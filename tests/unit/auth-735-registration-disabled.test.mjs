// [layer: unit | 依赖: 无（纯 Node，真源码 + 实测回包，零网络） | 耗时: <1s | Issue #735]
//
// **#735：「注册被关闭」被渲染成「账号或密码错误」**。
//
// 实测根因（2026-11-21，只读探测，回包见 `tests/fixtures/consume/auth-*.json`）：
//   · 生产 0.2.15 `POST /api/v1/auth/register` 与 `/auth/send-verify-code` → 403 `reason:"REGISTRATION_DISABLED"`
//     （`GET /api/v1/settings/public` 同时 `registration_enabled:false`，两条互相印证）；
//   · 同一实例 `POST /api/v1/auth/login` 错密码 → 401 `reason:"INVALID_CREDENTIALS"`（这条文案本来就对）；
//   · 本地 0.2.20 重复邮箱 → 409 `reason:"EMAIL_EXISTS"`。
// 上一版 `transport.ts` 把 `consumeErrForbidden`（403）也映射成 `sub2authCredentialInvalid`，
// 于是「注册暂未开放」上屏成了「账号或密码错误」—— 用户以为密码错，反复重试。
//
// 本文件钉住的分流口径：**服务端业务码（`reason` 优先、`code` 其次）→ 归一化类别兜底（状态码）**，
// 且**永不匹配 `message`**（#679 收口口径：同一码有多种 message，按文本匹配会在别的路径上静默失效）。
//
//   R1 register  403 REGISTRATION_DISABLED → 「注册暂未开放…」且**不含**「账号或密码错误」
//   R2 sendCode  403 REGISTRATION_DISABLED → 同上（「发送验证码」这条入口常被漏掉）
//   R3 login     401 INVALID_CREDENTIALS   → 「账号或密码错误」（**不回归**）
//   R4 403 **无** reason / 无信封           → `sub2authForbiddenUnknown`：**拒绝 ≠ 密码错**（#735 的另一半）
//   R5 middleware 信封 `code:"REGISTRATION_DISABLED"`（没有 reason 字段）→ 同样按码分流
//   R6 表外 reason（`ACCESS_DENIED`）+ message 里写着 "registration is currently disabled"
//      → **不许**变成「注册暂未开放」（证明我们没有去匹配英文文案），落到 forbidden 档
//   R7 register / sendCode 409 EMAIL_EXISTS → 「该邮箱已注册，请直接登录」
//   R9 login 403 USER_NOT_ACTIVE（密码对、账号停用，**实测复现**）→ 「账号已被停用，请联系管理员」
//   R10 纯文本 HTML 403（网关/WAF，连 JSON 信封都没有）→ 仍是 forbidden 档，不是密码错
//   C1 对照组（R1 不空转的证据）：同一条 403 回包**删掉 reason** → 文案从「注册暂未开放」变成
//      「操作被拒绝…」，与 R1 的结论**不同**；也就是说 R1 的绿只能来自 `reason` 分流。
//
// 口径升级（车道 lead 裁决，采纳 #739 的严格口径）：**403 一律不许说成「账号或密码错误」**。
// 修 REGISTRATION_DISABLED 只是堵住一个入口；无 reason 的 403（网关/WAF、表外码）若仍沿用
// 「账号或密码错误」，是同一类错误换个入口复发。
//
// 负向对照（人工，写进 PR 正文）：把 `AUTH_CODE_MESSAGE_KEYS` 那段分流删掉 → R1 / R2 / R7 立刻红，
// 还原后转绿。
//
//   node --test tests/unit/auth-735-registration-disabled.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { jsonRaw, rawFromFixture, textRaw } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { parseSub2ApiError } = await import('../../src/services/consume/errors.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const EMAIL = 'copy-735@example.com'
const PASSWORD = 'secret-735'

/** 真文案（断言落在「用户看到的话」上，不是 key 上） */
const textOf = (key) => {
  const text = zh[key]
  assert.equal(typeof text, 'string', `zh 里没有键 ${String(key)}`)
  return text
}

/**
 * 假消费层客户端：只把**一次真回包**（先过真的 `parseSub2ApiError`）交回给身份层。
 * 中间不塞任何桩 —— 被测的就是「原始回包 → 归一化错误 → 上屏 key」这条真链路。
 */
const transportFor = (raw, patch = (body) => body) => {
  const error = parseSub2ApiError(patch(raw))
  const fail = async () => ({ ok: false, error, raw })
  const consume = {
    auth: { login: fail, register: fail, sendVerifyCode: fail, refresh: fail, profile: fail, revokeAllSessions: fail },
  }
  return createAuthTransport(consume)
}

/** 回包改造：删掉面板信封里的 `reason`（模拟「403 但服务端没给业务码」） */
const withoutReason = (raw) => {
  const body = { ...raw.json }
  delete body.reason
  return { ...raw, json: body, text: JSON.stringify(body) }
}

/** 回包改造：换掉 `reason`、保留 message（证明判定不看 message） */
const withBody = (patch) => (raw) => {
  const body = { ...raw.json, ...patch }
  return { ...raw, json: body, text: JSON.stringify(body) }
}

/** 一次失败结果 → `{key, text}`（顺带断言「失败没有冒充成功」） */
const copyOf = async (result) => {
  assert.equal(result.ok, false, '这一行必须是失败结果，不能悄悄成功')
  return { key: result.error.messageKey, text: textOf(result.error.messageKey) }
}

const ROWS = [
  {
    id: 'R1',
    what: 'register 403 REGISTRATION_DISABLED → 「注册暂未开放」，不含「账号或密码错误」',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-register-403-registration-disabled.json')).register({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authRegistrationDisabled', includes: '注册暂未开放', excludes: '账号或密码错误' },
  },
  {
    id: 'R2',
    what: 'send-verify-code 403 REGISTRATION_DISABLED → 同一句「注册暂未开放」',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-register-403-registration-disabled.json')).sendCode({ email: EMAIL })),
    expect: { key: 'sub2authRegistrationDisabled', includes: '注册暂未开放', excludes: '账号或密码错误' },
  },
  {
    id: 'R3',
    what: 'login 401 INVALID_CREDENTIALS → 「账号或密码错误」（正确文案，不许回归）',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-login-401-invalid-credentials.json')).login({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authCredentialInvalid', equals: '账号或密码错误' },
  },
  {
    id: 'R4',
    what: '403 但没有 reason → forbidden 档（拒绝 ≠ 密码错），不说「账号或密码错误」',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-register-403-registration-disabled.json'), withoutReason).register({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authForbiddenUnknown', includes: '操作被拒绝', excludes: '账号或密码错误' },
  },
  {
    id: 'R5',
    what: '中间件信封 code:"REGISTRATION_DISABLED"（无 reason 字段）→ 照样按业务码分流',
    run: async () => copyOf(await transportFor(jsonRaw(403, { code: 'REGISTRATION_DISABLED', message: 'registration is currently disabled' })).register({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authRegistrationDisabled', includes: '注册暂未开放', excludes: '账号或密码错误' },
  },
  {
    id: 'R6',
    what: '表外 reason + message 写着 disabled → 不按英文文案分流，回落保守兜底',
    run: async () =>
      copyOf(
        await transportFor(
          rawFromFixture('auth-register-403-registration-disabled.json'),
          withBody({ reason: 'ACCESS_DENIED', message: 'registration is currently disabled' })
        ).register({ email: EMAIL, password: PASSWORD })
      ),
    expect: { key: 'sub2authForbiddenUnknown', includes: '操作被拒绝', excludes: '注册暂未开放' },
  },
  {
    id: 'R7',
    what: 'register 409 EMAIL_EXISTS → 「该邮箱已注册，请直接登录」',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-register-409-email-exists.json')).register({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authEmailExists', equals: '该邮箱已注册，请直接登录' },
  },
  {
    id: 'R8',
    what: 'send-verify-code 409 EMAIL_EXISTS → 同一句「该邮箱已注册」（点「发送验证码」也会撞到）',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-register-409-email-exists.json')).sendCode({ email: EMAIL })),
    expect: { key: 'sub2authEmailExists', equals: '该邮箱已注册，请直接登录' },
  },
  {
    id: 'R9',
    what: 'login 403 USER_NOT_ACTIVE（密码对、账号被停用，实测复现）→ 「账号已被停用，请联系管理员」',
    run: async () => copyOf(await transportFor(rawFromFixture('auth-login-403-user-not-active.json')).login({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authUserNotActive', equals: '账号已被停用，请联系管理员', excludes: '账号或密码错误' },
  },
  {
    id: 'R10',
    what: '纯文本 HTML 403（网关/WAF，连 JSON 信封都没有）→ 仍是 forbidden 档，不说密码错',
    run: async () => copyOf(await transportFor(textRaw(403, '<html><head><title>403 Forbidden</title></head><body>403 Forbidden</body></html>', 'text/html')).register({ email: EMAIL, password: PASSWORD })),
    expect: { key: 'sub2authForbiddenUnknown', includes: '操作被拒绝', excludes: '账号或密码错误' },
  },
]

for (const row of ROWS) {
  test(`${row.id} ${row.what}`, async () => {
    const { key, text } = await row.run()
    assert.equal(key, row.expect.key, `上屏 key 不对（拿到 ${key}）：${text}`)
    if (row.expect.equals !== undefined) {
      assert.equal(text, row.expect.equals)
    }
    if (row.expect.includes !== undefined) {
      assert.ok(text.includes(row.expect.includes), `文案里应当出现「${row.expect.includes}」，实际是「${text}」`)
    }
    if (row.expect.excludes !== undefined) {
      assert.ok(!text.includes(row.expect.excludes), `文案里**不许**出现「${row.expect.excludes}」，实际是「${text}」`)
    }
  })
}

test('C1 对照组：同一条 403 回包删掉 reason 后文案就变了 —— R1 的绿只能来自业务码分流', async () => {
  const withReason = await copyOf(await transportFor(rawFromFixture('auth-register-403-registration-disabled.json')).register({ email: EMAIL, password: PASSWORD }))
  const withoutCode = await copyOf(
    await transportFor(rawFromFixture('auth-register-403-registration-disabled.json'), withoutReason).register({ email: EMAIL, password: PASSWORD })
  )
  assert.equal(withReason.key, 'sub2authRegistrationDisabled')
  assert.equal(withoutCode.key, 'sub2authForbiddenUnknown')
  assert.notEqual(withReason.text, withoutCode.text, '两条路径的文案必须不同，否则 R1 是空转')
})

test('新词条中英两侧都在、且非空（#314 口径：界面不许出现空块）', () => {
  for (const key of ['sub2authRegistrationDisabled', 'sub2authEmailExists', 'sub2authForbiddenUnknown', 'sub2authUserNotActive']) {
    for (const [locale, table] of [['zh', zh], ['en', en]]) {
      const text = table[key]
      assert.equal(typeof text, 'string', `${locale} 缺 ${key}`)
      assert.ok(text.trim() !== '', `${locale} 的 ${key} 是空文案`)
    }
  }
  // 403 的两条都不许带「密码」二字：那正是 #735 的误报形态
  assert.ok(!zh.sub2authRegistrationDisabled.includes('密码'))
  assert.ok(!zh.sub2authForbiddenUnknown.includes('密码'))
  assert.ok(!zh.sub2authUserNotActive.includes('密码'))
})
