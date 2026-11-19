import { getRegionName, provinces, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

const locationName = (location: UserLocation | null, locale: Locale): string => {
  if (!location) {
    return ''
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

/**
 * 模型约定的五项信息（日期 / 星期 / 所在地 / 平台 / 语言）；日期与星期使用浏览器本地时区，
 * 避免 UTC 日期跨日。
 *
 * **段数恒定 5，缺项留空段**（#324）。1.4.0-beta.1 起设置页不再暴露「位置信息」，
 * location 通常为 null，当时的实现把这一段整个丢掉，于是发出 `日期,星期,Web,语言` 四段；
 * 官方端点按位置解析，四段直接 400：
 * `latest_reminder must have at least 5 comma-separated fields, got 4`。
 * 该 400 落在 `kind: 'http'` 上、界面只有一句「未知错误」——这就是本单「回复中断/看不懂」的来源，
 * 与错误分类无关，是请求体不合规。空段是上游明确允许的（`location may be empty`）。
 */
export const createLatestReminder = (
  { locale, location }: { locale: Locale; location: UserLocation | null },
  now = new Date()
): string => {
  // 位置缺失只允许变成空段，不能用 filter 把整段删掉（删掉就是四段，见上）
  const parts = [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale) || '',
    'Web',
    translate('latestReminderLanguage'),
  ]
  return parts.map((part) => (typeof part === 'string' && part.trim() !== '' ? part : '')).join(',')
}

/**
 * 历史快照归一化（#324）：已存进会话里的快照可能是修复前写下的四段
 * `日期,星期,平台,语言`（位置那一段被丢掉了）。重发历史时原样带上就还是 400，
 * 所以按「缺的是第三段（所在地）」把它补成空段。
 *
 * 五段及以上一律原样返回：多出来的段由上游自己判，不在这里猜。
 */
export const normalizeReminder = (reminder: string): string => {
  const parts = reminder.split(',')
  if (parts.length >= 5 || parts.length < 4) {
    return reminder
  }
  // 四段：日期 / 星期 / 平台 / 语言 —— 缺的是所在地，插在第三位
  return [parts[0], parts[1], '', parts[2], parts[3]].join(',')
}
