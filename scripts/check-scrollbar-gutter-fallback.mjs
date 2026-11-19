/** `pnpm run check:gutter` —— 守住 #216：每一处 `scrollbar-gutter` 都必须有不依赖它的等价实现。
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
    + `已兜底 ${covered.length} 处，缺兜底 ${result.missing.length} 处`,
)
for (const item of covered) {
  console.log(`  OK   ${item.file}:${item.line}  ${item.value}  → ${item.shape}`)
}

if (result.missing.length > 0) {
  console.error('\nscrollbar-gutter 缺少等价回退（Chromium 83 上声明被丢弃 → 滚动条出现时横向跳动）：')
  for (const item of result.missing) console.error(`  ${item.file}:${item.line}  ${item.value}\n      ${item.why}`)
  process.exit(1)
}
console.log('OK：每处 scrollbar-gutter 都有不依赖它的等价实现')
