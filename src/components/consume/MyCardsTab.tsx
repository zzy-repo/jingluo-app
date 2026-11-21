/**
 * Tab 1「我的卡密」（#482 三弹层合一 / #487 W1-C1）—— 数据来自 **apia**（`GET /api/orders`），
 * 兑换走 **sub2api**（`POST /api/v1/redeem`，经 `consume.redeem.redeem`）。
 *
 * 两个后端各管一段（#484 §1），所以本文件里同时出现两条调用链，它们**不许互相顶替**：
 *
 *   列表   `fetchPurchases()`（`services/ours/purchases.ts`，apia，Bearer API Key）
 *   兑换   `consume.redeem.redeem({ code })`（`services/consume/redeem.ts`，sub2api，JWT）
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
 *
 * 安全：卡密全文只在内存里交给剪贴板，**不进 DOM 文本、不进日志、不进 localStorage**；
 * 列表只渲染后 4 位（`maskCardNo`，与 `mask.ts` 同一口径）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useApiConfig } from '../../services/api/apiConfig.js'
import type { Sub2ApiError } from '../../services/consume/errors.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { fetchPurchases, maskCardNo, PurchaseError } from '../../services/ours/purchases.js'
import type { PurchaseOrder } from '../../services/ours/purchases.js'
import { copyText } from '../../utils/clipboard.js'
import { afterRedeemed } from './myCardsModel.js'
import { formatCurrency } from './panels.js'
import { formatDate } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './AccountConsume.module.css'

/** 列表态：只有四种，不要再多分一档「正在刷新」（刷新就是 `loading` + 保留旧数据） */
type CardsView =
  | { status: 'loading' }
  | { status: 'ready'; orders: PurchaseOrder[] }
  | { status: 'error'; messageKey: TranslationKey; retryable: boolean }

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

/** apia 的失败分类 → 既有文案 key（`oursPurchasesErr*` 与 purchases.ts 的 `PurchaseErrorKind` 一一对应） */
const PURCHASE_ERROR_KEYS: Record<string, TranslationKey> = {
  keyMissing: 'oursPurchasesErrKeyMissing',
  unauthorized: 'oursPurchasesErrUnauthorized',
  rateLimited: 'oursPurchasesErrRateLimited',
  timeout: 'oursPurchasesErrTimeout',
  network: 'oursPurchasesErrNetwork',
  server: 'oursPurchasesErrServer',
  rejected: 'oursPurchasesErrRejected',
  badResponse: 'oursPurchasesErrBadResponse',
}

const cardIsUsed = (order: PurchaseOrder): boolean =>
  order.redeemState === 'redeemed' || order.cardStatus === 'used'

const orderDate = (createdAt: number): string => formatDate(createdAt * 1000) ?? ''

export type MyCardsTabProps = {
  consume: ConsumeClient
  /** 空态的「前往购买」：切到 Tab 2 */
  onGoBuy?: () => void
  /** 需要登录时的出口（W1-B 提供登录页/弹层） */
  onNeedLogin?: () => void
}

export const MyCardsTab = ({ consume, onGoBuy, onNeedLogin }: MyCardsTabProps) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const [view, setView] = useState<CardsView>({ status: 'loading' })
  const [code, setCode] = useState('')
  const [redeem, setRedeem] = useState<RedeemView>({ status: 'idle' })
  // 乐观锁：兑换请求在飞的时候不许再发一次（两次点击会产生第二个 POST，而它没有幂等键）
  const busyRef = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadOrders = useCallback(async () => {
    if (apiKey === '') {
      setView({ status: 'error', messageKey: 'oursPurchasesErrKeyMissing', retryable: false })
      return
    }
    setView({ status: 'loading' })
    try {
      const page = await fetchPurchases({ apiKey, limit: 20, offset: 0 })
      if (aliveRef.current) {
        setView({ status: 'ready', orders: page.orders })
      }
    } catch (error) {
      if (!aliveRef.current) {
        return
      }
      const kind = error instanceof PurchaseError ? error.kind : 'unknown'
      setView({
        status: 'error',
        messageKey: PURCHASE_ERROR_KEYS[kind] ?? 'oursPurchasesErrUnknown',
        // 只有「再来一次有意义」的分类才给重试按钮（401/gut 的 Key 问题重试一万次也一样）
        retryable: kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'rateLimited',
      })
    }
  }, [apiKey])

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
  const cards = view.status === 'ready' ? view.orders.filter((order) => order.cardNo !== null) : []

  return (
    <div className={styles.body} data-testid="account-consume-cards">
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
        <h3 className={styles.sectionTitle}>{t('accountConsumeTabCards')}</h3>
        {view.status === 'loading' ? (
          <div className={styles.state} aria-busy>
            <p className={styles.stateText}>{t('oursPurchasesLoading')}</p>
          </div>
        ) : null}
        {view.status === 'error' ? (
          <div className={styles.state}>
            <p className={styles.stateText}>{t(view.messageKey)}</p>
            {view.retryable ? (
              <div className={styles.stateActions}>
                <Button variant="outlined" size="m" onClick={() => void loadOrders()}>
                  {t('oursPurchasesRetry')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {view.status === 'ready' && cards.length === 0 ? (
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
        {cards.length > 0 ? (
          <>
            <ul className={styles.list}>
              {cards.map((order) => (
                <li key={order.outTradeNo} className={styles.item} data-testid="account-consume-card-row">
                  <div className={styles.itemTop}>
                    <span className={styles.tail}>{maskCardNo(order.cardNo)}</span>
                    <span className={cardIsUsed(order) ? `${styles.chip} ${styles.chipUsed}` : styles.chip}>
                      {t(cardIsUsed(order) ? 'oursPayRecordsRedeemed' : 'oursPayRecordsNotRedeemed')}
                    </span>
                  </div>
                  <div className={styles.itemMeta}>
                    <span>{order.planName}</span>
                    <span>{orderDate(order.createdAt)}</span>
                  </div>
                  <div className={styles.itemActions}>
                    <Button
                      variant="outlined"
                      size="m"
                      data-testid="account-consume-card-copy"
                      onClick={() => void copyCard(order.cardNo ?? '')}
                    >
                      {t('oursPayRecordsCopyCard')}
                    </Button>
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={busy || cardIsUsed(order)}
                      onClick={() => {
                        // 「去兑换」只把卡密填进上面的输入框：兑换是写操作，必须由用户自己点提交
                        const full = order.cardNo ?? ''
                        setCode(full)
                        setRedeem({ status: 'idle' })
                      }}
                    >
                      {t('oursPurchasesGoRedeem')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
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
