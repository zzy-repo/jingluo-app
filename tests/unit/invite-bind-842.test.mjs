// [layer: unit | 依赖: 无（纯 Node + 假 transport + 真 aff.ts / inviteBindModel / invitePanelModel / renderToStaticMarkup，零网络） | 耗时: <1s]
//
// #842「登录后绑定邀请码」前端部分 —— **mock 契约测试；形状按 #856 的 staging 实测（2026-11-22）**。
// 这里所有 HTTP 都是假 transport，按实测契约回包：
//   200 {"code":0,"message":"success","data":{"bound":true}}                       （没有 inviter_id）
//   400 {"code":400,"message":"…","reason":"AFFILIATE_CODE_INVALID" | "AFFILIATE_DISABLED"}
//   409 {"code":409,"message":"…","reason":"AFFILIATE_ALREADY_BOUND" | "AFFILIATE_INVITER_FULL"}
//   401 {"code":"UNAUTHORIZED","message":"Authorization header is required"}       （中间件，没有 reason）
//   400 空码 {"code":400,"message":"Invalid request: Key: 'BindAffiliateInviterRequest.AffCode' …"}（没有 reason）
// staging 上 affiliate_enabled=false，成功 / 409 / 名额满 / 码无效四条路径真实联调不到，只有这里的 mock 覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport, textReply } from '../helpers/consume-fixtures.mjs'

const { translate, zh, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { en } = await import('../../src/i18n/en.ts')
const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { bindInviter } = await import('../../src/services/consume/aff.ts')
const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { InvitePanelView, initialInviteState, loadInvite } = await import(
  '../../src/components/consume/invitePanelModel.ts'
)
const {
  INVITE_BIND_ENABLED,
  InviteBindView,
  initialInviteBindState,
  inviteBindMode,
  mapBindError,
  normalizeInviteCode,
  reduceInviteBind,
  runBindInviter,
} = await import('../../src/components/consume/inviteBindModel.ts')
const { PATH_WHITELIST } = await import('../../scripts/lib/consumeApiAudit.mjs')

// 实测形状工厂（面板信封：整数 code + reason；message 是英文句子，绝不该上屏）
const panelErr = (status, reason) => jsonReply(status, { code: status, message: `server text for ${reason}`, reason })
const BOUND_OK = () => panelOk({ bound: true })

const BIND_PATH = '/api/v1/user/aff/bind'
const AFF_PATH = '/api/v1/user/aff'

const AFF_UNBOUND = {
  user_id: 7,
  aff_code: 'MINE0007',
  aff_count: 0,
  aff_quota: 0,
  aff_frozen_quota: 0,
  aff_history_quota: 0,
  invitees: [],
}
const AFF_BOUND = { ...AFF_UNBOUND, inviter_id: 123 }

/** 假后端：POST bind 按 `onBind` 回；GET aff 按 `affs` 依次回（最后一个重复） */
const scene = ({ onBind, affs = [AFF_UNBOUND] }) => {
  let affIndex = 0
  const rec = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === BIND_PATH) {
      return onBind(request)
    }
    if (request.method === 'GET' && path === AFF_PATH) {
      const body = affs[Math.min(affIndex, affs.length - 1)]
      affIndex += 1
      return panelOk(body)
    }
    return jsonReply(404, { code: 404, message: 'not found' })
  })
  const http = createConsumeHttp({ transport: rec.transport, accessToken: () => 'jwt-842-test' })
  const consume = createConsumeClient({ transport: rec.transport, accessToken: () => 'jwt-842-test' })
  return { rec, http, consume }
}

const bindCalls = (rec) => rec.calls.filter((c) => c.method === 'POST' && pathOf(c.url).split('?')[0] === BIND_PATH)

// ------------------------------------------------------------------ bindInviter（服务层）

// 改动原因（#856 实测）：成功体是 `{"bound":true}`，不再有 `inviter_id`；原断言 `{ inviterId: 123 }` 对应旧契约。
test('mock 契约测试 842：bindInviter 成功 → POST /user/aff/bind，body {aff_code}，带 JWT，返回 bound:true', async () => {
  const { rec, http } = scene({ onBind: BOUND_OK })
  const result = await bindInviter(http, 'ABCD1234')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { bound: true })
  assert.equal(bindCalls(rec).length, 1)
  const call = bindCalls(rec)[0]
  assert.deepEqual(JSON.parse(call.body), { aff_code: 'ABCD1234' })
  assert.equal(call.headers.Authorization ?? call.headers.authorization, 'Bearer jwt-842-test')
})

// 改动原因（#856 实测）：旧用例「data 里没有 inviter_id 也算成功」对应旧契约的可选字段；新契约成功 = `data.bound === true`，
// 所以这条换成它的反面：2xx 但没有 bound:true（空 data / bound:false / 非布尔）解析成 `bound:false`，不是成功。
test('mock 契约测试 842：bindInviter 2xx 但 data.bound 不是 true（空 data / false / "true" / 1）→ bound:false，且 data.inviter_id 不被采信', async () => {
  for (const data of [{}, { bound: false }, { bound: 'true' }, { bound: 1 }, { inviter_id: 123 }]) {
    const { http } = scene({ onBind: () => panelOk(data) })
    const result = await bindInviter(http, 'ABCD1234')
    assert.equal(result.ok, true)
    assert.deepEqual(result.data, { bound: false }, JSON.stringify(data))
  }
})

// 改动原因（#856 实测）：①错误按 `reason` 映射（面板信封 `{code:<整数>, reason}`），不再是中间件的字符串 code；
// ②`AFFILIATE_DISABLED` 实测是 400（旧用例写的 403）；③新增 `AFFILIATE_INVITER_FULL`（409）；
// ④后端没有限流，429 不再是契约内的错误（保留为「通用分支」的单独用例，见下）；401 仍是中间件 `UNAUTHORIZED`（无 reason）。
const ERROR_CASES = [
  { name: '400 AFFILIATE_CODE_INVALID', reply: () => panelErr(400, 'AFFILIATE_CODE_INVALID'), status: 400, reason: 'AFFILIATE_CODE_INVALID', key: 'inviteBindErrInvalid' },
  { name: '409 AFFILIATE_ALREADY_BOUND', reply: () => panelErr(409, 'AFFILIATE_ALREADY_BOUND'), status: 409, reason: 'AFFILIATE_ALREADY_BOUND', key: 'inviteBindDone' },
  { name: '400 AFFILIATE_DISABLED（实测是 400，不是 403）', reply: () => panelErr(400, 'AFFILIATE_DISABLED'), status: 400, reason: 'AFFILIATE_DISABLED', key: 'inviteBindErrDisabled' },
  { name: '409 AFFILIATE_INVITER_FULL', reply: () => panelErr(409, 'AFFILIATE_INVITER_FULL'), status: 409, reason: 'AFFILIATE_INVITER_FULL', key: 'inviteBindErrFull' },
  { name: '401 UNAUTHORIZED（中间件，无 reason）', reply: () => jsonReply(401, { code: 'UNAUTHORIZED', message: 'Authorization header is required' }), status: 401, code: 'UNAUTHORIZED', key: 'inviteBindErrUnauthorized' },
]

for (const item of ERROR_CASES) {
  test(`mock 契约测试 842：bindInviter ${item.name} → ok:false，不判成功`, async () => {
    const { http } = scene({ onBind: item.reply })
    const result = await bindInviter(http, 'ABCD1234')
    assert.equal(result.ok, false)
    assert.equal(result.error.status, item.status)
    assert.equal(result.error.reason ?? result.error.code, item.reason ?? item.code)
    assert.equal(mapBindError(result.error).key, item.key)
  })
}

// 新增：只认 reason、不按状态码 —— 后端以后把 AFFILIATE_DISABLED 改成 403 时前端不受影响；同一状态码不同 reason 文案不同。
test('mock 契约测试 842：映射只看 reason，不看 HTTP 状态码（DISABLED 400/403 都对；409 的两个 reason 不混）', async () => {
  for (const status of [400, 403]) {
    const { http } = scene({ onBind: () => panelErr(status, 'AFFILIATE_DISABLED') })
    const result = await bindInviter(http, 'ABCD1234')
    assert.equal(mapBindError(result.error).key, 'inviteBindErrDisabled', `status ${status}`)
  }
  assert.equal(mapBindError({ code: 'AFFILIATE_INVITER_FULL', reason: 'AFFILIATE_INVITER_FULL', status: 409 }).key, 'inviteBindErrFull')
  assert.equal(mapBindError({ code: 'AFFILIATE_ALREADY_BOUND', reason: 'AFFILIATE_ALREADY_BOUND', status: 409 }).alreadyBound, true)
  assert.equal(mapBindError({ code: 'AFFILIATE_INVITER_FULL', reason: 'AFFILIATE_INVITER_FULL', status: 409 }).alreadyBound, false, '名额满不是已绑定')
})

// 新增：实测的空码 400（无 reason）与 5xx 一律通用失败，且错误对象里的服务端 message 不会成为文案。
test('mock 契约测试 842：无 reason 的 400（空码）→ 通用失败，不是成功、不是「码无效」、不暴露 message', async () => {
  const body = { code: 400, message: "Invalid request: Key: 'BindAffiliateInviterRequest.AffCode' Error:Field validation for 'AffCode' failed on the 'required' tag" }
  const { http } = scene({ onBind: () => jsonReply(400, body) })
  const result = await bindInviter(http, 'ABCD1234')
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, undefined)
  assert.deepEqual(mapBindError(result.error), { key: 'inviteBindErrFailed', alreadyBound: false })
  for (const lang of [zh, en]) {
    assert.ok(!String(lang[mapBindError(result.error).key]).includes('BindAffiliateInviterRequest'))
  }
})

// 保留（429 不在契约里，但通用分支仍在）：无 code 的 429 → 「稍后再试」，不是成功。
test('mock 契约测试 842：429（后端目前没有限流，通用分支）→ 稍后再试，不判成功', async () => {
  const { http } = scene({ onBind: () => jsonReply(429, { error: 'rate limit exceeded', message: 'slow down' }) })
  const result = await bindInviter(http, 'ABCD1234')
  assert.equal(result.ok, false)
  assert.equal(mapBindError(result.error).key, 'inviteBindErrRateLimited')
})

// 新增：2xx 但体里没有 bound:true（或是旧契约的 inviter_id 体）→ runBindInviter 判失败，不切只读、不重拉。
// 这条同时是「成功改回读 data.inviter_id → 用例红」的负向对照：若实现读 inviter_id，{inviter_id:123} 会被判成功，这里变红。
test('mock 契约测试 842：runBindInviter 2xx 但无 bound:true（含 {inviter_id:123}）→ failed，不重拉、不置 bound', async () => {
  for (const data of [{}, { bound: false }, { inviter_id: 123 }]) {
    const { rec, consume } = scene({ onBind: () => panelOk(data), affs: [AFF_BOUND] })
    const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
    assert.deepEqual(outcome, { kind: 'failed', key: 'inviteBindErrFailed' }, JSON.stringify(data))
    assert.equal(rec.calls.filter((c) => c.method === 'GET').length, 0)
    assert.equal(reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome }).bound, false)
  }
})

test('mock 契约测试 842：未识别错误（500 / 纯文本 404）→ 通用失败文案，不是成功也不是别的码', async () => {
  for (const reply of [() => jsonReply(500, { code: 'INTERNAL_ERROR', message: 'x' }), () => jsonReply(500, { code: 500, message: 'boom' }), () => textReply(404, '404 page not found')]) {
    const { http } = scene({ onBind: reply })
    const result = await bindInviter(http, 'ABCD1234')
    assert.equal(result.ok, false)
    assert.deepEqual(mapBindError(result.error), { key: 'inviteBindErrFailed', alreadyBound: false })
  }
})

// ------------------------------------------------------------------ 客户端轻量校验

test('mock 契约测试 842：normalizeInviteCode：trim + 转大写；4–32 位 A-Z0-9_- 才放行', () => {
  assert.deepEqual(normalizeInviteCode('  abcd_12-x '), { ok: true, code: 'ABCD_12-X' })
  assert.deepEqual(normalizeInviteCode('ABCD'), { ok: true, code: 'ABCD' })
  assert.deepEqual(normalizeInviteCode('A'.repeat(32)), { ok: true, code: 'A'.repeat(32) })
  for (const bad of ['', '   ', 'abc', 'A'.repeat(33), 'AB CD', 'AB!CD', '邀请码邀请码', 'ab.cd']) {
    assert.deepEqual(normalizeInviteCode(bad), { ok: false }, `应判非法：${JSON.stringify(bad)}`)
  }
})

test('mock 契约测试 842：runBindInviter 小写输入自动转大写后才发请求', async () => {
  const { rec, consume } = scene({ onBind: BOUND_OK, affs: [AFF_BOUND] })
  const outcome = await runBindInviter({ aff: consume.aff }, '  abcd1234 ')
  assert.equal(outcome.kind, 'bound')
  assert.deepEqual(JSON.parse(bindCalls(rec)[0].body), { aff_code: 'ABCD1234' })
})

test('mock 契约测试 842：runBindInviter 非法字符 / 长度不对 → 不发任何请求，提示格式', async () => {
  const { rec, consume } = scene({ onBind: BOUND_OK })
  for (const bad of ['', 'ab', 'AB CD', 'A$B#C', 'X'.repeat(40)]) {
    const outcome = await runBindInviter({ aff: consume.aff }, bad)
    assert.deepEqual(outcome, { kind: 'invalid' })
    const next = reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome })
    assert.equal(next.errorKey, 'inviteBindErrFormat')
    assert.equal(next.bound, false)
  }
  assert.equal(rec.calls.length, 0, '客户端校验不过时一个请求都不该发')
})

// ------------------------------------------------------------------ 提交流程 / 状态

test('mock 契约测试 842：runBindInviter 五种错误（含名额满）各不判成功，且除 409 外不切已绑定、不重拉', async () => {
  for (const item of ERROR_CASES) {
    const { rec, consume } = scene({ onBind: item.reply, affs: [AFF_BOUND] })
    const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
    const affGets = rec.calls.filter((c) => c.method === 'GET').length
    if (item.reason === 'AFFILIATE_ALREADY_BOUND') {
      // 改动原因：旧写法按 `status === 409` 判「已绑定」；#856 新增的 409 `AFFILIATE_INVITER_FULL` 不是已绑定，必须按 reason 区分。
      assert.equal(outcome.kind, 'bound', '409 ALREADY_BOUND = 其实已绑定过 → 切只读')
      assert.equal(outcome.alreadyBound, true)
      assert.equal(affGets, 1, '409 后要重新拉一次 GET /user/aff')
      assert.equal(outcome.reloaded?.phase, 'ready')
      continue
    }
    assert.equal(outcome.kind, 'failed', `${item.name} 不许判成功`)
    assert.equal(outcome.key, item.key)
    assert.equal(affGets, 0, `${item.name} 不该重拉`)
    const next = reduceInviteBind({ ...initialInviteBindState(), busy: true }, { type: 'outcome', outcome })
    assert.equal(next.bound, false)
    assert.equal(next.errorKey, item.key)
    assert.equal(next.busy, false)
  }
})

test('mock 契约测试 842：绑定成功（bound:true）→ 重拉 GET /user/aff，新数据带 inviterId，reducer 置 bound', async () => {
  const { rec, consume } = scene({ onBind: BOUND_OK, affs: [AFF_BOUND] })
  const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
  assert.equal(outcome.kind, 'bound')
  assert.equal(outcome.alreadyBound, false)
  assert.equal(outcome.reloaded.data.inviterId, 123)
  assert.deepEqual(rec.sequence(), [`POST ${BIND_PATH}`, `GET ${AFF_PATH}`])
  const next = reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome })
  assert.equal(next.bound, true)
  assert.equal(next.errorKey, null)
})

test('mock 契约测试 842：重拉 GET /user/aff 失败不推翻「已绑定」（reloaded 为 null，bound 仍为 true）', async () => {
  const rec = recordingTransport((request) =>
    request.method === 'POST' ? panelOk({ bound: true }) : jsonReply(503, { code: 503, message: 'down' })
  )
  const consume = createConsumeClient({ transport: rec.transport, accessToken: () => 'jwt-842-test' })
  const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
  assert.equal(outcome.kind, 'bound')
  assert.equal(outcome.reloaded, null)
  assert.equal(reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome }).bound, true)
})

// ------------------------------------------------------------------ 面板模型：未绑定 / 已绑定 / 开关

const readyState = async (aff) => {
  const { consume } = scene({ onBind: BOUND_OK, affs: [aff] })
  return loadInvite({ aff: { detail: consume.aff.detail } })
}

const renderPanel = (state, mode, bindState = initialInviteBindState()) => {
  const bindSlot = InviteBindView({
    t: translate,
    c: classNames,
    Button: ButtonStub,
    mode,
    state: bindState,
    onDraft() {},
    onSubmit() {},
  })
  return markupOf(
    InvitePanelView({ t: translate, c: classNames, Button: ButtonStub, state, copied: false, onCopy() {}, onRetry() {}, bindSlot })
  )
}

test('mock 契约测试 842：开关打开 + 未绑定（无 inviter_id）→ 显示输入框 + 提交按钮', async () => {
  const state = await readyState(AFF_UNBOUND)
  assert.equal(state.data.inviterId, undefined)
  const mode = inviteBindMode({ enabled: true, state, bound: false })
  assert.equal(mode, 'form')
  const markup = renderPanel(state, mode)
  assert.ok(hasTestId(markup, 'invite-bind-form'))
  assert.ok(hasTestId(markup, 'invite-bind-input'))
  assert.ok(hasTestId(markup, 'invite-bind-submit'))
  assert.ok(!hasTestId(markup, 'invite-bind-done'))
  assert.ok(hasTestId(markup, 'invite-code-value'), '原有「我的邀请码」展示不受影响')
})

test('mock 契约测试 842：开关打开 + 已绑定（inviter_id 有值）→ 只读，不出输入框，不显示邀请人信息', async () => {
  const state = await readyState(AFF_BOUND)
  assert.equal(state.data.inviterId, 123)
  const mode = inviteBindMode({ enabled: true, state, bound: false })
  assert.equal(mode, 'bound')
  const markup = renderPanel(state, mode)
  assert.ok(hasTestId(markup, 'invite-bind-done'))
  assert.equal(textOf(markup, 'invite-bind-done').includes(zh.inviteBindDone), true)
  assert.ok(!hasTestId(markup, 'invite-bind-input'))
  assert.ok(!hasTestId(markup, 'invite-bind-submit'))
  assert.ok(!markup.includes('123'), '只表示「已绑定」，不展示邀请人 id')
})

test('mock 契约测试 842：inviter_id 为 0 视为未绑定', async () => {
  const state = await readyState({ ...AFF_UNBOUND, inviter_id: 0 })
  assert.equal(inviteBindMode({ enabled: true, state, bound: false }), 'form')
})

test('mock 契约测试 842：开关关闭 → 整个区块不出现（没有任何 invite-bind-* 节点）', async () => {
  assert.equal(INVITE_BIND_ENABLED, false, '默认必须关闭：后端接口未上线')
  for (const aff of [AFF_UNBOUND, AFF_BOUND]) {
    const state = await readyState(aff)
    const mode = inviteBindMode({ enabled: false, state, bound: false })
    assert.equal(mode, 'hidden')
    const markup = renderPanel(state, mode)
    assert.ok(!markup.includes('invite-bind'), '关闭时 DOM 里不许有 invite-bind-*')
    assert.ok(hasTestId(markup, 'invite-code-value'), '面板其余内容照旧')
  }
})

test('mock 契约测试 842：非数据态（hidden / 未登录 / 加载失败）即使开关打开也不出现入口', async () => {
  const failed = { phase: 'failed', error: { i18nKey: 'consumeErrUnknown', retryable: true, needLogin: false, code: 'X' } }
  for (const state of [initialInviteState(), { phase: 'signedOut' }, { phase: 'loading' }, failed]) {
    assert.equal(inviteBindMode({ enabled: true, state, bound: false }), 'hidden')
  }
})

test('mock 契约测试 842：ALREADY_BOUND 后面板切只读（本地 bound=true 即使 GET 还没带 inviter_id）', async () => {
  const { consume } = scene({
    onBind: () => panelErr(409, 'AFFILIATE_ALREADY_BOUND'),
    affs: [AFF_BOUND],
  })
  const before = await readyState(AFF_UNBOUND)
  assert.equal(inviteBindMode({ enabled: true, state: before, bound: false }), 'form')
  const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
  const next = reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome })
  assert.equal(next.bound, true)
  assert.equal(next.errorKey, null, '409 不显示成「失败」，直接进只读')
  assert.equal(inviteBindMode({ enabled: true, state: before, bound: next.bound }), 'bound')
  assert.equal(inviteBindMode({ enabled: true, state: outcome.reloaded, bound: false }), 'bound', '重拉的数据里也带 inviter_id')
})

// 改动原因：新增文案 key `inviteBindErrFull`，互不相同的集合从 6 条变 7 条（断言 `size` 同步，不是放宽）。
test('mock 契约测试 842：失败时表单保留输入并显示对应文案（七种错误文案互不相同且非空，zh / en 成对）', () => {
  const state = { ...initialInviteBindState(), draft: 'abcd1234' }
  const texts = new Set()
  for (const key of ['inviteBindErrFormat', 'inviteBindErrInvalid', 'inviteBindErrDisabled', 'inviteBindErrFull', 'inviteBindErrUnauthorized', 'inviteBindErrRateLimited', 'inviteBindErrFailed']) {
    const markup = markupOf(
      InviteBindView({ t: translate, c: classNames, Button: ButtonStub, mode: 'form', state: { ...state, errorKey: key }, onDraft() {}, onSubmit() {} })
    )
    assert.ok(hasTestId(markup, 'invite-bind-error'))
    assert.ok(markup.includes('value="abcd1234"'), '失败后输入框内容保留')
    const text = textOf(markup, 'invite-bind-error')
    assert.ok(text.length > 0)
    texts.add(text)
  }
  assert.equal(texts.size, 7)
})

// ------------------------------------------------------------------ 白名单 / 源码落位

test('mock 契约测试 842：白名单含 POST /api/v1/user/aff/bind', () => {
  assert.ok(PATH_WHITELIST.includes(BIND_PATH))
})

test('mock 契约测试 842：InvitePanel 的入口默认值取 INVITE_BIND_ENABLED（不是写死 true）', () => {
  const source = readFileSync(new URL('../../src/components/consume/InvitePanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /bindEnabled = INVITE_BIND_ENABLED/u)
  const model = readFileSync(new URL('../../src/components/consume/inviteBindModel.ts', import.meta.url), 'utf8')
  assert.match(model, /export const INVITE_BIND_ENABLED = false\b/u)
  const mounts = readFileSync(new URL('../../src/components/consume/AccountConsumePage.tsx', import.meta.url), 'utf8')
  assert.ok(!/bindEnabled/u.test(mounts), '挂载点不得传 bindEnabled 上线入口')
})

// 新增：zh 与 en 都有每个绑定文案 key，且任何文案都不含原始 `AFFILIATE_*` 错误码（不给用户看机器码）。
test('mock 契约测试 842：inviteBind* 文案 zh / en 成对，且不含原始 AFFILIATE_ 码或服务端 message', () => {
  const keys = Object.keys(zh).filter((k) => k.startsWith('inviteBind'))
  assert.ok(keys.includes('inviteBindErrFull'))
  assert.deepEqual(keys.sort(), Object.keys(en).filter((k) => k.startsWith('inviteBind')).sort())
  for (const key of keys) {
    for (const lang of [zh, en]) {
      assert.ok(typeof lang[key] === 'string' && lang[key].length > 0, key)
      assert.ok(!/AFFILIATE_|BindAffiliateInviterRequest/u.test(lang[key]), key)
    }
  }
  assert.notEqual(zh.inviteBindErrDisabled, zh.inviteBindErrFailed, 'DISABLED 单独一条文案，不是通用失败')
  assert.notEqual(en.inviteBindErrDisabled, en.inviteBindErrFailed)
})

// B 自检发现（提交中按钮文案仍是「提交」，只剩一个变灰的按钮）：提交中按钮换成进行中文案（同时 disabled）；输入框禁用。
test('mock 契约测试 842：提交中 → 按钮文案「提交中…」+ disabled，输入框禁用；空闲时文案是「提交」', () => {
  const render = (busy) =>
    markupOf(
      InviteBindView({ t: translate, c: classNames, Button: ButtonStub, mode: 'form', state: { ...initialInviteBindState(), draft: 'ABCD1234', busy }, onDraft() {}, onSubmit() {} })
    )
  const busyMarkup = render(true)
  assert.ok(textOf(busyMarkup, 'invite-bind-submit').includes(zh.inviteBindSubmitting))
  assert.ok(!/>提交</u.test(busyMarkup), '提交中按钮不再显示空闲文案「提交」')
  assert.match(busyMarkup, /data-testid="invite-bind-submit"[^>]*disabled|disabled[^>]*data-testid="invite-bind-submit"/u)
  assert.match(busyMarkup, /data-testid="invite-bind-input"[^>]*disabled|disabled[^>]*data-testid="invite-bind-input"/u)
  const idle = render(false)
  assert.ok(/>提交</u.test(idle), '空闲时按钮文案是「提交」')
  assert.ok(!idle.includes(zh.inviteBindSubmitting))
  assert.notEqual(zh.inviteBindSubmitting, zh.inviteBindSubmit)
  assert.notEqual(en.inviteBindSubmitting, en.inviteBindSubmit)
})
