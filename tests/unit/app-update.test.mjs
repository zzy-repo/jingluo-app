// [layer: unit | dependencies: none | no build, browser, network or Android]
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
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
const {
  parseManifest,
  selectUpdate,
  releaseUrl,
  loadManifest,
  fetchManifest,
  RELEASE_BASES,
  PRIMARY_RELEASE_BASE,
  FALLBACK_RELEASE_BASE,
} = await import('../../src/services/updateManifest.ts')
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
  assert.equal(releaseUrl(row().file), `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.5.0.apk`)
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
test('相对 file 拼在生效 base 上：新机与旧机各拼各的，第三方 base 直接拒绝', () => {
  assert.equal(
    releaseUrl(row().file, FALLBACK_RELEASE_BASE),
    `${FALLBACK_RELEASE_BASE}/apk/deepseek-chat-1.5.0.apk`
  )
  assert.equal(
    releaseUrl(row().file, PRIMARY_RELEASE_BASE),
    `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.5.0.apk`
  )
  for (const base of [
    'https://evil.test',
    'http://62.106.70.167:9999',
    'http://62.106.70.167:8888/',
    'https://dl.rose7.cn/apk',
    '',
  ]) {
    assert.throws(() => releaseUrl(row().file, base), base)
  }
})
test('manifest fetch is anonymous, nonredirecting, cancellable and injectable', async () => {
  let options
  const seen = []
  const signal = new AbortController().signal
  const result = await loadManifest(signal, async (url, init) => {
    seen.push(url)
    options = init
    return new Response(JSON.stringify({ releases: [row()] }))
  })
  assert.deepEqual(seen, [`${PRIMARY_RELEASE_BASE}/releases.json`], '首选新机，成功就不再回退')
  assert.equal(result.length, 1)
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers, undefined)
  assert.equal(options.signal, signal)
  await assert.rejects(loadManifest(signal, async () => new Response('', { status: 503 })))
  const invalid = []
  await assert.rejects(
    loadManifest(signal, async (url) => {
      invalid.push(url)
      return new Response('{bad')
    })
  )
  assert.deepEqual(
    invalid,
    [`${PRIMARY_RELEASE_BASE}/releases.json`, `${FALLBACK_RELEASE_BASE}/releases.json`],
    '200 但清单不合法时也要试下一台（Issue #330：新机脏、旧机好时不能把可用清单丢掉）'
  )
})
test('首选新机不可达时按固定顺序回退旧机，并回传生效 base', async () => {
  assert.deepEqual(RELEASE_BASES, [PRIMARY_RELEASE_BASE, FALLBACK_RELEASE_BASE], '顺序写死：先新后旧')
  // 地址只有 config/endpoints.json 一个来源（#269）：这里跟着配置走，不再抄第二份字面量
  const dlConfig = JSON.parse(readFileSync(new URL('../../config/endpoints.json', import.meta.url), 'utf8'))
  assert.equal(PRIMARY_RELEASE_BASE, dlConfig.download.primaryBase, '首选地址 = download.primaryBase')
  assert.equal(FALLBACK_RELEASE_BASE, dlConfig.download.fallbackBase, '回退地址 = download.fallbackBase')
  const seen = []
  const { rows: parsed, base } = await fetchManifest(new AbortController().signal, async (url) => {
    seen.push(url)
    if (url.startsWith(PRIMARY_RELEASE_BASE)) {
      throw new TypeError('fetch failed')
    }
    return new Response(JSON.stringify({ releases: [row()] }))
  })
  assert.deepEqual(seen, [
    `${PRIMARY_RELEASE_BASE}/releases.json`,
    `${FALLBACK_RELEASE_BASE}/releases.json`,
  ])
  assert.equal(base, FALLBACK_RELEASE_BASE, 'file 必须拼在回退生效的 base 上')
  assert.equal(parsed.length, 1)
  // 两台都挂 → 报错，不许静默成功
  await assert.rejects(
    loadManifest(new AbortController().signal, async () => {
      throw new TypeError('fetch failed')
    })
  )
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
test('下载地址用的是本次清单生效的 base（回退后不会拿新机域名拼）', async () => {
  const ids = []
  const { bridge } = mock(async (options) => {
    ids.push(options.url)
    return { cached: false }
  })
  await downloadUpdate(
    row(),
    new AbortController().signal,
    () => {},
    bridge,
    FALLBACK_RELEASE_BASE
  )
  await downloadUpdate(row(), new AbortController().signal, () => {}, bridge)
  assert.deepEqual(ids, [
    `${FALLBACK_RELEASE_BASE}/apk/deepseek-chat-1.5.0.apk`,
    `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.5.0.apk`,
  ])
})
test('Java 端地址只来自 BuildConfig：源码零字面量，白名单由 base 派生（#269）', async () => {
  const { readFile } = await import('node:fs/promises')
  const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
  const JAVA = 'android/app/src/main/java/com/example/deepseekchat'
  const endpoint = await read(`${JAVA}/UpdateEndpoint.java`)
  const plugin = await read(`${JAVA}/AppUpdatePlugin.java`)
  const junit = await read('android/app/src/test/java/com/example/deepseekchat/UpdateEndpointTest.java')
  const gradle = await read('android/app/build.gradle')
  // 地址不再写在 Java 里：两处 base 都从 BuildConfig 读（= config/endpoints.json 的 download.*）
  assert.match(endpoint, /PRIMARY_BASE = BuildConfig\.DL_PRIMARY/)
  assert.match(endpoint, /FALLBACK_BASE = BuildConfig\.DL_FALLBACK/)
  assert.doesNotMatch(endpoint, /https?:\/\//, 'Java 源码里不许有任何地址字面量（#269 零副本）')
  assert.ok(endpoint.indexOf('PRIMARY_BASE =') < endpoint.indexOf('FALLBACK_BASE ='), '顺序写死：先首选后回退')
  assert.match(endpoint, /MANIFEST_BASES = \{PRIMARY_BASE, FALLBACK_BASE\}/)
  assert.match(endpoint, /return base \+ "\/releases\.json"/)
  // 白名单由 base 派生：主机 / 端口 / 协议不许再存一份副本
  assert.doesNotMatch(endpoint, /PRIMARY_HOST|FALLBACK_HOST/, '主机不许另存一份副本（那正是 #269 要消掉的）')
  assert.match(endpoint, /private static final Base PRIMARY = new Base\(PRIMARY_BASE\)/)
  assert.match(endpoint, /private static final Base FALLBACK = new Base\(FALLBACK_BASE\)/)
  const https = endpoint.slice(endpoint.indexOf('if (https)'), endpoint.indexOf('if ("http".equals(scheme))'))
  assert.match(https, /host\.equals\(FALLBACK\.host\)/)
  assert.match(https, /host\.equals\(PRIMARY\.host\)/)
  const http = endpoint.slice(endpoint.indexOf('if ("http".equals(scheme))'))
  assert.match(http, /!PRIMARY\.tls && host\.equals\(PRIMARY\.host\) && port == PRIMARY\.port/)
  assert.doesNotMatch(http, /FALLBACK/, '明文 http 不给回退机')
  // 为什么允许裸 http 必须写在代码里（签名由安装器强制校验）
  assert.match(endpoint, /#269/)
  assert.match(endpoint, /签名/)
  // 插件侧从同一份策略派生：地址、白名单都不再各自硬编码
  assert.match(plugin, /for \(String base : UpdateEndpoint\.MANIFEST_BASES\)/)
  assert.match(plugin, /result\.put\("base", base\)/)
  assert.match(plugin, /UpdateEndpoint\.allowsDownloadUrl\(url\)/)
  assert.doesNotMatch(plugin, /rose7/, '旧地址只许出现在 config/endpoints.json，避免只改一处')
  assert.doesNotMatch(plugin, /getHost\(\)\.equals/)
  // 构建期注入：配置 → buildConfigField → BuildConfig（不开 buildConfig true 会被 AGP 8 静默丢弃）
  assert.match(gradle, /buildConfig true/, '必须显式打开 buildFeatures.buildConfig（AGP 8 默认关）')
  assert.ok(
    gradle.includes('buildConfigField "String", "DL_PRIMARY", "\\"${dlPrimaryBase}\\""'),
    'build.gradle 把 download.primaryBase 落成 BuildConfig.DL_PRIMARY'
  )
  assert.ok(
    gradle.includes('buildConfigField "String", "DL_FALLBACK", "\\"${dlFallbackBase}\\""'),
    'build.gradle 把 download.fallbackBase 落成 BuildConfig.DL_FALLBACK'
  )
  assert.match(gradle, /config\/endpoints\.json/, 'gradle 从配置读，不写死地址')
  assert.doesNotMatch(gradle, /62\.106\.70\.167|rose7/, 'build.gradle 里不许有地址字面量')
  // Java 单测覆盖的判定类别（地址一律从 BuildConfig / base 派生，测试里不抄配置）
  for (const name of [
    'allowsFallbackHostHttps',
    'allowsPrimaryHostHttps',
    'allowsPlainHttpOnlyOnPrimary',
    'rejectsThirdPartyHosts',
    'configuredBasesAreWellFormed',
  ]) {
    assert.ok(junit.includes(name), name)
  }
})
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
