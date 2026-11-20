// [layer: server | 纯 Node，无网络无 aapt2 | 耗时: <1s]
// Issue #601 技术兜底：**回环 consume.baseUrl** 的判据与抽取。
//
// 事故（2026-11-20 22:14）：一个 `consume.baseUrl = http://127.0.0.1:18000` 的 internal 包被发到
// 公网分发机，公网可见约 30 分钟。这种包在真机上连不上任何后端（127.0.0.1 是手机自己），
// 只对本机 adb reverse 联调有意义，却和普通包长得一模一样。
//
// 上传侧的两道闸都靠这里的判据：
//   - `extractConsumeBaseUrl()`：从 APK 的 JS bundle 里抽出 `consume.baseUrl`（`__ENDPOINTS__` 内联处）；
//   - `isLoopbackBaseUrl()` / `assessLoopbackConsume()`：判定 + 按变体决定拦还是放行。
// 这里钉住它们的行为，尤其是「抽不到 ≠ 回环」这条取舍（宁可告警放行，也不误杀正常发布）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONSUME_BASE_URL_PATTERN, extractConsumeBaseUrl, readZipEntry } from '../apk-manifest.mjs';
import { isLoopbackBaseUrl, isLoopbackHost } from '../../../shared/loopback-consume.mjs';
import { assessLoopbackConsume } from '../../../scripts/lib/consumeEndpoints.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

/**
 * 造一个最小 zip（只够本模块读：中央目录 + 本地头；CRC 不校验，所以填 0）。
 * 不用第三方库：这条用例要能在任何机器上离线跑，与 apk-manifest.mjs 的「零依赖」口径一致。
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const plain = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.deflate ? zlib.deflateRawSync(plain) : plain;
    const method = entry.deflate ? 8 : 0;
    const name = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 真实产物里的形态：压缩器把键名的引号去掉了（实测 `consume:{baseUrl:"…"}`） */
const BUNDLE_LOOPBACK =
  'var E={chatBaseUrl:"http://140.210.13.146:60010",consume:{baseUrl:"http://127.0.0.1:18000",' +
  'apiV1Prefix:"/api/v1",gatewayPrefix:"/v1",timeoutMs:{read:10000,write:20000,redeem:30000}}};';

test('#601：从 APK 的 JS bundle 里抽出回环 consume.baseUrl（键名无反引号，真实压缩形态）', () => {
  const apk = makeZip([{ name: 'assets/public/static/js/main.abcdef12.js', data: BUNDLE_LOOPBACK, deflate: true }]);
  const got = extractConsumeBaseUrl(apk);
  assert.equal(got.reason, 'ok');
  assert.equal(got.baseUrl, 'http://127.0.0.1:18000');
  assert.equal(got.source, 'assets/public/static/js/main.abcdef12.js');
  assert.equal(got.scanned, 1);
  assert.equal(isLoopbackBaseUrl(got.baseUrl), true, '抽出来的地址必须判成回环');
});

test('#601：https base 不算回环（正常包不许被误杀）', () => {
  const apk = makeZip([
    {
      name: 'assets/public/static/js/main.deadbeef.js',
      data: 'var E={consume:{baseUrl:"https://consume.example.com",apiV1Prefix:"/api/v1"}};',
      deflate: true,
    },
  ]);
  const got = extractConsumeBaseUrl(apk);
  assert.equal(got.baseUrl, 'https://consume.example.com');
  assert.equal(isLoopbackBaseUrl(got.baseUrl), false);
});

test('#601：带引号的键名（未压缩形态）同样能抽', () => {
  const apk = makeZip([
    {
      name: 'assets/public/js/app.js',
      data: '{"consume": {"baseUrl": "http://localhost:18000", "apiV1Prefix": "/api/v1"}}',
    },
  ]);
  const got = extractConsumeBaseUrl(apk);
  assert.equal(got.baseUrl, 'http://localhost:18000');
  assert.equal(isLoopbackBaseUrl(got.baseUrl), true, 'localhost 也是回环');
});

test('#601：抽不到时返回 null + 明确 reason（**不是**回环，调用方要放行 + 告警）', () => {
  const noJs = makeZip([{ name: 'AndroidManifest.xml', data: '<binary>' }]);
  assert.deepEqual(extractConsumeBaseUrl(noJs), {
    baseUrl: null,
    source: null,
    reason: 'no_js_assets',
    scanned: 0,
  });

  const noSegment = makeZip([{ name: 'assets/public/static/js/main.js', data: 'var x={pay:{baseUrl:"https://a.b"}};' }]);
  const got = extractConsumeBaseUrl(noSegment);
  assert.equal(got.baseUrl, null);
  assert.equal(got.reason, 'no_match');

  // 不是 zip：读不出来 ≠ 回环
  const junk = extractConsumeBaseUrl(Buffer.from('definitely not a zip'));
  assert.equal(junk.baseUrl, null);
  assert.equal(junk.reason, 'zip_failed');
});

test('#601：APK 路径与 Buffer 两种入参结果一致（服务端走 Buffer，脚本走路径）', () => {
  const apk = makeZip([{ name: 'assets/public/static/js/main.js', data: BUNDLE_LOOPBACK, deflate: true }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk601-'));
  const file = path.join(dir, 'a.apk');
  fs.writeFileSync(file, apk);
  try {
    assert.deepEqual(extractConsumeBaseUrl(file), extractConsumeBaseUrl(apk));
    assert.equal(readZipEntry(apk, 'assets/public/static/js/main.js') !== null, true, 'readZipEntry 仍能读到同名条目');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#601：回环主机判定覆盖 127.0.0.1 / localhost / ::1，且不误判同形域名', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, `${host} 是回环`);
  }
  for (const host of ['127.0.0.10', 'localhost.evil.com', 'example.com', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不是回环`);
  }
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:18000'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost:18000'), true);
  assert.equal(isLoopbackBaseUrl('http://[::1]:18000'), true);
  assert.equal(isLoopbackBaseUrl('https://127.0.0.1'), true, '回环判定与协议无关（https 回环仍是回环）');
  assert.equal(isLoopbackBaseUrl('http://127.0.0.10:18000'), false);
  assert.equal(isLoopbackBaseUrl(''), false);
  assert.equal(isLoopbackBaseUrl('not a url'), false, '解析不出来不算回环（形状错误由 schema 校验去报）');
});

test('#601：构建期判定 —— internal+回环默认拦，显式开关放行且要求打标记', () => {
  const blocked = assessLoopbackConsume({ variant: 'internal', baseUrl: 'http://127.0.0.1:18000' });
  assert.equal(blocked.loopback, true);
  assert.equal(blocked.blocked, true, 'internal + 回环 + 没开开关 = 必须拦');
  assert.match(blocked.message, /internal 变体 \+ 回环 baseUrl 默认禁止出包/);
  assert.match(blocked.message, /ALLOW_LOOPBACK_CONSUME=1/, '报错必须告诉人怎么显式放行');
  assert.match(blocked.message, /adb reverse/, '报错必须说清本地联调怎么做');

  const allowed = assessLoopbackConsume({ variant: 'internal', baseUrl: 'http://127.0.0.1:18000', allowLoopback: true });
  assert.equal(allowed.blocked, false, '显式开关要能放行（本地联调需要出包）');
  assert.equal(allowed.mark, true, '放行的产物必须打回环标记，供上传侧识别');

  // standard + 回环：现状保留（仓库 config 就是回环，硬失败会让整条链路当天全红），只告警 + 打标记
  const standard = assessLoopbackConsume({ variant: 'standard', baseUrl: 'http://127.0.0.1:18000' });
  assert.equal(standard.blocked, false);
  assert.equal(standard.mark, true);

  // 非回环：什么都不做（任何变体都不受影响）
  for (const variant of ['internal', 'standard']) {
    const clean = assessLoopbackConsume({ variant, baseUrl: 'https://consume.example.com' });
    assert.deepEqual(clean, { loopback: false, blocked: false, mark: false, message: '' });
  }
});

test('#601：抽取判据对「consume 段之外的 baseUrl」不误报（pay 在前 / migration 在后）', () => {
  const text =
    '{"pay":{"baseUrl":"https://apia.ecsafe.cn"},"consume":{"baseUrl":"http://127.0.0.1:18000"},' +
    '"migration":{"baseUrl":"http://127.0.0.1:9999","enabled":false}}';
  const m = CONSUME_BASE_URL_PATTERN.exec(text);
  assert.equal(m[1], 'http://127.0.0.1:18000', '只能匹配 consume 段里的那个 baseUrl');
});

test('#601：真实仓库产物若已构建，则 dist/build-info.json 必须带 loopbackConsume 标记', (t) => {
  const file = path.join(ROOT, 'dist/build-info.json');
  if (!fs.existsSync(file)) return t.skip('没有 dist/build-info.json（未构建）');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(
    typeof info.loopbackConsume,
    'boolean',
    'build-info.json 必须写明这份产物是不是回环地址（上传侧 / 事后取证都靠它）',
  );
});

// ---------------------------------------------------------------------------
// 端到端：真起一个 dl-release 服务端（临时目录 + 假 aapt2），POST 一个带着回环 baseUrl 的 APK。
// 这一条是「事故复现 → 必被拒收」的机械证明：判据写歪了、错误码变了、或者落盘顺序被调过，
// 这里都会红。只用本地 127.0.0.1 的临时实例，不碰任何线上分发机。
// ---------------------------------------------------------------------------

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 起服务端：假 aapt2 只回放 badging（本用例的判定不依赖 xmltree） */
async function startServer() {
  const { spawn } = await import('node:child_process');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-loopback-'));
  const apkDir = path.join(work, 'apk');
  fs.mkdirSync(apkDir);
  const token = `test-token-${process.pid}-${Date.now()}`;
  const tokenFile = path.join(work, 'token');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const releasesFile = path.join(work, 'releases.json');
  const variantsFile = path.join(work, 'artifact-variants.json');
  fs.writeFileSync(variantsFile, '{"apks":{}}\n');
  const badgingFile = path.join(work, 'badging.txt');
  fs.writeFileSync(
    badgingFile,
    "package: name='com.example.deepseekchat' versionCode='21' versionName='1.4.2'\n",
  );
  const stub = path.join(work, 'aapt2');
  fs.writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "dump" ] && [ "$2" = "badging" ]; then cat "${badgingFile}"; fi\nexit 0\n`,
    { mode: 0o755 },
  );

  const port = await freePort();
  const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_APK_DIR: apkDir,
      DL_RELEASES_JSON: releasesFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_AAPT2: stub,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: '1000',
      DL_PUBLIC_BASE: 'https://dl.example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(String(c)));
  server.stderr.on('data', (c) => logs.push(String(c)));

  for (let i = 0; ; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (server.exitCode !== null) throw new Error(`服务退出 code=${server.exitCode}:\n${logs.join('')}`);
    if (i > 100) throw new Error(`服务未在 10s 内起来:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const seed = () =>
    fs.writeFileSync(
      releasesFile,
      `${JSON.stringify(
        {
          latest: '1.4.1',
          releases: [
            {
              version: '1.4.1',
              versionCode: 20,
              releasedAt: '2026-11-19T20:00:00+08:00',
              file: 'apk/deepseek-chat-1.4.1.apk',
              size: 1000,
              md5: '0'.repeat(32),
              sha256: 'a'.repeat(64),
              changes: ['基线'],
              buildType: 'stable',
              breaking: false,
              artifactVariant: 'standard',
              artifactVariantSource: 'apk-manifest',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

  const post = async (apk) => {
    const fd = new FormData();
    fd.set('apk', new Blob([apk]), 'app-release.apk');
    fd.set('meta', JSON.stringify({ version: '1.4.2', versionCode: 21, changes: ['#601 对照'] }));
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/release`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  return {
    apkDir,
    releasesFile,
    logs,
    seed,
    post,
    stop: () =>
      new Promise((resolve) => {
        server.once('exit', resolve);
        server.kill('SIGTERM');
      }),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  };
}

const ctx = await startServer();
test.after(async () => {
  await ctx.stop();
  ctx.cleanup();
});

/**
 * 一份**真的** AXML（aapt2 link 出来的最小 AndroidManifest.xml，1 KB，不含 debuggable 属性）。
 * 服务端在回环校验之前还要过「debuggable 必须为 false」那道闸（#60），随便塞几个字节会被
 * APK_DEBUGGABLE 挡在前面 —— 那样这条用例就测不到本单的判据了，所以用真清单。
 */
const AXML = fs.readFileSync(path.join(HERE, 'fixtures/minimal-manifest.axml'));

test('#601：POST /api/v1/release 收到回环 baseUrl 的 APK → 400 BAD_CONSUME_BASE，且不落盘', async () => {
  ctx.seed();
  const apk = makeZip([
    { name: 'assets/public/static/js/main.abcdef12.js', data: BUNDLE_LOOPBACK, deflate: true },
    { name: 'AndroidManifest.xml', data: AXML },
  ]);
  const before = fs.readFileSync(ctx.releasesFile, 'utf8');

  const res = await ctx.post(apk);
  assert.equal(res.status, 400, `必须 400，实际 ${res.status}：${res.text}`);
  assert.equal(res.json?.code, 'BAD_CONSUME_BASE', '错误码必须是 BAD_CONSUME_BASE（发布脚本按它判）');
  assert.match(res.json?.message ?? '', /127\.0\.0\.1:18000/, '错误信息要点出真实地址');
  assert.equal(
    fs.readdirSync(ctx.apkDir).length,
    0,
    '拒绝时不许留下任何文件（临时文件也要清掉）',
  );
  assert.equal(fs.readFileSync(ctx.releasesFile, 'utf8'), before, 'releases.json 一个字节都不许动');
  assert.match(ctx.logs.join(''), /event=reject_loopback_consume/, '拒绝要留可事后核查的一条日志');
});

test('#601：抽不到 consume.baseUrl 的包 → 放行（200）并在响应里 warn', async () => {
  ctx.seed();
  const apk = makeZip([{ name: 'AndroidManifest.xml', data: AXML }]);
  const res = await ctx.post(apk);
  assert.equal(res.status, 200, `老包不该被误杀：${res.text}`);
  assert.equal(res.json?.consumeBaseUrl, null);
  assert.equal(Array.isArray(res.json?.warnings), true);
  assert.match(res.json.warnings.join('\n'), /未能从 APK 的 JS bundle 抽出 consume\.baseUrl/);
  assert.match(ctx.logs.join(''), /event=consume_base_unverified/);
});
