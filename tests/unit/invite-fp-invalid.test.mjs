// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// 被测对象：`src/services/invite/fingerprint.ts` 的「可信指纹」判定 + 上报语义（Issue #395）
//
// 为什么要有这条：`DEVICE_FP_PATTERN = /^[0-9a-f]{64}$/` 只校验**形状**，于是 `0`×64
// （模拟器 / 部分 ROM / 指纹读失败后的兜底常量）完全合法。服务端把它当「这台机器」的身份 →
// 第一台注册的账号被其后所有同类设备共享：多台无关设备写着同一个 device_id、共用一把 Key 与余额。
// 所以本文件把「形状对」与「可信」拆成两件事，并逐行断言**上报 / 不上报**。
//
// 一张表 6 行（每行 7 条断言，覆盖同一输入的五个观测面）：
//   F1 正常指纹        → 上报（请求头里就是这枚哈希）
//   F2 全零 `0`×64     → 不上报，reason=constant_fp
//   F3 全 F  `f`×64    → 不上报，reason=constant_fp
//   F4 长度不符        → 不上报，reason=invalid-shape
//   F5 常量字符串      → 不上报，reason=invalid-shape
//   F6 空串            → 不上报，reason=invalid-shape
//
// 五个观测面（每行都要一致，任一处「放行」都是线上那类事故）：
//   normalizeDeviceFp / isDeviceFp / interpretFingerprint / resolveDeviceFpReport(+resolveDeviceFp)
//   / 真实请求（applyForKey 与 fetchInviteProfile 的 `X-Device-Fp` 头）
//
// 跑法：
//   node tests/run-layer.mjs unit --only invite-fp-invalid
//   node --test tests/unit/invite-fp-invalid.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { inviteBaseUrl } from '../../scripts/lib/endpoints.mjs'
import { installTsResolve, loadTsModule, ROOT } from '../helpers/dom-env.mjs'

// `__ENDPOINTS__` 是 rspack DefinePlugin 打包期替换的标识符（Node 里由 tests/helpers/injected.mjs
// 注入）。单文件直跑时没有那个预加载，这里按同一份配置兜底，保证「每个文件都能单独跑」。
globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl: 'https://chat.test.invalid',
  inviteBaseUrl,
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([]),
  allowedHosts: Object.freeze([]),
})

installTsResolve()
const fingerprint = await loadTsModule('src/services/invite/fingerprint.ts')
const { applyForKey, fetchInviteProfile } = await loadTsModule('src/services/invite/api.ts')

const {
  CONSTANT_DEVICE_FP_VALUES,
  DEVICE_FP_HEADER,
  describeFingerprintSignal,
  fpPrefix,
  interpretFingerprint,
  isConstantDeviceFp,
  isDeviceFp,
  normalizeDeviceFp,
  resetFingerprintSignalForTest,
  resolveDeviceFp,
  resolveDeviceFpReport,
} = fingerprint

const DEVICE_ID = 'd-3950123456789abcdef0123456789abcd'
/** 一枚「像真的」摘要：形状合法、内容无语义（表里所有「正常」断言都用它） */
const GOOD_FP = createHash('sha256').update('android_id:unit-test-395').digest('hex')
const API_KEY = 'sk-live-unit-395-00112233445566778899aabbccddeeff'
const PROFILE = {
  invite_code: 'FP395QW2',
  invited_count: 0,
  max_invites: 20,
  bonus_points: 0,
  redeemed: false,
  quota_points: 100,
  used_points: 0,
  remaining_points: 100,
  key_status: 'active',
}

const ZERO_FP = '0'.repeat(64)
const F_FP = 'f'.repeat(64)

/**
 * 6 行输入表。`reason: null` = 应当**上报**；否则该值必须被当成「没有可信指纹」，
 * 且 reason 必须精确（`constant_fp` 与 `invalid-shape` 分开，排障才知道该修原生读取还是修兜底）。
 */
const FP_ROWS = [
  {
    id: 'F1',
    name: '正常指纹（64 位十六进制摘要）→ 上报',
    input: GOOD_FP,
    reason: null,
  },
  {
    id: 'F2',
    name: '全零 `0`×64 → 不上报（constant_fp）',
    input: ZERO_FP,
    reason: 'constant_fp',
  },
  {
    id: 'F3',
    name: '全 F `f`×64 → 不上报（constant_fp）',
    input: F_FP,
    reason: 'constant_fp',
  },
  {
    id: 'F4',
    name: '长度不符（63 位 / 65 位 / 128 位）→ 不上报（invalid-shape）',
    input: GOOD_FP.slice(0, 63),
    reason: 'invalid-shape',
    extras: [`${GOOD_FP}0`, GOOD_FP.repeat(2)],
  },
  {
    id: 'F5',
    name: '常量字符串（unknown / null / NULL / 短全零）→ 不上报（invalid-shape）',
    input: 'unknown',
    reason: 'invalid-shape',
    extras: ['null', 'NULL', '0'.repeat(16), 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  },
  {
    id: 'F6',
    name: '空串（读失败后没填值）→ 不上报（invalid-shape）',
    input: '',
    reason: 'invalid-shape',
    extras: ['   ', '\n\t'],
  },
]

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

/** 记下每次请求的假 transport（不碰网络） */
const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}

/** 请求里有没有指纹头（大小写不敏感，模拟真实 HTTP 头语义） */
const headerOf = (request, name) => {
  const key = Object.keys(request.headers).find((item) => item.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : request.headers[key]
}

/** 一个输入 → 五个观测面一起断言，任何一个面「放行」都算失败 */
const assertSameVerdict = async (label, input, reason) => {
  const reported = reason === null
  const why = reported ? '上报' : `不上报（${reason}）`

  // 1. 形状 + 内容归一化
  assert.equal(normalizeDeviceFp(input), reported ? GOOD_FP : '', `${label}｜normalizeDeviceFp → ${why}`)
  assert.equal(isDeviceFp(input), reported, `${label}｜isDeviceFp = ${reported}`)
  // 常量前缀不许外露（诊断页只露前 8 位，常量露出来同样没用，还可能被当成身份）
  assert.equal(fpPrefix(input), reported ? GOOD_FP.slice(0, 8) : '', `${label}｜fpPrefix 不露常量`)

  // 2. 原生返回解释：available 由调用方给，结论必须由内容决定
  const interpreted = interpretFingerprint({ available: true, deviceFp: input })
  assert.deepEqual(
    interpreted,
    reported
      ? { available: true, fp: GOOD_FP, strength: 'base' }
      : { available: false, reason },
    `${label}｜interpretFingerprint → ${why}`
  )

  // 3. resolveDeviceFpReport：两种状态用判别联合表达，不许用占位值代表「没有」
  resetFingerprintSignalForTest()
  const report = await resolveDeviceFpReport(async () => ({ available: true, deviceFp: input }))
  assert.deepEqual(
    report,
    reported ? { reported: true, fp: GOOD_FP } : { reported: false, reason },
    `${label}｜resolveDeviceFpReport → ${why}`
  )
  assert.equal(await resolveDeviceFp(async () => ({ available: true, deviceFp: input })), reported ? GOOD_FP : '', `${label}｜resolveDeviceFp`)
  assert.equal(
    describeFingerprintSignal(),
    reported ? 'device-fp:reported' : `device-fp:none(${reason})`,
    `${label}｜可诊断信号`
  )

  // 4. 线缆层：/apply 与 /me 的实际请求头
  const apply = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
  const applied = await applyForKey(DEVICE_ID, apply.transport, input)
  assert.equal(applied.kind, 'ok', `${label}｜/apply 照常成功（绝不阻塞）`)
  assert.equal(
    headerOf(apply.calls[0], DEVICE_FP_HEADER),
    reported ? GOOD_FP : undefined,
    `${label}｜/apply 的 X-Device-Fp`
  )

  const me = fakeTransport([json(200, { ...PROFILE })])
  const profile = await fetchInviteProfile(DEVICE_ID, me.transport, input)
  assert.equal(profile.kind, 'ok', `${label}｜/me 照常成功`)
  assert.equal(
    headerOf(me.calls[0], DEVICE_FP_HEADER),
    reported ? GOOD_FP : undefined,
    `${label}｜/me 的 X-Device-Fp`
  )

  // 5. 不上报时连请求体都不许含这个值：绝不「换个地方带上」
  if (!reported) {
    assert.equal(apply.calls[0].body, JSON.stringify({ device_id: DEVICE_ID }), `${label}｜body 仍是只有 device_id`)
    if (input.length > 0) {
      assert.equal(apply.calls[0].url.includes(encodeURIComponent(input)), false, `${label}｜坏值没有绕道进 URL`)
    }
  }
}

// ------------------------------------------------------------------ 主表：6 行输入

for (const row of FP_ROWS) {
  test(`${row.id} ${row.name}`, async () => {
    await assertSameVerdict(row.id, row.input, row.reason)
    for (const extra of row.extras ?? []) {
      await assertSameVerdict(`${row.id}+`, extra, row.reason)
    }
  })
}

// ------------------------------------------------------------------ 补充断言

test('全相同字符不分字符种类：`0`×64 / `f`×64 / `a`×64 / 大小写混写都算常量', () => {
  for (const char of ['0', '1', 'a', '8', 'f', 'F', 'A']) {
    const value = char.repeat(64)
    assert.equal(isConstantDeviceFp(value), true, `${char}×64 必须判成常量`)
    assert.equal(normalizeDeviceFp(value), '', `${char}×64 归一化必须是「没有指纹」`)
  }
  // 大小写 / 空白先归一化再判：`' F'×64` 不能因为是大写就漏掉
  assert.equal(normalizeDeviceFp(`  ${F_FP.toUpperCase()}  `), '', '大写的全 F 同样不上报')
  // 只差一位就不是常量（避免误伤真实摘要）
  assert.equal(normalizeDeviceFp(`${'0'.repeat(63)}1`), `${'0'.repeat(63)}1`, '63 个 0 + 1 是可变值，放行')
  assert.equal(isConstantDeviceFp(`${'f'.repeat(63)}0`), false, '全 F 少一位不算常量')
})

test('已知常量摘要：空 ANDROID_ID / 老设备常量 ANDROID_ID 的固定哈希都在黑名单里', () => {
  // 黑名单必须覆盖 issue #395 点名的两类「固定哈希」：ANDROID_ID 为空串、以及老设备那个人人相同的值
  assert.ok(CONSTANT_DEVICE_FP_VALUES.length >= 2, '至少覆盖两类固定哈希')
  for (const value of CONSTANT_DEVICE_FP_VALUES) {
    assert.match(value, /^[0-9a-f]{64}$/, '黑名单条目本身必须是形状合法的摘要')
    assert.equal(isConstantDeviceFp(value), true, `${value} 必须命中常量判定`)
    assert.equal(normalizeDeviceFp(value), '', `${value} 不许上报`)
  }

  // 值与包名绑定：包名一改（config/appIdentity.json）黑名单就失效，所以这里现算一遍比对，
  // 不靠人记 —— 漏改的表现会是一条红用例，而不是线上又出现一堆同号设备。
  const identity = JSON.parse(readFileSync(`${ROOT}/config/appIdentity.json`, 'utf8'))
  const appId = identity.applicationId
  const expected = [
    createHash('sha256').update(`${''}${appId}`).digest('hex'),
    createHash('sha256').update(`9774d56d682e549c${appId}`).digest('hex'),
  ]
  for (const value of expected) {
    assert.equal(CONSTANT_DEVICE_FP_VALUES.includes(value), true, `黑名单缺少当前包名算出的 ${value}（改了包名要同步）`)
  }
})

test('「有指纹」与「没有可信指纹」是两种状态：不上报时一个头都不加，且不重试', async () => {
  for (const constant of [ZERO_FP, F_FP, ...CONSTANT_DEVICE_FP_VALUES]) {
    const { transport, calls } = fakeTransport([json(201, { ...PROFILE, key: API_KEY })])
    await applyForKey(DEVICE_ID, transport, constant)
    assert.equal(calls.length, 1, '只发一次，不为「没有指纹」重试')
    assert.equal(headerOf(calls[0], DEVICE_FP_HEADER), undefined, '常量 → 头不出现（不是发个全零）')
    assert.deepEqual(
      Object.keys(calls[0].headers).sort(),
      ['Accept', 'Content-Type'],
      '没有指纹时头集合与 #243 之前完全一致（不会因为「常量」多出第三个头）'
    )
    assert.equal(calls[0].url, `${inviteBaseUrl}/apply`, '地址不变')
  }
})

test('原生侧若直接报「无指纹」：reason 原样保留，绝不改写成 constant_fp', async () => {
  // constant_fp 只在「形状合法但值是常量」时出现；插件没注册 / 读不到要各说各的
  for (const reason of ['not-native', 'plugin-unavailable', 'android_id_missing', 'android_id_placeholder', 'hash_failed']) {
    assert.deepEqual(
      await resolveDeviceFpReport(async () => ({ available: false, reason })),
      { reported: false, reason },
      `原生原因 ${reason} 必须原样保留`
    )
  }
  // 抛错 / 回 null 也不能假装有指纹
  assert.deepEqual(
    await resolveDeviceFpReport(async () => {
      throw new Error('旧壳子没有这个插件方法')
    }),
    { reported: false, reason: 'plugin-unavailable' },
    '原生抛错 → 没有可信指纹'
  )
  assert.deepEqual(await resolveDeviceFpReport(async () => null), { reported: false, reason: 'plugin-unavailable' })
})

test('回归：真实摘要永远放行，不会被「常量判定」误伤', () => {
  // 指纹是 sha256 输出：随机样本必须全部通过（否则正常用户会掉进「无指纹」，等于退回纯 device_id）
  for (let i = 0; i < 64; i += 1) {
    const fp = createHash('sha256').update(`sample-${i}`).digest('hex')
    assert.equal(normalizeDeviceFp(fp), fp, `sample-${i} 必须放行`)
    assert.equal(isConstantDeviceFp(fp), false, `sample-${i} 不是常量`)
  }
  // 常见「像常量但不是」的输入同样不该被误判成常量（它们本来就形状不符，归 invalid-shape）
  assert.equal(isConstantDeviceFp('unknown'), false)
  assert.equal(isConstantDeviceFp(''), false)
})
