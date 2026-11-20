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
//
// ## #611：INFRA —— 「runner 自己崩了」不是「用例失败」
//
// 背景：CI 曾把下面这一段当**真红（重跑仍红）**上报：
//
//     >> tests/unit/domain05-download-state-machine.test.mjs
//     #   ✓ 206 连续分块…                            ← 用例已经跑出 ✓（断言全过）
//     failureType: 'uncaughtException'
//     error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
//     code: 'ERR_TEST_FAILURE'
//     stack: node:internal/test_runner/runner:354 → FileTest.parseMessage
//
// 同一份代码本地三种跑法（单跑 / `run-layer --case` / 整层 186 文件）全绿 —— 红的是
// **`node --test` 父进程反序列化子进程消息失败**（IPC 通道），不是任何一条断言。
// 把它当成用例失败，等于让人去找一个不存在的产品 bug。
//
// 判据是**三者同时命中**（缺一条都不算，见 `INFRA_IPC_SIGNATURE`）：文案 + `failureType`
// + stack 指向 `node:internal/test_runner`。只命中「文案」是不够的 —— 一条真的断言失败也可能在
// 错误信息里**抄到**这段文案（例如本仓库里就有人用假日志喂判定函数做负向对照），
// 那种情况 stack 一定落在 `tests/…` 上，于是第二、三条不命中，判定仍是 TEST_FAIL。
//
// 行为（`withInfraRetry`，runner 的判定处调用）：
//   · 命中 → 判 `INFRA`，该文件**单独重跑一次**（换一个全新进程，不经合并批次）；
//   · 重跑通过 → 绿，汇总里标 `INFRA-RETRIED`（不进 flaky 登记簿：它不是「碰运气的 flake」）；
//   · 重跑仍是同一个 IPC 签名 → `INFRA-FAIL`：CI 照样红，但结论写清楚「不是用例失败」+ 指向 #611；
//   · 重跑变成**断言红**（签名不在了）→ 按 `TEST_FAIL` 上报（INFRA 不许顺手把真红洗成基础设施问题）。

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

// ───────────────────────── Issue #611：runner 基础设施崩（INFRA） ─────────────────────────

/**
 * 命中判据（三条**同时**成立才算 INFRA）。写成常量是为了让「签名是什么」只有一处定义：
 * 登记簿（`tests/flaky-registry.json` 的 `infraSignatures`）与本文件引用的是同一条，
 * 用例文件只负责喂日志、不负责复述签名。
 */
export const INFRA_IPC_SIGNATURE = Object.freeze({
  /** ① 文案：node 的 v8 反序列化失败（IPC 消息被截断/版本不符） */
  message: 'Unable to deserialize cloned data due to invalid or unsupported version',
  /** ② reporter 的 failureType：这是**未捕获异常**，不是断言失败（断言失败是 `testCodeFailure`） */
  failureType: 'uncaughtException',
  /** ③ stack 必须落在 runner 内部：断言失败的 stack 永远在 `tests/…` 上 */
  stackIncludes: 'node:internal/test_runner',
  /** 指向的 issue：报告里要能一路点到背景与裁决 */
  issue: 611,
})

/** 把「一次跑的全部证据」摊平成一段文本（result / 假日志字符串 / 假日志数组都能喂） */
export const evidenceTextOf = (result) => {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map((item) => evidenceTextOf(item)).join('\n')
  const parts = []
  if (result.error) parts.push(String(result.error))
  if (result.output) parts.push(String(result.output))
  if (result.tail) parts.push(evidenceTextOf(result.tail))
  if (result.stderr) parts.push(evidenceTextOf(result.stderr))
  return parts.join('\n')
}

/**
 * INFRA 判定：返回 `{ infra, checks }`。`checks` 逐条写清楚哪一条命中/没命中 ——
 * 报告里要能回答「凭什么说这是 runner 的问题」，而不是一句「判定为 INFRA」。
 */
export const classifyInfraIpc = (result) => {
  const text = evidenceTextOf(result)
  const checks = [
    { key: 'message', label: `文案「${INFRA_IPC_SIGNATURE.message}」`, ok: text.includes(INFRA_IPC_SIGNATURE.message) },
    {
      key: 'failureType',
      label: `failureType: '${INFRA_IPC_SIGNATURE.failureType}'（未捕获异常，不是断言失败）`,
      ok: new RegExp(`failureType:\\s*['"]?${INFRA_IPC_SIGNATURE.failureType}['"]?`).test(text),
    },
    {
      key: 'stack',
      label: `stack 含 ${INFRA_IPC_SIGNATURE.stackIncludes}（崩在 runner 内部，不在用例里）`,
      ok: text.includes(INFRA_IPC_SIGNATURE.stackIncludes),
    },
  ]
  return { infra: checks.every((check) => check.ok), checks, missing: checks.filter((check) => !check.ok) }
}

/** `INFRA-FAIL` 的结论文案（终端 / `--json` / job summary 共用一份，措辞不许三处不一样） */
export const infraFailNote = () =>
  `INFRA-FAIL（#611）：不是用例失败，属 runner IPC 崩 —— ${INFRA_IPC_SIGNATURE.message}（stack 在 ${INFRA_IPC_SIGNATURE.stackIncludes}）。重跑仍是同一个签名，所以红灯保留；请按 #611 处理 runner，不要改断言。`

/**
 * 命中 INFRA 时的处置：**单独重跑一次**再定性。
 *
 * @param {object} args
 * @param {object} args.result  第一次跑的结果（`{ ok, tail, output, error, … }` 或假日志）
 * @param {() => Promise<object>} args.rerun 单文件重跑（换新进程；caller 负责计数/收日志）
 * @param {(line: string) => void} [args.say] 打点（run-layer 传自己的 `say`）
 * @returns {Promise<{ result: object, infra: 'none'|'retried'|'fail'|'red-after-infra', checks?: object }>}
 *   · `none`           没命中签名（含：本来就是绿的）→ 原样返回，后续判定照旧
 *   · `retried`        命中且重跑通过 → `result.ok = true`、`infraRetried = true`
 *   · `fail`           命中且重跑仍是同一签名 → 仍然红，`infraFail = true`（措辞见 `infraFailNote()`）
 *   · `red-after-infra` 命中但重跑变成**断言红** → 按 TEST_FAIL 上报（不盖章成基础设施问题）
 */
export const withInfraRetry = async ({ result, rerun, say = () => {} }) => {
  const first = classifyInfraIpc(result)
  if (result?.ok || !first.infra) return { result, infra: 'none', checks: first }
  say(`   ⚠ 命中 runner IPC 签名（#611）：${INFRA_IPC_SIGNATURE.message}`)
  say(`   ⟹ 这不是用例失败：崩在 ${INFRA_IPC_SIGNATURE.stackIncludes}（父进程反序列化子进程消息），判 INFRA —— 该文件单独重跑一次定性`)
  const retry = typeof rerun === 'function' ? await rerun() : result
  const second = classifyInfraIpc(retry)
  if (retry?.ok) {
    say('   ↻ INFRA-RETRIED：单文件重跑通过 → 绿（不登记 flaky：这不是碰运气的 flake）')
    return { result: { ...retry, ok: true, infra: 'retried', infraRetried: true }, infra: 'retried', checks: second }
  }
  if (!second.infra) {
    say('   ↻ 单文件重跑不再命中 IPC 签名 → 按**用例失败**（TEST_FAIL）上报：INFRA 不许顺手把真红洗成基础设施问题')
    return { result: retry, infra: 'red-after-infra', checks: second }
  }
  say(`   ✖ ${infraFailNote()}`)
  return {
    result: { ...retry, ok: false, infra: 'fail', infraFail: true, error: infraFailNote() },
    infra: 'fail',
    checks: second,
  }
}
