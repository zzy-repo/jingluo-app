// 老版本 WebView 矩阵取证 · 设备/模拟器公共装置。
//
// 纪律（本仓库 AGENTS.md + 本次任务）：
//   - **一台模拟器串行**：run 之前先确认 `adb devices` 为空，否则直接退出，绝不去碰别人的进程；
//   - 只用 execFileSync 传参数数组，**不经过 shell**，所以不存在 MSYS 把 `/sdcard/x` 改写成
//     `D:/Program Files/Git/sdcard/x` 的问题（以前踩过）；
//   - 模拟器固定用 SDK 里现有的 35.1.2.0（不要升级，`emulator-37.2.13.bak` 是留给别人的备份）；
//   - 证据只写 `docs/compat/compat-old/api<NN>/`，本目录只放脚本。
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { MatrixConfigError, matrixConfig } from './matrix-config.mjs'

// 路径 / 包名 / 端口全部来自 scripts/compat/matrix.config.json（+ ANDROID_HOME、ANDROID_AVD_HOME 等
// 环境变量覆盖）。本文件不再写死 D 盘路径，也不再自己拼 adb.exe —— 换机器只需设环境变量（issue #278）。
const CONFIG = matrixConfig()

/** 解析出来的整份矩阵配置（sdkRoot / avdHome / daemonPort / avdProfiles / captureWidths…）。 */
export const MATRIX = CONFIG
export const SDK = CONFIG.sdkRoot
export const ADB = CONFIG.adb
export const EMULATOR = CONFIG.emulator
export const AVD_HOME = CONFIG.avdHome
/** 包名不写死：唯一来源是 config/appIdentity.json（Issue #271），矩阵配置只做转发（Issue #278）。 */
export const PACKAGE = CONFIG.packageName
export const DAEMON_PORT = CONFIG.daemonPort

/** 缺路径时报人话（不是 spawnSync 的 ENOENT）。 */
const requirePath = (value, label) => {
  if (value) return value
  throw new MatrixConfigError(
    MATRIX.problems[0] ?? `找不到 ${label}：请检查 matrix.config.json 与 ANDROID_HOME / ANDROID_AVD_HOME`,
    { problems: MATRIX.problems }
  )
}

/** 证据根：compat-old 的 README 与 api30/api31 都在这儿，新增档位按 api<NN> 并排。 */
export const EVIDENCE_ROOT = resolve(
  new URL('../../../docs/compat/compat-old/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
)
export const APK = resolve(
  new URL('../../../android/app/build/outputs/apk/debug/app-debug.apk', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1'
  )
)

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
export const now = () => new Date().toTimeString().slice(0, 8)

/** adb 调用：返回 stdout（trim 过）；失败时抛出带 stderr 的错误。 */
export const adb = (args, options = {}) => {
  const adbPath = requirePath(ADB, 'adb')
  try {
    return execFileSync(adbPath, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim()
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim()
    const stdout = String(error.stdout ?? '').trim()
    throw new Error(`adb ${args.join(' ')} 失败：${stderr || stdout || error.message}`)
  }
}

/** adb shell 用这个（参数数组，不做路径改写）。 */
export const shell = (...args) => adb(['shell', ...args])

/** 二进制输出（screencap）。 */
export const adbBuffer = (args) => {
  const adbPath = requirePath(ADB, 'adb')
  return execFileSync(adbPath, args, { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 当前连着的设备序列号列表。 */
export const devices = () =>
  adb(['devices'])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))

/** 串行闸门：有设备在跑就直接退出，不抢。 */
export const requireIdleHost = () => {
  const list = devices()
  if (list.length > 0) {
    throw new Error(
      `宿主上已有设备在跑（${list.map(([serial, state]) => `${serial}:${state}`).join(', ')}），串行纪律要求先等它结束`
    )
  }
}

export const startEmulator = (avd) => {
  const emulatorPath = requirePath(EMULATOR, 'emulator')
  const avdHome = requirePath(AVD_HOME, 'AVD 目录')
  const child = spawn(
    emulatorPath,
    [
      '-avd',
      avd,
      '-no-snapshot',
      '-no-boot-anim',
      '-no-audio',
      '-gpu',
      'swiftshader_indirect',
      '-port',
      String(DAEMON_PORT),
    ],
    {
      env: { ...process.env, ANDROID_AVD_HOME: avdHome },
      detached: true,
      stdio: 'ignore',
    }
  )
  child.unref()
  return child.pid
}

/** 等开机完成（sys.boot_completed=1 + 包管理器可用）。 */
export const waitBoot = async (timeoutMs = 300_000, log = console.log) => {
  const deadline = Date.now() + timeoutMs
  let lastReport = 0
  while (Date.now() < deadline) {
    try {
      if (shell('getprop', 'sys.boot_completed').trim() === '1') {
        // 开机完成不等于 Launcher 就绪，等 launcher 起来再继续
        const ready = shell('getprop', 'dev.bootcomplete').trim()
        if (ready === '1') {
          await sleep(3000)
          return true
        }
      }
    } catch {
      // 设备还没上 adb，正常
    }
    if (Date.now() - lastReport > 20_000) {
      lastReport = Date.now()
      log(`  等开机… ${now()}`)
    }
    await sleep(2000)
  }
  return false
}

export const killEmulator = () => {
  try {
    adb(['emu', 'kill'])
  } catch {
    // 已经没了就算了
  }
}

/** 环境口径（每条都要原文贴进报告，不许按 Android 版本猜 WebView 版本）。 */
export const environment = () => {
  const dumpsysWebView = (() => {
    try {
      return shell('dumpsys package com.google.android.webview').split(/\r?\n/)
    } catch {
      return []
    }
  })()
  const provider = (() => {
    try {
      return shell('dumpsys webviewupdate').split(/\r?\n/).slice(0, 40)
    } catch {
      return []
    }
  })()
  return {
    model: shell('getprop', 'ro.product.model'),
    device: shell('getprop', 'ro.product.device'),
    release: shell('getprop', 'ro.build.version.release'),
    sdk: shell('getprop', 'ro.build.version.sdk'),
    abi: shell('getprop', 'ro.product.cpu.abi'),
    buildId: shell('getprop', 'ro.build.id'),
    webViewVersionLine:
      dumpsysWebView.find((line) => /versionName=/.test(line))?.trim() ?? '(没有 versionName 行)',
    webViewUpdate: provider.filter((line) => /Current WebView package|versionName|Valid|Fallback/.test(line)),
    wmSize: shell('wm', 'size'),
    wmDensity: shell('wm', 'density'),
    memTotal: shell('cat', '/proc/meminfo').split(/\r?\n/)[0],
  }
}

export const evidenceDir = (api) => `${EVIDENCE_ROOT}/api${api}`

export const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const saveJson = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

export const appendLog = (file, text) => {
  if (!existsSync(file)) {
    writeFileSync(file, '')
  }
  appendFileSync(file, text)
}

/** 截图直接落证据目录（headless 模拟器上 CDP 截图会复用旧帧，所以走 screencap）。 */
export const screencap = (file) => {
  writeFileSync(file, adbBuffer(['exec-out', 'screencap', '-p']))
  return file
}

/** uiautomator dump：老 WebView 上 CDP 可能连不上，这是最底线的「页面上到底有没有字」证据。 */
export const uiTree = () => {
  try {
    shell('uiautomator', 'dump', '/sdcard/window_dump.xml')
    return shell('cat', '/sdcard/window_dump.xml')
  } catch (error) {
    return `<uiautomator dump 失败：${error.message}>`
  }
}

/** uiautomator XML 里所有 text 属性的值（用于判断「页面上到底显示了什么」）。 */
export const uiTexts = (xml) =>
  [...xml.matchAll(/text="([^"]*)"/g)].map((match) => match[1]).filter((text) => text.length > 0)

/** 内存：`dumpsys meminfo <pkg>` 的 TOTAL PSS 行原文。 */
export const meminfoTotal = () => {
  try {
    const text = shell('dumpsys', 'meminfo', PACKAGE)
    const line = text.split(/\r?\n/).find((row) => /^\s*TOTAL\s+PSS:/.test(row))
    const pss = /TOTAL\s+PSS:\s*(\d+)/.exec(text)
    return { totalPssKb: pss ? Number(pss[1]) : null, line: line?.trim() ?? null }
  } catch (error) {
    return { totalPssKb: null, line: `dumpsys meminfo 失败：${error.message}` }
  }
}

export const pidOf = () => {
  try {
    return shell('pidof', PACKAGE).trim() || null
  } catch {
    return null
  }
}

export const installApk = () => {
  const started = Date.now()
  const output = adb(['install', '-r', '-g', APK])
  return { elapsedMs: Date.now() - started, output, apk: APK }
}

/** 冷启动：force-stop → 清 logcat → am start，返回启动耗时。 */
export const coldStart = (activity = '.MainActivity') => {
  try {
    shell('am', 'force-stop', PACKAGE)
  } catch {
    // 没装也算失败在下一步
  }
  // API 26 的 `adb shell logcat -c` 会报 "failed to clear the 'main' log"，改用宿主侧 adb logcat -c
  let clearError = null
  try {
    adb(['logcat', '-c'])
  } catch (error) {
    clearError = String(error.message || error).slice(0, 200)
  }
  const started = Date.now()
  const output = shell('am', 'start', '-W', '-n', `${PACKAGE}/${activity}`)
  return { elapsedMs: Date.now() - started, output, clearError }
}

/** 关掉动画，避免把动画时长算进「多久出画面」。 */
export const calmDown = () => {
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    try {
      shell('settings', 'put', 'global', key, '0')
    } catch {
      // 老系统没有 animator_duration_scale
    }
  }
}
