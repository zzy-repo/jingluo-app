// [layer: unit | 依赖: 无（纯 Node + 真 createConsumeHttp / 真 renderToStaticMarkup + 假 transport，零网络） | 耗时: <1s]
//
// #819 —— 邀请功能「整条不可达」的真根因修复，四条验收钉在这里。
//
// 根因（已定位，别重复排查）：`6d7ab635`（#788）改账号 L2 页时，把原来挂在 `AccountPanel` 里的
// `<InvitePanel …/>` 连同 `import { AccountPanel, QuotaPanel }` 一起换掉了，于是
//   ① 账号页再也没有邀请面板 → `GET /api/v1/user/aff` 一次都没打过；
//   ② `AuthGate` / `RegisterPage` 那条注册链路（邀请码行的宿主）不可达；
//   ③ `SettingsAuthCard` 注册只发 email / password / verify_code，`consume/auth.ts` 里的
//      `invitation_code` 分支永远进不去。
// 本单按 C 类修复：**恢复挂载 + 注册补邀请码字段，开关语义一个字不改**。
//
// 四张表（`①`/`②` 是面板侧，`③`/`④` 是注册表单侧）：
//   ① 已登录 + `invitation_code_enabled=true` → 账号页渲染 `invite-*` 节点，且真的打 `GET /user/aff`；
//   ② 开关 false → **整块隐藏**（DOM 里没有任何 `invite-*`），且不发 / 不渲染（口径见下）；
//   ③ `invitation_code_enabled=true` → 注册分段多一行「邀请码（可选）」，提交体含 `invitation_code`；
//   ④ 开关 false → 那一行不渲染，**哪怕 state 里有值**请求体也不含 `invitation_code`。
//
// 为什么 ① 里的「账号页真的挂了面板」要读源码断言：`.tsx` 在裸 Node 里 import 不了（本仓库 L1 口径），
// 页面外壳本身也只做「选 tab + 递 props」。所以拆成两半并各自可证伪：
//   · 源码断言 = 挂载点存在且 props 口径不变（删掉挂载 → 立刻红，见本单负向对照）；
//   · 模型/视图断言 = 真 `loadInvite` 打真端点 + 真视图渲染出 `invite-*`。
//
// 关于 ② 的「不发请求」：`loadInvite` 刻意**并行**读开关与返利（`invitePanelModel.ts` 文件头：
// 开关读不出来就失败态重试、不猜），所以开关关着时 `GET /user/aff` 仍会发出去，只是结果被丢弃、
// 面板落 `hidden`。这是 #487 既定口径，本单不改成串行（改了等于顺手改行为），断言按现状钉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const { InvitePanelView, inviteStateSignedOut, loadInvite } = await import(
  '../../src/components/consume/invitePanelModel.ts'
)
const { initialAuthCardState, reduceAuthCard, SettingsAuthCardView, submitAuthCard } = await import(
  '../../src/components/consume/settingsAuthCardModel.ts'
)

const JWT = 'jwt-819'

const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/**
 * 去掉注释再断言。
 *
 * 为什么必须去：本单的病因本身就是「`<InvitePanel …/>` 只写在文档注释里」——
 * 直接 `indexOf('<InvitePanel')` 会被文件头注释里的字样骗过（负向对照第一次跑就抓到了这一点）。
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** `GET /user/aff` 的实测形状（staging 0.2.x 原样，只截界面用到的字段） */
const AFF = {
  user_id: 7,
  aff_code: 'INV819',
  aff_count: 3,
  aff_quota: 12.5,
  aff_frozen_quota: 0,
  aff_history_quota: 12.5,
  effective_rebate_rate_percent: 10,
  invitees: [],
}

/**
 * 只认「开关」与「返利」两条端点的场景；别的端点被打到就炸
 * —— 顺手钉住「面板没有偷偷多打一条」。
 */
const inviteScene = ({ invitationCodeEnabled, aff = AFF }) => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'GET' && path === '/api/v1/settings/public') {
      return panelOk({
        registration_enabled: true,
        invitation_code_enabled: invitationCodeEnabled,
        affiliate_enabled: invitationCodeEnabled,
      })
    }
    if (request.method === 'GET' && path === '/api/v1/user/aff') {
      return panelOk(aff)
    }
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const consume = createConsumeClient({ accessToken: () => JWT, transport: recorder.transport })
  return { consume, ...recorder }
}

const inviteRender = (state) =>
  markupOf(
    InvitePanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      copied: false,
      onCopy() {},
      onRetry() {},
    })
  )

/** 注册卡视图（只注入测试关心的开关；其余通道给空实现） */
const authCardRender = (state, { invitationCodeEnabled }) =>
  markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: () => null,
      EyeOffIcon: () => null,
      state,
      submitting: false,
      sendingCode: false,
      countdown: 0,
      errorKey: null,
      registrationLoaded: true,
      registrationEnabled: true,
      invitationCodeEnabled,
      onEvent() {},
      onSubmit() {},
      onSendCode() {},
      onForgotSubmit() {},
      onSkip() {},
    })
  )

const registerState = (over = {}) => ({
  ...initialAuthCardState('register'),
  email: 'invitee@example.com',
  password: 'secret123',
  confirmPassword: 'secret123',
  ...over,
})

/** 注册端点场景：只认 `POST /api/v1/auth/register`，回一个能过 `toAuthSession` 的会话 */
const registerScene = () => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/auth/register') {
      return panelOk({
        access_token: 'access-819',
        refresh_token: 'refresh-819',
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: 9, email: 'invitee@example.com', username: '', role: 'user', status: 'active' },
      })
    }
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const consume = createConsumeClient({ accessToken: () => null, transport: recorder.transport })
  return { register: createAuthTransport(consume).register, ...recorder }
}

// ────────────────────────────────────────────────────────────── ① 已登录 + 开关开

test('① 账号 L2 页真的挂了 <InvitePanel>（不再只出现在文档注释里）', () => {
  const page = readSource('src/components/consume/AccountConsumePage.tsx')
  const start = page.indexOf("if (page === 'account')")
  assert.ok(start > 0, '账号分支必须还在（本单只补挂载，不重排这一页）')
  // 注释要剥掉：本单的病灶就是「面板只写在文档注释里」，带注释搜一定被骗过
  const branch = stripComments(page.slice(start, page.indexOf('L1：列表页', start)))
  assert.ok(branch.length > 0, '账号分支切片要能取到')

  const mount = branch.indexOf('<InvitePanel')
  assert.ok(mount > 0, '账号页必须真的渲染 <InvitePanel …/>（#819 的根因就是这里没有它，注释里写着不算）')
  assert.match(
    branch,
    /<InvitePanel\b[^>]*\bconsume=\{consume\}[^>]*\bsignedIn=\{signedIn === true\}[^>]*\bonSignIn=\{needLogin\}/s,
    'props 口径保持原样：consume / signedIn（严格 true 才算已登录）/ onSignIn（页面既有登录出口）'
  )
  // 顺序：资料区之后、退出登录之前（底稿的版式口径）
  const profile = branch.indexOf('account-consume-profile')
  const signOut = branch.indexOf('data-testid="account-consume-signout"')
  assert.ok(profile > 0 && signOut > 0, '账号页的资料区 / 退出登录行都得在')
  assert.ok(profile < mount && mount < signOut, '邀请面板要夹在资料区与退出登录之间')
  // 反面：页面里不许抄第二份开关（开关只有面板内侧那一处，见 #484 §3.1d）
  assert.ok(
    !/invitationCodeEnabled|affiliateEnabled/.test(branch),
    '页面里不许出现本地开关判断 —— 开关语义留在 invitePanelModel 里'
  )
})

test('① 已登录 + 开关 true → 渲染 invite-* 节点，且真的打了 GET /api/v1/user/aff', async () => {
  const scene = inviteScene({ invitationCodeEnabled: true })
  const state = await loadInvite({ settings: scene.consume.settings, aff: scene.consume.aff })
  assert.equal(state.phase, 'ready', '开关开 + 已登录 → 数据态')
  assert.deepEqual(
    scene.sequence().sort(),
    ['GET /api/v1/settings/public', 'GET /api/v1/user/aff'],
    '两条只读端点各打一次（邀请这条链路真的跑起来了）'
  )
  const affCall = scene.calls.find((request) => pathOf(request.url).startsWith('/api/v1/user/aff'))
  assert.equal(affCall.headers.authorization, `Bearer ${JWT}`, '`/user/aff` 要带 JWT（只进头，不进 query）')

  const markup = inviteRender(state)
  assert.ok(hasTestId(markup, 'invite-panel'), '面板外壳（testid: invite-panel）')
  assert.ok(hasTestId(markup, 'invite-code-value'), '邀请码行（testid: invite-code-value）')
  assert.ok(hasTestId(markup, 'invite-code-copy'), '复制按钮（testid: invite-code-copy）')
  assert.ok(hasTestId(markup, 'invite-stats'), '统计块（testid: invite-stats）')
  assert.match(textOf(markup, 'invite-code-value'), /INV819/, '邀请码原样上屏')
  assert.match(markup, /我的邀请/, '标题用的是挂载后终于被用上的 inviteTitle')
})

// ───────────────────────────────────────────────────── ② 开关 false / 未登录都用同一口径

test('② 开关 false → 整块隐藏：DOM 里没有任何 invite-* 节点', async () => {
  const scene = inviteScene({ invitationCodeEnabled: false })
  const state = await loadInvite({ settings: scene.consume.settings, aff: scene.consume.aff })
  assert.deepEqual(state, { phase: 'hidden' }, '`invitation_code_enabled=false` → hidden（不是置灰、不是报错）')

  const markup = inviteRender(state)
  assert.equal(markup, '', 'hidden 时面板返回 null（容器那一层什么都不渲染）')
  assert.ok(!markup.includes('invite-'), 'DOM 里不许出现任何 invite-* 节点')

  // 现状口径（刻意并行）：开关关着时 aff 这条仍会发出去，只是结果被丢弃 —— 断言按现状钉，
  // 免得下一个人以为「关着就不发」而把 loadInvite 改成串行（那是行为变更，不属本单）。
  assert.ok(
    scene.sequence().includes('GET /api/v1/user/aff'),
    'parallel 读取现状：aff 仍发一次（复用 #487 的既定口径）'
  )
})

test('② 未登录 + 开关 false → 连引导态都不给（与已登录路径同一口径）', () => {
  assert.deepEqual(inviteStateSignedOut({ invitationCodeEnabled: false }), { phase: 'hidden' })
  assert.deepEqual(inviteStateSignedOut({ invitationCodeEnabled: true }), { phase: 'signedOut' })
})

// ─────────────────────────────────────────────────────────── ③ 注册补邀请码字段（开关开）

test('③ invitation_code_enabled=true → 注册分段多一行「邀请码（可选）」，提交体含 invitation_code', async () => {
  const markup = authCardRender(registerState(), { invitationCodeEnabled: true })
  assert.ok(hasTestId(markup, 'settings-auth-invitation'), '注册分段要有邀请码输入（testid: settings-auth-invitation）')
  assert.match(markup, /邀请码（可选）/, '占位文案是「邀请码（可选）」')
  // 只在注册分段：登录 tab 没有这一行（邀请关系只能在注册时填一次）
  const loginMarkup = authCardRender(
    { ...initialAuthCardState('login'), email: 'invitee@example.com', password: 'secret123' },
    { invitationCodeEnabled: true }
  )
  assert.ok(!hasTestId(loginMarkup, 'settings-auth-invitation'), '登录分段不出现邀请码')

  // 输入能进 state（与验证码同一条事件通路），切 tab 也不会丢
  const typed = reduceAuthCard(registerState(), { type: 'invitation-code', value: 'INV819' })
  assert.equal(typed.invitationCode, 'INV819')
  const backToRegister = reduceAuthCard(
    reduceAuthCard(typed, { type: 'mode', mode: 'login' }),
    { type: 'mode', mode: 'register' }
  )
  assert.equal(backToRegister.invitationCode, 'INV819', '注册 → 登录 → 注册 不该把码弄丢')

  // 提交：submitAuthCard → AuthTransport.register → consume.auth.register → 真 http（全链路）
  const scene = registerScene()
  const events = await submitAuthCard(
    { signUp: scene.register, signIn: async () => ({}), forgotPassword: async () => ({}) },
    typed,
    { submitting: false, registrationLoaded: true, registrationEnabled: true, invitationCodeEnabled: true }
  )
  assert.deepEqual(events, [{ type: 'form-submitted' }], '注册请求发出后落「已提交」')
  assert.deepEqual(scene.sequence(), ['POST /api/v1/auth/register'], '只打注册这一条')
  const body = JSON.parse(scene.calls[0].body)
  assert.equal(body.invitation_code, 'INV819', '请求体里的字段名是 snake_case invitation_code')
  assert.equal(body.email, 'invitee@example.com')
  assert.equal('confirmPassword' in body, false, '确认密码仍然不进请求体（#797）')
})

// ───────────────────────────────────────────────────────── ④ 开关 false 时不渲染、也不进请求体

test('④ invitation_code_enabled=false → 没有这一行，请求体也不含 invitation_code（哪怕 state 有值）', async () => {
  const markup = authCardRender(registerState({ invitationCode: 'INV819' }), { invitationCodeEnabled: false })
  assert.ok(!hasTestId(markup, 'settings-auth-invitation'), '开关关着 → 这一行不渲染（与现状一致）')
  assert.ok(!markup.includes('邀请码（可选）'), '连占位文案都不该出现')

  const scene = registerScene()
  await submitAuthCard(
    { signUp: scene.register, signIn: async () => ({}), forgotPassword: async () => ({}) },
    registerState({ invitationCode: 'INV819' }),
    { submitting: false, registrationLoaded: true, registrationEnabled: true, invitationCodeEnabled: false }
  )
  const body = JSON.parse(scene.calls[0].body)
  assert.equal('invitation_code' in body, false, '开关关着 → 请求体里没有 invitation_code 这个键')
  assert.equal(body.email, 'invitee@example.com', '注册本身照常发（开关只管邀请码这一栏）')
})

test('④ 开关开但留空 → 也不进请求体（「可选」不是「必填」）', async () => {
  const scene = registerScene()
  await submitAuthCard(
    { signUp: scene.register, signIn: async () => ({}), forgotPassword: async () => ({}) },
    registerState(),
    { submitting: false, registrationLoaded: true, registrationEnabled: true, invitationCodeEnabled: true }
  )
  const body = JSON.parse(scene.calls[0].body)
  assert.equal('invitation_code' in body, false, '没填就不传这个键（不是传空串）')
})
