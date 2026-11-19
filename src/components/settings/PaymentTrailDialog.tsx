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
 * 两条这页特有的行为：
 *  1. **PAID 未发卡自动刷新**：支付回调到发卡通常 1~3 秒，用户盯着页面等的时候每 4 秒
 *     静默重拉一次，最多 2 分钟（`shouldKeepPolling`）；轮询失败**不砸掉**已有内容。
 *  2. **只复制单号，不碰卡密**：完整卡号不进 DOM（列表里只有后 4 位），
 *     复制按钮只给订单号，方便用户发给客服核对。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import { fetchTrail } from '../../services/ours/trail.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  PaymentTrailView,
  TRAIL_POLL_INTERVAL_MS,
  loadTrailPage,
  shouldKeepPolling,
  shouldShowPaymentTrail,
  type TrailFetcher,
  type TrailView,
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
  /** 复制订单号；默认写剪贴板（测试注入以便断言） */
  onCopyOrderNo?: (outTradeNo: string) => void
}

export const PaymentTrailDialog = ({
  onClose,
  fetchTrail: load = fetchTrail,
  onCopyOrderNo,
}: PaymentTrailDialogProps) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const kind = useApiConfig((state) => state.kind)
  const [view, setView] = useState<TrailView>({ status: 'loading' })
  // 关掉之后异步请求可能才回来：别往已卸载的组件里写状态
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 轮询起点：从挂载算起，封顶 2 分钟（`shouldKeepPolling` 判的就是这个差值）
  const startedAt = useRef(Date.now())

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

  const run = useCallback(
    (silent: boolean) => {
      if (!silent) {
        setView({ status: 'loading' })
      }
      void loadTrailPage({
        fetchTrail: load,
        apiKey,
        offset: 0,
      }).then((result) => {
        if (!alive.current) {
          return
        }
        // 静默轮询失败时保留上一次的内容：网络抖一下不该把用户已经看到的时间线清空
        if (silent && result.status === 'error') {
          return
        }
        setView(result)
      })
    },
    [load, apiKey]
  )

  useEffect(() => {
    run(false)
  }, [run])

  const page = view.status === 'ok' ? view.page : null
  const waitingCard = page !== null && page.orders.some((order) => order.status === 'paid')

  useEffect(() => {
    if (!waitingCard) {
      return undefined
    }
    if (!shouldKeepPolling('paid', Date.now() - startedAt.current)) {
      return undefined
    }
    timer.current = setTimeout(() => {
      timer.current = null
      run(true)
    }, TRAIL_POLL_INTERVAL_MS)
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [waitingCard, page, run])

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

  return createElement(
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
            onClick: () => run(false),
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
      onRetry: () => run(false),
      onCopyOrderNo: copyOrderNo,
    })
  )
}
