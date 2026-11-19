// 合并批次的「用例记账」：谁注册了用例、什么时候真的跑完。
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
export const state = { pending: new Set(), listener: null }

/** 装事件监听：`{ type: 'pass'|'fail', name, skip, error }` */
export const setListener = (listener) => { state.listener = listener }

/**
 * 记一条用例。`skipOf()` 在落定时求值 —— 用例内 `t.skip()` 只有跑完才知道。
 * 返回的 promise **永远兑现**（失败的用例由 node:test 自己报），这样 drain 不会因为一条
 * 红用例提前抛出去，也不会制造第二次未捕获拒绝。
 */
export const track = (promise, { name, skipOf } = {}) => {
  const settled = Promise.resolve(promise).then(
    () => {
      const skip = typeof skipOf === 'function' ? skipOf() : skipOf
      notify({ type: 'pass', name, skip })
    },
    (error) => { notify({ type: 'fail', name, error }) },
  )
  state.pending.add(settled)
  void settled.then(() => state.pending.delete(settled))
  return promise
}

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
