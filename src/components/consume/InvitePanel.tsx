import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  InvitePanelView,
  initialInviteState,
  inviteStateSignedOut,
  loadInvite,
  runBindInviter,
  type InviteBindForm,
  type InviteBindSource,
  type InviteSource,
  type InviteState,
} from './invitePanelModel.js'
import type { PanelError } from './panels.js'
import styles from './panels.module.css'

/**
 * 「我的邀请」面板的容器（W1-C2 #487，**#608 之后多了未登录态**，**#819-v2 改了可见性判据**）。
 *
 * 三种终态：
 *  - `hidden`：**还没拿到 `GET /user/aff` 的数据**（初始态，或服务端没给 `aff_code`）—— 不渲染任何 `invite-*`
 *    节点。**这不是「功能被关掉」**：面板可见性只看「已登录 + aff 拿到 `aff_code`」，与
 *    `settings/public.invitation_code_enabled`（那只管注册页那一行）解耦；
 *  - `signedOut`（#608 新增）：没登录 → 「登录后可查看邀请」的引导 + 一个出口，**不发请求**
 *    （`aff.detail()` 要 JWT，打了只会 401，把「没登录」显示成「加载失败」）；
 *  - 其余：原来的加载 / 数据 / 失败三态，口径一字未改。
 *
 * 没有「领取 / 兑换」按钮：返利按比例结算进返利余额。唯一能提交的动作是「绑定邀请人」（#839 / #842）：
 * 一次性，由调用方用 `canBind` 放开；绑定成功后**重新读 `GET /user/aff`**，以服务端的 `inviter_id` 为准。
 *
 * **#830（渲染顺序，必须保持）**：初始态恒为 `hidden`（`initialInviteState()`），第一帧 DOM 里没有任何
 * `invite-*` 节点；`loadInvite()` 的结论回来时**一次**落 `ready` / `failed`，不存在「先画骨架、随后被抹掉」
 * 的回落（那正是 #830 修掉的"闪现后消失"）。骨架（`loading`）仍留在视图里，但不作为初始态。
 */
export type InvitePanelProps = {
  consume: ConsumeClient
  /** 当前是否已登录（#608）。不传按 `true` 处理：老的挂载点（已登录上下文）行为不变 */
  signedIn?: boolean
  /** 未登录态「去登录」的出口 */
  onSignIn?: () => void
  /**
   * 是否显示「填写邀请码」入口（#839）。默认 `false`：**入口随后端 `settings/public.invitation_code_enabled` 放开**
   * （调用方读 `useAuthFlags`），本组件不自己读开关 —— 面板可见性与开关解耦（#819-v2）、`#830` 的钉法不变。
   */
  canBind?: boolean
}

const COPIED_MS = 2000

export const InvitePanel = ({ consume, signedIn = true, onSignIn, canBind = false }: InvitePanelProps) => {
  const t = useTranslate()
  const source = useMemo<InviteSource>(() => ({ aff: consume.aff }), [consume])
  const bindSource = useMemo<InviteBindSource>(() => ({ aff: consume.aff }), [consume])
  const [draft, setDraft] = useState('')
  const [binding, setBinding] = useState(false)
  const [bindError, setBindError] = useState<PanelError | null>(null)
  /**
   * 初始态**不许**写死 `loading`（#830 的病灶就是把初值写成「假设能看见」）：可见性的真值来自
   * `GET /user/aff`（异步），所以第一帧必须什么都没有，等结论回来**一次**落定。
   */
  const [state, setState] = useState<InviteState>(() => initialInviteState())
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(() => {
    // #830：**不**先把态清成 `loading`（那会引入"先有后无"的路径）；当前帧保持原样，
    // 等 `loadInvite()` 的结论回来一次替换成 `ready` / `failed`。
    void loadInvite(source).then((next) => {
      if (alive.current) {
        setState(next)
      }
    })
  }, [source])

  // 未登录：不发请求，直接落引导态（#819-v2：不再先看 invitation_code_enabled）
  useEffect(() => {
    if (!signedIn) {
      setState(inviteStateSignedOut())
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

  const onBind = useCallback(() => {
    if (binding) {
      return
    }
    setBinding(true)
    setBindError(null)
    void runBindInviter(bindSource, draft).then((result) => {
      if (!alive.current) {
        return
      }
      setBinding(false)
      if (result.ok) {
        setDraft('')
        // 以服务端为准：重新读 `GET /user/aff`，`inviter_id` 有值才切成「已绑定」
        reload()
      } else {
        setBindError(result.error)
      }
    })
  }, [binding, bindSource, draft, reload])

  // 只有「已登录 + 调用方放开」才给入口；是否已绑定、数据是否就绪由视图按 `state` 再判一次
  const bind: InviteBindForm | undefined =
    signedIn && canBind
      ? {
          draft,
          busy: binding,
          error: bindError,
          onDraft: (value) => {
            setDraft(value)
            if (bindError !== null) {
              setBindError(null)
            }
          },
          onSubmit: onBind,
        }
      : undefined

  return InvitePanelView({ t, c: styles, Button, state, bind, copied, onCopy, onRetry: reload, onSignIn })
}
