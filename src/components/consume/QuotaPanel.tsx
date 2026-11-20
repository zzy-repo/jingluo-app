import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import type { ConsumeGatewayUsage } from '../../services/consume/usage.js'
import { Button } from '../base/Button.js'
import { panelLoading, type PanelAsync, type PanelError } from './panels.js'
import {
  QuotaPanelView,
  appendUsagePage,
  initialQuotaState,
  loadQuota,
  loadUsagePage,
  type QuotaSource,
  type QuotaState,
  type QuotaUsagePage,
} from './quotaPanelModel.js'
import styles from './panels.module.css'

/**
 * 「我的额度」面板的容器（W1-C2 #487）。
 *
 * 只做四件事：把真客户端的三个入口注射给纯视图、按需拉数据、把「会话失效」翻译成
 * `onNeedLogin()`、把「加载更多」的追加 / 去重交给 `appendUsagePage`。
 * 余额 / 已用 / 剩余的口径全在 `quotaSummaryOf`（`spent = actual_cost`，不是 `quota.used`）。
 *
 * 这里**不缓存余额**：每次进来都重新问服务端，本地不留第二份「还能不能发消息」的账本（A4）。
 */
export type QuotaPanelProps = {
  consume: ConsumeClient
  /** 401 / 会话失效时调一次：由「账户与消费」页切到登录，面板不自己跳转 */
  onNeedLogin: () => void
}

export const QuotaPanel = ({ consume, onNeedLogin }: QuotaPanelProps) => {
  const t = useTranslate()
  const source = useMemo<QuotaSource>(
    () => ({ hasApiKey: () => consume.http.hasApiKey(), usage: consume.usage }),
    [consume]
  )
  const [quota, setQuota] = useState<QuotaState>(() => initialQuotaState(source))
  const [expanded, setExpanded] = useState(false)
  const [usage, setUsage] = useState<PanelAsync<QuotaUsagePage> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<PanelError | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(() => {
    setQuota(panelLoading<ConsumeGatewayUsage>())
    void loadQuota(source).then((next) => {
      if (alive.current) {
        setQuota(next)
      }
    })
  }, [source])

  useEffect(() => {
    reload()
  }, [reload])

  // 会话失效：交给外壳切登录态（面板不自己清 token）
  useEffect(() => {
    if (quota.phase === 'failed' && quota.error.needLogin) {
      onNeedLogin()
    }
  }, [quota, onNeedLogin])

  const loadUsage = useCallback(
    (page: number) => {
      setLoadMoreError(null)
      setUsage(panelLoading<QuotaUsagePage>())
      void loadUsagePage(source, page).then((next) => {
        if (alive.current) {
          setUsage(next)
        }
      })
    },
    [source]
  )

  const onToggle = useCallback(() => {
    const next = !expanded
    setExpanded(next)
    // 懒加载：第一次展开才打列表接口（首屏不为一张折叠的列表多发一次请求）
    if (next && usage === null) {
      loadUsage(1)
    }
  }, [expanded, loadUsage, usage])

  const onLoadMore = useCallback(() => {
    if (usage === null || usage.phase !== 'ready') {
      return
    }
    setLoadingMore(true)
    void loadUsagePage(source, usage.data.page + 1).then((next) => {
      if (!alive.current) {
        return
      }
      setLoadingMore(false)
      if (next.phase === 'ready') {
        setUsage((prev) => appendUsagePage(prev ?? panelLoading<QuotaUsagePage>(), next.data))
        return
      }
      // 追加失败：已经渲染出来的记录一条不少，只在底部给错误 + 重试
      if (next.phase === 'failed') {
        setLoadMoreError(next.error)
      }
    })
  }, [source, usage])

  return QuotaPanelView({
    t,
    c: styles,
    Button,
    quota,
    expanded,
    usage,
    loadingMore,
    loadMoreError,
    onToggle,
    onLoadMore,
    onRetryQuota: reload,
    onRetryUsage: () => loadUsage(1),
  })
}
