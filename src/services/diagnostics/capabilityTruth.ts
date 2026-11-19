import { legacyPolyfillReport } from '../../polyfills/legacy.js'
import { cssSupports, hasApi, isFetchPatched, isNative } from '../../utils/capabilities.js'
import { detectFlexGap } from '../../utils/flexGap.js'

/**
 * 运行时能力字段的「两个维度」（GitHub issue #220）。
 *
 * 问题：入口兜底（`src/polyfills/legacy.ts`，main.tsx 的第一个 import）会在任何业务模块求值之前
 * 把 Object.hasOwn / Array.prototype.at / toSorted 这类缺失 API 补上。诊断区块在自己的模块里求值，
 * 一定晚于兜底，所以过去那句 `typeof Object.hasOwn === 'function'` 在 WebView 83 上恒为 true ——
 * 上报的 `capabilities.hasOwn: true` 到底是「内核原生具备」还是「自家兜底补齐」，看报告的人分不出来，
 * 而 `capabilities` 正是排查兼容问题的唯一依据。
 *
 * 做法：把两件事分开记，互不冒充。
 *   - `runtime`：能不能调（含兜底）。等于旧字段语义，永远和线上已发的报告对得上。
 *   - `native`：内核原生是否具备。= runtime 可用 **且** 这个 API 不是兜底装的。
 *   - `polyfilled` / `degradedClones`：兜底自己的台账（`legacyPolyfillReport()`），
 *     直接点名「谁被补过」「structuredClone 降级了几次」。
 *
 * 为什么不「在装兜底之前先探一份基线」：那需要依赖 main.tsx 里 import 的先后顺序（现在只有注释和
 * 单测守着，没有构建期门禁，见 docs/capabilities/api.md §3），而且一旦经由
 * `utils/capabilities.ts` 的 `hasApi()` 探就会按下标缓存 —— 补丁装之前探到的 false 会被永久钉死
 * （#212 就是因此故意不接 legacy.ts）。这里换了个方向：**不猜时间点，读兜底自己的安装台账**。
 * `legacy.ts` 每个 installer 都是「原生在就早退、不在才 define」，`define()` 又只在这时登记名字，
 * 所以 `installed` 天然就是「装之前那份基线」，而且是在唯一能记对的时刻记下来的，跟 import 顺序无关。
 * 本文件全程不碰 `hasApi()` 的缓存键去做原生判定，缓存时序问题也就无从发生。
 */

/** 兜底台账的形状（= `legacyPolyfillReport()` 的返回） */
export type PolyfillReport = {
  installed: string[]
  degradedClones: number
}

/** 一个能力字段的两个维度 + 兜底台账 */
export type CapabilityTruth = {
  /** 能不能调（含入口兜底）：旧的 capabilities 语义，字段名一个不改 */
  runtime: Record<string, boolean>
  /** 内核原生是否具备（扣掉入口兜底装的）：排查兼容问题只认这份 */
  native: Record<string, boolean>
  /** 入口兜底实际装上的 API 名（原生缺失时才会装） */
  polyfilled: string[]
  /** structuredClone 无法深拷贝、按引用降级透传的次数 */
  degradedClones: number
}

/**
 * 诊断字段 → 兜底安装时登记的名字。
 * 只列入口真的会补的 API；不在表里的字段（visualViewport / dvh / clipboard / fetchPatched…）
 * 入口没补过它们，探到什么就是什么，`native` 与 `runtime` 相等。
 */
const POLYFILLED_FIELDS: Record<string, string> = {
  hasOwn: 'hasOwn',
  at: 'at',
  toSorted: 'toSorted',
  structuredClone: 'structuredClone',
  cryptoRandomUUID: 'randomUUID',
  intlSegmenter: 'Segmenter',
}

/**
 * 探「现在能不能调」。
 *
 * #209：能力探测统一收口到 `utils/capabilities.ts`（同一 key 只真探一次，启动期 flexGap 已经量过的
 * 那条直接命中缓存）。这里只读结论，字段名与顺序与上报口径保持一致。
 */
const probeRuntime = (): Record<string, boolean> => {
  const w = typeof window === 'undefined' ? undefined : window
  const capabilities: Record<string, boolean> = {}
  capabilities.toSorted = hasApi('Array.prototype.toSorted')
  capabilities.hasOwn = hasApi('Object.hasOwn')
  capabilities.at = hasApi('Array.prototype.at')
  capabilities.visualViewport = !!w?.visualViewport
  capabilities.dvh = cssSupports('height', '100dvh')
  capabilities.fetchPatched = isFetchPatched()
  capabilities.isNative = isNative()
  capabilities.clipboard = hasApi('navigator.clipboard.writeText')
  capabilities.blobStream = hasApi('Blob.prototype.stream')
  capabilities.intlSegmenter = hasApi('Intl.Segmenter')
  capabilities.intlDisplayNames = hasApi('Intl.DisplayNames')
  capabilities.structuredClone = hasApi('structuredClone')
  capabilities.cryptoRandomUUID = hasApi('crypto.randomUUID')
  // flex gap 只能量（CSS.supports 在 WebView 83 上假阳性，见 #173）：复用启动期那次实测的缓存
  capabilities.flexGapVerified = typeof document === 'undefined' ? false : detectFlexGap(document)
  return capabilities
}

/**
 * 读一次能力快照。
 * @param report 兜底台账；默认读真实模块的 `legacyPolyfillReport()`（测试可注入以模拟不同宿主）
 */
export const readCapabilityTruth = (
  report: PolyfillReport = legacyPolyfillReport()
): CapabilityTruth => {
  const runtime = probeRuntime()
  const installed = new Set(report.installed)
  const native: Record<string, boolean> = {}
  for (const field of Object.keys(runtime)) {
    const polyfillName = POLYFILLED_FIELDS[field]
    const available = runtime[field] === true
    native[field] =
      polyfillName === undefined ? available : available && !installed.has(polyfillName)
  }
  return {
    runtime,
    native,
    polyfilled: report.installed.slice(),
    degradedClones: report.degradedClones,
  }
}
