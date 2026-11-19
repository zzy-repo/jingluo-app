#!/usr/bin/env node
/**
 * test-report.mjs —— 生成 `docs/testing/report.md`：覆盖 / 耗时 / known-red 一张看板（Issue #409）。
 *
 *   pnpm test:report            # 读上次实测 + 实时清点文件，1 秒出报告（可复现）
 *   pnpm test:report -- --measure   # 先重测 unit / regression / golden / gates，再更新
 *                                   # tests/timing-baseline.json 并出报告（unit 全量 ~100s）
 *
 * 三条口径（别把这张表读成「覆盖率 100%」）：
 *   1. **文件数**是实时的（扫目录），**用例数与耗时**来自 `tests/timing-baseline.json` 的上次实测，
 *      每条都带 `measuredAt` 与采集命令 —— 报告里把两者分列，避免「数字看着新，其实两个月前测的」。
 *   2. **每域功能点覆盖**不重算，只读 `docs/testing/coverage/feature-coverage.md` 的表（那是 #362
 *      逐条读码 + 读断言的产物）；脚本只做汇总，防止「看板和盘点各说各话」。
 *   3. 集成层全量一次 ~20 分钟，`--measure` **不跑**它（只保留上次实测值并注明来源）；
 *      它由 CI 的 L1 分片任务覆盖。宁可报告上写「未在本机重测」，也不编一个数。
 *
 * 为什么不接 CI：`.github/workflows/ci.yml` 同时有别的改动在进行（#405），本单只提供本地可复现的
 * 生成器；「每次 main 跑完自动更新」留给 follow-up（见 PR 描述）。
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, printSummary, rel, runSelected } from './lib/run-selected.mjs'
import { expandGlob } from './lib/glob-match.mjs'

const REPORT_FILE = path.join(ROOT, 'docs', 'testing', 'report.md')
const LEDGER_FILE = path.join(ROOT, 'tests', 'timing-baseline.json')
const COVERAGE_FILE = path.join(ROOT, 'docs', 'testing', 'coverage', 'feature-coverage.md')
const BASELINE_FILE = path.join(ROOT, 'tests', 'integration-baseline.json')
const MAP_FILE = path.join(ROOT, 'tests', 'domain-map.json')
const FAST_SUBSET_FILE = path.join(ROOT, 'tests', 'fast-subset.json')

/** 看板里的五层；`files` 是实时扫出来的，`cases`/`ms` 来自 timing-baseline.json */
const LAYERS = [
  { id: 'unit', label: 'unit（L0）', dir: 'tests/unit', command: 'pnpm test' },
  { id: 'integration', label: 'integration（L1）', dir: 'tests/integration', command: 'pnpm test:integration:baseline' },
  { id: 'regression', label: 'regression', dir: 'tests/regression', command: 'pnpm test:regression' },
  { id: 'golden', label: 'golden（每域主路径）', dir: 'tests/golden', command: 'pnpm test:golden' },
  { id: 'gates', label: 'gates（门禁负向对照）', dir: null, command: 'node --test tests/unit/gate-negative-controls.test.mjs' },
]

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

const countTests = async (dir) => {
  try {
    return (await readdir(path.join(ROOT, dir))).filter((name) => name.endsWith('.test.mjs')).length
  } catch {
    return 0
  }
}

/** tests/gates 按目录口径数：fixtures + lib（它本身不放可执行用例，见 tests/gates/README.md） */
const countGates = async () => {
  const root = path.join(ROOT, 'tests', 'gates')
  let total = 0
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name))
      else if (!entry.name.endsWith('.md')) total += 1
    }
  }
  await walk(root)
  return total
}

/** 把 feature-coverage.md 的 §2.x 域表读成「每域 4 档状态计数」 */
function parseFeatureCoverage(markdown) {
  const domains = []
  let current = null
  let statusIndex = -1
  for (const line of markdown.split('\n')) {
    const heading = /^###\s+2\.\d+\s+域\s*(\d+)\s+(.+?)（(\d+)）\s*$/.exec(line)
    if (heading) {
      current = { id: Number(heading[1]), name: heading[2].trim(), declared: Number(heading[3]), rows: [], statusIndex: -1 }
      domains.push(current)
      statusIndex = -1
      continue
    }
    if (!current) continue
    if (/^##\s/.test(line)) {
      current = null
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.includes('覆盖状态')) {
      statusIndex = cells.indexOf('覆盖状态')
      current.statusIndex = statusIndex
      continue
    }
    if (/^\|[\s:-]+\|/.test(line)) continue
    if (statusIndex < 0) continue
    // 域 5 的表用 `F-05-01`，别的域用 `F1-01`：两种都要认（#409 实测 127/160 就是这么少的 33 行）
    if (!/^F-?\d/.test(cells[1] ?? '')) continue
    // 有些行把状态写成 `**未覆盖**`（加粗）：先剥掉强调标记再分档，否则会漏 14 行（#409 实测）
    current.rows.push({ id: cells[1], status: (cells[statusIndex] ?? '').replace(/\*/g, '').trim() })
  }
  return domains.map((domain) => {
    const tally = { covered: 0, partial: 0, uncovered: 0, na: 0 }
    for (const row of domain.rows) {
      const status = row.status
      if (status.startsWith('已覆盖')) tally.covered += 1
      else if (status.startsWith('部分')) tally.partial += 1
      else if (status.startsWith('未覆盖')) tally.uncovered += 1
      else if (status.startsWith('不适用')) tally.na += 1
    }
    return { ...domain, rows: undefined, total: domain.rows.length, tally }
  })
}

/** 黄金层要的 standard 产物：缺了才构建一次（写成 dist-standard，别覆盖集成层用的 dist/） */
async function ensureStandardDist() {
  const index = path.join(ROOT, 'dist-standard', 'index.html')
  try {
    await access(index)
    const info = JSON.parse(await readFile(path.join(ROOT, 'dist-standard', 'build-info.json'), 'utf8'))
    if (info.variant === 'standard') return
  } catch {
    /* 缺产物 / 缺 build-info：往下构建 */
  }
  console.log('   产物：dist-standard/ 缺失或不是 standard 变体 → 构建一次（DIST_OUT=dist-standard node scripts/build.mjs）')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DIST_OUT: 'dist-standard' },
  })
  if (result.status !== 0) throw new Error('标准产物构建失败：先修构建')
}

const rmFile = async (file) => {
  const { rm } = await import('node:fs/promises')
  await rm(file, { force: true })
}

const fmtMs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—')

/** ISO 时间 → 本地日期（报告是给人看的，「今天跑的」不该显示成昨天） */
const fmtDate = (iso) => {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 10)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function testPool() {
  const pool = []
  for (const layer of ['unit', 'integration', 'regression', 'golden']) {
    try {
      const names = (await readdir(path.join(ROOT, 'tests', layer))).filter((name) => name.endsWith('.test.mjs'))
      for (const name of names) pool.push(`tests/${layer}/${name}`)
    } catch {
      continue
    }
  }
  return pool
}

/** `--measure`：重测能本地重测的层，写回 ledger；集成层保留原值（~20 分钟，交给 CI） */
async function measure(ledger, only = ['unit', 'regression', 'golden', 'gates']) {
  const results = { ...ledger.layers }
  // 映射表自检：10 个域是硬要求（Issue #409 验收），少一个域就等于有一类改动挑不到用例
  if (mapRows.length !== 10) console.log(`⚠ tests/domain-map.json 只覆盖 ${mapRows.length} 个域（#409 要求 10 个）`)
  for (const row of mapRows) {
    if (row.tests === 0) console.log(`⚠ ${row.id} ${row.name} 映射到 0 个用例文件：glob 写错了或用例改名了`)
  }

  const stamp = new Date().toISOString()
  for (const layer of only) {
    if (layer === 'integration') {
      console.log('· integration：跳过重测（全量约 20 分钟，由 CI 的 L1 分片任务覆盖；保留上次实测值与来源）')
      continue
    }
    // 黄金层用自己的 runner 测（并行、单条 ≤60s、整层 ≤5min），别用顺序批量冒充它的口径
    if (layer === 'golden') {
      const json = path.join(ROOT, 'tests', '.golden-measure.json')
      console.log('\n== 重测 golden（node tests/run-golden.mjs，并行口径）')
      const started = performance.now()
      // 黄金套件要 standard 产物；`dist/` 可能是内测变体（集成层要它），所以指到 dist-standard，
      // 与 test-full / CI 黄金 job 同一个口径（GOLDEN_DIST_DIR）。
      await ensureStandardDist()
      const spawn = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run-golden.mjs'), '--json', json], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, GOLDEN_DIST_DIR: path.join(ROOT, 'dist-standard') },
      })
      const report = await readJson(json).catch(() => null)
      await rmFile(json)
      const ms = report?.totalMs ?? Math.round(performance.now() - started)
      results.golden = {
        files: report?.results?.length ?? 4,
        cases: report?.results?.length ?? null,
        ms,
        measuredAt: stamp,
        command: 'node tests/run-golden.mjs',
        note: '用例数 = 主路径条数（每条路径是一域一条主路径，内部多步断言）',
        failed: (report?.results ?? []).filter((item) => item.status !== 'PASS').length,
        skipped: 0,
        status: spawn.status === 0 ? 'PASS' : 'FAIL',
      }
      continue
    }
    let files = []
    if (layer === 'gates') {
      files = ['tests/unit/gate-negative-controls.test.mjs']
    } else {
      const dir = LAYERS.find((item) => item.id === layer).dir
      files = (await readdir(path.join(ROOT, dir))).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `${dir}/${name}`)
    }
    console.log(`\n== 重测 ${layer}（${files.length} 个文件）`)
    const summary = await runSelected(files)
    printSummary(layer, summary)
    results[layer] = {
      files: files.length,
      cases: summary.cases,
      ms: summary.totalMs,
      measuredAt: stamp,
      command: layer === 'gates' ? 'node --test tests/unit/gate-negative-controls.test.mjs' : `node tests/run-layer.mjs ${layer}`,
      note:
        layer === 'gates'
          ? '门禁负向对照：四道门禁各跑一轮「注入必错输入 → 红且红对地方 → 还原」'
          : '由 pnpm test:report --measure 采集：同一份 runCase 逐文件跑，墙钟含 runner 循环开销（比 run-layer 的 elapsed 高 <10%）',
      failed: summary.failed,
      skipped: summary.skipped,
    }
  }
  const updated = {
    ...ledger,
    schemaVersion: ledger.schemaVersion ?? 1,
    measuredBy: 'node scripts/test-report.mjs --measure',
    layers: results,
  }
  await writeFile(LEDGER_FILE, `${JSON.stringify(updated, null, 2)}\n`)
  console.log(`\n已更新 ${rel(LEDGER_FILE)}`)
  return updated
}

async function main() {
  const argv = process.argv.slice(2)
  const opts = { measure: false, layers: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // pnpm 会把 `--` 原样传下来
    if (arg === '--measure') { opts.measure = true; continue }
    if (arg === '--layers') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        console.error('--layers 需要一个值，例如 --layers golden,gates')
        return 2
      }
      opts.layers = value.split(',').map((item) => item.trim()).filter(Boolean)
      const allowed = ['unit', 'regression', 'golden', 'gates', 'integration']
      const bad = opts.layers.filter((layer) => !allowed.includes(layer))
      if (bad.length > 0) {
        console.error(`未知层：${bad.join(' ')}（可选 ${allowed.join(' / ')}）`)
        return 2
      }
      continue
    }
    console.error(`未知参数：${arg}\n用法：node scripts/test-report.mjs [--measure [--layers unit,regression,golden,gates]]`)
    return 2
  }
  let ledger = await readJson(LEDGER_FILE)
  if (opts.layers && !opts.measure) {
    console.error('--layers 只和 --measure 一起用')
    return 2
  }
  if (opts.measure) ledger = await measure(ledger, opts.layers ?? undefined)

  const [baseline, map, fastSubset, coverageMarkdown] = await Promise.all([
    readJson(BASELINE_FILE),
    readJson(MAP_FILE),
    readJson(FAST_SUBSET_FILE),
    readFile(COVERAGE_FILE, 'utf8'),
  ])
  const pool = await testPool()

  const layerRows = []
  for (const layer of LAYERS) {
    const files = layer.dir ? await countTests(layer.dir) : await countGates()
    const measured = ledger.layers?.[layer.id] ?? {}
    layerRows.push({
      label: layer.label,
      files,
      cases: measured.cases ?? null,
      ms: measured.ms ?? null,
      measuredAt: measured.measuredAt ?? '',
      command: measured.command ?? layer.command,
      note: measured.note ?? '',
    })
  }

  const featureDomains = parseFeatureCoverage(coverageMarkdown)
  const totals = featureDomains.reduce(
    (acc, domain) => ({
      total: acc.total + domain.total,
      covered: acc.covered + domain.tally.covered,
      partial: acc.partial + domain.tally.partial,
      uncovered: acc.uncovered + domain.tally.uncovered,
      na: acc.na + domain.tally.na,
    }),
    { total: 0, covered: 0, partial: 0, uncovered: 0, na: 0 },
  )

  const knownRed = Object.entries(baseline.files ?? {})
    .filter(([, entry]) => entry.expected === 'known-red')
    .map(([file, entry]) => ({ file, reason: entry.reason ?? '', followUp: entry.followUp ?? '', evidence: entry.evidence ?? '' }))
  const registeredPass = Object.values(baseline.files ?? {}).filter((entry) => entry.expected === 'pass').length
  const flakyRegistryCandidates = ['tests/flaky-registry.json', 'tests/flaky.json', 'docs/testing/flaky.md']
  const flaky = []
  for (const candidate of flakyRegistryCandidates) {
    try {
      const text = await readFile(path.join(ROOT, candidate), 'utf8')
      const parsed = candidate.endsWith('.json') ? JSON.parse(text) : null
      if (parsed) flaky.push({ registry: candidate, entries: parsed.files ?? parsed.entries ?? [] })
      else flaky.push({ registry: candidate, entries: [] })
    } catch {
      /* 没有就是没有：flaky registry 目前不存在 */
    }
  }

  const mapRows = map.domains.map((domain) => {
    const globs = Object.keys(domain.paths ?? {})
    const tests = new Set()
    for (const glob of globs) {
      for (const assigned of domain.paths[glob]) for (const file of expandGlob(assigned, pool)) tests.add(file)
    }
    for (const extra of Object.values(domain.tests ?? {})) for (const glob of extra) for (const file of expandGlob(glob, pool)) tests.add(file)
    return { id: domain.id, name: domain.name, doc: domain.doc ?? '', globs: globs.length, tests: tests.size }
  })

  const stamp = new Date()
  /** `pnpm test:fast -- --record` 写进台账的那一行（第 5 节的「最近实测」） */
  const fastLedger = ledger.layers?.fast ?? null
  const lines = []
  const push = (...items) => lines.push(...items)

  push(
    '# 测试覆盖与耗时看板（自动生成）',
    '',
    '> 本文件由 `pnpm test:report` 生成，**不要手改**（手改会在下一次生成时被覆盖）。',
    `> 生成时间：${stamp.toISOString()}`,
    '> 数据来源：`tests/timing-baseline.json`（上次实测，逐条带 measuredAt）+ 目录实时清点 + `docs/testing/coverage/feature-coverage.md`（#362 功能点总表）。',
    '> 重测：`pnpm test:report -- --measure`（重跑 unit / regression / golden / gates 并更新实测值；集成层约 20 分钟，交给 CI）。',
    '',
    '## 0. 一页结论',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 五层文件数 | ${layerRows.map((row) => `${row.label.split('（')[0]}=${row.files}`).join(' / ')} |`,
    `| 功能点（#362 十域） | ${totals.total} 条：已覆盖 ${totals.covered} / 部分覆盖 ${totals.partial} / 未覆盖 ${totals.uncovered} / 不适用 ${totals.na} |`,
    `| known-red（集成层基线） | ${knownRed.length} 条（每个文件都在 tests/integration-baseline.json 里有 reason + followUp） |`,
    `| flaky registry | ${flaky.length === 0 ? '暂无（仓库里没有 registry 文件）' : `${flaky.length} 份`} |`,
    `| 改动-用例映射 | ${mapRows.length} 个域 / ${mapRows.reduce((sum, row) => sum + row.globs, 0)} 条 src glob → ${mapRows.reduce((sum, row) => sum + row.tests, 0)} 个用例文件（tests/domain-map.json） |`,
    '',
    '## 1. 各层文件数 / 用例数 / 上次实测耗时',
    '',
    '| 层 | 文件数（实时） | 用例数（实测） | 上次实测耗时 | 实测时间（本地） | 采集命令 |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const row of layerRows) {
    push(`| ${row.label} | ${row.files} | ${row.cases ?? '—'} | ${fmtMs(row.ms)} | ${fmtDate(row.measuredAt)} | \`${row.command}\` |`)
  }
  push(
    '',
    '口径说明：',
    '',
    '- **文件数**每次生成时重新清点，不会和仓库漂移。',
    '- **用例数 / 耗时**是「上次实测」，不是本次生成时现测的；`unit` 的用例数 = node:test 用例 + 自执行脚本分节。',
    '- **gates** 的「文件数」是 `tests/gates/` 下的 fixture/lib 文件数（这一层不放可执行用例，用例在 `tests/unit/gate-negative-controls.test.mjs`，随 unit 层一起跑）。',
    '',
    '## 2. 每域功能点覆盖（读 `docs/testing/coverage/feature-coverage.md`）',
    '',
    '| 域 | 名称 | 功能点 | 已覆盖 | 部分覆盖 | 未覆盖 | 不适用 | domain-map 映射到的用例 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const domain of featureDomains) {
    const mapped = mapRows.find((row) => row.id === `domain${String(domain.id).padStart(2, '0')}`)
    push(
      `| ${domain.id} | ${domain.name} | ${domain.total} | ${domain.tally.covered} | ${domain.tally.partial} | ${domain.tally.uncovered} | ${domain.tally.na} | ${mapped ? `${mapped.tests} 个文件` : '—'} |`,
    )
  }
  push(
    `| **合计** | | **${totals.total}** | **${totals.covered}** | **${totals.partial}** | **${totals.uncovered}** | **${totals.na}** | ${mapRows.reduce((sum, row) => sum + row.tests, 0)} 个文件 |`,
    '',
    '这张表**只汇总** `feature-coverage.md` 的行级状态，不重新判定覆盖；判定口径（L0/L1/L2/L3、四档状态）见该文件 §2.0。',
    '',
    '## 3. known-red 与 flaky',
    '',
    `### 3.1 known-red（${knownRed.length} 条，来源 \`tests/integration-baseline.json\`）`,
    '',
  )
  if (knownRed.length === 0) {
    push('无。', '')
  } else {
    push('| 文件 | 为什么红 | 跟进 |', '| --- | --- | --- |')
    for (const item of knownRed) push(`| \`${item.file}\` | ${item.reason || '—'} | ${item.followUp || '—'} |`)
    push('', `另有 ${registeredPass} 条登记为 expected=pass。判红规则：只判「相对基线没有新增失败」；known-red 跑绿会报 FIXED? 要求删条目（防基线永久腐烂）。`, '')
  }
  push(`### 3.2 flaky`, '')
  if (flaky.length === 0) {
    push(
      '暂无 flaky registry：仓库里没有 `tests/flaky-registry.json`，所以「已知不稳定用例」目前没有登记处。',
      '真遇到时按 `tests/integration-baseline.json` 的形状新建一份 registry（每条写 reason + 关联 issue + 复跑次数），本脚本会自动读进来。',
      '',
    )
  } else {
    for (const item of flaky) push(`- \`${item.registry}\`：${Array.isArray(item.entries) ? item.entries.length : 0} 条`)
    push('')
  }

  push(
    '## 4. 改动 → 用例映射（`tests/domain-map.json`）',
    '',
    '| 域 | 名称 | src glob 数 | 映射到的用例文件数 | 盘点文档 |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const row of mapRows) push(`| ${row.id} | ${row.name} | ${row.globs} | ${row.tests} | ${row.doc ? `\`${row.doc}\`` : '—'} |`)
  push(
    `| **合计** | **${mapRows.length} 个域** | **${mapRows.reduce((sum, row) => sum + row.globs, 0)}** | **${mapRows.reduce((sum, row) => sum + row.tests, 0)}** | |`,
    '',
    '用法：`pnpm test:affected -- <改动路径...>`（默认 unit + regression + golden；`--with-integration` 才跑集成层）。',
    '',
    '## 5. 单命令入口',
    '',
    '| 命令 | 声明预算 | 最近实测 | 跑什么 | 什么时候用 |',
    '| --- | --- | --- | --- | --- |',
    `| \`pnpm test:fast\` | ≤${((fastSubset.budgetMs ?? 60000) / 1000).toFixed(0)}s | ${fastLedger ? `${(fastLedger.ms / 1000).toFixed(1)}s（${fmtDate(fastLedger.measuredAt)}，${fastLedger.overBudget ? '超预算' : '预算内'}）` : '未记录（跑一次 `pnpm test:fast -- --record`）'} | tsc + L0 快速子集（${(fastSubset.measured?.files ?? 154) - (fastSubset.exclude?.length ?? 0)}/${fastSubset.measured?.files ?? 154} 个单元文件）+ 黄金套件 | 每次提交前 |`,
    '| `pnpm test:full` | 分钟~20 分钟 | 未记录 | unit + regression + golden + integration（集成层按基线判「不新增失败」） | 合并前 / 发版前 |',
    '| `pnpm test:affected` | 秒级~1 分钟 | 未记录 | 按 `tests/domain-map.json` 挑用例并执行 | 改完一处、想知道「就这一处」该跑什么 |',
    '| `pnpm test:report` | <2s | 未记录 | 生成本文件（`--measure` 会重测 unit/regression/golden/gates） | 想知道「现在整体长什么样」 |',
    '',
    `快速子集排除了 ${fastSubset.exclude?.length ?? 0} 个实测最慢的单元文件（合计 ${(((fastSubset.exclude ?? []).reduce((sum, item) => sum + (Number(item.ms) || 0), 0)) / 1000).toFixed(1)}s）；它们仍在 \`pnpm test\` / \`test:full\` / CI 里跑，名单与理由见 \`tests/fast-subset.json\`。`,
    '',
    '## 6. 这张看板怎么保持可信',
    '',
    '1. **文件数实时**：不会出现「文档说 121 个文件，实际 154 个」。',
    '2. **耗时带日期与命令**：分不清「现在」和「上次」的看板等于没有看板。',
    '3. **不接 CI（本单）**：`.github/workflows/ci.yml` 同时有别的改动在进行，接线留 follow-up；',
    '   本单只保证 `pnpm test:report` 在本地一条命令可复现（生成器无网络、无隐式构建、<2s）。',
    '4. **数字对不上就是红**：`pnpm test:report --measure` 会真的跑一遍并覆盖实测值，不手填。',
    '',
  )

  await writeFile(REPORT_FILE, `${lines.join('\n')}\n`)
  console.log(`已生成 ${rel(REPORT_FILE)}（${lines.length} 行）`)
  console.log(`  五层文件数：${layerRows.map((row) => `${row.label}=${row.files}`).join(' / ')}`)
  console.log(`  功能点：${totals.total}（已覆盖 ${totals.covered} / 部分 ${totals.partial} / 未覆盖 ${totals.uncovered} / 不适用 ${totals.na}）`)
  console.log(`  known-red：${knownRed.length} 条；flaky registry：${flaky.length === 0 ? '无' : '有'}`)
  console.log(`  domain-map：${mapRows.length} 个域 / ${mapRows.reduce((sum, row) => sum + row.tests, 0)} 个用例文件`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
