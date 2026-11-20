// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s] 说明见 tests/README.md
//
// Issue #234：邀请奖励改成「只给邀请人」之后，被邀请人填码会看到「已获得 0 积分」，像失败。
// 本用例锁住四条行为（先红后绿：改之前应该全红）：
//   [1] 被邀请人成功态（reward_points: 0）不再出现「积分」，改说「邀请关系已绑定」
//   [2] 邀请人态（reward_points: 100）文案与改动前逐字相同，不许一起改坏
//   [3] invite_rules 缺失（老服务端 / 降级）时不谎报积分，也**不许**回落到写死的「双方各得 1 元」
//   [4] 服务端新错误码 circular_invite（409，互填邀请码）有专属文案，不落通用报错
//   [5] 规则行由 invite_rules 的数值生成（换数值文案跟着变），不含金额换算
//   [6] /redeem 成功响应里的新字段（reward_points_inviter / cashback_points / invite_rules…）被解析出来
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// 端点地址唯一来源：config/endpoints.json（#274）
import { inviteBaseUrl } from '../../scripts/lib/endpoints.mjs'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const {
  INVITE_API_BASE,
  INVITE_ERROR_KEYS,
  fetchInviteProfile,
  parseInviteProfile,
  redeemInviteCode,
} = await import('../../src/services/invite/api.ts')
const { formatPoints } = await import('../../src/services/ours/api.ts')
const { inviteOkCopy, inviteRuleLines } = await import('../../src/services/invite/copy.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'

/** 与 i18n/index.ts 的 createTranslate 同一算法（占位符替换），文案表直接喂进来 */
const render = (table, key, params) => {
  assert.equal(typeof table[key], 'string', `文案表缺少键 ${key}`)
  return table[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    params && params[name] !== undefined ? String(params[name]) : placeholder
  )
}
/** 组件里的真实渲染路径：积分一律带 oursPointsUnit 单位，不做金额换算 */
const renderOk = (table, copy) =>
  copy.key === 'oursInviteOk'
    ? render(table, 'oursInviteOk', { points: formatPoints(copy.points, table.oursPointsUnit) })
    : render(table, copy.key)

const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}
const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

const PROFILE = {
  invite_code: 'G7TA7UR3',
  invited_count: 2,
  max_invites: 30,
  bonus_points: 0,
  redeemed: true,
  quota_points: 200,
  used_points: 20,
  remaining_points: 180,
  key_status: 'active',
}
const RULES = {
  reward_inviter_points: 100,
  reward_invitee_points: 0,
  cashback_points: 100,
  cashback_min_fen: 490,
}

test('#234 [1] 被邀请人成功态（reward_points: 0）不再显示「已获得 0 积分」', () => {
  const copy = inviteOkCopy(0)
  assert.equal(copy.key, 'oursInviteBound', '0 积分 → 只能说「邀请关系已绑定」')

  for (const [locale, table] of [
    ['zh', zh],
    ['en', en],
  ]) {
    const text = renderOk(table, copy)
    assert.ok(!text.includes('积分'), `${locale}：被邀请人成功文案里不能出现「积分」（实际：${text}）`)
    assert.ok(!/\b0\b/.test(text), `${locale}：不能出现 0（实际：${text}）`)
    assert.ok(!text.includes('{'), `${locale}：占位符没被替换（实际：${text}）`)
    assert.ok(text.trim() !== '', `${locale}：成功文案不能空`)
  }
  assert.equal(render(zh, 'oursInviteBound'), '邀请关系已绑定')
  // 旧模板照抄就会渲染成这个（本次要消灭的字面量）
  assert.notEqual(renderOk(zh, copy), render(zh, 'oursInviteOk', { points: formatPoints(0, zh.oursPointsUnit) }))
})

test('#234 [2] 邀请人态（reward_points: 100）文案与改动前逐字相同', () => {
  const copy = inviteOkCopy(100)
  assert.equal(copy.key, 'oursInviteOk', '拿到奖励 → 仍走「+N」报数')
  assert.equal(copy.points, 100)
  // #487：单位统一为元（100 积分 = 1 元），文案结构与断言强度不变，期望值跟着单位改
  assert.equal(renderOk(zh, copy), '绑定成功，+1.00 元', '邀请人侧文案（元口径）')
  assert.equal(renderOk(en, copy), 'Bound. +1.00 CNY', '英文侧同样按元口径')
  assert.equal(inviteOkCopy(1).key, 'oursInviteOk', '1 积分也是真到账，仍报数')
})

test('#234 [3] invite_rules 缺失（老服务端/降级）安全兜底，且不写死「双方各得 1 元」', () => {
  // 老服务端：没有 invite_rules、没有 cashback_points
  const legacy = parseInviteProfile({ ...PROFILE })
  assert.notEqual(legacy, null, '老响应仍要能解析出档案')
  assert.equal(legacy.inviteRules, null, '缺 invite_rules → null（不是编造的默认规则）')
  assert.equal(inviteRuleLines(legacy.inviteRules).length, 0, '规则行整行隐藏，不回落写死文案')

  // reward_points 也缺失（更老的部署）：仍然只说「已绑定」，不谎报积分
  assert.equal(inviteOkCopy(null).key, 'oursInviteBound')
  assert.equal(inviteOkCopy(undefined).key, 'oursInviteBound')

  // 两张文案表里都不许再出现写死的「双方各得」/「各 1 元」这类规则
  for (const [locale, table] of [
    ['zh', zh],
    ['en', en],
  ]) {
    const offenders = Object.entries(table)
      .filter(([, text]) => /各得|各 1 元|each get|both get/i.test(String(text)))
      .map(([key]) => key)
    assert.deepEqual(offenders, [], `${locale}：文案表里仍有写死的规则（${offenders.join(', ')}）`)
  }

  // 规则行也不可能凭空冒出金额
  assert.deepEqual(inviteRuleLines(null), [])
})

test('#234 [4] 409 circular_invite 有专属文案，不落通用报错', () => {
  assert.equal(INVITE_ERROR_KEYS.circular_invite, 'oursInviteErrCircularInvite', '错误码要映射到专属 key')
  for (const table of [zh, en]) {
    const text = render(table, 'oursInviteErrCircularInvite')
    assert.ok(text.trim() !== '', '专属文案不能空')
    assert.notEqual(text, table.oursInviteErrUnknown, '不能等于通用报错文案')
    assert.notEqual(text, table.oursInviteErrAlreadyRedeemed, '不能等于「已绑定过邀请码」')
    assert.ok(!text.includes('{'), '无占位符残留')
  }

  return (async () => {
    const { transport, calls } = fakeTransport([
      json(409, { error: { code: 'circular_invite', message: 'circular invite' } }),
    ])
    const result = await redeemInviteCode({ deviceId: DEVICE_ID, inviteCode: ' abcd1234 ' }, transport)
    assert.equal(calls.length, 1, '只发一次请求（语义错误不重试）')
    assert.equal(JSON.parse(calls[0].body).invite_code, 'ABCD1234', '邀请码仍规范化后提交')
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'circular_invite', '保留服务端原始错误码')
    assert.equal(result.messageKey, 'oursInviteErrCircularInvite', '走专属文案')
    assert.equal(result.retryable, false, '互填邀请码不是可重试错误')
    assert.notEqual(zh[result.messageKey], zh.oursInviteErrUnknown, '界面上不能是通用报错')
  })()
})

test('#234 [5] 规则行来自 invite_rules 的数值（不写死、不做金额换算）', () => {
  const { transport } = fakeTransport([json(200, { ...PROFILE, cashback_points: 0, invite_rules: RULES })])
  return fetchInviteProfile(DEVICE_ID, transport).then((result) => {
    assert.equal(result.kind, 'ok')
    assert.deepEqual(result.profile.inviteRules, {
      rewardInviterPoints: 100,
      rewardInviteePoints: 0,
      cashbackPoints: 100,
      cashbackMinFen: 490,
    })
    assert.equal(result.profile.cashbackPoints, 0, '本人已获返现读 cashback_points')

    const lines = inviteRuleLines(result.profile.inviteRules)
    assert.equal(lines.length, 2, 'reward_invitee_points = 0 → 不出现「被邀请人得 0 积分」这行')
    assert.equal(lines[0].key, 'oursInviteRuleInviter')
    assert.equal(lines[0].points, 100)
    assert.equal(lines[1].key, 'oursInviteRuleCashback')
    const texts = lines.map((line) =>
      render(zh, line.key, { points: formatPoints(line.points, zh.oursPointsUnit) })
    )
    assert.match(texts[0], /邀请人得 1\.00 元/)
    assert.match(texts[1], /1\.00 元/)
    assert.ok(!texts.some((text) => /4\.9/.test(text)), '不写死门槛金额（数值全部来自服务端）')

    // 换一组服务端数值，文案必须跟着变（证明不是写死的）
    const other = inviteRuleLines({
      rewardInviterPoints: 50,
      rewardInviteePoints: 30,
      cashbackPoints: 0,
      cashbackMinFen: 0,
    })
    assert.equal(other.length, 2, '两侧都有奖励时两行都在')
    const otherTexts = other.map((line) =>
      render(zh, line.key, { points: formatPoints(line.points, zh.oursPointsUnit) })
    )
    assert.match(otherTexts.join(' / '), /0\.50 元/)
    assert.match(otherTexts.join(' / '), /0\.30 元/)
    assert.ok(!otherTexts.join(' / ').includes('1.00 元'), '旧数值不许残留')
  })
})

test('#234 [6] /redeem 成功响应解析新增字段（reward_points: 0 也算成功）', () => {
  const { transport } = fakeTransport([
    json(200, {
      ...PROFILE,
      reward_points: 0,
      reward_points_inviter: 100,
      invited_count: 1,
      max_invites: 30,
      cashback_points: 0,
      invite_rules: RULES,
      synced: true,
    }),
  ])
  return redeemInviteCode({ deviceId: DEVICE_ID, inviteCode: 'G7TA7UR3' }, transport).then((result) => {
    assert.equal(result.kind, 'ok', 'reward_points: 0 是成功，不是失败')
    assert.equal(result.rewardPoints, 0)
    assert.equal(result.rewardPointsInviter, 100)
    assert.equal(result.invitedCount, 1)
    assert.equal(result.maxInvites, 30)
    assert.equal(result.cashbackPoints, 0)
    assert.deepEqual(result.inviteRules, {
      rewardInviterPoints: 100,
      rewardInviteePoints: 0,
      cashbackPoints: 100,
      cashbackMinFen: 490,
    })
    assert.equal(result.profile?.invitedCount, 1, '档案仍旧从响应里取')
    assert.equal(INVITE_API_BASE, inviteBaseUrl, '接口地址不变')
    assert.equal(inviteOkCopy(result.rewardPoints).key, 'oursInviteBound', '这次要显示「邀请关系已绑定」')
  })
})
