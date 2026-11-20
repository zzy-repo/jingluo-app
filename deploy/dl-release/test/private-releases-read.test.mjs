// [layer: L1（零外部依赖：真 HTTP 服务 + 真文件，不需要 APK / aapt2） | 耗时: <3s]
//
// 私有清单**读**端点 —— `GET /api/v1/releases/internal` 与
// `GET /api/v1/releases/internal/download?file=<basename>`（Issue #621）。
//
// 为什么要钉住这几条：#621 的起点是「私有清单正确地在 webroot 之外，于是内测客户端一个字节都
// 取不到」。补读端点时最容易顺手做坏的三件事，正好就是这三条：
//   1. **鉴权退让**：为了让内测客户端「先验一下能不能下」，把清单端点做成免令牌 ——
//      等于把 #614 刚清干净的 internal 包又挂到公网上；
//   2. **路径穿越**：`?file=` 拿来做 `path.join`，`../../etc/passwd` 就成了一次任意文件读；
//   3. **一条坏记录打死整条渠道**：清单里一条 file 写错（改名/没上传/size 记错）就 500，
//      于是「一个包没发好」升级成「所有内测用户都更新不了」。
//
// 这里只起真服务、给真文件，不 mock 任何东西：
//   - 令牌：`X-DL-Token` 与 `Authorization: Bearer` 两种写法都要成立（同一份判据）；
//   - 私有目录与清单都在**临时工作目录之外**（服务启动期会拒绝「私有根落在 webroot 内」）；
//   - 私有包是随机字节的假文件 —— 读端点不解析 APK，所以不需要 aapt2。
//
// 运行：node --test deploy/dl-release/test/private-releases-read.test.mjs（或 pnpm run test:dl-release）

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')

const TOKEN = 'test-private-read-token-621'
const LIST = '/api/v1/releases/internal'
const DOWNLOAD = '/api/v1/releases/internal/download'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 一个像样的私有 APK（随机字节 + 正确文件名；读端点不解析内容） */
function writeApk(dir, name, bytes = 4096) {
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

/** 清单条目：形状与公网 releases.json 同构（`file` 是 `apk/<name>`，#620 私有发布目标就是这么写的） */
function entry(apk, over = {}) {
  return {
    version: '1.4.0-internal',
    versionCode: 19,
    releasedAt: '2026-11-19T19:18:00+08:00',
    file: `apk/${apk.name}`,
    size: apk.size,
    md5: apk.md5,
    sha256: apk.sha256,
    changes: ['内测构建'],
    buildType: 'prerelease',
    artifactVariant: 'internal',
    artifactVariantSource: 'apk-manifest',
    ...over,
  }
}

/**
 * 起一个真服务端。
 * 私有根**不在** work 目录下：`WEBROOT` = 公网清单所在目录，服务启动时会拒绝
 * 「私有根落在 webroot 内」的配置（#620 的启动期硬门禁），这里要构造合法布局。
 */
async function startServer({ privateManifest = null, privateApks = [], env = {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-private-read-'))
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-private-root-'))
  const apkDir = path.join(priv, 'apk')
  fs.mkdirSync(apkDir, { recursive: true })

  const tokenFile = path.join(work, 'token')
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const releasesFile = path.join(work, 'releases.json')
  fs.writeFileSync(releasesFile, '{"latest":"1.4.1","releases":[]}\n')
  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, '{"apks":{}}\n')

  const apks = privateApks.map((a) => writeApk(apkDir, a))
  const manifestFile = path.join(priv, 'releases.internal.json')
  if (privateManifest) fs.writeFileSync(manifestFile, `${JSON.stringify(privateManifest, null, 2)}\n`)

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_APK_DIR: path.join(work, 'apk'),
      DL_RELEASES_JSON: releasesFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_PRIVATE_ROOT: priv,
      DL_PRIVATE_APK_DIR: apkDir,
      DL_PRIVATE_RELEASES_JSON: manifestFile,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: '2',
      DL_PRIVATE_READ_RATE_LIMIT_MAX: '200',
      DL_PUBLIC_BASE: 'https://dl.example.test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (c) => logs.push(String(c)))
  child.stderr.on('data', (c) => logs.push(String(c)))

  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) break
    } catch { /* 还没起来 */ }
    if (child.exitCode !== null) throw new Error(`服务退出 code=${child.exitCode}:\n${logs.join('')}`)
    if (i > 100) throw new Error(`服务未在 10s 内起来:\n${logs.join('')}`)
    await new Promise((r) => setTimeout(r, 100))
  }

  const call = (p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, init)
  return {
    port,
    work,
    priv,
    apkDir,
    apks,
    manifestFile,
    logs,
    call,
    /** 带令牌（默认走约定的 X-DL-Token 写法） */
    withToken: (p, headers = { 'X-DL-Token': TOKEN }) => call(p, { headers }),
    stop: () => new Promise((r) => {
      if (child.exitCode !== null) return r()
      child.once('exit', () => r())
      child.kill('SIGTERM')
    }),
  }
}

test('私有清单：不带令牌 → 401（不泄露清单存不存在）', async () => {
  const ctx = await startServer({
    privateApks: ['deepseek-chat-1.4.0-internal.apk'],
    privateManifest: null,
  })
  const apk = ctx.apks[0]
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal', releases: [entry(apk)],
  })}\n`)

  try {
    const res = await ctx.call(LIST)
    assert.equal(res.status, 401, '无令牌必须 401')
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'UNAUTHORIZED')
    // 响应体里不许回显路径/清单内容 —— 401 的措辞只能谈令牌
    assert.ok(!JSON.stringify(body).includes('releases.internal'), '401 响应体不得泄露清单文件名')
    assert.ok(!JSON.stringify(body).includes('.apk'), '401 响应体不得泄露包名')

    // 同一个 401 也在「清单根本不存在」时成立 —— 401 与 404 的差异本身是一条情报
    fs.rmSync(ctx.manifestFile, { force: true })
    const again = await ctx.call(LIST)
    assert.equal(again.status, 401)
    assert.deepEqual(await again.json(), body, '有清单/没清单的 401 必须同形')
  } finally {
    await ctx.stop()
  }
})

test('私有清单：错令牌 → 401（Bearer 写法同样走同一份判据）', async () => {
  const ctx = await startServer({
    privateApks: ['deepseek-chat-1.4.0-internal.apk'],
    privateManifest: null,
  })
  try {
    const xdl = await ctx.call(LIST, { headers: { 'X-DL-Token': 'not-the-token' } })
    assert.equal(xdl.status, 401)

    const bearer = await ctx.call(LIST, { headers: { Authorization: 'Bearer not-the-token' } })
    assert.equal(bearer.status, 401)

    // 空值也是 401（不是「没带头就放行」）
    const empty = await ctx.call(LIST, { headers: { 'X-DL-Token': '' } })
    assert.equal(empty.status, 401)
  } finally {
    await ctx.stop()
  }
})

test('私有清单：正确令牌 → 200，且 releases 里没有 artifactVariant=standard 的条目', async () => {
  const internalName = 'deepseek-chat-1.4.0-internal.apk'
  const betaName = 'deepseek-chat-1.4.0-beta.10.apk'
  const standardName = 'deepseek-chat-1.4.1.apk'
  const ctx = await startServer({ privateApks: [internalName, betaName, standardName] })
  // 清单在文件存在之后才写（service 已经起来，读端点是每请求读盘，没问题）
  const [internalApk, betaApk, standardApk] = ctx.apks
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: internalApk.name,
    releases: [
      entry(internalApk, { version: '1.4.0-internal', versionCode: 19 }),
      entry(betaApk, { version: '1.4.0-beta.10', versionCode: 17 }),
      // 对外包混进私有清单：无论 buildType 写什么都**不许**出现在读响应里
      entry(standardApk, {
        version: '1.4.1', versionCode: 20, buildType: 'prerelease', artifactVariant: 'standard',
      }),
      entry(standardApk, { version: '1.4.1-stable', versionCode: 20, buildType: 'stable', artifactVariant: 'standard' }),
    ],
  }, null, 2)}\n`)

  try {
    for (const headers of [{ 'X-DL-Token': TOKEN }, { Authorization: `Bearer ${TOKEN}` }]) {
      const res = await ctx.call(LIST, { headers })
      assert.equal(res.status, 200)
      assert.match(String(res.headers.get('cache-control') || ''), /no-store/, '清单必须 no-store')

      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(body.latest, '1.4.0-internal')
      assert.ok(Array.isArray(body.releases))
      assert.equal(body.releases.length, 2, '只留 internal / prerelease 条目')
      assert.ok(
        body.releases.every((r) => r.artifactVariant !== 'standard'),
        'releases 里不允许出现 artifactVariant=standard 的条目',
      )
      assert.deepEqual(body.releases.map((r) => r.version), ['1.4.0-internal', '1.4.0-beta.10'])

      // 每条都要带一个可用的下载入口（形状由服务端给，客户端不自己拼 URL）
      for (const r of body.releases) {
        assert.equal(r.downloadUrl, `${DOWNLOAD}?file=${encodeURIComponent(r.apkName)}`)
        assert.ok(!r.downloadUrl.includes('/apk/'), 'downloadUrl 里不该出现清单的 apk/ 前缀')
      }
    }
  } finally {
    await ctx.stop()
  }
})

test('私有包下载：正确令牌 → 200 流式返回，字节与磁盘一致', async () => {
  const ctx = await startServer({ privateApks: ['deepseek-chat-1.4.0-internal.apk'] })
  const apk = ctx.apks[0]
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal', releases: [entry(apk)],
  })}\n`)

  try {
    const res = await ctx.withToken(`${DOWNLOAD}?file=${encodeURIComponent(apk.name)}`)
    assert.equal(res.status, 200)
    assert.match(String(res.headers.get('content-type') || ''), /vnd\.android\.package-archive/)
    assert.match(String(res.headers.get('content-disposition') || ''), /^attachment; filename=".*\.apk"$/)
    const got = Buffer.from(await res.arrayBuffer())
    assert.equal(got.length, apk.size)
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), apk.sha256, '下载到的字节必须与清单 sha256 一致')

    // 下载同样要令牌：不然「私有」只剩文件名不可猜
    assert.equal((await ctx.call(`${DOWNLOAD}?file=${apk.name}`)).status, 401)
    assert.equal(
      (await ctx.call(`${DOWNLOAD}?file=${apk.name}`, { headers: { 'X-DL-Token': 'wrong' } })).status,
      401,
    )
  } finally {
    await ctx.stop()
  }
})

test('私有包下载：路径穿越一律被拒（400/404），绝不放行读任意文件', async () => {
  const ctx = await startServer({ privateApks: ['deepseek-chat-1.4.0-internal.apk'] })
  const apk = ctx.apks[0]
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal', releases: [entry(apk)],
  })}\n`)

  try {
    const traversals = [
      '../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '/etc/passwd',
      'apk/../../etc/passwd',
      'sub/deepseek-chat-1.4.0-internal.apk',
      '..\\..\\etc\\passwd',
      '.',
      '',
    ]
    for (const bad of traversals) {
      const res = await ctx.withToken(`${DOWNLOAD}?file=${encodeURIComponent(bad)}`)
      assert.ok(
        res.status === 400 || res.status === 404,
        `file=${JSON.stringify(bad)} 必须 400/404，实际 ${res.status}`,
      )
      const body = await res.json()
      assert.equal(body.ok, false)
      // 绝不能把 /etc/passwd 的内容当 APK 发出去
      assert.ok(!JSON.stringify(body).includes('root:x:'), '响应里不允许出现穿越目标的文件内容')
    }

    // 缺参数也是 400（不是 500，也不是「默认给第一个包」）
    assert.equal((await ctx.withToken(DOWNLOAD)).status, 400)
  } finally {
    await ctx.stop()
  }
})

test('私有包下载：文件不存在 → 404；目录里存在但没写进清单的包 → 404', async () => {
  const ctx = await startServer({
    privateApks: ['deepseek-chat-1.4.0-internal.apk', 'deepseek-chat-1.4.0-undeclared.apk'],
  })
  const [declared] = ctx.apks
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal', releases: [entry(declared)],
  })}\n`)

  try {
    const missing = await ctx.withToken(`${DOWNLOAD}?file=deepseek-chat-9.9.9-internal.apk`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'NOT_FOUND')

    // 白名单是「清单里声明过的」，不是「私有目录里有什么」—— 少一条声明就少一个出口
    const undeclared = await ctx.withToken(`${DOWNLOAD}?file=deepseek-chat-1.4.0-undeclared.apk`)
    assert.equal(undeclared.status, 404)
  } finally {
    await ctx.stop()
  }
})

test('清单与文件不自洽：坏条目跳过并记 warn，其余条目照发（不是 500、也不整份拒）', async () => {
  const ctx = await startServer({
    privateApks: [
      'deepseek-chat-1.4.0-internal.apk',        // 唯一健康的那条
      'deepseek-chat-1.4.0-beta.10.apk',         // size 记错 → 跳过
    ],
  })
  const [good, sizeDrift] = ctx.apks
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal',
    releases: [
      entry(good),
      entry(sizeDrift, { version: '1.4.0-beta.10', size: sizeDrift.size + 1 }),   // 声明 size 与磁盘不符
      entry({ ...good, name: 'deepseek-chat-1.4.0-gone.apk' }, { version: '1.4.0-gone' }), // 文件不在盘上
      entry(good, { version: '1.4.0-trav', file: '../../etc/passwd' }),           // file 不是 basename
      { version: '1.4.0-not-object-file', file: 42, buildType: 'prerelease', artifactVariant: 'internal' },
      null,                                                                      // 垃圾条目
    ],
  }, null, 2)}\n`)

  try {
    const res = await ctx.withToken(LIST)
    assert.equal(res.status, 200, '一条坏记录不能让整份清单 500')
    const body = await res.json()
    assert.deepEqual(body.releases.map((r) => r.version), ['1.4.0-internal'], '只留活下来的那条')
    assert.equal(body.count, 1)
    assert.equal(body.skipped, 5)
    assert.equal(body.latest, '1.4.0-internal', 'latest 只能落在活下来的条目上')

    // warn 必须真进日志（不然「跳过了」等于静默丢包）
    const joined = ctx.logs.join('')
    for (const reason of ['size_mismatch', 'file_missing', 'unsafe_file', 'not_an_object']) {
      assert.ok(
        joined.includes(`event=private_entry_skipped`) && joined.includes(`reason="${reason}"`),
        `日志里应有 reason="${reason}" 的 private_entry_skipped`,
      )
    }
  } finally {
    await ctx.stop()
  }
})

test('私有清单不存在 → 503（不是 500，也绝不是 200 + 空清单）', async () => {
  // 故意不写清单文件：空清单会让客户端以为「没有内测版」，比明确报错更糟
  const ctx = await startServer({ privateApks: ['deepseek-chat-1.4.0-internal.apk'] })
  try {
    const res = await ctx.withToken(LIST)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'MANIFEST_UNAVAILABLE')
    assert.equal(body.releases, undefined, '不可用时不许回一个空 releases 数组')

    // 清单不可用时下载同样 503（不是 404 —— 404 会让人以为「这个包不存在」）
    assert.equal(
      (await ctx.withToken(`${DOWNLOAD}?file=deepseek-chat-1.4.0-internal.apk`)).status,
      503,
    )
  } finally {
    await ctx.stop()
  }
})

test('读端点吃自己的限流桶：不挤占发布额度，超限 429', async () => {
  const ctx = await startServer({
    privateApks: ['deepseek-chat-1.4.0-internal.apk'],
    env: { DL_PRIVATE_READ_RATE_LIMIT_MAX: '3', DL_RATE_LIMIT_MAX: '100' },
  })
  const apk = ctx.apks[0]
  fs.writeFileSync(ctx.manifestFile, `${JSON.stringify({
    latest: '1.4.0-internal', releases: [entry(apk)],
  })}\n`)

  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await ctx.withToken(LIST)).status, 200, `第 ${i + 1} 次应放行`)
    }
    const limited = await ctx.withToken(LIST)
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) > 0, '429 必须带 Retry-After')

    // 上传桶是另一个桶：私有读打满了也不影响发布路径返回自己的状态（未带令牌仍是 401）
    const post = await ctx.call('/api/v1/release', { method: 'POST' })
    assert.equal(post.status, 401, '读端点的限流不该把发布路径染成 429')
  } finally {
    await ctx.stop()
  }
})
