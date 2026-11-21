#!/usr/bin/env node
/**
 * #727 阶段 3「我的卡密 / 历史消费 两屏照原型落版」的截图与断言工具。
 *
 *   node scripts/shot-727-wallet-lists.mjs
 *   node scripts/shot-727-wallet-lists.mjs --base=http://127.0.0.1:8099/ --viewport=390
 *   node scripts/shot-727-wallet-lists.mjs --proto=wt-727/proto/服务Tab.html   # 多出「与原型并排」那两张
 *
 * 与 `scripts/shot-727-wallet-card.mjs` 同一套做法：**直接打开正在跑的 dev server**（默认 8099），
 * 点真实入口「设置 → 账户与消费 → 我的钱包 → 我的卡密 / 历史消费」再截 —— 维护者那一刻看到的
 * 就是这张图，改完保存后重跑本脚本即可复现。
 *
 * 这一屏不需要登录，也不需要任何桩：
 *   - 数据来自 `src/components/consume/__mock__/walletDemo.ts`，开关是 **dev 构建 +
 *     URL 带 `?mock=1`**（未登录也会用 mock），所以脚本只把 `?mock=1` 挂在地址上；
 *   - 因此消费层**一个请求都不发**（没有 CapacitorHttp 也不是问题），`consoleErrors` 一直是 `[]`。
 *
 * 断言（任一不成立就 exit 1，不是 warn）：
 *   1. 卡密文本形如 `••••` + 4 位（`••••RRQY` / `••••A3SR` / `••••JP9Q`）；
 *   2. 徽标文案只有 `已兑换` / `未兑换`（已兑换那张的「去兑换」是 disabled）；
 *   3. 「复制卡密」复制的是**完整卡号**（拦 `document.execCommand('copy')` 读回来，不是掩码）；
 *   4. 金额匹配 `/^-¥\d+\.\d{2}$/`，`font-variant-numeric: tabular-nums`；
 *   5. 分组标题存在且是「今天 / 昨天 / M月D日」；
 *   6. `overflowCount === 0`、`consoleErrors === []`（两个视口、两屏全部）。
 *
 * 产出（默认 `docs/ui/727-wallet-lists/`）：
 *   {390,360}/cards.png · {390,360}/history.png
 *   prototype-cards-375.png · prototype-history-375.png（给了 `--proto` 才有）
 *   compare-cards-390.png · compare-history-390.png（左原型 375 / 右实现 390）
 *   metrics.json（上面六条断言的实测值）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}

/** 入口文案（与 `src/i18n/zh.ts` 同步；脚本不 import 源码，免得为一张图拉整包 TS） */
const T = {
  settings: '设置',
  openSider: '打开边栏',
  walletRow: '我的钱包',
}

/** 原型那一屏的窗口尺寸（原型 `.phone` 是 375×812） */
const PROTO_VIEWPORT = { width: 375, height: 812 }

/** 与 `__mock__/walletDemo.ts` 一致的期望值（脚本里再写一遍：断言不能只信被测代码自己的常量） */
const EXPECT = {
  cards: [
    { code: '••••RRQY', badge: '已兑换', meta: '入门包 5 元额度 2026-11-18', full: 'RRQY' },
    { code: '••••A3SR', badge: '已兑换', meta: '新人特惠 1 元额度 2026-11-18', full: 'A3SR' },
    { code: '••••JP9Q', badge: '未兑换', meta: '入门包 5 元额度 2026-11-17', full: 'JP9Q' },
  ],
  amounts: ['-¥0.12', '-¥0.20', '-¥0.36', '-¥0.05', '-¥0.08'],
  times: ['14:32', '11:08', '21:08', '09:41', '09:15'],
  firstGroups: ['今天', '昨天'],
}

const parseArgs = (argv) => {
  const options = {
    base: 'http://100.113.135.55:8099/',
    out: 'docs/ui/727-wallet-lists',
    viewports: ['390', '360'],
    proto: '',
  }
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg)
    if (match === null) {
      throw new Error(`不认识的参数：${arg}（用法：--base=… --out=… --viewport=390,360 --proto=<原型 html>）`)
    }
    const [, key, value = ''] = match
    if (key === 'base') {
      options.base = value.trim()
    } else if (key === 'out') {
      options.out = value.trim()
    } else if (key === 'viewport' || key === 'viewports') {
      options.viewports = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    } else if (key === 'proto') {
      options.proto = value.trim()
    } else {
      throw new Error(`不认识的参数：--${key}`)
    }
  }
  for (const key of options.viewports) {
    if (VIEWPORTS[key] === undefined) {
      throw new Error(`不支持的视口：${key}（只有 390 / 360）`)
    }
  }
  return options
}

/**
 * 把「复制」这一步截下来：非安全上下文（`http://100.113.135.55:8099`）里没有 `navigator.clipboard`，
 * 产品代码走的是 `document.execCommand('copy')` 的 textarea 兜底 —— 拦这一步就能读回**真正被复制的那串**。
 * 两条路径都拦，省得以后本机换成 localhost（安全上下文）就断言不到。
 */
const clipboardSpy = () => {
  window.__copied = []
  const original = document.execCommand.bind(document)
  document.execCommand = (command) => {
    if (command === 'copy') {
      const active = document.activeElement
      window.__copied.push(active !== null && 'value' in active ? String(active.value) : '')
      return true
    }
    return original(command)
  }
  if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = (text) => {
      window.__copied.push(String(text))
      return write(text)
    }
  }
}

/**
 * 打开「设置 → 账户与消费 → 我的钱包」。
 *
 * 窄屏下侧边栏是收起的（`设置` 按钮不在视口里），所以先按 aria-label 找，找不到再点「打开边栏」。
 */
const openWalletPage = async (page) => {
  const entry = page.getByTestId('account-consume-open')
  if (!(await entry.isVisible().catch(() => false))) {
    const settings = page.getByRole('button', { name: T.settings, exact: true })
    if (!(await settings.isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: T.openSider })
      await menu.waitFor({ state: 'visible', timeout: 15000 })
      await menu.click()
      await page.waitForTimeout(320)
    }
    await page.getByRole('button', { name: T.settings, exact: true }).click()
    await page.getByRole('tab', { name: '通用设置' }).waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(250)
  }
  await entry.click()
  await page.locator('[data-testid="account-consume-page"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(250)
  await page.getByTestId('account-consume-wallet').click()
  await page.getByTestId('account-consume-tab-cards').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(250)
}

/** 横向溢出（#106 口径）：`overflowCount` 必须为 0 */
const measureOverflow = (page) =>
  page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const overflow = []
    for (const element of document.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.right > viewportWidth + 1) {
        overflow.push({ tag: element.tagName, right: Math.round(rect.right), text: (element.textContent ?? '').slice(0, 24) })
      }
    }
    return {
      viewportWidth,
      documentScrollWidth: Math.round(document.documentElement.scrollWidth),
      overflowCount: overflow.length,
      overflowSamples: overflow.slice(0, 5),
    }
  })

/** 卡密那一屏的 DOM 实测（文本 + 两个徽标 + 卡片几何 + 按钮几何） */
const readCards = (page) =>
  page.evaluate(() => {
    const text = (node) => (node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim())
    const rows = Array.from(document.querySelectorAll('[data-testid="account-consume-card-row"]'))
    const style = (node) => (node === null ? null : getComputedStyle(node))
    const card = rows[0] ?? null
    const code = document.querySelector('[data-testid="account-consume-card-code"]')
    const badge = document.querySelector('[data-testid="account-consume-card-badge"]')
    const copy = document.querySelector('[data-testid="account-consume-card-copy"]')
    const redeem = document.querySelector('[data-testid="account-consume-card-redeem"]')
    const cardStyle = style(card)
    const codeStyle = style(code)
    const badgeStyle = style(badge)
    const copyStyle = style(copy)
    const redeemStyle = style(redeem)
    const box = (node) => (node === null ? null : node.getBoundingClientRect())
    const rowGap = rows.length > 1 ? Math.round(box(rows[1]).top - box(rows[0]).bottom) : null
    return {
      rowCount: rows.length,
      codes: Array.from(document.querySelectorAll('[data-testid="account-consume-card-code"]')).map(text),
      badges: Array.from(document.querySelectorAll('[data-testid="account-consume-card-badge"]')).map(text),
      metas: Array.from(document.querySelectorAll('[data-testid="account-consume-card-row"]')).map((node) =>
        text(node).replace(/复制卡密|去兑换/gu, '').trim()
      ),
      rows: rows.map(text),
      redeemDisabled: Array.from(document.querySelectorAll('[data-testid="account-consume-card-redeem"]')).map(
        (node) => node.disabled
      ),
      cardPadding: cardStyle === null ? null : cardStyle.padding,
      cardRadius: cardStyle === null ? null : cardStyle.borderRadius,
      cardBorderWidth: cardStyle === null ? null : cardStyle.borderTopWidth,
      cardBorderColor: cardStyle === null ? null : cardStyle.borderTopColor,
      cardGap: rowGap,
      codeFontSize: codeStyle === null ? null : codeStyle.fontSize,
      codeFontWeight: codeStyle === null ? null : codeStyle.fontWeight,
      codeLetterSpacing: codeStyle === null ? null : codeStyle.letterSpacing,
      badgeRadius: badgeStyle === null ? null : badgeStyle.borderRadius,
      badgeBackgroundUsed: badgeStyle === null ? null : badgeStyle.backgroundColor,
      badgeColorUsed: badgeStyle === null ? null : badgeStyle.color,
      copyHeight: box(copy) === null ? null : Math.round(box(copy).height),
      copyRadius: copyStyle === null ? null : copyStyle.borderRadius,
      copyBorderWidth: copyStyle === null ? null : copyStyle.borderTopWidth,
      copyBackground: copyStyle === null ? null : copyStyle.backgroundColor,
      redeemHeight: box(redeem) === null ? null : Math.round(box(redeem).height),
      redeemRadius: redeemStyle === null ? null : redeemStyle.borderRadius,
      redeemBackground: redeemStyle === null ? null : redeemStyle.backgroundColor,
      redeemOpacity: redeemStyle === null ? null : redeemStyle.opacity,
    }
  })

/** 历史消费那一屏的 DOM 实测（分组标题 + 五条记录） */
const readHistory = (page) =>
  page.evaluate(() => {
    const text = (node) => (node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim())
    const rows = Array.from(document.querySelectorAll('[data-testid="account-consume-history-row"]'))
    const amounts = Array.from(document.querySelectorAll('[data-testid="account-consume-history-amount"]'))
    const groups = Array.from(document.querySelectorAll('[data-testid="account-consume-history-group"]'))
    const amountStyle = amounts[0] === undefined ? null : getComputedStyle(amounts[0])
    const rowStyle = rows[0] === undefined ? null : getComputedStyle(rows[0])
    return {
      rowCount: rows.length,
      groups: groups.map(text),
      groupFontSize: groups[0] === undefined ? null : getComputedStyle(groups[0]).fontSize,
      groupColor: groups[0] === undefined ? null : getComputedStyle(groups[0]).color,
      rows: rows.map(text),
      names: rows.map((node) => text(node.querySelector('div > div'))),
      times: rows.map((node) => text(node.querySelector('div > div + div'))),
      amounts: amounts.map(text),
      amountFontSize: amountStyle === null ? null : amountStyle.fontSize,
      amountFontWeight: amountStyle === null ? null : amountStyle.fontWeight,
      amountFontVariantNumeric: amountStyle === null ? null : amountStyle.fontVariantNumeric,
      rowPadding: rowStyle === null ? null : rowStyle.padding,
      rowBorderWidth: rowStyle === null ? null : rowStyle.borderTopWidth,
      emptyState: document.querySelector('[data-testid="account-consume-history-empty"]') !== null,
    }
  })

/** 原型截图：原型是纯静态 HTML（`S` 是全局状态 + `render()`），切屏只改一个字段 */
const shotPrototype = async (browser, protoPath, outDir) => {
  const context = await browser.newContext({
    viewport: PROTO_VIEWPORT,
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  await page.goto(`file://${protoPath}`, { waitUntil: 'domcontentloaded' })
  const shots = {}
  for (const screen of ['cards', 'history']) {
    await page.evaluate((target) => {
      // 原型的两屏在同一个 `S` 状态机上；`render()` 把 `#app` 整块重绘。
      // `S` 是原型里顶层的 `const`（全局词法绑定，不在 `globalThis` 上），所以按名字直接取。
      // eslint-disable-next-line no-undef
      S.screen = target
      render()
    }, screen)
    await page.waitForTimeout(120)
    const file = path.join(outDir, `prototype-${screen}-375.png`)
    await page.locator('#app').screenshot({ path: file })
    shots[screen] = file
  }
  await context.close()
  return shots
}

/** 左原型 / 右实现 的并排图（纯 HTML 拼一张，不引入图像库） */
const composeCompare = async (browser, { left, right, leftLabel, rightLabel, out }) => {
  const dataUrl = async (file) =>
    `data:image/png;base64,${(await readFile(file)).toString('base64')}`
  const context = await browser.newContext({ viewport: { width: 1140, height: 1200 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.setContent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><style>
  body { margin: 0; background: #ededed; font: 14px/20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #111114; }
  .wrap { display: inline-block; padding: 24px; background: #ededed; }
  .row { display: flex; align-items: flex-start; }
  .col { width: 375px; }
  .col + .col { margin-left: 24px; }
  .cap { margin: 0 0 10px; font-size: 13px; color: #6b6b70; }
  .col img { display: block; width: 375px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08); }
</style></head>
<body><div class="wrap"><div class="row">
  <div class="col"><p class="cap">${leftLabel}</p><img src="${await dataUrl(left)}" /></div>
  <div class="col"><p class="cap">${rightLabel}</p><img src="${await dataUrl(right)}" /></div>
</div></div></body></html>`)
  await page.waitForTimeout(250)
  // 只截内容（不截整个视口）：比对图上下不要留一大片空底色
  await page.locator('.wrap').screenshot({ path: out })
  await context.close()
}

const run = async () => {
  const options = parseArgs(process.argv.slice(2))
  const outRoot = path.resolve(ROOT, options.out)
  const metrics = { base: options.base, viewports: {}, consoleErrors: [], overflowCount: 0, states: {}, asserts: {} }

  const browser = await chromium.launch({ args: ['--force-device-scale-factor=2'] })
  const url = `${options.base.replace(/\/$/u, '')}/?mock=1`

  for (const key of options.viewports) {
    const viewport = VIEWPORTS[key]
    const dir = path.join(outRoot, key)
    await mkdir(dir, { recursive: true })

    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'zh-CN' })
    const errors = []
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text())
      }
    })
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    await page.addInitScript(clipboardSpy)

    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30000 })
    await openWalletPage(page)

    // ---------------- 我的卡密 ----------------
    await page.getByTestId('account-consume-tab-cards').click()
    await page.getByTestId('account-consume-card-row').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, 'cards.png') })

    const cards = await readCards(page)
    const cardsOverflow = await measureOverflow(page)

    // 「复制卡密」复制的必须是完整卡号（不是掩码）：拦下 execCommand 读回真正被写进去的那串
    await page.getByTestId('account-consume-card-copy').first().click()
    await page.waitForTimeout(200)
    const copied = await page.evaluate(() => window.__copied ?? [])
    // 收起 toast（3s）再往下走，免得它盖在下一张图上
    await page.waitForTimeout(3200)

    metrics.states[`${key}/cards`] = { screenshot: `${key}/cards.png`, ...cards, copied, ...cardsOverflow, consoleErrors: errors }

    if (cardsOverflow.overflowCount !== 0) {
      throw new Error(`${key}/cards：横向溢出 ${cardsOverflow.overflowCount} 处 ${JSON.stringify(cardsOverflow.overflowSamples)}`)
    }
    if (cards.rowCount !== EXPECT.cards.length) {
      throw new Error(`${key}/cards：卡片应为 ${EXPECT.cards.length} 张，实际 ${cards.rowCount}`)
    }
    cards.codes.forEach((code, index) => {
      if (!/^••••[A-Z0-9]{4}$/u.test(String(code))) {
        throw new Error(`${key}/cards：第 ${index + 1} 张卡密不是「••••+4 位」：${JSON.stringify(code)}`)
      }
      if (code !== EXPECT.cards[index].code) {
        throw new Error(`${key}/cards：第 ${index + 1} 张卡密应为 ${EXPECT.cards[index].code}，实际 ${code}`)
      }
    })
    cards.badges.forEach((badge, index) => {
      if (badge !== EXPECT.cards[index].badge) {
        throw new Error(`${key}/cards：第 ${index + 1} 张徽标应为 ${EXPECT.cards[index].badge}，实际 ${badge}`)
      }
    })
    if (cards.redeemDisabled.join(',') !== 'true,true,false') {
      throw new Error(`${key}/cards：已兑换那两张的「去兑换」必须是 disabled：${JSON.stringify(cards.redeemDisabled)}`)
    }
    if (copied.length !== 1 || !/^[A-Z0-9-]+$/u.test(String(copied[0])) || !String(copied[0]).endsWith(EXPECT.cards[0].full)) {
      throw new Error(`${key}/cards：复制的不是完整卡密：${JSON.stringify(copied)}`)
    }
    if (String(copied[0]) === cards.codes[0]) {
      throw new Error(`${key}/cards：复制到的是掩码而不是完整卡密：${JSON.stringify(copied)}`)
    }
    if (cards.cardPadding !== '16px' || cards.cardRadius !== '14px') {
      throw new Error(`${key}/cards：卡片内外距不对（padding=${cards.cardPadding} radius=${cards.cardRadius}）`)
    }
    if (cards.copyHeight !== 36 || cards.redeemHeight !== 36 || cards.copyRadius !== '999px') {
      throw new Error(
        `${key}/cards：按钮应是 36 高 / 999 圆角（copy=${cards.copyHeight}/${cards.copyRadius} redeem=${cards.redeemHeight}/${cards.redeemRadius}）`
      )
    }

    // ---------------- 历史消费 ----------------
    await page.getByTestId('account-consume-back').click()
    await page.waitForTimeout(300)
    await page.getByTestId('account-consume-history').click()
    await page.getByTestId('account-consume-history-row').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, 'history.png') })

    const history = await readHistory(page)
    const historyOverflow = await measureOverflow(page)
    metrics.states[`${key}/history`] = {
      screenshot: `${key}/history.png`,
      ...history,
      ...historyOverflow,
      consoleErrors: errors,
    }

    if (historyOverflow.overflowCount !== 0) {
      throw new Error(`${key}/history：横向溢出 ${historyOverflow.overflowCount} 处 ${JSON.stringify(historyOverflow.overflowSamples)}`)
    }
    if (history.rowCount !== EXPECT.amounts.length) {
      throw new Error(`${key}/history：记录应为 ${EXPECT.amounts.length} 条，实际 ${history.rowCount}`)
    }
    history.amounts.forEach((amount, index) => {
      if (!/^-¥\d+\.\d{2}$/u.test(String(amount))) {
        throw new Error(`${key}/history：第 ${index + 1} 条金额不合口径：${JSON.stringify(amount)}`)
      }
      if (amount !== EXPECT.amounts[index]) {
        throw new Error(`${key}/history：第 ${index + 1} 条金额应为 ${EXPECT.amounts[index]}，实际 ${amount}`)
      }
    })
    history.times.forEach((time, index) => {
      if (time !== EXPECT.times[index]) {
        throw new Error(`${key}/history：第 ${index + 1} 条时间应为 ${EXPECT.times[index]}，实际 ${time}`)
      }
    })
    if (history.groups.length !== 3) {
      throw new Error(`${key}/history：分组标题应为 3 组，实际 ${JSON.stringify(history.groups)}`)
    }
    EXPECT.firstGroups.forEach((label, index) => {
      if (history.groups[index] !== label) {
        throw new Error(`${key}/history：第 ${index + 1} 个分组标题应为 ${label}，实际 ${history.groups[index]}`)
      }
    })
    if (!/^\d{1,2}月\d{1,2}日$/u.test(String(history.groups[2]))) {
      throw new Error(`${key}/history：第三个分组标题应是「M月D日」：${JSON.stringify(history.groups[2])}`)
    }
    if (history.amountFontVariantNumeric !== 'tabular-nums') {
      throw new Error(`${key}/history：金额应是等宽数字（tabular-nums），实际 ${history.amountFontVariantNumeric}`)
    }
    if (history.amountFontSize !== '16px' || history.amountFontWeight !== '500') {
      throw new Error(`${key}/history：金额字号字重应为 16px/500，实际 ${history.amountFontSize}/${history.amountFontWeight}`)
    }
    if (history.groupFontSize !== '13px') {
      throw new Error(`${key}/history：分组标题字号应为 13px，实际 ${history.groupFontSize}`)
    }
    if (history.emptyState) {
      throw new Error(`${key}/history：有 mock 数据时不该再出现空态节点`)
    }

    metrics.overflowCount += cardsOverflow.overflowCount + historyOverflow.overflowCount
    metrics.consoleErrors.push(...errors)
    metrics.viewports[key] = {
      cards: `${key}/cards.png`,
      history: `${key}/history.png`,
      overflowCount: cardsOverflow.overflowCount + historyOverflow.overflowCount,
    }
    await context.close()
  }

  // ---------------- 与原型并排 ----------------
  if (options.proto !== '') {
    const protoPath = path.resolve(ROOT, options.proto)
    const protoShots = await shotPrototype(browser, protoPath, outRoot)
    for (const [screen, file] of Object.entries(protoShots)) {
      await composeCompare(browser, {
        left: file,
        right: path.join(outRoot, '390', `${screen}.png`),
        leftLabel: `原型（375 宽 HTML，${path.basename(protoPath)}）`,
        rightLabel: `实现（dev server 390×844，?mock=1）`,
        out: path.join(outRoot, `compare-${screen}-390.png`),
      })
    }
    metrics.proto = { path: options.proto, compare: ['compare-cards-390.png', 'compare-history-390.png'] }
  } else {
    metrics.proto = { path: null, note: '未传 --proto，跳过「与原型并排」那两张' }
  }

  metrics.asserts = {
    cards: EXPECT.cards.map((card) => card.code),
    amountsRegex: '/^-¥\\d+\\.\\d{2}$/',
    groups: ['今天', '昨天', 'M月D日'],
    copyIsFullCard: true,
    overflowCount: metrics.overflowCount,
    consoleErrors: metrics.consoleErrors,
  }
  await writeFile(path.join(outRoot, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)

  await browser.close()

  console.log(`两屏 × ${options.viewports.join('/')} 全部通过：`)
  for (const [label, state] of Object.entries(metrics.states)) {
    console.log(`  ${label}  → ${state.screenshot}  overflow=${state.overflowCount}  console=${state.consoleErrors.length}`)
  }
  console.log(`overflowCount=${metrics.overflowCount}  consoleErrors=${JSON.stringify(metrics.consoleErrors)}`)
}

await run()
