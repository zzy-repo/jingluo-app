/**
 * 付款记录弹层（Issue #115）：`GET /api/orders` 的可视化。
 *
 * 为什么单独一页：这次事故里用户明明付过款，界面上却只有「等待支付」一个入口，
 * 既看不到历史订单，也看不到「这笔钱到底记在哪个账号名下」。所以这里给一份**只读**的历史：
 * 金额、状态、时间、卡密后 4 位，外加累计已支付。
 *
 * 只读＝不发任何写请求：刷新重试安全（`/api/orders` 是纯查询），不会新建订单。
 * 完整卡密只在用户点「查看卡密」后展开，列表里永远只有后 4 位（maskCard）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchPaymentRecords,
  type PaymentRecord,
  type PaymentRecordsData,
  type PaymentRecordStatus,
} from '../../services/ours/paymentRecords.js'
import type { OursMessageKey } from '../../services/ours/api.js'
import { httpTransport } from '../../services/ours/transport.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './PaymentRecords.module.css'

type View =
  | { status: 'loading' }
  | { status: 'ok'; data: PaymentRecordsData }
  | { status: 'error'; messageKey: OursMessageKey }

const STATUS_KEY: Record<PaymentRecordStatus, 'oursPayRecordsStatusPending' | 'oursPayRecordsStatusCompleted' | 'oursPayRecordsStatusExpired'> = {
  pending: 'oursPayRecordsStatusPending',
  completed: 'oursPayRecordsStatusCompleted',
  expired: 'oursPayRecordsStatusExpired',
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 秒 → 本地时间 `YYYY-MM-DD HH:mm`（服务端给的是秒，未付就没有支付时间） */
export const formatRecordTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '—'
  }
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const money = (yuan: number): string => `¥${yuan.toFixed(2)}`

export const PaymentRecordsDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  const [view, setView] = useState<View>({ status: 'loading' })
  /** 展开中的卡密（按单号）；同一时刻只展开一条，完整卡密不重复铺在页面上 */
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setView({ status: 'loading' })
    const result = await fetchPaymentRecords(apiKey, httpTransport)
    setView(result.kind === 'ok' ? { status: 'ok', data: result.data } : { status: 'error', messageKey: result.messageKey })
  }, [apiKey])

  useEffect(() => {
    void load()
  }, [load])

  const copyCard = async (record: PaymentRecord) => {
    const ok = await copyText(record.cardNo)
    showToast(ok ? t('oursPayRecordsCopied') : t('oursPayRecordsCopyCard'))
  }

  return (
    <Modal
      title={t('oursPayRecordsTitle')}
      closable
      zIndex={1200}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
      footer={
        <div className={styles.actions}>
          <Button variant="outlined" disabled={view.status === 'loading'} onClick={() => void load()}>
            {t('oursPayRecordsRefresh')}
          </Button>
        </div>
      }
    >
      {view.status === 'loading' ? <div className={styles.hint}>{t('oursPayRecordsLoading')}</div> : null}

      {view.status === 'error' ? (
        <div className={styles.error} role="alert">
          {t(view.messageKey)}
        </div>
      ) : null}

      {view.status === 'ok' ? (
        <>
          <div className={styles.summary}>
            <span className={styles.summaryLabel}>{t('oursPayRecordsTotalPaid')}</span>
            <span className={styles.summaryValue}>{money(view.data.totalPaidYuan)}</span>
          </div>
          {view.data.orders.length === 0 ? (
            <div className={styles.hint}>{t('oursPayRecordsEmpty')}</div>
          ) : (
            <ul className={styles.list}>
              {view.data.orders.map((record) => {
                const opened = expanded === record.outTradeNo
                return (
                  <li key={record.outTradeNo} className={styles.item} data-status={record.status}>
                    <div className={styles.itemHead}>
                      <span className={styles.amount}>{money(record.amountYuan)}</span>
                      <span className={styles.status} data-status={record.status}>
                        {t(STATUS_KEY[record.status])}
                      </span>
                    </div>
                    <div className={styles.meta}>
                      <span>{formatRecordTime(record.paidAt ?? record.createdAt)}</span>
                      {record.cardTail === '' ? null : (
                        <span className={styles.card}>
                          {t('oursPayRecordsCardTail')} {record.cardTail}
                        </span>
                      )}
                      {record.status === 'completed' ? (
                        <span className={styles.redeemed}>
                          {record.redeemed ? t('oursPayRecordsRedeemed') : t('oursPayRecordsNotRedeemed')}
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.itemFoot}>
                      <span className={styles.outTradeNo}>{record.outTradeNo}</span>
                      {record.cardNo === '' ? null : (
                        <>
                          <Button
                            variant="outlined"
                            size="s"
                            onClick={() => setExpanded(opened ? null : record.outTradeNo)}
                          >
                            {opened ? t('oursPayRecordsHideCard') : t('oursPayRecordsViewCard')}
                          </Button>
                          {opened ? (
                            <Button variant="outlined" size="s" onClick={() => void copyCard(record)}>
                              {t('oursPayRecordsCopyCard')}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                    {opened ? <div className={styles.cardNo}>{record.cardNo}</div> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : null}

      {apiKey.trim() === '' ? <div className={styles.hint}>{t('oursPayRecordsNeedKey')}</div> : null}
    </Modal>
  )
}
