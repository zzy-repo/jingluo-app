// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 上游把网页当接口数据返回（200 + text/html）时，必须给出明确错误
// 「上游返回的是网页而不是数据，通常是网关或代理出错」，并且绝不能把 HTML 渲染进消息气泡。
//
// #434（本用例的 known-red 归零）：改前这条失败落进「空响应」档，页面文本是
// 「上游这次没有返回任何内容（空响应）…可以重试」，并且被自动重试了 3 次
// （同一份 HTML 重发几次都一样）。现在单独成 html 档：文案可达、不重试、
// 折叠区里给响应摘要（content-type + 正文前 200 字）。
//
// 跑法：node tests/run-layer.mjs integration --case upstream-html.test.mjs
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
  sendChat,
  stubModels,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/upstream-html.test.mjs'
const KEY = 'sk-testkey-html'
const HTML = '<!doctype html><html><head><title>Sub2API - AI API Gateway</title></head><body>SUB2API_GATEWAY_HTML</body></html>'
const { browser, page } = await openApp()
const failures = []
const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}
try {
  await stubModels(page)
  // 上游返回网页：200 + text/html，正文是 HTML 文档
  await page.route(/\/anthropic\/v1\/messages$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: HTML,
    })
  })
  const requests = capturePaths(page)
  const messageCalls = () =>
    requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/messages')).length

  await openSettingsDataSection(page)
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await page.waitForTimeout(500)
  await closeSettings(page)

  await sendChat(page, '你好')
  await waitFor(() => messageCalls() > 0)
  await page.waitForTimeout(2500)

  // 文案要说人话：上游返回的是网页而不是数据（#434 的验收口径）
  const hint = page.getByText(/上游返回的是网页而不是数据/)
  if ((await hint.count()) === 0) {
    failures.push('界面上没有出现「上游返回的是网页而不是数据…」的错误提示')
  } else {
    console.log(`ok: 错误提示 = ${JSON.stringify((await hint.first().innerText()).trim())}`)
  }

  // 同一份 HTML 重发几次都一样：这条失败是终态，不能白重试
  if (messageCalls() !== 1) {
    failures.push(`回答请求次数应为 1（终态、不重试），实际 ${messageCalls()}`)
  }

  // 折叠区：默认收起，**展开后**能看到 content-type 与正文前 200 字（响应摘要）
  const fold = page.getByTestId('notice-upstream')
  if ((await fold.count()) === 0) {
    failures.push('错误提示里没有「上游原文 / 响应摘要」的折叠区')
  } else {
    if (await fold.first().evaluate((node) => node.hasAttribute('open'))) {
      failures.push('折叠区必须默认收起（一屏 HTML 不能糊在界面上）')
    }
    await fold.first().locator('summary').first().click()
    await page.waitForTimeout(200)
    const summary = await fold.first().innerText()
    for (const needle of ['content-type', 'text/html', 'SUB2API_GATEWAY_HTML']) {
      if (!summary.includes(needle)) {
        failures.push(`折叠区的响应摘要里缺少 ${JSON.stringify(needle)}`)
      }
    }
    console.log(`ok: 折叠区响应摘要 = ${JSON.stringify(summary.replace(/\s+/g, ' ').trim())}`)
  }

  // HTML 不能出现在消息气泡里（折叠区里那份**响应摘要**是给人核对的，不算渲染：
  // 它默认收起，且内容是 content-type + 前 200 字，不是可执行的 HTML 文档）
  const foldText = (await fold.count()) > 0 ? await fold.first().innerText() : ''
  const body = (await page.locator('body').innerText()).split(foldText).join('')
  for (const needle of ['SUB2API_GATEWAY_HTML', '<!doctype', 'AI API Gateway']) {
    if (body.includes(needle)) {
      failures.push(`HTML 被渲染进页面：出现了 ${JSON.stringify(needle)}`)
    }
  }
  if (!body.includes('上游返回的是网页而不是数据')) {
    failures.push('页面文本里找不到「上游返回的是网页而不是数据」')
  }
  if (body.includes('空响应')) {
    failures.push('不许再说成「空响应」：那是上游什么都没给的那一档（#324），不是「返回了网页」')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
