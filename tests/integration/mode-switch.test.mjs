// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 模式切换控件的自建验收：402×874 截图 + getComputedStyle 断言 + 3 次切换 + 回归（输入/按钮/发消息）。
//
//   cd /root/deepseek-app && node tests/integration/mode-switch.test.mjs
//
// 需要**内测构建**（默认渠道是我们的渠道 ours，契约见 tests/fixtures/ours-upstream.mjs）：
// 脚本自己起静态服务（默认端口 5293，PORT 可注入），上游用 page.route 打桩，不连外网。
//   DIST_DIR=$PWD/dist PORT=5293 node tests/integration/mode-switch.test.mjs
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'
import { OURS_CHAT_PATH, OURS_CORS, OURS_HOST, modelsJson, openAiSse } from '../fixtures/ours-upstream.mjs'

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
await page.reload({ waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /快速模式|Fast mode/ }).waitFor({ timeout: 15000 })

console.log('\n[1] 默认态（快速模式选中）')
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

const initial = await assertState(page, '默认态', 'fast')
await page.screenshot({ path: `${OUT_DIR}/mode-01-fast.png` })
ok(`截图 ${OUT_DIR}/mode-01-fast.png`)

console.log('\n[2] 点击「专家模式」后')
await page.getByRole('button', { name: /专家模式|Expert mode/ }).click()
await wait(220)
const afterClick = await assertState(page, '点击后', 'expert')
await page.screenshot({ path: `${OUT_DIR}/mode-02-expert.png` })
ok(`截图 ${OUT_DIR}/mode-02-expert.png`)

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
expect(
  storage.every((key) => key === 'chat-demo:api-key'),
  '控件没有写入 localStorage（只剩预先种下的 api-key）',
  storage.join(',')
)

console.log('\n[4] 回归：输入框 / 深度思考 / 智能搜索 / 发消息')
const textarea = page.locator('textarea').first()
await textarea.click()
await textarea.fill('')
await textarea.type('模式切换回归：发一条消息')
expect((await textarea.inputValue()) === '模式切换回归：发一条消息', '输入框可正常输入')
const modeAfterTyping = await readSegment(page, 'fast')
expect(modeAfterTyping.ariaPressed === 'true', '输入文字不影响模式选中态（仍为快速模式）')

// 内测包默认渠道是我们自己的渠道（ours）：OpenAI 协议，只有基础对话，
// 深度思考 / 智能搜索入口都不渲染（1.4.0-beta.6 起的 ours 契约，见 providers.ts）。
// 「正式包里这些入口仍在」由 tests/integration/mode-switch-plain.test.mjs 守着。
const thinkCount = await page.getByRole('button', { name: /深度思考|DeepThink|Thinking/ }).count()
expect(thinkCount === 0, 'ours 渠道不渲染深度思考入口（该协议不提供）', `count=${thinkCount}`)
const searchCount = await page.getByRole('button', { name: /智能搜索|Search/ }).count()
expect(searchCount === 0, 'ours 渠道不渲染智能搜索入口（该协议不提供）', `count=${searchCount}`)

await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
const reply = page.getByText(REPLY_TEXT, { exact: false }).first()
await reply.waitFor({ timeout: 20000 })
expect(await reply.isVisible(), '发消息流程正常：mock 上游回复已渲染')
expect(
  upstreamLog.some((entry) => entry.endsWith(OURS_CHAT_PATH)),
  `请求按 ours 契约打到 ${OURS_CHAT_PATH}（OpenAI 协议）`,
  upstreamLog.join(' | ')
)

expect(consoleErrors.length === 0, 'console error = 0', consoleErrors.join(' | '))

await browser.close()

console.log('\n=== 汇总 ===')
console.log(
  `默认态 fast: bg=${initial.fast.backgroundColor} color=${initial.fast.color} / expert: bg=${initial.expert.backgroundColor} color=${initial.expert.color}`
)
console.log(
  `点击后 fast: bg=${afterClick.fast.backgroundColor} color=${afterClick.fast.color} / expert: bg=${afterClick.expert.backgroundColor} color=${afterClick.expert.color}`
)
served.kill()
if (failures.length === 0) {
  console.log('全部断言通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
