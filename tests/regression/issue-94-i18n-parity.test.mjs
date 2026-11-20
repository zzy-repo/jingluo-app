// [layer: regression | 依赖: 无（纯 Node） | Issue #94（关联 #75 / #115）]
//
// 回归对象：**中英文案表必须逐键对齐**，以及积分展示文案不许硬编码中文（#94）。
//
// 修复前症状（#94 / #75）：formatPoints 把「积分」写死在代码里，英文界面也显示中文；
//   zh/en 两张表的键数量还不一致，切到英文就有键缺失（渲染出 key 原文或空字符串）。
// 修复后预期：zh 与 en 的键集合双向相等、同一键的占位符集合一致；
//   formatPoints 的货币单位由调用方（文案表）给，英文下不出现中文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { formatPoints } = await import('../../src/services/ours/api.ts')

const placeholdersOf = (text) => [...new Set(String(text).match(/\{(\w+)\}/g) ?? [])].sort()

test('#94 zh / en 键集合双向相等（缺一个键 = 英文界面渲染出 key 原文）', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.ok(zhKeys.length >= 500, `文案表规模异常：${zhKeys.length} 个键`)
})

test('#94 同一键的占位符集合一致（少了 {percent} 这类就会显示成「已下载 %」）', () => {
  const mismatched = []
  for (const [key, zhText] of Object.entries(zh)) {
    const enText = en[key]
    if (enText === undefined) continue
    const zhSlots = placeholdersOf(zhText)
    const enSlots = placeholdersOf(enText)
    if (zhSlots.join(',') !== enSlots.join(',')) {
      mismatched.push({ key, zh: zhSlots, en: enSlots })
    }
  }
  assert.deepEqual(mismatched, [])
})

test('#94 两条语言表都不能有空文案（空串等于界面上一片空白）', () => {
  const empty = [...Object.entries(zh), ...Object.entries(en)]
    .filter(([, text]) => String(text).trim() === '')
    .map(([key]) => key)
  assert.deepEqual(empty, [])
})

test('#94 formatPoints 的单位由调用方给，英文下不出现中文单位（#487：元口径）', () => {
  assert.equal(formatPoints(300, '元'), '3.00 元', '100 积分 = 1 元')
  assert.equal(formatPoints(300, 'CNY'), '3.00 CNY', 'en 单位由文案表给')
  assert.equal(formatPoints(300, ''), '¥3.00', '单位为空时退回带符号的金额（不在代码里塞单位）')
  assert.ok(!formatPoints(300, 'CNY').includes('积分'))
})
