// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// Issue #100：弹层打开时**不许**自动 POST /apply —— 否则「绑定已有 Key」（#86）在真机上永远 409。
//
// 运行：node --test tests/unit/dialog-open-no-apply.test.mjs
//
// 用假 transport 记录**请求序列**（method + path），逐条断言：
//   [1] 本地无 Key + 用户还没做选择 → 一条写请求都没有（尤其没有 /apply）
//   [2] 本地有 Key、/me 返回 404 device_not_found → 只发 GET /me，**不补** /apply
//   [3] 用户显式选「我已有 Key」→ 只发 POST /bind，没有 /apply
//   [4] 用户显式选「领取新 Key」→ /apply 照旧（这条行为必须保留）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// 端点地址唯一来源：config/endpoints.json（#274）
import { inviteBaseUrl } from '../../scripts/lib/endpoints.mjs'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { prepareDialogOpen } = await import('../../src/services/invite/openFlow.ts')
const { applyForKey, INVITE_API_BASE } = await import('../../src/services/invite/api.ts')
const { bindExistingKey } = await import('../../src/services/invite/bind.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const API_KEY = 'sk-live-unit-test-00112233445566778899aabb'

const PROFILE_BODY = {
  invite_code: 'K3M9QW2P',
  invited_count: 0,
  max_invites: 3,
  bonus_points: 0,
  redeemed: false,
  quota_points: 0,
  used_points: 0,
  remaining_points: 0,
  key_status: 'active',
}

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

/** 假 transport：把每次请求压成 "METHOD /path"，按顺序返回 responses（最后一个复用） */
const fakeTransport = (responses) => {
  const sent = []
  const transport = async (request) => {
    sent.push(`${request.method} ${new URL(request.url).pathname}`)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, sent }
}

const NO_APPLY = (sent) =>
  assert.equal(
    sent.filter((line) => line.endsWith('/apply')).length,
    0,
    `不该出现 /apply，实际请求序列：${JSON.stringify(sent)}`
  )

test('[1] 本地无 Key、用户未做选择 → 不发任何写请求', async () => {
  const { transport, sent } = fakeTransport([json(201, { key: API_KEY, ...PROFILE_BODY })])
  const outcome = await prepareDialogOpen({ deviceId: DEVICE_ID, transport, hasLocalKey: false })
  NO_APPLY(sent)
  assert.deepEqual(sent, [], `打开弹层不该发任何请求，实际：${JSON.stringify(sent)}`)
  assert.equal(outcome.kind, 'choose', `期望等用户选「领取/我已有 Key」，实际 kind=${outcome.kind}`)
})

test('[2] 本地有 Key、/me 404 device_not_found → 只读 /me，不补 /apply', async () => {
  const { transport, sent } = fakeTransport([json(404, { error: { code: 'device_not_found' } })])
  const outcome = await prepareDialogOpen({ deviceId: DEVICE_ID, transport, hasLocalKey: true })
  NO_APPLY(sent)
  assert.deepEqual(sent, ['GET /me'], `只该有 GET /me，实际：${JSON.stringify(sent)}`)
  assert.equal(outcome.kind, 'choose', `未绑定要提示用户领取或绑定，实际 kind=${outcome.kind}`)
})

test('[2b] 本地有 Key、/me 200 → 正常读到档案', async () => {
  const { transport, sent } = fakeTransport([json(200, PROFILE_BODY)])
  const outcome = await prepareDialogOpen({ deviceId: DEVICE_ID, transport, hasLocalKey: true })
  assert.deepEqual(sent, ['GET /me'])
  assert.equal(outcome.kind, 'profile')
  assert.equal(outcome.profile.inviteCode, PROFILE_BODY.invite_code)
})

test('[3] 显式选「我已有 Key」→ 只发 POST /bind', async () => {
  const { transport, sent } = fakeTransport([json(200, { key: API_KEY, already_bound: false, ...PROFILE_BODY })])
  const result = await bindExistingKey({ deviceId: DEVICE_ID, apiKey: API_KEY }, transport)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(sent, ['POST /bind'], `绑定只该发 /bind，实际：${JSON.stringify(sent)}`)
})

test('[4] 显式选「领取新 Key」→ /apply 照旧', async () => {
  const { transport, sent } = fakeTransport([json(201, { key: API_KEY, ...PROFILE_BODY })])
  const result = await applyForKey(DEVICE_ID, transport)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(sent, ['POST /apply'], `领取只该发 /apply，实际：${JSON.stringify(sent)}`)
  assert.equal(INVITE_API_BASE, inviteBaseUrl)
})
