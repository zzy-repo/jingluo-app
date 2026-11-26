// [layer: unit | 依赖: 无（纯 Node） | 耗时: <2s]
//
// Issue #896 **3c-2**：`chat/streamBreakout.ts` 的「静默补试」压回 `stream` 类策略。
//
// ## 改前真有的问题（不是假想）
//
// 断流那一档的五个数字原本是本文件的私有常量：
//   `STREAM_BREAK_RETRY_LIMIT = 5` / `STREAM_BREAK_PARTIAL_RETRY_LIMIT = 1` /
//   `STREAM_BREAK_RETRY_BUDGET_MS = 60_000` / `STREAM_BREAK_PARTIAL_MAX_CHARS = 150` /
//   `STREAM_BREAK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]`
// 而同一个类（`stream`）在 `net/requestPolicy.ts` 里另有一行 `retry = 2`。
// **两处都能改、都能编译通过**，改哪一处生效取决于「谁问了哪个问题」——
// 这就是 #896 立项要收掉的东西。改后数字只在 `LIMITS.streamBreakout` 写一次，
// `REQUEST_POLICY.stream.silent` 是它的投影，本文件只读结论。
//
// ## 必须同时守住的前提：**已发出的内容不能撤回，所以不能悄悄重发**
//
// 迁移会动「次数」和「条件」两处。次数改了最多是体验问题；条件改了是**用户可见的重复内容
// + 上游重复计费**（#105 / #150）。本文件把这条前提单独钉成 K1~K3：
//   K1 一个字都没看到 → 允许静默补试，且**不许**丢弃任何内容（没有内容可丢）；
//   K2 已经看到内容 → 只有内容 `< 阈值` 才允许补一次，且 `discardPartial` **必须**为 true
//      （「重发」与「留着旧内容」不能同时成立）；内容 `>= 阈值` 一次都不补；
//   K3 只要 `retry === false`，`discardPartial` 就必须是 false —— 不重发就没有「丢内容」这回事。
//
//   node --test tests/unit/stream-breakout-policy-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

const breakout = await import('../../src/services/chat/streamBreakout.ts')
const { requestPolicyOf, silentRetryOf } = await import('../../src/services/net/requestPolicy.ts')
const { LIMITS } = await import('../../src/services/limits.ts')

const {
  STREAM_BREAK_RETRY_LIMIT,
  STREAM_BREAK_PARTIAL_RETRY_LIMIT,
  STREAM_BREAK_RETRY_BUDGET_MS,
  STREAM_BREAK_PARTIAL_MAX_CHARS,
  STREAM_BREAK_RETRY_DELAYS_MS,
  decideStreamBreakout,
  streamBreakRetryDelayMs,
} = breakout

/** 源码去掉注释（块注释 + 行注释）：只判**代码**里还有没有裸数字 */
const codeOf = (path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('[B1] 五个常量的值全部来自 stream 的静默补试档，不再各写一份', () => {
  const silent = silentRetryOf('stream')
  assert.equal(STREAM_BREAK_RETRY_LIMIT, silent.attempts)
  assert.equal(STREAM_BREAK_PARTIAL_RETRY_LIMIT, silent.partialAttempts)
  assert.equal(STREAM_BREAK_RETRY_BUDGET_MS, silent.budgetMs)
  assert.equal(STREAM_BREAK_PARTIAL_MAX_CHARS, silent.partialMaxChars)
  assert.deepEqual([...STREAM_BREAK_RETRY_DELAYS_MS], [...silent.delaysMs])
  // 值本身一个没改（迁移不改行为）
  assert.equal(STREAM_BREAK_RETRY_LIMIT, 5)
  assert.equal(STREAM_BREAK_PARTIAL_RETRY_LIMIT, 1)
  assert.equal(STREAM_BREAK_RETRY_BUDGET_MS, 60_000)
  assert.equal(STREAM_BREAK_PARTIAL_MAX_CHARS, 150)
  assert.deepEqual([...STREAM_BREAK_RETRY_DELAYS_MS], [1000, 2000, 4000, 8000])
  // 与 `LIMITS` 是同一份（改 LIMITS 不改这里 → 这条红）
  assert.equal(STREAM_BREAK_RETRY_LIMIT, LIMITS.streamBreakout.silentAttempts)
  assert.equal(STREAM_BREAK_RETRY_BUDGET_MS, LIMITS.streamBreakout.silentBudgetMs)
  assert.equal(STREAM_BREAK_PARTIAL_MAX_CHARS, LIMITS.streamBreakout.partialMaxChars)
})

test('[B2] 本文件读的是策略表本身，且代码里不再有这五个数字（改前两样都不成立）', () => {
  const raw = readFileSync(new URL('../../src/services/chat/streamBreakout.ts', import.meta.url), 'utf8')
  assert.equal(
    raw.includes("from '../net/requestPolicy.js'"),
    true,
    '改前本文件不 import 策略表（数字全是自己写的），改后必须读同一份' 
  )
  const code = codeOf('../../src/services/chat/streamBreakout.ts')
  for (const literal of ['= 5', '60_000', '60000', '= 150', '1000, 2000, 4000, 8000']) {
    assert.equal(
      code.includes(literal),
      false,
      `chat/streamBreakout.ts 的代码里还写着 ${literal}：这个数字必须只在 LIMITS.streamBreakout 写一次`
    )
  }
})

test('[B3] 静默补试档只有 stream 类有；control / data 用错了要当场红（不是静默给空值）', () => {
  assert.notEqual(requestPolicyOf('stream').silent, null)
  assert.equal(requestPolicyOf('control').silent, null)
  assert.equal(requestPolicyOf('data').silent, null)
  assert.throws(() => silentRetryOf('control'), /control/, '用错类必须抛错')
  assert.throws(() => silentRetryOf('data'), /data/)
})

test('[K1] 一个字都没看到：允许补试，且没有内容可丢', () => {
  const d = decideStreamBreakout({ receivedChars: 0, kind: 'interrupted', retriedCount: 0 })
  assert.equal(d.retry, true)
  assert.equal(d.maxRetries, STREAM_BREAK_RETRY_LIMIT)
  assert.equal(d.discardPartial, false, '没有内容可丢')
  assert.equal(d.budgetMs, STREAM_BREAK_RETRY_BUDGET_MS)
  assert.equal(d.retryDelayMs, streamBreakRetryDelayMs(0))
})

test('[K2] 已经看到内容：< 阈值补一次且必须丢弃重来；>= 阈值一次都不补', () => {
  const small = decideStreamBreakout({
    receivedChars: 1,
    kind: 'interrupted',
    retriedCount: 0,
  })
  assert.equal(small.retry, true, '内容很少时允许补一次')
  assert.equal(small.maxRetries, STREAM_BREAK_PARTIAL_RETRY_LIMIT)
  assert.equal(
    small.discardPartial,
    true,
    '「重发」与「留着旧内容」不能同时成立 —— 必须丢弃已收到的半截'
  )

  const edge = decideStreamBreakout({
    receivedChars: STREAM_BREAK_PARTIAL_MAX_CHARS - 1,
    kind: 'idle',
    retriedCount: 0,
  })
  assert.equal(edge.retry, true, '149 字仍补一次（口径严格小于 150）')
  assert.equal(edge.discardPartial, true)

  const big = decideStreamBreakout({
    receivedChars: STREAM_BREAK_PARTIAL_MAX_CHARS,
    kind: 'interrupted',
    retriedCount: 0,
  })
  assert.equal(big.retry, false, '150 字不补（边界不许漂移）')
  assert.equal(big.maxRetries, 0)
  assert.equal(big.discardPartial, false, '不重发就不谈丢内容')
})

test('[K3] 只要 retry === false，discardPartial 就必须是 false（全格穷举）', () => {
  const kinds = [undefined, 'interrupted', 'idle', 'network', 'http', 'auth']
  for (const kind of kinds) {
    for (const receivedChars of [0, 1, 149, 150, 151, 5_000]) {
      for (const retriedCount of [0, 1, 4, 5, 99]) {
        const d = decideStreamBreakout({ receivedChars, kind, retriedCount })
        if (!d.retry) {
          assert.equal(
            d.discardPartial,
            false,
            `kind=${String(kind)} chars=${receivedChars} retried=${retriedCount}：不重发却要求丢内容`
          )
        } else {
          // 反过来：要重发且已经有内容 ⇒ 必须丢弃（否则用户看到两份）
          assert.equal(
            d.discardPartial,
            receivedChars > 0,
            `kind=${String(kind)} chars=${receivedChars} retried=${retriedCount}：重发时的丢弃口径不对`
          )
        }
      }
    }
  }
})

test('[B4] 静默补试的次数上限由策略给：第 N 次之后不再补，且退避序列封顶', () => {
  const d = decideStreamBreakout({
    receivedChars: 0,
    kind: 'interrupted',
    retriedCount: STREAM_BREAK_RETRY_LIMIT,
  })
  assert.equal(d.retry, false, '到了上限就不许再补')
  assert.equal(d.maxRetries, STREAM_BREAK_RETRY_LIMIT)
  // 退避序列用完封顶，绝不指数爆炸（否则 60s 预算一撞就白等）
  const last = STREAM_BREAK_RETRY_DELAYS_MS.at(-1)
  assert.equal(streamBreakRetryDelayMs(0), 1000)
  assert.equal(streamBreakRetryDelayMs(99), last)
  // 全部退避之和必须落在总预算之内（改预算不改序列 → 这条红）
  const total = [0, 1, 2, 3, 4].reduce((sum, n) => sum + streamBreakRetryDelayMs(n), 0)
  assert.ok(total < STREAM_BREAK_RETRY_BUDGET_MS, `退避总和 ${total} 必须小于总预算`)
})

test('[B5] 预算优先于次数：超预算立刻停，哪怕次数还没用完', () => {
  const over = decideStreamBreakout({
    receivedChars: 0,
    kind: 'idle',
    retriedCount: 0,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS,
  })
  assert.equal(over.retry, false, '60s 到了就不许再发')
  const justUnder = decideStreamBreakout({
    receivedChars: 0,
    kind: 'idle',
    retriedCount: 0,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS - 1,
  })
  assert.equal(justUnder.retry, true, '差 1ms 仍然可以再试一次')
})
