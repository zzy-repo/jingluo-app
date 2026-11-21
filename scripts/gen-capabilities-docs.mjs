#!/usr/bin/env node
/**
 * `docs/capabilities/{api,css,host}.md` 的**机器可读部分**由本脚本现算生成（#240 立规，#542 落地）。
 *
 *   node scripts/gen-capabilities-docs.mjs            # 重算并写盘
 *   node scripts/gen-capabilities-docs.mjs --check    # 只比对，有漂移 exit 1（不写盘）
 *   node scripts/gen-capabilities-docs.mjs --sha <sha># 指定「快照基准」commit（默认取 origin/main tip）
 *
 * ## 为什么要有它
 *
 * `tests/unit/capabilities-docs-sync.test.mjs` 会把四份盘点的**数字**与**行号**跟实时复算对一遍。
 * 在此之前这些数字是**人手抄进文档**的，于是每次修复碰到被盘点的代码就要重抄一遍 ——
 * #226 / #230 / #231 / #232 / #240 / #542 都在重复这件事，抄错的形态也一样：
 * 数字改了一半、`文件:行` 只改了一部分（#542 时 host.md 有 55 条引用指不到实时命中）。
 * 生成器把「算」和「写」接起来，人只留判断与结论，不碰数字。
 *
 * ## 谁的口径
 *
 * 数字一律来自 `scripts/lib/*AssumptionAudit.mjs` 这几个**纯判定模块**（与 `check-capabilities.mjs`、
 * 单元测试同一份），本脚本不判定任何东西，只做「遍历 → 汇总 → 排版」：
 *
 * - `apiAssumptionAudit.mjs`  → `docs/capabilities/api.md`
 * - `cssAssumptionAudit.mjs`  → `docs/capabilities/css.md`
 * - `hostCapabilityAudit.mjs` → `docs/capabilities/host.md`
 *
 * ## 生成什么、不生成什么
 *
 * **生成**（机器可读，人在这些格子里写字一律会被覆盖）：
 *
 * - host.md：扫描范围文件数、`总计 … 条命中` 的 verdict / 风险分布、**整张明细表**（`文件:行` 从这里来）、
 *   各能力命中数表、「0 命中清单」之外的第二个总计行；
 * - api.md：扫描范围、§一 合计表、类别 1 命中总数句、§二 标题处数、§二 明细表的 `文件:行`（按文件内
 *   出现顺序重锚）、§三 每行的命中 / 涉及文件数；
 * - css.md：§0 扫描范围 / 口径拆分 / 命中总数、§1 逐特性表的命中与分类列 + 合计行；
 * - 四份文档的 `快照基准：<sha>`（同一个 commit，改动 sha 时顺带刷新 `采集时间`）。
 *
 * **不生成**（人的判断，脚本一个字都不碰）：结论列、复核记录、真实漏洞拆单、已知边界、「0 命中清单」
 * 里的备注、css.md §2.x 明细表的分节叙述。数字对不上时脚本只报「哪一格漂了」，不替人下结论。
 *
 * 退出码：`0` 一致 / 已写盘；`1` `--check` 发现漂移；`2` 环境错误（找不到 `src/` 或锚点行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { auditApiAssumptions, summarize as summarizeApi } from './lib/apiAssumptionAudit.mjs'
import { auditCssAssumptions, collectSources } from './lib/cssAssumptionAudit.mjs'
import { auditHostCapabilities, CAPABILITY_RULES } from './lib/hostCapabilityAudit.mjs'
import { isVendored } from './lib/vendoredPaths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
const DOCS = path.join(ROOT, 'docs', 'capabilities')
const SRC = path.join(ROOT, 'src')

const posix = (p) => p.split(path.sep).join('/')

/** 本轮跑出来的可报告量（CLI 打印用，不参与判定） */
const STATS = { hostStaleRefs: 0 }

const walk = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// ---------------------------------------------------------------- 实时复算（与 capabilities-docs-sync.test.mjs 同一口径）

const ALL_SRC = walk(SRC).filter((p) => !isVendored(p))
const SRC_REL = ALL_SRC.map((p) => posix(path.relative(ROOT, p)))

const API_RAW = auditApiAssumptions(
  ALL_SRC.map((p) => ({ path: posix(path.relative(ROOT, p)), text: fs.readFileSync(p, 'utf8') })),
)
const API = summarizeApi(API_RAW)

const CSS_RESULT = auditCssAssumptions(collectSources(SRC))
const CSS = CSS_RESULT.summary

const HOST_SCOPE = SRC_REL.filter((p) => /\.(ts|tsx|html)$/.test(p))
const HOST_RESULT = auditHostCapabilities(
  HOST_SCOPE.map((p) => ({ file: p, text: fs.readFileSync(path.join(ROOT, p), 'utf8') })),
)
const HOST = HOST_RESULT.summary

const countExt = (ext) => SRC_REL.filter((p) => path.extname(p).toLowerCase() === ext).length

// ---------------------------------------------------------------- 行 / 表格小工具

const readDoc = (name) => {
  const text = fs.readFileSync(path.join(DOCS, name), 'utf8')
  const trailing = text.endsWith('\n')
  const lines = text.split('\n')
  if (trailing) lines.pop()
  return { lines, trailing }
}

const writeDoc = (name, { lines, trailing }) => {
  fs.writeFileSync(path.join(DOCS, name), lines.join('\n') + (trailing ? '\n' : ''))
}

/** 拆表格行为裸单元格（保留空白，转义竖线 `\|` 不当分隔符）。 */
const splitRow = (line) => {
  const parts = line.split(/(?<!\\)\|/)
  return { lead: parts[0], cells: parts.slice(1, -1), tail: parts[parts.length - 1] }
}

const joinRow = ({ lead, cells, tail }) => `${lead}|${cells.join('|')}|${tail}`

/** 取单元格里的可见文字（去强调与行内代码），用于定位行。 */
const plain = (cell) => cell.replace(/\*\*/g, '').replace(/`/g, '').trim()

/** 列宽对齐：`| a | b |` 的单元格两侧各留一个空格。 */
const cell = (text) => ` ${text} `

class AnchorError extends Error {}

const findLine = (lines, pred, what) => {
  const index = lines.findIndex(pred)
  if (index < 0) throw new AnchorError(`找不到锚点：${what}`)
  return index
}

/**
 * 把一张表的数据行整体替换掉（表头 + 分隔线由文档保留）。
 *
 * 返回「这次替换改了几行」的记账，供 `--check` 累加 —— **以前这里不记账**，于是
 * 明细表里那些 `文件:行` 漂了也不报漂移：`--check` 说「一致」，`gen` 一跑却把
 * 4 行旧行号（`src/index.html:227/262/362/472` → `236/278/378/488`）静默改写。
 * 门禁看不见的漂移等于没有门禁（#652 车道 A / D12 的实测：`check:doc-refs`
 * 的 host.md WARN 就是这么攒出来的）。
 */
const replaceTableRows = (lines, headerPred, rows, what) => {
  const header = findLine(lines, (l) => l.startsWith('|') && headerPred(l), what)
  let end = header + 1
  while (end < lines.length && (lines[end].startsWith('|') || end === header + 1)) end += 1
  if (end === header + 1 || !lines[header + 1]?.startsWith('|')) {
    throw new AnchorError(`表格「${what}」没有分隔线，格式不是本脚本认识的形状`)
  }
  const before = lines.slice(header + 2, end)
  lines.splice(header + 2, end - header - 2, ...rows)
  const after = lines.slice(header + 2, header + 2 + rows.length)
  const drifted = before.length !== after.length || before.some((line, i) => line !== after[i])
  return drifted ? { before: `${before.length} 行`, after: `${after.length} 行` } : null
}

/** 对表格里第一列匹配到 needle 的那一行的某个单元格做替换。 */
const patchRowCell = (lines, headerPred, needle, cellIndex, transform, what) => {
  const header = findLine(lines, (l) => l.startsWith('|') && headerPred(l), what)
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const row = splitRow(lines[i])
    if (!plain(row.cells[0]).includes(needle)) continue
    const next = transform(row.cells[cellIndex] ?? '')
    if (next === null) return null
    const before = lines[i]
    row.cells[cellIndex] = cell(next)
    lines[i] = joinRow(row)
    return before === lines[i] ? null : { before, after: lines[i] }
  }
  throw new AnchorError(`表格「${what}」里找不到「${needle}」行`)
}

const setString = (lines, pred, what, next) => {
  const index = findLine(lines, pred, what)
  const before = lines[index]
  lines[index] = next(before)
  return before === lines[index] ? null : { before, after: lines[index] }
}

// ---------------------------------------------------------------- host.md

const hostFiles = HOST.files
/** 旧明细行 → 能力 id：先按扫描器的 `reason` 认（历史行大多照抄它），认不出再按能力名认。 */
const ruleReasons = CAPABILITY_RULES.flatMap((rule) =>
  [rule.reason, rule.onReason].filter(Boolean).map((reason) => ({ reason, id: rule.id })),
).sort((a, b) => b.reason.length - a.reason.length)

const capabilityOfRowText = (text) => {
  const byReason = ruleReasons.find(({ reason }) => text.startsWith(reason))
  if (byReason) return byReason.id
  const byId = [...CAPABILITY_RULES]
    .sort((a, b) => b.id.length - a.id.length)
    .find((rule) => text.includes(rule.id))
  return byId ? byId.id : null
}

/**
 * 明细表的「假设内容」大多就是扫描器的 `reason`，但人往里补过现场说明
 * （「#434 折叠区的响应摘要」「#104 自助信息」这类）。这些说明是文档的价值所在，
 * 所以：同一个（文件, 能力）组里旧行数与实时命中数相等时，**沿用旧行的说明文字**，
 * 只把 `文件:行` 换成实时行号；组里数量变了才退回扫描器的原始 reason。
 */
const hostRows = (lines) => {
  const old = new Map() // `${file}\u0000${capability}` -> [假设内容...]
  const header = lines.findIndex((l) => l.startsWith('|') && l.includes('文件:行') && l.includes('假设内容'))
  if (header >= 0) {
    for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
      const row = splitRow(lines[i])
      const ref = plain(row.cells[0])
      const colon = ref.lastIndexOf(':')
      const file = colon < 0 ? ref.replace(/\s*的.*$/u, '').trim() : ref.slice(0, colon).trim()
      const capability = capabilityOfRowText(plain(row.cells[1] ?? ''))
      if (!capability) continue
      const key = `${file}\u0000${capability}`
      if (!old.has(key)) old.set(key, [])
      // 存原始单元格文本（含行内代码 / 加粗），plain() 只用来认能力
      old.get(key).push((row.cells[1] ?? '').trim())
    }
  }

  const groups = new Map()
  for (const hit of HOST_RESULT.hits) {
    const key = `${hit.file}\u0000${hit.capability}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(hit)
  }

  const reasonFor = new Map()
  for (const [key, hits] of groups) {
    const previous = old.get(key) ?? []
    const reusable = previous.length === hits.length
    hits.forEach((hit, index) => {
      // 扫描器的 `reason` 极少数情况下是 undefined（`fetch 响应体 clone` 这条规则只写了 `onReason`，
      // 兜底命中时走到 `rule.reason`）——退能力名，别让文档里出现 "undefined"
      const base = hit.reason ?? hit.capability
      // 旧行是自成一体的说明（人把它当整句重写过），沿用即可；没得沿用才退回扫描器的 reason。
      // 表格单元格里的竖线必须转义，否则整行会被拆错列。
      const kept = reusable ? (previous[index] ?? base) : base
      reasonFor.set(hit, kept.replace(/\|/gu, '\\|'))
    })
  }

  return HOST_RESULT.hits.map(
    (hit) =>
      `| \`${hit.file}:${hit.line}\` | ${reasonFor.get(hit)} | 3 | ${hit.risk} | ${hit.disposition} |`,
  )
}

const hostTotalLine = () =>
  `**总计 ${HOST.total} 条命中**（\`已有兜底\` ${HOST.byVerdict['已有兜底']} / \`无风险\` ${HOST.byVerdict['无风险']} / \`真实漏洞\` ${HOST.byVerdict['真实漏洞']} / \`需动态验证\` ${HOST.byVerdict['需动态验证']}）；风险分布：高 ${HOST.byRisk['高']}、中 ${HOST.byRisk['中']}、低 ${HOST.byRisk['低']}。`

const hostCapabilityRows = () =>
  HOST.byCapability.map(
    (stat) =>
      `| \`${stat.capability}\` | ${stat.total} | ${stat.verdicts['已有兜底']} | ${stat.verdicts['无风险']} | ${stat.verdicts['真实漏洞']} | ${stat.verdicts['需动态验证']} |`,
  )

/** 旧明细表里指不到实时命中的 `文件:行` 条数 —— 报给人看「这次重锚了几条」。 */
const countStaleHostRefs = (lines) => {
  const live = new Set(HOST_RESULT.hits.map((hit) => `${hit.file}:${hit.line}`))
  const header = lines.findIndex((l) => l.startsWith('|') && l.includes('文件:行') && l.includes('假设内容'))
  if (header < 0) return 0
  let stale = 0
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    for (const m of plain(splitRow(lines[i]).cells[0]).matchAll(/`?([\w@./-]+\.(?:ts|tsx|html)):(\d+)`?/gu)) {
      if (!live.has(`${m[1]}:${m[2]}`)) stale += 1
    }
  }
  return stale
}

const genHost = (doc) => {
  const { lines } = doc
  const changes = []
  STATS.hostStaleRefs = countStaleHostRefs(lines)

  changes.push(
    setString(
      lines,
      (l) => l.startsWith('> **扫描范围**'),
      'host.md 扫描范围',
      () => `> **扫描范围**：\`src/**\` 的 **${hostFiles}** 个源文件。`,
    ),
  )

  // 「拆分」行：只重算前半段的分项数字，括号里的历史说明（人写的）原样保留。
  const split = findLine(lines, (l) => l.startsWith('> 拆分：'), 'host.md 拆分')
  lines[split] = lines[split].replace(
    /^> 拆分：`\.ts` \*\*\d+\*\* \/ `\.tsx` \d+ \/ `\.html` \d+ = \d+/u,
    `> 拆分：\`.ts\` **${countExt('.ts')}** / \`.tsx\` ${countExt('.tsx')} / \`.html\` ${countExt('.html')} = ${hostFiles}`,
  )

  // 两处「总计 … 条命中」：命中明细的汇总 + 各能力表逐行相加，同一个实时复算。
  let seen = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\*\*总计 \d+ 条命中\*\*（/u.test(lines[i])) continue
    seen += 1
    const before = lines[i]
    lines[i] = hostTotalLine()
    if (before !== lines[i]) changes.push({ before, after: lines[i] })
  }
  if (seen !== 2) throw new AnchorError(`host.md 应有 2 处「总计 … 条命中」行，实际 ${seen}`)

  const rows = hostRows(lines)
  changes.push(
    replaceTableRows(
      lines,
      (l) => l.includes('文件:行') && l.includes('假设内容'),
      rows,
      'host.md 明细表',
    ),
  )
  changes.push(
    replaceTableRows(
      lines,
      (l) => l.includes('能力') && l.includes('需动态验证'),
      hostCapabilityRows(),
      'host.md 各能力命中数表',
    ),
  )

  return changes.filter(Boolean)
}

// ---------------------------------------------------------------- api.md

/** api.md §三 的「标签 → 实时分项」映射：一行合并多个 API 的写法（`a / b`）按 / 拆开求和。 */
const apiLabels = (label) => {
  const live = new Map(API.byApi.map((bucket) => [bucket.api, bucket]))
  if (live.has(label)) return [live.get(label)]
  return label
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => live.get(part) ?? null)
    .filter(Boolean)
}

/**
 * api.md §二 明细表重锚：按**文件内出现顺序**把文档行与实时命中对齐。
 *
 * 明细表的「假设内容」是人写的说明（例如「13 处接收者全是数组」），不能由脚本复述；
 * 但 `文件:行` 必须是真的，所以只重写第一列的**行号**，其余列一个字不动。
 * 某个文件的行数与实时命中数对不上时直接报错 —— 硬凑只会造出偏一行还看似合理的表。
 */
const reanchorApiRows = (lines) => {
  const header = findLine(
    lines,
    (l) => l.startsWith('|') && l.includes('文件:行') && l.includes('假设内容'),
    'api.md §二 明细表',
  )

  const byFile = new Map()
  for (const hit of API_RAW.hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, [])
    byFile.get(hit.file).push(hit.line)
  }

  const cursor = new Map()
  const changes = []
  let rows = 0
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows += 1
    const row = splitRow(lines[i])
    const ref = plain(row.cells[0])
    const colon = ref.lastIndexOf(':')
    if (colon < 0) throw new AnchorError(`api.md §二 第一列不是 \`文件:行\`：${ref}`)
    const file = ref.slice(0, colon).trim()
    const lines0 = byFile.get(file)
    if (!lines0) throw new AnchorError(`api.md §二 记了 \`${file}\`，但实时复算没有这个文件的命中`)
    const at = cursor.get(file) ?? 0
    if (at >= lines0.length) throw new AnchorError(`api.md §二 \`${file}\` 的行数比实时命中的 ${lines0.length} 条多`)
    const next = `\`${file}:${lines0[at]}\``
    cursor.set(file, at + 1)
    if (row.cells[0] !== cell(next)) {
      changes.push({ before: `\`${ref}\``, after: next })
      row.cells[0] = cell(next)
      lines[i] = joinRow(row)
    }
  }

  for (const [file, list] of byFile) {
    if ((cursor.get(file) ?? 0) !== list.length) {
      throw new AnchorError(
        `api.md §二 \`${file}\` 写了 ${cursor.get(file) ?? 0} 条，实时复算是 ${list.length} 条 —— 先补/删行再重跑`,
      )
    }
  }
  return { rows, changes }
}

const genApi = (doc) => {
  const { lines } = doc
  const changes = []

  changes.push(
    patchRowCell(
      lines,
      (l) => l.includes('| 项目 | 值 |'),
      '扫描范围',
      1,
      () =>
        `\`src/**\` 共 **${SRC_REL.length}** 个文件（**${countExt('.ts')}** \`.ts\` / ${countExt('.tsx')} \`.tsx\` / ${countExt('.css')} \`.css\` / ${countExt('.html')} \`.html\` / ${countExt('.md')} \`.md\`）`,
      'api.md 扫描范围',
    ),
  )

  // §一 按类别合计
  for (const [needle, value] of [
    ['entry-polyfill', API.byVerdict['entry-polyfill']],
    ['baseline', API.byVerdict.baseline],
    ['uncovered', API.byVerdict.uncovered],
    ['合计', API.total],
  ]) {
    changes.push(
      patchRowCell(
        lines,
        (l) => l.includes('含义') && l.includes('命中数'),
        needle,
        2,
        () => `**${value}**`,
        `api.md §一「${needle}」`,
      ),
    )
  }

  // 类别 1 命中总数一句话 + §二 标题处数
  changes.push(
    setString(
      lines,
      (l) => /^类别 1 命中总数 \*\*\d+ 处\*\*/u.test(l),
      'api.md 类别 1 命中总数句',
      () =>
        `类别 1 命中总数 **${API.total} 处**：${API.byVerdict['entry-polyfill']} 处依赖入口 polyfill、${API.byVerdict.baseline} 处落在基线内、**${API.byVerdict.uncovered} 处裸调用无兜底**。`,
    ),
  )
  changes.push(
    setString(
      lines,
      (l) => l.startsWith('## ') && l.includes('逐条命中'),
      'api.md §二 标题',
      (before) => before.replace(/（\d+ 处）/u, `（${API.total} 处）`),
    ),
  )

  // §二 明细：只重锚行号
  const anchored = reanchorApiRows(lines)
  changes.push(...anchored.changes)

  // §三 按 API 汇总：命中 / 涉及文件
  const header = findLine(
    lines,
    (l) => l.startsWith('|') && l.includes('首次支持') && l.includes('命中'),
    'api.md §三 表',
  )
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const row = splitRow(lines[i])
    const known = apiLabels(plain(row.cells[0]))
    if (known.length === 0) continue
    const count = known.reduce((sum, bucket) => sum + bucket.count, 0)
    const files = new Set(known.flatMap((bucket) => bucket.files))
    const next2 = cell(String(count))
    const next3 = cell(String(files.size))
    if (row.cells[2] !== next2 || row.cells[3] !== next3) {
      changes.push({ before: `${plain(row.cells[0])}：${row.cells[2].trim()}/${row.cells[3].trim()}`, after: `${count}/${files.size}` })
      row.cells[2] = next2
      row.cells[3] = next3
      lines[i] = joinRow(row)
    }
  }

  return changes.filter(Boolean)
}

// ---------------------------------------------------------------- css.md

/** css.md §1 的「特性」标签 → `CSS.byFeature` 键（与 capabilities-docs-sync.test.mjs 同一份映射）。 */
const CSS_LABEL_TO_FEATURE = new Map([
  ['嵌套 &', 'nesting &'],
  ['flex gap', 'flex-gap'],
  ['min() / max()', 'min()/max()'],
  [':has()', ':has()'],
  [':focus-visible', ':focus-visible'],
  ['overscroll-behavior', 'overscroll-behavior'],
  ['env(safe-area-inset-*)', 'env(safe-area-inset-*)'],
  ['getComputedStyle 声明回读', 'getComputedStyle'],
  ['touch-action', 'touch-action'],
  ['backdrop-filter', 'backdrop-filter'],
  ['scrollbar-gutter', 'scrollbar-gutter'],
  ['inset', 'inset'],
  [':where() / :is()', ':where()/:is()'],
  ['@container', '@container'],
  ['container-type', 'container-type'],
])

const cssFiles = SRC_REL.filter((p) => p.endsWith('.css'))
const cssModuleFiles = cssFiles.filter((p) => p.endsWith('.module.css'))

const genCss = (doc) => {
  const { lines } = doc
  const changes = []

  changes.push(
    patchRowCell(
      lines,
      (l) => l.includes('| 项 | 值 |'),
      '扫描范围',
      1,
      () =>
        `\`src/**\` 全部源文件 **${CSS.files}** 个（\`.css\` **${cssFiles.length}** 个，其中 \`*.module.css\` **${cssModuleFiles.length}** 个；其余 \`.ts / .tsx / .html\` 共 **${CSS.files - cssFiles.length}** 个）`,
      'css.md §0 扫描范围',
    ),
  )
  changes.push(
    patchRowCell(
      lines,
      (l) => l.includes('| 项 | 值 |'),
      '口径拆分',
      1,
      () =>
        `${cssFiles.length} \`.css\` + ${countExt('.ts')} \`.ts\` + ${countExt('.tsx')} \`.tsx\` + ${countExt('.html')} \`.html\` = ${CSS.files}`,
      'css.md §0 口径拆分',
    ),
  )
  changes.push(
    patchRowCell(
      lines,
      (l) => l.includes('| 项 | 值 |'),
      '命中总数',
      1,
      () => `**${CSS.hits}** 处，分布在 **${CSS.filesWithHits}** 个文件`,
      'css.md §0 命中总数',
    ),
  )

  // §1 逐特性表：命中 + 五个分类列 + 合计行
  const header = findLine(
    lines,
    (l) => l.startsWith('|') && l.includes('首支持 Chromium') && l.includes('命中'),
    'css.md §1 逐特性表',
  )
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const row = splitRow(lines[i])
    const label = plain(row.cells[0])
    if (label === '合计') {
      const totals = [
        CSS.hits,
        CSS.byVerdict.covered,
        CSS.byVerdict['no-risk'],
        CSS.byVerdict.degraded,
        CSS.byVerdict.defect,
        CSS.falsePositives.length,
      ]
      const before = row.cells.slice(2, 8).map((c) => c.trim()).join('/')
      for (let k = 0; k < totals.length; k += 1) row.cells[2 + k] = cell(`**${totals[k]}**`)
      const after = totals.join('/')
      if (before.replace(/\*/g, '') !== after) changes.push({ before: `合计 ${before}`, after })
      lines[i] = joinRow(row)
      continue
    }
    const feature = label.startsWith('@supports 块') ? '@supports' : CSS_LABEL_TO_FEATURE.get(label)
    if (!feature) continue
    const live = CSS.byFeature[feature]
    const numbers = live
      ? [live.count, live.covered, live.noRisk, live.degraded, live.defect, live.falsePositive]
      : [0, 0, 0, 0, 0, 0]
    const before = row.cells.slice(2, 8).map((c) => c.trim()).join('/')
    for (let k = 0; k < numbers.length; k += 1) {
      // 保留人写的加粗（`**0**` / `**389**` 这类重点标法）
      const bold = row.cells[2 + k].includes('**')
      row.cells[2 + k] = cell(bold ? `**${numbers[k]}**` : `${numbers[k]}`)
    }
    const after = numbers.join('/')
    if (before.replace(/\*/g, '') !== after) changes.push({ before: `${label} ${before}`, after })
    lines[i] = joinRow(row)
  }

  return changes.filter(Boolean)
}

// ---------------------------------------------------------------- 四份文档的快照抬头

const HEADER_DOCS = ['api.md', 'css.md', 'host.md', 'behavior.md']

/** 默认不重打抬头：`快照基准` 是人决定「这一版以哪个 commit 为准」的地方，不是算出来的。 */
const resolveSha = (argSha) => argSha ?? null

const stampNow = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  // 采集时间按 +0800 记，与既有抬头一致
  const utc = new Date(now.getTime() + 8 * 3600 * 1000)
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`
}

/** 统一四份文档的 `快照基准` / `采集时间`；sha 变了才刷新采集时间，保证重跑幂等。 */
const stampHeader = (doc, sha) => {
  const { lines } = doc
  const changes = []
  if (!sha) return changes
  const index = lines.findIndex((l) => l.includes('快照基准'))
  if (index < 0) return changes
  const before = lines[index]
  const current = before.match(/快照基准：`([0-9a-f]{7,40})`/u)?.[1] ?? null
  let next = before.replace(/快照基准：`[0-9a-f]{7,40}`/u, `快照基准：\`${sha}\``)
  if (current !== sha) {
    next = next.replace(/采集时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u, `采集时间：${stampNow()}`)
  }
  if (next !== before) {
    lines[index] = next
    changes.push({ before: current ?? '—', after: sha })
  }
  return changes
}

// ---------------------------------------------------------------- CLI

const main = () => {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const shaIndex = args.indexOf('--sha')
  const sha = resolveSha(shaIndex >= 0 ? args[shaIndex + 1] : null)

  if (!fs.existsSync(SRC)) {
    console.error(`✖ 找不到 ${SRC}`)
    return 2
  }

  const plan = [
    ['host.md', genHost],
    ['api.md', genApi],
    ['css.md', genCss],
  ]

  let drift = 0
  const report = []
  for (const [name, gen] of plan) {
    const doc = readDoc(name)
    const before = doc.lines.join('\n')
    let changes
    try {
      changes = gen(doc)
    } catch (error) {
      if (error instanceof AnchorError) {
        console.error(`✖ ${name}：${error.message}`)
        return 2
      }
      throw error
    }
    if (changes.length > 0) {
      drift += changes.length
      report.push(`  ${name}：${changes.length} 处`)
    }
    if (!check) writeDoc(name, doc)
  }

  if (sha) {
    const missing = []
    for (const name of HEADER_DOCS) {
      const doc = readDoc(name)
      if (stampHeader(doc, sha).length > 0) {
        missing.push(name)
        if (!check) writeDoc(name, doc)
      }
    }
    if (check && missing.length > 0) {
      console.error(`✖ 抬头基准与 --sha ${sha} 不一致：${missing.join('、')}`)
      return 1
    }
  }

  if (check) {
    if (drift > 0) {
      console.error(`✖ docs/capabilities 与实时复算不一致（${drift} 处）\n${report.join('\n')}\n跑 node scripts/gen-capabilities-docs.mjs 重算。`)
      return 1
    }
    console.log(`✔ docs/capabilities 三份表与实时复算一致${sha ? `（抬头基准 ${sha}）` : ''}`)
    return 0
  }

  console.log(
    `✔ 已按实时复算重写 docs/capabilities：host ${HOST.total} 条 / api ${API.total} 处 / css ${CSS.hits} 处`,
  )
  console.log(
    `  分布：host 已有兜底 ${HOST.byVerdict['已有兜底']} / 无风险 ${HOST.byVerdict['无风险']} / 真实漏洞 ${HOST.byVerdict['真实漏洞']} / 需动态验证 ${HOST.byVerdict['需动态验证']}；风险 高 ${HOST.byRisk['高']} / 中 ${HOST.byRisk['中']} / 低 ${HOST.byRisk['低']}；扫描 ${hostFiles} 个 .ts/.tsx/.html`,
  )
  console.log(`  host.md 明细表重锚：${STATS.hostStaleRefs} 条旧 \`文件:行\` 指不到实时命中，已按复算重写`)
  if (report.length > 0) console.log(report.join('\n'))
  return 0
}

if (process.argv[1] && posix(process.argv[1]).endsWith('gen-capabilities-docs.mjs')) {
  process.exitCode = main()
}

export { genApi, genCss, genHost, reanchorApiRows, stampHeader }
