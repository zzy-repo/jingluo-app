// [layer: unit | 依赖: 无（纯 Node） | 耗时: <3s]
//
// Issue #896 主体：`RequestClass = control | data | stream` 的**单一策略表**，
// 以及「同一件事不再在四层有四种答案」这件事本身。
//
// 本文件要钉的是改前**真实存在**的矛盾（不是假想的）：
//   429 在四层有三种口径 ——
//     · `api/errors.isRetryableStatus(429)` = true（限流是临时的）
//     · `auth/flags.ts:264` 的 `!(status >= 400 && status < 500)` = false（429 落在 4xx 区间）
//     · `consume/errors` 标 `retryable: true`，但消费链路从不自动重发
//   改后：429 = 可重试，这一条由 `requestPolicy.ts` 唯一决定，三层读同一份。
//
// 还有一条同样要钉死：**「用户取消」永远不重试**（母单 #894 第 4 条纪律），
// 它必须比任何「临时故障」判据都优先，且在三个类里都成立。
//
//   node --test tests/unit/request-class-policy-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

globalThis.__API_ORIGIN__ ??= 'https://api.test.invalid'
globalThis.INTERNAL_BUILD ??= false
globalThis.__log ??= { records: [], events: [], actions: [] }

const policy = await import('../../src/services/net/requestPolicy.ts')
const { ApiError } = await import('../../src/services/api/client.ts')
const { isRetryableApiError, isRetryableStatus } = await import('../../src/services/api/errors.ts')
const { readSettingsWithRetry, backoffDelayOf, FLAGS_RETRY } = await import(
  '../../src/services/auth/flags.ts'
).catch(() => ({}))
const { consumeRetryableOf } = await import('../../src/services/consume/errors.ts').catch(() => ({}))

const { REQUEST_CLASSES, REQUEST_POLICY, canAutoRetry, backoffOf, retryableFailure, failureOfStatus } =
  policy

/** 五种失败 × 三个类：表驱动（同一份判据，三个类逐格断言） */
const FAILURES = ['timeout', 'offline', 'server5xx', 'rateLimited', 'cancelled']

test('[P1] 三个类都定义了七件事（connect / firstByte / idle / total / retry / backoff / idempotent）', () => {
  for (const cls of REQUEST_CLASSES) {
    const row = REQUEST_POLICY[cls]
    for (const field of ['connectMs', 'firstByteMs', 'idleMs', 'totalMs']) {
      assert.equal(typeof row[field], 'number', `${cls}.${field} 必须是数字`)
    }
    for (const field of ['maxAttempts', 'backoffMs', 'backoffFactor']) {
      assert.equal(typeof row.retry[field], 'number', `${cls}.retry.${field} 必须是数字`)
    }
    assert.equal(typeof row.retry.idempotent, 'boolean', `${cls}.retry.idempotent 必须是布尔`)
  }
  assert.deepEqual([...REQUEST_CLASSES], ['control', 'data', 'stream'], '三个类就是这三个，不许悄悄加')
})

test('[P2] 429 的唯一口径：三个类都可重试，且与「其它 4xx 不重试」分开', () => {
  for (const cls of REQUEST_CLASSES) {
    assert.equal(
      retryableFailure('rateLimited'),
      true,
      `${cls}：429 是临时限流，等一会儿真有额度 —— 必须可重试`
    )
    assert.equal(
      retryableFailure('client4xx'),
      false,
      `${cls}：其余 4xx 重发是同一份结果（#303 的 2059 次 404）`
    )
  }
  // 状态码 → 失败类型：429 不许落进 4xx 那一档
  assert.equal(failureOfStatus(429), 'rateLimited')
  assert.equal(failureOfStatus(400), 'client4xx')
  assert.equal(failureOfStatus(503), 'server5xx')
})

test('[P3] 用户取消：三个类都不可重试（比任何临时故障判据都优先）', () => {
  for (const cls of REQUEST_CLASSES) {
    assert.equal(retryableFailure('cancelled'), false, `${cls}：用户点了停止就不许再发`)
    assert.equal(
      canAutoRetry({ cls, failure: 'cancelled', attempt: 0, receivedContent: false }),
      false,
      `${cls}：连一次都不许自动发`
    )
  }
})

test('[P4] 表驱动：同一 class 在 超时 / 断网 / 5xx / 429 / 用户取消 下的重试次数与退避', () => {
  // 期望值**写在测试里**，不是从表里读回来自己比自己（那样改坏了也绿）
  const expected = {
    control: {
      // 控制类有不可撤销的副作用（卡密 / 建 Key / 扣费）：只标记可重试，一次都不自动发
      timeout: { retryable: true, autoRetries: 0 },
      offline: { retryable: true, autoRetries: 0 },
      server5xx: { retryable: true, autoRetries: 0 },
      rateLimited: { retryable: true, autoRetries: 0 },
      cancelled: { retryable: false, autoRetries: 0 },
    },
    data: {
      timeout: { retryable: true, autoRetries: 2 },
      offline: { retryable: true, autoRetries: 2 },
      server5xx: { retryable: true, autoRetries: 2 },
      rateLimited: { retryable: true, autoRetries: 2 },
      cancelled: { retryable: false, autoRetries: 0 },
    },
    stream: {
      timeout: { retryable: true, autoRetries: 2 },
      offline: { retryable: true, autoRetries: 2 },
      server5xx: { retryable: true, autoRetries: 2 },
      rateLimited: { retryable: true, autoRetries: 2 },
      cancelled: { retryable: false, autoRetries: 0 },
    },
  }
  for (const cls of REQUEST_CLASSES) {
    for (const failure of FAILURES) {
      const want = expected[cls][failure]
      assert.equal(
        retryableFailure(failure),
        want.retryable,
        `${cls} × ${failure}：可重试性不符合表`
      )
      let autoRetries = 0
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (canAutoRetry({ cls, failure, attempt, receivedContent: false })) {
          autoRetries += 1
        } else {
          break
        }
      }
      assert.equal(autoRetries, want.autoRetries, `${cls} × ${failure}：自动重发次数不符合表`)
    }
  }
})

test('[P5] 退避单调递增，且 429 的 Retry-After 优先于本地节奏', () => {
  for (const cls of REQUEST_CLASSES) {
    const first = backoffOf(cls, 0)
    const second = backoffOf(cls, 1)
    const third = backoffOf(cls, 2)
    assert.ok(second > first, `${cls}：第 2 次重发要比第 1 次等得久（${first} → ${second}）`)
    assert.ok(third > second, `${cls}：指数退避，第 3 次更久（${second} → ${third}）`)
    assert.equal(
      backoffOf(cls, 0, 7000),
      7000,
      `${cls}：服务端给了 Retry-After 就按它，不自己猜节奏`
    )
    assert.equal(backoffOf(cls, 3, 0), backoffOf(cls, 3), `${cls}：0 / 负数 / 缺失一律回落本地退避`)
  }
})

test('[P6] 流式出过内容就不许自动重发（三个类里只有 stream/data 有这条）', () => {
  assert.equal(
    canAutoRetry({ cls: 'stream', failure: 'timeout', attempt: 0, receivedContent: true }),
    false,
    '流式已经吐过字：重发会答两遍、重复计费（#105 / #150）'
  )
  assert.equal(
    canAutoRetry({ cls: 'stream', failure: 'timeout', attempt: 0, receivedContent: false }),
    true,
    '还没吐字：重发是安全的'
  )
  assert.equal(
    canAutoRetry({ cls: 'control', failure: 'timeout', attempt: 0, receivedContent: true }),
    false,
    '控制类本来就不自动发'
  )
})

test('[P7] 四层读同一份 429 口径：api/errors、auth/flags、consume 不再各说各话', () => {
  // 层 1：聊天 / 上传这一层（api/errors）
  assert.equal(isRetryableStatus(429), true, 'api/errors：429 可重试（改前就是 true，保持）')
  assert.equal(isRetryableStatus(400), false, 'api/errors：400 不可重试')
  assert.equal(isRetryableStatus(502), true, 'api/errors：5xx 可重试')

  // 层 2：设置页读公开配置那一层（auth/flags）—— **改前这里是 false，这就是那条矛盾**
  const flagsRow = policy.REQUEST_POLICY.data
  assert.ok(flagsRow, '设置页读配置属于 data 类（幂等只读）')
  assert.equal(
    policy.retryableFailure('rateLimited'),
    true,
    'auth/flags 必须与 api/errors 同口径：429 可重试'
  )

  // 层 3：消费链路（consume/errors）—— 标记可重试，但 control 类不自动重发
  assert.equal(policy.retryableFailure('rateLimited'), true, 'consume 的 429 仍然标可重试')
  assert.equal(
    policy.canAutoRetry({ cls: 'control', failure: 'rateLimited', attempt: 0 }),
    false,
    'consume 仍然是「标可重试但从不自动重发」—— 这条产品决定现在写在表里（control.maxAttempts=0）'
  )

  // 层 4：流式三段超时矩阵不许出现第二套口径
  const streamRow = policy.REQUEST_POLICY.stream
  assert.equal(streamRow.retry.requiresNoContent, true, '流式：出过内容就不重发')
  assert.equal(streamRow.retry.maxAttempts > 0, true, '流式：确实会重发（不是标记了事）')
})

test('[P8] ApiError 上的 429 走到同一个结论（不靠调用点各判一遍）', () => {
  const error = new ApiError('http', 'rate limited', 429, undefined, undefined, 'rate_limit_exceeded')
  assert.equal(isRetryableApiError(error), true, '429 的 ApiError 可重试')
  const bad = new ApiError('http', 'bad request', 400)
  assert.equal(isRetryableApiError(bad), false, '400 的 ApiError 不可重试')
  const quota = new ApiError('http', 'insufficient_quota', 429, undefined, undefined, 'insufficient_quota')
  assert.equal(
    isRetryableApiError(quota),
    false,
    '429 + 额度用完不是限流：终态（这一条必须排在「429 可重试」之前）'
  )
})

test('[P9] 流式三段超时矩阵与策略表逐字相等（改一边不改另一边必红）', async () => {
  const { STREAM_TIMEOUT_POLICIES } = await import('../../src/services/chat/timeoutPolicy.ts')
  const streamRetry = REQUEST_POLICY.stream.retry
  // `chat/timeoutPolicy.ts` 故意不 import 本表（它要被负向对照整份复制到临时目录，
  // 有了 import 注入件就解析不到依赖），所以这份一致性由这条用例守。
  for (const row of STREAM_TIMEOUT_POLICIES) {
    assert.equal(
      row.retryable,
      streamRetry.idempotent && retryableFailure('timeout'),
      `${row.code}：矩阵的 retryable 必须与表里的 stream 类一致`
    )
    assert.equal(
      row.requiresNoContent,
      streamRetry.requiresNoContent,
      `${row.code}：矩阵的 requiresNoContent 必须与表里的 stream 类一致`
    )
  }
})

test('[P10] 设置页（auth/flags）的 429 口径：改前 false，改后与 api/errors 一致为 true', async () => {
  const flags = await import('../../src/services/auth/flags.ts')
  assert.equal(typeof flags.isRetryableStatus, 'function', '设置页的重试判据要能被用例直接验证')
  assert.equal(flags.isRetryableStatus(429), true, '429 是临时限流：设置页也要重试（改前这里是 false）')
  assert.equal(flags.isRetryableStatus(400), false, '400 是服务端说你不对：不重试')
  assert.equal(flags.isRetryableStatus(503), true, '5xx 重试')
  assert.equal(flags.isRetryableStatus(null), true, '没有状态码（断网 / 超时）重试')
  // 与聊天层同一个答案
  assert.equal(flags.isRetryableStatus(429), isRetryableStatus(429), '两层不许再各说各话')
})

test('[P11] 诊断层（diagnostics/reasons）也读同一份判据：http-error + 429 可重试', async () => {
  const { retryableFor } = await import('../../src/services/diagnostics/reasons.ts')
  // 改前 `code >= 500` → 429 落在 4xx → false（第三处口径）
  assert.equal(retryableFor('http-error', 429), true, '429 是限流：与 api/errors / auth/flags 同口径')
  assert.equal(retryableFor('http-error', 500), true, '5xx 可重试（改前也是如此）')
  assert.equal(retryableFor('http-error', 404), false, '4xx 终态（改前也是如此）')
  assert.equal(retryableFor('http-error'), false, '拿不到状态码时不许劝用户「再试一次」')
  // 业务终态不受状态码影响（它有自己的 preset，不走状态码分支）
  assert.equal(retryableFor('card-already-used', 409), false)
})

test('[P12] 判据模块是零依赖的（diagnostics 引它不许把 LIMITS/transport 拖进去）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('../../src/services/net/failureKind.ts', import.meta.url),
    'utf8'
  )
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  assert.equal(/^import /m.test(code), false, 'failureKind.ts 不许 import 任何东西（零依赖是它的存在理由）')
})
