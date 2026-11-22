/**
 * 「我的邀请」面板（W1-C2 #487 / 契约 §3.1b；**可见性口径见 #819-v2**）。
 *
 * 语义必须如实表达（旧文案已删，别写回来）：
 *  · 邀请人在本面板里**一次性绑定**（#839：注册表单不再填邀请码）。上游 sub2api 原生没有登录后绑定的端点，
 *    `POST /user/aff/bind` 是 #842 向后端提的新接口；**接口没上线前入口不出现**（见下面 `bind` 的闸门）；
 *  · 返利是**按比例结算**的金额（元，CNY），进「返利余额」，不是「填码立刻得积分」；
 *    面板**不再写返利比例说明**（#841：比例由服务端说了算，客户端不重复一份文案）；
 *  · **面板可见性 = 已登录 + `GET /user/aff` 成功且真的给了一个 `aff_code`**（下面 §可见性）。
 *
 * ## 可见性（#819-v2 —— 上一版把两件事绑在一起了）
 *
 * 曾经这里用 `settings/public.invitation_code_enabled` 当整块的开关，于是 staging 上
 * `invitation_code_enabled=false` / `affiliate_enabled=false` 而 `GET /user/aff` 明明 200 且有真数据
 * （`aff_code` / `aff_count` / `effective_rebate_rate_percent`）时，面板被判 `hidden` → **整块不出现**。
 * 两个开关的语义本来就不同，别再把它们当同一件事：
 *  · `invitation_code_enabled` = **「我的邀请」里要不要出现「填写邀请码」入口**（#839 之后；原来管注册页那一行，
 *    注册表单已不再有邀请码）。它只管那个入口，**不参与面板可见性**，由容器的调用方作为 `canBind` 递进来；
 *  · `affiliate_enabled` = 返利体系开关（本面板不读它）；
 *  · 本面板要展示的东西（我的邀请码 / 已邀请人数 / 返利余额）**由 `GET /user/aff` 直接给**。
 * 所以这里**不读 `settings/public`**：能拿到 `aff` 数据就展示，拿不到才是失败态。
 *
 * 也就是说这里没有任何「领奖 / 兑换 / 立即到账」的动作 —— 面板只做两件事：展示邀请码（可复制）、
 * 展示已邀请人数与返利余额。多一个按钮都意味着我们在承诺服务端没有的能力。
 */

import { createElement, type ChangeEvent, type ReactNode } from 'react'

import type { ConsumeAffiliate, ConsumeCallResult } from '../../services/consume/index.js'
import {
  copyRow,
  errorBlock,
  loadingBlock,
  panelReady,
  panelShell,
  statRow,
  toPanelError,
  formatCurrency,
  localPanelError,
  type PanelAsync,
  type PanelError,
  type PanelBlockProps,
} from './panels.js'

/** 面板要用到的客户端子集：**只有** `aff.detail()`（可见性不再读 `settings/public`，见文件头） */
export type InviteSource = {
  aff: { detail: () => Promise<ConsumeCallResult<ConsumeAffiliate>> }
}

/** 绑定邀请人用到的客户端子集（#842）：只有 `aff.bind()` */
export type InviteBindSource = {
  aff: { bind: (code: string) => Promise<ConsumeCallResult<{ inviterId?: number }>> }
}

/** 界面上要的四个数（其余字段不给 view 看见，避免在渲染里推导返利规则） */
export type InviteDetail = {
  code: string
  count: number
  /** 已结算返利（元 / CNY） */
  rebateBalance: number
  /** 冻结中的返利（元 / CNY） */
  frozenBalance: number
  /** 我的邀请人 id；有值 = 已绑定（一次性，不能改），没有 = 还没绑定 */
  inviterId?: number
}

/**
 * `hidden` = 这条链路上没有可展示的东西（未拿到 `aff` 数据），`signedOut` = 没登录（引导态，不发请求），
 * 与「加载失败」是三件不同的事（#608：没登录不是错误）。
 */
export type InviteState = { phase: 'hidden' } | { phase: 'signedOut' } | PanelAsync<InviteDetail>

/**
 * 未登录时的状态（#608）—— 引导态，**不发任何请求**（`aff.detail()` 需要 JWT，打了只会 401）。
 *
 * #819-v2：这里**不再**先看 `invitation_code_enabled`。那个开关管的是注册页能不能填码，
 * 与「登录后有没有邀请码可看」无关（凭 `settings/public` 判一个只有登录后才知道的事实，本来也判不准）。
 */
export const inviteStateSignedOut = (): InviteState => ({ phase: 'signedOut' })

/**
 * 面板的**初始态**（#830 —— 先渲染后查开关是"闪一下就没"的病灶；#819-v2 之后更难写错）。
 *
 * 不变的硬要求：**第一帧不许出现任何 `invite-*` 节点**，除非它一定会变成内容。
 * 现在可见性的真值来自 `GET /user/aff`（异步），初始态因此恒为 `hidden`，等结论回来**一次**落
 * `ready`（数据态）或 `failed`（重试）；不存在"先骨架、后被抹掉"的回落路径。
 * 骨架（`loading`）仍留在类型与视图里（重试等场景可用），但**初始态不许是它**。
 */
export const initialInviteState = (): InviteState => ({ phase: 'hidden' })

export const toInviteDetail = (affiliate: ConsumeAffiliate): InviteDetail => {
  const detail: InviteDetail = {
    code: affiliate.affCode,
    count: affiliate.affCount,
    rebateBalance: affiliate.affQuota,
    frozenBalance: affiliate.affFrozenQuota,
  }
  if (affiliate.inviterId !== undefined) {
    detail.inviterId = affiliate.inviterId
  }
  return detail
}

/** 服务端真的给了邀请码才算「有东西可展示」（空串 / 只有空白 → 不放出空壳面板） */
export const hasInviteCode = (code: string | undefined | null): boolean =>
  typeof code === 'string' && code.trim() !== ''

/**
 * 读返利（#819-v2：**只读 `GET /user/aff`**，不再并行读 `settings/public`）。
 *
 *  · 成功且带 `aff_code` → `ready`（面板可见，内容照旧）；
 *  · 成功但没有 `aff_code`（空串）→ `hidden`（没有可展示的邀请码，不摆一个「—」的空壳）；
 *  · 请求失败 → `failed` + 重试（**不猜**：猜「有」会在真出错的部署上摆假数据，猜「没有」会让
 *    用户以为自己的邀请码没了 —— 这条是 #819 的病根，别退回「读开关失败就隐藏」）。
 */
export const loadInvite = async (source: InviteSource): Promise<InviteState> => {
  const affiliate = await source.aff.detail()
  if (!affiliate.ok) {
    return { phase: 'failed', error: toPanelError(affiliate.error) }
  }
  if (!hasInviteCode(affiliate.data.affCode)) {
    return { phase: 'hidden' }
  }
  return panelReady(toInviteDetail(affiliate.data))
}

/**
 * 「填写邀请码」入口的受控状态（#839）。**只在** 已登录 + 数据已就绪 + 还没绑定 + 调用方允许（`canBind`）时才传。
 * `error` 是上一次提交的失败（`error.i18nKey` 直接上屏，永不显示服务端英文 message）。
 */
export type InviteBindForm = {
  draft: string
  busy: boolean
  error: PanelError | null
  onDraft: (value: string) => void
  onSubmit: () => void
}

export type InviteBindResult = { ok: true } | { ok: false; error: PanelError }

/**
 * 提交绑定（纯逻辑，容器只负责把结果落成状态）。
 *
 *  · 空串 / 全空白 → **不发请求**，落 `inviteCodeInvalid`（本地拦，不吃服务端 10/min 限流）；
 *  · 其余一律交给服务端判（格式 / 是否存在 / 是否自己的码 / 是否已绑定）—— 客户端不复制一份规则；
 *  · 成功 → `{ok:true}`，容器随后重新读 `GET /user/aff`（`inviter_id` 以服务端为准，不在本地猜）。
 */
export const runBindInviter = async (source: InviteBindSource, code: string): Promise<InviteBindResult> => {
  if (code.trim() === '') {
    return { ok: false, error: localPanelError('inviteCodeInvalid') }
  }
  const result = await source.aff.bind(code)
  return result.ok ? { ok: true } : { ok: false, error: toPanelError(result.error) }
}

export type InvitePanelViewProps = PanelBlockProps & {
  state: InviteState
  /** 「填写邀请码」入口；不传 = 不渲染（未开放 / 已绑定 / 非就绪态） */
  bind?: InviteBindForm
  copied: boolean
  onCopy: () => void
  onRetry: () => void
  /** 未登录态的「去登录」出口（由外壳切到账号 tab / 打开局部登录卡） */
  onSignIn?: () => void
}

/** 「填写邀请码」：输入框 + 绑定按钮 + 一句「只能绑定一次」+ 上一次的失败 */
const inviteBindBlock = (props: InvitePanelViewProps, bind: InviteBindForm): ReactNode => {
  const { t, c, Button } = props
  return createElement(
    'div',
    { className: c.form, 'data-testid': 'invite-bind' },
    createElement('span', { className: c.label }, t('inviteBindTitle')),
    createElement('input', {
      className: c.input,
      type: 'text',
      autoComplete: 'off',
      autoCapitalize: 'characters',
      spellCheck: false,
      value: bind.draft,
      disabled: bind.busy,
      placeholder: t('inviteBindPlaceholder'),
      'aria-label': t('inviteBindTitle'),
      'data-testid': 'invite-bind-input',
      onChange: (event: ChangeEvent<HTMLInputElement>) => bind.onDraft(event.currentTarget.value),
    }),
    createElement(
      Button,
      {
        size: 's',
        variant: 'primary',
        disabled: bind.busy || bind.draft.trim() === '',
        testId: 'invite-bind-submit',
        onClick: bind.onSubmit,
      },
      t('inviteBindSubmit')
    ),
    createElement('p', { className: c.hint }, t('inviteBindOnce')),
    bind.error === null ? null : errorBlock(props, bind.error, undefined, 'invite-bind-error')
  )
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
    if (state.data.inviterId !== undefined) {
      // 已绑定：只读展示（一次性，不给改的入口）
      body.push(createElement('p', { className: c.hint, 'data-testid': 'invite-bound' }, t('inviteBindDone')))
    } else if (props.bind !== undefined) {
      body.push(inviteBindBlock(props, props.bind))
    }
  }
  return panelShell(c, t('inviteTitle'), body, 'invite-panel')
}
