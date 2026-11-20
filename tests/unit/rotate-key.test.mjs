// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// Issue #90：前端接入 /rotate —— 更换 API Key（额度不丢、旧 Key 立即失效）。
//
// 运行：node --test tests/unit/rotate-key.test.mjs
//
// 覆盖（逐条对应 issue 的关闭条件 + 任务书「红」的三件事）：
//   [1] 发起：POST http://140.210.13.146:60013/rotate，body 只有 {device_id}，**不带旧 Key**
//   [2] 成功：返回的 key 立刻落盘一次；remaining_points 立即刷新且与换前一致（额度不丢）
//   [3] 旧 Key 失效处理：成功后本地存档里只剩新 Key；previous_key_id / carried_used_points 不外泄
//   [4] 失败绝不破坏本地旧 Key：NETWORK / TIMEOUT / 404 device_not_found / 400 invalid_device /
//       500 internal / 429 rate_limited 六种失败下存档一个字节都不动
//   [5] 200 但没给 key：不落盘（否则本地会存一把空 Key），报 KEY_MISSING
//   [6] 绝不自愈：device_not_found 不补 POST /apply，400 invalid_device 不重发（文案让用户重启）
//   [7] 兜底只兜链路不通：NETWORK/TIMEOUT → https://apia.ecsafe.cn/invite/rotate；业务错误不重发
//   [8] 文案：错误码与 issue 表格逐字一致；二次确认文案必须写明「立即失效」+「无法找回」
//   [9] 隐私：整条链路一条 console 都没有；返回值里没有完整 device_id / 旧 Key
//   [10] UI 接线（源码断言）：设置页有入口 + 二次确认 + 置灰防连点 + 成功时 setApiKey 落盘
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

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

const rotate = await import('../../src/services/invite/rotate.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
/** 只有测试用的假凭据；真 Key 绝不进仓库 */
const OLD_KEY = 'sk-live-unit-test-old-0000000000000000000000'
const NEW_KEY = 'sk-live-unit-test-new-1111111111111111111111'

/** 换之前本机的额度（与 #90 issue 正文的样例对齐） */
const BEFORE = { quotaPoints: 410, usedPoints: 0.52, remainingPoints: 409.48 }

/** 服务端 200 的真实形状（issue 正文样例）；previous_key_id / carried_used_points 故意给特征值 */
const SUCCESS_BODY = {
  customer_id: 5,
  invite_code: '9XST3MHE',
  key: NEW_KEY,
  rotated: true,
  previous_key_id: 123,
  carried_used_points: 0.52,
  total_points: 410.0,
  quota_points: 410.0,
  remaining_points: 409.48,
  key_status: 'active',
  bonus_points: 310,
  invited_count: 0,
  max_invites: 3,
}

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const errorBody = (code) => json(404, { error: { code, message: 'server says no' } })

/** 假传输：按调用次序回放 script，并记录每一次请求（断言「到底发了什么」） */
const makeTransport = (script) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = script[calls.length - 1] ?? script[script.length - 1]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}

/** 假的本地存档：saveKey 写它，等同于界面里的 setApiKey → localStorage */
const makeStorage = (current) => ({ apiKey: current, writes: 0 })

const runRotate = async (options) => {
  const storage = makeStorage(options.currentKey ?? OLD_KEY)
  const outcome = await rotate.rotateKey({
    deviceId: options.deviceId ?? DEVICE_ID,
    transport: options.transport,
    currentKey: storage.apiKey,
    saveKey: (key) => {
      storage.writes += 1
      storage.apiKey = key
    },
  })
  return { outcome, storage }
}

// ------------------------------------------------------------------ [1] 发起

test('[1] 发起：POST /rotate，body 只有 device_id，不带旧 Key', async () => {
  const { transport, calls } = makeTransport([json(200, SUCCESS_BODY)])
  const { outcome } = await runRotate({ transport })

  assert.equal(calls.length, 1, '换一次 Key 只发一条请求')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, inviteBaseUrl + '/rotate')
  assert.equal(rotate.ROTATE_URL, inviteBaseUrl + '/rotate')
  assert.equal(calls[0].followRedirects, false, '破坏性操作不许跟随 3xx 重放')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), { device_id: DEVICE_ID }, 'body 只有 device_id')
  assert.equal(calls[0].body.includes(OLD_KEY), false, '旧 Key 绝不出现在请求体里')
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.via, 'primary')
})

// ------------------------------------------------------------------ [2] 成功：落盘 + 额度不变

test('[2] 成功：新 Key 立刻落盘一次，剩余额度与换前一致（额度不丢）', async () => {
  const { transport } = makeTransport([json(200, SUCCESS_BODY)])
  const { outcome, storage } = await runRotate({ transport })

  assert.equal(outcome.kind, 'ok')
  assert.equal(storage.writes, 1, '落盘只发生一次')
  assert.equal(storage.apiKey, NEW_KEY, '本地存档换成了新 Key')
  assert.equal(outcome.apiKey, NEW_KEY)
  assert.equal(outcome.saved, true)
  assert.equal(outcome.rotated, true)
  assert.equal(outcome.replaced, true)

  assert.ok(outcome.profile !== null, '响应里的额度档案要带出来给界面直接用')
  assert.equal(outcome.profile.remainingPoints, BEFORE.remainingPoints, '剩余额度与换前完全一致')
  assert.equal(outcome.profile.quotaPoints, BEFORE.quotaPoints)
  assert.equal(outcome.profile.usedPoints, BEFORE.usedPoints)
  assert.equal(outcome.profile.inviteCode, '9XST3MHE')
})

// ------------------------------------------------------------------ [3] 旧 Key 失效处理

test('[3] 旧 Key 失效处理：本地只留新 Key，排查字段不外泄', async () => {
  const { transport } = makeTransport([json(200, SUCCESS_BODY)])
  const { outcome, storage } = await runRotate({ transport })

  // 旧 Key 在本地已经不存在：既不在存档里，也不在返回值里
  assert.notEqual(storage.apiKey, OLD_KEY, '旧 Key 不再留在本地（服务端已让它失效）')
  assert.equal(JSON.stringify(outcome).includes(OLD_KEY), false)
  // issue 要求不展示的排障字段，连解析都不做
  const text = JSON.stringify(outcome)
  assert.equal(text.includes('previous_key_id'), false, 'previous_key_id 不对外')
  assert.equal(text.includes('carried_used_points'), false, 'carried_used_points 不对外')
  assert.equal(text.includes('123'), false, 'previous_key_id 的值也不出现')
})

test('[3b] 服务端返回的还是原 Key：照样算成功，但标记 replaced=false 让界面别说「已换」', async () => {
  const body = { ...SUCCESS_BODY, key: OLD_KEY, rotated: false }
  const { transport } = makeTransport([json(200, body)])
  const { outcome, storage } = await runRotate({ transport })

  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.replaced, false)
  assert.equal(outcome.rotated, false)
  assert.equal(storage.apiKey, OLD_KEY)
})

// ------------------------------------------------------------------ [4] 失败绝不动旧 Key

// [标签, 服务端回什么, 期望文案 key, 期望请求条数]
// 链路不通要换域名再打一次（2 条）；业务错误说明请求已被处理，绝不重放（1 条）。
const FAILURES = [
  ['网络不通', { kind: 'network', message: 'offline' }, 'oursRotateErrNetwork', 2],
  ['请求超时', { kind: 'timeout', message: 'timeout' }, 'oursRotateErrTimeout', 2],
  ['404 device_not_found', errorBody('device_not_found'), 'oursRotateErrDeviceNotFound', 1],
  ['400 invalid_device', json(400, { error: { code: 'invalid_device' } }), 'oursRotateErrInvalidDevice', 1],
  ['500 internal', json(500, { error: { code: 'internal' } }), 'oursRotateErrInternal', 1],
  ['429 rate_limited', json(429, { error: { code: 'rate_limited' } }), 'oursRotateErrRateLimited', 1],
]

for (const [label, reply, expectedKey, expectedCalls] of FAILURES) {
  test(`[4] 失败不破坏本地旧 Key：${label}`, async () => {
    const { transport, calls } = makeTransport([reply])
    const { outcome, storage } = await runRotate({ transport })

    assert.equal(outcome.kind, 'error')
    assert.equal(storage.writes, 0, '失败时一次都不许写存档')
    assert.equal(storage.apiKey, OLD_KEY, '旧 Key 原样还在（用户不会突然失去服务）')
    assert.equal(outcome.keptOldKey, true)
    assert.equal(outcome.messageKey, expectedKey)
    assert.equal(calls.length, expectedCalls, `请求条数应为 ${expectedCalls}`)
    // 文案必须真的是中文（不是没翻译的 key）
    assert.equal(typeof zh[expectedKey], 'string')
    assert.notEqual(zh[expectedKey], '')
  })
}

test('[4b] 设备码读不到：本地先拦下，一条请求都不发，旧 Key 不动', async () => {
  const { transport, calls } = makeTransport([json(200, SUCCESS_BODY)])
  const { outcome, storage } = await runRotate({ transport, deviceId: '   ' })

  assert.equal(calls.length, 0)
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.code, 'DEVICE_MISSING')
  assert.equal(storage.writes, 0)
  assert.equal(storage.apiKey, OLD_KEY)
})

// ------------------------------------------------------------------ [5] 200 却没给 Key

test('[5] 200 但没有 key：不落盘，报 KEY_MISSING（否则本地会存一把空 Key）', async () => {
  const body = { ...SUCCESS_BODY, key: '   ' }
  const { transport } = makeTransport([json(200, body)])
  const { outcome, storage } = await runRotate({ transport })

  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.code, 'KEY_MISSING')
  assert.equal(outcome.messageKey, 'oursRotateErrNoKeyInResponse')
  assert.equal(storage.writes, 0)
  assert.equal(storage.apiKey, OLD_KEY)
})

// ------------------------------------------------------------------ [6] 绝不自愈

test('[6] device_not_found 不自愈：绝不补 POST /apply（那会静默发一把新 Key）', async () => {
  const { transport, calls } = makeTransport([errorBody('device_not_found')])
  const { outcome } = await runRotate({ transport })

  assert.equal(outcome.kind, 'error')
  assert.equal(calls.length, 1, '只有 /rotate 这一条')
  assert.equal(calls[0].url, rotate.ROTATE_URL)
  assert.equal(
    calls.some((call) => call.url.includes('/apply')),
    false,
    '换 Key 链路里**不能**出现 /apply'
  )
  assert.equal(zh[outcome.messageKey], '本机还没有领取过 Key，请先领取')
})

test('[6b] 400 invalid_device 不重生设备码、不重发：交用户重启 App（issue 文案）', async () => {
  const { transport, calls } = makeTransport([json(400, { error: { code: 'invalid_device' } })])
  const { outcome, storage } = await runRotate({ transport })

  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].body).device_id, DEVICE_ID, '设备码原样，没有重生')
  assert.equal(outcome.kind, 'error')
  assert.equal(zh[outcome.messageKey], '设备标识异常，请重启 App 重试')
  assert.equal(storage.apiKey, OLD_KEY)
})

// ------------------------------------------------------------------ [7] 兜底只兜链路不通

test('[7] 主链路不通 → 兜底支付侧 base 的 /invite/rotate，且只兜一次', async () => {
  const { transport, calls } = makeTransport([{ kind: 'timeout', message: 't' }, json(200, SUCCESS_BODY)])
  const { outcome, storage } = await runRotate({ transport })

  // 兜底地址不再写字面量（#484 A6）：就是 config/endpoints.json 里 pay.baseUrl 那一台
  const fallbackUrl = `${globalThis.__ENDPOINTS__.pay.baseUrl}/invite/rotate`
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, rotate.ROTATE_URL)
  assert.equal(calls[1].url, fallbackUrl)
  assert.equal(rotate.ROTATE_FALLBACK_URL, fallbackUrl)
  assert.equal(JSON.parse(calls[1].body).device_id, DEVICE_ID)
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.via, 'fallback')
  assert.equal(outcome.primaryFailure, 'TIMEOUT')
  assert.equal(storage.apiKey, NEW_KEY, '兜底成功同样要落盘')
})

test('[7b] 业务错误（400）不兜底：请求已经到服务端并被处理，重发没意义', async () => {
  const { transport, calls } = makeTransport([json(400, { error: { code: 'invalid_device' } })])
  await runRotate({ transport })
  assert.equal(calls.length, 1)
})

test('[7c] 兜底也不通：报错且旧 Key 不动', async () => {
  const { transport, calls } = makeTransport([
    { kind: 'network', message: 'x' },
    { kind: 'network', message: 'y' },
  ])
  const { outcome, storage } = await runRotate({ transport })

  assert.equal(calls.length, 2)
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.via, 'fallback')
  assert.equal(storage.writes, 0)
  assert.equal(storage.apiKey, OLD_KEY)
})

// ------------------------------------------------------------------ [8] 文案

test('[8] 三个错误码文案与 issue 表格逐字一致', () => {
  assert.equal(zh.oursRotateErrDeviceNotFound, '本机还没有领取过 Key，请先领取')
  assert.equal(zh.oursRotateErrInvalidDevice, '设备标识异常，请重启 App 重试')
  // #357：云端语义变成「原地重置额度」，界面上这个动作也叫「重置」，失败文案跟着同一口径
  assert.equal(zh.oursRotateErrInternal, '重置失败，请稍后重试')
})

test('[8b] 二次确认文案必须如实说明「只重算额度、Key 不变、别的客户端不受影响」', () => {
  // #357：/rotate 不再换发新的 Key 字符串，旧 Key 也不会失效 ——
  // 原来这里钉的是「立即失效 / 无法找回」，那句已经和实际不符，改成钉新语义。
  assert.match(zh.oursRotateConfirmBody, /额度/)
  assert.match(zh.oursRotateConfirmBody, /Key 本身不变|Key 不变/)
  // 必须说清「不影响别的客户端」，避免用户以为要重新填 Key
  assert.match(zh.oursRotateConfirmBody, /其它|其他/)
  // 反面：不许再声称旧 Key 会失效 / 找不回来
  assert.equal(/立即失效|无法找回/.test(zh.oursRotateConfirmBody), false, 'Key 不再失效，文案不许再这么说')
  assert.match(en.oursRotateConfirmBody, /stays the same|cannot|unchanged/i)
  assert.equal(/cannot be recovered|stops working immediately/i.test(en.oursRotateConfirmBody), false)
})

test('[8c] zh / en 的文案 key 一一对应（新增键只加不改）', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
})

// ------------------------------------------------------------------ [9] 隐私

test('[9] 隐私：整条链路一条 console 都没有，返回值不含完整设备码', async () => {
  const seen = []
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  console.log = (...args) => seen.push(args.join(' '))
  console.warn = (...args) => seen.push(args.join(' '))
  console.error = (...args) => seen.push(args.join(' '))
  console.info = (...args) => seen.push(args.join(' '))
  try {
    const ok = makeTransport([json(200, SUCCESS_BODY)])
    const { outcome } = await runRotate({ transport: ok.transport })
    assert.equal(JSON.stringify(outcome).includes(DEVICE_ID), false, '返回值里没有完整 device_id')
    const failed = makeTransport([errorBody('device_not_found')])
    await runRotate({ transport: failed.transport })
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    console.info = originals.info
  }
  assert.deepEqual(seen, [], `不许有任何 console：${seen.join(' | ')}`)
})

// ------------------------------------------------------------------ [10] UI 接线（源码断言）

const dialogSource = readFileSync(new URL('../../src/components/settings/OursServicesDialog.tsx', import.meta.url), 'utf8')

test('[10] 设置页有「更换 Key」入口 + 二次确认弹窗 + 置灰防连点', () => {
  assert.match(dialogSource, /ours-rotate-open/, '入口按钮')
  assert.match(dialogSource, /ours-rotate-confirm/, '二次确认块')
  assert.match(dialogSource, /ours-rotate-submit/, '确认后的提交按钮')
  assert.match(dialogSource, /ours-rotate-cancel/, '取消按钮')
  assert.match(dialogSource, /oursRotateConfirmBody/, '确认文案里要有风险说明')
  // 连点保护：提交按钮在 busy 时 disabled
  assert.match(dialogSource, /disabled=\{rotateBusy/, '更换中必须置灰')
})

test('[10b] UI 用同一个传输层 + 同一个落盘入口，成功后立刻刷新余额', () => {
  assert.match(dialogSource, /from '\.\.\/\.\.\/services\/invite\/rotate\.js'/, '走 rotate 服务层，不另造请求')
  assert.match(dialogSource, /rotateKey\(\{/, '调用服务层的 rotateKey')
  assert.match(dialogSource, /saveKey:\s*\(?key/, '把 setApiKey 作为落盘入口注入')
  assert.match(dialogSource, /setApiKey\(/, '成功时落盘到当前渠道配置')
  assert.match(dialogSource, /setBalance\(\{ status: 'ok', profile/, '成功后余额立即刷新')
  // 失败分支不许把 Key 清空
  assert.equal(/setApiKey\(''\)/.test(dialogSource), false, '任何分支都不许把本地 Key 清空')
})
