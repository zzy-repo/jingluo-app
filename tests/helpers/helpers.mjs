// 共享的 Playwright 步骤：打开设置 → 数据管理，并捕获 /models 探测请求。
import { chromium } from 'playwright'
import { defaultDist, verifyAppUrl } from './env.mjs'

// 默认走 127.0.0.1：语音输入用例需要「安全上下文」（localhost/127.0.0.1）才拿到麦克风，
// 局域网 IP（100.113.135.55）不是安全上下文，按钮会被置灰成「非 HTTPS 页面无法使用语音输入」。
export const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
export const FAKE_KEY = 'sk-testkey-0123456789'

/** 启动浏览器并进入「干净」的应用状态：清掉 localStorage 里已保存的配置后重载 */
export const openApp = async () => {
  // 环境守卫：APP_URL 不可达 / serve 的不是本地 dist（端口撞车）/ 产物陈旧 → SKIP(env)，不产生假红
  await verifyAppUrl(APP_URL, defaultDist(), { variant: 'standard' })
  // 伪造麦克风：语音输入用例要真的走一次 /v1/tools/asr（被测页需为 localhost/127.0.0.1 这类安全上下文）
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  })
  const page = await context.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  return { browser, page }
}

/** 没有 API Key 时应用会自己弹出设置并选中「数据管理」；已弹出就只切分组 */
export const openSettingsDataSection = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  // 已保存 Key 时密码框是隐藏的（只显示掩码），等不到不算错
  await page.waitForSelector('input[type="password"]', { timeout: 3000 }).catch(() => {})
}

/** 监听 /models 请求，返回数组（元素为 { url, authorization, apiKey, version }） */
export const captureProbeRequests = (page) => {
  const captured = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('/models')) {
      const headers = request.headers()
      captured.push({
        url: request.url(),
        authorization: headers['authorization'],
        apiKey: headers['x-api-key'],
        version: headers['anthropic-version'],
      })
    }
  })
  return captured
}

/** 点服务地址那一行的「测试」按钮 */
export const clickTest = async (page) => {
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
}

/** 等待第一条探测请求出现（等不到返回 false） */
export const waitForProbe = async (page, captured, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (captured.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100)
  }
  return captured.length > 0
}

/** 统一的收尾：打印失败原因并以非 0 退出，或用例通过 */
export const finish = async (browser, name, failures) => {
  await browser.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}`)
}

// ---------- 1.2.3 服务类型 / 协议适配用例共用的步骤 ----------

/** 伪造一段合法的 Messages SSE 响应，让用例不依赖真实上游 */
export const MESSAGES_SSE_OK = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"deepseek-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好呀"}}',
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

/** 捕获所有请求 { method, path, url, headers } */
export const capturePaths = (page) => {
  const list = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    list.push({
      method: request.method(),
      path: url.pathname,
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    })
  })
  return list
}

/** 把消息接口打桩成正常 SSE（避免真的连上游） */
export const stubMessagesStream = async (page, pathRe = /\/anthropic\/v1\/messages$/) => {
  await page.route(pathRe, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: MESSAGES_SSE_OK,
    })
  })
}

/** 把 /models 打桩成正常模型列表 */
export const stubModels = async (page, pathRe = /\/models$/) => {
  await page.route(pathRe, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
    })
  })
}

/** 把 /v1/tools/asr 打桩成识别结果 */
export const stubAsr = async (page) => {
  await page.route(/\/v1\/tools\/asr$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '语音转写内容' }),
    })
  })
}

/** 在 API Key 输入框里填 key（不点「确定」） */
export const fillApiKey = async (page, key) => {
  await page.locator('input[type="password"]').first().fill(key)
}

/** 点 API Key 行的「确定」 */
export const clickApiKeyConfirm = async (page) => {
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
}

/** 关掉设置弹窗 */
export const closeSettings = async (page) => {
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(300)
  }
}

/** 打开设置 → 通用设置（服务类型在最上面的「数据管理」分组里） */
export const openSettingsDataTab = openSettingsDataSection

/** 选「渠道」下拉里的某一项（1.4.0-beta.3 起叫「渠道」，旧文案「服务类型」保留兼容） */
export const selectProviderKind = async (page, nameRe) => {
  await page.getByRole('button', { name: /渠道|Channel|服务类型|Service type/ }).first().click()
  await page.getByRole('option', { name: nameRe }).first().click()
  await page.waitForTimeout(300)
}

/** 填写服务地址 */
export const fillBaseUrl = async (page, value) => {
  const input = page.getByLabel(/服务地址|Service URL/).first()
  await input.fill(value)
  await input.press('Enter')
  await page.waitForTimeout(200)
}

/** 填写模型 */
export const fillModel = async (page, value) => {
  const input = page.getByLabel(/^模型$|^Model$/).first()
  await input.fill(value)
  await input.press('Enter')
  await page.waitForTimeout(200)
}

/** 在输入框里发一条消息并点发送 */
export const sendChat = async (page, text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
}

/** 语音输入：点麦克风开始、再点结束，触发 ASR */
export const recordVoice = async (page) => {
  const mic = page.getByRole('button', { name: /语音输入|Voice input/ }).first()
  await mic.click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /结束录音并转写|Stop and transcribe/ }).first().click()
}
