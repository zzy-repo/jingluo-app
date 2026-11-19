#!/usr/bin/env node
/**
 * check-test-duplication.mjs —— 测试重复检测门禁（#362 阶段二 / #366 收口）。
 *
 * 为什么要有它：#362 盘点（`docs/testing/coverage/baseline-and-overlap.md` §2）逐条列出了
 * 「同一逻辑被两处断言 = 一处零边际」，其中最贵的是 **L1 在重复测 L0 已覆盖的纯逻辑**（D1~D10），
 * 其次是 90 个文件各抄一份 `.js→.ts` 装配（约 3000 行）。这些只能靠人肉读 diff 发现，
 * 所以退化到「没人看」。这里把**最容易被机械判定**的三类做成断言，让新增的跨层重复当场露头。
 *
 * 只做三条规则（不求语义理解，宁可漏也别误杀）：
 *   R1 逐字相同 ≥N 行（默认 20）—— 行窗口哈希。把每个文件按「trim 后非空行」切片，
 *      连续 N 行做 sha1，同一指纹出现在 ≥2 个文件即为一组；再按行号连续段合并成一个"重复块"。
 *      这类命中基本只有两个来源：抄装配样板、抄整段断言 —— 两个都该削。
 *   R2 断言主题关键词跨层 —— 同一主题（`512 KiB` / `redact` / `幂等` …）同时出现在两层，
 *      是「上层在重测下层」的最强信号（#362 §2.1 的 D1/D3/D6 全是这种形状）。
 *   R3 用例标题跨层同名 —— `test('复制上限按字节判定')` 在 unit 与 integration 各写一遍。
 *
 * 严重级别：
 *   R1 = error（默认 exit 1；`--warn` 不阻塞）
 *   R2 / R3 = warning（`--strict` 才阻塞）—— 关键词/标题重合也可能合理，先暴露再收。
 *
 * 白名单（`tests/test-duplication-whitelist.json`，**必须写理由**）：
 *   允许某些跨层重复长期存在（例如「L1 只有浏览器能验的那一条」与 L0 的纯函数断言天然同题）。
 *   条目形状：{ rule, files?: [...], topic?: string, title?: string, reason, issue }
 *   · R1 组：条目 `files` ⊆ 组内文件（允许少列，但列出的必须都在组里）
 *   · R2/R3：按 `topic` / `title` 匹配
 *   没写 `reason` 的条目视为无效（直接报错），避免白名单变成垃圾桶。
 *
 * 用法：
 *   node scripts/check-test-duplication.mjs              # R1 阻塞，R2/R3 只警告
 *   node scripts/check-test-duplication.mjs --warn        # 只报告，永远 exit 0（CI 前三轮用这个）
 *   node scripts/check-test-duplication.mjs --strict      # 警告也阻塞
 *   node scripts/check-test-duplication.mjs --window 30   # 改逐字重复的行窗口
 *   node scripts/check-test-duplication.mjs --json r.json
 *
 * 退出码：0 通过（或 --warn）/ 1 发现违规 / 2 用法或环境错误
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = path.join(ROOT, 'tests')
const WHITELIST_FILE = path.join(TESTS_DIR, 'test-duplication-whitelist.json')

/** 逐字重复的行窗口：20 行 ≈ 一段完整的 setup 或一组完整断言，低于这个量级噪声太大。 */
const DEFAULT_WINDOW = 20
/** 用例标题跨层比对的最小长度（太短的标题如 "基本流程" 重合无意义）。 */
const MIN_TITLE_LENGTH = 12

/**
 * R2 的断言主题关键词。加新词的门槛：它必须是「一个具体口径」，不是泛词。
 * 每个主题给多个 pattern 是允许的写法差异（`512KiB` / `512 KiB` 是同一件事）。
 */
const KEYWORD_TOPICS = [
  { topic: 'copy-limit-512k', patterns: [/512\s*KiB/i, /524\s*288/], note: '复制上限按 UTF-8 字节判定（#362 D1）' },
  { topic: 'redaction', patterns: [/\bredact(?:ion|ed|s)?\b/i, /脱敏/], note: '日志/导出脱敏口径（#362 D3/D8）' },
  { topic: 'invalid-release', patterns: [/INVALID_RELEASE/], note: '清单 buildType/variant 校验（#362 D-清单）' },
  { topic: 'retention', patterns: [/retention/i], note: '环形缓冲/保留期口径（#362 D8）' },
  { topic: 'idempotent-claim', patterns: [/幂等/, /idempoten/i], note: '领取/兑换幂等重放（#362 D10）' },
  { topic: 'local-only-export', patterns: [/local-only/i], note: '反馈导出不上传语义（#362 D3）' },
]

const LAYER_DIRS = ['unit', 'integration', 'regression', 'e2e', 'device']
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

function usage(message) {
  if (message) console.error(`${message}\n`)
  console.error('用法：node scripts/check-test-duplication.mjs [--warn] [--strict] [--window N] [--json <file>]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { warn: false, strict: false, window: DEFAULT_WINDOW, json: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // npm/pnpm 会把 `--` 原样透传
    if (arg === '--warn') opts.warn = true
    else if (arg === '--strict') opts.strict = true
    else if (arg === '--window') {
      opts.window = Number(argv[++i])
      if (!Number.isSafeInteger(opts.window) || opts.window < 8) usage('--window 必须是 ≥8 的整数')
    } else if (arg === '--json') {
      opts.json = argv[++i]
      if (!opts.json || opts.json.startsWith('--')) usage('--json 需要一个输出路径')
    } else usage(`未知参数：${arg}`)
  }
  return opts
}

/** 收集所有用例文件（tests/{unit,integration,regression,e2e,device}/**\/*.test.mjs） */
async function collectTestFiles() {
  const files = []
  for (const layer of LAYER_DIRS) {
    let entries
    try {
      entries = await readdir(path.join(TESTS_DIR, layer), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path.join(TESTS_DIR, layer, entry.name))
      else if (entry.isDirectory()) {
        for (const nested of await readdir(path.join(TESTS_DIR, layer, entry.name))) {
          if (nested.endsWith('.test.mjs')) files.push(path.join(TESTS_DIR, layer, entry.name, nested))
        }
      }
    }
  }
  return files
}

const layerOf = (relPath) => relPath.split('/')[1]

/** 规则 R1：逐字相同 ≥window 行。返回按「文件组 + 连续行段」合并后的重复块。 */
function findVerbatimGroups(sources, window) {
  /** 指纹 → { files: Set<string>, starts: Map<file, number[]> } */
  const index = new Map()
  for (const [file, text] of sources) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    for (let i = 0; i + window <= lines.length; i++) {
      const digest = createHash('sha1').update(lines.slice(i, i + window).join('\n')).digest('hex')
      let entry = index.get(digest)
      if (!entry) {
        entry = { files: new Set(), starts: new Map(), sample: lines.slice(i, i + 3) }
        index.set(digest, entry)
      }
      entry.files.add(file)
      if (!entry.starts.has(file)) entry.starts.set(file, [])
      entry.starts.get(file).push(i)
    }
  }

  // 按「文件组合」聚合：同一批文件之间的连续窗口合并成一个块（块长 = 窗口 20 + 连续窗口数 - 1）
  const bySignature = new Map()
  for (const entry of index.values()) {
    if (entry.files.size < 2) continue
    const signature = [...entry.files].sort().join('\u0000')
    if (!bySignature.has(signature)) bySignature.set(signature, { files: [...entry.files].sort(), starts: new Map(), sample: entry.sample })
    const bucket = bySignature.get(signature)
    for (const [file, starts] of entry.starts) {
      const list = bucket.starts.get(file) ?? []
      list.push(...starts)
      bucket.starts.set(file, list)
    }
  }

  const groups = []
  for (const bucket of bySignature.values()) {
    const canonical = bucket.files[0]
    const starts = [...new Set(bucket.starts.get(canonical) ?? [])].sort((a, b) => a - b)
    let runStart = starts[0]
    let previous = starts[0]
    const runs = []
    for (const start of starts.slice(1)) {
      if (start === previous + 1) {
        previous = start
        continue
      }
      runs.push([runStart, previous])
      runStart = start
      previous = start
    }
    runs.push([runStart, previous])
    const longest = runs.reduce((max, [a, b]) => Math.max(max, b - a + 1), 0)
    groups.push({
      rule: 'verbatim-window',
      files: bucket.files,
      layers: [...new Set(bucket.files.map(layerOf))].sort(),
      windows: starts.length,
      lines: longest + window - 1,
      blocks: runs.length,
      sample: bucket.sample,
    })
  }
  return groups.sort((a, b) => b.lines * b.files.length - a.lines * a.files.length || b.lines - a.lines)
}

/** 规则 R2：断言主题关键词跨层 */
function findKeywordGroups(sources) {
  const groups = []
  for (const topic of KEYWORD_TOPICS) {
    const hits = []
    for (const [file, text] of sources) {
      if (topic.patterns.some((pattern) => pattern.test(text))) hits.push(file)
    }
    const layers = [...new Set(hits.map(layerOf))].sort()
    if (layers.length < 2) continue
    groups.push({ rule: 'keyword-cross-layer', topic: topic.topic, note: topic.note, files: hits.sort(), layers })
  }
  return groups
}

/** 规则 R3：用例标题跨层同名 */
function findTitleGroups(sources) {
  const byTitle = new Map()
  const titleRe = /\btest\(\s*(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`)/g
  for (const [file, text] of sources) {
    for (const match of text.matchAll(titleRe)) {
      const raw = match[1] ?? match[2] ?? match[3] ?? ''
      const normalized = raw
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .replace(/\d+/g, '#')
      if (normalized.length < MIN_TITLE_LENGTH) continue
      if (!byTitle.has(normalized)) byTitle.set(normalized, { title: raw, files: new Set() })
      byTitle.get(normalized).files.add(file)
    }
  }
  const groups = []
  for (const entry of byTitle.values()) {
    const files = [...entry.files].sort()
    const layers = [...new Set(files.map(layerOf))].sort()
    if (layers.length < 2) continue
    groups.push({ rule: 'duplicate-title-cross-layer', title: entry.title, files, layers })
  }
  return groups
}

async function readWhitelist() {
  let raw
  try {
    raw = await readFile(WHITELIST_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { groups: [], keywords: [], titles: [], entries: [] }
    throw new Error(`白名单 ${rel(WHITELIST_FILE)} 读取失败：${error.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`白名单 ${rel(WHITELIST_FILE)} 不是合法 JSON：${error.message}`)
  }
  const groups = data.groups ?? []
  const keywords = data.keywords ?? []
  const titles = data.titles ?? []
  for (const entry of [...groups, ...keywords, ...titles]) {
    if (!entry.reason || String(entry.reason).trim().length < 4) {
      throw new Error(`白名单条目缺少理由：${JSON.stringify(entry)}（允许跨层重复必须写清为什么）`)
    }
  }
  return { groups, keywords, titles, entries: data }
}

/** R1 组是否被白名单覆盖：条目的 files ⊆ 组内文件 */
function verbatimWhitelisted(group, entries) {
  return entries.find((entry) => {
    if (!Array.isArray(entry.files) || !entry.files.length) return false
    const groupFiles = new Set(group.files)
    return entry.files.every((file) => groupFiles.has(file))
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const files = await collectTestFiles()
  const sources = []
  for (const file of files) sources.push([rel(file), await readFile(file, 'utf8')])
  const whitelist = await readWhitelist()

  const verbatim = findVerbatimGroups(sources, opts.window)
  const keywords = findKeywordGroups(sources)
  const titles = findTitleGroups(sources)

  const skippedVerbatim = []
  const activeVerbatim = []
  for (const group of verbatim) {
    const entry = verbatimWhitelisted(group, whitelist.groups)
    if (entry) skippedVerbatim.push({ group, reason: entry.reason, issue: entry.issue ?? '' })
    else activeVerbatim.push(group)
  }
  const skippedKeywords = keywords.filter((group) => whitelist.keywords.some((entry) => entry.topic === group.topic))
  const activeKeywords = keywords.filter((group) => !whitelist.keywords.some((entry) => entry.topic === group.topic))
  const skippedTitles = titles.filter((group) => whitelist.titles.some((entry) => entry.title === group.title))
  const activeTitles = titles.filter((group) => !whitelist.titles.some((entry) => entry.title === group.title))

  console.log('check:test-duplication —— 测试重复检测（#362 阶段二 / #366）\n')
  console.log(`扫描 ${sources.length} 个用例文件；行窗口 ${opts.window} 行；主题关键词 ${KEYWORD_TOPICS.length} 个\n`)

  const printGroup = (group, tag) => {
    console.log(`${tag} ${group.files.join(' ↔ ')}`)
    if (group.rule === 'verbatim-window') {
      console.log(`   跨 ${group.layers.length} 层（${group.layers.join('/')}），最长连续 ${group.lines} 行、${group.blocks} 个块、${group.windows} 个窗口`)
      console.log(`   片段起头：${group.sample.map((line) => line.slice(0, 70)).join(' ⏎ ')}`)
    } else if (group.rule === 'keyword-cross-layer') {
      console.log(`   主题 ${group.topic} 跨 ${group.layers.join('/')}；${group.note}`)
    } else {
      console.log(`   标题「${group.title}」跨 ${group.layers.join('/')}`)
    }
  }

  if (activeVerbatim.length) {
    console.log(`❌ R1 逐字相同 ≥${opts.window} 行：${activeVerbatim.length} 组`)
    for (const group of activeVerbatim.slice(0, 20)) printGroup(group, ' •')
    if (activeVerbatim.length > 20) console.log(`  …另有 ${activeVerbatim.length - 20} 组，见 --json`)
    console.log('')
  }
  if (activeKeywords.length) {
    console.log(`⚠ R2 断言主题关键词跨层：${activeKeywords.length} 组`)
    for (const group of activeKeywords) printGroup(group, ' •')
    console.log('')
  }
  if (activeTitles.length) {
    console.log(`⚠ R3 用例标题跨层同名：${activeTitles.length} 组`)
    for (const group of activeTitles.slice(0, 15)) printGroup(group, ' •')
    if (activeTitles.length > 15) console.log(`  …另有 ${activeTitles.length - 15} 组，见 --json`)
    console.log('')
  }
  const whitelistedCount = skippedVerbatim.length + skippedKeywords.length + skippedTitles.length
  if (whitelistedCount) {
    console.log(`ℹ 白名单放行 ${whitelistedCount} 组（${rel(WHITELIST_FILE)}）：`)
    for (const item of skippedVerbatim) {
      console.log(`  [R1] ${item.group.files.join(' ↔ ')}\n      ↳ ${item.reason}${item.issue ? `（${item.issue}）` : ''}`)
    }
    for (const group of skippedKeywords) console.log(`  [R2] ${group.topic}\n      ↳ ${whitelist.keywords.find((e) => e.topic === group.topic).reason}`)
    for (const group of skippedTitles) console.log(`  [R3] ${group.title}\n      ↳ ${whitelist.titles.find((e) => e.title === group.title).reason}`)
    console.log('')
  }
  if (!activeVerbatim.length && !activeKeywords.length && !activeTitles.length) {
    console.log(`没有发现未登记的重复 ✅（白名单放行 ${whitelistedCount} 组）`)
  }

  const stats = {
    files: sources.length,
    window: opts.window,
    verbatimGroups: activeVerbatim.length,
    verbatimCrossLayer: activeVerbatim.filter((group) => group.layers.length > 1).length,
    keywordGroups: activeKeywords.length,
    titleGroups: activeTitles.length,
    whitelisted: whitelistedCount,
    topVerbatim: activeVerbatim.slice(0, 10).map((group) => ({ files: group.files, lines: group.lines, layers: group.layers })),
  }
  if (opts.json) {
    await writeFile(path.resolve(opts.json), `${JSON.stringify({ ...stats, groups: { verbatim: activeVerbatim, keywords: activeKeywords, titles: activeTitles } }, null, 2)}\n`)
    console.log(`\nJSON 报告：${opts.json}`)
  }
  console.log(
    `\n合计：逐字重复 ${stats.verbatimGroups} 组（其中跨层 ${stats.verbatimCrossLayer}）`
      + ` / 关键词跨层 ${stats.keywordGroups} / 标题跨层 ${stats.titleGroups} / 白名单放行 ${stats.whitelisted}`,
  )

  const blocking = activeVerbatim.length > 0 || (opts.strict && (activeKeywords.length > 0 || activeTitles.length > 0))
  if (!blocking) {
    console.log('check:test-duplication OK ✅')
    return
  }
  if (opts.warn) {
    console.log('check:test-duplication WARN —— 发现重复，但 --warn 模式不阻塞（CI 前三轮观测用）')
    return
  }
  console.error(
    '\n修法：同一断言只保留一层（纯逻辑留 L0，L1 只留浏览器/时序独有的一条）；'
      + '整段复制的装配样板抽到 tests/helpers/；确需长期共存的写进 tests/test-duplication-whitelist.json 并给理由。'
      + '规则见 scripts/check-test-duplication.mjs 文件头（#362/#366）。',
  )
  process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(`check:test-duplication 环境错误：${error.message}`)
  process.exitCode = 2
}
