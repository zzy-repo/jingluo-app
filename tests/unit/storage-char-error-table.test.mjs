// [layer: unit | 纯 Node，无 IndexedDB | 耗时: <1s]
//
// #906 特征化测试（零行为变化的证据）——「存储错误分类」真值表。
//
// 被钉物：`src/services/chat/db.ts` 的 classifyStorageFailure / storageFailureOf / normalizeStorageFailure /
// isStorageFailureKind / saveBannerTierOf / selectSaveBannerTier / SAVE_BANNER_MESSAGE / saveBannerRetryable。
//
// 这张表是**将来 SQLite 实现要映射进来的目标口径**：
//   · 每一行 = 「一种底层错误」→「kind」→「横幅档位」。新增 SQLite 错误码时，在 `SQLITE_ROWS`
//     里追加行即可（现为空，故意留口），不用改任何断言；
//   · 行的顺序无语义；每行一个独立用例，红了直接点名是哪种底层错误。
//
// 与 `storage-failure.test.mjs`（#P0 事故的逻辑层证据）的分工：那份挑代表性错误名各验一条；
// 本文件把**每个出现在 switch 里的名字 + 边界输入**列成穷举表，并加上 storageFailureOf 的截断 / 省略字段、
// normalizeStorageFailure 的非法输入、selectSaveBannerTier 的容错与顺序无关。
//
// 为什么 import 真代码：判定口径的价值全在「生产里跑的就是这几行」（#547 的教训）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()
const db = await loadTsModule('src/services/chat/db.ts')

const named = (name, message = 'boom') => {
  const error = new Error(message)
  error.name = name
  return error
}

/** 档位 → 横幅 i18n key / 是否给重试按钮（SQLite 实现也必须落在这三档上） */
const TIER_EXPECT = {
  retry: { message: 'sessionSaveFailedRetryable', retryable: true },
  quota: { message: 'sessionSaveFailedQuota', retryable: true },
  unavailable: { message: 'sessionSaveFailedUnavailable', retryable: false },
}

/**
 * 错误真值表。字段：[行名, 构造函数, kind, 档位]
 * 判定只认 `error.name`（对象且 name 为非空字符串）；message / 构造函数 / code 一概不看。
 */
const IDB_ROWS = [
  // ---- clone：会话里混进不可结构化克隆的值
  ['DataCloneError（Error 实例）', () => named('DataCloneError'), 'clone', 'retry'],
  ['DataCloneError（真 DOMException，code=25）', () => new DOMException('x', 'DataCloneError'), 'clone', 'retry'],
  // ---- quota
  ['QuotaExceededError（Error 实例）', () => named('QuotaExceededError'), 'quota', 'quota'],
  ['QuotaExceededError（真 DOMException）', () => new DOMException('x', 'QuotaExceededError'), 'quota', 'quota'],
  ['NS_ERROR_DOM_QUOTA_REACHED（Firefox）', () => named('NS_ERROR_DOM_QUOTA_REACHED'), 'quota', 'quota'],
  ['鸭子类型：{ name: "QuotaExceededError" } 纯对象', () => ({ name: 'QuotaExceededError' }), 'quota', 'quota'],
  // ---- unavailable：这个环境写不进去，重试没用
  ['UnknownError（WebKit 写 blob）', () => named('UnknownError'), 'unavailable', 'unavailable'],
  ['NotSupportedError', () => named('NotSupportedError'), 'unavailable', 'unavailable'],
  ['SecurityError', () => named('SecurityError'), 'unavailable', 'unavailable'],
  ['StorageUnavailableError（名字）', () => named('StorageUnavailableError'), 'unavailable', 'unavailable'],
  ['StorageUnavailableError（真类）', () => new db.StorageUnavailableError(), 'unavailable', 'unavailable'],
  ['StorageVersionTooNewError（名字）', () => named('StorageVersionTooNewError'), 'unavailable', 'unavailable'],
  ['StorageVersionTooNewError（真类）', () => new db.StorageVersionTooNewError(), 'unavailable', 'unavailable'],
  // ---- unknown：可重试（含「看似该判环境问题、实际判可重试」的几个）
  ['InvalidStateError（连接在关，重连后可再试）', () => named('InvalidStateError'), 'unknown', 'retry'],
  ['StorageBlockedError（名字：另一标签页占着）', () => named('StorageBlockedError'), 'unknown', 'retry'],
  ['StorageBlockedError（真类）', () => new db.StorageBlockedError(), 'unknown', 'retry'],
  ['AbortError（事务被中止 / 升级失败）', () => new DOMException('x', 'AbortError'), 'unknown', 'retry'],
  ['ConstraintError', () => new DOMException('x', 'ConstraintError'), 'unknown', 'retry'],
  ['TransactionInactiveError', () => new DOMException('x', 'TransactionInactiveError'), 'unknown', 'retry'],
  ['NotFoundError（store 名写错）', () => new DOMException('x', 'NotFoundError'), 'unknown', 'retry'],
  ['ReadOnlyError', () => new DOMException('x', 'ReadOnlyError'), 'unknown', 'retry'],
  ['DataError', () => new DOMException('x', 'DataError'), 'unknown', 'retry'],
  ['VersionError（原始名；只有被 openWithBlockedGuard 包成 TooNew 后才是 unavailable）', () => new DOMException('x', 'VersionError'), 'unknown', 'retry'],
  ['普通 Error', () => new Error('x'), 'unknown', 'retry'],
  ['TypeError', () => new TypeError('x'), 'unknown', 'retry'],
  // ---- 边界输入：只认 name，别的一律 unknown
  ['名字大小写不同：quotaexceedederror', () => named('quotaexceedederror'), 'unknown', 'retry'],
  ['message 里写着 QuotaExceededError 但 name=Error（不看 message）', () => new Error('QuotaExceededError'), 'unknown', 'retry'],
  ['字符串抛值 "QuotaExceededError"（字符串没有 name）', () => 'QuotaExceededError', 'unknown', 'retry'],
  ['undefined', () => undefined, 'unknown', 'retry'],
  ['null', () => null, 'unknown', 'retry'],
  ['数字 42', () => 42, 'unknown', 'retry'],
  ['空对象 {}', () => ({}), 'unknown', 'retry'],
  ['name 为空串', () => ({ name: '' }), 'unknown', 'retry'],
  ['name 不是字符串', () => ({ name: 42 }), 'unknown', 'retry'],
]

/**
 * 【SQLite 实现在这里追加行】格式同上：[行名, 构造函数, kind, 档位]。
 * 例（示意，未启用）：['SQLITE_FULL', () => sqliteError('SQLITE_FULL'), 'quota', 'quota']
 * 追加后上面的「每行一个用例」与「kind×档位一致」两条会自动覆盖新行。
 */
const SQLITE_ROWS = []

const ALL_ROWS = [...IDB_ROWS, ...SQLITE_ROWS]

for (const [label, make, kind, tier] of ALL_ROWS) {
  test(`错误表：${label} → kind=${kind} → 档位=${tier}`, () => {
    const error = make()
    assert.equal(db.classifyStorageFailure(error), kind)
    assert.equal(db.storageFailureOf(error).kind, kind, 'storageFailureOf 必须与 classify 同口径')
    const resolvedTier = db.saveBannerTierOf(kind)
    assert.equal(resolvedTier, tier)
    assert.equal(db.SAVE_BANNER_MESSAGE[resolvedTier], TIER_EXPECT[tier].message)
    assert.equal(db.saveBannerRetryable(resolvedTier), TIER_EXPECT[tier].retryable)
    // 端到端：一条会话级失败 → 横幅档位
    assert.equal(db.selectSaveBannerTier({ s1: db.storageFailureOf(error) }), tier)
  })
}

test('常量：四类 kind 的清单与顺序；每个 kind 都能落到三档之一', () => {
  assert.deepEqual([...db.STORAGE_FAILURE_KINDS], ['quota', 'clone', 'unavailable', 'unknown'])
  const tiers = new Set(db.STORAGE_FAILURE_KINDS.map((kind) => db.saveBannerTierOf(kind)))
  assert.deepEqual([...tiers].sort(), ['quota', 'retry', 'unavailable'])
  assert.deepEqual(db.SAVE_BANNER_MESSAGE, {
    retry: 'sessionSaveFailedRetryable',
    quota: 'sessionSaveFailedQuota',
    unavailable: 'sessionSaveFailedUnavailable',
  })
})

test('表自检：每个 kind 至少被一行覆盖（防止表漏掉某一类）', () => {
  const covered = new Set(ALL_ROWS.map(([, , kind]) => kind))
  for (const kind of db.STORAGE_FAILURE_KINDS) {
    assert.ok(covered.has(kind), `错误表没有覆盖 kind=${kind}`)
  }
})

// ---------------------------------------------------------------- isStorageFailureKind

test('isStorageFailureKind：只认四个字面量，大小写 / 档位名 / 非字符串都是 false', () => {
  for (const ok of ['quota', 'clone', 'unavailable', 'unknown']) {
    assert.equal(db.isStorageFailureKind(ok), true, ok)
  }
  for (const bad of ['retry', 'QUOTA', ' quota', '', null, undefined, 1, true, {}, ['quota'], Symbol.iterator]) {
    assert.equal(db.isStorageFailureKind(bad), false, String(typeof bad === 'symbol' ? 'symbol' : JSON.stringify(bad)))
  }
})

// ---------------------------------------------------------------- storageFailureOf

test('storageFailureOf：带 name / message / stores / at；at 取 Date.now()', (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_123)
  assert.deepEqual(db.storageFailureOf(named('QuotaExceededError', '配额'), 'sessions,sessionSummaries'), {
    kind: 'quota',
    at: 1_700_000_000_123,
    name: 'QuotaExceededError',
    message: '配额',
    stores: 'sessions,sessionSummaries',
  })
})

test('storageFailureOf：message 截断到 200 字符（199/200 不动，201 截成 200）', () => {
  for (const [length, expected] of [[199, 199], [200, 200], [201, 200], [5000, 200]]) {
    const failure = db.storageFailureOf(named('Error', 'm'.repeat(length)))
    assert.equal(failure.message.length, expected, `输入 ${length}`)
  }
})

test('storageFailureOf：空 / 缺失字段整个省略（键不存在，而不是 undefined）', (t) => {
  t.mock.method(Date, 'now', () => 7)
  const bare = db.storageFailureOf(undefined)
  assert.deepEqual(bare, { kind: 'unknown', at: 7 })
  assert.deepEqual(Object.keys(bare).sort(), ['at', 'kind'])
  // 空 name / 空 message / 空 stores 都省略
  assert.deepEqual(db.storageFailureOf({ name: '', message: '' }, ''), { kind: 'unknown', at: 7 })
  // name 非字符串、message 非字符串
  assert.deepEqual(db.storageFailureOf({ name: 3, message: 4 }), { kind: 'unknown', at: 7 })
})

test('storageFailureOf：字符串抛值 → message=该字符串、没有 name、kind=unknown', (t) => {
  t.mock.method(Date, 'now', () => 7)
  assert.deepEqual(db.storageFailureOf('boom'), { kind: 'unknown', at: 7, message: 'boom' })
  assert.deepEqual(db.storageFailureOf(''), { kind: 'unknown', at: 7 })
})

// ---------------------------------------------------------------- normalizeStorageFailure

const NORMALIZE_ROWS = [
  ['true（P0 之前的布尔）', true, { kind: 'unknown' }],
  ['false', false, undefined],
  ['undefined', undefined, undefined],
  ['null', null, undefined],
  ['0', 0, undefined],
  ['字符串', 'quota', undefined],
  ['函数', () => {}, undefined],
  ['空对象 → 补 kind=unknown', {}, { kind: 'unknown' }],
  ['合法 kind 原样保留 + 其它字段透传', { kind: 'quota', name: 'QuotaExceededError', at: 5 }, { kind: 'quota', name: 'QuotaExceededError', at: 5 }],
  ['非法 kind 改写成 unknown，其它字段保留', { kind: 'bogus', name: 'N' }, { kind: 'unknown', name: 'N' }],
  ['档位名当 kind（retry）视为非法', { kind: 'retry' }, { kind: 'unknown' }],
  ['数组（typeof 为 object）→ 当空对象处理', [], { kind: 'unknown' }],
]

for (const [label, input, expected] of NORMALIZE_ROWS) {
  test(`normalizeStorageFailure：${label}`, () => {
    assert.deepEqual(db.normalizeStorageFailure(input), expected)
  })
}

test('normalizeStorageFailure：返回新对象，不改调用方传入的那个', () => {
  const source = { kind: 'bogus' }
  const out = db.normalizeStorageFailure(source)
  assert.notEqual(out, source)
  assert.equal(source.kind, 'bogus')
})

// ---------------------------------------------------------------- selectSaveBannerTier

const SELECT_ROWS = [
  ['null', null, null],
  ['undefined', undefined, null],
  ['空对象', {}, null],
  ['只有 false / undefined 值 → 全跳过', { a: false, b: undefined }, null],
  ['布尔 true → retry', { a: true }, 'retry'],
  ['unknown → retry', { a: { kind: 'unknown' } }, 'retry'],
  ['clone → retry', { a: { kind: 'clone' } }, 'retry'],
  ['quota → quota', { a: { kind: 'quota' } }, 'quota'],
  ['unavailable → unavailable', { a: { kind: 'unavailable' } }, 'unavailable'],
  ['非法 kind → retry（按 unknown 读）', { a: { kind: 'bogus' } }, 'retry'],
  ['跳过假值后取到有效项', { a: false, b: { kind: 'quota' } }, 'quota'],
  ['retry + quota → quota', { a: true, b: { kind: 'quota' } }, 'quota'],
  ['quota + unavailable → unavailable', { a: { kind: 'quota' }, b: { kind: 'unavailable' } }, 'unavailable'],
  ['三档并存 → unavailable', { a: true, b: { kind: 'quota' }, c: { kind: 'unavailable' } }, 'unavailable'],
]

for (const [label, input, expected] of SELECT_ROWS) {
  test(`selectSaveBannerTier：${label} → ${expected}`, () => {
    assert.equal(db.selectSaveBannerTier(input), expected)
  })
}

test('selectSaveBannerTier：结果与键顺序无关（三档的全部 6 种排列）', () => {
  const items = [
    ['r', true],
    ['q', { kind: 'quota' }],
    ['u', { kind: 'unavailable' }],
  ]
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  for (const order of permutations) {
    const errors = Object.fromEntries(order.map((index) => items[index]))
    assert.equal(db.selectSaveBannerTier(errors), 'unavailable', order.join(','))
  }
})

test('saveBannerRetryable：只有 unavailable 档不给重试', () => {
  assert.deepEqual(
    ['retry', 'quota', 'unavailable'].map((tier) => db.saveBannerRetryable(tier)),
    [true, true, false]
  )
})
