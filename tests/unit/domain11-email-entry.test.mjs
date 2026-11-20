// [layer: unit —— 组件级（真弹层组件 + 真 device.ts，假传输），零浏览器 | 耗时: <2s]
// Issue #421 第 4、5 点：设置页邮箱入口的出现条件与备份提示分流。
// 域 11 落位（#438）：L0 组件级的一半 —— 入口**显隐**与备份提示分流只在这里断言；
// 绑定之后的「备份提示消失」在 L1（tests/integration/domain11-email-flow.test.mjs）验。
//
// 三件事必须成立，缺一条用户就会看到不该看的东西：
//   1. 服务端没开邮箱功能（404 + `not_found`）→ **入口整块不渲染**，旧流程一个字不变；
//   2. 已绑 → 显示脱敏邮箱 `email_masked`、不再给「绑定邮箱」按钮；未绑 → 只给「绑定邮箱」；
//   3. 已绑邮箱的用户**不再**被提示「复制设备码备份」（账号可以靠邮箱找回，前提变了）。
//
// 服务端邮箱功能只在开发分支（#421 正文），本文件全部用假传输，**不发任何真请求**；
// 真机端到端（发码 → 收信 → 登录）目前无法验证，也不在这里假装验证。
//
//   node --test tests/unit/domain11-email-entry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource('src/components/settings/OursServicesDialog.tsx')
const { DEVICE_ID_STORAGE_KEY, DEVICE_BACKUP_HINT_KEY } = await harness.importSource(
  'src/services/invite/device.ts'
)
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-77777777777777777777777777777777'
const KEY = 'sk-ours-device-code-0011223344556677'
const MASKED = 'e***@example.com'

const profile = (extra = {}) => ({
  invite_code: 'K3M9QW2P',
  invited_count: 0,
  max_invites: 3,
  bonus_points: 0,
  redeemed: false,
  quota_points: 300,
  used_points: 0,
  remaining_points: 300,
  key_status: 'active',
  device_id: DEVICE,
  ...extra,
})

/**
 * 统一准备：`/me` 回显请求里的 device_id，`/email/status` 回 `emailStatus` 给定的结果。
 * 其余路径一律报错（宁可红，也不许悄悄打到别的接口）。
 */
const prepare = ({ emailStatus, body = null, hintSeen = null }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  globalThis.localStorage.setItem(DEVICE_ID_STORAGE_KEY, DEVICE)
  if (hintSeen !== null) {
    globalThis.localStorage.setItem(DEVICE_BACKUP_HINT_KEY, hintSeen)
  }
  harness.ctx.oursOpen = true
  harness.ctx.reply((request) => {
    if (request.path === '/email/status') {
      return emailStatus
    }
    if (request.method === 'GET' && request.path === '/me') {
      return TRANSPORT.json(
        200,
        body ?? profile({ device_id: new URL(request.url).searchParams.get('device_id') })
      )
    }
    throw new Error(`未准备的请求：${request.method} ${request.path}`)
  })
}

test('E1 服务端未开邮箱功能（404 not_found）→ 入口整块不渲染，旧流程不受影响', async () => {
  prepare({ emailStatus: TRANSPORT.json(404, { error: { code: 'not_found' } }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email'), false, 'served 404 not_found 时不许出现邮箱入口')
  // 旧流程回归：设备码、额度、邀请码三段仍在
  assert.equal(view.text('ours-device-code'), DEVICE)
  assert.equal(view.has('ours-quota'), true)
  assert.equal(view.has('ours-invite'), true)
  assert.deepEqual(harness.ctx.paths, ['GET /me', 'GET /email/status'], '只多一条只读探测')
  view.unmount()
})

test('E1 探测失败（网络不可用）→ 同样不渲染入口（宁可不显示，也不给点了就报错的按钮）', async () => {
  prepare({ emailStatus: TRANSPORT.network() })
  const view = await harness.mount(OursServicesRow, {})
  assert.equal(view.has('ours-email'), false)
  view.unmount()
})

test('E1 404 device_not_found 不是「功能没开」，但探测没成功 → 入口一样不出现', async () => {
  prepare({ emailStatus: TRANSPORT.json(404, { error: { code: 'device_not_found' } }) })
  const view = await harness.mount(OursServicesRow, {})
  assert.equal(view.has('ours-email'), false)
  assert.deepEqual(harness.ctx.paths, ['GET /me', 'GET /email/status'])
  view.unmount()
})

test('E2 已绑邮箱 → 显示脱敏邮箱，且不给「绑定邮箱」按钮', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: true, email_masked: MASKED }),
  })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email'), true)
  assert.equal(view.text('ours-email-masked'), MASKED, '已绑就显示服务端给的脱敏邮箱（原样，不改写）')
  assert.equal(view.has('ours-email-bind'), false, '已绑过一次就不再给绑定入口')
  assert.equal(view.has('ours-email-input'), false, '没展开表单时不该有输入框')
  view.unmount()
})

test('E2 未绑邮箱 → 只给「绑定邮箱」入口，不显示脱敏邮箱', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: false }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email'), true)
  assert.equal(view.has('ours-email-masked'), false)
  assert.equal(view.has('ours-email-bind'), true)
  assert.equal(view.text('ours-email-bind'), zh.oursEmailBindAction)
  view.unmount()
})

test('E2 点「绑定邮箱」才展开表单（邮箱 + 验证码两格）', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: false }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email-input'), false)
  await view.click('ours-email-bind')
  assert.equal(view.has('ours-email-input'), true)
  assert.equal(view.has('ours-email-code'), true)
  view.unmount()
})

test('E2 /me 里的 has_email:true 也算已绑（探测与档案两条来源一致时不打架）', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: true, email_masked: MASKED }),
    body: profile({ device_id: DEVICE, has_email: true, email_masked: MASKED }),
  })
  const view = await harness.mount(OursServicesRow, {})
  assert.equal(view.text('ours-email-masked'), MASKED)
  assert.equal(view.has('ours-email-bind'), false)
  view.unmount()
})

test('E5 已绑邮箱 → 不再提示「复制设备码备份」', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: true, email_masked: MASKED }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email-masked'), true)
  assert.equal(view.has('ours-device-backup-hint'), false, '账号能靠邮箱找回，就不该再催备份设备码')
  view.unmount()
})

test('E5 未绑邮箱 → 备份提示照旧（#72 的回归：没绑的人设备码仍是唯一凭据）', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: false }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-device-backup-hint'), true)
  assert.ok(view.text('ours-device-backup-hint').includes(zh.oursDeviceBackupHint))
  view.unmount()
})

test('E5 邮箱功能未开启（404 not_found）→ 备份提示也照旧（行为与 #421 之前完全一致）', async () => {
  prepare({ emailStatus: TRANSPORT.json(404, { error: { code: 'not_found' } }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-device-backup-hint'), true)
  view.unmount()
})
