/**
 * 「账户与消费」页 —— **三弹层合一**（#482 定调 / #487 W1-C1，旧 UI 3,160 行的替代物）。
 *
 * 合并的是设置页里原来那三个入口（付款记录 #115 / 我的购买 #158 / 支付记录时间线 #189），
 * 外加「额度 / 账号」两段：**一个页面四个 tab**，不再各弹各的层。
 *
 *   [账户与消费]
 *    ├── Tab 1 我的卡密   apia `GET /api/orders` + sub2api `POST /api/v1/redeem`   ← W1-C1
 *    ├── Tab 2 购买       apia `GET /api/plans` / `GET /api/pay-link`             ← W1-C1
 *    ├── Tab 3 我的额度   `<QuotaPanel />`                                        ← W1-C2
 *    └── Tab 4 账号       `<AccountPanel />`（邀请 / 邮箱绑定在它内部）             ← W1-C2
 *
 * Tab3/Tab4 的组件本体来自 W1-C2（`src/components/consume/index.ts` 的四个面板）：
 * 本页只负责「选 tab + 把同一个 `consume` 实例和登录出口递下去」。两边的契约就是那四个面板的
 * props（`consume` / `user` / `onNeedLogin`），**没有第二套状态机**。
 *
 * 四条不许在这里破的约定：
 *  1. **不做第二份客户端**：整页一个 `ConsumeClient`，用全应用共享的 `getConsumeClient()`
 *     （JWT 与 sk- Key 都在每次请求时现取；本页不存 token、不刷新 token）；
 *  2. **不复制旧 CSS**：样式全在 `AccountConsume.module.css`，只吃 design token；
 *  3. **不搬旧逻辑**：Tab3/Tab4 的额度 / 邀请 / 邮箱一律不在这里实现；
 *  4. **写操作都靠用户点**：兑换不自动重试、收款页不自动重开（#484 §5）。
 */
import clsx from 'clsx'
import { useCallback, useMemo, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { ConsumeClient, ConsumeUser } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { openSettings, type AccountConsumeTab } from '../settings/settingsDialogState.js'
import { Modal } from '../base/Modal.js'
import { BuyTab } from './BuyTab.js'
import { AccountPanel, QuotaPanel } from './index.js'
import { MyCardsTab } from './MyCardsTab.js'
import styles from './AccountConsume.module.css'

/** 四个 tab：顺序、i18n key 都在这里，加 tab 只改这一处 */
const TABS: readonly { value: AccountConsumeTab; label: TranslationKey }[] = [
  { value: 'cards', label: 'accountConsumeTabCards' },
  { value: 'buy', label: 'oursPayTitle' },
  { value: 'quota', label: 'accountConsumeTabQuota' },
  { value: 'account', label: 'accountConsumeTabAccount' },
]

/**
 * tab 类型的**唯一出处**是 `settingsDialogState`（状态层：付款回跳与消息流 CTA 都要按 tab 打开它），
 * 这里只是转出去，避免同一个联合类型在两处各写一遍而漂移。
 */
export type { AccountConsumeTab }

export type AccountConsumePageProps = {
  onClose: () => void
  /** 打开时落在哪个 tab（默认「我的卡密」，付款回跳可以指到 `buy`） */
  initialTab?: AccountConsumeTab
  /**
   * 页面用的消费侧客户端。**不传就用全应用共享的那一个**（`services/consumeClient.ts` 的单例，
   * 凭据提供者是 `getAccessToken` + `getApiKey`）：上层（测试 / 特殊流程）注入时把自己的实例
   * 传进来，整页共用一份，不出现第二个 token 来源。
   */
  consume?: ConsumeClient
  /** 当前用户；不传则取 W1-B 的 `useAuthStore().user`（仍未登录时 Tab4 自己给可选登录卡） */
  user?: ConsumeUser | null
  /**
   * 需要登录时的出口。**默认实现已经够用**（切到「账号」tab —— 那里有局部登录卡）；
   * 上层要接管（例如整页换壳）再传自己的。
   */
  onNeedLogin?: () => void
}

export const AccountConsumePage = ({
  onClose,
  initialTab = 'cards',
  consume: injected,
  user = null,
  onNeedLogin,
}: AccountConsumePageProps) => {
  const t = useTranslate()
  const [tab, setTab] = useState<AccountConsumeTab>(initialTab)
  /**
   * 整页一个客户端：取**全应用共享**的那一个（`getConsumeClient()`，JWT 与 sk- Key 两个凭据提供者
   * 都在里面按请求现取）。不在这里另 `createConsumeClient(...)`：那样「我的额度」拿不到 Key
   * （`consume.http.hasApiKey()` 恒 false），面板只会显示「还没有可用的 Key」，而共享实例正是
   * `services/consumeClient.ts` 存在的理由（同一份传输实例，排查时说得清是哪一份发的）。
   * 上层要注入自己的实例（测试 / 特殊流程）就传 `consume`。
   */
  const consume = useMemo(() => injected ?? getConsumeClient(), [injected])
  // Tab4 的「当前用户」默认取 W1-B 的登录态；上层传了以传入的为准
  const auth = useAuthStatus()
  const authUser = auth.user
  /**
   * 登录态（#608）：三档，`null` = 启动恢复还没跑完。
   *
   * 为什么不直接用 `user !== null`：恢复期间 store 里既没有 token 也没有 user，但那不等于
   * 「未登录」—— 先按「未知」给 loading，免得回访用户一进来就看到一句「登录后可查看额度」。
   */
  const signedIn = auth.restored ? auth.authenticated : null
  /**
   * 登录出口：面板的 `onNeedLogin` 是必填（会话失效时它们只负责喊，不自己跳转）。
   * 拆掉登录墙之后**没有一个可以由外壳切走的登录页**了，默认行为就是切到「账号」tab ——
   * 那里的局部登录卡正是这条出口的落点（#608）。上层要接管再传 `onNeedLogin`。
   */
  const needLogin = useCallback(() => {
    setTab('account')
    onNeedLogin?.()
  }, [onNeedLogin])

  /**
   * 未登录态的主 CTA：「去填 API Key」（#608 —— 账户是次要的，能不发请求就不发请求）。
   * 落在「设置 → 数据管理 → API Key」那一行：关掉本页、回到设置的数据管理分组。
   */
  const fillKey = useCallback(() => {
    onClose()
    openSettings('data')
  }, [onClose])

  /** 关掉收款页后回到「我的卡密」：卡密由小铺发到订单上，重进这个 tab 就会重拉一次 */
  const backToCards = useCallback(() => setTab('cards'), [])

  return (
    <Modal
      title={t('accountConsumeTitle')}
      closable
      zIndex={1100}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
    >
      <div role="tablist" aria-label={t('accountConsumeTitle')} className={styles.tabs}>
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            data-testid={`account-consume-tab-${item.value}`}
            className={clsx(styles.tab, tab === item.value && styles.tabActive)}
            onClick={() => setTab(item.value)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid="account-consume-page">
        {tab === 'cards' ? (
          <MyCardsTab consume={consume} onGoBuy={() => setTab('buy')} onNeedLogin={onNeedLogin} />
        ) : null}
        {tab === 'buy' ? <BuyTab onPurchased={backToCards} /> : null}
        {tab === 'quota' ? (
          <QuotaPanel consume={consume} onNeedLogin={needLogin} signedIn={signedIn} onSignIn={needLogin} />
        ) : null}
        {tab === 'account' ? (
          <AccountPanel
            consume={consume}
            user={user ?? authUser}
            onNeedLogin={needLogin}
            onFillKey={fillKey}
          />
        ) : null}
      </div>
    </Modal>
  )
}
