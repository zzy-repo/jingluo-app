// 「反馈与日志」行塌陷的机制取证：在同一台真实 Chromium 上，逐个只改一个变量，
// 量出文本列的宽度 / 标题行数 / 是否横向溢出，用来判定到底是
//   (a) flex-basis 为 0 + min-width:0（文本列对行基准尺寸零贡献，只能吃剩余空间）
//   (b) min-content 太小（overflow-wrap:anywhere + word-break:break-word 让最小内容宽 = 1 个字符）
//   (c) 行不允许换行（nowrap 让动作区不能整行下移）
// 哪一项在起作用。不做任何 CSS 能力模拟，读的是 getBoundingClientRect()。
//
// 用法: APP_URL=http://127.0.0.1:8090 node repro/settings-cell-mechanism.mjs [outJson]
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const out = process.argv[2] || new URL('./mechanism.json', import.meta.url).pathname
const APP = process.env.APP_URL || 'http://127.0.0.1:8090'
const VARIANTS = [
  ['baseline', ''],
  ['text-min-width-96px', '[class*="text-"]{min-width:96px !important}'],
  ['text-flex-1-1-40%', '[class*="text-"]{flex:1 1 40% !important}'],
  ['text-flex-basis-auto', '[class*="text-"]{flex:1 1 auto !important}'],
  ['text-no-anywhere', '[class*="text-"]{overflow-wrap:normal !important;word-break:normal !important}'],
  ['row-flex-wrap', '[class*="row-"]{flex-wrap:wrap !important}'],
  ['actions-full-row', '[class*="row-"]{flex-wrap:wrap !important}[class*="cellActions-"]{flex:1 0 100% !important}'],
]

const browser = await chromium.launch({ headless: true })
const version = browser.version()
const context = await browser.newContext({
  viewport: { width: 360, height: 780 },
  isMobile: true,
  hasTouch: true,
  locale: 'en-US',
  reducedMotion: 'reduce',
})
const page = await context.newPage()
await page.goto(APP, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => window.localStorage.clear())
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
if (!(await page.getByRole('dialog').count())) {
  await page.getByRole('button', { name: /sidebar|menu|边栏|菜单/i }).first().tap()
  await page.getByRole('button', { name: /Settings|设置/ }).last().tap()
  await page.waitForTimeout(300)
}
const dataTab = page.getByRole('tab', { name: /Data|数据管理/ }).first()
if (await dataTab.count()) await dataTab.tap()
await page.waitForTimeout(400)
await page.evaluate(() => {
  const panel = document.querySelector('[role="tabpanel"]')
  if (panel) panel.scrollTop = panel.scrollHeight
})
await page.waitForTimeout(300)

const measure = () =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /Send feedback|写反馈/.test(b.textContent || ''))
    const cell = btn?.closest('[class*="row-"]')
    const text = cell?.querySelector('[class*="text"]')
    const actions = cell?.querySelector('[class*="cellActions"]')
    const label = text?.querySelector('[class*="label"]')
    if (!cell || !text) return { error: 'not found' }
    const contentSize = (el, value) => {
      const clone = el.cloneNode(true)
      clone.style.cssText += `;position:absolute;left:-9999px;top:0;width:${value};height:auto;visibility:hidden`
      document.body.append(clone)
      const w = clone.getBoundingClientRect().width
      clone.remove()
      return Math.round(w * 10) / 10
    }
    const lh = label ? parseFloat(getComputedStyle(label).lineHeight) : 0
    return {
      rowW: Math.round(cell.getBoundingClientRect().width * 10) / 10,
      rowWrap: getComputedStyle(cell).flexWrap,
      textW: Math.round(text.getBoundingClientRect().width * 10) / 10,
      textFlex: getComputedStyle(text).flex,
      textMinWidth: getComputedStyle(text).minWidth,
      textPadRight: getComputedStyle(text).paddingRight,
      textMinContent: contentSize(text, 'min-content'),
      textMaxContent: contentSize(text, 'max-content'),
      actionsW: Math.round((actions?.getBoundingClientRect().width || 0) * 10) / 10,
      actionsMaxContent: actions ? contentSize(actions, 'max-content') : null,
      labelLines: label && lh ? Math.round(label.getBoundingClientRect().height / lh) : null,
      buttons: [...cell.querySelectorAll('button')].map((b) => ({
        text: (b.textContent || '').trim(),
        w: Math.round(b.getBoundingClientRect().width * 10) / 10,
        y: Math.round(b.getBoundingClientRect().y),
      })),
      textOverflowX: Math.round(text.scrollWidth - text.clientWidth),
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })

const results = []
for (const [name, css] of VARIANTS) {
  await page.evaluate(() => {
    const old = document.getElementById('exp-style')
    if (old) old.remove()
  })
  if (css) await page.addStyleTag({ content: `#exp-style-placeholder{}${css}`, })
  if (css) await page.evaluate(() => {
    const tags = [...document.querySelectorAll('style')]
    const last = tags[tags.length - 1]
    if (last) last.id = 'exp-style'
  })
  await page.waitForTimeout(150)
  results.push({ variant: name, css: css || '(none)', ...(await measure()) })
}
await browser.close()
const summary = { chromium: version, viewport: '360x780', locale: 'en-US', app: APP, results }
await writeFile(out, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
