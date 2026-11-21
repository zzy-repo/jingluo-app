// [layer: L1（零外部依赖：真 HTTP 服务 + 真 ZIP/AXML + 假 aapt2） | 耗时: ~5s]
//
// **读令牌与发布令牌严格分离**（Issue #641 的 DoD）—— 两枚令牌各管一边，交叉一律 401。
//
// 起点（#621 + #622）：私有清单的读端点与发布端点共用一枚令牌 `/etc/dl-release/token`，
// 而 #622 把这枚令牌**随 internal 包装到测试者设备上**（构建期 `DL_PRIVATE_TOKEN` → `X-DL-Token`）。
// 于是「拿到内测包的人」手里那枚令牌不只读清单、下私有包，还能 `POST /api/v1/release`
// （**覆盖正式分发包**）。读能力随包扩散是可接受的代价，写能力随包扩散不是。
//
// 落地顺序（不能反）：`/etc/dl-release/token` **保留为读令牌**（已发出的内测包里就是它，
// 轮换它 = 全员断读），新建 `/etc/dl-release/publish-token` 作为写令牌。这样「写能力随包扩散」
// 当场被切断，而读不受影响。
//
// 本文件钉住的矩阵（**两个方向都是核心断言，缺一个就等于没拆**）：
//
//   | 端点                                     | 读令牌   | 发布令牌 |
//   | ---------------------------------------- | -------- | -------- |
//   | GET  /api/v1/releases/internal            | 200      | **401**  |
//   | GET  /api/v1/releases/internal/download   | 200      | **401**  |
//   | GET  /api/v1/version                      | 免令牌   | 免令牌   |
//   | POST /api/v1/release                      | **401**  | 200      |
//   | POST /api/v1/release/private              | **401**  | 200      |
//
// 同源约束（坏掉任何一条，「拆令牌」就还是纸面上的）：
//   1. **fail-closed**：`publish-token` 缺失 / 为空 / 与读令牌同值 → **写端点一律 401**，
//      绝不回落成「写也认读令牌」（那等于把 #622 的泄漏原样复活）。服务照常起，读不受影响。
//   2. **读令牌缺失 → 服务不启动**（`event=fatal_token`）：读端点没有备胎，起不来比全 401 好排查。
//   3. **401 同形**：「没令牌」与「令牌不对」的**状态码、code、message 逐字节相同**，不给探测留差异。
//   4. **令牌值不进日志**：日志只有来源文件与长度（本文件有静态扫描断言）。
//   5. **拒收零副作用**：401 之后公网清单 / 私有清单 / APK 目录必须逐字节不变。
//
// 为什么起真服务端而不是打桩：鉴权在 `server.mjs` 的路由里，判据（读端点只认读、写端点只认发布）
// 与「顺序」（鉴权先于一切存在性/格式判断）都是契约本身，打桩验的是复制出来的第二份逻辑。
//
// 运行：node --test deploy/dl-release/test/publish-token-641.test.mjs（或 pnpm run test:dl-release）

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApk } from '../../../tests/fixtures/domain10/apk-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')
const APK_MANIFEST = path.join(ROOT, 'deploy/dl-release/apk-manifest.mjs')
const VARIANT_MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT'

const LIST = '/api/v1/releases/internal'
const DOWNLOAD = '/api/v1/releases/internal/download'
const VERSION = '/api/v1/version'

// 两枚**不同的**令牌：值是假的，但形状与线上一致（线上是 `openssl rand -hex 21` = 42 字符）
const READ_TOKEN = 'a'.repeat(21).repeat(2) // 42 字符
const PUBLISH_TOKEN = 'b'.repeat(21).repeat(2) // 42 字符
assert.notEqual(READ_TOKEN, PUBLISH_TOKEN)
assert.equal(READ_TOKEN.length, 42)

const APK_STANDARD = buildApk({ metaData: { [VARIANT_MARKER]: 'standard' }, versionName: '1.4.4', versionCode: 23 })
const APK_INTERNAL = buildApk({ metaData: { [VARIANT_MARKER]: 'internal' }, versionName: '1.4.4', versionCode: 23 })

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const sha256File = (file) => sha256Of(fs.readFileSync(file))

/** 私有包：随机字节（读端点不解析内容，只需要「是个文件、在清单里」） */
function writePrivateApk(dir, name, bytes = 4096) {
  const body = crypto.randomBytes(bytes)
  fs.writeFileSync(path.join(dir, name), body)
  return {
    name,
    size: body.length,
    md5: crypto.createHash('md5').update(body).digest('hex'),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    body,
  }
}

// 私有清单种子的 versionCode 必须**小于**下面要发布的 23，否则防降级闸先拦（那不是本文件要验的）
const privateEntry = (apk) => ({
  version: '1.4.3-internal',
  versionCode: 22,
  releasedAt: '2026-11-21T09:00:00+08:00',
  file: `apk/${apk.name}`,
  size: apk.size,
  md5: apk.md5,
  sha256: apk.sha256,
  changes: ['内测构建'],
  buildType: 'prerelease',
  artifactVariant: 'internal',
  artifactVariantSource: 'apk-manifest',
})

/** 公网清单里的一条历史 standard 记录（发布的前置：versionCode 必须更大） */
const publicRecord = (over = {}) => ({
  version: '1.4.3',
  versionCode: 22,
  releasedAt: '2026-11-20T10:00:00+08:00',
  file: 'apk/deepseek-chat-1.4.3.apk',
  size: 4096,
  md5: '0'.repeat(32),
  sha256: 'a'.repeat(64),
  changes: ['历史标准包'],
  buildType: 'stable',
  breaking: false,
  artifactVariant: 'standard',
  artifactVariantSource: 'apk-manifest',
  ...over,
})

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

/**
 * 假 aapt2：从**真 ZIP 里的真 AXML 字节**转述 aapt2 的两种输出（与 #620 的用例同一招）。
 * 起真 aapt2 要 Android SDK，而这里要验的是鉴权，不是 APK 解析质量。
 */
const STUB_SOURCE = (manifestModule) => `#!/usr/bin/env node
import fs from 'node:fs';
import { parseBinaryXml, readZipEntry } from ${JSON.stringify(manifestModule)};

const argv = process.argv.slice(2);
if (argv[0] !== 'dump') process.exit(2);
const mode = argv[1];
const file = argv[2];
let doc;
try {
  doc = parseBinaryXml(readZipEntry(fs.readFileSync(file), 'AndroidManifest.xml'));
} catch {
  process.exit(3);
}
const decode = (attr) => {
  if (!attr) return '';
  if (typeof attr.rawValue === 'string') return attr.rawValue;
  if (attr.dataType === 0x03) return doc.strings[attr.data] ?? '';
  if (attr.dataType === 0x12) return attr.data !== 0 ? 'true' : 'false';
  if (attr.dataType === 0x10 || attr.dataType === 0x11) return String(attr.data);
  return '';
};
const pick = (attrs, name) => attrs.find((a) => a.name === name);
const manifest = doc.elements.find((el) => el.name === 'manifest') ?? { attrs: [] };
if (mode === 'badging') {
  const versionCode = pick(manifest.attrs, 'versionCode');
  process.stdout.write(
    "package: name='" + decode(pick(manifest.attrs, 'package')) +
    "' versionCode='" + (versionCode ? versionCode.data : 0) +
    "' versionName='" + decode(pick(manifest.attrs, 'versionName')) + "'\\n",
  );
  process.exit(0);
}
if (mode === 'xmltree') {
  const lines = ['E: manifest (line=2)'];
  for (const el of doc.elements.filter((e) => e.name === 'meta-data')) {
    lines.push(
      'E: application (line=6)',
      '  E: meta-data (line=7)',
      '    A: http://schemas.android.com/apk/res/android:name(0x01010003)="' +
        decode(pick(el.attrs, 'name')) + '"',
      '    A: http://schemas.android.com/apk/res/android:value(0x01010024)="' +
        decode(pick(el.attrs, 'value')) + '"',
    );
  }
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
}
process.exit(2);
`

/**
 * 起一台真服务端，目录形状就是线上的形状（私有根在 webroot 之外，否则服务拒绝启动）：
 *   work/webroot/  releases.json + apk/              ← 公网（Caddy file_server 直接服）
 *   work/private/  releases.internal.json + apk/     ← 私有（webroot 之外）
 *
 * `readToken` / `publishToken` 的取值语义：
 *   · 字符串 → 写一个同名替身文件（`DL_TOKEN_FILE` / `DL_PUBLISH_TOKEN_FILE` 指过去）
 *   · `null` → **不建文件**（缺失路径）
 *   · `''`   → 建一个空文件（「文件在但没内容」）
 */
const startServer = async ({
  readToken = READ_TOKEN,
  publishToken = PUBLISH_TOKEN,
  rateLimitMax = 1000,
} = {}) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-token-641-'))
  const webroot = path.join(work, 'webroot')
  const apkDir = path.join(webroot, 'apk')
  fs.mkdirSync(apkDir, { recursive: true })
  const releasesFile = path.join(webroot, 'releases.json')
  fs.writeFileSync(releasesFile, `${JSON.stringify({ latest: '1.4.3', releases: [publicRecord()] }, null, 2)}\n`)

  const privateRoot = path.join(work, 'private')
  const privateApkDir = path.join(privateRoot, 'apk')
  fs.mkdirSync(privateApkDir, { recursive: true })
  const privateManifestFile = path.join(privateRoot, 'releases.internal.json')
  const apks = [writePrivateApk(privateApkDir, 'deepseek-chat-1.4.4-internal.apk')]
  fs.writeFileSync(privateManifestFile, `${JSON.stringify({
    latest: '1.4.3-internal', releases: apks.map(privateEntry),
  }, null, 2)}\n`)

  const readTokenFile = path.join(work, 'token') // 线上 /etc/dl-release/token
  if (readToken !== null) fs.writeFileSync(readTokenFile, readToken === '' ? '' : `${readToken}\n`, { mode: 0o600 })
  const publishTokenFile = path.join(work, 'publish-token') // 线上 /etc/dl-release/publish-token
  if (publishToken !== null) {
    fs.writeFileSync(publishTokenFile, publishToken === '' ? '' : `${publishToken}\n`, { mode: 0o600 })
  }

  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, '{"apks":{}}\n')

  const stubMjs = path.join(work, 'aapt2-stub.mjs')
  fs.writeFileSync(stubMjs, STUB_SOURCE(APK_MANIFEST), { mode: 0o755 })
  const stub = path.join(work, 'aapt2')
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${stubMjs}" "$@"\n`, { mode: 0o755 })

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: readTokenFile,
      DL_PUBLISH_TOKEN_FILE: publishTokenFile,
      DL_WEBROOT: webroot,
      DL_APK_DIR: apkDir,
      DL_RELEASES_JSON: releasesFile,
      DL_PRIVATE_ROOT: privateRoot,
      DL_PRIVATE_APK_DIR: privateApkDir,
      DL_PRIVATE_RELEASES_JSON: privateManifestFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_AAPT2: stub,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: String(rateLimitMax),
      DL_PRIVATE_READ_RATE_LIMIT_MAX: '200',
      DL_PUBLIC_BASE: 'https://dl.example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))

  for (let attempt = 0; ; attempt += 1) {
    if (child.exitCode !== null) {
      // 服务没起来：把日志交给调用方（有的用例**期望**起不来，见「读令牌缺失」那条）
      return {
        started: false,
        exitCode: child.exitCode,
        logs,
        exited,
        cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
        stop: async () => {},
      }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    if (attempt > 100) throw new Error(`服务 10s 内没起来:\n${logs.join('')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const call = (p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, init)

  /** 两种令牌写法都收（`X-DL-Token` / `Authorization: Bearer`），两处必须同判。 */
  const readWith = (token, p = LIST) =>
    Promise.all([
      call(p, { headers: { 'X-DL-Token': token } }).then((r) => ({ status: r.status })),
      call(p, { headers: { Authorization: `Bearer ${token}` } }).then((r) => ({ status: r.status })),
    ])

  /** 发布：默认走 `Authorization: Bearer`（发布脚本从 #619 起就是这么写的）。 */
  const post = async (endpoint, { apk, token, header = 'bearer' } = {}) => {
    const form = new FormData()
    form.set('apk', new Blob([apk]), 'app-release.apk')
    form.set('meta', JSON.stringify({ changes: ['#641 用例'] }))
    const headers = token
      ? (header === 'bearer' ? { Authorization: `Bearer ${token}` } : { 'X-DL-Token': token })
      : {}
    const res = await call(endpoint, { method: 'POST', headers, body: form })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }

  return {
    started: true,
    port,
    work,
    webroot,
    apkDir,
    releasesFile,
    privateRoot,
    privateApkDir,
    privateManifestFile,
    apks,
    logs,
    call,
    readWith,
    post,
    /** 全部落盘状态：拒收类用例一律先拍快照，再断言「什么都没变」 */
    snapshot: () => ({
      publicSha: sha256File(releasesFile),
      publicApk: fs.readdirSync(apkDir).sort(),
      privateSha: sha256File(privateManifestFile),
      privateApk: fs.readdirSync(privateApkDir).sort(),
    }),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', resolve)
        child.kill('SIGTERM')
      }),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

const withServer = async (setup, body) => {
  const ctx = await startServer(setup)
  assert.equal(ctx.started, true, `服务必须能起来：\n${ctx.logs?.join('') ?? ''}`)
  try {
    await body(ctx)
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
}

// ---------------------------------------------------------------- 读令牌：能读
test('读令牌 → GET 私有清单 200（X-DL-Token 与 Bearer 两种写法同判）', async () => {
  await withServer({}, async (ctx) => {
    for (const r of await ctx.readWith(READ_TOKEN, LIST)) {
      assert.equal(r.status, 200, '读令牌必须能读清单（已发出的内测包靠这一枚）')
    }
    const res = await ctx.call(LIST, { headers: { 'X-DL-Token': READ_TOKEN } })
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.releases) && body.releases.length === 1)
    assert.equal(body.releases[0].artifactVariant, 'internal')
  })
})

test('读令牌 → GET 私有包下载 200，字节与磁盘一致', async () => {
  await withServer({}, async (ctx) => {
    const apk = ctx.apks[0]
    const res = await ctx.call(`${DOWNLOAD}?file=${encodeURIComponent(apk.name)}`, {
      headers: { 'X-DL-Token': READ_TOKEN },
    })
    assert.equal(res.status, 200, '读令牌必须能下私有包')
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${apk.name}"`)
    const got = Buffer.from(await res.arrayBuffer())
    assert.equal(got.length, apk.size)
    assert.equal(sha256Of(got), apk.sha256, '下到的字节必须与磁盘上的包一致')
  })
})

// ---------------------------------------------------------------- 读令牌：不能写（核心方向 1/2）
test('【核心】读令牌 → POST /api/v1/release = 401，且公网清单与 APK 目录零变化', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const res = await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: READ_TOKEN })
    assert.equal(res.status, 401, '读令牌（= 随内测包分发的那一枚）发布公网包必须 401')
    assert.equal(res.json?.error?.code ?? res.json?.code, 'UNAUTHORIZED')
    // 回包不许回显令牌 / 也不许解释「读令牌缺什么权限」（那是给攻击者的提示）
    assert.ok(!res.text.includes(READ_TOKEN) && !res.text.includes(PUBLISH_TOKEN), '401 回包不得回显任何令牌')
    assert.deepEqual(ctx.snapshot(), before, '被拒的发布不许改动线上任何字节')
  })
})

test('【核心】读令牌 → POST /api/v1/release/private = 401，且私有清单与私有目录零变化', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const res = await ctx.post('/api/v1/release/private', { apk: APK_INTERNAL, token: READ_TOKEN })
    assert.equal(res.status, 401, '读令牌也不许发私有包（它随内测包分发到设备上）')
    assert.equal(res.json?.error?.code ?? res.json?.code, 'UNAUTHORIZED')
    assert.deepEqual(ctx.snapshot(), before, '私有清单/私有目录必须逐字节不变')
  })
})

// ---------------------------------------------------------------- 发布令牌：不能读（核心方向 2/2）
test('【核心】发布令牌 → GET 私有清单 401、GET 私有包下载 401（两枚互不包含）', async () => {
  await withServer({}, async (ctx) => {
    for (const r of await ctx.readWith(PUBLISH_TOKEN, LIST)) {
      assert.equal(r.status, 401, '发布令牌不许读私有清单（超集会让两枚边界糊掉，本单明确拒绝）')
    }
    const apk = ctx.apks[0]
    const dl = await ctx.call(`${DOWNLOAD}?file=${encodeURIComponent(apk.name)}`, {
      headers: { 'X-DL-Token': PUBLISH_TOKEN },
    })
    assert.equal(dl.status, 401, '发布令牌不许下私有包')
    const body = await dl.json()
    assert.equal(body.error.code, 'UNAUTHORIZED')
  })
})

// ---------------------------------------------------------------- 发布令牌：能写
test('发布令牌 → POST /api/v1/release 200，公网清单被原子更新', async () => {
  await withServer({}, async (ctx) => {
    const res = await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: PUBLISH_TOKEN })
    assert.equal(res.status, 200, `发布令牌必须能发公网包：${res.text}`)
    assert.equal(res.json.target, 'public')
    const manifest = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
    assert.equal(manifest.latest, '1.4.4')
    assert.equal(manifest.releases.length, 2)
    assert.ok(fs.readdirSync(ctx.apkDir).some((f) => f.endsWith('.apk')), 'APK 必须落盘')
    assert.match(ctx.logs.join(''), /event=release_ok/)
  })
})

test('发布令牌 → POST /api/v1/release/private 200，私有清单被原子更新', async () => {
  await withServer({}, async (ctx) => {
    const beforePrivateApk = fs.readdirSync(ctx.privateApkDir).sort()
    const res = await ctx.post('/api/v1/release/private', { apk: APK_INTERNAL, token: PUBLISH_TOKEN })
    assert.equal(res.status, 200, `发布令牌必须能发私有包：${res.text}`)
    assert.equal(res.json.target, 'private')
    const manifest = JSON.parse(fs.readFileSync(ctx.privateManifestFile, 'utf8'))
    assert.equal(manifest.latest, '1.4.4')
    assert.ok(manifest.releases.every((r) => r.artifactVariant === 'internal'))
    assert.ok(fs.readdirSync(ctx.privateApkDir).length > beforePrivateApk.length, '私有包必须落进私有目录')
  })
})

test('写端点只认 Bearer：发布令牌放在 X-DL-Token 上仍 401（历史契约不变）', async () => {
  await withServer({}, async (ctx) => {
    const res = await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: PUBLISH_TOKEN, header: 'x-dl-token' })
    assert.equal(res.status, 401, '写路径从 #619 起只收 Authorization: Bearer，本单不改这条')
  })
})

// ---------------------------------------------------------------- 免令牌端点
test('/api/v1/version 免令牌（两枚令牌都不需要）', async () => {
  await withServer({}, async (ctx) => {
    const res = await ctx.call(VERSION)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.targets) && body.targets.includes('private'))
  })
})

// ---------------------------------------------------------------- 无令牌 / 错令牌（同形）
test('无令牌 → 读端点 401、写端点 401（写端点即使空 body 也先 401）', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    assert.equal((await ctx.call(LIST)).status, 401)
    assert.equal((await ctx.call(`${DOWNLOAD}?file=${encodeURIComponent(ctx.apks[0].name)}`)).status, 401)
    for (const endpoint of ['/api/v1/release', '/api/v1/release/private']) {
      const res = await ctx.call(endpoint, { method: 'POST' })
      assert.equal(res.status, 401, `${endpoint}：无 body 也必须先 401，不能先报 400`)
      assert.equal((await res.json()).error.code, 'UNAUTHORIZED')
    }
    assert.deepEqual(ctx.snapshot(), before, '无令牌打一轮，线上字节必须一点没动')
  })
})

test('错令牌 → 读端点与写端点一律 401，且与「没令牌」逐字节同形（不区分原因）', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    for (const bad of ['not-the-token', `${READ_TOKEN}x`, `${PUBLISH_TOKEN}x`]) {
      assert.equal((await ctx.call(LIST, { headers: { 'X-DL-Token': bad } })).status, 401)
      assert.equal(
        (await ctx.call(`${DOWNLOAD}?file=${encodeURIComponent(ctx.apks[0].name)}`, { headers: { 'X-DL-Token': bad } }))
          .status,
        401,
      )
      assert.equal((await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: bad })).status, 401)
      assert.equal((await ctx.post('/api/v1/release/private', { apk: APK_INTERNAL, token: bad })).status, 401)
    }

    // 「没令牌」与「令牌不对」在**读端点**上必须逐字节相同（状态码 + 回包）
    const missingRead = await ctx.call(LIST)
    const wrongRead = await ctx.call(LIST, { headers: { 'X-DL-Token': 'nope' } })
    assert.equal(missingRead.status, wrongRead.status)
    assert.equal(await missingRead.text(), await wrongRead.text(), '读端点：缺令牌与错令牌不许有可观察差异')

    // 写端点同理（都走 Authorization: Bearer 通道比较）
    const missingWrite = await ctx.call('/api/v1/release', { method: 'POST' })
    const wrongWrite = await ctx.call('/api/v1/release', {
      method: 'POST', headers: { Authorization: 'Bearer nope' },
    })
    assert.equal(missingWrite.status, wrongWrite.status)
    assert.equal(await missingWrite.text(), await wrongWrite.text(), '写端点：缺令牌与错令牌不许有可观察差异')

    assert.deepEqual(ctx.snapshot(), before, '一轮错令牌下来，线上字节必须一点没动')
  })
})

// ---------------------------------------------------------------- fail-closed：发布令牌缺/空/同值
test('publish-token 缺失 → 写端点一律 401（fail-closed，不回落读令牌），读端点照常 200', async () => {
  await withServer({ publishToken: null }, async (ctx) => {
    const logs = ctx.logs.join('')
    assert.match(logs, /event=publish_token_missing/, '发布令牌缺失必须吵，事后翻 journalctl 能查')
    assert.match(logs, /effect="write_endpoints_401"/, '启动日志要说清后果')
    assert.match(logs, /publish_token="missing"/, 'token_roles 要报 missing')
    assert.ok(!logs.includes(READ_TOKEN) && !logs.includes(PUBLISH_TOKEN), '日志里不许出现令牌明文')

    // 读通道不受影响（这正是「先保读、再断写」的落地效果）
    for (const r of await ctx.readWith(READ_TOKEN, LIST)) assert.equal(r.status, 200)
    assert.equal(
      (await ctx.call(`${DOWNLOAD}?file=${encodeURIComponent(ctx.apks[0].name)}`, {
        headers: { 'X-DL-Token': READ_TOKEN },
      })).status,
      200,
    )

    // 写端点：**读令牌也不行**（不许回落）——两个写端点都是 401
    const before = ctx.snapshot()
    assert.equal((await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: READ_TOKEN })).status, 401)
    assert.equal((await ctx.post('/api/v1/release/private', { apk: APK_INTERNAL, token: READ_TOKEN })).status, 401)
    assert.deepEqual(ctx.snapshot(), before, 'fail-closed 状态下更不允许动线上字节')
  })
})

test('publish-token 存在但为空 → 同样 401（不是「空令牌放行一切」）', async () => {
  await withServer({ publishToken: '' }, async (ctx) => {
    const logs = ctx.logs.join('')
    assert.match(logs, /event=publish_token_missing/)
    assert.match(logs, /reason="empty"/)
    assert.equal((await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: '' })).status, 401)
    assert.equal((await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: READ_TOKEN })).status, 401)
    assert.equal((await ctx.call(LIST, { headers: { 'X-DL-Token': READ_TOKEN } })).status, 200)
  })
})

test('publish-token 与读令牌同值 → 写端点 401（拆了等于没拆，按未配置处理）', async () => {
  await withServer({ publishToken: READ_TOKEN }, async (ctx) => {
    const logs = ctx.logs.join('')
    assert.match(logs, /event=publish_token_missing/)
    assert.match(logs, /reason="same_as_read_token"/)
    // 同值时若放行，等于 #622 的泄漏原样复活 —— 必须 fail-closed
    assert.equal((await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: READ_TOKEN })).status, 401)
    assert.equal((await ctx.call(LIST, { headers: { 'X-DL-Token': READ_TOKEN } })).status, 200)
  })
})

test('读令牌缺失 → 服务拒绝启动（event=fatal_token），不静默全 401', async () => {
  const ctx = await startServer({ readToken: null })
  try {
    assert.equal(ctx.started, false, '读令牌文件缺失时服务不许起来')
    const logs = ctx.logs.join('')
    assert.match(logs, /event=fatal_token/)
    assert.notEqual(ctx.exitCode, 0)
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
})

// ---------------------------------------------------------------- 日志不含令牌明文
test('令牌值绝不进日志：两枚明文在全部 stdout/stderr 里命中数为 0', async () => {
  await withServer({}, async (ctx) => {
    // 让每条路径都跑一遍（成功读、被拒的读、成功写、被拒的写）
    await ctx.call(LIST, { headers: { 'X-DL-Token': READ_TOKEN } })
    await ctx.call(LIST, { headers: { 'X-DL-Token': PUBLISH_TOKEN } })
    await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: READ_TOKEN })
    await ctx.post('/api/v1/release', { apk: APK_STANDARD, token: PUBLISH_TOKEN })
    await new Promise((r) => setTimeout(r, 100)) // 等 stdout 落进来
    const logs = ctx.logs.join('')
    assert.ok(logs.length > 0, '日志非空（否则这条断言是空转）')
    assert.ok(!logs.includes(READ_TOKEN), '读令牌明文绝不进日志')
    assert.ok(!logs.includes(PUBLISH_TOKEN), '发布令牌明文绝不进日志')
    // 只打来源与长度
    assert.match(logs, /event=token_loaded/)
    assert.match(logs, /event=publish_token_loaded/)
    assert.match(logs, /len="42"/)
  })
})
