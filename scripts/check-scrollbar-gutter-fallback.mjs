/** `pnpm run check:gutter` —— 守住 #216 / #236：每一处 `scrollbar-gutter` 都必须有不依赖它的等价实现，
 * 每一个「媒体查询里靠 auto 才长滚动条」的容器也必须为 classic 滚动条环境做过处置。
 *
 * `scrollbar-gutter` 首支持 Chromium 94，运行时下限是 Chromium 83：低内核上这条声明被整条丢弃，
 * 槽位退回动态，滚动条出现/消失时内容横向跳动。所以每一处都要有「槽位恒宽」的等价实现，
 * 判定口径与理由见 `scripts/lib/scrollbarGutterAudit.mjs` 顶部注释。
 */

import { fileURLToPath } from 'node:url'

import { auditScrollbarGutter } from './lib/scrollbarGutterAudit.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const result = await auditScrollbarGutter(SRC)
const covered = result.occurrences.filter((item) => item.shape !== 'missing')
console.log(
  `扫描 ${result.files} 个源文件（含 scrollbar-gutter 的 ${result.scannedWithHit} 个）：`
    + `已兜底 ${covered.length} 处，缺兜底 ${result.missing.length} 处；`
    + `窄屏换手容器 ${result.containers.length} 个，未处置 ${result.uncoveredContainers.length} 个`,
)
for (const item of covered) {
  console.log(`  OK   ${item.file}:${item.line}  ${item.value}  → ${item.shape}`)
}
for (const item of result.containers) {
  if (item.scopedReserve && item.scopedWithdraw) {
    console.log(`  OK   ${item.file}:${item.line}  ${item.selector}  → 指针作用域常驻槽位 + @supports 收回`)
  }
}

if (result.missing.length > 0) {
  console.error('\nscrollbar-gutter 缺少等价回退（Chromium 83 上声明被丢弃 → 滚动条出现时横向跳动）：')
  for (const item of result.missing) console.error(`  ${item.file}:${item.line}  ${item.value}\n      ${item.why}`)
  process.exit(1)
}

if (result.uncoveredContainers.length > 0) {
  console.error('\n窄屏换手滚动容器没为 classic 滚动条环境做处置（滚动条出现时整列消息重新折行）：')
  for (const item of result.uncoveredContainers) {
    console.error(`  ${item.file}:${item.line}  ${item.selector}  媒体查询：${item.media}\n      ${item.why}`)
  }
  process.exit(1)
}

console.log('OK：每处 scrollbar-gutter 都有不依赖它的等价实现，每个换手容器都做了槽位处置')
