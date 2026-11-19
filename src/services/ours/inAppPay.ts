/**
 * 「去支付」的编排（Issue #235）：建单 → 在 App 内嵌浏览器里打开收银台 → 关掉就回跳查单。
 *
 * 只做决定，不碰平台细节：真正的建单 / 打开 / 轮询都由调用方通过 `flow` 注入，
 * 于是这段顺序逻辑可以在纯 Node 里跑单测（不需要 WebView、不需要 React）。
 *
 * 三条规矩：
 *  1. **同一张单不重复建单** —— 用户连点两次「去支付」不该在服务端留下两张废弃订单；
 *  2. **换套餐必须换新的 pay_url** —— 收银台地址里带着金额与单号签名，跨单复用等于开错价；
 *  3. **关闭只回跳一次** —— 「关掉收银台」可能被触发多次（重复事件 / 重开），
 *     重查一次就够，否则会连打几次 /api/order（后端限流）。
 */
import type { OursBuyResult, OursBuyTicket, OursMessageKey } from './api.js'

/** 一次支付要用到的外部能力（由界面注入，便于单测） */
export type InAppPayFlow = {
  /** 上一次拿到的票根：同一套餐就复用，不重复建单 */
  ticket: OursBuyTicket | null
  /** 记住新票根（界面存内存，订单到终态时清掉） */
  remember: (ticket: OursBuyTicket | null) => void
  /** 建单：GET /api/buy */
  createOrder: (planId: string) => Promise<OursBuyResult>
  /** 用 App 内嵌浏览器打开；返回 false 表示这条路走不通（Web / 没插件 / 打不开） */
  openInApp: (payUrl: string, onClosed: () => void) => Promise<boolean>
  /** 降级：用系统浏览器打开（老行为） */
  openSystem: (payUrl: string) => Promise<boolean>
  /** 起一轮查单；`force` 表示「用户刚从收银台回来，把后台那轮超时的轮询顶掉」 */
  poll: (order: { outTradeNo: string; orderToken: string }, options: { force: boolean }) => void
}

export type InAppPayOutcome =
  | {
      kind: 'ok'
      ticket: OursBuyTicket
      /** 收银台是在 App 内打开的还是退回系统浏览器 */
      via: 'in-app' | 'system'
      replacedUnpaidOrder: boolean
    }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

/** 收银台打开后立刻查一轮，再在用户关掉它时**强制重查一次** */
const openPay = async (
  payUrl: string,
  flow: InAppPayFlow,
  order: { outTradeNo: string; orderToken: string }
): Promise<'in-app' | 'system' | null> => {
  let closed = false
  const onClosed = (): void => {
    if (closed) {
      return
    }
    closed = true
    flow.poll(order, { force: true })
  }
  if (await flow.openInApp(payUrl, onClosed)) {
    return 'in-app'
  }
  // 内嵌这条路走不通：把回调废掉，免得它以后（哪怕真的被调用）再触发一次重查
  closed = true
  if (await flow.openSystem(payUrl)) {
    return 'system'
  }
  return null
}

export const startInAppPay = async (
  planId: string,
  flow: InAppPayFlow
): Promise<InAppPayOutcome> => {
  const id = planId.trim()
  if (id === '') {
    return { kind: 'error', code: 'PLAN_MISSING', messageKey: 'oursErrPlanMissing' }
  }
  let ticket: OursBuyTicket | null =
    flow.ticket !== null && flow.ticket.planId === id ? flow.ticket : null
  let replacedUnpaidOrder = false
  if (ticket === null) {
    const created = await flow.createOrder(id)
    if (created.kind !== 'ok') {
      return { kind: 'error', code: created.code, messageKey: created.messageKey }
    }
    ticket = created.ticket
    replacedUnpaidOrder = created.replacedUnpaidOrder
    flow.remember(ticket)
  }
  const order = { outTradeNo: ticket.outTradeNo, orderToken: ticket.orderToken }
  const via = await openPay(ticket.payUrl, flow, order)
  if (via === null) {
    return { kind: 'error', code: 'CHECKOUT_NOT_OPENED', messageKey: 'oursErrCheckoutUnsupported' }
  }
  // 先起一轮：有用户付完款根本不关浏览器（直接切回 App），那一轮轮询仍能拿到卡密
  flow.poll(order, { force: false })
  return { kind: 'ok', ticket, via, replacedUnpaidOrder }
}
