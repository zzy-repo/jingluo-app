import assert from 'node:assert/strict'
import test from 'node:test'

test('model response parser handles object, JSON string, invalid JSON, and empty/status fixtures', async () => {
  const source = await import('../../src/services/api/modelPayload.ts')
  assert.deepEqual(source.pickModelIds({ data: [{ id: 'a' }, { name: 'b' }, { model: 'c' }] }), ['a', 'b', 'c'])
  assert.deepEqual(source.parseModelPayload('{"data":[{"id":"string-model"}]}'), ['string-model'])
  assert.deepEqual(source.parseModelPayload({ data: ['x', 'y'] }), ['x', 'y'])
  assert.deepEqual(source.parseModelPayload('{bad-json'), [])
  assert.deepEqual(source.parseModelPayload({ data: [] }), [])
  assert.deepEqual(source.parseModelPayload({ error: { message: 'unauthorized' } }), [])
})
