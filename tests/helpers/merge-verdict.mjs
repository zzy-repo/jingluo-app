// 合并批次「单文件结局」的唯一判定入口（Issue #501，P0）。
//
// 抽成一个纯函数，是为了让「判定规则」能被单独钉住：`tests/unit/runner-verdict-self-check.test.mjs`
// 有一条负向对照，把这里改回 #501 之前的旧逻辑（只看 `test()` 的 promise）→ 自检必须变红。
// 规则散在 merged-entry 的 if 里时，这种对照只能靠人肉 review，等于没有。
//
// ## 输入
//
//   · `tracked`：我们自己的记账（`merged-tracker.mjs`）。用例体抛出来的错误现在会被捕获
//     （#501 的修法），但仍只是**我们的观测**；
//   · `tap`：node 自己 reporter 的判定（`tap.mjs`）。**这才是权威**：钩子抛错、超时、
//     `t.plan` 数量不符、未捕获异常挂到用例上…… 这些我们自己都看不见，node 看得见；
//   · `nodeTest`：这个文件是不是 `node:test` 用例（自收摊脚本没有用例，走退出码）。
//
// ## 规则（顺序有意义）
//
//   1. node 报了红（用例或套件）→ FAIL。**不许**因为我们没观测到就放过；
//   2. 我们观测到用例体抛错 → FAIL（TAP 那边的计数偶尔可能落后，两条都算数）；
//   3. 用例数对不上（node 跑的比我们登记的少，或者一条都没跑）→ FAIL：
//      「少跑了几条」和「跑红了」同样不能当绿，否则删掉一半用例也是绿的；
//   4. 一条用例都没有的 node:test 文件 → EMPTY（EMPTY 在 merged-entry 里算失败，
//      这是 #366 定的口径：空文件不许当绿）；
//   5. 全是 SKIP → SKIP；否则 PASS。
//
// 计数（写进 `<< FILE … tests= pass= fail= skip=`）优先取 TAP：套件与子测试都在里面，
// 比我们的记账完整；TAP 一条都没有（自收摊脚本、或 reporter 没生效）时退回记账值。

/** 该文件「真正的」用例计数：TAP 优先，退回我们的记账 */
export const countsOf = ({ tracked, tap }) =>
  tap && tap.tests > 0
    ? { tests: tap.tests, pass: tap.pass, fail: tap.fail, skip: tap.skip }
    : { tests: tracked.tests, pass: tracked.pass, fail: tracked.fail, skip: tracked.skip }

/** 单文件结局：'PASS' | 'FAIL' | 'SKIP' | 'EMPTY' */
export const verdictOf = ({ tracked, tap, nodeTest, scriptOk = true }) => {
  const counts = countsOf({ tracked, tap })
  // 1) node 的判定是权威：用例红、套件红都算红
  if (tap && (tap.fail > 0 || tap.suiteFail > 0)) return 'FAIL'
  // 2) 我们自己看到的用例体失败
  if (tracked.fail > 0) return 'FAIL'
  // 3) 用例数对不上：node 少跑了 = 有东西没跑到，不许当绿
  if (nodeTest && tap && tap.tests < tracked.tests) return 'FAIL'
  if (nodeTest && !tap && tracked.tests > 0) return 'FAIL'
  // 4) 空文件（node:test 却没有一条用例）不算绿
  if (nodeTest && counts.tests === 0) return counts.skip > 0 ? 'SKIP' : 'EMPTY'
  // 5) 自收摊脚本（不用 node:test）：结局只看它自己的退出码
  if (!nodeTest) return scriptOk ? 'PASS' : 'FAIL'
  if (counts.pass > 0) return 'PASS'
  return counts.skip > 0 ? 'SKIP' : 'PASS'
}

/**
 * 记账与 node 判定不一致时的证据行（`!!` 开头，merged-entry 打到 stdout）。
 * 只用于**看得见**：不一致本身已经让 verdictOf 判红了，这里补上「红在哪几条」。
 */
export const mismatchNotes = ({ tracked, tap }) => {
  const notes = []
  if (!tap) {
    if (tracked.tests > 0) notes.push(`node reporter 没有一条用例记录，但我们登记了 ${tracked.tests} 条 —— 判定不可信`)
    return notes
  }
  if (tap.tests < tracked.tests) {
    notes.push(`node 只跑了 ${tap.tests} 条，我们登记了 ${tracked.tests} 条（${tracked.tests - tap.tests} 条没跑到）`)
  }
  if (tap.fail > tracked.fail) {
    notes.push(`node 报了 ${tap.fail} 条失败，我们只观测到 ${tracked.fail} 条（用例体外的失败：钩子/超时/子用例）`)
  }
  return notes
}
