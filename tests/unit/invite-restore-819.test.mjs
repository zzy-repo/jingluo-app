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
//   ① 已登录 → 账号页渲染 `invite-*` 节点，且真的（且**只**）打 `GET /user/aff`；
//   ② 可见性判据 = 已登录 + `GET /user/aff` 成功且带 `aff_code`；`invitation_code_enabled=false`
//      **不再**让面板消失（staging 实测正是这个组合：开关 false、`/user/aff` 200 有真数据），
//      只有「服务端没给邀请码」才落 `hidden`；
//   ③ `invitation_code_enabled=true` → 注册分段多一行「邀请码（可选）」，提交体含 `invitation_code`；
//   ④ 开关 false → 那一行不渲染，**哪怕 state 里有值**请求体也不含 `invitation_code`。
//
// **#819-v2（本文件的第二次口径变更，2026-11-22）**：上一版把面板可见性绑在
// `invitation_code_enabled` 上，于是「注册页能不能填码」= 「登录后有没有邀请码可看」，两个语义被混成一个；
// staging 上开关 false + `/user/aff` 200（`aff_code` 有值）→ 面板判 `hidden` → 维护者与群用户都看不到邀请码。
// 现在可见性只看 aff 那条链路，`invitation_code_enabled` **只**管注册页那一行（① ② 改判据，③ ④ 一字未动）。
//
// 为什么 ① 里的「账号页真的挂了面板」要读源码断言：`.tsx` 在裸 Node 里 import 不了（本仓库 L1 口径），
// 页面外壳本身也只做「选 tab + 递 props」。所以拆成两半并各自可证伪：
//   · 源码断言 = 挂载点存在且 props 口径不变（删掉挂载 → 立刻红，见本单负向对照）；
//   · 模型/视图断言 = 真 `loadInvite` 打真端点 + 真视图渲染出 `invite-*`。
//
// 关于 ② 的请求口径：`loadInvite` **只**读 `GET /user/aff`（#819-v2 起不再并行读 `settings/public` ——
// 那个开关已经不参与可见性判断，继续读它只会让「面板显不显示」看起来又跟开关有关）。断言从
// 「两条只读端点各打一次」收紧成「只打 aff 这一条」：少打一条是更强的钉法，不是放宽。
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

test('① 已登录 → 渲染 invite-* 节点，且只打了 GET /api/v1/user/aff（不再问开关）', async () => {
  const scene = inviteScene({ invitationCodeEnabled: true })
  const state = await loadInvite({ aff: scene.consume.aff })
  assert.equal(state.phase, 'ready', '已登录 + aff 有码 → 数据态')
  assert.deepEqual(
    scene.sequence().sort(),
    ['GET /api/v1/user/aff'],
    '只打 aff 这一条只读端点（邀请这条链路真的跑起来了，#819-v2 起不再读 settings/public）'
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

test('② `invitation_code_enabled=false`（staging 实测组合）→ 面板**照旧出现**：可见性不再被开关决定', async () => {
  // 现场事实（维护者给的）：settings/public 里 invitation_code_enabled=false、affiliate_enabled=false，
  // 但 GET /user/aff 200 且 aff_code 有值。旧判据在这里落 hidden → 整块消失（本单要修的 bug）。
  const scene = inviteScene({ invitationCodeEnabled: false })
  const state = await loadInvite({ aff: scene.consume.aff })
  assert.equal(state.phase, 'ready', 'aff 有码 → 数据态（开关为 false 也一样）')

  const markup = inviteRender(state)
  assert.ok(hasTestId(markup, 'invite-panel'), '面板外壳必须在')
  assert.match(textOf(markup, 'invite-code-value'), /INV819/, '邀请码要真的上屏（不再是"整块消失"）')
  assert.ok(hasTestId(markup, 'invite-stats'), '已邀请人数 / 返利余额块必须在')

  // 反向钉：这条路径**不许**再问 settings/public（否则可见性又和开关耦合回去了）
  assert.deepEqual(scene.sequence(), ['GET /api/v1/user/aff'], '开关 false 时也只打 aff 一条（不读 settings/public）')
})

test('② 拿到 aff 但服务端没给 aff_code → 才是 hidden（没有可展示的邀请码，不摆空壳）', async () => {
  const scene = inviteScene({ invitationCodeEnabled: true, aff: { ...AFF, aff_code: '' } })
  const state = await loadInvite({ aff: scene.consume.aff })
  assert.deepEqual(state, { phase: 'hidden' }, 'aff 成功但没有邀请码 → hidden（不是置灰、不是报错）')

  const markup = inviteRender(state)
  assert.equal(markup, '', 'hidden 时面板返回 null（容器那一层什么都不渲染）')
  assert.ok(!markup.includes('invite-'), 'DOM 里不许出现任何 invite-* 节点')
})

test('② aff 请求失败 → failed（不猜「有」也不猜「没有」）#819 的病根', async () => {
  const state = await loadInvite({
    aff: {
      detail: async () => ({
        ok: false,
        error: { status: 503, code: 'HTTP_503', i18nKey: 'consumeErrServerUnavailable', retryable: true },
      }),
    },
  })
  assert.equal(state.phase, 'failed', '读不到 aff → 失败态 + 重试（不是 hidden，否则用户以为自己的码没了）')
  assert.ok(hasTestId(inviteRender(state), 'invite-error'), '失败态要渲染可重试的错误块')
})

test('② 未登录 → 一律引导态（与开关无关，且不发请求）', () => {
  assert.deepEqual(inviteStateSignedOut(), { phase: 'signedOut' })
  const markup = inviteRender(inviteStateSignedOut())
  assert.ok(hasTestId(markup, 'invite-signed-out'), '未登录给引导，不是错误也不是隐藏')
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
