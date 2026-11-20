import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { EMAIL_COOLDOWN_TICK_MS, emailCooldownRemaining } from '../../services/invite/emailCooldown.js'
import { Button } from '../base/Button.js'
import {
  EmailBindPanelView,
  initialEmailBindState,
  reduceEmailBind,
  runBindEmail,
  runLoadEmailBind,
  runSendCode,
  runUnbindEmail,
  type EmailBindEvent,
  type EmailBindSource,
} from './emailBindPanel.js'
import styles from './panels.module.css'

/**
 * 「邮箱绑定」面板的容器（W1-C2 #487）。
 *
 * 倒计时只用 `services/invite/emailCooldown.ts` 的两个纯函数：状态里存的是**截止时刻**
 * （`startEmailCooldown` 的产物），每秒 tick 只把它和 `Date.now()` 交给 `emailCooldownRemaining`
 * 求剩余秒数 —— 所以后台标签页被节流之后也不会「越走越慢」（纯函数没有累加状态）。
 */
export type EmailBindPanelProps = {
  consume: ConsumeClient
}

export const EmailBindPanel = ({ consume }: EmailBindPanelProps) => {
  const t = useTranslate()
  const source = useMemo<EmailBindSource>(
    () => ({ settings: consume.settings, auth: consume.auth, email: consume.email }),
    [consume]
  )
  const [state, dispatch] = useReducer(reduceEmailBind, undefined, initialEmailBindState)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(() => {
    void runLoadEmailBind(source).then((events) => {
      if (alive.current) {
        events.forEach(dispatch)
      }
    })
  }, [source])

  useEffect(() => {
    reload()
  }, [reload])

  // 倒计时期间每秒 tick 一次；没有倒计时就不留定时器
  useEffect(() => {
    if (state.cooldown === null) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), EMAIL_COOLDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [state.cooldown])

  const remaining = emailCooldownRemaining(state.cooldown, now)

  /** 动作统一走一遍「标记 busy → 跑 → 依次 dispatch → 清 busy」，避免连点重复提交 */
  const run = useCallback(
    (token: 'send' | 'bind' | 'unbind', work: () => Promise<EmailBindEvent[]>) => {
      if (state.busy !== null) {
        return
      }
      dispatch({ type: 'busy', token })
      void work().then((events) => {
        if (!alive.current) {
          return
        }
        events.forEach(dispatch)
        dispatch({ type: 'busy', token: null })
      })
    },
    [state.busy]
  )

  return EmailBindPanelView({
    t,
    c: styles,
    Button,
    state,
    remaining,
    onStartBind: () => {
      dispatch({ type: 'mode', mode: 'form' })
      dispatch({ type: 'draftEmail', email: state.info.phase === 'ready' ? state.info.data.email : '' })
    },
    onCancelForm: () => dispatch({ type: 'mode', mode: 'view' }),
    onDraftEmail: (email) => dispatch({ type: 'draftEmail', email }),
    onDraftCode: (code) => dispatch({ type: 'draftCode', code }),
    onSendCode: () => run('send', () => runSendCode(source, state.draftEmail)),
    onSubmit: () => run('bind', () => runBindEmail(source, state.draftEmail, state.draftCode)),
    onAskUnbind: () => dispatch({ type: 'confirmUnbind', value: true }),
    onCancelUnbind: () => dispatch({ type: 'confirmUnbind', value: false }),
    onUnbind: () => run('unbind', () => runUnbindEmail(source)),
    onRetry: reload,
  })
}
