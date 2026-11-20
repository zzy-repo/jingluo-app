// [layer: unit | 依赖: 无（纯 Node，零浏览器、零网络） | 耗时: <1s]
//
// #362 / #367 · 域 3 最小充分集 · N3-A「渠道配置解析与迁移矩阵」（L0，一张表 12 行）
//
// 被测对象是**真源码**：`src/services/api/apiConfig.ts`（解析 / 校验 / 按渠道隔离 / 旧残留读侧守卫）
// + `src/services/api/configMigration.ts`（#339 一次性迁移写侧）。只把 localStorage 与诊断写入口
// 换成内存替身，不 mock 任何被测逻辑。
//
// 覆盖功能点（注释见每一行的 [F3-xx] 标注）：
//   F3-01 四渠道切换：非法/缺失 kind 一律回落构建默认，不白屏、不发空渠道请求
//   F3-08 地址/模型默认值与自填校验：normalizeBaseUrl、去尾斜杠、内置渠道拒写、空模型拒写
//   F3-09 配置迁移与旧残留清理：LEGACY_HOSTS 读到即忽略、老中转仍在用时模型继续生效、#339 残留清理
//   F3-13 渠道间凭证隔离：地址与模型按渠道分开存、API Key 共用一把、切换不串台
//
// 跑法：
//   node tests/run-layer.mjs unit --only domain03-provider-config-matrix
//   node --test tests/unit/domain03-provider-config-matrix.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

const collectorStub = new URL('../fixtures/domain03-04/collector.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 采集层依赖 DOM：这里只需要「哪天写了哪条动作」，换成内存替身
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 源码里写的是 ESM 的 `.js` 后缀，实际文件是 `.ts`（打包期由 rspack 解析）
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

// 打包期注入的常量（rspack DefinePlugin）：标准构建 → 默认渠道 deepseek
globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl: 'https://invite.test.invalid',
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([]),
})
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false
globalThis.__log = { records: [], events: [], actions: [] }

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
}

const cfg = await import('../../src/services/api/apiConfig.ts')
const migration = await import('../../src/services/api/configMigration.ts')
const { getSpec, PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')

const OFFICIAL = getSpec('deepseek').defaults
const OURS = getSpec('ours').defaults
const LEGACY_HOST = legacyHosts[0]
const RELAY = 'https://relay.example.com'
const RESIDUE = 'deepseek-v4.1-flash'

/** 每行的起点：清空存储 + 把 store 拉回「标准构建、什么都没配」 */
const reset = (entries = {}) => {
  store.clear()
  globalThis.__log = { records: [], events: [], actions: [] }
  for (const [key, value] of Object.entries(entries)) {
    store.set(key, value)
  }
  cfg.useApiConfig.setState({ kind: 'deepseek', apiKey: '', baseUrl: '', model: '' })
}

const actionsOf = (action) => globalThis.__log.actions.filter((entry) => entry.action === action)

test('N3-A 渠道配置解析与迁移矩阵（表驱动 12 行）', async (t) => {
  await t.test('[1] F3-08 地址归一化：去空白、去尾斜杠、保留路径与大小写', () => {
    assert.equal(cfg.normalizeBaseUrl('  https://Relay.Example.com/v1///  '), 'https://Relay.Example.com/v1')
    assert.equal(cfg.normalizeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
    assert.equal(cfg.normalizeBaseUrl('https://relay.example.com'), 'https://relay.example.com')
  })

  await t.test('[2] F3-08 非法地址一律 null（不猜、不补 scheme、不放行非 http(s)）', () => {
    const invalid = [
      '',
      '   ',
      'relay.example.com',
      '//relay.example.com',
      'ftp://relay.example.com',
      'javascript:alert(1)',
      'http://',
      'http://relay example.com',
    ]
    for (const value of invalid) {
      assert.equal(cfg.normalizeBaseUrl(value), null, `非法地址必须被判 null：${JSON.stringify(value)}`)
    }
  })

  await t.test('[3] F3-08 setBaseUrl 非法地址：返回 false、不落盘、state 不变、诊断留痕', () => {
    reset({ 'chat-demo:provider-kind': 'anthropic' })
    cfg.setProviderKind('anthropic')
    const before = cfg.useApiConfig.getState().baseUrl
    assert.equal(cfg.setBaseUrl('relay.example.com'), false, '缺 scheme 必须拒绝')
    assert.equal(store.has('chat-demo:base-url:anthropic'), false, '非法值不许写盘（否则「保存后没反应」）')
    assert.equal(cfg.useApiConfig.getState().baseUrl, before, 'state 不能被非法值污染')
    const [rejected] = actionsOf('provider-base-url')
    assert.equal(rejected?.fields.result, 'invalid', '保存失败必须留痕，否则查不出「改了但没生效」')
  })

  await t.test('[4] F3-08 内置渠道（deepseek / ours）拒写地址与模型', () => {
    for (const kind of ['deepseek', 'ours']) {
      reset({ 'chat-demo:provider-kind': kind })
      cfg.setProviderKind(kind)
      assert.equal(cfg.setBaseUrl('https://evil.example.com'), false, `${kind} 的地址由 spec.defaults 决定`)
      assert.equal(cfg.setModel('gpt-4o'), false, `${kind} 的模型由 spec.defaults 决定`)
      assert.equal(store.has(`chat-demo:base-url:${kind}`), false, `${kind} 不许把地址写进 localStorage`)
      assert.equal(store.has(`chat-demo:model:${kind}`), false, `${kind} 不许把模型写进 localStorage`)
    }
  })

  await t.test('[5] F3-08 空模型拒写；reset=true 才允许清空', () => {
    reset({ 'chat-demo:provider-kind': 'openai' })
    cfg.setProviderKind('openai')
    assert.equal(cfg.setModel('gpt-4o-mini'), true)
    assert.equal(cfg.setModel('   '), false, '空白模型不是有效值')
    assert.equal(cfg.useApiConfig.getState().model, 'gpt-4o-mini', '拒写后 state 保持上一个有效值')
    const [rejected] = actionsOf('provider-model').filter((entry) => entry.fields.result === 'invalid')
    assert.equal(rejected?.fields.reason, 'empty')
    assert.equal(cfg.setModel('', true), true, '清除要显式传 reset，不能靠空串')
    assert.equal(store.has('chat-demo:model:openai'), false)
    assert.equal(cfg.useApiConfig.getState().model, '', 'state 清空，界面回到占位值')
    assert.equal(cfg.getModel(), 'deepseek-flash', '自填渠道没有内置默认 → 回落 DEFAULT_MODEL')
  })

  await t.test('[6] F3-13 地址/模型按渠道分开存，API Key 共用一把', () => {
    reset()
    cfg.setApiKey('sk-shared-key')
    cfg.setProviderKind('anthropic')
    assert.equal(cfg.setBaseUrl(`${RELAY}/anthropic`), true)
    assert.equal(cfg.setModel('claude-relay-model'), true)
    cfg.setProviderKind('openai')
    assert.equal(cfg.setBaseUrl(`${RELAY}/openai`), true)
    assert.equal(cfg.setModel('gpt-relay-model'), true)

    assert.equal(store.get('chat-demo:base-url:anthropic'), `${RELAY}/anthropic`)
    assert.equal(store.get('chat-demo:base-url:openai'), `${RELAY}/openai`)
    assert.equal(store.get('chat-demo:model:anthropic'), 'claude-relay-model')
    assert.equal(store.get('chat-demo:model:openai'), 'gpt-relay-model')
    assert.equal(cfg.getApiKey(), 'sk-shared-key', 'Key 四个渠道共用一把，换渠道不能丢')
    assert.equal(cfg.getBaseUrl(), `${RELAY}/openai`, '当前渠道只认自己的地址')
  })

  await t.test('[7] F3-13 切回原渠道：自填值原样回来，Key 不丢', () => {
    reset()
    cfg.setApiKey('sk-shared-key')
    cfg.setProviderKind('anthropic')
    cfg.setBaseUrl(`${RELAY}/anthropic`)
    cfg.setModel('claude-relay-model')

    cfg.setProviderKind('openai')
    cfg.setBaseUrl(`${RELAY}/openai`)
    cfg.setModel('gpt-relay-model')

    cfg.setProviderKind('anthropic')
    assert.equal(cfg.getBaseUrl(), `${RELAY}/anthropic`)
    assert.equal(cfg.getModel(), 'claude-relay-model')
    assert.equal(cfg.getApiKey(), 'sk-shared-key')
    assert.equal(cfg.useApiConfig.getState().baseUrl, `${RELAY}/anthropic`, '界面 state 也要跟着切回来')
    assert.equal(cfg.useApiConfig.getState().model, 'claude-relay-model')
  })

  await t.test('[8] F3-01 非法/缺失渠道回落构建默认，不白屏也不发空渠道请求', () => {
    for (const saved of ['', 'bogus', 'DEEPSEEK', 'our', 'null']) {
      reset({ 'chat-demo:provider-kind': saved })
      assert.equal(cfg.getProviderKind(), 'deepseek', `非法 kind ${JSON.stringify(saved)} 必须回落 deepseek`)
      assert.equal(cfg.getCurrentSpec().kind, 'deepseek')
    }
    reset()
    assert.equal(cfg.getProviderKind(), 'deepseek', '老用户没有这个键 → 构建默认渠道')
    assert.equal(getSpec(undefined).kind, 'deepseek')
    assert.equal(getSpec('bogus').kind, 'deepseek')
    assert.equal(PROVIDER_SPECS.length, 4, '四个渠道都要能选')

    reset()
    cfg.setProviderKind('bogus')
    assert.equal(store.get('chat-demo:provider-kind'), 'deepseek', '非法值不落盘')
    assert.equal(cfg.useApiConfig.getState().kind, 'deepseek')
  })

  await t.test('[9] F3-09 已下线主机：读到即忽略，回落内置默认（地址与模型一起失效）', () => {
    reset({
      'chat-demo:provider-kind': 'deepseek',
      'chat-demo:base-url': `http://${LEGACY_HOST}:60010`,
      'chat-demo:model': RESIDUE,
    })
    assert.equal(cfg.getBaseUrl(), OFFICIAL.baseUrl, '下线主机一律当作没配过')
    assert.equal(cfg.getModel(), OFFICIAL.model, '地址不是老中转 → 共享模型不许再生效')
    assert.equal(cfg.isLegacyRelayInUse('deepseek'), false)
  })

  await t.test('[10] F3-09 老中转仍在用：地址与模型作为一套配置一起保留', () => {
    reset({
      'chat-demo:provider-kind': 'deepseek',
      'chat-demo:base-url': RELAY,
      'chat-demo:model': 'relay-model',
    })
    assert.equal(cfg.isLegacyRelayInUse('deepseek'), true)
    assert.equal(cfg.getBaseUrl(), RELAY, '1.2.3 老用户升级后地址仍生效')
    assert.equal(cfg.getModel(), 'relay-model', '同一套配置里的模型也必须继续生效')
    assert.equal(cfg.isLegacyRelayInUse('openai'), false, '老共享键只属于 DeepSeek 官方')
  })

  await t.test('[11] F3-09 #339 残留：读侧不生效 + 写侧一次性清理', () => {
    reset({ 'chat-demo:provider-kind': 'deepseek', 'chat-demo:model': RESIDUE })
    assert.equal(cfg.getModel(), OFFICIAL.model, '读侧先堵住：内置渠道不读共享键残留')

    const result = migration.migrateConfigOnce()
    assert.equal(result.clearedModel, RESIDUE, '写侧把残留清掉并带回被清的值')
    assert.equal(store.has('chat-demo:model'), false)
    assert.equal(store.get('chat-demo:config-schema'), '2', '版本号落盘，保证只迁一次')
    assert.equal(cfg.getModel(), OFFICIAL.model)
    assert.equal(
      actionsOf('legacy-model')[0]?.fields.result,
      'migrated',
      '迁移必须留痕（出问题能直接看到清掉了哪个值）'
    )
  })

  await t.test('[12] F3-09 锁定渠道：旧值被内置默认覆盖，Key 保留', () => {
    reset({
      'chat-demo:provider-kind': 'ours',
      'chat-demo:api-key': 'sk-ours-key',
      'chat-demo:base-url:ours': 'https://old-ours.example.com',
      'chat-demo:model:ours': 'old-ours-model',
    })
    assert.equal(cfg.getBaseUrl(), OURS.baseUrl, 'locked 渠道的地址只认 spec.defaults')
    assert.equal(cfg.getModel(), OURS.model, 'locked 渠道的模型只认 spec.defaults')
    assert.equal(cfg.getApiKey(), 'sk-ours-key', 'Key 共用一把，不能被锁定渠道的迁移抹掉')
  })
})
