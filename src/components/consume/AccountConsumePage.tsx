/**
 * 「账户与消费」—— **设置弹层里的第三个 tab**（#727 阶段 1 布局）。
 *
 * 层级（维护者口径）：设置在容器最外层，本文件只是第三个 tab 的内容区，**以及它的下级页面**：
 *
 *   设置（一个容器：头部 / 关闭按钮 / 左侧导航都是设置自己的）
 *     ├─ Tab1 通用设置
 *     ├─ Tab2 数据管理     → 聊天背景 / 导入 / 导出 / 反馈日志 / 删除
 *     └─ Tab3 账户与消费   ← 本文件
 *         L1（列表页）
 *           ├─ 模型来源        → 行 → 底部 sheet（不换页）
 *           ├─ 连通性测试      → 行（三态）
 *           ├─ 我的钱包        → 剩余余额 ¥x.xx（余额卡）+ 我的额度（卡内入口）
 *           ├─ 我的卡密        → 行 → L2 页（卡密列表 + 兑换卡密）
 *           ├─ 历史消费        → 行 → L2 页（消费记录）
 *           └─ 账号            → 行 → L2 页（资料 / 账号 ID / 绑定邮箱 / 登录方式 / 账号与安全 / 退出登录）
 *
 * 五条硬约定（本阶段只动布局）：
 *  1. **不自带外壳**：没有 `Modal`、没有遮罩、没有第二个 X —— 头部 / 关闭按钮全部复用设置的；
 *  2. **子行是「进入下一级页面」**，不是在导航下面原地展开：`page` 由外层（设置弹层）持有，
 *     非 `null` 时设置头部换成该页标题 + 「返回」，内容区整体替换；
 *  3. **不做第二份客户端**：一个 `ConsumeClient`，默认用全应用共享的 `getConsumeClient()`；
 *  4. **面板逻辑原样复用**：卡密 / 购买 / 额度 / 账号还是 `MyCardsTab` / `BuyTab` / `QuotaPanel` /
 *     `AccountPanel` 那四个既有组件，本文件只负责「把它们放到原型的位置上」；
 *  5. `模型来源` / `连通性测试` 两行只在**独立渲染**（`showSourceRows`，截图脚本/旧文档用）时出现；
 *     设置弹层里渠道 / API Key / 模型由 tab 3 顶部的 `ApiConfigFields` 承担，两处都渲染就是重复。
 *
 * #608 仍然成立：未登录可用、只填 Key 可用；未登录态账号页 = 登录 / 注册入口 + 「不登录也可以…」，
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
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { AccountPanel, QuotaPanel } from './index.js'
import { BuyTab } from './BuyTab.js'
import { HistoryView } from './HistoryView.js'
import { MyCardsTab } from './MyCardsTab.js'
import { formatCurrency, maskedEmail } from './panels.js'
import { SourceSheet, sourceKeyOf } from './SourceSheet.js'
import styles from './AccountConsume.module.css'

/**
 * 「账户与消费」的下级页面（L2）。`null` = L1 列表页。
 *
 * 类型放在这里而不是设置的状态层：它只描述「这一页内部展示什么」，进出都由内容区自己点，
 * 不参与 `openSettings` / 付款回跳那套跨模块状态。
 */
export type AccountSubPage = 'cards' | 'buy' | 'quota' | 'history' | 'account'

/** 连通性三态（#727 §二）：`idle` 还没测 / `testing` 测试中 / `ok` 正常 / `fail` 失败可重试 */
type ConnState = { phase: 'idle' } | { phase: 'testing' } | { phase: 'ok'; ms: number } | { phase: 'fail' }

export type AccountConsumePanelProps = {
  /**
   * 当前显示哪一屏：`null` = L1 列表页，其余 = 各自的下级页面（L2）。
   *
   * **为什么由外层持有**：L2 出现时，tab 3 顶上的「模型来源（渠道 / API Key / 模型）」要让位 ——
   * 内容区整体换成下级页面，而不是"导航下面接一段内容"。外层（设置弹层）同时也用它决定
   * 顶部配置区显不显示，所以状态放在外层，本文件只按 `page` 渲染。
   */
  page: AccountSubPage | null
  /** 进入下级页面（`null` = 回 L1） */
  onNavigate: (page: AccountSubPage | null) => void
  /** 用的消费侧客户端；不传就用全应用共享的那一个 */
  consume?: ConsumeClient
  /** 当前用户；不传则取 W1-B 的登录态 */
  user?: ConsumeUser | null
  /** 需要登录时的出口（L2 账号页 = 登录 / 注册入口） */
  onNeedLogin?: () => void
  /**
   * 是否渲染「模型来源 / 连通性测试」两行。设置弹层里默认由 `ApiConfigFields` 承担（传 `false`），
   * 只有独立渲染（截图脚本 / 面板联调）时才需要它自己带这两行。
   */
  showSourceRows?: boolean
}

export const AccountConsumePage = ({
  page,
  onNavigate,
  consume: injected,
  user = null,
  onNeedLogin,
  showSourceRows = true,
}: AccountConsumePanelProps) => {
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
   * 连通性测试：复用既有的 `probeProvider`（与设置里那个「测试」按钮同一条实现）。
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

  /** 登录出口（#608）：登录 / 注册入口就在账号页，不换容器、不设登录墙 */
  const needLogin = useCallback(() => {
    onNavigate('account')
    onNeedLogin?.()
  }, [onNavigate, onNeedLogin])

  /**
   * 未登录态「去填 API Key」：Key / 渠道就住在这张 L1 页顶上的配置区，
   * 所以这里只是把「模型来源」的 sheet 打开 —— 换 tab、开新弹层都是多余的。
   */
  const fillKey = useCallback(() => {
    setSheet(true)
  }, [])

  /** 收款页关掉后回到「我的卡密」（卡密由小铺发到订单上）并让余额重拉一次 */
  const backToCards = useCallback(() => {
    onNavigate('cards')
    setWalletTick((tick) => tick + 1)
  }, [onNavigate])

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

  const sourceRows = showSourceRows ? (
    <>
      <div className={styles.rows}>
        <button
          type="button"
          className={styles.row}
          data-testid="account-consume-source"
          onClick={() => setSheet(true)}
        >
          <span className={styles.rowMain}>{t('accountConsumeGroupSource')}</span>
          <span className={styles.value}>{configured ? t(sourceLabelKey) : ''} ›</span>
        </button>
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
      </div>
    </>
  ) : null

  /** 余额卡：剩余余额（余额卡不是行）；额度收进卡里的一个入口，点它进 L2「我的额度」 */
  const balanceCard = (
    <div className={styles.balance} data-testid="account-consume-balance">
      <div className={styles.balanceKey}>{t('accountConsumeRemaining')}</div>
      {/* 未登录 / 恢复中：给「—」，不显示一个来路不明的 0.00 */}
      <div className={styles.balanceValue}>
        {signedIn === null ? '…' : balance === undefined ? '—' : formatCurrency(balance)}
      </div>
      <button
        type="button"
        className={styles.balanceMore}
        data-testid="account-consume-tab-quota"
        onClick={() => onNavigate('quota')}
      >
        {t('accountConsumeTabQuota')} ›
      </button>
    </div>
  )

  /** L2 页标题（`root` 没有）：与行文案同一批词条，不新写中文 */
  const SUB_PAGE_TITLES: Record<AccountSubPage, TranslationKey> = {
    cards: 'accountConsumeTabCards',
    buy: 'oursPayTitle',
    quota: 'accountConsumeTabQuota',
    history: 'accountConsumeHistory',
    account: 'accountConsumeTabAccount',
  }

  /** 下级页面的头部：左上角「返回」+ 本页标题（设置弹层的头部与 X 不动，这里只是内容区的二级头） */
  const subHeader = (target: AccountSubPage) => (
    <div className={styles.subHeader}>
      <button
        type="button"
        className={styles.subBack}
        data-testid="account-consume-back"
        onClick={() => onNavigate(null)}
      >
        <IconChevronRightOutline14 />
        {t('back')}
      </button>
      <span className={styles.subTitle}>{t(SUB_PAGE_TITLES[target])}</span>
    </div>
  )

  const sheetNode = sheet ? (
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
  ) : null

  // ───────────────────────────── L2：我的卡密（列表 + 兑换卡密） ──────────────────
  if (page === 'cards') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('cards')}
        <div className={styles.viewBody}>
        {/* 页标题由设置头部给（「我的卡密」+ 返回），这里不再写第二份同名标题 */}
        <MyCardsTab
          consume={consume}
          hideListTitle
          onGoBuy={() => onNavigate('buy')}
          onNeedLogin={needLogin}
        />
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：购买（收款页回跳后落回卡密） ────────────────
  if (page === 'buy') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('buy')}
        <div className={styles.viewBody}>
        <BuyTab onPurchased={backToCards} />
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：我的额度（用量） ────────────────────────────
  if (page === 'quota') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('quota')}
        <div className={styles.viewBody}>
        <QuotaPanel consume={consume} onNeedLogin={needLogin} signedIn={signedIn} onSignIn={needLogin} />
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：历史消费 ──────────────────────────────────
  if (page === 'history') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('history')}
        <div className={styles.viewBody}>
        <HistoryView consume={consume} signedIn={signedIn === true} />
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：账号（资料 / 安全 / 退出登录） ──────────────
  if (page === 'account') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('account')}
        <div className={styles.viewBody}>
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
        {signedIn === true ? (
          <div className={styles.rows}>
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
          </div>
        ) : null}
        <div className={styles.ghead}>{t('accountConsumeSecurity')}</div>
        <div data-testid="account-consume-tab-account">
          <AccountPanel
            consume={consume}
            user={authUser}
            onNeedLogin={needLogin}
            onFillKey={fillKey}
            authDialog={styles.authDialog}
          />
        </div>
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
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L1：列表页 ────────────────────────────────────
  return (
    <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
      {sourceRows}
      {showSourceRows ? <div className={styles.dividerFull} /> : null}

      <div className={styles.ghead}>{t('accountConsumeWallet')}</div>
      {balanceCard}

      {/* 子行 = 进入下一级页面（内容区整体替换 + 头部「返回」），不在导航下面原地展开 */}
      <div role="tablist" aria-label={t('accountConsumeWallet')} className={styles.rows}>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className={styles.row}
          data-testid="account-consume-tab-cards"
          onClick={() => onNavigate('cards')}
        >
          <span className={styles.rowMain}>{t('accountConsumeTabCards')}</span>
          <span className={styles.value}>›</span>
        </button>
        <div className={styles.divider} />
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className={styles.row}
          data-testid="account-consume-history"
          onClick={() => onNavigate('history')}
        >
          <span className={styles.rowMain}>{t('accountConsumeHistory')}</span>
          <span className={styles.value}>›</span>
        </button>
      </div>

      <div className={styles.dividerFull} />
      <div className={styles.rows}>
        <button
          type="button"
          className={styles.row}
          data-testid="account-consume-tab-account"
          onClick={() => onNavigate('account')}
        >
          <span className={styles.rowMain}>{t('accountConsumeTabAccount')}</span>
          <span className={styles.value}>{signedIn === true ? '›' : t('accountConsumeSignedOutCta')}</span>
        </button>
      </div>

      {sheetNode}
    </div>
  )
}
