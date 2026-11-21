/**
 * 「账户与消费」页 —— #727 阶段 1（P0 最小可发布集）：**整页 + 原型布局词汇 + 真功能**。
 *
 * 这一页是设置里的一级入口（`设置 → 账户与消费`，一次点击），页面按 #727 原型 HTML 的
 * **布局词汇**重排，不再是「设置弹层 + 四个 pill tab + 每格一个描边盒子」：
 *
 *   大标题 34px
 *   ├─ 模型来源            56px inset 列表行 → 底部 sheet（切既有 `ProviderKind`）
 *   ├─ 连通性测试          三态圆点（通 / Key 无效 / 网络或配置错）
 *   ├─ 我的钱包            余额卡 + inset 行（我的卡密 / 历史消费 / 购买套餐）
 *   └─ 账号                profile 行（未登录 = 账号面板自己的引导态）
 *
 * ## 这个文件只做「外壳 + 选哪一块」，一条业务逻辑都不新写
 *
 * | 这一页上的东西 | 真正干活的地方（既有实现） |
 * | --- | --- |
 * | 余额 / 已用 | `quotaPanelModel.loadQuota` + `quotaSummaryOf`（`spent = actual_cost`，**不是** `quota.used`） |
 * | 我的卡密（含复制完整卡密） | `MyCardsTab` → `services/ours/purchases.ts` 的 `fetchPurchases` / `maskCardNo` |
 * | 购买 / 支付 | `BuyTab` → 既有 `/api/plans` + `/api/pay-link` + `openPayLinkInApp` + 回跳重拉订单 |
 * | 历史消费 / 额度 | `QuotaPanel`（`/v1/usage` + `/api/v1/usage` 一族） |
 * | 账号 / 邀请 / 邮箱 / 退出 | `AccountPanel`（+ `InvitePanel` / `EmailBindPanel`） |
 * | 登录 / 注册 / 发验证码 | 居中 dialog 里的 `<AuthGate variant="dialog" />` → `services/consume/auth.ts` |
 * | 模型来源 | `services/api/providers.ts` 的 `ProviderKind` + `setProviderKind`（**底层状态不动**） |
 * | 连通性 | `services/api/client.ts` 的 `probeProvider`（既有 `/models` 探测）+ `keyRejection` 的判死记录 |
 *
 * ## 四条不许在这里破的约定
 *
 *  1. **不做第二份客户端**：整页一个 `ConsumeClient`，用全应用共享的 `getConsumeClient()`；
 *  2. **不复制旧 CSS**：样式全在 `AccountConsume.module.css`，只吃 design token；
 *  3. **契约不动**（#727 §三 第 4 条）：`data-testid="account-consume-page"` /
 *     `account-consume-tab-{cards,buy,quota,account}` 与 `aria-selected` 全部保留 ——
 *     四个 tab 的 id 从「pill 按钮」搬到了原型里的 inset 列表行上（同一个 `role="tablist"`），
 *     付款回跳 / 消息流 CTA 的 `openAccountConsume(tab)` 深链仍然落在同一块；
 *  4. **写操作都靠用户点**：兑换不自动重试、收款页不自动重开（#484 §5）；连通性测试也只在
 *     用户点那一行时才发请求（打开页面不自动探测，免得每次进设置都打一发 `/models`）。
 */
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { ConsumeClient, ConsumeUser } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { openSettings, type AccountConsumeTab } from '../settings/settingsDialogState.js'
import { getApiKey, getBaseUrl, recordKeySuccess, setProviderKind, useApiConfig } from '../../services/api/apiConfig.js'
import { probeProvider, type ProviderProbeResult } from '../../services/api/client.js'
import type { ProviderKind } from '../../services/api/providers.js'
import { useSettings } from '../../services/settings.js'
import { describeProbe } from '../settings/ApiConfigFields.js'
import { Modal } from '../base/Modal.js'
import { AuthGate } from '../auth/AuthGate.js'
import { IconCheckedOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { BuyTab } from './BuyTab.js'
import { AccountPanel, QuotaPanel } from './index.js'
import { MyCardsTab } from './MyCardsTab.js'
import {
  connectivityLabelOf,
  connectivityOf,
  modelSourceLabel,
  modelSourceOptions,
  walletRemainingOf,
} from './consumeHomeModel.js'
import { loadQuota, quotaSummaryOf, type QuotaSource, type QuotaSummary } from './quotaPanelModel.js'
import { formatCurrency, maskedEmail } from './panels.js'
import styles from './AccountConsume.module.css'

/**
 * 四个子视图（顺序与 i18n key 都在这里，加一块只改这一处）。
 *
 * 类型唯一出处仍是 `settingsDialogState`（付款回跳与消息流 CTA 要按块打开它），这里只转出去。
 */
const TABS: readonly { value: AccountConsumeTab; label: TranslationKey }[] = [
  { value: 'cards', label: 'accountConsumeTabCards' },
  { value: 'quota', label: 'accountConsumeHistoryTitle' },
  { value: 'buy', label: 'accountConsumeBuyRow' },
  { value: 'account', label: 'accountConsumeTabAccount' },
]

export type { AccountConsumeTab }

/**
 * 每一块的**既有名字**（tabpanel 的 aria-label 用它）。
 *
 * 行上显示的是 #727 原型的词汇（`历史消费` / `购买套餐`），而这块面板在无障碍树里仍然叫它
 * 一直以来的名字（`我的额度` / `购买`）—— 同一块东西，不给它起第二个产品名，
 * 改动前后用读屏软件/测试定位到的还是同一句话。
 */
const PANEL_LABEL: Record<AccountConsumeTab, TranslationKey> = {
  cards: 'accountConsumeTabCards',
  buy: 'oursPayTitle',
  quota: 'accountConsumeTabQuota',
  account: 'accountConsumeTabAccount',
}

/** 三态圆点的类名（绿 / 黄 / 红，原型 `.dot` / `.dot.testing` / `.dot.fail`） */
const DOT_CLASS = {
  idle: styles.dot_idle,
  testing: styles.dot_testing,
  ok: styles.dot_ok,
  keyInvalid: styles.dot_keyInvalid,
  error: styles.dot_keyInvalid,
} as const

export type AccountConsumePageProps = {
  onClose: () => void
  /** 打开时落在哪一块（默认「我的卡密」，付款回跳可以指到 `buy`） */
  initialTab?: AccountConsumeTab
  /**
   * 页面用的消费侧客户端。**不传就用全应用共享的那一个**（`services/consumeClient.ts` 的单例）。
   * 上层（测试 / 特殊流程）注入时把自己的实例传进来，整页共用一份，不出现第二个 token 来源。
   */
  consume?: ConsumeClient
  /** 当前用户；不传则取 W1-B 的 `useAuthStore().user` */
  user?: ConsumeUser | null
  /** 需要登录时的出口（默认切到「账号」一块 —— 那里有局部登录卡） */
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
  /** 模型来源底部 sheet */
  const [sheetOpen, setSheetOpen] = useState(false)
  /** 居中登录 dialog（原型：选「内置服务」而当前未登录时先弹它） */
  const [authOpen, setAuthOpen] = useState(false)
  /** 因为「要登录才能用这个来源」而打开 dialog 时记下来，登录成功后自动落回这个来源 */
  const [pendingKind, setPendingKind] = useState<ProviderKind | null>(null)
  const consume = useMemo(() => injected ?? getConsumeClient(), [injected])
  const auth = useAuthStatus()
  const authUser = auth.user
  /** 登录态（#608）：`null` = 启动恢复还没跑完，先不下「未登录」的结论 */
  const signedIn = auth.restored ? auth.authenticated : null
  const kind = useApiConfig((state) => state.kind)
  const locale = useSettings((state) => state.locale)
  const lang: 'zh' | 'en' = locale.startsWith('zh') ? 'zh' : 'en'

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // ---------------------------------------------------------------- 余额卡（复用既有额度口径）
  /**
   * 余额卡只读**既有**那一条额度链：`loadQuota`（`GET /v1/usage`）→ `quotaSummaryOf`。
   * 「已用」永远是 `usage.total.actual_cost`（实测 `quota.used` 恒为 0，见 `usage.ts` 文件头），
   * 这里不重算、也不缓存第二份账本（A4：额度只以服务端响应为准）。
   */
  const quotaSource = useMemo<QuotaSource>(
    () => ({ hasApiKey: () => consume.http.hasApiKey(), usage: consume.usage }),
    [consume]
  )
  const [summary, setSummary] = useState<QuotaSummary | null>(null)
  const reloadBalance = useCallback(() => {
    void loadQuota(quotaSource).then((state) => {
      if (!alive.current) {
        return
      }
      setSummary(state.phase === 'ready' ? quotaSummaryOf(state.data) : null)
    })
  }, [quotaSource])
  // 未登录不发请求（`/v1/usage` 的鉴权就是 Key 本身，没 Key 只会 401）
  useEffect(() => {
    if (signedIn === true) {
      reloadBalance()
    } else if (signedIn === false) {
      setSummary(null)
    }
  }, [reloadBalance, signedIn])
  // 切块时重拉一次：兑换成功 / 付款回跳都会改余额，回到钱包时不显示上一次的数
  useEffect(() => {
    if (signedIn === true) {
      reloadBalance()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只为「切块」这一个触发点，`reloadBalance` 已含依赖
  }, [tab])

  // ---------------------------------------------------------------- 连通性（复用既有探测）
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMs, setProbeMs] = useState<number | undefined>(undefined)
  /** 本地就能判死的两种（没地址 / 没 Key）：不发请求，直接给既有那句文案 */
  const [probeLocalKey, setProbeLocalKey] = useState<TranslationKey | null>(null)
  const phase = connectivityOf(probe, probing)
  const phaseLabel = connectivityLabelOf(phase, probeMs)
  const probeNow = useCallback(async () => {
    if (probing) {
      return
    }
    const baseUrl = getBaseUrl()
    if (!baseUrl) {
      setProbeLocalKey('settingsBaseUrlRequired')
      setProbe(null)
      return
    }
    const key = getApiKey()
    if (key === '') {
      setProbeLocalKey('settingsTestApiKeyRequired')
      setProbe(null)
      return
    }
    setProbeLocalKey(null)
    setProbing(true)
    setProbe(null)
    const startedAt = Date.now()
    try {
      const result = await probeProvider({ baseUrl, apiKey: key })
      if (!alive.current) {
        return
      }
      // #451：只有真的拿到成功应答才记「最近一次确认可用」；失败一次都不写（与设置页同一纪律）
      if (result.ok) {
        recordKeySuccess(key)
      }
      setProbeMs(Date.now() - startedAt)
      setProbe(result)
    } finally {
      if (alive.current) {
        setProbing(false)
      }
    }
  }, [probing])

  // 换来源后旧的测试结果没有意义（与设置页 `ConnectionTestField` 同一处理）
  useEffect(() => {
    setProbe(null)
    setProbeLocalKey(null)
  }, [kind])

  // ---------------------------------------------------------------- 模型来源 sheet
  const pickSource = useCallback(
    (next: ProviderKind) => {
      // 「我们的渠道」的 Key 只能由服务端下发（`apiKeyFieldMode === 'managed'`）→ 未登录时先登录。
      // 这不是登录墙（#608）：其它三个来源、钱包、卡密、消费记录在不登录时照常可用。
      if (next === 'ours' && signedIn !== true) {
        setPendingKind(next)
        setSheetOpen(false)
        setAuthOpen(true)
        return
      }
      setProviderKind(next)
      setSheetOpen(false)
    },
    [signedIn]
  )
  // 登录成功：把刚才想选的来源落下去，再把 dialog 收掉（`AuthGate` 自己不再挡住任何东西）
  useEffect(() => {
    if (!authOpen || signedIn !== true) {
      return
    }
    if (pendingKind !== null) {
      setProviderKind(pendingKind)
      setPendingKind(null)
    }
    setAuthOpen(false)
  }, [authOpen, pendingKind, signedIn])

  // ---------------------------------------------------------------- 登录出口
  const needLogin = useCallback(() => {
    setTab('account')
    onNeedLogin?.()
  }, [onNeedLogin])

  /** 未登录态的主 CTA：「去填 API Key」（#608 —— 账户是次要的）。落点是设置的数据管理分组 */
  const fillKey = useCallback(() => {
    onClose()
    openSettings('data')
  }, [onClose])

  /** 关掉收款页后回到「我的卡密」（卡密由小铺发到订单上，回到这一块就会重拉一次） */
  const backToCards = useCallback(() => setTab('cards'), [])

  const remaining = walletRemainingOf(summary)
  const accountValue =
    signedIn === true && authUser !== null
      ? maskedEmail(authUser.email)
      : signedIn === false
        ? t('accountConsumeSignedOut')
        : ''

  return (
    <Modal
      // 标题只留给读屏与关闭按钮：视觉上的标题是下面那个 34px 的 `.h1`（原型 `.h1`）
      title={<span className={styles.srOnly}>{t('accountConsumeTitle')}</span>}
      closable
      zIndex={1100}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
    >
      <div className={styles.page}>
        <h1 className={styles.h1}>{t('accountConsumeTitle')}</h1>

        {/* ── 组 1：模型来源 / 连通性测试 ───────────────────────────────── */}
        <div className={styles.rows} role="group" aria-label={t('accountConsumeSourceTitle')}>
          <button
            type="button"
            className={styles.row}
            data-testid="account-consume-source-open"
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
          >
            <span className={styles.rowLabel}>{t('accountConsumeSourceTitle')}</span>
            <span className={styles.rowValue}>
              {modelSourceLabel(kind, lang)}
              <IconChevronRightOutline14 />
            </span>
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            className={styles.row}
            data-testid="account-consume-connectivity"
            disabled={probing}
            onClick={() => void probeNow()}
          >
            <span className={styles.rowLabel}>{t('settingsTestLabel')}</span>
            <span className={styles.rowValue} data-phase={phase} data-testid="account-consume-connectivity-value">
              <i className={clsx(styles.dot, DOT_CLASS[phase])} aria-hidden="true" />
              {t(phaseLabel.key, phaseLabel.params)}
            </span>
          </button>
          {probeLocalKey !== null ? (
            <p className={styles.rowError} role="alert" data-testid="account-consume-connectivity-error">
              {t(probeLocalKey)}
            </p>
          ) : null}
          {probe !== null && !probe.ok ? (
            <p className={styles.rowHint} role="status">
              {describeProbe(t, probe)}
            </p>
          ) : null}
        </div>

        {/* ── 组 2：我的钱包 ─────────────────────────────────────────── */}
        <h2 className={styles.ghead}>{t('accountConsumeWalletTitle')}</h2>
        <div className={styles.balance} data-testid="account-consume-balance">
          <div className={styles.balanceKey}>{t('accountConsumeBalanceLabel')}</div>
          <div className={styles.balanceValue}>
            {remaining === undefined ? '—' : formatCurrency(remaining)}
          </div>
          {summary === null ? null : (
            <div className={styles.balanceMeta}>
              {t('consumeUsed')} {formatCurrency(summary.spent)}
            </div>
          )}
        </div>

        {/* 四块子视图的入口：`role="tablist"` 与四个 `account-consume-tab-*` 原样保留（契约） */}
        <div className={styles.rows} role="tablist" aria-label={t('accountConsumeTitle')}>
          {TABS.map((item, index) => (
            <div key={item.value} className={styles.rowSlot}>
              {index === TABS.length - 1 ? null : <div className={styles.divider} />}
              <button
                type="button"
                role="tab"
                aria-selected={tab === item.value}
                data-testid={`account-consume-tab-${item.value}`}
                className={clsx(styles.row, tab === item.value && styles.rowActive)}
                onClick={() => setTab(item.value)}
              >
                <span className={styles.rowLabel}>{t(item.label)}</span>
                <span className={styles.rowValue}>
                  {item.value === 'account' ? accountValue : null}
                  <IconChevronRightOutline14 />
                </span>
              </button>
            </div>
          ))}
        </div>

        {/* ── 选中的那一块（面板本体全部来自既有实现）──────────────────── */}
        <div
          role="tabpanel"
          aria-label={t(PANEL_LABEL[tab])}
          data-testid="account-consume-page"
          className={styles.panel}
        >
          {tab === 'cards' ? (
            <MyCardsTab consume={consume} onGoBuy={() => setTab('buy')} onNeedLogin={needLogin} />
          ) : null}
          {tab === 'buy' ? <BuyTab onPurchased={backToCards} /> : null}
          {tab === 'quota' ? (
            <QuotaPanel
              consume={consume}
              onNeedLogin={needLogin}
              signedIn={signedIn}
              onSignIn={needLogin}
            />
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
      </div>

      {/* ── 模型来源：底部 sheet（原型 `.mask` + `.sheet`）────────────────── */}
      {sheetOpen ? (
        <div className={styles.sheetLayer}>
          <button
            type="button"
            className={styles.mask}
            aria-label={t('cancel')}
            data-testid="account-consume-source-mask"
            onClick={() => setSheetOpen(false)}
          />
          <div
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-label={t('accountConsumeSourceTitle')}
            data-testid="account-consume-source-sheet"
          >
            <div className={styles.sheetHandle} aria-hidden="true" />
            <div className={styles.sheetTitle}>{t('accountConsumeSourceTitle')}</div>
            <div className={styles.rows}>
              {modelSourceOptions().map((option) => (
                <div key={option.kind} className={styles.rowSlot}>
                  <div className={styles.divider} />
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={kind === option.kind}
                    className={styles.row}
                    data-testid={`account-consume-source-${option.kind}`}
                    onClick={() => pickSource(option.kind)}
                  >
                    <span className={styles.rowLabel}>{lang === 'zh' ? option.zh : option.en}</span>
                    <span className={styles.rowValue}>
                      {kind === option.kind ? <IconCheckedOutline14 /> : null}
                    </span>
                  </button>
                </div>
              ))}
            </div>
            {/* Key / 地址的输入行只有一处：设置的数据管理分组（既有 `ApiConfigFields`），不在这里再写一套 */}
            <button
              type="button"
              className={styles.sheetLink}
              data-testid="account-consume-source-edit"
              onClick={fillKey}
            >
              {t('accountConsumeSourceEditHint')}
            </button>
            <button type="button" className={styles.sheetCancel} onClick={() => setSheetOpen(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 登录 / 注册：居中 dialog + segmented（原型 `.mask.center` + `.dialog`）── */}
      {authOpen ? (
        <Modal
          title={<span className={styles.srOnly}>{t('sub2authLogin')}</span>}
          closable
          zIndex={1200}
          className={styles.authDialog}
          onClose={() => setAuthOpen(false)}
        >
          <AuthGate variant="dialog" onDismiss={() => setAuthOpen(false)} />
        </Modal>
      ) : null}
    </Modal>
  )
}
