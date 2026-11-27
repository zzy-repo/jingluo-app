/**
 * 「账户与消费」—— **设置弹层里的第三个 tab**（#727 阶段 1 布局）。
 *
 * 层级（维护者口径）：设置在容器最外层，本文件只是第三个 tab 的内容区，**以及它的下级页面**：
 *
 *   设置（一个容器：头部 / 关闭按钮 / 左侧导航都是设置自己的）
 *     ├─ Tab1 通用设置
 *     ├─ Tab2 数据管理     → 聊天背景 / 导入 / 导出 / 反馈日志 / 删除
 *     └─ Tab3 账户与消费   ← 本文件
 *         L1（列表页：模型来源 / 我的钱包 / 账号 三行）
 *           ├─ 模型来源        → 行（右侧当前来源名）→ L2 页：**单层手风琴**（#807）
 *           │                     三行行头（内置服务 / 第三方服务 / DeepSeek 官方服务），
 *           │                     同一时间只展开一行；展开区里是该来源自己的字段 + 「确认使用」，
 *           │                     **没有 L3 子页、没有返回**。展开 ≠ 生效（详见下面第 6 条）
 *           ├─ 我的钱包        → 行 → L2 页，页首**同一行**：余额卡（剩余余额 ¥x.xx）+ 付款入口
 *           │                            （#817：入口只是换页，付款仍是既有 `BuyTab`）
 *           │                     ├─ 我的卡密  → 行 → L2 页（卡密列表 + 兑换卡密）
 *           │                     └─ 历史消费  → 行 → L2 页（消费记录）
 *           └─ 账号            → 行 → L2 页（资料 / 账号 ID / 绑定邮箱 / 登录方式 / 邀请 / 退出登录）
 *
 * #817：「我的额度」这一页**整页退场**（余额卡里那个入口删掉，`'quota'` 不再在 `AccountSubPage`
 * 里）。额度相关的两块信息各有去处：余额还在钱包页首的余额卡里，已用 / 消费明细在「历史消费」
 * （`HistoryView` 复用 `quotaPanelModel.ts` 的解析）。消息流「额度用完 → 去充值」的 CTA 因此改指
 * **钱包页**（`openAccountConsume('wallet')`，见 `messages/AssistantMessage.tsx`）。
 *
 * 六条硬约定：
 *  1. **不自带外壳**：没有 `Modal`、没有遮罩、没有第二个 X —— 头部 / 关闭按钮全部复用设置的；
 *  2. **子行是「进入下一级页面」**（购买 / 卡密 / 历史 / 账号仍是这样）：`page` 由外层
 *     （设置弹层）持有，非 `null` 时内容区整体替换。**唯一的例外是「模型来源」**：它是同一页里的
 *     手风琴（#807），展开某一行不换页、也不出现第三个「返回」；
 *  3. **不做第二份客户端**：一个 `ConsumeClient`，默认用全应用共享的 `getConsumeClient()`；
 *  4. **面板逻辑原样复用**：卡密 / 购买 / 邀请仍是 `MyCardsTab` / `BuyTab` / `InvitePanel` 既有组件
 *     （#817 之后「我的额度」没有挂载点，`QuotaPanel` 本体保留在 `consume/index.ts` 的出口上），
 *     本文件只负责「把它们放到原型的位置上」；邀请面板的挂载点在账号 L2 页（#819 恢复真挂载）；
 *  5. L1 只留**一行**「模型来源」（右侧显示当前来源名）；它点进去是**手风琴**（每行 56px、
 *     左右 20px、1px 极浅下边框、右侧箭头，**不是分段控件**）：点行头只展开它自己的字段区
 *     （服务地址 / API Key / 模型 + 「确认使用」），不再有第三层页面。
 *
 *  6. **「正在查看」与「正在使用」分开**（#807）：展开 / 收起 / 改草稿都只影响「查看」，
 *     生效来源（`chat-demo:provider-kind`）只在两处被切换 —— 内置服务领取成功、
 *     或第三方 / 官方点了「确认使用」。打勾（✓ 当前使用）只绑生效来源，同一时间最多一个。
 *
 * #608 仍然成立：未登录可用、只填 Key 可用；未登录态账号页 = 登录 / 注册入口 + 「不登录也可以…」，
 * **没有登录墙**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useApiConfig } from '../../services/api/apiConfig.js'
import type { ConsumeClient, ConsumeUser } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { MY_ORDERS_DEFAULT_PAGE_SIZE, type ConsumeMyOrder } from '../../services/consume/orders.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { managedKeyTail, shouldSyncManagedKey } from '../../services/api/managedKey.js'
import { detectThirdPartyProtocol } from '../../services/api/protocolDetect.js'
import { syncManagedKeyFromServer } from '../settings/managedKeyRuntime.js'
import { clearManagedKeyBlocked, useSettingsDialog } from '../settings/settingsDialogState.js'
import { SettingsAuthCard } from './SettingsAuthCard.js'
import { getAccessToken, useAuthStore } from '../../services/auth/store.js'
import { LegacyMigrationButton } from '../../legacy/migration/LegacyMigrationButton.js'
import { useLegacyMigrationResult } from '../../legacy/migration/resultState.js'
import { Button } from '../base/Button.js'
import {
  IconDataOutline16,
  IconDocumentOutline16,
  IconSettingsOutline16,
  IconUserOutline16,
  IconWalletOutline16,
} from '../base/icons.js'
import { SettingsBackButton, SettingsCard, SettingsCardRow } from '../settings/CardRow.js'
import { showToast } from '../base/toastState.js'
import { InvitePanel } from './index.js'
import { BuyTab } from './BuyTab.js'
import { HistoryView } from './HistoryView.js'
import { MyCardsTab } from './MyCardsTab.js'
import { runWalletAutoRedeem, type WalletAutoRedeemOutcome } from './walletAutoRedeem.js'
import { WALLET_PAY_ENTRY_PAGE, landAfterPayReturn } from './walletPayFlow.js'
import { runWebPayReturn, subscribeWebPayOpened } from './webPayReturn.js'
import { record } from '../../services/diagnostics/collector.js'
import { buildMeta } from '../../services/diagnostics/fields.js'
import { WalletHeaderView } from './walletHeaderView.js'
import { formatCurrency, maskedEmail } from './panels.js'
import { sourceKeyOf } from './SourceSheet.js'
import { ApiConfigFields, type SourceDraftBinding } from '../settings/ApiConfigFields.js'
import {
  initialSourcePageState,
  planBuiltinClick,
  SOURCE_ROW_LABEL_KEY,
  sourcePageReducer,
  type DraftRowKey,
  type SourcePageEvent,
  type SourceRowKey,
} from '../settings/sourceAccordion.js'
import { SourceAccordionView } from '../settings/sourceAccordionView.js'
import { ManagedKeyEnsureBanner } from '../settings/managedKeyView.js'
import { useManagedKeyEnsure } from '../settings/managedKeyEnsureState.js'
import { ensureManagedKeyForDevice } from '../settings/managedKeyRuntime.js'
import {
  claimBuiltinKey,
  confirmSourceRow,
  hasPendingBuiltinClaim,
  readSourceDrafts,
  rowConfigured,
  selectBuiltin,
  takePendingBuiltinClaim,
  thirdRowKind,
} from '../settings/sourceAccordionRuntime.js'
import styles from './AccountConsume.module.css'

/**
 * 「账户与消费」的下级页面（L2）。`null` = L1 列表页。
 *
 * 类型放在这里而不是设置的状态层：它只描述「这一页内部展示什么」，进出都由内容区自己点，
 * 不参与 `openSettings` / 付款回跳那套跨模块状态。
 */
/**
 * Web 端「付款回来」的兜底节拍：**4.5s 一次、最多 8 次（≈36 秒）**，页面不可见时不查。
 *
 * 为什么要有它（原生端根本不需要）：
 *  - 切回本页的 `visibilitychange` 只给「用户回来了」这一个时刻，而小铺的发卡 / 回调可能晚几秒：
 *    那一刻订单还不是 `COMPLETED`，`runWalletAutoRedeem` 会正常地 `skipped:no-pending`，
 *    之后就没有第二次机会了 —— 于是补一层低频轮询，把「晚几秒的卡」捞回来；
 *  - 上限写死（8 次）而不是一直轮下去：这是**兜底**，不是「客户端负责查单」，
 *    该由用户手动重试的场合必须停在手动重试上（`walletAutoRedeem` 本身也永不自动重试）。
 */
/** 诊断日志里统一用这个 stage，排「为什么没自动兑现」时按它过滤 */
const WEB_PAY_STAGE = 'wallet.pay-return'

const WEB_PAY_POLL_MS = 4500
const WEB_PAY_POLL_MAX = 8
/** 轮询的墙钟上限（2 分钟）：无论用户有没有切回来，定时器到点自己退场（监听仍留着） */
const WEB_PAY_POLL_WALL_MS = 120000

export type AccountSubPage = 'wallet' | 'source' | 'cards' | 'buy' | 'history' | 'account'

/**
 * 各下级页面的标题词条 —— 与行文案同一批，不新写中文。
 *
 * 消费方是设置弹层：标题栏（居中标题 + 右上圆形 X）是**设置容器**的，
 * 这里只把「这一屏叫什么」交给它（第五轮：视觉统一，页内不再自己画标题）。
 */
export const ACCOUNT_SUB_PAGE_TITLES: Record<AccountSubPage, TranslationKey> = {
  wallet: 'accountConsumeWallet',
  source: 'accountConsumeGroupSource',
  cards: 'accountConsumeTabCards',
  buy: 'oursPayTitle',
  history: 'accountConsumeHistory',
  account: 'accountConsumeTabAccount',
}

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
}

export const AccountConsumePage = ({
  page,
  onNavigate,
  consume: injected,
  user = null,
  onNeedLogin,
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
  /**
   * #803：后台「确保有 Key」的可见状态。两次尝试都失败时界面必须说话（不许静默失败）——
   * 内置服务在模型来源页、注册/登录发生在账号页，所以两处都挂同一条 banner。
   */
  const keyEnsureStatus = useManagedKeyEnsure((state) => state.status)
  const keyEnsureFailure = useManagedKeyEnsure((state) => state.failure)
  const keyEnsureAttempts = useManagedKeyEnsure((state) => state.attempts)
  /** #812：失败现场（Key 前 6 位 + 推理地址），让提示能一眼定位「哪把 Key 打到哪」 */
  const keyEnsureContext = useManagedKeyEnsure((state) => state.context)

  /**
   * #807：「模型来源」这一页的全部界面状态 —— 展开的是哪一行、两行的草稿、内置服务的领取状态。
   *
   * 状态机本身在 `settings/sourceAccordion.ts`（纯函数，裸 Node 单测直接跑）：
   * 这里只负责「把事件派进去 + 需要发请求时发一次」。**展开 / 收起一次都不碰生效来源**，
   * 切来源只有两条路：内置服务领取成功、或第三方 / 官方点了「确认使用」。
   */
  const [sourceState, setSourceState] = useState(() => initialSourcePageState(readSourceDrafts()))
  const dispatchSource = useCallback((event: SourcePageEvent) => {
    setSourceState((state) => sourcePageReducer(state, event))
  }, [])
  const [balance, setBalance] = useState<number | undefined>(undefined)
  const [walletTick, setWalletTick] = useState(0)
  /**
   * Web「开过收款页」的会话计数：`0` = 本次挂载还没有开过收款页（此时**不挂**可见性监听）。
   * `BuyTab` 在收款页导航成功那一刻 `markWebPayOpened()`（`webPayReturn.ts`），这里加一。
   */
  const [webPayTick, setWebPayTick] = useState(0)
  const [signOutAsk, setSignOutAsk] = useState(false)
  /**
   * #784：「付款回来」那一次自动兑现的结局。只有 `openPayLinkInApp` 的 `onClosed` 会写它
   * （见 `backToCards`）；进钱包页 / 切 tab 都碰不到，所以卡片不会「自己冒出来」。
   */
  const [autoRedeem, setAutoRedeem] = useState<WalletAutoRedeemOutcome | null>(null)
  /** #803：失败原因（带状态码）+「重试」；重试真的再跑一轮完整流程（查重 → 建） */
  const keyEnsureBanner = signedIn && shouldSyncManagedKey(kind, apiKey) && (
    <ManagedKeyEnsureBanner
      t={t}
      status={keyEnsureStatus}
      failure={keyEnsureFailure}
      attempts={keyEnsureAttempts}
      context={keyEnsureContext}
      onRetry={() => {
        void ensureManagedKeyForDevice()
      }}
      Button={Button}
      styles={styles}
    />
  )

  const alive = useRef(true)
  /** Web 轮询预算（跨 effect 重启不复位：只在新一次「开过收款页」时清零），见下面的 watcher */
  const webPayAttempts = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 离开「模型来源」这一页时把手风琴收起（草稿不动）：下次进来先看到三行行头 */
  useEffect(() => {
    if (page !== 'source') {
      dispatchSource({ type: 'collapse' })
    }
  }, [dispatchSource, page])

  /**
   * #794：展开「第三方服务」那一行时，在后台把协议判一次（`detectThirdPartyProtocol`）。
   *
   * 为什么挂在这里：用户刚在这页填完「服务地址 / 模型」，此刻是唯一能确定「这条地址到底是哪种
   * 协议」的时刻（判据见 `services/api/protocolDetect.ts`）。本地判据（主机 / 模型 / 缓存）不需要
   * 任何请求；只有全都说不清时才探一次 `GET /v1/models`（≤3s），结论落盘缓存。
   *
   * **不在发送链路上做这件事**：发送链路只用本地判据（`syncThirdPartyProtocol`），
   * 首条消息零等待；这里探出来的结论下次发送直接命中缓存。界面不参与判定，
   * 也不因为探测结果跳来跳去（三个字段与协议无关）。
   */
  useEffect(() => {
    if (page !== 'source' || sourceState.open !== 'third') {
      return
    }
    void detectThirdPartyProtocol().catch(() => undefined)
  }, [page, sourceState.open])

  /**
   * #800：内置服务的 **Key 恢复入口**（Key 行连同「重新领取」都不再渲染了）。
   *
   * 发送前那道闸发现「本机这把不是服务端那把」时会写 `managedKeyBlocked` 并把设置打开
   * （`settingsDialogState.ensureApiKey`）。以前这一屏靠用户点「重新领取」收尾；现在没有那个按钮，
   * 所以由这里**自动**做一次幂等对齐（`syncManagedKeyFromServer`：与服务端核对并按服务端覆盖），
   * 成功就把提示清掉、把新尾号说出来。未登录 / 网络失败时什么都不做（提示留着，下次进设置再试）——
   * 登录之后 `App` 的那条对齐也会跑（见 `App.tsx` 里 ours 渠道的对齐 effect）。
   */
  const managedKeyBlocked = useSettingsDialog((state) => state.managedKeyBlocked)
  const [keySync, setKeySync] = useState<'idle' | 'syncing' | 'done'>('idle')
  useEffect(() => {
    if (managedKeyBlocked === null || signedIn !== true) {
      return
    }
    let live = true
    setKeySync('syncing')
    void syncManagedKeyFromServer()
      .then((outcome) => {
        if (!live) {
          return
        }
        if (outcome === 'updated' || outcome === 'unchanged') {
          clearManagedKeyBlocked()
          setKeySync('done')
          return
        }
        setKeySync('idle')
      })
      .catch(() => {
        if (live) {
          setKeySync('idle')
        }
      })
    return () => {
      live = false
    }
  }, [managedKeyBlocked, signedIn])

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

  /** 登录出口（#608）：登录 / 注册入口就在账号页，不换容器、不设登录墙 */
  const needLogin = useCallback(() => {
    onNavigate('account')
    onNeedLogin?.()
  }, [onNavigate, onNeedLogin])

  /**
   * #807 内置服务的**行内领取**（行即动作，没有表单）。
   *
   * 顺序（验收 ③④⑤ 都钉在这上面）：
   *  1. 未登录 → 一个请求都不发，把用户送到登录 / 注册入口（#793 的那套：提示 + 入口），
   *     同时记下「登录后自动继续领取」——登录回来由下面的 effect 接着领，不用再点一次；
   *  2. 领取中 → 行头「领取中…」、整行禁用（防重复领取）；
   *  3. 成功 → **运行时里**才 `setProviderKind('ours')`，所以 ✓ 只会落在拿到 Key 之后；
   *  4. 失败 / 超时 → 不选中，行内写原因（#771 的分类）+「重试」。
   */
  const runBuiltinClaim = useCallback(
    async (signedInNow: boolean) => {
      dispatchSource({ type: 'claim-started' })
      const result = await claimBuiltinKey({ signedIn: signedInNow })
      if (!alive.current) {
        return
      }
      if (result.kind === 'claimed' || result.kind === 'superseded') {
        dispatchSource({ type: 'claim-ok' })
        if (result.kind === 'claimed') {
          showToast(t('settingsSourceSwitched', { name: t(SOURCE_ROW_LABEL_KEY.builtin) }))
        }
        return
      }
      if (result.kind === 'need-login') {
        dispatchSource({ type: 'claim-need-login' })
        showToast(
          { key: 'settingsSourceClaimNeedLogin' },
          { action: { key: 'settingsSourceClaimNeedLoginAction', run: needLogin } }
        )
        needLogin()
        return
      }
      dispatchSource({
        type: 'claim-failed',
        messageKey: result.error.i18nKey,
        retryable: result.error.retryable,
      })
    },
    [dispatchSource, needLogin, t]
  )

  /**
   * 点行头：**只切换「正在查看」的那一行**（同一时间只展开一行，由状态机保证）。
   *
   * 内置服务是唯一的例外：那一行**行即动作**（没有表单），所以展开的同时按
   * `planBuiltinClick()` 的判定做一件事 —— 已经握着服务端那把就直接选中；
   * 否则（没有 / 是旧的 / 未登录）走领取。收起（点已展开的行）什么都不做。
   */
  const onToggleSourceRow = useCallback(
    (row: SourceRowKey) => {
      const willOpen = sourceState.open !== row
      dispatchSource({ type: 'toggle', row })
      if (!willOpen || row !== 'builtin') {
        return
      }
      const plan = planBuiltinClick({ signedIn: signedIn === true, hasKey: rowConfigured('builtin') })
      if (plan.action === 'select') {
        dispatchSource({ type: 'claim-ok' })
        // 已经是内置服务时不再重复写一次存储、也不喊「已切换到…」（重复点 = 只是展开看看）
        if (kind !== 'ours') {
          selectBuiltin()
          showToast(t('settingsSourceSwitched', { name: t(SOURCE_ROW_LABEL_KEY.builtin) }))
        }
        return
      }
      void runBuiltinClaim(plan.action === 'claim')
    },
    [dispatchSource, kind, runBuiltinClaim, signedIn, sourceState.open, t]
  )

  /**
   * ③「登录成功后自动继续领取」：登录态一翻过来（或重新打开设置时待办还在），
   * 接着把那次领取做完 —— 用户不需要再点一次「内置服务」。
   */
  useEffect(() => {
    if (signedIn !== true) {
      return
    }
    if (sourceState.claim.phase !== 'need-login' && !hasPendingBuiltinClaim()) {
      return
    }
    takePendingBuiltinClaim()
    void runBuiltinClaim(true)
  }, [runBuiltinClaim, signedIn, sourceState.claim.phase])

  /**
   * 「确认使用」（第三方 / 官方）：**校验通过才生效**。
   *
   * 校验不过 → 行内红字，生效来源一个字都不动（草稿留着，改完再点）；
   * 通过 → `confirmSourceRow()` 里落盘三件套并切生效来源（这是全页仅有的两处切换之一）。
   */
  const onConfirmSourceRow = useCallback(
    (row: DraftRowKey) => {
      const result = confirmSourceRow(row, sourceState.drafts[row])
      if (result.kind !== 'applied') {
        // `invalid`（校验不过）与 `not-saved`（#986：本机存储写不进去、已整体回滚）走同一条提示通道：
        // 行内红字 + 不弹「已切换」toast。两者的区别只在文案（`messageKey` 由运行时给）。
        dispatchSource({ type: 'submit-failed', row, field: result.field, messageKey: result.messageKey })
        return
      }
      dispatchSource({ type: 'draft-set', row, draft: result.draft })
      dispatchSource({ type: 'submit-ok', row })
      showToast(t('settingsSourceSwitched', { name: t(SOURCE_ROW_LABEL_KEY[row]) }))
    },
    [dispatchSource, sourceState.drafts, t]
  )

  /**
   * 收款页关掉后回到「我的卡密」（卡密由小铺发到订单上）并让余额重拉一次。
   *
   * **#784 的唯一触发点**：本回调只由 `BuyTab` 的 `openPayLinkInApp(url, onClosed)` 里的
   * `onClosed` 调用（`BuyTab` 的 `onPurchased`），而 `onClosed` 就是「用户从收款页回来了」。
   * 所以进钱包页 / 进卡密页 / 挂载组件都**不会**走到这里 —— 自动兑现只在付款回来这一下发生。
   *
   * #817：换页那一句收进了 `landAfterPayReturn()`（`walletPayFlow.ts`），落点是
   * `WALLET_PAY_RETURN_PAGE = 'cards'` —— 从钱包页首的付款入口进去付款，回来同样停在卡密页
   * （两个入口共用同一段 `BuyTab`，所以只有这一处落点）。
   *
   * **Web 也走这里，但入口不同**（原生 `openPayLinkInApp` 在非原生环境仍然返回 false、
   * `onClosed` 不触发 —— 那条链一个字没动）：Web 的收款页开在**新标签页**里，回来的信号是
   * 本文件的 `visibilitychange` + 低频轮询兜底（见下面 `WEB_PAY_POLL_*` 那一段），
   * 两条路最后调的都是同一个 `backToCards`，**自动兑现的判定一行都没有第二份**。
   *
   * 自动兑现本身不在这里写逻辑：判定与不发第二枪的规则全在 `walletAutoRedeem.ts`（复用既有的
   * `consume.redeem` 封装，一行兑换逻辑都没有重写）。这里只负责两件事：
   *  1. 把**数据源**接进去 —— #834 起「我买了什么、卡发了没」与「我的卡密」同一个接口：
   *     `consume.orders.my()`（`GET /api/v1/payment/orders/my`，JWT）。**不再需要 apiKey** ——
   *     旧接口 apia `GET /api/orders` 要的是 apia 签发的 sk- Key，账号迁移后恒 401（#834 的现场）；
   *     没有登录态就不注入，自动兑现那边连请求都不会发；
   *  2. 把结局交给界面：未登录 → 一句「登录后自动到账」，不提交；到账 → toast「已自动到账 ¥X」
   *     + 让余额卡重拉一次；其余（处理中 / 失败 / 打码卡 / 这张卡已经兑过）→ 静默或卡片 + 「去兑换」
   *     手动出口，**没有自动重试**。
   */
  const backToCards = useCallback(() => {
    // 落点只有一份判定（`walletPayFlow.ts`）：收款页关掉之后停在「我的卡密」
    landAfterPayReturn(onNavigate)
    setWalletTick((tick) => tick + 1)
    const loadOrders =
      signedIn !== true
        ? undefined
        : () =>
            consume.orders.my({ page: 1, pageSize: MY_ORDERS_DEFAULT_PAGE_SIZE }).then(
              (result): ConsumeMyOrder[] => {
                if (!result.ok) {
                  // 抛出去：自动兑现那边要能把「订单拉不到」和「没有待兑」在日志里分开（skipped:orders-failed）
                  throw new Error(`orders/my failed: ${result.error.code}`)
                }
                return result.data.items
              }
            )
    void runWalletAutoRedeem({
      client: consume,
      signedIn: signedIn === true,
      ...(loadOrders === undefined ? {} : { loadOrders }),
    })
      .then((outcome) => {
        if (!alive.current) {
          return
        }
        if (outcome.kind === 'skipped') {
          // 只有「没登录」要说话：其余跳过（订单读不到 / 没有待兑 / 已经兑过）都是「没事发生」
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

  /** 「本次会话开过收款页」的订阅：只在 `BuyTab` **真的把 Web 收款页导航出去**之后加一 */
  useEffect(
    () =>
      subscribeWebPayOpened(() => {
        // 新一次付款 = 新的轮询预算
        webPayAttempts.current = 0
        record('nav', 'info', 'web pay opened', {
          ...buildMeta({ stage: WEB_PAY_STAGE }),
          // 触发方式写在 meta 里：`check:log-coverage` 要求可切片字段 ≥2，
          // 而且排障时能区分「新标签页导航成功」和将来可能的其它入口。
          trigger: 'pay-tab-navigated',
        })
        setWebPayTick((tick) => tick + 1)
      }),
    []
  )

  /**
   * Web 端「付款回来」的两个触发点 —— 走的都是**同一个** `backToCards`（自动兑现的判定一行都没复制）。
   *
   *   1. `visibilitychange` → `visible`：用户从收款页（另一个标签页）切回来了。
   *      原生那条是 `browserFinished` → `onClosed` → `BuyTab.onPurchased`，Web 没有这个事件；
   *   2. 低频轮询兜底（`WEB_PAY_POLL_MS` / `WEB_PAY_POLL_MAX`）：切回来那一秒订单可能还没变成
   *      `COMPLETED`（小铺回调晚几秒），那一刻 `runWalletAutoRedeem` 会正常地 `skipped:no-pending`，
   *      再给几次机会把它捞回来。
   *
   * 三条边界（都是「别乱触发」）：
   *  - **只有本次会话真的开过收款页**（`webPayTick > 0`）才挂监听：用户随便切个标签回来，
   *    不该白查一次订单；
   *  - 页面不可见时**一个请求都不发**（浏览器也会把定时器节流到 1 分钟一次）；
   *  - 轮询有**上限**（8 次请求 / 墙钟 2 分钟，两者任一先到就停），页面卸载时
   *    `clearInterval` + `removeEventListener`；可见性那一下是**一次性的**
   *    （回调里就把监听摘了，不用幂等标记再兜一层）。
   *
   * ⚠️ **`visibilitychange` 会被「用户切个标签又切回来」误触发，这是已知且可接受的代价，
   * 别把它当 bug 修掉。** `runWalletAutoRedeem` 是幂等的：订单状态判据（`COMPLETED` + 卡号完整）、
   * `GET /api/v1/redeem/history` 交叉比对、本地指纹去重（`wasAutoSubmitted` 先落盘再发）、
   * 以及**永不自动重试**，四道闸决定了最坏结果只是「白查一次订单」——
   * 绝不会多兑一张卡、也不会对同一张卡打第二枪。
   */
  useEffect(() => {
    // 没开过收款页 / 非浏览器环境 → 没什么可听的
    if (webPayTick === 0 || typeof document === 'undefined') {
      return
    }
    if (signedIn !== true) {
      // 未登录：`orders/my` 要 JWT，这条路必然以 `not-signed-in` 收场。与其让用户以为
      // 「自动兑现坏了」，不如当场说清楚，并在诊断里留痕（#784 的唯一触发点在这里）。
      record('nav', 'info', 'web pay return skipped', {
        ...buildMeta({ stage: WEB_PAY_STAGE }),
        reason: 'not-signed-in',
      })
      showToast(t('walletAutoRedeemNeedSignIn'))
      return
    }
    let timer: ReturnType<typeof setInterval> | null = null
    const startedAt = Date.now()

    /** 只停轮询：可见性监听要留到「切回来」那一下（用户可能在收款页上停留很久） */
    function stopPolling(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    /** 全停（组件卸载 / 页面已经不再是本会话）：定时器和监听一起摘 */
    function stop(): void {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    /**
     * 与原生 `onClosed` **完全同一条路**：`runWebPayReturn()` 调的就是 `BuyTab` 登记进来的
     * `onPurchased`（= 本文件的 `backToCards`）——换页 + 重拉订单 + 自动兑现，
     * 判定逻辑（`walletAutoRedeem.ts`）一行都没有复制，也没有第二个回调名。
     */
    function fire(source: 'visible' | 'poll'): void {
      if (!alive.current) {
        stop()
        return
      }
      record('nav', 'info', 'web pay return fire', {
        ...buildMeta({ stage: WEB_PAY_STAGE }),
        source,
        attempts: webPayAttempts.current,
      })
      runWebPayReturn()
    }
    /** 切回来这一下最准：一次就够（之后就交给下面的轮询兜底），摘掉监听 */
    function onVisibility(): void {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisibility)
        fire('visible')
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    timer = setInterval(() => {
      // 墙钟上限：用户一直待在收款页（本页长时间不可见）时，定时器同样要自己退场
      if (Date.now() - startedAt > WEB_PAY_POLL_WALL_MS) {
        stopPolling()
        return
      }
      // 本页不可见 = 用户还在收款页，查了也没人看，还会被浏览器节流
      if (document.visibilityState !== 'visible') {
        return
      }
      webPayAttempts.current += 1
      if (webPayAttempts.current > WEB_PAY_POLL_MAX) {
        stopPolling()
        return
      }
      fire('poll')
    }, WEB_PAY_POLL_MS)

    return stop
  }, [signedIn, webPayTick, t])

  const SOURCE_LABEL_KEYS: Record<string, TranslationKey> = {
    builtin: 'accountConsumeSourceBuiltin',
    third: 'accountConsumeSourceThird',
    deepseek: 'accountConsumeSourceOfficial',
    anthropic: 'accountConsumeSourceAnthropic',
  }
  const sourceLabelKey = SOURCE_LABEL_KEYS[sourceKeyOf(kind)]

  /** 「已选来源」= 手上真有一把能用的 Key（内置服务的 Key 由服务端下发后再领取到本机） */
  const configured = apiKey.trim() !== ''

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

  /**
   * 内置服务那一行展开后的一句状态（#800 / #807）：这一行**没有任何 Key 控件**，
   * 所以要把「Key 从哪来」说清楚。三种状态：常态 / 正在自动对齐 / 刚对齐完（带新尾号）。
   * 纯文案 —— 没有按钮、没有输入框、没有复制入口：恢复由上面的 effect 自动完成。
   */
  const builtinKeyNote = (
    <div data-testid="account-consume-builtin-key-note">
      <p className={styles.sourceNote} data-testid="account-consume-builtin-key-note-text">
        {keySync === 'syncing'
          ? t('settingsBuiltinKeySyncing')
          : keySync === 'done'
            ? t('settingsBuiltinKeySynced', { tail: managedKeyTail(apiKey) })
            : t('settingsBuiltinKeyAuto')}
      </p>
    </div>
  )
  /**
   * 页首那一行：**余额卡 + 付款入口**（#817）。
   *
   * 版式与三态文案都在 `walletHeaderView.ts`（`.ts`，裸 Node 可渲染，用例按 markup 断言），
   * 这里只注入数据与那一个换页动作 —— 付款本身仍是既有 `BuyTab`，本文件一行付款逻辑都不写。
   */
  const walletHeader = (
    <WalletHeaderView
      t={t}
      styles={styles}
      signedIn={signedIn}
      balance={balance}
      onPay={() => onNavigate(WALLET_PAY_ENTRY_PAGE)}
    />
  )

  /**
   * 下级页面的头部：**只有左上角「‹ 返回」**。
   *
   * 标题（与右上角圆形 X）是设置弹层自己的那份 —— 内容和一级列表是同一个容器，
   * 所以这里不再写第二份居中的标题（第五轮：五套页头统一成设置二级页那一套）。
   * 本页的标题由 `SettingsDialog` 按 `page` 从 `ACCOUNT_SUB_PAGE_TITLES` 取。
   */
  const subBack = (back: AccountSubPage | null) => (
    <SettingsBackButton testId="account-consume-back" onClick={() => onNavigate(back)} />
  )

  // ───────────────── L2：我的钱包（余额卡 + 付款入口 / 我的卡密 / 历史消费） ──────
  if (page === 'wallet') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subBack(null)}
        {/* 页首一行：余额 + 付款入口（#817 的信息层级不变，只是并进同一张卡片 —— 第五轮视觉统一） */}
        <SettingsCard>{walletHeader}</SettingsCard>
        <SettingsCard>
          <SettingsCardRow
            testId="account-consume-tab-cards"
            icon={<IconDocumentOutline16 />}
            label={t('accountConsumeTabCards')}
            onClick={() => onNavigate('cards')}
          />
          <SettingsCardRow
            testId="account-consume-history"
            icon={<IconDataOutline16 />}
            label={t('accountConsumeHistory')}
            onClick={() => onNavigate('history')}
          />
        </SettingsCard>
        {/* 老账号额度迁移（#498 的临时尾巴，@remove-after 1.6.0）：本行只是**挂载点**，
            「显不显示」全由组件自己判 —— `migration.enabled !== true` 时组件 `return null`，
            所以默认关闭的构型里这一页**没有任何痕迹**（不是空按钮、不是占位）。
            有结果时（登录后那一次已经跑过）传 `initial`：`migrated` → 「历史额度已迁移：¥X」；
            `already_migrated` + 金额 0 的兜底入口（「仍要迁移」）也在组件里。 */}
        {signedIn === true ? (
          <LegacyMigrationButton initial={migrationResult ?? undefined} getToken={getAccessToken} />
        ) : null}
      </div>
    )
  }

  // ───────────────────── L2：模型来源（**单层手风琴**，一行一次，没有子页） ──────────────
  if (page === 'source') {
    /**
     * 「模型来源」= **一屏三行的手风琴**（#807）。行头 = 名称 + 状态（✓ 当前使用 / 未配置 / 领取中…）
     * + 箭头；**同一时间只展开一行**，展开区里是该来源自己要配的东西：
     *
     *   内置服务（kind=ours）       → **行即动作、没有表单**：没登录就弹登录 / 注册（登录回来自动接着领），
     *                                没有服务端那把 Key 就行内领取，已经握着就直接设成当前来源。
     *                                #800 的结论照旧：这里**没有 Key 行**（输入框 / 掩码 / 复制 /
     *                                「重新领取」全不渲染），Key 只在后台落盘。
     *   第三方服务                   → 服务地址 + API Key + 模型 + （可选）连通性探测 + 「确认使用」。
     *                                #794：**没有协议选择**，协议按地址 / 模型自动适配。
     *   DeepSeek 官方服务（deepseek）→ 地址固定，只填 API Key + 「确认使用」。
     *
     * 「正在查看」与「正在使用」是两件事：展开 / 收起 / 改草稿都不动生效来源，
     * 只有「内置服务领取成功」与「点确认使用」才切（切换点全在 `sourceAccordionRuntime.ts`）。
     * 打勾只绑生效来源，持久化在既有键 `chat-demo:provider-kind` 上，重启后照样在。
     */
    const configuredRows: Record<SourceRowKey, boolean> = {
      builtin: rowConfigured('builtin'),
      third: rowConfigured('third'),
      official: rowConfigured('official'),
    }
    /** 草稿绑定：值的生死交给状态机（收起不动 `drafts`，所以草稿不丢） */
    const draftBinding = (row: DraftRowKey): SourceDraftBinding => ({
      values: sourceState.drafts[row],
      onChange: (field, value) => dispatchSource({ type: 'edit', row, field, value }),
    })
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subBack(null)}
        {sourceState.open === 'builtin' && (sourceState.claim.phase === 'claiming' || sourceState.claim.phase === 'failed')
          ? null : keyEnsureBanner}
        <SettingsCard>
        <SourceAccordionView
          t={t}
          state={sourceState}
          effectiveKind={kind}
          configured={configuredRows}
          builtinNote={builtinKeyNote}
          panels={{
            third: (
              <ApiConfigFields
                mode="draft"
                kind={thirdRowKind()}
                hideProviderKind
                draft={draftBinding('third')}
              />
            ),
            official: (
              <ApiConfigFields
                mode="draft"
                kind="deepseek"
                hideProviderKind
                draft={draftBinding('official')}
              />
            ),
          }}
          onToggle={onToggleSourceRow}
          onRetry={() => void runBuiltinClaim(signedIn === true)}
          onConfirm={onConfirmSourceRow}
          styles={styles}
        />
        </SettingsCard>
      </div>
    )
  }

  // ───────────────────────────── L2：我的卡密（列表 + 兑换卡密） ──────────────────
  if (page === 'cards') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subBack('wallet')}
        <SettingsCard>
        {/* 页标题由设置头部给（「我的卡密」+ 返回），这里不再写第二份同名标题 */}
        <MyCardsTab
          consume={consume}
          hideListTitle
          autoRedeem={autoRedeem}
          onDismissAutoRedeem={() => setAutoRedeem(null)}
          onGoBuy={() => onNavigate('buy')}
          onNeedLogin={needLogin}
        />
        </SettingsCard>
      </div>
    )
  }

  // ───────────────────────────── L2：购买（收款页回跳后落回卡密） ────────────────
  if (page === 'buy') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subBack('wallet')}
        <SettingsCard>
        {/* 未登录点「购买」→ BuyTab 弹登录提示，`onNeedLogin` 就是全应用共用的那一个登录出口（#608） */}
        <BuyTab onPurchased={backToCards} onNeedLogin={needLogin} />
        </SettingsCard>
      </div>
    )
  }

  // ───────────────────────────── L2：历史消费 ──────────────────────────────────
  if (page === 'history') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subBack('wallet')}
        <SettingsCard>
        <HistoryView consume={consume} signedIn={signedIn === true} />
        </SettingsCard>
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
        {subBack(null)}
        {keyEnsureBanner}

        {/* 资料区：已登录 = 头像 + 昵称 + 邮箱；未登录 = 一句「未登录」（登录 / 注册入口在下方的账号面板） */}
        {signedIn === true ? (
          <SettingsCard>
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
          </SettingsCard>
        ) : null}

        {/* 行区：未登录时不摆一排「—」，直接给登录 / 注册入口（#608：不设登录墙） */}
        {signedIn === true ? (
          <SettingsCard>
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-id">
              <span className={styles.rowMain}>{t('accountConsumeAccountId')}</span>
              <span className={styles.value}>
                {accountIdText}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-bind-email">
              <span className={styles.rowMain}>{t('accountConsumeBindEmail')}</span>
              <span className={styles.value}>
                {emailBound ? displayEmail : ''}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
            <div className={`${styles.row} ${styles.rowStatic}`} data-testid="account-consume-login-method">
              <span className={styles.rowMain}>{t('accountConsumeLoginMethod')}</span>
              <span className={styles.value}>
                {t('accountConsumeLoginMethodEmail')}
                <i className={styles.chevron} aria-hidden="true">
                  ›
                </i>
              </span>
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
          <div className={styles.viewBody} data-testid="account-consume-tab-account">
            {/* 未登录 = **这一页就是登录界面**：登录 / 注册分段 + 获取验证码 + 忘记密码 +
                「暂不登录」（#608 的口子，直接去填 API Key）。 */}
            <SettingsAuthCard consume={consume} onSkip={() => onNavigate('source')} />
          </div>
          </SettingsCard>
        )}

        {/*
          邀请（#819 恢复挂载）：`6d7ab635`（#788）把账号 L2 页改成手写三行时，原本挂在
          `AccountPanel` 里的 `<InvitePanel …/>` 一起没了 —— 这条链路从此**一次 `GET /user/aff` 都没打过**。
          这里按原来的口径把面板挂回来：`consume` 是页面那一个客户端，`signedIn` 是页面的登录态三档
          （`true` 才算已登录），`onSignIn` 复用页面的登录出口。

          **面板可见性只看这条链路自己的数据**（#819-v2）：已登录 → 发 `GET /user/aff`，成功且带邀请码就展示，
          失败才落失败态。**未登录整块不渲染**（维护者明确要求：登录页不显示「我的邀请」；#608 §3 写过
          未登录给引导，但这里从未真的渲染过）。`settings/public` 里那两个与「注册」有关的
          开关**不参与**这里的判断（它们管注册页的邀请码行），所以这一层**不加**任何本地开关判断，
          否则就成了「客户端第二份开关」（#484 §3.1d）。
        */}
        {signedIn === true ? (
          // 挂载点必须**直接**是 `{signedIn === true ? (<div className={styles.viewBody}
          // data-testid="account-consume-invite">` —— `tests/unit/invite-signedout-hidden.test.mjs`
          // 按这个形状判「未登录不渲染邀请面板」，所以这里不套卡片外壳（面板自己带卡片样式）。
          <div className={styles.viewBody} data-testid="account-consume-invite">
            <InvitePanel
              consume={consume}
              signedIn={signedIn === true}
              onSignIn={needLogin}
              onBalance={setBalance}
            />
          </div>
        ) : null}

        {/* 退出登录（红字行，原型 `.logout`）：动作就是既有的 auth store `signOut()`，不另写一套 */}
        {signedIn === true ? (
          signOutAsk ? (
            <SettingsCard>
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
            </SettingsCard>
          ) : (
            <SettingsCard>
              <button
                type="button"
                className={styles.logout}
                data-testid="account-consume-signout"
                onClick={() => setSignOutAsk(true)}
              >
                {t('sub2authLogout')}
              </button>
            </SettingsCard>
          )
        ) : null}
      </div>
    )
  }

  // ───────────────────────────── L1：列表页（三行：模型来源 / 我的钱包 / 账号） ──
  // 视觉与设置一级列表同款：卡片 + 「图标 + 标签 + 右值 + chevron」的 56px 行。
  return (
    <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
      <SettingsCard>
        {/* 1) 模型来源收成一行：右侧是当前渠道名；未登录先去登录界面（登录后才是配置页） */}
        <SettingsCardRow
          testId="account-consume-source"
          icon={<IconSettingsOutline16 />}
          label={t('accountConsumeGroupSource')}
          value={configured ? t(sourceLabelKey) : undefined}
          onClick={() => onNavigate('source')}
        />
        {/* 2) 我的钱包：余额卡 / 我的卡密 / 历史消费都在它点进去的那一页，L1 不摊开余额卡 */}
        <SettingsCardRow
          testId="account-consume-wallet"
          icon={<IconWalletOutline16 />}
          label={t('accountConsumeWallet')}
          onClick={() => onNavigate('wallet')}
        />
        {/* 3) 账号：未登录进去就是登录界面（#608 的 key-only 口子在那页底部） */}
        <SettingsCardRow
          testId="account-consume-tab-account"
          icon={<IconUserOutline16 />}
          label={t('accountConsumeTabAccount')}
          value={signedIn === true ? undefined : t('accountConsumeSignedOutCta')}
          onClick={() => onNavigate('account')}
        />
      </SettingsCard>
    </div>
  )
}
