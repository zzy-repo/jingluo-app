// [layer: integration | 依赖: playwright + chromium + 本地 dev 服务器 + 路由拦截的 mock 上游 | 耗时: ~40s]
// Issue #25 的请求侧硬证据：同一句提问、两种模式（快速 / 专家）各发一次真实请求，
// 把两次 POST 的请求体逐字节对比；随后刷新页面，看模式选择是否还在、是否进请求。
//
//   cd /d/all_project/runs/fix25 && pnpm dev            # 另开一个终端
//   APP_URL=http://127.0.0.1:8090 node tests/integration/mode-switch-request.test.mjs
//
// 上游由 Playwright 路由拦截伪造（不碰真网络、不需要真 Key）：
//   POST https://api.deepseek.com/anthropic/v1/messages → 固定 SSE 回复。
// 断言口径：请求体必须因模式而不同（且差异含 thinking），刷新后模式必须还在。
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
// 用正式产物（DeepSeek 官方渠道才有「快速/专家」），产物种类/新鲜度由 verifyDist 守
const DIST =
  process.env.DIST_DIR_STANDARD || process.env.STANDARD_DIST_DIR || path.join(ROOT, 'dist-standard')
let APP_URL = process.env.APP_URL || ''
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'docs/ui/mode-switch')
const PROMPT = '同一个问题：把「快速 / 专家」讲清楚'
const REPLY_TEXT = '模式请求对比回复。'

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

const sse = () => {
  const lines = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mode_request',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'deepseek-flash',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: REPLY_TEXT },
    })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20 },
    })}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ]
  return lines.join('\n')
}

/** 把两个请求体按顶层 key 对比，返回变化项（值做紧凑 JSON 化，便于人眼核对） */
const diffBodies = (a, b) => {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort()
  const changed = []
  for (const key of keys) {
    const left = JSON.stringify(a?.[key])
    const right = JSON.stringify(b?.[key])
    if (left !== right) {
      changed.push({ key, fast: left, expert: right })
    }
  }
  return changed
}

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
})
// 假 Key：请求被路由拦掉，不会真的发出去
await context.addInitScript(() => {
  localStorage.setItem('chat-demo:api-key', 'sk-mode-request-probe')
  localStorage.setItem('chat-demo:provider-kind', 'deepseek')
})

// 环境下沉：以前固定连 127.0.0.1:8090 的 pnpm dev，没起服务或端口被别的东西占了就是假红。
// 现在自己起静态服务（PORT 可注入），并校验端口上那份产物就是正式包。
verifyDist(DIST, { variant: 'standard' })
const served = await serveDir(DIST, { port: process.env.PORT, label: '正式产物 dist-standard' })
APP_URL = APP_URL || served.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const bodies = []
await page.route('**/anthropic/v1/messages', async (route) => {
  bodies.push(route.request().postData() ?? '')
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    body: sse(),
  })
})

const openWelcome = async () => {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea')
  await page.waitForSelector('[data-mode="expert"]')
}

const selectedMode = () =>
  page.evaluate(() => {
    const pressed = [...document.querySelectorAll('[data-mode]')].find(
      (node) => node.getAttribute('aria-pressed') === 'true'
    )
    return pressed?.getAttribute('data-mode') ?? null
  })

/** 选中某个模式 → 发一句话 → 等回复落地 → 返回这次请求体的解析结果 */
const ask = async (mode) => {
  await page.click(`[data-mode="${mode}"]`)
  const before = bodies.length
  await page.fill('textarea', PROMPT)
  await page.keyboard.press('Enter')
  await page.waitForSelector(`text=${REPLY_TEXT}`, { timeout: 20000 })
  if (bodies.length === before + 1) {
    return JSON.parse(bodies[bodies.length - 1])
  }
  return null
}

mkdirSync(OUT_DIR, { recursive: true })

console.log('# 快速模式')
await openWelcome()
// #363 起缺省档位是专家模式（开思考）；本用例验的是「档位真的改变请求体」，
// 所以先断言缺省态，再用 ask('fast') 显式切到快速模式做对照。
expect((await selectedMode()) === 'expert', '首次进入默认是专家模式（#363）')
const fastBody = await ask('fast')
expect(!!fastBody, '快速模式下抓到了请求体', fastBody ? `${bodies.at(-1).length} 字节` : '没抓到')

console.log('# 专家模式（刷新后重新选择）')
await openWelcome()
expect((await selectedMode()) === 'fast', '刷新后沿用已保存的模式（上一步选的是快速）')
const expertBody = await ask('expert')
expect(!!expertBody, '专家模式下抓到了请求体', expertBody ? `${bodies.at(-1).length} 字节` : '没抓到')

console.log('# 两次请求体逐字节对比')
const rawEqual = bodies.length >= 2 && bodies[0] === bodies[1]
const changed = diffBodies(fastBody, expertBody)
if (changed.length === 0) {
  bad('两种模式的请求体完全相同（逐字节一致，没有任何字段随模式变化）')
} else {
  ok(`两种模式的请求体不同，共 ${changed.length} 处字段差异`)
  for (const item of changed) {
    console.log(`      · ${item.key}: fast=${item.fast} → expert=${item.expert}`)
  }
}
writeFileSync(
  path.join(OUT_DIR, 'request-bodies.json'),
  `${JSON.stringify({ rawEqual, fast: fastBody, expert: expertBody, changed }, null, 2)}\n`
)

console.log('# 模式持久化（刷新后是否保留）')
await openWelcome()
const afterReload = await selectedMode()
expect(afterReload === 'expert', '刷新后仍是刷新前选的模式', afterReload)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-mode="expert"]')
expect((await selectedMode()) === 'expert', '再次刷新仍保留专家模式')
const persistedBody = await ask('expert')
expect(
  JSON.stringify(persistedBody) === JSON.stringify(expertBody),
  '刷新后的专家模式请求体与刷新前一致（没有退回快速模式）'
)

console.log('# 截图（390 / 360，Chromium 视口，非真机）')
for (const [width, height, name] of [
  [390, 844, 'welcome-expert-390.png'],
  [360, 800, 'welcome-expert-360.png'],
]) {
  await page.setViewportSize({ width, height })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-mode="expert"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT_DIR, name) })
  ok(`截图 ${path.join(OUT_DIR, name)}（${width}×${height} Chromium 视口）`)
}

expect(pageErrors.length === 0, '页面没有运行时报错', pageErrors.join(' | '))

await browser.close()
served.kill()
if (failures.length) {
  console.error(`\n${failures.length} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
