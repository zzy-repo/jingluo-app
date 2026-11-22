/**
 * 「我的卡密」列表的**渲染层**（Issue #834）—— 真文案 + `createElement`，不 import CSS，
 * 所以裸 Node 能 `renderToStaticMarkup`：**有卡号的订单显示掩码卡号、复制拿完整卡号、
 * 没有 `recharge_code` 的订单根本没有卡号节点**这三件事都能按 markup 断言，而不是读源码猜。
 *
 * ## 为什么抽成 `.ts`
 *
 * `.tsx` 裸 Node import 不了（JSX 不在类型擦除范围内），而这个列表的契约恰恰全是「渲染出什么」：
 *  #834 的验收里写着「有 `recharge_code` 的订单显示掩码卡号 + 复制可取完整；无卡号订单没有卡号节点，
 *  也不报错」。放在 `.tsx` 里就只能靠读源码断言，等于把契约降级成口头承诺
 * （仓库既有口径：#817 的余额卡、#487 的四个面板都这么拆）。
 *
 * ## 状态文案自己映射（#834 第三条）
 *
 * 新接口**没有 `plan_name`、也没有 `status_text`**，所以状态由界面按 `status` 自己映射
 * （`ORDER_STATUS_KEYS`，zh/en 成对；认不出的状态给 `consumeOrderStatusUnknown`，
 * **绝不**把未知状态显示成「已完成」）。
 *
 * ## 卡号
 *
 * 展示只用 `maskCardNo()`（= `mask.ts` 的 `maskCard`：只留尾 4 位），复制按钮交出去的仍是
 * **完整卡号**（`onCopy(fullCode)`），全文不进 DOM 文本、不进日志、不进 localStorage。
 */
import { createElement, type ReactNode } from 'react'
import type { TranslationKey } from '../../i18n/index.js'
import {
  isCompletedOrder,
  isOrderRedeemable,
  rechargeCodeOf,
  type ConsumeMyOrder,
} from '../../services/consume/orders.js'
import { maskCardNo } from '../../services/ours/mask.js'
import { formatCurrency, formatDateTime, type PanelBlockProps } from './panels.js'

/**
 * `status` → 界面文案 key（zh/en 成对）。
 *
 * 覆盖面按服务端枚举来：`COMPLETED` / `PENDING` / `EXPIRED` 是票面点名的三个，
 * `CANCELLED` / `FAILED` / `REFUNDED` 是同一套支付系统里必然出现的三个（先写上，免得回落到「未知」）。
 */
export const ORDER_STATUS_KEYS: Record<string, TranslationKey> = {
  COMPLETED: 'consumeOrderStatusCompleted',
  PENDING: 'consumeOrderStatusPending',
  EXPIRED: 'consumeOrderStatusExpired',
  CANCELLED: 'consumeOrderStatusCancelled',
  FAILED: 'consumeOrderStatusFailed',
  REFUNDED: 'consumeOrderStatusRefunded',
}

/** 未知状态的文案 key（**不是**「已完成」） */
export const ORDER_STATUS_UNKNOWN_KEY: TranslationKey = 'consumeOrderStatusUnknown'

/** 一条订单的状态文案 key：大小写无关，认不出就是 `consumeOrderStatusUnknown` */
export const orderStatusKeyOf = (status: string): TranslationKey => {
  const key = status.trim().toUpperCase()
  const mapped = ORDER_STATUS_KEYS[key]
  return mapped === undefined ? ORDER_STATUS_UNKNOWN_KEY : mapped
}

export type CardsListViewProps = PanelBlockProps & {
  /** 订单（服务端顺序即展示顺序；这里不重排 —— 排序口径在服务端 `created_at desc`） */
  orders: ConsumeMyOrder[]
  /** 兑换请求在飞：按钮禁用（两次点击会产生第二个 POST，而它没有幂等键） */
  busy: boolean
  /** 复制**完整**卡号（全文只走剪贴板） */
  onCopy: (code: string) => void
  /** 「去兑换」：只把卡号填进上面的输入框，**绝不代替用户提交** */
  onRedeem: (code: string) => void
}

/**
 * 一行订单。
 *
 * 没有 `recharge_code`（非 COMPLETED、或服务端没发）时**不渲染卡号节点、也不渲染复制按钮**：
 *  - 卡号节点缺失是「这张单还没有卡」的正确表达，界面既不编一个空串占位，也不报错；
 *  - 复制按钮复制空串等于一个假动作，藏掉比留着诚实。
 */
const cardRow = (props: CardsListViewProps, order: ConsumeMyOrder, index: number): ReactNode => {
  const { t, c, Button, busy, onCopy, onRedeem } = props
  const code = rechargeCodeOf(order)
  const completed = isCompletedOrder(order)
  // #840 关闭条件 5：`issued` + `redeemable` 才给「去兑换」；`void` / `expired` / `redeemed` 不给
  const canRedeem = isOrderRedeemable(order)
  const statusText = t(orderStatusKeyOf(order.status))
  const amountText = formatCurrency(order.amountYuan)
  const timeText = formatDateTime(order.createdAt)
  return createElement(
    'li',
    {
      key: order.outTradeNo === '' ? `card-row-${index}` : order.outTradeNo,
      className: c.item,
      'data-testid': 'account-consume-card-row',
    },
    createElement(
      'div',
      { className: c.itemTop },
      // 卡号：只有真的拿到卡号才渲染这个节点（掩码展示，复制仍取全文）
      code === ''
        ? null
        : createElement(
            'span',
            { className: c.tail, 'data-testid': 'account-consume-card-no' },
            maskCardNo(code)
          ),
      createElement(
        'span',
        {
          className: completed ? `${c.chip} ${c.chipUsed}` : c.chip,
          'data-testid': 'account-consume-card-status',
        },
        statusText
      )
    ),
    createElement(
      'div',
      { className: c.itemMeta },
      // 到账额度（元）：卡密的面值，不是实付
      createElement('span', { 'data-testid': 'account-consume-card-amount' }, amountText),
      // 时间：认不出来给 `—`（`formatDateTime` 的口径），不显示 1970
      createElement('span', { 'data-testid': 'account-consume-card-time' }, timeText)
    ),
    createElement(
      'div',
      { className: c.itemActions },
      code === ''
        ? null
        : createElement(
            Button,
            {
              key: 'copy',
              variant: 'outlined',
              size: 'm',
              testId: 'account-consume-card-copy',
              onClick: () => onCopy(code),
            },
            t('oursPayRecordsCopyCard')
          ),
      // #840：只有「还能兑」的卡才长这个按钮 —— `void`（已作废）/ `expired`（已过期）/
      // `redeemed`（已兑换）/ 服务端说 `redeemable:false` 的，一概不出现（关闭条件 5）
      canRedeem
        ? createElement(
            Button,
            {
              key: 'redeem',
              variant: 'outlined',
              size: 'm',
              testId: 'account-consume-card-redeem',
              disabled: busy,
              onClick: () => onRedeem(code),
            },
            t('oursPurchasesGoRedeem')
          )
        : null
    )
  )
}

/** 列表本体：`<ul>` + 每行一条订单（空列表由调用方渲染空态，这里不重复文案） */
export const CardsListView = (props: CardsListViewProps): ReactNode => {
  const { c, orders } = props
  return createElement(
    'ul',
    { className: c.list, 'data-testid': 'account-consume-card-list' },
    orders.map((order, index) => cardRow(props, order, index))
  )
}
