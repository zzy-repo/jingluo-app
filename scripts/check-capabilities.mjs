/** `pnpm run check:capabilities` —— #209 的盘点闸门（**warn 级**）。
 *
 * 三件事，按顺序：
 *
 * 1. 遍历 `src/**`，把同一份源码喂给三个**纯判定**模块（三层结构的第三层就是这里：
 *    判定在 `scripts/lib/*.mjs`，CLI 只遍历 + 汇总 + 打印）；
 * 2. 类别 4（行为 / 布局）读 `docs/ui/209-behavior/*.json` 的真实测量快照，
 *    缺文件只报「未采集」—— 采集要模拟器，缺文件是环境状态，不是代码问题，**不算失败**；
 * 3. 汇总出「总命中 / 各类缺陷数 / 有缺陷的 `文件:行` 清单 / 指向对应 docs」。
 *
 * ## 为什么是 warn 级（有缺陷也 exit 0）
 *
 * #209 拆出去的 6 条修复 lane（#210 #211 #213 #214 #215 #216 #217 #218 …）正在并行改 `src/**`。
 * 此刻若把这条闸门做成硬拦截并接进 CI，任何一条 lane 的 PR 都会因为**别人还没修完**的缺陷变红，
 * 互相卡死；而缺陷清单本身已经是各路 lane 的工作输入，「红」传递不了任何新信息。
 * 所以：默认只标 `⚠`、只登记，退出码给 0；`--strict` 才是「有缺陷就 exit 1」，
 * 留给所有 lane 落地之后再接 CI（本次**不**接，也不动 `.github/workflows/**`）。
 *
 * ## 扫描范围（与既有门禁保持一致）
 *
 * - 类别 1 / 2：`src/**` 全部文本源文件（`.ts .tsx .js .mjs .cjs .jsx .css .html .md`）；
 *   CSS 与 Markdown 对 API 判定会被整篇抹空，所以多喂进去不会造成假阳性。
 * - 类别 2 的 CSS 范围包含**普通 `.css`**，不只是 `*.module.css` —— #217 把 `check:gap`
 *   扩到全部 `.css` 之后，两个门禁必须是同一个范围，否则同一份源码会被两套口径判成两个结论。
 * - 类别 3：`.ts .tsx .js .mjs .cjs .jsx .html`（与 `docs/capabilities/host.md` 的 190 文件口径同源）。
 * - 类别 4：`docs/ui/209-behavior/*.json` 里带 `width` 字段的测量快照（`before-summary.json` 这类
 *   派生文件没有 `width`，自动跳过）。
 *
 * ## 退出码
 *
 * - `0`：跑完（warn 级，有缺陷也是 0）
 * - `1`：只有 `--strict` 且确实有缺陷
 * - `2`：用法 / 环境错误（未知参数、`src/` 下一个文件都没扫到）
 *
 * ## 已知边界
 *
 * - 只统计静态审计能看见的东西：动态取用（`Reflect.get(o, 'at')`）、第三方 chunk、
 *   构建期产物都不在内（详见 `docs/capabilities/api.md` 的「已知边界」）。
 * - 「缺陷」的口径是各模块自己的结论，不在这里二次判定：类别 1 `uncovered`、类别 2
 *   `defect` / `false-positive`、类别 3 `真实漏洞`、类别 4 `不成立`；其余（`entry-polyfill`、
 *   `covered`、`degraded`、`无风险`、`需动态验证`、`成立`、`未测`）都**不算**缺陷。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { auditApiAssumptions, summarize as summarizeApi } from './lib/apiAssumptionAudit.mjs'
import { VERDICT_TEXT as CSS_VERDICT_TEXT, auditCssAssumptions } from './lib/cssAssumptionAudit.mjs'
import { auditHostCapabilities } from './lib/hostCapabilityAudit.mjs'
import { VERDICT as BEHAVIOR_VERDICT, auditBehaviorAssumptions } from './lib/behaviorAssumptionAudit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const BEHAVIOR_DIR = path.join('docs', 'ui', '209-behavior')

const DOCS = {
  api: 'docs/capabilities/api.md',
  css: 'docs/capabilities/css.md',
  host: 'docs/capabilities/host.md',
  behavior: 'docs/capabilities/behavior.md',
}

const LABELS = {
  api: '类别 1  JS 内置 API / 语言特性',
  css: '类别 2  CSS 特性 / @supports',
  host: '类别 3  平台与宿主能力',
  behavior: '类别 4  行为 / 布局假设',
}

/** 扫描的扩展名：`.md` 只为了文件数口径与 `docs/capabilities/api.md` 对齐，判定模块会整篇抹空 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.md']
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.html'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])

export const USAGE = `用法：node scripts/check-capabilities.mjs [选项]

  --strict               有缺陷时 exit 1（默认 warn 级：只标 ⚠，exit 0）
  --root <dir>           换一个仓库根（默认本仓；测试用它注入 fixture）
  --behavior-dir <dir>   换一个类别 4 测量快照目录（默认 <root>/docs/ui/209-behavior）
  --json                 只输出机器可读报告（PR 里的数字全从这抄）
  --help                 就是这段
`

class UsageError extends Error {}

const toPosix = (file) => file.split('\\').join('/')

/** 递归收集文本源文件，返回 `{ path, ext, text }`，`path` 是相对仓库根的 POSIX 路径 */
export const collectSources = (srcDir, root) => {
  const files = []
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!EXTENSIONS.includes(ext)) continue
      files.push({ path: toPosix(path.relative(root, full)), ext, text: fs.readFileSync(full, 'utf8') })
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir)
  return files
}

/** 类别 4 的输入：带 `width` 的测量快照。没有就报「未采集」，不抛错、不算失败 */
export const loadBehaviorInput = (dir, root) => {
  const shown = toPosix(path.relative(root, dir)) || dir
  if (!fs.existsSync(dir)) {
    return { dir: shown, status: 'not-collected', measurements: [], skipped: [], reason: `${shown} 不存在` }
  }
  const measurements = []
  const skipped = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      skipped.push(name)
      continue
    }
    const width = parsed?.width
    if (typeof width !== 'string' && typeof width !== 'number') {
      skipped.push(name)
      continue
    }
    measurements.push(parsed)
  }
  if (measurements.length === 0) {
    return { dir: shown, status: 'not-collected', measurements, skipped, reason: `${shown} 里没有带 width 的测量快照` }
  }
  return { dir: shown, status: 'collected', measurements, skipped, reason: '' }
}

/** 跑完四类盘点，返回报告对象（`--json` 直接打印它） */
export const auditAll = ({ root = REPO_ROOT, behaviorDir } = {}) => {
  const sources = collectSources(path.join(root, 'src'), root)
  const scriptSources = sources.filter((source) => SCRIPT_EXTENSIONS.has(source.ext))

  const apiResult = auditApiAssumptions(sources.map((source) => ({ path: source.path, text: source.text })))
  const cssResult = auditCssAssumptions(sources.map((source) => ({ path: source.path, content: source.text })))
  // 类别 3 的范围限定在脚本 / HTML（`host.md` 的口径），CSS 与 Markdown 里的同名文字不是调用点
  const hostResult = auditHostCapabilities(scriptSources.map((source) => ({ file: source.path, text: source.text })))
  const behaviorInput = loadBehaviorInput(behaviorDir ?? path.join(root, BEHAVIOR_DIR), root)
  const behaviorResult =
    behaviorInput.status === 'collected'
      ? auditBehaviorAssumptions(behaviorInput.measurements)
      : { findings: [], summary: { assumptionCount: 4, holds: 0, falsified: 0, untested: 4, widths: [], issuesToOpen: [] } }

  const apiDefects = apiResult.hits
    .filter((hit) => hit.verdict === 'uncovered')
    .map((hit) => ({
      category: 'api',
      file: hit.file,
      line: hit.line,
      label: `${hit.api} 存在（首支持 Chromium ${hit.firstSupported}，无兜底）`,
    }))
  const cssDefects = cssResult.hits
    .filter((hit) => hit.verdict === 'defect' || hit.verdict === 'false-positive')
    .map((hit) => ({
      category: 'css',
      file: hit.file,
      line: hit.line,
      label: `${hit.feature} —— ${CSS_VERDICT_TEXT[hit.verdict]}：${hit.reason}`,
    }))
  const hostDefects = hostResult.hits
    .filter((hit) => hit.verdict === '真实漏洞')
    .map((hit) => ({
      category: 'host',
      file: hit.file,
      line: hit.line,
      label: hit.reason ? `${hit.capability}（风险${hit.risk}）：${hit.reason}` : `${hit.capability}（风险${hit.risk}）`,
    }))
  const behaviorDefects = behaviorResult.findings
    .filter((finding) => finding.verdict === BEHAVIOR_VERDICT.falsified)
    .map((finding) => ({ category: 'behavior', file: null, line: null, label: `${finding.assumption} 被实测证伪` }))

  const apiSummary = summarizeApi(apiResult)
  const categories = {
    api: {
      label: LABELS.api,
      docs: DOCS.api,
      files: apiSummary.filesScanned,
      hits: apiSummary.total,
      byVerdict: apiSummary.byVerdict,
      defects: apiDefects.length,
    },
    css: {
      label: LABELS.css,
      docs: DOCS.css,
      files: cssResult.summary.files,
      filesWithHits: cssResult.summary.filesWithHits,
      hits: cssResult.summary.hits,
      byVerdict: cssResult.summary.byVerdict,
      byRisk: cssResult.summary.byRisk,
      hitFiles: [...new Set(cssResult.hits.map((hit) => hit.file))].sort(),
      defects: cssDefects.length,
    },
    host: {
      label: LABELS.host,
      docs: DOCS.host,
      files: hostResult.summary.files,
      hits: hostResult.summary.total,
      byVerdict: hostResult.summary.byVerdict,
      byRisk: hostResult.summary.byRisk,
      needsDynamic: hostResult.summary.needsDynamic.length,
      defects: hostDefects.length,
    },
    behavior: {
      label: LABELS.behavior,
      docs: DOCS.behavior,
      status: behaviorInput.status,
      dir: behaviorInput.dir,
      reason: behaviorInput.reason,
      skipped: behaviorInput.skipped,
      widths: behaviorResult.summary.widths,
      hits: behaviorResult.findings.length,
      byVerdict: { 成立: behaviorResult.summary.holds, 不成立: behaviorResult.summary.falsified, 未测: behaviorResult.summary.untested },
      findings: behaviorResult.findings.map((finding) => ({ assumption: finding.assumption, verdict: finding.verdict })),
      defects: behaviorDefects.length,
    },
  }

  const defectHits = [...apiDefects, ...cssDefects, ...hostDefects, ...behaviorDefects]
  const byExtension = {}
  for (const source of sources) byExtension[source.ext] = (byExtension[source.ext] ?? 0) + 1

  return {
    issue: 209,
    strict: false,
    scanned: {
      total: sources.length,
      byExtension,
      files: { css: sources.filter((source) => source.ext === '.css').map((source) => source.path) },
      scope: { api: sources.length, css: sources.length, host: scriptSources.length },
    },
    categories,
    defectHits,
    totals: {
      staticHits: categories.api.hits + categories.css.hits + categories.host.hits,
      behaviorFindings: categories.behavior.hits,
      hits: categories.api.hits + categories.css.hits + categories.host.hits + categories.behavior.hits,
      defects: defectHits.length,
    },
  }
}

/** 中文按两格宽算，否则中文表头会跟数字对不齐 */
const cjkWidth = (text) => {
  let width = 0
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1
  return width
}

const column = (text, width) => text + ' '.repeat(Math.max(0, width - cjkWidth(text)))

const countText = (value) => (Number.isFinite(value) ? String(value) : '—')

const formatCategoryLine = (report) => {
  const { api, css, host, behavior } = report.categories
  const behaviorHits = behavior.status === 'collected' ? String(behavior.hits) : '—'
  const behaviorNote =
    behavior.status === 'collected'
      ? `缺陷 ${behavior.defects}（成立 ${behavior.byVerdict.成立} / 不成立 ${behavior.byVerdict.不成立} / 未测 ${behavior.byVerdict.未测}）`
      : `未采集（${behavior.reason}，不算失败）`
  const rows = [
    [api.label, `命中 ${countText(api.hits)}`, `缺陷 ${api.defects}（uncovered 裸调用无兜底）`, api.docs],
    [
      css.label,
      `命中 ${countText(css.hits)}`,
      `缺陷 ${css.defects}（真实缺陷 ${css.byVerdict.defect ?? 0} + 探测假阳性 ${css.byVerdict['false-positive'] ?? 0}）`,
      css.docs,
    ],
    [host.label, `命中 ${countText(host.hits)}`, `缺陷 ${host.defects}（真实漏洞；另有需动态验证 ${host.needsDynamic}）`, host.docs],
    [behavior.label, `命中 ${behaviorHits}`, behaviorNote, behavior.docs],
  ]
  const widths = [0, 1, 2].map((index) => Math.max(...rows.map((row) => cjkWidth(row[index]))) + 2)
  return rows.map((row) => row.slice(0, 3).map((cell, index) => column(cell, widths[index])).join('') + `→ ${row[3]}`)
}

/** 人读的报告 */
export const formatReport = (report, { strict = false } = {}) => {
  const { scanned, categories, defectHits, totals } = report
  const extensions = Object.entries(scanned.byExtension)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} ${count}`)
    .join(' / ')

  const lines = [
    '#209 能力假设盘点 —— warn 级闸门（默认有缺陷也 exit 0；--strict 才 exit 1）',
    '',
    `扫描范围：src/** 共 ${scanned.total} 个文件（${extensions}）`,
    `  类别 1 / 2 口径：全部 ${scanned.scope.api} 个（CSS、Markdown 对 API 判定整篇抹空）`,
    `  类别 3 口径：.ts/.tsx/.js/.mjs/.cjs/.jsx/.html 共 ${scanned.scope.host} 个（与 docs/capabilities/host.md 同源）`,
    categories.behavior.status === 'collected'
      ? `  类别 4 口径：${categories.behavior.dir}/*.json 的 ${categories.behavior.widths.length} 份测量快照（宽度 ${categories.behavior.widths.join(' / ')}）`
      : `  类别 4 口径：${categories.behavior.dir}/*.json —— 未采集`,
    '',
    ...formatCategoryLine(report),
    '',
    `总命中 ${totals.hits}（静态 ${totals.staticHits} + 行为 ${totals.behaviorFindings} 条假设结论）`,
    `各类缺陷数：api ${categories.api.defects} / css ${categories.css.defects} / host ${categories.host.defects} / behavior ${categories.behavior.defects} —— 合计 ${totals.defects}`,
    '',
  ]

  if (defectHits.length === 0) {
    lines.push('✅ 四类盘点都没有缺陷。')
  } else {
    lines.push(`有缺陷的 文件:行 清单（${defectHits.length} 处）：`)
    for (const hit of defectHits) {
      const where = hit.file ? `${hit.file}:${hit.line}` : '（测量结论，无行号）'
      lines.push(`  [${hit.category}] ${where}  ${hit.label}`)
    }
    lines.push('')
    lines.push(
      strict
        ? `❌ --strict：${totals.defects} 处能力假设缺陷，exit 1（接 CI 之前先确认各路 lane 已落地）。`
        : `⚠ ${totals.defects} 处能力假设缺陷（warn 级：不拦截。6 条修复 lane 在飞，硬拦截会互相卡死；接 CI 时改用 --strict）。`,
    )
  }
  return lines.join('\n')
}

const parseArgs = (argv) => {
  const options = { root: REPO_ROOT, behaviorDir: null, strict: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root' || arg === '--behavior-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} 需要一个目录`)
      index += 1
      if (arg === '--root') options.root = path.resolve(value)
      else options.behaviorDir = path.resolve(value)
    } else throw new UsageError(`未知参数：${arg}`)
  }
  return options
}

/** 真正的入口（测试也可以直接调，不必起进程） */
export const main = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`check:capabilities 参数错误：${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const report = auditAll(options)
  if (report.scanned.total === 0) {
    console.error(`check:capabilities 在 ${path.join(options.root, 'src')} 下一个文件都没扫到，不谎报「通过」。`)
    return 2
  }

  console.log(options.json ? JSON.stringify({ ...report, strict: options.strict }, null, 2) : formatReport(report, options))
  return options.strict && report.totals.defects > 0 ? 1 : 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
