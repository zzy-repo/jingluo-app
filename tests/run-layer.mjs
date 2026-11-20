#!/usr/bin/env node
// Sequential adapter for legacy self-executing scripts and node:test files.
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { cpus, freemem, hostname, loadavg, tmpdir, totalmem, availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase, runMergedBatch } from './helpers/runtime.mjs'
import { serveDir } from './helpers/env.mjs'
import {
  DEFAULT_POLICY,
  KINDS,
  TRI_STATE_ACTION,
  buildRunRecord,
  dayOf,
  describeEntry,
  dueReminders,
  emptyRegistry,
  isQuarantined,
  isRecurringRed,
  normalizeRegistry,
  recordCrossRunner,
  recordFlaky,
  recordPass,
  recordRecurringRed,
  resolveRunnerIdentity,
  scanCrossRunner,
  scanTimingWindows,
  summarizeTriState,
  triStateOf,
} from '../scripts/flaky-registry.mjs'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')
/**
 * 已接线的层。#368：`regression` 补进来 —— tests/regression/ 那 11 个文件（纯 Node，无浏览器/网络）
 * 一直写好放在仓库里，却既不在 LAYERS 也不在 CI 引用里，等于整层从未执行；`issue-135` 因此
 * 死了很久（import 了 #331 已删除的 `startCheckout`）也没人发现。CI 接线见 #365。
 *
 * #415：`server` 补进来 —— `deploy/dl-release/test/` 的用例（#441 起 37 条；变体解析 / APK debuggable /
 * 服务端 buildType 门禁 / 上传契约矩阵）同样是「全绿但零入口」：不在 LAYERS、CI 无步骤。
 * 这一层没有对应的 `tests/server/` 目录，用例目录由下面的 `LAYER_DIRS` 指到 deploy/ 下
 * （为什么不搬：见那里的注释）。枚举口径与其它层一致，`node tests/run-layer.mjs server` 可跑。
 */
const LAYERS = ['unit', 'integration', 'regression', 'server', 'e2e', 'device']
/**
 * #415：层级 → 用例目录。默认就是 `tests/<层>/`，唯一的例外是 `server`：
 * `deploy/dl-release/test/*.test.mjs` 与被测实现（`deploy/dl-release/*.mjs`）**同目录** ——
 * 用例按 `import ... from '../apk-manifest.mjs'`、`path.resolve(HERE, '..', 'server.mjs')` 取被测物，
 * 并读同目录的 `xmltree-fixtures/` 真 aapt2 输出。搬进 `tests/` 要同时改断这些相对引用、
 * `deploy/README.md` 与 `docs/testing/coverage/domain-10.md` 的路径，收益只是目录好看；
 * 所以 #415 的取舍是「留在原地 + 让它真的被跑到」，而不是搬家。
 * 与之配套：`scripts/check-test-layout.mjs` 的 `EXTRA_TEST_DIRS` 有一条同名白名单条目
 * （带理由、不可免检）—— 该目录里新增一个用例却没被这一层枚举到，照样判 orphan 红。
 */
const LAYER_DIRS = { server: path.join(ROOT, 'deploy/dl-release/test') }
/** 某一层对应的用例目录（默认 tests/<层>，`server` 见 LAYER_DIRS） */
const layerDirOf = (name) => LAYER_DIRS[name] ?? path.join(TESTS_DIR, name)
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
  'domain03-provider-probe-matrix.test.mjs', 'check-capabilities.test.mjs', 'capabilities-docs-sync.test.mjs',
  // 要 runner 注入 APP_URL / DIST_DIR / SELF_SERVED
  'quota-exhausted.test.mjs', 'feedback-export.test.mjs', 'legacy-bundle-target.test.mjs',
  // 读仓库/产物文件、起真实静态服务
  'matrix-config.test.mjs', 'shot-mobile.test.mjs',
].map((s) => s))

/**
 * #366：unit 层的「工作单元耗时权重」。只用来**排序**（长任务先起跑），不影响覆盖率：
 * 车道少时把 16s 的 domain03-provider-probe-matrix 排到最后一棒，等于让三条车道空等它。
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
/**
 * #406：flaky 登记簿 + 失败自动重跑一次。
 *
 * 为什么要重跑：红过一次的用例如果是**时序/端口/首帧**一类的偶发，直接红会把「真红」淹没在噪音里；
 * 重跑一次能把偶发和稳定红分开。为什么必须登记：重跑通过**不等于**没问题 —— 名单必须留痕
 * （终端 + job summary + 本文件），连续 3 次进 quarantine（跳过但每周提醒），
 * 21 天内复发 ≥2 次就当红处理（禁止用重跑洗白真红，规则见 docs/TESTING-POLICY.md 第 10 节）。
 */
const FLAKY_FILE = path.join(TESTS_DIR, 'flaky-registry.json')
/**
 * #456：跨 runner 判定要的**运行记录**目录。每个 run 在这里留一份「同 commit 上这台 runner 跑出了
 * 什么」的原始事实（`{ commit, runner, results[] }`），跨 runner 判据（`scanCrossRunner`）就是拿它们
 * 互相比。为什么落到磁盘而不是只在内存里：判据要能看见**别的机器**、以及**同 SHA 的另一次 attempt**
 * —— 那些结果根本不在本进程里。
 *
 * CI 里由 ci.yml 给 `FLAKY_RUNS_DIR`（各分片写进 workspace，作为 artifact 上传，再由
 * `flaky-cross-runner` job 汇总下载）；本地默认 `.flaky-runs/`（已在 .gitignore，不入库）。
 */
const FLAKY_RUNS_DIR = process.env.FLAKY_RUNS_DIR ? path.resolve(process.env.FLAKY_RUNS_DIR) : path.join(ROOT, '.flaky-runs')
/** 写进 GitHub Actions 的 job summary（有就写，没有就不写；不依赖 ci.yml 改动） */
const STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY ?? ''
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/**
 * #456：本次 run 的 runner 身份（判据里「runner 不同」的那一维）。
 *
 * 机器事实在这里取一次（`os` 的 hostname / loadavg / cpus / freemem），判据本身是纯函数
 * （`resolveRunnerIdentity`），所以 `tests/unit/flaky-registry.test.mjs` 能不用真机器就把它钉死。
 */
const runnerIdentity = () =>
  resolveRunnerIdentity({
    env: process.env,
    hostname: hostname(),
    loadavg: loadavg(),
    cpus: cpus().length,
    freeMemMb: Math.round(freemem() / 1024 / 1024),
  })

/** 本次 run 对应的 commit（跨 runner 判据的分组键）。拿不到就是 `unknown`，不会因此失败 */
function currentCommit() {
  const fromEnv = process.env.GITHUB_SHA || process.env.GIT_COMMIT
  if (fromEnv) return String(fromEnv).slice(0, 12)
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 12)
  } catch {
    return 'unknown'
  }
}

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
 *
 * #487：**再加一层内存约束**。实测（本仓 unit 层，16 文件/批）：一个合并批次进程峰值 RSS ≈ 250 MB，
 * 单文件进程 ≈ 120 MB，共享标准产物服务另算；N 条车道并发时峰值 ≈ N × 320 MB。车道数只看核数时，
 * 4 核但只剩 1 GB 可用内存的机器上并发批次会把内存吃光，内核 OOM killer 挑最大的进程杀掉 ——
 * runner 只看到「批次进程没跑完」，于是把**资源不足误报成测试失败**（本单的故障）。
 * 所以默认车道数 = min(核数上限 4, 内存预算)，并在终端写明算出来的理由（不许悄悄降）。
 */
const LANE_RSS_ESTIMATE_MB = 320
const HOST_MEMORY_RESERVE_MB = 768

/** 当前可用内存与「能安全开几条车道」（导出给 resolveJobs 与车道日志共用） */
function memoryLaneBudget() {
  const availableMb = Math.floor(freemem() / (1024 * 1024))
  const lanes = Math.max(1, Math.floor(Math.max(0, availableMb - HOST_MEMORY_RESERVE_MB) / LANE_RSS_ESTIMATE_MB))
  return { availableMb, totalMb: Math.floor(totalmem() / (1024 * 1024)), lanes }
}

function resolveJobs(plan, explicit) {
  const mem = memoryLaneBudget()
  if (!plan.includes('unit')) return { lanes: 1, why: '非 unit 层：串行（#365 行为不变）' }
  const cores = availableParallelism()
  if (Number.isSafeInteger(explicit) && explicit > 0) {
    return { lanes: explicit, why: `--jobs ${explicit} 显式指定（不按内存改；超过内存预算 ${mem.lanes} 时崩溃会被自动降级并留痕）` }
  }
  const env = Number(process.env.TEST_JOBS)
  if (Number.isSafeInteger(env) && env > 0) {
    return { lanes: env, why: `TEST_JOBS=${env} 显式指定（不按内存改；超过内存预算 ${mem.lanes} 时崩溃会被自动降级并留痕）` }
  }
  const lanes = Math.max(1, Math.min(Math.min(cores, 4), mem.lanes))
  return { lanes, why: `核 ${cores}（上限 4）· 可用内存 ${mem.availableMb}/${mem.totalMb} MB（每车道估 ${LANE_RSS_ESTIMATE_MB} MB + 预留 ${HOST_MEMORY_RESERVE_MB} MB → 预算 ${mem.lanes} 条）` }
}

/**
 * #487：子进程的内存上限。V8 默认按「物理内存的一半」（64 位上封顶 4 GB）算堆上限 ——
 * 一个失控的批次足以吃干净整台机器，然后被内核按限额杀掉，日志里只剩一个 `Killed`，
 * 谁也看不出是内存。这里给每个用例子进程一个**明确可见**的上限：
 *   · 超限 → V8 打 `FATAL ERROR: Reached heap limit ... JavaScript heap out of memory`，
 *     run-layer 据此判成 `oom`（可降级复跑、可指名报告），而不是「测试断言失败」；
 *   · `TEST_CHILD_HEAP_MB` 可覆盖；用户自己在 `NODE_OPTIONS` 里设了就不抢。
 */
const CHILD_HEAP_FLOOR_MB = 1024
const CHILD_HEAP_CEIL_MB = 4096
function childHeapPlan() {
  const explicit = Number(process.env.TEST_CHILD_HEAP_MB)
  if (Number.isSafeInteger(explicit) && explicit > 0) return { mb: explicit, source: 'TEST_CHILD_HEAP_MB', inject: true }
  // 用户自己在 NODE_OPTIONS 里设了就别抢：那是显式意志（子进程会继承同一个值）
  const inherited = /--max-old-space-size=(\d+)/.exec(process.env.NODE_OPTIONS ?? '')
  if (inherited) return { mb: Number(inherited[1]), source: 'NODE_OPTIONS', inject: false }
  const { availableMb } = memoryLaneBudget()
  const mb = Math.min(CHILD_HEAP_CEIL_MB, Math.max(CHILD_HEAP_FLOOR_MB, Math.floor(availableMb * 0.4)))
  return { mb, source: `按可用内存 ${availableMb} MB × 0.4 自动`, inject: true }
}

/**
 * #487：**「进程怎么死的」和「用例断言怎么红的」是两件事。**
 *
 * 以前两种情况在报告里是同一句话（`批内崩溃，该文件未跑完`），于是「内存不足 / 被内核杀掉 /
 * 还没跑到断言就 exit」全被当成测试失败 —— 每个 PR 的 CI 随机变红。这里按**证据**分类：
 * 只有分类结果是「用例自己红了」才判失败，`oom` / `killed` 先走降级复跑。
 */
const OOM_SIGNATURES = [
  /FATAL ERROR: Reached heap limit/i,
  /JavaScript heap out of memory/i,
  /Allocation failed/i,
  /ERR_WORKER_OUT_OF_MEMORY/,
  /Cannot allocate memory/i,
  /std::bad_alloc/,
]
const isOomText = (text) => OOM_SIGNATURES.some((pattern) => pattern.test(text))
/** 从被截断的 stderr 里挑出「有用的那几行」（跳过 `<--- Last few GCs --->` 那种噪音） */
function stderrExcerpt(text, limit = 12) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim())
  if (!lines.length) return []
  // 内存类：稳定命中 `FATAL ERROR: Reached heap limit …` 那一行开始的一小段
  //（tail 里混着 stdout 的 TAP 行，取「最后 N 行」会正好错过它 —— 实测过）
  const oom = lines.findIndex((line) => isOomText(line))
  if (oom >= 0) return lines.slice(oom, oom + Math.min(6, limit))
  const hit = lines.findIndex((line) => /Error|error:|ERR_|Killed|not found|Cannot|FATAL/.test(line))
  const from = hit >= 0 ? Math.max(0, hit - 1) : Math.max(0, lines.length - limit)
  return lines.slice(from, from + limit)
}
/**
 * 返回 `{ kind, label, excerpt }`：
 *   · `timeout`  批/用例超时
 *   · `oom`      堆上限触顶（V8 FATAL）或外部 OOM（Cannot allocate memory）
 *   · `killed`   被 SIGKILL 杀掉（exit 137，常见于系统内存不足时的内核 OOM killer）
 *   · `signal`   其它信号（SIGSEGV / SIGABRT 没有 OOM 文本）
 *   · `exit`     以非 0 码退出、但没有收尾行
 */
function classifyDeath(result) {
  const text = (result?.tail ?? []).join('')
  const excerpt = stderrExcerpt(text)
  if (result?.timedOut) return { kind: 'timeout', label: '超时（timeout，进程被 runner 停掉）', excerpt }
  if (isOomText(text)) return { kind: 'oom', label: '内存不足（V8 堆上限触顶 / 分配失败）', excerpt }
  if (result?.signal === 'SIGKILL' || result?.code === 137) {
    return { kind: 'killed', label: '被信号 SIGKILL 终止（exit 137，通常是系统内存不足时内核 OOM killer 挑中）', excerpt }
  }
  if (result?.signal) return { kind: 'signal', label: `被信号 ${result.signal} 终止`, excerpt }
  if (typeof result?.code === 'number' && result.code !== 0) return { kind: 'exit', label: `进程异常退出（exit ${result.code}），没跑到收尾行`, excerpt }
  return { kind: 'unknown', label: '进程没跑到收尾行就结束了', excerpt }
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

// ───────────────────────────── Issue #456：跨 runner 判据的接线 ─────────────────────────────

/** 运行记录文件名：同 commit + 同 runner + 同层 + 同分片是同一个格子（重跑覆盖它，目录不会无限膨胀） */
const recordFileName = (commit, identity, shard, layer = 'all') =>
  `run-${commit}-${layer.replace(/[^a-zA-Z0-9._+-]+/g, '_')}-${identity.id.replace(/[^a-zA-Z0-9._@#-]+/g, '_')}${shard ? `-shard${shard.index}` : ''}.json`

/** 读运行记录目录（半截文件 / 陌生版本直接跳过：判据的输入坏了不该让整轮测试起不来） */
async function readRunRecords(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      if (parsed && parsed.object === 'flaky-run-record') records.push(parsed)
    } catch { /* 写了一半 / 不是我们的文件：跳过 */ }
  }
  return records
}

/** 目录的显示名：仓库内给相对路径，仓库外（CI 的 artifact 下载目录 / 临时目录）给绝对路径 */
const dirLabel = (dir) => {
  const relative = rel(dir)
  return relative.startsWith('..') ? dir : relative
}

/** 一条观测的指纹：同一份证据重复登记只会让 count 虚高，不会让结论更可信 */
const evidenceKey = (item) => `${item.commit}|${item.runner}|${item.at}|${item.ok ? 'ok' : 'red'}`

/** 这条分叉的证据是否已经全在登记簿里（是 → 不重复登记） */
const alreadyRecorded = (entry, group) => {
  const seen = new Set((entry?.evidence ?? []).map(evidenceKey))
  return group.evidence.every((item) => seen.has(evidenceKey(item)))
}

/**
 * #456 §1：本轮记录落盘 + 跨 runner 聚合 + 登记。
 *
 * 返回 `{ all, registered, records }`：
 *   · `all` 是本轮记录目录里**所有**分叉（含此前已登记过的）—— 三态判定要用全量，
 *     否则「已经登记过」的条目下一轮就看不见了；
 *   · `registered` 是这一轮**新**落进登记簿的（终端与 summary 只说新发现，避免刷屏）。
 */
async function registerCrossRunner({ registry, plan, shard, identity, commit, results, startedAt, totalMs, recordDir, writeRecord, today }) {
  if (writeRecord) {
    const record = buildRunRecord({
      layer: plan.join('+'),
      shard: shard ? `${shard.index}/${shard.count}` : null,
      runner: identity,
      commit,
      results,
      startedAt,
      totalMs,
    })
    await mkdir(recordDir, { recursive: true }).catch(() => {})
    await writeFile(path.join(recordDir, recordFileName(commit, identity, shard, plan.join('+'))), `${JSON.stringify(record, null, 2)}\n`)
      .catch((error) => {
        // 写不进去不是错误：判据退化成「只看得到别的 runner 已落盘的记录」，终端里点名即可。
        console.log(`\n⚠ 运行记录写入失败（${error.message}）：跨 runner 判据看不到本轮的证据`)
      })
  }
  const records = await readRunRecords(recordDir)
  const all = scanCrossRunner(records).filter((item) => item.commit === commit)
  const registered = []
  for (const group of all) {
    if (alreadyRecorded(registry.tests[group.test], group)) continue
    recordCrossRunner(registry, group.test, {
      today,
      runners: group.runners,
      evidence: group.evidence,
      commit: group.commit,
      reason: `红：${group.redRunners.join(', ')} / 绿：${group.greenRunners.join(', ')}`,
    })
    registered.push(group)
  }
  return { all, registered, records }
}

/**
 * #456 §3：时序窗口静态提示（警告级、不阻塞）—— 扫本轮选中用例的源码。
 * 只报告不判红：这类写法是要「改」的，不是要「卡」的；卡住它只会让人把断言写得更松。
 */
async function scanTimingWarnings(items) {
  const found = []
  for (const item of items) {
    let source
    try {
      source = await readFile(item.file, 'utf8')
    } catch {
      continue
    }
    const findings = scanTimingWindows(source)
    if (findings.length) found.push({ file: rel(item.file), layer: item.layer, findings })
  }
  return found.sort((a, b) => b.findings.length - a.findings.length || a.file.localeCompare(b.file))
}

/**
 * #456：`--cross-runner-scan` —— 只做「聚合 + 判定 + 登记 + summary」，一条用例都不跑。
 *
 * 为什么单独一个入口：CI 里「哪个分片红了」和「同 SHA 的另一次 attempt / 另一台机器绿了」是两份
 * 互不相干的 artifact，只有把它们下载到一起才判得出「runner-dependent」。这条命令就是那个聚合点。
 */
async function crossRunnerScan({ recordDir, registryPath, json }) {
  let registry = emptyRegistry()
  try {
    registry = normalizeRegistry(JSON.parse(await readFile(registryPath, 'utf8')))
  } catch { /* 没有登记簿：用空簿继续 */ }
  const today = dayOf()
  const records = await readRunRecords(recordDir)
  const all = scanCrossRunner(records)
  const registered = []
  for (const group of all) {
    if (alreadyRecorded(registry.tests[group.test], group)) continue
    recordCrossRunner(registry, group.test, {
      today,
      runners: group.runners,
      evidence: group.evidence,
      commit: group.commit,
      reason: `红：${group.redRunners.join(', ')} / 绿：${group.greenRunners.join(', ')}`,
    })
    registered.push(group)
  }
  const commits = [...new Set(records.map((item) => item.commit))].sort()
  const runners = [...new Set(records.map((item) => item.runner?.id).filter(Boolean))].sort()
  console.log(`\n跨 runner 扫描：${records.length} 份运行记录（${commits.length} 个 commit / ${runners.length} 个 runner）来自 ${dirLabel(recordDir)}`)
  for (const item of records) console.log(`  record  ${item.commit}  ${item.runner?.id}  ${item.results?.length ?? 0} 条结果  ${item.startedAt}`)
  if (!all.length) {
    console.log('结论：没有「同 commit + 同用例 + 结果不同 + runner 不同」的分叉（判据没有空跑以外的输出）。')
  } else {
    console.log(`\nCROSS-RUNNER（runner-dependent，${all.length} 条分叉；本轮新登记 ${registered.length} 条）`)
    for (const group of all) {
      const isNew = registered.includes(group)
      console.log(`  ${isNew ? 'NEW  ' : '已知 '} ${group.test}（commit ${group.commit}）`)
      console.log(`        红：${group.redRunners.join(', ')}`)
      console.log(`        绿：${group.greenRunners.join(', ')}`)
      console.log(`        ⟹ 处置：${TRI_STATE_ACTION['runner-dependent']}`)
    }
  }
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    recordDir: dirLabel(recordDir),
    records: records.map((item) => ({ commit: item.commit, runner: item.runner?.id, results: item.results?.length ?? 0, startedAt: item.startedAt })),
    commits,
    runners,
    crossRunner: all,
    registered: registered.map((item) => ({ test: item.test, commit: item.commit })),
  }
  if (json) await writeFile(path.resolve(json), `${JSON.stringify(payload, null, 2)}\n`)
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`).catch((error) => {
    console.log(`\n⚠ flaky 登记簿写入失败（${error.message}）：本轮结论只在终端与 --json 报告里`)
  })
  if (STEP_SUMMARY) {
    const lines = ['## 跨 runner 判定（flaky cross-runner scan）', '']
    lines.push(
      `运行记录：${records.length} 份 / ${commits.length} 个 commit / ${runners.length} 个 runner（\`${dirLabel(recordDir)}\`）。`,
      '',
      `| 判定 | 数量 | 处置 |`,
      `| --- | --- | --- |`,
      `| runner-dependent（跨 runner 结论不一致） | ${all.length} | ${TRI_STATE_ACTION['runner-dependent']} |`,
      `| 本轮新登记 | ${registered.length} | 写进 \`tests/flaky-registry.json\`（kind: cross-runner） |`,
    )
    if (all.length) {
      lines.push('', '### 结论不一致的用例', '')
      for (const group of all) {
        lines.push(`- \`${group.test}\`（commit ${group.commit}）：红 ${group.redRunners.join(', ')} / 绿 ${group.greenRunners.join(', ')}`)
      }
      lines.push('', `> 红线：这类用例**必须改成等终态**（until 轮询），不允许加 \`sleep\` / 提高超时把窗口撑开。见 docs/TESTING-POLICY.md §11.5。`)
    } else {
      lines.push('', '没有跨 runner 分叉：本轮各 runner 对同一 commit 的结论一致（不等于是「没有 flaky」，只是没观测到分叉）。')
    }
    if (!records.length) {
      lines.push('', '⚠ 没有读到任何运行记录：分片 artifact 没上传 / 下载失败时就会这样，**结论不可用**（不是「全绿」）。')
    }
    await appendFile(STEP_SUMMARY, `${lines.join('\n')}\n`).catch(() => {})
  }
  return 0
}

/**
 * #456 自证（`--selftest-cross-runner`）：造一个**只在慢环境红**的用例，用两个负载档各跑一次，
 * 证明它被判成 `cross-runner` 并登记；再用两组反向对照证明判据不是「见到红就登记」。
 *
 * 六拍（[1]~[3] 是正向、[4]~[5] 是负向对照，缺一条都说明判据可能是空跑）：
 *   [1] 快 runner（负载 idle）绿 + [2] 慢 runner（负载 busy）红 → 同 commit / 同用例 / 结果不同 / runner 不同
 *   [3] → 判据命中，登记成 kind: "cross-runner"（runners 两条、evidence 两条、不进隔离区）
 *   [4] 两个 runner **都红** → 结论一致 → **不**登记（否则「都红」会被说成 flake）
 *   [5] 同一个 runner 红 → 绿 → 那是 same-runner flaky，**不**算 cross-runner（两条判据不能混）
 *   [6] 静态提示：这条自证用例必须被判出「靠时间而不是靠终态」的写法（sleep）
 *
 * 自证用例写在临时目录（不进仓库）：它本身就是一条「坏用例」，留在仓库里会用错误示范教人写测试。
 */
async function selftestCrossRunner({ recordDir }) {
  const workdir = await mkdtemp(path.join(tmpdir(), 'flaky-selftest-456-'))
  const caseFile = path.join(workdir, 'slow-window.test.mjs')
  const beats = []
  const stamp = (name) => `${workdir}/${name}`
  /**
   * 自证用例：一个「可注入延迟把窗口调窄」的时序断言。
   *   · `SELFTEST_CLICK_DELAY_MS` 模拟「看到中间态之后把取消点下去」的延迟（机器越快越小）；
   *   · `SELFTEST_WINDOW_MS` 是产品中间态窗口（固定）。
   * 快机器上 delay < window → 绿；慢机器上 delay > window → 红。**只有机器快慢这一个变量**。
   */
  await writeFile(caseFile, `import { test } from 'node:test'
import assert from 'node:assert/strict'

// #456 自证用例（临时文件，不入库）：只在慢环境红的时序断言
const CLICK_DELAY_MS = Number(process.env.SELFTEST_CLICK_DELAY_MS ?? '5')
const WINDOW_MS = Number(process.env.SELFTEST_WINDOW_MS ?? '100')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('取消点必须落在「导入中」窗口内（只在慢环境红）', async () => {
  const started = performance.now()
  await sleep(CLICK_DELAY_MS)
  const latency = performance.now() - started
  assert.ok(latency < WINDOW_MS, \`取消点晚于中间态窗口：latency=\${Math.round(latency)}ms window=\${WINDOW_MS}ms（慢环境才会发生）\`)
})
`, 'utf8')

  /** 在指定的「runner」（负载档 + 注入延迟）上跑一次自证用例，返回一条运行记录 */
  const runOn = async ({ load, delay, windowMs = 100, dir, commit = 'selftest456' }) => {
    const env = {
      ...process.env,
      TEST_RUNNER_LOAD: load,
      SELFTEST_CLICK_DELAY_MS: String(delay),
      SELFTEST_WINDOW_MS: String(windowMs),
    }
    const result = await runCase(caseFile, { cwd: ROOT, env, timeoutMs: 60000, output: false })
    const identity = resolveRunnerIdentity({ env, hostname: 'selftest-box', loadavg: [0, 0, 0], cpus: 4 })
    const record = buildRunRecord({
      commit,
      layer: 'selftest',
      runner: identity,
      results: [{ file: 'tests/selftest/slow-window.test.mjs', ok: result.ok, skipped: false, ms: result.ms, attempts: 1 }],
      startedAt: new Date().toISOString(),
      totalMs: result.ms,
    })
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${recordFileName(commit, identity, null, 'selftest')}`), `${JSON.stringify(record, null, 2)}\n`)
    return { ok: result.ok, ms: result.ms, tail: result.tail ?? [], identity }
  }

  const fail = (message) => {
    beats.push(`FAIL  ${message}`)
    return false
  }
  let ok = true
  try {
    // [1]+[2] 正向：快 runner 绿、慢 runner 红（同 commit、同用例、不同 runner）
    const crossDir = stamp('cross')
    const fast = await runOn({ load: 'idle', delay: 5, dir: crossDir })
    const slow = await runOn({ load: 'busy', delay: 400, dir: crossDir })
    ok = (fast.ok ? beats.push(`PASS  [1] 快 runner（负载 idle / 点击延迟 5ms < 窗口 100ms）→ 绿 ${Math.round(fast.ms)}ms`) : fail(`[1] 快 runner 应该绿，实际红：${fast.tail.slice(-2).join(' ')}`)) && ok
    ok = (!slow.ok ? beats.push(`PASS  [2] 慢 runner（负载 busy / 点击延迟 400ms > 窗口 100ms）→ 红 ${Math.round(slow.ms)}ms`) : fail('[2] 慢 runner 应该红，实际绿：环境没能把窗口调窄')) && ok
    const registry = emptyRegistry()
    const groups = scanCrossRunner(await readRunRecords(crossDir)).filter((item) => item.commit === 'selftest456')
    if (groups.length === 1) {
      recordCrossRunner(registry, groups[0].test, { today: dayOf(), runners: groups[0].runners, evidence: groups[0].evidence, commit: groups[0].commit })
      const entry = registry.tests[groups[0].test]
      const shapeOk = entry.kind === KINDS.crossRunner
        && entry.runners.length === 2
        && entry.firstSeen === dayOf() && entry.count === 1 && entry.lastSeen === dayOf()
        && Array.isArray(entry.evidence) && entry.evidence.length === 2
        && entry.quarantinedAt === null
      if (shapeOk) {
        beats.push(`PASS  [3] 判据命中 → kind="${entry.kind}"，runners=${JSON.stringify(entry.runners)}，evidence=${entry.evidence.length} 条`)
        beats.push(`      登记簿条目：${JSON.stringify({ test: entry.test, kind: entry.kind, firstSeen: entry.firstSeen, count: entry.count, lastSeen: entry.lastSeen, runners: entry.runners })}`)
      } else {
        ok = fail(`[3] 登记项的字段不对：${JSON.stringify(entry)}`)
      }
    } else {
      ok = fail(`[3] 应该判出 1 条 cross-runner 分叉，实际 ${groups.length} 条`)
    }

    // [4] 负向对照：两个 runner 都红 → 结论一致 → 不登记
    const bothRedDir = stamp('both-red')
    await runOn({ load: 'idle', delay: 400, dir: bothRedDir })
    await runOn({ load: 'busy', delay: 400, dir: bothRedDir })
    const bothRed = scanCrossRunner(await readRunRecords(bothRedDir)).filter((item) => item.commit === 'selftest456')
    ok = (bothRed.length === 0 ? beats.push('PASS  [4] 负向对照：两个 runner 都红 → 结论一致 → 不登记（「都红」不是 flake）') : fail(`[4] 都红被误判成 cross-runner（${bothRed.length} 条）`)) && ok

    // [5] 负向对照：同一个 runner 红→绿 → 那是 same-runner flaky，不算 cross-runner
    const sameRunnerDir = stamp('same-runner')
    await runOn({ load: 'busy', delay: 400, dir: sameRunnerDir })
    await runOn({ load: 'busy', delay: 5, dir: sameRunnerDir })
    const sameRunner = scanCrossRunner(await readRunRecords(sameRunnerDir)).filter((item) => item.commit === 'selftest456')
    ok = (sameRunner.length === 0 ? beats.push('PASS  [5] 负向对照：同一 runner 红→绿 → 不算 cross-runner（归 same-runner flaky）') : fail(`[5] 同 runner 的红→绿被误判成 cross-runner（${sameRunner.length} 条）`)) && ok

    // [6] 静态提示：自证用例本身必须被判出「靠时间而不是靠终态」
    const findings = scanTimingWindows(await readFile(caseFile, 'utf8'))
    ok = (findings.length > 0 ? beats.push(`PASS  [6] 静态提示命中 ${findings.length} 处：${[...new Set(findings.map((item) => item.kind))].join('/')}`) : fail('[6] 静态提示没命中 waitForTimeout/sleep 类的写法')) && ok
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
  console.log(`\n#456 自证：跨 runner 判定（临时目录 ${workdir}，跑完已清理）`)
  for (const line of beats) console.log(`  ${line}`)
  console.log(`\n自证结论：${ok ? 'PASS —— 「只在慢环境红」的用例被判为 cross-runner 并登记；两条负向对照都没误报' : 'FAIL —— 判据不可信，见上面失败项'}`)
  if (!ok && recordDir) console.log(`（自证用的记录目录：${rel(recordDir)} —— 自证不写仓库的登记簿）`)
  return ok ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)
  let layer, only = '', caseName = '', json, failedFrom, timeoutMs = 180000, shard = null, jobs
  // #456：`--record-dir` 指的是运行记录（跨 runner 判据的输入）写哪；`--registry` 换登记簿文件（自证/沙箱用）
  let recordDir = FLAKY_RUNS_DIR
  let registryPath = FLAKY_FILE
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--only', '--case', '--json', '--failed-from', '--timeout-ms', '--shard', '--jobs', '--record-dir', '--registry'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`)
      if (arg === '--only') only = value
      if (arg === '--case') caseName = value
      if (arg === '--json') json = value
      if (arg === '--failed-from') failedFrom = value
      if (arg === '--timeout-ms') timeoutMs = Number(value)
      if (arg === '--shard') shard = parseShard(value)
      if (arg === '--jobs') jobs = Number(value)
      if (arg === '--record-dir') recordDir = path.resolve(value)
      if (arg === '--registry') registryPath = path.resolve(value)
    } else if (
      ['--bail', '--list', '--baseline', '--write-weights', '--no-retry', '--include-quarantined', '--no-record', '--cross-runner-scan', '--selftest-cross-runner'].includes(arg)
    ) {
      flags.add(arg)
    }
    else if (!arg.startsWith('-') && !layer) layer = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout-ms must be a positive integer')
  if (jobs !== undefined && (!Number.isSafeInteger(jobs) || jobs < 1)) throw new Error('jobs must be a positive integer')
  /**
   * #456：两个「不跑用例」的入口，所以不要求给层：
   *   · `--cross-runner-scan`：只读运行记录、判跨 runner、登记、写 summary（CI 的汇总 job 用它）；
   *   · `--selftest-cross-runner`：自证（造一个「只在慢环境红」的用例，两个负载档各跑一次）。
   */
  if (flags.has('--cross-runner-scan') || flags.has('--selftest-cross-runner')) {
    return flags.has('--selftest-cross-runner')
      ? selftestCrossRunner({ recordDir })
      : crossRunnerScan({ recordDir, registryPath, json })
  }
  // #415：`all` 也要带 `server` —— 「接进 LAYERS 但不在 all 里」等于又留一个「全量跑不到」的口子
  const plan = layer === 'all' ? ['unit', 'regression', 'integration', 'server'] : [layer]
  if (plan.some((name) => !LAYERS.includes(name))) throw new Error('Usage: node tests/run-layer.mjs <unit|integration|regression|server|e2e|device|all> [--only substring] [--case exact-path] [--shard 1/3] [--jobs N] [--timeout-ms 180000] [--json result.json] [--failed-from result.json] [--bail] [--list] [--no-retry] [--include-quarantined] [--record-dir dir] [--registry file] [--no-record] | node tests/run-layer.mjs --cross-runner-scan [--record-dir dir] [--registry file] [--json r.json] | node tests/run-layer.mjs --selftest-cross-runner')
  let failed
  if (failedFrom) {
    const report = JSON.parse(await readFile(failedFrom, 'utf8'))
    if (!Array.isArray(report.results) || report.results.some((r) => typeof r.file !== 'string' || typeof r.ok !== 'boolean')) throw new Error('Invalid previous report')
    failed = new Set(report.results.filter((r) => !r.ok).map((r) => r.file))
  }
  const selected = []
  for (const name of plan) {
    // Missing/unreadable layer is an infrastructure error, never an empty PASS.
    // #415：目录由 LAYER_DIRS 解析（默认 tests/<层>，server 在 deploy/dl-release/test）。
    const layerDir = layerDirOf(name)
    const names = await readdir(layerDir)
    for (const basename of names.filter((n) => n.endsWith('.test.mjs')).sort()) {
      const file = path.join(layerDir, basename)
      if (only && !basename.includes(only)) continue
      if (caseName && caseName !== rel(file) && caseName !== basename) continue
      if (failed && !failed.has(rel(file))) continue
      selected.push({ layer: name, file })
    }
  }
  /**
   * #406：flaky 登记簿。
   *
   * · 隔离区（连续 3 次 flaky）默认**跳过**：它已经在「时好时坏」，每轮都跑只会继续污染判断；
   *   但跳过必须留痕并每周提醒一次修复（`dueReminders`），否则隔离区会变成遗忘区。
   * · `--case` 显式点名时照跑（人已经指定要跑它，就别替他拦），`--include-quarantined` 同理。
   * · 登记簿缺失/损坏不是错误：退化成本次的空簿，绝不因为登记簿坏了让整层跑不起来。
   */
  let flakyRegistry = emptyRegistry()
  try {
    flakyRegistry = normalizeRegistry(JSON.parse(await readFile(registryPath, 'utf8')))
  } catch { /* 没有文件 / JSON 坏了：用空簿继续 */ }
  const flakyPolicy = { ...DEFAULT_POLICY, ...(flakyRegistry.policy ?? {}) }
  const today = dayOf()
  const quarantinedFiles = []
  const runnable = []
  for (const item of selected) {
    const name = rel(item.file)
    if (!flags.has('--include-quarantined') && !caseName && isQuarantined(flakyRegistry, name)) {
      quarantinedFiles.push(name)
      continue
    }
    runnable.push(item)
  }
  if (quarantinedFiles.length) {
    console.log(`\nflaky 隔离区：跳过 ${quarantinedFiles.length} 个用例（连续 ${flakyPolicy.quarantineAfter} 次 flaky）`)
    for (const name of quarantinedFiles) console.log(`  QUARANTINED  ${name}`)
  }
  for (const entry of dueReminders(flakyRegistry, { today })) {
    console.log(`  ⏰ flaky 每周提醒：${describeEntry(entry)} —— 隔离不是修复，请派单或就地修`)
  }
  // #365：分片在「--only / --case / --failed-from 筛完之后」才切，保证分片是对当前选择集的完整划分。
  // #406：切的是**可跑的**选择集（隔离区已经先摘掉），分片覆盖自检（CI 里那条）才对得上。
  const shardPlan = shard ? await planShard(runnable, shard) : null
  const planned = shardPlan ? shardPlan.picked : selected
  const started = performance.now()
  const results = []
  /** #406：本轮「重跑才通过」的用例名单（要写进终端、--json、job summary 与登记簿） */
  const flakyRuns = []
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
    console.log(`分片 ${shard.index}/${shard.count}：本分片 ${planned.length} 个文件（全集 ${runnable.length}${quarantinedFiles.length ? ` + 隔离 ${quarantinedFiles.length}` : ''}），预计 ${Math.round(shardPlan.pickedLoadMs / 1000)}s；权重来源 ${shardPlan.weightSource}`)
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
  // #456：这次 run 的身份与 commit。判据要的两维就是「哪台机器」和「哪份代码」，两者都只取一次。
  const identity = runnerIdentity()
  const commit = currentCommit()
  console.log(`runner: ${identity.id}${identity.loadClass ? `（负载档 ${identity.loadClass}）` : ''} · commit: ${commit} · 运行记录目录: ${dirLabel(recordDir)}`)
  const lanePlan = resolveJobs(plan, jobs)
  const lanes = lanePlan.lanes
  /**
   * #487：子进程内存上限（所有用例子进程都带）。降级复跑时用一个更大的上限 ——
   * 「撞到自己上限」是可恢复的资源问题，「撞到系统上限」才需要人介入。
   */
  const heapPlan = childHeapPlan()
  const heapCap = heapPlan.mb
  const caseNodeArgs = heapPlan.inject ? [`--max-old-space-size=${heapCap}`] : []
  const degradedHeapMb = Math.min(CHILD_HEAP_CEIL_MB * 2, Math.max(CHILD_HEAP_FLOOR_MB, heapCap * 2))
  const degradedNodeArgs = heapPlan.inject ? [`--max-old-space-size=${degradedHeapMb}`] : []
  console.log(
    `车道：${lanes}（${lanePlan.why}）· 子进程堆上限 ${heapCap} MB（来源：${heapPlan.source}${heapPlan.inject ? '，TEST_CHILD_HEAP_MB 可覆盖' : '，不覆盖'}）`,
  )
  const unitWeights = await loadUnitWeights()
  const work = await buildWorkUnits(planned, unitWeights.files)

  // 每个工作单元跑完再整段打印：并行时几个文件的日志交错成一团既看不出失败在哪，也不好粘进 Issue
  const emit = (text) => process.stdout.write(text)
  /**
   * #487：单个用例进程的环境（APP_URL / DIST_DIR 注入）。抽出来是因为**降级复跑**（批次崩溃后
   * 逐文件串行重跑）必须拿到与正常单文件路径完全一样的环境，否则「串行能过」就成了假象。
   */
  const caseEnv = async (item) => {
    const env = { ...process.env }
    const base = path.basename(item.file)
    if (SELF_SERVED.has(base)) env.APP_URL = ''
    else if (APP_URL_FILES.has(base) && !process.env.APP_URL) env.APP_URL = (await ensureSharedStd()).url
    // 要 standard 变体却读 DIST_DIR 的用例：指到标准产物，别让它们对着内测包 SKIP(env)（#365）
    if (STANDARD_DIST_DIR_FILES.has(base) && !process.env.DIST_DIR) env.DIST_DIR = standardDistDir()
    return env
  }
  /** #487：本轮被降级重跑救回来的用例（`PASS(degraded)`）—— 只降并发不留痕是不允许的 */
  const degradedRuns = []
  /** #487：批次进程崩了的工作单元，主队列排空后串行重跑（见 runUnit 里的 pendingDegrade） */
  const pendingCrashes = []
  const runUnit = async (unit) => {
    const log = []
    const say = (line) => { if (lanes === 1) process.stdout.write(`${line}\n`) ; else log.push(`${line}\n`) }
    const startedUnit = performance.now()
    if (!unit.merged) {
      const item = unit.items[0]
      const name = rel(item.file)
      say(`\n>> ${name} (timeout ${timeoutMs}ms)`)
      const env = await caseEnv(item)
      // #456：attempts 要记下来 —— 判据里「同 runner 重跑绿」与「跨 runner 结论不同」是两件事，
      // 报告里必须能分开看（前者是 flaky，后者是 runner-dependent）。
      let attempts = 1
      const run = (nodeArgs = caseNodeArgs) => runCase(item.file, { cwd: ROOT, env, timeoutMs, output: lanes === 1, nodeArgs })
      let result = await run()
      if (lanes !== 1 && result.output) log.push(result.output)
      let skipped = result.code === SKIP_CODE
      /**
       * #487：撞到自己那条堆上限 → **不算失败**，把上限翻倍串行再来一次。
       * 这跟「重跑碰运气」（#406 flaky）是两回事：这里改的是资源配额，不是掷骰子。
       */
      let degradeReason = ''
      if (!result.ok && !skipped && heapPlan.inject && classifyDeath(result).kind === 'oom') {
        const death = classifyDeath(result)
        say(`   ⬆ ${death.label}；把子进程堆上限从 ${heapCap} MB 提到 ${degradedHeapMb} MB 重跑一次（资源配额问题，不是断言失败）`)
        attempts += 1
        result = await run(degradedNodeArgs)
        if (lanes !== 1 && result.output) log.push(result.output)
        if (result.ok) {
          degradeReason = `${death.label} → 提高子进程堆上限后通过（原上限 ${heapCap} MB）。调大 TEST_CHILD_HEAP_MB 或减小 --jobs 可消除降级`
          degradedRuns.push({ file: name, reason: degradeReason })
        }
        skipped = result.code === SKIP_CODE
      }
      /**
       * #406：失败自动重跑 **1 次**。
       *
       * 重跑通过 → 记 flaky（名单进终端 / --json / job summary / flaky-registry.json），当绿放行；
       * 重跑仍红 → 真红（这条路径一次都不省）。
       * SKIP(env) 不重跑：产物缺失 / 端口被占是环境问题，重跑只会再 SKIP 一遍。
       * 21 天内复发 ≥2 次的「重跑才通过」**不当 flaky**，直接按真红上报 —— 见 isRecurringRed。
       */
      let flaky = false
      if (!result.ok && !skipped && !flags.has('--no-retry')) {
        say(`   ↻ 红了（${result.ms}ms），按 flaky 判据重跑一次…`)
        attempts = 2
        const retry = await run()
        if (lanes !== 1 && retry.output) log.push(retry.output)
        if (retry.ok) {
          const previous = flakyRegistry.tests[name]
          const recurring = isRecurringRed(previous, flakyPolicy, today)
          const firstFailure = (result.tail ?? []).filter((line) => /✗|Error|FAIL/.test(line)).slice(-3).join(' ⏎ ')
          const entry = recurring
            ? recordRecurringRed(flakyRegistry, name, { today, reason: firstFailure.slice(0, 300) })
            : recordFlaky(flakyRegistry, name, { today, reason: firstFailure.slice(0, 300) })
          if (recurring) {
            say(
              `   ⚠ 重跑通过，但它在 ${flakyPolicy.recurrenceWindowDays} 天内已复发 ≥2 次 —— 按真红处理（不许用重跑洗白）`,
            )
            result = {
              ...retry,
              ok: false,
              recurringFlaky: true,
              error: `重跑通过但 ${flakyPolicy.recurrenceWindowDays} 天内复发 ≥2 次 → 当红处理（#406 策略）`,
            }
          } else {
            flaky = true
            flakyRuns.push(name)
            result = { ...retry, flaky: true, firstFailureMs: result.ms }
            say(`   ↻ 重跑通过 → 记为 flaky（累计 ${entry.count} 次 / 连续 ${entry.streak} 次）`)
            if (entry.quarantinedAt) {
              say(`   ⏸ 连续 ${flakyPolicy.quarantineAfter} 次 flaky → 进隔离区（下次起跳过，每周提醒修复）`)
            }
          }
        } else {
          result = retry
        }
        skipped = result.code === SKIP_CODE
      }
      const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(result.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
      const status = result.ok
        ? degradeReason
          ? 'PASS(degraded)'
          : flaky
            ? 'PASS(flaky)'
            : 'PASS'
        : skipped
          ? 'SKIP(env)'
          : result.timedOut
            ? 'TIMEOUT'
            : classifyDeath(result).kind === 'oom'
              ? 'FAIL(OOM)'
              : 'FAIL'
      say(`<< ${status} ${name} (${result.ms}ms)`)
      if (degradeReason) say(`   ↧ ${degradeReason}`)
      if (skipped) say(`   ↳ ${skipReason}`)
      // 真的绿了（不是重跑才绿）：连续 flaky 计数清零，quarantine 自动解除（修好就移除，不用手改 JSON）
      if (result.ok && !flaky) recordPass(flakyRegistry, name, { today })
      return {
        results: [{
          layer: item.layer, file: name, ...result, skipped, skipReason, attempts, runner: identity.id,
          ...(degradeReason ? { degraded: true, degradeReason } : {}),
        }],
        log: log.join(''),
        interrupted: result.interrupted,
        failed: !result.ok && !skipped,
      }
    }
    // 合并批次：一次进程跑 N 个文件，逐文件结局从 merged-entry 的 `<< FILE` 收尾行还原
    const files = unit.items.map((item) => item.file)
    say(`\n>> 合并批次 ${unit.items.length} 个文件 (timeout ${timeoutMs}ms/批)`)
    for (const item of unit.items) say(`   · ${rel(item.file)}`)
    const result = await runMergedBatch(files, { cwd: ROOT, env: { ...process.env }, timeoutMs, output: lanes === 1, nodeArgs: caseNodeArgs })
    if (lanes !== 1 && result.output) log.unshift(result.output)
    const byFile = new Map(result.files.map((entry) => [entry.file, entry]))
    const unitResults = []
    /** #487：这批里「没有收尾行」的文件 —— 先不判红，交给排空后的串行降级复跑 */
    const missing = []
    for (const item of unit.items) {
      const name = rel(item.file)
      const entry = byFile.get(name)
      if (!entry) {
        // 没有收尾行 = 这个文件没跑完（import 抛错 / 进程被杀 / 超时）。**不许当成通过**，
        // 但也不许直接判失败（#487）：先记成「待降级复跑」，由排空后的串行阶段定性。
        missing.push(item)
        unitResults.push({
          layer: item.layer, file: name, ok: false, skipped: false, skipReason: '',
          code: result.code, signal: result.signal, timedOut: result.timedOut, interrupted: result.interrupted,
          error: '批次进程没跑到收尾行（待串行降级复跑）', skips: 0, skipDetails: [], ms: 0, tail: result.tail, merged: true,
          pendingDegrade: true, attempts: 1, runner: identity.id,
        })
        continue
      }
      const skipped = entry.outcome === 'SKIP'
      unitResults.push({
        layer: item.layer, file: name, ok: entry.ok, skipped,
        skipReason: skipped ? '批内全部用例自带 SKIP' : '',
        code: entry.ok ? 0 : 1, signal: null, timedOut: false, interrupted: result.interrupted, error: null,
        skips: entry.skip, skipDetails: entry.skipDetails ?? [], tests: entry.tests, pass: entry.pass,
        fail: entry.fail, ms: entry.ms, tail: [], merged: true,
        attempts: 1, runner: identity.id,
      })
      const status = entry.outcome === 'PASS' ? 'PASS' : entry.outcome === 'FAIL' ? 'FAIL' : 'SKIP'
      say(`<< ${status} ${name} (${entry.ms}ms, ${entry.tests} 用例)`)
    }
    /**
     * #487：**崩溃 != 失败**。
     *
     * 批次进程没跑完时，以前直接把缺收尾行的文件判 FAIL（reason 只有一句「批内崩溃」）。可这类
     * 崩溃绝大多是**资源不够**：16 个文件在一个进程里顺序 import，峰值 RSS ≈ 250 MB，几条车道
     * 并发就足以把可用内存吃光，被内核 OOM killer 挑中整批杀掉；单文件重跑只要 120 MB，必过。
     * 于是「内存不足」被稳定地误报成「测试失败」——每个 PR 的 CI 随机变红。
     *
     * 现在的处置：这里只**暂记**（pendingDegrade），主队列排空后由 runDegradedRetry() 串行重跑：
     *   1) 整批独占（没有别的车道抢内存）跑一次 → 全过则整批 `PASS(degraded)`；
     *   2) 仍有文件没跑完 → 逐个单文件进程串行跑 → 过则 `PASS(degraded)`；
     *   3) 串行仍崩/仍红 → 才是真失败，并打印**真实 stderr**（不是只有一句「批内崩溃」）。
     */
    const death = missing.length ? classifyDeath(result) : null
    if (missing.length) {
      say(`\n⚠ 批次进程没跑完（${death.label}）：${missing.length}/${unit.items.length} 个文件没有收尾行`)
      say('   ⟹ 不判红：主队列排空后整批独占串行重跑（再退到逐文件串行），仍崩才算真失败')
      for (const line of death.excerpt) say(`   ⚠ ${line}`)
      for (const item of missing) say(`<< CRASH ${rel(item.file)}（${death.kind}，待串行降级复跑）`)
    }
    // 批次里有红：**不能直接相信** —— 合并的前提是「文件之间零串扰」，红了要么是真红，要么
    // 是这个批次不该合在一起（模块级装配互相影响 / 用例依赖 event loop 的时序）。于是把这几个
    // 文件按**单文件进程**（合并之前的老跑法）重跑一遍，结果以单文件为准：
    //   · 单跑绿 → 批次不兼容（打印 ⚠，建议把可疑文件登记进 UNIT_SOLO）
    //   · 单跑红 → 真红，照旧上报
    // #487：pendingDegrade 的条目不走这条（它们没有批内结论可比），由降级阶段统一处理。
    const reds = unitResults.filter((entry) => !entry.ok && !entry.skipped && !entry.pendingDegrade)
    if (reds.length) {
      say(`\n⚠ 批次 ${unit.items.length} 个文件里 ${reds.length} 个红了：改按单文件进程重跑这几个（结果以单文件为准）`)
      for (const red of reds) {
        const item = unit.items.find((candidate) => rel(candidate.file) === red.file)
        const env = await caseEnv(item)
        const single = await runCase(item.file, { cwd: ROOT, env, timeoutMs, output: lanes === 1, nodeArgs: caseNodeArgs })
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
          // 批内红 → 单文件重跑，所以这条确实是第 2 次 attempt（但机器没变，仍算 same-runner 的证据）
          attempts: 2,
          runner: identity.id,
        }
      }
    }
    if (missing.length) pendingCrashes.push({ unit, death, results: unitResults })
    return {
      results: unitResults,
      log: log.join(''),
      interrupted: result.interrupted,
      // #487：待降级复跑的文件先不算「失败」—— 否则 `--bail` 会在定性之前就把整轮掐掉
      failed: unitResults.some((entry) => !entry.ok && !entry.skipped && !entry.pendingDegrade),
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

  /**
   * #487：批次崩溃的**降级复跑**（串行，独占机器）。
   *
   * 为什么必须放在主队列**排空之后**：崩溃的成因绝大多数是「几条车道同时把内存吃光」，
   * 这时独占重跑才是干净的对照实验 —— 别的车道还在抢内存时重跑，只会再崩一次，
   * 于是「资源不足」又被读成「测试红」，白白多花时间还得出错误结论。
   *
   * 三级阶梯（每一级都留痕，不许悄悄降并发换绿）：
   *   1) 整批独占串行（子进程堆上限翻倍）→ 全过 ⇒ 整批 `PASS(degraded)`；
   *   2) 仍有文件没跑完/批内红 → 逐文件单进程串行 → 过 ⇒ `PASS(degraded)`；
   *   3) 串行仍崩 ⇒ 真失败，打印**真实 stderr** + 分类 + 复跑命令（不再只有一句「批内崩溃」）。
   */
  if (pendingCrashes.length && !interrupted) {
    console.log(
      `\n${'='.repeat(70)}\n== #487 降级复跑：${pendingCrashes.length} 个批次进程没跑完（${[...new Set(pendingCrashes.map((item) => item.death.kind))].join('/')}）\n${'='.repeat(70)}`,
    )
    console.log('主队列已排空 → 下面是独占串行复跑：能过就说明是「资源不足」，不是「测试失败」；仍崩才算真失败。')
    for (const crash of pendingCrashes) {
      if (interrupted) break
      const files = crash.unit.items.map((item) => item.file)
      const death = crash.death
      console.log(`\n↺ 整批独占串行重跑（${crash.unit.items.length} 个文件，堆上限 ${heapPlan.inject ? degradedHeapMb : heapCap} MB；上次死因：${death.label}）`)
      for (const line of death.excerpt) console.log(`   ⚠ 上次 stderr：${line}`)
      const alone = await runMergedBatch(files, {
        cwd: ROOT, env: { ...process.env }, timeoutMs, output: true, nodeArgs: degradedNodeArgs,
      })
      const aloneByFile = new Map(alone.files.map((entry) => [entry.file, entry]))
      const aloneDeath = classifyDeath(alone)
      const stillBroken = []
      for (const item of crash.unit.items) {
        const name = rel(item.file)
        const index = crash.results.findIndex((entry) => entry.file === name)
        if (index < 0) continue
        const entry = aloneByFile.get(name)
        if (entry && entry.ok) {
          const reason = `批次进程没跑完（${death.kind}：${death.label}）→ 独占串行整批重跑通过${entry.skip ? `（批内 ${entry.skip} 条用例自带 SKIP，判定不变）` : ''}`
          Object.assign(crash.results[index], {
            ok: true, skipped: entry.outcome === 'SKIP', skipReason: '', code: 0, signal: null, timedOut: false,
            error: null, tests: entry.tests, pass: entry.pass, fail: entry.fail, skips: entry.skip,
            skipDetails: entry.skipDetails ?? [], ms: entry.ms, tail: [], merged: true, pendingDegrade: false,
            batchFallback: true, degraded: true, degradeReason: reason, attempts: 2,
          })
          degradedRuns.push({ file: name, reason: `${reason}（批次资源不足）` })
          console.log(`   ↧ PASS(degraded) ${name}（${entry.ms}ms, ${entry.tests} 用例）`)
          continue
        }
        stillBroken.push(item)
      }
      if (!stillBroken.length) {
        console.log('   ⟹ 整批独占串行全过 → 判定为**批次资源不足**，不判红（已在 summary 记 DEGRADED）')
        continue
      }
      console.log(`   ⟹ 整批串行仍有 ${stillBroken.length} 个文件没跑完（${aloneDeath.label}），退到逐文件单进程串行`)
      for (const item of stillBroken) {
        const name = rel(item.file)
        const index = crash.results.findIndex((entry) => entry.file === name)
        const env = await caseEnv(item)
        const solo = await runCase(item.file, { cwd: ROOT, env, timeoutMs, output: true, nodeArgs: degradedNodeArgs })
        const soloDeath = solo.ok ? null : classifyDeath(solo)
        const skipped = solo.code === SKIP_CODE
        const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(solo.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
        if (solo.ok) {
          const reason = `批次进程没跑完（${death.kind}：${death.label}）→ 逐文件串行通过`
          if (index >= 0) {
            Object.assign(crash.results[index], {
              ...solo, file: name, layer: item.layer, skipped: false, skipReason: '', merged: false,
              pendingDegrade: false, batchFallback: true, degraded: true, degradeReason: reason, attempts: 2,
            })
          }
          degradedRuns.push({ file: name, reason })
          console.log(`   ↧ PASS(degraded) ${name}（逐文件串行 ${solo.ms}ms）`)
          continue
        }
        // 串行仍崩/仍红：**这才是真失败**。必须把真实 stderr 打出来，不许只写「批内崩溃」。
        const why = skipped
          ? `SKIP(env) ${skipReason}`
          : `${soloDeath.label}；逐文件串行仍没跑到收尾行`
        console.log(`\n   ✖ FAIL ${name}（${why}）`)
        console.log(`      批内死因：${death.label}${death.excerpt.length ? ` —— ${death.excerpt.join(' ⏎ ')}` : ''}`)
        for (const line of soloDeath?.excerpt ?? []) console.log(`      串行 stderr：${line}`)
        console.log(`      复跑：node tests/run-layer.mjs ${item.layer} --case ${name}`)
        if (index >= 0) {
          Object.assign(crash.results[index], {
            ok: false, skipped, skipReason, code: solo.code, signal: solo.signal, timedOut: solo.timedOut,
            merged: false, pendingDegrade: false, batchFallback: true, attempts: 2,
            error: why,
            crash: { batch: death.kind, solo: soloDeath?.kind ?? null, batchLabel: death.label, soloLabel: soloDeath?.label ?? null },
            stderr: { batch: death.excerpt, solo: soloDeath?.excerpt ?? [] },
            tail: solo.tail,
          })
        }
      }
    }
  }
  // 极端情况（中断 / 降级阶段被跳过）：待定条目一律按失败收口，绝不让「没跑完」被当成通过。
  sharedStd?.kill()
  // 结果按选择顺序归位：并行完成顺序不确定，报告顺序必须稳定
  const order = new Map(planned.map((item, index) => [rel(item.file), index]))
  results.push(...outcomes.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0)))
  for (const entry of results) {
    if (!entry.pendingDegrade) continue
    entry.pendingDegrade = false
    entry.error = entry.error ?? '批次崩溃后没有完成降级复跑（本轮被中断）'
  }
  const failures = results.filter((r) => !r.ok && !r.skipped)
  /**
   * #487：降级通过的名单（`PASS(degraded)`）。**必须与「绿」分开数**：它们是靠「降并发 / 提内存
   * 上限的串行重跑」才绿的，掩盖起来就等于「用降低并发换绿」。
   */
  const degraded = results.filter((r) => r.ok && r.degraded)
  const crashedFails = failures.filter((r) => r.crash)
  const skips = results.filter((r) => r.skipped)
  const totalMs = Math.round(performance.now() - started)

  /**
   * #456 §3：时序窗口的**静态提示**（警告级，不阻塞）。
   * 扫的是本轮选中用例的源码，找「靠时间而不是靠终态」的写法（`waitForTimeout` / 固定 sleep /
   * 依赖动画时长）。它们不是错，但正确性依赖机器快慢 —— 正是「同机绿、换 runner 红」的温床，
   * 所以要在 job summary 里点名，让人在改断言时看得见。
   */
  const timingWarnings = await scanTimingWarnings(planned)

  /**
   * #456 §1：跨 runner 判据。分两步，顺序不能反：
   *   1) 先把**本轮**的结果写成一份运行记录（带 runner 身份 + 负载快照 + commit）；
   *   2) 再把记录目录里所有记录聚合比对 —— 里面可能有别的 runner、别的分片、同 SHA 的另一次 attempt。
   *
   * 没有第 1 步就没有可比对的原始事实；没有第 2 步，判据又退回「只看自己这台机器」（#406 的盲区）。
   */
  const crossRunner = await registerCrossRunner({
    registry: flakyRegistry,
    plan,
    shard,
    identity,
    commit,
    results,
    startedAt: new Date(Date.now() - totalMs).toISOString(),
    totalMs,
    recordDir,
    writeRecord: !flags.has('--no-record'),
    today,
  })
  const crossRunnerFiles = new Set(crossRunner.all.map((item) => item.test))
  for (const item of results) {
    // 三态在这里落地（#456 §2）：runner-dependent 优先于 flaky/真红 ——
    // 「这台机器上重跑还是红」不代表它真红，只要有别的 runner 是绿的，它就是 runner-dependent。
    item.triState = triStateOf({
      ok: item.ok,
      flaky: Boolean(item.flaky),
      skipped: item.skipped,
      runnerDependent: crossRunnerFiles.has(item.file),
    })
  }
  const tri = summarizeTriState(results, crossRunnerFiles)
  /**
   * #406：登记簿落盘 + 名单留痕。
   *
   * 三条出口缺一不可，否则「重跑通过」就等于把红抹掉了：
   *   · 终端：本轮 flaky 名单与隔离情况；
   *   · `--json` 报告：`flaky` / `quarantined` 字段（CI 的 artifact 里能查历史）；
   *   · `GITHUB_STEP_SUMMARY`：PR 页面直接能看到名字（有该环境变量就写，不需要改 ci.yml）。
   */
  // 登记簿落盘失败（只读文件系统 / 沙箱里没有这个目录）不许把整轮结果弄丢：它只是留痕的副本，
  // 终端与 --json 里已经有一份完整名单。
  await writeFile(registryPath, JSON.stringify(flakyRegistry, null, 2) + '\n').catch((error) => {
    console.log(`\n⚠ flaky 登记簿写入失败（${error.message}）：本轮名单只在终端与 --json 报告里`)
  })
  if (flakyRuns.length) {
    console.log(`\nFLAKY（重跑才通过，${flakyRuns.length} 个；已登记 ${rel(registryPath)}）`)
    for (const name of flakyRuns) console.log(`  FLAKY  ${name} —— ${describeEntry(flakyRegistry.tests[name])}`)
  }
  if (crossRunner.all.length) {
    console.log(`\nCROSS-RUNNER（同 commit、同用例、换 runner 结论不同，${crossRunner.all.length} 个分叉；本轮新登记 ${crossRunner.registered.length} 个 → ${rel(registryPath)}）`)
    for (const item of crossRunner.all) {
      const isNew = crossRunner.registered.includes(item)
      console.log(`  ${isNew ? 'NEW' : '已知'}  ${item.test}（commit ${item.commit}）`)
      console.log(`    红：${item.redRunners.join(', ')} / 绿：${item.greenRunners.join(', ')}`)
      console.log(`    ⟹ 处置：${TRI_STATE_ACTION['runner-dependent']}`)
    }
  }
  if (timingWarnings.length) {
    const total = timingWarnings.reduce((sum, item) => sum + item.findings.length, 0)
    console.log(`\n⚠ 时序窗口静态提示（警告级，不阻塞）：${timingWarnings.length} 个文件 / ${total} 处「靠时间而不是靠终态」的写法`)
    for (const item of timingWarnings.slice(0, 8)) {
      const kinds = [...new Set(item.findings.map((one) => one.kind))].join('/')
      console.log(`  ${item.file}：${item.findings.length} 处（${kinds}）`)
    }
    if (timingWarnings.length > 8) console.log(`  …其余 ${timingWarnings.length - 8} 个文件见 --json 的 timingWarnings`)
    console.log('  这类写法在快慢不同的 runner 上结论会漂移；改成等终态（until 轮询），不要加 sleep（docs/TESTING-POLICY.md §11.5）')
  }
  if (STEP_SUMMARY) {
    const lines = [`## flaky 与三态判定（${plan.join('+')} · runner ${identity.id}）`, '']
    lines.push(
      `| 状态 | 数量 | 处置 |`,
      `| --- | --- | --- |`,
      `| 绿 | ${tri.summary.green} | ${TRI_STATE_ACTION.green} |`,
      `| flaky（同 runner 重跑绿） | ${tri.summary.flaky} | ${TRI_STATE_ACTION.flaky} |`,
      `| **runner-dependent（跨 runner 结论不一致）** | ${tri.summary['runner-dependent']} | ${TRI_STATE_ACTION['runner-dependent']} |`,
      `| 真红（同 runner 重跑仍红） | ${tri.summary['true-red']} | ${TRI_STATE_ACTION['true-red']} |`,
      `| **降级通过（批次资源不足 → 串行重跑绿）** | ${degraded.length} | 不算失败，但必须留痕；调小 \`--jobs\` 或调大 \`TEST_CHILD_HEAP_MB\` |`,
    )
    if (degraded.length) {
      lines.push(
        '',
        `### 降级通过 ${degraded.length} 个 —— 并发/内存不足，串行重跑才绿（不是 flake，不是真红）`,
        '',
        `本轮车道 ${lanes}（${lanePlan.why}）· 子进程堆上限 ${heapCap} MB（${heapPlan.source}）。`,
        '降级是「资源不够」的证据，不是「调小并发换绿」的许可：同一批次反复降级时请修资源口径，别让 summary 变绿了事。',
        '',
      )
      for (const r of degraded) lines.push(`- \`${r.file}\` —— ${r.degradeReason}`)
    }
    if (flakyRuns.length) {
      lines.push('', `### flaky（重跑才通过）${flakyRuns.length} 个 —— 不阻塞合并，但必须留痕`, '')
      for (const name of flakyRuns) lines.push(`- \`${name}\` —— ${describeEntry(flakyRegistry.tests[name])}`)
    }
    if (crossRunner.all.length) {
      lines.push('', `### runner-dependent ${crossRunner.all.length} 个（本轮新登记 ${crossRunner.registered.length} 个）—— **必须改成等终态，禁止加 sleep**`, '')
      for (const item of crossRunner.all) {
        lines.push(`- \`${item.test}\`：红 ${item.redRunners.join(', ')} / 绿 ${item.greenRunners.join(', ')}（commit ${item.commit}）`)
      }
    }
    if (tri.files['true-red'].length) {
      lines.push('', `### 真红 ${tri.files['true-red'].length} 个 —— 修产品或修断言（不是 flake，别重跑）`, '')
      for (const name of tri.files['true-red']) lines.push(`- \`${name}\``)
    }
    if (quarantinedFiles.length) {
      lines.push('', `隔离区跳过 ${quarantinedFiles.length} 个（连续 ${flakyPolicy.quarantineAfter} 次 flaky，每周提醒修复）：`, '')
      for (const name of quarantinedFiles) lines.push(`- \`${name}\``)
    }
    if (timingWarnings.length) {
      const total = timingWarnings.reduce((sum, item) => sum + item.findings.length, 0)
      lines.push('', `### ⚠ 时序窗口静态提示（警告级，不阻塞）：${timingWarnings.length} 个文件 / ${total} 处`, '')
      lines.push('`waitForTimeout` / 固定 sleep / 依赖动画时长 —— 这类断言的对错依赖机器快慢，是跨 runner flake 的温床。', '')
      for (const item of timingWarnings.slice(0, 10)) {
        const kinds = [...new Set(item.findings.map((one) => one.kind))].join('/')
        lines.push(`- \`${item.file}\`：${item.findings.length} 处（${kinds}）`)
      }
      if (timingWarnings.length > 10) lines.push(`- …其余 ${timingWarnings.length - 10} 个文件见 \`--json\` 报告的 \`timingWarnings\``)
    }
    if (!flakyRuns.length && !crossRunner.all.length && !tri.files['true-red'].length) lines.push('', '本轮没有 flaky / runner-dependent / 真红。')
    await appendFile(STEP_SUMMARY, `${lines.join('\n')}\n`).catch(() => {})
  }
  // #287：用例内部 `t.skip()` / `{ skip: ... }` 不会改进程退出码，跑完全绿也看不出「一行断言都没跑」。
  // 这里把用例自己报的 # SKIP 汇总打印（如 legacy-bundle-target 缺产物时的声明期跳过），
  // 让跳过在报告里永远露头；判红门禁仍只看真实失败，避免把「产物没构建」误报成回归。
  const nodeSkips = results.filter((r) => (r.skips ?? 0) > 0)
  const failedCount = failures.length
  const report = {
    version: 1,
    totalMs,
    selected: planned.length,
    executed: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: failedCount,
    skipped: skips.length,
    skippedSubtests: nodeSkips.reduce((sum, r) => sum + (r.skips ?? 0), 0),
    /** #487：降级（批次资源不足 / 堆上限触顶）后串行重跑通过的名单，与 green 分开统计 */
    degraded: degraded.map((r) => ({ file: r.file, reason: r.degradeReason })),
    /** #487：这次跑的并发口径（事后能复核「是不是机子太小」） */
    lanes: { planned: lanes, why: lanePlan.why, childHeapMb: heapCap, childHeapSource: heapPlan.source, memory: memoryLaneBudget() },
    /** #406：重跑才通过的名单（不是「通过」的同义词，必须能被单独筛出来） */
    flaky: flakyRuns,
    /** #406：被隔离区跳过、本轮没有执行的用例 */
    quarantined: quarantinedFiles,
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
    `\nTotal ${results.length}: PASS ${report.passed}, FAIL ${failedCount}, SKIP(env) ${skips.length}, NODE-SKIP ${report.skippedSubtests}, DEGRADED ${degraded.length}; elapsed ${totalMs}ms`,
  )
  // #487：降级必须留痕 —— 否则「调小并发换绿」就成了一条静默的作弊路径
  if (degraded.length) {
    console.log(
      `\nDEGRADED（批次/进程资源不足 → 降级串行重跑通过，${degraded.length} 个；**不算失败，但必须留痕**）`,
    )
    console.log(`  本轮车道 ${lanes}（${lanePlan.why}）· 子进程堆上限 ${heapCap} MB（${heapPlan.source}）`)
    for (const r of degraded) console.log(`  DEGRADED  ${r.file} —— ${r.degradeReason}`)
    console.log('  处置：调小 `--jobs` / 调大 `TEST_CHILD_HEAP_MB`；若某个批次反复降级，把其中文件登记进 UNIT_SOLO')
  }
  // #487：崩溃型失败的**真实 stderr** 必须打出来。以前只有一句「批内崩溃，该文件未跑完」，
  // 看报告的人无从判断是内存不足、是 import 抛错、还是被信号杀掉。
  for (const r of crashedFails) {
    console.log(`\nCRASH  ${r.file}`)
    console.log(`  批内：${r.crash.batchLabel ?? r.crash.batch}${r.stderr?.batch?.length ? ` —— ${r.stderr.batch.join(' ⏎ ')}` : ''}`)
    if (r.crash.soloLabel) console.log(`  串行：${r.crash.soloLabel}`)
    for (const line of r.stderr?.solo ?? []) console.log(`    ${line}`)
  }
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
