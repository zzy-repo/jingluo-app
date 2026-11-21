// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// docs/capabilities/*.md 四份盘点快照的「文档 ↔ 实时复算」同步检测 —— 对应 #240。
//
// 为什么需要这条测试：四份快照都是各自合并时那一版代码上数的，之后每次修复
// （#226 / #230 / #231 / #232 …）都会动到被盘点的代码，但文档里的命中总数、
// 分类计数和 `文件:行` 不会自己跟着改。没有检测，失真只能靠人偶然发现。
//
// 做法：真的跑四个 audit 模块（不抄一份数字进测试），解析文档里机器可读的部分，
// 逐项比对：
//   1. 四份文档都写了「快照基准 commit + 采集时间」，且指向同一个 commit；
//   2. 扫描范围、命中总数、分类计数、按 API / 按特性的计数表与复算一致；
//   3. 明细表第一列引用的每一个 `文件:行` 都在该行真有对应命中（行号漂移直接红）；
//   4. behavior 盘点表的行数与处置/风险分布自洽，且四条假设结论仍是「成立」。
//
// 文档里的判定（「已修」「可接受降级」这类人的判断）不在本测试的断言范围：
// 测试只钉「数字是算出来的、行号是真的」，不代替人去下结论。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditApiAssumptions, summarize as summarizeApi } from '../../scripts/lib/apiAssumptionAudit.mjs'
import { isVendored } from '../../scripts/lib/vendoredPaths.mjs'
import { auditCssAssumptions, collectSources } from '../../scripts/lib/cssAssumptionAudit.mjs'
import { auditHostCapabilities } from '../../scripts/lib/hostCapabilityAudit.mjs'
import { auditBehaviorAssumptions, VERDICT as BEHAVIOR_VERDICT } from '../../scripts/lib/behaviorAssumptionAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DOCS = path.join(ROOT, 'docs', 'capabilities')
const SRC = path.join(ROOT, 'src')

const posix = (p) => p.split(path.sep).join('/')

/** 递归收集 `src/**` 下所有文件（绝对路径）。 */
const walk = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// vendored 第三方目录不进本盘点（#417）：它与能力快照的「我们自己的代码」口径无关，
// 名单与理由见 scripts/lib/vendoredPaths.mjs / src/services/memory/README.md。
const ALL_SRC = walk(SRC).filter((p) => !isVendored(p))
const SRC_REL = ALL_SRC.map((p) => posix(path.relative(ROOT, p)))

// ---------------------------------------------------------------- 实时复算

const API_RAW = auditApiAssumptions(
  ALL_SRC.map((p) => ({ path: posix(path.relative(ROOT, p)), text: fs.readFileSync(p, 'utf8') })),
)
const API = summarizeApi(API_RAW)

const CSS_RESULT = auditCssAssumptions(collectSources(SRC))
const CSS = CSS_RESULT.summary
const CSS_HIT_LINES = new Set(CSS_RESULT.hits.map((h) => `${h.file}:${h.line}`))

// host 的口径只覆盖 `.ts / .tsx / .html`，与文档 §0 的扫描范围一致
const HOST_SCOPE = SRC_REL.filter((p) => /\.(ts|tsx|html)$/.test(p))
const HOST_RESULT = auditHostCapabilities(
  HOST_SCOPE.map((p) => ({ file: p, text: fs.readFileSync(path.join(ROOT, p), 'utf8') })),
)
const HOST = HOST_RESULT.summary
const HOST_HIT_LINES = new Set(HOST_RESULT.hits.map((h) => `${h.file}:${h.line}`))

const BEHAVIOR_MEASUREMENTS = fs
  .readdirSync(path.join(ROOT, 'docs', 'ui', '209-behavior'))
  .filter((f) => /^before-wv83-\d+\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ui', '209-behavior', f), 'utf8')))
const BEHAVIOR = auditBehaviorAssumptions(BEHAVIOR_MEASUREMENTS)

// ---------------------------------------------------------------- 解析工具

const doc = (name) => fs.readFileSync(path.join(DOCS, name), 'utf8')
const docLines = (name) => doc(name).split(/\r?\n/)

/**
 * 拆表格行。转义竖线 `\|`（`overflow: auto\|scroll` 这类）不当作分隔符。
 */
const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.replace(/\\\|/g, '|').trim())

/** 去掉强调与行内代码，方便按文字定位。 */
const plain = (cell) => cell.replace(/\*\*/g, '').replace(/`/g, '').trim()

const numbers = (text) => (text.match(/\d+/g) ?? []).map(Number)

/**
 * 取紧跟在某个表头后面的一张表。
 * @param {string[]} lines 文档按行拆开
 * @param {(header: string) => boolean} match 表头判定
 * @param {string} what 人读的描述，失败时用
 */
const table = (lines, match, what) => {
  const start = lines.findIndex((l) => l.startsWith('|') && match(l))
  assert.ok(start >= 0, `${what}：没找到表头`)
  const rows = []
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) rows.push(cells(lines[i]))
  assert.ok(rows.length > 0, `${what}：表格没有数据行`)
  return rows
}

/** 取某个 `### 2.x` 小节的行区间（到下一个 `### ` 或 `## ` 为止）。 */
const section = (lines, heading) => {
  const start = lines.findIndex((l) => l.startsWith('### ') && l.includes(heading))
  assert.ok(start >= 0, `没找到小节：${heading}`)
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('### ') && !lines[end].startsWith('## ')) end += 1
  return lines.slice(start, end)
}

/**
 * 从一段里取出所有表格行第一列引用的 `文件:行`（支持 `a.css:28,100` 这种行列表）。
 *
 * 一个小节里可能有多张表：现行表照查，表头里写明「修前 / 修复前 / 修后」的**历史快照表按设计跳过** ——
 * 它们保留旧行号是为了让人看见「当年长什么样」，拿它去对实时复算只会逼着下一个人把历史抹掉。
 */
const refsInFirstColumn = (lines) => {
  const refs = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].startsWith('|') || !lines[i + 1].startsWith('|')) continue
    if (!lines[i].includes('文件:行') && !lines[i].includes('位置')) continue
    const historical = /修前|修复前|修后/.test(plain(cells(lines[i])[0]))
    let j = i + 2
    for (; j < lines.length && lines[j].startsWith('|'); j += 1) {
      if (historical) continue
      // 删除线里的引用是「曾存在、现已删除」的记录（与 `scripts/check-doc-refs.mjs` 同一口径），
      // 不参与「该行真有命中」的断言 —— 文件都没了，自然没有命中行。
      const cell = plain(cells(lines[j])[0]).replace(/~~[^~]*~~/g, '')
      // #681：这里的正则曾写成 `([d,s]+)`（转义丢了），于是**一条引用都没匹配到**，
      // 这条断言看起来在守 §2 整张表，实际什么都没验 —— 同 #678 的「静默跳过」是同一类病。
      // 修好后 §2.1 / §2.5 / §2.6 / §2.7 / §2.8 的每个 `文件:行` 都必须落在实时命中集里。
      for (const m of cell.matchAll(/([A-Za-z0-9_@./-]+\.(?:css|ts|tsx|html)):([\d,]+)/g)) {
        for (const line of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
          refs.push(`${m[1]}:${line}`)
        }
      }
    }
    i = j - 1
  }
  return refs
}

// ---------------------------------------------------------------- 1. 快照基准

test('四份盘点文档都写了快照基准 commit 与采集时间', () => {
  const shas = new Map()
  for (const name of ['api.md', 'css.md', 'host.md', 'behavior.md']) {
    const text = doc(name)
    const sha = text.match(/快照基准：`([0-9a-f]{7,40})`/)
    assert.ok(sha, `${name} 缺「快照基准：\`<merge sha>\`」抬头`)
    const at = text.match(/采集时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)
    assert.ok(at, `${name} 缺「采集时间：<YYYY-MM-DD HH:MM>」抬头`)
    shas.set(name, sha[1])
  }
  const distinct = new Set(shas.values())
  assert.equal(distinct.size, 1, `四份文档指向了不同的基准 commit：${JSON.stringify([...shas])}`)
})

// ---------------------------------------------------------------- 2. api.md

test('api.md 的扫描范围与统计表与实时复算一致', () => {
  const lines = docLines('api.md')

  const scopeLine = lines.find((l) => l.includes('扫描范围'))
  assert.ok(scopeLine, 'api.md 缺「扫描范围」行')
  const byExt = (ext) => SRC_REL.filter((p) => path.extname(p).toLowerCase() === ext).length
  assert.deepEqual(
    numbers(scopeLine),
    [SRC_REL.length, byExt('.ts'), byExt('.tsx'), byExt('.css'), byExt('.html'), byExt('.md')],
    'api.md 扫描范围的文件数与实时清点不一致',
  )

  assert.equal(API.filesScanned, SRC_REL.length, 'api 审计的扫描文件数变了，文档口径要跟着改')

  const summaryRows = table(lines, (l) => l.includes('含义') && l.includes('命中数'), 'api.md §一 统计表')
  const rowOf = (needle) => {
    const row = summaryRows.find((r) => plain(r[0]).includes(needle))
    assert.ok(row, `api.md §一 缺 ${needle} 行`)
    return row
  }
  assert.deepEqual(numbers(rowOf('entry-polyfill')[2]), [API.byVerdict['entry-polyfill']], 'entry-polyfill 命中数不一致')
  assert.deepEqual(numbers(rowOf('baseline')[2]), [API.byVerdict.baseline], 'baseline 命中数不一致')
  assert.deepEqual(numbers(rowOf('uncovered')[2]), [API.byVerdict.uncovered], 'uncovered 命中数不一致')
  assert.deepEqual(numbers(rowOf('合计')[2]), [API.total], 'api.md §一 合计不一致')
})

test('api.md 的按 API 分项表覆盖全部命中的 API 且计数一致', () => {
  const lines = docLines('api.md')
  const rows = table(lines, (l) => l.includes('首次支持') && l.includes('命中'), 'api.md §三 API 表')

  const live = new Map(API.byApi.map((b) => [b.api, b]))
  const documented = new Set()

  for (const row of rows) {
    // 先按整格原文匹配（`Array.prototype.at / String.prototype.at` 本身就是一个 API 键），
    // 再退回按 `/` 拆开求和（一行合并多个 API 的写法）
    const whole = plain(row[0])
    const labels = live.has(whole) ? [whole] : whole.split('/').map((s) => s.trim()).filter(Boolean)
    const matched = labels.map((label) => live.get(label) ?? null)
    // `Array.prototype.at / String.prototype.at` 这种一行合并多个 API 的写法
    const known = matched.filter(Boolean)
    if (known.length === 0) {
      assert.deepEqual(numbers(row[2]), [0], `api.md §三「${plain(row[0])}」记了非 0 命中，但复算为 0`)
      continue
    }
    const count = known.reduce((sum, b) => sum + b.count, 0)
    const files = new Set(known.flatMap((b) => b.files))
    assert.equal(numbers(row[2])[0], count, `api.md §三「${plain(row[0])}」的命中数与复算不一致`)
    assert.equal(numbers(row[3])[0], files.size, `api.md §三「${plain(row[0])}」的涉及文件数与复算不一致`)
    for (const b of known) documented.add(b.api)
  }

  const missing = [...live.keys()].filter((api) => !documented.has(api))
  assert.deepEqual(missing, [], `api.md §三 漏记了这些 API：${missing.join('、')}`)
})

test('api.md 逐条命中表的行数与每个 文件:行 都对得上复算', () => {
  const lines = docLines('api.md')

  const heading = lines.find((l) => l.includes('逐条命中'))
  assert.ok(heading, 'api.md 缺「逐条命中」小节')
  assert.equal(numbers(heading)[0], API.total, 'api.md 逐条命中标题里的处数与复算不一致')

  const rows = table(lines, (l) => l.startsWith('|') && l.includes('假设内容') && l.includes('类别'), 'api.md §二 明细表')
  assert.equal(rows.length, API.total, 'api.md §二 明细表的行数与命中总数不一致')

  const live = new Set(API_RAW.hits.map((h) => `${h.file}:${h.line}`))
  for (const row of rows) {
    const ref = plain(row[0])
    assert.match(ref, /^src\/.+,?\d/, `api.md §二 第一列不是 \`文件:行\`：${ref}`)
    for (const line of ref.slice(ref.lastIndexOf(':') + 1).split(',')) {
      const key = `${ref.slice(0, ref.lastIndexOf(':'))}:${line.trim()}`
      assert.ok(live.has(key), `api.md §二 记了 ${key}，但复算在该行没有命中`)
    }
  }
})

// ---------------------------------------------------------------- 3. css.md

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
  ['CSS min() / max()', 'min()/max()'],
  ['@container', '@container'],
  ['container-type', 'container-type'],
])

test('css.md 的扫描范围、命中总数与逐特性统计与实时复算一致', () => {
  const lines = docLines('css.md')

  const scopeLine = lines.find((l) => l.includes('扫描范围'))
  assert.ok(scopeLine, 'css.md 缺「扫描范围」行')
  const cssFiles = SRC_REL.filter((p) => p.endsWith('.css'))
  const moduleFiles = cssFiles.filter((p) => p.endsWith('.module.css'))
  assert.deepEqual(
    numbers(scopeLine),
    [CSS.files, cssFiles.length, moduleFiles.length, CSS.files - cssFiles.length],
    'css.md 扫描范围的文件数与实时清点不一致',
  )
  assert.equal(CSS.files, SRC_REL.filter((p) => /\.(css|ts|tsx|html)$/.test(p)).length, 'collectSources 的扫描范围变了')

  const totalLine = lines.find((l) => l.includes('命中总数'))
  assert.ok(totalLine, 'css.md 缺「命中总数」行')
  assert.deepEqual(numbers(totalLine), [CSS.hits, CSS.filesWithHits], 'css.md 命中总数 / 分布文件数与复算不一致')

  const rows = table(lines, (l) => l.includes('首支持 Chromium') && l.includes('命中'), 'css.md §1 逐特性表')
  for (const row of rows) {
    const label = plain(row[0])
    if (label === '合计') {
      assert.deepEqual(
        numbers(row.slice(2, 8).join(' ')),
        [CSS.hits, CSS.byVerdict.covered, CSS.byVerdict['no-risk'], CSS.byVerdict.degraded, CSS.byVerdict.defect, CSS.falsePositives.length],
        'css.md §1 合计行（命中/兜底/无风险/可降级/缺陷/假阳性）与复算不一致',
      )
      continue
    }
    const feature = label.startsWith('@supports 块') ? '@supports' : CSS_LABEL_TO_FEATURE.get(label)
    if (!feature) {
      assert.deepEqual(numbers(row[2]), [0], `css.md §1「${label}」记了非 0 命中，但复算抓不到该特性`)
      continue
    }
    const live = CSS.byFeature[feature]
    assert.deepEqual(numbers(row[2]), [live ? live.count : 0], `css.md §1「${label}」命中数与复算不一致`)
    if (live) {
      assert.equal(numbers(row[2])[0], live.count)
      assert.deepEqual(
        numbers(row.slice(3, 8).join(' ')),
        [live.covered, live.noRisk, live.degraded, live.defect, live.falsePositive],
        `css.md §1「${label}」的分类计数与复算不一致`,
      )
    }
  }
})

test('css.md 明细小节里的每一个 文件:行 都在该行真有命中', () => {
  const lines = docLines('css.md')
  // §2.2 是 `:has()` 清零前的历史快照，按设计保留旧行号，不进本断言
  for (const heading of ['2.1', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8']) {
    const block = section(lines, heading)
    for (const ref of refsInFirstColumn(block)) {
      assert.ok(CSS_HIT_LINES.has(ref), `css.md §${heading} 记了 ${ref}，但复算在该行没有命中`)
    }
  }
})

test('css.md 的假阳性清单与复算的 falsePositives 一致', () => {
  const lines = docLines('css.md')
  const rows = table(lines, (l) => l.includes('探测形式') && l.includes('为什么是假阳性'), 'css.md §3 假阳性表')
  const live = CSS.falsePositives.length
  const current = rows.filter((r) => !plain(r[2]).includes('历史类'))
  assert.equal(current.length, live, `css.md §3 列出了 ${current.length} 条「当前」假阳性，复算是 ${live} 条`)
  if (live === 0) {
    assert.ok(
      lines.some((l) => l.includes('当前假阳性 0 条')),
      'css.md §3 复算为 0 条时，正文必须显式写明「当前假阳性 0 条」，不能只靠删表表达',
    )
  }
})

// ---------------------------------------------------------------- 4. host.md

test('host.md 的扫描范围、命中总数与风险分布与实时复算一致', () => {
  const lines = docLines('host.md')

  const scopeLine = lines.find((l) => l.includes('扫描范围'))
  assert.ok(scopeLine, 'host.md 缺「扫描范围」行')
  assert.deepEqual(numbers(scopeLine), [HOST.files], 'host.md 扫描范围的文件数与复算不一致')

  const totalLine = lines.find((l) => l.includes('总计') && l.includes('条命中'))
  assert.ok(totalLine, 'host.md 缺「总计 … 条命中」行')
  assert.deepEqual(
    numbers(totalLine),
    [HOST.total, HOST.byVerdict['已有兜底'], HOST.byVerdict['无风险'], HOST.byVerdict['真实漏洞'], HOST.byVerdict['需动态验证'], HOST.byRisk['高'], HOST.byRisk['中'], HOST.byRisk['低']],
    'host.md 总计 / verdict 分布 / 风险分布与复算不一致',
  )
})

test('host.md 的按能力统计表覆盖全部能力且计数一致', () => {
  const lines = docLines('host.md')
  const rows = table(lines, (l) => l.includes('能力') && l.includes('需动态验证'), 'host.md 各能力命中数表')

  const live = new Map(HOST.byCapability.map((c) => [c.capability, c]))
  const documented = new Set()

  for (const row of rows) {
    const capability = plain(row[0])
    const stat = live.get(capability)
    assert.ok(stat, `host.md 记了「${capability}」，但复算抓不到这个能力`)
    assert.deepEqual(
      numbers(row.slice(1, 6).join(' ')),
      [stat.total, stat.verdicts['已有兜底'], stat.verdicts['无风险'], stat.verdicts['真实漏洞'], stat.verdicts['需动态验证']],
      `host.md「${capability}」的命中 / 分类计数与复算不一致`,
    )
    documented.add(capability)
  }

  const missing = [...live.keys()].filter((c) => !documented.has(c))
  assert.deepEqual(missing, [], `host.md 能力表漏记了：${missing.join('、')}`)
})

test('host.md 的「0 命中清单」确实全是 0 命中', () => {
  const lines = docLines('host.md')
  const start = lines.findIndex((l) => l.includes('0 命中清单'))
  assert.ok(start >= 0, 'host.md 缺「0 命中清单」小节')
  const live = new Set(HOST.byCapability.map((c) => c.capability))
  const rows = table(
    lines.slice(start),
    (l) => l.startsWith('|') && l.includes('能力') && !l.includes('需动态验证'),
    'host.md 0 命中清单表',
  )
  for (const row of rows) {
    const capability = plain(row[0])
    assert.ok(!live.has(capability), `host.md 把「${capability}」列进 0 命中清单，但复算有命中`)
  }
})

// ---------------------------------------------------------------- 5. behavior.md

test('behavior.md 盘点表的行数与处置 / 风险分布自洽，且与合计行一致', () => {
  const lines = docLines('behavior.md')
  const rows = table(lines, (l) => l.includes('假设内容') && l.includes('处置'), 'behavior.md 盘点表')

  const tally = (index) => {
    const out = new Map()
    for (const row of rows) {
      const key = plain(row[index])
      out.set(key, (out.get(key) ?? 0) + 1)
    }
    return out
  }
  const disposition = tally(4)
  const risk = tally(3)

  const totalLine = lines.find((l) => l.includes('合计') && l.includes('行：'))
  assert.ok(totalLine, 'behavior.md 缺「合计 N 行：…」行')
  assert.deepEqual(
    numbers(totalLine),
    [
      rows.length,
      disposition.get('已有兜底') ?? 0,
      disposition.get('需动态验证') ?? 0,
      disposition.get('需探测') ?? 0,
      disposition.get('拆单') ?? 0,
      risk.get('高') ?? 0,
      risk.get('中') ?? 0,
      risk.get('低') ?? 0,
    ],
    'behavior.md 合计行的行数与表内实际分布不一致（表有几行、各处置几行，必须与合计行对得上）',
  )

  const probeLine = lines.find((l) => l.includes('行里有') && l.includes('需探测'))
  assert.ok(probeLine, 'behavior.md 缺「N 行里有 M 行『需探测』」一句')
  assert.deepEqual(
    numbers(probeLine),
    [rows.length, disposition.get('需探测') ?? 0],
    'behavior.md「N 行里有 M 行需探测」与表内实际不一致',
  )
})

test('behavior.md 的四条假设结论仍是复算的「成立」', () => {
  assert.equal(BEHAVIOR.summary.assumptionCount, 4, '行为假设的条数变了，文档结论段要跟着改')

  const body = doc('behavior.md')
  const holds = BEHAVIOR.findings.filter((f) => f.verdict === BEHAVIOR_VERDICT.holds).length
  assert.equal(holds, BEHAVIOR.summary.holds)
  if (BEHAVIOR.summary.falsified === 0) {
    assert.ok(
      body.includes('没有一条假设被实测证伪'),
      '复算没有证伪任何假设，文档结论段必须明确写出这一句',
    )
  }
  for (const finding of BEHAVIOR.findings) {
    assert.ok(body.includes(finding.assumption), `behavior.md 缺假设「${finding.assumption}」的结论`)
  }
})
