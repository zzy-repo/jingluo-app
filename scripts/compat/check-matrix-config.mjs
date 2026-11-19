#!/usr/bin/env node
/**
 * 兼容矩阵配置的契约校验（issue #278）。`pnpm run check:matrix` 的第一段。
 *
 * 它回答的问题是「这套矩阵配置还能不能支撑门禁」，不是「兼容性好不好」：
 *   - 截图档位是否覆盖 docs/RELEASE-MANUAL.md 第 8 节要求的档位（`requiredCaptureWidths`）；
 *     少一档就 FAIL —— 不许「某些档位根本没截，但报告里写着两档已覆盖」（#159/#190 那类假绿的复现条件）；
 *   - 每个档位能不能换算成 wm density（`capturePhysicalWidth`）；
 *   - `avdProfiles` 是否非空、AVD 名 / api / webviewTier 是否有重复或写错 ——
 *     「API 级别 × WebView 版本」这个维度只有写进这张表才能被 boot.mjs 回验；
 *   - SDK / AVD 路径能不能解析出来。**默认只算 warning**：CI 上没有 Android SDK，
 *     静态矩阵（第二段 matrix-scan.mjs）不该因此打红；本地要连门一起卡就用 `--require-paths`。
 *
 * 用法：
 *   node scripts/compat/check-matrix-config.mjs [--config <path>] [--require-paths]
 *   MATRIX_CONFIG=<path> node scripts/compat/check-matrix-config.mjs
 *
 * 退出码：0 通过；1 配置不满足契约；2 配置文件读不到 / 不是合法 JSON。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MatrixConfigError, cssProfiles, resolveMatrixConfig, validateMatrixConfig } from './lib/matrix-config.mjs'

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

const main = () => {
  const configPath = flagValue('config') ?? undefined
  const requirePaths = argv.includes('--require-paths')
  const config = resolveMatrixConfig({ configPath })

  console.log(`[matrix] 配置：${path.relative(process.cwd(), config.configPath) || config.configPath}`)
  console.log(
    `[matrix] SDK：${config.sdkRoot ?? '(未解析)'}${config.sdkRootSource ? `（来源 ${config.sdkRootSource}）` : ''}` +
      `  AVD 目录：${config.avdHome ?? '(未解析)'}${config.avdHomeSource ? `（来源 ${config.avdHomeSource}）` : ''}`
  )
  console.log(`[matrix] 包名：${config.packageName}  daemon 端口：${config.daemonPort}`)

  console.log(`[matrix] 截图档位（captureWidths / 契约 requiredCaptureWidths）：`)
  for (const profile of cssProfiles(config)) {
    console.log(
      `  - ${profile.name}：density ${profile.density}（物理宽 ${config.capturePhysicalWidth}）` +
        `${config.requiredCaptureWidths.includes(profile.width) ? '' : '（契约没要求这一档）'}`
    )
  }
  const missing = config.requiredCaptureWidths.filter((width) => !config.captureWidths.includes(width))
  if (missing.length) console.log(`  契约档位没覆盖：${missing.join('、')}`)

  console.log(`[matrix] AVD 档位（avdProfiles）：`)
  for (const profile of config.avdProfiles) {
    console.log(`  - ${profile.name}：API ${profile.api} / WebView ${profile.webviewTier} 档`)
  }

  const report = validateMatrixConfig(config, { requirePaths })
  for (const warning of report.warnings) console.log(`[matrix] warning：${warning}`)
  if (!report.ok) {
    console.error('[matrix] FAIL：矩阵配置不满足契约')
    for (const failure of report.failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log('[matrix] OK：矩阵配置满足契约')
  return 0
}

try {
  process.exit(main())
} catch (error) {
  console.error(error instanceof MatrixConfigError ? `[matrix] ${error.message}` : `[matrix] 失败：${error.message}`)
  process.exit(2)
}
