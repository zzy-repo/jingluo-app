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
