/**
 * 「账户与消费」页 —— **#727 的一级整页**（不是设置弹层里的 tab）。
 *
 * 层级（维护者 #727 10:48 更正的口径）：
 *
 *   设置 → 账户与消费（一级入口，点进来是整页）
 *     ├─ 模型来源        → 底部 sheet：内置 / 第三方 / DeepSeek 官方 / Anthropic（= `ProviderKind` 换皮）
 *     ├─ 连通性测试      → 已配置来源后出现，三态（正常 xx ms / 测试中… / 连接失败·重试）
 *     ├─ 我的钱包        → 余额卡 + 我的卡密 / 历史消费 / 我的额度 / 购买套餐
 *     └─ 账号            → 资料 / 账号 ID / 绑定邮箱 / 登录方式 / 账号与安全 / 退出登录
 *
 * 布局词汇照原型 HTML（`服务Tab.html`）：34px 大标题、56px inset 行 + 分隔线、余额卡、profile 头、
 * 消费记录行、底部 sheet、居中 dialog + segmented —— 具体对应关系写在 `ServicePage.module.css` 文件头。
 *
 * 四条不许在这里破的约定：
 *  1. **不做第二份客户端**：整页一个 `ConsumeClient`，默认用全应用共享的 `getConsumeClient()`
 *     （JWT 与 sk- Key 都在每次请求时现取；本页不存 token、不刷新 token）；
 *  2. **不复制面板逻辑**：卡密 / 购买 / 额度 / 账号四块还是 `MyCardsTab` / `BuyTab` / `QuotaPanel` /
 *     `AccountPanel` 那四个既有组件；本页只负责「把它们放到原型的位置上」，可改外观、不搬逻辑；
 *  3. **余额单一来源**：只读 sub2api（`/api/v1/user/profile` 的 `balance`，单位元）。
 *     已用额度不在这里算 —— 那是 `QuotaPanel` 的 `usage.total.actual_cost`（不是本地账本、不是 `quota.used`）；
 *  4. **契约不动**（#727 §五 第 4 条）：`account-consume-page` / `account-consume-tab-*` 这些
 *     `data-testid` 与 `aria-selected` 语义原样保留，只是从「四个 tab」变成「四个分区里的四行」。
 *
 * #608 仍然成立：未登录可用、只填 Key 可用；未登录态账号区 = 登录 / 注册入口 + 「不登录也可以…」，
 * **没有登录墙**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getApiKey, getBaseUrl, useApiConfig } from '../../services/api/apiConfig.js'
import { probeProvider } from '../../services/api/client.js'
import type { ConsumeClient, ConsumeUser } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { useAuthStore } from '../../services/auth/store.js'
import { openSettings, type AccountConsumeTab } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { AccountPanel, QuotaPanel } from './index.js'
import { BuyTab } from './BuyTab.js'
import { HistoryView } from './HistoryView.js'
import { MyCardsTab } from './MyCardsTab.js'
import { formatCurrency, maskedEmail } from './panels.js'
import { SourceSheet, sourceKeyOf } from './SourceSheet.js'
import styles from './AccountConsume.module.css'

/** 页内当前打开的子视图（`none` = 只有四个分区，没有展开任何列表） */
type PageView = 'cards' | 'buy' | 'quota' | 'history' | 'account'

/** 连通性三态（#727 §二）：`idle` 还没测 / `testing` 测试中 / `ok` 正常 / `fail` 失败可重试 */
type ConnState = { phase: 'idle' } | { phase: 'testing' } | { phase: 'ok'; ms: number } | { phase: 'fail' }

/**
 * tab 类型的**唯一出处**是 `settingsDialogState`（付款回跳与消息流 CTA 都按 tab 打开这一页），
 * 这里只是转出去，避免同一个联合类型在两处各写一遍而漂移。
 */
export type { AccountConsumeTab }

export type AccountConsumePageProps = {
  onClose: () => void
  /** 打开时展开哪个分区（默认「我的卡密」，付款回跳可以指到 `buy`） */
  initialTab?: AccountConsumeTab
  /** 页面用的消费侧客户端；不传就用全应用共享的那一个 */
  consume?: ConsumeClient
  /** 当前用户；不传则取 W1-B 的登录态 */
  user?: ConsumeUser | null
  /** 需要登录时的出口（默认切到「账号」分区 —— 那里就是登录 / 注册入口） */
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
  const consume = useMemo(() => injected ?? getConsumeClient(), [injected])
  const auth = useAuthStatus()
  const authUser = auth.user ?? user
  /**
   * 登录态三档（#608）：`null` = 启动恢复还没跑完。恢复期间既没有 token 也没有 user，
   * 但那不等于「未登录」—— 先按未知处理，免得回访用户一进来就看到「登录 / 注册」。
   */
  const signedIn = auth.restored ? auth.authenticated : null
  const signOut = useAuthStore((state) => state.signOut)
  const kind = useApiConfig((state) => state.kind)
  const apiKey = useApiConfig((state) => state.apiKey)

  const [view, setView] = useState<PageView>(initialTab)
  const [sheet, setSheet] = useState(false)
  const [conn, setConn] = useState<ConnState>({ phase: 'idle' })
  const [balance, setBalance] = useState<number | undefined>(undefined)
  const [walletTick, setWalletTick] = useState(0)
  const [signOutAsk, setSignOutAsk] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * 余额：只读 sub2api 的 `balance`（元）。未登录 / 恢复中**一个请求都不发**（拿 JWT 打只会 401），
   * 登录态一翻过来（或兑换 / 购买回来 bump 一次）就重拉。
   */
  useEffect(() => {
    if (signedIn !== true) {
      setBalance(undefined)
      return
    }
    let live = true
    void consume.auth
      .profile()
      .then((result) => {
        if (live && result.ok) {
          setBalance(result.data.balance)
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [consume, signedIn, walletTick])

  /**
   * 连通性测试：复用既有的 `probeProvider`（与设置里那个「测试」按钮同一条实现：
   * `GET {baseUrl}{paths.models}`，鉴权头按当前 spec）。耗时由本层测，结果只留三态。
   * Key 为空时**不发请求**，直接给「连接失败 · 重试」——那正是本地能给出的确定结论。
   */
  const runTest = useCallback(async () => {
    const key = getApiKey().trim()
    if (key === '') {
      setConn({ phase: 'fail' })
      return
    }
    setConn({ phase: 'testing' })
    const startedAt = Date.now()
    try {
      const result = await probeProvider({ baseUrl: getBaseUrl(), apiKey: key })
      if (!alive.current) {
        return
      }
      setConn(result.ok ? { phase: 'ok', ms: Date.now() - startedAt } : { phase: 'fail' })
    } catch {
      if (alive.current) {
        setConn({ phase: 'fail' })
      }
    }
  }, [])

  /** 登录出口（#608）：登录 / 注册入口就在「账号」分区，不换整页、不设登录墙 */
  const needLogin = useCallback(() => {
    setView('account')
    onNeedLogin?.()
  }, [onNeedLogin])

  /** 未登录态的主 CTA（#608）：去「设置 → 数据管理」填 Key —— 账户是次要的 */
  const fillKey = useCallback(() => {
    onClose()
    openSettings('data')
  }, [onClose])

  /** 收款页关掉后回到「我的卡密」并重拉一次余额（卡密由小铺发到订单上） */
  const backToCards = useCallback(() => {
    setView('cards')
    setWalletTick((tick) => tick + 1)
  }, [])

  const SOURCE_LABEL_KEYS: Record<string, TranslationKey> = {
    builtin: 'accountConsumeSourceBuiltin',
    third: 'accountConsumeSourceThird',
    deepseek: 'accountConsumeSourceDeepseek',
    anthropic: 'accountConsumeSourceAnthropic',
  }
  const sourceLabelKey = SOURCE_LABEL_KEYS[sourceKeyOf(kind)]

  /** 「已选来源」= 手上真有一把能用的 Key（内置服务的 Key 由服务端下发后再领取到本机） */
  const configured = apiKey.trim() !== ''
  const connText =
    conn.phase === 'testing'
      ? t('settingsTesting')
      : conn.phase === 'ok'
        ? t('accountConsumeConnOk', { ms: conn.ms })
        : conn.phase === 'fail'
          ? t('accountConsumeConnFail')
          : t('accountConsumeConnIdle')
  const connDot =
    conn.phase === 'ok'
      ? styles.dot
      : conn.phase === 'testing'
        ? `${styles.dot} ${styles.dotTesting}`
        : conn.phase === 'fail'
          ? `${styles.dot} ${styles.dotFail}`
          : `${styles.dot} ${styles.dotIdle}`

  const walletView = view === 'cards' || view === 'buy' || view === 'quota' || view === 'history'
  const accountViewActive = view === 'account'
  /**
   * 服务端给的 `email_masked` **已经脱敏**，再走一遍 `maskedEmail` 会变成 `a•••***@b.co`（#660）；
   * 没有这个字段时才在本地打码。
   */
  const displayEmail = ((): string => {
    if (authUser === null) {
      return ''
    }
    // `AuthUser`（登录态 store）没有 `email_masked`，`ConsumeUser`（/user/profile）才有：
    // 用 `in` 收窄，避免为了一个显示字段把两边的类型合并成一份新类型。
    if ('emailMasked' in authUser && typeof authUser.emailMasked === 'string' && authUser.emailMasked !== '') {
      return authUser.emailMasked
    }
    return maskedEmail(authUser.email)
  })()
  const avatarText = ((): string => {
    if (authUser === null) {
      return '—'
    }
    const name = authUser.username ?? authUser.email
    return name.slice(0, 1).toUpperCase() || '—'
  })()

  return (
    <Modal
      title={<span className={styles.pageTitle}>{t('accountConsumeTitle')}</span>}
      closable
      zIndex={1100}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
    >
      <div className={styles.page} data-testid="account-consume-page">
        {/* ── 模型来源 + 连通性测试 ─────────────────────────────────────────── */}
        <div className={styles.rows}>
          <button type="button" className={styles.row} data-testid="account-consume-source" onClick={() => setSheet(true)}>
            <span className={styles.rowMain}>{t('accountConsumeGroupSource')}</span>
            <span className={styles.value}>{configured ? t(sourceLabelKey) : ''} ›</span>
          </button>
          {configured ? (
            <>
              <div className={styles.divider} />
              <button
                type="button"
                className={styles.row}
                data-testid="account-consume-conn"
                onClick={() => void runTest()}
              >
                <span className={styles.rowMain}>{t('settingsTestLabel')}</span>
                <span className={styles.value} data-testid="account-consume-conn-state">
                  <i className={connDot} aria-hidden="true" />
                  {connText}
                </span>
              </button>
            </>
          ) : null}
        </div>

        {/* ── 我的钱包 ────────────────────────────────────────────────────── */}
        <div className={styles.dividerFull} />
        <div className={styles.ghead}>{t('accountConsumeWallet')}</div>
        <div className={styles.balance} data-testid="account-consume-balance">
          <div className={styles.balanceKey}>{t('accountConsumeRemaining')}</div>
          {/* 未登录 / 恢复中：给「—」，不显示一个来路不明的 0.00 */}
          <div className={styles.balanceValue}>
            {signedIn === null ? '…' : balance === undefined ? '—' : formatCurrency(balance)}
          </div>
        </div>
        <div role="tablist" aria-label={t('accountConsumeWallet')} className={styles.rows}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'cards'}
            className={styles.row}
            data-testid="account-consume-tab-cards"
            onClick={() => setView('cards')}
          >
            <span className={styles.rowMain}>{t('accountConsumeTabCards')}</span>
            <span className={styles.value}>›</span>
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            className={styles.row}
            data-testid="account-consume-history"
            onClick={() => setView('history')}
          >
            <span className={styles.rowMain}>{t('accountConsumeHistory')}</span>
            <span className={styles.value}>›</span>
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            role="tab"
            aria-selected={view === 'quota'}
            className={styles.row}
            data-testid="account-consume-tab-quota"
            onClick={() => setView('quota')}
          >
            <span className={styles.rowMain}>{t('accountConsumeTabQuota')}</span>
            <span className={styles.value}>›</span>
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            role="tab"
            aria-selected={view === 'buy'}
            className={styles.row}
            data-testid="account-consume-tab-buy"
            onClick={() => setView('buy')}
          >
            <span className={styles.rowMain}>{t('oursPayTitle')}</span>
            <span className={styles.value}>›</span>
          </button>
        </div>

        {/* 钱包的四个列表都开在分区下面（同一页，不再弹第二层）*/}
        {walletView ? (
          <div className={styles.viewBody}>
            {view === 'cards' ? (
              <MyCardsTab consume={consume} onGoBuy={() => setView('buy')} onNeedLogin={needLogin} />
            ) : null}
            {view === 'buy' ? <BuyTab onPurchased={backToCards} /> : null}
            {view === 'quota' ? (
              <QuotaPanel consume={consume} onNeedLogin={needLogin} signedIn={signedIn} onSignIn={needLogin} />
            ) : null}
            {view === 'history' ? <HistoryView consume={consume} signedIn={signedIn === true} /> : null}
          </div>
        ) : null}

        {/* ── 账号 ────────────────────────────────────────────────────────── */}
        <div className={styles.dividerFull} />
        <div className={styles.ghead}>{t('accountConsumeTabAccount')}</div>
        {signedIn === true ? (
          <div className={styles.profile} data-testid="account-consume-profile">
            <div className={styles.avatar} aria-hidden="true">
              {avatarText}
            </div>
            <div className={styles.profileText}>
              <div className={styles.profileName}>
                {authUser === null || authUser.username === undefined || authUser.username === ''
                  ? displayEmail
                  : authUser.username}
              </div>
              <div className={styles.profileMail}>{displayEmail}</div>
            </div>
          </div>
        ) : null}
        <div role="tablist" aria-label={t('accountConsumeTabAccount')} className={styles.rows}>
          <button
            type="button"
            role="tab"
            aria-selected={accountViewActive}
            className={styles.row}
            data-testid="account-consume-tab-account"
            onClick={() => setView('account')}
          >
            <span className={styles.rowMain}>{t('accountConsumeSecurity')}</span>
            <span className={styles.value}>{signedIn === true ? '›' : t('accountConsumeSignedOutCta')}</span>
          </button>
          {signedIn === true ? (
            <>
              <div className={styles.divider} />
              <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-id">
                <span className={styles.rowMain}>{t('accountConsumeAccountId')}</span>
                <span className={styles.value}>{authUser === null ? '—' : String(authUser.id).padStart(8, '0')}</span>
              </div>
              <div className={styles.divider} />
              <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-bind-email">
                <span className={styles.rowMain}>{t('accountConsumeBindEmail')}</span>
                <span className={styles.value}>{displayEmail === '' ? t('accountConsumeEmailUnbound') : displayEmail}</span>
              </div>
              <div className={styles.divider} />
              <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-login-method">
                <span className={styles.rowMain}>{t('accountConsumeLoginMethod')}</span>
                <span className={styles.value}>{t('accountConsumeLoginMethodEmail')}</span>
              </div>
            </>
          ) : null}
        </div>

        {/* 账号列表开在分区下面；未登录时它就是登录 / 注册入口（#608：不设登录墙） */}
        {accountViewActive ? (
          <div className={styles.viewBody}>
            <AccountPanel
              consume={consume}
              user={authUser}
              onNeedLogin={needLogin}
              onFillKey={fillKey}
              authDialog={styles.authDialog}
            />
          </div>
        ) : null}

        {/* 退出登录（红字行，原型 `.logout`）：动作就是既有的 auth store `signOut()`，不另写一套 */}
        {signedIn === true ? (
          signOutAsk ? (
            <div className={styles.rows}>
              <div className={styles.divider} />
              <div className={`${styles.row} ${styles.rowStatic}`}>
                <span className={styles.rowMain}>{t('accountConsumeSignOutConfirm')}</span>
                <span className={styles.value}>
                  <Button
                    variant="outlined"
                    size="s"
                    onClick={() => {
                      setSignOutAsk(false)
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </span>
              </div>
              <div className={styles.sheetActions}>
                <Button
                  block
                  variant="danger"
                  size="m"
                  data-testid="account-consume-signout-confirm"
                  onClick={() => {
                    setSignOutAsk(false)
                    void signOut()
                  }}
                >
                  {t('sub2authLogout')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.divider} />
              <button
                type="button"
                className={styles.logout}
                data-testid="account-consume-signout"
                onClick={() => setSignOutAsk(true)}
              >
                {t('sub2authLogout')}
              </button>
            </>
          )
        ) : null}

        <div className={styles.spacer} />
      </div>
      {sheet ? (
        <SourceSheet
          onClose={() => setSheet(false)}
          onConfigured={() => {
            setSheet(false)
            void runTest()
          }}
          onNeedLogin={() => {
            setSheet(false)
            needLogin()
          }}
        />
      ) : null}
    </Modal>
  )
}
