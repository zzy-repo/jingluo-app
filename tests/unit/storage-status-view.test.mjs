// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// 设置页「本地存储」这一节的纯视图映射。
//
// 本文件守两件事，都是**面向普通用户**的口径：
//
//   A 状态映射：「已完成升级 / 暂未升级 / 升级失败 / 升级中 / 暂不可用 / 正在检测」六态要一一对上，
//     其中 `failed`（尝试过、失败了）与 `not-migrated`（从未迁移）**必须分开** ——
//     用户看到的下一步动作不同，混成一个词就等于把「升级失败」藏起来（那正是内测反馈的一半）。
//
//   B 不暴露技术实现：界面只讲「数据升级」，不讲后端是谁。所以
//     ① 视图层不再产出「当前存储」这一行的文案 key；
//     ② 所有 `storageStatus*` 词条的取值里不许出现 SQLite / IndexedDB / 字节数 / MiB 这类字样。
//     引擎信息改由诊断快照承载（`storage.engine`），用户看不到、开发查得到。
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

const { readStorageStatus } = await import('../../src/components/settings/storageStatusView.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const FAILURE = { kind: 'unknown', message: 'boom' }

/** 默认输入：运行时已注册、宿主有持久化后端、路由还没结论 */
const input = (overrides = {}) => ({
  view: { kind: 'checking' },
  choice: undefined,
  runtimeRegistered: true,
  storageAvailable: true,
  ...overrides,
})

// ── A. 状态映射 ────────────────────────────────────────────────────────────

test('A1 闸门 succeeded → 已完成升级', () => {
  const status = readStorageStatus(input({ view: { kind: 'succeeded' }, choice: { engine: 'sqlite' } }))
  assert.equal(status.migration, 'migrated')
})

test('A2 闸门 migrating → 升级中', () => {
  const status = readStorageStatus(
    input({ view: { kind: 'migrating', phase: 'copy', percent: 40 } })
  )
  assert.equal(status.migration, 'migrating')
})

test('A3 闸门 ready + sqlite 路由 → 已完成升级', () => {
  const status = readStorageStatus(input({ view: { kind: 'ready' }, choice: { engine: 'sqlite' } }))
  assert.equal(status.migration, 'migrated')
})

test('A4 闸门 ready + indexeddb 路由 → 暂未升级', () => {
  const status = readStorageStatus(
    input({ view: { kind: 'ready' }, choice: { engine: 'indexeddb', reason: 'web' } })
  )
  assert.equal(status.migration, 'not-migrated')
})

test('A5 闸门 unsupported → 暂未升级（不是「不可用」）', () => {
  const status = readStorageStatus(
    input({ view: { kind: 'unsupported' }, choice: { engine: 'indexeddb', reason: 'native-not-ready' } })
  )
  assert.equal(status.migration, 'not-migrated')
})

// —— 下面这条是本次改动的核心：失败与「没试过」必须分开 ——

test('A6 闸门 failed → 升级失败，且与「暂未升级」不是同一个状态', () => {
  const failed = readStorageStatus(input({ view: { kind: 'failed', failure: FAILURE } }))
  const notMigrated = readStorageStatus(
    input({ view: { kind: 'ready' }, choice: { engine: 'indexeddb', reason: 'web' } })
  )

  assert.equal(failed.migration, 'failed')
  assert.equal(notMigrated.migration, 'not-migrated')
  assert.notEqual(failed.migration, notMigrated.migration)
})

test('A7 闸门 checking → 正在检测', () => {
  const status = readStorageStatus(input({ view: { kind: 'checking' } }))
  assert.equal(status.migration, 'unknown')
})

test('A8 闸门 blocked → 暂不可用', () => {
  const status = readStorageStatus(
    input({
      view: { kind: 'blocked', reason: 'migrating' },
      choice: { engine: 'blocked', reason: 'migrating' },
    })
  )
  assert.equal(status.migration, 'unavailable')
})

test('A9 ready 但路由未出结论 → 正在检测（不猜）', () => {
  const status = readStorageStatus(input({ view: { kind: 'ready' }, choice: undefined }))
  assert.equal(status.migration, 'unknown')
})

test('A10 没有迁移运行时 → 暂不可用', () => {
  const status = readStorageStatus(input({ runtimeRegistered: false }))
  assert.equal(status.migration, 'unavailable')
})

test('A11 宿主无持久化后端 → 暂不可用', () => {
  const status = readStorageStatus(input({ storageAvailable: false }))
  assert.equal(status.migration, 'unavailable')
})

// ── B. 重试入口只在真能重试时出现 ──────────────────────────────────────────

test('B1 只有 failed 允许重试', () => {
  assert.equal(readStorageStatus(input({ view: { kind: 'failed', failure: FAILURE } })).canRetry, true)
})

test('B2 升级成功不给重试入口（不再保留置灰按钮）', () => {
  const status = readStorageStatus(input({ view: { kind: 'succeeded' }, choice: { engine: 'sqlite' } }))
  assert.equal(status.canRetry, false)
})

test('B3 迁移中 / 未升级 / 检查中 / 不可用 都不给重试', () => {
  const cases = [
    input({ view: { kind: 'migrating', phase: 'copy', percent: 10 } }),
    input({ view: { kind: 'ready' }, choice: { engine: 'indexeddb', reason: 'web' } }),
    input({ view: { kind: 'checking' } }),
    input({ runtimeRegistered: false }),
  ]
  for (const value of cases) {
    assert.equal(readStorageStatus(value).canRetry, false, JSON.stringify(value.view))
  }
})

// ── C. 后端判定仅供诊断，不进界面 ──────────────────────────────────────────

test('C1 backend 仍可算出（诊断用），但与界面展示无关', () => {
  assert.equal(readStorageStatus(input({ choice: { engine: 'sqlite' } })).backend, 'sqlite')
  assert.equal(
    readStorageStatus(input({ choice: { engine: 'indexeddb', reason: 'web' } })).backend,
    'indexeddb'
  )
  // 没注册运行时 = 恒走 IDB（storage/index.ts 的既有契约），属于已知事实而非猜测
  assert.equal(readStorageStatus(input({ runtimeRegistered: false })).backend, 'indexeddb')
  assert.equal(readStorageStatus(input({ storageAvailable: false })).backend, 'unavailable')
})

// ── D. 界面词条不许出现技术细节 ────────────────────────────────────────────

const FORBIDDEN = [
  /SQLite/i,
  /IndexedDB/i,
  /\bMiB\b/i,
  /\d+\s*bytes?/i,
  /4194304/,
  /\bSELECT\b|\bINSERT\b|\bUPDATE\b/i,
]

test('D1 所有 storageStatus* 词条都不含后端名 / 字节数 / SQL 片段', () => {
  for (const [locale, table] of [
    ['zh', zh],
    ['en', en],
  ]) {
    const entries = Object.entries(table).filter(([key]) => key.startsWith('storageStatus'))
    assert.ok(entries.length > 0, `${locale} 没有任何 storageStatus* 词条`)
    for (const [key, value] of entries) {
      for (const pattern of FORBIDDEN) {
        assert.ok(
          !pattern.test(value),
          `${locale}.${key} 泄漏技术细节：${JSON.stringify(value)} 命中 ${pattern}`
        )
      }
    }
  }
})

test('D2 视图层不再产出「当前存储」这一行的文案 key', () => {
  // 反证：「当前存储」整行已被移除，所以这两个 key 不应再存在（存在即说明有人把它加回来了）
  assert.equal(zh.storageStatusBackendLabel, undefined)
  assert.equal(en.storageStatusBackendLabel, undefined)
  assert.equal(zh.storageStatusDescription, undefined)
  assert.equal(en.storageStatusDescription, undefined)
})

test('D3 六态词条在 zh / en 都存在（新增 failed 不许在某一侧漏掉）', () => {
  const keys = [
    'storageStatusMigrated',
    'storageStatusNotMigrated',
    'storageStatusFailed',
    'storageStatusMigrating',
    'storageStatusUnavailable',
    'storageStatusUnknown',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
  }
})
