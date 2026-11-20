// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + renderToStaticMarkup + 源码断言） | Issue #608]
//
// **账户是可选能力**（#608 拆掉登录墙）—— 这条用例钉的是「墙真的没了，且没把功能拆坏」：
//
//  ① 入口：`src/main.tsx` 直接渲染 `<App/>`，没有任何 `<AuthGate>` 包裹；启动恢复是**后台静默**
//     （`void restoreAuth().catch(() => {})`，没有 await、没有「未登录就换整屏」的分支）；
//  ② 局部化：`AuthGate` 没删，但降级成「账号区的一块卡」（`variant="inline"` + 表单 `embedded`），
//     由 `AccountPanel` 在**未登录时**挂载，登录 / 注册表单与 `sub2auth*` 文案仍是既有那一份；
//  ③ 未登录的三个面板都**不报错、不空白、不发请求**：账号区给引导 + 「去填 API Key」主 CTA，
//     额度 / 邀请给「登录后可查看…」+ 登录出口；
//  ④ 已登录路径一字未改（同一批 `run*` / `reduce*`，本文件只补未登录那一半）。
//
// 为什么既有源码断言又有渲染断言：`.tsx`（main / AuthGate / AccountPanel 容器）裸 Node import 不了
// （JSX 不在类型擦除范围内），接线只能读源码；「用户看到什么」全部在 `.ts` 的视图函数里，
// 用真 zh 文案表 `renderToStaticMarkup` 跑**真代码**。两层缺一不可：只测视图挡不住「墙还在」，
// 只测源码挡不住「引导态渲染成报错」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf, zh } = await setupAuthPanels()

const { AccountSignedOutView } = await import('../../src/components/consume/accountPanelModel.ts')
const { QuotaPanelView, quotaStateFor } = await import('../../src/components/consume/quotaPanelModel.ts')
const { InvitePanelView, inviteStateSignedOut } = await import('../../src/components/consume/invitePanelModel.ts')

const ROOT = path.resolve(import.meta.dirname, '../..')
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/**
 * 在 React 元素树里按 `testId` 找那个按钮（`ButtonStub` 把 testId 透成 data-testid）。
 *
 * 为什么不用 `markupOf` 就够：静态 HTML 能证明「按钮在、文案对」，但证明不了「点它会不会真的
 * 去填 Key / 去登录」—— 那正是 #608 的主 CTA 语义。所以这里直接走元素树拿到 `onClick` 并调用。
 */
const findButton = (node, testId) => {
  if (node === null || typeof node !== 'object') {
    return null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButton(item, testId)
      if (found !== null) {
        return found
      }
    }
    return null
  }
  if (node.props !== undefined && node.props.testId === testId) {
    return node
  }
  return findButton(node.props === undefined ? null : node.props.children, testId)
}

// ---------------------------------------------------------------- ① 入口：墙没了

test('main.tsx 不再用 AuthGate 包住整个应用：直接渲染 <App/>', () => {
  const main = sourceOf('src/main.tsx')
  assert.equal(/<AuthGate[\s/>]/u.test(main), false, '登录墙不许再出现在入口里（#608 的核心）')
  assert.equal(
    /from '\.\/components\/auth\/AuthGate\.js'/u.test(main),
    false,
    '入口连 AuthGate 都不该 import：它只在账号区内部使用'
  )
  assert.match(main, /<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/u, '入口必须直接渲染 <App/>（错误边界保留）')
})

test('启动恢复是后台静默：不 await、失败吞咽、不挡首屏', () => {
  const main = sourceOf('src/main.tsx')
  // 静默：失败一律吞掉（返回 void 的 Promise 上 .catch 就是那句「不打扰用户」）
  assert.match(main, /void restoreAuth\(\)\.catch\(\(\) => \{\}\)/u, '恢复必须静默：失败不许冒到启动路径')
  // 不阻塞：await 会把首屏交给网络
  assert.equal(/await restoreAuth/u.test(main), false, '恢复不许 await（那就是把首屏卡在网络上）')
  // 顺序：render 在前、恢复在后（先出界面，再去问登录态）
  const renderIndex = main.indexOf('createRoot(')
  const restoreIndex = main.indexOf('void restoreAuth()')
  assert.notEqual(renderIndex, -1, '入口必须 createRoot')
  assert.notEqual(restoreIndex, -1, '入口必须触发后台恢复')
  assert.ok(restoreIndex < renderIndex, '恢复的接线必须写在 render 附近（同一段启动代码），且不 await')
  // 接缝构建（只可能是测试产物）里不许恢复：盘上没有凭据，恢复会把假会话清成未登录
  assert.match(main, /if \(typeof __TEST_AUTH_STATE__ === 'undefined'\)/u, '接缝构建里必须跳过 restoreAuth')
})

test('AuthGate 保留下来，但降级为「账号区的局部卡」：inline 形态 + 表单 embedded', () => {
  const gate = sourceOf('src/components/auth/AuthGate.tsx')
  assert.match(gate, /variant\?: 'page' \| 'inline'/u, 'AuthGate 必须支持局部（inline）形态')
  assert.match(gate, /embedded=\{inline\}/u, '表单要按形态换容器，但不许复制第二套表单')
  assert.match(gate, /styles\.inlineLoading/u, '局部形态的「正在检查登录状态」必须有占位')
  // 既有的表单 / 开关接线一条都不许丢（g11 与 auth L1 依赖这几行）
  for (const literal of [
    'showRegisterEntry={flags.registrationEnabled}',
    'if (!flags.registrationEnabled && mode === \'register\')',
    "authState === 'authenticated'",
    'if (!restored)',
  ]) {
    assert.ok(gate.includes(literal), `AuthGate 丢了一句既有接线：${literal}`)
  }
})

test('登录 / 注册页只多一个 embedded 形态，没有第二套表单', () => {
  for (const file of ['src/components/auth/LoginPage.tsx', 'src/components/auth/RegisterPage.tsx']) {
    const source = sourceOf(file)
    assert.match(source, /embedded\?: boolean/u, `${file} 必须声明 embedded`)
    assert.match(source, /styles\.embedded : styles\.page/u, `${file} 的容器按形态切换`)
  }
})

// ---------------------------------------------------------------- ② 账号区：未登录引导

const signedOutProps = (over = {}) => ({
  t: translate,
  c: classNames,
  Button: ButtonStub,
  auth: createElement('div', { 'data-testid': 'auth-slot-stub' }),
  onFillKey() {},
  ...over,
})

test('账号区未登录：一句话说明「不登录也能用」+ 得失 + 主 CTA 是填 Key', () => {
  const markup = markupOf(AccountSignedOutView(signedOutProps()))

  assert.equal(hasTestId(markup, 'account-panel'), true, '未登录也要是同一个「账号」面板（不是空白 / 不是报错）')
  assert.equal(hasTestId(markup, 'account-optional-notice'), true, '顶部必须有那句「不登录也可以…」')
  assert.ok(
    markup.includes(zh.accountOptionalHint),
    `顶部文案必须逐字是维护者的定调：${zh.accountOptionalHint}`
  )
  assert.ok(markup.includes(zh.accountOptionalStatusLoggedOut), '当前态必须是「未登录」，不是「登录已失效」')
  assert.equal(markup.includes(zh.consumeNeedLogin), false, '从没登录过不是故障：不许显示「登录状态已失效」')
  assert.equal(hasTestId(markup, 'account-profile-error'), false, '未登录不许渲染错误块')

  // 能得到什么 / 不会失去什么
  assert.equal(hasTestId(markup, 'account-benefits'), true, '必须写清登录后多出什么（余额 / Key / 邀请）')
  for (const key of ['accountOptionalBenefitBalance', 'accountOptionalBenefitKeys', 'accountOptionalBenefitInvite']) {
    assert.ok(markup.includes(zh[key]), `得失清单缺一条：${zh[key]}`)
  }
  assert.ok(markup.includes(zh.accountOptionalKeep), '必须说清「不登录一样不少」的是什么')

  // 主 CTA：填 Key（不是登录）
  assert.equal(hasTestId(markup, 'account-fill-key'), true, '主 CTA 必须是「去填 API Key」')
  assert.ok(markup.includes(zh.accountFillKeyCta), '主 CTA 文案必须是填 Key')
  const calls = []
  const fill = findButton(
    AccountSignedOutView(signedOutProps({ onFillKey: () => calls.push('fill-key') })),
    'account-fill-key'
  )
  assert.notEqual(fill, null, '主 CTA 必须真的渲染成按钮')
  fill.props.onClick()
  assert.deepEqual(calls, ['fill-key'], '点主 CTA 必须真的跳到「去填 Key」那条路')
})

test('账号区未登录：登录 / 注册卡是**局部**挂载，不是一个独立登录页', () => {
  const markup = markupOf(AccountSignedOutView(signedOutProps()))
  assert.equal(hasTestId(markup, 'account-auth-card'), true, '未登录态必须有登录 / 注册入口')
  assert.equal(markup.includes('auth-slot-stub'), true, '那块卡由容器注入（AuthGate inline），本视图不重写表单')
  assert.ok(markup.includes(zh.accountOptionalLoginEntry), '登录入口要有「可选」二字的标题')
})

test('容器接线：AccountPanel 只在已登录时拉数据，未登录挂 inline 登录卡', () => {
  const panel = sourceOf('src/components/consume/AccountPanel.tsx')
  assert.match(panel, /if \(signedIn\) \{\s*reload\(\)/u, '未登录不许发 profile()/keys.list()（只会 401）')
  assert.match(panel, /if \(!signedIn\) \{\s*return AccountSignedOutView\(/u, '未登录必须走引导视图')
  assert.match(panel, /<AuthGate variant="inline" \/>/u, '登录 / 注册卡必须是 AuthGate 的局部形态（复用既有表单）')
  assert.match(panel, /signedIn=\{signedIn\}/u, '邀请面板要知道登录态（未登录给引导，不发请求）')
})

// ---------------------------------------------------------------- ③ 额度 / 邀请：未登录引导态

const quotaView = (quota, extra = {}) =>
  markupOf(
    QuotaPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      quota,
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle() {},
      onLoadMore() {},
      onRetryQuota() {},
      onRetryUsage() {},
      onSignIn() {},
      ...extra,
    })
  )

test('额度未登录：引导态（不是报错、不是空白），且一个请求都不发', () => {
  let asked = 0
  const source = {
    hasApiKey: () => {
      asked += 1
      return true
    },
    usage: { gateway: async () => assert.fail('未登录不许打 /v1/usage'), list: async () => assert.fail('未登录不许打用量') },
  }
  assert.deepEqual(quotaStateFor(source, false), { phase: 'anonymous' }, '未登录必须落 anonymous 档')
  assert.equal(asked, 0, '未登录时连「有没有 Key」都不该问（那条路的结论用不上）')
  // 恢复中（真实登录态还不知道）先给 loading，别先喊「未登录」
  assert.equal(quotaStateFor(source, null).phase, 'loading', '恢复期间必须给 loading，不能提前判未登录')

  const markup = quotaView({ phase: 'anonymous' })
  assert.equal(hasTestId(markup, 'quota-signed-out'), true, '未登录的额度必须有引导块')
  assert.ok(markup.includes(zh.quotaNeedLoginTitle), '引导标题必须说「登录后可查看额度」')
  assert.equal(hasTestId(markup, 'quota-error'), false, '未登录不是错误态')
  assert.equal(hasTestId(markup, 'quota-sign-in'), true, '引导里必须有一个「去登录」出口')
  const signInCalls = []
  const signIn = findButton(
    QuotaPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      quota: { phase: 'anonymous' },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle() {},
      onLoadMore() {},
      onRetryQuota() {},
      onRetryUsage() {},
      onSignIn: () => signInCalls.push('sign-in'),
    }),
    'quota-sign-in'
  )
  assert.notEqual(signIn, null, '「去登录」必须是真按钮')
  signIn.props.onClick()
  assert.deepEqual(signInCalls, ['sign-in'], '点「去登录」必须真的交给外壳（切到账号 tab）')
})

test('邀请未登录：引导态而不是报错；功能没开则整块隐藏', () => {
  assert.deepEqual(inviteStateSignedOut({ invitationCodeEnabled: true }), { phase: 'signedOut' })
  assert.deepEqual(
    inviteStateSignedOut({ invitationCodeEnabled: false }),
    { phase: 'hidden' },
    '部署方没开邀请：未登录也不许露一个死入口（与已登录路径同一口径）'
  )

  const markup = markupOf(
    InvitePanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state: { phase: 'signedOut' },
      copied: false,
      onCopy() {},
      onRetry() {},
      onSignIn() {},
    })
  )
  assert.ok(markup.includes(zh.inviteNeedLoginTitle), '未登录的邀请必须给引导标题')
  assert.equal(hasTestId(markup, 'invite-error'), false, '未登录不是错误态')
  assert.equal(hasTestId(markup, 'invite-sign-in'), true, '引导里必须有一个「去登录」出口')
  assert.ok(markup.includes(zh.inviteNeedLoginBody), '引导正文要说清「邀请码与返利跟着账号走」')
})

test('已登录的额度 / 账号视图没被这次改动碰坏（同一套 render 仍然出原来的块）', () => {
  const ready = quotaView({
    phase: 'ready',
    data: {
      mode: 'wallet',
      isValid: true,
      balance: 11.5,
      unit: 'CNY',
      spent: 0.5,
      usageTotal: { requests: 3, totalTokens: 30, actualCost: 0.5 },
    },
  })
  assert.equal(hasTestId(ready, 'quota-stats'), true, '已登录照旧出三个数')
  assert.equal(hasTestId(ready, 'quota-signed-out'), false, '已登录不该出现未登录引导')
})

test('文案成对：新增的 #608 key 在 zh / en 都在，且占位符对齐', () => {
  const keys = [
    'accountOptionalHint',
    'accountOptionalStatusLoggedOut',
    'accountOptionalStatusLoggedIn',
    'accountOptionalBenefitsTitle',
    'accountOptionalBenefitBalance',
    'accountOptionalBenefitKeys',
    'accountOptionalBenefitInvite',
    'accountOptionalKeep',
    'accountOptionalLoginEntry',
    'accountOptionalChecking',
    'accountFillKeyCta',
    'accountFillKeyHint',
    'accountSignInCta',
    'quotaNeedLoginTitle',
    'quotaNeedLoginBody',
    'inviteNeedLoginTitle',
    'inviteNeedLoginBody',
  ]
  const en = sourceOf('src/i18n/en.ts')
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.match(en, new RegExp(`\\n  ${key}: `, 'u'), `en 缺 ${key}`)
  }
  // 只有「已登录」那条带占位符，两边必须同一个名字
  assert.equal((zh.accountOptionalStatusLoggedIn.match(/\{(\w+)\}/gu) ?? []).join(','), '{email}')
  assert.match(en, /accountOptionalStatusLoggedIn: '[^']*\{email\}'/u)
})
