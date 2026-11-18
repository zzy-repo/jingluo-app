import { cityNames, regionCodes, regionNameOverrides, provinceNames } from './locationData.js'
import { regionNameFallback } from './regionNameFallback.js'

export { regionCodes } from './locationData.js'

export const provinces = Object.entries(provinceNames).map(([code, name]) => ({
  code,
  name,
  cities: Object.entries(cityNames)
    .filter(([city]) => city.startsWith(code.slice(0, 2)))
    .map(([code, name]) => ({ code, name })),
}))

export type UserLocation = {
  region: string
  province?: string
  city?: string
}

const regions = new Set(regionCodes)

type Locale = 'zh-CN' | 'en-US'

/** `Intl.DisplayNames` 在这里只用到一个方法，按最小形状声明，别把宿主类型绑死 */
type RegionNameFormatter = { of: (code: string) => string | undefined }

type DisplayNamesConstructor = new (
  locales: string[],
  options: { type: 'region' }
) => RegionNameFormatter

/**
 * 惰性取 `Intl.DisplayNames`（GitHub issue #155）。
 *
 * 这条 API 是 Chromium **81** 才有的（WebView 79/80 没有），所以：
 *   - 探测 + 构造都必须留在**函数体内**，不能在模块顶层 `new` —— 顶层一求值就
 *     `Intl.DisplayNames is not a constructor`，整份产物从「80 能跑」被抬到「81 才能跑」；
 *   - 构造失败（半吊子实现、非法 locale）也只当「没有」，退回内建表，绝不把调用方带崩。
 */
const createRegionNameFormatter = (locale: Locale): RegionNameFormatter | null => {
  // 显式跟 undefined 比较这一半是给 `pnpm run check:matrix` 留的锚：压缩后
  // `typeof X === 'function'` 会被翻成 `"function"!=typeof X`，`in` 两侧的空格也会被吃掉，
  // 只剩 `=== void 0` 这种写法静态扫描器还认得出来「这里探测过」。运行时它同样是真探测。
  if (Intl.DisplayNames === undefined || typeof Intl.DisplayNames !== 'function') {
    return null
  }
  try {
    const formatter = new (Intl.DisplayNames as unknown as DisplayNamesConstructor)([locale], {
      type: 'region',
    })
    return typeof formatter.of === 'function' ? formatter : null
  } catch {
    return null
  }
}

/** 只缓存**成功构造**的实例：没有的日子不要记成“永远没有”，宿主哪天补上了就能自愈 */
const regionNameFormatters: Partial<Record<Locale, RegionNameFormatter>> = {}

/** 地区名：原生 Intl → 内建表 → 地区码（最后一步只为「永不空串」兜底） */
const regionName = (code: string, locale: Locale): string => {
  const formatter = regionNameFormatters[locale] ?? createRegionNameFormatter(locale)
  if (formatter) {
    regionNameFormatters[locale] = formatter
    try {
      const name = formatter.of(code)
      if (typeof name === 'string' && name.length > 0) {
        return name
      }
    } catch {
      // 部分实现/极老内核在陌生码上抛 RangeError：掉到内建表
    }
  }
  return regionNameFallback[locale][code] ?? code
}

export const getRegionName = (code: string, locale: Locale): string =>
  regions.has(code) ? (regionNameOverrides[locale][code] ?? regionName(code, locale)) : ''

export const normalizeLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const location = value as Record<string, unknown>
  const { region, province, city } = location
  if (typeof region !== 'string' || !regions.has(region)) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  if (province === undefined) {
    return city === undefined ? { region } : null
  }
  const selectedProvince = provinces.find((item) => item.code === province)
  if (!selectedProvince) {
    return null
  }
  if (city === undefined) {
    return { region, province: selectedProvince.code }
  }
  const selectedCity = selectedProvince.cities.find((item) => item.code === city)
  return selectedCity ? { region, province: selectedProvince.code, city: selectedCity.code } : null
}
