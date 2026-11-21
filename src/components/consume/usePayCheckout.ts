/**
 * 「取收款页地址 → App 内打开 → 关页回调」这一条付款链路的**唯一实现**（#817）。
 *
 * 为什么抽出来：付款入口现在有两处 —— 「购买」页里每个套餐的「去支付」，和「我的钱包」页余额卡
 * 右侧的付款按钮。两处必须走同一条链路（`fetchPayLink` → `openPayLinkInApp`），否则会出现
 * 「一处守了并发、一处没守」「一处给了可读提示、一处整页跳走」这类分叉。#331 / #784 的约束原样保留：
 *
 *  1. **不建单、不轮询**：地址每次现取（小铺随时换链接），不在客户端缓存；
 *  2. **同一时刻只允许一条在飞**（`payBusyRef`）：收款页是外部浏览器视图，连点会开出两个；
 *  3. **Web / 老 APK / 插件缺失** → `openPayLinkInApp` 返回 `false`，只给可读提示
 *     （`oursPayOpenFailed`），绝不 `window.open` 兜底（会整页跳走）；
 *  4. **`onPurchased` 只在「用户从收款页回来了」时调用一次**，不代表付款成功 ——
 *     #784 的自动兑现只挂在这一个回调上，这里不新增第二个触发点。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationKey } from '../../i18n/index.js'
import { fetchPayLink } from '../../services/ours/api.js'
import { httpTransport, openPayLinkInApp } from '../../services/ours/transport.js'

export type PayView = { status: 'idle' } | { status: 'busy' } | { status: 'error'; messageKey: TranslationKey }

export const usePayCheckout = (onPurchased?: () => void) => {
  const [pay, setPay] = useState<PayView>({ status: 'idle' })
  const payBusyRef = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** 取地址 → App 内打开 → 关页回调。地址每次现取，不在客户端缓存（小铺随时换链接） */
  const openCheckout = useCallback(async () => {
    if (payBusyRef.current) {
      return
    }
    payBusyRef.current = true
    setPay({ status: 'busy' })
    const link = await fetchPayLink(httpTransport)
    if (!aliveRef.current) {
      payBusyRef.current = false
      return
    }
    if (link.status === 'error') {
      payBusyRef.current = false
      setPay({ status: 'error', messageKey: link.messageKey })
      return
    }
    const opened = await openPayLinkInApp(link.url, () => {
      // 用户回来了：**不判断成败**，只把订单拉一遍（小铺付款后会把卡密挂到订单上）
      if (!aliveRef.current) {
        return
      }
      // 关页 = 只是「用户回来了」：把订单重拉一遍交给外层，这里不再多说一句
      setPay({ status: 'idle' })
      onPurchased?.()
    })
    payBusyRef.current = false
    if (!aliveRef.current) {
      return
    }
    if (!opened) {
      // Web / 老 APK / 插件缺失：绝不 window.open 兜底（会整页跳走），只给可读提示
      setPay({ status: 'error', messageKey: 'oursPayOpenFailed' })
      return
    }
    setPay({ status: 'idle' })
  }, [onPurchased])

  return { pay, payBusy: pay.status === 'busy', openCheckout }
}
