/**
 * 「我的购买」弹层（Issue #158）：`GET /api/orders` 的分页 / 筛选视图。
 *
 * 与「付款记录」（#115，`PaymentRecordsDialog`）的区别：那个是**只读流水**，返回什么就列什么；
 * 这一页是「按套餐看买了什么、还能做什么」，所以多了筛选 tab、分页和**卡片上的下一步动作**
 * （已发卡 → 去兑换；待支付 → 去支付）。
 *
 * 本文件只做三件事：持有状态、调数据层、把设计系统组件注入展示层。
 * 所有「会做判断」的逻辑与整块 DOM 都在 `PurchaseRecordsView.ts` 里（纯 `createElement`、
 * 不 import CSS），这样 `tests/unit/purchases-ui.test.mjs` 能在裸 Node 里对**真代码**跑
 * `renderToStaticMarkup`——`.tsx` 的 JSX 不在 Node 的类型擦除范围内，单测里加载不了。
 *
 * 数据层 `services/ours/purchases.ts`（#158 另一半，已随 PR #165 合入 main）只 import，
 * 不重复定义类型、不自己写请求。
 *
 * 安全约束：完整卡号只在**用户点开「查看完整卡号」之后**进入 DOM 与组件内存，
 * 不进 localStorage、不进日志、不进错误上报；列表里永远只有后 4 位（`maskCardNo`）。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import { fetchPurchases } from '../../services/ours/purchases.js'
import type { PurchaseOrder } from '../../services/ours/purchases.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { setOursServicesOpen } from './settingsDialogState.js'
import {
  PURCHASE_PAGE_SIZE,
  PurchaseRecordsView,
  loadPurchasePage,
  type CardAction,
  type FetchPurchases,
  type PurchaseTab,
  type PurchasesView,
  type ViewButtonComponent,
} from './PurchaseRecordsView.js'
import styles from './PurchaseRecordsDialog.module.css'

/**
 * 把设计系统的 `Button` 适配成展示层要的最小按钮形状。
 * `data-testid` 走展开而不是字面量：它不在 `ButtonHTMLAttributes` 的类型里，
 * 但真实 `Button` 会把剩余 props 原样透传到 `<button>`（见 Button.tsx），所以运行期是对的。
 */
const renderButton: ViewButtonComponent = ({ testId, ...props }) => {
  const extra: Record<string, string> = testId === undefined ? {} : { 'data-testid': testId }
  return createElement(Button, { ...props, ...extra })
}

export type PurchaseRecordsDialogProps = {
  onClose: () => void
  /** 测试注入；默认走数据层的真实现 */
  fetchPurchases?: FetchPurchases
  /** 初始筛选（默认「全部」）；也方便以后从别处深链进来 */
  initialTab?: PurchaseTab
  /** 「去兑换」落点；默认打开既有的「额度与卡密」弹层（里面就是卡密兑换） */
  onGoRedeem?: () => void
  /** 「去支付」落点；默认同样走既有购买入口（下单带 cid 的逻辑在那边，见 #135） */
  onGoPay?: () => void
}

export const PurchaseRecordsDialog = ({
  onClose,
  fetchPurchases: load = fetchPurchases,
  initialTab = 'all',
  onGoRedeem,
  onGoPay,
}: PurchaseRecordsDialogProps) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const [tab, setTab] = useState<PurchaseTab>(initialTab)
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<PurchasesView>({ status: 'loading' })
  const [expandedCard, setExpandedCard] = useState<string | null>(null)
  // 关掉之后异步请求可能才回来：别往已卸载的组件里写状态
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    (nextTab: PurchaseTab, nextOffset: number) => {
      setView({ status: 'loading' })
      setExpandedCard(null)
      void loadPurchasePage({
        fetchPurchases: load,
        apiKey,
        tab: nextTab,
        offset: nextOffset,
      }).then((result) => {
        if (alive.current) {
          setView(result)
        }
      })
    },
    [load, apiKey]
  )

  useEffect(() => {
    run(initialTab, 0)
    // 只在挂载与 apiKey 变化时重来；tab / offset 切换由各自的事件处理里显式 run
  }, [run, initialTab])

  const changeTab = (next: PurchaseTab) => {
    if (next === tab) {
      return
    }
    setTab(next)
    setOffset(0)
    run(next, 0)
  }

  const goPage = (next: number) => {
    setOffset(next)
    run(tab, next)
  }

  // 既有的「额度与卡密」弹层里已经有套餐购买与卡密兑换两块，跳过去就是复用；
  // 这里**不重写**下单（cid 逻辑在 OursServicesDialog / api.ts，见 #135）与兑换。
  const openExisting = () => {
    setOursServicesOpen(true)
    onClose()
  }

  const handleCardAction = (_order: PurchaseOrder, action: CardAction) => {
    if (action === 'redeem') {
      const go = onGoRedeem ?? openExisting
      go()
      return
    }
    if (action === 'pay') {
      const go = onGoPay ?? openExisting
      go()
    }
  }

  return (
    <Modal
      title={t('oursPurchasesTitle')}
      closable
      zIndex={1200}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
      footer={
        <div className={styles.actions}>
          <Button
            variant="outlined"
            disabled={view.status === 'loading'}
            data-testid="purchases-refresh"
            onClick={() => run(tab, offset)}
          >
            {t('oursPurchasesRefresh')}
          </Button>
        </div>
      }
    >
      <PurchaseRecordsView
        t={t}
        classNames={styles}
        button={renderButton}
        tab={tab}
        view={view}
        expandedCard={expandedCard}
        onTab={changeTab}
        onRetry={() => run(tab, offset)}
        onPrev={() => goPage(Math.max(0, offset - PURCHASE_PAGE_SIZE))}
        onNext={() => goPage(offset + PURCHASE_PAGE_SIZE)}
        onToggleCard={(outTradeNo) =>
          setExpandedCard((current) => (current === outTradeNo ? null : outTradeNo))
        }
        onCardAction={handleCardAction}
      />
    </Modal>
  )
}
