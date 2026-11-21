#!/usr/bin/env node
/**
 * #727 阶段 2「我的钱包 → 余额卡 + 购买按钮」的截图与断言工具。
 *
 *   node scripts/shot-727-wallet-card.mjs                       # 390/360 × 已登录/未登录 → docs/ui/727-wallet-card
 *   node scripts/shot-727-wallet-card.mjs --base=http://127.0.0.1:8099/
 *   node scripts/shot-727-wallet-card.mjs --viewport=390
 *
 * 与 `scripts/shot-mobile.mjs` 的区别：那个跑 `dist/` 整包并在脚本里 seed 会话；这里**直接打开
 * 正在跑的 dev server**（默认 8099），点真实入口进「设置 → 账户与消费 → 我的钱包」再截 ——
 * 维护者那一刻看到的就是这张图，所以改完保存后重跑本脚本即可复现。
 *
 * 两处打桩**不改产品行为**，只是为了在浏览器里能看到真实版式：
 *  1. `nativeBridgeStub`：消费层（`services/consume/http.ts`）只走 `CapacitorHttp`，浏览器里
 *     `isNativePlatform()` 为假时请求直接 `unsupported`。桩把 `CapacitorHttp.request` 转成一次
 *     `fetch`，于是下一条的 `page.route()` 才能接管（形状同 shot-mobile / g15 / g16 的配方）。
 *  2. `page.route()`：intercept 消费侧 / 支付侧两套端点，回契约形状的固定报文（不是真服务）。
 *
 * 已登录那张同样**不是摆拍**：往 localStorage 写一份真格式的落盘凭据
 * （`chat-demo:auth-token` = `{v:1,token,user}`，见 `services/auth/store.ts`）再整页 reload，
 * 让后台 `restoreAuth()` 真跑一遍；登录态的唯一真值来源仍是 `useAuthStore`。
 *
 * 产出：
 *   docs/ui/727-wallet-card/{390,360}/{signed-in,signed-out}.png
 *   docs/ui/727-wallet-card/{390,360}/signed-in-no-data.png（已登录但服务端没给余额 → `¥ 0.00`）
 *   docs/ui/727-wallet-card/{390,360}/buy-page-after-click.png（点「购买 / 充值」进购买页）
 *   docs/ui/727-wallet-card/metrics.json（溢出 / console / DOM 断言 / 按钮宽度占比）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { consumeApiV1Prefix, consumeBaseUrl, payBaseUrl } from './lib/endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}

/** 设置里三个分区的文案（与 `src/i18n/zh.ts` 同步；脚本不 import 源码，免得为一张图拉整包 TS） */
const T = {
  settings: '设置',
  openSider: '打开边栏',
  sectionAccount: '账户与消费',
  walletRow: '我的钱包',
  buy: '购买 / 充值',
}

/** `GET /api/v1/user/profile` 的实测字段子集（元，1 元 = 1 额度） */
const makeProfile = (balance) => ({
  id: 2,
  email: 'demo@example.com',
  email_masked: 'd***@example.com',
  username: 'demo',
  role: 'user',
  ...(balance === null ? {} : { balance }),
  frozen_balance: 0,
  concurrency: 5,
  status: 'active',
  identities: { email: { bound: true } },
})

const PLANS = {
  plans: [
    { id: 'basic', name: '入门包 100万 token', price: 0.1, points: 300, currency: 'CNY', enabled: true },
    { id: 'standard', name: '标准包 500万 token', price: 39, points: 3900, currency: 'CNY', enabled: true },
  ],
}

/**
 * Capacitor 替身（同 `scripts/shot-mobile.mjs` 的 `nativeBridgeStub`）：只把
 * `CapacitorHttp.request` 转成 fetch，多一个 `get` 供连通性探测用。不改产品行为。
 */
const nativeBridgeStub = () => {
  window.androidBridge = { postMessage: () => {} }
  window.Capacitor = {
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }, { name: 'get', rtype: 'promise' }] },
    ],
    nativePromise: async (plugin, method, options) => {
      if (plugin !== 'CapacitorHttp') {
        return {}
      }
      const headers = {}
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        headers[String(name).toLowerCase()] = String(value)
      }
      const init = { method: String(options?.method ?? 'GET'), headers }
      if (typeof options?.data === 'string' && options.data !== '') {
        init.body = options.data
      }
      const response = await fetch(String(options?.url ?? ''), init)
      const text = await response.text()
      const responseHeaders = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      return { status: response.status, headers: responseHeaders, data: text, url: response.url }
    },
    nativeCallback: async () => '',
  }
}

const parseArgs = (argv) => {
  const options = { base: 'http://100.113.135.55:8099/', out: 'docs/ui/727-wallet-card', viewports: ['390', '360'] }
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(arg)
    if (match === null) {
      throw new Error(`不认识的参数：${arg}（用法：--base=… --out=… --viewport=390,360）`)
    }
    const [, key, value] = match
    if (key === 'base') {
      options.base = value.trim()
    } else if (key === 'out') {
      options.out = value.trim()
    } else if (key === 'viewport' || key === 'viewports') {
      options.viewports = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
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

const reply = (body, status = 200) => ({
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,accept,content-type,x-session-id',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  },
  body: JSON.stringify(body),
})

/** 消费层统一信封：`services/consume/http.ts` 只认 `{code,message,data}` */
const envelope = (data) => reply({ code: 0, message: 'success', data })

/**
 * 打开「设置 → 账户与消费 → 我的钱包」。
 *
 * 窄屏下侧边栏是收起的（`设置` 按钮不在视口里），所以先按 aria-label 找，找不到再点「打开边栏」。
 */
const openWalletPage = async (page) => {
  // 这一版首屏**可能已经把设置弹层打开**（未配 Key 时它自己弹），所以先看入口在不在，
  // 不要在遮罩上再点一次「设置」——那会被 overlay 挡住并超时。
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

  const wallet = page.getByTestId('account-consume-wallet')
  await wallet.waitFor({ state: 'visible', timeout: 15000 })
  await wallet.click()
  await page.getByTestId('account-consume-balance').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(350)
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

/** 余额卡 DOM 断言：数字元素在、文本不是 `—`、按钮可见且宽度 ≥ 卡片内容宽的 90% */
const readCard = (page, label) =>
  page.evaluate((tag) => {
    const card = document.querySelector('[data-testid="account-consume-balance"]')
    const value = document.querySelector('[data-testid="account-consume-balance-value"]')
    const buy = document.querySelector('[data-testid="account-consume-buy"]')
    const quota = document.querySelector('[data-testid="account-consume-tab-quota"]')
    const hint = card === null ? null : card.querySelector('div:last-child')
    const cardStyle = card === null ? null : getComputedStyle(card)
    const valueStyle = value === null ? null : getComputedStyle(value)
    const buyStyle = buy === null ? null : getComputedStyle(buy)
    const box = (node) => (node === null ? null : node.getBoundingClientRect())
    const cardRect = box(card)
    const buyRect = box(buy)
    const contentWidth =
      cardRect === null || cardStyle === null
        ? null
        : cardRect.width - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight)
    return {
      label: tag,
      valueText: value === null ? null : (value.innerText ?? '').replace(/\s+/gu, ' ').trim(),
      valueFontSize: valueStyle === null ? null : valueStyle.fontSize,
      valueFontWeight: valueStyle === null ? null : valueStyle.fontWeight,
      valueFontVariantNumeric: valueStyle === null ? null : valueStyle.fontVariantNumeric,
      cardPadding: cardStyle === null ? null : `${cardStyle.paddingTop} ${cardStyle.paddingRight} ${cardStyle.paddingBottom} ${cardStyle.paddingLeft}`,
      cardRadius: cardStyle === null ? null : cardStyle.borderRadius,
      cardBorderWidth: cardStyle === null ? null : cardStyle.borderTopWidth,
      cardBackground: cardStyle === null ? null : cardStyle.backgroundColor,
      buyVisible: buy !== null,
      buyHeight: buyRect === null ? null : Math.round(buyRect.height),
      buyWidth: buyRect === null ? null : Math.round(buyRect.width),
      buyBackground: buyStyle === null ? null : buyStyle.backgroundColor,
      buyRadius: buyStyle === null ? null : buyStyle.borderRadius,
      contentWidth: contentWidth === null ? null : Math.round(contentWidth),
      buyWidthRatio: contentWidth === null || buyRect === null ? null : Number((buyRect.width / contentWidth).toFixed(3)),
      // 「购买按钮整宽独立一行」：与「我的额度」不是同一行的并排关系
      buyOnOwnRow: buyRect === null || quota === null ? null : buyRect.top >= box(quota).bottom - 1,
      quotaRowHeight: quota === null ? null : Math.round(box(quota).height),
      cardText: card === null ? null : (card.innerText ?? '').replace(/\s+/gu, ' ').trim(),
      hintText: hint === null ? null : (hint.innerText ?? '').replace(/\s+/gu, ' ').trim(),
    }
  }, label)

const run = async () => {
  const options = parseArgs(process.argv.slice(2))
  const outRoot = path.resolve(ROOT, options.out)
  const metrics = { base: options.base, viewports: {}, consoleErrors: [], overflowCount: 0, states: {} }

  const browser = await chromium.launch({ args: ['--force-device-scale-factor=2'] })

  for (const key of options.viewports) {
    const viewport = VIEWPORTS[key]
    const dir = path.join(outRoot, key)
    await mkdir(dir, { recursive: true })

    for (const mode of ['signed-out', 'signed-in', 'signed-in-no-data']) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        locale: 'zh-CN',
      })
      const errors = []
      const page = await context.newPage()
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(message.text())
        }
      })
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      await page.addInitScript(nativeBridgeStub)

      if (mode !== 'signed-out') {
        await page.addInitScript(() => {
          localStorage.setItem(
            'chat-demo:auth-token',
            JSON.stringify({
              v: 1,
              token: {
                accessToken: 'shot-727-access-token',
                tokenType: 'Bearer',
                // 远未来：不触发续期，恢复只走 `profile()` 这一条（截图不依赖 refresh 时序）
                expiresAt: Date.now() + 86_400_000,
              },
              user: { id: 2, email: 'demo@example.com', username: 'demo', role: 'user' },
            })
          )
          // 入口只在自有渠道出现：reload 后还要能重新进这一页
          localStorage.setItem('chat-demo:provider-kind', 'ours')
        })
      }

      // 消费侧（sub2api）：profile 给余额；其余按契约给空表 / 固定报文。
      // ⚠️ 支付侧与消费侧**同一个主机**（`apia.ecsafe.cn` 与 `/staging`），所以支付侧的路由
      // 必须写到具体路径，不能写 `${payBaseUrl}/api/**` —— 那样会把消费侧请求一起接走回 404。
      const profile = makeProfile(mode === 'signed-in-no-data' ? null : 12.34)
      await context.route(`${consumeBaseUrl}${consumeApiV1Prefix}/**`, async (route) => {
        const request = route.request()
        if (request.method() === 'OPTIONS') {
          await route.fulfill(reply({}, 204))
          return
        }
        const pathname = new URL(request.url()).pathname
        if (pathname.endsWith('/user/profile')) {
          await route.fulfill(envelope(profile))
          return
        }
        if (pathname.endsWith('/settings/public')) {
          await route.fulfill(envelope({ registration_enabled: true, email_verify_enabled: false, invitation_code_enabled: true }))
          return
        }
        // 内置服务登录后会领一把托管 Key（`GET` 列表 + `POST` 创建）：给形状完整的一条，
        // 免得首屏在 console 里攒 404（那会把真正的报错盖住）
        if (pathname.endsWith('/keys')) {
          await route.fulfill(
            request.method() === 'POST'
              ? envelope({ id: 11, name: '默认 Key', key: 'sk-shot-727-fixture-0000', status: 'active' })
              : envelope({ items: [], total: 0, page: 1, page_size: 20, pages: 0 })
          )
          return
        }
        await route.fulfill(reply({ code: 404, message: 'not found' }, 404))
      })
      // 支付侧（apia）：套餐表 + 收款页地址（点「购买 / 充值」后那一页要用）
      await context.route(`${payBaseUrl}/api/plans`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill(reply({}, 204))
          return
        }
        await route.fulfill(reply(PLANS))
      })
      await context.route(`${payBaseUrl}/api/pay-link`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill(reply({}, 204))
          return
        }
        await route.fulfill(reply({ ok: true, url: 'https://pay.example.invalid/checkout', note: '' }))
      })

      await page.goto(options.base, { waitUntil: 'domcontentloaded' })
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30000 })
      await openWalletPage(page)

      const shot = `${mode}.png`
      await page.screenshot({ path: path.join(dir, shot), fullPage: false })

      const card = await readCard(page, `${key}/${mode}`)
      const overflow = await measureOverflow(page)
      metrics.states[`${key}/${mode}`] = { screenshot: `${key}/${shot}`, ...card, ...overflow, consoleErrors: errors }
      metrics.overflowCount += overflow.overflowCount
      metrics.consoleErrors.push(...errors)

      // ---- 硬断言：余额位不是破折号；按钮可见且占满卡片内容宽 ----
      if (card.valueText === null || card.valueText === '' || card.valueText === '—') {
        throw new Error(`${key}/${mode}：余额位没有内容（拿到了 ${JSON.stringify(card.valueText)}）`)
      }
      if (!card.buyVisible) {
        throw new Error(`${key}/${mode}：找不到「购买 / 充值」按钮`)
      }
      if (card.buyWidthRatio === null || card.buyWidthRatio < 0.9) {
        throw new Error(`${key}/${mode}：购买按钮宽度只占卡片内容宽的 ${card.buyWidthRatio}（要求 ≥ 0.9）`)
      }
      if (card.buyOnOwnRow !== true) {
        throw new Error(`${key}/${mode}：购买按钮没有独占一行`)
      }
      if (overflow.overflowCount !== 0) {
        throw new Error(`${key}/${mode}：横向溢出 ${overflow.overflowCount} 处 ${JSON.stringify(overflow.overflowSamples)}`)
      }
      // 未登录那张：按钮下面必须有「登录后可在此查看卡密」；已登录那两张不许有
      const hasHint = String(card.cardText ?? '').includes('登录后可在此查看卡密')
      if (mode === 'signed-out' && !hasHint) {
        throw new Error(`${key}/${mode}：未登录态缺了「登录后可在此查看卡密」那句：${card.cardText}`)
      }
      if (mode !== 'signed-out' && hasHint) {
        throw new Error(`${key}/${mode}：已登录态不该出现「登录后可在此查看卡密」：${card.cardText}`)
      }

      // ---- 点「购买 / 充值」→ 必须进购买页（同一档只测已登录那张，未登录那张在上面已经拍完）----
      if (mode === 'signed-in') {
        await page.getByTestId('account-consume-buy').click()
        await page.getByTestId('account-consume-buy-plan').first().waitFor({ state: 'visible', timeout: 15000 })
        await page.waitForTimeout(350)
        await page.screenshot({ path: path.join(dir, 'buy-page-after-click.png'), fullPage: false })
        const buyPage = await page.evaluate(() => {
          const read = (selector) => {
            const node = document.querySelector(selector)
            return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
          }
          return {
            plans: Array.from(document.querySelectorAll('[data-testid="account-consume-buy-plan"]')).map((node) =>
              (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
            ),
            body: read('[data-testid="account-consume-buy"]'),
            walletCardGone: document.querySelector('[data-testid="account-consume-balance"]') === null,
          }
        })
        metrics.states[`${key}/buy-page`] = { screenshot: `${key}/buy-page-after-click.png`, ...buyPage }
        if (buyPage.plans.length === 0) {
          throw new Error(`${key}：点了「购买 / 充值」但没有进购买页（一个套餐行都没有）`)
        }
        if (!buyPage.walletCardGone) {
          throw new Error(`${key}：点了「购买 / 充值」后余额卡还在（说明没换页）`)
        }
      }

      await context.close()
    }
  }

  await browser.close()
  await writeFile(path.join(outRoot, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)

  // 控制台打一份人眼可读的摘要（metrics.json 是机器可读的同一份数据）
  for (const [state, data] of Object.entries(metrics.states)) {
    console.log(
      `${state}: 余额=${JSON.stringify(data.valueText ?? data.plans)} 按钮=${data.buyWidth ?? '-'}px(${data.buyWidthRatio ?? '-'}) ` +
        `溢出=${data.overflowCount ?? 0} console=${(data.consoleErrors ?? []).length}`
    )
  }
  console.log(`overflowCount 合计 ${metrics.overflowCount}；consoleErrors ${metrics.consoleErrors.length} 条`)
  if (metrics.overflowCount !== 0 || metrics.consoleErrors.length !== 0) {
    process.exitCode = 1
  }
}

await run()
