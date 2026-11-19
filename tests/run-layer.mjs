#!/usr/bin/env node
// Sequential adapter for legacy self-executing scripts and node:test files.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './helpers/runtime.mjs'
import { serveDir } from './helpers/env.mjs'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')
/**
 * 已接线的层。#368：`regression` 补进来 —— tests/regression/ 那 11 个文件（纯 Node，无浏览器/网络）
 * 一直写好放在仓库里，却既不在 LAYERS 也不在 CI 引用里，等于整层从未执行；`issue-135` 因此
 * 死了很久（import 了 #331 已删除的 `startCheckout`）也没人发现。CI 接线见 #365。
 */
const LAYERS = ['unit', 'integration', 'regression', 'e2e', 'device']
const SELF_SERVED = new Set([
  'internal-build', 'motion', 'mode-switch', 'diagnostics', 'diagnostics-contract', 'auto-title',
  'provider-channels', 'feedback-export', 'mode-switch-plain',
].map((s) => `${s}.test.mjs`))
/**
 * 这几个用例历史上是「外部先起一个静态服务，再 APP_URL=... 跑」（旧 README 让手起 5181）。
 * 手起服务漏了就是整批假红，所以这里由 runner 统一起一份标准产物服务并把 APP_URL 注入进去；
 * 用例自己已经能自起服务的（SELF_SERVED）不走这条路。
 */
const APP_URL_FILES = new Set([
  'caps', 'paths', 'probe-auth', 'probe-auth-protocols', 'probe-nokey', 'provider-anthropic',
  'request-body', 'upstream-html', 'url-import-native', 'url-import-stages', 'url-import-web',
  'legacy-config', 'full-acceptance',
  // #365：域 5 的 L1 用例把 APP_URL 默认成 `http://127.0.0.1:5181`（旧 README 让手起服务）。
  // 本机 5181 上只要**有任何**静态服务在跑，这条用例就会对着陌生产物「跑绿」—— 假绿比红更坏。
  // 登记进来后由 runner 注入共享标准产物服务的地址，端口 0 原子分配。
  'domain05-ui-export-import',
].map((s) => `${s}.test.mjs`))

/**
 * #365：这几个用例的产物守卫要的是 **standard 变体**，但取的是 `DIST_DIR`（默认 `dist`）。
 * 本仓库的 `dist` 由 `pnpm build:internal` 产生（内测变体），标准变体落在 `dist-standard`，
 * 于是按默认值跑只会拿到 SKIP(env)「产物种类不对」—— #362 新增的这 6 个域的 L1 用例
 * 因此在标准跑法（`pnpm test:integration`）里**从未真正执行过**。
 * 这里由 runner 把 DIST_DIR 指到标准产物；用户显式传了 DIST_DIR 就不覆盖。
 */
const STANDARD_DIST_DIR_FILES = new Set([
  'domain01-first-run', 'domain01-session-load',
  'domain02-reply-error-ui', 'domain02-stop-regenerate', 'domain02-wait-thinking-ui',
  'domain08-feedback-negative',
  'domain09-delete-all-retention', 'domain09-settings-reload',
  'domain10-update-check-flow',
  'quota-exhausted',
].map((s) => `${s}.test.mjs`))

/** 用例的环境守卫退出码：端口被占 / 产物种类不对 / 产物陈旧（SKIP(env)，不算失败） */
const SKIP_CODE = 77
/** 集成层基线清单：只判「相对基线没有新增失败」 */
const BASELINE_FILE = path.join(TESTS_DIR, 'integration-baseline.json')
/**
 * #365：集成层全量已经跑到 ~20 分钟，CI 里一个 job 跑完反馈太慢，于是按分片拆成并行 job。
 * 分片只决定「哪个文件落到哪个分片」，**不影响「是否被跑到」**：分片是覆盖全集的划分
 * （没登记权重的文件也有默认权重，一样会被分进某个分片），不会出现「新文件没人跑」。
 * 权重取自实测耗时（见 integration-shard-weights.json 的 recordedAt/note），只影响均衡度。
 */
const SHARD_WEIGHTS_FILE = path.join(TESTS_DIR, 'integration-shard-weights.json')
/** 未登记文件的默认权重（ms）：按集成层中位数取，宁可高估也不让新文件把某个分片拖长 */
const DEFAULT_SHARD_WEIGHT_MS = 30000
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** `--shard 1/3` → { index: 1, count: 3 }；非法值直接抛，不做「猜你想要什么」 */
function parseShard(value) {
  const matched = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(value).trim())
  if (!matched) throw new Error(`--shard 的格式是 i/n（1-based，例如 1/3）：${value}`)
  const index = Number(matched[1])
  const count = Number(matched[2])
  if (count < 2) throw new Error(`--shard 的 n 必须 >= 2（不分组就别传 --shard）：${value}`)
  if (index > count) throw new Error(`--shard 的 i 必须 <= n：${value}`)
  return { index, count }
}

/**
 * #365：把选择集切成 n 片，长任务优先装进当前最轻的桶（LPT），只影响均衡度、不影响覆盖率。
 * 权重表缺失/损坏不是错误 —— 退化成「所有文件同权重」的 round-robin 等分，照样覆盖全集。
 */
async function planShard(list, shard) {
  let weights = {}
  let weightSource = `${path.basename(SHARD_WEIGHTS_FILE)}（未找到，按默认 ${DEFAULT_SHARD_WEIGHT_MS}ms 估重）`
  try {
    const parsed = JSON.parse(await readFile(SHARD_WEIGHTS_FILE, 'utf8'))
    weights = parsed.files ?? {}
    weightSource = `${path.basename(SHARD_WEIGHTS_FILE)}（实测 ${parsed.recordedAt ?? '未注明'}）`
  } catch { /* 没有权重表也能分片：下面的默认权重保证全覆盖 */ }
  const weightOf = (item) => {
    const ms = Number(weights[path.basename(item.file)]?.ms)
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SHARD_WEIGHT_MS
  }
  const bins = Array.from({ length: shard.count }, (_, i) => ({ index: i + 1, items: [], loadMs: 0 }))
  const ordered = [...list].sort((a, b) => weightOf(b) - weightOf(a) || rel(a.file).localeCompare(rel(b.file)))
  for (const item of ordered) {
    const target = bins.reduce((lightest, bin) => (bin.loadMs < lightest.loadMs ? bin : lightest), bins[0])
    target.items.push(item)
    target.loadMs += weightOf(item)
  }
  for (const bin of bins) bin.items.sort((a, b) => rel(a.file).localeCompare(rel(b.file)))
  const picked = bins[shard.index - 1].items
  return { bins, picked, pickedLoadMs: bins[shard.index - 1].loadMs, weightSource }
}

async function main() {
  const argv = process.argv.slice(2)
  let layer, only = '', caseName = '', json, failedFrom, timeoutMs = 180000, shard = null
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--only', '--case', '--json', '--failed-from', '--timeout-ms', '--shard'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`)
      if (arg === '--only') only = value
      if (arg === '--case') caseName = value
      if (arg === '--json') json = value
      if (arg === '--failed-from') failedFrom = value
      if (arg === '--timeout-ms') timeoutMs = Number(value)
      if (arg === '--shard') shard = parseShard(value)
    } else if (['--bail', '--list', '--baseline'].includes(arg)) flags.add(arg)
    else if (!arg.startsWith('-') && !layer) layer = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout-ms must be a positive integer')
  const plan = layer === 'all' ? ['unit', 'regression', 'integration'] : [layer]
  if (plan.some((name) => !LAYERS.includes(name))) throw new Error('Usage: node tests/run-layer.mjs <unit|integration|regression|e2e|device|all> [--only substring] [--case exact-path] [--shard 1/3] [--timeout-ms 180000] [--json result.json] [--failed-from result.json] [--bail] [--list]')
  let failed
  if (failedFrom) {
    const report = JSON.parse(await readFile(failedFrom, 'utf8'))
    if (!Array.isArray(report.results) || report.results.some((r) => typeof r.file !== 'string' || typeof r.ok !== 'boolean')) throw new Error('Invalid previous report')
    failed = new Set(report.results.filter((r) => !r.ok).map((r) => r.file))
  }
  const selected = []
  for (const name of plan) {
    // Missing/unreadable layer is an infrastructure error, never an empty PASS.
    const names = await readdir(path.join(TESTS_DIR, name))
    for (const basename of names.filter((n) => n.endsWith('.test.mjs')).sort()) {
      const file = path.join(TESTS_DIR, name, basename)
      if (only && !basename.includes(only)) continue
      if (caseName && caseName !== rel(file) && caseName !== basename) continue
      if (failed && !failed.has(rel(file))) continue
      selected.push({ layer: name, file })
    }
  }
  // #365：分片在「--only / --case / --failed-from 筛完之后」才切，保证分片是对当前选择集的完整划分。
  const shardPlan = shard ? await planShard(selected, shard) : null
  const planned = shardPlan ? shardPlan.picked : selected
  const started = performance.now()
  const results = []
  if (flags.has('--list')) {
    if (shardPlan) {
      for (const bin of shardPlan.bins) {
        console.log(`# 分片 ${bin.index}/${shard.count}：${bin.items.length} 个文件，约 ${Math.round(bin.loadMs / 1000)}s`)
        for (const item of bin.items) console.log(`  [${item.layer}] ${rel(item.file)}`)
      }
    }
    for (const item of planned) console.log(`[${item.layer}] ${rel(item.file)}`)
    return planned.length ? 0 : 1
  }
  if (shardPlan) {
    console.log(`分片 ${shard.index}/${shard.count}：本分片 ${planned.length} 个文件（全集 ${selected.length}），预计 ${Math.round(shardPlan.pickedLoadMs / 1000)}s；权重来源 ${shardPlan.weightSource}`)
  }
  let interrupted = false
  // 标准产物目录：APP_URL 注入与 DIST_DIR 重定向都以它为准（用户可用 STANDARD_DIST_DIR / DIST_DIR_STANDARD 覆盖）
  const standardDistDir = () =>
    process.env.STANDARD_DIST_DIR || process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
  // 共享标准产物服务：只在真的有用例需要 APP_URL 时才起，退出即释放（端口 0 = 原子分配，不撞端口）
  let sharedStd = null
  const ensureSharedStd = async () => {
    if (sharedStd) return sharedStd
    const dir = standardDistDir()
    sharedStd = await serveDir(dir, { port: 0, label: '共享标准产物 dist-standard' })
    console.log(`
共享标准产物服务：${dir} → ${sharedStd.url}`)
    return sharedStd
  }
  for (const item of planned) {
    console.log(`\n>> ${rel(item.file)} (timeout ${timeoutMs}ms)`)
    const env = { ...process.env }
    const base = path.basename(item.file)
    if (SELF_SERVED.has(base)) env.APP_URL = ''
    else if (APP_URL_FILES.has(base) && !process.env.APP_URL) env.APP_URL = (await ensureSharedStd()).url
    // 要 standard 变体却读 DIST_DIR 的用例：指到标准产物，别让它们对着内测包 SKIP(env)（#365）
    if (STANDARD_DIST_DIR_FILES.has(base) && !process.env.DIST_DIR) env.DIST_DIR = standardDistDir()
    const result = await runCase(item.file, { cwd: ROOT, env, timeoutMs })
    const skipped = result.code === SKIP_CODE
    const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(result.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
    results.push({ layer: item.layer, file: rel(item.file), ...result, skipped, skipReason })
    const status = result.ok ? 'PASS' : skipped ? 'SKIP(env)' : result.timedOut ? 'TIMEOUT' : 'FAIL'
    console.log(`<< ${status} ${rel(item.file)} (${result.ms}ms)`)
    if (skipped) console.log(`   ↳ ${skipReason}`)
    if (result.interrupted) { interrupted = true; break }
    if (!result.ok && flags.has('--bail')) break
  }
  sharedStd?.kill()
  const failures = results.filter((r) => !r.ok && !r.skipped)
  const skips = results.filter((r) => r.skipped)
  // #287：用例内部 `t.skip()` / `{ skip: ... }` 不会改进程退出码，跑完全绿也看不出「一行断言都没跑」。
  // 这里把用例自己报的 # SKIP 汇总打印（如 legacy-bundle-target 缺产物时的声明期跳过），
  // 让跳过在报告里永远露头；判红门禁仍只看真实失败，避免把「产物没构建」误报成回归。
  const nodeSkips = results.filter((r) => (r.skips ?? 0) > 0)
  const failedCount = failures.length
  const totalMs = Math.round(performance.now() - started)
  const report = {
    version: 1,
    totalMs,
    selected: planned.length,
    executed: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: failedCount,
    skipped: skips.length,
    skippedSubtests: nodeSkips.reduce((sum, r) => sum + (r.skips ?? 0), 0),
    results,
  }
  if (json) await writeFile(path.resolve(json), JSON.stringify(report, null, 2) + '\n')
  if (!planned.length) console.error('No matching cases')
  console.log(
    `\nTotal ${results.length}: PASS ${report.passed}, FAIL ${failedCount}, SKIP(env) ${skips.length}, NODE-SKIP ${report.skippedSubtests}; elapsed ${totalMs}ms`,
  )
  for (const r of failures) console.log(`Rerun: node tests/run-layer.mjs ${r.layer} --case ${r.file}`)
  for (const r of skips) console.log(`Skipped (environment): ${r.file} — ${r.skipReason}`)
  // #298：跳过必须**指名道姓**。以前只有 `Skipped (in-case # SKIP ×2): <文件>` 一行，报告里
  // 根本看不出是「E-1/E-2 产物门禁没跑」，更看不出原因（缺 dist）—— 而这两条正是产物层的硬门禁。
  for (const r of nodeSkips) {
    console.log(`Skipped (in-case # SKIP ×${r.skips}): ${r.file}`)
    for (const detail of r.skipDetails ?? []) {
      console.log(`   ↳ 未被检查：${detail.name}${detail.reason ? ` — ${detail.reason}` : ''}`)
    }
  }
  const verdict = await compareWithBaseline(results)
  if (verdict !== null) return interrupted ? 130 : verdict
  return interrupted ? 130 : planned.length && !failedCount ? 0 : 1

  /** --baseline：与 tests/integration-baseline.json 比对，只判「相对基线没有新增失败」 */
  async function compareWithBaseline(list) {
    if (!flags.has('--baseline')) return null
    let baseline
    try {
      baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'))
    } catch (error) {
      console.error(`\n基线清单读取失败：${BASELINE_FILE}（${error.message}）——按普通模式判定`)
      return null
    }
    const entryOf = (file) => baseline.files?.[path.basename(file)] ?? null
    const newFails = []
    const fixed = []
    const knownRed = []
    const skipped = []
    for (const r of list) {
      const entry = entryOf(r.file)
      const expected = entry?.expected ?? 'pass'
      if (r.skipped) {
        skipped.push(r)
        continue
      }
      if (r.ok && expected === 'known-red') fixed.push(r.file)
      else if (!r.ok && expected === 'known-red') knownRed.push(r.file)
      else if (!r.ok) newFails.push({ file: r.file, reason: entry?.reason ?? '' })
    }
    const failedNow = list.filter((r) => !r.ok && !r.skipped).length
    const registeredRed = Object.values(baseline.files ?? {}).filter((e) => e.expected === 'known-red').length
    console.log(
      `\n${'='.repeat(70)}\n== 基线比对（${path.basename(BASELINE_FILE)}，基线：${baseline.baseline?.ref ?? '未注明'}）\n${'='.repeat(70)}`,
    )
    console.log(
      `本次失败 ${failedNow} / 基线登记红 ${registeredRed} / 新增失败 ${newFails.length} / 已转绿 ${fixed.length} / 跳过(环境) ${skipped.length}（共 ${list.length} 个文件）`,
    )
    for (const file of knownRed) console.log(`  KNOWN-RED  ${file}（基线已登记，不算新增）`)
    for (const r of skipped) console.log(`  SKIP(ENV)  ${r.file}：${r.skipReason}`)
    for (const file of fixed) console.log(`  FIXED?     ${file}（基线记着红但这次通过，请更新基线清单）`)
    for (const item of newFails) console.log(`  NEW FAIL   ${item.file}${item.reason ? `（${item.reason}）` : ''}`)
    const ok = newFails.length === 0 && fixed.length === 0
    console.log(ok ? '\n相对基线没有新增失败 ✅' : '\n相对基线有问题 ❌')
    return ok ? 0 : 1
  }
}

try { process.exitCode = await main() }
catch (error) { console.error(error.message); process.exitCode = 2 }
