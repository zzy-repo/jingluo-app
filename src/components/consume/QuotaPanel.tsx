import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import type { ConsumeGatewayUsage } from '../../services/consume/usage.js'
import { Button } from '../base/Button.js'
import { panelLoading, type PanelAsync, type PanelError } from './panels.js'
import {
  QuotaPanelView,
  appendUsagePage,
  loadQuota,
  quotaStateFor,
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
 *
 * #608 之后多一个「没登录」的档：余额与用量跟着账号走，未登录时这里只给引导（`quotaSignedOut*`）
 * + 一个「去登录」出口，**一个请求都不发** —— 拿 JWT 打 `/v1/usage` 只会 401，把「没登录」
 * 显示成「会话失效」正是拆登录墙要消掉的那种错。
 */
export type QuotaPanelProps = {
  consume: ConsumeClient
  /** 401 / 会话失效时调一次：由「账户与消费」页切到登录，面板不自己跳转 */
  onNeedLogin: () => void
  /**
   * 登录态（#608）：`true` 已登录 / `false` 未登录 / `null` 还在恢复登录态（给 loading，
   * 别先喊「未登录」）。**不传按已登录处理**，老的挂载点行为一字不变。
   */
  signedIn?: boolean | null
  /** 未登录态「去登录」的出口（外壳切到账号 tab） */
  onSignIn?: () => void
}

export const QuotaPanel = ({ consume, onNeedLogin, signedIn, onSignIn }: QuotaPanelProps) => {
  const t = useTranslate()
  /** `undefined` = 老挂载点没传登录态 → 按已登录处理（与 #608 之前完全一致） */
  const signedInNow: boolean | null = signedIn === undefined ? true : signedIn
  const source = useMemo<QuotaSource>(
    () => ({ hasApiKey: () => consume.http.hasApiKey(), usage: consume.usage }),
    [consume]
  )
  const [quota, setQuota] = useState<QuotaState>(() => quotaStateFor(source, signedInNow))
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

  // 登录态决定「查什么」：没登录 → 引导态（不发请求）；恢复中 → loading；已登录 → 原来那条
  useEffect(() => {
    if (signedInNow === null) {
      setQuota(panelLoading<ConsumeGatewayUsage>())
      return
    }
    if (!signedInNow) {
      setQuota({ phase: 'anonymous' })
      return
    }
    reload()
  }, [reload, signedInNow])

  // 会话失效：交给外壳切登录态（面板不自己清 token）
  useEffect(() => {
    if (signedInNow !== false && quota.phase === 'failed' && quota.error.needLogin) {
      onNeedLogin()
    }
  }, [signedInNow, quota, onNeedLogin])

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
    onSignIn: () => onSignIn?.(),
  })
}
