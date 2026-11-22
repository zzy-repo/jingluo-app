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
import { managedKeyTail } from '../../services/api/managedKey.js'
import { detectThirdPartyProtocol } from '../../services/api/protocolDetect.js'
import { syncManagedKeyFromServer } from '../settings/managedKeyRuntime.js'
import { clearManagedKeyBlocked, useSettingsDialog } from '../settings/settingsDialogState.js'
import { SettingsAuthCard } from './SettingsAuthCard.js'
import { getAccessToken, useAuthStore } from '../../services/auth/store.js'
import { LegacyMigrationButton } from '../../legacy/migration/LegacyMigrationButton.js'
import { useLegacyMigrationResult } from '../../legacy/migration/resultState.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { InvitePanel } from './index.js'
import { BuyTab } from './BuyTab.js'
import { HistoryView } from './HistoryView.js'
import { MyCardsTab } from './MyCardsTab.js'
import { runWalletAutoRedeem, type WalletAutoRedeemOutcome } from './walletAutoRedeem.js'
import { WALLET_PAY_ENTRY_PAGE, landAfterPayReturn } from './walletPayFlow.js'
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
export type AccountSubPage = 'wallet' | 'source' | 'cards' | 'buy' | 'history' | 'account'

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
  const [signOutAsk, setSignOutAsk] = useState(false)
  /**
   * #784：「付款回来」那一次自动兑现的结局。只有 `openPayLinkInApp` 的 `onClosed` 会写它
   * （见 `backToCards`）；进钱包页 / 切 tab 都碰不到，所以卡片不会「自己冒出来」。
   */
  const [autoRedeem, setAutoRedeem] = useState<WalletAutoRedeemOutcome | null>(null)
  /** #803：失败原因（带状态码）+「重试」；重试真的再跑一轮完整流程（查重 → 建） */
  const keyEnsureBanner = (
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
      if (result.kind === 'claimed') {
        dispatchSource({ type: 'claim-ok' })
        showToast(t('settingsSourceSwitched', { name: t(SOURCE_ROW_LABEL_KEY.builtin) }))
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
      if (result.kind === 'invalid') {
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
   * （两个入口共用同一段 `BuyTab`，所以只有这一处落点）。**Web 分支不在这条链上**：
   * 非原生环境 `openPayLinkInApp` 返回 false、`onClosed` 不触发，界面停在购买页给可读提示。
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

  /** L2 页标题（`root` 没有）：与行文案同一批词条，不新写中文 */
  const SUB_PAGE_TITLES: Record<AccountSubPage, TranslationKey> = {
    wallet: 'accountConsumeWallet',
    source: 'accountConsumeGroupSource',
    cards: 'accountConsumeTabCards',
    buy: 'oursPayTitle',
    history: 'accountConsumeHistory',
    account: 'accountConsumeTabAccount',
  }

  /** 下级页面的头部：左上角「返回」+ 本页标题（设置弹层的头部与 X 不动，这里只是内容区的二级头） */
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

  // ───────────────── L2：我的钱包（余额卡 + 付款入口 / 我的卡密 / 历史消费） ──────
  if (page === 'wallet') {
    return (
      <div className={`${styles.page} ${styles.embedded}`} data-testid="account-consume-page">
        {subHeader('wallet', null)}
        {/* 页首一行：余额卡 + 付款入口（#817，同一行；窄屏放不下就整块折行） */}
        {walletHeader}
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
        {subHeader('source', null)}
        {keyEnsureBanner}
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
            {keyEnsureBanner}
            <SettingsAuthCard consume={consume} onSkip={() => onNavigate('source')} />
          </div>
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
          <div className={styles.viewBody} data-testid="account-consume-invite">
            <InvitePanel consume={consume} signedIn={signedIn === true} onSignIn={needLogin} />
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

    </div>
  )
}
