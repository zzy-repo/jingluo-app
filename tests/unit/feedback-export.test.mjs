// [layer: unit | real export source + injected snapshot/save mocks, zero network]
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@capacitor/core') return { url: 'data:text/javascript,export const Capacitor = {}; export const CapacitorHttp = {};', shortCircuit: true }
  try { return nextResolve(specifier, context) } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context)
    throw error
  }
} })
const { buildFeedbackExport, prepareFeedbackExport, saveFeedbackExport, MAX_EXPORT_BYTES } = await import('../../src/services/diagnostics/export.ts')
const snapshot = (logs = []) => ({ schemaVersion: 1,
  app: { version: '1.4.0-beta.6', versionCode: 104006, platform: 'android', buildType: 'standard' },
  device: { model: 'Pixel', androidVersion: '15', webviewVersion: '130', screen: '393x851', locale: 'zh-CN', system: { appVersionName: '1.4.0-beta.7', appVersionCode: 104007, artifactVariant: 'standard', appSource: 'PackageManager', androidSdk: 35, androidRelease: '15', manufacturer: 'fixture', brand: 'fixture', webviewPackage: 'com.google.android.webview', webviewVersion: '130.0', online: true, capabilities: { toSorted: true, hasOwn: true, at: true, visualViewport: true, dvh: true }, nativePath: 'DiagnosticsDevice', browserPath: 'browser' } },
  client: { clientId: 'private-client', sessionId: 'private-session' }, logs,
  feedback: { contact: 'private@example.org', description: 'private-description' }, screenshot: 'private-image',
})
const context = { category: 'bug', failure: { code: 'network', at: 123 } }
const entry = (msg, meta) => ({ t: 1, kind: 'error', level: 'error', msg, ...(meta ? { meta } : {}) })
test('offline/empty export retains metadata and failure, never calls network', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('network forbidden') }
  try {
    const file = buildFeedbackExport(snapshot(), context, { now: new Date('2026-11-18T04:00:00Z') })
    const data = JSON.parse(file.text)
    assert.deepEqual(data.logs, [])
    assert.equal(data.app.version, '1.4.0-beta.6')
    assert.equal(data.device.system.webviewPackage, 'com.google.android.webview')
    assert.equal(data.device.system.capabilities.dvh, true)
    assert.deepEqual(data.lastSubmissionFailure, context.failure)
    assert.equal(data.delivery, 'local-only-not-submitted')
    assert.match(file.filename, /2026-11-18.*v1\.4\.0-beta\.6\.json$/)
    for (const secret of ['private-client', 'private-session', 'private@example.org', 'private-description', 'private-image']) assert.ok(!file.text.includes(secret))
  } finally { globalThis.fetch = oldFetch }
})
test('second-boundary redaction covers keys/tokens/signed URLs/chat/payment/console', () => {
  const file = buildFeedbackExport(snapshot([
    entry('failed sk-abcdefghijklmnop1234567890 Bearer BEARER_SECRET token=TOKEN_SECRET https://host/a?X-Amz-Signature=SIGNED_SECRET#FRAGMENT', {
      apiKey: 'META_SECRET', 'error.msg': 'access_token=ERR_SECRET', content: 'CHAT_SECRET', payment: 'PAYMENT_SECRET', 'http.status': 503,
    }),
    entry('{"messages":[{"content":"BODY_SECRET"}]}'),
    entry('{"receipt":"RECEIPT_SECRET"}'),
    entry('CONSOLE_SECRET', { stage: 'console' }),
  ]), context)
  for (const value of ['abcdefghijklmnop1234567890', 'BEARER_SECRET', 'TOKEN_SECRET', 'SIGNED_SECRET', 'FRAGMENT', 'META_SECRET', 'ERR_SECRET', 'CHAT_SECRET', 'PAYMENT_SECRET', 'BODY_SECRET', 'RECEIPT_SECRET', 'CONSOLE_SECRET']) assert.ok(!file.text.includes(value), value)
  assert.equal(JSON.parse(file.text).logs[0].meta['http.status'], 503)
})
test('does not reuse upload clipping; 500 full collector-size logs survive under 4MiB', () => {
  const logs = Array.from({ length: 500 }, (_, t) => ({ ...entry('中'.repeat(2000)), t }))
  const input = snapshot(logs)
  const file = buildFeedbackExport(input, context)
  assert.ok(Buffer.byteLength(file.text) > 180 * 1024)
  assert.ok(Buffer.byteLength(file.text) <= MAX_EXPORT_BYTES)
  assert.equal(JSON.parse(file.text).logs.length, 500)
  assert.equal(file.truncated, false)
  assert.equal(input.logs.length, 500)
})
test('oversize exports have valid JSON, marked omissions and an exact UTF8 boundary', () => {
  const logs = Array.from({ length: 100 }, (_, t) => ({ ...entry('😀'.repeat(1000)), t }))
  const input = snapshot(logs)
  const file = buildFeedbackExport(input, context, { maxBytes: 16384 })
  const data = JSON.parse(file.text)
  assert.ok(Buffer.byteLength(file.text) <= 16384)
  assert.ok(data.limits.truncated)
  assert.equal(data.limits.omittedLogCount + data.logs.length, 100)
  assert.equal(data.logs.at(-1).t, 99)
  assert.equal(input.logs.length, 100)
})
test('snapshot read failure exports last visible snapshot without mutating logs', () => {
  const input = snapshot([entry('retained')])
  const file = prepareFeedbackExport(input, context, () => { throw new Error('read failed') })
  assert.equal(file.snapshotReadFailed, true)
  assert.match(file.text, /retained/)
  assert.equal(input.logs.length, 1)
})
test('save success/cancellation/failure remain distinct and retain diagnostics/form', async () => {
  const input = snapshot([entry('retained')])
  const before = structuredClone(input)
  for (const outcome of ['saved', 'cancelled', 'failed']) {
    const result = await saveFeedbackExport(input, context, async (file) => {
      assert.equal(file.mimeType, 'application/json')
      assert.equal(JSON.parse(file.text).delivery, 'local-only-not-submitted')
      if (outcome === 'failed') throw new Error('disk full')
      return outcome
    }, () => input)
    assert.equal(result.status, outcome)
    assert.deepEqual(input, before)
  }
})
