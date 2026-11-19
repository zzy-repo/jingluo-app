// [layer: unit —— 组件级（真弹层组件 + 真 device.ts，假传输），零浏览器 | 耗时: <1s]
// C5「设备码展示 / 复制 / 一次性备份提示 / 服务端回填写回」—— 域 6 F6-16（+ F6-01 的只读前提）
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 N5/N6 的真实写入路径也在这里被钉住）
//
// 设备码 = 账号：清站点数据就等于丢号，所以这四件事必须同时成立，缺一条用户就会「号丢了还没线索」：
//   1. 完整可见、可复制（端上只脱敏进日志，不脱敏给本人看）；
//   2. 「复制备份好」只提示一次（点过「我知道了」后跨会话都不再弹）；
//   3. 存了坏值（被手改 / 老版本写坏）要重建并写回，不能拿坏值一直打服务端；
//   4. 服务端 /me 回填的合法 device_id 必须写回本地（#261），坏值当没回、绝不写坏本地。
//
// 跑法：node --test tests/unit/domain06-device-backup-hint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource(
  'src/components/settings/OursServicesDialog.tsx'
)
const { DEVICE_ID_PATTERN, DEVICE_ID_STORAGE_KEY, DEVICE_BACKUP_HINT_KEY } =
  await harness.importSource('src/services/invite/device.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-55555555555555555555555555555555'
const OTHER_DEVICE = 'd-66666666666666666666666666666666'
const KEY = 'sk-ours-device-code-0011223344556677'

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
 * 统一准备：默认让 /me **回显请求里的 device_id**（真实服务就是这么回的），
 * 需要断言「服务端回填另一个值」时才显式指定 `body`。
 */
const prepare = ({ apiKey = KEY, storedDevice = DEVICE, hintSeen = null, body = null }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = apiKey
  if (storedDevice !== null) {
    globalThis.localStorage.setItem(DEVICE_ID_STORAGE_KEY, storedDevice)
  }
  if (hintSeen !== null) {
    globalThis.localStorage.setItem(DEVICE_BACKUP_HINT_KEY, hintSeen)
  }
  harness.ctx.oursOpen = true
  harness.ctx.reply((request) =>
    TRANSPORT.json(
      200,
      body ?? profile({ device_id: new URL(request.url).searchParams.get('device_id') })
    )
  )
}

const readDevice = () => globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY)

test('C5/1 F6-16 首次打开：完整设备码可见（与本地一致）+ 一次性备份提示出现', async () => {
  prepare({})
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.text('ours-device-code'), DEVICE, '设备码必须完整可见（给本人看，不脱敏）')
  assert.equal(view.has('ours-device-backup-hint'), true, '首次进入要提示一次「设备码=账号」')
  assert.ok(view.text('ours-device-backup-hint').includes(zh.oursDeviceBackupHint))
  view.unmount()
})

test('C5/2 F6-16 点「我知道了」→ 提示消失 + 持久化标记（只提示一次的实现点）', async () => {
  prepare({})
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-device-backup-hint-ok')

  assert.equal(view.has('ours-device-backup-hint'), false, '点过之后当次就该消失')
  assert.equal(globalThis.localStorage.getItem(DEVICE_BACKUP_HINT_KEY), '1')
  view.unmount()
})

test('C5/3 F6-16 跨会话（标记已存在）：重新打开不再提示', async () => {
  prepare({ hintSeen: '1' })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-device-backup-hint'), false)
  assert.equal(view.text('ours-device-code'), DEVICE)
  view.unmount()
})

test('C5/4 F6-16 点复制设备码 → 剪贴板收到完整设备码（复制按钮真的接到了 copyText）', async () => {
  prepare({})
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-device-copy')

  assert.deepEqual(harness.ctx.copied, [DEVICE], '复制的必须是完整设备码，不是脱敏后的')
  assert.equal(view.text('ours-device-copy'), zh.oursDeviceCopied, '复制后按钮文案要变成「已复制」')
  view.unmount()
})

test('C5/5 F6-16 本地设备码是坏值（被手改）→ 重建合法值并写回，不拿坏值去打服务端', async () => {
  prepare({ storedDevice: 'bad device id!!' })
  const view = await harness.mount(OursServicesRow, {})

  const shown = view.text('ours-device-code')
  assert.match(shown, DEVICE_ID_PATTERN, `重建后的设备码不合法：${shown}`)
  assert.equal(readDevice(), shown, '重建的 device_id 必须写回本地（下次启动还是同一个账号）')
  assert.equal(new URL(harness.ctx.requests[0].url).searchParams.get('device_id'), shown)
  view.unmount()
})

test('C5/6 F6-16 /me 回填合法的另一个 device_id → 写回本地并显示（#261：否则后续查错设备）', async () => {
  prepare({ body: profile({ device_id: OTHER_DEVICE }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(readDevice(), OTHER_DEVICE, '服务端回填的 device_id 必须写回本地')
  assert.equal(view.text('ours-device-code'), OTHER_DEVICE)
  view.unmount()
})

test('C5/7 F6-16 /me 回填坏值 → 当没回，绝不写坏本地', async () => {
  prepare({ body: profile({ device_id: 'bad id!' }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(readDevice(), DEVICE, '坏值绝不许写进本地')
  assert.equal(view.text('ours-device-code'), DEVICE)
  view.unmount()
})

test('C5/8 F6-16 存储不可用（隐私模式 / 配额满）：设备码仍可见可复制，界面不崩', async () => {
  prepare({})
  const working = globalThis.localStorage
  const throwing = {
    getItem: () => {
      throw new Error('storage disabled')
    },
    setItem: () => {
      throw new Error('storage disabled')
    },
    removeItem: () => {
      throw new Error('storage disabled')
    },
    clear: () => {},
    key: () => null,
    length: 0,
  }
  globalThis.localStorage = throwing
  try {
    const view = await harness.mount(OursServicesRow, {})
    const shown = view.text('ours-device-code')
    assert.match(shown, DEVICE_ID_PATTERN)
    await view.click('ours-device-copy')
    assert.deepEqual(harness.ctx.copied, [shown], '存不进本地也要能复制备份')
    view.unmount()
  } finally {
    globalThis.localStorage = working
  }
})
