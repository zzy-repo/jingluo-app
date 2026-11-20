// 负向对照 fixture（Issue #369）——`type` 门禁（`tsc -p tsconfig.json`）的必错输入。
//
// 这一行必须让 tsc 报 TS2322（string 赋给 number）。tsconfig.json 只 include `src` 与
// `rspack.config.ts`，所以本文件平时躺在 tests/ 下**不会被 tsc 扫到**（不会污染门禁正例）；
// 用例 `tests/unit/gate-negative-controls.test.mjs` 把它拷成 `src/__gate-neg-type-probe.ts`
// 再跑真门禁，跑完删掉。
//
// 别改成「语法错」：语法错连 swc/rspack 也会红，就分不清是 type 门禁抓到的还是构建抓到的。
// 这里要的是**纯类型错**（语法合法、类型不合法），这样红只能归因于 tsc。
export const answer: number = 'not a number'
