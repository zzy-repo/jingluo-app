// urlImport 一族的**共用夹具构造器**（Issue #408 收尾批）。
//
// 为什么有它：`zipBytes` 这段 8 行在 6 个 urlImport 用例文件里逐字相同（import-clock-monotonic /
// url-import-content-range / import-budget-vs-stall / url-import-stall /
// log-313-attachment-import / import-network-classification）。单看 8 行不到 `check:test-duplication`
// 的 20 行窗口，所以一直没被点出来；但它和 `rangeOf` / `resetEnv` / `records` 拼在一起就凑成一组，
// 说明「同一份构造器抄 6 遍」这件事本身是真的。
//
// 语义不变：字节内容、填充规则（`index % 251`）逐字沿用原文件 —— 这些用例断言的是
// 「服务端声称的体积 vs 实收体积」，字节只是一个**长度可预期**的假包体，不参与内容校验。

/**
 * 造一个「声称这么大」的 ZIP 字节：前 4 字节是 PK\x03\x04 头，其余按 `index % 251` 填充。
 * 确定性 + 可压缩性差，正好用来做分块 / Range / 上限判定的假数据。
 */
export const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

/**
 * 真实时钟毫秒数（Issue #459）。
 *
 * `node:test` 的假 timer 会把 `Date` 换成假的，所以「到底真等了多久」只能用
 * `process.hrtime` —— 否则 deadline 会被假时钟拖着一起走，等于没有 deadline。
 */
export const realElapsedMs = () => Number(process.hrtime.bigint() / 1_000_000n)

/**
 * 等一个「一定会来的终态」，但**只等 deadlineMs 真实毫秒**（Issue #459）。
 *
 * 为什么必须有：本族用例断言的是「无新字节到窗口上限就判死」。这条判据一旦失效
 * （例如 `stallVerdict()` 恒 `null`），被测导入既不会 resolve 也不会 reject，
 * `await` 就变成永久挂起 —— CI 里看到的是 `cancelled` / job 超时，失败信号里一句人话都没有。
 * 所以「等终态」这件事本身要自带 deadline：到点返回 `{ state: 'hung' }`，
 * 由用例 `assert.fail` 出一句「停滞判死失效」，几秒内红。
 *
 * 三种态由调用方补齐语义：
 *   `settled` + 成功值            → completed（停滞场景下「不该发生」）
 *   `settled` + 失败终态          → 判死（stalled / deadline / …）
 *   `hung`                        → 既没 resolve 也没 reject（判据不见了）
 *
 * @param promise 被等的终态（**不要**自己再 await 它）
 * @param deadlineMs 真实毫秒预算
 * @param pump 每轮轮询前调一次（假 timer 用例用它推进假时钟）；可省略
 * @returns {Promise<{state:'settled', value:unknown, realMs:number} | {state:'hung', realMs:number}>}
 */
export const settleInRealTime = async (promise, { deadlineMs = 5_000, pump } = {}) => {
  const startedAt = realElapsedMs()
  const box = { done: false, value: undefined }
  // 只挂回调、不 await：它可能永远不 settle
  promise.then(
    (value) => {
      box.done = true
      box.value = value
    },
    (value) => {
      box.done = true
      box.value = value
    }
  )
  while (!box.done) {
    const elapsed = realElapsedMs() - startedAt
    if (elapsed >= deadlineMs) {
      return { state: 'hung', realMs: elapsed }
    }
    pump?.()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { state: 'settled', value: box.value, realMs: realElapsedMs() - startedAt }
}

/**
 * 同上，但用于**真时钟**的用例：直接和真 `setTimeout` 赛跑，不轮询（Issue #459）。
 *
 * 为什么不统一用 `settleInRealTime`：它的 setImmediate 轮询会在真时钟用例里持续占用
 * 事件循环，把「600ms 预算 vs 150ms/块」这种本来就贴边的用例推过临界点（实测 ① 从
 * 100% 绿变成约 50% 红）。真时钟用例没有假 timer 的干扰，用 Promise.race 才是零扰动的。
 *
 * @param promise 被等的终态（**不要**自己再 await 它）
 * @param deadlineMs 真实毫秒预算
 * @param onHang 判定为 hung 时的收尾钩子（可选，例如 abort 掉导入以停掉心跳 interval）
 * @returns {Promise<{state:'settled', value:unknown, realMs:number} | {state:'hung', realMs:number}>}
 */
export const raceInRealTime = async (promise, { deadlineMs = 5_000, onHang } = {}) => {
  const startedAt = realElapsedMs()
  let timer
  const hung = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'hung', realMs: realElapsedMs() - startedAt }), deadlineMs)
  })
  const settled = promise.then((value) => ({ state: 'settled', value, realMs: realElapsedMs() - startedAt }))
  const outcome = await Promise.race([settled, hung])
  clearTimeout(timer)
  if (outcome.state === 'hung') {
    onHang?.()
  }
  return outcome
}
