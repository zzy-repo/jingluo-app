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
//   2. **globalThis 快照/还原**：文件跑完就把全局还原成它动手之前的样子，下一个文件看到的是干净的
//      全局（localStorage / document / window / rAF / `__xxx` 开关一律复原，不许串扰）。
//   3. `registerHooks` 装的解析 hook 没有反注册 API（进程级、只增不减），所以顺序很重要：文件 N
//      注册的 stub 只可能影响 N **之后**的文件，而 N 已经跑完了；且 N 之后加载的文件自己注册的
//      hook 优先级更高（后注册先命中），自己的装配不会被前人的 stub 抢走。
//
// 输出约定（run-layer 靠它把「一批进程」还原成「逐文件结果」）：
//   >> FILE <相对路径>
//   ok N - 用例名 [# SKIP 原因]        ← TAP 行，run-layer 的跳过扫描认这个
//   not ok N - 用例名
//   << FILE <相对路径> PASS|SKIP|FAIL|EMPTY tests=N pass=N fail=N skip=N ms=N
// 退出码：全绿 0；有失败 1。文件崩在 `<< FILE` 之前（import 抛错 / 进程被杀）时它不会有收尾行，
// run-layer 会把「没有收尾行」的文件判为失败 —— 不许「没跑完」被当成「通过」。
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { drain, reset, setListener } from './merged-tracker.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const WRAPPER = pathToFileURL(path.join(HERE, 'merged-node-test.mjs')).href
/** 事件里的 `file` 可能是绝对路径、也可能是 file:// URL —— 统一成仓库相对路径 */
const toAbsolute = (file) => (String(file).startsWith('file:') ? fileURLToPath(String(file)) : String(file))
const rel = (file) => path.relative(ROOT, toAbsolute(file)).split(path.sep).join('/')

/** 不参与快照/还原的内建（改动它们只会把还原逻辑自己搞坏） */
const PINNED = new Set(['globalThis', 'undefined', 'Infinity', 'NaN'])

const snapshotGlobals = () => {
  const snapshot = new Map()
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (PINNED.has(key)) continue
    snapshot.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  return snapshot
}

const restoreGlobals = (snapshot) => {
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (PINNED.has(key) || snapshot.has(key)) continue
    try { delete globalThis[key] } catch { /* 不可删的内建：留着 */ }
  }
  for (const [key, descriptor] of snapshot) {
    try {
      const current = Object.getOwnPropertyDescriptor(globalThis, key)
      if (current && current.value === descriptor.value && current.get === descriptor.get) continue
      Object.defineProperty(globalThis, key, descriptor)
    } catch { /* 只读内建：保持原样 */ }
  }
}

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
  const absolute = file.startsWith('/') ? file : path.join(ROOT, file)
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

/** 依次加载并跑完每个文件；每个文件的用例事件在这一段里被收成 TAP 行与计数 */
const runFile = async (file, source) => {
  const name = rel(file)
  const counters = { tests: 0, pass: 0, fail: 0, skip: 0 }
  const snapshot = snapshotGlobals()
  const startedAt = performance.now()
  console.log(`>> FILE ${name}`)
  setListener((event) => {
    counters.tests++
    if (event.type === 'fail') {
      counters.fail++
      console.log(`not ok ${++tap} - ${event.name}`)
      const message = event.error?.message ?? event.error
      if (message) console.log(`  # ${String(message).split('\n')[0]}`)
      return
    }
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
  const ms = Math.round(performance.now() - startedAt)
  setListener(null)
  reset()
  restoreGlobals(snapshot)
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
  const outcome = counters.fail
    ? 'FAIL'
    : counters.pass ? 'PASS'
      : counters.skip ? 'SKIP'
        : scriptStyle ? 'PASS'
          : 'EMPTY'
  console.log(`<< FILE ${name} ${outcome} tests=${counters.tests} pass=${counters.pass} fail=${counters.fail} skip=${counters.skip} ms=${ms}${scriptStyle ? ` script=${scriptCode}` : ''}`)
  if (outcome === 'FAIL' || outcome === 'EMPTY') exitCode = 1
}

for (const file of resolved) {
  await runFile(file, readFileSync(file, 'utf8'))
}

// 批内有文件起了服务/定时器没关干净时事件循环可能挂着不退出 —— 用例都跑完了，直接收工。
// 先等 stdout 冲干净再 exit，避免最后的汇总行被截掉。
if (strayExit !== null) {
  // 脚本在 import 之后的回调里调了 exit：整批已无法归因，判批次失败让 runner 单文件重跑
  console.error(`批内有文件在异步回调里调用了 process.exit(${strayExit})，本批结果不可信`)
  exitCode = 1
}
process.exitCode = exitCode
await new Promise((resolve) => process.stdout.write('', resolve))
process.exit = realExit
process.exit(exitCode)
