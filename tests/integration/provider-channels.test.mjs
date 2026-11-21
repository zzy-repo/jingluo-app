// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1 分钟]
// 被测对象：标准构建的「渠道」下拉（1.4.0-beta.3）——四个渠道各自的输入项、请求地址与能力入口。
// 前置：自己起一份**标准构建**（默认 DIST_OUT=dist-standard）的静态服务，上游全部用 page.route 打桩。
//
//   cd /root/deepseek-app && DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   node tests/integration/provider-channels.test.mjs
//
// 断言（对应任务书验收 1~8、10）：
//   [1] 标准构建默认渠道 = DeepSeek 官方；只渲染 API Key 一行（无 baseUrl / model 输入元素）
//   [2] DeepSeek 官方：发消息 /anthropic/v1/messages + model deepseek-flash；搜索/图片/语音/思考入口都在，
//       **文档入口按能力门渲染为不可用**（acceptsDocuments('deepseek') === false，#538）
//   [3] Anthropic 协议：三件套（服务地址 / 模型 / API Key）；切过去后 Key 不丢；请求按填的值发出 /v1/messages；
//       图片入口在且可点（#548）、文档入口在且可点（#480）；搜索/语音不渲染
//   [4] OpenAI 兼容：三件套；请求打到 /v1/chat/completions；搜索/语音不渲染，
//       图片入口在且可点（#548）、文档入口在且可点（#480），思考入口恒常驻（#341，请求不带字段）
//   [5] 我们的渠道：**没有任何可编辑输入框**（#596：Key 只能由服务端下发，界面只读 + 「重新领取」），
//       界面不出现后端地址与内置模型名；本机已有服务端下发的那把时，请求头里带的正是那一把；
//       图片入口在且可点（#548）、文档入口在且可点（#480）；
//       请求打到 http://140.210.13.146:60010/v1/chat/completions（OpenAI 协议）+ model deepseek-v4.1-flash，
//       鉴权 Authorization: Bearer <key>（不带 x-api-key）；深度思考入口恒常驻（#341，请求不带字段）
//   [6] 切换渠道后能力入口随之显隐（搜不到 DOM 节点，不是置灰）；刷新后渠道选择持久化
//
// ⚠ 两个「附件入口」不是同一件事（#552 之后必须分清，见 `capNodes()` 的注释）：
//   - 图片入口（`data-testid="attach-image"`）：**随 #552 变更：三渠道支持图片** —— 四个渠道都有且可点；
//   - 文档入口（`data-testid="attach-document"`）：走 #480 的 `documents.textInjection`。
//     Anthropic / OpenAI / 我们的渠道 = 在且可点；DeepSeek = 在、但标着 `data-attachment-entry="unavailable"`
//     + `aria-disabled`（#538 的能力门）。这一条**没变**，别跟着图片入口一起放宽；也**不要**退回
//     「按 aria-label 前缀数能用的那个 picker」——那样数不出占位在不在，能力门就没人守了。
//   [7] 四个渠道的设置页都不出现能力描述文案（基础对话 / 不支持 / 已关闭 / 仅支持 / capability / 能力）
//   [8] console error = 0
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import { installTsResolve } from '../helpers/dom-env.mjs'
import { capturePaths, providerKindTrigger, selectProviderKind } from '../helpers/helpers.mjs'
import { inferenceBaseUrl } from '../../scripts/lib/endpoints.mjs'

// 页面里种「服务端下发标记」时要用**真的**指纹函数（不在这里重算一份 djb2）：
// 本仓的 `.js` 说明符指向 `.ts` 源码，裸 Node 解析不到，先装解析 hook 再动态 import。
installTsResolve()
const { keyFingerprint } = await import('../../src/services/invite/keyIdentity.ts')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT
let APP_URL = process.env.APP_URL || ''
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

const KEY = 'sk-channels-acceptance-key'
const BASE_A = 'https://relay.example.com'
const MODEL_A = 'claude-relay-model'
const BASE_O = 'https://oai.example.com'
const MODEL_O = 'gpt-relay-model'
// #812：推理地址 = 登录环境（consume.baseUrl），不再是另一份 chatBaseUrl
const OURS_HOST = inferenceBaseUrl
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
const cleanup = () => {
  try {
    served.kill()
  } catch {
    // 已关闭
  }
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

// 触发器按整串匹配（#368）：`/渠道/` 子串会命中「当前渠道不支持文件上传…」那个禁用按钮，
// 详见 tests/helpers/helpers.mjs 的 providerKindTrigger 注释。
const channelLabel = async (dialog) => (await providerKindTrigger(dialog).innerText()).trim()

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

/**
 * 我们的渠道的 Key 行（#596）：**结构上没有输入框**，只有「当前 Key ···尾号」+「重新领取」。
 *
 * 为什么数 input 而不是数 `disabled`：禁用的输入框能被 devtools 打开、能被脚本填值，
 * 「用户填不进来」只有在 DOM 上没有那个节点时才成立 —— 这条断言就是钉这个形态。
 */
const expectManagedKeyRow = async (dialog, where) => {
  const types = await visibleInputTypes(dialog)
  note(`${where} 输入框：${JSON.stringify(types)}`)
  if (types.length !== 0) {
    bad(`${where} 不该有任何可编辑输入框（#596 禁止手填 Key），实际：${JSON.stringify(types)}`)
  } else {
    ok(`${where} 没有任何可编辑输入框（Key 只能由服务端下发）`)
  }
  const row = await dialog.locator('[data-testid="settings-managed-key"]').count()
  const claim = await dialog.locator('[data-testid="settings-managed-key-claim"]').count()
  if (row !== 1 || claim !== 1) {
    bad(`${where} 缺只读行或「重新领取」按钮（row=${row}, claim=${claim}）`)
  } else {
    ok(`${where} 只读行 + 「重新领取」按钮在位`)
  }
  const text = await dialog.innerText()
  const masks = ['服务器繁忙', '未知错误'].filter((word) => text.includes(word))
  if (masks.length > 0) {
    bad(`${where} 出现掩盖性文案：${masks.join(' / ')}（#596 第 1 条事故就是被这类话骗的）`)
  } else {
    ok(`${where} 没有「服务器繁忙 / 未知错误」这类掩盖性文案`)
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

/**
 * 输入区那两个「附件」入口是**两件不同的事**（#586 的根因就在这一步没分清）：
 *
 *  - **图片入口** `[data-testid="attach-image"]`（#548 / #551）：带视觉能力的渠道都该有。
 *    它收的是图片 —— 三家 base64 渠道本地编码内联，deepseek 走 `files` 上传 + `file_id`；
 *  - **文档入口** `[data-testid="attach-document"]`（#480 / #538）：收的是 txt / docx / pdf，
 *    能不能用**只由 `acceptsDocuments(kind)` 决定**。能力门关掉时入口不是消失，而是渲染成
 *    带 `data-attachment-entry="unavailable"` 的解释按钮（看得见、点下去给原因，这是 #538 的口径）。
 *
 * 这两个入口以前在 DOM 里没有各自的稳定标识，只能靠 `aria-label` 里的中文去数
 * （图片入口 = 「上传文件」、文档入口 = 「添加文档（TXT / DOCX / PDF）」）。而「上传文件」这个
 * 可访问名挂在**图片入口**上 —— 于是按文案数出来的数永远是图片入口，却被按「附件入口」的口径
 * 写期望；#548 给三个渠道开了图片入口之后，那些旧期望必然红（#586）。
 *
 * 更弱的写法是「按文案前缀数出『能用的那个 picker』」（`aria-label^="添加文档"`）：那样数不出
 * DeepSeek 的禁用态占位到底是渲染了还是被删了，#538 的能力门在用例里就**没有守卫**了。
 * 所以这里改用产品侧给出的稳定标识，把两个入口分开、把「在不在」与「能不能用」分开断言。
 */
const ATTACH_IMAGE = '[data-testid="attach-image"]'
const ATTACH_IMAGE_READY = `${ATTACH_IMAGE}:not([aria-disabled="true"])`
const ATTACH_DOC = '[data-testid="attach-document"]'
const ATTACH_DOC_READY = `${ATTACH_DOC}:not([data-attachment-entry="unavailable"])`
const ATTACH_DOC_DISABLED = `${ATTACH_DOC}[data-attachment-entry="unavailable"]`

/** 聊天页某入口的 DOM 节点数（找不到 = 入口压根没渲染） */
const capNodes = async () => ({
  search: await page.locator('button[aria-label="智能搜索"]').count(),
  asr: await page.locator('button[aria-label="语音输入"]').count(),
  thinking: await page.locator('button[aria-label="深度思考"]').count(),
  image: await page.locator(ATTACH_IMAGE).count(),
  imageReady: await page.locator(ATTACH_IMAGE_READY).count(),
  document: await page.locator(ATTACH_DOC).count(),
  documentReady: await page.locator(ATTACH_DOC_READY).count(),
  documentDisabled: await page.locator(ATTACH_DOC_DISABLED).count(),
})

/**
 * 图片入口的三态期望：`ready`（在 + 可点）/ `absent`（DOM 里没有）。
 * 四个渠道都应该是 `ready`：这是 #548 的功能本身。
 */
const expectImageEntry = (where, want, nodes) => {
  if (want === 'ready') {
    if (nodes.image !== 1) {
      bad(`${where} 图片入口（attach-image）应有且仅有 1 个，实际 ${nodes.image} 个`)
    } else if (nodes.imageReady !== 1) {
      bad(`${where} 图片入口存在但不可点（aria-disabled=true，实际可点 ${nodes.imageReady} 个）`)
    } else {
      ok(`${where} 图片入口存在且可点（attach-image ×1，#548 的三渠道图片通路）`)
    }
    return
  }
  if (nodes.image !== 0) {
    bad(`${where} 仍然渲染了图片入口（期望 DOM 里没有，实际 ${nodes.image} 个）`)
  } else {
    ok(`${where} 图片入口不存在（DOM 里没有节点）`)
  }
}

/**
 * 文档入口的三态期望：
 *  - `ready`：`acceptsDocuments(kind)` 为真 → 入口在且可点；
 *  - `disabled`：能力门关掉（今天只有 deepseek）→ 入口**仍在**，但明确标成不可用
 *    （`data-attachment-entry="unavailable"` + `aria-disabled="true"`），点下去给原因而不是静默；
 *  - `absent`：DOM 里没有。
 */
const expectDocumentEntry = (where, want, nodes) => {
  if (want === 'ready') {
    if (nodes.documentReady !== 1) {
      bad(
        `${where} 文档入口应存在且可点（attach-document 可点 ${nodes.documentReady} 个 / 总数 ${nodes.document} 个）`
      )
    } else if (nodes.documentDisabled !== 0) {
      bad(`${where} 文档入口同时出现了「不可用」标记，能力表自相矛盾`)
    } else {
      ok(`${where} 文档入口存在且可点（attach-document ×1，acceptsDocuments=true）`)
    }
    return
  }
  if (want === 'disabled') {
    if (nodes.document !== 1) {
      bad(`${where} 文档入口应渲染 1 个「不可用」解释按钮，实际 ${nodes.document} 个`)
    } else if (nodes.documentDisabled !== 1 || nodes.documentReady !== 0) {
      bad(
        `${where} 文档入口没有标成不可用（unavailable=${nodes.documentDisabled}、ready=${nodes.documentReady}）`
      )
    } else {
      ok(`${where} 文档入口按能力门渲染为不可用（acceptsDocuments=false，点下去给原因）`)
    }
    return
  }
  if (nodes.document !== 0) {
    bad(`${where} 仍然渲染了文档入口（期望 DOM 里没有，实际 ${nodes.document} 个）`)
  } else {
    ok(`${where} 文档入口不存在（DOM 里没有节点）`)
  }
}

const expectCaps = async (where, expected) => {
  const nodes = await capNodes()
  note(`${where} 入口节点数：${JSON.stringify(nodes)}`)
  for (const name of ['search', 'asr', 'thinking']) {
    if (!(name in expected)) {
      continue
    }
    const got = nodes[name]
    const want = expected[name]
    const label = { search: '智能搜索', asr: '语音输入', thinking: '深度思考' }[name]
    if (want && got === 0) {
      bad(`${where} 缺少「${label}」入口`)
    } else if (!want && got !== 0) {
      bad(`${where} 仍然渲染了「${label}」入口（期望 DOM 里没有，实际 ${got} 个）`)
    } else {
      ok(`${where} ${label}入口${want ? '存在' : '不存在（DOM 里没有节点）'}`)
    }
  }
  expectImageEntry(where, expected.image, nodes)
  expectDocumentEntry(where, expected.document, nodes)
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
  // 端口自动发现（PORT 可注入）：固定 5293 会撞到 diagnostics 或遗留服务 → 假红
  const served = await serveDir(DIST, { port: PORT, label: '标准产物 dist-standard' })
  APP_URL = APP_URL || served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

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
  // #339：模型不可编辑，但必须看得见 —— 只读行（不是 input，所以上面的输入框计数仍是 1）
  const builtInModel = await dialog.getByText(/^deepseek-flash$/).count()
  if (builtInModel < 1) {
    bad('DeepSeek 官方渠道没有露出内置模型（#339：至少要让用户知道当前用的是哪个模型）')
  } else {
    ok('DeepSeek 官方渠道展示只读模型 deepseek-flash')
  }
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
  // 随 #552 变更：三渠道支持图片。DeepSeek 的文档能力（#538）没变 —— 它不吃文档，
  // 所以文档入口仍是禁用态占位，`docs`（可用的文档 picker）在这里必须为 0。
  await expectCaps('DeepSeek 官方', {
    search: true,
    // 图片：deepseek 一直走 `files` 上传 + `file_id`（#551 的零改动边界，入口照旧可用）
    image: 'ready',
    // 文档：`acceptsDocuments('deepseek') === false`（#538 的能力门，本 PR 换过写法后仍是 false）→
    // 入口不会消失，而是渲染成带 `data-attachment-entry="unavailable"` 的解释按钮。
    // 这条断言就是「能力门没有被削弱」的 DOM 侧守卫：占位**必须在**、必须标着不可用。
    document: 'disabled',
    asr: true,
    thinking: true,
  })
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
  // 随 #552 变更：三渠道支持图片 —— `vision`（纸夹「上传文件」）现在有节点且可用，
  // 旧断言 vision:false 是 #552 之前的现实。`docs` 仍为 true：#480 起 Anthropic 走
  // `documents.textInjection`，文档入口一直是那个能吃 TXT/DOCX/PDF 的 picker（这一次没动）。
  await expectCaps('Anthropic 协议', {
    search: false,
    // #548 给三家开了图片入口（base64 内联），#480/#538 的文档入口照旧可用
    image: 'ready',
    document: 'ready',
    asr: false,
    thinking: true,
  })
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
  // 随 #552 变更：三渠道支持图片（`vision: true`）；文档仍是文本注入（`docs: true`，未改）。
  await expectCaps('OpenAI 兼容', {
    search: false,
    image: 'ready',
    document: 'ready',
    asr: false,
    thinking: true,
  })
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
  // 清掉 Key 再看形态（#596：不管有没有 Key，这一行都不该有输入框）
  await page.evaluate(() => {
    window.localStorage.removeItem('chat-demo:api-key')
    window.localStorage.removeItem('chat-demo:ours-server-key')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  dialog = await openSettings()
  const oursLabel = await channelLabel(dialog)
  if (!/我们的渠道|Our Channel/.test(oursLabel)) {
    bad(`刷新后渠道选择没保住：${JSON.stringify(oursLabel)}`)
  } else {
    ok(`刷新后渠道仍是 ${oursLabel}（渠道选择持久化）`)
  }
  // #596：没有 Key 时也**没有输入框**（不是 disabled 的输入框），只有「重新领取」
  await expectManagedKeyRow(dialog, '我们的渠道（未领取）')
  const unclaimedText = await dialog.innerText()
  if (!/尚未领取 Key|No key claimed yet/.test(unclaimedText)) {
    bad('未领取时只读行没有说清「尚未领取」')
  } else {
    ok('未领取时只读行显示「尚未领取 Key」')
  }
  await shot('channel-ours-unclaimed')
  const oursText = await dialog.innerText()
  // 内置地址的主机与端口取自 config/endpoints.json（#274），不在这里另抄一份
  for (const secret of [new URL(OURS_HOST).hostname, new URL(OURS_HOST).port, OURS_MODEL]) {
    if (oursText.includes(secret)) {
      bad(`我们的渠道把内置值露在界面上了：${secret}`)
    } else {
      ok(`我们的渠道界面不展示 ${secret}`)
    }
  }
  await expectNoCapabilityCopy(dialog, '我们的渠道')
  // 本机已有「服务端下发的那把」时：只读行显示尾号，请求头里带的也必须是这一把。
  // 这里直接把领取结果写进本地（与 `applyManagedKey` 的落盘形态一致：Key + 下发标记），
  // 不走网络 —— 领取链路本身在 `tests/unit/managed-key-596.test.mjs` 里按接口逐格验过。
  const oursMark = {
    fingerprint: keyFingerprint(KEY),
    tail: KEY.slice(-4),
    at: Date.now(),
    id: 1,
  }
  await page.evaluate(
    ([key, mark]) => {
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', JSON.stringify(mark))
    },
    [KEY, oursMark]
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  dialog = await openSettings()
  await expectManagedKeyRow(dialog, '我们的渠道（已领取）')
  const claimedText = await dialog.innerText()
  if (!claimedText.includes(`···${KEY.slice(-4)}`)) {
    bad(`只读行没有显示服务端那把的尾号 ···${KEY.slice(-4)}`)
  } else {
    ok(`只读行显示当前 Key 尾号 ···${KEY.slice(-4)}`)
  }
  await shot('channel-ours')
  await closeSettings(dialog)
  // 随 #552 变更：三渠道支持图片（`vision: true`）；文档仍是文本注入（`docs: true`，未改）。
  await expectCaps('我们的渠道', {
    search: false,
    image: 'ready',
    document: 'ready',
    asr: false,
    thinking: true,
  })
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
      ok('我们的渠道 Authorization = Bearer <服务端下发的那把>')
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
process.exit(0)
