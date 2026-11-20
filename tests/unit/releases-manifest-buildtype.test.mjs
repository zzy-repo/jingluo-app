// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// Issue #330 回归：buildType 只能是 stable|prerelease。
//
// 2026-11-19 的事故是「一条非法 → 整份清单被拒 → 界面只说检查更新失败」，而发布链路
// 三处（发布脚本 / 校验器 / 复核脚本）都没拦住。本用例把四件事钉成断言：
//   1) 校验器对事故清单（12 条、11 条 "release"）必须 FAIL，且逐条报出 11 条；
//   2) 客户端 parseManifest 对非法 buildType 仍抛 INVALID_RELEASE（fail-closed 不许软化）；
//   3) fetchManifest 解析失败也要试下一台 base，并把**首个解析错误**抛出；
//   4) 发布脚本 --build-type release 直接退出 2，且枚举只有 shared/build-types.mjs 一处定义。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 构建期注入值（`__ENDPOINTS__`）的兜底：直接复用 --import 预加载那一份（tests/helpers/injected.mjs）。
// updateManifest.ts 顶层就读 `__ENDPOINTS__.dlPrimaryBase`，少了这一行，直跑 `node --test`
// 会在断言之前 `ReferenceError` 退出（exit 1、零条 `not ok`）—— 只有走 runner 才是绿的（#487）。
import '../helpers/injected.mjs'

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'deploy/dl-release/fixtures')
const ACCIDENT = 'invalid-buildtype-release.json'

const { parseManifest, fetchManifest, RELEASE_BASES, FALLBACK_RELEASE_BASE, PRIMARY_RELEASE_BASE } = await import(
  '../../src/services/updateManifest.ts'
)
const { BUILD_TYPES, isBuildType, buildTypeFor } = await import('../../shared/build-types.mjs')

const readFixture = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))
const runValidator = (file) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-releases-manifest.mjs'), path.join(FIXTURES, file)], {
    encoding: 'utf8',
  })

// ---------------------------------------------------------------- 1. 校验器
test('事故清单（12 条 / 11 条 buildType:"release"）校验器必须 FAIL 且逐条报出 11 条', () => {
  const r = runValidator(ACCIDENT)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /buildType 只能是 stable\|prerelease/)
  // 只报第一条就停 = 清洗时得反复跑 11 次，必须一次列全（对照：事故现场就是 11 条）
  assert.equal((r.stdout.match(/✗ [^\n]*buildType/g) || []).length, 11, r.stdout)
  assert.match(r.stdout, /11 error/, r.stdout)
})

test('合法清单不被误杀（公网 live / 私有 private-valid 各自 PASS）', () => {
  // #609 起口径分开：公网清单不再接受 internal 条目（原来那两条 proposed-*-internal 已改成
  // invalid-internal-in-public-*.json 的反例），私有清单用 `--private` 单独校验。
  const r = runValidator('live-2026-11-18.json')
  assert.equal(r.status, 0, `live-2026-11-18.json\n${r.stdout}`)

  const priv = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/validate-releases-manifest.mjs'), path.join(FIXTURES, 'private-valid-internal.json'), '--private'],
    { encoding: 'utf8' },
  )
  assert.equal(priv.status, 0, `private-valid-internal.json（--private）\n${priv.stdout}`)
})

test('清洗动作本身有效：把 11 条 release 全改成 stable 后校验器转 PASS', () => {
  const data = readFixture(ACCIDENT)
  const cleaned = {
    ...data,
    releases: data.releases.map((r) => (r.buildType === 'release' ? { ...r, buildType: 'stable' } : r)),
  }
  const tmp = path.join(FIXTURES, `.tmp-cleaned-${process.pid}.json`)
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + '\n')
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-releases-manifest.mjs'), tmp], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /PASS/)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

// ---------------------------------------------------------------- 2. 客户端解析
test('客户端 parseManifest 对非法 buildType 仍抛 INVALID_RELEASE（不静默跳过坏条目）', () => {
  const data = readFixture(ACCIDENT)
  assert.throws(() => parseManifest(data), /INVALID_RELEASE/)
})

test('parseManifest 兼容缺 buildType 的历史条目（fail-closed 不等于一刀切）', () => {
  const rows = parseManifest(readFixture('live-2026-11-18.json'))
  assert.ok(rows.length > 0)
  assert.ok(rows.some((r) => r.buildType === undefined), '历史条目仍然可读')
})

// ---------------------------------------------------------------- 3. fetch 回退
const validRow = (version = '1.4.0', versionCode = 18, buildType = 'stable') => ({
  version,
  versionCode,
  size: 1024,
  file: `apk/deepseek-chat-${version}.apk`,
  changes: ['ok'],
  buildType,
})
const manifestOf = (...rows) => JSON.stringify({ releases: rows })
const accidentBody = readFixture(ACCIDENT) && JSON.stringify(readFixture(ACCIDENT))

/** 按 base 返回预设响应，并记录每次请求的 URL（用来断言「到底打了几台」） */
const mockFetch = (byBase) => {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    const base = RELEASE_BASES.find((b) => url.startsWith(b)) ?? url
    const hit = byBase[base]
    if (hit === undefined || hit === 'network') {
      const error = new Error('fetch failed')
      error.name = 'TypeError'
      throw error
    }
    if (typeof hit === 'number') return { ok: false, status: hit, text: async () => '' }
    return { ok: true, status: 200, text: async () => hit }
  }
  return { fn, calls }
}

test('首台 200 但清单脏 → 回退到下一台，base 跟着真正解析成功的那台走', async () => {
  const { fn, calls } = mockFetch({
    [PRIMARY_RELEASE_BASE]: accidentBody,
    [FALLBACK_RELEASE_BASE]: manifestOf(validRow()),
  })
  const result = await fetchManifest(new AbortController().signal, fn)
  assert.equal(result.base, FALLBACK_RELEASE_BASE, 'file 要拼在真正回了清单的那台 base 上')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].buildType, 'stable')
  assert.equal(calls.length, 2, `解析失败也要试下一台：${calls.join(' , ')}`)
})

test('两台都脏 → 抛解析错误（INVALID_RELEASE），不是 MANIFEST_NETWORK', async () => {
  const { fn, calls } = mockFetch({
    [PRIMARY_RELEASE_BASE]: accidentBody,
    [FALLBACK_RELEASE_BASE]: accidentBody,
  })
  await assert.rejects(fetchManifest(new AbortController().signal, fn), (error) => {
    assert.match(error.message, /INVALID_RELEASE/, '界面要说「清单坏了」，不是「连不上」')
    assert.doesNotMatch(error.message, /MANIFEST_NETWORK/)
    return true
  })
  assert.equal(calls.length, 2)
})

test('首台网络失败 → 仍回退（原有行为不变）', async () => {
  const { fn } = mockFetch({
    [PRIMARY_RELEASE_BASE]: 'network',
    [FALLBACK_RELEASE_BASE]: manifestOf(validRow()),
  })
  const result = await fetchManifest(new AbortController().signal, fn)
  assert.equal(result.base, FALLBACK_RELEASE_BASE)
})

test('首台 502 → 仍回退（原有行为不变）', async () => {
  const { fn } = mockFetch({
    [PRIMARY_RELEASE_BASE]: 502,
    [FALLBACK_RELEASE_BASE]: manifestOf(validRow()),
  })
  const result = await fetchManifest(new AbortController().signal, fn)
  assert.equal(result.base, FALLBACK_RELEASE_BASE)
})

test('首台合法 → 只请求 1 次，不打第二台', async () => {
  const { fn, calls } = mockFetch({ [PRIMARY_RELEASE_BASE]: manifestOf(validRow()) })
  const result = await fetchManifest(new AbortController().signal, fn)
  assert.equal(result.base, PRIMARY_RELEASE_BASE)
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------- 4. 枚举单一真相源
test('枚举只有一处定义：shared/build-types.mjs；发布脚本/校验器都从它拿', () => {
  // 用 split 构造期望值：本文件里也不许再写出那份数组（下面的扫描会把自己也扫进去）
  assert.deepEqual([...BUILD_TYPES], 'stable|prerelease'.split('|'))
  assert.equal(isBuildType('release'), false, 'Gradle 构建类型不是 buildType')
  assert.equal(isBuildType('debug'), false)
  assert.equal(isBuildType(undefined), false)
  assert.equal(buildTypeFor('1.4.0'), 'stable')
  assert.equal(buildTypeFor('1.4.0-beta.10'), 'prerelease')

  // 全仓（除 shared/ 自己）不许再出现第二份枚举数组（含无空格写法）
  const duplicate = /['"]stable['"]\s*,\s*['"]prerelease['"]/
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'dist-standard', 'dist-baseline', '.git'].includes(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (/\.(mjs|ts|mts|js)$/.test(entry.name) && duplicate.test(fs.readFileSync(abs, 'utf8'))) {
        offenders.push(path.relative(ROOT, abs))
      }
    }
  }
  for (const dir of ['src', 'scripts', 'deploy', 'tests']) walk(path.join(ROOT, dir))
  assert.deepEqual(offenders, [], `这些文件又抄了一份枚举：${offenders.join(', ')}`)

  const shared = path.join(ROOT, 'shared/build-types.mjs')
  assert.match(fs.readFileSync(shared, 'utf8'), duplicate, '真相源必须真的定义枚举')
})

test('发布脚本对 --build-type release 直接退出 2 并打印允许取值', () => {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/release-upload.mjs'), '--apk', 'apk/does-not-exist.apk', '--build-type', 'release', '--dry-run'],
    { encoding: 'utf8', cwd: ROOT },
  )
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /只能是 stable\|prerelease/)
  assert.match(r.stderr, /Gradle 构建类型/, '错误提示要讲清 release/debug 是构建类型')
})
