// [layer: unit | 纯 Node + Image/canvas/HTTP mocks；不访问后端、不启动构建]
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// 与打包器相同的 .js -> .ts 解析，直接运行真实 transport 源码。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core')
      return {
        url: 'data:text/javascript,export const Capacitor = { isNativePlatform: () => false }; export const CapacitorHttp = { post: async () => { throw new Error("unmocked native request") } };',
        shortCircuit: true,
      }
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
const { LegacyTransport, buildLegacyRequest } =
  await import('../../src/services/diagnostics/transport.legacy.ts')
const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
const { LEGACY_BODY_MAX_BYTES } = await import('../../src/services/diagnostics/config.ts')
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const payload = (extra = {}) => ({
  schemaVersion: 1,
  app: { version: '1.4.0-beta.4', versionCode: 104004, buildType: 'internal', platform: 'android' },
  device: {
    model: 'synthetic',
    androidVersion: 'test',
    webviewVersion: 'test',
    screen: '1x1',
    locale: 'zh-CN',
  },
  client: { sessionId: 'fixture', clientId: 'fixture' },
  feedback: { description: '人工测试截图', category: 'bug', contact: '' },
  logs: [{ t: 1, level: 'error', kind: 'chat_error', msg: '关键错误' }],
  ...extra,
})
const success = () =>
  new Response(JSON.stringify({ ok: true, id: 'mock-id', images: 1 }), { status: 200 })

test('单图映射与无截图兼容', () => {
  assert.deepEqual(buildLegacyRequest(payload({ screenshot: png })).body.images, [png])
  assert.equal(Object.hasOwn(buildLegacyRequest(payload()).body, 'images'), false)
})

test('中文、emoji、换行与 JSON 转义按整个 UTF-8 body 预算；关键错误保留', () => {
  const logs = Array.from({ length: 500 }, (_, i) => ({
    t: i,
    level: 'info',
    kind: 'nav',
    msg: '中文😀"\\\n'.repeat(70),
  }))
  logs.push({ t: 999, level: 'error', kind: 'chat_error', msg: '关键错误' })
  const result = buildLegacyRequest(payload({ screenshot: png, logs }))
  assert.equal(result.bodyBytes, Buffer.byteLength(JSON.stringify(result.body)))
  assert.ok(result.bodyBytes <= LEGACY_BODY_MAX_BYTES)
  assert.ok(result.build.omitted > 0)
  assert.match(result.body.log, /关键错误/)
  assert.deepEqual(result.body.images, [png])
})

test('413/network/timeout 降级重试保留同一截图和关键错误', async () => {
  const oldFetch = globalThis.fetch
  try {
    for (const mode of ['413', 'network', 'timeout']) {
      const sent = []
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body))
        if (sent.length === 1) {
          if (mode === '413') return new Response('payload too large', { status: 413 })
          throw new Error(mode === 'timeout' ? 'timeout' : 'connection reset')
        }
        return success()
      }
      const result = await new LegacyTransport().send(payload({ screenshot: png }))
      assert.equal(result.ok, true)
      assert.equal(result.retried, true)
      assert.equal(sent.length, 2)
      for (const body of sent) {
        assert.deepEqual(body.images, [png])
        assert.match(body.log, /关键错误/)
        assert.ok(Buffer.byteLength(JSON.stringify(body)) <= LEGACY_BODY_MAX_BYTES)
      }
    }
  } finally {
    globalThis.fetch = oldFetch
  }
})

test('大图有界重压缩，失败或仍超限明确报错且零请求', async () => {
  const old = { fetch: globalThis.fetch, Image: globalThis.Image, document: globalThis.document }
  const big = 'data:image/png;base64,' + 'A'.repeat(300000)
  let requests = 0
  let encodes = 0
  let output = png
  globalThis.Image = class {
    naturalWidth = 4000
    naturalHeight = 3000
    set src(_value) {
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => {
        encodes++
        return output
      },
    }),
  }
  globalThis.fetch = async (_url, init) => {
    requests++
    const body = JSON.parse(init.body)
    assert.deepEqual(body.images, [png])
    return success()
  }
  try {
    assert.equal((await new LegacyTransport().send(payload({ screenshot: big }))).ok, true)
    assert.equal(encodes, 1)
    assert.equal(requests, 1)
    requests = 0
    encodes = 0
    output = big
    const over = await new LegacyTransport().send(payload({ screenshot: big }))
    assert.equal(over.error, 'too_large')
    assert.match(over.detail, /截图未丢弃/)
    assert.equal(encodes, 6)
    assert.equal(requests, 0)
    globalThis.Image = class {
      set src(_value) {
        queueMicrotask(() => this.onerror())
      }
    }
    assert.equal(
      (await new LegacyTransport().send(payload({ screenshot: big }))).error,
      'too_large'
    )
    assert.equal(requests, 0)
  } finally {
    Object.assign(globalThis, old)
  }
})

test('关键错误本身超预算不静默裁掉，也不发超限请求', async () => {
  const oldFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return success()
  }
  try {
    const p = payload({
      logs: Array.from({ length: 500 }, (_, i) => ({
        t: i,
        level: 'error',
        kind: 'chat_error',
        msg: '错'.repeat(200),
      })),
    })
    assert.equal(buildLegacyRequest(p).build.omitted, 0)
    assert.equal((await new LegacyTransport().send(p)).error, 'too_large')
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = oldFetch
  }
})

test('原生 CapacitorHttp 首次与重试沿用 images', async () => {
  const oldNative = Capacitor.isNativePlatform
  const oldPost = CapacitorHttp.post
  const sent = []
  Capacitor.isNativePlatform = () => true
  CapacitorHttp.post = async (options) => {
    sent.push(options.data)
    return sent.length === 1
      ? { status: 413, data: { error: 'payload too large' } }
      : { status: 200, data: { ok: true, id: 'native-mock' } }
  }
  try {
    assert.equal((await new LegacyTransport().send(payload({ screenshot: png }))).ok, true)
    assert.equal(sent.length, 2)
    for (const body of sent) assert.deepEqual(body.images, [png])
  } finally {
    Capacitor.isNativePlatform = oldNative
    CapacitorHttp.post = oldPost
  }
})
