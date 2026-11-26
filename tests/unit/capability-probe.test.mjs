// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 被测对象：src/services/capability/probe.ts 的 probeNativePlugin（客户端基础设施规范 §3）。
// 宿主用 globalThis.Capacitor 替身控制（utils/capabilities.ts 读的就是它），探测逻辑原样运行。
// 故障注入：宿主非原生 / 插件未注册 / 方法缺失 / 权限被拒 / ping 失败；
// 缓存口径：结论性（not-native、plugin-unregistered）缓存，runtime-failed 不缓存（含负向对照）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()
const { probeNativePlugin, resetProbeCache, infraErrorOfProbe } = await loadTsModule('src/services/capability/probe.ts')
const { resetCapabilityCache } = await loadTsModule('src/utils/capabilities.ts')
const { InfraError, infraKindOfRejection } = await loadTsModule('src/services/capability/errors.ts')

const NAME = 'Probe'
const host = ({ native = true, plugins = [NAME] } = {}) => {
  globalThis.Capacitor = {
    isNativePlatform: () => native,
    isPluginAvailable: (name) => plugins.includes(name),
  }
}

beforeEach(() => {
  resetProbeCache()
  resetCapabilityCache()
  host()
})

test('全部通过 → available', async () => {
  const bridge = {
    capabilities: async () => ({ methods: ['a', 'b'] }),
    checkPermissions: async () => ({ storage: 'granted' }),
  }
  assert.deepEqual(await probeNativePlugin(NAME, { bridge, methods: ['a'], ping: async () => {} }), { available: true })
})

test('非原生宿主 → not-native，且不碰桥', async () => {
  host({ native: false })
  let touched = false
  const bridge = { capabilities: async () => { touched = true; return { methods: [] } } }
  const result = await probeNativePlugin(NAME, { bridge, methods: ['a'] })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'not-native')
  assert.equal(touched, false)
})

test('插件未注册 → plugin-unregistered', async () => {
  host({ plugins: [] })
  const result = await probeNativePlugin(NAME, { methods: ['a'] })
  assert.equal(result.reason, 'plugin-unregistered')
})

test('方法缺失 → method-missing 并点名缺的方法', async () => {
  const bridge = { capabilities: async () => ({ methods: ['a'] }) }
  const result = await probeNativePlugin(NAME, { bridge, methods: ['a', 'writeAtomic'] })
  assert.equal(result.reason, 'method-missing')
  assert.equal(result.detail, 'writeAtomic')
})

test('要求方法但插件没有 capabilities() / capabilities() 抛错 → method-missing', async () => {
  assert.equal((await probeNativePlugin(NAME, { bridge: {}, methods: ['a'] })).reason, 'method-missing')
  const broken = { capabilities: async () => { throw new Error('UNIMPLEMENTED') } }
  assert.equal((await probeNativePlugin(NAME, { bridge: broken, methods: ['a'] })).reason, 'method-missing')
})

test('权限被拒 → permission-denied；没有 checkPermissions 就不查', async () => {
  const bridge = { checkPermissions: async () => ({ storage: 'denied' }) }
  const denied = await probeNativePlugin(NAME, { bridge })
  assert.equal(denied.reason, 'permission-denied')
  assert.equal(denied.detail, 'storage')
  assert.deepEqual(await probeNativePlugin(NAME, { bridge: {} }), { available: true })
})

test('ping 失败 → runtime-failed（带原因）', async () => {
  const result = await probeNativePlugin(NAME, { ping: async () => { throw new Error('read-only dir') } })
  assert.equal(result.reason, 'runtime-failed')
  assert.match(result.detail, /read-only dir/u)
})

test('结论性结果缓存：not-native 之后宿主变成原生，缓存内仍是 not-native', async () => {
  host({ native: false })
  assert.equal((await probeNativePlugin(NAME)).reason, 'not-native')
  host({ native: true })
  assert.equal((await probeNativePlugin(NAME)).reason, 'not-native')
  resetProbeCache()
  resetCapabilityCache()
  assert.deepEqual(await probeNativePlugin(NAME), { available: true })
})

test('runtime-failed 不缓存：第一次 ping 失败、第二次恢复，第二次必须通过', async () => {
  let calls = 0
  const ping = async () => {
    calls += 1
    if (calls === 1) {
      throw new Error('transient')
    }
  }
  assert.equal((await probeNativePlugin(NAME, { ping })).reason, 'runtime-failed')
  assert.deepEqual(await probeNativePlugin(NAME, { ping }), { available: true })
  assert.equal(calls, 2)
})

test('负向对照：成功结果同样不缓存（ping 之后变坏，立即被发现）', async () => {
  let healthy = true
  const ping = async () => {
    if (!healthy) {
      throw new Error('disk gone')
    }
  }
  assert.deepEqual(await probeNativePlugin(NAME, { ping }), { available: true })
  healthy = false
  assert.equal((await probeNativePlugin(NAME, { ping })).reason, 'runtime-failed')
})

test('探测失败 → InfraError kind 映射（只有这一份）', () => {
  const kindOf = (reason) => infraErrorOfProbe({ available: false, reason }, 'fs').kind
  assert.equal(kindOf('not-native'), 'unsupported')
  assert.equal(kindOf('plugin-unregistered'), 'unsupported')
  assert.equal(kindOf('method-missing'), 'unsupported')
  assert.equal(kindOf('permission-denied'), 'permission')
  assert.equal(kindOf('runtime-failed'), 'unavailable')
  assert.ok(infraErrorOfProbe({ available: false, reason: 'not-native' }, 'fs') instanceof InfraError)
})

test('插件 reject code → kind', () => {
  assert.equal(infraKindOfRejection({ code: 'QUOTA' }), 'quota')
  assert.equal(infraKindOfRejection({ code: 'PERMISSION' }), 'permission')
  assert.equal(infraKindOfRejection({ code: 'UNAVAILABLE' }), 'unavailable')
  assert.equal(infraKindOfRejection({ code: 'UNIMPLEMENTED' }), 'unsupported')
  assert.equal(infraKindOfRejection({ code: 'IO' }), 'unknown')
  assert.equal(infraKindOfRejection(undefined), 'unknown')
})
