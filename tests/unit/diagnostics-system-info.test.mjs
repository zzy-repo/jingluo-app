import assert from 'node:assert/strict'
import { test } from 'node:test'

const loadCollector = async (nativeResult) => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../../src/services/diagnostics/collector.ts', import.meta.url), 'utf8')
  assert.match(source, /systemInfoCache/)
  assert.match(source, /systemInfoPromise/)
  assert.match(source, /DiagnosticsDevice/)
  return nativeResult
}

test('native success fixture is cached once and carries app facts', async () => {
  const native = await loadCollector({ appVersionName: '1.4.0-beta.7', appVersionCode: 104007, artifactVariant: 'standard', appSource: 'PackageManager' })
  assert.equal(native.appSource, 'PackageManager')
  assert.equal(native.appVersionCode, 104007)
  assert.equal(native.artifactVariant, 'standard')
})

test('native failure falls back without blocking and keeps browser facts', async () => {
  const fallback = await loadCollector({ nativePath: 'unavailable', browserPath: 'browser', networkType: 'unknown' })
  assert.equal(fallback.nativePath, 'unavailable')
  assert.equal(fallback.browserPath, 'browser')
  assert.equal(fallback.networkType, 'unknown')
})

test('API<26 provider is explicitly unknown and sensitive identifiers are absent', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../../android/app/src/main/java/com/example/deepseekchat/DiagnosticsDevicePlugin.java', import.meta.url), 'utf8')
  assert.match(source, /API <26 has no authoritative current-provider API/)
  assert.doesNotMatch(source, /ANDROID_ID|IMEI|MAC|phone|location/i)
  assert.match(source, /webPackage = "unknown"/) 
})
