// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #122 关闭条件①：几百轮真实长会话走「真实 store → 真实 toRequestMessages → 真实请求体」，
// 量出裁剪前 / 裁剪后的字节与估算 token，并复核三件不能被裁掉的东西：
//   - 系统前缀（SYSTEM_PROMPT + latest_reminder 折叠行）
//   - 本轮用户提问
//   - 续写（continueReply）前缀
// 同时复核 latest_reminder 去重：420 轮的快照不能变成 420 行。
//
// 替身只有边界：fetch、IndexedDB（换成内存 Map）、Capacitor、诊断写入口。
// store / reply / contextBudget / describe 全是真实代码，裁剪逻辑一行没改。
//
//   node tests/unit/chat-context-budget-long-session.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

// 假 db：IndexedDB 在裸 Node 里不存在。换掉存储落点，但 store 照旧 saveSession / loadSession。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
const memory = new Map()
const summary = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})
export const loadSessionSummaries = async () => [...memory.values()].map(summary)
export const loadSession = async (id) => (memory.has(id) ? structuredClone(memory.get(id)) : undefined)
export const saveSession = async (session) => {
  memory.set(session.id, structuredClone(session))
}
export const saveFiles = async () => {}
export const loadFile = async () => undefined
export const deleteSession = async (id) => {
  memory.delete(id)
}
export const pinSession = async () => {}
export const renameSession = async () => {}
export const clearStaging = async () => {}
export const addStagingSession = async () => {}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => []
export const reportStorageError = () => () => {}
export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
`)}`

const collectorStub = `data:text/javascript,${encodeURIComponent(`
export * from '${stub('collector.mjs')}'
export const recordError = (message, fields = {}) => {
  globalThis.__log.records.push({ kind: 'error', level: 'error', message, fields })
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const parent = String(context.parentURL ?? '')
      if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
        return { url: fakeDB, shortCircuit: true }
      }
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__INTERNAL_BUILD__ ??= true
globalThis.__log = { records: [], events: [], actions: [] }

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
}
const realSetTimeout = globalThis.setTimeout
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { getVisibleMessages } = await import('../../src/services/chat/branches.ts')
const budget = await import('../../src/services/chat/contextBudget.ts')
const { getContextRounds, toRequestMessages } = await import('../../src/services/chat/reply.ts')
const { useChatStore, initChat, sendMessage, continueReply, regenerateReply } =
  await import('../../src/services/chat/store.ts')

const { DEFAULT_CONTEXT_BUDGET, estimateTokens, getLastContextTrim, setContextBudget, resetContextBudget } =
  budget

const encoder = new TextEncoder()
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** 单轮回答：24 条要点，约 2.0k 字符——真实会话里带清单 / 代码的回答就是这个量级 */
const answerFor = (index) => {
  const bullets = []
  for (let i = 1; i <= 24; i += 1) {
    bullets.push(
      `${i}. 第 ${index} 轮第 ${i} 条：接口只做幂等写入，冲突以服务端 updatedAt 为准，` +
        '失败进重试队列并记录 lastError；调用方只传会话 id 与版本号，其余字段由本地状态补齐，避免半包写入。'
    )
  }
  return `结论：先做幂等接口，再做冲突合并，最后补重试队列。\n${bullets.join('\n')}`
}

/** 单轮提问：约 100 字符，像真人一样带上下文与验收要求 */
const questionFor = (index) =>
  `第 ${index} 轮提问：我这边有一个「历史记录同步」的需求，需要支持离线写入、冲突合并和失败重试；` +
  '请把这个需求拆成接口清单和实现步骤，说明每一步的取舍与风险，并给出可以照着验证的验收方式。'

const streamOf = (text) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            chunk({ id: 'chatcmpl-122', choices: [{ index: 0, delta: { role: 'assistant' } }] })
          )
        )
        controller.enqueue(
          encoder.encode(chunk({ id: 'chatcmpl-122', choices: [{ index: 0, delta: { content: text } }] }))
        )
        controller.enqueue(
          encoder.encode(chunk({ id: 'chatcmpl-122', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 只发一段正文就收尾在 max_tokens：真实「答到上限」的续写起点 */
const truncatedStream = (text) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(chunk({ id: 'chatcmpl-122', choices: [{ index: 0, delta: { content: text } }] }))
        )
        controller.enqueue(
          encoder.encode(
            chunk({ id: 'chatcmpl-122', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
          )
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 每次真实请求的原始记录：字节数、解析后的请求体 */
const requests = []
let answer = '默认回答'

/** 自动标题请求带 title.enabled；其余都是问答请求 */
const isTitleRequest = (body) => body?.title?.enabled === true

/** system 前缀可能在顶层字段，也可能被协议适配器折成第一条 system 消息 */
const systemOf = (body) => {
  if (typeof body.system === 'string') {
    return body.system
  }
  const first = body.messages.find((message) => message.role === 'system')
  return typeof first?.content === 'string' ? first.content : ''
}

globalThis.fetch = async (_url, init) => {
  const raw = init?.body ?? ''
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  if (isTitleRequest(body)) {
    return streamOf('会话标题')
  }
  requests.push({ bytes: Buffer.byteLength(raw, 'utf8'), body })
  return answer
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

const awaitIdle = async (sessionId, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error('本轮没有收尾，测试无法继续')
}

const session = (sessionId) => useChatStore.getState().sessionCache[sessionId]
const lastReply = (sessionId) => session(sessionId).messages.filter((m) => m.role === 'assistant').at(-1)
const replyText = (reply) => reply.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
const bodyText = (param) => (typeof param === 'string' ? param : (param?.map?.((b) => b.text ?? '') ?? []).join(''))

const ROUNDS = 420
let sessionId

test(`真实 ${ROUNDS} 轮会话：走 store 全链路建出长历史`, async () => {
  await initChat()
  setApiKey('sk-test-122')

  setDraftText(null, questionFor(0))
  answer = streamOf(answerFor(0))
  assert.equal(sendMessage(null), true, '第一轮应能发出去')
  sessionId = useChatStore.getState().activeId
  assert.ok(sessionId, '应新建会话')
  await awaitIdle(sessionId)

  for (let index = 1; index < ROUNDS; index += 1) {
    setDraftText(sessionId, questionFor(index))
    answer = streamOf(answerFor(index))
    assert.equal(sendMessage(sessionId), true, `第 ${index} 轮应能发出去`)
    await awaitIdle(sessionId)
  }

  const messages = getVisibleMessages(session(sessionId))
  assert.equal(messages.length, ROUNDS * 2, `${ROUNDS} 轮应有 ${ROUNDS * 2} 条消息`)
  const firstAnswer = replyText(messages[1])
  console.log(`  单轮回答实测 ${firstAnswer.length} 字符（造数 ${answerFor(0).length} 字符）`)
  assert.equal(firstAnswer, answerFor(0), '回答原文必须完整进入历史')
  const chars = JSON.stringify(messages).length
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
  console.log(
    `  真实历史：${ROUNDS} 轮 / ${messages.length} 条消息 / ${chars} 字符 / ${bytes} B / 估算 ${estimateTokens(chars)} token`
  )
  assert.ok(
    estimateTokens(chars) > DEFAULT_CONTEXT_BUDGET.maxTokens,
    `这段历史必须真的超过默认预算（${DEFAULT_CONTEXT_BUDGET.maxTokens} token），否则下面的裁剪数字没有意义`
  )
  const persisted = useChatStore.getState().sessions.find((item) => item.id === sessionId)
  assert.equal(persisted?.messages ?? undefined, undefined, '会话摘要不应带正文')
  assert.ok(persisted, '会话应已落库（内存 Map）并被列表读到')
})

/** 同一份历史各测一次：改预算 → 重发同一个问题 → 读真实请求体 + 真实裁剪报告 */
const probe = async (name, patch) => {
  // patch 为 null 表示「回到出厂默认」，不能用空对象（空对象会继承上一次的覆盖）
  if (patch === null) {
    resetContextBudget()
  } else {
    setContextBudget(patch)
  }
  answer = streamOf('探针回答')
  const reply = lastReply(sessionId)
  requests.length = 0
  regenerateReply(sessionId, reply.id)
  await awaitIdle(sessionId)
  const [request] = requests
  assert.ok(request, `${name}：必须真的发出一次请求`)
  const report = getLastContextTrim()
  return { request, report }
}

test('裁剪前后对比：字节 / 估算 token / 轮数（同一份真实历史）', async () => {
  const history = getVisibleMessages(session(sessionId))
  const roundsTotal = getContextRounds(history).length

  const off = await probe('关闸', { maxTokens: 1_000_000_000, maxRounds: 1_000_000 })
  const roundGateOnly = await probe('只条数闸', { maxTokens: 1_000_000_000, maxRounds: DEFAULT_CONTEXT_BUDGET.maxRounds })
  const tokenGateOnly = await probe('只 token 闸', { maxTokens: DEFAULT_CONTEXT_BUDGET.maxTokens, maxRounds: 1_000_000 })
  const byDefault = await probe('默认预算', null)

  // 估算口径与代码一致：字符数 / 3（不是 UTF-8 字节数，中文一字约等于 3 字节）
  const charsOf = (value) => JSON.stringify(value).length
  // getLastContextTrim() 在没有裁剪时返回的是上一次的报告，所以按条数判断这一枪到底裁没裁
  const line = (name, item) =>
    `  ${name}：${item.request.body.messages.length} 条消息 / 请求体 ${item.request.bytes} B / ` +
    `估算 ${estimateTokens(charsOf(item.request.body.messages))} token / ` +
    `${
      item.request.body.messages.length < fullCount
        ? `裁掉 ${item.report.roundsDropped} 轮（保留 ${item.report.roundsKept} / 共 ${item.report.roundsTotal}），字符 ${item.report.charsBefore}→${item.report.charsAfter}，token ${item.report.tokensBefore}→${item.report.tokensAfter}，reason=${item.report.reason}`
        : `未裁剪（全量 ${roundsTotal} 轮都发出去）`
    }`

  console.log(`\n  同一份真实历史（${roundsTotal} 轮）在四种预算下的真实请求体：`)
  const fullCount = off.request.body.messages.length
  console.log(line('裁剪前（关掉两道闸 = 修复前代码的行为）', off))
  console.log(line('只条数闸', roundGateOnly))
  console.log(line('只 token 闸', tokenGateOnly))
  console.log(line('默认预算（裁剪后）', byDefault))
  console.log(`  裁剪报告原文：${budget.formatContextTrim(byDefault.report)}\n`)

  // 裁剪后的请求体必须落在预算内，且明显小于裁剪前
  assert.ok(off.request.body.messages.length > byDefault.request.body.messages.length, '裁剪后条数必须下降')
  assert.ok(off.request.bytes > byDefault.request.bytes * 2, '裁剪后请求体必须至少减半')
  assert.ok(
    byDefault.report.roundsDropped > 0 && byDefault.report.roundsKept < byDefault.report.roundsTotal,
    '默认预算下必须真的裁掉一些轮次'
  )
  assert.ok(
    byDefault.request.body.messages.length <= DEFAULT_CONTEXT_BUDGET.maxRounds * 2 + 3,
    `条数闸：${byDefault.request.body.messages.length} 条超过上限`
  )
  const trimmedTokens = byDefault.report.tokensAfter
  assert.ok(
    trimmedTokens <= DEFAULT_CONTEXT_BUDGET.maxTokens && trimmedTokens > 0,
    `token 闸：裁剪后 ${trimmedTokens} 必须落回预算 ${DEFAULT_CONTEXT_BUDGET.maxTokens} 以内`
  )
  assert.ok(roundGateOnly.report.roundsKept >= 1 && tokenGateOnly.report.roundsKept >= 1, '两道闸单独都要能算出保留轮数')

  // 三件不许被裁掉的东西，逐项在真实请求体里核对
  const offBody = off.request.body
  const trimmedBody = byDefault.request.body
  const question = questionFor(ROUNDS - 1)
  const offSystem = systemOf(offBody)
  const trimmedSystem = systemOf(trimmedBody)
  assert.ok(offSystem.length > 0, '请求必须带系统前缀')
  assert.equal(trimmedSystem, offSystem, '系统前缀必须逐字节一致：裁剪不能动它')
  assert.ok(
    !trimmedSystem.includes('第 418 轮第 1 条'),
    '系统前缀里不能漏进历史正文（漏了说明折叠 / 去重坏了）'
  )
  console.log(`  系统前缀 ${trimmedSystem.length} 字符，裁剪前后逐字节相同：${JSON.stringify(trimmedSystem.slice(0, 60))}…`)
  assert.equal(trimmedBody.messages.at(-1).role, 'user', '最后一条必须是本轮提问')
  assert.equal(trimmedBody.messages.at(-1).content, question, '本轮用户提问必须原文保留')

  // latest_reminder 去重：420 轮快照不能变成 420 行
  const reminderRows = trimmedBody.messages.filter((m) => m.role === 'latest_reminder').length
  const systemLines = trimmedSystem.split(/\r?\n/).filter((line) => line.trim())
  if (reminderRows > 0) {
    assert.ok(reminderRows <= 2, `latest_reminder 去重失效：${reminderRows} 行（${ROUNDS} 轮最多 1~2 行）`)
    console.log(`  latest_reminder：协议直发，合并后 ${reminderRows} 行（${ROUNDS} 轮本会带 ${ROUNDS} 行）`)
  } else {
    assert.ok(systemLines.length <= 4, `快照折叠进系统前缀后堆了 ${systemLines.length} 行（${ROUNDS} 轮本会堆 ${ROUNDS} 行）`)
    console.log(`  latest_reminder：折叠进系统前缀，${systemLines.length} 行（${ROUNDS} 轮本会堆 ${ROUNDS} 行）`)
  }
  resetContextBudget()
})

test('续写前缀与系统前缀一起长在真历史里也不被裁掉', async () => {
  // 造一个真实「答到输出上限」的回复：内容有，但没答完，用户点续写
  const continueQuestion = '第 422 轮提问：接着把上面的重试队列补完，写清楚幂等键怎么生成。'
  const partial = '正在续写：幂等键用会话 id + 版本号拼接，先落到本地队列'
  setDraftText(sessionId, continueQuestion)
  answer = truncatedStream(partial)
  assert.equal(sendMessage(sessionId), true)
  await awaitIdle(sessionId)

  const truncated = lastReply(sessionId)
  assert.equal(truncated.status, 'done', '答到上限的回复按正常结束处理')
  assert.equal(truncated.stopReason, 'max_tokens', '这轮应停在输出上限')
  const prefixText = replyText(truncated)
  assert.equal(prefixText, partial, '截断回复的正文必须完整保留')

  requests.length = 0
  answer = streamOf('续写之后的补充')
  continueReply(sessionId, truncated.id)
  await awaitIdle(sessionId)

  const [request] = requests
  assert.ok(request, '续写必须真的发出一次请求')
  const messages = request.body.messages
  assert.equal(messages.at(-2).role, 'user', '续写请求的倒数第二条是本轮提问')
  assert.equal(messages.at(-2).content, continueQuestion, '续写提问不能被裁掉')
  assert.equal(messages.at(-1).role, 'assistant', '续写前缀必须排在最后')
  const prefixParam = bodyText(messages.at(-1).content)
  assert.ok(prefixParam.includes('幂等键用会话 id + 版本号拼接'), `续写前缀被裁掉了：${prefixParam.slice(0, 60)}`)
  const tokens = getLastContextTrim().tokensAfter
  assert.ok(
    tokens <= DEFAULT_CONTEXT_BUDGET.maxTokens,
    `续写请求也必须落在预算内：${tokens} > ${DEFAULT_CONTEXT_BUDGET.maxTokens}`
  )
  const report = getLastContextTrim()
  console.log(
    `  续写请求：${messages.length} 条消息 / ${request.bytes} B / 估算 ${tokens} token；` +
      `裁剪报告：${report.roundsDropped > 0 ? budget.formatContextTrim(report) : '未裁剪'}`
  )
  console.log(`  续写前缀原文保留：${JSON.stringify(prefixText)}`)
})

test('裁剪统计口径与 toRequestMessages 直调一致（防两套数字）', () => {
  const history = getVisibleMessages(session(sessionId))
  const question = { id: 'direct-question', role: 'user', content: '直调对照提问', files: [], createdAt: Date.now() }
  const reports = []
  toRequestMessages(history, question, undefined, false, undefined, { onTrim: (r) => reports.push(r) })
  assert.equal(reports.length, 1, '直调也必须裁一次')
  const [report] = reports
  assert.equal(report.roundsTotal, getContextRounds(history).length, '轮数口径必须和 store 一致')
  assert.ok(report.charsBefore > report.charsAfter, '字符必须下降')
  console.log(`  直调报告：${budget.formatContextTrim(report)}`)
})
