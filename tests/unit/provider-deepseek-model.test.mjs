// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
//
// Issue #339：官方渠道（deepseek）不能再读 1.2.x 时代的共享键 `chat-demo:model`。
//
// 为什么单独钉这一条：那个键的**写入方是旧版本**（beta.3 之前的 setModel 对所有渠道一律写共享键），
// 读取方是现在的代码，中间没有任何清理。只要里面躺过一个别的渠道的模型名（例如 ours 的默认值
// `deepseek-v4.1-flash`），官方渠道就会拿它去打官方端点 → 400 `The supported API model names are …`，
// 而设置页对这个渠道不渲染模型行、setModel 也拒写 —— 用户既看不见也改不了。
//
// 语义边界（四条都要保住）：
//   ① 只预置 model、没有 base-url  → 官方默认 deepseek-flash（issue 的验收口径）
//   ② 老中转地址仍在用（共享 base-url 非官方默认） → 旧模型继续生效（1.2.3 升级无感，legacy-config 锁着）
//   ③ 用户可编辑模型的渠道（anthropic / openai） → 自定义模型照旧生效
//   ④ locked 渠道（ours） → 只认 spec.defaults
//
//   node tests/run-layer.mjs unit --only provider-deepseek-model
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 端点地址唯一来源：config/endpoints.json（#274）
import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
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

// 非打包环境兜底：runner 一般已经用 --import tests/helpers/injected.mjs 注入过，这里只补缺失的那份
globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl: 'https://invite.test.invalid',
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([]),
})
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const { PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')
const cfg = await import('../../src/services/api/apiConfig.ts')

const OFFICIAL_BASE = 'https://api.deepseek.com'
const OFFICIAL_MODEL = 'deepseek-flash'
/** 真实残留来源之一：ours 渠道的默认模型，旧版手填过一次就会串进共享键 */
const RESIDUE = 'deepseek-v4.1-flash'
const RELAY = 'https://legacy-relay.example.com'

const specOf = (kind) => PROVIDER_SPECS.find((s) => s.kind === kind)

/** 造一份 localStorage：只放这次要断言的键 */
const seed = (entries) => {
  store.clear()
  for (const [key, value] of Object.entries(entries)) {
    store.set(key, value)
  }
}

test('① 官方渠道 + 共享键残留（没有 base-url）→ 实际发出 deepseek-flash', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek', 'chat-demo:model': RESIDUE })
  assert.equal(cfg.getModel(), OFFICIAL_MODEL, '内置渠道不许再读 chat-demo:model 的残留')
  assert.equal(cfg.getBaseUrl(), OFFICIAL_BASE)
  // 残留键本身还在（清理由 configMigration 一次性做，见 config-migration.test.mjs），
  // 但读取侧已经不认它了：这就是「用户不用手工删 localStorage」的第一道保证。
  assert.equal(store.get('chat-demo:model'), RESIDUE, '读取侧不改写存储')
})

test('① 官方渠道 + 共享键残留（base-url 就是官方默认地址）→ 仍是 deepseek-flash', () => {
  seed({
    'chat-demo:provider-kind': 'deepseek',
    'chat-demo:model': RESIDUE,
    'chat-demo:base-url': OFFICIAL_BASE,
  })
  assert.equal(
    cfg.getModel(),
    OFFICIAL_MODEL,
    '地址已经是官方默认 = 没在用中转，此时共享模型一定是残留'
  )
})

test('② 老中转仍在用（共享 base-url 非官方）→ 旧模型继续生效', () => {
  seed({
    'chat-demo:provider-kind': 'deepseek',
    'chat-demo:model': 'legacy-relay-model',
    'chat-demo:base-url': RELAY,
  })
  assert.equal(cfg.getBaseUrl(), RELAY, '老中转地址不受本次改动影响')
  assert.equal(cfg.getModel(), 'legacy-relay-model', '地址还在用中转时，模型是同一套配置，必须保留')
})

test('② 老中转已下线主机 → 地址被丢弃，模型也随之不再生效（#181 + #339）', () => {
  const deadHost = [...legacyHosts][0]
  assert.ok(deadHost, 'config/endpoints.json 里要登记已下线主机')
  seed({
    'chat-demo:provider-kind': 'deepseek',
    'chat-demo:model': RESIDUE,
    'chat-demo:base-url': `http://${deadHost}:60010`,
  })
  assert.equal(cfg.getBaseUrl(), OFFICIAL_BASE, '已下线主机在读取时被丢掉（#181）')
  assert.equal(cfg.getModel(), OFFICIAL_MODEL, '地址回到官方后，残留模型不再参与')
})

test('③ 共享键为空 → 官方默认值（负向：行为不变）', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek', 'chat-demo:model': '   ' })
  assert.equal(cfg.getModel(), OFFICIAL_MODEL, '空串 / 空白一律回落 spec.defaults')
})

test('③ 用户可编辑模型的渠道：自定义模型仍然生效（anthropic / openai）', () => {
  seed({
    'chat-demo:provider-kind': 'anthropic',
    'chat-demo:model:anthropic': 'claude-relay-model',
    'chat-demo:model': RESIDUE,
  })
  assert.equal(cfg.getModel(), 'claude-relay-model', 'anthropic 读自己的 scoped 键')

  seed({
    'chat-demo:provider-kind': 'openai',
    'chat-demo:model:openai': 'gpt-relay-model',
    'chat-demo:model': RESIDUE,
  })
  assert.equal(cfg.getModel(), 'gpt-relay-model', 'openai 读自己的 scoped 键')
})

test('④ locked 渠道（ours）→ 只认 spec.defaults，共享键不参与', () => {
  const ours = specOf('ours')
  seed({ 'chat-demo:provider-kind': 'ours', 'chat-demo:model': RESIDUE })
  assert.equal(cfg.getModel(), ours.defaults.model, 'ours 恒为内置模型')
  seed({
    'chat-demo:provider-kind': 'ours',
    'chat-demo:model': RESIDUE,
    'chat-demo:base-url': RELAY,
  })
  assert.equal(cfg.getModel(), ours.defaults.model, '即便共享地址还在，locked 渠道也不读共享模型')
})

test('四渠道模型解析表：deepseek / ours / anthropic / openai 各一条', () => {
  const table = [
    ['deepseek', { 'chat-demo:model': RESIDUE }, OFFICIAL_MODEL],
    ['ours', { 'chat-demo:model': RESIDUE }, specOf('ours').defaults.model],
    ['anthropic', { 'chat-demo:model:anthropic': 'claude-x' }, 'claude-x'],
    ['openai', { 'chat-demo:model:openai': 'gpt-x' }, 'gpt-x'],
  ]
  for (const [kind, entries, expected] of table) {
    seed({ 'chat-demo:provider-kind': kind, ...entries })
    assert.equal(cfg.getModel(), expected, `${kind} 的模型解析不对`)
  }
})

test('setModel 仍然拒写内置渠道（不可改的契约没被打开）', () => {
  seed({ 'chat-demo:provider-kind': 'deepseek' })
  assert.equal(cfg.setModel('deepseek-v4-pro'), false, '官方渠道不接受写入')
  assert.equal(store.has('chat-demo:model:deepseek'), false, '也不该写出 scoped 键')
  assert.equal(cfg.getModel(), OFFICIAL_MODEL)
})
