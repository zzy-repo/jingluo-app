// [layer: unit | 纯 Node，零浏览器，不发网络请求 | 耗时: <1s]
//
// N3 迁移不变量表（域 9 · F9-11）—— #362 / #367
//
// 迁移是**唯一会删用户数据的动作**，删错不可回滚。`config-migration.test.mjs` 覆盖了 #339 那一次
// （schema 1→2 清共享 model 残留：幂等 / 老中转不误删 / 诊断留痕），但那是**单场景回归**：
// schema 升到 3 时，「只删已知废弃键、表外键一个都不动」没有任何断言兜底。
//
// 本用例把契约写成一张表（`tests/fixtures/domain08-09/migration-invariants.mjs`）：
//   `schema 版本 → 允许删除的键集合`
// 每个用例逐键对账迁移前后的 localStorage：
//   ① 删掉的键 **必须正好等于** allowedDeletions（多删一个 = 丢用户配置）
//   ② 新增的键只能是版本号本身
//   ③ 留下来的键**值也逐字节不变**（不是「键还在」就算过）
//   ④ 高价值键（设备码 / API Key / 渠道 / 主题 / 阅读设置）显式点名保护
// 外加「版本覆盖门禁」：新增 schema 版本必须补一行，否则本用例失败。
//
//   node --test tests/unit/domain09-config-migration-invariants.test.mjs
import assert from 'node:assert/strict'
import { fixtureUrl, installEndpointsGlobals, installTsResolve } from '../helpers/dom-env.mjs'
import { test } from 'node:test'

// 装配走公共入口（#408 收尾批）：collector 替身 + `.js→.ts` + 构建期注入值。
// 「只换 src/services/ 下的采集层」这条按父模块的判定原样保留（走 onResolve）。
installTsResolve({
  onResolve: (specifier, context) => (
    /(?:^|\/)collector\.js$/.test(specifier) && context.parentURL?.includes('/src/services/')
      ? fixtureUrl('domain08-09/collector-stub.mjs')
      : undefined
  ),
})
installEndpointsGlobals()

Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

const resetLog = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
}
resetLog()

const api = await import('../../src/services/api/apiConfig.ts')
const migration = await import('../../src/services/api/configMigration.ts')
const { BASELINE, MIGRATION_CASES, PROTECTED_KEYS, SCHEMA_KEY } = await import(
  '../fixtures/domain08-09/migration-invariants.mjs'
)

const CONFIG_SCHEMA_VERSION = migration.CONFIG_SCHEMA_VERSION

/** 把一行用例的「升级前状态」写进假存储 */
const seedCase = (row) => {
  storage.clear()
  resetLog()
  for (const [key, value] of Object.entries(BASELINE)) storage.set(key, value)
  for (const [key, value] of Object.entries(row.seed)) storage.set(key, value)
  if (row.from === null) storage.delete(SCHEMA_KEY)
  else storage.set(SCHEMA_KEY, row.from)
}

const snapshotStore = () => Object.fromEntries(storage)

/**
 * 逐键对账：删了哪些、加了哪些、改了哪些。
 * 版本号键（`chat-demo:config-schema`）单独判（它的语义就是「从 N 变成 N+1」），
 * 其余业务键只许「原样保留」或「整条删除」。
 */
const diffStores = (before, after) => {
  const business = (key) => key !== SCHEMA_KEY
  return {
    deleted: Object.keys(before)
      .filter((key) => business(key) && !(key in after))
      .sort(),
    added: Object.keys(after)
      .filter((key) => business(key) && !(key in before))
      .sort(),
    changed: Object.keys(before)
      .filter((key) => business(key) && key in after && before[key] !== after[key])
      .sort(),
    schemaBefore: before[SCHEMA_KEY] ?? null,
    schemaAfter: after[SCHEMA_KEY] ?? null,
  }
}

test('N3-a 迁移不变量：schema → 允许删除的键集合（表外键一个都不动）', () => {
  const failures = []
  for (const row of MIGRATION_CASES) {
    seedCase(row)
    const before = snapshotStore()
    const result = migration.migrateConfigOnce()
    const after = snapshotStore()
    const diff = diffStores(before, after)
    const record = (message) => failures.push(`${row.id} ${row.label}：${message}`)

    if (JSON.stringify(diff.deleted) !== JSON.stringify([...row.allowedDeletions].sort())) {
      record(`删掉的键 ${JSON.stringify(diff.deleted)} ≠ 允许删除的 ${JSON.stringify(row.allowedDeletions)}`)
    }
    if (JSON.stringify(diff.added) !== JSON.stringify([...row.allowedAdditions].sort())) {
      record(`新增的业务键 ${JSON.stringify(diff.added)} ≠ 允许新增的 ${JSON.stringify(row.allowedAdditions)}`)
    }
    if (diff.schemaBefore !== (row.from ?? null)) {
      record(`迁移前的版本号 ${JSON.stringify(diff.schemaBefore)} ≠ 用例声明 ${JSON.stringify(row.from)}`)
    }
    if (diff.changed.length > 0) {
      record(`改了这些键的值：${diff.changed.join(', ')}（迁移只许删，不许改）`)
    }
    // 返回值 + 落盘版本 + 读取侧结果
    assert.equal(result.clearedModel, row.expect.clearedModel, `${row.id} clearedModel`)
    assert.equal(result.from, row.expect.from, `${row.id} from`)
    assert.equal(result.to, row.expect.to, `${row.id} to`)
    assert.equal(storage.get(SCHEMA_KEY), row.expect.schema, `${row.id} 版本号落盘`)
    assert.equal(api.getModel(), row.expect.model, `${row.id} 迁移后的模型`)
    // 高价值键点名保护（键在 + 值不变）
    for (const key of PROTECTED_KEYS) {
      if (!(key in BASELINE)) continue
      const expected = row.seed[key] ?? BASELINE[key]
      if (after[key] !== expected) record(`受保护的键 ${key} 被动过：${JSON.stringify(after[key])} ≠ ${JSON.stringify(expected)}`)
    }
  }
  console.log(`  ·  迁移不变量：${MIGRATION_CASES.length} 行 × 逐键对账（删除 / 新增 / 改动）+ ${PROTECTED_KEYS.length} 个受保护键`)
  assert.deepEqual(failures, [])
})

test('N3-b 幂等：同一状态跑两遍，第二次一个键都不动、也不再写诊断', () => {
  const failures = []
  for (const row of MIGRATION_CASES) {
    seedCase(row)
    const first = migration.migrateConfigOnce()
    const actionsAfterFirst = globalThis.__log.actions.length
    const before = snapshotStore()
    const second = migration.migrateConfigOnce()
    const after = snapshotStore()
    const diff = diffStores(before, after)
    if (diff.deleted.length || diff.added.length || diff.changed.length) {
      failures.push(`${row.id}：第二次调用动了键 ${JSON.stringify(diff)}`)
    }
    if (second.clearedModel !== null) failures.push(`${row.id}：第二次又清了一次 ${second.clearedModel}`)
    if (second.to !== first.to) failures.push(`${row.id}：第二次版本号从 ${first.to} 变成 ${second.to}`)
    if (globalThis.__log.actions.length !== actionsAfterFirst) {
      failures.push(`${row.id}：第二次调用又写了 ${globalThis.__log.actions.length - actionsAfterFirst} 条诊断`)
    }
  }
  console.log(`  ·  幂等：${MIGRATION_CASES.length} 行各跑两遍`)
  assert.deepEqual(failures, [])
})

test('N3-c 版本覆盖门禁：每个待迁移版本都必须有登记行（新增 schema 3 时必须补一行）', () => {
  const covered = new Set(MIGRATION_CASES.filter((row) => row.from !== null || row.allowedDeletions.length || row.allowedAdditions.length).map((row) => row.from ?? 1))
  const required = []
  for (let version = 1; version < CONFIG_SCHEMA_VERSION; version += 1) required.push(version)
  const missing = required.filter((version) => !covered.has(version))
  console.log(`  ·  版本覆盖：schema ${required.join(',')} → ${CONFIG_SCHEMA_VERSION}，已登记 ${[...covered].sort().join(',')}`)
  assert.deepEqual(
    missing,
    [],
    `schema ${missing.join(',')} → ${CONFIG_SCHEMA_VERSION} 没有登记「允许删除的键集合」：先把表补上，再让迁移跑`
  )
  assert.ok(
    MIGRATION_CASES.some((row) => row.from === String(CONFIG_SCHEMA_VERSION)),
    '必须有一行覆盖「已到顶版本」的 no-op 行为'
  )
})

test('N3-d 诊断留痕：清掉残留时记录「清了哪个值、多长、哪个渠道」，没清就一条都不写', () => {
  const failures = []
  for (const row of MIGRATION_CASES) {
    seedCase(row)
    migration.migrateConfigOnce()
    const records = globalThis.__log.actions.filter((action) => action.action === 'legacy-model')
    if (row.expect.clearedModel === null) {
      if (records.length !== 0) failures.push(`${row.id}：没清东西却写了 ${records.length} 条 legacy-model 诊断`)
      continue
    }
    if (records.length !== 1) {
      failures.push(`${row.id}：清了残留却没有一条 legacy-model 诊断`)
      continue
    }
    const fields = records[0].fields ?? {}
    if (fields.result !== 'migrated') failures.push(`${row.id}：result 应为 migrated，实际 ${fields.result}`)
    if (fields.model !== row.expect.clearedModel) failures.push(`${row.id}：诊断里没带上被清掉的值`)
    if (Object.keys(fields).length < 2) failures.push(`${row.id}：meta 至少两个键（check:log-coverage 的 R3）`)
    if (fields.length !== String(row.expect.clearedModel).length) failures.push(`${row.id}：诊断里的 length 不对`)
  }
  console.log('  ·  诊断留痕：清理行 1 条 legacy-model / 非清理行 0 条')
  assert.deepEqual(failures, [])
})

test('N3-e 不变量自检：表本身是「白名单」而不是「黑名单」', () => {
  // 允许删除的集合只能是「已知废弃键」；将来若有人把 api-key / device-id 加进白名单，
  // 这条会立刻失败（删用户凭据永远不属于迁移的职权）。
  const forbidden = ['chat-demo:api-key', 'chat-demo:ours-device-id', 'chat-demo:provider-kind', SCHEMA_KEY]
  for (const row of MIGRATION_CASES) {
    for (const key of row.allowedDeletions) {
      assert.equal(forbidden.includes(key), false, `${row.id} 把 ${key} 放进了可删集合`)
    }
  }
  assert.equal(MIGRATION_CASES.length >= 6, true, '每类升级前状态都应有一行')
})
