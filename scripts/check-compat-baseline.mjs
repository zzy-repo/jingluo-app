#!/usr/bin/env node
/**
 * 兼容下限「单一来源」门禁（GitHub issue #276）。
 *
 *   node scripts/check-compat-baseline.mjs        # 或 pnpm check:compat-baseline
 *   node scripts/check-compat-baseline.mjs --json
 *
 * 回答一个问题：**`config/compat.json` 里的数字，是不是真的只有一个来源？**
 *
 * 检查四类：
 *   1 唯一来源自身自洽（字段齐全、probeTiers 严格递增且含 baseline、minSdk 为正整数）；
 *   2 派生点（**行为级**）：真的 import `scripts/compat/probe.mjs` / `scripts/compat/matrix-scan.mjs`，
 *     比它们的运行时导出值，而不是比源码里有没有某句话 —— 「源码里有这句断言」不等于「这句断言会生效」；
 *   3 派生点（**源码级**）：`rspack.config.ts` / probe / matrix-scan / build-fixtures 里不许再出现
 *     `chrome >= 数字`、`chromium数字:`、`BASELINE_*=数字`、档位数字数组这类**写死的副本**。
 *     夹具写死 83 是最坏的一种：门禁还绿，但它量的不是线上那份产物；
 *   4 外部对齐：`android/variables.gradle` 的 minSdkVersion === `minAndroidSdk`（只读比对，不改 android/**）。
 *
 * 退出码：0 合格 / 1 有不一致 / 2 环境不具备（唯一来源读不到）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BASELINE_CHROMIUM,
  MIN_ANDROID_SDK,
  PACKAGE_JSON_FILE,
  PROBE_TIERS,
  ROOT,
  assertBrowserslist,
  chromeFloorsOf,
  readCompatConfig,
} from './lib/compatBaseline.mjs'

/** 仓库内相对路径（报告里统一用 / 分隔） */
export const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** 由唯一来源派生的文件：这些文件里**不许**出现写死的下限数字 */
export const DERIVED_FILES = [
  'rspack.config.ts',
  'scripts/compat/probe.mjs',
  'scripts/compat/matrix-scan.mjs',
  'scripts/fixtures/legacy-api-gate/build-fixtures.mjs',
  'scripts/lib/apiAssumptionAudit.mjs',
  'scripts/lib/cssAssumptionAudit.mjs',
]

/**
 * 「写死的副本」的四种形态。注释里的说明文字不算（会先被 stripComments 抹掉）——
 * 文档里保留「为什么是 83」是有价值的，代码里保留数字才是漂移源。
 */
export const HARDCODED_FLOOR_PATTERNS = [
  {
    id: 'chrome-floor-literal',
    pattern: /chrome\s*>=\s*\d+/g,
    why: '`chrome >= N` 只能由 browserslistChromeTarget() / productBrowserslist() 产出',
  },
  {
    id: 'chromium-preset-key',
    pattern: /chromium\d+\s*:/g,
    why: '探针档位键只能由 PROBE_TIERS 派生（chromium${tier}）',
  },
  {
    id: 'baseline-literal',
    pattern: /BASELINE_CHROME(?:MIUM)?\s*=\s*\d+/g,
    why: '下限常量必须 import 自 scripts/lib/compatBaseline.mjs',
  },
  {
    id: 'tier-array-literal',
    pattern: /(?:WEBVIEW_TARGETS|PRESET_TARGETS|PROBE_TIERS|probeTiers)\s*=\s*\[[^\]]*\d[^\]]*\]/g,
    why: '档位数组必须派生自 config/compat.json:probeTiers',
  },
]

/** 1-based 行列（与 check-bundle-syntax.mjs 的报错口径一致） */
export const positionOf = (text, index) => {
  const upto = text.slice(0, index)
  return { line: upto.split('\n').length, column: index - (upto.lastIndexOf('\n') + 1) + 1 }
}

/**
 * 把注释抹成空格（等长、保留换行），这样偏移量可以直接回算原文行列。
 * 行注释用 `^|[^:\\]` 前缀来避开 `https://` 这类字符串里的双斜杠。
 */
export const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (match, prefix) => prefix + match.slice(prefix.length).replace(/[^\n]/g, ' '))

/** 扫一份源码里有没有写死的下限副本。返回 [{file, line, column, token, id, why}] */
export const scanHardcodedFloors = (source, file) => {
  const code = stripComments(source)
  const hits = []
  for (const { id, pattern, why } of HARDCODED_FLOOR_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(code)
    while (match) {
      const { line, column } = positionOf(code, match.index)
      hits.push({ file, line, column, token: match[0].trim(), id, why })
      pattern.lastIndex = match.index + match[0].length
      match = pattern.exec(code)
    }
  }
  return hits
}

/** 档位集合比较（忽略顺序、忽略重复），返回人话差异描述或 '' */
export const describeTierMismatch = (actual, expected) => {
  const a = [...new Set(actual)].sort((left, right) => left - right)
  const e = [...new Set(expected)].sort((left, right) => left - right)
  return a.join(',') === e.join(',') ? '' : `档位是 [${a.join(', ')}]，唯一来源 probeTiers 是 [${e.join(', ')}]`
}

const importModule = (relativePath) => import(pathToFileURL(path.join(ROOT, relativePath)).href)

/**
 * 跑全套检查。返回 { problems, notes, summary }；`problems` 为空 = 合格。
 * 全部判定都在这里做，CLI 只负责打印与退出码 —— 测试直接调它，测的就是门禁本体。
 */
export const checkCompatBaseline = async () => {
  const problems = []
  const notes = []

  // 1 唯一来源自身
  const config = readCompatConfig()
  notes.push(
    `唯一来源：config/compat.json = { baselineChromium: ${config.baselineChromium}, ` +
      `probeTiers: [${config.probeTiers.join(', ')}], minAndroidSdk: ${config.minAndroidSdk} }`
  )
  const baseline = config.baselineChromium

  // 2a package.json 的 browserslist（唯一还必须共存的那一份）
  let pkg
  try {
    pkg = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf8'))
  } catch (error) {
    problems.push({
      file: 'package.json',
      line: 0,
      message: `读不到 package.json：${error instanceof Error ? error.message : String(error)}`,
    })
    return { problems, notes, summary: null }
  }
  try {
    const floor = assertBrowserslist(pkg.browserslist, baseline)
    notes.push(`package.json: browserslist 的 chrome 下限 = ${floor}（唯一一条，等于唯一来源）`)
  } catch (error) {
    problems.push({
      file: 'package.json',
      line: 0,
      message: `${error instanceof Error ? error.message : String(error)}（browserslist 当前：${
        (pkg.browserslist ?? []).join(', ') || '（缺失）'
      }）`,
    })
  }

  // 2b probe.mjs 的运行时导出（行为级，不看源码文本）
  let probe = null
  try {
    probe = await importModule('scripts/compat/probe.mjs')
    if (probe.BASELINE_CHROMIUM !== baseline) {
      problems.push({
        file: 'scripts/compat/probe.mjs',
        line: 0,
        message: `运行时 BASELINE_CHROMIUM = ${probe.BASELINE_CHROMIUM}，但唯一来源 baselineChromium = ${baseline}`,
      })
    } else {
      notes.push(`scripts/compat/probe.mjs: BASELINE_CHROMIUM = ${probe.BASELINE_CHROMIUM}`)
    }
    const presetValues = Object.values(probe.PRESET_TARGETS ?? {})
    const mismatch = describeTierMismatch(presetValues, config.probeTiers)
    if (mismatch) {
      problems.push({ file: 'scripts/compat/probe.mjs', line: 0, message: `PRESET_TARGETS ${mismatch}` })
    } else {
      notes.push(
        `scripts/compat/probe.mjs: PRESET_TARGETS = ${Object.keys(probe.PRESET_TARGETS).join(' / ')}`
      )
    }
  } catch (error) {
    problems.push({
      file: 'scripts/compat/probe.mjs',
      line: 0,
      message: `import 失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // 2c matrix-scan.mjs 的运行时导出（同一批档位，另一份列表）
  try {
    const matrix = await importModule('scripts/compat/matrix-scan.mjs')
    const mismatch = describeTierMismatch(matrix.WEBVIEW_TARGETS ?? [], config.probeTiers)
    if (mismatch) {
      problems.push({ file: 'scripts/compat/matrix-scan.mjs', line: 0, message: `WEBVIEW_TARGETS ${mismatch}` })
    } else {
      notes.push(`scripts/compat/matrix-scan.mjs: WEBVIEW_TARGETS = [${matrix.WEBVIEW_TARGETS.join(', ')}]`)
    }
  } catch (error) {
    problems.push({
      file: 'scripts/compat/matrix-scan.mjs',
      line: 0,
      message: `import 失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // 3 派生点里不许写死
  let scanned = 0
  for (const file of DERIVED_FILES) {
    let source
    try {
      source = readFileSync(path.join(ROOT, file), 'utf8')
    } catch {
      problems.push({ file, line: 0, message: '派生点文件不存在（清单过期了？）' })
      continue
    }
    scanned += 1
    for (const hit of scanHardcodedFloors(source, file)) {
      problems.push({
        file: hit.file,
        line: hit.line,
        message: `${hit.id} 写死的副本 \`${hit.token}\` —— ${hit.why}`,
      })
    }
  }
  if (!problems.length) notes.push(`派生点 ${scanned} 个文件里没有写死的下限副本`)

  // 4 与 android/variables.gradle 对齐（只读）
  try {
    const gradle = readFileSync(path.join(ROOT, 'android', 'variables.gradle'), 'utf8')
    const match = /minSdkVersion\s*=\s*(\d+)/.exec(gradle)
    if (!match) {
      problems.push({ file: 'android/variables.gradle', line: 0, message: '找不到 minSdkVersion' })
    } else if (Number(match[1]) !== config.minAndroidSdk) {
      problems.push({
        file: 'android/variables.gradle',
        line: 0,
        message: `minSdkVersion = ${match[1]}，但唯一的 config/compat.json:minAndroidSdk = ${config.minAndroidSdk}`,
      })
    } else {
      notes.push(`android/variables.gradle: minSdkVersion = ${match[1]}（等于 minAndroidSdk）`)
    }
  } catch (error) {
    problems.push({
      file: 'android/variables.gradle',
      line: 0,
      message: `读不到：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  return {
    problems,
    notes,
    summary: {
      baselineChromium: baseline,
      probeTiers: config.probeTiers,
      minAndroidSdk: config.minAndroidSdk,
      packageFloors: chromeFloorsOf(pkg.browserslist),
      derivedFiles: DERIVED_FILES.length,
    },
  }
}

const main = async () => {
  const json = process.argv.includes('--json')
  const { problems, notes, summary } = await checkCompatBaseline()
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, summary, problems, notes }, null, 2))
  } else {
    console.log('兼容下限单一来源检查（config/compat.json）')
    for (const note of notes) console.log(`  ✓ ${note}`)
    for (const problem of problems) {
      console.log(`  ✗ ${problem.file}${problem.line ? `:${problem.line}` : ''} ${problem.message}`)
    }
    if (problems.length) {
      console.error(
        `\n结论：不合格 —— ${problems.length} 处与唯一来源不一致；抬/降兼容下限只改 config/compat.json，` +
          '其余派生点会自己跟上（issue #276）'
      )
    } else {
      console.log('\n结论：合格 —— Chrome 下限只有一个来源 config/compat.json，全部派生点与它一致')
    }
  }
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`检查本身失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}
