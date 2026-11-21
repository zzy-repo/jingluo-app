// [layer: golden | 依赖: playwright + chromium + 标准产物 dist（CI 用 TEST_AUTH_SEAM=1 构建）+ 原生桥桩 | 预算: ≤60s]
//
// 黄金回归 · 域「支付 / 购买」（C 线，#567；设计定调见 #404；**替代已随 W1-D 删掉的 `g07-quota-purchase`**）：
//
//   打开「账户与消费」→ 套餐列表 → 下单（`/api/pay-link`）→ 回跳 → 拿到卡密 → 一键复制
//
// 为什么只有这一段：黄金层是「用户主路径还在不在」的哨兵，不是分支矩阵。购买域的分支细节
// （套餐空表 / 通道不可用 / 重试按钮 / 兑换四态 / 支付记录时间线）分别在 L0
// （`tests/unit/pay-link.test.mjs`、`consume-panels-*`）与 L1 里，这里**不重复**：
// 一条断言如果删掉它别处还有用例会因同一处坏掉而红，它就不该出现在这里。
//
// 只断五件事（#567 的清单，一条不多）：
//   ① 卡密出现在「我的卡密」tab（后 4 位展示）；
//   ② 复制动作拿到**完整**卡密（剪贴板桩里比对全文）；
//   ③ 没有走已下线的 `/buy` 建单链路（`/buy` 请求数 = 0，#331 之后那条路整条删掉了）；
//   ④ 额度显示来源是 **sub2api**：`spent = usage.total.actual_cost`，**不是**本地账本
//      （断言没有读邀请服务的 `remaining_points`）；
//   ⑤ 支付侧走 **apia**：`/api/plans` 与 `/api/pay-link` 各 ≥1 次；**sub2api 不参与下单**。
//
// 后端全桩、且**一个真请求都不发**：`window.Capacitor` 换成一层原生桥替身（与 G5/G11 同一手法），
// 所有取数都经 `CapacitorHttp.request` 落到本文件的 route 表上 —— apia（套餐 / 收款页 / 订单）与
// sub2api（`/v1/usage` 额度）都在里面。route 表之外的路径一律 404：主路径若悄悄打了别的接口，
// 会当场红而不是被兜住。收款页的「关页回跳」也走原生桥（`Browser.addListener` 的回调由替身接住，
// 由用例在「付完款」那一刻触发），因此不依赖任何真浏览器插件。
//
// 跑法（仓库根目录）：
//   TEST_AUTH_SEAM=1 pnpm run build      # 与 CI 的 golden job 同一条构建命令（登录接缝）
//   node --test tests/golden/g15-purchase.test.mjs
//   node tests/run-golden.mjs --only g15 # 走黄金 runner（并行 + 耗时 + 一句话失败定位）
import assert from 'node:assert'
import { test } from 'node:test'

import { brief, bodyText, openGoldenPage, runGolden, serveGoldenApp, waitFor } from '../helpers/golden.mjs'
// #596：ours 的 Key 由服务端下发 —— 种子数据要带「下发标记」，否则发送前守卫会拦（这是产品行为）
import { claimedOursStorage } from '../helpers/ours-claim.mjs'

/** 种子 Key：卡密列表（`GET /api/orders`）与额度（`GET /v1/usage`）都要用它 */
const API_KEY = 'sk-golden-g15-000000000000000015'
/** 卡密：后 4 位用于「列表只露尾」，全文只允许出现在剪贴板里 */
const CARD_NO = 'CARD-GOLD-0000-0000-WXYZ'
const CARD_TAIL = '••••WXYZ'
/** 套餐（金额单位是「元」，apia 下发的值，客户端不硬编码） */
const PLAN_NAME = '月卡'
const PLAN_PRICE = '¥39.00'
/** 额度：`usage.total.actual_cost` 才是「已用」；`quota.used` 实测恒为 0，用它就会显示 ¥0.00 */
const ACTUAL_COST = 12.34
const QUOTA_USED_DECOY = 0
const BALANCE = 88.8

/**
 * 原生桥桩（Capacitor 替身）。
 *
 * 平台伪装成 **android**（`window.androidBridge` 存在即可）：产品就是 APK，`isNativePlatform()`
 * 为 true 时 `ours/transport.ts` 与 `consume/http.ts` 才走 CapacitorHttp —— 于是两条后端链路
 * （apia 支付、sub2api 消费）全部落在本文件的 route 表上，**没有 CORS、也不会漏到真服务**。
 *
 * 收款页（`@capacitor/browser`）也走同一条桥：`PluginHeaders` 里给它一个 `addListener`
 * （`rtype: 'callback'`，这样回调能被我接住）+ `open`（promise）。用例在「用户关掉收款页」的
 * 那一刻调 `window.__goldenPurchase.closeCheckout()`，走的是**真代码**里的 `onClosed()`。
 */
const purchaseBridgeStub = ({ cardNo, planName, actualCost, quotaUsed, balance }) => {
  window.androidBridge = { postMessage: () => {} }
  const state = { calls: [], clipboard: [], paid: false, listening: false, opened: false, closeCheckout: null }
  window.__goldenPurchase = state

  // 剪贴板桩：只记写入内容（断言「复制拿到完整卡密」靠它）
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          state.clipboard.push(String(text))
        },
      },
    })
  } catch {
    /* 老宿主上 navigator 不可改：copyText 会退到 execCommand，那条路本域不测 */
  }

  const json = (status, body) => ({
    status,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify(body),
    url: '',
  })

  /** 一条已完成的订单（卡密挂在小铺发的订单上，见 BuyTab 文件头） */
  const order = () => ({
    out_trade_no: 'G15-TRADE-1',
    plan_id: 'g15-month',
    plan_name: planName,
    plan_points: 3900,
    amount_yuan: 39,
    status: 'fulfilled',
    status_text: '已完成',
    card_no: cardNo,
    card_status: 'leased',
    redeem_state: 'issued',
    created_at: 1_760_000_000,
    paid_at: 1_760_000_100,
  })

  const route = (options) => {
    const url = new URL(String(options?.url ?? ''))
    const method = String(options?.method ?? 'GET').toUpperCase()
    state.calls.push({ method, host: url.host, path: url.pathname })
    // ── 支付侧（apia）：套餐 / 收款页 / 订单 ──────────────────────────────
    if (url.host === 'apia.ecsafe.cn') {
      if (url.pathname === '/api/plans') {
        return json(200, {
          plans: [
            { id: 'g15-month', name: planName, price: 39, points: 3900, currency: 'CNY', enabled: true },
          ],
        })
      }
      if (url.pathname === '/api/pay-link') {
        // 取到收款页地址 = 这一单已经交给小铺；之后卡密会挂到订单上
        state.paid = true
        return json(200, { ok: true, url: 'https://pay.example.com/g15', note: '' })
      }
      if (url.pathname === '/api/orders') {
        // 付款前没有卡密（空列表 = 正常态），付款后同一条订单带上卡密
        return json(200, {
          customer_id: 1,
          total: state.paid ? 1 : 0,
          limit: 20,
          offset: 0,
          total_paid_yuan: state.paid ? 39 : 0,
          orders: state.paid ? [order()] : [],
        })
      }
      if (url.pathname === '/api/balance') {
        return json(200, { api_key: '…0015', valid: true })
      }
      return json(404, { code: 'not_found', message: `no route ${url.pathname}` })
    }
    // ── 消费侧（sub2api）：额度 ────────────────────────────────────────────
    if (url.pathname === '/v1/usage') {
      return json(200, {
        mode: 'unrestricted',
        isValid: true,
        balance,
        remaining: balance,
        unit: 'CNY',
        // 诱饵：`quota.used` 恒为 0，界面若读它就显示 ¥0.00（真值在 usage.total.actual_cost）
        quota: { limit: 0, remaining: balance, unit: 'CNY', used: quotaUsed },
        usage: {
          total: {
            requests: 3,
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            actual_cost: actualCost,
          },
        },
      })
    }
    // 其余一律 404：多打一个接口就会在「链路守卫」里露出来
    return json(404, { code: 'not_found', message: `no route ${url.pathname}` })
  }

  window.Capacitor = {
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] },
      // 收款页：open 走 promise；addListener 走 callback（核心会把回调原样递进来，见下）
      {
        name: 'Browser',
        methods: [
          { name: 'open', rtype: 'promise' },
          { name: 'addListener', rtype: 'callback' },
        ],
      },
    ],
    nativePromise: async (plugin, method, options) => {
      if (plugin === 'CapacitorHttp') {
        return route(options)
      }
      if (plugin === 'Browser' && method === 'open') {
        // 记一笔「收款页被打开过」：地址只在真机里才有意义，这里只证明走了这条路
        state.opened = true
        state.calls.push({ method: 'OPEN', host: 'browser', path: String(options?.url ?? '') })
        return {}
      }
      return {}
    },
    nativeCallback: async (plugin, method, options, callback) => {
      if (plugin === 'Browser' && method === 'addListener') {
        // 真机是「用户关掉收款页」时由原生回调；这里把回调存下来，让用例在付款后触发
        state.listening = true
        state.closeCheckout = () => callback({})
        return 'g15-callback'
      }
      return undefined
    },
  }
}

/** 桩里的所有调用（一次性取回来，断言与取证都用它） */
const callsOf = (page) => page.evaluate(() => window.__goldenPurchase.calls)
const countCalls = (calls, predicate) => calls.filter(predicate).length

test('G15 支付 / 购买：套餐 → 下单（pay-link）→ 回跳 → 卡密 → 一键复制', async () => {
  const app = await serveGoldenApp()
  const { page, close } = await openGoldenPage(app.url, {
    initScripts: [
      {
        fn: purchaseBridgeStub,
        arg: {
          cardNo: CARD_NO,
          planName: PLAN_NAME,
          actualCost: ACTUAL_COST,
          quotaUsed: QUOTA_USED_DECOY,
          balance: BALANCE,
        },
      },
    ],
    // #596：ours 的 Key 只能由服务端下发 —— 种「已领取」形态（Key + 下发标记）
    storage: { 'chat-demo:provider-kind': 'ours', ...(await claimedOursStorage(API_KEY)) },
  })
  try {
    const result = await runGolden(
      { id: 'G15', domain: '支付/购买', title: '套餐 → 下单（pay-link）→ 回跳 → 卡密 → 一键复制' },
      async (ctx) => {
        // ── 1. 打开「账户与消费」：设置 → 数据管理 → 该入口 → 四个 tab 在位 ────────
        ctx.begin('打开账户与消费')
        if ((await page.getByRole('dialog').count()) === 0) {
          await page.getByRole('button', { name: /设置|Settings/ }).last().click()
        }
        await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
        const entry = page.getByTestId('account-consume-open')
        if (!(await waitFor(page, async () => (await entry.count()) > 0))) {
          ctx.abort('设置 → 数据管理有「账户与消费」入口', '入口按钮存在', `body=${brief(await bodyText(page))}`)
        }
        await entry.click()
        const tabsReady = await waitFor(page, async () => (await page.getByTestId('account-consume-tab-cards').count()) > 0)
        if (!tabsReady) {
          ctx.abort('「账户与消费」页打开', '四个 tab 都在', `body=${brief(await bodyText(page))}`)
        }

        // ── 2. 套餐列表：apia 下发的套餐渲染出来（价格由服务端定，界面不硬编码）──────
        ctx.begin('套餐列表')
        await page.getByTestId('account-consume-tab-buy').click()
        const planRow = page.getByTestId('account-consume-buy-plan').first()
        if (!(await waitFor(page, async () => (await planRow.count()) > 0))) {
          ctx.abort('购买 tab 有套餐列表', `1 条套餐（${PLAN_NAME}）`, `body=${brief(await page.getByTestId('account-consume-page').innerText())}`)
        }
        const planText = (await planRow.innerText()).replace(/\s+/gu, ' ').trim()
        ctx.expect('套餐名与价格都来自 apia（不是客户端兜底的空表）', planText.includes(PLAN_NAME) && planText.includes(PLAN_PRICE), {
          expected: `${PLAN_NAME} ${PLAN_PRICE}`,
          actual: brief(planText),
        })

        // ── 3. 下单：点「去支付」→ 取收款页地址（/api/pay-link）→ 收款页被打开 ───────
        ctx.begin('下单（pay-link）')
        await page.getByTestId('account-consume-buy-open').first().click()
        const paid = await waitFor(page, () => page.evaluate(() => window.__goldenPurchase.paid === true))
        if (!paid) {
          ctx.abort('点「去支付」后现取收款页地址', 'GET /api/pay-link ≥1 次', `body=${brief(await page.getByTestId('account-consume-page').innerText())}`)
        }
        // 收款页的打开是**后置条件**：监听先挂上、再 open（`openPayLinkInApp` 的顺序保证），
        // 所以等到这两件事都发生再断言「真的在 App 内打开了」，而不是只看到 pay-link 就往下走。
        const opened = await waitFor(
          page,
          () => page.evaluate(() => window.__goldenPurchase.listening === true && window.__goldenPurchase.opened === true)
        )
        ctx.expect('收款页是在 App 内打开的（先挂 browserFinished 监听，再 open）', opened, {
          expected: '监听已挂上且 Browser.open 已调用',
          actual: opened ? '已打开' : `listening=${String(await page.evaluate(() => window.__goldenPurchase.listening))}`,
        })

        // ── 4. 回跳：用户关掉收款页 → 回到「我的卡密」→ 卡密出现（只露后 4 位）───────
        ctx.begin('回跳拿到卡密')
        await page.evaluate(() => window.__goldenPurchase.closeCheckout?.())
        const cardRow = page.getByTestId('account-consume-card-row').first()
        if (!(await waitFor(page, async () => (await cardRow.count()) > 0))) {
          ctx.abort('关掉收款页后卡密出现在「我的卡密」', `1 行卡密（${CARD_TAIL}）`, `body=${brief(await page.getByTestId('account-consume-page').innerText())}`)
        }
        const cardText = (await cardRow.innerText()).replace(/\s+/gu, ' ').trim()
        const onCardsTab =
          (await page.getByTestId('account-consume-tab-cards').getAttribute('aria-selected')) === 'true'
        ctx.expect('回跳落在「我的卡密」，卡密只露后 4 位（完整卡密不进 DOM）', onCardsTab && cardText.includes(CARD_TAIL) && !cardText.includes(CARD_NO), {
          expected: `我的卡密 tab 选中 + 含 ${CARD_TAIL}，不含完整卡密`,
          actual: `${onCardsTab ? '选中的是我的卡密' : '没回到我的卡密'} / ${brief(cardText)}`,
        })

        // ── 5. 一键复制：剪贴板拿到**完整**卡密 ────────────────────────────────────
        ctx.begin('一键复制')
        await page.getByTestId('account-consume-card-copy').first().click()
        const copied = await waitFor(page, () => page.evaluate(() => window.__goldenPurchase.clipboard.length > 0))
        const clip = await page.evaluate(() => window.__goldenPurchase.clipboard)
        ctx.expect('复制动作把完整卡密交给剪贴板', copied && clip[clip.length - 1] === CARD_NO, {
          expected: CARD_NO,
          actual: copied ? brief(String(clip[clip.length - 1])) : '（剪贴板没收到任何内容）',
        })

        // ── 6. 额度来源：sub2api 的 usage.total.actual_cost（不是本地账本）────────────
        ctx.begin('额度来源')
        await page.getByTestId('account-consume-tab-quota').click()
        const spentRow = page.getByTestId('quota-spent')
        const spentReady = await waitFor(page, async () => (await spentRow.count()) > 0)
        if (!spentReady) {
          ctx.abort('「我的额度」读到 sub2api 额度', 'quota-spent 出现', `body=${brief(await page.getByTestId('account-consume-page').innerText())}`)
        }
        const spentText = (await spentRow.innerText()).replace(/\s+/gu, ' ').trim()
        ctx.expect('已用 = usage.total.actual_cost（¥12.34，不是 quota.used 的 ¥0.00）', spentText.includes('¥12.34') && !spentText.includes('¥0.00'), {
          expected: '¥12.34',
          actual: brief(spentText),
        })

        // ── 7. 链路守卫：谁发请求、谁没发 ─────────────────────────────────────────
        ctx.begin('链路守卫')
        const calls = await callsOf(page)
        const paths = calls.map((entry) => `${entry.host}${entry.path}`).join(' | ')
        const onApia = (path) => (entry) => entry.host === 'apia.ecsafe.cn' && entry.path === path
        /** 已下线的建单链路（#331 删掉了 cid / order_token 那一套）：`/buy` 与它下面的任何路径 */
        const isBuyChain = (entry) => /^\/buy(\/|$)/u.test(entry.path)
        /** 下单两条命令（套餐 / 收款页）：只许出现在 apia 上 */
        const isOrderCommand = (entry) => entry.path === '/api/plans' || entry.path === '/api/pay-link'

        ctx.expect('没有走已下线的 /buy 建单链路（请求数为 0）', countCalls(calls, isBuyChain) === 0, {
          expected: '/buy 请求数 = 0',
          actual: `${countCalls(calls, isBuyChain)} 次（${brief(paths, 200)}）`,
        })
        ctx.expect('套餐来自 apia：GET /api/plans ≥1 次', countCalls(calls, onApia('/api/plans')) >= 1, {
          expected: '≥1 次',
          actual: `${countCalls(calls, onApia('/api/plans'))} 次（${brief(paths, 200)}）`,
        })
        ctx.expect('下单来自 apia：GET /api/pay-link ≥1 次', countCalls(calls, onApia('/api/pay-link')) >= 1, {
          expected: '≥1 次',
          actual: `${countCalls(calls, onApia('/api/pay-link'))} 次（${brief(paths, 200)}）`,
        })
        ctx.expect('卡密来自 apia 的订单接口：GET /api/orders ≥1 次', countCalls(calls, onApia('/api/orders')) >= 1, {
          expected: '≥1 次',
          actual: `${countCalls(calls, onApia('/api/orders'))} 次（${brief(paths, 200)}）`,
        })
        ctx.expect(
          'sub2api 不参与下单（plans / pay-link 一次都没打到它）',
          countCalls(calls, (entry) => entry.host !== 'apia.ecsafe.cn' && isOrderCommand(entry)) === 0,
          { expected: '非 apia 主机上 0 次 plans/pay-link', actual: brief(paths, 200) }
        )
        ctx.expect(
          '额度不是本地账本：没读邀请服务的 /me（remaining_points 那条老路）',
          countCalls(calls, (entry) => entry.path === '/me') === 0,
          { expected: '/me 请求数 = 0', actual: brief(paths, 200) }
        )
      }
    )
    // runGolden 只记失败、不抛：抬成 node:test 的失败（`node --test` 单跑也才算真红）
    assert.equal(result.status, 'PASS', result.failures.join(' | '))
  } finally {
    await close()
    await app.close()
  }
})
