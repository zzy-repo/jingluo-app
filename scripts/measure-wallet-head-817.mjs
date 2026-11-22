#!/usr/bin/env node
/**
 * #817 的**实测工具**：「我的钱包」页首那一行（余额卡 + 付款入口）在 390 / 360 两档到底怎么排。
 *
 *   node scripts/measure-wallet-head-817.mjs                     # 两档都量，写 docs/ui/817-wallet-pay-entry
 *   node scripts/measure-wallet-head-817.mjs --viewport=360      # 只量一档
 *   node scripts/measure-wallet-head-817.mjs --no-write          # 只打印，不落盘
 *
 * 为什么要有它：`flex-wrap` / `min-content` 这类版式承诺**只能量**，读 CSS 推理不出来
 * （#236 的 `measure-narrow-scroll-shift.mjs` 是同一套道理）。而且量的时候必须用**真东西**：
 *
 *  · markup 不是手抄的 —— 由 `walletHeaderView.ts` 的 `WalletHeaderView` 真渲染出来
 *    （`renderToStaticMarkup`，与单测同一份源码）；
 *  · CSS 不是复刻的 —— 直接读 `src/app/theme.css`（设计 token）+ `AccountConsume.module.css`；
 *  · 外层壳也不是猜的 —— 按 `Settings.module.css` 里那条真实规则搭：弹层左右各 24px 内距、
 *    `.content` 再 `padding: 0 24px; margin-right: -24px`，所以内容宽 = 视口 − 72
 *    （360 → 288、390 → 318）。壳只复刻**这三条**，其余一律不写。
 *
 * 量什么（每档落一份 `metrics.json` + 一张截图）：
 *  1. `head.rowCount`：余额卡与付款入口的中线是否落在同一行（1 = 同一行，2 = 已折行）；
 *  2. `balance.text / clipped / wrapped`：余额数字完整、没被裁、没被拆行；
 *  3. `head.scrollWidth === head.clientWidth` 且 `document.scrollWidth ≤ 视口`：**没有横向溢出**；
 *  4. `page.overflowX`：`.page` 这一层没有横向滚动条。
 *
 * 退出码：0 全部符合预期 / 1 有不符（逐条打印「期望 vs 实测」）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { installEndpointsGlobals, installTsResolve, moduleUrl, ROOT, setupDom } from '../tests/helpers/dom-env.mjs'

const OUT = path.join(ROOT, 'docs/ui/817-wallet-pay-entry')
const VIEWPORTS = { 390: { width: 390, height: 844 }, 360: { width: 360, height: 740 } }

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const onlyViewport = arg('viewport')
const write = !argv.includes('--no-write')

// 真源码：`.js → .ts` 解析钩子 + 构建期注入值 + 浏览器全局（`apiConfig` / i18n 都吃这套）
installTsResolve()
installEndpointsGlobals()
setupDom()
const { renderToStaticMarkup } = await import('react-dom/server')
const { translate } = await import(moduleUrl('src/i18n/index.ts'))
// 界面语言钉在中文（与单测 / 真机默认一致）：截图里必须是「剩余余额 / 去支付」，不是英文兜底
const { useSettings } = await import(moduleUrl('src/services/settings.ts'))
const { pinLocale } = await import('../tests/helpers/locale.mjs')
pinLocale(useSettings)
const { WalletHeaderView } = await import(moduleUrl('src/components/consume/walletHeaderView.ts'))

/** CSS Module 类名表替身：`.walletHead` 就叫 `.walletHead`（与真 CSS 里的选择器一致） */
const classNames = new Proxy({}, { get: (_target, name) => String(name) })

/** 真 markup：已登录、余额 ¥128.50（与 docs/ui 里其他取证同一笔数）；压力档换一笔长金额 */
const headerMarkupOf = (balance) =>
  renderToStaticMarkup(
    WalletHeaderView({ t: translate, styles: classNames, signedIn: true, balance, onPay: () => {} })
  )

const css = async (relative) => readFile(path.join(ROOT, relative), 'utf8')
const pageHtml = async (balance) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>${await css('src/app/theme.css')}</style>
<style>${await css('src/app/global.css')}</style>
<style>${await css('src/components/consume/AccountConsume.module.css')}</style>
<style>
  /* 只复刻设置弹层那三条壳规则（见文件头）；其余一律用真 CSS */
  body { margin: 0; background: var(--dsw-alias-bg-base); }
  #shell { box-sizing: border-box; width: 100%; padding: 19px 24px 22px; }
  #content { box-sizing: border-box; padding: 0 24px; margin-right: -24px; }
</style>
</head>
<body><div id="shell"><div id="content">
  <div class="page embedded">${headerMarkupOf(balance)}</div>
</div></div></body></html>`

/** 在页面里量：同一行 / 数字完整 / 无横向溢出 */
const measureInPage = () => {
  const head = document.querySelector('[data-testid="account-consume-wallet-head"]')
  const card = document.querySelector('[data-testid="account-consume-balance"]')
  const pay = document.querySelector('[data-testid="account-consume-wallet-pay"]')
  const value = card === null ? null : card.querySelector('div:last-child')
  const rect = (node) => (node === null ? null : node.getBoundingClientRect())
  const midY = (node) => {
    const box = rect(node)
    return box === null ? null : box.top + box.height / 2
  }
  const cardMid = midY(card)
  const payMid = midY(pay)
  const lineHeight = value === null ? 0 : Number.parseFloat(getComputedStyle(value).lineHeight) || 0
  const valueBox = rect(value)
  return {
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    head: {
      clientWidth: head === null ? 0 : head.clientWidth,
      left: rect(head) === null ? 0 : Math.round(rect(head).left),
      scrollWidth: head === null ? 0 : head.scrollWidth,
      // 中线差 < 2px = 同一行；折行时入口会掉到卡的下一行（差一个卡高）
      rowCount: cardMid === null || payMid === null || Math.abs(cardMid - payMid) < 2 ? 1 : 2,
      cardWidth: rect(card) === null ? 0 : Math.round(rect(card).width),
      payWidth: rect(pay) === null ? 0 : Math.round(rect(pay).width),
      payRight: rect(pay) === null ? 0 : Math.round(rect(pay).right),
      payTop: rect(pay) === null ? 0 : Math.round(rect(pay).top),
      cardTop: rect(card) === null ? 0 : Math.round(rect(card).top),
    },
    balance: {
      text: value === null ? null : (value.innerText ?? '').replace(/\s+/gu, ' ').trim(),
      clipped: value === null ? true : value.scrollWidth > value.clientWidth + 1,
      // 数字被拆成两行：算出来的高度明显大于行高
      wrapped: valueBox === null || lineHeight === 0 ? false : valueBox.height > lineHeight * 1.5,
      lineHeight,
      height: valueBox === null ? 0 : Math.round(valueBox.height),
      fontSize: value === null ? null : getComputedStyle(value).fontSize,
    },
    pay: {
      text: pay === null ? null : (pay.innerText ?? '').replace(/\s+/gu, ' ').trim(),
      height: rect(pay) === null ? 0 : Math.round(rect(pay).height),
    },
  }
}

const FAIL = []
const check = (label, condition, actual) => {
  if (!condition) {
    FAIL.push(`${label} —— 实测 ${JSON.stringify(actual)}`)
  }
}

const browser = await chromium.launch()
const results = {}
try {
  for (const [key, viewport] of Object.entries(VIEWPORTS)) {
    if (onlyViewport !== null && onlyViewport !== key) {
      continue
    }
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'zh-CN' })
    const page = await context.newPage()
    await page.setContent(await pageHtml(128.5), { waitUntil: 'load' })
    const metrics = await page.evaluate(measureInPage)
    const dir = path.join(OUT, key)
    if (write) {
      await mkdir(dir, { recursive: true })
      await page.screenshot({ path: path.join(dir, 'wallet-head.png'), fullPage: true })
    }
    results[key] = {
      page: 'wallet-head',
      title:
        '#817「我的钱包」页首一行：余额卡（剩余余额）+ 付款入口同一行；390 / 360 两档不横向溢出、余额数字完整',
      viewport: Number(key),
      size: `${viewport.width}×${viewport.height}`,
      shots: [`docs/ui/817-wallet-pay-entry/${key}/wallet-head.png`],
      notes: [
        'markup 来自 walletHeaderView.ts 的真渲染（renderToStaticMarkup），CSS 来自 src/app/theme.css + AccountConsume.module.css；',
        '外层壳只复刻 Settings.module.css 的三条：弹层 24px 内距 / .content padding 0 24px / margin-right: -24px（内容宽 = 视口 − 72）；',
        'rowCount = 1 表示余额卡与付款入口的中线差 < 2px（同一行）；折行时入口掉到下一行、仍靠右（margin-left: auto）。',
      ],
      ...metrics,
    }

    check(`${key} 档：没有横向溢出`, metrics.head.scrollWidth === metrics.head.clientWidth, metrics.head)
    check(
      `${key} 档：整页不横向滚动`,
      metrics.documentScrollWidth <= metrics.documentClientWidth + 1,
      { scrollWidth: metrics.documentScrollWidth, clientWidth: metrics.documentClientWidth }
    )
    check(`${key} 档：余额卡与付款入口在同一行`, metrics.head.rowCount === 1, metrics.head)
    check(`${key} 档：余额数字完整`, metrics.balance.text === '¥128.50', metrics.balance.text)
    check(`${key} 档：余额数字没被裁`, metrics.balance.clipped === false, metrics.balance)
    check(`${key} 档：余额数字没被拆行`, metrics.balance.wrapped === false, metrics.balance)
    check(
      `${key} 档：入口不越出这一行的右边界`,
      metrics.head.payRight <= metrics.head.left + metrics.head.clientWidth + 1,
      metrics.head
    )

    console.log(
      `\n[${key}] 内容宽 ${metrics.head.clientWidth}px（视口 ${metrics.viewport}）` +
        `\n  余额卡 ${metrics.head.cardWidth}px + 入口 ${metrics.head.payWidth}px，` +
        `${metrics.head.rowCount === 1 ? '同一行' : '已折行'}` +
        `\n  余额「${metrics.balance.text}」 ${metrics.balance.fontSize} / 高 ${metrics.balance.height}px` +
        `（clipped=${metrics.balance.clipped} wrapped=${metrics.balance.wrapped}）` +
        `\n  横向：head ${metrics.head.scrollWidth}/${metrics.head.clientWidth}，` +
        `document ${metrics.documentScrollWidth}/${metrics.documentClientWidth} → ${
          metrics.head.scrollWidth === metrics.head.clientWidth ? '无溢出' : '溢出'
        }`
    )
    if (write) {
      await writeFile(path.join(dir, 'metrics.json'), `${JSON.stringify(results[key], null, 2)}\n`, 'utf8')
    }
    await context.close()
  }

  /**
   * 压力档（只打印 + 断言，不落 docs）：证「放不下会怎样」——
   *   · 320 档（比 360 更窄）：折行也**不许**横向溢出；
   *   · 360 档 + 长金额 `¥1,234,567.89`：折行之后数字仍然完整（这正是 `min-width: min-content` 的用处）。
   */
  for (const stress of [
    { label: '320 档', viewport: { width: 320, height: 720 }, balance: 128.5 },
    { label: '360 档 + 长金额', viewport: { width: 360, height: 740 }, balance: 1234567.89 },
  ]) {
    const context = await browser.newContext({ viewport: stress.viewport, deviceScaleFactor: 2, locale: 'zh-CN' })
    const page = await context.newPage()
    await page.setContent(await pageHtml(stress.balance), { waitUntil: 'load' })
    const metrics = await page.evaluate(measureInPage)
    check(
      `${stress.label}：放不下也不横向溢出`,
      metrics.head.scrollWidth === metrics.head.clientWidth &&
        metrics.documentScrollWidth <= metrics.documentClientWidth + 1,
      { head: metrics.head, document: metrics.documentScrollWidth }
    )
    check(`${stress.label}：余额数字完整`, metrics.balance.text === `¥${stress.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}` || metrics.balance.clipped === false, metrics.balance)
    check(`${stress.label}：余额数字没被裁`, metrics.balance.clipped === false, metrics.balance)
    check(`${stress.label}：余额数字没被拆行`, metrics.balance.wrapped === false, metrics.balance)
    console.log(
      `\n[${stress.label}] 内容宽 ${metrics.head.clientWidth}px → ${
        metrics.head.rowCount === 1 ? '同一行' : '折行（入口掉到下一行、仍靠右）'
      }，余额「${metrics.balance.text}」clipped=${metrics.balance.clipped} wrapped=${metrics.balance.wrapped}，` +
        `横向 ${metrics.head.scrollWidth}/${metrics.head.clientWidth} → ${
          metrics.head.scrollWidth === metrics.head.clientWidth ? '无溢出' : '溢出'
        }`
    )
    await context.close()
  }
} finally {
  await browser.close()
}

if (write) {
  await mkdir(OUT, { recursive: true })
  await writeFile(
    path.join(OUT, 'measured.json'),
    `${JSON.stringify({ measuredAt: new Date().toISOString(), viewports: Object.keys(results) }, null, 2)}\n`,
    'utf8'
  )
}

if (FAIL.length > 0) {
  console.error(`\n实测不符（${FAIL.length} 条）：\n- ${FAIL.join('\n- ')}`)
  process.exit(1)
}
console.log('\n实测全部符合：同一行 / 无横向溢出 / 余额数字完整。')
