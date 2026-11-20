// [layer: L1（零外部依赖：真 HTTP 服务 + 真文件哈希，不需要 APK） | 耗时: <2s]
//
// 域10 补充 —— `GET /api/v1/version` 版本自证（Issue #441）。
//
// 为什么这几条必须钉住：这个端点存在的唯一理由是「线上跑的是哪一版」能自证。
// 它一旦说谎，比没有这个端点更糟 —— 你会拿一个错的 sha256 去签收一次错误的部署。
// 所以覆盖的是四件会被「顺手改坏」的事：
//   1. 回的 sha256 == 该文件在磁盘上的 sha256（用真文件算，不比字符串常量）；
//   2. **启动时算一次就缓存**：进程起来之后文件被换掉，端点仍报启动时那份，
//      —— 否则「热替换文件 + 重启失败」的场景下它会替没跑的新文件作证；
//   3. 不需要令牌（无 Authorization 也是 200），且不吃限流额度（限流只该管上传）；
//   4. 枚举取自单一真相源（variant.mjs / shared/build-types.mjs），不是另抄一份。
//
// 运行：node --test deploy/dl-release/test/version-endpoint.test.mjs（或 pnpm run test:dl-release）

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { VARIANTS } from '../variant.mjs'
import { BUILD_TYPES } from '../../../shared/build-types.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

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

/**
 * 起一个真服务端。
 * @param {string} [serverFile] 要跑的服务端文件（默认仓库里那份；缓存用例传临时副本）
 */
async function startServer(serverFile = SERVER) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-version-'))
  const tokenFile = path.join(work, 'token')
  fs.writeFileSync(tokenFile, `test-token-${process.pid}\n`, { mode: 0o600 })
  const releasesFile = path.join(work, 'releases.json')
  fs.writeFileSync(releasesFile, '{"latest":"1.0.0","releases":[]}\n')
  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, '{"apks":{}}\n')

  const port = await freePort()
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_APK_DIR: path.join(work, 'apk'),
      DL_RELEASES_JSON: releasesFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      // 限流调成 1：用来证明 /api/v1/version 不占额度
      DL_RATE_LIMIT_MAX: '1',
      DL_PUBLIC_BASE: 'https://dl.example.test',
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

  return {
    port,
    work,
    logs,
    version: (init = {}) => fetch(`http://127.0.0.1:${port}/api/v1/version`, init),
    stop: () => new Promise((r) => {
      if (child.exitCode !== null) return r()
      child.once('exit', () => r())
      child.kill('SIGTERM')
    }),
  }
}

test('GET /api/v1/version：不需要令牌，sha256 == 仓库里 server.mjs 的真实哈希', async () => {
  const ctx = await startServer()
  try {
    // 故意不带 Authorization：这个端点必须免令牌（只回非敏感信息）
    const res = await ctx.version()
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.equal(body.ok, true)
    assert.equal(
      body.sha256,
      sha256File(SERVER),
      '回包的 sha256 必须等于 server.mjs 文件内容的 sha256（部署签收就靠这一条）',
    )
    assert.equal(body.nodeVersion, process.version)
    // builtAt 是进程启动时刻（ISO 8601），不是构建时刻
    const builtAt = new Date(body.builtAt)
    assert.ok(!Number.isNaN(builtAt.getTime()), `builtAt 必须是合法 ISO 时间，实际 ${body.builtAt}`)
    assert.ok(
      Date.now() - builtAt.getTime() < 60_000,
      `builtAt 应是本次启动时刻（<60s 内），实际 ${body.builtAt}`,
    )

    // 枚举来自单一真相源，不是这里另抄的数组
    assert.deepEqual(body.variants, [...VARIANTS])
    assert.deepEqual(body.buildTypes, [...BUILD_TYPES])
  } finally {
    await ctx.stop()
  }
})

test('sha256 启动时算一次并缓存：文件被替换后端点仍报启动时那份', async () => {
  // 复制一份可执行的目录树（server 会 import 同目录 variant/apk-manifest/release-target 与
  // shared/build-types；#620 起多了 release-target.mjs —— 少拷一个服务就起不来，这条用例会红）
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-version-tree-'))
  const dlDir = path.join(tree, 'deploy/dl-release')
  fs.mkdirSync(dlDir, { recursive: true })
  fs.mkdirSync(path.join(tree, 'shared'), { recursive: true })
  for (const f of ['server.mjs', 'variant.mjs', 'apk-manifest.mjs', 'release-target.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'deploy/dl-release', f), path.join(dlDir, f))
  }
  fs.copyFileSync(path.join(ROOT, 'shared/build-types.mjs'), path.join(tree, 'shared/build-types.mjs'))
  const copy = path.join(dlDir, 'server.mjs')
  const bootHash = sha256File(copy)

  const ctx = await startServer(copy)
  try {
    // 进程起来之后再动文件：模拟「线上被换了文件但重启没成功」
    fs.appendFileSync(copy, '\n// replaced after boot\n')
    const afterHash = sha256File(copy)
    assert.notEqual(afterHash, bootHash, '本用例前提：替换后文件哈希必须变了')

    const body = await (await ctx.version()).json()
    assert.equal(
      body.sha256,
      bootHash,
      '必须报启动时缓存的哈希 —— 每请求读盘就会替没在跑的新文件作证（#441 要根治的正是这种错觉）',
    )
  } finally {
    await ctx.stop()
  }
})

test('/api/v1/version 不吃限流额度、也不放行上传；POST 仍 401', async () => {
  const ctx = await startServer() // DL_RATE_LIMIT_MAX=1
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await ctx.version()).status, 200, '版本端点不受上传限流影响')
    }

    // 免令牌只针对版本端点：上传仍然必须 401
    const post = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/release`, { method: 'POST' })
    assert.equal(post.status, 401)

    // 方法不对 → 405 且带 Allow（别让 GET 之外的动词落到上传分支）
    const bad = await ctx.version({ method: 'POST' })
    assert.equal(bad.status, 405)
    assert.match(String(bad.headers.get('allow') || ''), /GET/)
  } finally {
    await ctx.stop()
  }
})
