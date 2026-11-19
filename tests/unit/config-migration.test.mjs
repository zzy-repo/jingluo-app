// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
//
// Issue #339 的第二次修复：一次性配置迁移。
//
// 读侧（apiConfig.storedModel）已经不再把共享键 `chat-demo:model` 当官方渠道的模型来源，
// 但那个键留在本地就是个「休眠污染源」：换渠道、换构建、以后谁再读一次共享键，同一个 bug 就复活。
// 所以升级启动时（src/main.tsx → migrateConfigOnce）按版本号 `chat-demo:config-schema` 清一次，
// 并写一条 `config_change / legacy-model / result=migrated` 诊断留痕。
//
// 断言点：
//   ① 残留 + 没在用老中转 → 键被删、schema=2、getModel() 回官方默认、诊断里有 migrated 记录
//   ② 幂等：第二次调用不再清、不再写诊断
//   ③ 老中转仍在用 → **不**清（地址与模型是同一套配置，1.2.3 老用户的正常状态）
//   ④ 本来就没有残留 → 只落版本号，不写诊断
//   ⑤ 诊断 meta ≥ 2 键（check:log-coverage 的 R3 会拦空 meta），且带上被清掉的值
//
//   node tests/run-layer.mjs unit --only config-migration
import assert from 'node:assert/strict'
import { fixtureUrl, installEndpointsGlobals, installTsResolve } from '../helpers/dom-env.mjs'
import { test } from 'node:test'

// 装配走公共入口（#408 收尾批）：采集层依赖 DOM / IndexedDB，单测只关心「写了哪条动作」，
// 所以只把 diagnostics collector 换成内存替身；`.js→.ts` 与构建期注入值都由 helpers 统一处理。
installTsResolve({
  stubs: [[/diagnostics\/collector\.js$/, fixtureUrl('chat-stubs/collector.mjs')]],
})
installEndpointsGlobals()

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const cfg = await import('../../src/services/api/apiConfig.ts')
const migration = await import('../../src/services/api/configMigration.ts')

const RESIDUE = 'deepseek-v4.1-flash'
const RELAY = 'https://legacy-relay.example.com'

const seed = (entries) => {
  store.clear()
  globalThis.__log = { records: [], events: [], actions: [] }
  for (const [key, value] of Object.entries(entries)) {
    store.set(key, value)
  }
}

test('① 残留 + 没在用老中转 → 键被清、schema=2、模型回官方默认、诊断留痕', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek', 'chat-demo:model': RESIDUE })

  const result = migration.migrateConfigOnce()
  assert.equal(result.clearedModel, RESIDUE, '返回值要带出被清掉的值')
  assert.equal(result.from, 1, '没有版本号 = 1.2.x / 1.3.0 的配置')
  assert.equal(result.to, 2)

  assert.equal(store.has('chat-demo:model'), false, '残留键必须被删掉（等价于用户手工 removeItem）')
  assert.equal(store.get('chat-demo:config-schema'), '2', '版本号要落盘，保证只迁一次')
  assert.equal(cfg.getModel(), 'deepseek-flash', '迁移后官方渠道发出内置模型')
  assert.equal(cfg.useApiConfig.getState().model, '', '界面 state 也要同步（不再显示旧值）')

  const actions = globalThis.__log.actions.filter((entry) => entry.action === 'legacy-model')
  assert.equal(actions.length, 1, '迁移必须写一条诊断')
  const [action] = actions
  assert.equal(action.kind, 'config_change')
  assert.equal(action.fields.result, 'migrated')
  assert.equal(action.fields.model, RESIDUE, 'meta 里要能看出被清掉的是哪个值')
  assert.ok(
    Object.keys(action.fields).length >= 2,
    'meta 至少两个键（check:log-coverage 的 R3 会拦空 meta）'
  )
})

test('① 用户当前在 ours 渠道：残留同样被清（它只属于旧共享键）', () => {
  seed({ 'chat-demo:provider-kind': 'ours', 'chat-demo:model': RESIDUE })
  const result = migration.migrateConfigOnce()
  assert.equal(result.clearedModel, RESIDUE)
  assert.equal(store.has('chat-demo:model'), false)
  assert.equal(cfg.getModel(), 'deepseek-v4.1-flash', 'ours 仍用内置模型（来自 spec.defaults）')
})

test('② 幂等：第二次调用不再清理、不再写诊断', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek', 'chat-demo:model': RESIDUE })
  migration.migrateConfigOnce()

  // 迁移之后又被写了一次（模拟别的构建 / 手工改 localStorage）：版本号已是最新，不再清
  store.set('chat-demo:model', 'another-old-model')
  const before = globalThis.__log.actions.length
  const second = migration.migrateConfigOnce()

  assert.equal(second.clearedModel, null, '已迁移过就不再动任何键')
  assert.equal(second.from, 2)
  assert.equal(store.get('chat-demo:model'), 'another-old-model', '幂等：版本号到顶后不再清理')
  assert.equal(globalThis.__log.actions.length, before, '也不该重复写诊断')
})

test('③ 老中转仍在用 → 不清（地址与模型是同一套配置）', () => {
  seed({
    'chat-demo:provider-kind': 'deepseek',
    'chat-demo:model': 'legacy-relay-model',
    'chat-demo:base-url': RELAY,
  })
  const result = migration.migrateConfigOnce()

  assert.equal(result.clearedModel, null, 'relay 场景不清模型')
  assert.equal(store.get('chat-demo:model'), 'legacy-relay-model', '1.2.3 老用户的模型必须留着')
  assert.equal(cfg.getModel(), 'legacy-relay-model')
  assert.equal(store.get('chat-demo:base-url'), RELAY, 'base-url 一律不删')
  assert.equal(store.get('chat-demo:config-schema'), '2', '版本号照样落盘')
  assert.equal(
    globalThis.__log.actions.filter((entry) => entry.action === 'legacy-model').length,
    0,
    '没清东西就不写 migrated 诊断'
  )
})

test('④ 本来没有残留 → 只落版本号，不写诊断', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek' })
  const result = migration.migrateConfigOnce()

  assert.equal(result.clearedModel, null)
  assert.equal(store.get('chat-demo:config-schema'), '2')
  assert.equal(globalThis.__log.actions.length, 0)
  assert.equal(cfg.getModel(), 'deepseek-flash')
})

test('⑤ 版本号已经是 2 → 直接返回，一个键都不碰', () => {
  seed({
    'chat-demo:provider-kind': 'deepseek',
    'chat-demo:model': RESIDUE,
    'chat-demo:config-schema': '2',
  })
  const result = migration.migrateConfigOnce()
  assert.deepEqual(result, { clearedModel: null, from: 2, to: 2 })
  assert.equal(store.get('chat-demo:model'), RESIDUE, '版本号到顶后连残留都不动（迁移已经跑过）')
})
