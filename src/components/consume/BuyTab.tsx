/**
 * Tab 2「购买」（#482 三弹层合一 / #487 W1-C1）—— 数据来自 **apia**。
 *
 * 链路（#484 §3.5，一条都不能省，也都不能自己造）：
 *
 *   套餐列表  `GET /api/plans`     （`fetchPlans`，全线下架时返回空表 = 正常状态，不是失败）
 *   下单      `GET /api/pay-link`  （`fetchPayLink`，**每次现取**；我们不建单、不读 302 Location）
 *   收款页    `openPayLinkInApp()` （App 内 popover 打开；Web / 没有插件 → 返回 false，界面给可读提示）
 *   关页后    `onPurchased()`      → 回到 Tab 1 并重新拉订单（卡密由小铺直接发到订单上）
 *
 * 三条与旧弹层不同的地方（都是「砍掉」而不是「搬过来」）：
 *  1. **不建单、不轮询**（#331）：付款结果在小铺那边，客户端能做的只有「关掉收款页后重拉订单」；
 *  2. 空态 / 失败态都给**可操作**的出口（空表 → 「前往购买」；失败 → 「重试」），不停在白屏；
 *  3. `POST /api/pay-link` 这类写接口**不自动重试**（会生成新单）—— 失败就只让用户手动再点。
 *
 * 金额口径：一律「元」（`¥`），不出现 `$` / USD / 积分。价格只经 `formatPlanPrice()` 渲染一次，
 * 界面里不写第二份 `toFixed`，也不硬编码符号。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { fetchPayLink, fetchPlans, formatPlanPrice } from '../../services/ours/api.js'
import type { OursPlan } from '../../services/ours/api.js'
import { httpTransport, openPayLinkInApp } from '../../services/ours/transport.js'
import { Button } from '../base/Button.js'
import styles from './AccountConsume.module.css'

type PlansView =
  | { status: 'loading' }
  | { status: 'ready'; plans: OursPlan[] }
  | { status: 'empty' }
  | { status: 'error'; messageKey: TranslationKey }

type PayView = { status: 'idle' } | { status: 'busy' } | { status: 'error'; messageKey: TranslationKey }

export type BuyTabProps = {
  /**
   * 从收款页回到 App 之后调一次：外层据此切到 Tab 1 并重新拉订单。
   * **不代表付款成功**（小铺那边才有结果），所以文案只说「已回到 App」。
   */
  onPurchased?: () => void
}

export const BuyTab = ({ onPurchased }: BuyTabProps) => {
  const t = useTranslate()
  const [plans, setPlans] = useState<PlansView>({ status: 'loading' })
  const [pay, setPay] = useState<PayView>({ status: 'idle' })
  // 收款页是外部浏览器视图：同一时刻只允许一条「取地址 + 打开」在飞，避免连点开出两个收款页
  const payBusyRef = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadPlans = useCallback(async () => {
    setPlans({ status: 'loading' })
    const state = await fetchPlans(httpTransport)
    if (!aliveRef.current) {
      return
    }
    if (state.status === 'success') {
      setPlans({ status: 'ready', plans: state.plans })
      return
    }
    if (state.status === 'empty') {
      setPlans({ status: 'empty' })
      return
    }
    setPlans({ status: 'error', messageKey: state.messageKey })
  }, [])

  useEffect(() => {
    void loadPlans()
  }, [loadPlans])

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
      // 关页 = 只是「用户回来了」：把订单重拉一遍交给外层（切 Tab 1），这里不再多说一句
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

  const payBusy = pay.status === 'busy'

  return (
    <div className={styles.body} data-testid="account-consume-buy">
      <p className={styles.hint}>{t('oursPayHint')}</p>

      {plans.status === 'loading' ? (
        <div className={styles.state} aria-busy>
          <p className={styles.stateText}>{t('oursPlansLoading')}</p>
        </div>
      ) : null}

      {plans.status === 'error' ? (
        <div className={styles.state}>
          <p className={styles.stateText}>{t(plans.messageKey)}</p>
          <div className={styles.stateActions}>
            <Button variant="outlined" size="m" onClick={() => void loadPlans()}>
              {t('oursPurchasesRetry')}
            </Button>
          </div>
        </div>
      ) : null}

      {plans.status === 'empty' ? (
        <div className={styles.state}>
          {/* 套餐全线下架是正常状态（#331）：说清「去哪儿买」，而不是报「加载失败」 */}
          <p className={styles.stateText}>{t('oursPayEmpty')}</p>
          <div className={styles.stateActions}>
            <Button size="m" data-testid="account-consume-buy-open" disabled={payBusy} onClick={() => void openCheckout()}>
              {payBusy ? t('oursPayBusy') : t('oursPayAction')}
            </Button>
          </div>
        </div>
      ) : null}

      {plans.status === 'ready' ? (
        <ul className={styles.plans}>
          {plans.plans.map((plan) => (
            <li key={plan.id} className={styles.plan} data-testid="account-consume-buy-plan">
              <span className={styles.planText}>
                <span className={styles.planName}>{plan.name}</span>
                {/* 计量单位统一成「元」：只显示 `¥39.00`（`formatPlanPrice` 是 apia 侧唯一的价格格式器，
                    不在界面里再写一份 `toFixed`），不写「积分」也不出现 `$`。 */}
                <span className={styles.planMeta}>{formatPlanPrice(plan)}</span>
              </span>
              <Button
                size="m"
                disabled={payBusy}
                data-testid="account-consume-buy-open"
                onClick={() => void openCheckout()}
              >
                {payBusy ? t('oursPayBusy') : t('oursBuyAction')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {pay.status === 'error' ? (
        <div className={`${styles.feedback} ${styles.feedbackError}`} role="alert" data-testid="account-consume-buy-status">
          <span>{t(pay.messageKey)}</span>
          {/* 收款页地址是只读接口，重开是安全的；但**不自动重试**，由用户点一下 */}
          <div className={styles.feedbackActions}>
            <Button variant="outlined" size="m" onClick={() => void openCheckout()}>
              {t('oursPurchasesRetry')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
