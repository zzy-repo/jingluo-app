#!/usr/bin/env node
/**
 * dl-release — dl.rose7.cn APK 发布接口（HTTP 上传）
 *
 * 零依赖单文件。监听 127.0.0.1:8799，由 Caddy 反代
 * dl.rose7.cn/api/v1/release 与 /api/v1/version（只允许本机访问，不暴露公网端口）。
 *
 * GET /api/v1/version（Issue #441）：不需要令牌，只回非敏感信息 ——
 * 自身文件的 sha256（启动时算一次并缓存）、进程启动时刻、node 版本、
 * 合法变体/构建类型枚举。用途是让「线上跑的是哪一版」可核对，
 * 而不是靠人 ssh 上去数行数。
 *
 * 服务端不信任客户端任何声明：
 *   - 令牌常数时间比较（/etc/dl-release/token，chmod 600）
 *   - 体积上限 50MB
 *   - MD5 由服务端自己算
 *   - packageName / versionCode / versionName 一律由 aapt2 dump badging
 *     从 APK 二进制里解析；meta 里的同名值不采信（冲突只记日志）
 *   - `android:debuggable` 必须是 false（读 APK 内 AndroidManifest.xml 判定），
 *     否则 400 APK_DEBUGGABLE 拒收 —— 发布路径不允许出现 debuggable 构建（Issue #60）
 *   - 「回环 consume」构建一律拒收：APK 内 `<meta-data …LOOPBACK_CONSUME="true">`
 *     → 400 LOOPBACK_BUILD_REJECTED（Issue #601）。读不到标记（老包）按历史行为放行
 *   - 防降级：versionCode 必须大于 releases.json 当前 latest
 *     （版本号与 latest 完全相同 = 幂等覆盖，允许）
 *   - buildType 只接受 shared/build-types.mjs 的枚举（stable|prerelease），非法值
 *     在写任何文件之前就 400 拒收（Issue #330）
 *   - 落盘前对「新条目 + 现有清单」合并后的**整份**清单再校验一次：历史条目脏
 *     （例如早先写进去的 buildType:"release"）同样 409 拒收，APK 与清单都不落盘
 *
 * 发布目标（Issue #620 / 裁决 #614 决定 3）—— **接口层与脚本层同口径**：
 *
 *   `POST /api/v1/release`（公网清单 `/var/www/dl/releases.json`）
 *       artifactVariant !== "standard" → 400 VARIANT_NOT_PUBLIC（内部包/判不出变体的包一律拒）
 *       buildType      !== "stable"   → 400 BUILD_TYPE_NOT_PUBLIC
 *    `POST /api/v1/release/private`（私有清单 `DL_PRIVATE_RELEASES_JSON`，线上 `/var/www/dl-private/releases.internal.json`，webroot 之外）
 *       artifactVariant !== "internal" → 400 VARIANT_NOT_PRIVATE（standard 走 GitHub Release）
 *
 * 判据在 `release-target.mjs`（纯函数，与 scripts/publish-private-apk.mjs 的 G1、
 * scripts/validate-releases-manifest.mjs 的 public/private 双口径同一份枚举）。
 * 为什么接口层也要判：#601 事故的形状就是「脚本有闸，换个入口发就绕过去」——
 * 「能不能发」必须由接口拒绝，而不是靠调用方自觉。
 *
 * ## 私有清单的**读**端点（Issue #621）
 *
 * #619/#620 只解决了「私有包能不能写进去」，没解决「内测客户端怎么取到」——
 * 清单在 webroot 之外（公网 404，这是对的），于是一个字节都取不到，只能人工 scp + 报 sha256。
 * 这里补两个读端点，各自一个限流桶：
 *
 *   GET /api/v1/releases/internal            → { latest, releases:[…] }（只含 internal / prerelease）
 *   GET /api/v1/releases/internal/download?file=<basename.apk>
 *                                           → 200 流式返回私有 APK（Content-Disposition: attachment）
 *
 * 令牌两种写法都收：`X-DL-Token: <token>` 或 `Authorization: Bearer <token>`。
 * 无令牌 / 错令牌 → 401（**鉴权先于一切**：401 与「包在不在」同形，差异本身就是信息）。
 *
 * ## 两枚令牌：读令牌 / 发布令牌（Issue #641）
 *
 * #621 时读端点与发布端点共用一枚令牌（`/etc/dl-release/token`）。#622 的设计又把令牌
 * **随 internal 包分发到测试者设备**（构建期 `DL_PRIVATE_TOKEN` → `X-DL-Token`）——
 * 于是「任何拿到内测包的人，手里那枚令牌就能发布/覆盖正式分发包」。#641 拆成两枚：
 *
 *   /etc/dl-release/token        （DL_TOKEN_FILE）       发布令牌 —— 只见于发布脚本/主机
 *   /etc/dl-release/read-token   （DL_READ_TOKEN_FILE） 只读令牌 —— 内测包里的那一枚
 *
 * 权限矩阵（**最小权限**：写端点绝不认只读令牌）：
 *
 *   | 端点                                    | 只读令牌 | 发布令牌 |
 *   | --------------------------------------- | -------- | -------- |
 *   | GET  /api/v1/releases/internal           | 200      | 200      |
 *   | GET  /api/v1/releases/internal/download  | 200      | 200      |
 *   | GET  /api/v1/version                     | 免令牌   | 免令牌   |
 *   | POST /api/v1/release                     | **401**  | 200      |
 *   | POST /api/v1/release/private             | **401**  | 200      |
 *
 * 为什么发布令牌仍能读：它是**超集**（运维只持一枚也能排查），而只读令牌是子集。
 * 反向（读令牌能写）才是这条单子要杜绝的事，`POST` 的 401 是核心断言。
 *
 * **向后兼容**：`read-token` 不存在（或为空）时回退成「读也用发布令牌」，启动日志打
 * `read_token="fallback_to_write"` —— 运维一上线不会把整条内测读通道打死；等文件补上再重启即生效。
 *
 * 令牌本身**绝不进日志**：只打来源文件与长度，比较走 sha256 定长摘要 + timingSafeEqual。
 *
 * 两条硬规矩（都是「别把一个文件读错」变成「整条内测渠道断掉」）：
 *   1. **清单里的坏条目只跳过、不 500**：file 不是纯 basename / 不在私有目录内 / 文件不存在 /
 *      size 与磁盘不符 —— 记一条 warn 并跳过该条，其余条目照发。
 *   2. **下载只认 basename 白名单**：`?file=` 里出现 `/`、`..`、绝对路径一律 400，
 *      不做「清洗后再拼」那种把 `../../etc/passwd` 洗成 `etc/passwd` 的容错；
 *      而且必须在**已校验过的清单里**（`collectPrivateReleases` 的产物）才能下，
 *      目录里存在但没人声明的包不算可下。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  DEFAULT_LOOPBACK_MARKER,
  DEFAULT_MARKER,
  normalizeAllowEntry,
  parseVariantFromXmltree,
  resolveVariant,
  VARIANTS,
} from './variant.mjs';
import { inspectApkDebugState, inspectApkLoopback } from './apk-manifest.mjs';
// buildType 的枚举只有一处定义（Issue #330）——服务端不再自带字符串数组，
// 也不再把 Gradle 构建类型（release/debug）当发布渠道。
import { BUILD_TYPES, buildTypeFor, isBuildType } from '../../shared/build-types.mjs';
// 发布目标 × 变体 × 渠道的判定（Issue #620）：纯函数、可单测，接口层与脚本层同口径。
import {
  TARGETS,
  isInsideDir,
  judgeBuildType,
  judgeMergedManifest,
  judgeVariant,
  resolveTarget,
} from './release-target.mjs';

// ---------------------------------------------------------------- 配置
const LISTEN_HOST = process.env.DL_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.DL_LISTEN_PORT || 8799);

// 两枚令牌（Issue #641）：写（发布）令牌 + 读（只读）令牌。见文件头的权限矩阵。
const TOKEN_FILE = process.env.DL_TOKEN_FILE || '/etc/dl-release/token';
const READ_TOKEN_FILE = process.env.DL_READ_TOKEN_FILE || '/etc/dl-release/read-token';
const APK_DIR = process.env.DL_APK_DIR || '/var/www/dl/apk';
const RELEASES_JSON = process.env.DL_RELEASES_JSON || '/var/www/dl/releases.json';
// webroot（公网站点根）：只用来判「私有清单/私有包目录绝不许落在里面」（#609 G1 的接口层复刻）。
// 默认取公网清单所在目录 —— 两者部署上永远同一个地方，少一个要配的环境变量。
const WEBROOT = path.resolve(process.env.DL_WEBROOT || path.dirname(RELEASES_JSON));
// 私有清单与私有包目录（#609）：**webroot 之外**，Caddy 的 file_server 够不着。
// 默认值与线上对齐（#621 收尾，**以线上为准**）：私有根 = /opt/dl-private（包目录 /opt/dl-private/apk）；
// 线上清单不在私有根下，单独钉在 /var/www/dl-private/releases.internal.json。
// 三个都能用同名 env 覆盖，服务启动期仍会核「都不许落在 webroot 内」。
const PRIVATE_ROOT = path.resolve(process.env.DL_PRIVATE_ROOT || '/opt/dl-private');
const PRIVATE_RELEASES_JSON = path.resolve(
  process.env.DL_PRIVATE_RELEASES_JSON || path.join(PRIVATE_ROOT, 'releases.internal.json'),
);
const PRIVATE_APK_DIR = path.resolve(process.env.DL_PRIVATE_APK_DIR || path.join(PRIVATE_ROOT, 'apk'));
const PUBLIC_BASE = process.env.DL_PUBLIC_BASE || 'https://dl.rose7.cn';
const AAPT2 = process.env.DL_AAPT2 || '/opt/dl-release/bin/aapt2';

const REQUIRED_PACKAGE = process.env.DL_REQUIRED_PACKAGE || 'com.example.deepseekchat';
const MAX_APK_BYTES = 50 * 1024 * 1024;          // APK 本体硬上限 50MB
const MAX_BODY_BYTES = MAX_APK_BYTES + 6 * 1024 * 1024; // 含 multipart 边界的总上限
const RATE_LIMIT_MAX = Number(process.env.DL_RATE_LIMIT_MAX || 2);
const RATE_LIMIT_WINDOW_MS = Number(process.env.DL_RATE_LIMIT_WINDOW_S || 60) * 1000;
const AAPT2_TIMEOUT_MS = 30_000;
const STAGING_PREFIX = '.upload-';

// 私有清单**读**端点（Issue #621）
const PRIVATE_LIST_PATH = '/api/v1/releases/internal';
const PRIVATE_DOWNLOAD_PATH = '/api/v1/releases/internal/download';
// 内测客户端会按小时轮询清单、逢版本才下载包，所以读路径的额度比发布宽（60/min，按 IP）。
// **独立一个桶**：与发布共用 2/min 的话，客户端一刷新就把发布额度吃完了。
const PRIVATE_READ_RATE_LIMIT_MAX = Number(process.env.DL_PRIVATE_READ_RATE_LIMIT_MAX || 60);
// 私有包的 Content-Type：与 Caddy 给 *.apk 的一致（#619 的下载路径不经过 file_server，
// 头必须服务端自己给，否则某些客户端会当二进制/文本处理）。
const PRIVATE_APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
// 私有包文件名：**纯 basename**，不含任何目录成分。允许点与连字符（历史包名有 beta.10-dev.1 这类）。
const RE_PRIVATE_APK_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/;
// 私有清单里 `file` 的形状与公网清单同构（`apk/<name>.apk`，#620 的私有发布目标就是这么写的），
// 但物理文件直接躺在私有包目录下。只认「可选 apk/ 前缀 + 纯 basename」，别的一概不认。
const PRIVATE_FILE_PREFIX = 'apk/';

// 构建变体（artifactVariant）的可信来源：
//   1) APK 签名内的 AndroidManifest meta-data 标记（首选，构建时写入，客户端改不了）
//   2) 服务器侧 sha256 白名单（只用于没有标记的历史包）
// 都没有 → unknown，绝不默认 standard（App 遇到 unknown 不得自动更新/推荐）。
const VARIANT_MARKER = process.env.DL_VARIANT_MARKER || DEFAULT_MARKER;
// 回环 consume 标记（Issue #601 闸 2）：读法与 debuggable 同一套零依赖 AXML 解析，
// 不依赖 aapt2 —— 「这个包是不是只能本地联调」这种事，任何一台跑服务的机器都要判得出来。
const LOOPBACK_MARKER = process.env.DL_LOOPBACK_MARKER || DEFAULT_LOOPBACK_MARKER;
const VARIANTS_FILE = process.env.DL_VARIANTS_FILE || '/etc/dl-release/artifact-variants.json';

// ---------------------------------------------------------------- 发布目标（Issue #620）
// 一条路径 = 一个目标，不做「同一个 URL 靠参数切换口径」：口径藏在参数里，
// 迟早会有人（或某个模型）用错参数把 internal 包发到公网清单上，而接口不会拒绝。
const TARGET_SPECS = Object.freeze({
  public: Object.freeze({
    id: 'public',
    apkDir: path.resolve(APK_DIR),
    manifestFile: path.resolve(RELEASES_JSON),
    publicBase: PUBLIC_BASE,
    createIfMissing: false,
    okEvent: 'release_ok',
    label: '公网清单',
  }),
  private: Object.freeze({
    id: 'private',
    apkDir: PRIVATE_APK_DIR,
    manifestFile: PRIVATE_RELEASES_JSON,
    publicBase: null,          // 私有清单没有「公网直链」这回事，回包不给 URL
    createIfMissing: true,
    okEvent: 'release_private_ok',
    label: '私有清单',
  }),
});

/**
 * 私有根必须整棵在 webroot 之外 —— 否则公网 file_server 照样能把内部包发出去（#609 G1）。
 * 这是**启动期**硬门禁：配置写错了服务就不许起来（宁可发布接口缺席，也不要一个能把
 * internal 包写进 webroot 的服务在跑）。
 */
function assertPrivateRootOutsideWebroot() {
  const leaks = [
    ['私有根', PRIVATE_ROOT],
    ['私有清单', PRIVATE_RELEASES_JSON],
    ['私有包目录', PRIVATE_APK_DIR],
  ].filter(([, dir]) => isInsideDir(dir, WEBROOT));
  if (!leaks.length) return;
  log('fatal_private_root_in_webroot', {
    webroot: WEBROOT,
    detail: leaks.map(([name, dir]) => `${name}=${dir}`).join(' '),
  });
  process.exit(1);
}

// ---------------------------------------------------------------- 版本指纹（Issue #441）
// 「线上跑的是哪一版」必须由服务自己证明，而不是靠人 ssh 上去数行数。
//   sha256  —— **启动时**读一次自身文件算出来就缓存：进程跑的是那一次读到的字节，
//              之后磁盘上的文件被换掉，也不能让 /api/v1/version 替新文件作证。
//   builtAt —— 进程启动时刻（不是构建时刻），它回答的是「这份进程什么时候起来的」。
// 只回非敏感信息：无令牌、无路径、无 releases.json 内容。
const SELF_FILE = fileURLToPath(import.meta.url);
const STARTED_AT = new Date().toISOString();

function selfSha256() {
  return crypto.createHash('sha256').update(fs.readFileSync(SELF_FILE)).digest('hex');
}

// 算不出来就没有版本端点可言 —— 宁可不启动，也不让它在线上返回一个假指纹。
let SELF_SHA256 = null;
try {
  SELF_SHA256 = selfSha256();
} catch (e) {
  log('fatal_version', { file: SELF_FILE, error: e.message });
  process.exit(1);
}

const VERSION_INFO = Object.freeze({
  ok: true,
  sha256: SELF_SHA256,
  builtAt: STARTED_AT,
  nodeVersion: process.version,
  // 枚举都取自单一真相源（#330 / variant.mjs），不在这里另抄一份字符串数组
  variants: [...VARIANTS],
  buildTypes: [...BUILD_TYPES],
  // #620：接口层的两个目标（公网清单 / 私有清单）也一起自证，部署验收能核对「闸在不在」
  targets: [...TARGETS],
});

// ---------------------------------------------------------------- 令牌（两枚，#641）
// 只保存摘要（sha256，定长），原文用完即弃 —— 日志里只出现「来自哪个文件、多长」。
// 发布令牌必填（缺了服务不起）；只读令牌可缺 —— 缺了回退成「读也用发布令牌」
// （#641 的向后兼容：运维一上线不补 read-token 也不会把整条内测读通道打死）。
let WRITE_TOKEN_SHA256 = null;
let READ_TOKEN_SHA256 = null;
// true = 没有独立的只读令牌，读端点回退认发布令牌（启动日志会打警告）
let READ_TOKEN_FALLBACK = false;

/** 摘要（定长）。 */
function sha256OfToken(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 常数时间比较两个定长摘要。
 * 长度不同直接 false（sha256 摘要恒为 32 字节，长度信息本身不敏感），
 * 等长才走 timingSafeEqual —— 不泄漏「前几位对上没对上」。
 */
function digestEquals(got, expected) {
  return Buffer.isBuffer(got) && Buffer.isBuffer(expected) &&
    got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function loadToken() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!raw) throw new Error(`token file ${TOKEN_FILE} is empty`);
  WRITE_TOKEN_SHA256 = sha256OfToken(raw);
  log('token_loaded', { role: 'write', file: TOKEN_FILE, len: raw.length });

  // 只读令牌：缺失/为空都回退（都打警告），任何情况下不因此拒绝启动
  try {
    const read = fs.readFileSync(READ_TOKEN_FILE, 'utf8').trim();
    if (!read) {
      READ_TOKEN_FALLBACK = true;
      log('read_token_fallback', {
        file: READ_TOKEN_FILE, read_token: 'fallback_to_write', reason: 'empty',
      });
      return;
    }
    READ_TOKEN_SHA256 = sha256OfToken(read);
    log('read_token_loaded', { role: 'read', file: READ_TOKEN_FILE, len: read.length });
    // 两枚写成一样 = 拆了等于没拆。不拒绝启动（那是运维正在轮换的中间态），但必须吵。
    if (read === raw) {
      log('read_token_same_as_write', {
        file: READ_TOKEN_FILE, read_token: 'same_as_write',
        hint: '拆令牌没生效：read-token 与 token 同值',
      });
    }
  } catch (e) {
    READ_TOKEN_FALLBACK = true;
    log('read_token_fallback', {
      file: READ_TOKEN_FILE, read_token: 'fallback_to_write', reason: e.code || e.message,
    });
  }
}

/** 发布（写）令牌：`Authorization: Bearer <token>`（#619 起的发布脚本就长这样）。 */
function tokenOk(header) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return writeTokenOk(m[1]);
}

/** 发布令牌原文比较（只有持有写令牌才通过）。 */
function writeTokenOk(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value) return false;
  if (WRITE_TOKEN_SHA256 === null) return false;
  return digestEquals(sha256OfToken(value), WRITE_TOKEN_SHA256);
}

/**
 * 读端点令牌：**只读令牌或发布令牌**（发布令牌是超集，见文件头的矩阵）。
 * 回退态（没有 read-token）下 READ_TOKEN_SHA256 为 null，等价于「读也用发布令牌」。
 */
function readTokenOk(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value) return false;
  const got = sha256OfToken(value);
  return digestEquals(got, READ_TOKEN_SHA256) || digestEquals(got, WRITE_TOKEN_SHA256);
}

/**
 * 读请求里的令牌（Issue #621）：`X-DL-Token: <token>` 或 `Authorization: Bearer <token>`。
 * 为什么两种都收：#619 的发布脚本用 Authorization，内测客户端/curl 手敲 X-DL-Token 更顺手；
 * 只收一种就会逼调用方「为了让服务认，得多包一层」。接受两种不等于放宽判据 —— 值仍然走
 * 同一份 sha256 + timingSafeEqual。
 */
function readRequestToken(req) {
  const direct = req.headers['x-dl-token'];
  if (typeof direct === 'string' && direct.trim()) return direct;
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return '';
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
const rateBuckets = new Map(); // bucketKey -> number[]（窗口内时间戳）

/**
 * @param {string} key 桶键（发布用 ip；私有读端点用 `private:<ip>`，两者互不挤占）
 * @param {number} [max] 该桶窗口内允许的请求数，默认按发布口径（DL_RATE_LIMIT_MAX）
 */
function rateLimit(key, max = RATE_LIMIT_MAX) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let arr = rateBuckets.get(key);
  if (!arr) { arr = []; rateBuckets.set(key, arr); }
  while (arr.length && arr[0] <= cutoff) arr.shift();
  if (arr.length >= max) {
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

// Issue #330 的两个新错误码同时给顶层 code/message（#330 验收与发布脚本直接读这两个
// 字段），error{code,message} 嵌套保持既有契约不变，老调用方不受影响。
function failCode(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message, error: { code, message } });
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

// ---------------------------------------------------------------- 清单读取（两种口径）
/**
 * 读目标清单。公网清单缺失/损坏 = 环境坏了（500，不许猜着新建）；
 * 私有清单缺失 = 还没有私有发布过（ENOENT 视为空清单，第一次写入由 mkdir + 原子写完成）。
 */
async function readReleases(target) {
  try {
    const txt = await fsp.readFile(target.manifestFile, 'utf8');
    const data = JSON.parse(txt);
    if (!data || !Array.isArray(data.releases)) {
      throw new Error(`${path.basename(target.manifestFile)} malformed`);
    }
    return data;
  } catch (e) {
    if (target.createIfMissing && e.code === 'ENOENT') return { latest: null, releases: [] };
    throw e;
  }
}

/**
 * 整份清单的 buildType 体检（Issue #330 第 3 条：服务端已有清单的兜底）。
 *
 * 只校验 buildType：这是 2026-11-19 事故的字段，也是客户端 parseManifest() 整份拒绝的
 * 触发点。结构性的字段校验（versionCode 降序、sha256 形态等）继续由
 * scripts/validate-releases-manifest.mjs 在离线门禁里管，这里不重复造一套规则。
 *
 * @returns {{index:number, version:string, buildType:string}[]} 非法条目（空数组 = 干净）
 */
function findIllegalBuildTypes(manifest) {
  const list = Array.isArray(manifest && manifest.releases) ? manifest.releases : [];
  const bad = [];
  list.forEach((r, index) => {
    const value = r && typeof r === 'object' ? r.buildType : undefined;
    if (isBuildType(value)) return;
    bad.push({
      index,
      version: (r && typeof r.version === 'string' && r.version) || '?',
      buildType: value === undefined ? '(missing)' : String(value),
    });
  });
  return bad;
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

// ---------------------------------------------------------------- 私有清单读端点（Issue #621）
/**
 * 私有包的物理文件名：只认纯 basename 的 `.apk`。
 *
 * 返回 null 就是「这个名字不许用」，调用方一律拒绝，**不做清洗后再拼** ——
 * 把 `../../etc/passwd` 洗成 `etc/passwd` 那种容错，等于把「路径穿越」改写成「读到了别的文件」，
 * 只是把事故从 500 变成 200。
 *
 * @param {unknown} file 清单里的 `file` 字段或 `?file=` 参数
 * @returns {string|null} 合法 basename（如 `deepseek-chat-1.4.0-internal.apk`），否则 null
 */
function privateApkBasename(file) {
  if (typeof file !== 'string') return null;
  const value = file.trim();
  if (!value) return null;
  if (value.includes('\\') || value.includes('\0')) return null;   // Windows 分隔符 / NUL 注入
  // 清单沿用公网清单的 `apk/<name>` 形状（#620 的私有发布目标就是这么写的），
  // 但物理文件就在私有包目录里 —— 前缀只剥这一层，再出现 `/` 就是路径，不认。
  const name = value.startsWith(PRIVATE_FILE_PREFIX) ? value.slice(PRIVATE_FILE_PREFIX.length) : value;
  if (name.includes('/')) return null;
  if (name.includes('..')) return null;                              // 连 `a..apk` 这种也一并拒，少一类思考
  if (!RE_PRIVATE_APK_BASENAME.test(name)) return null;
  return name;
}

/**
 * 这条记录该不该出现在私有清单的读响应里。
 *
 * 私有清单是「内测渠道」的清单：只要 `artifactVariant === "internal"`（含 prerelease 渠道的内测包）。
 * `artifactVariant === "standard"` 的条目**一律不出现**，哪怕它 buildType 是 prerelease ——
 * standard 包走公网 `releases.json`（裁决 #614 决定 3 把两条渠道分开），出现在私有清单里
 * 会让内测客户端把对外包当成内测包。判不出变体的老条目按 prerelease 渠道放行（历史事实如此），
 * 但同样不认 standard。
 */
function isPrivateReadEntry(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.artifactVariant === 'standard') return false;
  return record.artifactVariant === 'internal' || record.buildType === 'prerelease';
}

/** 严格读私有清单：读不到 / 解析不了就是「暂不可用」，绝不当成空清单（空清单会让客户端以为没有内测版）。 */
async function readPrivateManifest() {
  const txt = await fsp.readFile(PRIVATE_RELEASES_JSON, 'utf8');
  const data = JSON.parse(txt);
  if (!data || !Array.isArray(data.releases)) {
    throw new Error(`${path.basename(PRIVATE_RELEASES_JSON)} malformed`);
  }
  return data;
}

/**
 * 把原始清单过滤成「可交付的内测清单」：逐条校验，坏条目跳过并记 warn。
 *
 * **为什么不能 500**：清单是 root 手维护/脚本写入的文件，一条写错的 file（改名、目录换了、
 * size 记错）会让整个端点 500 —— 于是「一个包没发好」升级成「所有内测用户都更新不了」。
 * 所以坏条目只记账、不传染：其余条目照发，warn 留在 journal 里等人修。
 *
 * @param {{releases?: unknown[]}|null} raw 原始清单
 * @param {string} ip 客户端 IP（只用于日志）
 * @returns {Promise<{releases: object[], skipped: {index:number,version:string,reason:string}[]}>}
 */
async function collectPrivateReleases(raw, ip) {
  const list = Array.isArray(raw && raw.releases) ? raw.releases : [];
  const releases = [];
  const skipped = [];
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    const version = record && typeof record.version === 'string' ? record.version : `releases[${index}]`;
    const skip = (reason, extra = {}) => {
      skipped.push({ index, version, reason });
      log('private_entry_skipped', { ip, index, version, reason, ...extra });
    };

    if (!record || typeof record !== 'object' || Array.isArray(record)) { skip('not_an_object'); continue; }
    if (!isPrivateReadEntry(record)) {
      skip('not_private_variant', { variant: record.artifactVariant || '-', buildType: record.buildType || '-' });
      continue;
    }
    const name = privateApkBasename(record.file);
    if (!name) { skip('unsafe_file', { file: String(record.file ?? '') }); continue; }

    const abs = path.resolve(PRIVATE_APK_DIR, name);
    if (!isInsideDir(abs, PRIVATE_APK_DIR)) { skip('outside_private_dir', { file: name }); continue; }

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (e) {
      skip('file_missing', { file: name, error: e.code || e.message });
      continue;
    }
    if (!stat.isFile()) { skip('not_a_file', { file: name }); continue; }

    // 清单自报的 size 与磁盘不符 = 清单和文件不是一回事（改名/覆盖/手改），这条不可交付
    const declaredSize = Number(record.size);
    if (Number.isFinite(declaredSize) && declaredSize !== stat.size) {
      skip('size_mismatch', { file: name, declared: declaredSize, actual: stat.size });
      continue;
    }

    releases.push({
      ...record,
      size: stat.size,
      // 给客户端的下载入口：**形状只此一种**，不让客户端拿 file 自己拼 URL
      // （拼法一旦分散到客户端，改路径就等于要求所有内测用户升级客户端）
      apkName: name,
      downloadUrl: `${PRIVATE_DOWNLOAD_PATH}?file=${encodeURIComponent(name)}`,
    });
  }
  return { releases, skipped };
}

/** 私有清单的 `latest`：只在**活下来的**条目里挑，不让被跳过的条目继续当「最新」。 */
function privateLatest(raw, releases) {
  const versions = new Set(releases.map((r) => r.version));
  const candidates = [raw && raw.latest, releases[0] && releases[0].version];
  for (const c of candidates) {
    if (typeof c === 'string' && versions.has(c)) return c;
  }
  return releases.length ? releases[0].version : null;
}

/** GET /api/v1/releases/internal */
async function handlePrivateReleases(req, res, ip) {
  let raw;
  try {
    raw = await readPrivateManifest();
  } catch (e) {
    log('private_manifest_error', { ip, error: e.code || e.message });
    return fail(res, 503, 'MANIFEST_UNAVAILABLE', '私有清单暂不可用');
  }

  const { releases, skipped } = await collectPrivateReleases(raw, ip);
  const latest = privateLatest(raw, releases);
  log('private_manifest_ok', {
    ip, count: releases.length, skipped: skipped.length, latest: latest || '-',
  });

  // Cache-Control: no-store 由 sendJson 统一给（清单是「此刻的事实」，缓存它等于发旧包）
  return sendJson(res, 200, {
    ok: true,
    latest,
    count: releases.length,
    skipped: skipped.length,
    releases,
  });
}

/** GET /api/v1/releases/internal/download?file=<basename.apk> */
async function handlePrivateDownload(req, res, ip, url) {
  const asked = url.searchParams.get('file');
  if (!asked || !asked.trim()) {
    log('private_download_reject', { ip, reason: 'missing_file' });
    return fail(res, 400, 'BAD_FILE_NAME', '缺少 file 参数（私有包文件名，如 deepseek-chat-1.4.0-internal.apk）');
  }
  const name = privateApkBasename(asked);
  // 下载入口只收裸 basename（`apk/<name>` 前缀是清单里的形状，不是请求参数的形状）
  if (!name || name !== asked.trim()) {
    log('private_download_reject', { ip, reason: 'unsafe_file' });
    return fail(res, 400, 'BAD_FILE_NAME', 'file 必须是私有包文件名，不允许任何路径成分');
  }

  // 白名单：必须在**已校验过的清单**里。目录里躺着但没人声明的包不算可下 ——
  // 否则「私有包」的边界就退化成「私有目录里有什么」，而目录是历史垃圾最容易堆积的地方。
  let raw;
  try {
    raw = await readPrivateManifest();
  } catch (e) {
    log('private_manifest_error', { ip, error: e.code || e.message });
    return fail(res, 503, 'MANIFEST_UNAVAILABLE', '私有清单暂不可用');
  }
  const { releases } = await collectPrivateReleases(raw, ip);
  if (!releases.some((r) => r.apkName === name)) {
    log('private_download_reject', { ip, reason: 'not_in_manifest', file: name });
    return fail(res, 404, 'NOT_FOUND', '未找到该私有包');
  }

  const abs = path.resolve(PRIVATE_APK_DIR, name);
  if (!isInsideDir(abs, PRIVATE_APK_DIR)) {
    log('private_download_reject', { ip, reason: 'outside_private_dir', file: name });
    return fail(res, 400, 'BAD_FILE_NAME', 'file 必须是私有包文件名，不允许任何路径成分');
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (e) {
    log('private_download_reject', { ip, reason: 'file_missing', file: name, error: e.code || e.message });
    return fail(res, 404, 'NOT_FOUND', '未找到该私有包');
  }
  if (!stat.isFile()) {
    log('private_download_reject', { ip, reason: 'not_a_file', file: name });
    return fail(res, 404, 'NOT_FOUND', '未找到该私有包');
  }

  res.writeHead(200, {
    'Content-Type': PRIVATE_APK_CONTENT_TYPE,
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  log('private_download_ok', { ip, file: name, size: stat.size });

  if (req.method === 'HEAD') return res.end();
  try {
    await pipeline(fs.createReadStream(abs), res);
  } catch (e) {
    // 客户端中途断开是常态（内测用户切网），只记一行，不当作服务端错误
    log('private_download_aborted', { ip, file: name, error: e.code || e.message });
  }
  return undefined;
}

// ---------------------------------------------------------------- 主流程
async function handleRelease(req, res, ip, target) {
  // (1) 鉴权：**只认发布令牌**（#641）—— 只读令牌随 internal 包分发到设备，它绝不能发布。
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

  // (4b) buildType 白名单（Issue #330）：非法值在这里就拒收 —— **零 I/O**，
  // 既不写 .upload-* 临时 APK，也不读/写 releases.json。
  // 缺字段（undefined）保留历史行为：落盘时按版本号推导（buildTypeFor）。
  // 空字符串、null、数字、Gradle 的 "release"/"debug" 一律算非法 —— 明确的错值不该被
  // 静默改成默认值，否则「写错了」和「没写」就分不出来。
  if (meta.buildType !== undefined && !isBuildType(meta.buildType)) {
    log('reject_build_type', { ip, meta: JSON.stringify(meta.buildType ?? null) });
    return failCode(
      res, 400, 'BAD_BUILD_TYPE',
      `buildType 必须是 ${BUILD_TYPES.join(' | ')} 之一，收到 ${JSON.stringify(meta.buildType)}。` +
      '注意 buildType 描述的是发布渠道，不是 Gradle 构建类型（release → stable，debug → 禁止发布，见 #60）；' +
      '省略该字段则由服务端按版本号推导',
    );
  }

  // (5) 落临时文件 + 服务端自己算 md5/sha256（不接受客户端提供的摘要）
  // 私有清单/私有包目录是第一次发布时才建的（不在 webroot 内 → 公网 file_server 够不着）
  if (target.createIfMissing) {
    try {
      await fsp.mkdir(target.apkDir, { recursive: true, mode: 0o755 });
      await fsp.mkdir(path.dirname(target.manifestFile), { recursive: true, mode: 0o755 });
    } catch (e) {
      log('reject_io', { ip, target: target.id, error: e.message });
      return fail(res, 500, 'INTERNAL', '私有目录创建失败');
    }
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(target.apkDir, `${STAGING_PREFIX}${stamp}.apk`);
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

  // (7a) 发布完整性硬门禁：debuggable 构建一律拒收（Issue #60）
  // 判据直接读 APK 内 AndroidManifest.xml 的 application/android:debuggable，
  // 不采信任何客户端声明；判不出来（null）同样拒收 —— 发布路径上不做「猜着放行」。
  const debugState = inspectApkDebugState(staging);
  if (debugState.debuggable !== false) {
    await fsp.rm(staging, { force: true });
    log('reject_debuggable', {
      ip, sha256, state: String(debugState.debuggable), reason: debugState.reason,
    });
    const why = debugState.debuggable === true
      ? 'APK 是 debuggable 构建（android:debuggable="true"），可被 adb run-as 读取私有数据'
      : `无法确认 APK 的 debuggable 状态（${debugState.reason}）`;
    return fail(res, 400, 'APK_DEBUGGABLE',
      `${why}，拒绝写入。请用 ./gradlew :app:assembleRelease -PartifactVariant=internal 重新出包（Issue #60）`);
  }

  // (7a-2) 回环 consume 包一律拒收（Issue #601 闸 2：闸 1 只保证「打得出来的回环包带标记」，
  // 这里保证「带标记的包进不了库」）。判据仍是 APK 二进制里的标记，不采信客户端 meta。
  // 读不到标记 → 放行（历史包没有这一条，误伤一次发布流程就会被绕过）。
  const loopbackState = inspectApkLoopback(staging, LOOPBACK_MARKER);
  log('loopback_marker', {
    ip, state: String(loopbackState.loopback), reason: loopbackState.reason, sha256,
  });
  if (loopbackState.loopback === true) {
    await fsp.rm(staging, { force: true });
    log('reject_loopback_build', { ip, sha256, marker: LOOPBACK_MARKER, value: loopbackState.value });
    return failCode(
      res, 400, 'LOOPBACK_BUILD_REJECTED',
      '该包仅用于本地联调：APK 内埋着 ' +
      `${LOOPBACK_MARKER}="true"，说明它是用回环地址（127.0.0.1 / localhost / [::1]）打出` +
      '的 consume 构建，装到任何真机上都连不上后端（127.0.0.1 指的是手机自己，只能配 adb reverse）。' +
      '已拒绝写入 releases.json。请把 config/endpoints.json 的 consume.baseUrl 换成 https 生产地址' +
      '后重新出包（Issue #601）',
    );
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
    ip, target: target.id, variant: artifactVariant || 'unknown', source: artifactVariantSource || '-',
    marker: marker.reason || '-', sha256,
  });

  // (7c) 发布目标 × 变体 × 渠道（Issue #620）：与 #619 的 G1 同一口径，判据在 release-target.mjs。
  // 位置是有意的 —— 变体判定之后（判据来自 APK 字节/服务器白名单），任何落盘之前：
  //   · 排在这里 → internal 包连 .upload-* 都不留，目标清单一个字节不改；
  //   · 排在这里 → 它比防降级更早报出真正的原因（内部包不该发，而不是「版本号不大」）。
  const variantGate = judgeVariant({
    target: target.id, variant: artifactVariant, source: artifactVariantSource,
  });
  if (!variantGate.ok) {
    await fsp.rm(staging, { force: true });
    log('reject_variant_target', {
      ip, target: target.id, variant: artifactVariant || 'unknown',
      source: artifactVariantSource || '-', code: variantGate.code, sha256,
    });
    return failCode(res, 400, variantGate.code, variantGate.message);
  }

  // 渠道（buildType）在这里就定下来：meta 显式给出优先，否则按版本号推导（buildTypeFor）。
  // 公网清单只收 stable（裁决 #614 决定 2/3）—— 推导出来的 prerelease 也一样拒。
  const buildType = meta.buildType !== undefined ? meta.buildType : buildTypeFor(versionName);
  const buildTypeGate = judgeBuildType({ target: target.id, buildType });
  if (!buildTypeGate.ok) {
    await fsp.rm(staging, { force: true });
    log('reject_build_type_target', {
      ip, target: target.id, buildType, code: buildTypeGate.code, sha256,
    });
    return failCode(res, 400, buildTypeGate.code, buildTypeGate.message);
  }

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
    data = await readReleases(target);
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_state', { ip, target: target.id, error: e.message });
    return fail(res, 500, 'INTERNAL', `${path.basename(target.manifestFile)} 读取失败`);
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

  // (9) 先算出新条目与「新条目 + 现有清单」的合并结果，并在**落盘前**整份校验（Issue #330 / #620）
  // 顺序是有意的：校验放在 rename 之前，脏清单时 APK 也不落盘，不会留下
  // 「目录里有新包、清单没收录」的半成品。buildType 已在 (7c) 定过（含渠道门禁）。
  const fileName = `deepseek-chat-${versionName}.apk`;
  const finalPath = path.join(target.apkDir, fileName);
  const relFile = `apk/${fileName}`;

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

  // (9b) 整份清单校验：新条目合法不代表清单干净（历史条目可能早就写着 buildType:"release"）。
  // 有非法值 → fail-closed：本次上传整体拒收，APK 与 releases.json 都不动。
  const dirty = findIllegalBuildTypes(next);
  if (dirty.length) {
    await fsp.rm(staging, { force: true });
    const head = dirty.slice(0, 3)
      .map((d) => `releases[${d.index}] ${d.version} buildType=${d.buildType}`).join('；');
    log('reject_manifest_dirty', {
      ip, target: target.id, count: dirty.length, first: head, stagingRemoved: true,
    });
    return failCode(
      res, 409, 'MANIFEST_DIRTY',
      `合并后的清单有 ${dirty.length} 条 buildType 非法（${head}${dirty.length > 3 ? ' …' : ''}），` +
      `只允许 ${BUILD_TYPES.join(' | ')}。整份清单校验未通过，本次上传未落盘（APK 与 releases.json 均未改），` +
      '请先清洗现有清单（见 #330）',
    );
  }

  // (9c) 整份清单的**变体**互斥校验（Issue #620 / #619 双口径的接口层复刻）：
  // 公网清单里只要有一条 internal（历史上漏进去的也算），这次上传就把那条直链又写回去了，
  // 所以整单拒收（fail-closed）。判据与 scripts/validate-releases-manifest.mjs 的
  // public/private 口径同一份枚举（见 release-target.mjs）。
  const manifestGate = judgeMergedManifest({ target: target.id, manifest: next });
  if (!manifestGate.ok) {
    await fsp.rm(staging, { force: true });
    log('reject_manifest_variant', {
      ip, target: target.id, code: manifestGate.code, count: manifestGate.count, stagingRemoved: true,
    });
    return failCode(res, 409, manifestGate.code, manifestGate.message);
  }

  // (10) 原子落盘 APK → 目标文件名由服务端解析出的 versionName 决定
  try {
    await fsp.rename(staging, finalPath);
    const dh = await fsp.open(target.apkDir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch (e) {
    await fsp.rm(staging, { force: true });
    log('reject_io', { ip, target: target.id, error: e.message });
    return fail(res, 500, 'INTERNAL', 'APK 落盘失败');
  }

  // (11) 原子更新目标清单（公网 / 私有各自那一份）
  try {
    await writeJsonAtomic(target.manifestFile, next);
  } catch (e) {
    log('reject_state_write', { ip, target: target.id, error: e.message });
    return fail(res, 500, 'INTERNAL', `${path.basename(target.manifestFile)} 更新失败`);
  }

  log(target.okEvent, {
    ip, target: target.id, version: versionName, versionCode, size: apkPart.data.length, md5,
    buildType, variant: artifactVariant || 'unknown', overwrite: sameVersion,
  });

  // 私有清单没有公网直链：回包不给 url（那不是「少给一步」，是私有包本来就不该有公网 URL）
  return sendJson(res, 200, {
    ok: true,
    target: target.id,
    ...(target.publicBase ? { url: `${target.publicBase}/apk/${fileName}` } : { file: relFile }),
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

  // Issue #441：版本自证。不校验令牌（只回非敏感信息）、也不吃限流额度
  // —— 它在限流之前返回，验收与监控可以随时打，不会挤掉正常发布。
  if (url.pathname === '/api/v1/version') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET', { Allow: 'GET' });
    }
    return sendJson(res, 200, VERSION_INFO);
  }

  // 私有清单**读**端点（Issue #621）：内测客户端取 releases.internal.json + 私有包下载。
  // 与发布端点同一枚令牌、同一套限流机制，但**各自一个桶**：发布是 2/min 的写操作，
  // 内测客户端轮询清单会把它挤干净。
  if (url.pathname === PRIVATE_LIST_PATH || url.pathname === PRIVATE_DOWNLOAD_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET', { Allow: 'GET' });
    }
    const rlPrivate = rateLimit(`private:${ip}`, PRIVATE_READ_RATE_LIMIT_MAX);
    if (!rlPrivate.ok) {
      log('reject_rate_limit', { ip, bucket: 'private', retryAfter: rlPrivate.retryAfter });
      return fail(res, 429, 'RATE_LIMITED',
        `请求过于频繁，每 IP 每分钟最多 ${PRIVATE_READ_RATE_LIMIT_MAX} 次`,
        { 'Retry-After': String(rlPrivate.retryAfter) });
    }
    // 鉴权必须在任何「存在性」判断之前：无令牌 / 错令牌与「清单有没有、包在不在」
    // 必须同形回 401 —— 401 与 404 的差异本身就是一条情报。
    // #641：读端点认「只读令牌」与「发布令牌」两枚（发布令牌是超集）；回退态下只剩后者。
    if (!readTokenOk(readRequestToken(req))) {
      log('reject_auth', { ip, bucket: 'private', path: url.pathname });
      return fail(res, 401, 'UNAUTHORIZED', '分发令牌缺失或无效');
    }
    try {
      if (url.pathname === PRIVATE_DOWNLOAD_PATH) {
        return await handlePrivateDownload(req, res, ip, url);
      }
      return await handlePrivateReleases(req, res, ip);
    } catch (e) {
      log('internal_error', { ip, path: url.pathname, error: e && e.message });
      if (!res.headersSent) return fail(res, 500, 'INTERNAL', '服务器内部错误');
      return res.end();
    }
  }

  // 发布端点：一条路径 = 一个目标（公网清单 / 私有清单，Issue #620）。
  // 目标不是「靠 meta 参数切换」—— 口径一旦能被参数选择，就会有人（或某个模型）选错，
  // 而错的那一次正是把 internal 包写进公网清单的那一次。
  const targetId = resolveTarget(url.pathname);
  if (!targetId) {
    return fail(res, 404, 'NOT_FOUND', '未知路径');
  }
  const target = TARGET_SPECS[targetId];

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
    await handleRelease(req, res, ip, target);
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

// #620 / #609 G1：私有根不许落在 webroot 内 —— 配置错了就不许起来（宁可接口缺席）
assertPrivateRootOutsideWebroot();

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
  log('listening', {
    host: LISTEN_HOST, port: LISTEN_PORT, apkDir: APK_DIR, aapt2: AAPT2,
    webroot: WEBROOT, privateManifest: PRIVATE_RELEASES_JSON, privateApkDir: PRIVATE_APK_DIR,
  });
  log('targets', { public: '/api/v1/release', private: '/api/v1/release/private' });
  // #621：读端点也进启动日志 —— 部署验收时「闸在不在」不该靠试
  log('read_endpoints', { list: PRIVATE_LIST_PATH, download: PRIVATE_DOWNLOAD_PATH,
    privateManifest: PRIVATE_RELEASES_JSON, privateApkDir: PRIVATE_APK_DIR });
  // #641：令牌分工也进启动日志（**只有来源与状态，没有令牌值**）。
  // 部署验收时「只读令牌生没生效」一眼可读，不必拿真令牌去试写端点。
  log('token_roles', {
    write_token: 'enabled', write_file: TOKEN_FILE,
    read_token: READ_TOKEN_FALLBACK ? 'fallback_to_write' : 'dedicated',
    read_file: READ_TOKEN_FILE,
    matrix: 'read=read|write;write=write',
  });
  // 启动指纹也进日志：事后翻 journalctl 就能对上「那段时间跑的是哪一版」
  log('version_fingerprint', { sha256: SELF_SHA256, builtAt: STARTED_AT, node: process.version });
  const allow = await readVariantAllowlist();
  log('variant_config', { marker: VARIANT_MARKER, file: VARIANTS_FILE, entries: Object.keys(allow).length });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('shutdown', { signal: sig }); server.close(() => process.exit(0)); });
}
process.on('uncaughtException', (e) => log('uncaught_exception', { error: e.message }));
process.on('unhandledRejection', (e) => log('unhandled_rejection', { error: String(e) }));
