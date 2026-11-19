// #388 修复前后对照探针（一次性，不进仓库）：选 .txt / 假图，看提示与预览
import { chromium } from 'playwright'
import { serveDist } from '../tests/helpers/runtime.mjs'

const DIST = process.argv[2]
const OUT = process.argv[3]
const settled = (page) => page.waitForTimeout(900)

const openFeedback = async (page, url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await settled(page)
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await settled(page)
  const tab = page.getByRole('tab', { name: /数据管理|Data/ })
  if ((await tab.count()) > 0) await tab.first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  await settled(page)
  return page.getByRole('dialog').last()
}

const toasts = async (page) =>
  (await page.locator('[role="status"]').allInnerTexts()).map((t) => t.trim()).filter(Boolean)

const served = await serveDist(DIST)
const browser = await chromium.launch()
const out = []
for (const [label, file] of [
  ['txt', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not an image', 'utf8') }],
  ['fake-png', { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image', 'utf8') }],
]) {
  for (const vp of [{ w: 390, h: 844 }, { w: 360, h: 740 }]) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const form = await openFeedback(page, served.url)
    await form.getByText('截图（可选）').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await form.locator('input[type="file"]').setInputFiles(file)
    await page.waitForTimeout(700)
    const previews = await form.locator('img').count()
    const toastTexts = (await toasts(page)).filter((t) => !/^deepseek-/.test(t))
    const note = `${vp.w} ${label}: 提示=${JSON.stringify(toastTexts)} 预览数=${previews}`
    console.log(note)
    out.push(note)
    await page.screenshot({ path: `${OUT}/${vp.w}-${label}.png` })
    await context.close()
  }
}
await browser.close()
await served.close()
