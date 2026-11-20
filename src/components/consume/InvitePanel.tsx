import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import { getAuthFlags } from '../../services/auth/flags.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  InvitePanelView,
  inviteStateSignedOut,
  loadInvite,
  type InviteSource,
  type InviteState,
} from './invitePanelModel.js'
import styles from './panels.module.css'

/**
 * 「我的邀请」面板的容器（W1-C2 #487，**#608 之后多了未登录态**）。
 *
 * 三种终态：
 *  - `hidden`：`invitation_code_enabled !== true`，**不渲染任何东西**（不是置灰、不是「功能未开放」的
 *    占位）—— 部署方没开的功能不该在界面上占一行位置；
 *  - `signedOut`（#608 新增）：没登录 → 「登录后可查看邀请」的引导 + 一个出口，**不发请求**
 *    （`aff.detail()` 要 JWT，打了只会 401，把「没登录」显示成「加载失败」）；
 *  - 其余：原来的加载 / 数据 / 失败三态，口径一字未改。
 *
 * 也没有「领取 / 兑换」按钮：返利按比例结算进返利余额，客户端这边没有可提交的动作（契约 §3.1b）。
 */
export type InvitePanelProps = {
  consume: ConsumeClient
  /** 当前是否已登录（#608）。不传按 `true` 处理：老的挂载点（已登录上下文）行为不变 */
  signedIn?: boolean
  /** 未登录态「去登录」的出口 */
  onSignIn?: () => void
}

const COPIED_MS = 2000

export const InvitePanel = ({ consume, signedIn = true, onSignIn }: InvitePanelProps) => {
  const t = useTranslate()
  const source = useMemo<InviteSource>(
    () => ({ settings: consume.settings, aff: consume.aff }),
    [consume]
  )
  const [state, setState] = useState<InviteState>({ phase: 'loading' })
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(() => {
    setState({ phase: 'loading' })
    void loadInvite(source).then((next) => {
      if (alive.current) {
        setState(next)
      }
    })
  }, [source])

  // 未登录：不发请求，直接落引导态（开关没开则整块隐藏，与已登录路径同一口径）
  useEffect(() => {
    if (!signedIn) {
      setState(inviteStateSignedOut(getAuthFlags()))
      return
    }
    reload()
  }, [reload, signedIn])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const onCopy = useCallback(() => {
    if (state.phase !== 'ready' || state.data.code === '') {
      return
    }
    void copyText(state.data.code).then((ok) => {
      if (ok && alive.current) {
        setCopied(true)
      }
    })
  }, [state])

  return InvitePanelView({ t, c: styles, Button, state, copied, onCopy, onRetry: reload, onSignIn })
}
