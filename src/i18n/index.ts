import { INTERNAL_BUILD } from '../services/api/internalBuild.js'
import { useSettings, type Locale } from '../services/settings.js'
import { en } from './en.js'
import { zh } from './zh.js'

export type TranslationKey = keyof typeof zh
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && Object.hasOwn(zh, key)

/**
 * 缺 key 时给用户看的兜底文案（#314）。
 *
 * 三条约束：
 * 1. **不抛错**：以前 `messages[key].replace(...)` 在缺 key 时抛 `TypeError`，错误里没有 key 名，
 *    整页还会被 ErrorBoundary 换掉；
 * 2. **不跨语言借原文**：缺 zh 就去 en 里找同 key 顶上，等于把英文原文丢给中文用户（与 #324 同口径）。
 *    所以这里用固定中文兜底 —— 缺就是缺，key 名只进日志；
 * 3. **内测包可辨识**：`⟦missing:<key>⟧` 只在 `INTERNAL_BUILD` 下出现，一眼看出是文案缺失；
 *    正式包不把 key 名端给用户。
 */
export const MISSING_TEXT = '内容暂时无法显示'

/**
 * 采集层的保留窗就是 30 分钟（`collector.ts` 的 `RETENTION_MS`）：
 * 同一个 (locale, key[, param]) 在窗口内只报一次，避免一次渲染循环刷爆日志。
 */
const REPORT_WINDOW_MS = 30 * 60 * 1000

/** 缺 key / 缺占位符：两种 miss 分开记，便于统计「文案缺失」和「调用方没传参」 */
export type MissingReason = 'missing_key' | 'missing_param'

type ReportMeta = Record<string, string | number | boolean>
type Reporter = (msg: string, meta: ReportMeta) => void

let reporter: Reporter | null = null
let loading: Promise<void> | null = null

/**
 * 懒加载采集层（#314）。
 *
 * 不在顶层静态 import collector：i18n 几乎被所有组件与单测导入，静态拉进来会连带 `idb` /
 * `@capacitor/core` 和构建期常量 `__ENDPOINTS__`（`diagnostics/config.ts` 顶层读它）——
 * 纯 Node 用例裸跑就会 `ReferenceError`。懒加载后：打包产物里 collector 已由 `main.tsx` 静态加载，
 * 这里拿到的是同一个模块实例，不会多一次请求；没有采集层的环境（裁剪构建 / 单测）静默降级。
 */
const loadReporter = (): Promise<void> => {
  loading ??= import('../services/diagnostics/collector.js')
    .then(({ record }) => {
      reporter = (msg, meta) => {
        record('warning', 'warn', msg, meta)
      }
    })
    .catch(() => {
      // 日志通道自身不可用：记录失败绝不能再把界面带崩
      reporter = null
    })
  return loading
}

/** 测试与排查用：等懒加载的采集通道就绪（生产无需显式调用，记录会自己落） */
export const whenI18nReportsReady = (): Promise<void> => loadReporter()

/** 窗口内已上报过的 (reason, locale, key, param)：值 = 上次上报的时间戳 */
const reportedAt = new Map<string, number>()

const shouldReport = (id: string): boolean => {
  const now = Date.now()
  // 顺手清掉窗口外的旧记录：规模由「运行时出现过的坏 key 数」决定，正常只有个位数
  for (const [seen, at] of reportedAt) {
    if (now - at >= REPORT_WINDOW_MS) {
      reportedAt.delete(seen)
    }
  }
  const last = reportedAt.get(id)
  if (last !== undefined && now - last < REPORT_WINDOW_MS) {
    return false
  }
  reportedAt.set(id, now)
  return true
}

/**
 * 缺 key / 缺占位符的唯一上报入口。
 * - key 是代码里的常量或归档字段（标识符），不含用户正文，可原样记；
 * - param 只记**参数名**，不记参数值；
 * - 字段名用 `i18nKey` 而不是 `key`：采集层的密钥字段过滤会把名为 `key` 的字段整条丢掉
 *   （`diagnostics/fields.ts` 的 `SECRET_SEGMENTS`），那样日志里就又没有 key 名了。
 */
const report = (reason: MissingReason, key: string, param?: string): void => {
  const locale = currentLocale()
  if (!shouldReport(`${reason}::${locale}::${key}::${param ?? ''}`)) {
    return
  }
  const meta: ReportMeta = {
    stage: 'i18n',
    reason,
    i18nKey: key,
    locale,
    ...(param === undefined ? {} : { param }),
  }
  const msg = reason === 'missing_key' ? 'i18n key missing' : 'i18n param missing'
  if (reporter !== null) {
    reporter(msg, meta)
    return
  }
  void loadReporter().then(() => reporter?.(msg, meta))
}

/** 显式上报一次缺 key（调用方拿到的字符串不可信、又不想查表时用，例如归档里的 reason） */
export const reportMissingKey = (key: unknown): void => {
  report('missing_key', String(key))
}

const missingKeyText = (key: unknown): string =>
  INTERNAL_BUILD ? `⟦missing:${String(key)}⟧` : MISSING_TEXT

const fill = (
  template: string,
  params: TranslationParams | undefined,
  key: TranslationKey
): string =>
  template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const value = params?.[name]
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }
    // 占位符没填上也别再静默把「共 {total} 笔」端给用户（#314）
    report('missing_param', String(key), name)
    return placeholder
  })

const createTranslate =
  (messages: Record<TranslationKey, string>) =>
  (key: TranslationKey, params?: TranslationParams): string => {
    const template = messages[key]
    if (typeof template !== 'string') {
      // 缺 key 的唯一定义点：不抛错、不查别的语言，报告后返回兜底
      report('missing_key', String(key))
      return missingKeyText(key)
    }
    return fill(template, params, key)
  }

const translators = {
  'zh-CN': createTranslate(zh),
  'en-US': createTranslate(en),
} as const

const currentLocale = (): Locale => useSettings.getState().locale

/** 组件订阅语言变化；普通函数在调用时读取当前语言。 */
export const useTranslate = () =>
  useSettings((state) => translators[state.locale] ?? translators['zh-CN'])

export const translate = (key: TranslationKey, params?: TranslationParams): string =>
  translators[currentLocale()](key, params)

/**
 * 外部来源的 key：跨版本持久化的 `localMessage`、归档里的 `reason`、注入的 toast 对象 ——
 * 类型上写着 `TranslationKey`，运行时却可能来自别的版本 / 第三方构造的包。
 * 先校验再查表；不认识就走 miss 上报 + 兜底，绝不再把未校验字符串直接丢给 `translate()`。
 */
export const translateUntrusted = (key: unknown, params?: TranslationParams): string => {
  if (isTranslationKey(key)) {
    return translate(key, params)
  }
  reportMissingKey(key)
  return missingKeyText(key)
}

/** 与 `useTranslate` 同一订阅，但接受不可信 key：未识别时上报 + 兜底（Toast 这类注入点用） */
export const useUntrustedTranslate = () => {
  const t = useTranslate()
  return (key: unknown, params?: TranslationParams): string =>
    isTranslationKey(key) ? t(key, params) : translateUntrusted(key, params)
}
