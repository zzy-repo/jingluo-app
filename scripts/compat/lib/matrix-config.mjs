/**
 * 兼容 / 截图矩阵的**唯一**配置入口（issue #278）。
 *
 * 为什么要这个文件：
 *   1. 以前 SDK / ADB / 模拟器 / AVD 目录全是 `D:/android-sdk` 这类字面量（device.mjs），
 *      换一台机器整套兼容门禁就「跑不起来所以今天不跑」—— 门禁失效最常见的死法；
 *   2. AVD 名字（`compat-apiNN` / `deepseek-apiNN` 两套前缀）与它装的 API / WebView 档位
 *      在代码里**没有任何绑定**，「API 30 / WebView 83 通过了」这句话机器无法验证；
 *   3. 截图宽度 390 / 360 在 3 个脚本里各写一遍，加档必漏改 → 报告与实际覆盖不符（假绿）。
 *
 * 口径：
 *   - 配置在 `scripts/compat/matrix.config.json`；缺项用本文件的 MATRIX_DEFAULTS
 *     （默认值可以保留，但**任何一项都能被配置或环境变量覆盖**）；
 *   - 路径解析顺序（与 build-apk.sh 的 ANDROID_HOME → ANDROID_SDK_ROOT → $HOME/android-sdk 同一套）：
 *       sdkRoot: matrix.config.json:sdkRoot → COMPAT_SDK_ROOT → ANDROID_HOME → ANDROID_SDK_ROOT
 *                → $HOME/android-sdk → 历史默认 LEGACY_PATHS.sdkRoot
 *       avdHome: matrix.config.json:avdHome → ANDROID_AVD_HOME → $HOME/.android/avd → 历史默认
 *     显式给了但不存在 → 直接报「找不到 …」，**不静默回退**（回退会把配错藏起来）；
 *   - 一个候选都没有 → 报人话 + 怎么修，不抛 ENOENT。
 *
 * 本模块只做「读 + 解析 + 校验 + 换算」，不启动模拟器、不碰 adb（那是 lib/device.mjs 的事）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAppIdentity } from '../../lib/appIdentity.mjs'
import { MIN_ANDROID_SDK, PROBE_TIERS } from '../../lib/compatBaseline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 默认配置文件位置（脚本里不必再写相对路径） */
export const DEFAULT_CONFIG_PATH = path.resolve(HERE, '..', 'matrix.config.json')

/** 配置缺项时的默认值。默认值可以保留，但必须能被 matrix.config.json / 环境变量覆盖。 */
export const MATRIX_DEFAULTS = {
  sdkRoot: null,
  avdHome: null,
  daemonPort: 5554,
  avdProfiles: [],
  webviewTierSlack: 0,
  captureWidths: [390, 360],
  requiredCaptureWidths: [390, 360],
  capturePhysicalWidth: 1080,
  captureHeights: { 390: 844, 360: 800 },
}

/**
 * 历史机器（只有那一台能跑）的**最后一档**兜底路径。
 * 只在本文件出现一次，且排在所有环境变量之后 —— 换机器不用改代码，设环境变量即可。
 */
export const LEGACY_PATHS = {
  sdkRoot: 'D:/android-sdk',
  avdHome: 'D:/android-avd',
}

export const SDK_MISSING_HINT = '找不到 Android SDK：请设置 ANDROID_HOME 或 matrix.config.json:sdkRoot'
export const AVD_MISSING_HINT = '找不到 AVD 目录：请设置 ANDROID_AVD_HOME 或 matrix.config.json:avdHome'

/** 配置 / 环境解析失败：消息本身就是给人看的，CLI 只负责打印 + 退出码。 */
export class MatrixConfigError extends Error {
  constructor(message, { problems = [] } = {}) {
    super(message)
    this.name = 'MatrixConfigError'
    this.problems = problems
  }
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

const readRawConfig = (configPath) => {
  let text
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new MatrixConfigError(`读不到矩阵配置：${configPath}（${error.code ?? error.message}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new MatrixConfigError(`矩阵配置不是合法 JSON：${configPath}（${error.message}）`)
  }
}

/** 「先给的生效」：显式值不存在就报错，不回退到下一个（回退会把配错藏起来）。 */
const firstDefined = (candidates, exists, missingHint) => {
  for (const candidate of candidates) {
    if (!nonEmpty(candidate.value)) continue
    const dir = candidate.value.trim()
    if (exists(dir)) return { dir, source: candidate.source, problem: null }
    return {
      dir: null,
      source: candidate.source,
      problem: `${missingHint.split('：')[0]}：${dir} 不存在（来源 ${candidate.source}）`,
    }
  }
  return { dir: null, source: null, problem: null }
}

const pickFallback = (fallbacks, exists) => {
  for (const fallback of fallbacks) {
    if (nonEmpty(fallback.value) && exists(fallback.value)) {
      return { dir: fallback.value, source: fallback.source, problem: null }
    }
  }
  return null
}

export const resolveSdkRoot = ({ raw = {}, env = {}, exists = existsSync, home = os.homedir() } = {}) => {
  const resolved = firstDefined(
    [
      { source: 'matrix.config.json:sdkRoot', value: raw.sdkRoot },
      { source: 'COMPAT_SDK_ROOT', value: env.COMPAT_SDK_ROOT },
      { source: 'ANDROID_HOME', value: env.ANDROID_HOME },
      { source: 'ANDROID_SDK_ROOT', value: env.ANDROID_SDK_ROOT },
    ],
    exists,
    SDK_MISSING_HINT
  )
  if (resolved.dir || resolved.problem) return resolved
  return (
    pickFallback(
      [
        { source: '默认 $HOME/android-sdk', value: home ? path.join(home, 'android-sdk') : null },
        { source: `历史默认 ${LEGACY_PATHS.sdkRoot}`, value: LEGACY_PATHS.sdkRoot },
      ],
      exists
    ) ?? { dir: null, source: null, problem: SDK_MISSING_HINT }
  )
}

/** AVD 目录里真的装着 AVD 吗（有 *.ini）——「存在但是空的」和「装着 10 个档位」不是一回事。 */
export const countAvds = (dir, readdir = readdirSync) => {
  if (!dir) return 0
  try {
    return readdir(dir).filter((name) => String(name).toLowerCase().endsWith('.ini')).length
  } catch {
    return 0
  }
}

export const resolveAvdHome = ({
  raw = {},
  env = {},
  exists = existsSync,
  home = os.homedir(),
  readdir = readdirSync,
} = {}) => {
  const resolved = firstDefined(
    [
      { source: 'matrix.config.json:avdHome', value: raw.avdHome },
      { source: 'ANDROID_AVD_HOME', value: env.ANDROID_AVD_HOME },
    ],
    exists,
    AVD_MISSING_HINT
  )
  if (resolved.dir || resolved.problem) return resolved
  // 都没配：在「历史默认」和「Android 工具的标准默认」里挑**真的装着 AVD 的那一个**。
  const fallbacks = [
    { source: `历史默认 ${LEGACY_PATHS.avdHome}`, value: LEGACY_PATHS.avdHome },
    { source: '默认 $HOME/.android/avd', value: home ? path.join(home, '.android', 'avd') : null },
  ].filter((fallback) => nonEmpty(fallback.value) && exists(fallback.value))
  const withAvds = fallbacks.find((fallback) => countAvds(fallback.value, readdir) > 0)
  if (withAvds) return { dir: withAvds.value, source: `${withAvds.source}（含 AVD）`, problem: null }
  if (fallbacks.length) return { dir: fallbacks[0].value, source: fallbacks[0].source, problem: null }
  return { dir: null, source: null, problem: AVD_MISSING_HINT }
}

const TOOL_NAMES =
  process.platform === 'win32' ? { adb: 'adb.exe', emulator: 'emulator.exe' } : { adb: 'adb', emulator: 'emulator' }

const sdkTools = (sdkRoot) =>
  sdkRoot
    ? {
        adb: path.join(sdkRoot, 'platform-tools', TOOL_NAMES.adb),
        emulator: path.join(sdkRoot, 'emulator', TOOL_NAMES.emulator),
      }
    : { adb: null, emulator: null }

const toPositiveInt = (value, fallback, label, problems) => {
  const number = Number(value)
  if (Number.isInteger(number) && number > 0) return number
  if (value !== undefined && value !== null) {
    problems.push(`${label} 必须是正整数（当前：${value}），已回退到 ${fallback}`)
  }
  return fallback
}

const toWidths = (value, label, problems) => {
  if (value === undefined || value === null) return [...MATRIX_DEFAULTS[label]]
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${label} 必须是非空数字数组（当前：${JSON.stringify(value)}）`)
    return [...MATRIX_DEFAULTS[label]]
  }
  const widths = value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
  if (widths.length !== value.length) {
    problems.push(`${label} 里有非正数档位（当前：${JSON.stringify(value)}），已丢弃那些档位`)
  }
  return widths.length ? widths : [...MATRIX_DEFAULTS[label]]
}

const toProfiles = (value, problems) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    problems.push(`avdProfiles 必须是数组（当前：${typeof value}）`)
    return []
  }
  return value.map((profile, index) => {
    const name = nonEmpty(profile?.name) ? profile.name.trim() : null
    if (!name) problems.push(`avdProfiles[${index}] 缺 name`)
    return { name, api: Number(profile?.api), webviewTier: String(profile?.webviewTier ?? '') }
  })
}

/**
 * 包名：**不在这里抄一份**。唯一来源是 config/appIdentity.json（#271 的 loadAppIdentity）：
 * 包名参与设备指纹，写第二份就是静默换账号。这里只允许 COMPAT_PACKAGE 环境变量做临时覆盖。
 */
const resolvePackageName = ({ env, problems }) => {
  if (nonEmpty(env.COMPAT_PACKAGE)) return env.COMPAT_PACKAGE.trim()
  try {
    return loadAppIdentity().applicationId
  } catch (error) {
    problems.push(`读不到应用身份（config/appIdentity.json）：${error.message}`)
    return null
  }
}

/** 读 + 解析整份配置。**不抛**路径类问题（记进 problems），只有文件读不到 / 不是 JSON 才抛。 */
export const resolveMatrixConfig = (options = {}) => {
  const env = options.env ?? process.env
  const configPath = path.resolve(options.configPath ?? env.MATRIX_CONFIG ?? DEFAULT_CONFIG_PATH)
  const exists = options.exists ?? existsSync
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir()
  const raw = options.raw ?? readRawConfig(configPath)
  const problems = []

  const sdk =
    options.sdkRoot === undefined
      ? resolveSdkRoot({ raw, env, exists, home })
      : { dir: options.sdkRoot, source: 'options', problem: null }
  const avd =
    options.avdHome === undefined
      ? resolveAvdHome({ raw, env, exists, home })
      : { dir: options.avdHome, source: 'options', problem: null }
  if (sdk.problem) problems.push(sdk.problem)
  if (avd.problem) problems.push(avd.problem)

  const tools = sdkTools(sdk.dir)
  const slack = Number(raw.webviewTierSlack ?? MATRIX_DEFAULTS.webviewTierSlack)
  const config = {
    configPath,
    sdkRoot: sdk.dir,
    sdkRootSource: sdk.source,
    avdHome: avd.dir,
    avdHomeSource: avd.source,
    adb: tools.adb,
    emulator: tools.emulator,
    daemonPort: toPositiveInt(
      raw.daemonPort ?? env.COMPAT_DAEMON_PORT ?? MATRIX_DEFAULTS.daemonPort,
      MATRIX_DEFAULTS.daemonPort,
      'daemonPort',
      problems
    ),
    packageName: resolvePackageName({ env, problems }),
    avdProfiles: toProfiles(raw.avdProfiles, problems),
    webviewTierSlack: Number.isFinite(slack) && slack >= 0 ? slack : MATRIX_DEFAULTS.webviewTierSlack,
    captureWidths: toWidths(raw.captureWidths, 'captureWidths', problems),
    requiredCaptureWidths: toWidths(raw.requiredCaptureWidths, 'requiredCaptureWidths', problems),
    capturePhysicalWidth: toPositiveInt(
      raw.capturePhysicalWidth ?? MATRIX_DEFAULTS.capturePhysicalWidth,
      MATRIX_DEFAULTS.capturePhysicalWidth,
      'capturePhysicalWidth',
      problems
    ),
    captureHeights: { ...MATRIX_DEFAULTS.captureHeights, ...(raw.captureHeights ?? {}) },
    problems,
  }
  config.ok = problems.length === 0
  return config
}

/** 进程级默认配置（同一进程里多次调用只读一次盘）。 */
let cachedConfig = null
export const matrixConfig = () => {
  cachedConfig ??= resolveMatrixConfig()
  return cachedConfig
}

/** 需要真跑模拟器时用这个：路径解析不出来就抛人话错误（不是 ENOENT）。 */
export const requireAndroidEnv = (config = matrixConfig()) => {
  if (!config.sdkRoot || !config.avdHome) {
    const message = config.problems.length ? config.problems.join('；') : SDK_MISSING_HINT
    throw new MatrixConfigError(message, { problems: config.problems })
  }
  return config
}

/** CSS 宽 → wm density（1080 物理宽下 390css → 443、360css → 480、411css → 420）。 */
export const densityForWidth = (cssWidth, physicalWidth = MATRIX_DEFAULTS.capturePhysicalWidth) => {
  const width = Number(cssWidth)
  const physical = Number(physicalWidth)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(physical) || physical <= 0) return null
  return String(Math.round((physical / width) * 160))
}

/** 截图档位列表：p4-layout 的 PROFILES 就是它。 */
export const cssProfiles = (config = matrixConfig()) =>
  config.captureWidths.map((width) => ({
    name: `${width}css`,
    width,
    density: densityForWidth(width, config.capturePhysicalWidth),
  }))

/**
 * 浏览器视口（shot-72 用）：高度取 captureHeights，缺了就按 390 档的宽高比折算。
 * 只改数字来源，不改原来的视口数值。
 */
export const viewportFor = (config, width) => {
  const explicit = Number(config.captureHeights?.[String(width)])
  if (Number.isFinite(explicit) && explicit > 0) return { width: Number(width), height: explicit }
  return { width: Number(width), height: Math.round((Number(width) * 844) / 390) }
}

export const avdProfileByName = (config, name) =>
  config.avdProfiles.find((profile) => profile.name === name) ?? null

export const avdProfileByApi = (config, api) =>
  config.avdProfiles.find((profile) => String(profile.api) === String(api)) ?? null

/** `83.0.4103.106` → 83；读不出来返回 null（不猜）。 */
export const majorOfVersion = (versionName) => {
  const match = /^\s*(\d+)/.exec(String(versionName ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * AVD 起来之后回验：「这台机真的是配置里声明的那一档吗」。
 * actual: { api: getprop ro.build.version.sdk 原文, webviewVersionName: dumpsys 里的 versionName }
 */
export const verifyAvdAgainstProfile = (profile, actual, config = {}) => {
  if (!profile) {
    return { ok: false, failures: ['AVD 不在 matrix.config.json:avdProfiles 里，无法校验它的 API / WebView 档位'] }
  }
  const failures = []
  const actualApiText = String(actual?.api ?? '').trim()
  const actualApi = Number(actualApiText)
  if (!Number.isFinite(actualApi) || actualApi !== Number(profile.api)) {
    failures.push(`AVD 实际 API ${actualApiText || '(空)'} ≠ 配置声明 ${profile.api}`)
  }

  const major = majorOfVersion(actual?.webviewVersionName)
  const declared = Number(String(profile.webviewTier ?? '').split('.')[0])
  const slack = Number(config.webviewTierSlack ?? 0)
  if (!Number.isFinite(declared)) {
    failures.push(`matrix.config.json:avdProfiles[${profile.name ?? '?'}].webviewTier 不是版本号（${profile.webviewTier}）`)
  } else if (major === null) {
    failures.push(
      `读不到 WebView 版本（原文：${actual?.webviewVersionName || '(空)'}），无法确认 ${profile.name} 是 WebView ${profile.webviewTier} 档`
    )
  } else if (major < declared - slack || major > declared + slack) {
    failures.push(`AVD 实际 WebView ${major} ≠ 配置声明档位 WebView ${profile.webviewTier}（${profile.name}）`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * 契约校验（`pnpm check:matrix` 的第一段）。
 * requirePaths=false 时路径问题只算 warning —— CI 上没有 Android SDK，不能因此把静态矩阵打红。
 */
export const validateMatrixConfig = (config, { requirePaths = false } = {}) => {
  const failures = []
  const warnings = []

  const missing = config.requiredCaptureWidths.filter((width) => !config.captureWidths.includes(width))
  if (missing.length) failures.push(`截图档位少于契约要求（缺 ${missing.join('、')}）`)
  const extra = config.captureWidths.filter((width) => !config.requiredCaptureWidths.includes(width))
  if (extra.length) {
    warnings.push(`比契约多出的截图档位：${extra.join('、')}（确认 docs/RELEASE-MANUAL.md 第 8 节是否要同步）`)
  }
  for (const width of config.captureWidths) {
    if (densityForWidth(width, config.capturePhysicalWidth) === null) failures.push(`截图档位 ${width} 换算不出 density`)
  }

  if (!config.avdProfiles.length) failures.push('matrix.config.json:avdProfiles 为空（API × WebView 组合无法被机器校验）')
  const seenNames = new Set()
  const seenApis = new Set()
  for (const profile of config.avdProfiles) {
    if (profile.name) {
      if (seenNames.has(profile.name)) failures.push(`avdProfiles 里 AVD 名重复：${profile.name}`)
      seenNames.add(profile.name)
    }
    if (!Number.isInteger(profile.api) || profile.api <= 0) {
      failures.push(`avdProfiles[${profile.name ?? '?'}].api 不是正整数：${profile.api}`)
    } else if (seenApis.has(profile.api)) {
      failures.push(`avdProfiles 里 api 重复：${profile.api}（--api 解析会有歧义）`)
    } else {
      seenApis.add(profile.api)
    }
    if (!/^\d+/.test(String(profile.webviewTier ?? ''))) {
      failures.push(`avdProfiles[${profile.name ?? '?'}].webviewTier 不是版本号：${profile.webviewTier}`)
    }
  }

  const pathProblems = config.problems ?? []
  if (requirePaths) failures.push(...pathProblems)
  else warnings.push(...pathProblems)

  return { ok: failures.length === 0, failures, warnings }
}

// ── 命令行（给 bash 脚本读同一份配置，避免 run-round.sh 再写一遍路径 / AVD 名） ────────
//
//   node scripts/compat/lib/matrix-config.mjs --print sdkRoot
//   node scripts/compat/lib/matrix-config.mjs --print avd:31
//   node scripts/compat/lib/matrix-config.mjs --json
const printCli = (argv) => {
  const printFlag = argv.indexOf('--print')
  const configPathFlag = argv.indexOf('--config')
  const config = resolveMatrixConfig({
    configPath: configPathFlag >= 0 ? argv[configPathFlag + 1] : undefined,
  })
  if (argv.includes('--json')) {
    const { raw, ...rest } = config
    console.log(JSON.stringify(rest, null, 2))
    return config.ok ? 0 : 1
  }
  if (printFlag < 0) {
    console.error(
      '用法：node scripts/compat/lib/matrix-config.mjs --print <sdkRoot|avdHome|adb|emulator|daemonPort|packageName|captureWidths|avd:<api>> [--json]'
    )
    return 2
  }
  const key = argv[printFlag + 1] ?? ''
  if (key.startsWith('avd:')) {
    const profile = avdProfileByApi(config, key.slice(4))
    if (!profile) {
      console.error(`avdProfiles 里没有 api=${key.slice(4)} 的档位（看 matrix.config.json）`)
      return 1
    }
    console.log(profile.name)
    return 0
  }
  if (key === 'captureWidths') {
    console.log(config.captureWidths.join(','))
    return 0
  }
  const value = config[key]
  if (typeof value !== 'string' || !value.length) {
    console.error(config.problems[0] ?? `配置项 ${key} 解析不出来（看 matrix.config.json）`)
    return 1
  }
  console.log(value)
  return 0
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    process.exit(printCli(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof MatrixConfigError ? error.message : `矩阵配置读取失败：${error.message}`)
    process.exit(2)
  }
}
