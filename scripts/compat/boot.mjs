/**
 * 起一台 AVD 并准备好被测环境（装包 + 冷启），留给后续脚本 attach。
 *
 *   node scripts/compat/boot.mjs --avd compat-api30 [--no-install]
 *   node scripts/compat/boot.mjs --api 31 [--no-install]   # AVD 名从 matrix.config.json:avdProfiles 解析
 *   node scripts/compat/boot.mjs --api 31 --dry-run        # 只解析配置 + 校验声明，不启动模拟器
 *
 * 起机后**回验**（issue #278）：`ro.build.version.sdk` 必须等于配置里声明给这台 AVD 的 `api`，
 * WebView 主版本必须落在 `webviewTier` 档 —— 不等就 kill 掉并退出，绝不让后面的脚本在
 * 「另一档内核」上产出证据。这一步才是把「API 级别 × WebView 版本」这个维度变成机器可验证的东西；
 * 改动前它只存在于 README 的散文里（写的是 compat-api31，装的到底是不是 31 没人问过）。
 *
 * 结束时不要自动 kill —— 调用方跑完自己 killEmulator()。
 */
import {
  MatrixConfigError,
  avdProfileByApi,
  avdProfileByName,
  resolveMatrixConfig,
  verifyAvdAgainstProfile,
} from './lib/matrix-config.mjs'
import {
  coldStart,
  devices,
  environment,
  installApk,
  killEmulator,
  sleep,
  startEmulator,
  waitBoot,
} from './lib/device.mjs'

const USAGE =
  '用法：node scripts/compat/boot.mjs (--avd <avdProfiles 里的 name> | --api <NN>) [--no-install] [--dry-run]'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}

const main = async () => {
  const config = resolveMatrixConfig()
  const dryRun = argv.includes('--dry-run')
  const noVerify = argv.includes('--no-verify')
  const avdArg = option('avd')
  const apiArg = option('api')

  const profile = (typeof avdArg === 'string' && avdProfileByName(config, avdArg)) || avdProfileByApi(config, apiArg)
  const avd = (typeof avdArg === 'string' ? avdArg : null) ?? profile?.name ?? null
  if (!avd) {
    console.error(USAGE)
    process.exit(2)
  }
  if (!profile && !noVerify) {
    console.error(`[boot] ${avd} 不在 matrix.config.json:avdProfiles 里：它的 API / WebView 档位无从校验`)
    console.error(
      `[boot] 要么把它加进 avdProfiles（{ "name": "${avd}", "api": <API 级别>, "webviewTier": "<WebView 主版本>" }），要么显式加 --no-verify`
    )
    process.exit(2)
  }

  // 路径解析不出来（没有 SDK / 没有 AVD 目录）就在这里报人话退出，而不是后面 spawnSync 抛 ENOENT
  if (config.problems.length) {
    console.error('[boot] 矩阵配置有问题：')
    for (const problem of config.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const plan = [
    `配置：${config.configPath}`,
    `AVD：${avd}（声明 API ${profile?.api ?? '?'} / WebView ${profile?.webviewTier ?? '?'} 档）`,
    `SDK：${config.sdkRoot}（来源 ${config.sdkRootSource}）`,
    `AVD 目录：${config.avdHome}（来源 ${config.avdHomeSource}）`,
    `端口：${config.daemonPort}`,
    `包名：${config.packageName}`,
  ]
  if (dryRun) {
    console.log('[boot] dry-run（不启动模拟器，只解析配置）：')
    for (const line of plan) console.log(`  ${line}`)
    process.exit(0)
  }

  const idle = devices()
  if (idle.length) {
    console.error(`[boot] 已经有设备在跑：${idle.join(', ')}；串行纪律要求先 kill`)
    process.exit(3)
  }

  startEmulator(avd)
  await waitBoot()
  const device = environment()
  console.log(`WebView 原文行：${device.webViewVersionLine}`)

  const webviewVersion = /versionName=(\S+)/.exec(device.webViewVersionLine)?.[1] ?? device.webViewVersionLine
  const verdict = verifyAvdAgainstProfile(profile, { api: device.sdk, webviewVersionName: webviewVersion }, config)
  if (!verdict.ok) {
    console.error(`[boot] ${avd} 与 matrix.config.json 声明不符，已停止（不继续往下跑）：`)
    for (const failure of verdict.failures) console.error(`  - ${failure}`)
    console.error('[boot] 已 kill 这台模拟器；确认 matrix.config.json:avdProfiles 或换一台 AVD 后重试')
    killEmulator()
    process.exit(4)
  }
  console.log(`[boot] 档位回验通过：API ${device.sdk} / WebView ${webviewVersion}`)

  if (!argv.includes('--no-install')) {
    const installed = installApk()
    console.log(`安装：${String(installed.output).trim().split('\n').pop()}（${installed.elapsedMs}ms）`)
    const started = coldStart()
    console.log(
      `am start -W：${started.elapsedMs}ms${started.clearError ? `（logcat 清空失败：${started.clearError}）` : ''}`
    )
    await sleep(6000)
  }
  const alive = environment()
  console.log(`设备就绪：${alive.model} / Android ${alive.release} / ${alive.webViewVersionLine}`)
}

main().catch((error) => {
  console.error(error instanceof MatrixConfigError ? `[boot] ${error.message}` : `[boot] 失败：${error.message}`)
  process.exit(1)
})
