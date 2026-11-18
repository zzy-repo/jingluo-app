import assert from 'node:assert/strict'
import test from 'node:test'

test('model response parser handles object and string entries', async () => {
  const source = await import('../../src/services/api/client.ts')
  assert.deepEqual(source.pickModelIds({ data: [{ id: 'a' }, { name: 'b' }, { model: 'c' }] }), ['a', 'b', 'c'])
  assert.deepEqual(source.pickModelIds({ models: ['x', 'y'] }), ['x', 'y'])
  assert.deepEqual(source.pickModelIds({ data: [] }), [])
  assert.deepEqual(source.pickModelIds({ data: [{ nope: 1 }] }), [])
})
