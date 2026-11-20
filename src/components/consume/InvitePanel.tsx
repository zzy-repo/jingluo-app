import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { InvitePanelView, loadInvite, type InviteSource, type InviteState } from './invitePanelModel.js'
import styles from './panels.module.css'

/**
 * 「我的邀请」面板的容器（W1-C2 #487）。
 *
 * `invitationCodeEnabled === false` 时 `loadInvite` 直接回 `hidden`，这里**不渲染任何东西**
 * （不是置灰、不是「功能未开放」的占位）—— 部署方没开的功能不该在界面上占一行位置。
 *
 * 也没有「领取 / 兑换」按钮：返利按比例结算进返利余额，客户端这边没有可提交的动作（契约 §3.1b）。
 */
export type InvitePanelProps = {
  consume: ConsumeClient
}

const COPIED_MS = 2000

export const InvitePanel = ({ consume }: InvitePanelProps) => {
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

  useEffect(() => {
    reload()
  }, [reload])

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

  return InvitePanelView({ t, c: styles, Button, state, copied, onCopy, onRetry: reload })
}
