#!/usr/bin/env node
/**
 * dl-release — dl.rose7.cn APK 发布接口（HTTP 上传）
 *
 * 零依赖单文件。监听 127.0.0.1:8799，由 Caddy 反代
 * dl.rose7.cn/api/v1/release（只允许本机访问，不暴露公网端口）。
 *
 * 服务端不信任客户端任何声明：
 *   - 令牌常数时间比较（/etc/dl-release/token，chmod 600）
 *   - 体积上限 50MB
 *   - MD5 由服务端自己算
 *   - packageName / versionCode / versionName 一律由 aapt2 dump badging
 *     从 APK 二进制里解析；meta 里的同名值不采信（冲突只记日志）
 *   - 防降级：versionCode 必须大于 releases.json 当前 latest
 *     （版本号与 latest 完全相同 = 幂等覆盖，允许）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  DEFAULT_MARKER,
  normalizeAllowEntry,
  parseVariantFromXmltree,
  resolveVariant,
  VARIANTS,
} from './variant.mjs';

// ---------------------------------------------------------------- 配置
const LISTEN_HOST = process.env.DL_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.DL_LISTEN_PORT || 8799);

const TOKEN_FILE = process.env.DL_TOKEN_FILE || '/etc/dl-release/token';
const APK_DIR = process.env.DL_APK_DIR || '/var/www/dl/apk';
const RELEASES_JSON = process.env.DL_RELEASES_JSON || '/var/www/dl/releases.json';
const PUBLIC_BASE = process.env.DL_PUBLIC_BASE || 'https://dl.rose7.cn';
const AAPT2 = process.env.DL_AAPT2 || '/opt/dl-release/bin/aapt2';

const REQUIRED_PACKAGE = process.env.DL_REQUIRED_PACKAGE || 'com.example.deepseekchat';
const MAX_APK_BYTES = 50 * 1024 * 1024;          // APK 本体硬上限 50MB
const MAX_BODY_BYTES = MAX_APK_BYTES + 6 * 1024 * 1024; // 含 multipart 边界的总上限
const RATE_LIMIT_MAX = Number(process.env.DL_RATE_LIMIT_MAX || 2);
const RATE_LIMIT_WINDOW_MS = Number(process.env.DL_RATE_LIMIT_WINDOW_S || 60) * 1000;
const AAPT2_TIMEOUT_MS = 30_000;
const STAGING_PREFIX = '.upload-';

// 构建变体（artifactVariant）的可信来源：
//   1) APK 签名内的 AndroidManifest meta-data 标记（首选，构建时写入，客户端改不了）
//   2) 服务器侧 sha256 白名单（只用于没有标记的历史包）
// 都没有 → unknown，绝不默认 standard（App 遇到 unknown 不得自动更新/推荐）。
const VARIANT_MARKER = process.env.DL_VARIANT_MARKER || DEFAULT_MARKER;
const VARIANTS_FILE = process.env.DL_VARIANTS_FILE || '/etc/dl-release/artifact-variants.json';

// ---------------------------------------------------------------- 令牌
let TOKEN = '';
let TOKEN_SHA256 = null;

function loadToken() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!raw) throw new Error(`token file ${TOKEN_FILE} is empty`);
  TOKEN = raw;
  // 定长摘要比较，既常数时间又不泄漏长度
  TOKEN_SHA256 = crypto.createHash('sha256').update(raw, 'utf8').digest();
  log('token_loaded', { file: TOKEN_FILE, len: raw.length });
}

function tokenOk(header) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1].trim(), 'utf8').digest();
  return TOKEN_SHA256 !== null && got.length === TOKEN_SHA256.length &&
    crypto.timingSafeEqual(got, TOKEN_SHA256);
}

// ---------------------------------------------------------------- 日志
// 只输出可公开的字段；绝不打印 Authorization / 令牌 / 请求体。
function log(event, fields = {}) {
  const parts = [`event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const s = String(v).replace(/[\r\n"]/g, ' ');
    parts.push(`${k}="${s}"`);
  }
  console.log(`${new Date().toISOString()} [dl-release] ${parts.join(' ')}`);
}

// ---------------------------------------------------------------- 限流
const rateBuckets = new Map(); // ip -> number[]（窗口内时间戳）

function rateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let arr = rateBuckets.get(ip);
  if (!arr) { arr = []; rateBuckets.set(ip, arr); }
  while (arr.length && arr[0] <= cutoff) arr.shift();
  if (arr.length >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((arr[0] + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  arr.push(now);
  return { ok: true };
}

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, arr] of rateBuckets) {
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (!arr.length) rateBuckets.delete(ip);
  }
}, 60_000).unref();

// 只信 Caddy 覆盖写入的 X-Real-IP（服务仅监听回环，外部无法直连伪造）。
// XFF 取最右一跳（Caddy 追加的真实来源），避免客户端自带 XFF 绕过限流。
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- 响应
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function fail(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

// ---------------------------------------------------------------- multipart
function parseMultipart(buf, boundary) {
  const dash = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(dash);
  if (pos < 0) throw new Error('multipart boundary not found');
  for (;;) {
    let hStart = pos + dash.length;
    if (hStart + 2 > buf.length) break;
    if (buf[hStart] === 0x2d && buf[hStart + 1] === 0x2d) break; // 收尾 "--"
    if (buf[hStart] === 0x0d && buf[hStart + 1] === 0x0a) hStart += 2;
    const next = buf.indexOf(dash, hStart);
    if (next < 0) break;
    let raw = buf.subarray(hStart, next);
    if (raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a) {
      raw = raw.subarray(0, raw.length - 2);
    }
    const hdrEnd = raw.indexOf('\r\n\r\n');
    let headers = '';
    let data = raw;
    if (hdrEnd >= 0) {
      headers = raw.subarray(0, hdrEnd).toString('utf8');
      data = raw.subarray(hdrEnd + 4);
    }
    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    if (nameM) {
      parts.push({ name: nameM[1], filename: fileM ? fileM[1] : null, data });
    }
    pos = next;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      const err = new Error('payload too large');
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      err.message2 = `请求体超过 ${(MAX_BODY_BYTES / 1048576).toFixed(0)}MB 上限`;
      return reject(err);
    }
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        const err = new Error('payload too large');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        err.message2 = `请求体超过 ${(MAX_BODY_BYTES / 1048576).toFixed(0)}MB 上限`;
        req.destroy();
        return reject(err);
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks, total)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

// ---------------------------------------------------------------- APK 解析
function aapt2Badging(file) {
  return new Promise((resolve, reject) => {
    execFile(
      AAPT2,
      ['dump', 'badging', file],
      { timeout: AAPT2_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const first = String(stdout).split('\n', 1)[0] || '';
        const pkg = /package:\s+name='([^']*)'/.exec(first);
        const vc = /versionCode='([^']*)'/.exec(first);
        const vn = /versionName='([^']*)'/.exec(first);
        if (!pkg || !vc || !vn) return reject(new Error('badging output unparsable'));
        resolve({ packageName: pkg[1], versionCode: Number(vc[1]), versionName: vn[1] });
      },
    );
  });
}

// ---------------------------------------------------------------- 变体解析
// 读 APK 内 AndroidManifest 的 meta-data 标记（aapt2 dump badging 不输出 meta-data，
// 已实测；必须用 xmltree）。
function aapt2VariantMarker(file) {
  return new Promise((resolve) => {
    execFile(
      AAPT2,
      ['dump', 'xmltree', file, '--file', 'AndroidManifest.xml'],
      { timeout: AAPT2_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ variant: null, reason: 'xmltree_failed' });
        resolve(parseVariantFromXmltree(String(stdout), VARIANT_MARKER));
      },
    );
  });
}

// 服务器侧 sha256 → 变体白名单（root 维护的服务器配置，客户端无法写入）
async function readVariantAllowlist() {
  try {
    const raw = await fsp.readFile(VARIANTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const map = (data && typeof data === 'object' && data.apks) || {};
    const out = {};
    for (const [sha, v] of Object.entries(map)) {
      const key = String(sha).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(key)) continue;   // 只接受 sha256 形态的键
      const entry = normalizeAllowEntry(v);
      if (entry) out[key] = entry;
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    log('variants_file_error', { error: e.message });
    return {};
  }
}

// ---------------------------------------------------------------- releases.json
async function readReleases() {
  const txt = await fsp.readFile(RELEASES_JSON, 'utf8');
  const data = JSON.parse(txt);
  if (!data || !Array.isArray(data.releases)) throw new Error('releases.json malformed');
  return data;
}

function shanghaiIso(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`
  );
}

// 原子写：同目录临时文件 → fsync → rename → fsync 目录
async function writeJsonAtomic(targetPath, obj) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  const fh = await fsp.open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(`${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, targetPath);
  const dh = await fsp.open(dir, 'r');
  try { await dh.sync(); } finally { await dh.close(); }
}

// ---------------------------------------------------------------- 主流程
async function handleRelease(req, res, ip) {
  // (1) 鉴权
  if (!tokenOk(req.headers.authorization)) {
    log('reject_auth', { ip });
    return fail(res, 401, 'UNAUTHORIZED', '发布令牌缺失或无效');
  }

  // (2) content-type
  const ctype = String(req.headers['content-type'] || '');
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!/^multipart\/form-data/i.test(ctype) || !bm) {
    return fail(res, 400, 'BAD_REQUEST', '需要 multipart/form-data 且带 boundary');
  }
  const boundary = (bm[1] || bm[2]).trim();

  // (3) 体积
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    log('reject_size', { ip, error: e.message2 || e.message });
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', e.message2 || '请求体过大');
  }

  // (4) 解析 multipart
  let parts;
  try {
    parts = parseMultipart(body, boundary);
  } catch (e) {
    return fail(res, 400, 'BAD_REQUEST', `multipart 解析失败: ${e.message}`);
  }
  const apkPart = parts.find((p) => p.name === 'apk');
  const metaPart = parts.find((p) => p.name === 'meta');
  if (!apkPart || !apkPart.data.length) return fail(res, 400, 'BAD_REQUEST', '缺少 apk 文件字段');
  if (apkPart.data.length > MAX_APK_BYTES) {
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', `APK 超过 ${MAX_APK_BYTES / 1048576}MB 上限`);
  }
  if (!metaPart) return fail(res, 400, 'BAD_REQUEST', '缺少 meta 字段');

  let meta = {};
  if (metaPart.data.length) {
    try {
      meta = JSON.parse(metaPart.data.toString('utf8'));
    } catch {
      return fail(res, 400, 'BAD_REQUEST', 'meta 不是合法 JSON');
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return fail(res, 400, 'BAD_REQUEST', 'meta 必须是 JSON 对象');
    }
  }
  let changes = meta.changes;
  if (changes === undefined) changes = [];
  if (!Array.isArray(changes) || changes.some((c) => typeof c !== 'string')) {
    return fail(res, 400, 'BAD_REQUEST', 'meta.changes 必须是字符串数组');
  }

  // (5) 落临时文件 + 服务端自己算 md5/sha256（不接受客户端提供的摘要）
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(APK_DIR, `${STAGING_PREFIX}${stamp}.apk`);
  const md5 = crypto.createHash('md5').update(apkPart.data).digest('hex');
  const sha256 = crypto.createHash('sha256').update(apkPart.data).digest('hex');
  try {
    await fsp.writeFile(staging, apkPart.data, { mode: 0o644 });
    const st = await fsp.stat(staging);
    if (st.size !== apkPart.data.length) throw new Error('short write');
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_io', { ip, error: e.message });
    return fail(res, 500, 'INTERNAL', '写入临时文件失败');
  }

  let badging;
  try {
    badging = await aapt2Badging(staging);       // (6) 从二进制里读真实值
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_not_apk', { ip, error: e.message });
    return fail(res, 400, 'INVALID_APK', '无法解析 APK 元信息（不是合法 APK？）');
  }

  const { packageName, versionCode, versionName } = badging;

  if (packageName !== REQUIRED_PACKAGE) {        // (7) 包名白名单
    await fsp.rm(staging, { force: true });
    log('reject_package', { ip, packageName });
    return fail(res, 400, 'INVALID_APK', `包名必须是 ${REQUIRED_PACKAGE}，实际 ${packageName}`);
  }

  // (7b) 变体判定：只认 APK 内标记 或 服务器白名单；客户端 meta 一律不采信
  if (meta.artifactVariant !== undefined) {
    log('meta_variant_ignored', { ip, meta: String(meta.artifactVariant) });
  }
  const marker = await aapt2VariantMarker(staging);
  const allowlist = await readVariantAllowlist();
  const allowEntry = allowlist[sha256] || null;
  const resolved = resolveVariant(marker, allowEntry);
  if (resolved.conflict) {
    await fsp.rm(staging, { force: true });
    log('reject_variant_conflict', {
      ip, sha256, marker: resolved.markerVariant, allowlist: resolved.allowVariant,
    });
    return fail(res, 409, 'VARIANT_CONFLICT',
      `APK 内标记 ${resolved.markerVariant} 与服务器白名单 ${resolved.allowVariant} 不一致，拒绝写入`);
  }
  const artifactVariant = resolved.variant;
  const artifactVariantSource = resolved.source;
  log('variant_resolved', {
    ip, variant: artifactVariant || 'unknown', source: artifactVariantSource || '-',
    marker: marker.reason || '-', sha256,
  });

  // meta 声明与 APK 真相不一致时只记日志，一律以 APK 为准
  if (meta.version !== undefined && String(meta.version) !== versionName) {
    log('meta_version_mismatch', { ip, meta: meta.version, apk: versionName });
  }
  if (meta.versionCode !== undefined && Number(meta.versionCode) !== versionCode) {
    log('meta_versioncode_mismatch', { ip, meta: meta.versionCode, apk: versionCode });
  }

  // (8) 防降级
  let data;
  try {
    data = await readReleases();
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_state', { ip, error: e.message });
    return fail(res, 500, 'INTERNAL', 'releases.json 读取失败');
  }
  const latestVersion = data.latest || (data.releases[0] && data.releases[0].version);
  const latestRecord = data.releases.find((r) => r.version === latestVersion) || data.releases[0];
  const latestCode = Number(latestRecord && latestRecord.versionCode);
  const sameVersion = versionName === latestVersion;

  if (!sameVersion && Number.isFinite(latestCode) && versionCode <= latestCode) {
    await fsp.rm(staging, { force: true });
    log('reject_downgrade', { ip, versionName, versionCode, latestVersion, latestCode });
    return fail(
      res, 409, 'VERSION_CONFLICT',
      `versionCode(${versionCode}) 必须大于当前最新 ${latestVersion} 的 ${latestCode}；` +
      '同版本号重传请使用完全相同的 versionName',
    );
  }

  // (9) 原子落盘 APK → 目标文件名由服务端解析出的 versionName 决定
  const fileName = `deepseek-chat-${versionName}.apk`;
  const finalPath = path.join(APK_DIR, fileName);
  const relFile = `apk/${fileName}`;
  try {
    await fsp.rename(staging, finalPath);
    const dh = await fsp.open(APK_DIR, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_io', { ip, error: e.message });
    return fail(res, 500, 'INTERNAL', 'APK 落盘失败');
  }

  // (10) 原子更新 releases.json
  const buildType = typeof meta.buildType === 'string' && meta.buildType
    ? meta.buildType
    : (/-(alpha|beta|rc)/i.test(versionName) ? 'prerelease' : 'stable');

  const record = {
    version: versionName,
    versionCode,
    releasedAt: shanghaiIso(),
    file: relFile,
    size: apkPart.data.length,
    md5,
    sha256,
    changes,
    buildType,
    breaking: typeof meta.breaking === 'boolean' ? meta.breaking : false,
  };
  // 变体无法可信判定时**不写**该字段（不默认 standard），App 侧据此不做自动更新
  if (artifactVariant) {
    record.artifactVariant = artifactVariant;
    record.artifactVariantSource = artifactVariantSource;
  }

  const rest = data.releases.filter((r) => r.version !== versionName);
  const nextReleases = [record, ...rest].sort((a, b) => {
    const d = Number(b.versionCode) - Number(a.versionCode);
    return Number.isFinite(d) && d !== 0 ? d : 0;
  });
  const next = { ...data, latest: versionName, releases: nextReleases };

  try {
    await writeJsonAtomic(RELEASES_JSON, next);
  } catch (e) {
    log('reject_state_write', { ip, error: e.message });
    return fail(res, 500, 'INTERNAL', 'releases.json 更新失败');
  }

  log('release_ok', {
    ip, version: versionName, versionCode, size: apkPart.data.length, md5,
    buildType, overwrite: sameVersion,
  });

  return sendJson(res, 200, {
    ok: true,
    url: `${PUBLIC_BASE}/apk/${fileName}`,
    latest: versionName,
    md5,
    sha256,
    artifactVariant: artifactVariant || null,
    artifactVariantSource: artifactVariantSource || null,
  });
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { url = { pathname: req.url }; }

  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: 'dl-release' });
  }

  if (url.pathname !== '/api/v1/release') {
    return fail(res, 404, 'NOT_FOUND', '未知路径');
  }

  const rl = rateLimit(ip);
  if (!rl.ok) {
    log('reject_rate_limit', { ip, retryAfter: rl.retryAfter });
    return fail(res, 429, 'RATE_LIMITED', `请求过于频繁，每 IP 每分钟最多 ${RATE_LIMIT_MAX} 次`,
      { 'Retry-After': String(rl.retryAfter) });
  }

  if (req.method !== 'POST') {
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST', { Allow: 'POST' });
  }

  try {
    await handleRelease(req, res, ip);
  } catch (e) {
    log('internal_error', { ip, error: e && e.message });
    if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务器内部错误');
    else res.end();
  }
});

server.requestTimeout = 180_000;
server.headersTimeout = 60_000;

try {
  loadToken();
} catch (e) {
  log('fatal_token', { error: e.message });
  process.exit(1);
}

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
  log('listening', { host: LISTEN_HOST, port: LISTEN_PORT, apkDir: APK_DIR, aapt2: AAPT2 });
  const allow = await readVariantAllowlist();
  log('variant_config', { marker: VARIANT_MARKER, file: VARIANTS_FILE, entries: Object.keys(allow).length });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('shutdown', { signal: sig }); server.close(() => process.exit(0)); });
}
process.on('uncaughtException', (e) => log('uncaught_exception', { error: e.message }));
process.on('unhandledRejection', (e) => log('unhandled_rejection', { error: String(e) }));
