/**
 * 邀请 / 返利 —— Issue #484 §3.1b，W1-A。
 *
 *   POST /api/v1/auth/validate-invitation-code   公共（10/min）：注册前预校验邀请码
 *   GET  /api/v1/user/aff                        JWT：我的邀请（返利按**比例**结算，金额单位是元）
 *
 * 语义（#484 §3.1b「UI 要跟着改」）：
 *  - 邀请关系**只能在注册时一次填定**（sub2api 没有「登录后补填邀请码」的端点）；
 *  - 所以这个模块的两个能力分别是「注册页先把码验一下」与「我的邀请页展示返利统计」，
 *    不存在「填码立刻得积分」那条旧玩法（`circular_invite` / `already_redeemed` 旧文案作废）。
 */

import type { ConsumeCallResult, ConsumeHttp } from './http.js'

/**
 * 邀请码预校验结果。
 * `valid: false` + `errorCode: 'INVITATION_CODE_DISABLED'` 表示**部署方没开邀请功能**（不是码错了）——
 * 界面应当整块隐藏邀请入口，而不是报「邀请码无效」。
 */
export type ConsumeInvitationCheck = { valid: boolean; errorCode?: string }

/** 我的邀请（`AffiliateDetail`）：`affQuota` / `affFrozenQuota` / `affHistoryQuota` 单位是 **元** */
export type ConsumeAffiliate = {
  userId: number
  affCode: string
  inviterId?: number
  /** 已邀请人数 */
  affCount: number
  /** 已结算返利（元） */
  affQuota: number
  /** 冻结中的返利（元） */
  affFrozenQuota: number
  /** 历史累计返利（元） */
  affHistoryQuota: number
  /** 生效返利比例（百分数，例如 10 表示 10%） */
  effectiveRebateRatePercent?: number
  /** 下线列表（字段随服务端版本变，原样保留） */
  invitees: unknown[]
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** 预校验邀请码（公共接口，不带 JWT；服务端限流 10/min，失败不要连着打） */
export const validateInvitationCode = (
  http: ConsumeHttp,
  code: string
): Promise<ConsumeCallResult<ConsumeInvitationCheck>> =>
  http
    .call<unknown>({
      method: 'POST',
      path: '/api/v1/auth/validate-invitation-code',
      body: { code },
      timeout: 'write',
      auth: null,
    })
    .then((result) => {
      if (!result.ok) {return result}
      const body = asRecord(result.data)
      const check: ConsumeInvitationCheck = { valid: body.valid === true }
      if (typeof body.error_code === 'string' && body.error_code !== '') {check.errorCode = body.error_code}
      return { ...result, data: check }
    })

/** 我的邀请（JWT）：`aff_code` / `aff_count` / `aff_quota` 是界面要的三个数 */
export const getAffiliate = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeAffiliate>> =>
  http
    .call<unknown>({ method: 'GET', path: '/api/v1/user/aff', timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toAffiliate(result.data) } : result))

const toAffiliate = (value: unknown): ConsumeAffiliate => {
  const body = asRecord(value)
  const invitees = Array.isArray(body.invitees) ? body.invitees : []
  const out: ConsumeAffiliate = {
    userId: num(body.user_id),
    affCode: str(body.aff_code),
    affCount: num(body.aff_count),
    affQuota: num(body.aff_quota),
    affFrozenQuota: num(body.aff_frozen_quota),
    affHistoryQuota: num(body.aff_history_quota),
    invitees,
  }
  if (typeof body.inviter_id === 'number') {out.inviterId = body.inviter_id}
  if (typeof body.effective_rebate_rate_percent === 'number') {out.effectiveRebateRatePercent = body.effective_rebate_rate_percent}
  return out
}
