// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s] 说明见 tests/README.md
// 邀请 / 额度服务（http://140.210.13.146:60013）与设备码单测（Issue #21）。
// 只 import src/services/invite/{api,device}.ts，用假 transport / 假存储断言行为，
// 不碰 DOM、不发网络请求、不打印任何凭据。
//
//   cd /root/worktrees/deepseek-pay-integration && node tests/unit/ours-invite.test.mjs
//
// 覆盖（对应任务书验收）：
//   [1] 设备码：8–128 位、字符集 [A-Za-z0-9._:-]、首次生成后持久化、坏值重建、不进日志
//   [2] /apply：201 首次 / 200 已申请（幂等，同一把 Key），请求体只有 device_id
//   [3] /me：解析 remaining_points 等字段；device_id 走 query；响应里不含 key
//   [4] 邀请码绑定：成功 → reward_points；大小写规范化
//   [5] 邀请码全部错误码：device_not_found / invalid_code / own_code / already_redeemed /
//       code_exhausted / rate_limited（含网络与超时）
//   [6] 隐私：整条链路一条 console 都没有；返回值里没有完整 device_id / Key
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

const { zh } = await import('../../src/i18n/zh.ts')
const {
  INVITE_API_BASE,
  applyForKey,
  fetchInviteProfile,
  isInviteCodeShape,
  normalizeInviteCode,
  parseInviteProfile,
  redeemInviteCode,
} = await import('../../src/services/invite/api.ts')
const {
  DEVICE_ID_PATTERN,
  DEVICE_ID_STORAGE_KEY,
  createDeviceId,
  isDeviceId,
  loadOrCreateDeviceId,
} = await import('../../src/services/invite/device.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const API_KEY = 'sk-live-unit-test-11223344556677889900aabbccddeeff'
const PROFILE = {
  invite_code: 'G7TA7UR3',
  invited_count: 2,
  max_invites: 20,
  bonus_points: 50,
  redeemed: true,
  quota_points: 150,
  used_points: 20,
  remaining_points: 130,
  key_status: 'active',
}

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${label} = ${a}`)
  } else {
    bad(`${label}：期望 ${b}，实际 ${a}`)
  }
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}
const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const errorBody = (code) => ({ error: { code, message: 'server says no' } })

// ---------------------------------------------------------------- [1] 设备码
console.log('\n[1] 设备码：长度/字符集/持久化/坏值重建')
{
  const id = createDeviceId()
  eq(id.length, 34, '生成长度（d- + 32 位十六进制）')
  truthy(DEVICE_ID_PATTERN.test(id), `符合服务端字符集 ${DEVICE_ID_PATTERN}`)
  truthy(id.startsWith('d-'), '带 d- 前缀，一眼看出是设备码')
  truthy(id.length >= 8 && id.length <= 128, '落在 8–128 位之间')
  truthy(createDeviceId() !== createDeviceId(), '两次生成不相同')
  eq(isDeviceId('short'), false, '7 位太短 → 非法')
  eq(isDeviceId('has space-----'), false, '含空格 → 非法')
  eq(isDeviceId('汉字devicе123456'.slice(0, 12)), false, '含非白名单字符 → 非法')
  eq(isDeviceId('A'.repeat(129)), false, '超 128 位 → 非法')
  eq(isDeviceId('Abc.123:xyz_09-'), true, '允许的字符集全用上 → 合法')

  // 持久化：第二次读到的必须是同一个（清缓存以外不丢）
  const store = new Map()
  const storage = {
    read: () => store.get(DEVICE_ID_STORAGE_KEY) ?? null,
    write: (value) => store.set(DEVICE_ID_STORAGE_KEY, value),
  }
  const first = loadOrCreateDeviceId(storage)
  eq(first.created, true, '首次生成')
  const second = loadOrCreateDeviceId(storage)
  eq(second.deviceId, first.deviceId, '第二次读到同一个设备码')
  eq(second.created, false, '第二次不再重建（created=false）')
  eq(store.get(DEVICE_ID_STORAGE_KEY), first.deviceId, '已写进存储')
  eq(DEVICE_ID_STORAGE_KEY, 'chat-demo:ours-device-id', '存储 key 固定（不随渠道切换变化）')

  // 坏值（老版本/手工改坏）必须重建，否则服务端一直报参数错误且用户无法自救
  store.set(DEVICE_ID_STORAGE_KEY, 'bad id!')
  const repaired = loadOrCreateDeviceId(storage)
  eq(repaired.created, true, '非法已存值 → 重建')
  truthy(isDeviceId(repaired.deviceId), '重建后合法')
  truthy(repaired.deviceId !== 'bad id!', '坏值被覆盖')
}

// ---------------------------------------------------------------- [2] /apply
console.log('\n[2] /apply：201 首次 / 200 已申请，同一 device_id 幂等')
{
  const { transport, calls } = fakeTransport([
    json(201, { ...PROFILE, key: API_KEY }),
    json(200, { ...PROFILE, key: API_KEY }),
  ])
  const first = await applyForKey(DEVICE_ID, transport)
  const second = await applyForKey(DEVICE_ID, transport)
  eq(calls.length, 2, '两次调用只发两次请求（重试安全）')
  eq(calls[0].method, 'POST', 'method')
  eq(calls[0].url, `${INVITE_API_BASE}/apply`, '/apply')
  eq(INVITE_API_BASE, inviteBaseUrl, '邀请服务地址（明文 HTTP）')
  eq(JSON.parse(calls[0].body), { device_id: DEVICE_ID }, '请求体只有 device_id')
  eq(calls[0].followRedirects, false, '不跟随重定向')
  eq(first.kind, 'ok', '201 → ok')
  eq(first.firstTime, true, '201 → firstTime')
  eq(first.apiKey, API_KEY, '拿到 Key')
  eq(first.profile.inviteCode, 'G7TA7UR3', '邀请码')
  eq(first.profile.remainingPoints, 130, '剩余积分')
  eq(second.kind, 'ok', '200 → ok')
  eq(second.firstTime, false, '200 → 不是首次（幂等）')
  eq(second.apiKey, first.apiKey, '幂等返回同一把 Key')

  const missingKey = await applyForKey(DEVICE_ID, fakeTransport([json(201, { ...PROFILE })]).transport)
  eq(missingKey.kind, 'error', '响应里没有 key → 报错')
  eq(zh[missingKey.messageKey], '服务端没有返回 Key，请重试', '缺 Key 文案')

  const network = await applyForKey(DEVICE_ID, fakeTransport([{ kind: 'network' }]).transport)
  eq(zh[network.messageKey], '网络不可用，请稍后重试', '断网文案')
  eq(network.retryable, true, '断网可重试')
  const timeout = await applyForKey(DEVICE_ID, fakeTransport([{ kind: 'timeout' }]).transport)
  eq(zh[timeout.messageKey], '请求超时，请稍后重试', '超时文案')

  const noDevice = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
    return { result: await applyForKey('   ', t2), calls: c2 }
  })()
  eq(noDevice.calls.length, 0, '空 device_id 一次请求都不发')
  eq(zh[noDevice.result.messageKey], '设备码缺失，无法完成操作', '空 device_id 文案')
}

// ---------------------------------------------------------------- [3] /me
console.log('\n[3] /me：解析档案，device_id 走 query，没有 key')
{
  const { transport, calls } = fakeTransport([json(200, PROFILE)])
  const result = await fetchInviteProfile(DEVICE_ID, transport)
  eq(calls[0].method, 'GET', 'method')
  eq(calls[0].url, `${INVITE_API_BASE}/me?device_id=${encodeURIComponent(DEVICE_ID)}`, '/me?device_id=…')
  eq(result.kind, 'ok', 'ok')
  eq(result.profile.remainingPoints, 130, 'remaining_points')
  eq(result.profile.quotaPoints, 150, 'quota_points')
  eq(result.profile.usedPoints, 20, 'used_points')
  eq(result.profile.invitedCount, 2, 'invited_count')
  eq(result.profile.maxInvites, 20, 'max_invites')
  eq(result.profile.keyStatus, 'active', 'key_status')
  truthy(!('apiKey' in result.profile) && !('key' in result.profile), '/me 结果里没有 key')

  const notFound = await fetchInviteProfile(
    DEVICE_ID,
    fakeTransport([json(404, errorBody('device_not_found'))]).transport
  )
  eq(zh[notFound.messageKey], '服务端没有这个设备码的记录，请点「领取 / 重新领取」', 'device_not_found 文案')

  eq(parseInviteProfile({}), null, '缺字段 → null')
  eq(parseInviteProfile({ invite_code: 'X' }), null, '缺 remaining_points → null')
  eq(parseInviteProfile(null), null, 'null → null')
  const partial = parseInviteProfile({ invite_code: 'AB12', remaining_points: 0 })
  eq(partial.remainingPoints, 0, '额度为 0 仍然能解析（不是错误）')
  eq(partial.invitedCount, 0, '缺的数值字段补 0')
}

// ---------------------------------------------------------------- [4] 邀请码绑定
console.log('\n[4] 绑定邀请码：成功 → reward_points；大小写规范化')
{
  eq(normalizeInviteCode('  g7ta7ur3 '), 'G7TA7UR3', '转大写去空格')
  eq(isInviteCodeShape('g7ta7ur3'), true, '形状校验')
  eq(isInviteCodeShape('ab'), false, '太短')

  const { transport, calls } = fakeTransport([
    json(200, { ...PROFILE, reward_points: 20, synced: true }),
  ])
  const result = await redeemInviteCode({ deviceId: DEVICE_ID, inviteCode: ' g7ta7ur3 ' }, transport)
  eq(calls[0].method, 'POST', 'method')
  eq(calls[0].url, `${INVITE_API_BASE}/redeem`, '/redeem')
  eq(JSON.parse(calls[0].body), { device_id: DEVICE_ID, invite_code: 'G7TA7UR3' }, '请求体（邀请码已规范化）')
  eq(result.kind, 'ok', 'ok')
  eq(result.rewardPoints, 20, 'reward_points')
  eq(result.synced, true, 'synced')
  eq(result.profile.remainingPoints, 130, '响应带档案时直接用')

  const withoutProfile = await redeemInviteCode(
    { deviceId: DEVICE_ID, inviteCode: 'G7TA7UR3' },
    fakeTransport([json(200, { reward_points: 20, synced: false })]).transport
  )
  eq(withoutProfile.kind, 'ok', '没有档案也算成功')
  eq(withoutProfile.profile, null, '界面据此再查一次 /me')

  const empty = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(200, {})])
    return { result: await redeemInviteCode({ deviceId: DEVICE_ID, inviteCode: '   ' }, t2), calls: c2 }
  })()
  eq(empty.calls.length, 0, '空邀请码一次请求都不发')
  eq(zh[empty.result.messageKey], '请先填写邀请码', '空邀请码文案')
}

// ---------------------------------------------------------------- [5] 全部错误码
console.log('\n[5] 邀请码全部错误码 → 各自能看的文案')
{
  const cases = [
    ['device_not_found', 404, '服务端没有这个设备码的记录，请点「领取 / 重新领取」', false],
    ['invalid_code', 404, '邀请码无效，请核对后重试', false],
    ['own_code', 400, '不能填自己的邀请码', false],
    ['already_redeemed', 409, '已经绑定过邀请码，不能重复绑定', false],
    ['code_exhausted', 409, '这个邀请码的奖励名额已用完', false],
    ['rate_limited', 429, '操作太频繁，请稍后再试', true],
  ]
  for (const [code, status, text, retryable] of cases) {
    const result = await redeemInviteCode(
      { deviceId: DEVICE_ID, inviteCode: 'G7TA7UR3' },
      fakeTransport([json(status, errorBody(code))]).transport
    )
    eq(result.kind, 'error', `${code} 是错误`)
    eq(result.code, code, `${code} 保留服务端 code`)
    eq(zh[result.messageKey], text, `${code} → ${text}`)
    eq(result.retryable, retryable, `${code} retryable=${retryable}`)
    truthy(!JSON.stringify(result).includes(DEVICE_ID), `${code} 结果不含完整 device_id`)
  }

  // 状态码兜底（服务端没给 code 时也不能是白屏）
  const noCode = await redeemInviteCode(
    { deviceId: DEVICE_ID, inviteCode: 'G7TA7UR3' },
    fakeTransport([json(404, { message: 'not found' })]).transport
  )
  eq(noCode.code, 'HTTP_404', '没有 code 时用 HTTP_404')
  eq(zh[noCode.messageKey], '服务端没有这个设备码的记录，请点「领取 / 重新领取」', '404 兜底文案')
}

// ---------------------------------------------------------------- [6] 隐私
console.log('\n[6] 隐私：不写 console、返回值不带完整凭据')
{
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const leaked = []
  const spy = (...args) => leaked.push(args.map((arg) => String(arg)).join(' '))
  console.log = spy
  console.warn = spy
  console.error = spy
  console.info = spy
  try {
    await applyForKey(DEVICE_ID, fakeTransport([json(201, { ...PROFILE, key: API_KEY })]).transport)
    await fetchInviteProfile(DEVICE_ID, fakeTransport([json(200, PROFILE)]).transport)
    await redeemInviteCode(
      { deviceId: DEVICE_ID, inviteCode: 'G7TA7UR3' },
      fakeTransport([json(200, { reward_points: 5, synced: true })]).transport
    )
    await applyForKey(DEVICE_ID, fakeTransport([{ kind: 'network' }]).transport)
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    console.info = originals.info
  }
  eq(leaked.length, 0, '整条链路一条 console 都没写')
  truthy(!leaked.join('\n').includes(API_KEY), '日志里没有完整 Key')
  truthy(!leaked.join('\n').includes(DEVICE_ID), '日志里没有完整 device_id')
  // 文案表里不能出现真实凭据形态
  const text = JSON.stringify(zh)
  truthy(!/sk-[A-Za-z0-9]{8,}/.test(text), 'i18n 文案里没有 Key 形态的串')
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（共 ${checks.n} 项检查）`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.n} 项检查）`)
