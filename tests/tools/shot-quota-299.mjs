// 手工一次性脚本（不参与分层执行）：为 Issue #299 出「额度不足」提示的 390 / 360 截图。
//
// 上游用 page.route 打桩成「额度用完」（429 + insufficient_quota，自有渠道 / OpenAI 协议链路），
// 页面是预构建标准产物，自起临时端口服务，不连外网。
//
//   node tests/tools/shot-quota-299.mjs
//   DIST_DIR=/private/artifacts/<commit>/standard node tests/tools/shot-quota-299.mjs
//
// 产物：docs/ui/quota299/quota-390x844.png / quota-360x780.png（外加 text.json 记录当时的界面文字）
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const OUT = path.join(ROOT, 'docs/ui/quota299')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const KEY = 'sk-shot-quota-299'

const server = await serveDist(DIST, { port: 0 })
const browser = await chromium.launch()
const shots = []

try {
  for (const [label, width, height] of [
    ['390x844', 390, 844],
    ['360x780', 360, 780],
  ]) {
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => window.localStorage.clear())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    await page.route(/\/models$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
      })
    })
    await page.route(/140\.210\.13\.146:60013/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customer_id: 'cus-mock', device_id: 'dev-mock' }),
      })
    })
    // 额度用完：网关把额度不足写成 429 + insufficient_quota
    await page.route(/\/v1\/chat\/completions$/, async (route) => {
      await route.fulfill({
        status: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            message: 'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      })
    })

    // 设置 → 数据管理 → 填 Key → 切到我们的渠道 → 关闭
    if ((await page.getByRole('dialog').count()) === 0) {
      await page.getByRole('button', { name: /设置|Settings/ }).last().click()
      await page.waitForTimeout(300)
    }
    await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
    await page.waitForSelector('input[type="password"]', { timeout: 3000 }).catch(() => {})
    await page.locator('input[type="password"]').first().fill(KEY)
    await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /渠道|Channel|服务类型|Service type/ }).first().click()
    await page.getByRole('option', { name: /我们的渠道|Our Channel/ }).first().click()
    await page.waitForTimeout(400)
    const dialog = page.getByRole('dialog').first()
    if ((await dialog.count()) > 0) {
      await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
      await page.waitForTimeout(400)
    }

    const textarea = page.locator('textarea').last()
    await textarea.click()
    await textarea.fill('帮我写一段自我介绍')
    await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
    await page.waitForTimeout(2500)

    const shot = path.join(OUT, `quota-${label}.png`)
    await page.screenshot({ path: shot, fullPage: false })
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    shots.push({ shot: path.relative(ROOT, shot), width, height, text })
    console.log(`ok  ${label} → ${path.relative(ROOT, shot)}`)
    console.log(`    界面文字 = ${JSON.stringify(text.slice(0, 200))}`)
    await context.close()
  }
  await fs.writeFile(
    path.join(OUT, 'text.json'),
    `${JSON.stringify(
      {
        device: 'Android Emulator API33（x86_64，非真实手机）',
        note: '额度不足提示：上游打桩为 429 + insufficient_quota（OpenAI 协议链路）',
        shots,
      },
      null,
      2
    )}\n`
  )
} finally {
  await browser.close()
  await server.close()
}
