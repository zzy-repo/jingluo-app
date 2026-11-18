// [layer: integration | 依赖: playwright + chromium + 本地静态服务（上游用 page.route 打桩） | 耗时: ~1 分钟] 说明见 tests/README.md
// 1.4.0-beta.3 内测版验收（自建、可自动化，不依赖真实上游）：
//
//   cd /root/deepseek-app && DIST_DIR=$PWD/dist PORT=5291 node tests/integration/internal-build.test.mjs
//
// 被测页面是**内测构建**（INTERNAL_BUILD=1）：默认渠道是「我们的渠道」（ours），
// 地址 http://62.106.70.167:60010 与模型 deepseek-v4.1-flash 内置在 providers.ts 的
// ours spec 里，设置页只渲染 API Key 一行；用户仍可在「渠道」下拉里切到另外三个渠道。
//
// 前置：无。内置上游的请求由 Playwright 的 page.route 拦截（不需要 ip addr add，
// 也不会和本机其它占着 60010 的 mock 抢端口）；断言直接看浏览器实际发出的 URL / 头 / 请求体。
//
// 断言：
//   [A] 设置页有「渠道」下拉，默认值是「我们的渠道」，共 4 个选项
//   [B] ours 渠道只渲染 API Key（type=password）一个输入框；没有 baseUrl / model 输入元素，
//       页面文本里也没有后端地址与内置模型名（用户不该看到后端地址）
//   [C] 发消息请求 URL === http://62.106.70.167:60010/v1/chat/completions（OpenAI 协议），
//       body.model === deepseek-v4.1-flash，鉴权 Authorization: Bearer（不带 x-api-key）
//   [D] 请求体不含 safety_check / title / tools，messages 里没有 role:'latest_reminder'
//   [E] 内置项不落 localStorage（只写 chat-demo:api-key）
//   [F] 切换渠道：Key 不丢、DeepSeek 官方渠道同样只有 API Key 一行、渠道选择落盘
//   [G] 刷新后渠道选择仍是「我们的渠道」
//   [H] 设置页文案不含能力描述（基础对话 / 不支持 / 已关闭 / 仅支持 / capability / 能力）
//   [I] console error = 0
//   [J] 截图：ours 设置页 + 发消息后的 mock 回复
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { capturePaths, selectProviderKind } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const PORT = process.env.PORT || '5291'
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}`
const API_URL = 'http://62.106.70.167:60010'
const MESSAGES_URL = `${API_URL}/v1/chat/completions`
const MODEL = 'deepseek-v4.1-flash'
const KEY = 'sk-internal-acceptance-key'
const REPLY = '内测版验收回复：内置渠道已生效。'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')
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

const children = []
const start = (command, args) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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

// ---------- 0) 起静态服务（内测构建） ----------
start('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIST])
await new Promise((resolve) => setTimeout(resolve, 800))

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

/** 内置上游（ours 渠道）：拦截并回 OpenAI 形状 SSE（chat.completion.chunk），断言看浏览器实际发出的请求 */
await page.route(`${API_URL}/**`, async (route) => {
  if (route.request().url().includes('/models')) {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: MODEL, type: 'model' }] }),
    })
    return
  }
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: [
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }],
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
  })
})

const requests = capturePaths(page)

const shot = async (name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `1.4.0-beta.3-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  note(`截图 ${path.relative(ROOT, file)}`)
}

const openSettings = async () => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(400)
  return page.getByRole('dialog').first()
}

/** 页面文本里出现能力描述就算失败 */
const expectNoCapabilityCopy = async (dialog, where) => {
  const text = await dialog.innerText()
  const hits = FORBIDDEN_WORDS.filter((word) => text.includes(word))
  if (hits.length > 0) {
    bad(`${where} 出现了能力描述文案：${hits.join(' / ')}`)
  } else {
    ok(`${where} 没有能力描述文案`)
  }
}

/** 内置地址/模型（deepseek / ours）只露 API Key：没有 url/model 输入元素 */
const expectOnlyApiKeyInputs = async (dialog, where, keySaved = false) => {
  const types = await dialog
    .locator('input')
    .evaluateAll((list) => list.map((item) => item.type))
  note(`${where} 输入框：${JSON.stringify(types)}`)
  const urlInputs = await dialog.locator('input[inputmode="url"]').count()
  const modelInputs = await dialog.getByLabel(/^模型$|^Model$/).count()
  const passwordInputs = await dialog.locator('input[type="password"]').count()
  if (urlInputs > 0) {
    bad(`${where} 仍然渲染了服务地址输入框`)
  } else {
    ok(`${where} 没有服务地址输入框`)
  }
  if (modelInputs > 0) {
    bad(`${where} 仍然渲染了模型输入框`)
  } else {
    ok(`${where} 没有模型输入框`)
  }
  // type=file 是「导入历史 / 聊天背景」用的隐藏选择器，不是配置入口
  const extra = types.filter((type) => type !== 'password' && type !== 'file')
  if (extra.length > 0) {
    bad(`${where} 还有其他可编辑输入框：${JSON.stringify(types)}`)
  } else if (keySaved) {
    // Key 已保存时那一行是掩码（不是输入框）：这里只允许 0 个输入框 + 星号掩码
    const masked = /\*{6,}/.test(await dialog.innerText())
    if (passwordInputs !== 0 || !masked) {
      bad(`${where} 已保存的 Key 没按掩码显示（输入框=${passwordInputs}，掩码=${masked}）`)
    } else {
      ok(`${where} 唯一一行是 API Key（已保存，显示为掩码，没有输入框）`)
    }
  } else if (passwordInputs !== 1) {
    bad(`${where} API Key 输入框数量异常：${passwordInputs}（期望 1）`)
  } else {
    ok(`${where} 唯一可编辑输入框是 API Key（type=password）`)
  }
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  // ---------- [A][B][H] 设置页：渠道下拉 + ours 只露 API Key ----------
  console.log('\n[A][B][H] 设置页 DOM')
  let dialog = await openSettings()

  const channelButton = dialog.getByRole('button', { name: /渠道|Channel/ }).first()
  if ((await channelButton.count()) === 0) {
    bad('设置页没有「渠道」下拉')
  } else {
    const label = (await channelButton.innerText()).trim()
    if (!/我们的渠道|Our Channel/.test(label)) {
      bad(`内测构建默认渠道不是「我们的渠道」：${JSON.stringify(label)}`)
    } else {
      ok(`默认渠道 = ${label}（内测构建 → ours）`)
    }
    await channelButton.click()
    const options = await page.getByRole('option').evaluateAll((list) =>
      list.map((item) => item.innerText.trim())
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const expected = ['DeepSeek 官方', 'Anthropic 协议', 'OpenAI 兼容', '我们的渠道']
    note(`渠道选项：${options.join(' / ')}`)
    if (options.length !== 4) {
      bad(`渠道下拉选项数不是 4：${options.length}`)
    } else if (expected.some((name, index) => !options[index].includes(name))) {
      bad(`渠道选项名/顺序不对：${JSON.stringify(options)}`)
    } else {
      ok('渠道下拉 4 个选项（DeepSeek 官方 / Anthropic 协议 / OpenAI 兼容 / 我们的渠道）')
    }
  }

  await expectOnlyApiKeyInputs(dialog, 'ours 渠道')

  // 后端地址与内置模型名不出现在界面上（用户不该看到后端地址）
  const dialogText = await dialog.innerText()
  for (const secret of ['62.106.70.167', '60010', MODEL]) {
    if (dialogText.includes(secret)) {
      bad(`ours 渠道把内置值露在界面上了：${secret}`)
    } else {
      ok(`ours 渠道界面不展示 ${secret}`)
    }
  }
  await expectNoCapabilityCopy(dialog, 'ours 渠道设置页')
  await shot('channel-ours')

  // 通用分组仍无位置信息项（历史契约不回退）
  await page.getByRole('tab', { name: /通用|General/ }).first().click()
  await page.waitForTimeout(300)
  const generalText = await dialog.innerText()
  const locationHits = [/位置信息/, /所在地/, /省份/, /^Location$/m, /Province/].filter((re) =>
    re.test(generalText)
  )
  if (locationHits.length > 0) {
    bad(`通用设置里仍有位置信息相关文案：${locationHits.map(String).join(' / ')}`)
  } else {
    ok('通用设置里没有位置信息项')
  }

  // ---------- [E] 保存 API Key ----------
  console.log('\n[E] 保存 API Key + localStorage')
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(300)
  await page.locator('input[type="password"]').first().fill(KEY)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(1200)

  const readStorage = () =>
    page.evaluate(() => {
      const out = {}
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i)
        out[key] = window.localStorage.getItem(key)
      }
      return out
    })

  const stored = await readStorage()
  note(`localStorage: ${JSON.stringify(stored)}`)
  if (stored['chat-demo:api-key'] !== KEY) {
    bad('API Key 没有写入 localStorage')
  } else {
    ok('API Key 已保存')
  }
  const forbiddenKeys = ['chat-demo:base-url', 'chat-demo:model', 'chat-demo:provider-kind']
  const leaked = forbiddenKeys.filter((key) => Object.hasOwn(stored, key))
  if (leaked.length > 0) {
    bad(`内置项被写进了 localStorage：${leaked.map((key) => `${key}=${stored[key]}`).join(', ')}`)
  } else {
    ok('地址 / 模型 / 渠道（未切换时）没有落 localStorage')
  }

  // ---------- [F] 切换渠道：Key 不丢，DeepSeek 官方同样只有 API Key ----------
  console.log('\n[F] 切换渠道')
  await selectProviderKind(page, /DeepSeek 官方|DeepSeek Official/)
  dialog = page.getByRole('dialog').first()
  await expectOnlyApiKeyInputs(dialog, 'DeepSeek 官方渠道', true)
  const keyAfterSwitch = (await readStorage())['chat-demo:api-key']
  if (keyAfterSwitch !== KEY) {
    bad('切换渠道后 API Key 丢了（应当共用一把）')
  } else {
    ok('切换渠道后 API Key 仍在（共用一把，不丢）')
  }
  const kindAfterSwitch = (await readStorage())['chat-demo:provider-kind']
  if (kindAfterSwitch !== 'deepseek') {
    bad(`渠道选择没有落盘：${JSON.stringify(kindAfterSwitch)}`)
  } else {
    ok('渠道选择已持久化（chat-demo:provider-kind=deepseek）')
  }
  // 回到我们的渠道再发消息
  await selectProviderKind(page, /我们的渠道|Our Channel/)

  // 关掉设置
  await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(400)

  // ---------- [C][D] 发消息 ----------
  console.log('\n[C][D] 发消息：URL / model / 请求体')
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('你好，内测版')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()

  await page.getByText(REPLY.slice(0, 10)).first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1200)
  ok('打桩上游的回复已渲染到消息列表')
  await shot('reply')

  const posts = requests.filter(
    (request) =>
      request.method === 'POST' && new URL(request.url).pathname === '/v1/chat/completions'
  )
  note(
    `浏览器发出的请求：${requests.map((request) => `${request.method} ${request.url}`).join(' , ') || '（无）'}`
  )

  if (posts.length === 0) {
    bad(`没有发出发消息请求（期望 ${MESSAGES_URL}）`)
  } else {
    const hit = posts[0]
    const hitHeaders = hit.headers
    if (hit.url !== MESSAGES_URL) {
      bad(`发消息 URL 不是内置地址：${hit.url}`)
    } else {
      ok(`发消息 URL = ${hit.url}`)
    }
    let body = {}
    try {
      body = JSON.parse(hit.postData ?? '{}')
    } catch {
      bad('请求体不是 JSON')
    }
    if (body.model !== MODEL) {
      bad(`body.model 不是内置模型：${JSON.stringify(body.model)}`)
    } else {
      ok(`body.model = ${body.model}`)
    }
    if (hitHeaders.authorization !== `Bearer ${KEY}`) {
      bad(`Authorization 头不对：${JSON.stringify(hitHeaders.authorization)}`)
    } else {
      ok('Authorization = Bearer <用户填的 key>')
    }
    if (hitHeaders['x-api-key']) {
      bad(`不该再带 x-api-key：${JSON.stringify(hitHeaders['x-api-key'])}`)
    } else {
      ok('未带 x-api-key（OpenAI 协议只用 Bearer）')
    }
    if (hitHeaders['anthropic-version']) {
      bad(`不该带 anthropic-version（中转 CORS 预检会失败）：${hitHeaders['anthropic-version']}`)
    } else {
      ok('未带 anthropic-version')
    }

    const topLevel = Object.keys(body)
    note(`请求体顶层字段 = ${JSON.stringify(topLevel)}`)
    for (const field of ['safety_check', 'title', 'tools']) {
      if (Object.hasOwn(body, field)) {
        bad(`请求体仍带 ${field}`)
      } else {
        ok(`已剥离 ${field}`)
      }
    }
    const roles = (body.messages ?? []).map((message) => message.role)
    if (roles.includes('latest_reminder')) {
      bad("请求体 messages 里仍有 role:'latest_reminder'")
    } else {
      ok("messages 里没有 role:'latest_reminder'")
    }
    // OpenAI 协议：system 提示词在 messages 头部的 {role:'system'} 行（body.system 不再存在）
    const systemRow = (body.messages ?? []).find((message) => message.role === 'system')
    const system = String(systemRow?.content ?? '')
    if (!system.includes('Web')) {
      bad(`提醒内容没有折进 system：${JSON.stringify(system)}`)
    } else if (/,,\s/.test(system)) {
      bad(`system 里出现空段：${JSON.stringify(system)}`)
    } else {
      ok(`提醒内容已折进 system，无空段（${system.length} 字符）`)
    }
  }

  // ---------- [G] 刷新后渠道选择持久化 ----------
  console.log('\n[G] 刷新后渠道选择')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  dialog = await openSettings()
  const reloadedLabel = (
    await dialog.getByRole('button', { name: /渠道|Channel/ }).first().innerText()
  ).trim()
  if (!/我们的渠道|Our Channel/.test(reloadedLabel)) {
    bad(`刷新后渠道选择没保住：${JSON.stringify(reloadedLabel)}`)
  } else {
    ok(`刷新后渠道仍是 ${reloadedLabel}`)
  }

  // ---------- [I] console error ----------
  console.log('\n[I] console error')
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

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/internal-build.test.mjs`)
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
