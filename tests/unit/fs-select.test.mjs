// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 被测对象：src/services/fs/index.ts 的 getFs() 选择逻辑与 unsupported 实现（规范 §3/§4）。
// 选择依赖探测结果；不支持时抛 kind:'unsupported'，且生产路径绝不返回 memoryFs / 不降级到内存。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve({ stubs: { '@capacitor/core': 'data:text/javascript,export const registerPlugin=(name)=>({__plugin:name})' } })
const { getFs, setFsForTests } = await loadTsModule('src/services/fs/index.ts')
const { createMemoryFs } = await loadTsModule('src/services/fs/memoryFs.ts')
const { resetProbeCache } = await loadTsModule('src/services/capability/probe.ts')
const { resetCapabilityCache } = await loadTsModule('src/utils/capabilities.ts')

const host = ({ native, plugins = [] }) => {
  globalThis.Capacitor = { isNativePlatform: () => native, isPluginAvailable: (name) => plugins.includes(name) }
}

beforeEach(() => {
  setFsForTests(undefined)
  resetProbeCache()
  resetCapabilityCache()
})

test('Web：supported=false，所有 I/O 抛 unsupported，freeBytes 为 undefined，没有写入降级', async () => {
  host({ native: false })
  const fs = getFs()
  assert.equal(fs.supported, false)
  for (const run of [
    () => fs.writeAtomic('a.txt', 'x'),
    () => fs.read('a.txt'),
    () => fs.readText('a.txt'),
    () => fs.list('d'),
    () => fs.remove('a.txt'),
  ]) {
    await assert.rejects(run, (error) => error.name === 'FsError' && error.kind === 'unsupported')
  }
  assert.equal(await fs.freeBytes(), undefined)
  // 即便「写」之后立刻「读」，也不能读回内容：证明没有内存降级
  await fs.writeAtomic('a.txt', 'x').catch(() => {})
  await assert.rejects(() => fs.read('a.txt'), (error) => error.kind === 'unsupported')
})

test('不支持的宿主上路径错误仍是 FsPathError（调用方 bug 不被 unsupported 掩盖）', async () => {
  host({ native: false })
  await assert.rejects(() => getFs().read('../x'), (error) => error.name === 'FsPathError')
})

test('原生壳但插件未注册：supported=false', () => {
  host({ native: true, plugins: [] })
  assert.equal(getFs().supported, false)
})

test('原生壳且插件已注册：选原生实现（supported=true）', () => {
  host({ native: true, plugins: ['AppFileSystem'] })
  assert.equal(getFs().supported, true)
})

test('原生实现：capabilities() 缺方法 → unsupported；ping 失败 → unavailable 且不缓存', async () => {
  host({ native: true, plugins: ['AppFileSystem'] })
  const { createNativeFs, REQUIRED_METHODS } = await loadTsModule('src/services/fs/native/nativeFs.ts')
  const calls = []
  let pingFails = true
  const bridge = {
    capabilities: async () => ({ methods: [...REQUIRED_METHODS] }),
    ping: async () => {
      if (pingFails) {
        throw new Error('dir not writable')
      }
    },
    read: async () => ({ exists: false }),
    list: async () => ({ entries: [] }),
    writeAtomic: async (options) => { calls.push(options) },
    remove: async () => {},
    freeBytes: async () => ({ bytes: 1234 }),
  }
  const fs = createNativeFs(bridge)
  await assert.rejects(() => fs.read('a'), (error) => error.kind === 'unavailable')
  pingFails = false
  assert.equal(await fs.read('a'), undefined)
  assert.equal(await fs.freeBytes(), 1234)

  const missing = createNativeFs({ ...bridge, capabilities: async () => ({ methods: ['read'] }) })
  await assert.rejects(() => missing.read('a'), (error) => error.kind === 'unsupported')
})

test('原生实现：base64 往返与 reject code → kind（QUOTA → quota）', async () => {
  host({ native: true, plugins: ['AppFileSystem'] })
  const { createNativeFs, REQUIRED_METHODS } = await loadTsModule('src/services/fs/native/nativeFs.ts')
  const store = new Map()
  let failWith
  const bridge = {
    capabilities: async () => ({ methods: [...REQUIRED_METHODS] }),
    ping: async () => {},
    writeAtomic: async ({ path, data }) => {
      if (failWith) {
        throw Object.assign(new Error('no space left on device'), { code: failWith })
      }
      store.set(path, data)
    },
    read: async ({ path }) => (store.has(path) ? { exists: true, data: store.get(path) } : { exists: false }),
    list: async () => ({ entries: [] }),
    remove: async () => {},
    freeBytes: async () => ({}),
  }
  const fs = createNativeFs(bridge)
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  await fs.writeAtomic('b.bin', bytes)
  assert.deepEqual([...(await fs.read('b.bin'))], [...bytes])
  await fs.writeAtomic('t.txt', '你好')
  assert.equal(await fs.readText('t.txt'), '你好')
  assert.equal(await fs.freeBytes(), undefined)
  failWith = 'QUOTA'
  await assert.rejects(() => fs.writeAtomic('c', 'x'), (error) => error.kind === 'quota')
})

test('setFsForTests 注入 memoryFs 后 getFs() 返回它；清空后恢复探测', async () => {
  host({ native: false })
  const memory = createMemoryFs()
  setFsForTests(memory)
  assert.equal(getFs(), memory)
  setFsForTests(undefined)
  assert.equal(getFs().supported, false)
})
