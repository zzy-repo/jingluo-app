/** `pnpm run check:focus` —— 守住 #215：每一处 `:focus-visible` 都必须有 `:focus` 兜底（+ 现代内核收回）。
 *
 * `:focus-visible` 首支持 Chromium 86，运行时下限是 Chromium 83：低内核上整条选择器无效、整条规则
 * 被丢弃，键盘用户在当前元素上什么都看不到。判定口径与理由见 `scripts/lib/focusVisibleAudit.mjs`。
 */

import { fileURLToPath } from 'node:url'

import { auditFocusVisible } from './lib/focusVisibleAudit.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const result = await auditFocusVisible(SRC)
const covered = result.occurrences.filter((item) => item.problems.length === 0)
console.log(
  `扫描 ${result.files} 个源文件（CSS ${result.scannedCss} 个）：`
    + `:focus-visible ${result.occurrences.length} 处，已兜底 ${covered.length} 处，缺兜底 ${result.problems.length} 处`,
)
for (const item of result.occurrences) {
  const mark = item.problems.length === 0 ? 'OK  ' : 'FAIL'
  const at = item.atRules.length === 0 ? '' : `  [${item.atRules.join(' ')}]`
  console.log(`${mark} ${item.file}:${item.line}  ${item.selector}${at}`)
}

if (result.problems.length > 0) {
  console.error('\n:focus-visible 缺少 :focus 兜底（Chromium 83 上整条规则被丢弃 → 键盘用户看不到焦点）：')
  for (const item of result.problems) console.error(`  ${item.file}:${item.line}  ${item.selector}\n      ${item.why}`)
  process.exit(1)
}
console.log('OK：每处 :focus-visible 都有 :focus 兜底，并用 :focus:not(:focus-visible) 在现代内核收回')
