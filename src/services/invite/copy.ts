/**
 * 邀请界面的文案决策（Issue #234）——把「该说哪句话」从组件里摘出来，纯函数、可单测。
 *
 * 背景：2026-11-19 起线上规则改成「只给邀请人发积分」，被邀请人填码只建立关系、
 * `reward_points` 就是 0。旧界面直接渲染 `+{points}`，于是被邀请人看到「绑定成功，+0 积分」，
 * 像失败。所以：
 *   1. 只有**真的拿到积分**（> 0）才报数；0 或字段缺失（老服务端）一律只说「关系已绑定」。
 *      邀请人侧（reward_points > 0）文案保持原样，不能一起改坏。
 *   2. 规则说明由服务端 `invite_rules` 的数值生成，前端不写死金额/积分数；
 *      规则缺失（降级）就返回空数组，界面把这一行整行隐藏——绝不回落「双方各得 1 元」。
 */
import type { TranslationKey } from '../../i18n/index.js'
import type { InviteRules } from './api.js'

/** 成功文案：要么「邀请关系已绑定」，要么「+N 积分」 */
export type InviteOkCopy =
  | { key: 'oursInviteBound' }
  | { key: 'oursInviteOk'; points: number }

/**
 * 填码成功该说什么。
 * @param rewardPoints 服务端 `reward_points`；缺失按 0 处理（老服务端不发就不谎报）
 */
export const inviteOkCopy = (rewardPoints: number | null | undefined): InviteOkCopy =>
  typeof rewardPoints === 'number' && Number.isFinite(rewardPoints) && rewardPoints > 0
    ? { key: 'oursInviteOk', points: rewardPoints }
    : { key: 'oursInviteBound' }

export type InviteRuleLine = {
  key: 'oursInviteRuleInviter' | 'oursInviteRuleInvitee' | 'oursInviteRuleCashback'
  points: number
}

/**
 * 规则说明的每一行，全部来自服务端 `invite_rules`。
 * 数值为 0 的那一端不出现（否则被邀请人又会看到「得 0 积分」）；
 * 规则整体缺失 → 空数组（界面隐藏整行，不编造「双方各得 1 元」）。
 */
export const inviteRuleLines = (rules: InviteRules | null | undefined): InviteRuleLine[] => {
  if (rules === null || rules === undefined) {
    return []
  }
  const lines: InviteRuleLine[] = []
  if (rules.rewardInviterPoints > 0) {
    lines.push({ key: 'oursInviteRuleInviter', points: rules.rewardInviterPoints })
  }
  if (rules.rewardInviteePoints > 0) {
    lines.push({ key: 'oursInviteRuleInvitee', points: rules.rewardInviteePoints })
  }
  if (rules.cashbackPoints > 0) {
    lines.push({ key: 'oursInviteRuleCashback', points: rules.cashbackPoints })
  }
  return lines
}

/** 本人已获返现那一行：「已获返现 N 积分」；没有（null / 0）就不显示 */
export const inviteCashbackLine = (
  cashbackPoints: number | null | undefined
): { key: Extract<TranslationKey, 'oursInviteCashbackEarned'>; points: number } | null =>
  typeof cashbackPoints === 'number' && Number.isFinite(cashbackPoints) && cashbackPoints > 0
    ? { key: 'oursInviteCashbackEarned', points: cashbackPoints }
    : null
