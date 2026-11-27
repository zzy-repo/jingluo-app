// [layer: unit | 依赖: 纯函数（无 DOM / 无 SQLite / 无网络） | 耗时: <1s]
//
// #940：迁移失败分类器 `failure-class.ts` —— 本单的核心不是「给某一条报错加一句中文」，
// 而是**未来任何未知异常到来时，系统仍然满足四条性质**。这里逐条钉住：
//
//   性质 1 停止不安全操作、保护已有数据 —— 无法识别时 `safeAction` 必须是保守的 `keep-source`；
//   性质 2 按实际状态决定入口 —— 真源 / 是否部分写入 / 能不能确认，决定给不给「重试」；
//   性质 3 不暴露原始技术异常、不虚报数据完整 —— 界面文案无技术细节，且不确定时不承诺；
//   性质 4 保留完整诊断信息 —— 原始 code / message / 类名 / 阶段 / store / 状态快照一个不少。
//
// 负向用例是本单主体（未知码 / 随机异常 / 无法确认数据状态 / 文案不泄漏），不是附赠。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTsModule } from '../helpers/dom-env.mjs'

const fc = await loadTsModule('src/services/storage/migration/failure-class.ts')
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')
const tables = { zh, en }

const classify = fc.classifyFailure
const planOf = fc.copyPlanOf

/** 用户可见文案的解析（与 `i18n/index.ts` 的占位符规则一致，但只给「不需要参数」的 key 用）。 */
const resolve = (table, key, params = {}) => {
  const raw = table[key]
  assert.equal(typeof raw, 'string', `key ${key} 在两份表里都必须是字符串`)
  return raw.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
}

/** 一屏失败页能出现的**全部**文字（标题 / 发生了什么 / 数据怎么样 / 下一步 / 主按钮）。 */
const screenText = (table, classification) => {
  const plan = planOf(classification)
  return [plan.titleKey, plan.bodyKey, plan.dataKey, plan.nextKey, plan.primaryLabelKey]
    .map((key) => resolve(table, key))
    .join('\n')
}

// ---------------------------------------------------------------- 数据状态样本

/** 评审要的五个状态：未迁移 / 迁移中 / 部分写入 / 已提交 / 状态未知。 */
const STATES = {
  未迁移: { truthSource: 'idb', phase: 'preflight', targetWritten: false },
  迁移中: { truthSource: 'idb', phase: 'copying', targetWritten: true },
  部分写入: { truthSource: 'idb', phase: 'failed', targetWritten: true },
  已提交: { truthSource: 'sqlite', phase: 'committed' },
  状态未知: { truthSource: 'unknown' },
}

/** 每个档位的代表性输入（真实链路里出现的形状）。 */
const TIER_INPUTS = {
  space: { code: 'SQLITE_FULL', error: { name: 'QuotaExceededError', message: 'SQLITE_FULL: disk is full' } },
  'too-large': { code: 'RESULT_TOO_LARGE', error: { message: 'result exceeds 4194304 bytes; refusing to truncate' } },
  corrupt: { code: 'SQLITE_CORRUPT', error: { name: 'StorageUnavailableError', message: 'SQLITE_CORRUPT: bad page' } },
  io: { code: 'SQLITE_BUSY', error: { name: 'SqliteBusyError', message: 'database is locked' } },
  unsupported: { code: 'unsupported', error: { message: 'source-too-large: 3221225472 bytes exceeds 2147483648' } },
  interrupted: { code: 'interrupted', error: { message: 'aborted' } },
  unknown: { code: 'SQLITE_WEIRD_9F3', error: { message: 'something we have never seen' } },
}

// ---------------------------------------------------------------- 性质 1：默认动作保守

test('未知错误码：落到 unknown 档，safeAction 是保守的 keep-source（不是 retry）', () => {
  const result = classify({ code: 'SQLITE_WEIRD_9F3', error: { message: 'nope' } })
  assert.equal(result.tier, 'unknown')
  assert.equal(result.safeAction, 'keep-source')
  assert.equal(result.allowRetry, false)
  assert.equal(result.canPromiseSourceIntact, false)
})

test('空输入 / 无 error / 只有 undefined 字段：一律 unknown + keep-source，不抛', () => {
  for (const input of [{}, { error: undefined }, { code: undefined }, { error: null }, { error: 42 }, { error: true }]) {
    const result = classify(input)
    assert.equal(result.tier, 'unknown', JSON.stringify(input))
    assert.equal(result.safeAction, 'keep-source', JSON.stringify(input))
    assert.equal(result.primaryAction, 'recheck', JSON.stringify(input))
  }
})

test('随机异常一个都不能抛：TypeError / RangeError / 字符串 / undefined / 空对象 / 循环 cause', () => {
  const cyclic = new Error('cyclic')
  cyclic.cause = cyclic
  const throwingGetter = {
    get code() {
      throw new Error('getter exploded')
    },
    get message() {
      throw new Error('getter exploded')
    },
  }
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy trap exploded')
      },
      getPrototypeOf() {
        throw new Error('proxy trap exploded')
      },
    },
  )
  const inputs = [
    new TypeError('undefined is not a function'),
    new RangeError('out of range'),
    new Error('plain'),
    cyclic,
    'boom',
    '',
    undefined,
    null,
    0,
    Symbol('boom'),
    {},
    { code: undefined },
    throwingGetter,
    hostile,
    Object.create(null),
  ]
  for (const error of inputs) {
    const result = classify({ error })
    assert.ok(fc.FAILURE_TIERS.includes(result.tier), `档位必须是已知档：${result.tier}`)
    assert.ok(['retry', 'recheck', 'keep-source'].includes(result.safeAction))
    assert.equal(typeof result.diagnostics.message, 'string')
    // 结论必须存在且保守：识别不出来时绝不能「当作成功」，也不能承诺数据完好
    if (result.tier === 'unknown') {
      assert.equal(result.safeAction, 'keep-source')
      assert.equal(result.canPromiseSourceIntact, false)
    }
  }
})

// ---------------------------------------------------------------- 性质 2：按状态决定入口

test('真源仍是旧库且没往新存储写过 → 数据完好，可以给「重试」', () => {
  const result = classify({ ...TIER_INPUTS.space, state: STATES.未迁移 })
  assert.equal(result.dataTruth, 'source-intact')
  assert.equal(result.canPromiseSourceIntact, true)
  assert.equal(result.primaryAction, 'retry')
  assert.equal(result.allowRetry, true)
})

test('已部分写入（未提交）→ 必须说「新存储里有未完成的写入」，不是「一切正常」', () => {
  const result = classify({ ...TIER_INPUTS.io, state: STATES.部分写入 })
  assert.equal(result.dataTruth, 'partial-write')
  assert.equal(result.canPromiseSourceIntact, false)
  // 依然可以重试（写入是幂等 upsert），但文案必须交代部分写入
  assert.equal(result.primaryAction, 'retry')
  const plan = planOf(result)
  assert.equal(plan.dataKey, 'storageMigrationDataPartial')
  assert.match(resolve(zh, plan.dataKey), /未完成的写入/u)
  assert.match(resolve(en, plan.dataKey), /unfinished/iu)
})

test('数据状态无法确认 → 不给「重试」，降级成「重新检测」，且不承诺数据完好', () => {
  for (const tier of Object.keys(TIER_INPUTS)) {
    const result = classify({ ...TIER_INPUTS[tier], state: STATES.状态未知 })
    assert.equal(result.dataTruth, 'unknown', tier)
    assert.equal(result.allowRetry, false, `${tier} 在状态未知时不能给重试`)
    assert.notEqual(result.primaryAction, 'retry', tier)
    assert.equal(result.primaryAction, 'recheck', tier)
    assert.equal(result.canPromiseSourceIntact, false, tier)
  }
})

test('真源已切到新存储（已提交）→ 不重试、不谈「原数据可用」', () => {
  const result = classify({ ...TIER_INPUTS.io, state: STATES.已提交 })
  assert.equal(result.dataTruth, 'committed')
  assert.equal(result.allowRetry, false)
  // 已提交后「继续使用原来的存储」是假话：入口给「重新检测」（重走路由 → 真源是 sqlite 就进 App）
  assert.equal(result.primaryAction, 'recheck')
  assert.equal(result.allowContinue, false)
  assert.equal(result.canPromiseSourceIntact, false)
})

test('旧库升过版（legacyBarrier 存在）→ 不能确认，禁止承诺数据完好', () => {
  const state = fc.dataStateOf({ truthSource: 'idb', phase: 'verified', legacyBarrier: 'bump-version' })
  assert.equal(state.legacyBumped, true)
  const result = classify({ ...TIER_INPUTS.io, state })
  assert.equal(result.dataTruth, 'unknown')
  assert.equal(result.canPromiseSourceIntact, false)
})

test('dataStateOf：阶段与检查点决定「目标库写过没有」，读不出来就是未知', () => {
  assert.equal(fc.dataStateOf({ truthSource: 'idb', phase: 'preflight' }).targetWritten, false)
  assert.equal(fc.dataStateOf({ truthSource: 'idb', phase: 'copying' }).targetWritten, true)
  assert.equal(fc.dataStateOf({ truthSource: 'idb', phase: 'failed' }).targetWritten, undefined)
  assert.deepEqual(
    fc.dataStateOf({ truthSource: 'idb', phase: 'failed', checkpoints: [{ store: 'sessions', done: true, lastKey: 's1' }] })
      .targetWritten,
    true,
  )
  assert.equal(fc.dataStateOf({}).truthSource, 'unknown')
  assert.equal(fc.dataStateOf({ truthSource: 'MySQL' }).truthSource, 'unknown')
})

// ---------------------------------------------------------------- 性质 3 正向：不泄漏技术细节

const LEAK_PATTERNS = [
  /\d+\s*bytes/iu,
  /4194304/u,
  /MiB/iu,
  /\bSQLite\b/iu,
  /IndexedDB/iu,
  /SqliteFailure/u,
  /UnexpectedFailure/u,
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\s/u,
  /store=/u,
  /\bat\s+\w+\s*\(/u, // 堆栈行
  /\b\w+Error\b/u, // 类名
]

test('每个档位 × 每种数据状态：界面文案不含原始 message / code / 类名 / 堆栈 / SQL / 后端名 / 字节上限', () => {
  let combos = 0
  for (const [tierName, input] of Object.entries(TIER_INPUTS)) {
    for (const [stateName, state] of Object.entries(STATES)) {
      const result = classify({ ...input, state })
      assert.equal(result.tier, tierName, `${tierName}/${stateName}`)
      for (const [lang, table] of Object.entries(tables)) {
        const text = screenText(table, result)
        for (const pattern of LEAK_PATTERNS) {
          assert.doesNotMatch(text, pattern, `${tierName}/${stateName}/${lang} 泄漏了 ${pattern}：\n${text}`)
        }
      }
      combos += 1
    }
  }
  assert.equal(combos, 35, '7 档 × 5 状态 = 35 组都要跑到')
})

test('本次内测实测的那条原始异常：分类正确，且屏幕上不出现它的任何字样', () => {
  const raw = 'result exceeds 4194304 bytes; refusing to truncate'
  const result = classify({ error: new Error(raw), state: STATES.迁移中 })
  assert.equal(result.tier, 'too-large')
  const text = screenText(zh, result)
  assert.doesNotMatch(text, /4194304|bytes|exceeds|truncat/iu)
  // 原始 message 只进诊断，一个字都不许丢
  assert.equal(result.diagnostics.message, raw)
})

// ---------------------------------------------------------------- 性质 3 反向：不确定就不承诺

const PROMISE_PATTERNS = [/未丢失/u, /完好/u, /安全/u, /完整/u, /正常使用/u, /not lost/iu, /nothing was lost/iu, /intact/iu, /is safe/iu, /are safe/iu, /unchanged/iu]

test('无法确认安全时，文案不出现「未丢失 / 完好 / 安全 / 完整 / 正常使用」这类承诺', () => {
  let checked = 0
  const unconfirmed = [STATES.状态未知, { truthSource: 'idb', phase: 'verified', legacyBumped: true }]
  for (const [tierName, input] of Object.entries(TIER_INPUTS)) {
    for (const state of unconfirmed) {
      const result = classify({ ...input, state })
      assert.equal(result.canPromiseSourceIntact, false, `${tierName} 不该承诺`)
      for (const [lang, table] of Object.entries(tables)) {
        const text = screenText(table, result)
        for (const pattern of PROMISE_PATTERNS) {
          assert.doesNotMatch(text, pattern, `${tierName}/${lang} 在无法确认时仍做了承诺：\n${text}`)
        }
      }
      checked += 1
    }
  }
  assert.equal(checked, 14, '7 档 × 2 种「无法确认」状态 = 14 组')
})

test('能承诺的时候才承诺（source-intact 才给「原数据仍然可用」那句）', () => {
  const ok = classify({ ...TIER_INPUTS.space, state: STATES.未迁移 })
  assert.equal(ok.canPromiseSourceIntact, true)
  assert.equal(planOf(ok).dataKey, 'storageMigrationDataIntact')
  assert.match(resolve(zh, 'storageMigrationDataIntact'), /可以正常使用/u)
  assert.match(resolve(en, 'storageMigrationDataIntact'), /remain usable/iu)
})

// ---------------------------------------------------------------- 入口约定

test('入口按档位给，且一次失败只有一个主入口', () => {
  const retryable = ['space', 'too-large', 'io', 'interrupted']
  for (const tier of retryable) {
    const result = classify({ ...TIER_INPUTS[tier], state: STATES.未迁移 })
    assert.equal(result.primaryAction, 'retry', tier)
    assert.equal(result.safeAction, 'retry', tier)
    assert.equal(planOf(result).showRetry, true, tier)
  }
  for (const tier of ['corrupt', 'unsupported']) {
    const result = classify({ ...TIER_INPUTS[tier], state: STATES.未迁移 })
    assert.equal(result.primaryAction, 'continue', tier)
    assert.equal(result.safeAction, 'keep-source', tier)
    const plan = planOf(result)
    assert.equal(plan.showRetry, false, `${tier} 不许给「重试」`)
    assert.equal(plan.showContinue, true, tier)
    assert.equal(plan.primaryLabelKey, 'storageMigrationKeepOriginal', tier)
  }
  const unknown = classify({ ...TIER_INPUTS.unknown, state: STATES.未迁移 })
  assert.equal(unknown.primaryAction, 'recheck')
  assert.equal(planOf(unknown).showRecheck, true)
  assert.equal(planOf(unknown).showDiagnostics, true)
})

test('按钮文案里不再带「原数据未丢失」这类承诺（承诺改由数据状态那一句说）', () => {
  for (const [key, value] of Object.entries(zh)) {
    if (key.startsWith('storageMigrationKeepOriginal') || key.startsWith('storageMigrationRetry') || key.startsWith('storageMigrationRecheck')) {
      assert.doesNotMatch(String(value), /未丢失|完好|安全|完整/u, key)
    }
  }
})

// ---------------------------------------------------------------- 分类口径（真实链路的三种反直觉之处）

test('code 优先：RESULT_TOO_LARGE / RESULT_INCOMPLETE / SQLITE_FULL / SQLITE_CORRUPT / SQLITE_BUSY / interrupted 各就各位', () => {
  const cases = {
    RESULT_TOO_LARGE: 'too-large',
    SQLITE_TOOBIG: 'too-large',
    // #949 新增的稳定码：分页/分块没取全 → 这次没搬全，可重试（不是 unknown）
    RESULT_INCOMPLETE: 'io',
    SQLITE_FULL: 'space',
    ENOSPC: 'space',
    'insufficient-space': 'space',
    SQLITE_CORRUPT: 'corrupt',
    SQLITE_NOTADB: 'corrupt',
    SQLITE_BUSY: 'io',
    SQLITE_LOCKED: 'io',
    SQLITE_IOERR: 'io',
    copyFailed: 'io',
    'copy-failed': 'io',
    interrupted: 'interrupted',
    ABORT_ERR: 'interrupted',
    unsupported: 'unsupported',
  }
  for (const [code, tier] of Object.entries(cases)) {
    assert.equal(classify({ code }).tier, tier, code)
  }
})

test('native 侧的 busy/locked 走不到 SqliteBusyError（name 被抹平成 unavailable），靠 code 与 message 分档', () => {
  // 事实 1：`retryable` 在 TS 侧已经丢了 —— 分类器必须自己判可重试
  const busy = classify({ code: 'SQLITE_BUSY', error: { name: 'StorageUnavailableError', message: 'SQLITE_BUSY: database is locked' } })
  assert.equal(busy.tier, 'io')
  assert.equal(busy.safeAction, 'retry')
  // 事实 2：光看类名分不出「坏了」和「被占着」——同一个类名，message 不同，档位必须不同
  const corrupt = classify({ error: { name: 'StorageUnavailableError', message: 'database disk image is malformed' } })
  assert.equal(corrupt.tier, 'corrupt')
  assert.equal(corrupt.safeAction, 'keep-source')
  // 码被抹平后仍留在 message 前缀里的原生码，也能把档位捞回来
  const byPrefix = classify({ error: { name: 'StorageUnavailableError', message: 'SQLITE_NOTADB: file is not a database' } })
  assert.equal(byPrefix.tier, 'corrupt')
})

test('judgePreflight 用同一个 unsupported 码装三种病：靠仓库内稳定前缀区分', () => {
  assert.equal(classify({ code: 'unsupported', error: { message: 'source-too-large: 3221225472 bytes exceeds 2147483648; export your data first' } }).tier, 'unsupported')
  const unknownSpace = classify({ code: 'unsupported', error: { message: 'free disk space is unknown; refusing to migrate' } })
  assert.equal(unknownSpace.tier, 'unknown')
  assert.equal(unknownSpace.primaryAction, 'recheck')
})

// ---------------------------------------------------------------- 性质 4：诊断信息一个不少

test('诊断负载保留原始 code / message / 类名 / 阶段 / store / 状态快照', () => {
  const raw = 'result exceeds 4194304 bytes; refusing to truncate'
  const result = classify({
    code: 'RESULT_TOO_LARGE',
    error: { name: 'SqliteFailure', message: raw },
    stage: 'copying',
    store: 'attachments',
    state: STATES.部分写入,
  })
  assert.deepEqual(result.diagnostics, {
    code: 'RESULT_TOO_LARGE',
    name: 'SqliteFailure',
    message: raw,
    stage: 'copying',
    store: 'attachments',
    tier: 'too-large',
    dataTruth: 'partial-write',
    truthSource: 'idb',
    phase: 'failed',
    targetWritten: 'true',
    legacyBumped: 'unknown',
  })
  const text = fc.diagnosticTextOf(result)
  assert.match(text, /4194304/u, '「复制诊断」的负载里必须有原始原文')
  assert.match(text, /store=attachments/u)
  assert.match(text, /stage=copying/u)
})
