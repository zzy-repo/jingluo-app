// D1 · 语法/API 探针（最重要的一类）
// 构造方式：不注入任何畸形数据，而是问「给定一个 ES 目标，代码里用到的语法/API 有哪些不可用，
//          因此哪一版 WebView 会直接崩或功能缺失」。
// 期望：probe.mjs 的判定要单调（版本越高可用越多）、每条都带最低 Chromium 版本与依据、
//      标注「静态推断」、给出可机器读取的退出码，且能被其它用例复用。
import { execFileSync } from 'node:child_process'

const probeUrl = new URL('../../../scripts/compat/probe.mjs', import.meta.url)
const probe = await import(probeUrl.href)

console.log('[d1] D. 语法/API 探针')
console.log('构造方式：对 chromium79 / 83 / 91 / 109 四个目标求「哪些特性不可用」并单调性校验。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const TARGETS = [79, 83, 91, 109]

// 1) 判定结构完整
const reports = TARGETS.map((chromium) => probe.judge(chromium))
const shapeOk = reports.every(
  (report) =>
    report.expected === '静态推断' &&
    typeof report.total === 'number' &&
    Array.isArray(report.unavailable) &&
    report.unavailable.every(
      (item) => typeof item.id === 'string' && item.minChrome > report.chromium && item.basis && item.evidence === '静态推断'
    )
)
check('1) 每条判定都带最低版本 + 依据 + 「静态推断」标注', shapeOk, reports.map((report) => `${report.chromium}:${report.unavailableCount}/${report.total}`).join(' '))

// 2) 单调性：目标版本越高，不可用越少
const monotonic = reports.every((report, index) => index === 0 || report.unavailableCount <= reports[index - 1].unavailableCount)
check(
  '2) 判定随目标版本单调（79 ≥ 83 ≥ 91 ≥ 109）',
  monotonic,
  reports.map((report) => `chromium${report.chromium}: ${report.unavailableCount} 项不可用`).join(' / ')
)

// 3) 关键结论：chrome>=83 是 browserslist 的下限，79 上到底会崩在哪
const at79 = new Set(reports[0].unavailable.map((item) => item.id))
const at83 = new Set(reports[1].unavailable.map((item) => item.id))
const mustBreak79 = ['optional-chaining', 'nullish-coalescing', 'logical-assignment', 'string-replaceall', 'intl-segmenter', 'object-hasown', 'structured-clone', 'top-level-await']
const missing79 = mustBreak79.filter((id) => !at79.has(id))
check(
  '3) chromium79 上必崩项（?./??/||=/replaceAll/Intl.Segmenter/hasOwn/structuredClone/TLA）全部命中',
  missing79.length === 0,
  missing79.length === 0 ? mustBreak79.join(', ') : `未命中：${missing79.join(', ')}`
)
const mustBreak83 = ['object-hasown', 'structured-clone', 'array-at', 'top-level-await', 'class-static-block', 'abort-signal-timeout', 'string-at']
const missing83 = mustBreak83.filter((id) => !at83.has(id))
check(
  '4) chromium83 是项目下限：hasOwn/structuredClone/at()/TLA 这些在 83 上仍不可用（说明下限只能靠转译保）',
  missing83.length === 0,
  missing83.length === 0 ? mustBreak83.join(', ') : `未命中：${missing83.join(', ')}`
)

// 5) 特性表本身：id 唯一、用法正则可编译
const ids = probe.FEATURES.map((feature) => feature.id)
const unique = new Set(ids).size === ids.length
const regexOk = probe.FEATURES.every((feature) => feature.usage instanceof RegExp)
check('5) 特性表自洽：id 唯一、每条都有可编译的用法正则', unique && regexOk, `${ids.length} 条特性`)

// 6) 真实扫描：代码里到底用了哪些高危特性
const hits = probe.scan('.')
const hitIds = [...new Set(hits.map((hit) => hit.id))]
const pre83 = hits.filter((hit) => hit.minChrome > 83)
check(
  '6) 扫描 src：统计最低版本 > 83 的实际用点（这些就是「哪一版 WebView 会出问题」的直接证据）',
  hits.length > 0,
  `${hits.length} 处命中、${hitIds.length} 个特性；其中 minChrome>83 的 ${pre83.length} 处`
)
for (const id of [...new Set(pre83.map((hit) => hit.id))]) {
  const sample = pre83.find((hit) => hit.id === id)
  console.log(`  · ${id}（Chrome ${sample.minChrome}+）：${sample.file}:${sample.line} ${sample.text.slice(0, 70)}`)
}

// 7) CLI 契约：--json / 退出码
const runCli = (args) => {
  try {
    const out = execFileSync(process.execPath, [probeUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], {
      encoding: 'utf8',
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
// stdout 是 JSON；stderr 里可能有 node 自身的 ExperimentalWarning，取首个 { 到末个 } 之间
const parseJson = (text) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
const cli79 = runCli(['--target', 'chromium79', '--json'])
const parsed79 = parseJson(cli79.out)
check(
  '7) CLI --target chromium79 --json → 退出码 1 + 可解析 JSON',
  cli79.code === 1 && parsed79.chromium === 79 && parsed79.unavailableCount > 0,
  `exit=${cli79.code} unavailable=${parsed79.unavailableCount}`
)
const cli120 = runCli(['--target', 'chromium120', '--json'])
check(
  '8) CLI --target chromium120 --json → 退出码 0（全部可用）',
  cli120.code === 0 && JSON.parse(cli120.out).unavailableCount === 0,
  `exit=${cli120.code}`
)
const cliList = runCli(['--list'])
check(
  '9) CLI --list → 列出全部特性 id',
  ids.every((id) => cliList.out.includes(id)),
  `${ids.length} 条`
)

// 10) 结论表：给报告直接用
console.log('')
console.log('  「哪一版 WebView 会出问题」结论表（静态推断）：')
for (const report of reports) {
  const ids = report.unavailable.slice(0, 6).map((item) => `${item.id}(≥${item.minChrome})`)
  const rest = report.unavailable.length > ids.length ? ` 等 ${report.unavailable.length} 项` : ''
  console.log(`   chromium${report.chromium}：${report.unavailableCount} 项不可用 → ${ids.join('、')}${rest}`)
}

const failed = checks.filter((item) => !item.pass)
console.log(`[d1] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
