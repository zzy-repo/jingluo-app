/**
 * 「我的钱包」页的**顶部一行**：余额卡 + 付款入口（Issue #817）—— 真 zh 文案 + `createElement`，
 * 裸 Node 里能 `renderToStaticMarkup`（所以「入口在不在、数字完不完整、点它去哪」都能按 markup 断言，
 * 不是读源码猜）。
 *
 * ## 版式（一张卡 + 右侧一个入口，同一行）
 *
 * ```
 * ┌───────────────────────────────┐  ┌──────────┐
 * │ 剩余余额                       │  │ 去支付 › │
 * │ ¥128.50                       │  └──────────┘
 * └───────────────────────────────┘
 * ```
 *
 * 三条硬约定：
 *
 *  1. **余额卡与付款入口同一行**（`.walletHead` 是 flex 行），入口贴右；
 *  2. **窄屏不挤断数字**：卡可以缩，但 `min-width: min-content` 保证「¥128.50」这种不可断的数字
 *     不会被压成两行 / 被截断；真的放不下时**整块折行**（父级 `flex-wrap: wrap`，入口掉到下一行
 *     仍贴右）—— 不做横向滚动（CSS 里没有 `overflow-x: auto|scroll`）；
 *  3. **这里没有第二套付款逻辑**：入口只做一次换页（`onPay`），真正下单 / 打开收款页还是
 *     `BuyTab`（`/api/pay-link` + `openPayLinkInApp`），落点由 `walletPayFlow.ts` 给。
 *
 * 余额的三态文案（`…` / `—` / `¥x.xx`）也在这里，而不是散在页面里：`signedIn === null` 是
 * 「启动恢复还没跑完」，这时候给一个来路不明的 `0.00` 就是误导（#608 的口径）。
 */
import { createElement, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { formatCurrency } from './panels.js'

export type WalletHeaderViewProps = {
  /** i18n 取词（与 `useTranslate()` 同签名；单测注入真 zh 表） */
  t: (key: TranslationKey, params?: TranslationParams) => string
  /** CSS Module 类名表 */
  styles: Record<string, string>
  /** 登录态：`null` = 启动恢复还没跑完（给 `…`，不显示一个来路不明的 0.00） */
  signedIn: boolean | null
  /** 余额（元，sub2api `/user/profile` 的 `balance`）；`undefined` = 还没读到（给 `—`） */
  balance: number | undefined
  /** 点付款入口：进「购买」子页（`WALLET_PAY_ENTRY_PAGE`，那页挂的就是既有 `BuyTab`） */
  onPay: () => void
}

/**
 * 余额的文案（三态）：恢复中 `…` / 没读到 `—` / 读到了 `¥x.xx`。
 *
 * 金额只经 `formatCurrency()`（`panels.ts` 里唯一的价格格式器）渲染一次，界面不写第二份 `toFixed`。
 */
export const balanceTextOf = ({ signedIn, balance }: Pick<WalletHeaderViewProps, 'signedIn' | 'balance'>): string => {
  if (signedIn === null) {
    return '…'
  }
  if (balance === undefined) {
    return '—'
  }
  return formatCurrency(balance)
}

export const WalletHeaderView = ({ t, styles, signedIn, balance, onPay }: WalletHeaderViewProps): ReactNode =>
  createElement(
    'div',
    { className: styles.walletHead, 'data-testid': 'account-consume-wallet-head' },
    [
      // 余额卡：`account-consume-balance` 是**既有契约**（#727 起就挂在这个 div 上，不许改名）
      createElement(
        'div',
        { key: 'balance', className: styles.balance, 'data-testid': 'account-consume-balance' },
        [
          createElement('div', { key: 'key', className: styles.balanceKey }, t('accountConsumeRemaining')),
          createElement('div', { key: 'value', className: styles.balanceValue }, balanceTextOf({ signedIn, balance })),
        ]
      ),
      // 付款入口：文案复用「购买」那一路既有的 `oursBuyAction`（不新增词条、不另写付款逻辑）
      createElement(
        'button',
        {
          key: 'pay',
          type: 'button',
          className: styles.walletPay,
          'data-testid': 'account-consume-wallet-pay',
          onClick: onPay,
        },
        t('oursBuyAction'),
        createElement('span', { key: 'chevron', className: styles.walletPayChevron, 'aria-hidden': 'true' }, '›')
      ),
    ]
  )
