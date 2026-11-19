/** `pnpm run check:gap` —— 守住 #173 的两条规则（issue #173 第 4 项要求）。
 *
 * 1. 不许再用 CSS.supports / @supports 探测 flex gap：WebView 83 上两者都返回 true，
 *    查出来的"支持"是假的，兜底分支不会命中，间距依旧是 0。
 * 2. 每一条 flex 容器上的非零 gap 都必须有对应兜底（或明确记进 SKIP 并写明原因），
 *    新增的 CSS 只要写了 gap 就会被这条检查逼着一起补兜底。
 *
 * #217：扫描范围是全部 `.css`（含非 module 的普通 CSS），输出的「跳过」按形态分组，
 * 免得只看到一个总数看不出跳的是什么。
 */

import { fileURLToPath } from 'node:url'

import { auditFlexGap } from './lib/flexGapAudit.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const result = await auditFlexGap(SRC)
console.log(
  `扫描 ${result.cssFiles} 个 CSS 文件（其中 ${result.cssModules} 个 CSS Module）：已兜底 ${result.covered.length} 条，跳过 ${result.skipped.length} 条`
)
// 跳过的形态分布：不分组的话「跳过 3 条」看不出跳的是哪一类，也无从判断该不该补兜底。
if (result.skipped.length > 0) {
  const groups = new Map()
  for (const item of result.skipped) {
    const key = item.includes('非 flex 容器') ? '非 flex 容器（gap 本就不生效）' : 'SKIP 白名单（见 flexGapRules.mjs）'
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  for (const [key, items] of groups) {
    console.log(`  跳过 ${items.length} 条 —— ${key}`)
    for (const item of items) console.log(`    ${item}`)
  }
}

let failed = false
if (result.forbidden.length > 0) {
  failed = true
  console.error('\n不允许的 gap 能力探测（WebView 83 上会假阳性）：')
  for (const item of result.forbidden) console.error(`  ${item.file} —— ${item.why}`)
}
if (result.missing.length > 0) {
  failed = true
  console.error('\nflex 容器上有 gap 但缺少兜底（跑 node scripts/gen-flex-gap-fallback.mjs 或补 SKIP 原因）：')
  for (const item of result.missing) console.error(`  ${item}`)
}
if (failed) process.exit(1)
console.log('OK：没有假阳性探测，flex gap 全部有兜底')
