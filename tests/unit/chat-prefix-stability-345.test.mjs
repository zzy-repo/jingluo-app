import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

// 宿主替身（IndexedDB / 诊断收集器 / Capacitor / 浏览器全局）统一在 helpers 里装；
// store / reply / contextBudget / requestBody 全是真代码。
installChatHostStubs()

const { setApiKey, setProviderKind } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { getVisibleMessages } = await import('../../src/services/chat/branches.ts')
const budget = await import('../../src/services/chat/contextBudget.ts')
const { useChatStore, initChat, sendMessage, regenerateReply, renameSession } =
  await import('../../src/services/chat/store.ts')

const { CONTEXT_LOW_WATERMARK_RATIO, getLastContextTrim, setContextBudget, resetContextBudget } = budget

/** 真定时器：本用例不接管 setTimeout，只借它做「等这一轮收尾」的轮询 */
const realSetTimeout = globalThis.setTimeout

const encoder = new TextEncoder()
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** 一轮回答约 6k 字符：真实长会话里带清单 / 代码的回答量级，也把预算闸压得下得来 */
const answerFor = (index) => {
  const bullets = []
  for (let i = 1; i <= 120; i += 1) {
    bullets.push(
      `${i}. 第 ${index} 轮第 ${i} 条：接口只做幂等写入，冲突以服务端 updatedAt 为准，` +
        '失败进重试队列并记录 lastError；调用方只传会话 id 与版本号。'
    )
  }
  return `结论：第 ${index} 轮先做幂等接口，再做冲突合并。\n${bullets.join('\n')}`
}

const questionFor = (index) => `第 ${index} 轮提问：把「历史记录同步」拆成接口清单和实现步骤。`

/** Anthropic 协议（deepseek）的 SSE：少一个事件都拿不到正文，正文长度就白造了 */
const anthropicStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(chunk(payload)))
        send({
          type: 'message_start',
          message: {
            id: 'msg-345',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1000, output_tokens: 0 },
          },
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        send({ type: 'content_block_stop', index: 0 })
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: Math.ceil(text.length / 3) },
        })
        send({ type: 'message_stop' })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** OpenAI 协议的 SSE（ours）：一段正文 + 收尾 + [DONE] */
const openaiStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(chunk(payload)))
        send({ id: 'chatcmpl-345', choices: [{ index: 0, delta: { role: 'assistant' } }] })
        send({ id: 'chatcmpl-345', choices: [{ index: 0, delta: { content: text } }] })
        send({ id: 'chatcmpl-345', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 当前渠道对应的流工厂：deepseek 走 Anthropic 事件，ours 走 OpenAI chunk */
let streamFor = anthropicStream

/** 切渠道：协议不同，mock 上游回的流也不同（否则正文进不了历史，用例就白跑了） */
const useChannel = (kind) => {
  setProviderKind(kind)
  streamFor = kind === 'ours' || kind === 'openai' ? openaiStream : anthropicStream
}

/** 每次真实请求的原始记录：**未解析的 JSON 字符串** + 解析后的请求体 */
const requests = []
/** 本轮问答要回放的回答（工厂函数：同一个 Response 不能回放两次） */
let answer = null
/** 自动标题请求带 max_tokens（走另一套体），问答请求不带 */
const isTitleRequest = (body) => body?.max_tokens !== undefined

globalThis.fetch = async (_url, init) => {
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  if (isTitleRequest(body)) {
    return streamFor('会话标题')()
  }
  requests.push({ raw, body })
  return answer()
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const awaitIdle = async (sessionId, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error('本轮没有收尾，测试无法继续')
}

/** 消息正文：user 是字符串，assistant 是内容块数组 */
const textOf = (content) =>
  typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('')

/** 「本轮请求」= 最后一条消息正好是这一轮的提问（排除标题请求与重试同名请求的干扰） */
const requestFor = (index) => {
  const question = questionFor(index)
  return requests.filter((item) => textOf(item.body?.messages?.at(-1)?.content) === question)
}

/** 请求体里 messages 数组的起始偏移：`"messages":[` 之后就是第一条消息 */
const messagesStart = (raw) => {
  const at = raw.indexOf('"messages":[')
  assert.ok(at > 0, '请求体里必须能找到 messages 数组（协议变了要改这个用例）')
  return at + '"messages":['.length
}

/**
 * 前缀的字节边界：`messages` 之前的所有字段（model / system …）+ 除最后一条以外的全部消息。
 * 这就是上游前缀缓存能命中的长度：边界之后的字节（本轮提问、续写前缀、消息后的字段）允许变。
 */
const prefixCut = (item) => {
  const lead = item.body.messages.slice(0, -1)
  return messagesStart(item.raw) + lead.reduce((sum, message) => sum + JSON.stringify(message).length + 1, 0)
}

/** 两条请求体的公共前缀长度（诊断用：fork 位置） */
const commonPrefix = (a, b) => {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) {
    index += 1
  }
  return index
}

/** 除最后一条消息外，前缀是否逐字节相同（字符串比较，不是深度相等） */
const prefixStable = (prev, next) => next.raw.startsWith(prev.raw.slice(0, prefixCut(prev)))

const describeFork = (prev, next) => {
  const fork = commonPrefix(prev.raw, next.raw)
  return (
    `fork_at=${fork}（上一轮长度 ${prev.raw.length}，前缀应有 ${prefixCut(prev)}）` +
    ` prev_msgs=${prev.body.messages.length} next_msgs=${next.body.messages.length}` +
    ` 分歧处：…${JSON.stringify(prev.raw.slice(Math.max(0, fork - 30), fork))}` +
    ` | 下一轮：…${JSON.stringify(next.raw.slice(Math.max(0, fork - 30), fork + 60))}`
  )
}

/** 起一个会话、连续发 N 轮，返回会话 id（回答长度可调） */
const runConversation = async (sessionId, rounds, firstIndex = 0) => {
  let id = sessionId
  for (let index = firstIndex; index < rounds; index += 1) {
    setDraftText(id, questionFor(index))
    answer = streamFor(answerFor(index))
    assert.equal(sendMessage(id), true, `第 ${index} 轮应能发出去`)
    if (!id) {
      id = useChatStore.getState().activeId
      assert.ok(id, '第 0 轮应新建会话')
      await awaitIdle(id)
      // 手动命名：自动标题会带自己的请求 + 重试退避，与本题无关，直接掐掉
      renameSession(id, '前缀稳定性用例')
      continue
    }
    await awaitIdle(id)
  }
  return id
}

/** 单轮回答的估算 token 量（决定预算闸位，用例自己算，不写死神奇数字） */
const roundChars = JSON.stringify(answerFor(0)).length + questionFor(0).length + 2 * 64

/**
 * 预算闸位：低水位保留的轮数要能容纳「越线后连续 10 轮」还不再越线。
 * 低水位 = 闸位 × 0.5，所以闸位至少要能装下 22 轮 —— 取 24 轮，余量给整轮丢弃的取整误差。
 */
const GATE_ROUNDS = 24
const GATE_TOKENS = Math.ceil((roundChars / 3) * GATE_ROUNDS)

test('[1] dump：同一对话连续两轮的真实请求体（诊断证据）', async () => {
  await initChat()
  setApiKey('sk-test-345')
  useChannel('deepseek')
  // 关掉两道闸：只看「装配链路本身」有没有给前缀塞可变内容
  setContextBudget({ maxTokens: 1_000_000_000, maxRounds: 1_000_000 })
  requests.length = 0
  const sessionId = await runConversation(null, 4)
  const prev = requestFor(2)[0]
  const next = requestFor(3)[0]
  assert.ok(prev && next, '两轮问答请求都要抓到')
  console.log(`  第 2 轮请求体：${prev.raw.length} B，${prev.body.messages.length} 条消息`)
  console.log(`    head=${JSON.stringify(prev.raw.slice(0, 120))}…`)
  console.log(`  第 3 轮请求体：${next.raw.length} B，${next.body.messages.length} 条消息`)
  console.log(`    head=${JSON.stringify(next.raw.slice(0, 120))}…`)
  console.log(`  前缀边界（第 2 轮）= 第 ${prefixCut(prev)} 字节；除最后一条消息外前缀相同=${prefixStable(prev, next)}`)
  console.log(`  第 3 轮在边界处的新增内容：${JSON.stringify(next.raw.slice(prefixCut(prev), prefixCut(prev) + 90))}…`)
  assert.equal(textOf(prev.body.messages.at(-1).content), questionFor(2), '最后一条是本轮提问')
  resetContextBudget()
  globalThis.__session = sessionId
})

test('[2] 未越线：连续 8 轮，除最后一条消息外前缀逐字节相同', async () => {
  await initChat()
  setApiKey('sk-test-345')
  useChannel('deepseek')
  setContextBudget({ maxTokens: 1_000_000_000, maxRounds: 1_000_000 })
  requests.length = 0
  await runConversation(null, 8)
  const pairs = []
  for (let index = 1; index < 8; index += 1) {
    const prev = requestFor(index - 1)[0]
    const next = requestFor(index)[0]
    assert.ok(prev && next, `第 ${index - 1} / ${index} 轮请求都要抓到`)
    assert.ok(
      prefixStable(prev, next),
      `第 ${index - 1} → ${index} 轮前缀被改写（未越线时不该有任何裁剪）：${describeFork(prev, next)}`
    )
    pairs.push(index)
  }
  const last = requestFor(7)[0]
  console.log(`  8 轮 / ${requests.length} 个请求：前缀稳定的连续对 ${pairs.length}/7，末轮 ${last.raw.length} B`)
  resetContextBudget()
})

/** 越线场景：把闸位设成 24 轮，先填到越线，再连发 10 轮 */
const runOverflow = async (kind) => {
  await initChat()
  setApiKey('sk-test-345')
  useChannel(kind)
  setContextBudget({ maxTokens: GATE_TOKENS, maxRounds: 1_000_000 })
  requests.length = 0
  // 第 0..GATE_ROUNDS-1 轮越线（第 GATE_ROUNDS 轮请求体第一次装不下）
  const sessionId = await runConversation(null, GATE_ROUNDS + 1)
  const trims = []
  // 越线后连续 10 轮
  for (let index = GATE_ROUNDS + 1; index < GATE_ROUNDS + 11; index += 1) {
    setDraftText(sessionId, questionFor(index))
    answer = streamFor(answerFor(index))
    assert.equal(sendMessage(sessionId), true, `第 ${index} 轮应能发出去`)
    await awaitIdle(sessionId)
    trims.push({ index, report: getLastContextTrim() })
  }
  return { sessionId, trims }
}

const reportOverflow = (name, sessionId, trims, lastRounds) => {
  const items = []
  for (let index = 0; index <= lastRounds; index += 1) {
    const [item] = requestFor(index)
    if (item) {
      items.push({ index, item })
    }
  }
  const breaks = []
  for (let at = 1; at < items.length; at += 1) {
    if (!prefixStable(items[at - 1].item, items[at].item)) {
      breaks.push({ from: items[at - 1].index, to: items[at].index, detail: describeFork(items[at - 1].item, items[at].item) })
    }
  }
  console.log(`\n  ${name}：闸位 ${GATE_TOKENS} token（≈${GATE_ROUNDS} 轮）/ 实际抓到 ${items.length} 轮请求体`)
  for (const item of items.slice(0, 4).concat(items.slice(-3))) {
    console.log(`    第 ${item.index} 轮：${item.item.raw.length} B / ${item.item.body.messages.length} 条消息`)
  }
  console.log(`    前缀断裂 ${breaks.length} 次：`)
  for (const item of breaks) {
    console.log(`      第 ${item.from} → ${item.to} 轮：${item.detail}`)
  }
  // 「边界移动」= 从最旧丢掉的轮数变了。锚定之后 kept 每轮 +1（尾部增长）是正常的，
  // 不算移动 —— 移动只发生在越线那一刻。
  const trimming = trims.filter(
    (item, at) => at === 0 || item.report.roundsDropped !== trims[at - 1].report.roundsDropped
  )
  console.log(
    `    每轮（保留轮数 / 丢掉的轮数）：${trims
      .map((item) => `${item.report.roundsKept}/${item.report.roundsDropped}`)
      .join(' → ')}`
  )
  console.log(
    `    裁剪事件（保留轮数变化）${trimming.length} 次：` +
      (trimming.length === 0
        ? '无'
        : trimming
            .map((item) => `第 ${item.index} 轮裁掉 ${item.report.roundsDropped}/${item.report.roundsTotal} 轮（reason=${item.report.reason}，保留 ${item.report.roundsKept} 轮，token ${item.report.tokensBefore}→${item.report.tokensAfter}/${item.report.maxTokens}）`)
            .join('；'))
  )
  return { items, breaks, trimming }
}

for (const [kind, label] of [
  ['deepseek', 'latest_reminder 直发（deepseek）'],
  ['ours', '快照折叠进 system（ours / OpenAI 协议）'],
]) {
  test(`[3] 越线后：${label} 连续 10 轮前缀逐字节稳定，整段最多断 1 次`, async () => {
    const { sessionId, trims } = await runOverflow(kind)
    const lastIndex = GATE_ROUNDS + 10
    const { items, breaks, trimming } = reportOverflow(label, sessionId, trims, lastIndex)
    assert.ok(items.length >= GATE_ROUNDS + 8, `应抓满整段请求体，实际 ${items.length} 轮`)
    assert.ok(trimming.length >= 1, '这段历史必须真的越过预算（否则「越线后稳定」没有意义）')
    assert.ok(
      trimming.length <= 1,
      `越线后应一次裁到低水位：整段只该裁 1 次，实际 ${trimming.length} 次（${trimming.map((item) => item.index).join(',')} 轮）`
    )
    const kept = trimming[0].report.roundsKept
    assert.ok(
      kept <= Math.floor(GATE_ROUNDS * CONTEXT_LOW_WATERMARK_RATIO) + 1,
      `一次裁到低水位：保留 ${kept} 轮应不高于闸位 ${GATE_ROUNDS} 轮的一半 + 触发那一轮`
    )
    assert.ok(
      breaks.length <= 1,
      `整段对话里前缀最多断 1 次（就是越线那一刻），实际断 ${breaks.length} 次：\n${breaks.map((item) => `第 ${item.from}→${item.to} 轮 ${item.detail}`).join('\n')}`
    )
    // 越线后的连续 10 轮必须全部稳定 —— 这就是「缓存能命中」的可测口径
    const after = items.slice(-11)
    assert.equal(after.length, 11, `越线后应抓到 11 个请求体，实际 ${after.length}`)
    for (let at = 1; at < after.length; at += 1) {
      assert.ok(
        prefixStable(after[at - 1].item, after[at].item),
        `第 ${after[at - 1].index} → ${after[at].index} 轮前缀被改写（越线后不该再动）：` +
          describeFork(after[at - 1].item, after[at].item)
      )
    }
    const lastItem = after.at(-1).item
    console.log(
      `    ✔ 越线后连续 ${after.length - 1} 轮前缀逐字节稳定（末轮 ${lastItem.raw.length} B / ${lastItem.body.messages.length} 条消息）`
    )
    resetContextBudget()
  })
}

test('[4] 冻结：同一轮重发（重新生成）两次，请求体逐字节相同', async () => {
  await initChat()
  setApiKey('sk-test-345')
  useChannel('deepseek')
  setContextBudget({ maxTokens: GATE_TOKENS, maxRounds: 1_000_000 })
  requests.length = 0
  const sessionId = await runConversation(null, GATE_ROUNDS + 2)
  /** 重新生成后新的可见回答（同一道提问的新版本，仍指向同一段历史） */
  const visibleReply = () =>
    getVisibleMessages(useChatStore.getState().sessionCache[sessionId])
      .filter((message) => message.role === 'assistant')
      .at(-1)
  requests.length = 0
  answer = streamFor('重新生成的回答')
  regenerateReply(sessionId, visibleReply().id)
  await awaitIdle(sessionId)
  const first = requests.at(-1)
  requests.length = 0
  answer = streamFor('重新生成的回答')
  regenerateReply(sessionId, visibleReply().id)
  await awaitIdle(sessionId)
  const second = requests.at(-1)
  assert.ok(first && second, '两次重新生成都要发出请求')
  assert.equal(second.raw, first.raw, '同一段历史重发出的请求体必须逐字节相同（窗口是纯函数）')
  console.log(`  重新生成两次：${first.raw.length} B，逐字节相同`)
  resetContextBudget()
})

test('[5] 保格式：保留的历史正文在请求体里逐字出现（整轮丢弃，不做空白改写）', async () => {
  await initChat()
  setApiKey('sk-test-345')
  useChannel('deepseek')
  setContextBudget({ maxTokens: GATE_TOKENS, maxRounds: 1_000_000 })
  requests.length = 0
  const sessionId = await runConversation(null, GATE_ROUNDS + 1)
  const [item] = requestFor(GATE_ROUNDS)
  const messages = getVisibleMessages(useChatStore.getState().sessionCache[sessionId])
  const answerText = answerFor(GATE_ROUNDS - 1)
  const keptAnswer = item.body.messages.filter(
    (message) => message.role === 'assistant' && textOf(message.content) === answerText
  )
  assert.equal(keptAnswer.length, 1, '保留轮次的回答必须作为**一条原样消息**出现（没有被拆开或改写）')
  assert.ok(
    item.raw.includes(JSON.stringify(answerText)),
    '回答正文必须原样出现在原始请求体里：缩进 / 换行 / 空行一个字符都不能被压平'
  )
  assert.equal(
    messages.filter((message) => message.role === 'assistant').length,
    GATE_ROUNDS + 1,
    `会话里 ${GATE_ROUNDS + 1} 条回答一条不少（裁剪只影响请求体，不改存下来的历史）`
  )
  const dropped = (answer) => item.body.messages.every((message) => !JSON.stringify(message).includes(answer))
  assert.ok(dropped(answerFor(0)), '最旧的轮次被整轮丢弃（不是改成摘要或截断片段）')
  console.log(
    `  请求体 ${item.body.messages.length} 条消息：第 0 轮原文已整轮消失，第 ${GATE_ROUNDS - 1} 轮回答 ${answerText.length} 字符逐字保留`
  )
  resetContextBudget()
})

test('[6] 已知残留：跨天只让前缀断一次，且断点就在快照那一行（不是每轮）', async () => {
  // latest_reminder 里带**真实日期与星期**（上游协议要求，去不掉）：跨天那一刻快照要变，
  // 前缀必然断一次 —— 这是本单修不掉的残留。这里把它钉成可测的事实：
  //   · 历史正文一条不动（断点不在历史里）；
  //   · 跨天只多插一行快照，别的都没变；
  //   · 跨过之后同一天内的连续两轮又恢复稳定（不是每轮都断）。
  const { toRequestMessages } = await import('../../src/services/chat/reply.ts')
  const day20 = '2026-11-20,星期五,,Web,中文'
  const day21 = '2026-11-21,星期六,,Web,中文'
  const history = []
  for (let index = 0; index < 3; index += 1) {
    history.push({
      id: `u${index}`,
      role: 'user',
      content: `第 ${index} 轮提问`,
      files: [],
      createdAt: index * 2,
    })
    history.push({
      id: `a${index}`,
      role: 'assistant',
      createdAt: index * 2 + 1,
      model: null,
      prefix: false,
      status: 'done',
      stopReason: 'end_turn',
      latestReminder: day20,
      blocks: [{ type: 'text', text: `第 ${index} 轮回答\n\n- 缩进与空行都要原样`, citations: [] }],
    })
  }
  const ask = (id) => ({ id, role: 'user', content: `本轮提问 ${id}`, files: [], createdAt: 99 })
  const build = (question, reminder) => toRequestMessages(history, ask(question), undefined, false, reminder)
  /** 逐条比前缀（不是深度相等）：返回第一个不同的下标，没有就 -1 */
  const firstDiff = (left, right) => {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
        return index
      }
    }
    return left.length === right.length ? -1 : Math.min(left.length, right.length)
  }
  const excerpt = (message) => JSON.stringify(message).slice(0, 80)
  /** 本轮提问之前的「历史 + 快照」段 */
  const prefixOf = (messages) => messages.slice(0, messages.findIndex((message) => message.role === 'user' && /^本轮提问/.test(message.content)))

  const todayA = build('a', day20)
  const todayB = build('b', day20)
  const tomorrow = build('b', day21)

  // 同一天连续两轮：整段前缀（历史 + 本轮快照）逐字节相同
  const sameDayDiff = firstDiff(prefixOf(todayA), prefixOf(todayB))
  assert.equal(sameDayDiff, -1, `同一天的两轮前缀必须在第 ${sameDayDiff} 条之前完全一致`)
  // 跨天：断点就是快照行；历史正文逐条不动
  const historyDiff = firstDiff(prefixOf(todayA).filter((m) => m.role !== 'latest_reminder'), prefixOf(tomorrow).filter((m) => m.role !== 'latest_reminder'))
  assert.equal(historyDiff, -1, '跨天时历史正文一条都不能变')
  const reminderOf = (messages) => messages.filter((message) => message.role === 'latest_reminder').at(-1)
  assert.match(reminderOf(todayA).content, /2026-11-20/)
  assert.match(reminderOf(tomorrow).content, /2026-11-21/)
  assert.ok(
    tomorrow.length - todayB.length <= 1,
    `跨天最多多插一行快照（${todayB.length} → ${tomorrow.length} 条）`
  )
  // 跨过之后同一天内又稳定：再发一轮，前缀与跨天那一轮逐字节相同
  const tomorrowNext = build('c', day21)
  assert.equal(
    firstDiff(prefixOf(tomorrow), prefixOf(tomorrowNext)),
    -1,
    '跨天之后同一天内的下一轮必须恢复逐字节稳定'
  )
  console.log(
    `  跨天残留：历史 ${history.length} 条正文不动，只有快照一行变化（${reminderOf(todayA).content} → ${reminderOf(tomorrow).content}）；` +
      `跨过后下一轮前缀稳定（首条 ${excerpt(tomorrow[0])}…）`
  )
})
