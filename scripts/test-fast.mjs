#!/usr/bin/env node
/**
 * test-fast.mjs —— 「提交前 60 秒内知道自己有没有把主流程弄坏」（Issue #409）。
 *
 * 三拍，任何一拍红就停：
 *   1. `npx tsc -p tsconfig.json`     类型门（本机实测 ~1.2s）
 *   2. L0 快速子集                     `tests/unit` 全量减去 `tests/fast-subset.json` 登记的慢文件（实测 ~38s）
 *   3. 黄金套件 `tests/run-golden.mjs` 每域 1 条主路径，真产物 + 真浏览器（实测 ~3.6s）
 *
 * 口径（和 docs/TESTING-POLICY.md 第 2 节对齐）：
 *   - 快速子集**不是**「挑几条重要的」，是「整层减去实测最慢的那批」：被去掉的 20 个文件仍在
 *     `pnpm test`（CI 每次跑）/ `pnpm test:full` / `pnpm test:affected` 里照跑，这里只是把它们的
 *     秒数从提交前的等待里挪走。名单与理由见 `tests/fast-subset.json`。
 *   - 60s 是**声明**，不是愿望：超预算默认 exit 1（`--no-budget` 可关掉），
 *     否则「≤60s」就会像历史上那样慢慢变成 90s、120s，再没人看。
 *   - 产物：黄金套件要吃标准产物 `dist/`。缺了才构建一次（实测 ~2.6s），已存在就原样用
 *     —— 和 `tests/README.md` 的「不在用例里隐式构建」保持距离：这里构建的是**入口命令**，不是用例。
 *
 * 用法：
 *   pnpm test:fast                 # tsc + L0 快速子集 + 黄金套件
 *   pnpm test:fast -- --list       # 只列会跑哪些文件（不执行）
 *   pnpm test:fast -- --json r.json
 *   pnpm test:fast -- --skip-tsc --skip-golden
 *   pnpm test:fast -- --budget-ms 90000
 *   pnpm test:fast -- --no-budget  # 只报耗时，不因超预算判红
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, printSummary, rel, runSelected } from './lib/run-selected.mjs'

const UNIT_DIR = path.join(ROOT, 'tests', 'unit')
const SUBSET_FILE = path.join(ROOT, 'tests', 'fast-subset.json')
const GOLDEN_RUNNER = path.join(ROOT, 'tests', 'run-golden.mjs')
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build.mjs')
const STANDARD_DIST = path.join(ROOT, 'dist-standard')
const DIST_INDEX = path.join(STANDARD_DIST, 'index.html')

const usage = (message) => {
  if (message) console.error(`${message}\n`)
  console.error('用法：node scripts/test-fast.mjs [--list] [--json r.json] [--record] [--budget-ms 60000] [--no-budget] [--concurrency 3] [--skip-tsc] [--skip-golden]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { list: false, json: '', budgetMs: null, enforceBudget: true, tsc: true, golden: true, concurrency: 3, record: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm 会把 `--` 原样传下来（`pnpm test:fast -- --record`），它不是参数
    if (arg === '--') continue
    if (arg === '--list') { opts.list = true; continue }
    if (arg === '--no-budget') { opts.enforceBudget = false; continue }
    if (arg === '--record') { opts.record = true; continue }
    if (arg === '--skip-tsc') { opts.tsc = false; continue }
    if (arg === '--skip-golden') { opts.golden = false; continue }
    if (!['--json', '--budget-ms', '--concurrency'].includes(arg)) usage(`未知参数：${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${arg} 需要一个值`)
    if (arg === '--json') opts.json = value
    if (arg === '--budget-ms') opts.budgetMs = Number(value)
    if (arg === '--concurrency') opts.concurrency = Number(value)
  }
  if (opts.budgetMs !== null && (!Number.isSafeInteger(opts.budgetMs) || opts.budgetMs < 1)) usage('--budget-ms 必须是正整数')
  if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1) usage('--concurrency 必须是正整数')
  return opts
}

/** 用快照里的实测数字给「省下了多少」一个量级（不是新测量，别当成当前数据） */
const kb = (ms) => `${(ms / 1000).toFixed(1)}s`

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  let subset
  try {
    subset = JSON.parse(await readFile(SUBSET_FILE, 'utf8'))
  } catch (error) {
    console.error(`读不到 ${rel(SUBSET_FILE)}：${error.message}——快速子集没有定义，按失败处理（不允许静默跑全量或空跑）`)
    return 2
  }
  const budgetMs = opts.budgetMs ?? subset.budgetMs ?? 60000
  const exclude = new Set((subset.exclude ?? []).map((item) => item.file))
  const all = (await readdir(UNIT_DIR)).filter((name) => name.endsWith('.test.mjs')).sort()

  // 名单失效要让认得出来：文件改名/删了，条目还留着 = 这条排除理由已经不成立
  const missing = [...exclude].filter((name) => !all.includes(name))
  const selected = all.filter((name) => !exclude.has(name))
  const goldenNames = opts.golden ? await goldenFiles() : []

  console.log(`L0 快速子集：${selected.length}/${all.length} 个单元文件（排除 ${exclude.size} 个慢文件，实测省 ${kb(estimatedExcludedMs(subset))}）`)
  console.log(`门禁：tsc ${opts.tsc ? '跑' : '跳过'} / 黄金套件 ${opts.golden ? `跑 ${goldenNames.length} 条` : '跳过'}；并发 ${opts.concurrency}；预算 ${kb(budgetMs)}`)
  if (missing.length > 0) console.log(`! tests/fast-subset.json 里有 ${missing.length} 个文件已经不存在（条目过期，请删掉）：${missing.join(', ')}`)
  const staleListed = (subset.exclude ?? []).filter((item) => missing.includes(item.file)).length
  if (staleListed > 0) console.log('  （过期条目不阻塞：它们本来就只是「不跑」的登记）')

  if (opts.list) {
    console.log('\n会跑的单元文件：')
    for (const name of selected) console.log(`  [unit] tests/unit/${name}`)
    for (const file of goldenNames) console.log(`  [golden] ${file}`)
    return 0
  }

  const phases = []
  const startedAll = performance.now()
  let failed = 0

  if (opts.tsc) {
    const started = performance.now()
    console.log('\n== 1/3 类型门：npx tsc -p tsconfig.json')
    const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
    const ms = Math.round(performance.now() - started)
    phases.push({ phase: 'tsc', status: result.status === 0 ? 'PASS' : 'FAIL', ms, files: 0 })
    if (result.status !== 0) failed += 1
    console.log(`   ↳ ${result.status === 0 ? 'PASS' : 'FAIL'}（${ms}ms）`)
  }

  if (failed === 0) {
    console.log('\n== 2/3 L0 快速子集')
    const summary = await runSelected(selected.map((name) => path.join(UNIT_DIR, name)), { concurrency: opts.concurrency })
    printSummary('L0 快速子集', summary)
    phases.push({ phase: 'unit-fast', status: summary.failed === 0 ? 'PASS' : 'FAIL', ms: summary.totalMs, files: summary.results.length, cases: summary.cases })
    if (summary.failed > 0) failed += 1
  }

  if (failed === 0 && opts.golden) {
    console.log('\n== 3/3 黄金套件（每域 1 条主路径）')
    const built = await ensureStandardDist()
    if (built !== null) phases.push({ phase: 'build', status: 'PASS', ms: built, files: 0 })
    const started = performance.now()
    const result = spawnSync(process.execPath, [GOLDEN_RUNNER], {
      cwd: ROOT,
      stdio: 'inherit',
      // 黄金套件要 standard 产物：`dist/` 可能是集成层要的内测变体，所以固定指 dist-standard（与 test-full / CI 同口径）
      env: { ...process.env, GOLDEN_DIST_DIR: STANDARD_DIST },
    })
    const ms = Math.round(performance.now() - started)
    phases.push({ phase: 'golden', status: result.status === 0 ? 'PASS' : 'FAIL', ms, files: goldenNames.length })
    if (result.status !== 0) failed += 1
  }

  const totalMs = Math.round(performance.now() - startedAll)
  console.log(`\n${'='.repeat(64)}\npnpm test:fast 各拍耗时`)
  for (const item of phases) {
    console.log(`  ${item.phase.padEnd(10)} ${String(item.status).padEnd(5)} ${String(item.ms).padStart(7)}ms${item.files ? `  ${item.files} 个文件` : ''}${item.cases ? ` / ${item.cases} 用例` : ''}`)
  }
  console.log(`  ${'合计'.padEnd(10)} ${failed === 0 ? 'PASS ' : 'FAIL '} ${String(totalMs).padStart(7)}ms（预算 ${budgetMs}ms）`)
  const overBudget = totalMs > budgetMs
  if (overBudget) {
    console.log(`\n⚠ 超过声明预算：${totalMs}ms > ${budgetMs}ms。「≤60s」是这条命令的契约，超了就说明慢用例又混进来了（或机器在跑别的东西）。`)
  }
  if (opts.json) {
    await writeFile(
      path.resolve(opts.json),
      `${JSON.stringify({ version: 1, totalMs, budgetMs, overBudget, subset: { files: selected.length, total: all.length, excluded: exclude.size }, phases }, null, 2)}\n`,
    )
    console.log(`报告：${opts.json}`)
  }
  // --record：把这一次的真实耗时写进台账（报告里「最近实测」就来自这里，不手填）
  if (opts.record) await recordFastRun({ totalMs, budgetMs, overBudget, phases, selected, all, concurrency: opts.concurrency })
  if (failed > 0) return 1
  return overBudget && opts.enforceBudget ? 1 : 0
}

/** 黄金层文件清单（走 runner 自己的 --list，别另抄一套「哪些算黄金用例」） */
async function goldenFiles() {
  const result = spawnSync(process.execPath, [GOLDEN_RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`黄金套件清单失败：${result.stderr || result.stdout}`)
  return result.stdout.split('\n').map((line) => line.replace(/^\[golden\]\s*/, '').trim()).filter(Boolean)
}

/** 黄金套件要标准产物 dist/；缺了才构建一次，返回构建耗时（没构建则 null） */
async function ensureStandardDist() {
  try {
    await access(DIST_INDEX)
    const info = JSON.parse(await readFile(path.join(STANDARD_DIST, 'build-info.json'), 'utf8'))
    if (info.variant !== 'standard') throw new Error(`dist-standard/ 里是 ${info.variant} 包，黄金套件要 standard`)
    console.log('   产物：dist-standard/ 已在（standard），直接复用（不重建）')
    return null
  } catch {
    console.log('   产物：dist-standard/ 缺失 → 构建一次标准产物（DIST_OUT=dist-standard node scripts/build.mjs）')
    const started = performance.now()
    const result = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DIST_OUT: 'dist-standard' } })
    const ms = Math.round(performance.now() - started)
    if (result.status !== 0) throw new Error('标准产物构建失败：先修构建，再跑 test:fast')
    return ms
  }
}

const estimatedExcludedMs = (subset) => (subset.exclude ?? []).reduce((sum, item) => sum + (Number(item.ms) || 0), 0)

/** 写入 tests/timing-baseline.json 的 `fast` 行（只加这一行，其它层原样不动） */
async function recordFastRun({ totalMs, budgetMs, overBudget, phases, selected, all, concurrency }) {
  const LEDGER = path.join(ROOT, 'tests', 'timing-baseline.json')
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'))
  const unitPhase = phases.find((item) => item.phase === 'unit-fast')
  const goldenPhase = phases.find((item) => item.phase === 'golden')
  ledger.layers = {
    ...(ledger.layers ?? {}),
    fast: {
      files: selected.length,
      cases: unitPhase?.cases ?? null,
      ms: totalMs,
      budgetMs,
      overBudget,
      measuredAt: new Date().toISOString(),
      command: 'pnpm test:fast',
      note: `tsc ${phases.find((item) => item.phase === 'tsc')?.ms ?? 0}ms + 快速子集 ${unitPhase?.ms ?? 0}ms（${selected.length}/${all.length} 个单元文件，并发 ${concurrency}）+ 黄金套件 ${goldenPhase?.ms ?? 0}ms`,
    },
  }
  await writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`)
  console.log(`已记录到 ${rel(LEDGER)}（layers.fast）`)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
