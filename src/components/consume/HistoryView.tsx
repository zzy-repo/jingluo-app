/**
 * 「历史消费」列表（#727）—— 数据来自既有的 `/api/v1/usage` 一族（`consume.usage.list`）。
 *
 * 为什么单独一个文件而不是在页面里现写一段：这一页现在有三处要读用量（我的额度 / 历史消费 / 余额卡），
 * 读数与解析**只能有一份**。解析、分页、去重全部复用 `quotaPanelModel.ts` 里已经落过单测的纯函数
 * （`loadUsagePage` / `appendUsagePage` / `hasMoreUsage`），本文件只做「按日期分组 + 记录行的排版」，
 * 一行解析逻辑都没有。金额也走 `panels.ts` 的 `formatCurrency`（唯一的口径，1 元 = 1 额度）。
 *
 * 三态沿用面板纪律（#484）：加载中 / 有数据（空列表也算有数据）/ 失败可重试；
 * 未登录或没 Key 时**一个请求都不发**，直接给空态文案 —— 拿 JWT 硬打 `/v1/usage` 只会 401。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { Button } from '../base/Button.js'
import { formatCurrency, panelLoading, type PanelAsync, type PanelError } from './panels.js'
import {
  appendUsagePage,
  hasMoreUsage,
  loadUsagePage,
  type QuotaSource,
  type QuotaUsagePage,
  type QuotaUsageRow,
} from './quotaPanelModel.js'
import styles from './AccountConsume.module.css'

export type HistoryViewProps = {
  consume: ConsumeClient
  signedIn: boolean
}

/** 一条记录按「哪一天」分组：服务端时间戳认不出时落到 `—` 组，而不是丢掉这一行 */
const dayOf = (at: string): string => (at.length >= 10 ? at.slice(0, 10) : '—')

/** 时间那一截（`2026-11-20 16:05` → `16:05`）；认不出就给原文 */
const timeOf = (at: string): string => (at.length >= 16 ? at.slice(11, 16) : at)

type Group = { day: string; rows: QuotaUsageRow[] }

/** 保序分组：服务端已按时间倒序，这里只切段，不重新排序（重排会把「今天」打散） */
const groupByDay = (rows: QuotaUsageRow[]): Group[] => {
  const groups: Group[] = []
  rows.forEach((row) => {
    const day = dayOf(row.at)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.day === day) {
      last.rows.push(row)
      return
    }
    groups.push({ day, rows: [row] })
  })
  return groups
}

export const HistoryView = ({ consume, signedIn }: HistoryViewProps) => {
  const t = useTranslate()
  const source = useMemo<QuotaSource>(
    () => ({ hasApiKey: () => consume.http.hasApiKey(), usage: consume.usage }),
    [consume]
  )
  const [state, setState] = useState<PanelAsync<QuotaUsagePage> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<PanelError | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    (page: number) => {
      if (!signedIn || !source.hasApiKey()) {
        // 没登录 / 没 Key：不发请求，空列表就是这一格的结论
        setState({ phase: 'ready', data: { items: [], page: 1, pages: 0, total: 0 } })
        return
      }
      setState(panelLoading<QuotaUsagePage>())
      void loadUsagePage(source, page).then((next) => {
        if (alive.current) {
          setState(next)
        }
      })
    },
    [signedIn, source]
  )

  useEffect(() => {
    load(1)
  }, [load])

  const onLoadMore = useCallback(() => {
    if (state === null || state.phase !== 'ready') {
      return
    }
    setLoadingMore(true)
    setLoadMoreError(null)
    void loadUsagePage(source, state.data.page + 1).then((next) => {
      if (!alive.current) {
        return
      }
      setLoadingMore(false)
      if (next.phase === 'ready') {
        setState((prev) => appendUsagePage(prev ?? panelLoading<QuotaUsagePage>(), next.data))
        return
      }
      if (next.phase === 'failed') {
        setLoadMoreError(next.error)
      }
    })
  }, [source, state])

  if (state === null || state.phase === 'loading') {
    return (
      <p className={styles.recTime} data-testid="account-consume-history-loading">
        {t('consumeLoadingMore')}
      </p>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div data-testid="account-consume-history-error">
        <p className={styles.errorText}>{t(state.error.i18nKey, state.error.params)}</p>
        {state.error.retryable ? (
          <div className={styles.sheetActions}>
            <Button variant="outlined" size="m" onClick={() => load(1)}>
              {t('retry')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state.data.items.length === 0) {
    return (
      <div className={styles.empty} data-testid="account-consume-history-empty">
        <p className={styles.emptyMain}>{t('accountConsumeHistoryEmpty')}</p>
        <p className={styles.emptySub}>{t('accountConsumeHistoryEmptyHint')}</p>
      </div>
    )
  }

  const groups = groupByDay(state.data.items)

  return (
    <div data-testid="account-consume-history">
      {groups.map((group, index) => (
        <div key={`${group.day}-${index}`}>
          {index > 0 ? <div className={styles.dividerFull} /> : null}
          <div className={styles.ghead}>{group.day}</div>
          {group.rows.map((row, rowIndex) => (
            <div key={row.id}>
              {rowIndex > 0 ? <div className={styles.divider} /> : null}
              <div className={styles.rec} data-testid="account-consume-history-row">
                <div className={styles.recMain}>
                  <div className={styles.recName}>{row.model === '' ? t('accountConsumeHistory') : row.model}</div>
                  <div className={styles.recTime}>{timeOf(row.at)}</div>
                </div>
                {/* 扣费前面带「−」：原型里是 `−¥0.12`，符号与小数位仍由 formatCurrency 一处决定 */}
                <div className={styles.recAmount}>{`−${formatCurrency(row.cost)}`}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
      {loadMoreError === null ? null : (
        <p className={styles.errorText}>{t(loadMoreError.i18nKey, loadMoreError.params)}</p>
      )}
      {hasMoreUsage(state) ? (
        <div className={styles.sheetActions}>
          <Button variant="outlined" size="m" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? t('consumeLoadingMore') : t('accountConsumeHistoryMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
