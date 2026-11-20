/**
 * 「支付记录」弹层（Issue #189）：把一笔订单从下单到卡密兑换的全过程按时间线摊开。
 *
 * 与 #115 的 `PaymentRecordsDialog`（只读流水）和 #158 的 `PurchaseRecordsDialog`
 * （按套餐看能做什么）的关系：这一页只回答一个问题——**这笔钱到底走到哪一步了**。
 * 所以它的主体是一根时间线，而不是一排卡片。
 *
 * 本文件同样只做三件事：持有状态、调数据层、把设计系统组件注入展示层。
 * 全部判定与整块 DOM 在 `PaymentTrailView.ts`（纯 `createElement`、不 import CSS），
 * 这样 `tests/unit/payment-trail-ui.test.mjs` 能在裸 Node 里对真代码跑 `renderToStaticMarkup`。
 *
 * 三条这页特有的行为：
 *  1. **PAID 未发卡自动刷新**：支付回调到发卡通常 1~3 秒，用户盯着页面等的时候每 4 秒
 *     静默重拉一次，最多 2 分钟（`shouldKeepPolling`）；轮询失败**不砸掉**已有内容，
 *     且只合并第一页（第 2 页起已加载的记录原地不动）。
 *  2. **只复制单号，不碰卡密**：完整卡号不进 DOM（列表里只有后 4 位），
 *     复制按钮只给订单号，方便用户发给客服核对。
 *  3. **分页 + 状态筛选（#326）**：列表按 `limit=20` + `offset` 一页页追加，筛选页签切换时
 *     整段重置（offset 回 0、旧列表丢掉、「全部」不带 status）。所有状态变化都走
 *     `PaymentTrailView.ts` 的 `trailListReducer`，容器只负责发请求与派发动作。
 */
import { Fragment, createElement, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import { fetchCardTrail, fetchTrail, type CardTrailFetcher } from '../../services/ours/trail.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  CardTrailPanel,
  PaymentTrailView,
  TRAIL_POLL_INTERVAL_MS,
  hasWaitingCard,
  initialTrailListState,
  loadCardTrail,
  loadTrailPage,
  nextTrailOffset,
  shouldKeepPolling,
  shouldShowPaymentTrail,
  tabToTrailStatus,
  trailListReducer,
  type CardTrailView,
  type TrailFetcher,
  type TrailStatusTab,
  type ViewButtonComponent,
} from './PaymentTrailView.js'
import styles from './PaymentTrailDialog.module.css'

/** 把设计系统的 `Button` 适配成展示层要的最小按钮形状（`data-testid` 走剩余 props 透传） */
const renderButton: ViewButtonComponent = ({ testId, ...props }) => {
  const extra: Record<string, string> = testId === undefined ? {} : { 'data-testid': testId }
  return createElement(Button, { ...props, ...extra })
}

export type PaymentTrailDialogProps = {
  onClose: () => void
  /** 测试注入；默认走数据层的真实现 */
  fetchTrail?: TrailFetcher
  /** 卡密溯源的注入点（#325）；默认 `GET /api/card/trail`，只读 */
  fetchCardTrail?: CardTrailFetcher
  /** 复制订单号；默认写剪贴板（测试注入以便断言） */
  onCopyOrderNo?: (outTradeNo: string) => void
}

export const PaymentTrailDialog = ({
  onClose,
  fetchTrail: load = fetchTrail,
  fetchCardTrail: loadCard = fetchCardTrail,
  onCopyOrderNo,
}: PaymentTrailDialogProps) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const kind = useApiConfig((state) => state.kind)
  // 列表状态（筛选页签 + 已累积的页 + 加载更多进度）全部走 `trailListReducer`：
  // 「切筛选整段重置」「加载更多失败不清空」这些口径都写在 `PaymentTrailView.ts` 里，能被 Node 单测直接断言。
  const [state, dispatch] = useReducer(trailListReducer, initialTrailListState)
  const { tab, view } = state
  // 关掉之后异步请求可能才回来：别往已卸载的组件里写状态
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 轮询起点：从挂载算起，封顶 2 分钟（`shouldKeepPolling` 判的就是这个差值）
  const startedAt = useRef(Date.now())
  /**
   * 两个请求通道各自一个序号（#326）：翻页请求与首页/轮询请求互不顶掉对方的结果。
   * 只比序号、不取消请求 —— `fetchTrail` 没有取消接口，这里只是「晚到的旧响应不写状态」。
   */
  const firstSeq = useRef(0)
  const moreSeq = useRef(0)
  /**
   * 卡密溯源（#325）：`cardNo` 是要查的那张卡，`view` 是它的三态。
   * 卡号只活在这个 state 里（重试要用它）：不进日志、不进埋点、不进剪贴板、不落存储。
   * 序号只管一件事——晚到的旧响应不许盖掉新的一次查询。
   */
  const [card, setCard] = useState<{ cardNo: string; view: CardTrailView } | null>(null)
  const cardSeq = useRef(0)
  /** 「重试」要重打同一个卡号：只留一个 ref，读它比读 state 少一层闭包陷阱 */
  const lastCardNo = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    startedAt.current = Date.now()
    return () => {
      alive.current = false
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [])

  /**
   * 拉第一页。`silent` = 4 秒轮询：不清列表、失败不抛错，只把结果按 `out_trade_no` 合并进去。
   * `offset` 恒为 0（首页 / 刷新 / 切筛选都是从头拉）。
   */
  const loadFirst = useCallback(
    (silent: boolean) => {
      if (!silent) {
        dispatch({ type: 'reload' })
        // 手动刷新 / 切筛选后，正在飞的翻页结果已经没意义了
        moreSeq.current += 1
      }
      const seq = (firstSeq.current += 1)
      void loadTrailPage({
        fetchTrail: load,
        apiKey,
        offset: 0,
        // `all` 页签 = null，请求里连 status 参数都不带
        status: tabToTrailStatus(tab),
      }).then((result) => {
        if (!alive.current || seq !== firstSeq.current) {
          return
        }
        if (result.status === 'ok') {
          dispatch({ type: silent ? 'silent' : 'loaded', page: result.page })
          return
        }
        // 静默轮询失败时保留上一次的内容：网络抖一下不该把用户已经看到的时间线清空
        if (silent) {
          return
        }
        dispatch({ type: 'failed', error: result.error })
      })
    },
    [load, apiKey, tab]
  )

  useEffect(() => {
    loadFirst(false)
  }, [loadFirst])

  /** 点「加载更多 / 重试」：`offset` = 已加载条数，成功后追加去重，失败只标底部错误（列表原地不动） */
  const loadMore = useCallback(() => {
    if (view.status !== 'ok' || view.page === null) {
      return
    }
    if ((view.more ?? 'idle') === 'loading') {
      return
    }
    const offset = nextTrailOffset(view.items ?? view.page.orders)
    dispatch({ type: 'more-start' })
    const seq = (moreSeq.current += 1)
    void loadTrailPage({
      fetchTrail: load,
      apiKey,
      offset,
      status: tabToTrailStatus(tab),
    }).then((result) => {
      if (!alive.current || seq !== moreSeq.current) {
        return
      }
      if (result.status === 'ok') {
        dispatch({ type: 'more-loaded', page: result.page })
        return
      }
      dispatch({ type: 'more-failed', error: result.error })
    })
  }, [view, load, apiKey, tab])

  // 轮询要看**全部已加载记录**（第 2 页起有 paid 单也得继续刷），不是只看第一页
  const items = view.status === 'ok' ? (view.items ?? view.page?.orders ?? []) : []
  const waitingCard = hasWaitingCard(items)

  useEffect(() => {
    if (!waitingCard) {
      return undefined
    }
    if (!shouldKeepPolling('paid', Date.now() - startedAt.current)) {
      return undefined
    }
    timer.current = setTimeout(() => {
      timer.current = null
      loadFirst(true)
    }, TRAIL_POLL_INTERVAL_MS)
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    // `view` 进依赖是为了「每次结果回来重新计时」：cleanup 会清掉旧 timer，永远不会叠加。
    // 追加分页也会让它重排一次计时（最多推迟一个周期），但绝不产生第二个定时器。
  }, [waitingCard, view, loadFirst])

  /**
   * 打开一张卡的溯源。先落 loading（弹层立刻出现，长请求不会「点了没反应」），
   * 再由 `loadCardTrail` 归一结果（404 统一「没有找到这笔记录」，503 可重试且不是空态）。
   * 这里的 `cardNo` 是**完整卡号**：只作为请求参数，DOM 里由面板 `maskTrailCard` 掩码。
   */
  const openCardTrail = useCallback(
    (cardNo: string) => {
      const seq = (cardSeq.current += 1)
      lastCardNo.current = cardNo
      setCard({ cardNo, view: { status: 'loading' } })
      void loadCardTrail({ fetchCardTrail: loadCard, apiKey, cardNo }).then((result) => {
        if (!alive.current || seq !== cardSeq.current) {
          return
        }
        setCard({
          cardNo,
          view:
            result.status === 'ok'
              ? { status: 'ok', trail: result.trail }
              : { status: 'error', error: result.error },
        })
      })
    },
    [loadCard, apiKey]
  )

  const retryCardTrail = useCallback(() => {
    const cardNo = lastCardNo.current
    if (cardNo !== null) {
      openCardTrail(cardNo)
    }
  }, [openCardTrail])

  const copyOrderNo = (outTradeNo: string) => {
    if (onCopyOrderNo !== undefined) {
      onCopyOrderNo(outTradeNo)
      return
    }
    void copyText(outTradeNo)
  }

  // 渠道门禁的兜底：入口已经在设置里按 `kind === 'ours'` 拦过一次，这里再拦一次，
  // 免得以后有人从别处直接挂载它（#166 的教训：门禁不能只写在入口）
  if (!shouldShowPaymentTrail(kind)) {
    return null
  }

  const trailModal = createElement(
    Modal,
    {
      title: t('oursTrailTitle'),
      closable: true,
      zIndex: 1200,
      className: styles.dialog,
      mainClassName: styles.main,
      onClose,
      footer: createElement(
        'div',
        { className: styles.actions },
        createElement(
          Button,
          {
            variant: 'outlined',
            disabled: view.status === 'loading',
            // `data-testid` 不在 Button 的 props 类型里，但会随剩余 props 透传到 <button>
            ...({ 'data-testid': 'trail-refresh' } as Record<string, string>),
            onClick: () => loadFirst(false),
          },
          t('oursTrailRefresh')
        )
      ),
    },
    createElement(PaymentTrailView, {
      t,
      classNames: styles,
      button: renderButton,
      view,
      tab,
      onTabChange: (next: TrailStatusTab) => dispatch({ type: 'tab', tab: next }),
      onLoadMore: loadMore,
      // 重试打的还是同一个 offset：失败时 items 没变，nextTrailOffset 自然还是那一页
      onRetryMore: loadMore,
      onRetry: () => loadFirst(false),
      onCopyOrderNo: copyOrderNo,
      // 卡密块上的「查这张卡」（#325）：完整卡号只在这里进 query，DOM 里仍是掩码
      onLookupCard: openCardTrail,
    })
  )

  /**
   * 卡密溯源弹层（#325）：叠在支付记录弹层之上（`zIndex` 1300），
   * 关掉它只关这一层（`Modal` 的 `openModals` 栈按挂载顺序让 Esc 只关最上层）。
   * 标题就是 `oursTrailCardLookupTitle`，正文三态全部在 `CardTrailPanel`。
   */
  const cardModal =
    card === null
      ? null
      : createElement(
          Modal,
          {
            title: t('oursTrailCardLookupTitle'),
            closable: true,
            zIndex: 1300,
            className: styles.dialog,
            mainClassName: styles.main,
            onClose: () => setCard(null),
          },
          createElement(CardTrailPanel, {
            t,
            classNames: styles,
            view: card.view,
            onRetry: retryCardTrail,
            button: renderButton,
          })
        )

  return createElement(Fragment, null, trailModal, cardModal)
}
