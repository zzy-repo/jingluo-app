/**
 * 统一能力探测（GitHub issue #209「能力探测替代一切假设」）。
 *
 * 为什么要有这个文件：仓库里到处是「裸判能力」的写法 —— `typeof Object.hasOwn === 'function'`、
 * `CSS.supports('gap', ...)`、`navigator.clipboard?.writeText`、`Capacitor.isPluginAvailable` ——
 * 每处各写一套，判错了也没有痕迹。#173 已经证明最坏的一种错法：**CSS.supports 说支持，渲染是 0**。
 * 所以这里把四类探测收成一组 API，并且在诊断里把结论打出来（`SystemInfo.capabilities`）。
 *
 * 三档可信度，从低到高：
 *   1. `hasApi(path)`        静态：宿主上有没有这个对象/函数。**只能回答「有没有」，不能回答「灵不灵」**；
 *   2. `cssSupports(prop, v)` 静态：`CSS.supports` 的包装。在 WebView 83 上对 flex gap 是假阳性；
 *   3. `verifyCss(...)`      动态：真造一个离屏元素、设样式、**回读**（computed / 几何），
 *                            和期望不一致就是「不支持」—— 只有它能覆盖 `gap` 这一类行为差异。
 *
 * 硬约束（都是被生产事故逼出来的）：
 *   - 产物要跑在 **WebView 83 / Chromium 83** 上：本文件不许用 83 之后才有的内置 API
 *     （`Object.hasOwn` Chrome 93、`structuredClone` 98、`Array.prototype.at` 92 …）。
 *     自己需要「判断属性在不在」时用 `Object.prototype.hasOwnProperty.call` 或 `typeof`；
 *   - **模块顶层不许碰 DOM**：`cssSupports` / `verifyCss` 只在被调用时求值，且结果进缓存。
 *     顶层一 `document.createElement`，整包启动期就从「能跑」被抬成「要 DOM」；
 *   - **同一个 key 只真探一次**：DOM 探针要造元素、量布局，有成本，而且在一次页面生命周期里
 *     宿主能力是常量。缓存是**按 key** 的，所以两处都问 `navigator.clipboard.writeText` 时只探一次；
 *   - 探测不抛错：所有出口都是 `boolean`，宿主怎么缺怎么坏都降级成 `false`。
 *
 * 一处**故意不接**这里：`src/polyfills/legacy.ts` 的 isinstance 探测。它跑在补丁安装之前，
 * 判完马上就把 API 补上；走缓存反而会把「补丁前没有」记成永久结论，诊断里就会谎报缺失。
 */

/** 探针结果缓存：key → 结论。同一次页面生命周期里宿主能力是常量，所以只需要一次真探 */
const cache = new Map<string, boolean>()

/** 仅供测试用：清空缓存，让下一次调用重新真探。**业务代码不要调用** */
export const resetCapabilityCache = (): void => {
  cache.clear()
}

const cached = (key: string, probe: () => boolean): boolean => {
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const value = probe()
  cache.set(key, value)
  return value
}

/** `globalThis` 读一次；不在全局环境（例如某些构建期求值）时给 undefined，不抛 */
const readGlobal = (): Record<string, unknown> | undefined =>
  typeof globalThis === 'undefined' ? undefined : (globalThis as unknown as Record<string, unknown>)

/**
 * 按点路径逐段取值：`'Array.prototype.at'` / `'Intl.Segmenter'` / `'navigator.clipboard.writeText'`。
 *
 * 逐段判存在（不是 `eval`、也不是 `'a.b.c' in globalThis`）：中途某一环缺了、或者是原始值，
 * 立刻返回 undefined。段与段之间沿原型链取，所以 `Array.prototype.at` 这种写法才成立。
 */
const readPath = (path: string): unknown => {
  if (typeof path !== 'string' || path.length === 0) {
    return undefined
  }
  const segments = path.split('.')
  let cursor: unknown = readGlobal()
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment || cursor === undefined || cursor === null) {
      return undefined
    }
    if (typeof cursor !== 'object' && typeof cursor !== 'function') {
      // 断在原始值上：'a.b.c' 里 a.b 是字符串，再往下取一定是假的
      return undefined
    }
    try {
      cursor = (cursor as Record<string, unknown>)[segment]
    } catch {
      // getter 抛错（宿主有的属性会炸）：当作不存在
      return undefined
    }
    if (cursor === undefined) {
      return undefined
    }
  }
  return cursor
}

/**
 * 静态探测：宿主上有没有这个 API。
 *
 * `hasApi('Object.hasOwn')` / `hasApi('Array.prototype.at')` / `hasApi('Intl.Segmenter')`。
 * `null` 与 `undefined` 都算没有（WebView 上确实有 `navigator.clipboard = null` 的版本）。
 *
 * 它**不判断「灵不灵」**：CSS 与行为类能力请用 `cssSupports` / `verifyCss`。
 */
export const hasApi = (path: string): boolean =>
  cached(`api:${path}`, () => {
    const value = readPath(path)
    return value !== undefined && value !== null
  })

/**
 * 静态探测：`CSS.supports(prop, value)`。
 *
 * 没有 `CSS`（老宿主 / 非 DOM 环境）或者 `CSS.supports` 自己抛错时一律 `false`，绝不抛给调用方。
 * **注意：这一档在 WebView 83 上会说谎**（`column-gap` 是 true，渲染是 0），
 * 布局类能力必须再用 `verifyCss` 回读一次。
 */
export const cssSupports = (property: string, value: string): boolean =>
  cached(`supports:${property}:${value}`, () => {
    const host = readGlobal()
    const css = host === undefined ? undefined : (host.CSS as { supports?: unknown } | undefined)
    if (!css || typeof css.supports !== 'function') {
      return false
    }
    try {
      return (css.supports as (prop: string, val: string) => boolean)(property, value) === true
    } catch {
      return false
    }
  })

/** 动态回读回调：探针元素已经在 DOM 里、样式也设好了，返回值就是「这条能力成立吗」 */
export type CssReadback = (element: HTMLElement, view: Window | undefined) => boolean

export type VerifyCssOptions = {
  /** 用哪份 document（测试注入；默认取全局 document） */
  doc?: Document
  /** 探针元素的基础样式（默认离屏绝对定位，不影响布局） */
  baseStyle?: string
}

/** 探针默认挂法：离屏绝对定位，宽高给足，不参与页面布局也不出滚动条 */
const DEFAULT_PROBE_STYLE = 'position:absolute;left:-9999px;top:0;width:100px;height:10px;overflow:hidden'

const normalizeCssValue = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, ' ')

/** `getComputedStyle` 读回某个属性；宿主缺这套 API 或它抛错时给 undefined */
const readComputedValue = (
  element: HTMLElement,
  property: string,
  view: Window | undefined
): string | undefined => {
  try {
    const getStyle =
      view && typeof view.getComputedStyle === 'function'
        ? view.getComputedStyle.bind(view)
        : typeof getComputedStyle === 'function'
          ? getComputedStyle
          : undefined
    if (!getStyle) {
      return undefined
    }
    const read = (getStyle(element) as CSSStyleDeclaration).getPropertyValue(property)
    return typeof read === 'string' ? read : undefined
  } catch {
    return undefined
  }
}

/**
 * 动态回读（issue #209 第 4 项：行为/布局类能力必须**设了再读**）。
 *
 * 造一个离屏元素挂到 `document.body` 上，写入 `property: value`，然后把「读回」交给 `readback`：
 *   - 不传 `readback`：默认走 `getComputedStyle` 读回同名属性、和 `value` 比对（归一化空白与大小写）；
 *   - 传 `readback`：自己量（例如 flex gap 要量几何，computed 会说谎）。
 * 探针无论成功失败都会从 DOM 上摘掉；任何异常都降级成 `false`。
 *
 * 缓存 key 只用 `property` + `value`：同一台宿主的同一对声明，结论是常量。
 * 同一个 `property`/`value` 换不同 `readback` 的写法别再找人加 —— 那是同一条结论的两种量法。
 */
export const verifyCss = (
  property: string,
  value: string,
  readback?: CssReadback,
  options?: VerifyCssOptions
): boolean =>
  cached(`verify:${property}:${value}`, () => {
    const doc = options?.doc ?? (typeof document === 'undefined' ? undefined : document)
    if (!doc || !doc.body || typeof doc.createElement !== 'function') {
      return false
    }
    let element: HTMLElement | undefined
    try {
      element = doc.createElement('div')
      element.setAttribute('aria-hidden', 'true')
      element.style.cssText = options?.baseStyle ?? DEFAULT_PROBE_STYLE
      element.style.setProperty(property, value)
      doc.body.append(element)
      if (readback) {
        return readback(element, doc.defaultView ?? undefined) === true
      }
      const read = readComputedValue(element, property, doc.defaultView ?? undefined)
      return read !== undefined && normalizeCssValue(read) === normalizeCssValue(value)
    } catch {
      return false
    } finally {
      element?.remove()
    }
  })

/** 宿主上的 Capacitor 桥（`@capacitor/core` 求值时会挂到 globalThis 上；没加载就是 undefined） */
const readCapacitor = (): Record<string, unknown> | undefined => {
  const value = readPath('Capacitor')
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 原生插件在不在：包一层 `Capacitor.isPluginAvailable`。
 *
 * 没加载 `@capacitor/core`（纯网页 / 单测）时一律 `false` 且不抛。
 * **这种情况不写缓存**：桥是模块求值时才挂上去的，早问一次不该把答案钉成「永远没有」。
 */
export const hasPlugin = (name: string): boolean => {
  const key = `plugin:${name}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const capacitor = readCapacitor()
  if (!capacitor || typeof capacitor.isPluginAvailable !== 'function') {
    return false
  }
  let available = false
  try {
    available = (capacitor.isPluginAvailable as (pluginName: string) => boolean)(name) === true
  } catch {
    available = false
  }
  cache.set(key, available)
  return available
}

/**
 * 是不是跑在原生壳里（Android/iOS WebView），而不是浏览器。
 *
 * 同样走 `globalThis.Capacitor`：没桥就是 `false`（纯网页），且这种判断不写缓存。
 */
export const isNative = (): boolean => {
  const hit = cache.get('native')
  if (hit !== undefined) {
    return hit
  }
  const capacitor = readCapacitor()
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function') {
    return false
  }
  let native = false
  try {
    native = (capacitor.isNativePlatform as () => boolean)() === true
  } catch {
    native = false
  }
  cache.set('native', native)
  return native
}

/** `CapacitorHttp` 注入脚本（native-bridge.js）里能认出来的痕迹，压缩/minify 都改不到运行时源码 */
const CAPACITOR_HTTP_SOURCE = /CapacitorHttp|CapacitorWebFetch|nativePromise/u

/**
 * `window.fetch` 是不是被 **CapacitorHttp** 换了（Android 下走原生网络栈，CORS / Cookie / 超时语义全变）。
 *
 * 判法：`window.fetch` 还在，但已经不是引擎的 `[native code]`，且源码里带 CapacitorHttp 的痕迹。
 * 故意**不**把「被任何人改过」都算成 `true` —— 诊断自己就在 collector 里包了一层 fetch，
 * 那种包装不是宿主差异，报成 native 会误导排障。
 */
export const isFetchPatched = (): boolean =>
  cached('fetchPatched', () => {
    const host = readGlobal()
    const win = host === undefined ? undefined : (host as { fetch?: unknown }).fetch
    if (typeof win !== 'function') {
      return false
    }
    try {
      const source = Function.prototype.toString.call(win)
      if (source.indexOf('[native code]') !== -1) {
        return false
      }
      return CAPACITOR_HTTP_SOURCE.test(source)
    } catch {
      return false
    }
  })
