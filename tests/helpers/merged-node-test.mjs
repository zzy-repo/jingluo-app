// `node:test` 的记账壳：把 `test()` 包一层，好让合并入口知道「这个文件的用例跑完了没有、红了没有」。
//
// ## #501（P0）：为什么不能只看 promise
//
// `test()` 返回的 promise 在**断言失败时依然 fulfilled**（node v22/v24 实测；红只体现在 node 自己的
// 报告里）。原来这里就靠它判绿，于是合并批次里 `assert.equal(1, 2)` 报 `PASS tests=1 pass=1 fail=0`。
//
// 现在用例体被包一层，**它抛出来的错误在这里被捕获**（同步抛 + 异步 reject 两条路），交给
// ./merged-tracker.mjs 的 `failOf()`；`node:test` 自己的判定不受影响（错误原样抛回去）。
// 三类「包在外层就看不见」的失败一并处理：
//   · 嵌套用例 `t.test(...)` / `describe(...)` 体抛错 → 记到父用例上（子红 ⇒ 父红）；
//   · 钩子 `before/after/beforeEach/afterEach` 抛错 → 记一条文件级失败（钩子不属于某条用例）；
//   · 其余 node 只在自己的报告里体现的失败（超时、`t.plan` 数量不符、未捕获异常）——
//     由 ./tap.mjs 读 node 的 TAP 报告兜底，判定见 ./merge-verdict.mjs（**以那份为准**）。
//
// 其余导出原样透传（`export * from 'node:test'`），所以 `import { test } from 'node:test'`
// 换成这个壳之后行为一致 —— 换壳只发生在合并批次内部（merged-entry 的 resolve hook）。
import * as realTest from 'node:test'
import { recordFailure, track } from './merged-tracker.mjs'

export * from 'node:test'

/** 把用例上下文包一层：捕获 `t.skip()`、把嵌套用例的失败记到父用例上，其余属性原样透传 */
const wrapContext = (context, { onSkip, onFailure }) => {
  if (!context || typeof context !== 'object') return context
  const nested = (name, call) => (...args) => {
    const wrapped = args.map((arg) => (typeof arg === 'function' ? observeBody(arg, { onFailure }) : arg))
    const result = call(...wrapped)
    // 子用例红 ⇒ 父用例红：node 对「父用例体内没有抛错、但子用例红了」不会拒绝父 promise
    if (result && typeof result.then === 'function') result.then(undefined, (error) => onFailure(error))
    return result
  }
  return new Proxy(context, {
    get(target, property) {
      if (property === 'skip') {
        return (...args) => {
          onSkip()
          return typeof target.skip === 'function' ? target.skip(...args) : undefined
        }
      }
      if (property === 'test' || property === 'describe' || property === 'suite') {
        const call = Reflect.get(target, property, target)
        return typeof call === 'function' ? nested(String(property), call.bind(target)) : call
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * 包一层用例/钩子体：同步抛错与返回的 promise 拒绝都记到 `onFailure`，然后把原错误抛回去
 * （node 该判红还是判红，我们只是多看了一眼）。返回给 node 的仍是原来的返回值。
 */
const observeBody = (body, { onFailure, onSkip = () => {} }) => {
  if (typeof body !== 'function') return body
  return (context, ...rest) => {
    let result
    try {
      result = body(wrapContext(context, { onSkip, onFailure }), ...rest)
    } catch (error) {
      onFailure(error)
      throw error
    }
    if (result && typeof result.then === 'function') {
      // 只观测，不吞、不改变链：派生出来的 promise 自己处理掉拒绝，避免多一条 unhandled rejection
      result.then(undefined, (error) => onFailure(error))
    }
    return result
  }
}

const wrapTest = (original) => (name, options, fn) => {
  let opts = options
  let body = fn
  if (typeof opts === 'function') { body = opts; opts = undefined }
  let skippedInside = false
  let failure = null
  const noteFailure = (error) => { failure ??= error || new Error('用例失败（错误对象缺失）') }
  if (typeof body === 'function') {
    body = observeBody(body, { onFailure: noteFailure, onSkip: () => { skippedInside = true } })
  }
  const promise = original(name, opts, body)
  const declared = opts && typeof opts === 'object' ? opts.skip : undefined
  const skipOf = () => {
    if (declared !== undefined && declared !== false) return typeof declared === 'string' ? declared : ''
    return skippedInside ? '' : undefined
  }
  return track(promise, { name: String(name), skipOf, failOf: () => failure })
}

/** 钩子（before/after/beforeEach/afterEach）：抛错时记一条文件级失败，归属当前文件 */
const wrapHook = (original, label = 'hook') => (fn, ...rest) => {
  if (typeof fn !== 'function') return original(fn, ...rest)
  const name = `${label} 钩子`
  return original(observeBody(fn, { onFailure: (error) => recordFailure(name, error) }), ...rest)
}

/** `describe`/`suite`：体里抛错同样要算红（node 会判它红，我们也要能归因到文件） */
const wrapSuite = (original) => (name, options, fn) => {
  let opts = options
  let body = fn
  if (typeof opts === 'function') { body = opts; opts = undefined }
  if (typeof body !== 'function') return original(name, opts, body)
  return original(name, opts, observeBody(body, { onFailure: (error) => recordFailure(`套件 ${String(name)} 体`, error) }))
}

const wrapped = wrapTest(realTest.test)
// `test.after(...)` / `test.before(...)` / `test.skip(...)` 这类「挂在 test 函数上的工具」要原样带过来，
// 否则用例报 `test.after is not a function`（实测 api-request-timeout）。
for (const key of Object.keys(realTest.test)) {
  if (key in wrapped) continue
  const value = realTest.test[key]
  const wrap = ['before', 'after', 'beforeEach', 'afterEach'].includes(key)
    ? (fn) => wrapHook(fn, key)
    : (fn) => fn
  wrapped[key] = typeof value === 'function' ? wrap(value.bind(realTest.test)) : value
}

export const test = wrapped
export const it = wrapped
export const before = wrapHook(realTest.before, 'before')
export const after = wrapHook(realTest.after, 'after')
export const beforeEach = wrapHook(realTest.beforeEach, 'beforeEach')
export const afterEach = wrapHook(realTest.afterEach, 'afterEach')
export const describe = wrapSuite(realTest.describe)
export const suite = wrapSuite(realTest.suite)
export default wrapped
