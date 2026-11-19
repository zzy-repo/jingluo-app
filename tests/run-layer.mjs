#!/usr/bin/env node
// Sequential adapter for legacy self-executing scripts and node:test files.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { runCase, runMergedBatch } from './helpers/runtime.mjs'
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

/**
 * #366 第二批：L0 进程合并。
 *
 * 现状：L0 一个文件一个进程，149 次冷启动 ≈ 12s（node 起进程 + 加载 node:test + 重新解析
 * `.js→.ts` hook 图 + 同一份 TS 源码再加载一次），一行断言都没有。合并后同一批文件共用一次
 * 冷启动与一份模块缓存；装配/隔离见 ../helpers/merged-entry.mjs 的文件头。
 *
 * 分组规则见 harnessKey()：**同一套夹具家族**的文件才进同一批，每 UNIT_BATCH_SIZE 个一批。
 * 新加的文件自动进批（按它引用的夹具目录归桶），不会因为漏登记而「悄悄回到一进程一文件」。
 *
 * 为什么留一批 SOLO 不合并：它们要独占进程级的资源或真计时 —— 起子进程（test-runtime 会
 * 把本 runner 拷到临时目录再跑）、吃真实超时窗口（stream-idle-timeout / long-session）、
 * 要 APP_URL / DIST_DIR 注入（quota-exhausted / feedback-export）、或直接读构建产物。
 * 合进批次会把「失败归因」和「进程级资源」搅在一起，收益也只有十几毫秒的冷启动。
 */
const UNIT_BATCH_SIZE = 16
/** 人工维护的「不合并」清单（原因逐条写在下面）；静态可判的那几条见 mergeBlocker() */
const UNIT_SOLO = new Set([
  // 起子进程 / 拷 runner 自身再跑（它断言的就是 runner 自己的行为）
  'test-runtime.test.mjs',
  // 会「吃到」批内前一个文件的替身（前一个文件把 `@capacitor/core` / `apiConfig` / `react` 换成了
  // 自己那份夹具，这几个文件要的导出不在里面）。批次里会红、单跑必绿 —— 单列，省得每轮都触发
  // 一次「批内红 → 单文件重跑」的兜底（兜底仍然保留，见 runUnit 里那段）。
  'app-update.test.mjs', 'domain09-config-migration-invariants.test.mjs', 'enter-key-mode.test.mjs',
  // pay-link 是「自收摊脚本 + 依赖自己是主脚本」的那类：并进批次时它的顶层检查会被同批文件
  // 提前触发的模块缓存短路（实测批内 7ms 跑完、退出码 0/1 不稳定），单列最诚实。
  'pay-link.test.mjs',
  // 真计时窗口 / 长会话 / 网络探测：并行+批次里计时最不稳定的几个
  'stream-idle-timeout.test.mjs', 'chat-context-budget-long-session.test.mjs',
  'provider-probe-matrix.test.mjs', 'check-capabilities.test.mjs', 'capabilities-docs-sync.test.mjs',
  // 要 runner 注入 APP_URL / DIST_DIR / SELF_SERVED
  'quota-exhausted.test.mjs', 'feedback-export.test.mjs', 'legacy-bundle-target.test.mjs',
  // 读仓库/产物文件、起真实静态服务
  'matrix-config.test.mjs', 'shot-mobile.test.mjs',
].map((s) => s))

/**
 * #366：unit 层的「工作单元耗时权重」。只用来**排序**（长任务先起跑），不影响覆盖率：
 * 车道少时把 16s 的 provider-probe-matrix 排到最后一棒，等于让三条车道空等它。
 * 权重来自实测（`recordedAt`），缺失也有默认值兜底 —— 文件新加没登记时照样能跑，只是均衡度差一点。
 */
const UNIT_WEIGHTS_FILE = path.join(TESTS_DIR, 'unit-merge-weights.json')
/** 未登记文件 / 未登记批次的默认权重（ms）：按 unit 层中位数取，宁可高估不低估 */
const DEFAULT_UNIT_WEIGHT_MS = 800

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

/**
 * #366：并行车道数。unit 层默认吃满本机核数（上限 4，CI 4 核 / 本机 4 核都用得上，再多只是
 * 互相抢 CPU 且更容易把真计时用例挤成假红）；其他层默认仍是 1 —— 行为与 #365 接线时一模一样。
 * 用法：`--jobs 4` 或 `TEST_JOBS=4`（两者都在，CI 想按机器调不用改代码）。
 */
function resolveJobs(plan, explicit) {
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  const env = Number(process.env.TEST_JOBS)
  if (Number.isSafeInteger(env) && env > 0) return env
  if (!plan.includes('unit')) return 1
  return Math.min(availableParallelism(), 4)
}

/**
 * #366：一个文件能不能并进批次 —— 静态可判的那一条（源码读一次，缓存起来）：
 *
 * `node:test` 用例里调 `process.exit(`：会把同批其他文件的用例半路带走，结局不可归因，不合并。
 * 不用 `node:test` 的「自收摊脚本」**可以**合并 —— 合并入口把 `process.exit` 换成记账+哨兵，
 * 它只结束自己那个文件（见 helpers/merged-entry.mjs）。
 *
 * 其余「进程级资源」类（起子进程 / 真计时 / 要 APP_URL 注入）写在 UNIT_SOLO 里，人工维护。
 */
const mergeSourceCache = new Map()
async function mergeBlocker(file) {
  let source = mergeSourceCache.get(file)
  if (source === undefined) {
    try {
      source = await readFile(file, 'utf8')
    } catch {
      source = null
    }
    mergeSourceCache.set(file, source)
  }
  if (source === null) return '源码读不到'
  // 不用 node:test 的「自收摊脚本」现在是**可以合并**的：合并入口把 `process.exit` 换成记账+哨兵，
  // 它只结束自己那个文件（见 helpers/merged-entry.mjs）。唯一还挡的是「node:test 用例里调
  // process.exit」—— 那会把同批其他文件的用例半路带走，结局不可归因。
  if (/(?:from\s*|import\s*|require\(\s*)['"]node:test['"]/.test(source) && /process\.exit\s*\(/.test(source)) {
    return 'node:test 用例里调 process.exit'
  }
  return null
}

/**
 * #366：批次的**分组键** —— 同组的文件用同一套替身。
 *
 * 为什么不能按文件名顺序直接切段：`registerHooks` 装的解析 hook 在进程内只增不减，文件 N 注册的
 * stub 对 N 之后的文件照样生效。于是「A 把 `@capacitor/core` 换成了自己那份夹具，B 却要
 * `registerPlugin`」这种组合一合批就红（实测把 8 个域 8~10 的文件塞一批时，8 个文件同时红）。
 * 同组文件引用的是**同一个夹具目录**，替身集合一致，谁也不抢谁的。
 *
 * 键 = 源码里引用到的 `tests/fixtures/<目录>/` 集合（排序去重）；一个都不引用的（纯逻辑/
 * 只读源码）归到 `no-fixture`，彼此之间没有替身可抢。
 */
const harnessKeyCache = new Map()
async function harnessKey(file, source) {
  if (harnessKeyCache.has(file)) return harnessKeyCache.get(file)
  const dirs = new Set()
  for (const matched of source.matchAll(/fixtures\/([a-z0-9-]+)\//g)) dirs.add(matched[1])
  const key = dirs.size ? [...dirs].sort().join('+') : 'no-fixture'
  harnessKeyCache.set(file, key)
  return key
}

/**
 * #366：把「逐文件选择集」折成「工作单元」：静态不可合并 / UNIT_SOLO 的原样单文件，
 * 其余按夹具家族归桶、每 UNIT_BATCH_SIZE 个一批。返回顺序=执行顺序（长任务先起跑）。
 */
async function buildWorkUnits(planned, weights) {
  const units = []
  let pending = []
  const weightOf = (item) => {
    const ms = Number(weights[path.basename(item.file)]?.ms)
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_UNIT_WEIGHT_MS
  }
  const flush = () => {
    if (!pending.length) return
    units.push({ merged: pending.length > 1, items: pending, weightMs: pending.reduce((sum, item) => sum + weightOf(item), 0) })
    pending = []
  }
  // 按分组键归桶（桶内保持原顺序：同域文件挨着，出问题好定位）
  const buckets = new Map()
  for (const item of planned) {
    const base = path.basename(item.file)
    const blocker = item.layer === 'unit'
      ? (UNIT_SOLO.has(base) ? 'solo' : await mergeBlocker(item.file))
      : 'not-unit'
    if (blocker) {
      units.push({ merged: false, items: [item], weightMs: weightOf(item) })
      continue
    }
    const source = mergeSourceCache.get(item.file) ?? ''
    const key = await harnessKey(item.file, source)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(item)
  }
  // 桶内每 UNIT_BATCH_SIZE 个一批；桶之间不混（混了就回到「抢替身」的老问题）
  for (const items of buckets.values()) {
    for (let index = 0; index < items.length; index += UNIT_BATCH_SIZE) {
      pending = items.slice(index, index + UNIT_BATCH_SIZE)
      flush()
    }
  }
  // 长任务先起跑（LPT）：车道少的时候，把最重的那几个压到最后等于让其他车道空等
  return units.sort((a, b) => b.weightMs - a.weightMs)
}

/** 读权重表（缺失/损坏不是错误：退化成同权重，照跑不误） */
async function loadUnitWeights() {
  try {
    const parsed = JSON.parse(await readFile(UNIT_WEIGHTS_FILE, 'utf8'))
    return { files: parsed.files ?? {}, recordedAt: parsed.recordedAt ?? '未注明' }
  } catch {
    return { files: {}, recordedAt: null }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  let layer, only = '', caseName = '', json, failedFrom, timeoutMs = 180000, shard = null, jobs
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--only', '--case', '--json', '--failed-from', '--timeout-ms', '--shard', '--jobs'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`)
      if (arg === '--only') only = value
      if (arg === '--case') caseName = value
      if (arg === '--json') json = value
      if (arg === '--failed-from') failedFrom = value
      if (arg === '--timeout-ms') timeoutMs = Number(value)
      if (arg === '--shard') shard = parseShard(value)
      if (arg === '--jobs') jobs = Number(value)
    } else if (['--bail', '--list', '--baseline', '--write-weights'].includes(arg)) flags.add(arg)
    else if (!arg.startsWith('-') && !layer) layer = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout-ms must be a positive integer')
  if (jobs !== undefined && (!Number.isSafeInteger(jobs) || jobs < 1)) throw new Error('jobs must be a positive integer')
  const plan = layer === 'all' ? ['unit', 'regression', 'integration'] : [layer]
  if (plan.some((name) => !LAYERS.includes(name))) throw new Error('Usage: node tests/run-layer.mjs <unit|integration|regression|e2e|device|all> [--only substring] [--case exact-path] [--shard 1/3] [--jobs N] [--timeout-ms 180000] [--json result.json] [--failed-from result.json] [--bail] [--list]')
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
  // 并发跑时多个 worker 会同时要它：缓存的是 **promise**，不是结果，避免起两份服务。
  let sharedStd = null
  let sharedStdPending = null
  const ensureSharedStd = async () => {
    if (sharedStd) return sharedStd
    sharedStdPending ??= (async () => {
      const dir = standardDistDir()
      const served = await serveDir(dir, { port: 0, label: '共享标准产物 dist-standard' })
      console.log(`
共享标准产物服务：${dir} → ${served.url}`)
      sharedStd = served
      return served
    })()
    return sharedStdPending
  }

  /**
   * #366：把选择集折成「工作单元」。合并只对 unit 层生效 —— integration 刚接 CI（#365）不动，
   * e2e / device 本来就是长任务 + 真实浏览器，串行才看得懂。
   * `--case` / `--failed-from` 会把批次拆开：重跑提示给的是单文件命令，单文件必须能单独跑通。
   */
  const lanes = resolveJobs(plan, jobs)
  const unitWeights = await loadUnitWeights()
  const work = await buildWorkUnits(planned, unitWeights.files)

  // 每个工作单元跑完再整段打印：并行时几个文件的日志交错成一团既看不出失败在哪，也不好粘进 Issue
  const emit = (text) => process.stdout.write(text)
  const runUnit = async (unit) => {
    const log = []
    const say = (line) => { if (lanes === 1) process.stdout.write(`${line}\n`) ; else log.push(line) }
    const startedUnit = performance.now()
    if (!unit.merged) {
      const item = unit.items[0]
      say(`\n>> ${rel(item.file)} (timeout ${timeoutMs}ms)`)
      const env = { ...process.env }
      const base = path.basename(item.file)
      if (SELF_SERVED.has(base)) env.APP_URL = ''
      else if (APP_URL_FILES.has(base) && !process.env.APP_URL) env.APP_URL = (await ensureSharedStd()).url
      // 要 standard 变体却读 DIST_DIR 的用例：指到标准产物，别让它们对着内测包 SKIP(env)（#365）
      if (STANDARD_DIST_DIR_FILES.has(base) && !process.env.DIST_DIR) env.DIST_DIR = standardDistDir()
      const result = await runCase(item.file, { cwd: ROOT, env, timeoutMs, output: lanes === 1 })
      if (lanes !== 1 && result.output) log.push(result.output)
      const skipped = result.code === SKIP_CODE
      const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(result.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
      const status = result.ok ? 'PASS' : skipped ? 'SKIP(env)' : result.timedOut ? 'TIMEOUT' : 'FAIL'
      say(`<< ${status} ${rel(item.file)} (${result.ms}ms)`)
      if (skipped) say(`   ↳ ${skipReason}`)
      return {
        results: [{ layer: item.layer, file: rel(item.file), ...result, skipped, skipReason }],
        log: log.join(''),
        interrupted: result.interrupted,
        failed: !result.ok && !skipped,
      }
    }
    // 合并批次：一次进程跑 N 个文件，逐文件结局从 merged-entry 的 `<< FILE` 收尾行还原
    const files = unit.items.map((item) => item.file)
    say(`\n>> 合并批次 ${unit.items.length} 个文件 (timeout ${timeoutMs}ms/批)`)
    for (const item of unit.items) say(`   · ${rel(item.file)}`)
    const result = await runMergedBatch(files, { cwd: ROOT, env: { ...process.env }, timeoutMs, output: lanes === 1 })
    if (lanes !== 1 && result.output) log.unshift(result.output)
    const byFile = new Map(result.files.map((entry) => [entry.file, entry]))
    const unitResults = []
    for (const item of unit.items) {
      const name = rel(item.file)
      const entry = byFile.get(name)
      if (!entry) {
        // 没有收尾行 = 这个文件没跑完（import 抛错 / 进程被杀 / 超时）。不许当成通过。
        const reason = result.timedOut ? '批超时，该文件未跑完' : '批内崩溃，该文件未跑完'
        unitResults.push({
          layer: item.layer, file: name, ok: false, skipped: false, skipReason: '',
          code: result.code, signal: result.signal, timedOut: result.timedOut, interrupted: result.interrupted,
          error: reason, skips: 0, skipDetails: [], ms: 0, tail: result.tail, merged: true,
        })
        say(`<< FAIL ${name}（${reason}）`)
        continue
      }
      const skipped = entry.outcome === 'SKIP'
      unitResults.push({
        layer: item.layer, file: name, ok: entry.ok, skipped,
        skipReason: skipped ? '批内全部用例自带 SKIP' : '',
        code: entry.ok ? 0 : 1, signal: null, timedOut: false, interrupted: result.interrupted, error: null,
        skips: entry.skip, skipDetails: entry.skipDetails ?? [], tests: entry.tests, pass: entry.pass,
        fail: entry.fail, ms: entry.ms, tail: [], merged: true,
      })
      const status = entry.outcome === 'PASS' ? 'PASS' : entry.outcome === 'FAIL' ? 'FAIL' : 'SKIP'
      say(`<< ${status} ${name} (${entry.ms}ms, ${entry.tests} 用例)`)
    }
    // 批次里有红：**不能直接相信** —— 合并的前提是「文件之间零串扰」，红了要么是真红，要么
    // 是这个批次不该合在一起（模块级装配互相影响 / 用例依赖 event loop 的时序）。于是把这几个
    // 文件按**单文件进程**（合并之前的老跑法）重跑一遍，结果以单文件为准：
    //   · 单跑绿 → 批次不兼容（打印 ⚠，建议把可疑文件登记进 UNIT_SOLO）
    //   · 单跑红 → 真红，照旧上报
    const reds = unitResults.filter((entry) => !entry.ok && !entry.skipped)
    if (reds.length) {
      say(`\n⚠ 批次 ${unit.items.length} 个文件里 ${reds.length} 个红了：改按单文件进程重跑这几个（结果以单文件为准）`)
      for (const red of reds) {
        const item = unit.items.find((candidate) => rel(candidate.file) === red.file)
        const env = { ...process.env }
        const single = await runCase(item.file, { cwd: ROOT, env, timeoutMs, output: lanes === 1 })
        if (lanes !== 1 && single.output) log.push(single.output)
        const skipped = single.code === SKIP_CODE
        const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(single.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
        const status = single.ok ? 'PASS' : skipped ? 'SKIP(env)' : single.timedOut ? 'TIMEOUT' : 'FAIL'
        say(`<< ${status} ${red.file}（单文件重跑${red.ok === single.ok ? '' : '，与批内结果不同'}）(${single.ms}ms)`)
        const index = unitResults.findIndex((entry) => entry.file === red.file)
        unitResults[index] = {
          ...unitResults[index],
          ...single,
          file: red.file,
          layer: item.layer,
          skipped,
          skipReason,
          merged: false,
          batchFallback: true,
        }
      }
    }
    return {
      results: unitResults,
      log: log.join(''),
      interrupted: result.interrupted,
      failed: unitResults.some((entry) => !entry.ok && !entry.skipped),
    }
  }

  const mergedUnits = work.filter((unit) => unit.merged).length
  console.log(
    `unit 工作单元：${planned.length} 个文件 → ${work.length} 个进程（${mergedUnits} 批合并 ${work.filter((unit) => unit.merged).reduce((sum, unit) => sum + unit.items.length, 0)} 个文件 + ${work.length - mergedUnits} 个单文件），${Math.min(lanes, work.length)} 条车道`,
  )
  // 工作单元池：jobs=1 就是原来的顺序跑法（输出实时转发）；jobs>1 时按条缓冲、跑完再整段打印
  const outcomes = []
  const queue = [...work]
  const worker = async () => {
    for (;;) {
      if (interrupted) return
      const unit = queue.shift()
      if (!unit) return
      const outcome = await runUnit(unit)
      if (lanes !== 1) emit(`${outcome.log}\n`)
      outcomes.push(...outcome.results)
      if (outcome.interrupted) { interrupted = true; return }
      if (outcome.failed && flags.has('--bail')) { interrupted = true; return }
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, work.length) }, worker))
  sharedStd?.kill()
  // 结果按选择顺序归位：并行完成顺序不确定，报告顺序必须稳定
  const order = new Map(planned.map((item, index) => [rel(item.file), index]))
  results.push(...outcomes.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0)))
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
  // #366：把这次实测的逐文件耗时写进权重表（只影响「谁先起跑」的排序，不影响覆盖率）。
  // 更新方式：`node tests/run-layer.mjs unit --write-weights`，别手改这个 JSON。
  if (flags.has('--write-weights') && plan.includes('unit')) {
    const files = {}
    for (const r of results) {
      const name = path.basename(r.file)
      if (files[name]) continue
      files[name] = { ms: Math.round(r.merged ? (r.ms ?? 0) : (r.ms ?? 0)) }
    }
    const payload = {
      version: 1,
      recordedAt: new Date().toISOString().slice(0, 10),
      note: '由 `node tests/run-layer.mjs unit --write-weights` 实测生成，只用于工作单元排序（LPT），不影响是否被跑到。',
      files,
    }
    await writeFile(UNIT_WEIGHTS_FILE, JSON.stringify(payload, null, 1) + '\n')
    console.log(`已更新 unit 层权重表：${rel(UNIT_WEIGHTS_FILE)}（${Object.keys(files).length} 个文件）`)
  }
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
