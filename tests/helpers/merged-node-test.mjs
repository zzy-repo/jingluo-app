// `node:test` 的记账壳：把 `test()` 包一层，好让合并入口知道「这个文件的用例跑完了没有」。
//
// 只做两件事，**不改任何用例语义**：
//   1. 把 `test()` 的 promise（node:test 本来就在「跑完即兑现」时兑现它）交给
//      ./merged-tracker.mjs 记账，返回给用例的仍是原 promise；
//   2. 用例内 `t.skip()` 与 `{ skip: … }` 都按跳过上报（跳过必须指名道姓，见 run-layer 的 NODE-SKIP）。
// 其余导出原样透传（`export * from 'node:test'`），所以 `import { test } from 'node:test'`
// 换成这个壳之后行为一致 —— 换壳只发生在合并批次内部（merged-entry 的 resolve hook）。
import * as realTest from 'node:test'
import { track } from './merged-tracker.mjs'

export * from 'node:test'

/** 把用例上下文包一层，只为捕获 `t.skip()`；其余属性原样透传 */
const watchSkips = (context, onSkip) => {
  if (!context || typeof context !== 'object') return context
  return new Proxy(context, {
    get(target, property) {
      if (property === 'skip') {
        return (...args) => {
          onSkip()
          return typeof target.skip === 'function' ? target.skip(...args) : undefined
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const wrapTest = (original) => (name, options, fn) => {
  let opts = options
  let body = fn
  if (typeof opts === 'function') { body = opts; opts = undefined }
  let skippedInside = false
  if (typeof body === 'function') {
    const originalBody = body
    body = (context, ...rest) => originalBody(watchSkips(context, () => { skippedInside = true }), ...rest)
  }
  const promise = original(name, opts, body)
  const declared = opts && typeof opts === 'object' ? opts.skip : undefined
  const skipOf = () => {
    if (declared !== undefined && declared !== false) return typeof declared === 'string' ? declared : ''
    return skippedInside ? '' : undefined
  }
  return track(promise, { name: String(name), skipOf })
}

const wrapped = wrapTest(realTest.test)
// `test.after(...)` / `test.before(...)` / `test.skip(...)` 这类「挂在 test 函数上的工具」要原样带过来，
// 否则用例报 `test.after is not a function`（实测 api-request-timeout）。
for (const key of Object.keys(realTest.test)) {
  if (key in wrapped) continue
  const value = realTest.test[key]
  wrapped[key] = typeof value === 'function' ? value.bind(realTest.test) : value
}

export const test = wrapped
export const it = wrapped
export default wrapped
