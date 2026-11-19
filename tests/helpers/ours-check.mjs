// 「自查断言骨架」—— 不用 `node:test` 的用例文件共用的那一段（Issue #408 收尾批）。
//
// 为什么有它：ours / invite 这一族用例自己数「检查了几项、失败了几项」，末尾打印汇总再
// `process.exit(1)`，所以它们没有 `test()` 用例树，也就借不到 `node:test` 的断言与收摊。
// 代价是同一段 20~30 行的骨架在 4 个文件里逐字抄了 4 份（`check:test-duplication` 直接抓到 3 组），
// 连带的 `fakeTransport` / `json` / `errorBody` 也是三份。
//
// 抽出来的是**装配**，不是断言：`ok` / `bad` / `eq` / `truthy` 的打印格式、计数口径、
// 失败文案与原来逐字相同，每个文件的用例体与末尾汇总（含 `process.exit`）一行没动。
//
//   import { createSelfCheck, fakeTransport, jsonResponse as json } from '../helpers/ours-check.mjs'
//   const { failures, checks, ok, bad, eq, truthy } = createSelfCheck()
//
// `EQ_TOLERANCE`：`eq` 用 `JSON.stringify` 比对（与各文件原来的写法一致），所以
// `1` 与 `'1'` 不相等、`-0` 与 `0` 相等 —— 这一层语义是被测口径的一部分，别改成 deepEqual。

/**
 * 造一套自查断言工具。返回的 `failures` / `checks` 是**可变引用**：
 * 文件里 `truthy(...)` 失败时往 `failures` 里 push，末尾汇总读的就是这个数组。
 *
 * `countBad`：失败是否也计入 `checks.n`。有 4 个文件（ours-api / ours-invite / invite-261 /
 * invite-device-fingerprint）不计，支付/购买两族（ours-inapp-buy / pay-link）计 ——
 * 末尾「共 N 项检查」的数字因此不同。这是**既有口径差异**，不许在这里统一：改了它就是改断言。
 */
export const createSelfCheck = ({ countBad = false } = {}) => {
  const failures = []
  const checks = { n: 0 }
  const ok = (message) => {
    checks.n += 1
    console.log(`  ok  ${message}`)
  }
  const bad = (message) => {
    failures.push(message)
    if (countBad) checks.n += 1
    console.error(`  ✗   ${message}`)
  }
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) {
      ok(`${label} = ${a}`)
    } else {
      bad(`${label}：期望 ${b}，实际 ${a}`)
    }
  }
  const truthy = (condition, label) => (condition ? ok(label) : bad(label))
  return { failures, checks, ok, bad, eq, truthy }
}

/**
 * 顺序回放的假 transport：每次调用记下来，响应可以是对象，也可以是函数。
 * 最后一条响应会被重复使用（`responses.length > 1` 才 shift），这是各文件原本的语义。
 */
export const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}

/** 假 transport 的「成功响应」形状：`{ kind, status, text }`（api.ts 只认这三个字段） */
export const jsonResponse = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

/** 服务端的错误体（`{ error: { code, message } }`），用来断言错误码分类 */
export const errorBody = (code) => ({ error: { code, message: 'server says no' } })
