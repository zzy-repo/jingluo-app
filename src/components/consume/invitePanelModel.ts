/**
 * 「我的邀请」面板（W1-C2 #487 / 契约 §3.1b）。
 *
 * 语义必须如实表达（旧文案已删，别写回来）：
 *  · 邀请码**只能在注册时填一次**（sub2api 没有「登录后补填邀请码」的端点，见契约 §3.7）；
 *  · 返利是**按比例结算**的金额（元，CNY），进「返利余额」，不是「填码立刻得积分」；
 *  · `settings/public.invitationCodeEnabled === false` → 整块**隐藏**（不是置灰、不是报错）：
 *    部署方没开这个功能，界面上就不该出现一个永远点不动的入口（契约 §3.1d）。
 *
 * 也就是说这里没有任何「领奖 / 兑换 / 立即到账」的动作 —— 面板只做两件事：展示邀请码（可复制）、
 * 展示已邀请人数与返利余额。多一个按钮都意味着我们在承诺服务端没有的能力。
 */

import { createElement, type ReactNode } from 'react'

import type { ConsumeAffiliate, ConsumeCallResult, ConsumePublicSettings } from '../../services/consume/index.js'
import {
  copyRow,
  errorBlock,
  loadingBlock,
  panelReady,
  panelShell,
  statRow,
  toPanelError,
  formatCurrency,
  type PanelAsync,
  type PanelBlockProps,
} from './panels.js'

/** 面板要用到的客户端子集（`settings.public` 是「入口显不显示」的唯一来源） */
export type InviteSource = {
  settings: { get: () => Promise<ConsumeCallResult<ConsumePublicSettings>> }
  aff: { detail: () => Promise<ConsumeCallResult<ConsumeAffiliate>> }
}

/** 界面上要的四个数（其余字段不给 view 看见，避免在渲染里推导返利规则） */
export type InviteDetail = {
  code: string
  count: number
  /** 已结算返利（元 / CNY） */
  rebateBalance: number
  /** 冻结中的返利（元 / CNY） */
  frozenBalance: number
  /** 生效返利比例（百分数）；服务端没给就不编一个 */
  ratePercent?: number
}

/**
 * `hidden` = 功能未开（整块不渲染），`signedOut` = 没登录（引导态，不发请求），
 * 与「加载失败」是三件不同的事（#608：没登录不是错误）。
 */
export type InviteState = { phase: 'hidden' } | { phase: 'signedOut' } | PanelAsync<InviteDetail>

/**
 * 未登录时的状态（#608）。
 *
 * 判据只用 `settings/public` 的开关（公开接口，启动时就读到了，不需要账号）：
 * 部署方没开邀请 → 整块隐藏（与已登录路径同一口径，不因为「没登录」就露一个死入口）；
 * 开了 → 引导态「登录后可查看邀请」。**不发任何请求**（`aff.detail()` 需要 JWT，打了只会 401）。
 */
export const inviteStateSignedOut = (flags: { invitationCodeEnabled: boolean }): InviteState =>
  flags.invitationCodeEnabled ? { phase: 'signedOut' } : { phase: 'hidden' }

export const toInviteDetail = (affiliate: ConsumeAffiliate): InviteDetail => {
  const detail: InviteDetail = {
    code: affiliate.affCode,
    count: affiliate.affCount,
    rebateBalance: affiliate.affQuota,
    frozenBalance: affiliate.affFrozenQuota,
  }
  if (affiliate.effectiveRebateRatePercent !== undefined) {
    detail.ratePercent = affiliate.effectiveRebateRatePercent
  }
  return detail
}

/**
 * 先读开关、再读返利（两个都只读，并行）。
 *
 * 开关读不出来 → 失败态 + 重试（**不猜**）：猜「开着」会在关闭的部署上露出死入口，
 * 猜「关着」会让正常部署的用户以为自己的邀请码没了。
 */
export const loadInvite = async (source: InviteSource): Promise<InviteState> => {
  const [settings, affiliate] = await Promise.all([source.settings.get(), source.aff.detail()])
  if (!settings.ok) {
    return { phase: 'failed', error: toPanelError(settings.error) }
  }
  if (!settings.data.invitationCodeEnabled) {
    return { phase: 'hidden' }
  }
  if (!affiliate.ok) {
    return { phase: 'failed', error: toPanelError(affiliate.error) }
  }
  return panelReady(toInviteDetail(affiliate.data))
}

export type InvitePanelViewProps = PanelBlockProps & {
  state: InviteState
  copied: boolean
  onCopy: () => void
  onRetry: () => void
  /** 未登录态的「去登录」出口（由外壳切到账号 tab / 打开局部登录卡） */
  onSignIn?: () => void
}

/** 邀请面板（纯渲染）。`hidden` 时返回 `null` —— 由容器直接不挂载 */
export const InvitePanelView = (props: InvitePanelViewProps): ReactNode => {
  const { t, c, state, copied, Button } = props
  if (state.phase === 'hidden') {
    return null
  }
  const body: ReactNode[] = []
  if (state.phase === 'signedOut') {
    // 没登录 = 引导，不是错误：说清「登录后能看到什么」，并给一个出口（#608）
    body.push(
      createElement(
        'div',
        { className: c.guide, 'data-testid': 'invite-signed-out' },
        createElement('p', { className: c.guideTitle }, t('inviteNeedLoginTitle')),
        createElement('p', { className: c.hint }, t('inviteNeedLoginBody'))
      )
    )
    body.push(
      createElement(
        'div',
        { className: c.actions },
        createElement(
          Button,
          { size: 's', variant: 'outlined', testId: 'invite-sign-in', onClick: () => props.onSignIn?.() },
          t('accountSignInCta')
        )
      )
    )
  } else if (state.phase === 'loading') {
    body.push(loadingBlock(props))
  } else if (state.phase === 'failed') {
    body.push(errorBlock(props, state.error, props.onRetry, 'invite-error'))
  } else {
    body.push(
      copyRow(props, {
        value: state.data.code === '' ? '—' : state.data.code,
        copied,
        onCopy: props.onCopy,
        testId: 'invite-code',
        label: t('inviteCode'),
        copyLabel: 'inviteCopyCode',
      })
    )
    body.push(
      createElement(
        'div',
        { className: c.stats, 'data-testid': 'invite-stats' },
        statRow(c, t('inviteCount'), `${state.data.count}`, 'invite-count'),
        statRow(c, t('inviteRebateBalance'), formatCurrency(state.data.rebateBalance), 'invite-rebate')
      )
    )
    if (state.data.frozenBalance > 0) {
      body.push(
        createElement(
          'p',
          { className: c.hint, 'data-testid': 'invite-frozen' },
          t('inviteRebateFrozen', { amount: formatCurrency(state.data.frozenBalance) })
        )
      )
    }
    // 语义说明：邀请码只在注册时填；返利按比例结算（没有「立刻得积分」这回事）
    body.push(
      createElement(
        'p',
        { className: c.hint, 'data-testid': 'invite-semantics' },
        t('inviteCodeAtRegister')
      )
    )
    if (state.data.ratePercent !== undefined) {
      body.push(
        createElement(
          'p',
          { className: c.hint, 'data-testid': 'invite-rate' },
          t('inviteRebateRate', { percent: state.data.ratePercent })
        )
      )
    }
  }
  return panelShell(c, t('inviteTitle'), body, 'invite-panel')
}
