/**
 * 「我的钱包」页的**付款两个落点**（Issue #817）—— 唯一一份判定，页面与用例共用。
 *
 * 付款这条链路上只有两次换页，方向相反：
 *
 * ```
 * 钱包页顶部「付款入口」 ──onPay──▶ WALLET_PAY_ENTRY_PAGE ('buy' 子页，里面就是既有 BuyTab)
 *                                          │
 *                              收款页关掉（onClosed）
 *                                          ▼
 *                           landAfterPayReturn(onNavigate) → 'cards'（我的卡密）
 * ```
 *
 * 为什么把两个常量放这里而不是在 `AccountConsumePage.tsx` 里各写一个字面量：
 * `.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除范围内），落点写死在页面里就只能靠读源码猜。
 * 收成这一层之后，用例断的是「真被调用的那个函数返回哪一页」，页面那边只需断言它接了线。
 */

/** 付款入口去哪一页：**购买**子页 —— 付款逻辑还是既有的 `BuyTab`（`/api/pay-link` + `openPayLinkInApp`） */
export const WALLET_PAY_ENTRY_PAGE = 'buy' as const

/** 收款页关掉之后落回哪一页：**我的卡密**（卡密由小铺直接发到订单上，回来就是要看它） */
export const WALLET_PAY_RETURN_PAGE = 'cards' as const

/**
 * 「用户从收款页回来了」这一下的换页动作。
 *
 * 调用链（`openPayLinkInApp` 的 `onClosed` 是唯一触发点，进钱包页 / 进卡密页都碰不到这里）：
 *
 *   `BuyTab.openCheckout()` → `openPayLinkInApp(url, onClosed)`
 *     → 原生 `browser.addListener('browserFinished', finish)`（**最多回调一次**）
 *     → `finish()` → `onClosed()`
 *     → `BuyTab` 的 `onPurchased`（= `AccountConsumePage` 的 `backToCards`）
 *     → `landAfterPayReturn(onNavigate)` → `onNavigate('cards')`
 *
 * **Web 分支不在这条链上**：非原生环境（Web / 没有 `@capacitor/browser`）`openPayLinkInApp` 直接
 * 返回 `false`、`onClosed` 一次都不调 —— 界面停在购买页并给「没能在 App 内打开收款页」+ 重试，
 * 不会假装「付款回来了」跳去卡密。这一支的行为由 `tests/unit/ours-inapp-buy.test.mjs` [G] 与
 * `tests/unit/wallet-pay-entry-817.test.mjs` ⑤ 一起钉住。
 */
export const landAfterPayReturn = (
  onNavigate: (page: typeof WALLET_PAY_RETURN_PAGE) => void
): void => {
  onNavigate(WALLET_PAY_RETURN_PAGE)
}
