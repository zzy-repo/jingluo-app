// [layer: unit | 依赖: 无（纯 Node + 真 createConsumeHttp / 真 renderToStaticMarkup + 假 transport，零网络） | 耗时: <1s]
//
// #839 / #841 / #842 —— 邀请码从注册表单挪到「我的邀请」里**一次性绑定**。
//
// ⚠️ 本文件**只证明客户端按 #842 契约写对了**：`POST /api/v1/user/aff/bind` 在后端**还没上线**，
// 这里的服务端回应全是假 transport 按契约捏的，**不是**真机 / 真后端验证。后端上线后要用真环境再跑一遍。
//
// 五张表：
//   ① 请求：POST /api/v1/user/aff/bind，带 JWT，体 `{code}`（去空白 + 大写），且只打这一条；
//   ② 错误：契约里的三个业务码 + 401 + 429 + 未上线的 404 都落成「可上屏的 i18n key」，不显示服务端原文；
//   ③ 视图：未绑定 → 有输入框与「绑定」按钮；已绑定（inviter_id 有值）→ 只读「已绑定邀请人」；`bind` 不传 → 没有入口；
//   ④ 提交逻辑：空串不发请求；成功 → ok；失败 → 带 `error.i18nKey`；
//   ⑤ 接线 / 删除：两句说明从面板与文案表里删了，注册表单没有邀请码，白名单有这条新路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { InvitePanelView, loadInvite, runBindInviter } = await import(
  '../../src/components/consume/invitePanelModel.ts'
)
const { PATH_WHITELIST } = await import('../../scripts/lib/consumeApiAudit.mjs')

const JWT = 'jwt-839'
const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const AFF = {
  user_id: 7,
  aff_code: 'MINE0001',
  aff_count: 3,
  aff_quota: 12.5,
  aff_frozen_quota: 0,
  aff_history_quota: 12.5,
  effective_rebate_rate_percent: 20,
  invitees: [],
}

/** 契约（#842）里 `/user/aff/bind` 的几种回应；`GET /user/aff` 恒回 AFF（可带 inviter_id） */
const bindScene = (reply) => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/user/aff/bind') {
      return reply(request)
    }
    if (request.method === 'GET' && path === '/api/v1/user/aff') {
      return panelOk(AFF)
    }
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const consume = createConsumeClient({ accessToken: () => JWT, transport: recorder.transport })
  return { consume, ...recorder }
}

const rejection = (status, reason) => () => jsonReply(status, { code: status, message: 'server english text', reason })

const bindForm = (over = {}) => ({
  draft: '',
  busy: false,
  error: null,
  onDraft() {},
  onSubmit() {},
  ...over,
})

const render = (state, bind) =>
  markupOf(
    InvitePanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      bind,
      copied: false,
      onCopy() {},
      onRetry() {},
    })
  )

const ready = (over = {}) => ({
  phase: 'ready',
  data: { code: 'MINE0001', count: 3, rebateBalance: 12.5, frozenBalance: 0, ...over },
})

// ───────────────────────────────────────────────────────────── ① 请求形状

test('① 绑定：POST /api/v1/user/aff/bind，带 JWT，体是 {code}（去空白 + 大写），只打这一条', async () => {
  const scene = bindScene(() => panelOk({ inviter_id: 42 }))
  const result = await scene.consume.aff.bind('  abc-123 ')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { inviterId: 42 }, '契约：200 { inviter_id }')
  assert.deepEqual(scene.sequence(), ['POST /api/v1/user/aff/bind'])
  const call = scene.calls[0]
  assert.equal(call.headers.authorization, `Bearer ${JWT}`, 'JWT 只进头')
  assert.deepEqual(JSON.parse(call.body), { code: 'ABC-123' }, '去空白 + 转大写（契约：4–32 位 A-Z0-9_-，服务端也会归一）')
  assert.equal(pathOf(call.url).includes('?'), false, '邀请码不进 query')
})

test('① 200 但没给 inviter_id 也算成功（客户端随后重读 GET /user/aff 取准）', async () => {
  const scene = bindScene(() => panelOk({}))
  const result = await scene.consume.aff.bind('ABCD')
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, {})
})

// ───────────────────────────────────────────────────────────── ② 错误映射

test('② 契约里的错误码都落成可上屏的 i18n key（不显示服务端 message）', async () => {
  const cases = [
    [400, 'AFFILIATE_CODE_INVALID', 'consumeErrInvitationInvalid', '邀请码无效，请核对后再填'],
    [409, 'AFFILIATE_ALREADY_BOUND', 'consumeErrAffiliateAlreadyBound', '你已经绑定过邀请人，不能再改'],
    [403, 'AFFILIATE_DISABLED', 'consumeErrNotEnabled', '这个功能还没开放，请联系客服开通'],
  ]
  for (const [status, reason, key, zhText] of cases) {
    const scene = bindScene(rejection(status, reason))
    const result = await scene.consume.aff.bind('ABCD')
    assert.equal(result.ok, false, reason)
    assert.equal(result.error.i18nKey, key, `${reason} → ${key}`)
    assert.equal(result.error.retryable, false, `${reason} 不可重试（重试只会再被拒）`)
    assert.equal(translate(key), zhText)
    assert.equal(translate(key).includes('server english text'), false, '不显示服务端英文原文')
  }
})

test('② 429 / 401 / 后端还没上线（404）：各有明确的下一步，不当成「成功」', async () => {
  const limited = await bindScene(() =>
    jsonReply(429, { error: 'rate limit exceeded', message: 'x' })
  ).consume.aff.bind('ABCD')
  assert.equal(limited.ok, false)
  assert.equal(limited.error.i18nKey, 'consumeErrRateLimited')

  const unauth = await bindScene(() => jsonReply(401, { code: 'UNAUTHORIZED', message: 'x' })).consume.aff.bind('ABCD')
  assert.equal(unauth.ok, false)
  assert.equal(unauth.error.i18nKey, 'consumeErrUnauthorized')

  // 接口没上线：未知路径 404 是 text/plain（#487 实测）
  const missing = await bindScene(() => ({
    kind: 'response',
    status: 404,
    text: '404 page not found',
    headers: { 'content-type': 'text/plain' },
  })).consume.aff.bind('ABCD')
  assert.equal(missing.ok, false, '后端没上线时必须如实失败，不假装绑定成功')
  // 纯文本 404 在现有全局映射里本来就落「这次请求没成功…反复出现请反馈」（`keyFromStatus`），本单不改全局口径
  assert.equal(missing.error.i18nKey, 'consumeErrUnknown')
  assert.equal(missing.error.code, 'HTTP_404')
  assert.equal(missing.error.retryable, false)
})

// ───────────────────────────────────────────────────────────── ③ 视图三态

test('③ 未绑定 + 入口放开 → 有输入框、绑定按钮与「只能绑定一次」；没有任何旧的两句说明', () => {
  const markup = render(ready(), bindForm({ draft: 'ABCD' }))
  assert.ok(hasTestId(markup, 'invite-bind'), '入口块')
  assert.ok(hasTestId(markup, 'invite-bind-input'), '输入框')
  assert.ok(hasTestId(markup, 'invite-bind-submit'), '绑定按钮')
  assert.ok(markup.includes(translate('inviteBindOnce')), '说清只能绑定一次')
  assert.ok(markup.includes(translate('inviteBindTitle')))
  assert.ok(!hasTestId(markup, 'invite-bound'))
  // #841：旧的两句
  assert.ok(!hasTestId(markup, 'invite-semantics') && !hasTestId(markup, 'invite-rate'))
  assert.ok(!markup.includes('注册时填写邀请码') && !markup.includes('结算'))
})

test('③ 已绑定（inviter_id 有值）→ 只读「已绑定邀请人」，没有输入框 / 按钮（一次性，不给改）', () => {
  const markup = render(ready({ inviterId: 42 }), bindForm())
  assert.ok(hasTestId(markup, 'invite-bound'))
  assert.match(textOf(markup, 'invite-bound'), /已绑定邀请人/)
  assert.ok(!hasTestId(markup, 'invite-bind'), '已绑定 → 入口消失')
  assert.ok(!hasTestId(markup, 'invite-bind-input'))
})

test('③ 调用方没放开（bind 不传）→ 没有入口，也没有「已绑定」之外的新节点', () => {
  const markup = render(ready(), undefined)
  assert.ok(!hasTestId(markup, 'invite-bind'))
  assert.ok(hasTestId(markup, 'invite-code-value'), '邀请码 / 人数 / 返利照常')
})

test('③ 提交失败 → 入口里显示 i18n 文案；busy → 输入与按钮禁用', () => {
  const error = { i18nKey: 'consumeErrAffiliateAlreadyBound', retryable: false, needLogin: false, code: 'AFFILIATE_ALREADY_BOUND' }
  const failed = render(ready(), bindForm({ draft: 'ABCD', error }))
  assert.ok(hasTestId(failed, 'invite-bind-error'))
  assert.ok(failed.includes('你已经绑定过邀请人，不能再改'))

  const busy = render(ready(), bindForm({ draft: 'ABCD', busy: true }))
  assert.match(busy, /data-testid="invite-bind-submit"[^>]*disabled|disabled[^>]*data-testid="invite-bind-submit"/u)
  const empty = render(ready(), bindForm({ draft: '   ' }))
  assert.match(empty, /data-testid="invite-bind-submit"[^>]*disabled|disabled[^>]*data-testid="invite-bind-submit"/u, '空输入不能点')
})

test('③ GET /user/aff 带 inviter_id → loadInvite 落「已绑定」，不带 → 未绑定', async () => {
  const bound = createConsumeClient({
    accessToken: () => JWT,
    transport: recordingTransport(() => panelOk({ ...AFF, inviter_id: 42 })).transport,
  })
  const state = await loadInvite({ aff: bound.aff })
  assert.equal(state.phase, 'ready')
  assert.equal(state.data.inviterId, 42)

  const unbound = createConsumeClient({
    accessToken: () => JWT,
    transport: recordingTransport(() => panelOk(AFF)).transport,
  })
  const state2 = await loadInvite({ aff: unbound.aff })
  assert.equal(state2.data.inviterId, undefined)
})

// ───────────────────────────────────────────────────────────── ④ 提交逻辑

test('④ 空 / 全空白 → 不发请求，直接落「邀请码无效」', async () => {
  const scene = bindScene(() => panelOk({ inviter_id: 1 }))
  for (const code of ['', '   ']) {
    const result = await runBindInviter({ aff: scene.consume.aff }, code)
    assert.equal(result.ok, false)
    assert.equal(result.error.i18nKey, 'inviteCodeInvalid')
    assert.equal(result.error.code, 'CLIENT_VALIDATION')
  }
  assert.deepEqual(scene.sequence(), [], '本地拦下，不吃服务端 10/min 的限流')
})

test('④ 成功 → ok；服务端拒绝 → 带 error.i18nKey', async () => {
  const good = bindScene(() => panelOk({ inviter_id: 9 }))
  assert.deepEqual(await runBindInviter({ aff: good.consume.aff }, 'abcd'), { ok: true })

  const bad = bindScene(rejection(400, 'AFFILIATE_CODE_INVALID'))
  const result = await runBindInviter({ aff: bad.consume.aff }, 'abcd')
  assert.equal(result.ok, false)
  assert.equal(result.error.i18nKey, 'consumeErrInvitationInvalid')
})

// ───────────────────────────────────────────────────────────── ⑤ 删除与接线

test('⑤ 两句说明的文案 key 在 zh / en 里都没了（不留孤儿 key）', () => {
  for (const file of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
    const source = readSource(file)
    assert.equal(/inviteCodeAtRegister|inviteRebateRate|settingsAuthInvitePlaceholder/.test(source), false, file)
  }
  const model = readSource('src/components/consume/invitePanelModel.ts')
  assert.equal(/inviteCodeAtRegister|inviteRebateRate/.test(model.replace(/\/\*[\s\S]*?\*\//gu, '')), false)
})

test('⑤ 新增的文案 zh / en 成对存在', () => {
  const zh = readSource('src/i18n/zh.ts')
  const en = readSource('src/i18n/en.ts')
  for (const key of [
    'inviteBindTitle',
    'inviteBindPlaceholder',
    'inviteBindSubmit',
    'inviteBindDone',
    'inviteBindOnce',
    'consumeErrAffiliateAlreadyBound',
  ]) {
    assert.ok(new RegExp(`\\b${key}:`).test(zh), `zh 缺 ${key}`)
    assert.ok(new RegExp(`\\b${key}:`).test(en), `en 缺 ${key}`)
  }
})

test('⑤ 注册表单（SettingsAuthCard / RegisterPage / AuthGate）已无邀请码；白名单有新路径', () => {
  for (const file of [
    'src/components/consume/SettingsAuthCard.tsx',
    'src/components/consume/settingsAuthCardModel.ts',
    'src/components/auth/RegisterPage.tsx',
    'src/components/auth/AuthGate.tsx',
    'src/components/auth/authForm.ts',
  ]) {
    assert.equal(/invitationCode|invitation-code|settings-auth-invitation/.test(readSource(file).replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')), false, `${file} 里不许再有邀请码`)
  }
  assert.ok(PATH_WHITELIST.includes('/api/v1/user/aff/bind'), '#484 白名单要有 /user/aff/bind（#842）')
})

test('⑤ 容器：入口开关只来自 canBind，且绑定成功后重读 GET /user/aff（以服务端为准）', () => {
  const source = readSource('src/components/consume/InvitePanel.tsx').replace(/\/\*[\s\S]*?\*\//gu, '')
  assert.match(source, /canBind = false/, '默认不开放入口')
  assert.match(source, /signedIn && canBind/, '未登录不给入口')
  assert.ok(/runBindInviter\(/.test(source) && /reload\(\)/.test(source), '成功后 reload()')
  assert.equal(/getAuthFlags|useAuthFlags/.test(source), false, '容器不自己读开关（#830 / #819-v2 的钉法不变）')
})
