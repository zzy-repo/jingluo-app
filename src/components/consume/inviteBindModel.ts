/**
 * 「我的邀请」里的「登录后填写邀请人」区块（Issue #842 契约 / #839）。
 *
 * **后端接口 `POST /api/v1/user/aff/bind` 目前不存在**：前端按 #842 的契约先做，用 mock 测试，不以真实接口验收。
 * 所以入口由 {@link INVITE_BIND_ENABLED} **默认关闭**（见该常量的注释：怎么打开、为什么不做运行时探测）。
 *
 * 分层沿用 `invitePanelModel.ts` / `emailBindPanelModel.ts`：本文件是**纯函数 + 纯渲染**，状态判定都写在这里，
 * 容器（`InvitePanel.tsx`）只负责持有状态、把输入与点击接进来。
 *
 * 口径：
 *  · 客户端只做**轻量校验**（trim + 转大写；4–32 位 `A-Z0-9_-`）以少发无意义请求，**后端才是权威**；
 *    不发明错误码，错误只按 `error.code`（429 没有 code，按状态码）映射到文案，认不出的一律「绑定失败」；
 *  · **只有 `ok: true` 才算成功**；`AFFILIATE_ALREADY_BOUND`（409）= 其实已绑定过 → 切只读并重新拉 `GET /user/aff`；
 *  · 已绑定只读：只表示「已绑定邀请人」，**不显示邀请人任何个人信息**（接口也不给）。
 */

import { createElement, type ChangeEvent, type ReactNode } from 'react'

import type { TranslationKey } from '../../i18n/index.js'
import type {
  ConsumeAffiliate,
  ConsumeAffiliateBind,
  ConsumeCallResult,
  Sub2ApiError,
} from '../../services/consume/index.js'
import { loadInvite, type InviteState } from './invitePanelModel.js'
import type { PanelBlockProps } from './panels.js'

/**
 * 入口总开关（**默认 `false`**）。
 *
 * 为什么是一个常量而不是特性开关体系：仓库里没有「客户端特性开关」机制 ——
 * `invitation_code_enabled` / `affiliate_enabled` 是**服务端** `settings/public` 的字段，管的是注册页与返利体系，
 * 且 #819-v2 已明确面板可见性不再读它们；也**不对不存在的接口做运行时探测**（探测 404 等于把「没上线」猜成「没开」）。
 * 所以用最小的常量，不新建配置体系。
 *
 * 怎么打开：后端 `POST /api/v1/user/aff/bind` 在 staging 上线并验收后，把这一行改成 `true`（一行改动即上线入口）。
 * 测试里不改它：所有判定函数都接收 `enabled` 入参，单测显式传 true / false。
 */
export const INVITE_BIND_ENABLED = false

/** 4–32 位 `A-Z0-9_-`（与 #842 契约里 `BindInviterByCode` 的格式校验一致；这里只为少发请求，后端才是权威） */
const INVITE_CODE_PATTERN = /^[A-Z0-9_-]{4,32}$/u

export type InviteCodeCheck = { ok: true; code: string } | { ok: false }

/** trim + 转大写，再按 {@link INVITE_CODE_PATTERN} 判格式；不合格返回 `{ ok: false }`（调用方不发请求） */
export const normalizeInviteCode = (raw: string): InviteCodeCheck => {
  const code = raw.trim().toUpperCase()
  return INVITE_CODE_PATTERN.test(code) ? { ok: true, code } : { ok: false }
}

// ------------------------------------------------------------------ 状态

export type InviteBindState = {
  draft: string
  busy: boolean
  /** 上一次提交的失败文案 key（`null` = 没有错误） */
  errorKey: TranslationKey | null
  /** 本地已确认「已绑定」（绑定成功，或服务端回 409 `AFFILIATE_ALREADY_BOUND`）；与 `aff.inviterId` 二者任一成立即只读 */
  bound: boolean
}

export const initialInviteBindState = (): InviteBindState => ({
  draft: '',
  busy: false,
  errorKey: null,
  bound: false,
})

export type InviteBindMode = 'hidden' | 'form' | 'bound'

/**
 * 区块该显示什么：
 *  · 开关关 → `hidden`（**没有任何 `invite-bind-*` 节点**）；
 *  · 面板还不是数据态（未登录 / 加载中 / 失败 / 无邀请码）→ `hidden`（没有可绑定的账号上下文）；
 *  · `GET /user/aff` 的 `inviter_id` 有值（正整数），或本地已确认绑定 → `bound`（只读）；
 *  · 其余 → `form`（输入框 + 提交）。
 */
export const inviteBindMode = (input: { enabled: boolean; state: InviteState; bound: boolean }): InviteBindMode => {
  if (!input.enabled || input.state.phase !== 'ready') {
    return 'hidden'
  }
  const inviterId = input.state.data.inviterId
  // `inviter_id` 在服务端是 `omitempty` 的整数：0 / 缺省都表示没绑
  if (input.bound || (typeof inviterId === 'number' && inviterId > 0)) {
    return 'bound'
  }
  return 'form'
}

// ------------------------------------------------------------------ 错误映射

/** 绑定失败 → 文案 key + 是否其实已绑定。**只认 `error.code`（429 / 401 无 code 时按状态码）**，永不匹配 `message` */
export type InviteBindFailure = { key: TranslationKey; alreadyBound: boolean }

export const mapBindError = (error: Pick<Sub2ApiError, 'code' | 'status'>): InviteBindFailure => {
  switch (error.code) {
    case 'AFFILIATE_CODE_INVALID':
      return { key: 'inviteBindErrInvalid', alreadyBound: false }
    case 'AFFILIATE_ALREADY_BOUND':
      return { key: 'inviteBindDone', alreadyBound: true }
    case 'AFFILIATE_DISABLED':
      return { key: 'inviteBindErrDisabled', alreadyBound: false }
    case 'UNAUTHORIZED':
      return { key: 'inviteBindErrUnauthorized', alreadyBound: false }
    default:
      break
  }
  // 429 限流没有 `code` 字段（见 `services/consume/errors.ts` 文件头），只能按状态码分支
  if (error.status === 429) {
    return { key: 'inviteBindErrRateLimited', alreadyBound: false }
  }
  if (error.status === 401) {
    return { key: 'inviteBindErrUnauthorized', alreadyBound: false }
  }
  // 其余未识别：通用失败文案（不吞掉、也绝不显示成功）
  return { key: 'inviteBindErrFailed', alreadyBound: false }
}

// ------------------------------------------------------------------ 提交

/** 面板要用到的客户端子集（`consume.aff` 的 `bind` 与 `detail`） */
export type InviteBindSource = {
  aff: {
    bind: (code: string) => Promise<ConsumeCallResult<ConsumeAffiliateBind>>
    detail: () => Promise<ConsumeCallResult<ConsumeAffiliate>>
  }
}

export type InviteBindOutcome =
  /** 客户端校验没过：**没有发请求** */
  | { kind: 'invalid' }
  /** 绑定成功，或服务端说已绑定过（`alreadyBound`）；`reloaded` = 重新拉 `GET /user/aff` 的数据态（拉失败为 `null`，不覆盖现有面板） */
  | { kind: 'bound'; alreadyBound: boolean; reloaded: InviteState | null }
  | { kind: 'failed'; key: TranslationKey }

/**
 * 提交一次绑定：校验 → `POST /user/aff/bind` → 按结果重新拉 `GET /user/aff`。
 * 成功与 409 都重新拉一次；重新拉失败不推翻「已绑定」（只是拿不到最新数据，面板保持原样）。
 */
export const runBindInviter = async (source: InviteBindSource, raw: string): Promise<InviteBindOutcome> => {
  const checked = normalizeInviteCode(raw)
  if (!checked.ok) {
    return { kind: 'invalid' }
  }
  const result = await source.aff.bind(checked.code)
  if (result.ok) {
    return { kind: 'bound', alreadyBound: false, reloaded: await reload(source) }
  }
  const failure = mapBindError(result.error)
  if (failure.alreadyBound) {
    return { kind: 'bound', alreadyBound: true, reloaded: await reload(source) }
  }
  return { kind: 'failed', key: failure.key }
}

const reload = async (source: InviteBindSource): Promise<InviteState | null> => {
  const next = await loadInvite({ aff: { detail: source.aff.detail } })
  return next.phase === 'ready' ? next : null
}

/** 纯 reducer：输入 / 开始提交 / 结果落定 */
export type InviteBindEvent =
  | { type: 'draft'; value: string }
  | { type: 'submit' }
  | { type: 'outcome'; outcome: InviteBindOutcome }

export const reduceInviteBind = (state: InviteBindState, event: InviteBindEvent): InviteBindState => {
  switch (event.type) {
    case 'draft':
      return { ...state, draft: event.value, errorKey: null }
    case 'submit':
      return { ...state, busy: true, errorKey: null }
    case 'outcome': {
      const { outcome } = event
      if (outcome.kind === 'invalid') {
        return { ...state, busy: false, errorKey: 'inviteBindErrFormat' }
      }
      if (outcome.kind === 'failed') {
        return { ...state, busy: false, errorKey: outcome.key }
      }
      return { ...state, busy: false, errorKey: null, bound: true, draft: '' }
    }
    default:
      return state
  }
}

// ------------------------------------------------------------------ 渲染

export type InviteBindViewProps = PanelBlockProps & {
  mode: InviteBindMode
  state: InviteBindState
  onDraft: (value: string) => void
  onSubmit: () => void
}

/** 区块（纯渲染）。`hidden` 返回 `null`：DOM 里没有任何 `invite-bind-*` 节点 */
export const InviteBindView = (props: InviteBindViewProps): ReactNode => {
  const { t, c, Button, mode, state } = props
  if (mode === 'hidden') {
    return null
  }
  if (mode === 'bound') {
    return createElement(
      'div',
      { className: c.guide, 'data-testid': 'invite-bind-done' },
      createElement('p', { className: c.guideTitle }, t('inviteBindDone')),
      createElement('p', { className: c.hint }, t('inviteBindDoneHint'))
    )
  }
  return createElement(
    'div',
    { 'data-testid': 'invite-bind-form' },
    createElement('p', { className: c.hint }, t('inviteBindHint')),
    createElement(
      'div',
      { className: c.createRow },
      createElement('input', {
        className: c.input,
        type: 'text',
        value: state.draft,
        placeholder: t('inviteBindPlaceholder'),
        'aria-label': t('inviteBindLabel'),
        autoCapitalize: 'characters',
        autoComplete: 'off',
        spellCheck: false,
        disabled: state.busy,
        'data-testid': 'invite-bind-input',
        onChange: (event: ChangeEvent<HTMLInputElement>) => props.onDraft(event.currentTarget.value),
      }),
      createElement(
        Button,
        { size: 's', variant: 'primary', disabled: state.busy, testId: 'invite-bind-submit', onClick: props.onSubmit },
        t('inviteBindSubmit')
      )
    ),
    state.errorKey === null
      ? null
      : createElement(
          'div',
          { className: c.error, role: 'alert', 'data-testid': 'invite-bind-error' },
          createElement('p', { className: c.errorText }, t(state.errorKey))
        )
  )
}
