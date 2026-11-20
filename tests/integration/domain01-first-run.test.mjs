// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 15~30 秒] 说明见 tests/README.md
// Issue #362（域 1「启动与可用性」）/ #367：最小充分集第 2/5 条。
//
// 这一条只跑一个场景，但三件事必须在**同一条时序**里串起来（表驱动会掩盖「先弹层、再存 Key、再发送」的先后关系）：
//   F1-09 清数据后首启：没有 Key 时**自动**把设置打开并停在数据管理/API Key 那一段，不让人卡在欢迎页；
//   F1-09 存 Key 后能直接发：填 Key → 确定 → 关弹层 → 发一条 → 打桩 SSE 回答上屏（不是「点了没反应」）；
//   F1-01 首屏始终可用：全程侧栏 + 欢迎页在场，没有「正在加载对话...」，没有白屏。
//
// 为什么以前一条都没覆盖（#362 盘点原文）：`tests/helpers/helpers.mjs` 的 `openSettingsDataSection`
// 把「已经自动弹出」当成通过条件，**放过**了「没弹出」；也没有任何一条断言「无 Key 时设置必须自动弹出」。
//
// 跑法（先 pnpm build 生成标准包；本脚本自起临时端口服务）：
//   node tests/integration/domain01-first-run.test.mjs
//   DIST_DIR=/private/artifacts/<commit>/standard node tests/integration/domain01-first-run.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { MESSAGES_SSE_OK } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain01-first-run.test.mjs'
const KEY = 'sk-testkey-domain01-first'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message) => (condition ? ok(message) : bad(message))

const server = await serveDist(DIST, { port: process.env.PORT || 0 })
const APP_URL = server.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
const browser = await chromium.launch()

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const waitFor = async (page, predicate, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(120)
  }
  return false
}
const waitForText = (page, part, timeout = 15_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  let messageCalls = 0
  // 上游全部打桩，不连外网
  await page.route(/\/models$/, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
    })
  )
  await page.route(/140\.210\.13\.146:60013/, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: 'cus-mock', device_id: 'dev-mock' }),
    })
  )
  await page.route(/\/anthropic\/v1\/messages$/, async (route) => {
    messageCalls += 1
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: MESSAGES_SSE_OK,
    })
  })

  // ---------- 清数据后首启：localStorage + IndexedDB 全部清空，再冷启动 ----------
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    window.localStorage.clear()
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('chat-demo')
      request.onsuccess = resolve
      request.onerror = resolve
      request.onblocked = resolve
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  // 分支 1（F1-09）：无 Key 时设置必须**自动**弹出，并且停在「数据管理 / API Key」
  const dialogShown = await waitFor(page, async () => (await page.getByRole('dialog').count()) > 0, 10_000)
  expect(dialogShown, 'F1-09 无 Key 首启自动打开设置弹层（用户不用自己找入口）')
  if (dialogShown) {
    const dialog = page.getByRole('dialog').first()
    const dialogText = await dialog.innerText()
    expect(/数据管理|API Key/.test(dialogText), 'F1-09 弹层停在数据管理 / API Key 那一段')
    expect(
      (await dialog.locator('input[type="password"]').count()) > 0,
      'F1-09 弹层里有可填的 API Key 输入框'
    )
  }

  // 分支 2（F1-01）：同一时刻首屏仍然是可用的（不是只给一个弹层 + 白屏）
  const text = await bodyText(page)
  expect(text.includes('今天有什么可以帮到你'), 'F1-01 清数据首启后主区仍是欢迎页（不白屏）')
  expect(text.includes('开启新对话'), 'F1-01 清数据首启后侧栏在场（可开启新对话）')
  expect(!text.includes('正在加载对话'), 'F1-01 清数据首启不卡在「正在加载对话...」')

  // ---------- 存 Key → 关弹层 → 直接发一条 ----------
  await page.locator('input[type="password"]').first().fill(KEY)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(400)
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(400)
  }
  expect((await page.getByRole('dialog').count()) === 0, 'F1-09 存 Key 后弹层能关掉（回到主界面）')

  // 分支 3（F1-09）：存 Key 后**直接**能发消息并收到回答，不需要重开 App
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('域名 1 首启发一条')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
  expect(await waitForText(page, '你好呀'), 'F1-09 存 Key 后直接发送，回答正常上屏')
  expect(messageCalls === 1, `F1-09 只发一次消息请求（实际 ${messageCalls} 次）`)
  expect(
    (await page.getByRole('button', { name: /^发送$|^Send$/ }).count()) > 0,
    'F1-09 回答结束后输入行回到「发送」态（没有卡在生成中）'
  )
  // 刷新后 Key 仍然在：不会再被要求输入（否则「清数据首启」只在第一次成立）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  expect(
    (await page.getByRole('dialog').count()) === 0,
    'F1-09 存下的 Key 在刷新后仍然生效（不再弹设置）'
  )
  await context.close()
} catch (error) {
  bad(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  await server.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}（1 条串行场景 / 3 条分支：F1-09 自动引导 + F1-09 存 Key 后能发 + F1-01 首屏可用）`)
}
