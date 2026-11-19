// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s] 说明见 tests/README.md
// 设备指纹上报（Issue #243）：客户端这一半。
//
//   cd /d/all_project/runs/fix243 && node tests/unit/invite-device-fingerprint.test.mjs
//
// 只 import src/services/invite/{fingerprint,api,openFlow}.ts，用假原生桥 / 假 transport 断言行为，
// 不碰 DOM、不发网络请求、不打印任何凭据或标识。
//
// 覆盖（对应 #243 的 1–6 条纪律 + PR 里的绿测清单）：
//   [1] 指纹形状：只认 64 位小写十六进制；明文 ANDROID_ID 一律丢弃
//   [2] 原生返回解释：拿到 / 各种拿不到 / 形状不对，都给出确定结论
//   [3] 有指纹：/apply 与 /me（含自愈重发）都带 X-Device-Fp，其余字节不动
//   [4] 无指纹：一个头都不加，请求照发、流程照走 —— 绝不阻塞注册
//   [5] 哈希非明文：链路上只有 sha256(ANDROID_ID + 包名)，明文一个字节都不出现
//   [6] 隐私：整条链路零 console；可诊断信号只有状态与原因，不含指纹 / 明文
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'

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

const {
  DEVICE_FP_HEADER,
  DEVICE_FP_PATTERN,
  describeFingerprintSignal,
  fpPrefix,
  getFingerprintSignal,
  interpretFingerprint,
  isDeviceFp,
  normalizeDeviceFp,
  readDeviceFingerprint,
  resetFingerprintSignalForTest,
  resolveDeviceFp,
} = await import('../../src/services/invite/fingerprint.ts')
const { applyForKey, fetchInviteProfile, runWithDeviceSelfHeal } = await import(
  '../../src/services/invite/api.ts'
)
const { prepareDialogOpen } = await import('../../src/services/invite/openFlow.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const PACKAGE_NAME = 'com.example.deepseekchat'
// 一枚「像真的」ANDROID_ID（16 位小写十六进制）与它的指纹：测试里禁止明文上链路
const ANDROID_ID = 'a1b2c3d4e5f60718'
const FP = createHash('sha256').update(ANDROID_ID + PACKAGE_NAME).digest('hex')
const API_KEY = 'sk-live-unit-test-11223344556677889900aabbccddeeff'
const PROFILE = {
  invite_code: 'G7TA7UR3',
  invited_count: 0,
  max_invites: 20,
  bonus_points: 0,
  redeemed: false,
  quota_points: 100,
  used_points: 0,
  remaining_points: 100,
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
/** 请求里有没有指纹头（大小写不敏感，模拟真实 HTTP 头语义） */
const headerOf = (request, name) => {
  const key = Object.keys(request.headers).find((item) => item.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : request.headers[key]
}

// ---------------------------------------------------------------- [1] 指纹形状
console.log('\n[1] 指纹形状：只认 64 位小写十六进制，明文一律丢弃')
{
  eq(FP.length, 64, 'SHA-256 十六进制长度 64')
  truthy(DEVICE_FP_PATTERN.test(FP), '形状与 DEVICE_FP_PATTERN 一致')
  eq(normalizeDeviceFp(FP), FP, '合法指纹原样通过')
  eq(normalizeDeviceFp(`  ${FP.toUpperCase()}  `), FP, '大写 + 空白 → 归一化成小写')
  eq(normalizeDeviceFp(ANDROID_ID), '', 'ANDROID_ID 明文 → 空（它的形状不是 64 位十六进制）')
  eq(normalizeDeviceFp(FP.slice(0, 63)), '', '63 位 → 空')
  eq(normalizeDeviceFp(`${FP}0`), '', '65 位 → 空')
  eq(normalizeDeviceFp(FP.replace(/^./, 'z')), '', '含非十六进制字符 → 空')
  eq(normalizeDeviceFp(null), '', 'null → 空')
  eq(normalizeDeviceFp(undefined), '', 'undefined → 空')
  eq(normalizeDeviceFp(12345), '', '非字符串 → 空')
  eq(isDeviceFp(FP), true, 'isDeviceFp(哈希) = true')
  eq(isDeviceFp(ANDROID_ID), false, 'isDeviceFp(明文) = false')
  eq(fpPrefix(FP), FP.slice(0, 8), '对外最多露前 8 位')
  eq(fpPrefix(ANDROID_ID), '', '对外露出的前缀不可能来自明文')
}

// ---------------------------------------------------------------- [2] 原生返回解释
console.log('\n[2] 原生返回解释：拿到 / 拿不到 / 形状不对，都给确定结论')
{
  const strong = interpretFingerprint({ available: true, deviceFp: FP, strength: 'strong' })
  eq(strong, { available: true, fp: FP, strength: 'strong' }, 'available=true + strength=strong')

  const base = interpretFingerprint({ available: true, deviceFp: FP })
  eq(base, { available: true, fp: FP, strength: 'base' }, '没有 strength → base')

  const weird = interpretFingerprint({ available: true, deviceFp: FP, strength: 'ultra' })
  eq(weird, { available: true, fp: FP, strength: 'base' }, '没见过的 strength → 退回 base')

  eq(
    interpretFingerprint({ available: false, reason: 'android_id_placeholder' }),
    { available: false, reason: 'android_id_placeholder' },
    '老设备那个「人人相同」的 ANDROID_ID → 如实标注原因'
  )
  eq(
    interpretFingerprint({ available: false, reason: 'not-native' }),
    { available: false, reason: 'not-native' },
    'Web / 非安卓 → not-native'
  )
  eq(
    interpretFingerprint({ available: false, reason: '没见过' }),
    { available: false, reason: 'plugin-unavailable' },
    '原因不在白名单 → 归到 plugin-unavailable'
  )
  eq(
    interpretFingerprint({ available: false }),
    { available: false, reason: 'plugin-unavailable' },
    '没有 reason → plugin-unavailable'
  )
  eq(
    interpretFingerprint({ available: true, deviceFp: ANDROID_ID }),
    { available: false, reason: 'invalid-shape' },
    '原生误把明文当指纹 → 宁可不报也不乱报'
  )
  eq(
    interpretFingerprint({}),
    { available: false, reason: 'plugin-unavailable' },
    '空对象（既没说有也没说没有）→ plugin-unavailable'
  )
  eq(
    interpretFingerprint(null),
    { available: false, reason: 'plugin-unavailable' },
    'null（插件抛错 / 旧壳子没这个方法）→ plugin-unavailable'
  )
}

// ---------------------------------------------------------------- [3] 有指纹：两个请求都带
console.log('\n[3] 有指纹：/apply 与 /me（含自愈重发）都带 X-Device-Fp')
{
  const { transport, calls } = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
  const result = await applyForKey(DEVICE_ID, transport, FP)
  eq(result.kind, 'ok', '/apply 成功')
  eq(DEVICE_FP_HEADER, 'X-Device-Fp', '头名固定')
  eq(headerOf(calls[0], DEVICE_FP_HEADER), FP, '/apply 带上指纹')
  eq(calls[0].method, 'POST', '/apply 仍是 POST')
  eq(calls[0].url, 'http://140.210.13.146:60013/apply', '/apply 地址不变')
  eq(JSON.parse(calls[0].body), { device_id: DEVICE_ID }, 'body 仍是只有 device_id（一个字节没加）')
  eq(calls[0].headers['Content-Type'], 'application/json', '原有 Content-Type 保留')
  eq(calls[0].timeoutMs, 15000, '超时口径不变')
  eq(calls[0].followRedirects, false, '不跟重定向')

  // 大写指纹也要按小写发（服务端口径统一，避免同一台机器算出两枚「不同」指纹）
  const upper = fakeTransport([json(200, { ...PROFILE })])
  await fetchInviteProfile(DEVICE_ID, upper.transport, FP.toUpperCase())
  eq(headerOf(upper.calls[0], DEVICE_FP_HEADER), FP, '/me 收到大写指纹时按小写发')
  eq(
    upper.calls[0].url,
    `http://140.210.13.146:60013/me?device_id=${DEVICE_ID}`,
    '/me 的 device_id 仍走 query（指纹不进 URL）'
  )
  eq(headerOf(upper.calls[0], 'Accept'), 'application/json', '/me 原有 Accept 保留')

  // 自愈链路（device_not_found → 补一把 /apply）同样要带，不能漏
  const heal = fakeTransport([
    json(404, errorBody('device_not_found')),
    json(201, { ...PROFILE, key: API_KEY }),
    json(200, { ...PROFILE }),
  ])
  const saved = []
  const outcome = await runWithDeviceSelfHeal(
    { deviceId: DEVICE_ID, deviceFp: FP, transport: heal.transport, saveKey: (key) => saved.push(key) },
    (deviceId) => fetchInviteProfile(deviceId, heal.transport, FP)
  )
  eq(outcome.kind, 'ok', '自愈后拿到结果')
  eq(outcome.healed, true, 'healed=true')
  eq(heal.calls[1].url, 'http://140.210.13.146:60013/apply', '自愈走 /apply')
  eq(headerOf(heal.calls[1], DEVICE_FP_HEADER), FP, '自愈补发的 /apply 也带指纹')
  eq(headerOf(heal.calls[2], DEVICE_FP_HEADER), FP, '重试的那条 /me 也带指纹')
}

// ---------------------------------------------------------------- [4] 无指纹：降级不阻塞
console.log('\n[4] 无指纹：一个头都不加，请求照发 —— 绝不阻塞注册')
{
  const none = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
  const result = await applyForKey(DEVICE_ID, none.transport)
  eq(result.kind, 'ok', '没有指纹照样领到 Key')
  eq(headerOf(none.calls[0], DEVICE_FP_HEADER), undefined, '没有指纹 → 一个头都不加')
  eq(none.calls.length, 1, '只发一次，不重试、不等待')

  const empty = fakeTransport([json(200, { ...PROFILE })])
  const profile = await fetchInviteProfile(DEVICE_ID, empty.transport, '')
  eq(profile.kind, 'ok', '空串指纹照样查到档案')
  eq(headerOf(empty.calls[0], DEVICE_FP_HEADER), undefined, '空串 → 不加头')

  // 明文 / 坏形状当指纹传进来：丢弃，绝不上链路（防上游误传）
  const plaintext = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
  await applyForKey(DEVICE_ID, plaintext.transport, ANDROID_ID)
  eq(headerOf(plaintext.calls[0], DEVICE_FP_HEADER), undefined, '明文当指纹 → 丢弃，不上链路')
  eq(
    JSON.stringify(plaintext.calls[0]).includes(ANDROID_ID),
    false,
    '请求里（含 header/body/url）没有 ANDROID_ID 明文'
  )

  // 界面入口：拿不到指纹不该影响打开弹层（#100 只读语义不变）
  const open = fakeTransport([json(200, { ...PROFILE })])
  const opened = await prepareDialogOpen({
    deviceId: DEVICE_ID,
    deviceFp: '',
    transport: open.transport,
    hasLocalKey: true,
  })
  eq(opened.kind, 'profile', '没指纹也能只读打开（拿回档案）')
  eq(open.calls.length, 1, '打开弹层仍然只有一条 /me（绝不自作主张 /apply）')

  // resolveDeviceFp：任何失败都收敛成空串，绝不抛
  resetFingerprintSignalForTest()
  const shown = await resolveDeviceFp(async () => ({ available: false, reason: 'not-native' }))
  eq(shown, '', 'Web → 空串')
  eq(getFingerprintSignal(), { available: false, reason: 'not-native' }, '信号记下 not-native（可诊断）')
  eq(describeFingerprintSignal(), 'device-fp:none(not-native)', '一行可诊断信号')
  eq(
    await resolveDeviceFp(async () => {
      throw new Error('旧壳子没有这个插件方法')
    }),
    '',
    '原生抛错 → 空串（不抛出、不阻塞）'
  )
  eq(getFingerprintSignal(), { available: false, reason: 'plugin-unavailable' }, '抛错记为 plugin-unavailable')
  eq(await resolveDeviceFp(async () => null), '', '原生回 null → 空串')
  eq(await resolveDeviceFp(async () => ({ available: true, deviceFp: ANDROID_ID })), '', '明文 → 空串')
  const got = await resolveDeviceFp(async () => ({ available: true, deviceFp: FP, strength: 'strong' }))
  eq(got, FP, '正常 → 拿到哈希')
  eq(describeFingerprintSignal(), 'device-fp:reported', '有指纹时的信号')
  eq(getFingerprintSignal(), { available: true }, '信号里只有「有」，不含指纹本身')
}

// ---------------------------------------------------------------- [5] 哈希非明文
console.log('\n[5] 哈希非明文：链路上只有 sha256(ANDROID_ID + 包名)')
{
  // 客户端约定：原生侧算 sha256(小写(ANDROID_ID) + 包名)，只把哈希交过来
  eq(FP, createHash('sha256').update(ANDROID_ID + PACKAGE_NAME).digest('hex'), '指纹 = sha256(明文+包名)')
  truthy(!FP.includes(ANDROID_ID), '哈希里不含明文子串')
  truthy(FP !== ANDROID_ID, '哈希不等于明文')

  const { transport, calls } = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
  await applyForKey(DEVICE_ID, transport, FP)
  const wire = calls[0]
  eq(headerOf(wire, DEVICE_FP_HEADER), FP, '上报的是哈希')
  truthy(!JSON.stringify(wire).includes(ANDROID_ID), '整条请求（header+body+url）没有明文')
  truthy(!JSON.stringify(wire).includes(ANDROID_ID.toUpperCase()), '也没有大写明文')
  truthy(wire.body.indexOf('device_fp') === -1, '指纹不进 body（只走 header，避免改契约）')

  // 原生返回的形状里也不带明文：只有 available / deviceFp / strength / source
  const interpreted = interpretFingerprint({
    available: true,
    deviceFp: FP,
    strength: 'base',
    source: 'Settings.Secure.ANDROID_ID+PackageManager',
  })
  eq(interpreted, { available: true, fp: FP, strength: 'base' }, '解释结果只留哈希与强度')
  truthy(!JSON.stringify(interpreted).includes(ANDROID_ID), '解释结果不含明文')

  // 同一台机器重复读，指纹必须稳定（不稳定会导致「同一台机器被当成新设备」，反而送分）
  const a = await resolveDeviceFp(async () => ({ available: true, deviceFp: FP }))
  const b = await resolveDeviceFp(async () => ({ available: true, deviceFp: FP }))
  eq(a, b, '重复读同一台机器 → 同一枚指纹')
}

// ---------------------------------------------------------------- [6] 隐私
console.log('\n[6] 隐私：零 console，信号里没有指纹 / 明文')
{
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  const leaked = []
  console.log = (...args) => leaked.push(args.join(' '))
  console.info = (...args) => leaked.push(args.join(' '))
  console.warn = (...args) => leaked.push(args.join(' '))
  console.error = (...args) => leaked.push(args.join(' '))
  try {
    await applyForKey(DEVICE_ID, fakeTransport([json(201, { ...PROFILE, key: API_KEY })]).transport, FP)
    await fetchInviteProfile(DEVICE_ID, fakeTransport([json(200, PROFILE)]).transport, FP)
    await applyForKey(DEVICE_ID, fakeTransport([json(201, { ...PROFILE, key: API_KEY })]).transport)
    await resolveDeviceFp(async () => ({ available: false, reason: 'android_id_missing' }))
    await resolveDeviceFp(async () => ({ available: true, deviceFp: FP }))
    describeFingerprintSignal()
  } finally {
    console.log = originals.log
    console.info = originals.info
    console.warn = originals.warn
    console.error = originals.error
  }
  eq(leaked.length, 0, '整条链路一条 console 都没写')
  const text = leaked.join('\n')
  truthy(!text.includes(FP), '日志里没有完整指纹')
  truthy(!text.includes(ANDROID_ID), '日志里没有明文 ANDROID_ID')

  // 可诊断信号本身也不能带指纹内容（第 6 条纪律）
  eq(describeFingerprintSignal(), 'device-fp:reported', '信号只说明「有/没有」')
  truthy(!describeFingerprintSignal().includes(FP.slice(0, 8)), '信号里连哈希前缀都没有')
  eq(
    describeFingerprintSignal().includes(ANDROID_ID),
    false,
    '信号里没有明文'
  )
  resetFingerprintSignalForTest()
  eq(describeFingerprintSignal(), 'device-fp:unreported', '没读过 → unreported（不假装成功）')
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
