// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// ============================================================================
// ⚠️ 历史遗留的巨型套件（36KB / 约 860 行，别再长）
//
// 这是 1.3.0 时期「一次性验收」的合集：8 组断言挤在一个文件里，跑法靠文件头注释。为了
// 保留既有覆盖没有重写，但**新测试一律拆小**（单个用例一个文件、不超过 500 行，放
// integration/ 下按被测对象命名），不要往这个文件里加东西。
// 需要哪组就抄出去做独立文件，然后从这里删掉对应段落。
// 约定见 tests/README.md「写新测试的约定」。
// ============================================================================
// 1.3.0 一次性验收脚本：本地标准库 mock 上游（不依赖任何外网），覆盖 8 组断言。
//
//   cd /root/deepseek-app && APP_URL=http://127.0.0.1:5181 node tests/integration/full-acceptance.test.mjs
//
// 1. openai 模式：POST 打到 /v1/chat/completions，header 为 Authorization: Bearer <key>
// 2. openai 请求体转换：system 进 messages 头部，无 safety_check/title/tools
// 3. 翻译器单测（不启浏览器，子进程直接 import 适配器）：构造 SSE → 严格事件序列
// 4. 翻译器脏数据用例：空 choices / 无 [DONE] 断流 / `: ping` 注释行 → 不抛错、不卡死、正常结束
// 5. 端到端：openai mock SSE → 文本逐字渲染、结束状态正常
// 6. openai 模式能力降级：四个入口 count=0；切回 deepseek 恢复
// 7. 回归：deepseek（三路径+四私有字段）与 anthropic（/v1/*、字段剥离、能力降级、HTML 上游）仍全绿
// 8. console error = 0
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { defaultDist, verifyAppUrl } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate, providerKindTrigger } from '../helpers/helpers.mjs'

// 证据目录：原来写死 /root/deepseek-app/...（Linux 一次性机器），在任何别的机器上都 ENOENT
// → 整条用例「用例异常」，属于环境假红。改成相对仓库根解析。
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')
const ACCEPT_DIR = path.join(ROOT, 'docs', 'acceptance')
mkdirSync(SHOT_DIR, { recursive: true })
mkdirSync(ACCEPT_DIR, { recursive: true })

const APP_URL = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '5181'}`
// 环境守卫：端口撞车 / 产物陈旧 → SKIP(env)，不产生假红（Issue #19）
await verifyAppUrl(APP_URL, defaultDist(), { variant: 'standard' })
const KEY = 'sk-acceptance-key'
const DEEPSEEK_MODEL = 'deepseek-flash'
const ANTHROPIC_MODEL = 'deepseek-v4.1-flash'
const OPENAI_MODEL = 'gpt-4o-mini'
// 与上面两组回答刻意不同：同一会话历史里已有 REPLY_TEXT，混用会让「是否渲染」判断失真
const OPENAI_REPLY_TEXT = 'OpenAI 兼容回答，逐字流出。'
const REPLY_TEXT = '验收测试回答，逐字流出。'
const TITLE = '验收标题'
const FILE_ID = 'file-api-accept-0001'

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

/** 标准 Anthropic SSE（正文逐块下发；有 title.enabled 时在 message_delta 里给标题） */
const sseBody = (text, withTitle) => {
  const chunks = [
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_accept","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
  ]
  // 拆成三块，验证增量拼接
  for (const piece of [text.slice(0, 5), text.slice(5, 10), text.slice(10)]) {
    chunks.push(
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(piece)}}}`,
      ''
    )
  }
  chunks.push(
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null${withTitle ? `,"title":${JSON.stringify(TITLE)}` : ''}},"usage":{"output_tokens":9}}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  )
  return chunks.join('\n')
}

/**
 * OpenAI 兼容 SSE：正文分三片、片间留 500ms，用来验证「逐字渲染」；
 * 夹杂 `: ping` 注释行与只带 usage 的收尾 chunk（choices 为空），顺便验证真实形态。
 */
const openaiChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const openaiSsePieces = (text) => [text.slice(0, 5), text.slice(5, 10), text.slice(10)]
const writeOpenAIStream = async (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(': ping\n\n')
  res.write(
    openaiChunk({
      id: 'chatcmpl-accept',
      object: 'chat.completion.chunk',
      model: OPENAI_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })
  )
  for (const piece of openaiSsePieces(text)) {
    res.write(openaiChunk({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  res.write(': ping\n\n')
  // 真实 OpenAI 在 finish_reason 之后还会来一条 choices 为空的 usage 收尾 chunk
  res.write(
    openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  )
  res.write(openaiChunk({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } }))
  res.write('data: [DONE]\n\n')
  res.end()
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  // authorization 是 openai 模式的鉴权头，预检不放行浏览器会直接拦下
  'access-control-allow-headers':
    'content-type,authorization,x-api-key,anthropic-version,anthropic-beta,accept,accept-encoding,x-session-id',
}

/** 极简 mock 上游：html=true 时所有 POST messages 都返回网页（模拟路径打错/网关报错页） */
const startMock = ({ html = false } = {}) =>
  new Promise((resolve) => {
    const log = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        const { pathname } = new URL(req.url, 'http://mock')
        log.push({ method: req.method, path: pathname, headers: req.headers, body: raw })
        for (const [name, value] of Object.entries(CORS)) {
          res.setHeader(name, value)
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
        const json = (value) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(value))
        }
        if (pathname === '/models' || pathname === '/v1/models') {
          return json({ data: [{ id: DEEPSEEK_MODEL }, { id: ANTHROPIC_MODEL }] })
        }
        // 附件挂在 messages 前缀下：/anthropic/v1/messages/files、/v1/messages/files
        if (pathname.endsWith('/files')) {
          return json({
            id: FILE_ID,
            type: 'file',
            size_bytes: raw.length,
            created_at: '2026-11-17T00:00:00Z',
            filename: 'acceptance.txt',
            mime_type: 'text/plain',
          })
        }
        // openai：POST /v1/chat/completions，返回 OpenAI 格式 SSE
        if (pathname === '/v1/chat/completions') {
          if (html) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><html><body>MOCK_GATEWAY_HTML</body></html>')
            return
          }
          void writeOpenAIStream(res, OPENAI_REPLY_TEXT)
          return
        }
        if (pathname === '/v1/tools/asr') {
          return json({ text: '语音内容' })
        }
        if (pathname === '/anthropic/v1/messages' || pathname === '/v1/messages') {
          if (html) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><html><body>MOCK_GATEWAY_HTML</body></html>')
            return
          }
          let withTitle = false
          try {
            withTitle = Boolean(JSON.parse(raw).title?.enabled)
          } catch {
            withTitle = false
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(sseBody(REPLY_TEXT, withTitle))
          res.end()
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock 没有实现 ${pathname}` } }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })
    })
  })

const posts = (log, path) => log.filter((entry) => entry.method === 'POST' && entry.path === path)
const jsonBody = (entry) => {
  try {
    return JSON.parse(entry.body)
  } catch {
    return {}
  }
}

const mockOk = await startMock()

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
})
const page = await context.newPage()
/**
 * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
 * 白名单两项，都是精确 host:port：被测产物自身的 origin + 本用例**真起的**本机 mock 上游
 * （`startMock()` 的 `127.0.0.1:<随机端口>`，「零外网」的被测输入就是它）。
 */
await installEgressGate(page, {
  appUrl: APP_URL,
  allowHosts: [new URL(APP_URL).host, new URL(mockOk.base).host],
})
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}

const seed = async ({ kind, baseUrl, model }) => {
  await page.evaluate(
    ({ kind, baseUrl, model, key }) => {
      window.localStorage.clear()
      if (kind) {
        window.localStorage.setItem('chat-demo:provider-kind', kind)
      }
      window.localStorage.setItem('chat-demo:base-url', baseUrl)
      window.localStorage.setItem('chat-demo:model', model)
      window.localStorage.setItem('chat-demo:api-key', key)
    },
    { kind, baseUrl, model, key: KEY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
}

const openSettings = async () => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(250)
}
const closeSettings = async () => {
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(300)
  }
}
const selectKind = async (nameRe) => {
  // 选择器必须落在设置弹窗里、且是**渠道行**本身：`/渠道|Channel/` 这类宽松名字会命中附件入口
  // 按钮的 aria-label（「当前渠道不支持文件上传，附件入口已不可用」），点它必超时（#406 复核）。
  // #555：文案换成「当前渠道不支持文档附件…」之后同一个坑又出现过一次，所以选择器不再本地重写，
  // 一律走 helpers.mjs 的 `providerKindTrigger`（整串锚定，是同一个判定口）。
  await providerKindTrigger(page.getByRole('dialog').first()).first().click()
  await page.getByRole('option', { name: nameRe }).first().click()
  await page.waitForTimeout(250)
}
const setField = async (labelRe, value) => {
  const input = page.getByLabel(labelRe).first()
  await input.fill(value)
  await input.press('Enter')
  await page.waitForTimeout(150)
}
const send = async (text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  const button = page.getByRole('button', { name: /^发送$|^Send$/ }).first()
  // 附件还在上传时发送按钮是 disabled：等它就绪再点
  const ready = await waitFor(async () => (await button.getAttribute('aria-disabled')) !== 'true')
  if (!ready) {
    throw new Error(`发送按钮一直不可用（草稿未就绪）：${text}`)
  }
  await button.click()
}
/** 可见且未置灰 */
const usable = async (nameRe) => {
  const button = page.getByRole('button', { name: nameRe })
  if ((await button.count()) === 0) {
    return false
  }
  const first = button.first()
  if (!(await first.isVisible())) {
    return false
  }
  return !((await first.getAttribute('aria-disabled')) === 'true' || (await first.isDisabled()))
}
const gone = async (nameRe) => !(await usable(nameRe))

/**
 * 输入区那两个「附件」入口是**两件不同的事**（#586 的根因就在这一步没分清）：
 *
 *  - **图片入口** `[data-testid="attach-image"]`（#548 / #551 / #552）：带视觉能力的渠道都该有。
 *    三家 base64 渠道本地编码内联，deepseek 走 `files` 上传 + `file_id`；
 *  - **文档入口** `[data-testid="attach-document"]`（#480 / #538）：收 txt / docx / pdf，
 *    能不能用**只由 `acceptsDocuments(kind)` 决定**；能力门关掉时它不是消失，而是渲染成
 *    `data-attachment-entry="unavailable"` 的解释按钮（看得见、点下去给原因）。
 *
 * 以前两处都靠 `aria-label` 的中文去认，而「上传文件」这个可访问名挂在**图片入口**上 ——
 * `usable(/^上传文件$/)`、`getByRole('button', {name: '上传文件'})` 数的一直是图片入口，
 * 却按「附件入口」的旧口径写期望。#548 把图片入口开给三个渠道之后那些断言必然红（#586）。
 * 按文案前缀（`^添加文档`）数「能用的那个 picker」也不够：那样数不出 DeepSeek 的禁用态占位
 * 在不在，#538 的能力门在用例里就没人守了（#596 把这条升回精确断言）。
 */
const ATTACH_IMAGE = '[data-testid="attach-image"]'
const ATTACH_DOC = '[data-testid="attach-document"]'

/** 一个入口的客观事实：在不在、看不看得见、有没有被标成不可用 */
const entryFacts = async (selector) => {
  const locator = page.locator(selector)
  const count = await locator.count()
  if (count === 0) {
    return { count, visible: false, ariaDisabled: null, unavailableMarker: null }
  }
  const first = locator.first()
  return {
    count,
    visible: await first.isVisible(),
    ariaDisabled: await first.getAttribute('aria-disabled'),
    unavailableMarker: await first.getAttribute('data-attachment-entry'),
  }
}

/**
 * 三态口径：`ready`（在且可点）/ `disabled`（在、但明确不可用）/ `absent`（DOM 里没有）。
 * 图片入口只有 `ready` / `absent`：它不可用时是「点下去给提示」的真实入口，
 * 没有「只剩解释」这一态（那是文档入口被能力门关掉时的形态）。
 */
const expectAttachEntries = async (where, want) => {
  const image = await entryFacts(ATTACH_IMAGE)
  const doc = await entryFacts(ATTACH_DOC)
  note(`${where} 附件入口：${JSON.stringify({ image, document: doc })}`)

  if (want.image === 'ready') {
    if (image.count === 1 && image.ariaDisabled !== 'true') {
      ok(`${where}) 图片入口在且可点（attach-image ×1，#548）`)
    } else {
      bad(
        `${where}) 图片入口应存在且可点，实际 count=${image.count} aria-disabled=${image.ariaDisabled}`
      )
    }
  } else if (image.count !== 0) {
    bad(`${where}) 图片入口应完全隐藏，实际 count=${image.count}`)
  } else {
    ok(`${where}) 图片入口不存在（DOM 里没有节点）`)
  }

  if (want.document === 'ready') {
    if (doc.count === 1 && doc.unavailableMarker === null && doc.ariaDisabled !== 'true') {
      ok(`${where}) 文档入口在且可点（attach-document ×1，acceptsDocuments=true）`)
    } else {
      bad(
        `${where}) 文档入口应存在且可点，实际 count=${doc.count} marker=${doc.unavailableMarker} aria-disabled=${doc.ariaDisabled}`
      )
    }
  } else if (want.document === 'disabled') {
    if (doc.count === 1 && doc.unavailableMarker === 'unavailable' && doc.ariaDisabled === 'true') {
      ok(`${where}) 文档入口按能力门渲染为不可用（acceptsDocuments=false，点下去给原因）`)
    } else {
      bad(
        `${where}) 文档入口应保留「不可用」解释按钮，实际 count=${doc.count} marker=${doc.unavailableMarker} aria-disabled=${doc.ariaDisabled}`
      )
    }
  } else if (doc.count !== 0) {
    bad(`${where}) 文档入口应完全隐藏，实际 count=${doc.count}`)
  } else {
    ok(`${where}) 文档入口不存在（DOM 里没有节点）`)
  }
}

try {
  // ============ 3/4. 翻译器单测：直接 import 适配器，不启浏览器 ============
  console.log('\n[3] 翻译器单测（OpenAI SSE → Anthropic 事件流）')
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  let translatorOut = ''
  // 子进程必须带 run-layer 那份 --import 预加载（tests/helpers/injected.mjs）：`__ENDPOINTS__` 是
  // rspack DefinePlugin 的打包期标识符，裸 node 直接 import 源码时没有它 → 一进来就
  // `ReferenceError: __ENDPOINTS__ is not defined`（#406 复核：老写法恒红，与产品无关）。
  try {
    translatorOut = execFileSync(
      process.execPath,
      ['--import', new URL('../helpers/injected.mjs', import.meta.url).href, 'tests/unit/openai-adapter.test.mjs'],
      { cwd: repoRoot, encoding: 'utf8' }
    )
  } catch (error) {
    translatorOut = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  // 断言失败的行以 ✗ 开头；两条用例（[3] 干净流 / [4] 脏数据）都必须全绿
  const translatorFailures = translatorOut
    .split('\n')
    .filter((line) => line.trim().startsWith('✗'))
  if (!translatorOut.includes('PASS tests/unit/openai-adapter.test.mjs')) {
    bad(`3/4) 翻译器单测未通过：${translatorFailures.slice(0, 3).join(' | ') || '无输出'}`)
  } else {
    ok('3) 翻译器单测通过（子进程 node tests/unit/openai-adapter.test.mjs）')
  }
  const sequence = translatorOut
    .split('\n')
    .find((line) => line.includes('[3] 事件序列 ='))
  if (!sequence) {
    bad('3) 没有抓到翻译器的事件序列输出')
  } else {
    ok(`3) 事件序列：${sequence.split('=').slice(1).join('=').trim()}`)
    note(sequence.trim())
  }
  for (const line of translatorOut.split('\n')) {
    if (/\[3\] (三个 text_delta|message_delta 带 usage)/.test(line) || /\[4[abcde]\]/.test(line)) {
      note(line.trim())
    }
  }
  const dirtyOk = ['[4a]', '[4b]', '[4c]', '[4d]', '[4e]'].every((tag) =>
    translatorOut
      .split('\n')
      .some((line) => line.includes(tag) && line.trim().startsWith('ok'))
  )
  if (!dirtyOk) {
    bad('4) 脏数据用例没有全部通过（空 choices / 无 [DONE] / `: ping` 注释行）')
  } else {
    ok('4) 脏数据用例全绿：空 choices、无 [DONE] 断流、`: ping` 注释行 → 不抛错、不卡死、正常结束')
  }
  writeFileSync(ACCEPT_DIR + '/1.3.0-translator-unit.log', translatorOut)

  // ============ 7a. deepseek 模式：零影响 ============
  console.log('\n[7a] 回归：deepseek 模式')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  // 老用户形态：只有 base-url / model / api-key，没有 provider-kind
  await seed({ baseUrl: mockOk.base, model: DEEPSEEK_MODEL })

  await openSettings()
  const kindText = (await providerKindTrigger(page).first().innerText()).trim()
  if (!/DeepSeek/.test(kindText)) {
    bad(`7a) 默认服务类型不是 DeepSeek 官方：${kindText}`)
  } else {
    ok(`默认服务类型 = ${kindText}`)
  }
  if ((await page.getByLabel(/服务地址|Service URL/).count()) > 0) {
    bad('7a) deepseek 模式不该显示「服务地址」输入框（fields 只有 apiKey）')
  } else {
    ok('deepseek 模式只渲染 API Key 行（服务地址/模型按 spec 隐藏）')
  }
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(async () => mockOk.log.some((entry) => entry.path === '/models'))
  await closeSettings()

  // 搜索开关打开 + 附件入口
  //
  // 随 #480 变更（#538 收紧语义）：这里的断言从「附件上传到 /anthropic/v1/files 拿 file_id」
  // **反过来**了。7a 是 **DeepSeek 渠道**，而 #538 把 `providerCapability` 里 deepseek 的
  // `nativeFile` 收紧成「本仓库确有可用的原生上传实现」= false（`/v1/chat/completions/files`
  // 线上 404，见 #360），`textInjection` 也为 false —— 也就是说这个渠道**不收文档**：
  // 既不上传原件、也不做文本注入。原断言证明了「一定会有 files 请求」，现在恰好相反。
  // 所以改成三条反向断言（不是删掉）：① 没有任何 files API 请求；② 文档入口是禁用态；
  // ③ 界面明说「当前渠道不支持文档附件」，不静默吞掉。
  // 文本注入本身的覆盖在单元层（tests/unit/attachment-doc-wiring-480.test.mjs [绿 1~6]：
  // 三个注入渠道的正文进 user 消息、请求体里不出现 file_id / base64）。
  await page.getByRole('button', { name: /^智能搜索$|^Search$/ }).first().click()
  const filesBefore = mockOk.log.filter((entry) => entry.path.endsWith('/files')).length
  const chooser = page.locator('input[type="file"]').first()
  await chooser.setInputFiles({
    name: 'acceptance.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello acceptance'),
  })
  // ① 反向：不许有任何 files API 请求（给了 2.5s 让「万一实现了」的上传有机会冒出来）
  const uploaded = await waitFor(
    async () => mockOk.log.filter((entry) => entry.path.endsWith('/files')).length > filesBefore,
    2500
  )
  if (uploaded) {
    bad(
      `7a) DeepSeek 渠道不该上传到 files API（#538：deepseek 两条路都不通），实际打了 ${JSON.stringify(
        mockOk.log.filter((entry) => entry.path.endsWith('/files')).map((entry) => entry.path)
      )}`
    )
  } else {
    ok('附件没有上传到 /anthropic/v1/files（#480/#538：DeepSeek 渠道不走 files API）')
    note('deepseek 附件：files API 请求数 = 0（改前断言上传拿 file_id，#538 后语义反转）')
  }
  // ② 反向：文档入口必须是禁用态（不给「能点但没用」的假承诺）
  const docEntry = page.getByRole('button', { name: /文档附件/ })
  const docEntryDisabled =
    (await docEntry.count()) > 0 &&
    (await docEntry.first().evaluate((node) => node.getAttribute('aria-disabled') === 'true'))
  if (!docEntryDisabled) {
    bad('7a) DeepSeek 渠道的文档入口应当是禁用态（aria-disabled=true），不给假承诺')
  } else {
    ok('DeepSeek 渠道的文档入口是禁用态（aria-disabled=true）')
  }
  // ③ 反向：界面必须说清「这个渠道收不了文档」，而不是静默忽略
  const toastShown = await waitFor(async () =>
    (await page.locator('body').innerText()).includes('当前渠道不支持文档附件')
  )
  if (!toastShown) {
    bad('7a) 选了文档却没有任何提示（#538 要求明说「当前渠道不支持文档附件」）')
  } else {
    ok('选文档时提示「当前渠道不支持文档附件」（不静默吞掉）')
  }
  await page.waitForTimeout(800)

  await send('你好')
  const dsMessages = await waitFor(async () => posts(mockOk.log, '/anthropic/v1/messages').length > 0)
  const dsEntry = posts(mockOk.log, '/anthropic/v1/messages')[0]
  if (!dsMessages || !dsEntry) {
    bad('7a) 没有打到 /anthropic/v1/messages')
  } else {
    const body = jsonBody(dsEntry)
    const roles = (body.messages ?? []).map((message) => message.role)
    const tools = (body.tools ?? []).map((tool) => tool.type)
    const present = {
      safety_check: body.safety_check?.level === 'high',
      title: body.title?.enabled === true,
      tools: tools.length > 0,
      latest_reminder: roles.includes('latest_reminder'),
      thinking: Boolean(body.thinking?.type),
    }
    for (const [field, sent] of Object.entries(present)) {
      if (!sent) {
        bad(`7a) deepseek 请求体缺少 ${field}`)
      }
    }
    if (tools.includes('deepseek_web_search')) {
      ok(`搜索开关打开时 tools 里确有 deepseek_web_search（${tools.join(', ')}）`)
      note(`deepseek requests.tools = ${JSON.stringify(tools)}`)
    } else {
      bad(`7a) 搜索开关打开却没有 deepseek_web_search：${JSON.stringify(tools)}`)
    }
    note(`deepseek messages roles = ${JSON.stringify([...new Set(roles)])}`)
    note(`deepseek body 顶层字段 = ${JSON.stringify(Object.keys(body))}`)
    note(`deepseek POST path = ${dsEntry.path}`)
  }
  await page.waitForTimeout(2500)
  const dsReply = await page.locator('body').innerText()
  if (!dsReply.includes(REPLY_TEXT)) {
    bad(`7a) deepseek 模式下回答没有渲染：${dsReply.slice(-120)}`)
  } else {
    ok('deepseek 模式回答正常渲染')
  }
  const titleShown = await page.getByText(TITLE).count()
  if (titleShown === 0) {
    bad('7a) 自动标题没有生效（侧边栏看不到标题）')
  } else {
    ok(`自动标题生效：侧边栏显示「${TITLE}」`)
    note(`deepseek 自动标题 = ${TITLE}`)
  }
  /**
   * #813：官方渠道的输入区右侧工具栏**只留最右边的文件上传** —— 语音入口与文档入口
   * （连「不可用」占位那一支）都彻底不渲染。所以这一节从「三个入口都在」改成：
   *   · 智能搜索 / 朗读 仍在（这两个不在 #813 的范围内）；
   *   · 语音入口**不在**（不是置灰，是 DOM 里没有节点）；
   *   · 文档入口 `absent`（`disabled` 那一档随 #813 一起退场）。
   */
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['朗读', /^朗读$|^Read aloud$/],
  ]) {
    if (!(await usable(re))) {
      bad(`7a) deepseek 模式下「${label}」入口不可用`)
    }
  }
  if (await usable(/^语音输入$|^Voice input$/)) {
    bad('7a) deepseek 模式下仍然渲染了语音入口（#813 起应彻底不渲染）')
  } else {
    ok('7a) 官方渠道没有语音入口（精简工具栏，#813）')
  }
  // 图片通路不变（`files` 上传 + `file_id`）；文档入口两种状态都不渲染（#813）
  await expectAttachEntries('7a', { image: 'ready', document: 'absent' })
  /**
   * 第三条路径 tools（`/v1/tools/asr`）：它**只能**从语音入口触发，而 #813 之后语音入口在
   * 任何渠道都不再渲染（全仓只有 deepseek 的 `caps.asr` 是 true）—— 这条腿因此不可达。
   * 这里不再假装录一次音，只在入口真的回来时才断言（回归时自动接上），并且**记一条 note**
   * 让「ASR 无 UI 覆盖」这件事在输出里看得见，而不是静默消失。
   */
  const voiceEntry = await page.getByRole('button', { name: /语音输入|Voice input/ }).first().count()
  const dsPaths = {
    models: mockOk.log.filter((entry) => entry.path === '/models').length,
    messages: posts(mockOk.log, '/anthropic/v1/messages').length,
    tools: posts(mockOk.log, '/v1/tools/asr').length,
  }
  if (voiceEntry === 0) {
    note('deepseek 语音入口已按 #813 移除 → /v1/tools/asr 本用例不可达（UI 侧无入口）')
    if (dsPaths.models === 0 || dsPaths.messages === 0) {
      bad(`7a) deepseek 两条路径没齐：${JSON.stringify(dsPaths)}`)
    } else {
      ok('deepseek 两条路径逐字一致：/models、/anthropic/v1/messages')
      note(`deepseek paths 命中次数 = ${JSON.stringify(dsPaths)}`)
    }
  } else {
    await page.locator('textarea').last().fill('')
    await page.getByRole('button', { name: /语音输入|Voice input/ }).first().click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /结束录音并转写|Stop and transcribe/ }).first().click()
    const asrHit = await waitFor(async () => posts(mockOk.log, '/v1/tools/asr').length > 0, 20000)
    dsPaths.tools = posts(mockOk.log, '/v1/tools/asr').length
    if (!asrHit || dsPaths.tools === 0) {
      bad(`7a) 没有捕获到 /v1/tools/asr：${JSON.stringify(dsPaths)}`)
    } else if (dsPaths.models === 0 || dsPaths.messages === 0) {
      bad(`7a) deepseek 三条路径没齐：${JSON.stringify(dsPaths)}`)
    } else {
      ok(`deepseek 三条路径逐字一致：/models、/anthropic/v1/messages、/v1/tools/asr`)
      note(`deepseek paths 命中次数 = ${JSON.stringify(dsPaths)}`)
    }
  }
  await page.waitForTimeout(1200)
  await page.screenshot({ path: SHOT_DIR + '/1.2.3-deepseek-full.png' })

  // ============ 2/3. anthropic 模式：路径 + 字段剥离 + 流式文本 ============
  console.log('\n[7b] 回归：anthropic 模式路径与请求体')
  // 只看切到 anthropic 之后产生的请求（前面的 deepseek 请求还在同一个 mock 日志里）
  const anLogStart = mockOk.log.length
  await openSettings()
  await selectKind(/Anthropic 协议|Anthropic-compatible/)
  await setField(/服务地址|Service URL/, mockOk.base)
  await setField(/^模型$|^Model$/, ANTHROPIC_MODEL)
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(async () => mockOk.log.some((entry) => entry.path === '/v1/models'))
  await closeSettings()
  note(`anthropic 探测 path = ${mockOk.log.filter((e) => e.path === '/v1/models').length} 次 /v1/models`)

  await send('再来一条')
  await waitFor(async () => posts(mockOk.log, '/v1/messages').length > 0)
  const anEntry = posts(mockOk.log, '/v1/messages')[0]
  if (!anEntry) {
    bad('7b) 没有打到 /v1/messages')
  } else {
    const body = jsonBody(anEntry)
    const roles = (body.messages ?? []).map((message) => message.role)
    const gates = {
      safety_check: Object.hasOwn(body, 'safety_check'),
      title: Object.hasOwn(body, 'title'),
      tools: Object.hasOwn(body, 'tools'),
      latest_reminder: roles.includes('latest_reminder'),
    }
    for (const [field, sent] of Object.entries(gates)) {
      if (sent) {
        bad(`7b) anthropic 请求体仍带 ${field}`)
      }
    }
    ok(`anthropic 请求体已剥离 safety_check/title/tools/latest_reminder`)
    note(`anthropic body 顶层字段 = ${JSON.stringify(Object.keys(body))}`)
    note(`anthropic messages roles = ${JSON.stringify([...new Set(roles)])}`)
    note(`anthropic POST path = ${anEntry.path}，model = ${body.model}`)
    const anModelPaths = [
      ...new Set(
        mockOk.log
          .slice(anLogStart)
          .filter((e) => e.path.endsWith('/models'))
          .map((e) => e.path)
      ),
    ]
    if (anModelPaths.length === 1 && anModelPaths[0] === '/v1/models' && anEntry.path === '/v1/messages') {
      ok(`anthropic 两条路径逐字一致：/v1/models、/v1/messages`)
      note(`anthropic paths = ${JSON.stringify({ models: anModelPaths, messages: anEntry.path })}`)
    } else {
      bad(`7b) anthropic 路径不符合规格：models=${JSON.stringify(anModelPaths)} messages=${anEntry.path}`)
    }
    if (body.system.length < 20) {
      bad('7b) latestReminder 内容没有折进 system')
    }
  }
  await page.waitForTimeout(2500)
  const anReply = await page.locator('body').innerText()
  if (!anReply.includes(REPLY_TEXT)) {
    bad(`7b) anthropic 流式文本没有逐字渲染出来：${anReply.slice(-140)}`)
  } else {
    ok(`anthropic 流式回答逐字渲染：${REPLY_TEXT}`)
  }
  const errorNotice = await page.getByText(/上游返回网页|网络异常|服务器繁忙|API Key 无效/).count()
  if (errorNotice > 0) {
    bad('7b) anthropic 正常回答被标成了错误状态')
  } else {
    ok('7b) 结束状态正常（无错误提示）')
  }

  // ============ 5. anthropic 能力降级 ============
  console.log('\n[7d] 回归：anthropic 模式能力降级')
  // 随 #552 变更：三渠道支持图片 —— 图片入口从本列表移出（它走 `image.base64` 本地编码内联，
  // 不需要 `paths.files`）。**文档入口**（TXT/DOCX/PDF）走 #480 的文本注入，这次没动。
  // 两个附件入口都在下面用同一条两轴断言（testid）钉住，别把两条能力混成一条。
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['语音输入', /^语音输入$|^Voice input$/],
    ['朗读', /^朗读$|^Read aloud$/],
  ]) {
    if (await gone(re)) {
      ok(`「${label}」入口已隐藏/置灰`)
    } else {
      bad(`7d) anthropic 模式下「${label}」入口仍可用`)
    }
  }
  // 两个附件入口分别按 testid 断言（#596）：图片走 base64 内联、文档走文本注入，**都该可用**。
  // （原来这里按 `^添加文档` 这个文案前缀数「能用的 picker」，现在并入同一条两轴断言。）
  await expectAttachEntries('7d', { image: 'ready', document: 'ready' })
  if (!(await usable(/^深度思考$|^DeepThink$/))) {
    bad('7d) anthropic 模式下「深度思考」被误删')
  } else {
    ok('「深度思考」保留可用')
  }
  await page.screenshot({ path: SHOT_DIR + '/1.2.3-anthropic-caps.png' })
  // DOM 证据：把四个入口在 anthropic 模式下的实际 DOM 属性落盘（隐藏 or aria-disabled）
  const domDump = await page.evaluate(() => {
    const wanted = ['智能搜索', '上传文件', '语音输入', '朗读', '深度思考']
    const buttons = [...document.querySelectorAll('button')]
    const nodes = (hits) =>
      hits.slice(0, 2).map((button) => ({
        ariaLabel: button.getAttribute('aria-label'),
        testId: button.getAttribute('data-testid'),
        ariaDisabled: button.getAttribute('aria-disabled'),
        unavailableMarker: button.getAttribute('data-attachment-entry'),
        disabled: button.disabled,
        hidden: button.hidden,
        display: getComputedStyle(button).display,
        visibility: getComputedStyle(button).visibility,
        className: button.className,
      }))
    const byLabel = wanted.map((label) => {
      const hits = buttons.filter(
        (button) =>
          button.getAttribute('aria-label')?.includes(label) ||
          button.textContent?.trim() === label ||
          button.textContent?.includes(label)
      )
      return { label, count: hits.length, nodes: nodes(hits) }
    })
    // 两个附件入口按 testid 单独落盘（#586 / #596）：`上传文件` 只挂在**图片**入口上，
    // 按文案数节点分不清「图片 / 文档」，证据里必须给出各自的真实形态。
    const byAttach = ['attach-image', 'attach-document'].map((testId) => {
      const hits = buttons.filter((button) => button.getAttribute('data-testid') === testId)
      return { label: `data-testid=${testId}`, count: hits.length, nodes: nodes(hits) }
    })
    return [...byLabel, ...byAttach]
  })
  writeFileSync(
    SHOT_DIR + '/1.2.3-anthropic-dom.txt',
    `anthropic 模式入口 DOM（生成于 ${new Date().toISOString()}）\n${JSON.stringify(domDump, null, 2)}\n`
  )
  note('anthropic 入口 DOM 证据已写入 docs/ui/1.2.3-anthropic-dom.txt')

  // ============ 4. 上游返回 HTML ============
  // #406：这一段已下线 —— 「上游 200 + text/html 必须给明确错误、且不得把 HTML 渲染进气泡」
  // 现在由**专用文件** `tests/integration/upstream-html.test.mjs` 承担（同一契约、独立夹具、
  // 独立耗时统计）。本文件头本来就写着「需要哪组就抄出去做独立文件，然后从这里删掉对应段落」。
  // 注意：那条契约当前是**真的不满足**（200 被 classifyErrorSignature 归到 emptyStream，
  // upstreamReturnedHtml 文案不可达），缺陷在 upstream-html.test.mjs 里继续红着追踪，
  // 对应 follow-up issue 见该基线条目，不是被这段删除掩盖掉。

  // ============ 1/2. openai 模式：路径、鉴权头、请求体 ============
  console.log('\n[1] openai 模式：路径与鉴权头')
  await openSettings()
  await setField(/服务地址|Service URL/, mockOk.base)
  await selectKind(/OpenAI 兼容|OpenAI-compatible/)
  await setField(/服务地址|Service URL/, mockOk.base)
  await setField(/^模型$|^Model$/, OPENAI_MODEL)
  // 窗口必须在**切到 openai 之后**才开：上面那句服务地址是先给 anthropic 渠道填的，
  // 它自己会触发一次 anthropic 探测（GET /v1/models + x-api-key），把这句请求算进来
  // 就会把「上一个渠道的正常探测」误判成「openai 探测缺 Authorization」（Issue #56）。
  await page.waitForTimeout(600)
  const openaiLogStart = mockOk.log.length
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(async () => mockOk.log.slice(openaiLogStart).some((e) => e.path === '/v1/models'))
  await closeSettings()
  const openaiModelEntry = mockOk.log
    .slice(openaiLogStart)
    .find((entry) => entry.method === 'GET' && entry.path === '/v1/models')
  if (!openaiModelEntry) {
    bad('1) openai 模式探测没有打到 /v1/models')
  } else if (openaiModelEntry.headers.authorization !== `Bearer ${KEY}`) {
    bad(`1) openai 探测鉴权头不对：${openaiModelEntry.headers.authorization}`)
  } else if (openaiModelEntry.headers['x-api-key'] || openaiModelEntry.headers['anthropic-version']) {
    bad('1) openai 模式仍带 x-api-key / anthropic-version')
  } else {
    ok(`openai 探测：GET /v1/models，Authorization: Bearer ${KEY}（无 x-api-key / anthropic-version）`)
  }

  const errorNoticeBefore = await page.getByText(/上游返回网页|网络异常|服务器繁忙|API Key 无效/).count()
  await send('你好 openai')
  const openaiHit = await waitFor(async () => posts(mockOk.log, '/v1/chat/completions').length > 0)
  await page.screenshot({ path: SHOT_DIR + '/1.3.0-openai-streaming.png' })
  const openaiEntry = posts(mockOk.log, '/v1/chat/completions')[0]
  if (!openaiHit || !openaiEntry) {
    bad('1) 没有打到 /v1/chat/completions')
  } else {
    ok(`1) POST 打到 /v1/chat/completions，header Authorization = ${openaiEntry.headers.authorization}`)
    const auth = openaiEntry.headers.authorization
    if (auth !== `Bearer ${KEY}`) {
      bad(`1) Authorization 不是 Bearer ${KEY}：${auth}`)
    }
    if (openaiEntry.headers['x-api-key'] || openaiEntry.headers['anthropic-version']) {
      bad('1) openai 模式请求仍带 x-api-key / anthropic-version')
    }
    const paths = [
      ...new Set(
        mockOk.log
          .slice(openaiLogStart)
          .filter((e) => e.path.startsWith('/v1/'))
          .map((e) => e.path)
      ),
    ]
    if (!paths.includes('/v1/models') || !paths.includes('/v1/chat/completions')) {
      bad(`1) openai 路径不符合规格：${JSON.stringify(paths)}`)
    } else {
      ok(`1) openai 路径逐字一致：${JSON.stringify(paths)}`)
    }
    note(`openai 探测鉴权头 = ${openaiModelEntry?.headers.authorization ?? '(未捕获)'}`)
    note(`openai 请求鉴权头 = ${auth}`)
  }

  console.log('\n[2] openai 请求体转换')
  if (!openaiEntry) {
    bad('2) 没有请求体可断言（POST 没打出去）')
  } else {
    const body = jsonBody(openaiEntry)
    const roles = (body.messages ?? []).map((message) => message.role)
    const head = body.messages?.[0] ?? {}
    if (head.role !== 'system' || typeof head.content !== 'string' || !head.content.includes('该助手为DeepSeek')) {
      bad(`2) system 没有进 messages 头部：${JSON.stringify(head)}`)
    } else {
      ok(`2) system 进 messages 头部：role=system，content=${head.content.slice(0, 24)}…`)
    }
    const leaked = ['safety_check', 'title', 'tools', 'thinking', 'system'].filter((key) =>
      Object.hasOwn(body, key)
    )
    if (leaked.length > 0) {
      bad(`2) openai 请求体仍带 ${JSON.stringify(leaked)}`)
    } else {
      ok('2) 请求体无 safety_check / title / tools / thinking / 顶层 system')
    }
    const badRoles = roles.filter((role) => !['system', 'user', 'assistant'].includes(role))
    if (badRoles.length > 0) {
      bad(`2) messages 里有非法角色：${JSON.stringify(badRoles)}`)
    }
    if (body.stream !== true || body.model !== OPENAI_MODEL) {
      bad(`2) stream/model 不对：stream=${body.stream} model=${body.model}`)
    } else {
      ok(`2) stream=true，model=${body.model}`)
    }
    note(`openai body 顶层字段 = ${JSON.stringify(Object.keys(body))}`)
    note(`openai messages roles = ${JSON.stringify(roles)}`)
    if (body.messages?.some((message) => typeof message.content !== 'string')) {
      bad('2) messages.content 不是纯字符串（应只取 text 块）')
    } else {
      ok('2) messages.content 全部是纯字符串')
    }
  }

  // ============ 5. openai 端到端：文本逐字渲染 ============
  console.log('\n[5] openai 端到端：逐字渲染与结束状态')
  const snapshots = []
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText()
    snapshots.push(text)
    if (text.includes(OPENAI_REPLY_TEXT)) {
      break
    }
    await page.waitForTimeout(100)
  }
  const partial = snapshots.filter(
    (snapshot) => !snapshot.includes(OPENAI_REPLY_TEXT) && /OpenAI 兼容|兼容回答/.test(snapshot)
  )
  const finalText = snapshots.at(-1) ?? ''
  if (!finalText.includes(OPENAI_REPLY_TEXT)) {
    bad(`5) openai 流式文本没有渲染出来：${finalText.slice(-140)}`)
  } else {
    ok(`5) openai 文本渲染完整：${OPENAI_REPLY_TEXT}`)
  }
  if (partial.length === 0) {
    note('5) 未捕获到中间帧（本地 mock 可能一次写完），逐字渲染以翻译器的 3 个 delta 为准')
  } else {
    ok(`5) 捕获到 ${partial.length} 个中间帧，正文是逐块追加渲染的`)
  }
  await page.waitForTimeout(1200)
  const errorNoticeOpenAI = await page.getByText(/上游返回网页|网络异常|服务器繁忙|API Key 无效/).count()
  // 同一会话里前面各组可能留下过错误气泡，按「增量」判断：openai 这轮不允许新增错误提示
  if (errorNoticeOpenAI > errorNoticeBefore) {
    bad(`5) openai 正常回答被标成了错误状态（错误提示 ${errorNoticeBefore} → ${errorNoticeOpenAI}）`)
  } else {
    ok(`5) 结束状态正常（错误提示数量未增加：${errorNoticeBefore} → ${errorNoticeOpenAI}）`)
  }
  const stillStreaming = await page
    .getByRole('button', { name: /停止|Stop/ })
    .count()
  if (stillStreaming > 0) {
    bad('5) 流已结束但仍处于生成中（停止按钮还在）')
  } else {
    ok('5) 结束后回到可发送状态（停止按钮已消失）')
  }
  await page.screenshot({ path: SHOT_DIR + '/1.3.0-openai-done.png' })

  // ============ 6a. openai 能力降级 ============
  console.log('\n[6] openai 模式能力降级')
  // 随 #552 变更：三渠道支持图片 —— 「上传文件」（图片入口）不再隐藏，下面单独断言。
  // 文档入口（添加文档 TXT/DOCX/PDF）走 #480 的文本注入，一直可用，这次没动。
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['语音输入', /^语音输入$|^Voice input$/],
    ['朗读', /^朗读$|^Read aloud$/],
  ]) {
    const count = await page.getByRole('button', { name: re }).count()
    if (count === 0) {
      ok(`「${label}」入口 count=0（隐藏）`)
    } else {
      bad(`6) openai 模式下「${label}」入口 count=${count}，应完全隐藏`)
    }
  }
  // 两个附件入口按 testid 精确断言（#596）：openai 渠道图片走 base64 内联、文档走文本注入，
  // 都**必须在且可点** —— 不随搜索 / 语音 / 朗读一起降级。
  await expectAttachEntries('6', { image: 'ready', document: 'ready' })
  // #341 起「深度思考」在四个渠道**恒常驻**（不隐藏、不置灰），能不能真生效由请求侧 REQUEST_GATES 决定；
  // openai 通道不发思考字段，所以入口在、但必须标记「不真生效」。老断言要求 count=0，已过时（#406 复核）。
  {
    const think = page.getByRole('button', { name: /^深度思考$|^DeepThink$/ }).first()
    const count = await think.count()
    const effective = count ? await think.getAttribute('data-thinking-effective') : null
    if (count === 1 && effective === 'false') {
      ok('「深度思考」入口常驻但标记为不真生效（#341，请求侧不发思考字段）')
    } else {
      bad(`6) openai 模式下「深度思考」应为「常驻 + 不真生效」，实际 count=${count} data-thinking-effective=${effective}`)
    }
  }
  const openaiCapsDom = await page.evaluate(() => {
    const wanted = ['智能搜索', '上传文件', '语音输入', '朗读', '深度思考', '重新生成']
    const buttons = [...document.querySelectorAll('button')]
    const byLabel = wanted.map((label) => ({
      label,
      count: buttons.filter(
        (button) =>
          button.getAttribute('aria-label')?.includes(label) || button.textContent?.includes(label)
      ).length,
    }))
    // 两个附件入口按 testid 单独落盘（#586 / #596）：`上传文件` 这个可访问名只挂在**图片**入口上，
    // 按文案数节点分不清「图片 / 文档」，证据里必须给出各自的真实计数与不可用标记。
    const byAttach = ['attach-image', 'attach-document'].map((testId) => {
      const hits = buttons.filter((button) => button.getAttribute('data-testid') === testId)
      return {
        label: `data-testid=${testId}`,
        count: hits.length,
        ariaDisabled: hits.map((button) => button.getAttribute('aria-disabled')),
        unavailableMarker: hits.map((button) => button.getAttribute('data-attachment-entry')),
      }
    })
    return [...byLabel, ...byAttach]
  })
  writeFileSync(
    SHOT_DIR + '/1.3.0-openai-dom.txt',
    `openai 模式入口 DOM 计数（生成于 ${new Date().toISOString()}）\n${JSON.stringify(openaiCapsDom, null, 2)}\n`
  )
  note(`openai 入口 DOM 计数 = ${JSON.stringify(openaiCapsDom)}`)
  await page.screenshot({ path: SHOT_DIR + '/1.3.0-openai-caps.png' })

  // ============ 6b. 切回 deepseek：能力恢复 ============
  console.log('\n[6] 切回 deepseek 模式')
  await openSettings()
  // 上一组换过服务地址，这里先指回正常运行的上游，再切回 deepseek
  await setField(/服务地址|Service URL/, mockOk.base)
  await selectKind(/DeepSeek 官方|DeepSeek Official/)
  await closeSettings()
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['上传文件', /^上传文件$|^Upload files$/],
    ['语音输入', /^语音输入$|^Voice input$/],
  ]) {
    if (await usable(re)) {
      ok(`「${label}」入口恢复可用`)
    } else {
      bad(`6) 切回 deepseek 后「${label}」入口没有恢复`)
    }
  }
  const beforeSwitch = posts(mockOk.log, '/anthropic/v1/messages').length
  await send('切回后的消息')
  await waitFor(async () => posts(mockOk.log, '/anthropic/v1/messages').length > beforeSwitch)
  const backEntry = posts(mockOk.log, '/anthropic/v1/messages')[beforeSwitch]
  if (!backEntry) {
    bad('6) 切回 deepseek 后没有重新打到 /anthropic/v1/messages')
  } else {
    const body = jsonBody(backEntry)
    ok(`切回后路径 = ${backEntry.path}，safety_check=${JSON.stringify(body.safety_check)}`)
  }
  await page.waitForTimeout(1500)

  // ============ 7. 刷新后会话与配置仍在 ============
  console.log('\n[7e] 刷新持久化')
  const sessionsBefore = await page.locator('text=' + TITLE).count()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const afterReload = await page.evaluate(() => ({
    kind: window.localStorage.getItem('chat-demo:provider-kind'),
    baseUrl: window.localStorage.getItem('chat-demo:base-url'),
    hasKey: Boolean(window.localStorage.getItem('chat-demo:api-key')),
  }))
  if (afterReload.kind !== 'deepseek' || !afterReload.hasKey) {
    bad(`7e) 配置没有持久化：${JSON.stringify(afterReload)}`)
  } else {
    ok(`配置仍在：kind=${afterReload.kind} baseUrl=${afterReload.baseUrl}`)
  }
  if (sessionsBefore > 0 && (await page.getByText(TITLE).count()) > 0) {
    ok('会话与标题刷新后仍在')
  } else {
    bad('7e) 刷新后会话/标题丢失')
  }
  await page.locator('text=' + TITLE).first().click()
  await page.waitForTimeout(800)
  const restored = await page.locator('body').innerText()
  if (restored.includes(REPLY_TEXT)) {
    ok('刷新后打开会话仍能看到历史回答')
  } else {
    bad('7e) 刷新后历史回答丢失')
  }
} catch (error) {
  bad(`用例异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  // ============ 8. console error ============
  console.log('\n[8] console')
  // 用例期间可能出现一次 4xx/5xx 资源日志，只关心真正的脚本错误
  const realErrors = consoleErrors.filter((text) => !/Failed to load resource/i.test(text))
  if (realErrors.length > 0) {
    bad(`8) console error ${realErrors.length} 条：${realErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('8) console error = 0')
  }
  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）—— 先断言再关浏览器
  assertNoEgress(failures)
  await browser.close()
  mockOk.server.close()

  console.log('\n=== 证据汇总 ===')
  for (const line of evidence) {
    console.log('  ' + line)
  }
  if (failures.length > 0) {
    console.error(`\nFAIL tests/integration/full-acceptance.test.mjs（${failures.length} 条）`)
    process.exit(1)
  }
  console.log('\nPASS tests/integration/full-acceptance.test.mjs')
}
