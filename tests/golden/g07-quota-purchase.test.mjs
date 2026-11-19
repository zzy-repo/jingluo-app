// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 原生桥桩 | 预算: ≤60s]
//
// 黄金回归 · 域 7「额度」+ 域 8「购买」（Issue #404 第二批，**同一条弹层路径合成一条**）：
//   领取 → 刷新 → 兑换成功一次 ｜ 套餐区 → 前往购买（现取收款页地址）→ App 内打开 → 关页刷新额度
//
// 两段合成一条的理由：它们都在「我们的服务」同一个弹层里、同一套后端、用户也是连着点的
// （领完额度就去看能不能买）。拆成两条会各起一次浏览器、各配一套桩，却仍然测不到
// 「兑换后余额变没变、关掉收款页回没回来」这类**跨步骤**事实。
//
// 全部后端都是桩（**不产生任何资金流**）：
//   · 邀请 / 额度服务（{inviteBaseUrl}）→ CapacitorHttp 原生桥替身按路径应答；
//   · 卡密 / 收款服务（https://apia.ecsafe.cn）→ 同一个替身；
//   · 内嵌浏览器（@capacitor/browser）→ 只记「打开了哪个地址」，关页事件由用例手动触发。
// 因此这里**只有 GET /api/pay-link 这个只读接口**，没有建单 / 查单 / 轮询 ——
// Issue #331 之后 App 侧本来就没有订单（旧链路整条删除），这条断言本身就是「不产生资金流」的守卫。
//
// 与 L0 的分工（tests/unit/ours-* 已覆盖兑换四态、领取幂等、错码文案、plans 解析…）：
// 这里只跑主路径一次成功，不重复任何失败分支。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g07-quota-purchase.test.mjs
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-ours-0987654321'
const CARD = 'GOLD-1234-5678-9012-ABCD'
const PAY_URL = 'https://pay.example.test/shop/golden-abc'
/** 额度轨迹：领取 100 → 刷新到 150 → 兑换 +300 → 关收款页后 500 */
const QUOTA = { claim: 100, refreshed: 150, afterRedeem: 450, afterPay: 500 }

/**
 * 原生桥桩（`addInitScript`）：让 Capacitor 认为自己在 APK 里。
 *
 * - `CapacitorHttp.request` → 按路径返回本用例的假响应（邀请服务 / 卡密服务都在这里）；
 * - `Browser.addListener/open/removeListener` → 记录打开地址，把关闭回调存起来，
 *   由用例在「用户从收款页回来」时手动触发一次（= `browserFinished`）。
 */
const nativeBridgeStub = ({ payUrl, key }) => {
  window.androidBridge = { postMessage: () => {} }
  const state = { calls: [], listener: null, opened: '', quota: 100 }
  window.__goldenOurs = state

  const profile = () => ({
    invite_code: 'GOLDEN01',
    invited_count: 0,
    max_invites: 20,
    bonus_points: 0,
    redeemed: false,
    quota_points: state.quota,
    used_points: 0,
    remaining_points: state.quota,
    key_status: 'active',
  })
  const json = (status, body) => ({
    status,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify(body),
    url: '',
  })

  const route = (options) => {
    const target = String(options?.url ?? '')
    const { pathname, host } = new URL(target)
    const method = String(options?.method ?? 'GET').toUpperCase()
    let body = null
    try {
      body = options?.data ? JSON.parse(options.data) : null
    } catch {
      body = null
    }
    state.calls.push({ host, method, path: pathname, body })
    if (pathname === '/apply') {
      return json(201, { ...profile(), key })
    }
    if (pathname === '/me') {
      return json(200, profile())
    }
    if (pathname === '/redeem-card') {
      state.quota += 300
      return json(200, {
        ok: true,
        card_no: body?.card_no ?? '',
        points: 300,
        quota_points: 300,
        remaining_points: state.quota,
        duplicate: false,
      })
    }
    if (pathname === '/api/balance') {
      return json(200, { api_key: '…4321', valid: true })
    }
    if (pathname === '/api/pay-link') {
      return json(200, { ok: true, url: payUrl, note: '' })
    }
    return json(404, { error: { code: 'not_found', message: `no route ${pathname}` } })
  }

  window.Capacitor = {
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] },
      {
        name: 'Browser',
        // addListener 声明成 callback 形态：这样原生桥替身能拿到回调，用来模拟「用户关掉收款页」
        methods: [
          { name: 'open', rtype: 'promise' },
          { name: 'addListener', rtype: 'callback' },
          { name: 'removeListener', rtype: 'promise' },
        ],
      },
    ],
    nativePromise: async (plugin, method, options) => {
      if (plugin === 'CapacitorHttp') {
        return route(options)
      }
      if (plugin === 'Browser' && method === 'open') {
        state.opened = String(options?.url ?? '')
        return {}
      }
      return {}
    },
    nativeCallback: async (plugin, method, options, callback) => {
      if (plugin === 'Browser' && method === 'addListener') {
        state.listener = typeof callback === 'function' ? callback : null
        return 'golden-cb-1'
      }
      return null
    },
  }
}

/** 用户从收款页回到 App：先让服务端额度变一下，再触发关闭回调 */
const comeBackFromPayPage = (page, quota) =>
  page.evaluate((next) => {
    const state = window.__goldenOurs
    state.quota = next
    if (typeof state.listener === 'function') {
      state.listener({})
    }
    return true
  }, quota)

const result = await runGolden(
  { id: 'G7', domain: '额度+购买', title: '领取 → 刷新 → 兑换 ｜ 套餐 → 前往购买 → 关页刷新额度' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, close } = await openGoldenPage(app.url, {
      initScripts: [{ fn: nativeBridgeStub, arg: { payUrl: PAY_URL, key: KEY } }],
      storage: { 'chat-demo:provider-kind': 'ours' },
    })
    try {
      await waitForBoot(page)

      // ── 1. 打开「我们的服务」弹层：本机无 Key → 只给选择，不发写请求 ────────────
      ctx.begin('打开弹层')
      if ((await page.getByRole('dialog').count()) === 0) {
        await page
          .getByRole('button', { name: /设置|Settings/ })
          .last()
          .click()
      }
      await page
        .getByRole('tab', { name: /数据管理|Data/ })
        .first()
        .click()
      const openButton = page.getByTestId('ours-services-open')
      const entryReady = await waitFor(page, async () => (await openButton.count()) > 0)
      if (!entryReady) {
        ctx.abort('ours 渠道的设置页有「我们的服务」入口', '入口按钮存在', `body=${brief(await bodyText(page))}`)
      }
      await openButton.click()
      const choiceReady = await waitFor(page, async () => (await page.getByTestId('ours-open-choice').count()) > 0)
      if (!choiceReady) {
        ctx.abort('弹层打开后给「领取 / 我已有 Key」二选一', '选择区存在', `body=${brief(await bodyText(page))}`)
      }
      const callsOf = async () => page.evaluate(() => window.__goldenOurs.calls)

      // ── 2. 领取：POST /apply → Key 落盘 + 额度显示 ────────────────────────────
      ctx.begin('领取')
      await page.getByTestId('ours-open-choice-claim').click()
      const claimed = await waitFor(page, async () => (await page.getByTestId('ours-claim-status').count()) > 0 &&
        /已领取/.test(await page.getByTestId('ours-claim-status').innerText()))
      ctx.expect('领取成功并给出结论', claimed, {
        expected: '状态含「已领取」',
        actual: brief(await page.getByTestId('ours-claim-status').innerText().catch(() => '（没有状态行）')),
      })
      const keySaved = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
      ctx.expect('领到的 Key 落盘（后续兑换/购买都用它）', keySaved === KEY, {
        expected: KEY.slice(0, 12) + '…',
        actual: String(keySaved).slice(0, 12) + '…',
      })
      const quotaAfterClaim = await waitFor(
        page,
        async () => (await page.getByTestId('ours-quota-value').innerText()) === `${QUOTA.claim} 积分`
      )
      ctx.expect('额度来自 /me 的 remaining_points，只显示积分', quotaAfterClaim, {
        expected: `${QUOTA.claim} 积分`,
        actual: await page.getByTestId('ours-quota-value').innerText(),
      })

      // ── 3. 刷新：再打一次 /me，额度跟着服务端变 ───────────────────────────────
      ctx.begin('刷新额度')
      const meBefore = (await callsOf()).filter((item) => item.path === '/me').length
      await page.evaluate((next) => {
        window.__goldenOurs.quota = next
      }, QUOTA.refreshed)
      await page.getByTestId('ours-quota-refresh').click()
      const refreshed = await waitFor(
        page,
        async () => (await page.getByTestId('ours-quota-value').innerText()) === `${QUOTA.refreshed} 积分`
      )
      const meAfter = (await callsOf()).filter((item) => item.path === '/me').length
      ctx.expect('刷新后额度按服务端最新值显示', refreshed, {
        expected: `${QUOTA.refreshed} 积分`,
        actual: await page.getByTestId('ours-quota-value').innerText(),
      })
      ctx.expect('「刷新额度」真的又查了一次 /me', meAfter === meBefore + 1, {
        expected: `/me = ${meBefore + 1} 次`,
        actual: `/me = ${meAfter} 次`,
      })

      // ── 4. 兑换成功一次：POST /redeem-card → 结果行 + 额度刷新 ─────────────────
      ctx.begin('兑换卡密')
      await page.getByTestId('ours-redeem-input').fill(CARD)
      await page.getByTestId('ours-redeem-submit').click()
      const redeemed = await waitFor(page, async () => {
        const count = await page.getByTestId('ours-redeem-result').count()
        return count > 0 && /兑换成功/.test(await page.getByTestId('ours-redeem-result').innerText())
      })
      ctx.expect('兑换成功并显示到账积分', redeemed, {
        expected: '结果含「兑换成功，+300」',
        actual: brief(await page.getByTestId('ours-redeem-result').innerText().catch(() => '（没有结果行）')),
      })
      const redeemCall = (await callsOf()).filter((item) => item.path === '/redeem-card')
      ctx.expect('兑换打了一次本机池 /redeem-card 且带当前 Key', redeemCall.length === 1 && redeemCall[0].body?.api_key === KEY, {
        expected: '/redeem-card = 1 次，body.api_key = 当前 Key',
        actual: `/redeem-card = ${redeemCall.length} 次，api_key=${String(redeemCall[0]?.body?.api_key).slice(0, 12)}…`,
      })
      const quotaAfterRedeem = await waitFor(
        page,
        async () => (await page.getByTestId('ours-quota-value').innerText()) === `${QUOTA.afterRedeem} 积分`
      )
      ctx.expect('兑换成功后额度自动刷新', quotaAfterRedeem, {
        expected: `${QUOTA.afterRedeem} 积分`,
        actual: await page.getByTestId('ours-quota-value').innerText(),
      })

      // ── 5. 购买：套餐区 → 前往购买 → 现取收款页地址 → App 内打开 ──────────────
      ctx.begin('前往购买')
      const plansText = await page.getByTestId('ours-plans').innerText()
      ctx.expect('套餐全线下架时给空态而不是「加载失败」', /套餐列表已下架/.test(plansText) && !/加载失败/.test(plansText), {
        expected: '含「套餐列表已下架」且不含「加载失败」',
        actual: brief(plansText),
      })
      await page.getByTestId('ours-buy').click()
      const opened = await waitFor(page, async () => (await page.evaluate(() => window.__goldenOurs.opened)) !== '')
      const openedUrl = await page.evaluate(() => window.__goldenOurs.opened)
      ctx.expect('现取 /api/pay-link 并在 App 内打开该地址', opened && openedUrl === PAY_URL, {
        expected: PAY_URL,
        actual: openedUrl || '（没有打开任何页面）',
      })
      const payLinkCalls = (await callsOf()).filter((item) => item.path === '/api/pay-link')
      ctx.expect('收款页地址是只读取的（GET /api/pay-link，一次）', payLinkCalls.length === 1 && payLinkCalls[0].method === 'GET', {
        expected: 'GET /api/pay-link = 1 次',
        actual: `${payLinkCalls.map((item) => item.method).join(',') || '0 次'}`,
      })

      // ── 6. 关掉收款页回跳：额度刷新一次，且**不显示「支付成功」** ───────────────
      ctx.begin('关页回跳')
      const meBeforeBack = (await callsOf()).filter((item) => item.path === '/me').length
      await comeBackFromPayPage(page, QUOTA.afterPay)
      const quotaAfterPay = await waitFor(
        page,
        async () => (await page.getByTestId('ours-quota-value').innerText()) === `${QUOTA.afterPay} 积分`
      )
      const meAfterBack = (await callsOf()).filter((item) => item.path === '/me').length
      ctx.expect('关页回来刷新一次额度', quotaAfterPay && meAfterBack === meBeforeBack + 1, {
        expected: `${QUOTA.afterPay} 积分，/me = ${meBeforeBack + 1} 次`,
        actual: `${await page.getByTestId('ours-quota-value').innerText()}，/me = ${meAfterBack} 次`,
      })
      const panelText = await page.getByTestId('ours-services-dialog').innerText()
      ctx.expect('不谎报「支付成功」（App 侧没有订单可查）', !/支付成功|付款成功/.test(panelText), {
        expected: 'body 不含「支付成功」',
        actual: brief(panelText),
      })
      // 不产生资金流：整条链路只碰过「只读取地址 + 兑换 + 额度查询」，没有建单 / 查单 / 拉套餐
      const touched = (await callsOf()).map((item) => `${item.method} ${item.path}`)
      const orderLike = touched.filter((item) => /\/buy|\/orders|checkout|\/api\/plans/i.test(item))
      ctx.expect('没有建单 / 查单 / 拉套餐的请求（后端全桩，不产生资金流）', orderLike.length === 0, {
        expected: '0 条订单类请求',
        actual: orderLike.join(' | ') || '0 条',
      })
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
