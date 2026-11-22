/**
 * 邀请 / 返利 —— Issue #484 §3.1b，W1-A。
 *
 *   POST /api/v1/auth/validate-invitation-code   公共（10/min）：注册前预校验邀请码
 *   GET  /api/v1/user/aff                        JWT：我的邀请（返利按**比例**结算，金额单位是元）
 *   POST /api/v1/user/aff/transfer               JWT：把全部可划转返利转入余额（#860；**没有真实响应样本**，只有 mock 契约）
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

/**
 * 登录后绑定邀请码的成功体（#842 / #856 实测）：`200 {"code":0,"data":{"bound":true}}`。
 * **没有 `inviter_id`**（也不返回邀请人任何个人信息）；是否已绑定以成功后重拉 `GET /user/aff` 的 `inviter_id` 为准。
 * `bound` 只有响应体里**字面是 `true`** 才为 `true`，缺省 / 其他值一律 `false`（调用方不得当成功）。
 */
export type ConsumeAffiliateBind = { bound: boolean }

/**
 * 划转返利到余额的成功体（#860 契约：`data: { transferred_quota, balance }`，**没有任何真实响应样本**）。
 * `confirmed` 只有响应体里 `balance` 是有限数字才为 `true`（界面要用它刷新余额）；
 * 2xx 但没有数字 `balance` 一律 `confirmed: false`，调用方不得显示成功。`transferredQuota` 单位是元，缺省就不带。
 */
export type ConsumeAffiliateTransfer = { confirmed: boolean; balance?: number; transferredQuota?: number }

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
  /** 剩余邀请名额：`0` = 已满，`-1` = 不限（#860）；服务端没给就不带，**不在客户端推算上限** */
  inviteRemaining?: number
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

/**
 * 登录后绑定邀请人（JWT，#856 实测契约：`POST /api/v1/user/aff/bind`，body `{"aff_code": "<邀请码>"}`，成功体 `{"bound":true}`）。
 *
 * 写操作，**不自动重试**；调用方负责客户端轻量校验（trim + 转大写 + 4–32 位 `A-Z0-9_-`），这里原样发出 `aff_code`。
 * 请求体字段名与后端注册接口一致（`aff_code`，不是 `code`），见 sub2api-private#19。
 * 失败按 `reason` 分派（`AFFILIATE_CODE_INVALID` / `AFFILIATE_DISABLED`（400，不按状态码）/ `AFFILIATE_ALREADY_BOUND` /
 * `AFFILIATE_INVITER_FULL`；401 是中间件的 `UNAUTHORIZED`，没有 reason），**成功 = 2xx 且 `data.bound === true`**。
 */
export const bindInviter = (http: ConsumeHttp, code: string): Promise<ConsumeCallResult<ConsumeAffiliateBind>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/user/aff/bind', body: { aff_code: code }, timeout: 'write' })
    .then((result) => {
      if (!result.ok) {return result}
      const body = asRecord(result.data)
      return { ...result, data: { bound: body.bound === true } }
    })

/**
 * 把全部可划转返利转入余额（JWT，#860：`POST /api/v1/user/aff/transfer`，无请求体）。
 * 写操作，**不自动重试**；成功 = 2xx 且 `data.balance` 是数字（见 {@link ConsumeAffiliateTransfer}）。
 * 失败的 `reason` 没有任何实测样本，这里不发明错误码，调用方只按 401 / 其余通用失败分派。
 */
export const transferAffiliate = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeAffiliateTransfer>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/user/aff/transfer', timeout: 'write' })
    .then((result) => {
      if (!result.ok) {return result}
      const body = asRecord(result.data)
      const out: ConsumeAffiliateTransfer = { confirmed: false }
      if (typeof body.balance === 'number' && Number.isFinite(body.balance)) {
        out.confirmed = true
        out.balance = body.balance
      }
      if (typeof body.transferred_quota === 'number' && Number.isFinite(body.transferred_quota)) {
        out.transferredQuota = body.transferred_quota
      }
      return { ...result, data: out }
    })

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
  if (typeof body.invite_remaining === 'number' && Number.isFinite(body.invite_remaining)) {out.inviteRemaining = body.invite_remaining}
  return out
}
