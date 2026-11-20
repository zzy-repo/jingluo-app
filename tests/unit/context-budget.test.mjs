// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #122：长会话请求不做上下文预算，全部历史每轮重发。
//
// 断言分两组：
// [红] 请求体体积随历史轮次线性增长、没有上限 —— 改动前必须失败。
// [绿] 预算双闸（token 估算 + 轮次上限）、成对丢弃最旧轮、不丢系统前缀与本轮提问、
//      不产生孤立回答 / 悬空 latest_reminder 快照、只剩最后一轮时仍能发出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { toRequestMessages, getContextRounds } = await import('../../src/services/chat/reply.ts')
const budgetModule = await import('../../src/services/chat/contextBudget.ts').catch(() => null)

/** 一轮真实形态的历史：提问 + 有文本的回答 */
const textOf = (index, length) => `第 ${index} 轮提问：${'背景说明'.repeat(Math.ceil(length / 8))}`

const userMessage = (index, content, files = []) => ({
  id: `u${index}`,
  role: 'user',
  content,
  files,
  createdAt: index * 2,
})

const assistantMessage = (index, text, latestReminder) => ({
  id: `a${index}`,
  role: 'assistant',
  createdAt: index * 2 + 1,
  model: null,
  prefix: false,
  status: 'done',
  latestReminder,
  blocks: [{ type: 'text', text, citations: [] }],
})

/** 构造 N 轮历史（每轮提问与回答各 length 个字符） */
const buildHistory = (rounds, length = 400, reminder) => {
  const history = []
  for (let i = 0; i < rounds; i += 1) {
    history.push(userMessage(i, textOf(i, length)))
    history.push(
      assistantMessage(i, `第 ${i} 轮回答：${'结论与依据'.repeat(Math.ceil(length / 5))}`, reminder)
    )
  }
  return history
}

const question = userMessage(9999, '本轮提问：请继续。')

/** 请求体大小（UTF-8 字节数），与真实发出的 JSON body 同量级 */
const bodyBytes = (messages) => Buffer.byteLength(JSON.stringify({ messages }), 'utf8')

/** 历史 + 本轮提问的完整 messages */
const build = (rounds, options) => toRequestMessages(buildHistory(rounds), question, undefined, false, undefined, options)

// ---------------------------------------------------------------- 红：线性增长

test('[红] 请求体不随历史轮次线性增长：1000 轮与 4000 轮体积相同', () => {
  const mid = build(1000)
  const huge = build(4000)
  const midBytes = bodyBytes(mid)
  const hugeBytes = bodyBytes(huge)
  console.log(
    `  1000 轮：${mid.length} 条消息 / ${midBytes} B；4000 轮：${huge.length} 条消息 / ${hugeBytes} B`
  )
  assert.ok(
    hugeBytes <= midBytes * 1.05,
    `历史翻 4 倍（1000→4000 轮）后请求体从 ${midBytes} B 涨到 ${hugeBytes} B（${(hugeBytes / midBytes).toFixed(1)} 倍）：说明没有上限，必须被预算截断`
  )
  assert.ok(
    huge.length <= mid.length * 1.05 + 4,
    `4000 轮发了 ${huge.length} 条消息，1000 轮发了 ${mid.length} 条：条数必须被上限截断`
  )
})

test('[红] 1000 轮历史的请求体落在预算内（token 估算闸 + 条数闸）', () => {
  assert.ok(budgetModule, '需要 src/services/chat/contextBudget.ts 提供预算常量')
  const { DEFAULT_CONTEXT_BUDGET, estimateTokens } = budgetModule
  const large = build(1000)
  const chars = JSON.stringify(large).length
  console.log(
    `  1000 轮裁剪后：${large.length} 条消息 / ${chars} 字符 / 估算 ${estimateTokens(chars)} token（默认预算 ${DEFAULT_CONTEXT_BUDGET.maxTokens} token / ${DEFAULT_CONTEXT_BUDGET.maxRounds} 轮）`
  )
  assert.ok(
    large.length <= DEFAULT_CONTEXT_BUDGET.maxRounds * 2 + 3,
    `条数闸：${large.length} 条超过 ${DEFAULT_CONTEXT_BUDGET.maxRounds} 轮的双边上限`
  )
  assert.ok(
    estimateTokens(chars) <= DEFAULT_CONTEXT_BUDGET.maxTokens,
    `token 闸：估算 ${estimateTokens(chars)} 超过默认预算 ${DEFAULT_CONTEXT_BUDGET.maxTokens}`
  )
})

// ---------------------------------------------------------------- 绿：预算语义

test('未超预算时原样保留全部轮次（默认预算不裁正常会话）', () => {
  const messages = build(10)
  assert.equal(messages.length, 10 * 2 + 1)
  assert.deepEqual(
    messages.map((message) => message.role),
    [...Array(10).fill(['user', 'assistant']).flat(), 'user']
  )
})

test('超预算按成对丢弃最旧轮，且不留孤立回答 / 孤立提问', () => {
  // #345：条数闸越线后一次裁到**低水位**（floor(5 × 0.5) = 2 轮），
  // 而不是「刚好塞满 5 轮」——后者会让裁剪边界每轮前移一格，前缀缓存永不命中。
  const messages = build(50, { budget: { maxRounds: 5 } })
  // 2 轮 × (提问 + 回答) + 本轮提问
  assert.equal(messages.length, 2 * 2 + 1)
  assert.equal(messages.filter((message) => message.role === 'user').length, 3)
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 2)
  // 保留的是最近 2 轮：第一条提问必须是第 48 轮
  assert.match(messages[0].content, /第 48 轮提问/)
  // 每条 assistant 前一条必须是 user，配对完整
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      assert.equal(messages[index - 1].role, 'user', `第 ${index} 条 assistant 前必须是 user`)
    }
  })
  // 最后一条是本轮提问，未被裁剪
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, question.content)
})

test('token 估算闸生效：字符超预算时按轮裁掉最旧部分', () => {
  const messages = build(40, { budget: { maxTokens: 2000, maxRounds: 1000 } })
  assert.ok(messages.length < 40 * 2 + 1, '超 token 预算时必须裁掉一些轮次')
  assert.ok(messages.length >= 3, '至少要留下最后一轮 + 本轮提问')
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, question.content)
})

test('裁剪不产生悬空的 latest_reminder 快照', () => {
  const history = buildHistory(30, 200, undefined)
  // 每轮的 latest_reminder 内容都不同，只有变化时才插快照
  history.forEach((message, index) => {
    if (message.role === 'assistant') message.latestReminder = `第 ${index} 轮系统快照`
  })
  // #345：4 轮闸越线 → 低水位保留 floor(4 × 0.5) = 2 轮（27、28 轮）
  const messages = toRequestMessages(history, question, undefined, false, '本轮系统快照', {
    budget: { maxRounds: 4 },
  })
  const reminderIndexes = messages.flatMap((message, index) =>
    message.role === 'latest_reminder' ? [index] : []
  )
  assert.ok(reminderIndexes.length > 0, '裁剪后仍应保留快照行')
  for (const index of reminderIndexes) {
    const next = messages[index + 1]
    assert.ok(next && next.role === 'user', `第 ${index} 条快照后面必须紧跟 user，不能悬空`)
  }
  // 保留轮次的快照内容必须与保留的那一轮对得上
  const keptUsers = messages.filter((message) => message.role === 'user')
  assert.match(keptUsers[0].content, /第 28 轮提问/)
  assert.equal(messages[0].role, 'latest_reminder')
  // 第 28 轮历史里 assistant 的下标是 2*28+1 = 57
  assert.equal(messages[0].content, '第 57 轮系统快照')
  assert.equal(messages.at(-2).content, '本轮系统快照')
})

test('只剩最后一轮时仍能发出：预算再小也保留最近一对 + 本轮提问', () => {
  const messages = build(20, { budget: { maxRounds: 1, maxTokens: 1 } })
  assert.equal(messages.length, 3)
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user']
  )
})

test('本轮提问永不截断，续写前缀也不丢', () => {
  const hugeQuestion = userMessage(9998, '超长提问'.repeat(20000))
  const prefix = {
    ...assistantMessage(9998, '续写中的回答', undefined),
    prefix: true,
    status: 'stopped',
  }
  const messages = toRequestMessages(buildHistory(30), hugeQuestion, prefix, false, undefined, {
    budget: { maxRounds: 2 },
  })
  assert.equal(messages.at(-2).content, hugeQuestion.content, '本轮提问必须原文保留')
  assert.equal(messages.at(-1).role, 'assistant', '续写前缀必须保留')
  assert.match(messages.at(-1).content[0].text, /续写中的回答/)
})

test('预算可配置且带保守默认值，裁剪有统计口径', () => {
  assert.ok(budgetModule, '需要 src/services/chat/contextBudget.ts')
  const { DEFAULT_CONTEXT_BUDGET, getContextBudget, setContextBudget, resetContextBudget } =
    budgetModule
  assert.ok(DEFAULT_CONTEXT_BUDGET.maxTokens >= 32000, '默认 token 预算不能激进到把正常会话裁掉')
  assert.ok(DEFAULT_CONTEXT_BUDGET.maxRounds >= 40, '默认轮次上限不能激进到把正常会话裁掉')
  try {
    // #345：闸位写 6，低水位裁到 3 轮，条数与改动前一致（只验证「全局配置被采用」）
    setContextBudget({ maxRounds: 6 })
    assert.equal(getContextBudget().maxRounds, 6)
    assert.equal(getContextBudget().maxTokens, DEFAULT_CONTEXT_BUDGET.maxTokens, '未覆盖的字段保持默认')
    assert.equal(build(30).length, 3 * 2 + 1, '全局配置必须被 toRequestMessages 采用')
  } finally {
    resetContextBudget()
  }
  assert.deepEqual(getContextBudget(), DEFAULT_CONTEXT_BUDGET)
})

test('裁剪有可观测量：报告给出裁掉多少轮 / 多少字符', () => {
  const history = buildHistory(30)
  assert.equal(getContextRounds(history).length, 30)
  const reports = []
  // #345：闸位写 8，越线后低水位裁到 4 轮（与改动前保留轮数一致，只看统计口径）
  toRequestMessages(history, question, undefined, false, undefined, {
    budget: { maxRounds: 8 },
    onTrim: (report) => reports.push(report),
  })
  assert.equal(reports.length, 1, '发生裁剪时必须回调一次')
  const [report] = reports
  assert.equal(report.roundsTotal, 30)
  assert.equal(report.roundsKept, 4)
  assert.equal(report.roundsDropped, 26)
  assert.ok(report.charsBefore > report.charsAfter, '裁剪后字符数必须下降')
  assert.ok(report.tokensBefore > report.tokensAfter)
  assert.match(budgetModule.formatContextTrim(report), /26/)
  assert.equal(budgetModule.formatContextTrim(budgetModule.emptyContextTrimReport).includes('0'), true)
})

test('未发生裁剪时不回调，保持零开销', () => {
  let calls = 0
  build(5, { onTrim: () => (calls += 1) })
  assert.equal(calls, 0)
})
