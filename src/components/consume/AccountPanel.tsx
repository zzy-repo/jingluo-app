import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import type { ConsumeUser } from '../../services/consume/auth.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  AccountPanelView,
  initialAccountState,
  loggedOut,
  reduceAccount,
  runCreateKey,
  runDeleteKey,
  runLoadAccount,
  runLogout,
  runToggleKey,
  type AccountEvent,
  type AccountSource,
} from './accountPanelModel.js'
import styles from './panels.module.css'

/**
 * 「账号」面板的容器（W1-C2 #487）。
 *
 * 状态机全在 `reduceAccount`（纯 reducer，单测直接跑），这里只做三件事：
 *  1. 把真客户端注射成 {@link AccountSource}；
 *  2. 每个动作按「先标 busy → 等结果 → 依次 dispatch」走一遍，避免连点；
 *  3. 退出登录成功后调 `onNeedLogin()`（token 由外壳清，面板不碰存储）。
 *
 * 复制：`copyText` 失败**不假装成功**（老 WebView 上剪贴板可能没有），失败就不显示「已复制」。
 */
export type AccountPanelProps = {
  consume: ConsumeClient
  /** 外壳已经知道当前用户就先渲染资料，再用 `profile()` 的结果覆盖 */
  user: ConsumeUser | null
  onNeedLogin: () => void
}

/** 「已复制」提示的存活时间 */
const COPIED_MS = 2000

export const AccountPanel = ({ consume, user, onNeedLogin }: AccountPanelProps) => {
  const t = useTranslate()
  const source = useMemo<AccountSource>(
    () => ({
      auth: { profile: consume.auth.profile, revokeAllSessions: consume.auth.revokeAllSessions },
      keys: { list: consume.keys.list, create: consume.keys.create, update: consume.keys.update, remove: consume.keys.remove },
    }),
    [consume]
  )
  const [state, dispatch] = useReducer(reduceAccount, user, initialAccountState)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(() => {
    void runLoadAccount(source).then((events) => {
      if (alive.current) {
        events.forEach(dispatch)
      }
    })
  }, [source])

  useEffect(() => {
    reload()
  }, [reload])

  // 会话失效（资料或列表读到 401）→ 交给外壳切登录
  const needLogin =
    (state.profile.phase === 'failed' && state.profile.error.needLogin) ||
    (state.keys.phase === 'failed' && state.keys.error.needLogin) ||
    (state.actionError !== null && state.actionError.needLogin)
  useEffect(() => {
    if (needLogin) {
      onNeedLogin()
    }
  }, [needLogin, onNeedLogin])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const run = useCallback(
    (token: string, work: () => Promise<AccountEvent[]>) => {
      dispatch({ type: 'busy', token })
      void work().then((events) => {
        if (!alive.current) {
          return
        }
        events.forEach(dispatch)
        dispatch({ type: 'busy', token: null })
        if (loggedOut(events)) {
          onNeedLogin()
        }
      })
    },
    [onNeedLogin]
  )

  const copy = useCallback((value: string) => {
    if (value === '') {
      return
    }
    void copyText(value).then((ok) => {
      if (ok && alive.current) {
        setCopied(true)
      }
    })
  }, [])

  return AccountPanelView({
    t,
    c: styles,
    Button,
    state,
    copied,
    onCopyKey: copy,
    onDraft: (name) => dispatch({ type: 'draft', name }),
    onCreate: () => run('create', () => runCreateKey(source, state.draftName)),
    onToggleKey: (key) => run(`key:${key.id}`, () => runToggleKey(source, key)),
    onAskDelete: (id) => dispatch({ type: 'confirmDelete', id }),
    onCancelDelete: () => dispatch({ type: 'confirmDelete', id: null }),
    onConfirmDelete: (id) => run(`key:${id}`, () => runDeleteKey(source, id)),
    onDismissCreated: () => dispatch({ type: 'createdDismiss' }),
    onAskLogout: () => dispatch({ type: 'confirmLogout', value: true }),
    onCancelLogout: () => dispatch({ type: 'confirmLogout', value: false }),
    onLogout: () => run('logout', () => runLogout(source)),
    onRetry: reload,
  })
}
