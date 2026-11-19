/** `pnpm run check:container` —— 守住 #214：布局决策不依赖容器查询（Chromium 105）。
 *
 * 判定口径与理由见 `scripts/lib/containerQueryAudit.mjs` 顶部注释。两道关：
 *  1. **本仓约定：`src/**` 里 `@container` / `container-type` 一律为 0**。运行时下限是 WebView 83
 *     （Chromium 83），那里 `@container` 是未知 at-rule → 整块丢弃，`container-type` 是未知声明 →
 *     整条丢弃；两个方向都会让「按容器宽度改布局」静默失效。缩略图宽度这类我们自己给定的值，
 *     判据直接写在类 / 自定义属性上，不需要浏览器去量。
 *  2. 就算将来真要写容器查询，审计也会逐块检查「块内的每条声明在块外有同一选择器的基线」，
 *     缺了就失败（`@supports` 里包一层、外面空着的写法同样失败，即 #173 教育过的错法）。
 */

import { fileURLToPath } from 'node:url'

import { auditContainerQuery } from './lib/containerQueryAudit.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const result = await auditContainerQuery(SRC)
console.log(
  `扫描 ${result.files} 个源文件（含容器查询字样的 ${result.scannedWithHit} 个）：`
    + `@container / container-type 共 ${result.occurrences.length} 处，缺基线 ${result.missing.length} 处`,
)
for (const item of result.occurrences) {
  const where = item.file ? `${item.file}:${item.line}` : `:${item.line}`
  console.log(`  命中 ${where}  ${item.selector}  → ${item.shape}`)
}

if (result.missing.length > 0) {
  console.error('\n容器查询缺少「不依赖它」的等价实现（Chromium 83 上整块/整条被丢弃 → 布局决策静默消失）：')
  for (const item of result.missing) {
    console.error(`  ${item.file}:${item.line}  ${item.selector}\n      ${item.why}`)
  }
}

if (result.missing.length > 0 || result.occurrences.length > 0) {
  if (result.occurrences.length > 0) {
    console.error(
      `\n${result.occurrences.length} 处容器查询：本仓运行时下限是 WebView 83（Chromium 83），`
        + '`@container` 整块丢弃。要「窄了就换布局」请把判据写在类或自定义属性上（见 #214 的修法）。',
    )
  }
  process.exit(1)
}
console.log('OK：src 里没有容器查询，布局决策都不依赖 @container / container-type')
