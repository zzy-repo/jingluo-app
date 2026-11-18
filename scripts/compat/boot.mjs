/**
 * 起一台 AVD 并准备好被测环境（装包 + 冷启），留给后续脚本 attach。
 *   node scripts/compat/boot.mjs --avd compat-api30 [--no-install]
 * 结束时不要自动 kill —— 调用方跑完自己 killEmulator()。
 */
import {
  startEmulator,
  waitBoot,
  installApk,
  coldStart,
  environment,
  devices,
  requireIdleHost,
  sleep,
} from './lib/device.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}
const AVD = option('avd')
if (!AVD) {
  console.error('用法：node scripts/compat/boot.mjs --avd compat-api30 [--no-install]')
  process.exit(2)
}

const idle = devices()
if (idle.length) {
  console.error(`已经有设备在跑：${idle.join(', ')}；串行纪律要求先 kill`)
  process.exit(3)
}

startEmulator(AVD)
await waitBoot()
const device = environment()
console.log(`WebView 原文行：${device.webViewVersionLine}`)
if (!argv.includes('--no-install')) {
  const installed = installApk()
  console.log(`安装：${String(installed.output).trim().split('\n').pop()}（${installed.elapsedMs}ms）`)
  const started = coldStart()
  console.log(`am start -W：${started.elapsedMs}ms${started.clearError ? `（logcat 清空失败：${started.clearError}）` : ''}`)
  await sleep(6000)
}
const alive = environment()
console.log(`设备就绪：${alive.model} / Android ${alive.release} / ${alive.webViewVersionLine}`)
