// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 会话自动标题验收（Anthropic / OpenAI 兼容模式；DeepSeek 官方模式零影响）
//
//   cd /root/deepseek-app && node tests/integration/auto-title.test.mjs
//
// 被测页面是预构建标准产物（STANDARD_DIST_DIR / DIST_DIR），脚本只读复用并起临时端口服务；
// 上游全部用 page.route 打桩，
// 不连任何外网、不依赖真实 IP。
//
// 断言（对应任务书 9 条验收）：
//   [1] 成功路径：mock 返回「如何配置代理」→ 会话标题变成该值，且只发起一次标题请求
//   [2] 超时：mock 延迟 10s → 8s 放弃，标题回退为本地截取，UI 不卡（期间可继续输入）
//   [3] HTTP 500 → 回退
//   [4] 返回空字符串 → 回退
//   [5] 脏输出（Markdown 强调 + 解释行）→ 只取「标题」，星号被剥掉
//   [6] finish 原因异常（max_tokens / tool_use）→ 视为失败并回退
//   [7] 手动改名后不再覆盖：改名 → 再发一轮 → 标题保持用户改的名字，且不再发起标题请求
//   [8] DeepSeek 模式回归：请求仍带 title:{enabled:true}，本地标题逻辑不触发（无额外请求）
//   [9] console error = 0
//   [10] 附加：OpenAI 兼容模式的标题请求走 {base}/v1/chat/completions（任务书要求的接口分流）
//   [11] 附加：部署验证——对 http://127.0.0.1:5181（可用 DEPLOY_URL 覆盖）再跑一遍成功路径，不可达则跳过
import { serveDist, requireDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const STANDARD_DIST = await requireDist(process.env.STANDARD_DIST_DIR || process.env.DIST_DIR || path.join(ROOT, 'dist-standard'))
let APP_URL
const KEY = 'sk-auto-title-acceptance-key'
const REPLY = '验收用 mock 回复。'
/** 「去掉语气前缀 → 取前 20 字符 → 回退到句读处 → 补省略号」的期望值 */
const LONG_QUESTION = '你好，请问这个网络问题怎么解决？我这边代理一直连不上'
const LOCAL_FALLBACK = '这个网络问题怎么解决…'

const failures = []
const evidence = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => {
  evidence.push(message)
  console.log(`  ·   ${message}`)
}

// ---------- 0) Reuse a private prebuilt artifact; bind port atomically ----------
const staticServer = await serveDist(STANDARD_DIST, { port: process.env.PORT || 0 })
APP_URL = staticServer.url
// 产物守卫：种类不对（内测/标准）或产物比源码旧 → SKIP(env)，不产生假红
await verifyAppUrl(APP_URL, STANDARD_DIST, { variant: 'standard' })
const cleanup = () => staticServer.close()
let browser
try { browser = await chromium.launch() }
catch (error) { await cleanup(); throw error }
try {
const allConsoleErrors = []
/** 浏览器对非 2xx 响应的资源日志（HTTP 500 用例必然产生），口径同 tests/integration/full-acceptance.test.mjs */
const allResourceNoise = []

// ---------- 通用步骤 ----------
const CHAT_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' +
    REPLY +
    '"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const OPENAI_CHUNK = (choices) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}`
const OPENAI_SSE = [
  OPENAI_CHUNK([{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }]),
  '',
  OPENAI_CHUNK([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

/** 打开应用并把服务配置直接写进 localStorage（被测的是标题逻辑，不是设置页交互） */
const openPage = async ({ kind, baseUrl, model, url = APP_URL }) => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return
    }
    const text = message.text()
    if (/Failed to load resource/i.test(text)) {
      // 浏览器自己给非 2xx 响应打的资源日志，不是应用报错；HTTP 500 用例必然产生（口径同 tests/integration/full-acceptance.test.mjs）
      allResourceNoise.push(text)
      return
    }
    consoleErrors.push(text)
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ kind, baseUrl, model, key }) => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:provider-kind', kind)
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:base-url', baseUrl)
      window.localStorage.setItem('chat-demo:model', model)
    },
    { kind, baseUrl, model, key: KEY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  return { context, page, consoleErrors }
}

/**
 * 打桩上游：按请求体区分聊天流与标题请求，标题请求交给 scenario 的 handler。
 * 返回的数组就是 mock 侧收到的全部请求（用于「只发起一次」的证明）。
 */
const installUpstream = async (page, { chatPath, titleHandler, chatSse = CHAT_SSE }) => {
  const requests = []
  await page.route(chatPath, async (route) => {
    const request = route.request()
    let body = {}
    try {
      body = JSON.parse(request.postData() ?? '{}')
    } catch {
      body = {}
    }
    const isTitle = body.stream === false || body.max_tokens === 32
    const entry = {
      kind: isTitle ? 'title' : 'chat',
      url: request.url(),
      path: new URL(request.url()).pathname,
      body,
      headers: request.headers(),
    }
    requests.push(entry)
    try {
      if (isTitle) {
        await titleHandler(route, body)
      } else {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: chatSse,
        })
      }
    } catch {
      // 8s 超时后浏览器已放弃该请求，迟到的 fulfill 会报错，忽略
    }
  })
  return requests
}

/** 标题 mock 的几种形态 */
const titleReply = (route, text, stopReason = 'end_turn') =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'msg_title',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content:
        text === null
          ? [{ type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} }]
          : [{ type: 'text', text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  })

const readSessions = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!db.objectStoreNames.contains('sessionSummaries')) {
      db.close()
      return []
    }
    const list = await new Promise((resolve, reject) => {
      const request = db
        .transaction('sessionSummaries', 'readonly')
        .objectStore('sessionSummaries')
        .getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return list.map((item) => ({ id: item.id, title: item.title }))
  })

/** 轮询持久化后的会话标题（IndexedDB sessionSummaries），返回出现时间 */
const waitForTitle = async (page, expected, timeout = 14000) => {
  const start = Date.now()
  let sessions = []
  while (Date.now() - start < timeout) {
    try {
      sessions = await readSessions(page)
    } catch {
      sessions = []
    }
    if (sessions.some((session) => session.title === expected)) {
      return { ok: true, elapsed: Date.now() - start, sessions }
    }
    await page.waitForTimeout(120)
  }
  return { ok: false, elapsed: Date.now() - start, sessions }
}

const sendChat = async (page, text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page
    .getByRole('button', { name: /^发送$|^Send$/ })
    .first()
    .click()
}

const waitForReply = async (page, timeout = 15000) => {
  await page.getByText(REPLY).first().waitFor({ timeout })
  await page.waitForTimeout(300)
}

/** 一条标题场景：发一条消息 → 等标题落库 → 断言 */
const runTitleScenario = async ({
  id,
  label,
  message,
  titleHandler,
  expectTitle,
  chatPath = /\/v1\/messages$/,
  kind = 'anthropic',
}) => {
  console.log(`\n${id} ${label}`)
  const { context, page, consoleErrors } = await openPage({
    kind,
    baseUrl: 'https://anthropic.example.com',
    model: 'test-model',
  })
  try {
    const requests = await installUpstream(page, { chatPath, titleHandler })
    await sendChat(page, message)
    await waitForReply(page)
    const result = await waitForTitle(page, expectTitle)
    if (!result.ok) {
      bad(
        `${id} 期望标题「${expectTitle}」，实际 ${JSON.stringify(result.sessions.map((s) => s.title))}`
      )
    } else {
      ok(`${id} 会话标题 = 「${expectTitle}」（${result.elapsed}ms 落库）`)
      note(`${id} mock 收到请求：${requests.map((r) => `${r.kind} ${r.path}`).join(' ，')}`)
    }
    // 只发起一次：再等 2.5s，标题请求次数必须还是 1
    await page.waitForTimeout(2500)
    const titleCount = requests.filter((r) => r.kind === 'title').length
    if (titleCount !== 1) {
      bad(`${id} 标题请求次数 = ${titleCount}（期望 1）`)
    } else {
      ok(`${id} 标题请求次数 = 1（mock 侧计数）`)
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`${id}: ${consoleErrors.slice(0, 2).join(' | ')}`)
      bad(`${id} console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
    return { requests }
  } catch (error) {
    bad(`${id} 用例异常：${error instanceof Error ? error.message : String(error)}`)
    return { requests: [] }
  } finally {
    await context.close()
  }
}

// ---------- [1] 成功路径 + 请求形状 ----------
{
  console.log('\n[1] 成功路径：mock 返回「如何配置代理」')
  const { context, page, consoleErrors } = await openPage({
    kind: 'anthropic',
    baseUrl: 'https://anthropic.example.com',
    model: 'test-model',
  })
  try {
    const requests = await installUpstream(page, {
      chatPath: /\/v1\/messages$/,
      titleHandler: (route) => titleReply(route, '如何配置代理'),
    })
    await sendChat(page, LONG_QUESTION)
    await waitForReply(page)
    const result = await waitForTitle(page, '如何配置代理')
    if (!result.ok) {
      bad(
        `[1] 标题没有变成「如何配置代理」：${JSON.stringify(result.sessions.map((s) => s.title))}`
      )
    } else {
      ok(`[1] 会话标题 = 「如何配置代理」（${result.elapsed}ms 落库）`)
    }
    await page.waitForTimeout(2500)
    const titleRequests = requests.filter((r) => r.kind === 'title')
    if (titleRequests.length !== 1) {
      bad(`[1] 标题请求次数 = ${titleRequests.length}（期望 1）`)
    } else {
      ok('[1] 只发起了一次标题请求（mock 侧计数 = 1）')
    }
    note(`[1] mock 收到：${requests.map((r) => `${r.kind} ${r.path}`).join(' ，')}`)
    const title = titleRequests[0]
    if (!title) {
      bad('[1] 没有捕获到标题请求')
    } else {
      note(`[1] 标题请求 URL = ${title.url}`)
      note(`[1] 标题请求体 = ${JSON.stringify(title.body)}`)
      if (title.path !== '/v1/messages') {
        bad(`[1] Anthropic 模式的标题请求应打 {base}/v1/messages，实际 ${title.path}`)
      } else {
        ok('[1] 标题请求走 {base}/v1/messages')
      }
      if (title.body.max_tokens !== 32) {
        bad(`[1] 标题请求 max_tokens = ${title.body.max_tokens}（期望 32）`)
      } else {
        ok('[1] max_tokens = 32（最小化开销）')
      }
      if (title.body.stream !== false) {
        bad(`[1] 标题请求不是非流式：stream=${JSON.stringify(title.body.stream)}`)
      } else {
        ok('[1] 非流式请求（stream=false）')
      }
      if (title.body.thinking !== undefined) {
        bad(`[1] 标题请求不该带 thinking：${JSON.stringify(title.body.thinking)}`)
      } else {
        ok('[1] 未开 thinking')
      }
      if (typeof title.body.system !== 'string' || !title.body.system.includes('简洁标题')) {
        bad(`[1] 标题请求 system prompt 不对：${JSON.stringify(title.body.system)}`)
      } else {
        ok('[1] 带标题 system prompt')
      }
      const messages = title.body.messages ?? []
      if (messages.length !== 1 || messages[0]?.role !== 'user') {
        bad(`[1] 只该喂一条 user 消息，实际 ${JSON.stringify(messages)}`)
      } else {
        let parsed = null
        try {
          parsed = JSON.parse(messages[0].content)
        } catch {
          parsed = null
        }
        if (!Array.isArray(parsed) || parsed[0] !== LONG_QUESTION) {
          bad(`[1] 用户消息应被包成 JSON 数组，实际 ${JSON.stringify(messages[0].content)}`)
        } else {
          ok('[1] 只喂首条用户消息，且包成 JSON 数组（防注入）')
        }
      }
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`[1]: ${consoleErrors.join(' | ')}`)
      bad(`[1] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
  } catch (error) {
    bad(`[1] 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

// ---------- [2] 超时（mock 延迟 10s）----------
{
  console.log('\n[2] 超时：mock 延迟 10s → 8s 放弃并回退')
  const { context, page, consoleErrors } = await openPage({
    kind: 'anthropic',
    baseUrl: 'https://anthropic.example.com',
    model: 'test-model',
  })
  try {
    const requests = await installUpstream(page, {
      chatPath: /\/v1\/messages$/,
      titleHandler: async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 10000))
        await titleReply(route, '迟到的标题不该生效')
      },
    })
    await sendChat(page, LONG_QUESTION)
    await waitForReply(page)

    // UI 不卡：标题请求在飞的这 8 秒里，输入框必须照常可用
    const textarea = page.locator('textarea').last()
    const t0 = Date.now()
    await textarea.fill('界面仍然可用')
    const typed = await textarea.inputValue()
    const typingCost = Date.now() - t0
    if (typed !== '界面仍然可用' || typingCost > 2000) {
      bad(`[2] 标题请求期间 UI 卡住了：inputValue=${JSON.stringify(typed)} 耗时 ${typingCost}ms`)
    } else {
      ok(`[2] 标题请求期间 UI 不卡（输入耗时 ${typingCost}ms）`)
    }
    await textarea.fill('')

    const result = await waitForTitle(page, LOCAL_FALLBACK)
    if (!result.ok) {
      bad(
        `[2] 超时后应回退为「${LOCAL_FALLBACK}」，实际 ${JSON.stringify(result.sessions.map((s) => s.title))}`
      )
    } else {
      ok(
        `[2] 8s 超时后回退为「${LOCAL_FALLBACK}」（${result.elapsed}ms 落库，早于 mock 的 10s 响应）`
      )
      if (result.elapsed > 10000) {
        bad(`[2] 回退耗时 ${result.elapsed}ms，超过了 10s 的 mock 延迟，说明不是超时放弃`)
      }
    }
    // 迟到的 10s 响应不能把标题改掉
    await page.waitForTimeout(3000)
    const after = await readSessions(page)
    if (after.some((session) => session.title === LOCAL_FALLBACK)) {
      ok('[2] 迟到的上游响应没有覆盖本地回退标题')
    } else {
      bad(`[2] 迟到响应覆盖了标题：${JSON.stringify(after.map((s) => s.title))}`)
    }
    const titleCount = requests.filter((r) => r.kind === 'title').length
    if (titleCount !== 1) {
      bad(`[2] 标题请求次数 = ${titleCount}（期望 1）`)
    } else {
      ok('[2] 标题请求次数 = 1')
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`[2]: ${consoleErrors.join(' | ')}`)
      bad(`[2] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
  } catch (error) {
    bad(`[2] 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

// ---------- [3][4][5][6] 失败与脏输出 ----------
await runTitleScenario({
  id: '[3]',
  label: 'HTTP 500 → 回退',
  message: LONG_QUESTION,
  titleHandler: (route) =>
    route.fulfill({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { message: 'boom' } }),
    }),
  expectTitle: LOCAL_FALLBACK,
})

await runTitleScenario({
  id: '[4]',
  label: '返回空字符串 → 回退',
  message: LONG_QUESTION,
  titleHandler: (route) => titleReply(route, ''),
  expectTitle: LOCAL_FALLBACK,
})

await runTitleScenario({
  id: '[5]',
  label: '脏输出 **标题**\\n解释… → 只取「标题」',
  message: LONG_QUESTION,
  titleHandler: (route) => titleReply(route, '**标题**\n解释…'),
  expectTitle: '标题',
})

await runTitleScenario({
  id: '[6a]',
  label: 'finish 原因 max_tokens → 回退',
  message: LONG_QUESTION,
  titleHandler: (route) => titleReply(route, '半截标题', 'max_tokens'),
  expectTitle: LOCAL_FALLBACK,
})

await runTitleScenario({
  id: '[6b]',
  label: 'finish 原因 tool_use → 回退',
  message: LONG_QUESTION,
  titleHandler: (route) => titleReply(route, null, 'tool_use'),
  expectTitle: LOCAL_FALLBACK,
})

// ---------- [7] 手动改名后不再覆盖 ----------
{
  console.log('\n[7] 手动改名后不再覆盖')
  const { context, page, consoleErrors } = await openPage({
    kind: 'anthropic',
    baseUrl: 'https://anthropic.example.com',
    model: 'test-model',
  })
  try {
    const requests = await installUpstream(page, {
      chatPath: /\/v1\/messages$/,
      titleHandler: (route) => titleReply(route, '如何配置代理'),
    })
    await sendChat(page, LONG_QUESTION)
    await waitForReply(page)
    const first = await waitForTitle(page, '如何配置代理')
    if (!first.ok) {
      bad('[7] 自动标题没有先落库，用例前提不成立')
    } else {
      ok('[7] 先自动生成标题「如何配置代理」')
    }

    // 侧边栏菜单 → 重命名
    await page
      .getByRole('button', { name: /^更多$|^More$/ })
      .first()
      .click()
    await page
      .getByRole('menuitem', { name: /^重命名$|^Rename$/ })
      .first()
      .click()
    const input = page.locator('input:focus').first()
    await input.fill('我的自定义标题')
    await input.press('Enter')
    await page.waitForTimeout(800)
    const renamed = await readSessions(page)
    if (!renamed.some((session) => session.title === '我的自定义标题')) {
      bad(`[7] 手动改名没有生效：${JSON.stringify(renamed.map((s) => s.title))}`)
    } else {
      ok('[7] 手动改名生效：「我的自定义标题」')
    }

    // 再发一轮（同一会话），标题必须保持用户改的名字
    await sendChat(page, '那如果是 https 代理呢？')
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && requests.filter((r) => r.kind === 'chat').length < 2) {
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(3000)
    const after = await readSessions(page)
    if (after.some((session) => session.title === '我的自定义标题')) {
      ok('[7] 第二轮之后标题仍是「我的自定义标题」（未被覆盖）')
    } else {
      bad(`[7] 第二轮覆盖了用户标题：${JSON.stringify(after.map((s) => s.title))}`)
    }
    const titleCount = requests.filter((r) => r.kind === 'title').length
    if (titleCount !== 1) {
      bad(`[7] 第二轮又发起了标题请求（总数 ${titleCount}，期望 1）`)
    } else {
      ok('[7] 改名后没有再次发起标题请求（总数 = 1）')
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`[7]: ${consoleErrors.join(' | ')}`)
      bad(`[7] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
  } catch (error) {
    bad(`[7] 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

// ---------- [8] DeepSeek 模式回归 ----------
{
  console.log('\n[8] DeepSeek 官方模式回归：原生 title 字段在、本地标题逻辑不触发')
  const { context, page, consoleErrors } = await openPage({
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  })
  try {
    const requests = await installUpstream(page, {
      chatPath: /\/anthropic\/v1\/messages$/,
      titleHandler: () => {
        throw new Error('DeepSeek 模式不该有标题请求')
      },
    })
    await sendChat(page, LONG_QUESTION)
    await waitForReply(page)
    // 等 9s：本地标题逻辑若被触发，8s 超时都该走完了
    await page.waitForTimeout(9000)
    const chatRequests = requests.filter((r) => r.kind === 'chat')
    const titleRequests = requests.filter((r) => r.kind === 'title')
    note(`[8] mock 收到：${requests.map((r) => `${r.kind} ${r.path}`).join(' ，')}`)
    if (chatRequests.length !== 1) {
      bad(`[8] DeepSeek 模式请求数 = ${chatRequests.length}（期望 1）`)
    } else {
      ok('[8] DeepSeek 模式只发了 1 个聊天请求')
    }
    if (titleRequests.length !== 0) {
      bad(`[8] DeepSeek 模式冒出了本地标题请求：${titleRequests.length}`)
    } else {
      ok('[8] 没有额外的本地标题请求（本地标题逻辑未触发）')
    }
    const body = chatRequests[0]?.body ?? {}
    if (body.title?.enabled !== true) {
      bad(`[8] DeepSeek 请求体丢了 title:{enabled:true}：${JSON.stringify(body.title)}`)
    } else {
      ok('[8] 请求体仍带 title:{enabled:true}（原生标题路径未动）')
    }
    const sessions = await readSessions(page)
    if (sessions.some((session) => session.title)) {
      bad(`[8] DeepSeek 模式不该写本地标题：${JSON.stringify(sessions.map((s) => s.title))}`)
    } else {
      ok('[8] 会话标题保持为空（等原生 title 字段，未被本地逻辑改写）')
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`[8]: ${consoleErrors.join(' | ')}`)
      bad(`[8] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
  } catch (error) {
    bad(`[8] 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

// ---------- [10] OpenAI 兼容模式：标题请求走 /v1/chat/completions ----------
{
  console.log('\n[10] OpenAI 兼容模式：标题请求走 {base}/v1/chat/completions')
  const { context, page, consoleErrors } = await openPage({
    kind: 'openai',
    baseUrl: 'https://openai.example.com',
    model: 'gpt-test',
  })
  try {
    const requests = []
    await page.route(/\/v1\/chat\/completions$/, async (route) => {
      const request = route.request()
      let body = {}
      try {
        body = JSON.parse(request.postData() ?? '{}')
      } catch {
        body = {}
      }
      const isTitle = body.stream === false || body.max_tokens === 32
      requests.push({
        kind: isTitle ? 'title' : 'chat',
        path: new URL(request.url()).pathname,
        body,
      })
      try {
        if (isTitle) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'chatcmpl-title',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '如何配置代理' },
                  finish_reason: 'stop',
                },
              ],
            }),
          })
        } else {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: OPENAI_SSE,
          })
        }
      } catch {
        // 请求可能已被取消
      }
    })
    await sendChat(page, LONG_QUESTION)
    await waitForReply(page)
    const result = await waitForTitle(page, '如何配置代理')
    if (!result.ok) {
      bad(`[10] OpenAI 模式标题没有落库：${JSON.stringify(result.sessions.map((s) => s.title))}`)
    } else {
      ok('[10] OpenAI 模式标题 = 「如何配置代理」')
    }
    const title = requests.find((r) => r.kind === 'title')
    if (!title) {
      bad('[10] 没捕获到 OpenAI 模式的标题请求')
    } else {
      note(`[10] 标题请求 URL path = ${title.path}，请求体 = ${JSON.stringify(title.body)}`)
      if (title.path !== '/v1/chat/completions') {
        bad(`[10] 应走 {base}/v1/chat/completions，实际 ${title.path}`)
      } else {
        ok('[10] 标题请求走 {base}/v1/chat/completions')
      }
      const roles = (title.body.messages ?? []).map((message) => message.role)
      if (roles[0] !== 'system' || roles[1] !== 'user') {
        bad(`[10] OpenAI 标题请求应是 system + user：${JSON.stringify(roles)}`)
      } else {
        ok('[10] system prompt + 单条 user 消息（JSON 数组）')
      }
    }
    if (consoleErrors.length > 0) {
      allConsoleErrors.push(`[10]: ${consoleErrors.join(' | ')}`)
      bad(`[10] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
    }
  } catch (error) {
    bad(`[10] 用例异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

// ---------- [11] 部署验证：5181 上跑一遍成功路径（可选，不可达则跳过）----------
{
  const DEPLOY_URL = process.env.DEPLOY_URL || 'http://127.0.0.1:5181'
  let reachable = false
  try {
    const response = await fetch(DEPLOY_URL, { signal: AbortSignal.timeout(3000) })
    reachable = response.ok
  } catch {
    reachable = false
  }
  console.log(`\n[11] 部署验证（${DEPLOY_URL}）`)
  if (!reachable) {
    note(`[11] 跳过：${DEPLOY_URL} 不可达`)
  } else {
    const { context, page, consoleErrors } = await openPage({
      kind: 'anthropic',
      baseUrl: 'https://anthropic.example.com',
      model: 'test-model',
      url: DEPLOY_URL,
    })
    try {
      const requests = await installUpstream(page, {
        chatPath: /\/v1\/messages$/,
        titleHandler: (route) => titleReply(route, '如何配置代理'),
      })
      await sendChat(page, LONG_QUESTION)
      await waitForReply(page)
      const result = await waitForTitle(page, '如何配置代理')
      if (!result.ok) {
        bad(`[11] 部署版没有自动标题：${JSON.stringify(result.sessions.map((s) => s.title))}`)
      } else {
        ok(`[11] 部署版（${DEPLOY_URL}）标题 = 「如何配置代理」`)
        note(`[11] 部署版 mock 收到：${requests.map((r) => `${r.kind} ${r.url}`).join(' ，')}`)
      }
      if (consoleErrors.length > 0) {
        allConsoleErrors.push(`[11]: ${consoleErrors.join(' | ')}`)
        bad(`[11] console error：${consoleErrors.slice(0, 2).join(' | ')}`)
      }
    } catch (error) {
      bad(`[11] 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context.close()
    }
  }
}

// ---------- [9] console error = 0 ----------
{
  console.log('\n[9] console error')
  if (allConsoleErrors.length > 0) {
    bad(`[9] console 有 error：${allConsoleErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('[9] console error = 0')
    if (allResourceNoise.length > 0) {
      note(
        `[9] 另排除 ${allResourceNoise.length} 条浏览器资源日志（HTTP 500 用例的 "Failed to load resource"，非应用报错）`
      )
    }
  }
}

} finally {
  try { await browser.close() } finally { await cleanup() }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/auto-title.test.mjs`)
if (evidence.length > 0) {
  console.log('证据：')
  for (const item of evidence) {
    console.log(`  · ${item}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
