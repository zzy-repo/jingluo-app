// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// Issue #86：前端接入 /bind —— 把**已有的** Key 绑定到本机设备码。
//
// 运行：node --test tests/unit/bind-key.test.mjs
//
// 覆盖（逐条对应 issue 的关闭条件）：
//   [1] 200 成功：POST http://140.210.13.146:60013/bind，body 只有 {device_id, api_key}
//   [2] already_bound:true **按成功处理**：不产生错误态、文案里不出现「已绑定过」
//   [3] 四个错误码（400 invalid_device / 400 invalid_api_key / 409 key_already_bound /
//       409 device_already_bound）各有中文文案，且与 issue 表格原文逐字一致
//   [4] adopted_points 是服务端内部折算值：不出现在返回值、不出现在任何用户可见文案
//   [5] 主链路 NETWORK / TIMEOUT / ROUTE_MISSING → 兜底 https://apia.ecsafe.cn/invite/bind；
//       业务错误（400/409）一律不兜底（请求已到服务端并被处理）
//   [6] device_id 用本地已持久化的那个；缺失 / 非法 → 按 #72 规则生成并落盘
//   [7] 隐私：整条链路一条 console 都没有，Key / 设备码不进日志
import '../helpers/injected.mjs'

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

const bind = await import('../../src/services/invite/bind.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { DEVICE_ID_STORAGE_KEY, isDeviceId } = await import('../../src/services/invite/device.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const API_KEY = 'sk-live-unit-test-00112233445566778899aabb'

/** 服务端 200 的真实形状（issue 里贴的样例）；adopted_points 故意给一个不会和其它字段撞的数字 */
const SUCCESS_BODY = {
  customer_id: 6,
  invite_code: 'K3M9QW2P',
  key: API_KEY,
  already_bound: false,
  adopted_points: 137.5,
  bonus_points: 0,
  invited_count: 0,
  max_invites: 3,
  quota_points: 52.8,
  used_points: 0.1,
  remaining_points: 52.7,
  key_status: 'active',
}

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const errorBody = (code) => ({ error: { code, message: 'server says no' } })

/** 假 transport：记录每次请求；responses 多于一个时按顺序消费，最后一个复用 */
const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}

const bindOnce = async (transport, overrides = {}) =>
  bind.bindExistingKey({ deviceId: DEVICE_ID, apiKey: API_KEY, ...overrides }, transport)

// ---------------------------------------------------------------- [1] 200 成功
test('[1] 200 成功：POST /bind，报文只有 device_id + api_key，返回 key 可落盘', async () => {
  const { transport, calls } = fakeTransport([json(200, SUCCESS_BODY)])
  const result = await bindOnce(transport)

  assert.equal(result.kind, 'ok')
  assert.equal(calls.length, 1, '只发一次请求')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, inviteBaseUrl + '/bind', '主链路地址')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), { device_id: DEVICE_ID, api_key: API_KEY }, '请求体字段')
  assert.equal(calls[0].followRedirects, false)

  assert.equal(result.apiKey, API_KEY, '返回的 key 就是要保存的那把')
  assert.equal(result.inviteCode, 'K3M9QW2P')
  assert.equal(result.remainingPoints, 52.7)
  assert.equal(result.quotaPoints, 52.8)
  assert.equal(result.keyStatus, 'active')
  assert.equal(result.alreadyBound, false)
  assert.equal(result.via, 'primary')
})

// ---------------------------------------------------------------- [2] already_bound
test('[2] already_bound:true 按成功处理：没有错误态，文案不说「已绑定过」', async () => {
  const { transport } = fakeTransport([json(200, { ...SUCCESS_BODY, already_bound: true })])
  const result = await bindOnce(transport)

  assert.equal(result.kind, 'ok', 'already_bound 必须走成功分支')
  assert.equal(result.alreadyBound, true)
  assert.equal(result.apiKey, API_KEY)
  assert.equal(result.code, undefined, '不算错误：没有错误码')
  assert.equal(result.messageKey, undefined, '不算错误：没有错误文案 key')

  // 成功文案只有一条：首次绑定与重复提交显示同一句话
  const first = bind.bindSuccessKey({ alreadyBound: false })
  const repeat = bind.bindSuccessKey({ alreadyBound: true })
  assert.equal(repeat, first, '重复绑定复用同一条成功文案')
  assert.equal(first, 'oursBindOk')

  for (const [locale, messages] of [['zh', zh], ['en', en]]) {
    assert.ok(!/已绑定过|已经绑定过|already bound/i.test(messages.oursBindOk), `${locale}: 成功文案不提「已绑定过」`)
  }
})

// ---------------------------------------------------------------- [3] 四个错误码
test('[3] 四个错误码各有中文文案，与 issue 表格原文逐字一致', async () => {
  const cases = [
    [400, 'invalid_device', 'oursBindErrInvalidDevice', '设备标识异常，请重启 App 后再试'],
    [400, 'invalid_api_key', 'oursBindErrInvalidApiKey', '这个 Key 不存在或已失效'],
    [409, 'key_already_bound', 'oursBindErrKeyAlreadyBound', '该 Key 已绑定在其他设备上'],
    [409, 'device_already_bound', 'oursBindErrDeviceAlreadyBound', '本机已绑定过另一个 Key'],
  ]
  for (const [status, code, messageKey, text] of cases) {
    const { transport, calls } = fakeTransport([json(status, errorBody(code))])
    const result = await bindOnce(transport)

    assert.equal(result.kind, 'error', `${code} 是错误`)
    assert.equal(result.code, code, `${code} 错误码透传`)
    assert.equal(result.messageKey, messageKey, `${code} → 文案 key`)
    assert.equal(zh[messageKey], text, `${code} 中文文案与 issue 原文一致`)
    assert.ok((en[messageKey] ?? '') !== '', `${code} 有英文文案`)
    assert.notEqual(en[messageKey], zh[messageKey], `${code} 英文不是照抄中文`)
    assert.equal(calls.length, 1, `${code} 是业务错误，不兜底、不重试`)
  }
})

// 服务端偶尔只给状态码不给 code：文案按状态码兜底，绝不能变成「没有文案」
test('[3b] 只有状态码没有 code 时也有可读文案', async () => {
  const { transport } = fakeTransport([json(409, {})])
  const result = await bindOnce(transport)
  assert.equal(result.kind, 'error')
  assert.ok(typeof zh[result.messageKey] === 'string' && zh[result.messageKey] !== '')
})

// ---------------------------------------------------------------- [4] adopted_points
test('[4] adopted_points 不进返回值，也不出现在任何用户可见文案里', async () => {
  const { transport } = fakeTransport([json(200, SUCCESS_BODY)])
  const result = await bindOnce(transport)

  const serialized = JSON.stringify(result)
  assert.ok(!/adopted/i.test(serialized), '返回值里没有 adopted_* 字段')
  assert.ok(!/137\.5/.test(serialized), '折算值 137.5 没有泄漏到返回值')

  // 界面只会渲染 oursBind* 里的文案：这些文案里不许出现折算值或 adopted 占位符
  for (const [locale, messages] of [['zh', zh], ['en', en]]) {
    for (const [key, text] of Object.entries(messages)) {
      if (!key.startsWith('oursBind')) continue
      assert.ok(!/adopted/i.test(text), `${locale}.${key} 提到 adopted`)
      assert.ok(!/\{adopted/i.test(text), `${locale}.${key} 有 adopted 占位符`)
    }
  }
})

// ---------------------------------------------------------------- [5] 兜底
test('[5] 主链路 NETWORK / TIMEOUT / ROUTE_MISSING → 兜底备用域名，结果标记 via=fallback', async () => {
  const unreachable = [
    ['network', { kind: 'network' }, 'NETWORK'],
    ['timeout', { kind: 'timeout' }, 'TIMEOUT'],
    ['404 无业务码 = 路由不存在', { kind: 'response', status: 404, text: '' }, 'ROUTE_MISSING'],
    ['405 无业务码 = 路由不存在', { kind: 'response', status: 405, text: '' }, 'ROUTE_MISSING'],
  ]
  for (const [label, first, firstCode] of unreachable) {
    const { transport, calls } = fakeTransport([first, json(200, SUCCESS_BODY)])
    const result = await bindOnce(transport)

    assert.equal(result.kind, 'ok', `${label} 兜底后成功`)
    assert.equal(calls.length, 2, `${label} 兜底恰好打两次`)
    assert.equal(calls[0].url, inviteBaseUrl + '/bind', `${label} 先打主链路`)
    assert.equal(calls[1].url, 'https://apia.ecsafe.cn/invite/bind', `${label} 再打备用域名`)
    assert.deepEqual(JSON.parse(calls[1].body), { device_id: DEVICE_ID, api_key: API_KEY }, `${label} 兜底报文一致`)
    assert.equal(result.via, 'fallback')
    assert.equal(result.apiKey, API_KEY)
    // 兜底请求也要把第一次的失败原因记下来，便于反馈时定位
    assert.equal(result.primaryFailure, firstCode)
  }
})

test('[5b] 兜底也失败时如实报错，不假装成功', async () => {
  const { transport, calls } = fakeTransport([{ kind: 'network' }, { kind: 'timeout' }])
  const result = await bindOnce(transport)
  assert.equal(result.kind, 'error')
  assert.equal(result.messageKey, 'oursBindErrTimeout', '报第二次（兜底）的失败原因')
  assert.equal(calls.length, 2)
  assert.equal(result.via, 'fallback')
})

test('[5c] 业务错误不兜底：400 invalid_api_key 只打一次主链路', async () => {
  const { transport, calls } = fakeTransport([json(400, errorBody('invalid_api_key')), json(200, SUCCESS_BODY)])
  const result = await bindOnce(transport)
  assert.equal(result.kind, 'error')
  assert.equal(calls.length, 1, '请求已到服务端并被处理，再打一遍没有意义')
})

// ---------------------------------------------------------------- [6] device_id
test('[6] device_id 用本地已持久化的那个；缺失 / 非法则按 #72 规则生成并落盘', () => {
  const store = new Map()
  const storage = {
    read: () => store.get(DEVICE_ID_STORAGE_KEY) ?? null,
    write: (value) => store.set(DEVICE_ID_STORAGE_KEY, value),
  }

  // 本地已有合法设备码 → 原样沿用，不重写
  store.set(DEVICE_ID_STORAGE_KEY, DEVICE_ID)
  const kept = bind.resolveBindDeviceId(storage)
  assert.equal(kept.deviceId, DEVICE_ID)
  assert.equal(kept.created, false)

  // 本地没有 → 生成并落盘（8–128 位 [A-Za-z0-9._:-]）
  store.delete(DEVICE_ID_STORAGE_KEY)
  const created = bind.resolveBindDeviceId(storage)
  assert.equal(created.created, true, '没有时新建')
  assert.ok(isDeviceId(created.deviceId), '生成的设备码符合服务端约束')
  assert.equal(store.get(DEVICE_ID_STORAGE_KEY), created.deviceId, '已经写进存储')

  // 存了坏值 → 当作没有，重新生成并覆盖（否则服务端一直报参数错误，用户无法自救）
  store.set(DEVICE_ID_STORAGE_KEY, 'bad id!')
  const repaired = bind.resolveBindDeviceId(storage)
  assert.equal(repaired.created, true)
  assert.ok(isDeviceId(repaired.deviceId))
  assert.equal(store.get(DEVICE_ID_STORAGE_KEY), repaired.deviceId)
})

test('[6b] device_id / api_key 缺失时先本地拦下，不发请求', async () => {
  const noDevice = fakeTransport([json(200, SUCCESS_BODY)])
  const r1 = await bind.bindExistingKey({ deviceId: '   ', apiKey: API_KEY }, noDevice.transport)
  assert.equal(r1.kind, 'error')
  assert.equal(r1.messageKey, 'oursBindErrDeviceMissing')
  assert.equal(noDevice.calls.length, 0, '本地就能判断的错不该发请求')

  const noKey = fakeTransport([json(200, SUCCESS_BODY)])
  const r2 = await bind.bindExistingKey({ deviceId: DEVICE_ID, apiKey: '  ' }, noKey.transport)
  assert.equal(r2.kind, 'error')
  assert.equal(r2.messageKey, 'oursBindErrKeyMissing')
  assert.equal(noKey.calls.length, 0)
})

test('[6c] Key 首尾空白被裁掉，粘贴时不至于因为空格失败', async () => {
  const { transport, calls } = fakeTransport([json(200, SUCCESS_BODY)])
  await bindOnce(transport, { apiKey: `  ${API_KEY}\n` })
  assert.deepEqual(JSON.parse(calls[0].body), { device_id: DEVICE_ID, api_key: API_KEY })
})

// ---------------------------------------------------------------- [7] 隐私
test('[7] 整条链路不打印 Key / 设备码', async () => {
  const seen = []
  const originals = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args) => seen.push(args.join(' '))
  console.warn = (...args) => seen.push(args.join(' '))
  console.error = (...args) => seen.push(args.join(' '))
  try {
    const okRun = fakeTransport([json(200, SUCCESS_BODY)])
    await bindOnce(okRun.transport)
    const errRun = fakeTransport([json(400, errorBody('invalid_api_key'))])
    await bindOnce(errRun.transport)
    const netRun = fakeTransport([{ kind: 'network' }, { kind: 'network' }])
    await bindOnce(netRun.transport)
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  }
  assert.deepEqual(seen, [], '一条日志都没有')
  for (const line of seen) {
    assert.ok(!line.includes(API_KEY), 'Key 不进日志')
    assert.ok(!line.includes(DEVICE_ID), '设备码不进日志')
  }
})
