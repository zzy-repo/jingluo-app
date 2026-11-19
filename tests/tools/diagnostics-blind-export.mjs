// 盲测导出：制造一个真实故障（断网发消息），走完整反馈流程，把**真正会发出去的 body**
// 落到 /tmp/feedback-blind.json & /tmp/feedback-blind.log，用于「只看这份 JSON 能否定位问题」的盲评。
//
//   cd /root/deepseek-app && node tests/tools/diagnostics-blind-export.mjs
//
// 说明：反馈请求本身被 page.route 截获（不回真后端），所以我们拿到的是逐字节的上传内容。
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

import { feedbackUrl } from '../../scripts/lib/endpoints.mjs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const FEEDBACK_URL = feedbackUrl
const OUT_JSON = process.env.OUT_JSON || '/tmp/feedback-blind.json'
const OUT_LOG = process.env.OUT_LOG || '/tmp/feedback-blind.log'

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
const page = await context.newPage()

// 故障注入：上游请求直接断网（模拟地铁里/弱网下点发送）
await page.route('**/v1/messages', (route) => route.abort('internetdisconnected'))
// 反馈上传拦下来，只为取样（不发真后端）
let captured = null
await page.route(`${FEEDBACK_URL}*`, async (route) => {
  captured = route.request().postData() ?? ''
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, id: 'blind-export-only', logSize: Buffer.byteLength(JSON.parse(captured).log, 'utf8') }),
  })
})

await page.goto(`${APP_URL}?diag-debug=1`, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => {
  window.localStorage.clear()
  window.localStorage.setItem('chat-demo:api-key', 'sk-blind-test-key-0123456789')
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__diagnostics), null, { timeout: 10000 })
await page.waitForTimeout(800)

// 真实故障：断网状态下发一条消息
const textarea = page.locator('textarea').last()
await textarea.click()
await textarea.fill('断网测试：点发送后一直转圈')
await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
await page.waitForTimeout(3000)

// 用户看到问题后提交反馈
if ((await page.getByRole('dialog').count()) === 0) {
  await page.getByRole('button', { name: /设置|Settings/ }).last().click()
}
await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /写反馈/ }).first().click()
await page.waitForTimeout(400)
const form = page.getByRole('dialog').last()
await form.locator('textarea').first().fill('地铁里断网时点发送，一直转圈，没有任何错误提示')
await form.locator('#feedback-contact').fill('tester@example.com')
await form.getByRole('button', { name: /^提交$/ }).first().click()
await page.waitForTimeout(2500)

await browser.close()

if (!captured) {
  console.error('没有截获到反馈请求，导出失败')
  process.exit(1)
}
const body = JSON.parse(captured)
writeFileSync(OUT_JSON, JSON.stringify(body, null, 2))
writeFileSync(OUT_LOG, body.log)
console.log(`已导出：${OUT_JSON}（body ${Buffer.byteLength(captured)} 字节）`)
console.log(`log 原文：${OUT_LOG}（${Buffer.byteLength(body.log, 'utf8')} 字节）`)
console.log(`字段：${Object.keys(body).join(',')}`)
console.log(`content：${body.content}`)
