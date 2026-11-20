// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #94 → #487
//
// 额度的「单位」必须走 i18n，数值口径必须只有一套：
//   · Issue #94：en 下不许再出现中文「积分」（单位从 `oursPointsUnit` 取）；
//   · Issue #487：维护者要求**统一计量 = 元**（1 元 = 1 额度，无 USD 概念），
//     旧「只显示积分、不做 points → 人民币折算」（#75）作废；折算系数 **100 积分 = 1 元**
//     （后端 8b12ab2）。
//
//   node tests/unit/format-points-i18n.test.mjs
//
// 覆盖：
//   [1] zh/en 两份都有单位 key，键名对齐（zh「元」/ en「CNY」）
//   [2] en：输出含 CNY、不含「积分」/`points`/`$`（额度 / 领取 / 邀请 / 兑换 / 套餐行全部调用点）
//   [3] zh：全部调用点按元口径逐字固定（100 积分 = 1 元）
//   [4] 数值规则：两位小数 + 千分位，非有限数按 0
//   [5] 币种**按值渲染**能力仍在（CNY→¥，其他码不猜符号）—— 解析层不许写死 ¥
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { formatPlanMeta, formatPlanPrice, formatPoints } = await import('../../src/services/ours/api.ts')
const { formatMoney, formatYuan, pointsToYuan } = await import('../../src/utils/money.ts')

const failures = []
let checks = 0
const eq = (actual, expected, label) => {
  checks += 1
  if (actual !== expected) failures.push(`${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}
const ok = (condition, label, detail = '') => {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : `\n  ${detail}`}`)
}

const useLocale = (locale) => useSettings.setState({ locale })
/**
 * 当前语言的金额单位，从 i18n 取（#94 的调用约定：单位由调用方注入，逻辑层不写死）。
 * key 缺失时退回空串，让下面的断言照常跑出真实输出（红），而不是在取 key 时就崩掉。
 */
const unit = () => {
  const table = useSettings.getState().locale === 'en-US' ? en : zh
  return typeof table.oursPointsUnit === 'string' ? translate('oursPointsUnit') : ''
}
const points = (value) => formatPoints(value, unit())

const p1 = { id: 'p1', name: '入门包', price: 3.0, points: 300, currency: 'CNY', enabled: true }

// ---------------------------------------------------------------- [1] 单位 key
console.log('\n[1] zh / en 都有金额单位 key，键名对齐（元 / CNY）')
{
  ok(typeof zh.oursPointsUnit === 'string' && zh.oursPointsUnit !== '', 'zh 有 oursPointsUnit')
  ok(typeof en.oursPointsUnit === 'string' && en.oursPointsUnit !== '', 'en 有 oursPointsUnit')
  eq(zh.oursPointsUnit, '元', 'zh 单位（#487：统一计量为元）')
  const enUnit = typeof en.oursPointsUnit === 'string' ? en.oursPointsUnit : ''
  ok(!enUnit.includes('积分'), 'en 单位不含中文「积分」', `en.oursPointsUnit=${JSON.stringify(en.oursPointsUnit)}`)
  ok(!enUnit.includes('points'), 'en 单位不再是 points（#487）', `en.oursPointsUnit=${JSON.stringify(en.oursPointsUnit)}`)
  eq(pointsToYuan(300), 3, '折算系数 100 积分 = 1 元（后端 8b12ab2）')
}

// ---------------------------------------------------------------- [2] en 无中文 / 无旧口径
console.log('\n[2] en：含 CNY、不含「积分」/points/$（全部调用点）')
{
  useLocale('en-US')
  const rendered = {
    'formatPoints(100)': points(100),
    'formatPoints(300)': points(300),
    'formatPoints(3900)': points(3900),
    'formatPlanMeta(p1)': formatPlanMeta(p1, unit()),
    'oursClaimOk': translate('oursClaimOk', { points: points(300) }),
    'oursQuotaValue': translate('oursQuotaValue', { points: points(100) }),
    'oursInviteOk': translate('oursInviteOk', { points: points(300) }),
    'oursRedeemSuccess': translate('oursRedeemSuccess', { points: points(300) }),
    'oursRedeemDuplicate': translate('oursRedeemDuplicate', { points: points(300) }),
  }
  eq(rendered['formatPoints(300)'], '3.00 CNY', 'en 额度最简文案（300 积分 = 3.00 元）')
  eq(rendered['formatPoints(3900)'], '39.00 CNY', 'en 折算 + 两位小数')
  eq(rendered['formatPlanMeta(p1)'], '¥3.00 · 3.00 CNY', 'en 套餐行')
  eq(rendered['oursClaimOk'], 'Claimed. 3.00 CNY left', 'en oursClaimOk')
  eq(rendered['oursInviteOk'], 'Bound. +3.00 CNY', 'en oursInviteOk')
  eq(rendered['oursRedeemDuplicate'], 'This card code was already redeemed; 3.00 CNY arrived', 'en oursRedeemDuplicate')
  // 红的时候这一行就是真实输出
  console.log(`  en 实际渲染：formatPoints(100) = ${JSON.stringify(rendered['formatPoints(100)'])}`
    + ` / formatPlanMeta = ${JSON.stringify(rendered['formatPlanMeta(p1)'])}`)
  for (const [label, text] of Object.entries(rendered)) {
    ok(!text.includes('积分'), `${label} 在 en 下不含「积分」`, `实际: ${JSON.stringify(text)}`)
    ok(!text.includes('points'), `${label} 在 en 下不含 points（旧口径已作废）`, `实际: ${JSON.stringify(text)}`)
    ok(!text.includes('$') && !text.includes('USD'), `${label} 在 en 下没有美元符号 / USD`, `实际: ${JSON.stringify(text)}`)
    ok(text.includes('CNY'), `${label} 在 en 下含 CNY（单位仍由 i18n 提供）`, `实际: ${JSON.stringify(text)}`)
  }
}

// ---------------------------------------------------------------- [3] zh 元口径
console.log('\n[3] zh：全部调用点按元口径固定（100 积分 = 1 元）')
{
  useLocale('zh-CN')
  eq(points(0), '0.00 元', 'zh 0')
  eq(points(100), '1.00 元', 'zh 100 积分 = 1 元')
  eq(points(300), '3.00 元', 'zh 300 积分 = 3 元')
  eq(points(3900), '39.00 元', 'zh 3900 积分 = 39 元')
  eq(formatPlanPrice(p1), '¥3.00', 'zh 价格文案（币种按值渲染 → ¥）')
  eq(formatPlanMeta(p1, unit()), '¥3.00 · 3.00 元', 'zh 套餐行')
  eq(translate('oursClaimOk', { points: points(300) }), '已领取，剩余 3.00 元', 'zh oursClaimOk')
  eq(translate('oursQuotaValue', { points: points(300) }), '3.00 元', 'zh oursQuotaValue 300')
  eq(translate('oursQuotaValue', { points: points(100) }), '1.00 元', 'zh oursQuotaValue 100')
  eq(translate('oursInviteOk', { points: points(300) }), '绑定成功，+3.00 元', 'zh oursInviteOk')
  eq(translate('oursRedeemSuccess', { points: points(300) }), '兑换成功，+3.00 元', 'zh oursRedeemSuccess')
  eq(
    translate('oursRedeemDuplicate', { points: points(300) }),
    '该卡密此前已兑换，已到账 3.00 元',
    'zh oursRedeemDuplicate'
  )
}

// ---------------------------------------------------------------- [4] 数值规则
console.log('\n[4] 数值格式化规则（两位小数 + 千分位，非有限数按 0）')
{
  useLocale('zh-CN')
  const zhUnit = unit()
  eq(formatPoints(1234.9, zhUnit), '12.35 元', '小数四舍五入到两位')
  eq(formatPoints(1234567, zhUnit), '12,345.67 元', '百万级千分位')
  eq(formatPoints(Number.NaN, zhUnit), '0.00 元', 'NaN → 0')
  eq(formatPoints(Number.POSITIVE_INFINITY, zhUnit), '0.00 元', 'Infinity → 0')
  eq(formatPoints(-500, zhUnit), '-5.00 元', '负数原样（符号在数字上）')
  eq(formatYuan(1234.5), '¥1,234.50', 'formatYuan：¥ 前缀 + 两位小数 + 千分位')
}

// ---------------------------------------------------------------- [5] 币种按值渲染
console.log('\n[5] 币种按值渲染：CNY→¥，其它码照抄、不猜符号（解析层不许写死 ¥）')
{
  eq(formatMoney(12.3, 'CNY'), '¥12.30', 'CNY → ¥')
  eq(formatMoney(12.3, 'cny'), '¥12.30', '币种码大小写不敏感')
  eq(formatMoney(12.3, ''), '¥12.30', '空币种按默认人民币')
  eq(formatMoney(12.3, 'USD'), '$12.30', 'USD 仍按下发的币种码渲染（映射能力保留）')
  eq(formatMoney(12.3, 'XTS'), '12.30 XTS', '认不得的币种码 → 数字 + 码，不猜符号')
}

if (failures.length > 0) {
  console.error(`\nFAIL format-points-i18n：${failures.length}/${checks} 条断言不通过\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS format-points-i18n：${checks} 条断言全通过`)
