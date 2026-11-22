// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// Issue #299：额度/余额用完时，界面必须明确说「余额不足 + 去哪里充值」，而不是「网络异常 / 生成失败 /
// 请求过于频繁」，也不许被自动重试（#105）白跑几次再报错。
//
// 上游全部用 page.route 打桩，不连外网。网关的额度报错有几种真实写法，本用例各走一遍：
//   [1] HTTP 402 + { error: { message, code: 'insufficient_balance' } }（Anthropic 协议链路）
//   [2] HTTP 429 + { error: { message, type/code: 'insufficient_quota' } }（OpenAI 兼容链路，
//       改前会落到「请求过于频繁」并被自动重试 2 次——这是用户最容易误判成「App 有 bug」的形态）
//   [3] 负向：HTTP 502 / 普通 400 必须仍是原来的分类与文案，不能被吞进额度档
//   [4] 额度正常：正常 SSE 回答照常渲染，不出现任何额度提示
//
// 跑法（先用 pnpm build 生成标准包；本脚本自起临时端口服务，不吃外部 APP_URL）：
//   node tests/integration/quota-exhausted.test.mjs
//   DIST_DIR=/private/artifacts/<commit>/standard node tests/integration/quota-exhausted.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
// #596：切到 ours 后 Key 必须带「下发标记」，否则发送前守卫会拦（产品行为），402 场景就等不到
import { seedClaimedApiKey } from '../helpers/ours-claim.mjs'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { MESSAGES_SSE_OK, providerKindTrigger } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const KEY = 'sk-testkey-quota-299'
const name = 'tests/integration/quota-exhausted.test.mjs'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}

const server = await serveDist(DIST, { port: process.env.PORT || 0 })
const APP_URL = server.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
const browser = await chromium.launch()

/** 干净的页面：清掉 localStorage 里已保存的配置后重载 */
const openPage = async () => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  return { context, page }
}

/** 设置弹窗 → 数据管理 → 填 Key → 确定（弹窗保持打开，方便接着切渠道） */
const setupKey = async (page, key = KEY) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
    await page.waitForTimeout(300)
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForSelector('input[type="password"]', { timeout: 3000 }).catch(() => {})
  await page.locator('input[type="password"]').first().fill(key)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(400)
}

/** 关掉设置弹窗 */
const closeSettings = async (page) => {
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(400)
  }
}

/** 切到「我们的渠道」（只有它才有额度 / 卡密的钱入口） */
const selectOursChannel = async (page) => {
  // #555：这里原来写的是 `getByRole('button', { name: /渠道|Channel|服务类型|Service type/ }).first()`。
  // #480/#538 之后聊天页多了一个**禁用态**的文档入口图标按钮，aria-label 是
  // 「当前渠道不支持文档附件：…请切换到其他渠道」—— 含「渠道」二字、DOM 顺序在设置弹窗之前、
  // 且 `aria-disabled="true"`。宽松选择器 `.first()` 正好命中它，Playwright 的 enabled 检查
  // 一路不让点，最终抛 `locator.click: Timeout 30000ms exceeded`（不是产品坏了，是选择器撞了）。
  // 改用共享的 `providerKindTrigger`（`aria-label` 整串锚定），并且限定在设置弹窗内。
  await providerKindTrigger(page.getByRole('dialog').first()).first().click()
  await page.getByRole('option', { name: /我们的渠道|Our Channel/ }).first().click()
  await page.waitForTimeout(400)
  // #596：切渠道不会动 Key，但 ours 的 Key 只能由服务端下发 —— 补上「已领取」形态（Key + 下发标记）
  await seedClaimedApiKey(page, KEY)
}

/** 发一条消息 */
const sendChat = async (page, text = '你好') => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
}

/** 轮询等待条件成立 */
const waitFor = async (predicate, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page_delay(150)
  }
  return false
}
const page_delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 整个页面正文（判断界面到底给用户看了什么） */
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

/**
 * 一个场景：打桩上游 → 配 Key → 发消息 → 等界面稳定 → 返回可见文案与请求次数。
 * respond 收到「本次是第几次回答请求」，用来造「第一次失败、之后成功」之类的形态。
 */
const runScenario = async ({
  label,
  messagesPath = /\/anthropic\/v1\/messages$/,
  respond,
  prepare,
  expectText,
}) => {
  const { page } = await openPage()
  let calls = 0
  const seen = []
  {
    // /models 探测（设置页打开时可能触发）与邀请服务请求都打桩，避免连外网
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
    await page.route(messagesPath, async (route) => {
      calls += 1
      const { status, contentType, body } = respond(calls)
      seen.push(status)
      await route.fulfill({
        status,
        headers: { 'content-type': contentType },
        body,
      })
    })
    await setupKey(page)
    if (prepare) {
      await prepare(page)
    }
    await closeSettings(page)
    await sendChat(page)
    // 等界面稳定：出现期望文案上限 20s（内含自动重试的退避时间）
    const hit = await waitFor(async () => (await bodyText(page)).includes(expectText), 20000)
    await page.waitForTimeout(1200)
    const text = await bodyText(page)
    console.log(`  ·   [${label}] 请求 ${calls} 次（状态码 ${JSON.stringify(seen)}），界面文案 = ${JSON.stringify(text.slice(0, 220))}`)
    if (!hit) {
      bad(`[${label}] 界面上找不到期望文案 ${JSON.stringify(expectText)}`)
    }
    return { page, calls, text, seen }
  }
}

const jsonError = (status, error) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ error }),
})

try {
  // ---------- [1] 402 + insufficient_balance（Anthropic 协议链路，默认渠道） ----------
  {
    const { page, calls, text } = await runScenario({
      label: '402/insufficient_balance',
      respond: () =>
        jsonError(402, {
          message: 'Insufficient balance, please top up your account.',
          code: 'insufficient_balance',
        }),
      // 额度类是终态错误：一次就收尾，不许自动重试
      expectText: '余额或额度不足',
    })
    if (calls !== 1) {
      bad(`[1] 402 额度不足不该自动重试，实际发了 ${calls} 次请求`)
    } else {
      ok('[1] 402 额度不足只发了一次请求（不进自动重试）')
    }
    if (/请求过于频繁|网络异常|未知错误|生成失败/.test(text)) {
      bad(`[1] 文案仍混着泛化提示：${JSON.stringify(text.slice(0, 200))}`)
    }
    const topUp = page.getByRole('link', { name: /前往充值|去充值|Top up/ })
    if ((await topUp.count()) === 0) {
      bad('[1] 提示里没有「去充值」入口')
    } else {
      ok(`[1] 充值入口 = ${JSON.stringify((await topUp.first().innerText()).trim())}`)
    }
  }

  // ---------- [2] 429 + insufficient_quota（OpenAI 兼容链路，最容易误判的形态） ----------
  {
    const { page, calls, text } = await runScenario({
      label: '429/insufficient_quota',
      messagesPath: /\/v1\/chat\/completions$/,
      prepare: selectOursChannel,
      respond: () =>
        jsonError(429, {
          message:
            'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        }),
      expectText: '余额或额度不足',
    })
    if (calls !== 1) {
      bad(`[2] 429 额度不足不该自动重试，实际发了 ${calls} 次请求`)
    } else {
      ok('[2] 429 额度不足只发了一次请求（改前会被当限流重试）')
    }
    if (/请求过于频繁/.test(text)) {
      bad('[2] 额度不足被说成「请求过于频繁」')
    }
    // 自有渠道的这个 CTA 打开「账户与消费」页并落在**「我的钱包」**（#817）。
    //
    // 判定口径的演变：#562 起是 `openAccountConsume('quota')`（落在「我的额度」tab），#817 把
    // 「我的额度」整页删掉（余额卡里的入口也删了），CTA 改指钱包页 —— 页首就是余额卡 + 付款入口，
    // 往下是「我的卡密」。「落点真的生效」这半条由 `tests/unit/wallet-pay-entry-817.test.mjs` ④
    // 在 store 层钉住（`accountConsumeTab === 'wallet'`），这里只断端到端能看到钱包页首。
    const entry = page.getByRole('button', { name: /去充值|兑换卡密|前往充值|Top up/ })
    if ((await entry.count()) === 0) {
      bad('[2] 提示里没有「去充值 / 兑换卡密」按钮')
    } else {
      await entry.first().click()
      await page.getByTestId('account-consume-page').waitFor({ state: 'visible', timeout: 10000 })
      const onWalletPage = (await page.getByTestId('account-consume-wallet-head').count()) > 0
      if (!onWalletPage) {
        bad('[2] 额度不足的 CTA 没有落在「我的钱包」（account-consume-wallet-head 不出现）')
      } else if ((await page.getByTestId('account-consume-tab-quota').count()) > 0) {
        bad('[2] 「我的额度」入口还在 —— #817 之后它必须删掉')
      } else if ((await page.getByTestId('ours-services-dialog').count()) > 0) {
        bad('[2] 旧「额度与卡密」弹层还在 —— #562 之后不该再出现')
      } else {
        ok('[2] CTA 打开「账户与消费」页并落在「我的钱包」（#817：额度页已删，旧弹层已退役）')
      }
    }
  }

  // ---------- [3a] 负向：502 仍是「服务器繁忙」，且照旧按上限重试 ----------
  {
    const { text, calls } = await runScenario({
      label: '502',
      respond: () => jsonError(502, { message: 'bad gateway' }),
      expectText: '服务器繁忙',
    })
    if (/余额|额度不足/.test(text)) {
      bad(`[3a] 502 被吞进额度档：${JSON.stringify(text.slice(0, 200))}`)
    }
    if (calls < 2) {
      bad(`[3a] 502 属于可重试，改后仍应自动重试，实际只发了 ${calls} 次`)
    } else {
      ok(`[3a] 502 仍是「服务器繁忙」且照旧重试（共 ${calls} 次请求）`)
    }
  }

  // ---------- [3b] 负向：普通 400 仍是原有的未识别错误，不进额度档 ----------
  {
    const { text } = await runScenario({
      label: '400/invalid_request',
      respond: () =>
        jsonError(400, {
          message: 'invalid request: max_tokens must be a positive integer',
          code: 'invalid_request_error',
        }),
      // #324：普通 400 有明确档位（参数错误），不再落到「未知错误」，
      // 且文案显式写「不要重试」——它仍然是 4xx 终态，不进额度 / 限流 / 服务端故障档。
      // #347 起这一档的措辞是「请求参数有误（HTTP 400）」：带状态码，能带字段就带字段
      expectText: '参数有误',
    })
    if (/余额|额度不足|服务器繁忙|请求过于频繁|未知错误/.test(text)) {
      bad(`[3b] 普通 400 被归错档：${JSON.stringify(text.slice(0, 200))}`)
    } else {
      ok('[3b] 普通 400 走「请求参数有误」档，没有被额度 / 限流 / 未知错误吃掉')
    }
  }

  // ---------- [4] 额度正常：回答照常渲染，不出现额度提示 ----------
  {
    const { text } = await runScenario({
      label: 'ok',
      respond: () => ({
        status: 200,
        contentType: 'text/event-stream',
        body: MESSAGES_SSE_OK,
      }),
      expectText: '你好呀',
    })
    if (/余额|额度不足|充值/.test(text)) {
      bad(`[4] 额度正常时冒出了额度提示：${JSON.stringify(text.slice(0, 200))}`)
    } else {
      ok('[4] 额度正常：回答照常渲染，没有额度提示')
    }
  }
} catch (error) {
  bad(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  await server.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}`)
}
