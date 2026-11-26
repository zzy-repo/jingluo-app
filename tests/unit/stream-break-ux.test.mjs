// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 断流体验（stream break UX）：**「中断」不是「报错」** —— 判定口径收成一个纯函数。
//
//   node tests/unit/stream-break-ux.test.mjs
//
// 背景：用户报「流式传输中断时前端会报错」。复现（docs/ui/streambreak-before-*.png）看到的是
// 三种断流形态**全都**渲染成红色错误条（rgb(236,19,19) + ⚠ 图标），而已收到的内容其实还在。
//
// 产品 2026-11-25 拍板的口径（本文件的唯一判据来源，改口径先改 `chat/streamBreakout.ts`）：
//
//   | 场景                          | 自动重试        | 已收到的内容       |
//   | ----------------------------- | --------------- | ------------------ |
//   | 首字节前断（receivedChars 0） | 5 次，1/2/4/8s 退避，60s 总预算 | 无内容可谈 |
//   | 首字节后断，< 150 字           | 1 次            | **丢弃重来**（discardPartial） |
//   | 首字节后断，>= 150 字          | 0 次            | 保留（软提示 + 重新生成） |
//   | idle 卡住，0 字                | 同「首字节前」   | 无内容可谈 |
//   | idle 卡住，有内容              | 按上面 150 字阈值 | 同上 |
//   | 4xx / 内容审核 / 额度 / 鉴权 / 参数 | 0 次        | 保留（既有文案不动） |
//
// 两条铁律（本文件逐条钉住）：
//   A. `discardPartial` 只在「retry 为 true 且 receivedChars > 0」时成立 —— 不许出现
//      「重发一次、又把旧内容留在同一条回复里」的形态（那就是用户看到两份）。
//   B. 重试只认 `interrupted` / `idle` 两档；其余 kind 一律 `retry: false`（`network` /
//      `timeout` 的重试由 #105 的 `decideStreamRetry` 管，不在本文件扩权）。
//
// 覆盖（对应任务书红绿要求 ①~⑨）：
//   ① 首字节前断 + 未重试 → retry = true，上限 5 次（第 5 次之后才 false）
//   ② 首字节前断 + 已重试 5 次 → retry = false
//   ③ 首字节前断但已超 60s 预算 → retry = false（预算优先于次数）
//   ④ 退避序列 1s / 2s / 4s / 8s（按 attempt 递增后封顶，不是无限翻倍）
//   ⑤ 首字节后断 + 149 字 → retry = true 且 discardPartial = true
//   ⑥ 首字节后断 + 150 字（边界）→ retry = false（阈值口径是 **< 150**，测试钉死）
//   ⑦ 首字节后断 + 300 字 → retry = false
//   ⑧ idle + 0 字 → 同首字节前规则；idle + 有内容 → 1 次
//   ⑨ 非断流 kind（unauthorized / insufficient_quota / content_filtered / badRequest …）→ retry = false
//
// 负向对照（改坏实现必须让本文件变红，实测见 PR）：
//   把「已收到内容」那条判断的 `discardPartial` 去掉 → ⑤ 立刻红（会重发且不丢内容 = 两份）；
//   把预算判断删掉 → ③ 红（超预算还在重试）；把上限从 5 改成 1 → ①② 红。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installResolveHooks } from '../helpers/contract.mjs'

// #896 3c-2：`chat/streamBreakout.ts` 现在读 `net/requestPolicy.ts` 的 `stream` 策略
// （五个数字不再自己写），所以这里需要 `.js → .ts` 的解析钩子 —— 与其它跨模块单测同一套。
installResolveHooks()

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const {
  decideStreamBreakout,
  isStreamBreakoutKind,
  receivedCharsOf,
  streamBreakoutTone,
  streamBreakRetryDelayMs,
  STREAM_BREAK_RETRY_LIMIT,
  STREAM_BREAK_PARTIAL_RETRY_LIMIT,
  STREAM_BREAK_RETRY_BUDGET_MS,
  STREAM_BREAK_PARTIAL_MAX_CHARS,
  STREAM_BREAK_RETRY_DELAYS_MS,
} = await import('../../src/services/chat/streamBreakout.ts')

/** 造一条「已经展示过 n 个字」的回复（正文分块，跟真实 store 的形态一致） */
const replyOfChars = (n) => ({
  blocks: n > 0 ? [{ type: 'text', text: '字'.repeat(n) }] : [],
})

/**
 * 极简「整轮」模拟：用**真实判定函数**驱动一个假请求循环，返回这一轮实际发了几次请求、
 * 以及最终向用户展示的正文。
 *
 * 为什么需要它：`retry = false` 只说明「不该再发」，但产品要的是「已经收到的内容不会变成
 * 两份」—— 那要看**整轮**跑下来正文有没有被清掉 / 被追加第二遍。
 *
 * attempts 的每一项是这一次尝试的结果：
 *   `{ text, ok: false }` = 断在 text 之后（内容照常进了这条回复，判定该不该重发）；
 *   `{ text, ok: true }`  = 正常答完（不再判定，本轮结束）。
 * `discardPartial` 为 true 时把已展示内容清空（= store 里清 blocks 再重新 streaming）。
 */
const simulateRound = ({ attempts, kind, elapsedMs = () => 0 }) => {
  /** 本条回复**当前**已展示的内容块（丢弃时会清空，与 store 的 reply.blocks 同构） */
  const blocks = []
  const shownText = () => blocks.reduce((total, block) => total + block.text.length, 0)
  let requests = 0
  let retriedCount = 0
  for (;;) {
    if (requests > 20) {
      throw new Error('模拟轮次失控：判定函数没有收敛（重试上限失效）')
    }
    const step = attempts[requests] ?? { text: '', ok: false }
    requests += 1
    blocks.push({ type: 'text', text: step.text })
    if (step.ok) {
      return { requests, text: blocks.map((block) => block.text).join(''), retriedCount }
    }
    const decision = decideStreamBreakout({
      receivedChars: shownText(),
      retriedCount,
      elapsedMs: elapsedMs(requests),
      kind,
    })
    if (!decision.retry) {
      return { requests, text: blocks.map((block) => block.text).join(''), decision, retriedCount }
    }
    retriedCount += 1
    if (decision.discardPartial) {
      blocks.length = 0
    }
  }
}

// ---------------------------------------------------------------------------
// 口径常量：产品拍板的数字只在这里钉一次，实现里不许散落魔数
// ---------------------------------------------------------------------------
test('口径常量：首字节前 5 次 / 有内容 1 次 / 60s 预算 / 150 字阈值 / 退避 1-2-4-8s', () => {
  assert.equal(STREAM_BREAK_RETRY_LIMIT, 5, '首字节前断开：静默重试 5 次')
  assert.equal(STREAM_BREAK_PARTIAL_RETRY_LIMIT, 1, '首字节后断（< 150 字）：重试 1 次')
  assert.equal(STREAM_BREAK_RETRY_BUDGET_MS, 60_000, '总时长预算 60s（超了立刻停）')
  assert.equal(STREAM_BREAK_PARTIAL_MAX_CHARS, 150, '有内容这一档的阈值')
  assert.deepEqual(
    [...STREAM_BREAK_RETRY_DELAYS_MS],
    [1000, 2000, 4000, 8000],
    '退避序列 = 1s / 2s / 4s / 8s'
  )
})

// ---------------------------------------------------------------------------
// ① 首字节前断开 + 未重试 → 重试，且允许到第 5 次
// ---------------------------------------------------------------------------
test('① 首字节前断开且还没重试过 → 自动重试（上限 5 次，软色调）', () => {
  const decision = decideStreamBreakout({
    receivedChars: 0,
    retriedCount: 0,
    kind: 'interrupted',
  })
  assert.equal(decision.retry, true, '一个字都没收到时重发是安全的，应当自动重试')
  assert.equal(decision.maxRetries, STREAM_BREAK_RETRY_LIMIT, '重试预算由常量给，不在调用点写死')
  assert.equal(decision.maxRetries, 5, '产品口径是 5 次：网络面板最多 6 次请求')
  assert.equal(decision.discardPartial, false, '没内容可丢，不许乱清')
  assert.equal(decision.retryDelayMs, 1000, '第一次重试等 1s')
  assert.equal(decision.budgetMs, STREAM_BREAK_RETRY_BUDGET_MS, '预算随判定一起给，调用点不另算')
  assert.equal(decision.tone, 'soft', '这时候用户什么都没看到，提示也不该是红色报错')
})

test('① 首字节前第 1~5 次重试都还要重试（第 5 次之后才收敛）', () => {
  for (const retriedCount of [0, 1, 2, 3, 4]) {
    const decision = decideStreamBreakout({ receivedChars: 0, retriedCount, kind: 'interrupted' })
    assert.equal(
      decision.retry,
      true,
      `已重试 ${retriedCount} 次（< 5）仍应当再试一次，不能提前放弃`
    )
  }
})

test('① 首字节前首发断 + 第二次就成功 → 整轮 2 次请求，正文只有一份', () => {
  const round = simulateRound({
    attempts: [{ text: '', ok: false }, { text: '第一次重试就成功啦', ok: true }],
    kind: 'interrupted',
  })
  assert.equal(round.requests, 2, '首发 1 次 + 静默重试 1 次')
  assert.equal(round.text, '第一次重试就成功啦', '重试成功后只展示第二份正文，不叠加')
})

test('① 首字节前断 3 次后成功 → 整轮 4 次请求（页面不该有任何错误提示）', () => {
  const round = simulateRound({
    attempts: [
      { text: '', ok: false },
      { text: '', ok: false },
      { text: '', ok: false },
      { text: '第四次终于通了', ok: true },
    ],
    kind: 'interrupted',
  })
  assert.equal(round.requests, 4, '首发 + 3 次重试')
  assert.equal(round.text, '第四次终于通了', '正文只有成功那一次')
  assert.equal(round.retriedCount, 3)
})

// ---------------------------------------------------------------------------
// ② 已经重试满 5 次 → 不再重试
// ---------------------------------------------------------------------------
test('② 首字节前断开且已重试 5 次 → 不再重发（收敛到软提示 + 重新生成）', () => {
  const decision = decideStreamBreakout({ receivedChars: 0, retriedCount: 5, kind: 'interrupted' })
  assert.equal(decision.retry, false, '重试预算用完了，必须收敛，不能无限重发')
  assert.equal(decision.retryDelayMs, 0, '不重试就不该给退避时长（免得调用点白等）')
  assert.equal(decision.discardPartial, false, '没内容可丢')
  assert.equal(decision.tone, 'soft', '首字节前失败的终态是软提示，不是红色报错')
})

test('② 一直断在首字节前 → 整轮恰好 6 次请求（首发 + 5 次重试，不多不少）', () => {
  const round = simulateRound({
    attempts: Array.from({ length: 12 }, () => ({ text: '', ok: false })),
    kind: 'interrupted',
  })
  assert.equal(round.requests, 1 + STREAM_BREAK_RETRY_LIMIT, '首发 + 5 次重试')
  assert.equal(round.requests, 6)
  assert.equal(round.text, '')
})

// ---------------------------------------------------------------------------
// ③ 60s 总预算优先于次数
// ---------------------------------------------------------------------------
test('③ 首字节前断开但已超 60s 预算 → 立刻停，不再重试（预算优先于次数）', () => {
  const over = decideStreamBreakout({
    receivedChars: 0,
    retriedCount: 1,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS,
    kind: 'interrupted',
  })
  assert.equal(over.retry, false, '总耗时已经 60s，重试次数还剩也不许再发')
  assert.equal(over.retryDelayMs, 0)

  const justUnder = decideStreamBreakout({
    receivedChars: 0,
    retriedCount: 1,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS - 1,
    kind: 'interrupted',
  })
  assert.equal(justUnder.retry, true, '差 1ms 没超预算就该再试（边界在 60s 整）')
})

test('③ 预算耗尽的那一轮整轮请求数少于上限（不是 6 次）', () => {
  // 每次尝试都花掉 20s：第 4 次尝试时已过 60s，必须在第 5 次之前停
  const round = simulateRound({
    attempts: Array.from({ length: 12 }, () => ({ text: '', ok: false })),
    kind: 'interrupted',
    elapsedMs: (requests) => requests * 20_000,
  })
  assert.ok(round.requests < 6, `超预算后不许再用满 5 次重试（实际 ${round.requests} 次）`)
  assert.ok(round.requests >= 2, '至少首发 + 1 次重试')
})

// ---------------------------------------------------------------------------
// ④ 退避序列：1s / 2s / 4s / 8s（递增后封顶）
// ---------------------------------------------------------------------------
test('④ 退避序列按 attempt 递增，第 5 次封顶在 8s（不无限翻倍）', () => {
  const delays = [0, 1, 2, 3, 4].map((retriedCount) =>
    decideStreamBreakout({ receivedChars: 0, retriedCount, kind: 'interrupted' }).retryDelayMs
  )
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000], '1s / 2s / 4s / 8s / 8s')
  assert.equal(streamBreakRetryDelayMs(9), 8000, '超出序列长度的 attempt 也要封顶，不能指数爆炸')
})

test('④ 五次退避加起来约 23s，仍在 60s 预算内（预算与序列不能自相矛盾）', () => {
  const total = [0, 1, 2, 3, 4].reduce(
    (sum, retriedCount) =>
      sum +
      decideStreamBreakout({ receivedChars: 0, retriedCount, kind: 'interrupted' }).retryDelayMs,
    0
  )
  assert.equal(total, 23_000)
  assert.ok(total < STREAM_BREAK_RETRY_BUDGET_MS, '全用满也必须在 60s 预算之内')
})

// ---------------------------------------------------------------------------
// ⑤⑥⑦ 首字节后断开：< 150 丢一次 / >= 150 不重试
// ---------------------------------------------------------------------------
test('⑤ 首字节后断开 + 149 字 → 重试 1 次且丢弃已收到内容（discardPartial）', () => {
  const decision = decideStreamBreakout({
    receivedChars: STREAM_BREAK_PARTIAL_MAX_CHARS - 1,
    retriedCount: 0,
    kind: 'interrupted',
  })
  assert.equal(decision.retry, true, '半截内容重来一次是安全的（丢干净就行）')
  assert.equal(decision.maxRetries, STREAM_BREAK_PARTIAL_RETRY_LIMIT, '这一档只补 1 次')
  assert.equal(decision.discardPartial, true, '必须丢弃重来，绝不能让用户看到两份')
  assert.equal(decision.retryDelayMs, 1000, '补一次也走退避第一档')
  assert.equal(decision.tone, 'warn', '提示是警示状态行，不是红色报错')
})

test('⑤ 149 字断流 → 整轮 2 次请求，最终正文只有重来那一份（旧片段一个字都不留）', () => {
  const partial = '半'.repeat(149)
  const round = simulateRound({
    attempts: [{ text: partial, ok: false }, { text: '重来的完整回答', ok: true }],
    kind: 'interrupted',
  })
  assert.equal(round.requests, 2, '首发 + 1 次重试')
  assert.equal(round.text, '重来的完整回答', '最终正文 = 重来那一份')
  assert.equal(round.text.includes('半'), false, '上一份内容必须被清掉（不许留两份）')
})

test('⑤ 丢弃只补一次：149 字断流后重试又断（仍有内容）→ 不再重试', () => {
  const decision = decideStreamBreakout({
    receivedChars: 149,
    retriedCount: 1,
    kind: 'interrupted',
  })
  assert.equal(decision.retry, false, '这一档的重试预算是 1 次，用掉就收口')
  assert.equal(decision.discardPartial, false, '不重试就不许再丢内容（否则用户什么都看不到）')
})

test('⑥ 边界：150 字 → 不重试（阈值口径是 **< 150**，不是 <= 150）', () => {
  const decision = decideStreamBreakout({
    receivedChars: STREAM_BREAK_PARTIAL_MAX_CHARS,
    retriedCount: 0,
    kind: 'interrupted',
  })
  assert.equal(decision.retry, false, '150 字已经够用户看一段了，重发就是重复计费')
  assert.equal(decision.maxRetries, 0, '这一档没有重试预算')
  assert.equal(decision.discardPartial, false, '不重试就保留已收到的内容')
  assert.equal(decision.retryDelayMs, 0)
  assert.equal(decision.tone, 'warn', '给警示状态行 + 重新生成按钮')
})

test('⑥ 边界两侧只差一个字，判定必须翻转（149 重试 / 150 不重试）', () => {
  const at149 = decideStreamBreakout({ receivedChars: 149, retriedCount: 0, kind: 'interrupted' })
  const at150 = decideStreamBreakout({ receivedChars: 150, retriedCount: 0, kind: 'interrupted' })
  assert.equal(at149.retry, true)
  assert.equal(at150.retry, false)
  assert.equal(at149.discardPartial, true)
  assert.equal(at150.discardPartial, false)
})

test('⑦ 首字节后断开 + 300 字 → 1 次请求，内容原样保留', () => {
  const decision = decideStreamBreakout({ receivedChars: 300, retriedCount: 0, kind: 'interrupted' })
  assert.equal(decision.retry, false, '内容已经不少了，绝不重发')
  assert.equal(decision.discardPartial, false, '保留')
  assert.equal(decision.tone, 'warn')

  const round = simulateRound({
    attempts: [{ text: '长'.repeat(300), ok: false }],
    kind: 'interrupted',
  })
  assert.equal(round.requests, 1, '不许再发第二次')
  assert.equal(round.text.length, 300, '已经收到的 300 字必须原样留着')
})

test('铁律 A：discardPartial 只在「要重试且已经有内容」时成立（全组合矩阵）', () => {
  for (const kind of ['interrupted', 'idle', 'http', 'network', 'timeout', 'stream', undefined]) {
    for (const receivedChars of [0, 1, 149, 150, 300]) {
      for (const retriedCount of [0, 1, 5]) {
        for (const elapsedMs of [0, 59_000, 60_000]) {
          const decision = decideStreamBreakout({ receivedChars, retriedCount, elapsedMs, kind })
          if (decision.discardPartial) {
            assert.equal(
              decision.retry,
              true,
              `kind=${kind} chars=${receivedChars} retried=${retriedCount} ms=${elapsedMs}：要丢内容就必须真的重试`
            )
            assert.ok(
              receivedChars > 0,
              `kind=${kind} retried=${retriedCount}：没有内容时不许有 discardPartial`
            )
          }
          if (decision.retry) {
            assert.ok(decision.retryDelayMs > 0, '要重试就必须给退避时长')
            assert.ok(decision.maxRetries > retriedCount, '还能重试说明预算没用完')
          } else {
            assert.equal(decision.retryDelayMs, 0, '不重试就不给退避时长')
            assert.equal(decision.discardPartial, false, '不重试绝不丢内容')
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// ⑧ idle 卡住
// ---------------------------------------------------------------------------
test('⑧ idle + 0 字 → 同「首字节前」规则（5 次 + 60s 预算）', () => {
  const decision = decideStreamBreakout({ receivedChars: 0, retriedCount: 0, kind: 'idle' })
  assert.equal(decision.retry, true, '连上了但一个字都没出：重发是安全的补救')
  assert.equal(decision.maxRetries, STREAM_BREAK_RETRY_LIMIT)
  assert.equal(decision.budgetMs, STREAM_BREAK_RETRY_BUDGET_MS)
  assert.equal(decision.discardPartial, false)
  assert.equal(decision.retryDelayMs, 1000)

  const exhausted = decideStreamBreakout({ receivedChars: 0, retriedCount: 5, kind: 'idle' })
  assert.equal(exhausted.retry, false, '同样受 5 次上限约束')
  const overBudget = decideStreamBreakout({
    receivedChars: 0,
    retriedCount: 0,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS,
    kind: 'idle',
  })
  assert.equal(overBudget.retry, false, '同样受 60s 预算约束')
})

test('⑧ idle + 有内容（< 150 字）→ 重试 1 次，且丢弃重来（不能留两份）', () => {
  const decision = decideStreamBreakout({ receivedChars: 40, retriedCount: 0, kind: 'idle' })
  assert.equal(decision.retry, true, '卡住时有内容也补一次')
  assert.equal(decision.maxRetries, STREAM_BREAK_PARTIAL_RETRY_LIMIT)
  assert.equal(decision.discardPartial, true, '重来就必须丢干净')
  const again = decideStreamBreakout({ receivedChars: 40, retriedCount: 1, kind: 'idle' })
  assert.equal(again.retry, false, '只补 1 次')
})

test('⑧ idle 整轮：0 字卡住两次后成功 → 3 次请求且无重复内容', () => {
  const round = simulateRound({
    attempts: [
      { text: '', ok: false },
      { text: '', ok: false },
      { text: '第三次通了', ok: true },
    ],
    kind: 'idle',
  })
  assert.equal(round.requests, 3)
  assert.equal(round.text, '第三次通了')
})

test('⑧ 有内容这一档不叠 60s 预算（否则 idle 永远走不到「补 1 次」）', () => {
  // 空闲超时的判死阈值本身就是 idleMs = 60s：等它判死时 60s 预算必然已经用光。
  // 若这里也套预算，「idle 有内容补 1 次」就成了永远走不到的死代码
  // （浏览器验收 5-idle 形态实测：套预算时只发 1 次请求、没补试）。
  for (const kind of ['idle', 'interrupted']) {
    const decision = decideStreamBreakout({
      receivedChars: 40,
      retriedCount: 0,
      elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS * 2,
      kind,
    })
    assert.equal(decision.retry, true, `kind=${kind}：有内容这一档的重试不该被 60s 预算掐掉`)
    assert.equal(decision.budgetMs, 0, '这一档不设总预算（预算只属于「首字节前」那档）')
  }
  // 首字节前那档仍然吃预算（那条才是「连着试 5 次」的兜底）
  const before = decideStreamBreakout({
    receivedChars: 0,
    retriedCount: 0,
    elapsedMs: STREAM_BREAK_RETRY_BUDGET_MS,
    kind: 'idle',
  })
  assert.equal(before.retry, false, '0 字 + 超预算 → 停')
  assert.equal(before.budgetMs, STREAM_BREAK_RETRY_BUDGET_MS, '0 字那档要报出 60s 预算')
})

// ---------------------------------------------------------------------------
// ⑨ 非断流 kind：一条都不能重试
// ---------------------------------------------------------------------------
test('⑨ 4xx / 内容审核 / 额度 / 鉴权 / 参数错 → 一律 retry = false（红色照旧）', () => {
  // 这些是上游码 / 界面条件名（不是 ApiErrorKind），判定函数只认 interrupted / idle 两档，
  // 别的字符串一律「不重试 + 红色」，避免把真错误也拿去重发。
  for (const kind of [
    'unauthorized',
    'insufficient_quota',
    'content_filtered',
    'badRequest',
    'http',
    'network',
    'timeout',
    'protocol',
    'stream',
    'upload',
    undefined,
  ]) {
    for (const receivedChars of [0, 149, 300]) {
      const decision = decideStreamBreakout({ receivedChars, retriedCount: 0, kind })
      assert.equal(decision.retry, false, `kind=${kind} 不许自动重试`)
      assert.equal(decision.discardPartial, false, `kind=${kind} 不许动用户已看到的内容`)
      assert.equal(decision.maxRetries, 0, `kind=${kind} 没有重试预算`)
      assert.equal(decision.tone, 'error', `kind=${kind} 仍是红色报错（文案由 errorNotice 表给）`)
      assert.equal(isStreamBreakoutKind(kind), false, `kind=${kind} 不属于断流`)
    }
  }
  for (const kind of ['interrupted', 'idle']) {
    assert.equal(isStreamBreakoutKind(kind), true, `kind=${kind} 属于断流`)
  }
})

// ---------------------------------------------------------------------------
// ⑤ 语气：断流两档永远不落到红色 error
// ---------------------------------------------------------------------------
test('⑤ 断流四/六种组合的 tone 都不是 error（红色只留给真错误）', () => {
  for (const kind of ['interrupted', 'idle']) {
    for (const receivedChars of [0, 40, 149, 150, 300]) {
      for (const retriedCount of [0, 1, 5]) {
        const { tone } = decideStreamBreakout({ receivedChars, retriedCount, kind })
        assert.notEqual(tone, 'error', `kind=${kind} 收到 ${receivedChars} 字不该是红色报错`)
        assert.ok(tone === 'soft' || tone === 'warn', `tone 只能是 soft / warn，实际 ${tone}`)
      }
    }
  }
})

test('⑤ 「一个字都没收到」一律比「已经收到内容」更软（status 行 vs 警示行）', () => {
  const before = decideStreamBreakout({ receivedChars: 0, retriedCount: 5, kind: 'interrupted' })
  const after = decideStreamBreakout({ receivedChars: 99, retriedCount: 1, kind: 'interrupted' })
  assert.equal(before.tone, 'soft')
  assert.equal(after.tone, 'warn')
})

test('⑤ 渲染入口 streamBreakoutTone 永远不吐 error（写错 kind 也兜成 warn，绝不染红）', () => {
  for (const kind of ['interrupted', 'idle', 'http', 'network', undefined]) {
    for (const receivedChars of [0, 10, 300]) {
      const tone = streamBreakoutTone({ receivedChars, retried: true, kind })
      assert.notEqual(tone, 'error', `kind=${kind} 不该被渲染成红色报错`)
    }
  }
})

// ---------------------------------------------------------------------------
// ⑦ 已收内容怎么数：正文 + 思考（用户看见了），工具块不算
// ---------------------------------------------------------------------------
test('⑦ receivedCharsOf 只数用户看得见的正文与思考字符', () => {
  const reply = {
    blocks: [
      { type: 'thinking', thinking: '先拆规则' },
      { type: 'text', text: '第一段' },
      { type: 'server_tool_use', id: 't1', name: 'read_url' },
    ],
  }
  assert.equal(receivedCharsOf(reply), '先拆规则'.length + '第一段'.length)
  assert.equal(receivedCharsOf({ blocks: [] }), 0)
  assert.equal(receivedCharsOf(null), 0)
  assert.equal(receivedCharsOf(undefined), 0)
})

test('⑦ 150 字阈值认的是「用户看得见的字」，思考字也算进来', () => {
  const thinkingOnly = { blocks: [{ type: 'thinking', thinking: '想'.repeat(150) }] }
  assert.equal(receivedCharsOf(thinkingOnly), 150)
  const decision = decideStreamBreakout({
    receivedChars: receivedCharsOf(thinkingOnly),
    retriedCount: 0,
    kind: 'interrupted',
  })
  assert.equal(decision.retry, false, '只吐了 150 字思考也按「已有内容」收口，不许重发')
})

// ---------------------------------------------------------------------------
// ⑩ 挂载点契约：store / describe / 渲染层必须真的用这份判定
// ---------------------------------------------------------------------------
test('⑩ store 用本函数决定断流是否重发，并把「预算 / 退避 / 丢弃」都用在执行上', () => {
  const store = read('../../src/services/chat/store.ts')
  assert.match(store, /decideStreamBreakout/, 'store 必须问这份判定，而不是自己再写一遍 if')
  assert.match(store, /isStreamBreakoutKind/, '断流两档的收口要有明确判据，不能靠 if 顺序碰运气')
  assert.match(store, /breakout\.maxRetries/, '「共 N 次」要用这一档自己的预算，不能照抄 #105 的 2 次')
  assert.match(store, /breakout\.discardPartial/, '丢弃重来必须由判定结果驱动，不能各写一套')
  assert.match(store, /breakout\.retryDelayMs/, '退避时长也要来自判定，store 不许自己算 2^n')
})

test('⑩ describe 为断流两档落 tone，AssistantMessage 按 tone 选样式而不是一律红色', () => {
  const describe = read('../../src/services/chat/describe.ts')
  assert.match(describe, /tone: breakout\('/, 'describe 要把判定结果落到 Notice.tone')
  assert.match(describe, /streamBreakoutTone/, '渲染层的语气只接 soft / warn 两档，红色留给真错误')
  const view = read('../../src/components/messages/AssistantMessage.tsx')
  assert.match(view, /styles\.noticeSoft/, '软提示要有独立样式，不能再穿红色错误条')
  assert.match(view, /styles\.noticeWarn/, '警示状态行要有独立样式')
  const css = read('../../src/components/messages/AssistantMessage.module.css')
  assert.match(css, /\.noticeSoft/, '样式表里必须有 .noticeSoft')
  assert.match(css, /\.noticeWarn/, '样式表里必须有 .noticeWarn')
})
