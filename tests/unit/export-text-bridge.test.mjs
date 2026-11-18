// [layer: unit | common native facade with injected Capacitor plugin; no device]
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@capacitor/core') return { url: 'data:text/javascript,export const Capacitor = {isNativePlatform:()=>true}; export const registerPlugin = ()=>globalThis.__exportBridge;', shortCircuit: true }
  return nextResolve(specifier, context)
} })
const calls = []
let mode = 'saved'
globalThis.__exportBridge = {
  start: async options => { calls.push(['start', options]); if (mode === 'cancel-start') return { status: 'cancelled' }; if (mode === 'cancel-legacy') throw Object.assign(new Error('cancel'), { code: 'CANCELLED' }); return { id: 'job' } },
  writeChunk: async options => { calls.push(['chunk', options]); if (mode === 'write-failed') throw new Error('disk full') },
  finish: async () => { calls.push(['finish']); return { status: 'saved' } },
  abort: async () => { calls.push(['abort']) },
}
const { saveText } = await import('../../src/services/exportText.ts')
test('SAF start cancellation is not saved and sends no body or finish', async () => {
  for (mode of ['cancel-start', 'cancel-legacy']) {
    calls.length = 0
    assert.equal(await saveText({ filename: 'logs.json', mimeType: 'application/json', text: 'private' }), 'cancelled')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1].mimeType, 'application/json')
  }
})
test('chunk writes respect 48KiB UTF8 and reconstruct the exact JSON text', async () => {
  mode = 'saved'; calls.length = 0
  const text = JSON.stringify({ logs: ['中文😀'.repeat(50000)] })
  assert.equal(await saveText({ filename: 'logs.json', mimeType: 'application/json', text }), 'saved')
  const chunks = calls.filter(([kind]) => kind === 'chunk').map(([, options]) => options.data)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 48 * 1024))
})
test('legacy WebView without TextEncoder still chunks and saves', async () => {
  mode = 'saved'; calls.length = 0
  const original = globalThis.TextEncoder
  // The implementation intentionally uses code-point UTF8 sizing, not TextEncoder.
  globalThis.TextEncoder = undefined
  try {
    assert.equal(await saveText({ filename: 'logs.json', mimeType: 'application/json', text: '中文😀' }), 'saved')
  } finally { globalThis.TextEncoder = original }
})
test('write failure aborts, propagates, and never returns saved', async () => {
  mode = 'write-failed'; calls.length = 0
  await assert.rejects(saveText({ filename: 'logs.json', mimeType: 'application/json', text: '{}' }), /disk full/)
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'chunk', 'abort'])
})
