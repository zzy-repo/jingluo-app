// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s]
//
// 设置页「抖音号」展示项的纯逻辑层（用户直接指定的改动，无 issue）：
//   [1] 复制出去的值就是 shiro_0824 本身（不带 @、不带空白、不与界面文案耦合）
//   [2] 复制成功 / 失败各对应哪个提示（失败必须是 error 类型，不能静默假成功）
//   [3] zh / en 四条文案成对存在且非空，en 里不许混中文
//   [4] 提示 key 真的能翻译出文案（key 写错时这里就红，不用渲染 React）
//
//   node tests/unit/douyin-account.test.mjs
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

const { DOUYIN_ACCOUNT_ID, douyinCopyToast } = await import('../../src/components/settings/douyinAccount.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')

const failures = []
let checks = 0
const eq = (actual, expected, label) => {
  checks += 1
  if (actual !== expected) {
    failures.push(`${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
  }
}
const ok = (condition, label, detail = '') => {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : `\n  ${detail}`}`)
}

const CJK = /[\u4e00-\u9fff]/u

// ---------------------------------------------------------------- [1] 复制值
console.log('\n[1] 复制出去的值')
{
  eq(DOUYIN_ACCOUNT_ID, 'shiro_0824', '抖音号值')
  eq(DOUYIN_ACCOUNT_ID, DOUYIN_ACCOUNT_ID.trim(), '不带首尾空白（复制后粘进搜索框就能用）')
  ok(!DOUYIN_ACCOUNT_ID.startsWith('@'), '不带 @ 前缀（抖音搜索框不认 @）')
  ok(!CJK.test(DOUYIN_ACCOUNT_ID), '值里没有中文')
}

// ---------------------------------------------------------------- [2] 提示对应
console.log('\n[2] 复制成功 / 失败对应的提示')
{
  const success = douyinCopyToast(true)
  const failure = douyinCopyToast(false)
  eq(success.key, 'settingDouyinCopied', '成功提示 key')
  eq(success.type, undefined, '成功提示不是 error')
  eq(failure.key, 'copyFailed', '失败提示 key（复用通用「复制失败」）')
  eq(failure.type, 'error', '失败提示是 error（不静默假成功）')
  ok(Object.keys(success).length === 1, '成功提示只有 key 一个字段', `实际: ${JSON.stringify(success)}`)
}

// ---------------------------------------------------------------- [3] 文案成对
console.log('\n[3] zh / en 文案成对且非空')
const KEYS = ['settingDouyinLabel', 'settingDouyinDescription', 'settingDouyinCopyAria', 'settingDouyinCopied']
for (const key of KEYS) {
  ok(typeof zh[key] === 'string' && zh[key].trim() !== '', `zh 有 ${key}`)
  ok(typeof en[key] === 'string' && en[key].trim() !== '', `en 有 ${key}`)
  ok(!CJK.test(en[key] ?? ''), `en 的 ${key} 不含中文`, `实际: ${JSON.stringify(en[key])}`)
  ok(zh[key] !== en[key], `${key} 中英确实不同`)
}
// en 是 satisfies Record<keyof typeof zh, string>，运行时再兜一遍：两份键集合必须一致
eq(
  Object.keys(en).sort().join(','),
  Object.keys(zh).sort().join(','),
  'zh / en 键集合一致（多一条少一条都会红）'
)

// ---------------------------------------------------------------- [4] 能翻译
console.log('\n[4] 提示 key 能翻译出真实文案')
{
  useSettings.setState({ locale: 'zh-CN' })
  eq(translate(douyinCopyToast(true).key), '抖音号已复制', 'zh 成功提示')
  useSettings.setState({ locale: 'en-US' })
  eq(translate(douyinCopyToast(true).key), 'Douyin ID copied', 'en 成功提示')
}

if (failures.length > 0) {
  console.error(`\nFAIL douyin-account：${failures.length}/${checks} 条断言不通过\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS douyin-account：${checks} 条断言全通过`)
