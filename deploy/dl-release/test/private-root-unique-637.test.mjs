// [layer: L1（零外部依赖：真 HTTP 服务 + 真文件，不需要 APK / aapt2） | 耗时: <5s]
//
// 私有根**唯一** —— `warn_stray_private_root`（Issue #637 方案 A）。
//
// #637 的形状是「同一个概念散在两处」：私有根在 `/opt/dl-private/`，私有清单在
// `/var/www/dl-private/releases.internal.json`。方案 A 把清单挪进私有根、旧目录删掉之后，
// 最怕的不是「当时没挪干净」（那次有备份、有复验），而是**以后又悄悄长回来**：
//   1. 有人照旧文档 `install -d ... /var/www/dl-private`，于是清单又分叉；
//   2. 有人往 webroot 里建 `private/`，把 internal 包挂回公网（#601 的形状）。
// 所以服务启动时扫一眼：`<webroot>-private` 与 `<webroot>/private` 只要存在、又不是配置里的
// 私有根，就记一条 `warn_stray_private_root`。
//
// 这里钉住三件事（每一件都是「做坏了也看不出来」的那种）：
//   A. 干净机（收敛后的线上形态）**不许**打这条 warn —— 报警天天响就等于没报警；
//   B. 又冒出来一处 → 必须打 warn、必须点名那个目录，且**服务照样起来、照样能读清单**
//      （只 warn 不 exit —— 报警不该变成新的「生产起不来」）；
//   C. 已经配成私有根的路径**不算** stray（有人确实把私有根放在 `<webroot>-private`，
//      这层没资格替他判错），否则就是假阳。
//
// 运行：node --test deploy/dl-release/test/private-root-unique-637.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')

const TOKEN = 'test-private-root-unique-637'
const LIST = '/api/v1/releases/internal'
const WARN_EVENT = 'warn_stray_private_root'

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

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/**
 * 起一个真服务端。布局与线上同构：
 *   webroot              = 公网清单所在目录（线上 /var/www/dl）
 *   `<webroot>-private`  = 线上 /var/www/dl-private（#637 之前的第二个私有根）
 *   `<webroot>/private`  = 线上 /var/www/dl/private（#601 的形状）
 *   privateRoot          = webroot 之外的私有根，清单就在它下面（线上 /opt/dl-private）
 *
 * @param {{webroot?: string, privateRoot?: string, strays?: string[]}} opts
 *        strays：**启动前**就要建好的疑似私有根（目录名可传 'sibling' / 'nested'）
 */
async function startServer(opts = {}) {
  const webroot = opts.webroot ?? tmp('dl637-webroot-')
  const priv = opts.privateRoot ?? tmp('dl637-priv-')
  const sibling = `${webroot}-private`
  const nested = path.join(webroot, 'private')

  fs.mkdirSync(path.join(priv, 'apk'), { recursive: true })
  const manifestFile = path.join(priv, 'releases.internal.json')
  if (!fs.existsSync(manifestFile)) {
    fs.writeFileSync(manifestFile, '{"latest":"1.4.0","releases":[]}\n')
  }
  if (!fs.existsSync(webroot)) fs.mkdirSync(webroot, { recursive: true })
  fs.writeFileSync(path.join(webroot, 'releases.json'), '{"latest":"1.4.1","releases":[]}\n')
  const variantsFile = path.join(webroot, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, '{"apks":{}}\n')

  for (const s of opts.strays ?? []) {
    const dir = s === 'sibling' ? sibling : s === 'nested' ? nested : s
    fs.mkdirSync(dir, { recursive: true })
  }

  const tokenFile = path.join(tmp('dl637-tok-'), 'token')
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_APK_DIR: path.join(webroot, 'apk'),
      DL_RELEASES_JSON: path.join(webroot, 'releases.json'),
      DL_WEBROOT: webroot,
      DL_VARIANTS_FILE: variantsFile,
      DL_PRIVATE_ROOT: priv,
      DL_PRIVATE_APK_DIR: path.join(priv, 'apk'),
      DL_PRIVATE_RELEASES_JSON: manifestFile,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: '2',
      DL_PRIVATE_READ_RATE_LIMIT_MAX: '200',
      DL_PUBLIC_BASE: 'https://dl.example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const chunks = []
  child.stdout.on('data', (c) => chunks.push(String(c)))
  child.stderr.on('data', (c) => chunks.push(String(c)))

  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) break
    } catch { /* 还没起来 */ }
    if (child.exitCode !== null) {
      throw new Error(`服务退出 code=${child.exitCode}（warn 不该拦启动）:\n${chunks.join('')}`)
    }
    if (i > 100) throw new Error(`服务未在 10s 内起来:\n${chunks.join('')}`)
    await new Promise((r) => setTimeout(r, 100))
  }

  const logs = () => chunks.join('')
  return {
    webroot,
    priv,
    sibling,
    nested,
    logs,
    list: () => fetch(`http://127.0.0.1:${port}${LIST}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    stop: () => {
      child.kill('SIGTERM')
      return new Promise((r) => child.once('exit', r))
    },
  }
}

test('#637 A：干净布局（收敛后的线上形态）不打 warn_stray_private_root', async () => {
  const srv = await startServer()
  try {
    const log = srv.logs()
    assert.ok(log.includes('event=listening'), `启动日志缺 listening:\n${log}`)
    assert.equal(
      log.includes(WARN_EVENT),
      false,
      `干净布局不该报警（私有根唯一 = ${srv.priv}）：\n${log}`,
    )
    // 顺带确认读端点还活着（warn 逻辑没碰鉴权/路由）
    const res = await srv.list()
    assert.equal(res.status, 200)
    assert.equal((await res.json()).releases.length, 0)
  } finally {
    await srv.stop()
  }
})

test('#637 B：`<webroot>-private` 又冒出来 → warn 点名它，服务照常可用（不 exit）', async () => {
  const srv = await startServer({ strays: ['sibling'] })
  try {
    const log = srv.logs()
    assert.ok(log.includes(WARN_EVENT), `又冒出来的私有根必须报警:\n${log}`)
    assert.ok(log.includes(srv.sibling), `warn 必须点名那个目录（${srv.sibling}）:\n${log}`)
    // 只 warn 不 exit：进程还活着，鉴权与清单读取都照旧
    const res = await srv.list()
    assert.equal(res.status, 200, 'warn 不许把服务拦死')
    const noToken = await fetch(
      `http://127.0.0.1:${new URL(res.url).port}${LIST}`,
    )
    assert.equal(noToken.status, 401, 'warn 也不许顺手把鉴权放开')
  } finally {
    await srv.stop()
  }
})

test('#637 B2：webroot 里又出现 `private/`（#601 的形状）→ 同样 warn', async () => {
  const srv = await startServer({ strays: ['nested'] })
  try {
    const log = srv.logs()
    assert.ok(log.includes(WARN_EVENT), `webroot/private 也必须报警:\n${log}`)
    assert.ok(log.includes(srv.nested), `warn 必须点名 ${srv.nested}:\n${log}`)
    const res = await srv.list()
    assert.equal(res.status, 200)
  } finally {
    await srv.stop()
  }
})

test('#637 C：配成私有根的路径不算 stray（不出假阳）', async () => {
  // 私有根**就放在** `<webroot>-private`：有意这么配的人不该被报警打扰
  const webroot = tmp('dl637-webroot-')
  const srv = await startServer({ webroot, privateRoot: `${webroot}-private` })
  try {
    const log = srv.logs()
    assert.equal(
      log.includes(WARN_EVENT),
      false,
      `私有根本身就在 <webroot>-private 时不该报警:\n${log}`,
    )
  } finally {
    await srv.stop()
  }
})
