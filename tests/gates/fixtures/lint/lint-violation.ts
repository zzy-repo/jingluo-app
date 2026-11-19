// 负向对照 fixture（Issue #369）——`lint` 门禁（`oxlint src rspack.config.ts`）的必错输入。
//
// `debugger` 命中 .oxlintrc.json 里的 `no-debugger: error`（CI 里 lint 步骤不带 --warn，
// 所以这是硬红）。本文件放在 tests/ 下不在 lint 的扫描范围（`oxlint src rspack.config.ts`），
// 用例会把它拷成 `src/__gate-neg-lint-probe.ts` 再跑真门禁。
//
// 刻意做成「类型合法、只违反 lint」：这样 lint 红不会被 tsc 也拦下而模糊归因
// （tsc 对 debugger 语句不报错，见 tests/unit/gate-negative-controls.test.mjs 的连带断言）。
export const keep = (input: string): string => {
  debugger
  return input
}
