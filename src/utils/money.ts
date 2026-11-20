/**
 * 金额 / 额度的唯一格式化出口（Issue #487「统一计量单位为元」）。
 *
 * ## 口径（后端 8b12ab2 明确，别自己发明换算）
 *
 * - **1 元 = 1 额度**：`users.balance` / `quota` / `actual_cost` 的 1 个余额单位就是 1 元，
 *   客户端**不做汇率**，也**无 USD 概念**（早前按 sub2api 文档理解的「USD 余额」作废）。
 * - **100 积分 = 1 元**：只有已经废弃的旧邀请 / 卡密服务体系还在用「积分」这个词，
 *   它的 `remaining_points` / `card.points` 折算成元就是除以 100（见 `pointsToYuan`）。
 * - 展示一律两位小数、千分位不随 locale 变（用户对账时按千分位读，别给 `3000`）。
 *
 * ## 为什么币种是「按值渲染」而不是写死 ¥
 *
 * 后端 `{amount, currency}`（以及迁移接口的 `currency:"CNY"`）里的 `currency` 是**数据**，
 * 解析层原样保留、不做判断；只有本文件的 `CURRENCY_SYMBOLS` 把它映射成显示符号。
 * 真出现 `USD` 之类的币种码时按码渲染（`1,234.50 USD`），**不许**用 ¥ 顶替 ——
 * 那是把汇率问题藏进显示层。
 */

/** 默认币种：本仓业务口径就是人民币（元） */
export const DEFAULT_CURRENCY = 'CNY'

/**
 * 币种 → 符号。**只**是显示映射表：解析层不许拿它做判断，界面也不许在别处再写一份。
 *
 * 认不得的币种码故意不给符号（走「数字 + 币种码」），免得把别人的钱标成人民币。
 */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: '¥',
  RMB: '¥',
  JPY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
  SGD: 'S$',
  CAD: 'C$',
  AUD: 'A$',
}

/** 两位小数的「金额数字」：`1234.5` → `1,234.50`（**不含**符号与单位） */
export const formatMoneyValue = (amount: number, digits = 2): string => {
  const value = Number.isFinite(amount) ? amount : 0
  const fixed = Math.abs(value).toFixed(digits)
  const [integer, fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const sign = value < 0 ? '-' : ''
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`
}

/** 币种符号；认不得返回空串（调用方退回「数字 + 币种码」） */
export const currencySymbol = (currency: string): string => {
  const code = currency.trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)
    ? (CURRENCY_SYMBOLS[code] as string)
    : ''
}

/**
 * 金额：`¥1,234.50`。币种认不得时退化成 `1,234.50 ABC`（不猜符号）。
 *
 * @param amount 后端原始数额（1 元 = 1 额度，不换算）
 * @param currency `{amount, currency}` 里的币种码，缺省按人民币
 */
export const formatMoney = (amount: number, currency: string = DEFAULT_CURRENCY): string => {
  const code = currency.trim() === '' ? DEFAULT_CURRENCY : currency.trim().toUpperCase()
  const value = formatMoneyValue(amount)
  const symbol = currencySymbol(code)
  return symbol === '' ? `${value} ${code}` : `${symbol}${value}`
}

/** 元：`¥1,234.50`（1 元 = 1 额度，最常用的那一个） */
export const formatYuan = (amount: number): string => formatMoney(amount, DEFAULT_CURRENCY)

/** 旧体系折算系数：100 积分 = 1 元（后端 8b12ab2） */
export const POINTS_PER_YUAN = 100

/** 旧体系的「积分」 → 元（非法值按 0，不让 NaN 漏到界面上） */
export const pointsToYuan = (points: number): number =>
  Number.isFinite(points) ? points / POINTS_PER_YUAN : 0
