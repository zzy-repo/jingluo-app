// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1 分钟]
// 被测对象：标准构建的「渠道」下拉（1.4.0-beta.3）——四个渠道各自的输入项、请求地址与能力入口。
// 前置：自己起一份**标准构建**（默认 DIST_OUT=dist-standard）的静态服务，上游全部用 page.route 打桩。
//
//   cd /root/deepseek-app && DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   node tests/integration/provider-channels.test.mjs
//
// 断言（对应任务书验收 1~8、10）：
//   [1] 标准构建默认渠道 = DeepSeek 官方；只渲染 API Key 一行（无 baseUrl / model 输入元素）
//   [2] DeepSeek 官方：发消息 /anthropic/v1/messages + model deepseek-flash；搜索/附件/语音/思考入口都在
//   [3] Anthropic 协议：三件套（服务地址 / 模型 / API Key）；切过去后 Key 不丢；请求按填的值发出 /v1/messages
//   [4] OpenAI 兼容：三件套；请求打到 /v1/chat/completions；搜索/附件/语音/思考入口全部不渲染（DOM 里没有）
//   [5] 我们的渠道：只渲染 API Key（1 个 password 输入框），界面不出现后端地址与内置模型名；
//       请求打到 http://62.106.70.167:60010/v1/chat/completions（OpenAI 协议）+ model deepseek-v4.1-flash，
//       鉴权 Authorization: Bearer <key>（不带 x-api-key），且没有深度思考入口（该协议不提供）
//   [6] 切换渠道后能力入口随之显隐（搜不到 DOM 节点，不是置灰）；刷新后渠道选择持久化
//   [7] 四个渠道的设置页都不出现能力描述文案（基础对话 / 不支持 / 已关闭 / 仅支持 / capability / 能力）
//   [8] console error = 0
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { capturePaths, selectProviderKind } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT || '5293'
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}`
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

const KEY = 'sk-channels-acceptance-key'
const BASE_A = 'https://relay.example.com'
const MODEL_A = 'claude-relay-model'
const BASE_O = 'https://oai.example.com'
const MODEL_O = 'gpt-relay-model'
const OURS_HOST = 'http://62.106.70.167:60010'
const OURS_URL = `${OURS_HOST}/v1/chat/completions`
const OURS_MODEL = 'deepseek-v4.1-flash'
/** 界面上禁止出现的能力描述（能不能用只体现在入口显隐上，不写文案） */
const FORBIDDEN_WORDS = ['基础对话', '不支持', '已关闭', '仅支持', 'capability', '能力']

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

/** Anthropic 风格 SSE（消息正文逐块下发） */
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"stub","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"渠道验收回复"}}',
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

/** OpenAI 风格 SSE（chat/completions chunk 流） */
const OPENAI_SSE = [
  'data: {"id":"chatcmpl-stub","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[{"index":0,"delta":{"content":"渠道验收回复"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6}}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

const children = []
const startStatic = () => {
  const child = spawn('python3', [
    '-m',
    'http.server',
    PORT,
    '--bind',
    '127.0.0.1',
    '--directory',
    DIST,
  ])
  children.push(child)
  return child
}
const cleanup = () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

const shot = async (name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `1.4.0-beta.3-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  note(`截图 ${path.relative(ROOT, file)}`)
}

const readStorage = () =>
  page.evaluate(() => {
    const out = {}
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      out[key] = window.localStorage.getItem(key)
    }
    return out
  })

const openSettings = async () => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(400)
  return page.getByRole('dialog').first()
}

const closeSettings = async (dialog) => {
  await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(400)
}

const channelLabel = async (dialog) =>
  (await dialog.getByRole('button', { name: /渠道|Channel/ }).first().innerText()).trim()

/** 设置页里可见的输入框类型（排除导入历史/聊天背景用的隐藏 file 选择器） */
const visibleInputTypes = async (dialog) => {
  const types = await dialog.locator('input').evaluateAll((list) => list.map((item) => item.type))
  return types.filter((type) => type !== 'file')
}

const expectOnlyApiKey = async (dialog, where) => {
  const types = await visibleInputTypes(dialog)
  const urlInputs = await dialog.locator('input[inputmode="url"]').count()
  const modelInputs = await dialog.getByLabel(/^模型$|^Model$/).count()
  const passwordInputs = await dialog.locator('input[type="password"]').count()
  note(`${where} 输入框：${JSON.stringify(types)}`)
  if (urlInputs > 0 || modelInputs > 0) {
    bad(`${where} 露出了服务地址/模型输入框（url=${urlInputs}, model=${modelInputs}）`)
  } else if (passwordInputs !== 1) {
    bad(`${where} 可见输入框不是唯一一个 API Key：password=${passwordInputs}，全部=${JSON.stringify(types)}`)
  } else if (types.length !== 1) {
    bad(`${where} 还有额外的可编辑输入框：${JSON.stringify(types)}`)
  } else {
    ok(`${where} 只有 1 个可见输入框（API Key，type=password）`)
  }
}

const expectThreeInputs = async (dialog, where) => {
  const urlInputs = await dialog.locator('input[inputmode="url"]').count()
  const modelInputs = await dialog.getByLabel(/^模型$|^Model$/).count()
  if (urlInputs !== 1 || modelInputs !== 1) {
    bad(`${where} 没渲染三件套（服务地址=${urlInputs}、模型=${modelInputs}）`)
  } else {
    ok(`${where} 渲染服务地址 + 模型输入框（API Key 行同时在）`)
  }
}

const expectNoCapabilityCopy = async (dialog, where) => {
  const text = await dialog.innerText()
  const hits = FORBIDDEN_WORDS.filter((word) => text.includes(word))
  if (hits.length > 0) {
    bad(`${where} 出现能力描述文案：${hits.join(' / ')}`)
  } else {
    ok(`${where} 没有能力描述文案`)
  }
}

/** 聊天页某入口的 DOM 节点数（找不到 = 入口压根没渲染） */
const capNodes = async () => ({
  search: await page.locator('button[aria-label="智能搜索"]').count(),
  vision: await page.locator('button[aria-label="上传文件"]').count(),
  asr: await page.locator('button[aria-label="语音输入"]').count(),
  thinking: await page.locator('button[aria-label="深度思考"]').count(),
})

const expectCaps = async (where, expected) => {
  const nodes = await capNodes()
  note(`${where} 入口节点数：${JSON.stringify(nodes)}`)
  for (const [name, want] of Object.entries(expected)) {
    const got = nodes[name]
    const label = { search: '智能搜索', vision: '附件', asr: '语音输入', thinking: '深度思考' }[name]
    if (want && got === 0) {
      bad(`${where} 缺少「${label}」入口`)
    } else if (!want && got !== 0) {
      bad(`${where} 仍然渲染了「${label}」入口（期望 DOM 里没有，实际 ${got} 个）`)
    } else {
      ok(`${where} ${label}入口${want ? '可用' : '不存在（DOM 里没有节点）'}`)
    }
  }
}

const lastMessageRequest = (requests) =>
  requests.filter((request) => request.method === 'POST' && request.postData).at(-1)

const sendAndCapture = async (requests, text) => {
  const before = requests.length
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (requests.slice(before).some((request) => request.method === 'POST' && request.postData)) {
      break
    }
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(600)
  return lastMessageRequest(requests.slice(before))
}

try {
  startStatic()
  await new Promise((resolve) => setTimeout(resolve, 800))

  // ---------- 上游全部打桩，不连外网 ----------
  await page.route('https://api.deepseek.com/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/models')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ANTHROPIC_SSE,
    })
  })
  await page.route(`${BASE_A}/**`, async (route) => {
    const url = route.request().url()
    if (url.includes('/models')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: MODEL_A, type: 'model' }] }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ANTHROPIC_SSE,
    })
  })
  await page.route(`${BASE_O}/**`, async (route) => {
    const url = route.request().url()
    if (url.includes('/models')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: MODEL_O, type: 'model' }] }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: OPENAI_SSE,
    })
  })
  // 我们的渠道：真地址，但请求由 Playwright 拦截（不需要 host 绑定）
  // （2026-11-18 起该上游走 OpenAI 协议：/v1/chat/completions + Authorization: Bearer，SSE 是 chat.completion.chunk）
  await page.route(`${OURS_HOST}/**`, async (route) => {
    const url = route.request().url()
    if (url.includes('/models')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: OURS_MODEL, type: 'model' }] }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: OPENAI_SSE,
    })
  })

  const requests = capturePaths(page)

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  // ---------- [1] 标准构建默认渠道 = DeepSeek 官方 ----------
  console.log('\n[1] 默认渠道（标准构建）')
  let dialog = await openSettings()
  const defaultLabel = await channelLabel(dialog)
  if (!/DeepSeek 官方|DeepSeek Official/.test(defaultLabel)) {
    bad(`标准构建默认渠道不是 DeepSeek 官方：${JSON.stringify(defaultLabel)}`)
  } else {
    ok(`默认渠道 = ${defaultLabel}（标准构建 → deepseek）`)
  }
  await expectOnlyApiKey(dialog, 'DeepSeek 官方')
  await expectNoCapabilityCopy(dialog, 'DeepSeek 官方渠道')
  await shot('channel-deepseek')

  // 保存 Key（DeepSeek 官方渠道 → 共用一把）
  await page.locator('input[type="password"]').first().fill(KEY)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(1200)
  let stored = await readStorage()
  if (stored['chat-demo:api-key'] !== KEY) {
    bad('API Key 没有写入 localStorage')
  } else {
    ok('API Key 已保存')
  }
  if (Object.hasOwn(stored, 'chat-demo:base-url') || Object.hasOwn(stored, 'chat-demo:model')) {
    bad(`内置渠道不该写地址/模型：${JSON.stringify(stored)}`)
  } else {
    ok('内置渠道没有把地址/模型写进 localStorage')
  }
  await closeSettings(dialog)

  // ---------- [2] DeepSeek 官方：能力全开 + 请求路径 ----------
  console.log('\n[2] DeepSeek 官方渠道')
  await expectCaps('DeepSeek 官方', { search: true, vision: true, asr: true, thinking: true })
  const hitDeepseek = await sendAndCapture(requests, '你好，官方渠道')
  if (!hitDeepseek) {
    bad('DeepSeek 官方渠道没有发出消息请求')
  } else {
    if (hitDeepseek.url !== 'https://api.deepseek.com/anthropic/v1/messages') {
      bad(`DeepSeek 官方发消息 URL 不对：${hitDeepseek.url}`)
    } else {
      ok(`DeepSeek 官方发消息 → ${new URL(hitDeepseek.url).pathname}`)
    }
    const body = JSON.parse(hitDeepseek.postData ?? '{}')
    if (body.model !== 'deepseek-flash') {
      bad(`DeepSeek 官方 model 不对：${JSON.stringify(body.model)}`)
    } else {
      ok(`DeepSeek 官方 model = ${body.model}`)
    }
  }

  // ---------- [3] Anthropic 协议：三件套 + Key 不丢 ----------
  console.log('\n[3] Anthropic 协议渠道')
  dialog = await openSettings()
  await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)
  dialog = page.getByRole('dialog').first()
  await expectThreeInputs(dialog, 'Anthropic 协议')
  await expectNoCapabilityCopy(dialog, 'Anthropic 协议渠道')
  stored = await readStorage()
  if (stored['chat-demo:api-key'] !== KEY) {
    bad('切到 Anthropic 协议后 API Key 丢了')
  } else {
    ok('切到 Anthropic 协议后 API Key 仍在（共用一把）')
  }
  await page.getByLabel(/服务地址|Service URL/).first().fill(BASE_A)
  await page.getByLabel(/服务地址|Service URL/).first().press('Enter')
  await page.getByLabel(/^模型$|^Model$/).first().fill(MODEL_A)
  await page.getByLabel(/^模型$|^Model$/).first().press('Enter')
  await page.waitForTimeout(400)
  stored = await readStorage()
  if (stored['chat-demo:base-url:anthropic'] !== BASE_A || stored['chat-demo:model:anthropic'] !== MODEL_A) {
    bad(`Anthropic 协议的地址/模型没有按渠道分开存：${JSON.stringify(stored)}`)
  } else {
    ok('Anthropic 协议的地址/模型按渠道落盘（chat-demo:base-url:anthropic / model:anthropic）')
  }
  await shot('channel-anthropic')
  await closeSettings(dialog)
  await expectCaps('Anthropic 协议', { search: false, vision: false, asr: false, thinking: true })
  const hitAnthropic = await sendAndCapture(requests, '你好，Anthropic 协议')
  if (!hitAnthropic) {
    bad('Anthropic 协议渠道没有发出消息请求')
  } else {
    if (hitAnthropic.url !== `${BASE_A}/v1/messages`) {
      bad(`Anthropic 协议发消息 URL 不对：${hitAnthropic.url}`)
    } else {
      ok(`Anthropic 协议发消息 → ${new URL(hitAnthropic.url).pathname}（自填地址生效）`)
    }
    const body = JSON.parse(hitAnthropic.postData ?? '{}')
    if (body.model !== MODEL_A) {
      bad(`Anthropic 协议 model 不对：${JSON.stringify(body.model)}`)
    } else {
      ok(`Anthropic 协议 model = ${body.model}（自填模型生效）`)
    }
  }

  // ---------- [4] OpenAI 兼容：三件套 + /v1/chat/completions，能力入口全无 ----------
  console.log('\n[4] OpenAI 兼容渠道')
  dialog = await openSettings()
  await selectProviderKind(page, /OpenAI 兼容|OpenAI-compatible/)
  dialog = page.getByRole('dialog').first()
  await expectThreeInputs(dialog, 'OpenAI 兼容')
  await expectNoCapabilityCopy(dialog, 'OpenAI 兼容渠道')
  await page.getByLabel(/服务地址|Service URL/).first().fill(BASE_O)
  await page.getByLabel(/服务地址|Service URL/).first().press('Enter')
  await page.getByLabel(/^模型$|^Model$/).first().fill(MODEL_O)
  await page.getByLabel(/^模型$|^Model$/).first().press('Enter')
  await page.waitForTimeout(400)
  await shot('channel-openai')
  await closeSettings(dialog)
  await expectCaps('OpenAI 兼容', { search: false, vision: false, asr: false, thinking: false })
  const hitOpenai = await sendAndCapture(requests, '你好，OpenAI 兼容')
  if (!hitOpenai) {
    bad('OpenAI 兼容渠道没有发出消息请求')
  } else {
    if (hitOpenai.url !== `${BASE_O}/v1/chat/completions`) {
      bad(`OpenAI 兼容发消息 URL 不对：${hitOpenai.url}`)
    } else {
      ok(`OpenAI 兼容发消息 → ${new URL(hitOpenai.url).pathname}`)
    }
    const body = JSON.parse(hitOpenai.postData ?? '{}')
    if (body.model !== MODEL_O) {
      bad(`OpenAI 兼容 model 不对：${JSON.stringify(body.model)}`)
    } else {
      ok(`OpenAI 兼容 model = ${body.model}`)
    }
  }

  // ---------- [5][6] 我们的渠道：只露 API Key + 内置地址/模型 ----------
  console.log('\n[5][6] 我们的渠道')
  dialog = await openSettings()
  await selectProviderKind(page, /我们的渠道|Our Channel/)
  dialog = page.getByRole('dialog').first()
  // 清掉 Key 再看「只显示唯一一个输入框」的形态（有 Key 时那行是掩码，不是输入框）
  await page.evaluate(() => window.localStorage.removeItem('chat-demo:api-key'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  dialog = await openSettings()
  const oursLabel = await channelLabel(dialog)
  if (!/我们的渠道|Our Channel/.test(oursLabel)) {
    bad(`刷新后渠道选择没保住：${JSON.stringify(oursLabel)}`)
  } else {
    ok(`刷新后渠道仍是 ${oursLabel}（渠道选择持久化）`)
  }
  await expectOnlyApiKey(dialog, '我们的渠道')
  const oursText = await dialog.innerText()
  for (const secret of ['62.106.70.167', '60010', OURS_MODEL]) {
    if (oursText.includes(secret)) {
      bad(`我们的渠道把内置值露在界面上了：${secret}`)
    } else {
      ok(`我们的渠道界面不展示 ${secret}`)
    }
  }
  await expectNoCapabilityCopy(dialog, '我们的渠道')
  await shot('channel-ours')
  await page.locator('input[type="password"]').first().fill(KEY)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(1200)
  await closeSettings(dialog)
  await expectCaps('我们的渠道', { search: false, vision: false, asr: false, thinking: false })
  const hitOurs = await sendAndCapture(requests, '你好，我们的渠道')
  if (!hitOurs) {
    bad('我们的渠道没有发出消息请求')
  } else {
    if (hitOurs.url !== OURS_URL) {
      bad(`我们的渠道发消息 URL 不对：${hitOurs.url}`)
    } else {
      ok(`我们的渠道发消息 → ${hitOurs.url}`)
    }
    const body = JSON.parse(hitOurs.postData ?? '{}')
    if (body.model !== OURS_MODEL) {
      bad(`我们的渠道 model 不对：${JSON.stringify(body.model)}`)
    } else {
      ok(`我们的渠道 model = ${body.model}`)
    }
    if (hitOurs.headers.authorization !== `Bearer ${KEY}`) {
      bad(`我们的渠道 Authorization 头不对：${JSON.stringify(hitOurs.headers.authorization)}`)
    } else {
      ok('我们的渠道 Authorization = Bearer <用户填的 key>')
    }
    if (hitOurs.headers['x-api-key']) {
      bad(`我们的渠道不该再带 x-api-key：${JSON.stringify(hitOurs.headers['x-api-key'])}`)
    } else {
      ok('我们的渠道未带 x-api-key（OpenAI 协议只用 Bearer）')
    }
    if (hitOurs.headers['anthropic-version']) {
      bad(`我们的渠道不该带 anthropic-version：${hitOurs.headers['anthropic-version']}`)
    } else {
      ok('我们的渠道未带 anthropic-version（CORS 预检安全）')
    }
    for (const field of ['safety_check', 'tools', 'title']) {
      if (Object.hasOwn(body, field)) {
        bad(`我们的渠道请求体仍带 ${field}`)
      } else {
        ok(`我们的渠道请求体已剥离 ${field}`)
      }
    }
  }

  // ---------- [8] console error ----------
  console.log('\n[8] console error')
  if (consoleErrors.length > 0) {
    bad(`console 有 ${consoleErrors.length} 条 error：${consoleErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('console error = 0')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  cleanup()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/provider-channels.test.mjs`)
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
