/**
 * 「账户与消费」—— **设置弹层里的第三个 tab**（#727 阶段 1 布局）。
 *
 * 层级（维护者口径）：设置在容器最外层，本文件只是第三个 tab 的内容区，**以及它的下级页面**：
 *
 *   设置（一个容器：头部 / 关闭按钮 / 左侧导航都是设置自己的）
 *     ├─ Tab1 通用设置
 *     ├─ Tab2 数据管理     → 聊天背景 / 导入 / 导出 / 反馈日志 / 删除
 *     └─ Tab3 账户与消费   ← 本文件
 *         L1（列表页，页首就是余额卡）
 *           ├─ 余额卡：剩余余额 ¥x.xx（+ 卡内「我的额度」入口）
 *           ├─ 模型来源        → 行（右侧当前来源名）→ L2 页：**三行**（内置服务 / 第三方服务 /
 *           │                     DeepSeek 官方服务）→ 点某一行进 L3 子页：字段 / 连通性测试
 *           ├─ 我的卡密        → 行 → L2 页（卡密列表 + 兑换卡密）
 *           ├─ 历史消费        → 行 → L2 页（消费记录）
 *           └─ 账号            → 行 → L2 页（资料 / 账号 ID / 绑定邮箱 / 登录方式 / 退出登录）
 *
 * 五条硬约定（本阶段只动布局）：
 *  1. **不自带外壳**：没有 `Modal`、没有遮罩、没有第二个 X —— 头部 / 关闭按钮全部复用设置的；
 *  2. **子行是「进入下一级页面」**，不是在导航下面原地展开：`page` 由外层（设置弹层）持有，
 *     非 `null` 时设置头部换成该页标题 + 「返回」，内容区整体替换；
 *  3. **不做第二份客户端**：一个 `ConsumeClient`，默认用全应用共享的 `getConsumeClient()`；
 *  4. **面板逻辑原样复用**：卡密 / 购买 / 额度还是 `MyCardsTab` / `BuyTab` /
 *     `QuotaPanel` 那三个既有组件，本文件只负责「把它们放到原型的位置上」；
 *  5. L1 只留**一行**「模型来源」（右侧显示当前来源名）；它点进去是**三行 inset 列表**（每行 56px、
 *     左右 20px、1px 极浅下边框、右侧 `›`，**不是分段控件**），再点某一行才进字段子页：
 *     API Key / 服务地址 / 模型 / 连通性测试（设置弹层把这些字段通过 `sourceConfig` 注入，不造第二份）。
 *
 * #608 仍然成立：未登录可用、只填 Key 可用；未登录态账号页 = 登录 / 注册入口 + 「不登录也可以…」，
 * **没有登录墙**。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  getApiKey,
  getBaseUrl,
  setProviderKind,
  useApiConfig,
} from '../../services/api/apiConfig.js'
import { PROBE_TIMEOUT_MS, probeProvider } from '../../services/api/client.js'
import type { ConsumeClient, ConsumeUser } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { SettingsAuthCard } from './SettingsAuthCard.js'
import { getAccessToken, useAuthStore } from '../../services/auth/store.js'
import { LegacyMigrationButton } from '../../legacy/migration/LegacyMigrationButton.js'
import { useLegacyMigrationResult } from '../../legacy/migration/resultState.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { QuotaPanel } from './index.js'
import { BuyTab } from './BuyTab.js'
import { HistoryView } from './HistoryView.js'
import { MyCardsTab } from './MyCardsTab.js'
import { runWalletAutoRedeem, type WalletAutoRedeemOutcome } from './walletAutoRedeem.js'
import { formatCurrency, maskedEmail } from './panels.js'
import { SourceSheet, sourceKeyOf } from './SourceSheet.js'
import styles from './AccountConsume.module.css'

/**
 * 「账户与消费」的下级页面（L2）。`null` = L1 列表页。
 *
 * 类型放在这里而不是设置的状态层：它只描述「这一页内部展示什么」，进出都由内容区自己点，
 * 不参与 `openSettings` / 付款回跳那套跨模块状态。
 */
export type AccountSubPage = 'wallet' | 'source' | 'cards' | 'buy' | 'quota' | 'history' | 'account'

/** 连通性三态（#727 §二）：`idle` 还没测 / `testing` 测试中 / `ok` 正常 / `fail` 失败可重试 */
type ConnState = { phase: 'idle' } | { phase: 'testing' } | { phase: 'ok'; ms: number } | { phase: 'fail' }

/** 「模型来源」的三个选项（底层 kind：内置=ours / 第三方=openai|anthropic / 官方=deepseek） */
type SourceOption = 'builtin' | 'third' | 'official'

/** 三行的文案（行名与子页标题共用同一份；**不再用「渠道」那套旧词条**） */
const SOURCE_LABEL_KEY: Record<SourceOption, TranslationKey> = {
  builtin: 'accountConsumeSourceBuiltin',
  third: 'accountConsumeSourceThird',
  official: 'accountConsumeSourceOfficial',
}

const SOURCE_OPTIONS: SourceOption[] = ['builtin', 'third', 'official']

/** 第三方服务下的两个协议（既有两个 kind，不新增） */
const THIRD_PARTY_PROTOCOLS: { kind: 'openai' | 'anthropic'; labelKey: TranslationKey }[] = [
  { kind: 'openai', labelKey: 'settingsProtocolOpenai' },
  { kind: 'anthropic', labelKey: 'settingsProtocolAnthropic' },
]

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
   * L2「模型来源」页的配置区（渠道下拉 / API Key / 模型 / 连通性测试）。
   *
   * 由外层传进来 —— 那些字段的编辑状态（`useApiKeyEditor`）属于设置弹层，内容区不自己造一份。
   * 不传时（独立渲染 / 截图脚本 / 面板联调）回落到「点一行开底部 sheet」的老形态。
   */
  sourceConfig?: ReactNode
}

export const AccountConsumePage = ({
  page,
  onNavigate,
  consume: injected,
  user = null,
  onNeedLogin,
  sourceConfig,
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
  /** 「登录后那一次」迁移的结论（#498 的临时尾巴）；`null` = 还没跑过 */
  const migrationResult = useLegacyMigrationResult((state) => state.result)
  const kind = useApiConfig((state) => state.kind)
  const apiKey = useApiConfig((state) => state.apiKey)

  const [sheet, setSheet] = useState(false)
  /**
   * 「模型来源」里点开的是哪一行（`null` = 三行列表本身）。
   *
   * 这一层**留在内容区**：它只是同一页里的下一屏（标题换成行名、左上「‹ 返回」），
   * 不进设置层的 `page`，所以返回不会离开设置、也不会把 tab 换掉。
   */
  const [sourceRow, setSourceRow] = useState<SourceOption | null>(null)
  const [conn, setConn] = useState<ConnState>({ phase: 'idle' })
  const [balance, setBalance] = useState<number | undefined>(undefined)
  const [walletTick, setWalletTick] = useState(0)
  const [signOutAsk, setSignOutAsk] = useState(false)
  /**
   * #784：「付款回来」那一次自动兑现的结局。只有 `openPayLinkInApp` 的 `onClosed` 会写它
   * （见 `backToCards`）；进钱包页 / 切 tab 都碰不到，所以卡片不会「自己冒出来」。
   */
  const [autoRedeem, setAutoRedeem] = useState<WalletAutoRedeemOutcome | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 离开「模型来源」这一页时收起子页：下次进来先看到三行，而不是上次停的那一行 */
  useEffect(() => {
    if (page !== 'source') {
      setSourceRow(null)
    }
  }, [page])

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
      // 探测超时显式传入（#771）：与设置页同一个 15s，不被 connectMs（60s）拖成转圈一分钟
      const result = await probeProvider(
        { baseUrl: getBaseUrl(), apiKey: key },
        PROBE_TIMEOUT_MS
      )
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
   * 收款页关掉后回到「我的卡密」（卡密由小铺发到订单上）并让余额重拉一次。
   *
   * **#784 的唯一触发点**：本回调只由 `BuyTab` 的 `openPayLinkInApp(url, onClosed)` 里的
   * `onClosed` 调用（`BuyTab` 的 `onPurchased`），而 `onClosed` 就是「用户从收款页回来了」。
   * 所以进钱包页 / 进卡密 tab / 挂载组件都**不会**走到这里 —— 自动兑现只在付款回来这一下发生。
   *
   * 自动兑现本身不在这里写逻辑：判定与不发第二枪的规则全在 `walletAutoRedeem.ts`（复用既有的
   * `consume.redeem` 封装，一行兑换逻辑都没有重写）。这里只负责「把结局交给界面」：
   *  - 未登录 → 一句「登录后自动到账」，不提交；
   *  - 到账 → toast「已自动到账 ¥X」+ 让余额卡重拉一次；
   *  - 其余（处理中 / 失败 / 打码卡）→ 卡片 + 「去兑换」手动出口，**没有自动重试**。
   */
  const backToCards = useCallback(() => {
    onNavigate('cards')
    setWalletTick((tick) => tick + 1)
    void runWalletAutoRedeem({ client: consume, signedIn: signedIn === true })
      .then((outcome) => {
        if (!alive.current) {
          return
        }
        if (outcome.kind === 'skipped') {
          // 只有「没登录」要说话：其余跳过（历史读不到 / 没有待兑 / 已经兑过）都是「没事发生」
          if (outcome.reason === 'not-signed-in') {
            showToast(t('walletAutoRedeemNeedSignIn'))
          }
          return
        }
        setAutoRedeem(outcome)
        if (outcome.kind === 'credited') {
          // 余额变了：再 bump 一次，让余额卡读到兑换后的 `/user/profile`
          setWalletTick((tick) => tick + 1)
          showToast(
            outcome.amount === undefined
              ? t('consumeRedeemSuccess')
              : t('walletAutoRedeemCredited', { amount: formatCurrency(outcome.amount) })
          )
        }
      })
      .catch(() => undefined)
  }, [consume, onNavigate, signedIn, t])

  const SOURCE_LABEL_KEYS: Record<string, TranslationKey> = {
    builtin: 'accountConsumeSourceBuiltin',
    third: 'accountConsumeSourceThird',
    deepseek: 'accountConsumeSourceOfficial',
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
  /**
   * 账号 ID 分段显示（原型 `8842 1907`）：补齐 8 位后每 4 位一组，中间一个空格。
   * 只是显示层排版，值本身不变（`authUser.id`）。
   */
  const accountIdText = ((): string => {
    if (authUser === null) {
      return '—'
    }
    const padded = String(authUser.id).padStart(8, '0')
    return `${padded.slice(0, 4)} ${padded.slice(4, 8)}`
  })()
  /** 「绑定邮箱」行：没有邮箱就留空只给箭头（原型就是这样，不写「未绑定」把人吓一跳） */
  const emailBound = displayEmail !== ''
  const avatarText = ((): string => {
    if (authUser === null) {
      return '—'
    }
    const name = authUser.username ?? authUser.email
    return name.slice(0, 1).toUpperCase() || '—'
  })()

  /** 连通性测试一行（子页的兜底、以及不接 `sourceConfig` 的独立渲染共用同一份 JSX） */
  const connRow = (
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
  )

  /**
   * 来源子页里的字段区（服务地址 / API Key / 模型 / 连通性测试）。
   *
   * 设置弹层里这些字段由外层注入（`sourceConfig`，按 `spec.fields` 渲染）；独立渲染时回落到
   * 「只有一行连通性测试」的老形态，保证面板联调 / 截图脚本仍能跑。
   */
  const sourceFields = sourceConfig ? <div className={styles.viewBody}>{sourceConfig}</div> : null

  /** 独立渲染（没有 `sourceConfig`）时的兜底：一行「模型来源」开底部 sheet + 一行连通性测试 */
  const sourcePage = sourceFields ?? (
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
      {connRow}
    </div>
  )

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
    wallet: 'accountConsumeWallet',
    source: 'accountConsumeGroupSource',
    cards: 'accountConsumeTabCards',
    buy: 'oursPayTitle',
    quota: 'accountConsumeTabQuota',
    history: 'accountConsumeHistory',
    account: 'accountConsumeTabAccount',
  }

  /** 下级页面的头部：左上角「返回」+ 本页标题（设置弹层的头部与 X 不动，这里只是内容区的二级头） */
  /**
   * 点「模型来源」里的某一行 → 进它的子页（同一容器内换一屏）。
   *
   * **只有内置服务判断登录**（托管 Key / 余额挂在账号上）：未登录 → 去登录/注册，不留在子页；
   * 第三方服务与 DeepSeek 官方服务永远不拦，直接切 kind 让用户填 Key（#608）。
   */
  const chooseSource = useCallback(
    (source: SourceOption) => {
      if (source === 'builtin') {
        if (signedIn !== true) {
          onNavigate('account')
          return
        }
        setProviderKind('ours')
        setSourceRow('builtin')
        return
      }
      if (source === 'official') {
        setProviderKind('deepseek')
        setSourceRow('official')
        return
      }
      // 第三方服务：保持当前协议（老用户已选 anthropic 就还是 anthropic），默认 OpenAI 兼容
      setProviderKind(kind === 'anthropic' ? 'anthropic' : 'openai')
      setSourceRow('third')
    },
    [kind, onNavigate, signedIn]
  )

  /** 与 `subHeader` 同形，只是标题换成一个自定义词条（例如登录卡出现时这一屏叫「登录」） */
  const subHeaderWithTitle = (back: AccountSubPage | null, titleKey: TranslationKey) => (
    <div className={styles.subHeader}>
      <button
        type="button"
        className={styles.subBack}
        data-testid="account-consume-back"
        onClick={() => onNavigate(back)}
      >
        <IconChevronRightOutline14 />
        {t('back')}
      </button>
      <span className={styles.subTitle}>{t(titleKey)}</span>
    </div>
  )

  const subHeader = (target: AccountSubPage, back: AccountSubPage | null) => (
    <div className={styles.subHeader}>
      <button
        type="button"
        className={styles.subBack}
        data-testid="account-consume-back"
        onClick={() => onNavigate(back)}
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

  // ───────────────────────────── L2：我的钱包（余额卡 + 我的卡密 / 历史消费） ──────
  if (page === 'wallet') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('wallet', null)}
        {/* 余额卡放在这一页的最上面 */}
        {balanceCard}
        <div className={styles.rows}>
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
        {/* 老账号额度迁移（#498 的临时尾巴，@remove-after 1.6.0）：本行只是**挂载点**，
            「显不显示」全由组件自己判 —— `migration.enabled !== true` 时组件 `return null`，
            所以默认关闭的构型里这一页**没有任何痕迹**（不是空按钮、不是占位）。
            有结果时（登录后那一次已经跑过）传 `initial`：`migrated` → 「历史额度已迁移：¥X」；
            `already_migrated` + 金额 0 的兜底入口（「仍要迁移」）也在组件里。 */}
        {signedIn === true ? (
          <LegacyMigrationButton initial={migrationResult ?? undefined} getToken={getAccessToken} />
        ) : null}
        {sheetNode}
      </div>
    )
  }

  // ───────────────────── L2：模型来源（三行 inset 列表）／L3：每行的子页 ────────────────
  if (page === 'source') {
    /**
     * 「模型来源」= **一屏三行**（inset 列表，不是分段控件），每行点进去是**同一容器内的子页**：
     *
     *   内置服务（kind=ours）       → **只有它判断登录**：未登录 → 登录/注册；已登录 → 托管 Key + 余额入口 + 连通性测试
     *   第三方服务                   → 协议（OpenAI 兼容 / Anthropic）+ 服务地址 + API Key + 模型 + 连通性测试
     *   DeepSeek 官方服务（deepseek）→ API Key + 内置模型（只读）+ 连通性测试
     *
     * 底层仍是既有的 `ProviderKind`：这里只是「三个来源 + 一个协议切换」的入口，
     * 字段渲染照旧由 `spec.fields` 决定（`ApiConfigFields`），不新增任何渠道状态。
     */
    if (sourceRow !== null) {
      // 子页：标题就是行名，左上「‹ 返回」只回三行列表 —— 不离开设置这个容器
      return (
        <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
          <div className={styles.subHeader}>
            <button
              type="button"
              className={styles.subBack}
              data-testid="account-consume-source-back"
              onClick={() => setSourceRow(null)}
            >
              <IconChevronRightOutline14 />
              {t('back')}
            </button>
            <span className={styles.subTitle}>{t(SOURCE_LABEL_KEY[sourceRow])}</span>
          </div>
          {sourceRow === 'builtin' ? (
            /* 余额挂在账号上：内置服务的子页里给一个回「我的钱包」的入口（金额只登录后读得到） */
            <div className={styles.rows}>
              <button
                type="button"
                className={styles.row}
                data-testid="account-consume-source-balance"
                onClick={() => onNavigate('wallet')}
              >
                <span className={styles.rowMain}>{t('accountConsumeRemaining')}</span>
                <span className={styles.value}>
                  {signedIn === true ? formatCurrency(balance ?? 0) : ''}
                  <i className={styles.chevron} aria-hidden="true">
                    ›
                  </i>
                </span>
              </button>
              <div className={styles.divider} />
            </div>
          ) : null}
          {sourceRow === 'third' ? (
            /* 协议是第三方服务自己的事，所以这一组分段只在这个子页里出现 */
            <div className={styles.authSegmented} role="group" aria-label={t('settingsThirdPartyProtocol')}>
              {THIRD_PARTY_PROTOCOLS.map((protocol) => (
                <button
                  key={protocol.kind}
                  type="button"
                  className={kind === protocol.kind ? `${styles.authSeg} ${styles.authSegOn}` : styles.authSeg}
                  aria-pressed={kind === protocol.kind}
                  data-testid={`settings-protocol-${protocol.kind}`}
                  onClick={() => setProviderKind(protocol.kind)}
                >
                  {t(protocol.labelKey)}
                </button>
              ))}
            </div>
          ) : null}
          {sourcePage}
          {sheetNode}
        </div>
      )
    }
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('source', null)}
        <div className={styles.rows} data-testid="account-consume-source-list">
          {SOURCE_OPTIONS.map((option, index) => (
            <Fragment key={option}>
              {index === 0 ? null : <div className={styles.divider} />}
              <button
                type="button"
                className={styles.row}
                data-testid={`settings-source-${option}`}
                onClick={() => chooseSource(option)}
              >
                <span className={styles.rowMain}>{t(SOURCE_LABEL_KEY[option])}</span>
                <span className={styles.value}>
                  <i className={styles.chevron} aria-hidden="true">
                    ›
                  </i>
                </span>
              </button>
            </Fragment>
          ))}
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：我的卡密（列表 + 兑换卡密） ──────────────────
  if (page === 'cards') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('cards', 'wallet')}
        <div className={styles.viewBody}>
        {/* 页标题由设置头部给（「我的卡密」+ 返回），这里不再写第二份同名标题 */}
        <MyCardsTab
          consume={consume}
          hideListTitle
          autoRedeem={autoRedeem}
          onDismissAutoRedeem={() => setAutoRedeem(null)}
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
        {subHeader('buy', 'wallet')}
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
        {subHeader('quota', 'wallet')}
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
        {subHeader('history', 'wallet')}
        <div className={styles.viewBody}>
        <HistoryView consume={consume} signedIn={signedIn === true} />
        </div>
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L2：账号（资料 / 安全 / 退出登录） ──────────────
  //
  // 版式照原型 1:1：居中标题 + 左「返回」；资料区（56px 圆头像 + 昵称 + 邮箱）+ 56px 行（左右 20px 内距、
  // 行间只一条 1px 极浅分隔线，不给每行套描边盒子）；「退出登录」独立一行、红字居中、无箭头。
  // 主题全走 token（`--dsw-alias-*` / danger），不硬编码浅色 —— 深色下同样是这套版式。
  if (page === 'account') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {signedIn === true ? subHeader('account', null) : subHeaderWithTitle(null, 'sub2authLogin')}

        {/* 资料区：已登录 = 头像 + 昵称 + 邮箱；未登录 = 一句「未登录」（登录 / 注册入口在下方的账号面板） */}
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

        {/* 行区：未登录时不摆一排「—」，直接给登录 / 注册入口（#608：不设登录墙） */}
        {signedIn === true ? (
          <div className={styles.rows}>
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-id">
              <span className={styles.rowMain}>{t('accountConsumeAccountId')}</span>
              <span className={styles.value}>
                {accountIdText}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
            <div className={styles.divider} />
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-bind-email">
              <span className={styles.rowMain}>{t('accountConsumeBindEmail')}</span>
              <span className={styles.value}>
                {emailBound ? displayEmail : ''}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
            <div className={styles.divider} />
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-login-method">
              <span className={styles.rowMain}>{t('accountConsumeLoginMethod')}</span>
              <span className={styles.value}>
                {t('accountConsumeLoginMethodEmail')}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.viewBody} data-testid="account-consume-tab-account">
            {/* 未登录 = **这一页就是登录界面**：登录 / 注册分段 + 获取验证码 + 忘记密码 +
                「暂不登录」（#608 的口子，直接去填 API Key）。 */}
            <SettingsAuthCard consume={consume} onSkip={() => onNavigate('source')} />
          </div>
        )}

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
        {sheetNode}
      </div>
    )
  }

  // ───────────────────────────── L1：列表页（三行：模型来源 / 我的钱包 / 账号） ──
  return (
    <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
      <div role="tablist" aria-label={t('accountConsumeTitle')} className={styles.rows}>
        {/* 1) 模型来源收成一行：右侧是当前渠道名；未登录先去登录界面（登录后才是配置页） */}
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className={styles.row}
          data-testid="account-consume-source"
          onClick={() => onNavigate('source')}
        >
          <span className={styles.rowMain}>{t('accountConsumeGroupSource')}</span>
          <span className={styles.value}>{configured ? t(sourceLabelKey) : ''} ›</span>
        </button>
        <div className={styles.divider} />
        {/* 2) 我的钱包：余额卡 / 我的卡密 / 历史消费都在它点进去的那一页，L1 不摊开余额卡 */}
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className={styles.row}
          data-testid="account-consume-wallet"
          onClick={() => onNavigate('wallet')}
        >
          <span className={styles.rowMain}>{t('accountConsumeWallet')}</span>
          <span className={styles.value}>›</span>
        </button>
        <div className={styles.divider} />
        {/* 3) 账号：未登录进去就是登录界面（#608 的 key-only 口子在那页底部） */}
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
