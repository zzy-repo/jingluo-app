// [layer: unit | 依赖: 无（纯 Node：不碰 DOM、不发请求） | 耗时: <2s]
//
// Issue #896 **3c-1**：`timeoutBudget.ts`（3a，「一条请求允许等多久」）与
// `requestPolicy.ts`（3b，「等不到之后怎么办」）**合成一份策略源**。
//
// ## 为什么这不是「两个文件合成一个」的搬家
//
// 合并前，同一个类（`RequestClass`）在两个模块里各有一套答案，而且两套字段**不重叠**：
//   · 策略表说 `stream` 的 connect 预算是 `LIMITS.requestTimeouts.connectMs`（60s）；
//   · 传输预算说 `consume.read` 这档是 `10s`（`config/endpoints.json`）。
// 两者都叫「超时」，都能被调用方拿去用，但**没有任何地方**能回答
// 「`consume.read` 属于哪个类、这个类的 retry/idempotent 是什么」—— 想回答就得在调用点
// 再写一次映射。于是「同一件事在四层有四种答案」（#896 立项理由）又长出一条新的。
//
// 本文件钉的正是那条断掉的链路：
//   S1 **取得到**：任一个传输槽位（consume/pay/migration 共 7 个）都能回报它属于哪个类；
//   S2 **两条链路完全一致**：同一个类，从「策略表链路」与「传输槽位链路」取到的
//      connect / firstByte / idle / total / retry / backoff / idempotent **逐字相等**
//     （改前：传输链路根本没有 retry 这回事，`undefined !== 0` → 红）；
//   S3 **一处覆盖两条链路都看得见**：按类改预算，传输槽位读到的也是新值
//     （改前：`setTimeoutBudgetOverlay` 只能改槽位，改不动策略表 → 红）；
//   S4 **槽位预算只有一条取值链**：覆盖 → 配置 → 类 total → 抛错，没有第四个来源。
//
//   node --test tests/unit/request-policy-single-source-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { consumeTimeouts } from '../../scripts/lib/endpoints.mjs'

installResolveHooks()

const {
  REQUEST_CLASSES,
  REQUEST_POLICY,
  TRANSPORT_SLOTS,
  TRANSPORT_SLOT_NAMES,
  requestPolicyOf,
  transportPolicyOf,
  transportBudgetOf,
  setBudgetOverlay,
  resetBudgetOverlay,
  currentBudgetOverlay,
  backoffOf,
  canAutoRetry,
} = await import('../../src/services/net/requestPolicy.ts')

const { OURS_TIMEOUTS } = await import('../../src/services/ours/api.ts')

/** 一个类上「两条链路都必须给出同一个答案」的七个字段 */
const POLICY_FIELDS = [
  'connect',
  'firstByte',
  'idle',
  'total',
  'retry',
  'backoff',
  'backoffFactor',
  'idempotent',
  'requiresNoContent',
]

const clean = () => resetBudgetOverlay()

test('[S1] 七个传输槽位都能回报自己属于哪个类（改前：这个映射根本不存在）', () => {
  clean()
  assert.deepEqual(
    [...TRANSPORT_SLOT_NAMES].sort(),
    [
      'consume.read',
      'consume.redeem',
      'consume.write',
      'migration',
      'pay.keyProbe',
      'pay.payLink',
      'pay.redeem',
    ],
    '槽位名单就是这七个：consume 三档 + pay 三槽 + migration'
  )
  for (const slot of TRANSPORT_SLOT_NAMES) {
    const row = TRANSPORT_SLOTS[slot]
    assert.ok(
      REQUEST_CLASSES.includes(row.cls),
      `${slot} 的类必须是 control/data/stream 之一，实际 ${String(row.cls)}`
    )
  }
  // 有副作用的档必须是 control：这是「卡密重复兑换 / 建两把 Key」那类事故的防线
  for (const slot of /** @type {const} */ ([
    'consume.redeem',
    'consume.write',
    'pay.redeem',
    'pay.payLink',
    'migration',
  ])) {
    assert.equal(TRANSPORT_SLOTS[slot].cls, 'control', `${slot} 有不可撤销副作用，必须归 control`)
  }
  // 只读的档是 data：重发最多多花一点流量
  for (const slot of /** @type {const} */ (['consume.read', 'pay.keyProbe'])) {
    assert.equal(TRANSPORT_SLOTS[slot].cls, 'data', `${slot} 是只读查询，归 data`)
  }
})

test('[S2] 同一个类：策略表链路与传输槽位链路给出的七件事逐字相等', () => {
  clean()
  const links = new Map()
  for (const cls of REQUEST_CLASSES) {
    links.set(cls, [requestPolicyOf(cls)])
  }
  for (const slot of TRANSPORT_SLOT_NAMES) {
    const { cls, policy } = transportPolicyOf(slot)
    links.get(cls).push(policy)
  }
  // stream 没有 consume/pay/migration 槽位（它走聊天客户端的 SSE，不在这七档里），
  // 所以「两条链路」这条对 control / data 成立；stream 的单链路另由 S7 与 LIMITS 对照。
  assert.equal(links.get('control').length >= 2, true, 'control 必须有多条传输链路可对照')
  assert.equal(links.get('data').length >= 2, true, 'data 必须有多条传输链路可对照')
  for (const [cls, policies] of links) {
    const [head, ...rest] = policies
    for (const other of rest) {
      for (const field of POLICY_FIELDS) {
        assert.equal(
          other[field],
          head[field],
          `${cls}.${field} 在两条链路上不一致：${String(other[field])} !== ${String(head[field])}`
        )
      }
    }
  }
})

test('[S3] 按类装的预算覆盖，传输槽位读到的也是同一个新值', () => {
  clean()
  const before = transportPolicyOf('consume.read').policy.connect
  setBudgetOverlay({ classes: { data: { connect: before + 12_345 } } })
  assert.equal(
    transportPolicyOf('consume.read').policy.connect,
    before + 12_345,
    'data 类的 connect 覆盖必须同时反映在「consume.read」这条传输链路上'
  )
  assert.equal(
    requestPolicyOf('data').connect,
    before + 12_345,
    '策略表链路上也要是同一个值'
  )
  assert.equal(
    transportPolicyOf('pay.keyProbe').policy.connect,
    before + 12_345,
    '同类（data）的另一个槽位同样生效'
  )
  assert.equal(
    transportPolicyOf('consume.redeem').policy.connect,
    REQUEST_POLICY.control.connect,
    '别的类（control）不许被顺带改掉'
  )
  clean()
  assert.equal(transportPolicyOf('consume.read').policy.connect, before, 'reset 之后回到原值')
})

test('[S4] 槽位预算只有一条取值链：覆盖 → 配置 → 类 total（>0）→ 抛错', () => {
  clean()
  // 1. 配置在（consume 三档来自 config/endpoints.json）→ 用配置值
  assert.equal(transportBudgetOf('consume.read', consumeTimeouts.read), consumeTimeouts.read)
  assert.equal(transportBudgetOf('consume.write', consumeTimeouts.write), consumeTimeouts.write)
  assert.equal(transportBudgetOf('consume.redeem', consumeTimeouts.redeem), consumeTimeouts.redeem)
  // 2. 覆盖优先于配置
  setBudgetOverlay({ slots: { 'consume.read': 1_234 } })
  assert.equal(transportBudgetOf('consume.read', consumeTimeouts.read), 1_234, '覆盖优先于配置')
  // 3. 非法覆盖值一律丢弃（0 = 永不超时，是本仓库最贵的一类事故）
  clean()
  setBudgetOverlay({ slots: { 'consume.read': 0 } })
  assert.equal(
    transportBudgetOf('consume.read', consumeTimeouts.read),
    consumeTimeouts.read,
    '0 必须被丢弃，不许把预算调成「永不超时」'
  )
  setBudgetOverlay({ slots: { 'consume.read': Number.NaN } })
  assert.equal(transportBudgetOf('consume.read', consumeTimeouts.read), consumeTimeouts.read)
  clean()
  // 4. 什么都没有 → 抛错（不写「读不到就给 10 秒」那种兜底）
  assert.throws(
    () => transportBudgetOf('migration'),
    /migration/,
    '既没有覆盖、也没有配置、类 total 又是 0 时必须抛错，不许悄悄给一个来源不明的数字'
  )
  assert.equal(transportBudgetOf('migration', 20_000), 20_000, '调用方给了配置就用它')
  assert.equal(transportBudgetOf('pay.keyProbe', OURS_TIMEOUTS.keyProbe), OURS_TIMEOUTS.keyProbe)
})

test('[S5] 退避与次数也只从这一张表出（两个模块各一套的旧形态不再可能）', () => {
  clean()
  for (const cls of REQUEST_CLASSES) {
    const policy = requestPolicyOf(cls)
    assert.equal(
      backoffOf(cls, 0),
      policy.backoff,
      `${cls}：第 0 次重发的等待必须等于本类的 backoff 基数`
    )
    assert.equal(backoffOf(cls, 2), policy.backoff * policy.backoffFactor ** 2)
    // 服务端给了 Retry-After 就听它的
    assert.equal(backoffOf(cls, 0, 5_000), 5_000)
  }
  // control 永不自动重发：次数为 0、idempotent 为 false，两条一起挡
  assert.equal(requestPolicyOf('control').retry, 0)
  assert.equal(requestPolicyOf('control').idempotent, false)
  for (const failure of ['timeout', 'offline', 'server5xx', 'rateLimited']) {
    assert.equal(
      canAutoRetry({ cls: 'control', failure, attempt: 0 }),
      false,
      `control 在 ${failure} 上也不许自动重发`
    )
  }
})

test('[S7] stream 的静默补试档也在这张表里，且与 LIMITS 逐字相等', async () => {
  clean()
  const { LIMITS } = await import('../../src/services/limits.ts')
  const silent = requestPolicyOf('stream').silent
  assert.notEqual(silent, null, 'stream 必须有静默补试档（改前那 5 个常量住在 chat/streamBreakout.ts）')
  assert.equal(silent.attempts, LIMITS.streamBreakout.silentAttempts)
  assert.equal(silent.budgetMs, LIMITS.streamBreakout.silentBudgetMs)
  assert.equal(silent.partialAttempts, LIMITS.streamBreakout.partialAttempts)
  assert.equal(silent.partialMaxChars, LIMITS.streamBreakout.partialMaxChars)
  assert.deepEqual(
    [...silent.delaysMs],
    [1000, 2000, 4000, 8000],
    '退避序列由 retryBaseDelayMs 的 1/2/4/8 倍算出，不是另抄一份字面量'
  )
  // 看得见的重试（2）与静默补试（5）必须是两个数：混用会砍掉弱网恢复率或放大请求量
  assert.notEqual(
    requestPolicyOf('stream').retry,
    silent.attempts,
    '「看得见的重试」与「静默补试」是两档，不许合并成一个数'
  )
  for (const cls of ['control', 'data']) {
    assert.equal(requestPolicyOf(cls).silent, null, `${cls} 没有静默补试档`)
  }
})

test('[S6] 单一策略源只有一份文件：旧的 timeoutBudget 模块已经不存在', async () => {
  const { existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../../src/services/net/timeoutBudget.ts', import.meta.url))
  assert.equal(existsSync(path), false, 'timeoutBudget.ts 必须已经被 requestPolicy.ts 吸收（一份策略源）')
})
