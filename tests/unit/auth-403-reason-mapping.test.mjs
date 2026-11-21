// [layer: unit | 依赖: 无（纯 Node + 真源码 + 厂商回包形状，零网络） | Issue #735 / #654]
//
// **#735：403 被当成「账号或密码错误」**。本文件是该缺陷的 **L0 表驱动契约**，只钉
// 「一份原始 HTTP 回包 → 用户看到的那句话」，不碰 UI、不碰网络、不碰 store。
//
// 缺陷（`src/services/auth/transport.ts:146-147`，修复前）：
//   consumeErrUnauthorized → sub2authCredentialInvalid   ← 对（401 确实是凭据错）
//   consumeErrForbidden    → sub2authCredentialInvalid   ← 错（403 未必与凭据有关）
// 生产实证（2026-11-21 对 `sub2api.rose7.cn` 的只读探测，回包逐字抄在下面的 CASES 里）：
//   · `registration_enabled=false`
//   · `POST /api/v1/auth/register` → 403 `{"code":403,"message":"registration is currently disabled","reason":"REGISTRATION_DISABLED"}`
//   · 同一实例错密码 `POST /api/v1/auth/login` → 401 `{"code":401,"message":"invalid email or password","reason":"INVALID_CREDENTIALS"}`
// 于是「注册暂未开放」被上屏成「账号或密码错误」—— 用户去改密码、反复重试，运维也被这条
// 假文案带着去查凭据（真实原因是注册开关）。
//
// 五行口径（一行 = 一条断言；失败信息里带行 id 与「现在实际拿到什么」）：
//   行 1  401 `INVALID_CREDENTIALS`          → `sub2authCredentialInvalid`（真凭据错，**不许回归**）
//   行 2  403 `REGISTRATION_DISABLED`        → 注册未开放类 key（**不是**凭据错）
//   行 3  403 `INVALID_CREDENTIALS`          → `sub2authCredentialInvalid`（后端显式说凭据错，按码走）
//   行 4  403 **无 body / 无 reason**         → **不是** `sub2authCredentialInvalid`（网关 / WAF 403）
//   行 5  403 未知 reason（`ACCOUNT_SUSPENDED`）→ **不是** `sub2authCredentialInvalid`（通用 forbidden 类）
//
// **本文件在 #735 修复落地前是红的**（行 2 / 4 / 5 + 对照组 T1），这是刻意的：
// 它描述的是**目标口径**，不是现状。合并顺序：先 #735 修复 → 本文件转绿 → 再合本 PR。
// 建议的 key（等车道 A 落地；本文件只读 `zh` / `en`，不改 `src/`）：
//   sub2authRegistrationDisabled  注册暂未开放，请稍后或联系管理员 / Sign-up is not open yet…
//   sub2authForbiddenUnknown      当前操作被拒绝（403），请稍后重试或联系客服 / This action was denied (403)…
//
//   node --test tests/unit/auth-403-reason-mapping.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { jsonRaw } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { parseSub2ApiError } = await import('../../src/services/consume/errors.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const EMAIL = 'reason-map-735@example.com'
const PASSWORD = 'secret-735'

/** 目标口径的 key（#735 修复要引入的；改名只需改这三行） */
const KEY = {
  credentialInvalid: 'sub2authCredentialInvalid',
  registrationDisabled: 'sub2authRegistrationDisabled',
  forbiddenUnknown: 'sub2authForbiddenUnknown',
}

/** i18n 查词：缺词条**不抛**，返回让断言自己说话的那句话（否则红了只有 TypeError，看不出原因） */
const textOf = (key) => (typeof zh[key] === 'string' ? zh[key] : `（zh 缺词条 ${String(key)}）`)

/**
 * 真链路：一份原始回包 → `parseSub2ApiError`（真归一化）→ `createAuthTransport`（真映射）→ `messageKey`。
 * 中间不塞任何桩：被测的就是这段产品的分流逻辑，只把 HTTP 那一层换成内存对象。
 */
const copyOf = async (raw, entry = 'register') => {
  const error = parseSub2ApiError(raw)
  const failed = async () => ({ ok: false, error, raw })
  const transport = createAuthTransport({
    auth: {
      login: failed,
      register: failed,
      sendVerifyCode: failed,
      refresh: failed,
      profile: failed,
      revokeAllSessions: failed,
    },
  })
  const result = entry === 'login' ? await transport.login({ email: EMAIL, password: PASSWORD }) : await transport.register({ email: EMAIL, password: PASSWORD, verifyCode: '000000' })
  assert.equal(result.ok, false, '这一行必须是失败结果（不能悄悄成功）')
  const key = result.error.messageKey
  return { key, text: textOf(key), en: typeof en[key] === 'string' ? en[key] : `（en 缺词条 ${String(key)}）`, error: result.error }
}

/** 网关 / WAF 的裸 403：没有 JSON 信封、没有 reason，正文是 HTML（模拟运维侧拦截） */
const waf403 = () => ({
  status: 403,
  ok: false,
  text: '<html><head><title>403 Forbidden</title></head><body>403 Forbidden</body></html>',
  json: null,
  headers: {},
  contentType: 'text/html',
})

// --------------------------------------------------------------------------- 五行

/** 行 1：401 —— 真凭据错。这是唯一该说「账号或密码错误」的一行。 */
const row1 = {
  id: '行1',
  what: '401 INVALID_CREDENTIALS → 账号或密码错误（正确文案，不许回归）',
  raw: () => jsonRaw(401, { code: 401, message: 'invalid email or password', reason: 'INVALID_CREDENTIALS' }),
  entry: 'login',
  expect: { equals: 'sub2authCredentialInvalid' },
}

/** 行 2：403 REGISTRATION_DISABLED —— 生产实际形态（注册开关关闭），与凭据无关。 */
const row2 = {
  id: '行2',
  what: '403 REGISTRATION_DISABLED → 注册未开放类文案（不是凭据错）',
  raw: () => jsonRaw(403, { code: 403, message: 'registration is currently disabled', reason: 'REGISTRATION_DISABLED' }),
  entry: 'register',
  expect: { equals: 'sub2authRegistrationDisabled', textIncludes: '注册', textExcludes: '账号或密码错误' },
}

/** 行 3：403 但后端显式说凭据错 —— 按业务码走，仍然可以（也应该）是凭据错文案。 */
const row3 = {
  id: '行3',
  what: '403 INVALID_CREDENTIALS → 账号或密码错误（后端显式声明，按码分流）',
  raw: () => jsonRaw(403, { code: 403, message: 'invalid email or password', reason: 'INVALID_CREDENTIALS' }),
  entry: 'login',
  expect: { equals: 'sub2authCredentialInvalid' },
}

/** 行 4：403 无 body / 无 reason —— 网关、WAF、反代的拦截，与用户密码毫无关系。 */
const row4 = {
  id: '行4',
  what: '403 无 body 无 reason（网关/WAF）→ 不是凭据错',
  raw: waf403,
  entry: 'register',
  expect: { notEquals: 'sub2authCredentialInvalid', textExcludes: '账号或密码错误' },
}

/** 行 5：403 表外 reason —— 账号停用/风控等，通用 forbidden 类，不冒充「密码错」。 */
const row5 = {
  id: '行5',
  what: '403 ACCOUNT_SUSPENDED（未知 reason）→ 不是凭据错，走通用 forbidden 类',
  raw: () => jsonRaw(403, { code: 403, message: 'account suspended', reason: 'ACCOUNT_SUSPENDED' }),
  entry: 'login',
  expect: { notEquals: 'sub2authCredentialInvalid', textExcludes: '账号或密码错误' },
}

const ROWS = [row1, row2, row3, row4, row5]

/** 表驱动断言器：一行一条 `test()`，红的时候**每行各自**报（不是第一行红了后面全看不见） */
const declare = (row) => {
  test(`${row.id} ${row.what}`, async () => {
    const { key, text, en: enText, error } = await copyOf(row.raw(), row.entry)
    const got = `实际 key=${key} / zh=「${text}」/ en=「${enText}」（kind=${error.kind} status=${error.status} code=${JSON.stringify(error.code)}）`
    if (row.expect.equals !== undefined) {
      assert.equal(key, row.expect.equals, `${row.id} 期望 key=${row.expect.equals}，${got}`)
    }
    if (row.expect.notEquals !== undefined) {
      assert.notEqual(key, row.expect.notEquals, `${row.id} **不许**落到 ${row.expect.notEquals}（403 与凭据无关时不能冒充密码错），${got}`)
    }
    if (row.expect.textIncludes !== undefined) {
      assert.ok(text.includes(row.expect.textIncludes), `${row.id} 文案里应出现「${row.expect.textIncludes}」，${got}`)
    }
    if (row.expect.textExcludes !== undefined) {
      assert.ok(!text.includes(row.expect.textExcludes), `${row.id} 文案里**不许**出现「${row.expect.textExcludes}」，${got}`)
    }
  })
}

for (const row of ROWS) {
  declare(row)
}

// --------------------------------------------------------------------------- 不变量

/**
 * T1（对照组，也是 #735 的核心不变量）：401 / 403-注册关闭 / 403-WAF 这三份**语义完全不同**的回包，
 * 上屏文案必须是三句**互不相同**的话。修复前四条回包全撞成同一句 —— 这就是用户看到的 bug。
 */
test('T1 对照：401、403-REGISTRATION_DISABLED、403-无reason 的文案必须两两不同', async () => {
  const [a, b, d] = await Promise.all([copyOf(row1.raw(), row1.entry), copyOf(row2.raw(), row2.entry), copyOf(row4.raw(), row4.entry)])
  const seen = [
    ['行1 401', a.key],
    ['行2 403 REGISTRATION_DISABLED', b.key],
    ['行4 403 无 reason', d.key],
  ]
  const distinct = new Set(seen.map(([, key]) => key))
  assert.equal(
    distinct.size,
    3,
    `三种语义必须三种文案，实际只有 ${distinct.size} 种：${seen.map(([id, key]) => `${id}→${key}`).join(' / ')}`
  )
  assert.notEqual(a.text, b.text, '「账号或密码错误」不能同时用于 401 与「注册未开放」')
  assert.notEqual(b.text, d.text, '「注册未开放」不能与网关 403 混成一句')
})
