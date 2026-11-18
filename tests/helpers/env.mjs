// 集成层「环境守卫」：把「端口被占/产物陈旧/产物对不上」从假红里分出来。
//
// 历史坑（Issue #19）：5181 被别人的 `python3 -m http.server` 占着，serve 的是另一条分支的
// 1.4.0-beta.3 产物，于是 13 个用例一起红，看着像「基线本来就坏」。这类失败不是产品问题，
// 也不该表现为断言失败——所以在用例开头就自检环境，不满足就 exit 77（SKIP(env)），
// 并打印**可操作的原因**：端口上有谁、dist 的 main.<hash>.js 是多少、该重建什么。
//
// 用法（放在用例顶部，起浏览器之前）：
//   import { verifyAppUrl, verifyDist } from '../helpers/env.mjs'
//   const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
//   await verifyAppUrl(APP_URL)        // 外部静态服务的用例
//   await verifyDist(DIST)             // 自己 serve dist 的用例
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '../..')

/** 退出码约定：77 = 环境不满足（SKIP，不算失败）；run-layer 会把它汇总成 SKIP(env) */
export const SKIP_CODE = 77

export const skipEnv = (reason, hint = '') => {
  console.error(`SKIP(env) ${reason}`)
  if (hint) {
    console.error(`  → ${hint}`)
  }
  process.exit(SKIP_CODE)
}

/** 默认产物目录：DIST_DIR 可注入（默认仓库根 dist） */
export const defaultDist = () => process.env.DIST_DIR || path.join(ROOT, 'dist')

/** 从 index.html 里取构建 hash（main.<hash>.js）；取不到返回 null */
export const mainScriptOf = (html) => /main\.([a-z0-9]+)\.js/.exec(html)?.[1] ?? null

/** 读产物自述（rspack 写的 build-info.json），没有就返回 null（老产物/别人手工拷的目录） */
export const readBuildInfo = (dist) => {
  try {
    return JSON.parse(readFileSync(path.join(dist, 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 读本地 dist 的 index.html（不存在返回 null） */
export const readLocalIndex = (dist) => {
  try {
    return readFileSync(path.join(dist, 'index.html'), 'utf8')
  } catch {
    return null
  }
}

const newestMtime = (dir, filter) => {
  let newest = 0
  let newestPath = ''
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.startsWith('dist')) {
          continue
        }
        walk(full)
        continue
      }
      if (!filter(entry.name)) {
        continue
      }
      const mtime = statSync(full).mtimeMs
      if (mtime > newest) {
        newest = mtime
        newestPath = full
      }
    }
  }
  walk(dir)
  return { mtime: newest, path: newestPath }
}

/**
 * 陈旧产物守卫：源码/构建配置比 dist/index.html 新 → 产物过期，断言会对着旧代码报错。
 * 打印当前 dist 的 main.<hash>.js 与最新源码文件，方便直接判断该重建什么。
 */
export const verifyDist = (dist = defaultDist(), { variant } = {}) => {
  const index = readLocalIndex(dist)
  if (!index) {
    skipEnv(
      `找不到构建产物：${dist}/index.html`,
      `先构建：NODE_ENV=production rspack build -c rspack.config.ts（内测类用例用 INTERNAL_BUILD=1），或用 DIST_DIR 指定目录`
    )
  }
  const info = readBuildInfo(dist)
  const hash = info?.hash ?? mainScriptOf(index)
  const relay = `当前产物 main.${hash ?? '?'}.js（${path.relative(ROOT, dist) || dist}${info ? `, variant=${info.variant}, builtAt=${info.builtAt}` : '，无 build-info.json'}）`
  // 1) 产物种类对不对：内测用例拿标准包跑必然全红，且看起来像产品坏了
  if (variant && info && info.variant !== variant) {
    skipEnv(
      `产物种类不对：用例需要 ${variant} 包，${path.relative(ROOT, dist) || dist} 里是 ${info.variant} 包；${relay}`,
      variant === 'internal'
        ? '重建内测包：INTERNAL_BUILD=1 NODE_ENV=production rspack build -c rspack.config.ts'
        : '重建标准包：NODE_ENV=production rspack build -c rspack.config.ts'
    )
  }
  // 2) 产物是否比源码旧
  const builtAt = info?.builtAt ? Date.parse(info.builtAt) : statSync(path.join(dist, 'index.html')).mtimeMs
  const sources = newestMtime(path.join(ROOT, 'src'), (name) => /\.(tsx?|css)$/.test(name))
  const config = newestMtime(ROOT, (name) => /^rspack\.config\.ts$/.test(name))
  const newest = sources.mtime > config.mtime ? sources : config
  if (newest.mtime > builtAt) {
    skipEnv(
      `构建产物陈旧：${path.relative(ROOT, newest.path)}（${new Date(newest.mtime).toISOString()}）比产物（${new Date(builtAt).toISOString()}）新；${relay}`,
      '重建产物：NODE_ENV=production rspack build -c rspack.config.ts'
    )
  }
  return { hash, variant: info?.variant ?? null }
}

/**
 * 外部静态服务守卫：
 * 1) APP_URL 不可达 → SKIP
 * 2) 端口上 serve 的不是「本地 dist 的这份构建」（main hash 不同）→ SKIP，并指出谁占了端口
 */
export const verifyAppUrl = async (appUrl, dist = defaultDist(), { variant } = {}) => {
  const url = new URL(appUrl)
  let html = ''
  try {
    const response = await fetch(appUrl, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) {
      skipEnv(`${appUrl} 返回 HTTP ${response.status}`, `换一个空闲端口起服务：python3 -m http.server <port> --directory dist`)
    }
    html = await response.text()
  } catch (error) {
    skipEnv(
      `${appUrl} 不可达（${error instanceof Error ? error.message : String(error)}）`,
      `先起静态服务：python3 -m http.server ${url.port || 80} --bind 127.0.0.1 --directory <产物目录>`
    )
  }
  const remoteHash = mainScriptOf(html)
  // 优先相信「端口上那份产物」的自述文件（build-info.json 就在产物目录里，静态服务能直接取到）
  let served = null
  try {
    const info = await fetch(`${appUrl.replace(/\/$/, '')}/build-info.json`, { signal: AbortSignal.timeout(3000) })
    if (info.ok) {
      served = await info.json()
    }
  } catch {
    served = null
  }
  const hash = served?.hash ?? remoteHash
  const relay = `端口产物 main.${hash ?? '?'}.js${served ? `（variant=${served.variant}, builtAt=${served.builtAt}）` : '（无 build-info.json，按 index.html 判断）'}`
  // 1) 产物种类：内测用例连到标准包必然全红，看起来像产品坏了
  if (variant && served && served.variant !== variant) {
    skipEnv(
      `产物种类不对：用例需要 ${variant} 包，${appUrl} 上是 ${served.variant} 包；${relay}`,
      variant === 'internal'
        ? '重建内测包并 serve 它：INTERNAL_BUILD=1 NODE_ENV=production rspack build -c rspack.config.ts'
        : '重建标准包并 serve 它：NODE_ENV=production rspack build -c rspack.config.ts'
    )
  }
  // 2) 端口上 serve 的是不是「本地那份产物」（同 hash）——不一致多半是端口撞车，连到了别人的服务
  const localIndex = readLocalIndex(dist)
  const localHash = localIndex ? mainScriptOf(localIndex) : null
  if (!served && remoteHash && localHash && remoteHash !== localHash) {
    let owner = ''
    try {
      owner = execFileSync('bash', ['-lc', `ss -ltnp 2>/dev/null | grep -w ':${url.port || 80}' | head -1`], {
        encoding: 'utf8',
      }).trim()
    } catch {
      owner = ''
    }
    skipEnv(
      `${appUrl} serve 的不是本地 dist：远端 main.${remoteHash}.js ≠ 本地 main.${localHash}.js` + (owner ? `（端口占用：${owner}）` : ''),
      `换端口重跑：APP_URL=http://127.0.0.1:<空闲端口>`
    )
  }
  // 3) 产物是否比源码旧（看端口上那份产物的 builtAt；没有自述文件就退回本地 dist 的 mtime 判断）
  const sources = newestMtime(path.join(ROOT, 'src'), (name) => /\.(tsx?|css)$/.test(name))
  const config = newestMtime(ROOT, (name) => /^rspack\.config\.ts$/.test(name))
  const newest = sources.mtime > config.mtime ? sources : config
  const builtAt = served?.builtAt
    ? Date.parse(served.builtAt)
    : existsSync(path.join(dist, 'index.html'))
      ? statSync(path.join(dist, 'index.html')).mtimeMs
      : 0
  if (builtAt > 0 && newest.mtime > builtAt) {
    skipEnv(
      `产物陈旧：${path.relative(ROOT, newest.path)}（${new Date(newest.mtime).toISOString()}）比端口上的产物（${new Date(builtAt).toISOString()}）新；${relay}`,
      '重建产物后再跑（或换一个指向新产物的 APP_URL）'
    )
  }
  return { hash, variant: served?.variant ?? null }
}

/**
 * 起静态服务的薄封装：复用 tests/helpers/runtime.mjs 的 `serveDist`（进程内 HTTP 服务，
 * 端口 0 = 操作系统原子分配，天然不撞车），统一成 { url, port, kill } 的形状。
 *
 * 为什么要这一层：main 上已经用 serveDist 统一了「自建服务」的做法，这里只做命名与
 * 「允许 PORT 注入」的适配，不引入第二套实现。
 *
 *   const { url, kill } = await serveDir(DIST, { port: process.env.PORT })
 *   … 用例结束时 kill()
 */
export const serveDir = async (dir, { port, label = '' } = {}) => {
  const { serveDist } = await import('./runtime.mjs')
  let server
  try {
    server = await serveDist(dir, { port: port ? Number(port) : 0 })
  } catch (error) {
    skipEnv(
      `${label || dir} 起静态服务失败（${error instanceof Error ? error.message : String(error)}）`,
      '先构建产物（NODE_ENV=production [DIST_OUT=<dir>] rspack build -c rspack.config.ts），或用 DIST_DIR / PORT 指定'
    )
  }
  return {
    url: server.url,
    port: Number(new URL(server.url).port),
    kill: () => {
      server.close().catch(() => {})
    },
  }
}
