#!/usr/bin/env node
/**
 * check-artifact-redaction.mjs —— 公开发布物里**不得出现内网地址**（Issue #745）。
 *
 * 为什么要有它：`v1.4.5` / `v1.4.6` 的公开发布 APK 里 grep 得到
 * `http://140.210.13.146:60010` / `:60012/feedback` / `:60013` / `http://62.106.70.167:8888`
 * —— 来源是 `config/endpoints.json` 的历史 baseUrl 与「已下线主机重写表」字面量被打进 bundle。
 * 正文早就禁写裸 IP（那道门做得很好），但**包内没人管**；而包被下载后是长期留存的。
 *
 * ## 为什么用"基线只减不增"而不是"命中即红"
 * 缺陷是存量（当前正式包就有 7 处），若直接命中即红，会把 main 立刻打红、逼着人往门禁里加
 * `continue-on-error`（那才是真正的失败模式）。所以照仓库既有做法（`test-duplication-baseline.json`）：
 *   · 基线里登记**允许存在的存量**（逐条 literal + count）；
 *   · **新增任何一条 → exit 1**（这才是要防的：以后又塞进一个内网地址）；
 *   · **某条已消失 → 只 WARN 提示从基线删掉**（只减不增，不许基线腐烂）。
 *
 * ## 扫什么
 * - RFC1918 / 回环 / 链路本地 IPv4（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`）
 * - 显式内网主机表（`INTERNAL_HOSTS`：今天这批 `140.210.13.146` / `62.106.70.167`）
 * - 内网端口（`INTERNAL_PORTS`：`60010` `60012` `60013` `8888`）
 * - 只扫**产物**（`dist/**` 或 APK 里的 `assets/public/**`），不扫源码（源码里出现是正常的：
 *   配置源本来就在仓库里，问题只在"被固化进可分发的 bundle"）。
 *
 * ## 用法
 * ```
 * node scripts/check-artifact-redaction.mjs                  # 默认扫 dist/
 * node scripts/check-artifact-redaction.mjs --dir dist-xxx
 * node scripts/check-artifact-redaction.mjs --apk app-release.apk
 * node scripts/check-artifact-redaction.mjs --json
 * ```
 *
 * 退出码：0 通过 / 1 有新增（或基线外命中）/ 2 判不出来（目录不存在、APK 解不开、基线坏了）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE_REL = 'config/artifact-redaction-baseline.json'
const BASELINE = path.join(ROOT, BASELINE_REL)

/** 今天已知的内网主机（#745）。新增内网机器时加这里，**不要**改成"只按私网段匹配就够"。 */
const INTERNAL_HOSTS = ['140.210.13.146', '62.106.70.167']
/** 今天已知的内网端口。 */
const INTERNAL_PORTS = ['60010', '60012', '60013', '8888']

/** 扫哪些扩展名：bundle 只有这些里面可能有地址字面量 */
const SCAN_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json'])

const RFC1918 = String.raw`(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})`

/** 命中形如 `http://<host>[:port][/whatever]` 的整段（去掉路径，便于按 literal 归并计数） */
const buildLiteralRe = (host) =>
  new RegExp(String.raw`https?://${host.replace(/\./g, '\\.')}(?::(\d{2,5}))?`, 'g')

const RE_RFC1918 = new RegExp(String.raw`https?://${RFC1918}(?::\d{2,5})?`, 'g')
/** 光秃秃的内网 IP（没有 scheme 也算）：`140.210.13.146:60013` 这种 */
const RE_BARE_HOST = new RegExp(
  String.raw`\b(?:${INTERNAL_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?::(\d{2,5}))?\b`,
  'g'
)
/** 单独出现的内网端口（`:60013`），配合上面「确认是内网主机」用不到，只用于统计 hint */
const RE_INTERNAL_PORT = new RegExp(String.raw`:(${INTERNAL_PORTS.join('|')})\b`, 'g')

const usage = () => {
  console.error('用法: node scripts/check-artifact-redaction.mjs [--dir <产物目录> | --apk <apk>] [--json] [--quiet]')
  console.error('退出码: 0 通过 / 1 有新增内网地址 / 2 判不出来')
}

const argv = process.argv.slice(2)
let dirArg = null
let apkArg = null
let asJson = false
let quiet = false
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--dir') dirArg = argv[++i]
  else if (a === '--apk') apkArg = argv[++i]
  else if (a === '--json') asJson = true
  else if (a === '--quiet') quiet = true
  else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
  else { console.error(`未知参数: ${a}`); usage(); process.exit(2) }
}

/** 递归列文件（跳过 map / 隐藏目录） */
const listFiles = (dir) => {
  const out = []
  const walk = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = path.join(cur, name)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (!SCAN_EXT.has(path.extname(name).toLowerCase())) continue
      if (name.endsWith('.map')) continue
      out.push(full)
    }
  }
  walk(dir)
  return out
}

/** 决定扫描根目录：APK 先解到临时目录的 assets/public */
const resolveScanRoot = () => {
  if (apkArg) {
    const apk = path.resolve(apkArg)
    if (!existsSync(apk)) { console.error(`APK 不存在: ${apk}`); process.exit(2) }
    const tmp = mkdtempSync(path.join(tmpdir(), 'artifact-redaction-'))
    try {
      execFileSync('unzip', ['-q', apk, 'assets/public/*', '-d', tmp], { stdio: 'pipe' })
    } catch {
      console.error(`APK 解不开（unzip 失败）: ${apk}`)
      process.exit(2)
    }
    const root = path.join(tmp, 'assets', 'public')
    if (!existsSync(root)) { console.error(`APK 里没有 assets/public: ${apk}`); process.exit(2) }
    return { root, cleanup: () => rmSync(tmp, { recursive: true, force: true }), label: `apk:${path.basename(apk)}` }
  }
  const dir = path.resolve(dirArg ?? path.join(ROOT, 'dist'))
  if (!existsSync(dir)) {
    console.error(`产物目录不存在: ${dir} —— 先 pnpm build（或用 --apk 指一个包）`)
    process.exit(2)
  }
  return { root: dir, cleanup: () => {}, label: `dir:${path.relative(ROOT, dir) || '.'}` }
}

/**
 * 扫一个文本，返回 literal → 次数。
 * **归一成 `host[:port]`（不带 scheme）**：同一个地址在 bundle 里可能以
 * `http://h:60010`、`h:60010`、`h` 三种形态出现，按 scheme 归并会把同一件事算成三条基线，
 * 基线就必然会腐烂。
 */
const scanText = (text, bucket, where) => {
  const add = (literal) => {
    bucket.set(literal, (bucket.get(literal) ?? 0) + 1)
    if (!bucket.where.has(literal)) bucket.where.set(literal, new Set())
    bucket.where.get(literal).add(where)
  }
  const normalize = (raw) => {
    // 去掉 scheme 与路径，只留 host[:port]；裸 `:port` 不单独计（它必然伴随某条 host 命中）
    const noScheme = raw.replace(/^https?:\/\//, '')
    const m = /^([^/?#]+?)(?:[/?#]|$)/.exec(noScheme)
    return m ? m[1] : noScheme
  }
  // 只保留两个正则：RE_BARE_HOST 已覆盖 `host[:port]`（含被 `http://` 前缀的那种），
  // 再叠一个 buildLiteralRe 会把同一处地址数成两次（基线就对不上了）。
  for (const re of [RE_RFC1918, RE_BARE_HOST]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const lit = normalize(m[0])
      if (/^:\d+$/.test(lit)) continue
      add(lit)
    }
  }
}

const main = () => {
  const { root, cleanup, label } = resolveScanRoot()
  const hits = new Map()
  hits.where = new Map()
  let scanned = 0
  try {
    for (const file of listFiles(root)) {
      const text = readFileSync(file, 'utf8')
      scanned += 1
      scanText(text, hits, path.relative(root, file))
    }
  } finally {
    cleanup()
  }

  let baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch (e) {
    console.error(`基线读不出或不是合法 JSON: ${BASELINE_REL}（${e.message}）`)
    process.exit(2)
  }
  const baseMap = new Map((baseline.entries ?? []).map((e) => [e.literal, e.count ?? 0]))

  const added = []      // 基线外的新命中 → 红
  const grown = []      // 基线里有但次数变多 → 红
  const shrunk = []     // 基线里有但已消失/变少 → 只 WARN
  for (const [literal, count] of hits) {
    if (!baseMap.has(literal)) { added.push({ literal, count, files: [...(hits.where.get(literal) ?? [])] }); continue }
    const limit = baseMap.get(literal)
    if (count > limit) grown.push({ literal, count, limit, files: [...(hits.where.get(literal) ?? [])] })
    else if (count < limit) shrunk.push({ literal, count, limit })
  }
  for (const [literal, limit] of baseMap) {
    if (!hits.has(literal)) shrunk.push({ literal, count: 0, limit })
  }

  const ok = added.length === 0 && grown.length === 0
  if (asJson) {
    console.log(JSON.stringify({ ok, target: label, scanned, added, grown, shrunk, hits: [...hits].map(([literal, count]) => ({ literal, count })) }, null, 2))
  } else if (!quiet) {
    console.log(`产物内网地址检查（#745）· 扫描 ${scanned} 个文件 · target=${label}`)
    if (added.length) {
      console.log('\n[FAIL] 基线外的新内网地址（这是要防的：又往 bundle 里塞了一个）：')
      for (const a of added) console.log(`  ${a.literal} ×${a.count}  ← ${a.files.slice(0, 3).join(', ')}`)
    }
    if (grown.length) {
      console.log('\n[FAIL] 基线内条目出现次数变多：')
      for (const g of grown) console.log(`  ${g.literal} ×${g.count}（基线 ${g.limit}）← ${g.files.slice(0, 3).join(', ')}`)
    }
    if (shrunk.length) {
      console.log('\n[WARN] 这些已在产物里消失/变少，请从基线删掉（只减不增，别让基线腐烂）：')
      for (const s of shrunk) console.log(`  ${s.literal} ×${s.count}（基线 ${s.limit}）`)
    }
    console.log(ok
      ? `\n结论：PASS —— 没有新增内网地址（基线内 ${baseMap.size} 条存量待 #745 清理）`
      : '\n结论：FAIL —— 产物里出现了不该有的内网地址')
  }
  process.exit(ok ? 0 : 1)
}

main()
