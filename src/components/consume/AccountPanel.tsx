import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import type { ConsumeUser } from '../../services/consume/auth.js'
import { copyText } from '../../utils/clipboard.js'
import { AuthGate } from '../auth/AuthGate.js'
import { Button } from '../base/Button.js'
import {
  AccountPanelView,
  AccountSignedOutView,
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
import { InvitePanel } from './InvitePanel.js'
import styles from './panels.module.css'

/**
 * 「账号」面板的容器（W1-C2 #487，**#608 之后分成登录 / 未登录两条路**）。
 *
 * 已登录：状态机全在 `reduceAccount`（纯 reducer，单测直接跑），这里只做三件事：
 *  1. 把真客户端注射成 {@link AccountSource}；
 *  2. 每个动作按「先标 busy → 等结果 → 依次 dispatch」走一遍，避免连点；
 *  3. 退出登录成功后调 `onNeedLogin()`（token 由外壳清，面板不碰存储）。
 *
 * 未登录（#608 的主路径）：**一个请求都不发**，只渲染 `AccountSignedOutView` —— 顶部一句
 * 「不登录也可以：在设置里填 API Key 即可使用各渠道」，主 CTA「去填 API Key」，下面是可选的
 * 局部登录 / 注册卡（`<AuthGate variant="inline" />`，表单与 `sub2auth*` 文案都是既有那一份）。
 * 为什么不在未登录时照旧拉 `profile()` / `keys.list()`：那两条只会回 401，把「从没登录过」
 * 显示成「登录已失效」是 #608 要消掉的误导。
 *
 * 登录成功后 `useAuthStore` 的登录态翻成 `authenticated` → 这里自动切到已登录视图并拉一次数据，
 * 不需要外壳做任何跳转（登录不再是「换掉整个界面」的事）。
 *
 * 复制：`copyText` 失败**不假装成功**（老 WebView 上剪贴板可能没有），失败就不显示「已复制」。
 */
export type AccountPanelProps = {
  consume: ConsumeClient
  /** 外壳已经知道当前用户就先渲染资料，再用 `profile()` 的结果覆盖 */
  user: ConsumeUser | null
  onNeedLogin: () => void
  /** 未登录态的主 CTA：去「设置 → 数据管理 → API Key」。不传时只渲染文案（测试 / 孤立挂载） */
  onFillKey?: () => void
  /**
   * 登录 / 注册卡的容器类名（#727）：这一页按原型把它做成**居中 dialog**，外壳注入 dialog 的类名。
   * 不传时保持原样（普通卡片），老挂载点一字不变。
   */
  authDialog?: string
}

/** 「已复制」提示的存活时间 */
const COPIED_MS = 2000

export const AccountPanel = ({ consume, user, onNeedLogin, onFillKey, authDialog }: AccountPanelProps) => {
  const t = useTranslate()
  /**
   * 登录态是**这一块自己的开关**（#608）：未登录不再由登录墙拦在门外，而是落在这里的引导态。
   * 判据只有 `useAuthStatus().authenticated` 一条（与 `AuthGate` 的放行分支同一口径）——
   * 订阅 store 而不是吃外壳传来的 `user`：登录 / 退出就发生在下面那张卡里，翻态后要立刻重渲染。
   */
  const signedIn = useAuthStatus().authenticated
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

  // 未登录不发请求（`profile()` / `keys.list()` 只会回 401）；登录态一翻过来就拉一次
  useEffect(() => {
    if (signedIn) {
      reload()
    }
  }, [reload, signedIn])

  // 会话失效（资料或列表读到 401）→ 交给外壳切登录
  const needLogin =
    (state.profile.phase === 'failed' && state.profile.error.needLogin) ||
    (state.keys.phase === 'failed' && state.keys.error.needLogin) ||
    (state.actionError !== null && state.actionError.needLogin)
  useEffect(() => {
    if (signedIn && needLogin) {
      onNeedLogin()
    }
  }, [signedIn, needLogin, onNeedLogin])

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

  // 未登录：引导态（不登录也能用）+ 可选的登录 / 注册卡。表单本体不在这里，见 AuthGate
  if (!signedIn) {
    return AccountSignedOutView({
      t,
      c: styles,
      Button,
      // #727：登录 / 注册用分段控件切换（原型 `.segmented`），表单本体仍是既有的 LoginPage / RegisterPage
      auth: <AuthGate variant="inline" segmented />,
      authDialog,
      onFillKey: () => onFillKey?.(),
    })
  }

  return (
    <>
      {AccountPanelView({
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
      })}
      {/*
        邀请（#608）：「账号」tab 里的第二块 —— 登录后还能得到什么（邀请码 / 返利余额）。
        未登录时面板自己给引导（`inviteSignedOut*`），不发请求、不报错。
      */}
      <InvitePanel consume={consume} signedIn={signedIn} onSignIn={onNeedLogin} />
    </>
  )
}
