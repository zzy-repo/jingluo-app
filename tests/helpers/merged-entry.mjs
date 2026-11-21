#!/usr/bin/env node
// L0 进程合并入口（Issue #366 第二批）：把**同一批**测试文件放进同一个进程内顺序执行。
//
// 为什么：L0 原来一个文件一个进程（149 次冷启动 ≈ 12s）。冷启动里没有一行断言，全是
// node 起进程 + 加载 node:test + 重新解析 `.js→.ts` 的 hook 图 + 同一份 TS 源码再加载一次。
// 合并后同一批文件共用一次冷启动与一份模块缓存。
//
// **为什么不用 `node:test` 的 `run({ isolation: 'none' })`**：它先把整批文件全部 import 一遍，
// 再统一跑用例（实测：两个文件的顶层 log 都先出现，用例才开跑）。L0 的用例文件几乎都在模块
// 顶层装配（`createHarness()` / `registerHooks()` / `globalThis.localStorage = …`），提前加载等于
// 让后一个文件的装配盖住前一个文件 —— 实测 domain06 家族 9 个文件里 5 个因此假红。
//
// 这里自己控顺序，三条：
//   1. **一个文件一个文件加载**：`await import(file)` → 等它的用例全部跑完（记账见
//      ./merged-tracker.mjs）→ 再下一个。前一个文件的装配不会活到后一个文件的用例里。
//   2. **globalThis 快照/还原 + 文件级状态复位**（#366 → #513）：文件跑完就把全局还原成它动手之前
//      的样子（localStorage / document / window / rAF / `__xxx` 开关一律复原），并把 `process.env`
//      还原、把文件漏掉的定时器清掉、跑一遍已登记的清场函数 —— 见 ./merged-tracker.mjs。
//      复位动了什么会打印成 `·· reset <文件>：…`，是「谁在污染」的证据，不许静默。
//   3. `registerHooks` 装的解析 hook 没有反注册 API（进程级、只增不减），所以顺序很重要：文件 N
//      注册的 stub 只可能影响 N **之后**的文件，而 N 已经跑完了。
//      **但「后注册优先级更高」只解决了一半（#513 实测）**：后一个文件的条件路由常常写在 `catch`
//      分支里（`nextResolve` 抛错才走），而前一个文件的通吃兜底会**先替它解析成功**，那段分支根本
//      进不去；ESM 模块缓存也是「首写者胜」，前一个文件装好的替身实例后一个文件改不掉。
//      这两类串扰在进程内不可修 —— 只能靠 `run-layer` 的 `UNIT_SOLO` 独占进程（机制与实测症状写在
//      那份清单里），不要指望「hook 顺序」把它们解决掉。
//
// ## #501（P0）：逐文件结局**不许**只看我们的记账
//
// 曾经这里只数「`test()` 的 promise 有没有兑现」，而断言失败时它依然 fulfilled —— 于是
// `assert.equal(1, 2)` 的批次收尾行是 `PASS tests=1 pass=1 fail=0`、退出码 0，unit 层的「全绿」
// 建立在这上面（假绿源头）。现在结算一段：记账（用例体抛错，见 ./merged-node-test.mjs）+
// **node 自己 reporter 的判定**（`--test-reporter=tap` 写到本进程专属的文件，见 ./tap.mjs），
// 判定规则集中在 ./merge-verdict.mjs（以 node 的判定为准）。TAP 文件路径由 runner 通过
// `MERGED_TAP_LOG` 传进来；没有它（例如手工单跑本文件）就只有记账这一路，仍能抓到用例体失败。
//
// 输出约定（run-layer 靠它把「一批进程」还原成「逐文件结果」）：
//   >> FILE <相对路径>
//   ok N - 用例名 [# SKIP 原因]        ← TAP 行，run-layer 的跳过扫描认这个
//   not ok N - 用例名
//   << FILE <相对路径> PASS|SKIP|FAIL|EMPTY tests=N pass=N fail=N skip=N ms=N
// 退出码：全绿 0；有失败 1。文件崩在 `<< FILE` 之前（import 抛错 / 进程被杀）时它不会有收尾行，
// run-layer 会把「没有收尾行」的文件判为失败 —— 不许「没跑完」被当成「通过」。
import { registerHooks } from 'node:module'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
// #513：文件级状态复位（globalThis 之外还有 process.env / 定时器 / 模块级单例）与用例记账同住一处 ——
// 两者都是「换文件时要把上一个文件的东西清干净」，而且自检沙箱是按这份 helper 清单拷文件的
//（`tests/unit/runner-verdict-self-check.test.mjs` 的 HELPERS），新开一个文件就得同步改那份清单。
import {
  captureTestState,
  describeReset,
  drain,
  installTimerTracker,
  reset,
  resetAllTestState,
  restoreGlobals,
  setListener,
} from './merged-tracker.mjs'
import { parseTap } from './tap.mjs'
import { countsOf, mismatchNotes, verdictOf } from './merge-verdict.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const WRAPPER = pathToFileURL(path.join(HERE, 'merged-node-test.mjs')).href
/** 事件里的 `file` 可能是绝对路径、也可能是 file:// URL —— 统一成仓库相对路径 */
const toAbsolute = (file) => (String(file).startsWith('file:') ? fileURLToPath(String(file)) : String(file))
const rel = (file) => path.relative(ROOT, toAbsolute(file)).split(path.sep).join('/')

/**
 * #513：快照/还原搬进 ./merged-tracker.mjs —— 只留 globalThis 这一半是不够的。
 * 实测的第三类串扰（`process.env` 被改、残留定时器跑到下一个文件、模块级单例没清）都在那边，
 * 复位口径统一收在一处，免得「合并入口清一半、别处清一半」。
 *
 * 注意：`restoreGlobals` 仍然在这里逐文件调用（行为与 #366 完全一致：文件跑完立刻复原全局），
 * 复位阶段（`resetAllTestState`）又兜一次 —— 因为它还要管 env / 定时器 / 清场函数，
 * 而且**跑红的文件**更容易留残渣，两条路都要走。
 */

// 把批内用例的 `import … from 'node:test'` 换成本文件的记账壳。
// 壳自己 import 'node:test' 时不能再换一次（否则无限递归），用 parentURL 认出来放行。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:test' && context.parentURL !== WRAPPER) {
      return { url: WRAPPER, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node tests/helpers/merged-entry.mjs <测试文件…>')
  process.exit(2)
}
const resolved = []
for (const file of files) {
  const absolute = path.isAbsolute(file) ? file : path.join(ROOT, file)
  if (!existsSync(absolute)) {
    console.error(`合并批次里登记了不存在的文件：${file}`)
    process.exit(2)
  }
  resolved.push(absolute)
}

/**
 * 自收摊脚本（不用 `node:test`、结尾自己 `process.exit()` 的那些）也能并进批次：
 * 把 `process.exit` 在批次期间换成「记账 + 抛哨兵」，哨兵在 import 处被接住，
 * 于是它只结束**自己这个文件**，不会把整批进程带走。
 */
class ScriptExit extends Error {
  constructor(code) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

const realExit = process.exit
let strayExit = null
let interceptedExit = null
process.exit = (code = 0) => {
  const numeric = Number(code)
  const safe = Number.isFinite(numeric) ? numeric : 0
  interceptedExit = safe
  throw new ScriptExit(safe)
}
// 脚本也可能在定时器/回调里 exit（import 早就返回了）：接住哨兵，别让整批陪葬；
// 但要记下来，批次结束时按「该文件没跑完」判红（不静默吞掉）。
process.on('uncaughtException', (error) => {
  if (error instanceof ScriptExit) { strayExit = error.code; return }
  throw error
})

let tap = 0
let exitCode = 0
/** 批次的「批级」证据：整批 tap 计数与逐文件计数之和，用来判断有没有事件没归到文件上 */
const batchTap = { tests: 0, pass: 0, fail: 0, skip: 0, suiteFail: 0 }

/**
 * node 的 TAP 报告走**独立文件**（runner 用 `--test-reporter-destination` 指过来），
 * 因此这里的 stdout 不会被 node 的输出动过手脚，逐文件朗读时也不必和 stdout 抢顺序。
 *
 * 难点只有一个：**报告是用例落定之后的下一轮宏任务里才写出去的**（实测：死等 `setImmediate`
 * 一次不够，报告会比框架行晚一轮）。所以这里不做「固定睡多久」的猜测，而是**自校验地等**：
 *
 *   ① 等到本文件该有的结果行都出现了（条数 ≥ 我们登记的用例数）；
 *   ② 并且文件连续两拍不再增长（尾部的 YAML 块、子用例都写完了）；
 *   ③ 超过上限（2s）还没等到 ⇒ 记 `settleTimedOut`，该文件判红（**宁可红，不许假绿**）。
 *
 * 时间只用来「决定什么时候读」，不用来「决定红不红」：红不红仍由 node 的判定说了算，
 * 而整批在 helpers/runtime.mjs 里还会拿完整的 TAP 文件复核逐文件计数之和。
 */
const tapLog = process.env.MERGED_TAP_LOG || ''
/** 等报告的堆叠上限（ms）：正常情况 2~10ms 就到齐，2s 只是防死等 */
const TAP_SETTLE_MAX_MS = 2000
let tapOffset = 0
let settleTimedOut = false

const tapSize = () => {
  try { return statSync(tapLog).size } catch { return 0 }
}

/** 从当前偏移读出「已收口的完整行」，以及没写完的那半行（下次再读） */
const readTapChunk = () => {
  if (!tapLog) return { complete: '', pending: 0 }
  const size = tapSize()
  if (size <= tapOffset) return { complete: '', pending: 0 }
  const fd = openSync(tapLog, 'r')
  let chunk
  try {
    const buffer = Buffer.alloc(size - tapOffset)
    const read = readSync(fd, buffer, 0, buffer.length, tapOffset)
    chunk = buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) return { complete: '', pending: Buffer.byteLength(chunk, 'utf8') }
  const complete = chunk.slice(0, lastNewline + 1)
  return { complete, pending: Buffer.byteLength(chunk, 'utf8') - Buffer.byteLength(complete, 'utf8') }
}

/** 只看不推进：用于「该来的都来了没有」 */
const peekTap = () => parseTap(readTapChunk().complete)

/** 推进偏移并返回这一段的事件 */
const commitTap = () => {
  const { complete } = readTapChunk()
  tapOffset += Buffer.byteLength(complete, 'utf8')
  return parseTap(complete)
}

/** 把事件折成计数（用例 / 套件分开：套件不是用例，`describe` 里的用例各自计过一次） */
const countEvents = (events) => {
  const counts = { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, suites: 0, suiteFail: 0 }
  for (const event of events) {
    if (event.kind === 'suite') { counts.suites++; if (!event.ok) counts.suiteFail++; continue }
    counts.tests++
    if (event.directive === 'SKIP') counts.skip++
    else if (event.directive === 'TODO') counts.todo++
    else if (event.ok) counts.pass++
    else counts.fail++
  }
  return counts
}

/**
 * 等本文件的 TAP 落定后提交。`expectedTests` = 我们在这个文件里登记到的用例数。
 * 用 `node:timers/promises` 的 setTimeout：用例文件可能把 globalThis.setTimeout 换成假时钟，
 * 屏障不能跟着被换掉。
 */
const settleTap = async (expectedTests) => {
  settleTimedOut = false
  if (!tapLog) return null
  const deadline = performance.now() + TAP_SETTLE_MAX_MS
  let lastSize = tapSize()
  let quiet = 0
  for (;;) {
    const counts = countEvents(peekTap())
    const size = tapSize()
    if (size === lastSize) quiet += 1
    else { quiet = 0; lastSize = size }
    if (counts.tests >= expectedTests && quiet >= 2) break
    if (performance.now() > deadline) { settleTimedOut = expectedTests > 0 || counts.tests > 0; break }
    await sleep(2)
  }
  return countEvents(commitTap())
}

/** 依次加载并跑完每个文件；每个文件的用例事件在这一段里被收成 TAP 行与计数 */
const runFile = async (file, source, baseline) => {
  const name = rel(file)
  const counters = { tests: 0, pass: 0, fail: 0, skip: 0 }
  const snapshot = baseline.globals
  const startedAt = performance.now()
  console.log(`>> FILE ${name}`)
  setListener((event) => {
    if (event.type === 'fail') {
      // 钩子/套件体的失败不是一条用例（`kind: 'hook'`），计进 fail 但不计进 tests
      if (event.kind !== 'hook') counters.tests++
      counters.fail++
      console.log(`not ok ${++tap} - ${event.name}`)
      const message = event.error?.message ?? event.error
      if (message) console.log(`  # ${String(message).split('\n')[0]}`)
      return
    }
    counters.tests++
    if (event.skip !== undefined) {
      counters.skip++
      console.log(`ok ${++tap} - ${event.name} # SKIP${event.skip ? ` ${event.skip}` : ''}`)
      return
    }
    counters.pass++
    console.log(`ok ${++tap} - ${event.name}`)
  })
  const nodeTest = /(?:from\s*|import\s*|require\(\s*)['"]node:test['"]/.test(source)
  const exitCodeBefore = process.exitCode
  interceptedExit = null
  let crashed = null
  try {
    await import(pathToFileURL(file).href)
    await drain()
  } catch (error) {
    if (!(error instanceof ScriptExit)) crashed = error
  }
  // #501：node 的报告比用例落定晚一轮宏任务，这里自校验地等它写全（见 settleTap）
  const tapCounts = await settleTap(counters.tests)
  const ms = Math.round(performance.now() - startedAt)
  setListener(null)
  reset()
  /**
   * #513：文件级复位 —— 这是本单的核心改动，两条路都要走：
   *   ① `restoreGlobals`（#366 原有行为，逐文件立刻复原 globalThis）；
   *   ② `resetAllTestState`：再兜一次全局 + 还原 `process.env` + 清掉文件漏掉的定时器 +
   *      调已登记的清场函数（模块级单例，见 ./merged-tracker.mjs）。
   * 差集非空就打一行 `·· reset`：**谁在污染是证据，不许静默**。没有这一行就等于「没人知道
   * 上一个文件把什么留在了进程里」，下一个人又要去查一个不存在的产品问题（本单的起因）。
   */
  const undone = resetAllTestState(baseline, { file: name })
  const resetNote = describeReset(undone)
  if (resetNote) console.log(`·· reset ${name}：${resetNote}`)
  // 脚本自己设的 `process.exitCode = 1` 也要算数（不能把失败留在进程上，否则整批判红）
  const declaredCode = process.exitCode === exitCodeBefore ? 0 : Number(process.exitCode ?? 0)
  process.exitCode = exitCodeBefore
  const scriptCode = interceptedExit ?? (declaredCode || 0)
  interceptedExit = null
  if (crashed) {
    // import 就抛错（语法/依赖/顶层装配失败）：这个文件一条用例都没跑成，必须判失败
    counters.fail++
    console.log(`not ok ${++tap} - <加载失败> ${name}`)
    console.log(`  # ${String(crashed?.message ?? crashed).split('\n')[0]}`)
  }
  // 不用 node:test 的自收摊脚本：结局只看它自己的退出码（与 #366 之前 runCase 的判法一致）
  const scriptStyle = !nodeTest
  if (scriptStyle && scriptCode !== 0) {
    counters.fail++
    console.log(`not ok ${++tap} - <脚本退出码 ${scriptCode}> ${name}`)
  }
  // #501：结局由 ./merge-verdict.mjs 定 —— node 的 TAP 判定优先，我们的记账只补「哪条红了」。
  let outcome = verdictOf({
    tracked: counters,
    tap: tapCounts,
    nodeTest,
    scriptOk: !crashed && scriptCode === 0,
  })
  const reported = countsOf({ tracked: counters, tap: tapCounts })
  if (settleTimedOut) {
    console.log(`!! ${name}：等 node 的 reporter 超过 ${TAP_SETTLE_MAX_MS}ms 还没写全，判定不可信（按红处理）`)
    if (outcome === 'PASS' || outcome === 'SKIP' || outcome === 'EMPTY') outcome = 'FAIL'
  }
  for (const note of mismatchNotes({ tracked: counters, tap: tapCounts })) {
    console.log(`!! ${name}：${note}`)
  }
  if (tapCounts) {
    batchTap.tests += tapCounts.tests
    batchTap.pass += tapCounts.pass
    batchTap.fail += tapCounts.fail
    batchTap.skip += tapCounts.skip
    batchTap.suiteFail += tapCounts.suiteFail
  }
  console.log(`<< FILE ${name} ${outcome} tests=${reported.tests} pass=${reported.pass} fail=${reported.fail} skip=${reported.skip} ms=${ms}${scriptStyle ? ` script=${scriptCode}` : ''}`)
  if (outcome === 'FAIL' || outcome === 'EMPTY') exitCode = 1
}

/**
 * #513：批次开始抓一份干净基线（globalThis / process.env）+ 装定时器记账。
 * 每个文件跑完都复位到这份基线，而不是「复位到上一个文件留下的样子」。
 */
const timers = installTimerTracker()
const baseline = captureTestState({ timers })
for (const file of resolved) {
  await runFile(file, readFileSync(file, 'utf8'), baseline)
}
timers.uninstall()

// 批内有文件起了服务/定时器没关干净时事件循环可能挂着不退出 —— 用例都跑完了，直接收工。
// 先等 stdout 冲干净再 exit，避免最后的汇总行被截掉。
if (strayExit !== null) {
  // 脚本在 import 之后的回调里调了 exit：整批已无法归因，判批次失败让 runner 单文件重跑
  console.error(`批内有文件在异步回调里调用了 process.exit(${strayExit})，本批结果不可信`)
  exitCode = 1
}
process.exitCode = exitCode
// 收工时再看一眼：还有 TAP 事件没归到任何文件上（异步收尾、末条晚写），说明逐文件归因不完整 ——
// 这**不许**当成绿。runner 那边还会用完整的 TAP 文件复核一遍（见 helpers/runtime.mjs）。
const trailing = await settleTap(0)
if (trailing && (trailing.tests > 0 || trailing.suiteFail > 0)) {
  console.error(`!! 批尾还有 ${trailing.tests} 条用例 / ${trailing.fail + trailing.suiteFail} 条失败没归到文件：${trailing.tests + trailing.suites > 0 ? '（见 node 的 TAP 文件）' : ''}`)
  exitCode = 1
}
await new Promise((resolve) => process.stdout.write('', resolve))
process.exit = realExit
process.exit(exitCode)
