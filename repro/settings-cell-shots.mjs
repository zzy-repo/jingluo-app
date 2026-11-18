// 设置→数据「反馈与日志」行在窄视口下的实测：文本列宽度、标题是否竖排、动作区是否溢出。
// 用法: node repro/settings-cell-shots.mjs [outDir] [exePath]
// 只测量真实 Chromium 的 computed style / bounding box，不做任何 CSS 能力模拟。
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const out = process.argv[2] || new URL('./shots/', import.meta.url).pathname
const exe = process.argv[3] || undefined
const APP = process.env.APP_URL || 'http://127.0.0.1:5419'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: exe })
const rows = []
const LOCALE = process.env.LOCALE || 'zh-CN'
try {
  for (const [width, height] of [[390, 844], [360, 780]]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      locale: process.env.LOCALE || 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => window.localStorage.clear())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    if (!(await page.getByRole('dialog').count())) {
      await page.getByRole('button', { name: /边栏|菜单|sidebar|menu/i }).first().tap()
      await page.getByRole('button', { name: /设置|Settings/ }).last().tap()
      await page.waitForTimeout(300)
    }
    const dataTab = page.getByRole('tab', { name: /数据管理|Data/ }).first()
    if (await dataTab.count()) await dataTab.tap()
    await page.waitForTimeout(400)
    // 滚到底部，让「反馈与日志」进入视口
    await page.evaluate(() => {
      const panel = document.querySelector('[role="tabpanel"]')
      if (panel) panel.scrollTop = panel.scrollHeight
    })
    await page.waitForTimeout(300)

    const m = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /写反馈|Send feedback/.test(b.textContent || ''))
      const cell = btn?.closest('[class*="row-"]')
      if (!cell) return { error: 'feedback cell not found' }
      const r = (el) => {
        const b = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return {
          w: Math.round(b.width * 10) / 10,
          h: Math.round(b.height * 10) / 10,
          x: Math.round(b.x * 10) / 10,
          flex: `${s.flexGrow} ${s.flexShrink} ${s.flexBasis}`,
          minWidth: s.minWidth,
          wrap: s.flexWrap,
          padRight: s.paddingRight,
        }
      }
      const text = cell.querySelector('[class*="text"]')
      const actions = cell.querySelector('[class*="cellActions"]')
      const label = text?.querySelector('[class*="label"]')
      const panel = document.querySelector('[role="tabpanel"]')
      return {
        panelW: Math.round(panel.getBoundingClientRect().width),
        cell: r(cell),
        text: text ? r(text) : null,
        actions: actions ? r(actions) : null,
        label: label ? r(label) : null,
        labelLineCount: label
          ? Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight))
          : null,
        labelText: label?.textContent,
        buttons: [...cell.querySelectorAll('button')].map((b) => ({
          text: (b.textContent || '').trim(),
          w: Math.round(b.getBoundingClientRect().width),
          x: Math.round(b.getBoundingClientRect().x),
          y: Math.round(b.getBoundingClientRect().y),
        })),
        cellRight: Math.round(cell.getBoundingClientRect().right),
        allRows: [...document.querySelectorAll('[class*=" row-"]')].map((row) => {
          const t = row.querySelector('[class*="text-"]')
          const a = row.querySelector('[class*="cellActions-"]')
          const l = t?.querySelector('[class*="label-"]')
          const lh = l ? parseFloat(getComputedStyle(l).lineHeight) : 0
          const bb = row.getBoundingClientRect()
          return {
            label: (l?.textContent || '').slice(0, 18),
            textW: t ? Math.round(t.getBoundingClientRect().width) : null,
            labelLines: l && lh ? Math.round(l.getBoundingClientRect().height / lh) : null,
            actionsW: a ? Math.round(a.getBoundingClientRect().width) : null,
            rowW: Math.round(bb.width),
            rowH: Math.round(bb.height),
            overflowX: t ? Math.round(t.scrollWidth - t.clientWidth) : null,
          }
        }),
        docScrollW: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })
    await page.screenshot({ path: `${out}/${width}x${height}.png`, fullPage: false })
    rows.push({ viewport: `${width}x${height}`, ...m })
    await context.close()
  }
} finally {
  await browser.close()
}
const summary = { app: APP, locale: LOCALE, exe: exe || 'bundled', rows }
await writeFile(`${out}/metrics.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
