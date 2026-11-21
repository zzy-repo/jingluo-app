/**
 * 兼容下限的**唯一来源**（GitHub issue #276）。
 *
 * 背景：`Chrome 83` 这个数字一度在 6 个地方各写一份 ——
 *   1 `package.json:10` 的 `browserslist`（本来就是唯一来源）
 *   2 `rspack.config.ts` 的 fallback 副本 `['chrome >= 83']`
 *   3 `rspack.config.ts` 的断言里再写一次 `>= 83` 的正则
 *   4 `scripts/compat/probe.mjs` 的 `BASELINE_CHROMIUM = 83` + `PRESET_TARGETS` 再列一份
 *   5 `scripts/fixtures/legacy-api-gate/build-fixtures.mjs:51` 的 `env: { targets: ['chrome >= 83'] }`
 *   6 注释里的文档副本（`src/polyfills/legacy.ts` / `src/index.html`）
 *
 * 抬下限时漏改任何一处，表现都不是「红」，而是**假绿**：`check:legacy` 还在跑，但它量的
 * 不是线上那份产物（夹具按 83 构建、产品按 91 构建），于是「合格」这个结论失去意义。
 *
 * 现在只有 `config/compat.json` 存数字，其余全部派生：
 *   - 构建目标：`browserslistChromeTarget()` / `productBrowserslist()` + `assertBrowserslist()`
 *   - 探针档位：`PROBE_TIERS`（probe.mjs 的 `PRESET_TARGETS`、matrix-scan.mjs 的 `WEBVIEW_TARGETS` 都由它派生）
 *   - Android 下限：`MIN_ANDROID_SDK`
 *   - 一致性门禁：`node scripts/check-compat-baseline.mjs`（`pnpm check:compat-baseline`）
 *
 * 为什么 `package.json` 还留着 `chrome >= 83`：rspack / swc / lightningcss 只吃 browserslist，
 * 没有 JS 化配置的入口。两份共存可以，但**必须有东西保证它们相等** —— 那就是
 * `assertBrowserslist()`（构建期 fail-fast）和 `check-compat-baseline`（门禁）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录 */
export const ROOT = path.resolve(HERE, '..', '..')

/** 唯一来源文件 */
export const COMPAT_CONFIG_FILE = path.join(ROOT, 'config', 'compat.json')

/** 构建目标的载体（rspack / lightningcss 只吃这份 browserslist） */
export const PACKAGE_JSON_FILE = path.join(ROOT, 'package.json')

/** 唯一来源本身有问题时抛这个：**绝不静默退回某个默认数字** */
export class CompatBaselineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CompatBaselineError'
    this.code = 'COMPAT_BASELINE'
  }
}

const requirePositiveInteger = (value, field) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CompatBaselineError(
      `config/compat.json:${field} 必须是正整数，实际：${JSON.stringify(value)}`
    )
  }
  return value
}

/**
 * 读并校验 `config/compat.json`。任何一项不合格都直接抛 CompatBaselineError ——
 * 唯一来源坏了就该让所有下游（构建、探针、门禁）一起明确失败，而不是各自拿默认值继续跑。
 */
export const readCompatConfig = (file = COMPAT_CONFIG_FILE) => {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CompatBaselineError(
      `读不到唯一来源 ${path.relative(ROOT, file)}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (raw === null || typeof raw !== 'object') {
    throw new CompatBaselineError('config/compat.json 必须是一个 JSON 对象')
  }
  const baselineChromium = requirePositiveInteger(raw.baselineChromium, 'baselineChromium')
  // #104：语法下限（产物真实能被解析的最低内核）必须单独声明，不能等于 baselineChromium —— 见
  // `syntaxFloorChromium` 的说明。缺字段直接炸：宁可门禁红，也不要让下游各自猜一个数。
  const syntaxFloorChromium = requirePositiveInteger(raw.syntaxFloorChromium, 'syntaxFloorChromium')
  if (syntaxFloorChromium > baselineChromium) {
    throw new CompatBaselineError(
      `config/compat.json:syntaxFloorChromium（${syntaxFloorChromium}）不能大于 baselineChromium（${baselineChromium}）——` +
        'baseline 是「我们承诺支持的档」，语法下限只会更低；落在这个区间说明工具档位被抬过，先改工具档位'
    )
  }
  const minAndroidSdk = requirePositiveInteger(raw.minAndroidSdk, 'minAndroidSdk')
  if (!Array.isArray(raw.probeTiers) || raw.probeTiers.length === 0) {
    throw new CompatBaselineError('config/compat.json:probeTiers 必须是非空数组')
  }
  const probeTiers = raw.probeTiers.map((tier) => requirePositiveInteger(tier, 'probeTiers[]'))
  if (!probeTiers.includes(baselineChromium)) {
    throw new CompatBaselineError(
      `config/compat.json:probeTiers（${probeTiers.join(', ')}）必须包含 baselineChromium=${baselineChromium}`
    )
  }
  for (let index = 1; index < probeTiers.length; index += 1) {
    if (probeTiers[index] <= probeTiers[index - 1]) {
      throw new CompatBaselineError(
        `config/compat.json:probeTiers 必须严格递增，实际：${probeTiers.join(', ')}`
      )
    }
  }
  return { baselineChromium, syntaxFloorChromium, probeTiers, minAndroidSdk }
}

/** 进程级唯一来源：模块加载时读一次，坏了直接炸 */
export const COMPAT_CONFIG = readCompatConfig()

/** 兼容下限（Chromium 主版本号）：我们**承诺支持**的最低档，兜底页按它判「内核过旧」（issue #104） */
export const BASELINE_CHROMIUM = COMPAT_CONFIG.baselineChromium

/**
 * 产物语法下限（Chromium 主版本号）：构建产物**真实能解析**的最低内核。
 *
 * 为什么它不等于 BASELINE_CHROMIUM（issue #104）：构建目标 `chrome >= 83` 的能力集里
 * **包含 ES2020** —— 可选链 `?.` / 空值合并 `??` 是 Chrome 80 就有的语法，SWC 不会把它们降级。
 * 所以产物一旦用了 `??`（本仓确实用了，`src/app/errorReport.ts:84` 等处），真实语法下限就是 80，
 * 而"承诺支持 83"这句话只对 83+ 成立。80~82 能解析但不在承诺范围；**< 80 直接整包解析失败**
 * （`Uncaught SyntaxError: Unexpected token '?'`），此时唯一还能跑的是 `src/index.html` 的 ES5 兜底守卫。
 *
 * 这个数字的用途只有一个：让兜底页能对用户说清「最低要多少」，而不是让用户"重试"
 * （`src/index.html` 的 `MIN_ENGINE_CHROMIUM`，由 tests/unit/compat-guard-baseline.test.mjs 钉住两边相等）。
 */
export const SYNTAX_FLOOR_CHROMIUM = COMPAT_CONFIG.syntaxFloorChromium

/** 探针 / 矩阵要回答的 WebView 档位 */
export const PROBE_TIERS = COMPAT_CONFIG.probeTiers

/** Android minSdkVersion（与 android/variables.gradle 对齐，门禁会比对） */
export const MIN_ANDROID_SDK = COMPAT_CONFIG.minAndroidSdk

/**
 * browserslist 的 chrome 下限写法 —— 全仓库只有这一处拼这个字符串。
 * 注意这里没有数字字面量：数字只存在于 config/compat.json。
 */
export const browserslistChromeTarget = (chromium = BASELINE_CHROMIUM) => `chrome >= ${chromium}`

/** 构建 target 的期望值（不含其他浏览器：chrome 是唯一有硬约束的那条） */
export const browserslistTargets = () => [browserslistChromeTarget()]

/** 从一组 browserslist 条目里读出全部 chrome 下限数字 */
export const chromeFloorsOf = (targets) =>
  (Array.isArray(targets) ? targets : []).flatMap((target) => {
    const match = /^chrome\s*>=\s*(\d+)$/.exec(String(target).trim())
    return match ? [Number(match[1])] : []
  })

/**
 * 构建期断言：browserslist 必须**恰好**声明一条 chrome 下限，且等于唯一来源。
 *
 * 老写法是 `targets.some(t => /^chrome\s*>=\s*83$/.test(t))` —— 断言自带 83，于是它只能回答
 * 「package.json 里那条字符串是不是还写着 83」，永远回答不了「它是不是还等于唯一来源」；
 * 更糟的是 `targets` 为空时代码会先塞进 fallback `['chrome >= 83']` 再去断言，
 * 于是「browserslist 被人删了」这种最该拦的情形反而通过（断言被自己的 fallback 满足 = 恒真）。
 * 现在数字只从 baseline 来，空列表/两条下限都直接抛。
 */
export const assertBrowserslist = (targets, baseline = BASELINE_CHROMIUM) => {
  const floors = chromeFloorsOf(targets)
  const shown = Array.isArray(targets) && targets.length ? targets.join(', ') : '（空）'
  if (floors.length !== 1) {
    throw new CompatBaselineError(
      `browserslist 应有且只有一条 \`chrome >= N\` 下限（当前：${shown}）—— ` +
        `构建语法下限必须来自唯一来源 config/compat.json:baselineChromium = ${baseline}`
    )
  }
  if (floors[0] !== baseline) {
    throw new CompatBaselineError(
      `browserslist 的 chrome 下限是 ${floors[0]}，但 config/compat.json:baselineChromium = ${baseline} —— ` +
        '两处必须相等，否则构建产物与探针/夹具报告量的不是同一档（issue #276）'
    )
  }
  return floors[0]
}

/**
 * 真实构建目标：`package.json` 的 browserslist，读完顺手断言它没和唯一来源漂开。
 * 夹具（`scripts/fixtures/legacy-api-gate/build-fixtures.mjs`）用它，保证与线上产物同档。
 */
export const productBrowserslist = (file = PACKAGE_JSON_FILE) => {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CompatBaselineError(
      `读不到 ${path.relative(ROOT, file)}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  assertBrowserslist(pkg.browserslist)
  return pkg.browserslist
}
