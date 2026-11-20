/**
 * dl-release 服务端 buildType 门禁的集成用例（Issue #330）。
 *
 * 2026-11-19 事故：上传接口照收 `buildType:"release"`，写进 releases.json 后客户端
 * parseManifest() 整份拒绝 → 所有版本「检查更新失败」。这里把「服务端会拦」变成可执行断言：
 *
 *   1) 非法 buildType → 400 BAD_BUILD_TYPE，且**零 I/O**（没解析 APK、没写临时文件、
 *      releases.json 字节不变）—— 用假 aapt2 的调用记录 + apk 目录清单 + sha256 三重证明；
 *   2) 字段缺失 → 保留历史行为，按版本号推导（buildTypeFor：-beta/-rc → prerelease）；
 *   3) 合法显式值原样写入（版本号推导会得 stable，显式 prerelease 必须写 prerelease）；
 *   4) 历史清单脏（早先写进去的 buildType:"release"）→ 409 MANIFEST_DIRTY，
 *      APK 与 releases.json **都不落盘**（校验在 rename 之前）。
 *
 * 为什么用假 aapt2：本机/CI 都没有 aapt2 二进制（真机在线上 /opt/dl-release/bin/aapt2），
 * 而这几条用例要验的是「服务的门禁顺序」，不是 aapt2 解析本身（那有 apk-manifest.test.mjs 与
 * Issue #60 的真机证据）。假 aapt2 只回放 badging 行，APK 本体是真 ZIP + 真 AXML（本地造的
 * 最小样例），所以 debuggable 判定、sha256、落盘链路都是真的。
 *
 * 运行：node --test deploy/dl-release/test/server-buildtype.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ATTR_DEBUGGABLE_RES_ID } from '../apk-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');

// ------------------------------------------------- 最小 AXML / ZIP（造一个真 APK）
// 与 deploy/dl-release/test/apk-manifest.test.mjs 同源的最小编码器：真 APK 不方便入库，
// 而服务端是用 apk-manifest.mjs 从 zip 里读 AndroidManifest.xml 判定 debuggable 的，
// 所以这里必须造「真 ZIP + 真 AXML」，不能拿假文件糊过去。

function chunk(type, headerSize, body) {
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(headerSize + body.length, 4);
  return Buffer.concat([head, body]);
}

function stringPool(strings) {
  const offsets = [];
  const bytes = [];
  for (const s of strings) {
    offsets.push(bytes.length);
    const utf8 = Buffer.from(s, 'utf8');
    const pushLen = (n) => {
      if (n > 0x7f) bytes.push(0x80 | ((n >> 8) & 0xff), n & 0xff);
      else bytes.push(n);
    };
    pushLen(s.length);
    pushLen(utf8.length);
    bytes.push(...utf8, 0);
  }
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(stringsStart + bytes.length, 4);
  head.writeUInt32LE(offsets.length, 8);
  head.writeUInt32LE(0, 12);
  head.writeUInt32LE(0x100, 16);
  head.writeUInt32LE(stringsStart, 20);
  head.writeUInt32LE(0, 24);
  const offBuf = Buffer.alloc(offsets.length * 4);
  offsets.forEach((o, i) => offBuf.writeUInt32LE(o, i * 4));
  return Buffer.concat([head, offBuf, Buffer.from(bytes)]);
}

function buildManifestAxml({ versionCode = 1, versionName = '0.0.0' } = {}) {
  const strings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    'manifest',
    'package',
    'versionCode',
    'versionName',
    'application',
    'debuggable',
    'com.example.deepseekchat',
    versionName,
  ];
  const RES = { 4: 0x0101021b, 5: 0x0101021c, 7: ATTR_DEBUGGABLE_RES_ID };
  const resMap = Buffer.alloc(strings.length * 4);
  for (const [idx, id] of Object.entries(RES)) resMap.writeUInt32LE(id, Number(idx) * 4);

  const NS = 1;
  const attr = (nameIdx, { rawValue = 0xffffffff, dataType = 0x00, data = 0 }) => {
    const b = Buffer.alloc(20);
    b.writeInt32LE(NS, 0);
    b.writeUInt32LE(nameIdx, 4);
    b.writeUInt32LE(rawValue >>> 0, 8);
    b.writeUInt16LE(8, 12);
    b.writeUInt8(0, 14);
    b.writeUInt8(dataType, 15);
    b.writeUInt32LE(data >>> 0, 16);
    return b;
  };
  const element = (nameIdx, attrs) => {
    const body = Buffer.alloc(20 + attrs.length * 20);
    body.writeUInt32LE(0xffffffff, 0);
    body.writeUInt32LE(nameIdx, 4);
    body.writeUInt16LE(20, 8);
    body.writeUInt16LE(20, 10);
    body.writeUInt16LE(attrs.length, 12);
    attrs.forEach((a, i) => a.copy(body, 20 + i * 20));
    return chunk(0x0102, 16, body);
  };

  const pkg = Buffer.alloc(20);
  pkg.writeInt32LE(-1, 0);
  pkg.writeUInt32LE(3, 4);
  pkg.writeInt32LE(8, 8);
  pkg.writeUInt16LE(8, 12);
  pkg.writeUInt8(0, 14);
  pkg.writeUInt8(0x03, 15);
  pkg.writeUInt32LE(8, 16);
  const manifestAttrs = [
    pkg,
    attr(4, { dataType: 0x10, data: versionCode }),
    attr(5, { rawValue: 9, dataType: 0x03, data: 9 }),
  ];

  const startNs = (() => {
    const body = Buffer.alloc(8);
    body.writeInt32LE(0, 0);
    body.writeInt32LE(NS, 4);
    const b = Buffer.alloc(16);
    b.writeUInt16LE(0x0100, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    return Buffer.concat([b, body]);
  })();

  // application 上**不写** android:debuggable（release 包常见形态）→ 服务端判定 debuggable=false
  const body = Buffer.concat([
    stringPool(strings),
    chunk(0x0180, 8, resMap),
    startNs,
    element(2, manifestAttrs),
    element(6, []),
  ]);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
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

const APK_BYTES = buildZip([
  { name: 'AndroidManifest.xml', data: buildManifestAxml({ versionCode: 18, versionName: '1.4.0' }) },
  { name: 'classes.dex', data: Buffer.from('dex\n035\0', 'binary') },
]);

// ------------------------------------------------------------------ 夹具 / 服务

const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => hex(fs.readFileSync(file));

const record = (over = {}) => ({
  version: '1.4.0',
  versionCode: 18,
  releasedAt: '2026-11-19T10:00:00+08:00',
  file: 'apk/deepseek-chat-1.4.0.apk',
  size: APK_BYTES.length,
  md5: '0'.repeat(32),
  sha256: 'a'.repeat(64),
  changes: ['事故前的老版本'],
  buildType: 'stable',
  breaking: false,
  artifactVariant: 'standard',
  artifactVariantSource: 'apk-manifest',
  ...over,
});

/** 内核分配的临时空闲端口（先 bind 再释放，避免测试之间撞端口） */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 起一个真服务端：临时目录、真 token、假 aapt2（只回放 badging） */
async function startServer() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-buildtype-'));
  const apkDir = path.join(work, 'apk');
  fs.mkdirSync(apkDir);
  const token = `test-token-${process.pid}-${Date.now()}`;
  const tokenFile = path.join(work, 'token');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const releasesFile = path.join(work, 'releases.json');
  const variantsFile = path.join(work, 'artifact-variants.json');
  // #620：公网端点只收 artifactVariant="standard" —— 这个夹具的 APK 没有变体标记
  // （它的 AXML 编码器不写 meta-data），所以在这里用**服务器侧白名单**把它的 sha256 登记成
  // standard（白名单本来就是给「没有标记的历史包」用的补救通道）。这样每一行验的仍是它
  // 自己要验的 buildType 契约，而不是被变体闸提前拦下。
  fs.writeFileSync(
    variantsFile,
    `${JSON.stringify({ apks: { [hex(APK_BYTES)]: { variant: 'standard', version: '1.4.0', note: '#620 夹具' } } }, null, 2)}\n`,
  );

  // 假 aapt2：每次调用记一行（用来断言「非法 buildType 根本没走到解析 APK」），
  // badging 从 badging.txt 回放，xmltree 空输出 = 无变体标记（unknown）。
  const stub = path.join(work, 'aapt2');
  const stubLog = path.join(work, 'aapt2-calls.log');
  const badgingFile = path.join(work, 'badging.txt');
  fs.writeFileSync(
    stub,
    `#!/bin/sh
echo "$*" >> "${stubLog}"
if [ "$1" = "dump" ] && [ "$2" = "badging" ]; then cat "${badgingFile}"; fi
exit 0
`,
    { mode: 0o755 },
  );

  const port = await freePort();
  const server = spawn(process.execPath, [SERVER], {
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

  // 等 /healthz 真起来再开测（不用固定 sleep，起不来就带着日志失败）
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) break;
    } catch { /* 还没起来 */ }
    if (server.exitCode !== null) throw new Error(`服务退出 code=${server.exitCode}:\n${logs.join('')}`);
    if (i > 100) throw new Error(`服务未在 10s 内起来:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    work,
    apkDir,
    releasesFile,
    token,
    stubLog,
    logs,
    badging: (versionName, versionCode) =>
      fs.writeFileSync(
        badgingFile,
        `package: name='com.example.deepseekchat' versionCode='${versionCode}' versionName='${versionName}'\n`,
      ),
    seed: (manifest) => fs.writeFileSync(releasesFile, `${JSON.stringify(manifest, null, 2)}\n`),
    post: async (meta, { apk = APK_BYTES, rawMeta } = {}) => {
      const fd = new FormData();
      fd.set('apk', new Blob([apk]), 'app-release.apk');
      fd.set('meta', rawMeta !== undefined ? rawMeta : JSON.stringify(meta));
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text };
    },
    stop: () => new Promise((resolve) => {
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

// ------------------------------------------------------------------ 用例

test('非法 buildType（release/debug/空串/null）→ 400 BAD_BUILD_TYPE，且零 I/O', async () => {
  ctx.seed({ latest: '1.4.0', releases: [record()] });
  const before = sha256File(ctx.releasesFile);
  const beforeApk = fs.readdirSync(ctx.apkDir);
  fs.writeFileSync(ctx.stubLog, '');

  for (const bad of ['release', 'debug', '', 'STABLE', 'beta']) {
    const r = await ctx.post({ buildType: bad, changes: ['不该落盘'] });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} 应 400，实际 ${r.status} ${r.text}`);
    assert.equal(r.json.code, 'BAD_BUILD_TYPE', '顶层 code 必须是 BAD_BUILD_TYPE');
    assert.equal(r.json.error.code, 'BAD_BUILD_TYPE', 'error.code 保持既有契约');
    assert.match(r.json.message, /stable \| prerelease/, 'message 要给出允许取值');
  }
  // JSON null 也要拦（typeof null === 'object'，不是合法枚举）
  const rNull = await ctx.post({ buildType: null });
  assert.equal(rNull.status, 400);
  assert.equal(rNull.json.code, 'BAD_BUILD_TYPE');

  assert.equal(sha256File(ctx.releasesFile), before, 'releases.json 必须字节不变（sha256 相同）');
  assert.deepEqual(fs.readdirSync(ctx.apkDir), beforeApk, 'apk 目录不许出现临时文件（零 I/O）');
  assert.deepEqual(fs.readdirSync(ctx.apkDir), [], 'apk 目录必须还是空的');
  assert.equal(fs.readFileSync(ctx.stubLog, 'utf8'), '', '非法 buildType 时不该解析 APK（aapt2 未调用）');
});

test('字段缺失 → 仍按 versionName 推导（-beta → prerelease），但公网清单只收 stable → 400 BUILD_TYPE_NOT_PUBLIC', async () => {
  // #620 / 裁决 #614 决定 2/3：预发布版不进公网清单（走 GitHub Release 的 prerelease 资产）。
  // 这条用例的**前半段语义没变**：推导还在（否则报错说不清是「没写」还是「写错了」），
  // 只是推导出来的 prerelease 现在被接口拒绝 —— 收紧，不是放宽。
  const before = sha256File(ctx.releasesFile);
  const beforeApk = fs.readdirSync(ctx.apkDir);
  ctx.badging('1.4.1-beta.1', 19);
  const r = await ctx.post({ changes: ['缺 buildType'] });
  assert.equal(r.status, 400, `推导出 prerelease 应被拒，实际 ${r.status} ${r.text}`);
  assert.equal(r.json.code, 'BUILD_TYPE_NOT_PUBLIC');
  assert.match(r.json.message, /prerelease/, '文案要说明推导结果是 prerelease（证明推导真的发生了）');
  assert.match(r.json.message, /GitHub Release/, '要指出预发布该走哪里');
  assert.equal(sha256File(ctx.releasesFile), before, '被拒后 releases.json 必须字节不变');
  assert.deepEqual(fs.readdirSync(ctx.apkDir), beforeApk, '被拒后 APK 目录必须不变（含无 .upload-* 残留）');
});

test('字段缺失 + 正式版本号 → stable（buildTypeFor 的另一个分支）', async () => {
  ctx.badging('1.5.0', 20);
  const r = await ctx.post({});
  assert.equal(r.status, 200, r.text);
  const man = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'));
  assert.equal(man.releases[0].buildType, 'stable');
});

test('合法显式值原样写入：显式 stable 写 stable；显式 prerelease 在公网端点被拒（#620）', async () => {
  // 「显式值不被版本号推导覆盖」这半条断言在私有端点仍然成立（见
  // server-variant-gate-620.test.mjs 的 V10：显式 prerelease + 推导会得 stable → 私有清单仍写 prerelease）。
  const before = sha256File(ctx.releasesFile);
  ctx.badging('1.6.0', 21);
  const rejected = await ctx.post({ buildType: 'prerelease', changes: ['显式预发布'] });
  assert.equal(rejected.status, 400, `公网端点不收 prerelease，实际 ${rejected.status} ${rejected.text}`);
  assert.equal(rejected.json.code, 'BUILD_TYPE_NOT_PUBLIC');
  assert.equal(sha256File(ctx.releasesFile), before, '被拒的上传不许改清单');

  const ok = await ctx.post({ buildType: 'stable', changes: ['显式渠道'] });
  assert.equal(ok.status, 200, ok.text);
  const man = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'));
  assert.equal(man.releases[0].version, '1.6.0');
  assert.equal(man.releases[0].buildType, 'stable');
});

test('历史清单脏（buildType:"release"）→ 409 MANIFEST_DIRTY，APK 与 releases.json 都不落盘', async () => {
  // 事故现场形态：老条目是非法值，新上传本身合法 —— 不许「新的干净就写」
  ctx.seed({
    latest: '1.4.0',
    releases: [record({ buildType: 'release' })],
  });
  const before = sha256File(ctx.releasesFile);
  const beforeApk = fs.readdirSync(ctx.apkDir);
  ctx.badging('1.7.0', 22);

  const r = await ctx.post({ buildType: 'stable', changes: ['应被整单拒收'] });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'MANIFEST_DIRTY');
  assert.equal(r.json.error.code, 'MANIFEST_DIRTY');
  assert.match(r.json.message, /1 条 buildType 非法/, '要报出脏条目数');
  assert.match(r.json.message, /1\.4\.0/, '要指出是哪个版本脏');

  assert.equal(sha256File(ctx.releasesFile), before, 'releases.json 必须字节不变');
  assert.deepEqual(fs.readdirSync(ctx.apkDir), beforeApk, 'APK 不许落盘');
  assert.ok(
    !fs.readdirSync(ctx.apkDir).some((f) => f.includes('1.7.0') || f.startsWith('.upload-')),
    `apk 目录不许出现 1.7.0 的包或 .upload-* 残留：${fs.readdirSync(ctx.apkDir).join(',')}`,
  );
});

test('清单干净 + 合法 buildType → 200，且落盘的清单整份合法', async () => {
  ctx.seed({ latest: '1.4.0', releases: [record()] });
  ctx.badging('1.8.0', 23);
  const r = await ctx.post({ buildType: 'stable', changes: ['正常发布'] });
  assert.equal(r.status, 200, r.text);
  const man = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'));
  assert.equal(man.latest, '1.8.0');
  assert.deepEqual(man.releases.map((x) => x.buildType), ['stable', 'stable']);
  assert.ok(fs.existsSync(path.join(ctx.apkDir, 'deepseek-chat-1.8.0.apk')), 'APK 应已落盘');
});
