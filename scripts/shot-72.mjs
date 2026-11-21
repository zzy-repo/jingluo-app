// 临时截图脚本（Issue #72）：Playwright Chromium 390 / 360，浏览器视口尺寸，不是真机。
import { chromium } from 'playwright'
import fs from 'node:fs'

import { matrixConfig, viewportFor } from './compat/lib/matrix-config.mjs'

const OUT = 'docs/ui/redeem-migrate'
fs.mkdirSync(OUT, { recursive: true })

const KEY = 'sk-ours-demo-1234567890abcdef'
const DEVICE = 'd-0123456789abcdef0123456789abcdef'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
  headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
})

const PROFILE = {
  device_id: DEVICE,
  key: KEY,
  api_key: KEY,
  remaining_points: 1280,
  total_points: 5000,
  used_points: 3720,
  invite_code: 'MUSE72',
  invite_count: 2,
  created_at: '2026-11-01T00:00:00Z',
}

const PLANS = {
  plans: [
    { id: 'p1', name: '入门包 100万 token', price: 0.1, points: 300, currency: 'CNY', enabled: true },
    { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
  ],
}

const run = async (width, height, tag) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  })
  await context.addInitScript(
    ({ key, device }) => {
      localStorage.setItem('chat-demo:provider-kind', 'ours')
      localStorage.removeItem('chat-demo:ours-device-backup-hint-seen')
      localStorage.setItem('chat-demo:ours-device-id', device)
    },
    { key: KEY, device: DEVICE }
  )
  const page = await context.newPage()
  // 只拦支付那套后端（截图用固定报文，不代表真实服务返回）。
  // #745 第二步：这里原来还拦 `inviteBaseUrl` 那台邀请服 —— 该服务已下线（#604 迁到 consume），
  // 客户端不再有调用点，路由桩一并删掉（顺带去掉产物里 `:60013` 的来源）。
  await context.route('https://apia.ecsafe.cn/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/plans')) return route.fulfill(json(200, PLANS))
    return route.fulfill(json(404, { code: 'NOT_FOUND', message: 'no route' }))
  })

  await page.goto('http://localhost:8095/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // 首次启动没有 Key：应用会自动展开设置并自动领取（mock 的 /apply 给了 Key），
  // 等「我们的渠道」入口出现后点开
  await page.waitForSelector('[data-testid="ours-services-open"]', { timeout: 10000 })
  await page.click('[data-testid="ours-services-open"]')
  await page.waitForSelector('[data-testid="ours-device-backup-hint"]', { timeout: 10000 })

  // 输入卡密并兑换：202 处理中
  await page.waitForFunction(
    () => document.querySelector('[data-testid="ours-redeem-submit"]')?.disabled === false,
    null,
    { timeout: 15000 }
  )
  await page.fill('[data-testid="ours-redeem-input"]', 'MUSE-8f3a-9b7c-2d44-71bb')
  await page.click('[data-testid="ours-redeem-submit"]')
  await page.waitForSelector('[data-testid="ours-redeem-refresh"]', { timeout: 10000 })
  await page.waitForTimeout(400)

  const dialog = page.locator('[data-testid="ours-services-dialog"]')
  await dialog.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${OUT}/72-ours-${tag}-full.png`, fullPage: false })
  await dialog.screenshot({ path: `${OUT}/72-ours-${tag}-dialog.png` })
  const text = await dialog.innerText()
  fs.writeFileSync(`${OUT}/72-ours-${tag}-dialog.txt`, `${width}x${height}\n\n${text}\n`)
  await browser.close()
  return text
}

// 档位 / 视口来自 scripts/compat/matrix.config.json（captureWidths / captureHeights）：视口数值与
// 改动前一致（390×844、360×800），只是不再写死在这条脚本里（issue #278）。
const CONFIG = matrixConfig()
const shots = []
for (const width of CONFIG.captureWidths) {
  const viewport = viewportFor(CONFIG, width)
  shots.push({ tag: String(width), text: await run(viewport.width, viewport.height, String(width)) })
}
for (const { tag, text } of shots) {
  console.log(`${tag} has backup hint:`, text.includes('设备码就是你的账号凭据'))
  console.log(`${tag} has processing:`, text.includes('兑换处理中，稍后自动到账'))
}
