// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// Issue #306（母单 #301 维度 2）：诊断字段契约 + 采集层清洗。
//
// 改造前的问题：`meta` 是一个开放的 `Record<string, string|number|boolean>`，
// 键名全靠调用方自觉 —— 同一个「阶段」有 `check` / `staging` / `stream` 三种写法，
// 「多大」有时叫 `bytes`、有时叫 `download.bytes`；键不统一就切不了片。
//
// 本文件的断言分四块：
//   A 结构化字段：合法值原样落库（键名与取值都在契约里）
//   B 取值收紧：越界/非法一律不写（NaN、负数、0 次尝试、700 的状态码…），不许写「猜的值」
//   C 采集层清洗（负向用例）：超长字符串 / 带密钥的 URL / 对象数组 / 键名像密钥 → 截断或丢弃且不抛
//   D 端点键：只认 config/endpoints.json 的键，认不出来给 other（绝不写完整 URL）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

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

const fields = await import('../../src/services/diagnostics/fields.ts')
const {
  buildMeta,
  sanitizeMeta,
  endpointKeyFromUrl,
  isStage,
  isStatusCode,
  META_KEYS,
  META_VALUE_MAX,
  MAX_META_KEYS,
  MAX_DURATION_MS,
  TRACE_ID_PENDING,
  STAGES,
  LEGACY_STAGES,
} = fields

test('A 合法值：结构化字段按契约原样落库', () => {
  const meta = buildMeta({
    flow: 'chat',
    stage: 'chat.stream',
    attempt: 2,
    status: 200,
    endpointKey: 'chatBaseUrl',
    traceId: 'r-20261119-abcdef',
    // #324：上游短码（error.code / error.type），用来按 code 切片「这个月多少次 invalid_request_error」
    upstreamCode: 'invalid_request_error',
    // #301：reason 从「白名单里的裸键」提升成类型化字段，取值只能来自 reasons.ts 的字典
    reason: 'insufficient-balance',
    durationMs: 1832,
    queueMs: 640,
    retryable: true,
    bytes: 4096,
    totalBytes: 8192,
    speedBps: 2234,
    prepMs: 120,
    ttfbMs: 900,
    firstTokenMs: 1100,
    streamMs: 732,
    chunks: 42,
    gapMaxMs: 380,
    chars: 640,
    charsPerSec: 874.3,
    cacheHit: false,
    fromCache: true,
  })
  assert.deepEqual(meta, {
    flow: 'chat',
    stage: 'chat.stream',
    attempt: 2,
    status: 200,
    endpointKey: 'chatBaseUrl',
    traceId: 'r-20261119-abcdef',
    upstreamCode: 'invalid_request_error',
    reason: 'insufficient-balance',
    durationMs: 1832,
    queueMs: 640,
    retryable: true,
    bytes: 4096,
    totalBytes: 8192,
    speedBps: 2234,
    prepMs: 120,
    ttfbMs: 900,
    firstTokenMs: 1100,
    streamMs: 732,
    chunks: 42,
    gapMaxMs: 380,
    chars: 640,
    charsPerSec: 874.3,
    cacheHit: false,
    fromCache: true,
  })
  // 每个键本身都是原始值（铁律：日志里不许出现对象）
  for (const value of Object.values(meta)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `非原始值: ${String(value)}`)
  }
  // 契约里的键都真的能写进去（防止「定义了但忘了加进 META_KEYS」）
  // 21 = #324 的 upstreamCode；#313 再加两个：`queueMs`（排队等待，上传链路必须能分开
  // 「排队」与「传输」）与 `retryable`（这次失败再试有没有用）；
  // #301 再加一个 `reason`（机器可读原因，取值受 reasons.ts 的 LogReason 约束）
  assert.equal(META_KEYS.length, 24, '键集合的增删必须在这里留一行说明（谁、为什么）')
  assert.equal(Object.keys(meta).length, META_KEYS.length)
})

test('B 取值收紧：非法值不写，越界值夹到上限', () => {
  const clamped = buildMeta({
    durationMs: MAX_DURATION_MS * 3,
    bytes: -5,
    speedBps: 1e15,
    attempt: 2.7,
    status: 700,
    traceId: '有中文的-id',
    charsPerSec: 1234.567,
  })
  assert.equal(clamped.durationMs, MAX_DURATION_MS, '超长耗时夹到 24h')
  assert.equal(clamped.bytes, undefined, '负数计数不写（0 是合法值，不许拿它冒充「量不出来」）')
  assert.equal(clamped.speedBps, 1e12, '异常速率夹到上限')
  assert.equal(clamped.attempt, 3, '尝试次数取整')
  assert.equal(clamped.status, undefined, '700 不是合法状态码 → 不写')
  assert.equal(clamped.traceId, TRACE_ID_PENDING, '非法链路 id 换成占位值')
  assert.equal(clamped.charsPerSec, 1234.6, '吞吐保留 1 位小数')

  const dropped = buildMeta({
    attempt: 0,
    durationMs: Number.NaN,
    bytes: Number.POSITIVE_INFINITY,
    prepMs: -1,
    status: 'weird',
    stage: 'not-a-stage',
    flow: 'nope',
    cacheHit: 'yes',
  })
  assert.deepEqual(dropped, {}, '全部非法 → 一个键都不写（不写猜的值）')

  // endpointKey 认不出来就退成 other（比丢掉更有用：至少知道「不是官方端点」）
  assert.equal(buildMeta({ endpointKey: 'whatever' }).endpointKey, 'other')

  // 运行期守卫：绕过类型塞进来的未知键，buildMeta 也不认
  const sneaky = buildMeta({ '随便一个键': 1, stage: 'chat.stream' })
  assert.deepEqual(sneaky, { stage: 'chat.stream' })
})

test('C 负向用例：超长 / 带密钥的 URL / 非原始类型 → 截断或丢弃且不抛', () => {
  const longText = `x`.repeat(5000)
  const apiKeyInUrl = `https://relay.example.com/v1/messages?token=sk-abcdefghijklmnopqrstuvwxyz&sig=1`
  const meta = sanitizeMeta({
    // 1) 超长字符串 → 截断到 META_VALUE_MAX
    'error.msg': longText,
    // 2) 值里带完整 URL（含签名与 sk- key） → 只剩 path，密钥变 ***
    'url.path': apiKeyInUrl,
    // 3) 非原始类型 → 丢弃
    'req.bodyBytes': { nested: true },
    reason: ['a', 'b'],
    method: undefined,
    action: null,
    stage: Number.NaN,
    threshold: Number.POSITIVE_INFINITY,
    // 4) 键名像密钥 → 整条丢弃（值可能是 Key 原文）
    apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
    'provider.token': 'abc',
    // 5) 白名单外的键 → 丢弃
    '随便一个键': 'x',
    nonsense: 1,
    // 6) 合法值：数字与布尔原样保留
    'http.status': 200,
    native: true,
  })

  assert.equal(meta['error.msg'].length, META_VALUE_MAX, '超长字符串被截断')
  assert.ok(meta['error.msg'].length < longText.length, '截断后不保留整段原文')
  assert.equal(meta['error.msg'], longText.slice(0, META_VALUE_MAX), '按上限整段截断')
  assert.ok(!/https?:\/\//.test(String(meta['url.path'])), `完整 URL 必须消失: ${meta['url.path']}`)
  assert.equal(meta['url.path'], '/v1/messages', '只剩 path（host / query / 签名全丢）')
  for (const key of ['req.bodyBytes', 'reason', 'method', 'action', 'stage', 'threshold']) {
    assert.ok(!(key in meta), `非原始值必须被丢弃: ${key}`)
  }
  for (const key of ['apiKey', 'provider.token', '随便一个键', 'nonsense']) {
    assert.ok(!(key in meta), `不该出现的键必须被丢弃: ${key}`)
  }
  assert.equal(meta['http.status'], 200)
  assert.equal(meta.native, true)
  // 全流程不抛：把各种畸形输入直接怼进去
  for (const bad of [undefined, null, 42, 'text', [], [['a', 1]], () => 1]) {
    assert.deepEqual(sanitizeMeta(bad), {}, `sanitizeMeta(${String(bad)}) 必须返回空对象`)
  }
  // 键数上限：超出的直接丢（不让 meta 撑爆一行日志）
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
  assert.equal(Object.keys(sanitizeMeta(many)).length, 0, '白名单外的批量键全部丢弃')
  const manyAllowed = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [i % 2 ? 'native' : 'count', i % 2 === 0 ? i : true])
  )
  assert.ok(Object.keys(sanitizeMeta(manyAllowed)).length <= MAX_META_KEYS, '键数受上限约束')
})

test('D 端点键：只写 config/endpoints.json 的键，认不出来给 other', async () => {
  const { chatBaseUrl, feedbackUrl, inviteBaseUrl } = globalThis.__ENDPOINTS__
  assert.equal(endpointKeyFromUrl(`${chatBaseUrl}/v1/messages`), 'chatBaseUrl')
  assert.equal(endpointKeyFromUrl(`${feedbackUrl}?x=1`), 'feedbackUrl')
  assert.equal(endpointKeyFromUrl(`${inviteBaseUrl}/api`), 'inviteBaseUrl')
  assert.equal(endpointKeyFromUrl('https://api.deepseek.com/v1/messages'), 'other', '自填地址 → other')
  assert.equal(endpointKeyFromUrl('/v1/messages'), 'other', '相对路径认不出来 → other')
  assert.equal(endpointKeyFromUrl(''), 'other', '空地址不抛，给 other')
  // 端点表缺失（老版本 / 非打包环境）也不能抛
  const saved = globalThis.__ENDPOINTS__
  globalThis.__ENDPOINTS__ = undefined
  try {
    assert.equal(endpointKeyFromUrl(`${chatBaseUrl}/v1/messages`), 'other')
  } finally {
    globalThis.__ENDPOINTS__ = saved
  }
})

test('E 阶段枚举：新值带域前缀，旧值只读兼容（新代码写不出旧值）', () => {
  for (const stage of STAGES) {
    assert.ok(stage.includes('.'), `新 stage 必须带域前缀: ${stage}`)
    assert.ok(isStage(stage))
  }
  for (const legacy of LEGACY_STAGES) {
    assert.equal(isStage(legacy), false, `旧值不许再当新 stage 用: ${legacy}`)
  }
  assert.equal(buildMeta({ stage: 'stream' }).stage, undefined, '旧值写不进结构化字段')
  assert.ok(isStatusCode('timeout') && isStatusCode(429) && !isStatusCode(1000))
})

test('F #301：reason 字典封闭可控，且白名单不再静默丢弃「正在写的键」', async () => {
  const reasons = await import('../../src/services/diagnostics/reasons.ts')
  const { REASON, REASONS, LEGACY_REASONS, REASON_RETRYABLE, isLogReason, retryableFor } = reasons

  // ---- 1. 字典自洽：47 个值、唯一、kebab-case、每个都有默认可重试性 ----------------------------------
  assert.equal(REASONS.length, 47, 'reason 字典就是 47 条（#301 评论里的字典表），增删要同步文档')
  assert.equal(new Set(REASONS).size, REASONS.length, '字典里有重复取值')
  for (const reason of REASONS) {
    assert.match(reason, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `reason 必须是 kebab-case: ${reason}`)
    // `null` = 「看 HTTP 状态码」，只有 http-error 允许这样；其余每个都必须给出定论
    const preset = REASON_RETRYABLE[reason]
    assert.ok(
      typeof preset === 'boolean' || preset === null,
      `缺默认可重试性: ${reason}`
    )
    assert.equal(preset === null, reason === 'http-error', `只有 http-error 可以「看状态码」: ${reason}`)
  }
  // 字典值不许与历史取值重名（重名会让「能认得旧值」变成「分不清新旧」）
  const legacyOverlap = LEGACY_REASONS.filter((value) => REASONS.includes(value))
  assert.deepEqual(legacyOverlap, [], `历史取值与字典重名：${legacyOverlap.join('、')}`)

  // ---- 2. 类型入口：字典值落库，裸字符串写不进结构化字段 --------------------------------------------
  assert.equal(buildMeta({ reason: REASON.cardAlreadyUsed }).reason, 'card-already-used')
  assert.equal(buildMeta({ reason: 'CARD_ALREADY_USED' }).reason, undefined, '上游短码不许当 reason（那是 upstreamCode）')
  assert.ok(isLogReason('stalled') && !isLogReason('stall'))

  // ---- 3. 可重试性：只有 http-error 看状态码 --------------------------------------------------------
  assert.equal(retryableFor('http-error', 404), false, '4xx 是终态，重试同一个结果')
  assert.equal(retryableFor('http-error', 503), true, '5xx 是服务端的事，重试有意义')
  assert.equal(retryableFor('http-error'), false, '拿不到状态码时不许劝用户「再试一次」')
  assert.equal(retryableFor('card-already-used', 409), false, '业务终态不受状态码影响')
  assert.equal(REASON_RETRYABLE['http-error'], null, 'http-error 是唯一「看状态码」的取值')

  // ---- 4. 白名单补漏（#301 本批）：生产里正在写、改造前被静默丢弃的 4 个键 ---------------------------
  //      billing.quota / billing.quota.code：#299 的「额度不足」标记，注释写着「能单独筛出来」，
  //      但键名一直不在白名单里 —— 于是「查不到余额不足」这件事本身查不到。
  const kept = sanitizeMeta({
    'billing.quota': 'exhausted',
    'billing.quota.code': 'insufficient_balance',
    imported: 12,
    skipped: 3,
  })
  assert.deepEqual(kept, {
    'billing.quota': 'exhausted',
    'billing.quota.code': 'insufficient_balance',
    imported: 12,
    skipped: 3,
  })

  // ---- 5. 负向：Key 派生的标识仍必须丢弃（脱敏铁律不因「补白名单」松动） ---------------------------
  const keyDerived = sanitizeMeta({ 'key.fingerprint': 'api.deepseek.com#1a2b3c4d', 'key.tail': '****4321' })
  assert.equal(keyDerived['key.fingerprint'], undefined, 'Key 派生标识不落库（只留尾 4 位的 key.tail）')
  assert.equal(keyDerived['key.tail'], '****4321')
})
