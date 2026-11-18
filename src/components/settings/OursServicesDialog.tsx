import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import {
  createRequestId,
  fetchBalance,
  fetchPlans,
  formatPlanPrice,
  formatQuota,
  maskCard,
  maskKey,
  OURS_PAYMENT_OPEN,
  redeemCard,
  type OursBalanceState,
  type OursPlansState,
  type OursRedeemResult,
} from '../../services/ours/api.js'
import { httpTransport } from '../../services/ours/transport.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './OursServices.module.css'

/**
 * 「我们的渠道」的额度与卡密入口（只在 kind === 'ours' 时渲染，其他渠道一条 DOM 都不留）。
 *
 * 为什么是一行 + 独立弹层，而不是把输入框直接摊在设置页：
 * 设置页「数据管理」区在 ours 渠道下只有 API Key 一个输入框（1.4.0-beta.3 的验收断言），
 * 卡密输入框塞进去会破坏那条约束；而且三块内容比设置行高得多，
 * 折叠进独立弹层在 360/390 的手机视口上不用滚很长的设置页。
 *
 * 本次范围（beta.8）只放开「只读 + 不产生订单」的部分：
 *   - 额度查询：手动触发，挂载不请求、无 interval
 *   - 套餐展示：价格与额度全部来自 /api/plans
 *   - 卡密兑换：POST /api/redeem（request_id 复用、IDEMPOTENT 按成功）
 *   - 支付：只有一行「支付暂未开放」说明。建单/查单/轮询逻辑留在 services/ours/api.ts
 *     并有单测覆盖，但界面上不提供入口：/buy 目前 302 到收银台且金额（0.10）与套餐标价
 *     不符，属资损风险，未核实前不能放开，也不能建出永远付不了的订单。
 */

type BalanceView = OursBalanceState | { status: 'loading'; keyTail: string }

/** 1000000 → 1,000,000（只做千分位，不跟着 locale 变） */
const formatTokenCount = (value: number): string =>
  Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 套餐列表里默认选中的套餐 id（没有可用套餐就是 null） */
const firstPlanId = (state: OursPlansState | { status: 'loading' }): string | null => {
  if (state.status !== 'success') {
    return null
  }
  return state.plans[0]?.id ?? null
}

/** 设置页里的入口行：只有我们的渠道才出现 */
export const OursServicesRow = () => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  const [open, setOpen] = useState(false)
  if (kind !== 'ours') {
    return null
  }
  return (
    <>
      <div className={styles.row} data-testid="ours-services-row">
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>{t('oursServicesLabel')}</div>
          <div className={styles.rowDescription}>{t('oursServicesDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.rowButton}
          data-testid="ours-services-open"
          onClick={() => setOpen(true)}
        >
          {t('oursServicesOpen')}
        </Button>
      </div>
      {open ? <OursServicesDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * 额度与卡密弹层：额度查询（手动）、套餐（只读 + 支付未开放说明）、卡密兑换。
 * 额度**不在挂载时请求**，也没有任何 interval：只有点「查询额度」或用 Key 兑换成功后才查一次。
 */
const OursServicesDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const hasKey = apiKey.trim() !== ''
  const [balance, setBalance] = useState<BalanceView>({ status: 'idle' })
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [plans, setPlans] = useState<OursPlansState | { status: 'loading' }>({ status: 'loading' })
  const [planId, setPlanId] = useState('')
  const [cardNo, setCardNo] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeem, setRedeem] = useState<OursRedeemResult | null>(null)
  // 一次「逻辑提交」一个 request_id：重试沿用同一个，服务端靠它去重（IDEMPOTENT）
  const requestIdRef = useRef<string | null>(null)

  // 套餐不带 Key，挂载时拉一次；失败给「重新加载」。额度不在这里查。
  useEffect(() => {
    let alive = true
    void fetchPlans(httpTransport).then((next) => {
      if (!alive) {
        return
      }
      setPlans(next)
      const nextId = firstPlanId(next)
      if (nextId !== null) {
        setPlanId((current) => (current === '' ? nextId : current))
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const reloadPlans = async () => {
    setPlans({ status: 'loading' })
    const next = await fetchPlans(httpTransport)
    setPlans(next)
    const nextId = firstPlanId(next)
    if (nextId !== null) {
      setPlanId((current) => (current === '' ? nextId : current))
    }
  }

  const refreshBalance = async () => {
    if (!hasKey) {
      return
    }
    setBalanceBusy(true)
    setBalance({ status: 'loading', keyTail: maskKey(apiKey) })
    const next = await fetchBalance(apiKey, httpTransport)
    setBalance(next)
    setBalanceBusy(false)
  }

  const submitRedeem = async () => {
    if (!hasKey) {
      setRedeem({ kind: 'error', code: 'API_KEY_MISSING', messageKey: 'oursErrKeyMissing', cardTail: maskCard(cardNo), retryable: false })
      return
    }
    if (cardNo.trim() === '') {
      setRedeem({ kind: 'error', code: 'CARD_MISSING', messageKey: 'oursErrCardMissing', cardTail: maskCard(cardNo), retryable: false })
      return
    }
    if (requestIdRef.current === null) {
      requestIdRef.current = createRequestId()
    }
    setRedeemBusy(true)
    const result = await redeemCard({ cardNo, apiKey, requestId: requestIdRef.current }, httpTransport)
    setRedeemBusy(false)
    setRedeem(result)
    if (result.kind === 'success') {
      // 成功后这一轮提交结束，下次输入新的卡密再用新的请求号
      requestIdRef.current = null
      setCardNo('')
      // 兑换成功即刷新额度（不轮询）
      void refreshBalance()
    }
  }

  const balanceText = (): string => {
    switch (balance.status) {
      case 'idle':
        return hasKey ? t('oursBalanceIdleHint') : t('oursBalanceNeedsKey')
      case 'loading':
        return t('oursBalanceLoading')
      case 'success':
        return t('oursBalanceValue', { tokens: formatTokenCount(balance.balance) })
      case 'unknown-balance':
        return t('oursBalanceUnknown')
      case 'network':
        return t('oursBalanceNetwork')
      case 'timeout':
        return t('oursBalanceTimeout')
      case 'invalid-json':
        return t('oursBalanceInvalidJson')
    }
  }

  const balanceTone =
    balance.status === 'success'
      ? styles.valueSuccess
      : balance.status === 'network' || balance.status === 'timeout' || balance.status === 'invalid-json'
        ? styles.valueError
        : undefined

  return (
    <Modal
      title={t('oursServicesTitle')}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.sections} data-testid="ours-services-dialog">
        {/* 1. 额度查询（最高优先）：手动触发，零轮询 */}
        <section className={styles.section} data-testid="ours-balance">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursBalanceTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-balance-refresh"
              disabled={!hasKey || balanceBusy}
              onClick={() => void refreshBalance()}
            >
              {balanceBusy ? t('oursBalanceLoading') : t('oursBalanceAction')}
            </Button>
          </div>
          <div
            role="status"
            data-testid="ours-balance-value"
            className={clsx(styles.value, balanceTone)}
          >
            {balanceText()}
          </div>
          {balance.status !== 'idle' ? (
            <div className={styles.hint}>{t('oursBalanceKeyTail', { tail: balance.keyTail })}</div>
          ) : null}
        </section>

        {/* 2. 套餐：价格与额度全部来自 /api/plans；支付只留一行说明，不建单、不跳转 */}
        <section className={styles.section} data-testid="ours-plans">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursPlansTitle')}</h3>
            {plans.status === 'error' ? (
              <Button
                variant="outlined"
                size="s"
                className={styles.sectionAction}
                onClick={() => void reloadPlans()}
              >
                {t('oursPlansRetry')}
              </Button>
            ) : null}
          </div>
          {plans.status === 'loading' ? (
            <div className={styles.hint}>{t('oursPlansLoading')}</div>
          ) : plans.status === 'error' ? (
            <div className={clsx(styles.value, styles.valueError)}>{t(plans.messageKey)}</div>
          ) : (
            <ul className={styles.plans}>
              {plans.plans.map((plan) => (
                <li key={plan.id}>
                  <button
                    type="button"
                    className={clsx(styles.plan, plan.id === planId && styles.planActive)}
                    aria-pressed={plan.id === planId}
                    onClick={() => setPlanId(plan.id)}
                  >
                    <span className={styles.planName}>{plan.name}</span>
                    <span className={styles.planMeta}>
                      {t('oursPlanPriceQuota', {
                        price: formatPlanPrice(plan),
                        quota: formatQuota(plan.quota),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <Button size="m" data-testid="ours-buy" disabled={!OURS_PAYMENT_OPEN}>
              {OURS_PAYMENT_OPEN ? t('oursBuyOpen') : t('oursBuyClosed')}
            </Button>
          </div>
          <div className={styles.hint} data-testid="ours-pay-notice">
            {t('oursBuyClosedHint')}
          </div>
        </section>

        {/* 3. 卡密兑换 */}
        <section className={styles.section} data-testid="ours-redeem">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursRedeemTitle')}</h3>
          </div>
          <div className={styles.redeemForm}>
            <input
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="ours-redeem-input"
              placeholder={t('oursRedeemPlaceholder')}
              aria-label={t('oursRedeemPlaceholder')}
              value={cardNo}
              onChange={(event) => setCardNo(event.target.value)}
              disabled={redeemBusy}
            />
            <Button
              size="m"
              data-testid="ours-redeem-submit"
              disabled={redeemBusy || !hasKey}
              onClick={() => void submitRedeem()}
            >
              {redeemBusy ? t('oursRedeemBusy') : t('oursRedeemAction')}
            </Button>
          </div>
          {redeem !== null ? (
            <div
              role="status"
              data-testid="ours-redeem-result"
              className={clsx(
                styles.value,
                redeem.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {`${t(redeem.messageKey)}${redeem.cardTail === '' ? '' : `（${redeem.cardTail}）`}`}
            </div>
          ) : null}
          {redeem !== null && redeem.kind === 'error' && redeem.retryable ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                disabled={redeemBusy}
                onClick={() => void submitRedeem()}
              >
                {t('oursRedeemRetry')}
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}
