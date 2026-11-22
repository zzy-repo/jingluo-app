// [layer: unit | 依赖: 无（纯 Node + 假 transport + 真 aff.ts / invitePanelModel / renderToStaticMarkup，零网络） | 耗时: <1s]
//
// #860「邀请面板对接汇总」前端部分 —— **mock 契约测试，未对真实接口验证**。
//
// 夹具来源与可信度（测试名里的「mock」不是客套）：
//   · `REAL_AFF_*`：形状取自 sub2api-private#20 最后一条评论里 admin 账号 `GET /user/aff` 的**真实响应事实**
//     （`inviter_id` 键缺省而不是 null、`aff_count` 0→1、`invite_remaining` 30→29、`invitees` 里有一条）。
//     数值是按那条评论手写的 mock，不是抓包原文；
//   · `MIGRATED_AFF`：#860 描述的迁移用户场景（`aff_count=30`、`invitees=[]`、`invite_remaining=0`）。
//     来自后端对测试库的描述，**没有用真实账号验证过**；
//   · 划转 `POST /user/aff/transfer`：**没有任何真实响应样本**，成功体 `{transferred_quota, balance}` 只是 #860 的契约文字，
//     失败码没有任何样本，所以只断言「不显示成功 / 通用失败文案 / 401 登录失效」，不发明 reason。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const {
  InvitePanelView,
  INVITE_MIGRATION_RECHECK_MS,
  initialInviteTransferState,
  isInviteFull,
  loadInvite,
  nextRecheckDelay,
  reduceInviteTransfer,
  runTransfer,
  toInviteDetail,
} = await import('../../src/components/consume/invitePanelModel.ts')
const { INVITE_BIND_ENABLED, inviteBindMode } = await import('../../src/components/consume/inviteBindModel.ts')
const { PATH_WHITELIST } = await import('../../scripts/lib/consumeApiAudit.mjs')

const AFF_PATH = '/api/v1/user/aff'
const TRANSFER_PATH = '/api/v1/user/aff/transfer'
const JWT = 'jwt-860-test'

const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** #20 真实事实的 mock：admin（已有 1 个被邀请人）。注意**没有 inviter_id 键**（后端 omitempty） */
const REAL_AFF_ADMIN = {
  user_id: 1,
  aff_code: '6EFT6PUQ4JSY',
  aff_count: 1,
  aff_quota: 0,
  aff_frozen_quota: 0,
  aff_history_quota: 0,
  effective_rebate_rate_percent: 20,
  invitees: [{ user_id: 21, email: 's***@example.com' }],
  max_invitees: 30,
  invite_remaining: 29,
}
/** #860 迁移用户：人数是迁移一次性加上去的，邀请关系没有迁成列表 */
const MIGRATED_AFF = {
  ...REAL_AFF_ADMIN,
  user_id: 11,
  aff_code: 'MIGR0011',
  aff_count: 30,
  invitees: [],
  invite_remaining: 0,
}

const sceneOf = (handler) => {
  const rec = recordingTransport(handler)
  const consume = createConsumeClient({ accessToken: () => JWT, transport: rec.transport })
  return { rec, consume }
}

const affScene = (affs) => {
  let index = 0
  return sceneOf((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'GET' && path === AFF_PATH) {
      const body = affs[Math.min(index, affs.length - 1)]
      index += 1
      return panelOk(body)
    }
    return jsonReply(404, { code: 404, message: 'not found' })
  })
}

const render = (state, transfer) =>
  markupOf(
    InvitePanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      copied: false,
      onCopy() {},
      onRetry() {},
      transfer,
    })
  )

// ------------------------------------------------------------------ 条件 1：人数用 aff_count

test('[mock 契约，未对真实接口验证] #20 形状：aff_count=1 显示 1，invitees 列表长度不参与', async () => {
  const { consume } = affScene([REAL_AFF_ADMIN])
  const state = await loadInvite({ aff: consume.aff })
  assert.equal(state.phase, 'ready')
  assert.equal(state.data.count, 1)
  assert.equal(textOf(render(state), 'invite-count').includes('1'), true)
})

test('[mock 契约，未对真实接口验证] 迁移用户：aff_count=30 + invitees=[] → 显示 30 而不是「0 人」', async () => {
  const { consume } = affScene([MIGRATED_AFF])
  const state = await loadInvite({ aff: consume.aff })
  assert.equal(state.phase, 'ready')
  assert.equal(state.data.count, 30)
  const markup = render(state)
  const shown = textOf(markup, 'invite-count')
  assert.equal(shown.includes('30'), true, `人数应显示 30，实际：${shown}`)
  assert.equal(/(^|\D)0(\D|$)/u.test(shown), false, `不许出现 0：${shown}`)
})

test('源码守卫：面板链路里没有 invitees.length（人数只认 aff_count）', () => {
  for (const file of ['src/components/consume/invitePanelModel.ts', 'src/components/consume/InvitePanel.tsx', 'src/services/consume/aff.ts']) {
    assert.equal(/invitees\s*\.\s*length/u.test(stripComments(readSource(file))), false, `${file} 不许用 invitees.length`)
  }
})

// ------------------------------------------------------------------ 条件 2：名额已满 + inviter_id 缺失

test('[mock 契约，未对真实接口验证] invite_remaining=0 → 「名额已满」提示；=29 / -1 / 缺省 → 没有', async () => {
  const full = await loadInvite({ aff: affScene([MIGRATED_AFF]).consume.aff })
  assert.equal(isInviteFull(full.data), true)
  assert.equal(hasTestId(render(full), 'invite-full'), true)
  assert.equal(textOf(render(full), 'invite-full').includes(translate('inviteFull')), true)

  const { invite_remaining: _drop, ...noRemaining } = REAL_AFF_ADMIN
  for (const body of [REAL_AFF_ADMIN, { ...REAL_AFF_ADMIN, invite_remaining: -1 }, noRemaining]) {
    const state = await loadInvite({ aff: affScene([body]).consume.aff })
    assert.equal(isInviteFull(state.data), false, JSON.stringify(body.invite_remaining))
    assert.equal(hasTestId(render(state), 'invite-full'), false)
  }
})

test('inviter_id 缺失 / null / 0 都当未绑定；正整数才算已绑定（#20：未绑定账号是「键缺省」）', async () => {
  const cases = [
    { name: '缺省（#20 真实形状）', body: REAL_AFF_ADMIN, mode: 'form' },
    { name: 'null', body: { ...REAL_AFF_ADMIN, inviter_id: null }, mode: 'form' },
    { name: '0', body: { ...REAL_AFF_ADMIN, inviter_id: 0 }, mode: 'form' },
    { name: '1（#20：绑定后 inviter_id=1）', body: { ...REAL_AFF_ADMIN, inviter_id: 1 }, mode: 'bound' },
  ]
  for (const item of cases) {
    const state = await loadInvite({ aff: affScene([item.body]).consume.aff })
    assert.equal(inviteBindMode({ enabled: true, state, bound: false }), item.mode, item.name)
  }
})

test('不写死后端设置值：名额文案不含数字，模型源码里没有 30 / 返利比例字面量', () => {
  assert.equal(/\d/u.test(translate('inviteFull')), false, '「名额已满」文案不带上限数字')
  const model = stripComments(readSource('src/components/consume/invitePanelModel.ts'))
  assert.equal(/\b30\b/u.test(model), false, 'invitePanelModel 里不许出现 30（max_invitees 是后台设置）')
})

// ------------------------------------------------------------------ 条件 3（冲突项，不改，钉现状）

test('affiliate_enabled：面板仍不读 settings/public（#819-v2 的既有决定，#860 条件 3 与之冲突，未改）', async () => {
  const scene = affScene([REAL_AFF_ADMIN])
  await loadInvite({ aff: scene.consume.aff })
  assert.deepEqual(scene.rec.sequence(), ['GET /api/v1/user/aff'], '只打 aff 一条')
})

// ------------------------------------------------------------------ 条件 4：划转

const transferScene = ({ onTransfer, affs = [{ ...REAL_AFF_ADMIN, aff_quota: 12.5 }, { ...REAL_AFF_ADMIN, aff_quota: 0 }] }) => {
  let index = 0
  return sceneOf((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === TRANSFER_PATH) {
      return onTransfer(request)
    }
    if (request.method === 'GET' && path === AFF_PATH) {
      const body = affs[Math.min(index, affs.length - 1)]
      index += 1
      return panelOk(body)
    }
    return jsonReply(404, { code: 404, message: 'not found' })
  })
}

test('[mock 契约，无真实样本] 划转成功：POST 无请求体带 JWT → 用响应 balance → 再重拉 GET /user/aff', async () => {
  // 划转前面板已经读过一次（有 12.5 可划转）；这里的 GET 序列只放划转之后的那一次（可划转归零）
  const { rec, consume } = transferScene({
    onTransfer: () => panelOk({ transferred_quota: 12.5, balance: 20.75 }),
    affs: [{ ...REAL_AFF_ADMIN, aff_quota: 0 }],
  })
  const outcome = await runTransfer({ aff: consume.aff })
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.balance, 20.75, '余额用响应里的 balance，不是本地加减')
  assert.equal(outcome.reloaded.phase, 'ready')
  assert.equal(outcome.reloaded.data.rebateBalance, 0, '重拉之后可划转返利归零')
  assert.deepEqual(rec.sequence(), ['POST /api/v1/user/aff/transfer', 'GET /api/v1/user/aff'])
  const post = rec.calls[0]
  assert.equal(post.headers.authorization, `Bearer ${JWT}`)
  assert.equal(post.body === undefined || post.body === '' || post.body === null, true, '划转没有请求体')
})

test('[mock 契约，无真实样本] 划转失败不显示成功：4xx / 5xx / 401 / 2xx 但 balance 不是数字 / 传输失败', async () => {
  const cases = [
    { name: '400 带 reason', reply: () => jsonReply(400, { code: 400, message: 'x', reason: 'ANYTHING' }), key: 'inviteTransferFailed' },
    { name: '500', reply: () => jsonReply(500, { code: 500, message: 'boom' }), key: 'inviteTransferFailed' },
    { name: '401 UNAUTHORIZED', reply: () => jsonReply(401, { code: 'UNAUTHORIZED', message: 'Authorization header is required' }), key: 'inviteBindErrUnauthorized' },
    { name: '2xx 没有 balance', reply: () => panelOk({ transferred_quota: 12.5 }), key: 'inviteTransferFailed' },
    { name: '2xx balance 是字符串', reply: () => panelOk({ transferred_quota: 12.5, balance: '20.75' }), key: 'inviteTransferFailed' },
    { name: '2xx 空 data', reply: () => panelOk({}), key: 'inviteTransferFailed' },
  ]
  for (const item of cases) {
    const { rec, consume } = transferScene({ onTransfer: item.reply })
    const outcome = await runTransfer({ aff: consume.aff })
    assert.deepEqual(outcome, { kind: 'failed', key: item.key }, item.name)
    assert.deepEqual(rec.sequence(), ['POST /api/v1/user/aff/transfer'], `${item.name}：失败不重拉、不重试`)
    const state = reduceInviteTransfer(initialInviteTransferState(), { type: 'outcome', outcome })
    assert.equal(state.done, false, `${item.name}：状态里没有成功`)
    assert.equal(state.errorKey, item.key)
  }
})

test('划转状态机 + 视图：提交中禁用并换文案；成功才出现「已划转」；没有可划转返利就没有按钮', async () => {
  let state = reduceInviteTransfer(initialInviteTransferState(), { type: 'submit' })
  assert.deepEqual(state, { busy: true, done: false, errorKey: null })

  const withMoney = await loadInvite({ aff: affScene([{ ...REAL_AFF_ADMIN, aff_quota: 12.5 }]).consume.aff })
  const busyMarkup = render(withMoney, { state, onTransfer() {} })
  assert.equal(hasTestId(busyMarkup, 'invite-transfer'), true)
  assert.equal(busyMarkup.includes(translate('inviteTransferring')), true)
  assert.equal(/<button[^>]*data-testid="invite-transfer"[^>]*disabled/u.test(busyMarkup), true, '提交中按钮禁用')

  state = reduceInviteTransfer(state, { type: 'outcome', outcome: { kind: 'done', balance: 1, reloaded: null } })
  const doneMarkup = render(withMoney, { state, onTransfer() {} })
  assert.equal(hasTestId(doneMarkup, 'invite-transfer-done'), true)

  state = reduceInviteTransfer(state, { type: 'outcome', outcome: { kind: 'failed', key: 'inviteTransferFailed' } })
  const failMarkup = render(withMoney, { state, onTransfer() {} })
  assert.equal(hasTestId(failMarkup, 'invite-transfer-error'), true)
  assert.equal(hasTestId(failMarkup, 'invite-transfer-done'), false, '失败时不能同时显示成功')

  const noMoney = await loadInvite({ aff: affScene([REAL_AFF_ADMIN]).consume.aff })
  assert.equal(hasTestId(render(noMoney, { state: initialInviteTransferState(), onTransfer() {} }), 'invite-transfer'), false)
  assert.equal(hasTestId(render(noMoney), 'invite-transfer'), false, '不传 transfer 时没有划转区块')
})

test('白名单与服务函数同步：PATH_WHITELIST 含 aff/transfer，consume.aff.transfer 存在，文档表有这一行', () => {
  assert.equal(PATH_WHITELIST.includes(TRANSFER_PATH), true)
  assert.equal(typeof createConsumeClient({ transport: async () => jsonReply(404, {}) }).aff.transfer, 'function')
  assert.equal(readSource('docs/consume-layer.md').includes('POST /api/v1/user/aff/transfer'), true)
})

// ------------------------------------------------------------------ 条件 5：迁移延迟后重拉

test('[mock 契约，未对真实接口验证] 迁移延迟：首读全 0 才补读，两次用完即止；已有数据不补读', async () => {
  const unmigrated = { ...REAL_AFF_ADMIN, aff_count: 0, invitees: [], invite_remaining: 30 }
  const first = await loadInvite({ aff: affScene([unmigrated]).consume.aff })
  assert.equal(nextRecheckDelay(first, 0), INVITE_MIGRATION_RECHECK_MS[0])
  assert.equal(nextRecheckDelay(first, 1), INVITE_MIGRATION_RECHECK_MS[1])
  assert.equal(nextRecheckDelay(first, 2), null, '用完即止，不是无限轮询')

  const migrated = await loadInvite({ aff: affScene([MIGRATED_AFF]).consume.aff })
  assert.equal(nextRecheckDelay(migrated, 0), null, '已有人数就不再补读')
  const hasMoney = await loadInvite({ aff: affScene([{ ...unmigrated, aff_quota: 1 }]).consume.aff })
  assert.equal(nextRecheckDelay(hasMoney, 0), null, '已有返利就不再补读')
  assert.equal(nextRecheckDelay({ phase: 'hidden' }, 0), null)
  assert.equal(nextRecheckDelay({ phase: 'signedOut' }, 0), null)
  assert.equal(nextRecheckDelay({ phase: 'failed', error: { i18nKey: 'consumeErrServerUnavailable', retryable: true, needLogin: false, code: 'x' } }, 0), null)
  assert.ok(INVITE_MIGRATION_RECHECK_MS.every((ms) => ms > 5000), '间隔都要超过迁移的 ~5 秒')
})

test('源码守卫：容器里接了补读与划转，页面把新余额接回 setBalance；开关与注册表单不动', () => {
  const panel = stripComments(readSource('src/components/consume/InvitePanel.tsx'))
  assert.match(panel, /nextRecheckDelay\(state, recheckAttempt\.current\)/u, '补读 effect 在位')
  assert.match(panel, /runTransfer\(transferSource\)/u, '划转走模型里的 runTransfer')
  assert.match(panel, /onBalance\?\.\(outcome\.balance\)/u, '成功后用响应 balance 回调')
  const page = stripComments(readSource('src/components/consume/AccountConsumePage.tsx'))
  assert.match(page, /<InvitePanel\b[^>]*\bonBalance=\{setBalance\}/su, '页面把划转后的 balance 接回余额 state')
  assert.equal(INVITE_BIND_ENABLED, true, '#859 已打开，本单不翻')
  assert.equal(
    /invitation_code|aff_code|invitationCode/u.test(stripComments(readSource('src/components/consume/settingsAuthCardModel.ts'))),
    false,
    '注册表单模型不带任何邀请字段（#859；本单不碰）'
  )
})

test('toInviteDetail 兼容：没有 invite_remaining 时不带 remaining 键（旧夹具的 deepEqual 不被打破）', () => {
  assert.deepEqual(
    toInviteDetail({ userId: 1, affCode: 'X', affCount: 1, affQuota: 0.5, affFrozenQuota: 0, affHistoryQuota: 0, invitees: [] }),
    { code: 'X', count: 1, rebateBalance: 0.5, frozenBalance: 0 }
  )
})
