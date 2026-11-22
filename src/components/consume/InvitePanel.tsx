import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  InvitePanelView,
  initialInviteState,
  initialInviteTransferState,
  inviteStateSignedOut,
  loadInvite,
  nextRecheckDelay,
  reduceInviteTransfer,
  runTransfer,
  type InviteSource,
  type InviteState,
  type InviteTransferSource,
} from './invitePanelModel.js'
import {
  INVITE_BIND_ENABLED,
  InviteBindView,
  initialInviteBindState,
  inviteBindMode,
  reduceInviteBind,
  runBindInviter,
  type InviteBindSource,
} from './inviteBindModel.js'
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
 * 也没有「领取 / 兑换」按钮：返利按比例结算进返利余额，客户端这边没有可提交的动作（契约 §3.1b）。
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
   * 「填写邀请人」入口（#842）。缺省读 `INVITE_BIND_ENABLED`（当前 true，见 `inviteBindModel.ts`）；
   * 挂载点不传它，开关只在常量处改。
   */
  bindEnabled?: boolean
  /** 划转成功后用响应里的新余额刷新外面显示的余额（#860）；不传 = 只刷新面板自己 */
  onBalance?: (balance: number) => void
}

const COPIED_MS = 2000

export const InvitePanel = ({
  consume,
  signedIn = true,
  onSignIn,
  bindEnabled = INVITE_BIND_ENABLED,
  onBalance,
}: InvitePanelProps) => {
  const t = useTranslate()
  const source = useMemo<InviteSource>(() => ({ aff: consume.aff }), [consume])
  /**
   * 初始态**不许**写死 `loading`（#830 的病灶就是把初值写成「假设能看见」）：可见性的真值来自
   * `GET /user/aff`（异步），所以第一帧必须什么都没有，等结论回来**一次**落定。
   */
  const [state, setState] = useState<InviteState>(() => initialInviteState())
  const [copied, setCopied] = useState(false)
  const bindSource = useMemo<InviteBindSource>(() => ({ aff: consume.aff }), [consume])
  const [bind, dispatchBind] = useReducer(reduceInviteBind, undefined, initialInviteBindState)
  const transferSource = useMemo<InviteTransferSource>(() => ({ aff: consume.aff }), [consume])
  const [transfer, dispatchTransfer] = useReducer(reduceInviteTransfer, undefined, initialInviteTransferState)
  const alive = useRef(true)
  const recheckAttempt = useRef(0)

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

  // #860：迁移约 5 秒后才到账。首读全是 0 才补读（最多两次，非零即止）；换号 / 退出时计数归零
  useEffect(() => {
    recheckAttempt.current = 0
  }, [signedIn])
  useEffect(() => {
    if (!signedIn) {
      return
    }
    const delay = nextRecheckDelay(state, recheckAttempt.current)
    if (delay === null) {
      return
    }
    const timer = setTimeout(() => {
      recheckAttempt.current += 1
      reload()
    }, delay)
    return () => clearTimeout(timer)
  }, [state, signedIn, reload])

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

  const onBindSubmit = useCallback(() => {
    if (bind.busy) {
      return
    }
    dispatchBind({ type: 'submit' })
    void runBindInviter(bindSource, bind.draft).then((outcome) => {
      if (!alive.current) {
        return
      }
      dispatchBind({ type: 'outcome', outcome })
      // 成功 / 409：用重新拉到的 `GET /user/aff` 刷新面板（拉失败就保持原样，只靠本地 `bound` 切只读）
      if (outcome.kind === 'bound' && outcome.reloaded !== null) {
        setState(outcome.reloaded)
      }
    })
  }, [bind.busy, bind.draft, bindSource])

  const onTransfer = useCallback(() => {
    if (transfer.busy) {
      return
    }
    dispatchTransfer({ type: 'submit' })
    void runTransfer(transferSource).then((outcome) => {
      if (!alive.current) {
        return
      }
      dispatchTransfer({ type: 'outcome', outcome })
      if (outcome.kind === 'done') {
        onBalance?.(outcome.balance)
        if (outcome.reloaded !== null) {
          setState(outcome.reloaded)
        }
      }
    })
  }, [transfer.busy, transferSource, onBalance])

  const bindMode = inviteBindMode({ enabled: bindEnabled, state, bound: bind.bound })
  const bindSlot = InviteBindView({
    t,
    c: styles,
    Button,
    mode: bindMode,
    state: bind,
    onDraft: (value) => dispatchBind({ type: 'draft', value }),
    onSubmit: onBindSubmit,
  })

  return InvitePanelView({
    t,
    c: styles,
    Button,
    state,
    copied,
    onCopy,
    onRetry: reload,
    onSignIn,
    bindSlot,
    transfer: { state: transfer, onTransfer },
  })
}
