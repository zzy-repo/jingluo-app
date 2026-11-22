// [layer: unit | 依赖: 无（纯 Node + 真 inviteBindModel / invitePanelModel / flags / renderToStaticMarkup，零网络） | 耗时: <1s]
//
// #860 条件 3 的折中（只补这一点）：`settings/public.affiliate_enabled` **已读到且为 false** 时，只藏「填写邀请人」入口
// （此时 `POST /user/aff/bind` 必然 400 AFFILIATE_DISABLED）；面板可见性仍只由 `GET /user/aff` 决定（#838 / #819-v2），
// 面板其余内容（邀请码 / 人数 / 返利 / 名额 / 划转）一个都不许跟着消失。
// 没读到开关（含 settings/public 读失败返回 null）不等于关闭：只认服务端明确写的 affiliate_enabled:false。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId } = await setupAuthPanels()

const { InvitePanelView } = await import('../../src/components/consume/invitePanelModel.ts')
const { InviteBindView, initialInviteBindState, inviteBindMode } = await import(
  '../../src/components/consume/inviteBindModel.ts'
)
const { CONSERVATIVE_AUTH_FLAGS, loadAuthFlags, parseAuthFlags, setPublicSettingsReader, useAuthFlags } = await import(
  '../../src/services/auth/flags.ts'
)

const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

const ready = (inviterId) => ({
  phase: 'ready',
  data: { code: 'MINE0860', count: 3, rebateBalance: 2.5, frozenBalance: 0, remaining: 5, ...(inviterId === undefined ? {} : { inviterId }) },
})

test('① affiliateClosed=true：未绑定时「填写邀请人」整块 hidden（没有 invite-bind-*）', () => {
  assert.equal(inviteBindMode({ enabled: true, state: ready(), bound: false, affiliateClosed: true }), 'hidden')
})

test('① 没关闭（false / 不传）→ 表单照常；已绑定只读不受影响', () => {
  assert.equal(inviteBindMode({ enabled: true, state: ready(), bound: false, affiliateClosed: false }), 'form')
  assert.equal(inviteBindMode({ enabled: true, state: ready(), bound: false }), 'form', '不传 = 未关闭（既有调用方式不变）')
  assert.equal(inviteBindMode({ enabled: true, state: ready(77), bound: false, affiliateClosed: true }), 'bound')
  assert.equal(inviteBindMode({ enabled: true, state: ready(), bound: true, affiliateClosed: true }), 'bound')
})

test('② affiliate_enabled=false：面板其余内容仍在，只少了填写区', () => {
  const render = (affiliateClosed) => {
    const state = ready()
    const mode = inviteBindMode({ enabled: true, state, bound: false, affiliateClosed })
    const bindSlot = InviteBindView({
      t: translate, c: classNames, Button: ButtonStub, mode, state: initialInviteBindState(), onDraft() {}, onSubmit() {},
    })
    return markupOf(
      InvitePanelView({
        t: translate, c: classNames, Button: ButtonStub, state, copied: false, onCopy() {}, onRetry() {}, bindSlot,
        transfer: { state: { busy: false, done: false, errorKey: null }, onTransfer() {} },
      })
    )
  }
  const open = render(false)
  assert.ok(hasTestId(open, 'invite-bind-form'), '对照：开关没关时表单在')
  const closed = render(true)
  assert.ok(!closed.includes('invite-bind-'), '开关关闭：没有任何 invite-bind-* 节点')
  assert.ok(closed.includes('MINE0860'), '邀请码本身要上屏')
  for (const id of ['invite-panel', 'invite-code-value', 'invite-stats', 'invite-count', 'invite-rebate', 'invite-transfer']) {
    assert.ok(hasTestId(closed, id), `${id} 仍在（面板可见性与 affiliate_enabled 无关）`)
  }
})

test('③ 开关来源：只认明确的 affiliate_enabled:false；没读到 / 缺字段 / 读失败都不当成关闭', async () => {
  assert.equal(parseAuthFlags({ data: { affiliate_enabled: false } }).affiliateDisabled, true)
  assert.equal(parseAuthFlags({ affiliateEnabled: false }).affiliateDisabled, true)
  assert.equal(parseAuthFlags({ data: { affiliate_enabled: true } }).affiliateDisabled, false)
  assert.equal(parseAuthFlags({ data: {} }).affiliateDisabled, false, '字段缺失 ≠ 关闭')
  assert.equal(parseAuthFlags({ data: { affiliate_enabled: 'false' } }).affiliateDisabled, false, '非布尔 ≠ 关闭')
  assert.equal(parseAuthFlags({ data: { affiliate_enabled: 0 } }).affiliateDisabled, false)
  assert.equal(parseAuthFlags(null).affiliateDisabled, false)
  assert.equal(CONSERVATIVE_AUTH_FLAGS.affiliateDisabled, false)

  // 与 InvitePanel 里同一条表达式：`flags.affiliateDisabled`
  const closed = () => useAuthFlags.getState().affiliateDisabled
  setPublicSettingsReader(null)
  await loadAuthFlags()
  assert.equal(closed(), false, '没接线 → 不算关闭')
  setPublicSettingsReader(async () => {
    throw new Error('settings/public unreachable')
  })
  await loadAuthFlags()
  assert.equal(closed(), false, '读取抛错 → 不算关闭')
  // 生产 reader（`createPublicSettingsReader`）读失败时返回 null、不抛错 —— loadAuthFlags 会落 loaded:true + 全 false：
  // 这正是「settings/public 偶发超时」的真实形状，产物级曾因此误藏表单（`!affiliateEnabled` 的写法会在这里红）
  setPublicSettingsReader(async () => null)
  await loadAuthFlags()
  assert.equal(useAuthFlags.getState().loaded, true, '前提：null 读取也会 loaded=true')
  assert.equal(closed(), false, '读取失败返回 null → 不算关闭，表单照常')
  setPublicSettingsReader(async () => ({ data: { affiliate_enabled: false, registration_enabled: true } }))
  await loadAuthFlags()
  assert.equal(closed(), true, '明确 false → 关闭')
  setPublicSettingsReader(async () => ({ data: { affiliate_enabled: true } }))
  await loadAuthFlags()
  assert.equal(closed(), false, '明确 true → 不关闭')
  setPublicSettingsReader(null)
})

test('④ 接线：affiliateClosed 只进入 inviteBindMode；面板模型 / 页面不读开关（#838 解耦不变）', () => {
  const panel = stripComments(readSource('src/components/consume/InvitePanel.tsx'))
  assert.match(panel, /useAuthFlags\(\(flags\) => flags\.affiliateDisabled\)/u, '只认明确的 false（读失败返回 null 时 loaded 也是 true，不能用 !affiliateEnabled）')
  assert.match(panel, /inviteBindMode\(\{[^}]*\baffiliateClosed\b[^}]*\}\)/u, '开关只喂给 inviteBindMode')
  assert.equal((panel.match(/affiliateClosed/gu) || []).length, 2, 'affiliateClosed 只出现在「定义」与「传给 inviteBindMode」两处')
  const model = stripComments(readSource('src/components/consume/invitePanelModel.ts'))
  assert.ok(!/affiliateDisabled|affiliateClosed|useAuthFlags/u.test(model), '面板可见性模型不碰 settings/public')
  const page = stripComments(readSource('src/components/consume/AccountConsumePage.tsx'))
  assert.ok(!/affiliateDisabled|useAuthFlags/u.test(page), '页面里不抄第二份开关')
})
