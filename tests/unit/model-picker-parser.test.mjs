import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// 与打包器一致：源码内部 .js 说明符实际指向 .ts 文件（否则 import client.ts 会 ERR_MODULE_NOT_FOUND）
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

// 打包期 DefinePlugin 常量，裸 Node 里没有
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false

test('model response parser handles object, JSON string, invalid JSON, and empty/status fixtures', async (t) => {
  let source
  try {
    source = await import('../../src/services/api/client.ts')
  } catch (error) {
    if (String(error?.code) === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      t.skip(`client.ts 依赖链含 TS 参数属性，strip-only 模式不可加载（${error.code}）；用 NODE_OPTIONS=--experimental-transform-types 跑真实路径`)
      return
    }
    throw error
  }
  assert.deepEqual(source.pickModelIds({ data: [{ id: 'a' }, { name: 'b' }, { model: 'c' }] }), ['a', 'b', 'c'])
  assert.deepEqual(source.parseModelPayload('{"data":[{"id":"string-model"}]}'), ['string-model'])
  assert.deepEqual(source.parseModelPayload({ data: ['x', 'y'] }), ['x', 'y'])
  assert.deepEqual(source.parseModelPayload('{bad-json'), [])
  assert.deepEqual(source.parseModelPayload({ data: [] }), [])
  assert.deepEqual(source.parseModelPayload({ error: { message: 'unauthorized' } }), [])
})
