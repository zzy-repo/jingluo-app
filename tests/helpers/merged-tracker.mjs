// 合并批次的「用例记账」：谁注册了用例、什么时候真的跑完、跑红了没有。
//
// 为什么需要它（#366 第二批）：`node:test` 的 `run({ isolation: 'none' })` 是**先把批内所有文件
// 都 import 一遍，再统一跑用例**（实测：两个文件的顶层 console.log 都先出现，用例才开跑）。
// 而 L0 的用例文件几乎都在**模块顶层**做装配 —— `createHarness()`、`registerHooks()`、
// `globalThis.localStorage = …`。全部提前加载 = 后一个文件的装配盖住前一个文件，前一个文件的
// 用例就对着别人的假传输跑（实测 domain06 家族 9 个文件里 5 个因此假红）。
//
// 所以这里自己控顺序：一个文件 import 完 → 等它**所有**用例跑完 → 再 import 下一个。
// 记账方式是包一层 `node:test` 的 `test()`（见 ./merged-node-test.mjs）：它返回的 promise 就是
// 「这条用例跑完了」。drain() 等到 pending 清空，顺带处理「用例里又注册用例」的嵌套。
//
// ## #501（P0）：promise 兑现 ≠ 用例通过
//
// 这里**曾经**把「promise 兑现」当成 pass（`then(() => notify({type:'pass'}))`），而断言失败时
// 那个 promise 依然 fulfilled —— 于是 `assert.equal(1, 2)` 在合并批次里是 `PASS tests=1 pass=1 fail=0`、
// 退出码 0。整个 unit 层「全绿」的结论都建立在这上面，属于假绿的源头。
//
// 现在失败有两条来源，缺一不可：
//   1. `failOf()`：用例体（含嵌套 `t.test`、钩子）**抛出来的错误**由 ./merged-node-test.mjs 捕获后
//      交进来 —— 这条能指名道姓「哪条用例红了」；
//   2. node 自己的 TAP 判定（./tap.mjs + ./merge-verdict.mjs）—— 这条兜住我们看不见的失败
//      （钩子、超时、`t.plan` 数量不符、未捕获异常挂到用例上）。**判定以它为准。**
export const state = { pending: new Set(), listener: null }

/** 装事件监听：`{ type: 'pass'|'fail', name, skip, error }` */
export const setListener = (listener) => { state.listener = listener }

/**
 * 记一条用例。`skipOf()` / `failOf()` 在落定时求值 —— 用例内 `t.skip()`、用例体抛错都只有跑完才知道。
 *
 * `failOf()` 返回**错误对象**（truthy）即判红；返回 falsy 就是没观测到失败。
 * 注意它只补观测，不改变 `node:test` 自己的行为：返回给用例的仍是原 promise。
 *
 * 返回的 promise **永远兑现**（失败的用例由 node:test 自己报），这样 drain 不会因为一条
 * 红用例提前抛出去，也不会制造第二次未捕获拒绝。
 */
export const track = (promise, { name, skipOf, failOf } = {}) => {
  const settled = Promise.resolve(promise).then(
    () => {
      const failure = typeof failOf === 'function' ? failOf() : failOf
      if (failure) { notify({ type: 'fail', name, error: failure }); return }
      const skip = typeof skipOf === 'function' ? skipOf() : skipOf
      notify({ type: 'pass', name, skip })
    },
    (error) => { notify({ type: 'fail', name, error }) },
  )
  state.pending.add(settled)
  void settled.then(() => state.pending.delete(settled))
  return promise
}

/**
 * 不挂在某条用例 promise 上的失败（钩子抛错、`describe` 体抛错）。
 * 直接记一条，归属当前正在跑的这个文件。
 *
 * `kind: 'hook'` 很关键：它不是一条用例，计数时**不能**算进 tests（否则「2 条用例 + 1 个钩子红」
 * 会被记成 3 条用例，跟 node 的 reporter 对不上，反而制造假红）。
 */
export const recordFailure = (name, error) => { notify({ type: 'fail', name, error, kind: 'hook' }) }

const notify = (event) => {
  try { state.listener?.(event) } catch { /* 监听里抛错不能连累用例本身 */ }
}

/** 等当前文件注册的用例（含用例里再注册的嵌套用例）全部落定 */
export const drain = async () => {
  let guard = 0
  while (state.pending.size) {
    if (++guard > 10000) break // 死循环用例交给 runner 的进程超时，不在这里判死
    await Promise.all([...state.pending])
  }
}

/** 换文件时清账：上一个文件的 promise 都已 await 过，残留的只是已 settle 的壳 */
export const reset = () => { state.pending.clear() }

// ===========================================================================
// #513：文件级状态复位（见下）
// ===========================================================================
// 文件级状态复位（Issue #513）：合并批次里「上一个文件的残留」不许流到下一个文件。
//
// ## 为什么需要
//
// 合并批次（#366）一个进程顺序跑十几个文件，而下面两样东西都是**进程级、只增不减**的：
//   · ESM 模块缓存与模块级单例（缓存 Map、订阅、patch 过的 Date / performance / fetch）；
//   · `registerHooks()` 装上的解析 hook（没有反注册 API）。
// 所以「文件之间零串扰」不能只靠自觉。#366 已有的 globalThis 快照/还原挡住了「globalThis 上的
// 读写」，挡不住另外三类（都是实测过的 #513 症状）：
//
//   1. **`process.env` 被某个文件改过**（`LANG` / `TZ` / `TEST_AUTH_SEAM` / `NODE_ENV` …）——
//      后面的文件按另一套环境判定，单跑时那套环境不存在，于是「批内红、单跑绿」。
//   2. **`setTimeout` / `setInterval` / `setImmediate` 排下的任务**跑到下一个文件的窗口里：
//      上一条清理定时器（或 `unref` 掉）才让事件循环退出，这里却可能把下一条用例的假传输改掉。
//   3. **模块级单例的状态**（模块内 `let cache = new Map()` / 全局订阅 / 假时钟）：文件跑完它还在。
//
// 本文件负责第 1、2 类（机械可复位）＋给第 3 类提供**登记口径**（`onTestStateReset`）。
// 第 3 类里登记不了的那些（解析 hook 链、模块缓存互相冲突 —— 例如 A 把 `pdfjs-dist` 换成替身、
// B 要真的 pdfjs）**只能独占进程**，登记在 `run-layer.mjs` 的 `UNIT_SOLO`，不在这里硬凑。
//
// ## 用法（只有合并入口该调它）
//
//   const snapshot = captureTestState()          // 批次开始时一次
//   … 每个文件 import + drain + restoreGlobals … 之后：
//   const undone = resetAllTestState(snapshot)   // 差异非空就打在终端上（证据，不静默）
//
// 单文件路径（`runCase`）不需要它：一个进程一个文件，进程退出就是最彻底的复位。

/** 不参与快照/还原的内建（改动它们只会把还原逻辑自己搞坏） */
const PINNED_GLOBALS = new Set(['globalThis', 'undefined', 'Infinity', 'NaN'])

/**
 * 需要登记的「模块级单例清场函数」（`onTestStateReset(() => cache.clear())`）。
 * 只放过**能安全重复调用**的函数；返回 undefined 的函数在下一次复位时被丢掉。
 */
const resetters = []

/**
 * 登记一个「每个文件跑完后执行」的清场函数（#513 第 3 类：模块级单例）。
 * 用例/夹具在模块顶层登记一次即可，批次里每个文件结束后都会调它。
 * **必须是幂等的**：文件没跑完、跑红了，也会调。
 */
export const onTestStateReset = (fn) => {
  if (typeof fn !== 'function') return () => {}
  resetters.push(fn)
  return () => {
    const index = resetters.indexOf(fn)
    if (index >= 0) resetters.splice(index, 1)
  }
}

/** 当前登记的清场函数数量（自检 / 报告用） */
export const testStateResetterCount = () => resetters.length

// ── 全局描述符快照 ──────────────────────────────────────────────────────────
// 与 #366 的 merged-entry 同一口径：按 descriptor 存，不用值比较（`globalThis.x = 1` 与
// `Object.defineProperty` 装上去的，还原方式不一样）。

const snapshotGlobals = () => {
  const snapshot = new Map()
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (PINNED_GLOBALS.has(key)) continue
    snapshot.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  return snapshot
}

const sameDescriptor = (current, wanted) =>
  current && current.value === wanted.value && current.get === wanted.get &&
  current.set === wanted.set && current.enumerable === wanted.enumerable &&
  current.writable === wanted.writable && current.configurable === wanted.configurable

/**
 * 还原 globalThis —— 返回 `{ deleted, restored }` 两个名字数组（空数组 = 这个文件很干净）。
 * 导出给 merged-entry 复用（#366 的行为不变，只是把「还原了什么」变成可核对的数字）。
 */
export const restoreGlobals = (snapshot) => {
  const deleted = []
  const restored = []
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (PINNED_GLOBALS.has(key) || snapshot.has(key)) continue
    try {
      delete globalThis[key]
      deleted.push(key)
    } catch { /* 不可删的内建：留着 */ }
  }
  for (const [key, descriptor] of snapshot) {
    try {
      const current = Object.getOwnPropertyDescriptor(globalThis, key)
      if (sameDescriptor(current, descriptor)) continue
      Object.defineProperty(globalThis, key, descriptor)
      restored.push(key)
    } catch { /* 只读内建：保持原样 */ }
  }
  return { deleted, restored }
}

// ── 定时器记账 ─────────────────────────────────────────────────────────────
// Node 没有「列出当前挂着的定时器」的 API，所以只能自己记账：包装全局的四个排程函数，
// 记下 handle，文件结束时把还没烧掉的清掉（并计数 —— 这是「有文件漏了清理」的证据）。

const TIMER_FUNCTIONS = ['setTimeout', 'setInterval', 'setImmediate']

/**
 * 装定时器记账。合并入口在批次开始时调一次，返回 `{ outstanding, clearAll, uninstall }`。
 * 记账函数**行为与原生一致**（透传参数与返回值），只是把 handle 抄一份。
 */
export const installTimerTracker = () => {
  const live = new Map() // handle → 'timeout' | 'interval' | 'immediate'
  const originals = new Map()
  const clearTimeoutOriginal = globalThis.clearTimeout
  const clearIntervalOriginal = globalThis.clearInterval
  const clearImmediateOriginal = globalThis.clearImmediate

  const track = (kind, original) => function tracked(...args) {
    const handle = original.apply(globalThis, args)
    live.set(handle, kind)
    return handle
  }

  for (const name of TIMER_FUNCTIONS) {
    const original = globalThis[name]
    if (typeof original !== 'function') continue
    originals.set(name, original)
    const kind = name === 'setTimeout' ? 'timeout' : name === 'setInterval' ? 'interval' : 'immediate'
    globalThis[name] = track(kind, original)
  }
  // 清掉的 handle 从账上划掉（否则「文件自己清干净了」也会被算成漏清）
  const forget = (handle) => { live.delete(handle) }
  if (typeof clearTimeoutOriginal === 'function') {
    globalThis.clearTimeout = (handle) => { forget(handle); return clearTimeoutOriginal(handle) }
  }
  if (typeof clearIntervalOriginal === 'function') {
    globalThis.clearInterval = (handle) => { forget(handle); return clearIntervalOriginal(handle) }
  }
  if (typeof clearImmediateOriginal === 'function') {
    globalThis.clearImmediate = (handle) => { forget(handle); return clearImmediateOriginal(handle) }
  }

  return {
    /** 还挂着的定时器条数 */
    outstanding: () => live.size,
    /**
     * 把还挂着的全清掉，返回清掉的条数。
     * 注意用**抓下来的原生** clear*（文件可能把 globalThis.clearTimeout 换成了假时钟）。
     */
    clearAll: () => {
      const handles = [...live.entries()]
      live.clear()
      for (const [handle, kind] of handles) {
        try {
          if (kind === 'interval') (clearIntervalOriginal ?? clearTimeoutOriginal)?.(handle)
          else if (kind === 'immediate') (clearImmediateOriginal ?? clearTimeoutOriginal)?.(handle)
          else (clearTimeoutOriginal ?? clearImmediateOriginal)?.(handle)
        } catch { /* 已烧掉 / 非法 handle：忽略 */ }
      }
      return handles.length
    },
    /** 批次结束卸掉记账（还原成原生函数，理论上不影响任何东西，但别让包装留到进程收尾） */
    uninstall: () => {
      for (const [name, original] of originals) globalThis[name] = original
      if (typeof clearTimeoutOriginal === 'function') globalThis.clearTimeout = clearTimeoutOriginal
      if (typeof clearIntervalOriginal === 'function') globalThis.clearInterval = clearIntervalOriginal
      if (typeof clearImmediateOriginal === 'function') globalThis.clearImmediate = clearImmediateOriginal
      live.clear()
    },
  }
}

// ── process.env 快照 ───────────────────────────────────────────────────────

const snapshotEnv = () => ({ ...process.env })

/**
 * 把 `process.env` 还原成快照：新增的删掉、改过的改回去、删掉的补回来。
 * 返回 `{ added, changed, removed }` 三个名字数组（空 = 没人动过 env）。
 */
const restoreEnv = (snapshot) => {
  const added = []
  const changed = []
  const removed = []
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key]
      added.push(key)
    } else if (process.env[key] !== snapshot[key]) {
      process.env[key] = snapshot[key]
      changed.push(key)
    }
  }
  for (const key of Object.keys(snapshot)) {
    if (!(key in process.env)) {
      process.env[key] = snapshot[key]
      removed.push(key)
    }
  }
  return { added, changed, removed }
}

// ── 对外入口 ───────────────────────────────────────────────────────────────

/**
 * 批次开始时抓一份「干净基线」。
 * `timers` 传 `installTimerTracker()` 的返回值（合并入口装了才传）。
 */
export const captureTestState = ({ timers = null } = {}) => ({
  globals: snapshotGlobals(),
  env: snapshotEnv(),
  timers,
})

/**
 * 一个文件跑完后调：把基线之外的一切复位。**幂等**，跑红的文件也要调（红了更容易留下残渣）。
 *
 * 返回一份差异报告（全空 = 这个文件很干净）：
 *   `{ file, globals: {deleted, restored}, env: {added, changed, removed}, timersCleared, resetters, resettersFailed }`
 * 这里**不打印**：要不要留痕、怎么留痕由调用方决定（合并入口只在非空时打一行）。
 */
export const resetAllTestState = (snapshot, { file = '' } = {}) => {
  const globals = restoreGlobals(snapshot.globals)
  const env = restoreEnv(snapshot.env)
  const timersCleared = snapshot.timers?.clearAll?.() ?? 0
  let resettersRun = 0
  const resettersFailed = []
  for (const resetter of [...resetters]) {
    try {
      resetter()
      resettersRun += 1
    } catch (error) {
      // 清场函数自己炸了不许连累下一个文件 —— 但要留痕（它是「状态没清干净」的证据）
      resettersFailed.push(String(error?.message ?? error).split('\n')[0])
    }
  }
  return { file, globals, env, timersCleared, resetters: resettersRun, resettersFailed }
}

/** 差异报告 → 一行可读证据（合并入口打在终端上）；干净就返回空串 */
export const describeReset = (report) => {
  if (!report) return ''
  const bits = []
  if (report.globals.deleted.length) bits.push(`清掉全局 ${report.globals.deleted.length}（${report.globals.deleted.slice(0, 6).join(', ')}${report.globals.deleted.length > 6 ? '…' : ''}）`)
  if (report.globals.restored.length) bits.push(`还原全局 ${report.globals.restored.length}（${report.globals.restored.slice(0, 6).join(', ')}${report.globals.restored.length > 6 ? '…' : ''}）`)
  const envBits = [...report.env.added, ...report.env.changed, ...report.env.removed]
  if (envBits.length) bits.push(`还原 env ${envBits.length}（${envBits.slice(0, 6).join(', ')}${envBits.length > 6 ? '…' : ''}）`)
  if (report.timersCleared) bits.push(`清掉残留定时器 ${report.timersCleared}`)
  if (report.resetters) bits.push(`跑清场函数 ${report.resetters}`)
  if (report.resettersFailed.length) bits.push(`清场函数报错 ${report.resettersFailed.length}（${report.resettersFailed.join(' / ')}）`)
  return bits.join(' · ')
}
