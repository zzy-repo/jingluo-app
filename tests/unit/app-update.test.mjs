// [layer: unit | dependencies: none | no build, browser, network or Android]
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})
const { parseManifest, selectUpdate, releaseUrl, loadManifest } =
  await import('../../src/services/updateManifest.ts')
const { downloadUpdate } = await import('../../src/services/appUpdate.ts')
const row = (extra = {}) => ({
  version: '1.5.0',
  versionCode: 12,
  size: 1234,
  file: 'apk/deepseek-chat-1.5.0.apk',
  changes: ['优化体验'],
  buildType: 'stable',
  artifactVariant: 'internal',
  sha256: 'a'.repeat(64),
  ...extra,
})
const rows = (...items) => parseManifest({ latest: 'irrelevant', releases: items })
test('strict code ordering, variant isolation, stable/prerelease are independent of variants', () => {
  assert.equal(selectUpdate(rows(row()), 11, 'internal', 'stable').release.versionCode, 12)
  assert.equal(selectUpdate(rows(row()), 12, 'internal', 'stable').release, undefined)
  assert.equal(selectUpdate(rows(row()), 13, 'internal', 'stable').release, undefined)
  assert.equal(selectUpdate(rows(row()), 11, 'standard', 'stable').release, undefined)
  const prerelease = row({ buildType: 'prerelease', version: '0.1-beta.1', versionCode: 13 })
  assert.equal(selectUpdate(rows(prerelease), 11, 'internal', 'stable').release, undefined)
  assert.equal(
    selectUpdate(rows(prerelease, row()), 11, 'internal', 'prerelease').release.versionCode,
    13
  )
})
test('legacy rows are visible but not eligible; no MD5 fallback', () => {
  const legacy = row({ artifactVariant: undefined, sha256: undefined, md5: 'b'.repeat(32) })
  const parsed = rows(legacy)
  assert.equal(parsed.length, 1)
  assert.deepEqual(selectUpdate(parsed, 11, 'internal', 'prerelease'), {
    release: undefined,
    incomplete: 1,
  })
  assert.equal(
    selectUpdate(rows(row({ sha256: undefined })), 11, 'internal', 'stable').release,
    undefined
  )
  assert.equal(rows(row({ buildType: undefined }))[0].buildType, undefined)
  assert.equal(
    selectUpdate(rows(row({ buildType: undefined })), 11, 'internal', 'prerelease').release,
    undefined
  )
  for (const extra of [
    { artifactVariant: 'unknown' },
    { sha256: 'BAD' },
    { sha256: 'A'.repeat(64) },
  ]) {
    assert.equal(selectUpdate(rows(row(extra)), 11, 'internal', 'stable').release, undefined)
  }
})
test('malformed records and ambiguous maximum code fail closed', () => {
  for (const value of [null, {}, { releases: 'bad' }]) assert.throws(() => parseManifest(value))
  for (const extra of [
    { size: -1 },
    { versionCode: 12.1 },
    { changes: [null] },
    { buildType: 'internal' },
  ]) {
    assert.throws(() => rows(row(extra)))
  }
  assert.throws(() => selectUpdate(rows(row(), row()), 11, 'internal', 'stable'))
})
test('relative APK path only: no credentials, traversal, absolute URLs, queries or encodings', () => {
  assert.equal(releaseUrl(row().file), 'https://dl.rose7.cn/apk/deepseek-chat-1.5.0.apk')
  for (const file of [
    'https://evil.test/a.apk',
    'https://dl.rose7.cn/apk/a.apk',
    '//evil.test/a.apk',
    '/apk/a.apk',
    'apk/../a.apk',
    'apk/%2e%2e/a.apk',
    'apk/a.apk?token=x',
    'apk/a.apk#x',
    'apk/a\\b.apk',
  ]) {
    assert.throws(() => releaseUrl(file), file)
  }
})
test('manifest fetch is anonymous, nonredirecting, cancellable and injectable', async () => {
  let options
  const signal = new AbortController().signal
  const result = await loadManifest(signal, async (url, init) => {
    assert.equal(url, 'https://dl.rose7.cn/releases.json')
    options = init
    return new Response(JSON.stringify({ releases: [row()] }))
  })
  assert.equal(result.length, 1)
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers, undefined)
  assert.equal(options.signal, signal)
  await assert.rejects(loadManifest(signal, async () => new Response('', { status: 503 })))
  await assert.rejects(loadManifest(signal, async () => new Response('{bad')))
})
const mock = (run) => {
  const state = { listener: null, removed: 0, cancelled: 0 }
  const bridge = {
    async addListener(name, callback) {
      assert.equal(name, 'downloadProgress')
      state.listener = callback
      return {
        async remove() {
          state.removed++
        },
      }
    },
    async download(options) {
      return run(options, state)
    },
    async cancel() {
      state.cancelled++
    },
  }
  return { state, bridge }
}
test('cached/downloaded results, progress filtering and listener cleanup', async () => {
  for (const cached of [false, true]) {
    const events = []
    const { bridge, state } = mock(async (options, state) => {
      assert.equal(options.sha256, row().sha256)
      assert.equal(options.versionCode, 12)
      assert.equal(options.headers, undefined)
      state.listener({ id: 'stale', received: 5, total: 10 })
      state.listener({ id: options.id, received: 10, total: 10 })
      return { cached }
    })
    assert.deepEqual(
      await downloadUpdate(row(), new AbortController().signal, (e) => events.push(e), bridge),
      { cached }
    )
    assert.equal(events.length, 1)
    assert.equal(state.removed, 1)
  }
})
test('cancel actively reaches bridge and ignores late completion/progress', async () => {
  const controller = new AbortController()
  const events = []
  const { state, bridge } = mock(async (options, state) => {
    controller.abort()
    state.listener({ id: options.id, received: 10, total: 10 })
    return { cached: false }
  })
  await assert.rejects(
    downloadUpdate(row(), controller.signal, (e) => events.push(e), bridge),
    { name: 'AbortError' }
  )
  assert.equal(state.cancelled, 1)
  assert.equal(state.removed, 1)
  assert.equal(events.length, 0)
})
test('hash/package/signature/network failures propagate and release listener', async () => {
  for (const code of [
    'HASH_MISMATCH',
    'SIZE_MISMATCH',
    'PACKAGE_MISMATCH',
    'SIGNATURE_MISMATCH',
    'VERSION_MISMATCH',
    'VARIANT_MISMATCH',
    'DOWNLOAD_HTTP',
  ]) {
    const { state, bridge } = mock(async () => {
      throw new Error(code)
    })
    await assert.rejects(
      downloadUpdate(row(), new AbortController().signal, () => {}, bridge),
      { message: code }
    )
    assert.equal(state.removed, 1)
  }
})
