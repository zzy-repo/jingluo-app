// [layer: unit | 依赖: 无（纯 Node + 假 transport + 真 aff.ts / inviteBindModel / invitePanelModel / renderToStaticMarkup，零网络） | 耗时: <1s]
//
// #842「登录后绑定邀请码」前端部分 —— **mock 契约测试，未对真实接口验证**。
// 后端 `POST /api/v1/user/aff/bind` 目前不存在；这里所有 HTTP 都是假 transport，按 #842 正文里的契约回包：
//   200 {"code":0,"message":"success","data":{"inviter_id":123}}
//   400 AFFILIATE_CODE_INVALID / 409 AFFILIATE_ALREADY_BOUND / 403 AFFILIATE_DISABLED / 401 UNAUTHORIZED / 429 限流（无 code）
// 契约若被后端调整，这些用例只证明「前端按本契约写对了」，不证明后端已上线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport, textReply } from '../helpers/consume-fixtures.mjs'

const { translate, zh, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

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

test('mock 契约测试 842：bindInviter 成功 → POST /user/aff/bind，body {aff_code}，带 JWT，返回 inviterId', async () => {
  const { rec, http } = scene({ onBind: () => panelOk({ inviter_id: 123 }) })
  const result = await bindInviter(http, 'ABCD1234')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { inviterId: 123 })
  assert.equal(bindCalls(rec).length, 1)
  const call = bindCalls(rec)[0]
  assert.deepEqual(JSON.parse(call.body), { aff_code: 'ABCD1234' })
  assert.equal(call.headers.Authorization ?? call.headers.authorization, 'Bearer jwt-842-test')
})

test('mock 契约测试 842：bindInviter 成功但 data 里没有 inviter_id（可选字段）也算成功', async () => {
  const { http } = scene({ onBind: () => panelOk({}) })
  const result = await bindInviter(http, 'ABCD1234')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, {})
})

const ERROR_CASES = [
  { name: '400 AFFILIATE_CODE_INVALID', reply: () => jsonReply(400, { code: 'AFFILIATE_CODE_INVALID', message: 'x' }), status: 400, code: 'AFFILIATE_CODE_INVALID', key: 'inviteBindErrInvalid' },
  { name: '409 AFFILIATE_ALREADY_BOUND', reply: () => jsonReply(409, { code: 'AFFILIATE_ALREADY_BOUND', message: 'x' }), status: 409, code: 'AFFILIATE_ALREADY_BOUND', key: 'inviteBindDone' },
  { name: '403 AFFILIATE_DISABLED', reply: () => jsonReply(403, { code: 'AFFILIATE_DISABLED', message: 'x' }), status: 403, code: 'AFFILIATE_DISABLED', key: 'inviteBindErrDisabled' },
  { name: '401 UNAUTHORIZED', reply: () => jsonReply(401, { code: 'UNAUTHORIZED', message: 'Authorization header is required' }), status: 401, code: 'UNAUTHORIZED', key: 'inviteBindErrUnauthorized' },
  { name: '429 限流（无 code 字段）', reply: () => jsonReply(429, { error: 'rate limit exceeded', message: 'slow down' }), status: 429, code: 'HTTP_429', key: 'inviteBindErrRateLimited' },
]

for (const item of ERROR_CASES) {
  test(`mock 契约测试 842：bindInviter ${item.name} → ok:false，不判成功`, async () => {
    const { http } = scene({ onBind: item.reply })
    const result = await bindInviter(http, 'ABCD1234')
    assert.equal(result.ok, false)
    assert.equal(result.error.status, item.status)
    assert.equal(result.error.code, item.code)
    assert.equal(mapBindError(result.error).key, item.key)
  })
}

test('mock 契约测试 842：未识别错误（500 / 纯文本 404）→ 通用失败文案，不是成功也不是别的码', async () => {
  for (const reply of [() => jsonReply(500, { code: 'INTERNAL_ERROR', message: 'x' }), () => textReply(404, '404 page not found')]) {
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
  const { rec, consume } = scene({ onBind: () => panelOk({ inviter_id: 5 }), affs: [AFF_BOUND] })
  const outcome = await runBindInviter({ aff: consume.aff }, '  abcd1234 ')
  assert.equal(outcome.kind, 'bound')
  assert.deepEqual(JSON.parse(bindCalls(rec)[0].body), { aff_code: 'ABCD1234' })
})

test('mock 契约测试 842：runBindInviter 非法字符 / 长度不对 → 不发任何请求，提示格式', async () => {
  const { rec, consume } = scene({ onBind: () => panelOk({}) })
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

test('mock 契约测试 842：runBindInviter 五种错误各不判成功，且除 409 外不切已绑定、不重拉', async () => {
  for (const item of ERROR_CASES) {
    const { rec, consume } = scene({ onBind: item.reply, affs: [AFF_BOUND] })
    const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
    const affGets = rec.calls.filter((c) => c.method === 'GET').length
    if (item.status === 409) {
      assert.equal(outcome.kind, 'bound', '409 = 其实已绑定过 → 切只读')
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

test('mock 契约测试 842：绑定成功 → 重拉 GET /user/aff，新数据带 inviterId，reducer 置 bound', async () => {
  const { rec, consume } = scene({ onBind: () => panelOk({ inviter_id: 123 }), affs: [AFF_BOUND] })
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
    request.method === 'POST' ? panelOk({ inviter_id: 1 }) : jsonReply(503, { code: 503, message: 'down' })
  )
  const consume = createConsumeClient({ transport: rec.transport, accessToken: () => 'jwt-842-test' })
  const outcome = await runBindInviter({ aff: consume.aff }, 'ABCD1234')
  assert.equal(outcome.kind, 'bound')
  assert.equal(outcome.reloaded, null)
  assert.equal(reduceInviteBind(initialInviteBindState(), { type: 'outcome', outcome }).bound, true)
})

// ------------------------------------------------------------------ 面板模型：未绑定 / 已绑定 / 开关

const readyState = async (aff) => {
  const { consume } = scene({ onBind: () => panelOk({}), affs: [aff] })
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
    onBind: () => jsonReply(409, { code: 'AFFILIATE_ALREADY_BOUND', message: 'x' }),
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

test('mock 契约测试 842：失败时表单保留输入并显示对应文案（五种错误文案互不相同且非空）', () => {
  const state = { ...initialInviteBindState(), draft: 'abcd1234' }
  const texts = new Set()
  for (const key of ['inviteBindErrFormat', 'inviteBindErrInvalid', 'inviteBindErrDisabled', 'inviteBindErrUnauthorized', 'inviteBindErrRateLimited', 'inviteBindErrFailed']) {
    const markup = markupOf(
      InviteBindView({ t: translate, c: classNames, Button: ButtonStub, mode: 'form', state: { ...state, errorKey: key }, onDraft() {}, onSubmit() {} })
    )
    assert.ok(hasTestId(markup, 'invite-bind-error'))
    assert.ok(markup.includes('value="abcd1234"'), '失败后输入框内容保留')
    const text = textOf(markup, 'invite-bind-error')
    assert.ok(text.length > 0)
    texts.add(text)
  }
  assert.equal(texts.size, 6)
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
