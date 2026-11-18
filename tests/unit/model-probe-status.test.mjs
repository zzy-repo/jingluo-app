import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModelPayload } from '../../src/services/api/modelPayload.ts'

const probe = async (response, timeoutMs = 25) => {
  const timer = new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout', models: [] }), timeoutMs))
  const request = Promise.resolve(response).then((value) => {
    if (value.status < 200 || value.status >= 300) return { ok: false, status: value.status, reason: 'http', models: [] }
    return { ok: true, status: value.status, models: parseModelPayload(value.data) }
  })
  return Promise.race([request, timer])
}

test('mock status and timeout mapping', async () => {
  assert.deepEqual(await probe({ status: 401, data: '{"error":{"message":"no"}}' }), { ok: false, status: 401, reason: 'http', models: [] })
  assert.deepEqual(await probe({ status: 404, data: '{}' }), { ok: false, status: 404, reason: 'http', models: [] })
  assert.deepEqual(await probe({ status: 200, data: '{"data":[{"id":"native-object"}]}' }), { ok: true, status: 200, models: ['native-object'] })
  assert.deepEqual(await probe(new Promise((resolve) => setTimeout(() => resolve({ status: 200, data: '{}' }), 80))), { ok: false, reason: 'timeout', models: [] })
})
