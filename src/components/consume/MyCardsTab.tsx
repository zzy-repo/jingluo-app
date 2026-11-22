/**
 * Tab 1「我的卡密」（#482 三弹层合一 / #487 W1-C1 / **#834 数据源换新**）。
 *
 * 两条调用链，都在 **sub2api**（同一条 JWT 通道），但职责仍然分开：
 *
 *   列表   `consume.orders.my()`（`services/consume/orders.ts` → `GET /api/v1/payment/orders/my`）
 *   兑换   `consume.redeem.redeem({ code })`（`services/consume/redeem.ts` → `POST /api/v1/redeem`）
 *
 * 为什么要换（#834）：旧数据源是 apia 的 `GET /api/orders`（`fetchPurchases`，Bearer sk- Key）。
 * 账号迁到 sub2api 之后，那把 Key 在 apia 侧不存在 —— 实测真 Key 打旧接口恒 `401 UNAUTHORIZED`，
 * 于是列表永远空白（同一个原因还让 #784 的自动兑现一个请求都发不出去）。新接口带登录态 JWT，
 * 与兑换同一条通道，所以这里**没有 API Key 这一层**：登录了就能看。
 *
 * 新契约（票面）：`data.items[] / total / page / page_size / pages`，每条订单有
 * `out_trade_no`、`status`、`amount`（到账额度 元）、`created_at`、`recharge_code`（**只有 COMPLETED 才有**）。
 * 于是本文件的三条口径：
 *
 *  1. **卡号**：有 `recharge_code` 才渲染卡号节点（`maskCardNo` 掩码；复制按钮交出去的仍是完整卡号），
 *     没有就不渲染、也不报错（非 COMPLETED 的订单本来就没有卡）—— 渲染细节在 `myCardsListView.ts`；
 *  2. **状态文案自己映射**：新接口**没有 `plan_name` / `status_text`**，界面按 `status` 取 i18n key；
 *  3. **不显示「是否已兑换」**：新接口不回答这件事（#834 边界），所以卡片上只有状态、没有「已兑换」标签。
 *
 * 兑换的四态（#484 §3.4 / §5，全仓最不能写错的一段）：
 *
 * | 结局 | 界面 | 为什么这么写 |
 * | --- | --- | --- |
 * | `redeemed` | 「兑换成功」 | 服务端直接成功，或超时后查历史确认已到账（`credited: 'history'`） |
 * | `processing` | 「正在确认兑换结果」 | `409 REDEEM_CODE_LOCKED` = 正在处理，**不是失败**，禁止提示换卡 |
 * | `pending`  | 「兑换失败，请稍后重试」+ 重试按钮 | 超时/5xx 且历史核对「未到账」。**重试必须用户手动点** |
 * | `failed`   | 按错误码给具体句（已使用 / 无效）+ 登录出口 | 业务失败不重试，也不去猜 |
 *
 * 幂等：首发只发一次；重试只走 `retryAfterConfirm: true`（用户点了那个按钮才算确认），
 * 绝不在这份界面里写任何自动重试循环（`redeem.ts` 已经把补偿判定做完，这里只负责「问一句」）。
 *
 * 兑换成功之后**必须重拉 `/api/v1/user/profile`**（#676 §五：余额进 `user.balance`，不再是某把 Key 的
 * `quota`）。这一段在 `myCardsModel.ts` 的 `afterRedeemed()` 里，本文件只负责把读到的余额显示一行 ——
 * 组件里写 setState 断言不了「有没有真的拉」，契约就变成口头承诺。
 * 兑换成功后**重拉一次列表**（`loadOrders`）的不变行为也保留：卡密页要反映服务端的最新状态。
 *
 * 安全：卡密全文只在内存里交给剪贴板，**不进 DOM 文本、不进日志、不进 localStorage**；
 * 列表只渲染后 4 位（`maskCardNo`，与 `mask.ts` 同一口径）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Sub2ApiError } from '../../services/consume/errors.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { MY_ORDERS_DEFAULT_PAGE_SIZE, type ConsumeMyOrder } from '../../services/consume/orders.js'
import { copyText } from '../../utils/clipboard.js'
import { afterRedeemed } from './myCardsModel.js'
import { CardsListView } from './myCardsListView.js'
import { localPanelError, toPanelError, type PanelError } from './panels.js'
import type { WalletAutoRedeemOutcome } from './walletAutoRedeem.js'
import { formatCurrency } from './panels.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './AccountConsume.module.css'

/**
 * 列表态：只有三种，不要再多分一档「正在刷新」（刷新就是 `loading` + 保留旧数据）。
 *
 * 错误只存上屏要用的三样（`PanelError`：文案 key / 能不能重试 / 要不要重新登录）——
 * 服务端 message 是英文原句，绝不上屏（#484 §4 第 4 条）。
 */
type CardsView =
  | { status: 'loading' }
  | { status: 'ready'; orders: ConsumeMyOrder[] }
  | { status: 'error'; error: PanelError }

/**
 * 兑换态：与 `ConsumeRedeemOutcome` 四态一一对应，外加 idle / busy。
 *
 * `processing` / `pending` / `failed` 都把消费层给的 `Sub2ApiError` 带在手上 ——
 * 上屏只认 `error.i18nKey`（#484 §4 第 4 条：`message` 是英文原句，绝不上屏）。
 */
type RedeemView =
  | { status: 'idle' }
  | { status: 'busy' }
  /** `balance` 是兑换后重拉 `/user/profile` 读到的余额（元）；读不到就没有这一项（不显示） */
  | { status: 'redeemed'; balance?: number }
  | { status: 'processing'; error: Sub2ApiError }
  /** 已核对「未到账」：给重试按钮，点了才带 `retryAfterConfirm: true` 再发一次 */
  | { status: 'pending'; code: string }
  | { status: 'failed'; error: Sub2ApiError }

export type MyCardsTabProps = {
  consume: ConsumeClient
  /** 空态的「前往购买」：切到 Tab 2 */
  onGoBuy?: () => void
  /** 需要登录时的出口（W1-B 提供登录页/弹层） */
  onNeedLogin?: () => void
  /**
   * 是否渲染列表自己的「我的卡密」小标题（#727 阶段 1）。
   *
   * 设置弹层里这一块是**由「我的卡密」那一行点开的**：行上已经写了分组名，视图里再写一遍
   * 就是维护者截图里看到的重复（同一个名字当一次分组标题、又当一次列表标题）。独立渲染
   * （截图脚本 / 面板联调）时不传，行为一字不变。
   */
  hideListTitle?: boolean
  /**
   * #784：「付款回来」那一次自动兑现的结局（由 `AccountConsumePage` 持有，只在
   * `openPayLinkInApp(onClosed)` 之后才会被赋值）。`null` / 不传 = 这次没有自动兑现过。
   *
   * 为什么由外层传：自动兑现发生在收款页关闭那一刻，本组件当时可能还没挂载；
   * 结果必须比组件活得久一点，否则「已自动到账」这句提示会随着 tab 切换而消失。
   */
  autoRedeem?: WalletAutoRedeemOutcome | null
  /** 关掉自动兑现的提示卡片（用户看过了） */
  onDismissAutoRedeem?: () => void
}

export const MyCardsTab = ({
  consume,
  onGoBuy,
  onNeedLogin,
  hideListTitle = false,
  autoRedeem = null,
  onDismissAutoRedeem,
}: MyCardsTabProps) => {
  const t = useTranslate()
  const [view, setView] = useState<CardsView>({ status: 'loading' })
  const [code, setCode] = useState('')
  const [redeem, setRedeem] = useState<RedeemView>({ status: 'idle' })
  // 乐观锁：兑换请求在飞的时候不许再发一次（两次点击会产生第二个 POST，而它没有幂等键）
  const busyRef = useRef(false)
  const aliveRef = useRef(true)
  /** 「去兑换」（自动兑现失败 / 打码卡的唯一出口）：只把焦点送到下面那个输入框，**绝不代替用户提交** */
  const codeInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * 拉一页订单（`GET /api/v1/payment/orders/my`，JWT）。
   *
   * 不用 `try/catch` 兜「Key 没填」这种前置条件：新数据源没有 Key 这一层，未登录时
   * 消费层会把 401 归一成 `kind: 'auth'` + `i18nKey: consumeErrUnauthorized`，
   * 界面按 `error.needLogin` 给登录出口即可（不再自建一张错误码 → 文案的平行表）。
   */
  const loadOrders = useCallback(async () => {
    setView({ status: 'loading' })
    let result: Awaited<ReturnType<ConsumeClient['orders']['my']>>
    try {
      result = await consume.orders.my({ page: 1, pageSize: MY_ORDERS_DEFAULT_PAGE_SIZE })
    } catch {
      // 配置缺失这类「连请求都没发出去」的意外：按未知失败上屏，不给重试（重试也一样）
      if (aliveRef.current) {
        setView({ status: 'error', error: localPanelError('oursPurchasesErrUnknown') })
      }
      return
    }
    if (!aliveRef.current) {
      return
    }
    if (result.ok) {
      setView({ status: 'ready', orders: result.data.items })
      return
    }
    // 文案只认 `error.i18nKey`，重试按钮只按 `error.retryable` 出现（401 重试一万次也一样）
    setView({ status: 'error', error: toPanelError(result.error) })
  }, [consume])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  /** 复制完整卡密：全文只走剪贴板，不进 DOM */
  const copyCard = useCallback(async (cardNo: string) => {
    const done = await copyText(cardNo)
    showToast({ key: done ? 'oursPayRecordsCopied' : 'copyFailed' })
  }, [])

  /**
   * 兑换：`retryAfterConfirm` 只由「用户点了重试按钮」传 true。
   * 其它情况（含首发超时）一律不重发 —— sub2api 的兑换没有幂等键（#484 §5 第 1 行）。
   */
  const submitRedeem = useCallback(
    async (value: string, retryAfterConfirm: boolean) => {
      const target = value.trim()
      if (target === '' || busyRef.current) {
        return
      }
      busyRef.current = true
      setRedeem({ status: 'busy' })
      let outcome: Awaited<ReturnType<ConsumeClient['redeem']['redeem']>>
      try {
        outcome = await consume.redeem.redeem({ code: target, retryAfterConfirm })
      } catch {
        // 传输层之外的意外（配置缺失等）也按「不可知」处理：不给自动重试，让用户自己决定
        busyRef.current = false
        if (aliveRef.current) {
          setRedeem({ status: 'pending', code: target })
        }
        return
      }
      busyRef.current = false
      if (!aliveRef.current) {
        return
      }
      if (outcome.kind === 'redeemed') {
        setCode('')
        // 兑换改了**账户余额**（`user.balance`）：按契约重拉 `/user/profile`，不刷某把 Key 的 quota（#676 §五）
        const aftermath = await afterRedeemed(outcome, consume.auth)
        if (!aliveRef.current) {
          return
        }
        setRedeem({ status: 'redeemed', balance: aftermath.refresh ? aftermath.balance : undefined })
        // 订单上的兑换态也跟着变：重拉一次列表（不自建账本）
        void loadOrders()
        return
      }
      if (outcome.kind === 'processing') {
        // 409 REDEEM_CODE_LOCKED = 正在处理，**不是失败**：文案 = consumeRedeemProcessing，
        // 不给重试按钮、不提示换卡（#484 §4.4）
        setRedeem({ status: 'processing', error: outcome.error })
        return
      }
      if (outcome.kind === 'pending') {
        setRedeem({ status: 'pending', code: target })
        return
      }
      // 只带上归一的错误：文案是 `error.i18nKey`（卡密已用 / 不存在 / 会话失效 …各自一句）
      setRedeem({ status: 'failed', error: outcome.error })
    },
    [consume, loadOrders]
  )

  const busy = redeem.status === 'busy'
  const orders = view.status === 'ready' ? view.orders : []

  return (
    <div className={styles.body} data-testid="account-consume-cards">
      {/* #784：付款回来那一次的自动兑现结论（到账 / 处理中 / 失败 / 打码卡）。
          卡片放在兑换表单**上面**：用户从收款页回来第一眼要看的是「钱到没到」，
          而不是先看到输入框以为还要自己输一遍。 */}
      {autoRedeem === null ? null : (
        <AutoRedeemNotice
          outcome={autoRedeem}
          onManual={() => {
            setRedeem({ status: 'idle' })
            codeInputRef.current?.focus()
          }}
          onDismiss={onDismissAutoRedeem}
        />
      )}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('consumeRedeemTitle')}</h3>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void submitRedeem(code, false)
          }}
        >
          <input
            className={styles.input}
            value={code}
            placeholder={t('consumeRedeemPlaceholder')}
            aria-label={t('consumeRedeemTitle')}
            data-testid="account-consume-redeem-input"
            ref={codeInputRef}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button
            type="submit"
            size="m"
            data-testid="account-consume-redeem-submit"
            disabled={busy || code.trim() === ''}
          >
            {busy ? t('consumeRedeemBusy') : t('oursRedeemAction')}
          </Button>
        </form>
        <RedeemFeedback
          view={redeem}
          onRetry={(target) => void submitRedeem(target, true)}
          onNeedLogin={onNeedLogin}
        />
      </section>

      <section className={styles.section}>
        {hideListTitle ? null : <h3 className={styles.sectionTitle}>{t('accountConsumeTabCards')}</h3>}
        {view.status === 'loading' ? (
          <div className={styles.state} aria-busy>
            <p className={styles.stateText}>{t('oursPurchasesLoading')}</p>
          </div>
        ) : null}
        {view.status === 'error' ? (
          <div className={styles.state}>
            <p className={styles.stateText}>{t(view.error.i18nKey, view.error.params)}</p>
            <div className={styles.stateActions}>
              {view.error.retryable ? (
                <Button variant="outlined" size="m" data-testid="account-consume-cards-retry" onClick={() => void loadOrders()}>
                  {t('oursPurchasesRetry')}
                </Button>
              ) : null}
              {/* 数据源是登录态（JWT）：未登录时唯一的出路是去登录，不是重试 */}
              {view.error.needLogin && onNeedLogin !== undefined ? (
                <Button variant="outlined" size="m" data-testid="account-consume-cards-login" onClick={onNeedLogin}>
                  {t('sub2authLogin')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {view.status === 'ready' && orders.length === 0 ? (
          <div className={styles.state}>
            <p className={styles.stateText}>{t('oursPurchasesEmpty')}</p>
            {onGoBuy ? (
              <div className={styles.stateActions}>
                <Button variant="outlined" size="m" onClick={onGoBuy}>
                  {t('oursPayAction')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {orders.length === 0 ? null : (
          <CardsListView
            t={t}
            c={styles}
            Button={Button}
            orders={orders}
            busy={busy}
            onCopy={(full) => void copyCard(full)}
            onRedeem={(full) => {
              // 「去兑换」只把卡密填进上面的输入框：兑换是写操作，必须由用户自己点提交
              setCode(full)
              setRedeem({ status: 'idle' })
            }}
          />
        )}
      </section>
    </div>
  )
}

/**
 * 兑换结果的四态反馈条。
 *
 * 单独拆出来只为一件事：**每一态只有一句话 + 最多两个动作**，不允许拼「服务端 message」，
 * 也不允许出现「重试」以外的手段（换卡、重复提交都要用户自己改主意）。
 */
const RedeemFeedback = ({
  view,
  onRetry,
  onNeedLogin,
}: {
  view: RedeemView
  onRetry: (code: string) => void
  onNeedLogin?: () => void
}) => {
  const t = useTranslate()
  if (view.status === 'idle') {
    return null
  }
  const testId = 'account-consume-redeem-status'
  if (view.status === 'busy') {
    // 兑换请求在飞的时候可能正在做「先查历史再定性」的补偿（`redeem.ts` 的首发 + 核对），
    // 这句话就是给那段等待用的：说明正在确认、不要重复提交（#484 §5）。
    return (
      <p className={`${styles.feedback} ${styles.feedbackWarn}`} role="status">
        {t('consumeRedeemConfirming')}
      </p>
    )
  }
  if (view.status === 'redeemed') {
    return (
      <p className={`${styles.feedback} ${styles.feedbackOk}`} role="status" data-testid={testId}>
        {t('consumeRedeemSuccess')}
        {/* 余额来自兑换后重拉的那次 `/user/profile`（元）；读不到就只显示「兑换成功」 */}
        {view.balance === undefined ? '' : ` · ${t('consumeBalanceLabel')} ${formatCurrency(view.balance)}`}
      </p>
    )
  }
  if (view.status === 'processing') {
    // LOCKED = 正在处理，**不是失败**：不给重试按钮，也不提示换卡（#484 §4.4）
    return (
      <p className={`${styles.feedback} ${styles.feedbackWarn}`} role="status" data-testid={testId}>
        {t(view.error.i18nKey)}
      </p>
    )
  }
  if (view.status === 'pending') {
    return (
      <div className={`${styles.feedback} ${styles.feedbackError}`} role="alert" data-testid={testId}>
        <span>{t('consumeRedeemFailed')}</span>
        <div className={styles.feedbackActions}>
          <Button variant="outlined" size="m" onClick={() => onRetry(view.code)}>
            {t('oursPurchasesRetry')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className={`${styles.feedback} ${styles.feedbackError}`} role="alert" data-testid={testId}>
      <span>{t(view.error.i18nKey)}</span>
      {view.error.kind === 'auth' && onNeedLogin ? (
        <div className={styles.feedbackActions}>
          <Button variant="outlined" size="m" onClick={onNeedLogin}>
            {t('sub2authLogin')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 「付款回来」那次自动兑现的提示卡片（#784）。
 *
 * 四态各一句话，**没有第三句话**：
 *
 * | 结局 | 卡片 | 动作 |
 * | --- | --- | --- |
 * | `credited`   | 「已自动到账 ¥X」（+ 重新拉到的余额） | 无（钱到了，不需要用户做事） |
 * | `processing` | 消费层给的 `i18nKey`（「正在确认兑换结果」）+ 服务端原句 | 「去兑换」（手动入口） |
 * | `failed`     | 「自动兑换未完成」+ 服务端原句 | 「去兑换」 |
 * | `masked`     | 「卡密已打码，无法自动兑换」+ 打码后的卡号 | 「去兑换」 |
 *
 * 两个不许：
 *  - **不许**给「重试」按钮：这条链路的第二枪必须用户自己走到手动入口按下去（`redeem` 没有幂等键）；
 *  - **不许**把服务端英文原句当主文案：主文案只认 i18n key，原句作副标题（`#484 §4 第 4 条` 的既有口径，
 *    #784 要的「文案用后端 message」由这一行承载）。
 */
const AutoRedeemNotice = ({
  outcome,
  onManual,
  onDismiss,
}: {
  outcome: WalletAutoRedeemOutcome
  onManual: () => void
  onDismiss?: () => void
}) => {
  const t = useTranslate()
  const testId = 'account-consume-auto-redeem'
  if (outcome.kind === 'skipped') {
    return null
  }
  const actions = (
    <div className={styles.feedbackActions}>
      <Button variant="outlined" size="m" data-testid="account-consume-auto-redeem-manual" onClick={onManual}>
        {t('oursPurchasesGoRedeem')}
      </Button>
      {onDismiss === undefined ? null : (
        <Button variant="outlined" size="m" data-testid="account-consume-auto-redeem-dismiss" onClick={onDismiss}>
          {t('walletAutoRedeemDismiss')}
        </Button>
      )}
    </div>
  )
  if (outcome.kind === 'credited') {
    return (
      <div className={`${styles.feedback} ${styles.feedbackOk}`} role="status" data-testid={testId}>
        <span>
          {outcome.amount === undefined
            ? t('consumeRedeemSuccess')
            : t('walletAutoRedeemCredited', { amount: formatCurrency(outcome.amount) })}
          {/* 余额来自兑换后重拉的那次 `/user/profile`；读不到就不写这一截（不显示一个来路不明的数） */}
          {outcome.balance === undefined
            ? ''
            : ` · ${t('consumeBalanceLabel')} ${formatCurrency(outcome.balance)}`}
        </span>
      </div>
    )
  }
  if (outcome.kind === 'masked') {
    return (
      <div className={`${styles.feedback} ${styles.feedbackWarn}`} role="status" data-testid={testId}>
        <span>
          {/* 服务端已经把中间打码了（`MUSE-****-1234`）：原样显示，不打第二层码也不拼全码 */}
          {t('walletAutoRedeemMasked')} · {outcome.code}
        </span>
        {actions}
      </div>
    )
  }
  // processing / failed：主文案 i18n key，副标题是后端那句 message
  return (
    <div
      className={`${styles.feedback} ${outcome.kind === 'processing' ? styles.feedbackWarn : styles.feedbackError}`}
      role={outcome.kind === 'processing' ? 'status' : 'alert'}
      data-testid={testId}
    >
      <span>
        {/* 主文案只认 `error.i18nKey`（卡密已用 / 不存在 / 会话失效 …各自一句），后面接后端原句 */}
        {t(outcome.i18nKey)}
        {outcome.message === '' ? '' : ` · ${outcome.message}`}
      </span>
      {actions}
    </div>
  )
}
