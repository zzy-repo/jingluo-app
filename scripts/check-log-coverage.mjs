#!/usr/bin/env node
/**
 * check-log-coverage.mjs —— 诊断埋点的「覆盖面门禁」（母单 #301 / 维度 9）。
 *
 * 为什么要有它：`EventKind` 是一个 21 项的联合类型，#301 盘点发现的问题都不是「写错」，而是
 * 「没写」——枚举里躺着一个从来没有调用点的 kind、关键链路（更新 / 支付 / i18n 缺失）一条日志
 * 都没有、新加的埋点只有一句人话 meta 是空的。这些都不会让编译或单测失败，只会在用户反馈
 * 「日志太笼统」时暴露，而那时已经付过一次排查成本。这个脚本把三件事变成一条命令：
 *
 *   1. R1 死枚举：`EventKind` 里每个 kind 必须有调用点；其中「业务侧应该主动写」的那批
 *      （BUSINESS_KINDS）必须有 `src/services/diagnostics/` **之外**的调用点，否则等于死枚举。
 *   2. R2 关键链路：CRITICAL_PATHS 里列的每条链路必须在代码里有对应埋点（缺就 FAIL）。
 *      已登记、尚未补的缺口写在 `scripts/log-coverage-baseline.json` 的 `knownGaps` 里，
 *      默认只报「已知缺口（#issue）」不阻断（否则脚本一落地就是红的，没人能合）；
 *      `--strict` 下变成 FAIL —— 子单做完后把它从 knownGaps 删掉即自动转严格。
 *   3. R3 meta 贫瘠：除生命周期类（LIFECYCLE_OK）外，每条埋点的 meta 至少要 MIN_META_KEYS 个键。
 *      存量违反项登记在基线 `metaDebt` 里，**只能减不能增**：基线里有、代码里已修 → FAIL，
 *      逼着人删登记，登记簿不会烂在仓库里。
 *
 * 判定口径（静态扫描，不跑应用）：
 *   - 只看 `src/**` 里对 `record` / `recordEvent` / `recordAction` / `recordError` /
 *     `recordUserAction` / `captureStateSnapshot` 的调用，注释与字符串先被抹掉再扫，注释里的
 *     示例代码不算调用点；
 *   - kind 从**字面量实参**取（`recordError` 恒为 error，`recordUserAction` 恒为 nav，
 *     `captureStateSnapshot` 恒为 state_snapshot，三元里的两个分支都算）；
 *   - meta 键数按最外层对象字面量的键算，`{...spread}` 记 1 个键；实参是标识符 / 函数调用
 *     （如 `errorBoundaryMeta(...)`）时无法静态计数，按「非空」放过（宁漏不误报）。
 *
 * 用法：
 *   node scripts/check-log-coverage.mjs            # 门禁模式（已知缺口只告警）
 *   node scripts/check-log-coverage.mjs --strict   # 严格模式（已知缺口也 FAIL，子单收口后用）
 *   node scripts/check-log-coverage.mjs --selftest # 负向自检：三个反例都必须被拦住
 *   pnpm run check:log-coverage
 *
 * 退出码：
 *   0  干净（或只剩已登记的已知缺口）
 *   1  发现未登记的违规（死枚举 / 关键链路缺埋点 / 新增空 meta / 基线失效）
 *   2  用法 / 环境错误（找不到 types.ts、EventKind 解析为空）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TYPES_FILE = 'src/services/diagnostics/types.ts'
const COLLECTOR_DIR = 'src/services/diagnostics/'
const BASELINE_FILE = 'scripts/log-coverage-baseline.json'

/** meta 至少要有几个键：1 个键等于「一句话 + 一个注脚」，切不出维度，见 #301 表 3 */
const MIN_META_KEYS = 2

/**
 * 允许 meta 很少的 kind：生命周期与采集层自产事件。
 * 它们回答的是「什么时候发生」，没有业务维度可切；强行加字段只会灌水（母单「禁止假细化」）。
 */
const LIFECYCLE_OK = new Set([
  'app_launch',
  'app_pause',
  'app_resume',
  'state_snapshot',
  'longtask',
  'ui_rendered',
])

/**
 * 必须由**业务代码**主动写的 kind（采集层 hook 写不出来）。
 * 这类 kind 只有采集层内部的调用点 = 死枚举：业务侧没有任何时机在写它。
 */
const BUSINESS_KINDS = new Set([
  'nav',
  'config_change',
  'chat_send',
  'chat_first_token',
  'chat_done',
  'chat_abort',
  'import_start',
  'import_stage',
  'import_done',
  'import_error',
])

/**
 * 关键链路清单（#301 维度 1 的缺口清单落成可执行判定）。
 * `files` 里出现 `*` 结尾表示目录前缀；`minKindCalls` 是最少要有的埋点数；
 * `requireMeta` 是必须出现的 meta 键（证明埋点带够定位信息，不是又一句人话）。
 */
const CRITICAL_PATHS = [
  {
    id: 'update-check',
    label: '更新检查 → 下载 → 安装（updateManifest / appUpdate / AppUpdateField）',
    files: [
      'src/services/updateManifest.ts',
      'src/services/appUpdate.ts',
      'src/components/settings/AppUpdateField.tsx',
    ],
    minKindCalls: 3,
    issue: '#311',
  },
  {
    id: 'payment-chain',
    label: '支付 / 额度 / 卡密 / 购买记录（src/services/ours/**）',
    files: ['src/services/ours/'],
    minKindCalls: 4,
    issue: '#312',
  },
  {
    id: 'attachment-upload',
    label: '附件上传：开始与失败各一个点（attachments.ts）',
    files: ['src/services/attachments.ts'],
    minKindCalls: 2,
    issue: '#313',
  },
  {
    id: 'i18n-missing-key',
    label: 'i18n 缺 key 的兜底与上报（i18n/index.ts）',
    files: ['src/i18n/index.ts'],
    minKindCalls: 1,
    issue: '#314',
  },
  {
    id: 'url-import-done',
    label: 'URL 导入成功要有结论日志（import_done）',
    files: ['src/services/chat/history/urlImport.ts'],
    minKindCalls: 1,
    kinds: ['import_done'],
    issue: '#313',
  },
  {
    id: 'chat-first-token',
    label: '发送 → 首字耗时（chat_first_token + durationMs）',
    files: ['src/services/chat/store.ts'],
    minKindCalls: 1,
    kinds: ['chat_first_token'],
    requireMeta: ['durationMs'],
  },
  {
    id: 'render-boundary',
    label: '渲染错误兜底（ErrorBoundary → recordError）',
    files: ['src/app/ErrorBoundary.tsx'],
    minKindCalls: 1,
    kinds: ['error'],
  },
]

// ---------------------------------------------------------------- 源码扫描

/** 把注释抹成空格（保留长度与换行，注释里的示例调用不会被当成调用点） */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (match, head) => head + ' '.repeat(match.length - head.length))

const walk = (dir, out = []) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(item.name) && !item.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const toRel = (full) => path.relative(ROOT, full).split(path.sep).join('/')

/** 从 openIndex（指向 `(`）开始，按括号配平取出实参文本与结束位置 */
const readCallArgs = (source, openIndex) => {
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        return { text: source.slice(openIndex + 1, index), end: index }
      }
    }
  }
  return { text: source.slice(openIndex + 1), end: source.length }
}

/** 顶层逗号切分（字符串 / 模板 / 嵌套括号内的逗号不切） */
const splitTopLevel = (text) => {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      current += char
      if (char === '\\') {
        current += text[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const STRING_LITERAL = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\$]*)`/g

const literalsIn = (text) => {
  const found = []
  for (const match of text.matchAll(STRING_LITERAL)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return found
}

const firstLiteral = (text) => literalsIn(text)[0]

/** meta 实参 → 键数；无法静态计数返回 null（按非空放过） */
const countMetaKeys = (arg) => {
  if (arg === undefined) return 0
  const text = arg.trim()
  if (text === '' || /^\{\s*\}$/.test(text)) return 0
  if (!text.startsWith('{')) return null
  const inner = text.replace(/^\{/, '').replace(/\}$/, '')
  let keys = 0
  for (const part of splitTopLevel(inner)) {
    if (part === '') continue
    if (part.startsWith('...')) keys += 1
    else if (/^[A-Za-z_$][\w$]*\s*:/.test(part) || /^'[^']*'\s*:/.test(part)) keys += 1
    else keys += 1
  }
  return keys
}

/** 名字 → (kind 取法, label 取法, meta 取法) 的实参下标（或固定值） */
const CALL_SHAPES = {
  record: { kindArg: 0, labelArg: 2, metaArg: 3 },
  recordEvent: { kindArg: 0, labelArg: 1, metaArg: 2 },
  recordAction: { kindArg: 0, labelArg: 1, metaArg: 2 },
  recordUserAction: { kind: 'nav', labelArg: 0, metaArg: 1 },
  recordError: { kind: 'error', labelArg: 0, metaArg: 1 },
  captureStateSnapshot: { kind: 'state_snapshot', labelArg: 0, metaArg: 1 },
}

const scanCallSites = (files, kindSet) => {
  const sites = []
  for (const full of files) {
    const rel = toRel(full)
    const source = stripComments(fs.readFileSync(full, 'utf8'))
    const pattern = /\b(record|recordEvent|recordAction|recordUserAction|recordError|captureStateSnapshot)\s*\(/g
    for (const match of source.matchAll(pattern)) {
      // 方法调用（obj.record(...)）不算：只有紧邻的 `.` 才排除。
      // 注意不能宽判「前面是标识符」——`const ok = response.ok` 换行后的 record( 会被误伤（真踩过）。
      const before = source.slice(Math.max(0, match.index - 40), match.index)
      if (/\.\s*$/.test(before)) continue
      const name = match[1]
      const shape = CALL_SHAPES[name]
      const openIndex = match.index + match[0].length - 1
      const { text } = readCallArgs(source, openIndex)
      const args = splitTopLevel(text)
      const kinds = shape.kind
        ? [shape.kind]
        : [
            ...new Set(
              literalsIn(args[shape.kindArg] ?? '').filter((item) => kindSet.has(item))
            ),
          ]
      const label = (firstLiteral(args[shape.labelArg] ?? '') ?? '').replace(/\s+/g, ' ').trim()
      const metaKeys = countMetaKeys(args[shape.metaArg])
      for (const kind of kinds) {
        sites.push({ file: rel, line: source.slice(0, match.index).split('\n').length, kind, label, metaKeys })
      }
    }
  }
  // 组内序号：`文件::kind::标签` 相同的第 n 条。基线登记用它，既不用行号（会漂移），
  // 也不会把同组里新增的一条无差别豁免掉。
  const counters = new Map()
  for (const site of sites) {
    const group = `${site.file}::${site.kind}::${site.label}`
    const index = (counters.get(group) ?? 0) + 1
    counters.set(group, index)
    site.key = `${group}#${index}`
  }
  return sites
}

/** 从 types.ts 抽出 EventKind 联合类型的所有成员 */
const readEventKinds = () => {
  const full = path.join(ROOT, TYPES_FILE)
  if (!fs.existsSync(full)) {
    console.error(`✗ 找不到 ${TYPES_FILE}`)
    process.exit(2)
  }
  const source = fs.readFileSync(full, 'utf8')
  const block = /export type EventKind\s*=([\s\S]*?)\n\n/.exec(source)
  if (!block) {
    console.error('✗ EventKind 联合类型解析失败（types.ts 结构变了？）')
    process.exit(2)
  }
  const kinds = literalsIn(block[1]).filter((item) => /^[a-z][a-z0-9_]*$/.test(item))
  if (kinds.length === 0) {
    console.error('✗ EventKind 解析为空')
    process.exit(2)
  }
  return [...new Set(kinds)]
}

// ---------------------------------------------------------------- 判定

const readBaseline = () => {
  const full = path.join(ROOT, BASELINE_FILE)
  if (!fs.existsSync(full)) {
    return { knownGaps: [], metaDebt: [] }
  }
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
  return { knownGaps: parsed.knownGaps ?? [], metaDebt: parsed.metaDebt ?? [] }
}

const checkDeadKinds = (kinds, sites, failures) => {
  const usedEverywhere = new Set(sites.map((site) => site.kind))
  const usedByBusiness = new Set(
    sites.filter((site) => !site.file.startsWith(COLLECTOR_DIR)).map((site) => site.kind)
  )
  for (const kind of kinds) {
    if (!usedEverywhere.has(kind)) {
      failures.push({
        rule: 'R1 死枚举',
        detail: `EventKind 里的 ${kind} 没有任何调用点（采集层也没有）`,
        fix: '要么补调用点，要么从 types.ts 删掉这个 kind',
      })
      continue
    }
    if (BUSINESS_KINDS.has(kind) && !usedByBusiness.has(kind)) {
      failures.push({
        rule: 'R1 死枚举',
        detail: `EventKind 里的 ${kind} 只有采集层内部调用点，业务侧从不主动写`,
        fix: `补业务侧调用点，或把 ${kind} 从 BUSINESS_KINDS（scripts/check-log-coverage.mjs）里删掉`,
      })
    }
  }
}

const matchPath = (site, entry) =>
  entry.files.some((item) =>
    item.endsWith('/') ? site.file.startsWith(item) : site.file === item
  )

const checkCriticalPaths = (sites, baseline, strict, failures, known) => {
  for (const entry of CRITICAL_PATHS) {
    const hits = sites.filter(
      (site) => matchPath(site, entry) && (!entry.kinds || entry.kinds.includes(site.kind))
    )
    const metaOk = (entry.requireMeta ?? []).every((key) =>
      // requireMeta 只能证明「埋点里有这个键」，静态扫描拿不到具体键名以外的信息，
      // 所以这里退一步：要求该链路至少有一个调用点带了非空 meta（键名靠 review 兜）
      hits.some((site) => (site.metaKeys ?? 0) >= MIN_META_KEYS)
    )
    const passed = hits.length >= entry.minKindCalls && metaOk
    if (passed) continue
    const detail =
      `关键链路缺埋点：${entry.label}（要求 ≥${entry.minKindCalls} 处，实际 ${hits.length} 处` +
      `${metaOk ? '' : '，且没有带够 meta 的埋点'}）`
    if (entry.issue && baseline.knownGaps.includes(entry.id) && !strict) {
      known.push({ rule: 'R2 关键链路', detail, issue: entry.issue })
    } else {
      failures.push({
        rule: 'R2 关键链路',
        detail,
        fix: entry.issue ? `见 ${entry.issue}；补完后从 ${BASELINE_FILE} 的 knownGaps 删掉 ${entry.id}` : '补埋点',
      })
    }
  }
  // 基线失效：登记了却已经不再违规 → 逼着删登记
  for (const id of baseline.knownGaps) {
    const entry = CRITICAL_PATHS.find((item) => item.id === id)
    if (!entry) {
      failures.push({
        rule: 'R2 基线失效',
        detail: `基线里的 ${id} 已不存在于 CRITICAL_PATHS`,
        fix: `从 ${BASELINE_FILE} 删掉 ${id}`,
      })
      continue
    }
    const hits = sites.filter(
      (site) => matchPath(site, entry) && (!entry.kinds || entry.kinds.includes(site.kind))
    )
    if (hits.length >= entry.minKindCalls) {
      failures.push({
        rule: 'R2 基线失效',
        detail: `${id} 已经补上了埋点，但还留在 ${BASELINE_FILE} 的 knownGaps 里`,
        fix: `从 knownGaps 删掉 ${id}（脚本会自动转严格）`,
      })
    }
  }
}

const checkMeta = (sites, baseline, failures) => {
  const debt = new Set(baseline.metaDebt)
  const seenDebt = new Set()
  for (const site of sites) {
    if (site.metaKeys === null) continue
    if (LIFECYCLE_OK.has(site.kind)) continue
    if (site.metaKeys >= MIN_META_KEYS) continue
    const key = site.key
    if (debt.has(key)) {
      seenDebt.add(key)
      continue
    }
    failures.push({
      rule: 'R3 meta 贫瘠',
      detail: `${site.file}:${site.line} ${site.kind} "${site.label}" 的 meta 只有 ${site.metaKeys} 个键（要求 ≥${MIN_META_KEYS}）`,
      fix: '补 stage / status / durationMs / bytes / reason 这类可切片字段；生命周期类请加进 LIFECYCLE_OK',
    })
  }
  for (const key of debt) {
    if (!seenDebt.has(key)) {
      failures.push({
        rule: 'R3 基线失效',
        detail: `${key} 已不再违反 meta 规则，但还登记在 ${BASELINE_FILE} 的 metaDebt 里`,
        fix: '从 metaDebt 删掉这一行（登记簿只能减）',
      })
    }
  }
}

// ---------------------------------------------------------------- 负向自检

/** 三个反例必须全部被拦住；任一漏过 = 门禁本身失效 */
const SELFTEST_CASES = [
  {
    name: '反例 1：死枚举（kind 声明了但没有任何调用点）',
    run: (failures) => checkDeadKinds(['app_launch', 'chat_first_token'], [], failures),
    expect: /chat_first_token 没有任何调用点/,
  },
  {
    name: '反例 2：关键链路缺埋点（更新检查零埋点）',
    run: (failures, known) =>
      checkCriticalPaths([], { knownGaps: [], metaDebt: [] }, true, failures, known),
    expect: /关键链路缺埋点：更新检查/,
  },
  {
    name: '反例 3：meta 为空（除生命周期类）',
    run: (failures) =>
      checkMeta(
        [{ file: 'src/demo.ts', line: 9, kind: 'chat_send', label: 'send-message', metaKeys: 0 }],
        { knownGaps: [], metaDebt: [] },
        failures
      ),
    expect: /meta 只有 0 个键/,
  },
]

const selftest = () => {
  let bad = 0
  for (const item of SELFTEST_CASES) {
    const failures = []
    const known = []
    item.run(failures, known)
    const texts = failures.map((failure) => `${failure.rule} ${failure.detail}`)
    const hit = texts.some((text) => item.expect.test(text))
    console.log(`  ${hit ? 'ok  ' : '✗   '}${item.name}`)
    console.log(`       输出：${texts[0] ?? '(无)'}`)
    if (!hit) bad += 1
  }
  if (bad > 0) {
    console.error(`\n✗ 自检失败：${bad} 个反例没被拦住，门禁不可信`)
    process.exit(1)
  }
  console.log('\nok  3 个反例全部被拦住')
  process.exit(0)
}

// ---------------------------------------------------------------- main

const strict = process.argv.includes('--strict')
if (process.argv.includes('--selftest')) {
  selftest()
}

const kinds = readEventKinds()
const files = walk(path.join(ROOT, 'src'))
const sites = scanCallSites(files, new Set(kinds))
const baseline = readBaseline()
const failures = []
const known = []

checkDeadKinds(kinds, sites, failures)
checkCriticalPaths(sites, baseline, strict, failures, known)
checkMeta(sites, baseline, failures)

console.log(`log-coverage：EventKind ${kinds.length} 种，调用点 ${sites.length} 处（src/**）`)
const byKind = new Map()
for (const site of sites) {
  byKind.set(site.kind, (byKind.get(site.kind) ?? 0) + 1)
}
console.log(
  `  kind 覆盖：${[...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}×${count}`)
    .join(' ')}`
)
if (process.argv.includes('--list')) {
  for (const site of sites) {
    console.log(`  ·  ${site.file}:${site.line} ${site.kind} "${site.label}" meta=${site.metaKeys} key=${site.key}`)
  }
}
const missing = kinds.filter((kind) => !byKind.has(kind))
console.log(`  未覆盖 kind：${missing.length === 0 ? '无' : missing.join(', ')}`)

for (const item of known) {
  console.log(`  !  已知缺口 ${item.issue}：${item.detail}`)
}

if (failures.length === 0) {
  if (known.length > 0) {
    console.log(`\nok  未发现新增违规；仍有 ${known.length} 条已登记缺口（见 ${BASELINE_FILE}）`)
  } else {
    console.log('\nok  埋点覆盖面门禁通过')
  }
  process.exit(0)
}

console.error(`\n✗ ${failures.length} 项未通过：`)
for (const failure of failures) {
  console.error(`  ✗ [${failure.rule}] ${failure.detail}`)
  console.error(`        处理：${failure.fix}`)
}
process.exit(1)
