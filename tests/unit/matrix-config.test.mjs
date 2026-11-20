// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// issue #278：兼容 / 截图矩阵配置化的自测。钉住四件事：
//   1. **契约**：`captureWidths` 少一档必须 FAIL（负向 1），不许静默只跑一档；
//   2. **AVD 档位回验**：配置声明 api 30、设备实际 26 必须报错（负向 2）——
//      「API 30 / WebView 83 通过了」这句话以前只能靠人记得，现在机器能验；
//   3. **路径缺失**：一个候选都没有时报人话（负向 3），不是 spawnSync 的 ENOENT；
//      且 ANDROID_HOME / ANDROID_SDK_ROOT 能覆盖默认值（换机器不用改代码）；
//   4. **只此一处**：4 个消费方（device / p4-layout / measure-narrow-scroll-shift / shot-72）
//      不许再把 390/360、D 盘路径抄回去。
//
// 这些断言全部离线（不启动模拟器、不连 adb），本单的重启矩阵由单测 + `--dry-run` 覆盖。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  MatrixConfigError,
  avdProfileByApi,
  avdProfileByName,
  cssProfiles,
  densityForWidth,
  requireAndroidEnv,
  resolveMatrixConfig,
  resolveSdkRoot,
  validateMatrixConfig,
  verifyAvdAgainstProfile,
  majorOfVersion,
  viewportFor,
} from '../../scripts/compat/lib/matrix-config.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CONFIG_RELATIVE = 'scripts/compat/matrix.config.json'
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const rawConfig = () => JSON.parse(read(CONFIG_RELATIVE))

/** `exists` 全部注入：断言不看这台机器上真有哪个盘（D 盘在别的机器上不存在）。 */
const existsIn = (set) => (dir) =>
  set.some((candidate) => candidate.toLowerCase() === String(dir).split(String.fromCharCode(92)).join('/').toLowerCase())

const buildConfig = (overrides = {}, options = {}) =>
  resolveMatrixConfig({
    configPath: path.join(ROOT, CONFIG_RELATIVE),
    env: { HOME: '/home/dev', ANDROID_HOME: '/android-sdk', ANDROID_AVD_HOME: '/avd' },
    exists: existsIn(['/android-sdk', '/avd']),
    home: '/home/dev',
    raw: { ...rawConfig(), ...overrides },
    ...options,
  })

test('#278 密度换算：1080 物理宽下 390css→443、360css→480、411css→420', () => {
  assert.equal(densityForWidth(390, 1080), '443')
  assert.equal(densityForWidth(360, 1080), '480')
  assert.equal(densityForWidth(411, 1080), '420')
  assert.equal(densityForWidth(0, 1080), null)
})

test('#278 截图档位只有一处来源：p4-layout 的 PROFILES 就是 cssProfiles()', () => {
  const config = buildConfig()
  assert.deepEqual(cssProfiles(config).map((profile) => profile.name), ['390css', '360css'])
  assert.deepEqual(cssProfiles(config).map((profile) => profile.density), ['443', '480'])
  // 加一档只需要改配置
  const widened = buildConfig({ captureWidths: [412, 390, 360] })
  assert.deepEqual(cssProfiles(widened).map((profile) => profile.name), ['412css', '390css', '360css'])
  assert.equal(cssProfiles(widened)[0].density, '419')
})

test('#278 shot-72 的视口来自配置（390×844、360×800 与改动前一致）', () => {
  const config = buildConfig()
  assert.deepEqual(viewportFor(config, 390), { width: 390, height: 844 })
  assert.deepEqual(viewportFor(config, 360), { width: 360, height: 800 })
})

test('#278 负向 1：captureWidths 少了 360 → 必须 FAIL 报「截图档位少于契约要求（缺 360）」', () => {
  const report = validateMatrixConfig(buildConfig({ captureWidths: [390] }))
  assert.equal(report.ok, false)
  assert.ok(report.failures.includes('截图档位少于契约要求（缺 360）'), report.failures.join('；'))
})

test('#278 默认配置满足契约；档位少了 / AVD 表空 / api 重复都要报出来', () => {
  assert.deepEqual(validateMatrixConfig(buildConfig(), { requirePaths: true }).failures, [])
  const noProfiles = validateMatrixConfig(buildConfig({ avdProfiles: [] }))
  assert.equal(noProfiles.ok, false)
  assert.ok(noProfiles.failures.some((failure) => failure.includes('avdProfiles 为空')))
  const duplicated = validateMatrixConfig(
    buildConfig({ avdProfiles: [{ name: 'a', api: 30, webviewTier: '83' }, { name: 'a', api: 30, webviewTier: '83' }] })
  )
  assert.ok(duplicated.failures.some((failure) => failure.includes('AVD 名重复：a')))
  assert.ok(duplicated.failures.some((failure) => failure.includes('api 重复：30')))
})

test('#278 负向 2：AVD 实际 API 26 ≠ 配置声明 30 → 报错退出（不继续往下跑）', () => {
  const profile = { name: 'compat-api26', api: 30, webviewTier: '83' }
  const verdict = verifyAvdAgainstProfile(profile, { api: '26', webviewVersionName: '83.0.4103.106' })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.includes('AVD 实际 API 26 ≠ 配置声明 30'), verdict.failures.join('；'))
})

test('#278 AVD 档位对得上就通过；WebView 档位不符 / 读不到版本都要报', () => {
  const config = { webviewTierSlack: 0 }
  const profile = { name: 'compat-api31', api: 31, webviewTier: '91' }
  assert.equal(verifyAvdAgainstProfile(profile, { api: '31', webviewVersionName: '91.0.4472.114' }, config).ok, true)

  const wrongTier = verifyAvdAgainstProfile(profile, { api: '31', webviewVersionName: '109.0.5414.118' }, config)
  assert.equal(wrongTier.ok, false)
  assert.match(wrongTier.failures.join('；'), /WebView 109 ≠ 配置声明档位 WebView 91/)

  const unreadable = verifyAvdAgainstProfile(profile, { api: '31', webviewVersionName: '(没有 versionName 行)' }, config)
  assert.match(unreadable.failures.join('；'), /读不到 WebView 版本/)

  assert.equal(majorOfVersion('83.0.4103.106'), 83)
  assert.equal(majorOfVersion('(没有 versionName 行)'), null)
  assert.equal(avdProfileByName(buildConfig(), 'compat-api31').webviewTier, '91')
  assert.equal(avdProfileByApi(buildConfig(), 33).name, 'deepseek-api33')
})

test('#278 负向 3：找不到 SDK 时报人话（不是 ENOENT），CI 上只算 warning', () => {
  const resolved = resolveSdkRoot({ raw: { sdkRoot: null }, env: {}, exists: () => false, home: '/home/dev' })
  assert.equal(resolved.dir, null)
  assert.equal(resolved.problem, '找不到 Android SDK：请设置 ANDROID_HOME 或 matrix.config.json:sdkRoot')

  const config = buildConfig(
    {},
    { env: { HOME: '/home/dev' }, exists: () => false }
  )
  assert.equal(config.sdkRoot, null)
  assert.equal(config.ok, false)

  let caught = null
  try {
    requireAndroidEnv(config)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof MatrixConfigError, '应当抛 MatrixConfigError')
  assert.match(caught.message, /找不到 Android SDK：请设置 ANDROID_HOME 或 matrix\.config\.json:sdkRoot/)
  assert.doesNotMatch(caught.message, /ENOENT/)

  // 本地连门一起卡
  assert.equal(validateMatrixConfig(config, { requirePaths: true }).ok, false)
  // CI 上没有 Android SDK：路径问题只算 warning，静态矩阵不该因此打红
  const lenient = validateMatrixConfig(config)
  assert.equal(lenient.ok, true)
  assert.ok(lenient.warnings.some((warning) => warning.includes('找不到 Android SDK')))
})

test('#278 路径优先级：配置 > COMPAT_SDK_ROOT > ANDROID_HOME > ANDROID_SDK_ROOT > 默认', () => {
  const exists = existsIn(['/cfg-sdk', '/compat-sdk', '/env-sdk', '/root-sdk', '/home/dev/android-sdk'])
  const pick = (raw, env) => resolveSdkRoot({ raw, env, exists, home: '/home/dev' }).dir
  assert.equal(pick({ sdkRoot: '/cfg-sdk' }, { ANDROID_HOME: '/env-sdk' }), '/cfg-sdk')
  assert.equal(pick({}, { COMPAT_SDK_ROOT: '/compat-sdk', ANDROID_HOME: '/env-sdk' }), '/compat-sdk')
  assert.equal(pick({}, { ANDROID_HOME: '/env-sdk', ANDROID_SDK_ROOT: '/root-sdk' }), '/env-sdk')
  assert.equal(pick({}, { ANDROID_SDK_ROOT: '/root-sdk' }), '/root-sdk')
  assert.equal(pick({}, {}), path.join('/home/dev', 'android-sdk'))
  // 这台机器之外：只有历史默认在也能跑（改动前的行为不变），但它是最后一档
  assert.equal(
    resolveSdkRoot({ raw: {}, env: {}, exists: existsIn(['d:/android-sdk']), home: '/home/dev' }).dir,
    'D:/android-sdk'
  )
})

test('#278 显式路径不存在时直接报错，不静默回退到下一个候选', () => {
  const resolved = resolveSdkRoot({
    raw: {},
    env: { ANDROID_HOME: '/nope/sdk', ANDROID_SDK_ROOT: '/env-sdk' },
    exists: existsIn(['/env-sdk']),
    home: '/home/dev',
  })
  assert.equal(resolved.dir, null)
  assert.match(resolved.problem, /^找不到 Android SDK：\/nope\/sdk 不存在（来源 ANDROID_HOME）$/)
})

test('#278 只此一处：4 个消费方不许再把 390/360 与 D 盘路径抄回去', () => {
  const device = read('scripts/compat/lib/device.mjs')
  assert.doesNotMatch(device, /'D:\/android-(sdk|avd)'/)
  assert.match(device, /matrix-config\.mjs/)

  const p4 = read('scripts/compat/p4-layout.mjs')
  assert.doesNotMatch(p4, /\{ name: '(390|360)css'/)
  assert.match(p4, /cssProfiles\(resolveMatrixConfig\(\)\)/)

  const measure = read('scripts/measure-narrow-scroll-shift.mjs')
  assert.doesNotMatch(measure, /DEFAULT_WIDTHS = \[390, 360\]/)
  assert.match(measure, /matrixConfig\(\)\.captureWidths/)

  const shot = read('scripts/shot-72.mjs')
  assert.doesNotMatch(shot, /run\(390, 844, '390'\)/)
  assert.match(shot, /viewportFor\(CONFIG, width\)/)

  // 串行跑批脚本：SDK 与 AVD 名都从配置来，不写死 /d/android-sdk、也不写死 AVD 名
  const round = read('scripts/compat/run-round.sh')
  assert.doesNotMatch(round, /\/d\/android-sdk/)
  assert.doesNotMatch(round, /compat-api31|deepseek-api33/)
  assert.match(round, /--print sdkRoot/)

  // 档位表只有一份
  const config = read(CONFIG_RELATIVE)
  assert.equal((config.match(/"captureWidths":/g) ?? []).length, 1)
})

test('#278 pnpm check:matrix 第一段：缺档即 FAIL，配齐即 OK（真实进程）', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'matrix-config-'))
  try {
    const negativePath = path.join(tmpDir, 'matrix.config.json')
    writeFileSync(negativePath, JSON.stringify({ ...rawConfig(), captureWidths: [390] }, null, 2))
    const run = (args) =>
      spawnSync(process.execPath, [path.join(ROOT, 'scripts/compat/check-matrix-config.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, ANDROID_HOME: tmpDir, ANDROID_AVD_HOME: tmpDir },
      })

    const negative = run(['--config', negativePath])
    assert.equal(negative.status, 1, negative.stderr)
    assert.match(negative.stderr, /截图档位少于契约要求（缺 360）/)

    const positive = run([])
    assert.equal(positive.status, 0, positive.stderr)
    assert.match(positive.stdout, /\[matrix\] OK/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
