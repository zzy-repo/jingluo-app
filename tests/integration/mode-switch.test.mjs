// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 模式切换控件的自建验收：402×874 截图 + getComputedStyle 断言 + 3 次切换 + 回归（输入/按钮/发消息）。
//
//   cd /root/deepseek-app && node tests/integration/mode-switch.test.mjs
//
// 需要**内测构建**（默认渠道是我们的渠道 ours，契约见 tests/fixtures/domain03-04/ours-upstream.mjs）：
// 脚本自己起静态服务（默认端口 5293，PORT 可注入），上游用 page.route 打桩，不连外网。
//   DIST_DIR=$PWD/dist PORT=5293 node tests/integration/mode-switch.test.mjs
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'
import { OURS_CHAT_PATH, OURS_CORS, OURS_HOST, modelsJson, openAiSse } from '../fixtures/domain03-04/ours-upstream.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
let APP_URL = process.env.APP_URL || ''
const UPSTREAM_HOSTNAME = new URL(OURS_HOST).hostname
const REPLY_TEXT = '模式切换验收回复，逐字流出。'
const OUT_DIR = path.join(ROOT, 'docs', 'ui')

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (cond, message, detail) => {
  if (cond) {
    ok(detail ? `${message}（${detail}）` : message)
  } else {
    bad(detail ? `${message}（实际：${detail}）` : message)
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 读取某个分段按钮的实际计算样式 */
const readSegment = (page, mode) =>
  page.evaluate((m) => {
    const button = document.querySelector(`button[data-mode="${m}"]`)
    if (!button) {
      return null
    }
    const style = getComputedStyle(button)
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontWeight: style.fontWeight,
      ariaPressed: button.getAttribute('aria-pressed'),
      rect: button.getBoundingClientRect().toJSON(),
    }
  }, mode)

const SELECTED_BG = 'rgb(232, 237, 255)' // #E8EDFF
const SELECTED_FG = 'rgb(77, 107, 254)' // #4D6BFE
const DEFAULT_FG = 'rgb(23, 23, 27)' // #17171b
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

const assertState = async (page, label, selected) => {
  const fast = await readSegment(page, 'fast')
  const expert = await readSegment(page, 'expert')
  const pairs = [
    ['fast', fast, selected === 'fast'],
    ['expert', expert, selected === 'expert'],
  ]
  for (const [name, snap, isSelected] of pairs) {
    if (!snap) {
      bad(`${label}：找不到 ${name} 分段按钮`)
      continue
    }
    expect(
      snap.ariaPressed === String(isSelected),
      `${label}：${name} aria-pressed = ${isSelected}`,
      snap.ariaPressed
    )
    if (isSelected) {
      expect(
        snap.backgroundColor === SELECTED_BG && snap.color === SELECTED_FG,
        `${label}：${name} 选中态背景/文字为 #E8EDFF / #4D6BFE`,
        `bg=${snap.backgroundColor} color=${snap.color} weight=${snap.fontWeight}`
      )
    } else {
      expect(
        snap.backgroundColor === TRANSPARENT && snap.color === DEFAULT_FG,
        `${label}：${name} 未选中态背景透明 / 文字 #17171b`,
        `bg=${snap.backgroundColor} color=${snap.color} weight=${snap.fontWeight}`
      )
    }
  }
  return { fast, expert }
}

// 环境守卫：dist 缺失 / 陈旧（源码比产物新）/ 种类不对 → SKIP(env) 并打印当前 main.<hash>.js
verifyDist(DIST, { variant: 'internal' })
// 端口自动发现（PORT 可注入）：以前固定 5294，撞到别的任务遗留的服务就会连到那份产物（假红）
const served = await serveDir(DIST, { port: process.env.PORT, label: '内测产物 dist' })
APP_URL = APP_URL || served.url
// 连外部 APP_URL 时也要校验「端口上那份产物」是不是内测包（防止撞到别人的标准包 → 假红）
await verifyAppUrl(APP_URL, DIST, { variant: 'internal' })
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
  deviceScaleFactor: 1,
})

const consoleErrors = []
context.on('page', (page) => {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
})

const upstreamLog = []
/** ours 聊天请求体（#363）：证明「档位」真的落进了请求，而不是只改了界面 */
const upstreamBodies = []
await context.route('**/*', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  if (url.hostname !== UPSTREAM_HOSTNAME) {
    await route.fallback()
    return
  }
  upstreamLog.push(`${request.method()} ${url.pathname}`)
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: OURS_CORS, body: '' })
    return
  }
  if (url.pathname.endsWith('/models')) {
    await route.fulfill({
      status: 200,
      headers: { ...OURS_CORS, 'content-type': 'application/json' },
      body: modelsJson(),
    })
    return
  }
  if (url.pathname.endsWith(OURS_CHAT_PATH)) {
    try {
      upstreamBodies.push(JSON.parse(request.postData() ?? '{}'))
    } catch {
      upstreamBodies.push({})
    }
    // ours 渠道走 OpenAI 协议：SSE 是 chat.completion.chunk，不再是 Anthropic message_*
    await route.fulfill({
      status: 200,
      headers: { ...OURS_CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: openAiSse(REPLY_TEXT),
    })
    return
  }
  await route.fulfill({ status: 200, headers: { ...OURS_CORS, 'content-type': 'application/json' }, body: '{}' })
})

const page = await context.newPage()
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => window.localStorage.clear())
await page.evaluate(() => window.localStorage.setItem('chat-demo:api-key', 'sk-mode-accept-0001'))
// #341 起模式开关在四个渠道**恒常驻**（不置灰、不带 disabled），布局断言在 DeepSeek 官方渠道跑；
// 内测包默认渠道 ours 的入口存在性与「可点、请求不带字段」在 [5] 单独断言。
await page.evaluate(() => window.localStorage.setItem('chat-demo:provider-kind', 'deepseek'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /快速模式|Fast mode/ }).waitFor({ timeout: 15000 })

// #363 起缺省档位是「专家模式（开思考）」：从没碰过开关的机器默认就思考，
// 所以这里的初始态是 expert（缺省值本身由 tests/unit/thinking-effort-363.test.mjs [1] 钉住）。
console.log('\n[1] 默认态（专家模式选中，缺省档 #363）')
const layout = await page.evaluate(() => {
  const group = document.querySelector('[role="group"][aria-label]')
  const fast = document.querySelector('button[data-mode="fast"]')
  const greeting = [...document.querySelectorAll('div')].find(
    (node) =>
      node.children.length === 0 &&
      /今天有什么可以帮到你|How can I help you/.test(node.textContent || '')
  )
  const groupRect = group.getBoundingClientRect()
  const fastRect = fast.getBoundingClientRect()
  const greetingRect = greeting.getBoundingClientRect()
  const trackStyle = getComputedStyle(group)
  return {
    viewportWidth: window.innerWidth,
    groupWidth: Math.round(groupRect.width),
    groupHeight: Math.round(groupRect.height),
    groupLeft: Math.round(groupRect.left),
    groupRight: Math.round(groupRect.right),
    trackBg: trackStyle.backgroundColor,
    trackRadius: trackStyle.borderRadius,
    trackPadding: trackStyle.padding,
    greetingBottom: Math.round(greetingRect.bottom),
    groupTop: Math.round(groupRect.top),
    segmentEqualWidth: Math.round(fastRect.width * 2) === Math.round(groupRect.width - 8),
  }
})
expect(
  layout.groupWidth >= 270 && layout.groupWidth <= 280,
  `外层胶囊宽度 ${layout.groupWidth}px 落在 270–280px（402 宽下 68%）`
)
expect(
  Math.abs(layout.groupLeft - (layout.viewportWidth - layout.groupRight)) <= 1,
  '胶囊水平居中'
)
expect(layout.groupHeight >= 40 && layout.groupHeight <= 42, `胶囊高度 ${layout.groupHeight}px 在 40–42px`)
expect(layout.trackBg === 'rgb(242, 242, 245)', `轨道底色 #F2F2F5`, layout.trackBg)
expect(layout.trackPadding === '4px', `轨道内边距 4px`, layout.trackPadding)
expect(layout.segmentEqualWidth, '两段等宽')
expect(
  layout.groupTop - layout.greetingBottom >= 0 && layout.groupTop - layout.greetingBottom <= 20,
  `控件紧贴问候语正下方（问候语底 ${layout.greetingBottom}px → 控件顶 ${layout.groupTop}px）`
)

const initial = await assertState(page, '默认态', 'expert')
await page.screenshot({ path: `${OUT_DIR}/mode-01-default-expert.png` })
ok(`截图 ${OUT_DIR}/mode-01-default-expert.png`)

console.log('\n[2] 点击「快速模式」后')
await page.getByRole('button', { name: /快速模式|Fast mode/ }).click()
await wait(220)
const afterClick = await assertState(page, '点击后', 'fast')
await page.screenshot({ path: `${OUT_DIR}/mode-02-fast.png` })
ok(`截图 ${OUT_DIR}/mode-02-fast.png`)

console.log('\n[3] 连续切换 3 次')
const sequence = [
  ['fast', 'fast'],
  ['expert', 'expert'],
  ['fast', 'fast'],
]
let toggleOk = true
for (const [clicked, expected] of sequence) {
  await page.getByRole(`button`, { name: clicked === 'fast' ? /快速模式|Fast mode/ : /专家模式|Expert mode/ }).click()
  await wait(220)
  const fast = await readSegment(page, 'fast')
  const expert = await readSegment(page, 'expert')
  const selected = fast.ariaPressed === 'true' ? 'fast' : 'expert'
  const consistent =
    selected === expected &&
    (expected === 'fast'
      ? fast.backgroundColor === SELECTED_BG && expert.backgroundColor === TRANSPARENT
      : expert.backgroundColor === SELECTED_BG && fast.backgroundColor === TRANSPARENT)
  if (!consistent) {
    toggleOk = false
  }
  console.log(
    `  ·   点击 ${clicked} → 选中 ${selected}（fast bg=${fast.backgroundColor} / expert bg=${expert.backgroundColor}）`
  )
}
expect(toggleOk, '3 次切换后选中态与计算样式始终一致')

const storage = await page.evaluate(() => Object.keys(window.localStorage).sort())
// issue #25：控件不再是纯样式，点它会写自己的两个键（新键 + 同步的旧「深度思考」键）
// #339 起启动时还会写一次性迁移版本号 `chat-demo:config-schema`（configMigration.ts，
// 只写一次、与模式开关无关）；#406 复核：老白名单没收这个键 → 恒红。
expect(
  storage.every((key) =>
    [
      'chat-demo:api-key',
      'chat-demo:provider-kind',
      'chat-demo:chat-mode',
      'chat-demo:thinking',
      'chat-demo:config-schema',
    ].includes(key)
  ) && storage.includes('chat-demo:chat-mode'),
  '除启动期一次性迁移版本号外，不应出现其它键（模式开关只写 chat-mode + thinking）',
  storage.join(',')
)

console.log('\n[4] 回归：输入框可输入，且输入不影响选中态')
const textarea = page.locator('textarea').first()
await textarea.click()
await textarea.fill('')
await textarea.type('模式切换回归：发一条消息')
expect((await textarea.inputValue()) === '模式切换回归：发一条消息', '输入框可正常输入')
const modeAfterTyping = await readSegment(page, 'fast')
expect(modeAfterTyping.ariaPressed === 'true', '输入文字不影响模式选中态（仍为快速模式）')

console.log('\n[5] 切回内测默认渠道（ours）：入口恒常驻、可点、请求真的带 reasoning_effort + 发消息')
await page.evaluate(() => window.localStorage.setItem('chat-demo:provider-kind', 'ours'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.getByText(/今天有什么可以帮到你|How can I help you/).first().waitFor({ timeout: 15000 })
const oursToggle = await page.locator('button[data-mode]').count()
expect(oursToggle === 2, 'ours 渠道仍渲染快速/专家两个按钮（#341 恒常驻）', `count=${oursToggle}`)
// 内测包默认渠道是我们自己的渠道（ours）：OpenAI 协议。
// #363 起 ours 的 reasoningParam 是 'reasoning_effort'（档位 high）：入口（#341 恒常驻）点了真的生效，
// 请求体带 reasoning_effort: 'high'；智能搜索仍按 caps.search 不渲染。
const thinkButton = page.getByRole('button', { name: /深度思考|DeepThink|Thinking/ }).first()
const thinkCount = await thinkButton.count()
expect(thinkCount === 1, 'ours 渠道深度思考入口仍渲染（#341 恒常驻）', `count=${thinkCount}`)
expect(
  (await thinkButton.getAttribute('data-thinking-effective')) === 'true',
  'ours 渠道标记为「真生效」（不可见）#363',
  await thinkButton.getAttribute('data-thinking-effective')
)
const searchCount = await page.getByRole('button', { name: /智能搜索|Search/ }).count()
expect(searchCount === 0, 'ours 渠道不渲染智能搜索入口（该协议不提供）', `count=${searchCount}`)

// #363：档位要真的联动 —— 前面几步停在快速模式（关思考），这里点一下开关再用。
// 老实现下这一步是「点了也白点」：请求侧被 REQUEST_GATES 拦掉，一个思考字段都不发。
if ((await thinkButton.getAttribute('aria-pressed')) === 'false') {
  await thinkButton.click()
  await wait(220)
}
expect(
  (await thinkButton.getAttribute('aria-pressed')) === 'true',
  'ours 渠道点一下深度思考 → 档位真的翻转（#363 联动）',
  await thinkButton.getAttribute('aria-pressed')
)

const oursTextarea = page.locator('textarea').first()
await oursTextarea.click()
await oursTextarea.fill('')
await oursTextarea.type('模式切换回归：发一条消息')
expect((await oursTextarea.inputValue()) === '模式切换回归：发一条消息', 'ours 渠道输入框可正常输入')

await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
const reply = page.getByText(REPLY_TEXT, { exact: false }).first()
await reply.waitFor({ timeout: 20000 })
expect(await reply.isVisible(), '发消息流程正常：mock 上游回复已渲染')
expect(
  upstreamLog.some((entry) => entry.endsWith(OURS_CHAT_PATH)),
  `请求按 ours 契约打到 ${OURS_CHAT_PATH}（OpenAI 协议）`,
  upstreamLog.join(' | ')
)
// #363 的验收口径：档位必须真的落进请求体（默认档 = 专家模式 → reasoning_effort: 'high'）。
// 自动起标题也是同一个上游的流式请求（max_tokens=32 的小请求），先把它排掉再取最后一条。
const chatBodies = upstreamBodies.filter(
  (body) => !(typeof body.max_tokens === 'number' && body.max_tokens <= 64)
)
const oursBody = chatBodies.at(-1) ?? {}
expect(
  oursBody.reasoning_effort === 'high',
  'ours 请求体真的带 reasoning_effort: "high"（#363：以前一个思考字段都没有）',
  JSON.stringify(oursBody)
)

expect(consoleErrors.length === 0, 'console error = 0', consoleErrors.join(' | '))

await browser.close()

console.log('\n=== 汇总 ===')
console.log(
  `默认态（专家）fast: bg=${initial.fast.backgroundColor} color=${initial.fast.color} / expert: bg=${initial.expert.backgroundColor} color=${initial.expert.color}`
)
console.log(
  `点击后（快速）fast: bg=${afterClick.fast.backgroundColor} color=${afterClick.fast.color} / expert: bg=${afterClick.expert.backgroundColor} color=${afterClick.expert.color}`
)
served.kill()
if (failures.length === 0) {
  console.log('全部断言通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
