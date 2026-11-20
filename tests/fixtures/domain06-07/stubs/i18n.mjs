/**
 * i18n 替身：只换「读当前语言」这一层，文案用**真 zh 表**（`src/i18n/zh.ts`）。
 *
 * 这样断言的是用户真会看到的那句话（`oursClaimOk` = 「已领取，剩余 {points}」），
 * 而不是用例自己编的字符串；插值规则照抄 `src/i18n/index.ts` 的 createTranslate。
 */
import { zh } from '../../../../src/i18n/zh.ts'

const interpolate = (template, params) =>
  template.replaceAll(/\{(\w+)\}/gu, (placeholder, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

/** 与生产 `createTranslate(zh)` 等价的翻译函数（缺 key 直接显形，便于断言发现漏配） */
export const translate = (key, params) => interpolate(zh[key] ?? `<missing:${String(key)}>`, params)

export const useTranslate = () => translate

export const useLocale = () => 'zh'
