// `node:test` 的 TAP 报告解析（`--test-reporter=tap`）。
//
// ## 为什么必须看它（#501，P0）
//
// 合并批次里「这条用例红了没有」**不能**靠 `test()` 返回的 promise：断言失败时它依然 fulfilled
// （红只体现在 node 自己的报告里），于是 `assert.equal(1, 2)` 被判成 pass —— unit 层假绿的源头。
// 也不能只看进程退出码：一个进程跑 N 个文件，退出码归因不到「哪个文件红」。
//
// TAP 是 **node 自己**给出的结构化判定：每条用例一行 `ok|not ok N - 名字`，跳过/待办带
// `# SKIP|# TODO 原因`，套件（`describe`）的 `type: 'suite'` 在紧随其后的 YAML 块里。
// 记账逻辑读它，就不存在「我们以为是绿」：判红的依据和 node 打印的是同一份数据。
//
// ## 输入形态
//
// 由 `--test-reporter=tap --test-reporter-destination=<file>` 写进**单独的文件**（不进 stdout）：
// 合并入口的 stdout 里还有自己的 `>> FILE` / `<< FILE` 框架行与自收摊脚本的输出，混在一起
// 既会把人类可读的日志变成两倍，也让「哪一行是 node 的判定」变得二义。
//
// TAP 片段示例：
//
//   TAP version 13
//   # Subtest: my suite
//       # Subtest: in-suite-bad
//       not ok 2 - in-suite-bad
//         ---
//         type: 'test'
//         ...
//   not ok 1 - my suite
//     ---
//     type: 'suite'
//     ...
//   ok 4 - top-skip # SKIP why

/** `ok 1 - 名字` / `    not ok 2 - 名字 # SKIP 原因`（子测试按 TAP 缩进） */
const RESULT = /^(\s*)(not ok|ok)\s+(\d+)\s+-\s+(.*)$/
/** 结果行后面 YAML 块里的类型声明 —— 套件靠它区分（套件不是用例，不能算进用例数） */
const YAML_TYPE = /^\s*type:\s*'(test|suite)'\s*$/
/** YAML 块结束 */
const YAML_END = /^\s*\.\.\.\s*$/
/** 行尾指令（跳过 / 待办） */
const DIRECTIVE = /#\s*(SKIP|TODO)\b\s*(.*)$/i

/**
 * 把一段 TAP 文本解析成逐条事件：
 * `{ ok, kind: 'test'|'suite', name, directive: 'SKIP'|'TODO'|null, reason, depth }`
 */
export const parseTap = (text) => {
  const events = []
  let pending = null
  const flush = () => {
    if (!pending) return
    events.push(pending)
    pending = null
  }
  for (const line of String(text ?? '').split('\n')) {
    const matched = RESULT.exec(line)
    if (matched) {
      // 上一条若没有 YAML 块（跳过、待办、以及没有 details 的行）在这里收口
      flush()
      const raw = matched[4]
      const directive = DIRECTIVE.exec(raw)
      pending = {
        ok: matched[2] === 'ok',
        kind: 'test',
        name: raw.replace(/\s*#\s*(SKIP|TODO)\b.*$/i, '').trim(),
        directive: directive ? directive[1].toUpperCase() : null,
        reason: directive ? directive[2].trim() : '',
        // 缩进层级（子测试 / 套件里的用例）
        depth: Math.floor(matched[1].replace(/\t/g, '    ').length / 4),
      }
      continue
    }
    if (!pending) continue
    const type = YAML_TYPE.exec(line)
    if (type) { pending.kind = type[1]; continue }
    if (YAML_END.test(line)) flush()
  }
  flush()
  return events
}

/**
 * 汇总成计数。**用例数不含套件**（套件是容器，`describe` 里每条用例都单独计过一次）；
 * 套件自己的失败单列 `suiteFail` —— 套件体抛错、或「子用例全绿但 after 钩子红」时它才是唯一信号。
 */
export const countTap = (events) => {
  const counts = { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, suites: 0, suiteFail: 0 }
  for (const event of events) {
    if (event.kind === 'suite') {
      counts.suites++
      if (!event.ok) counts.suiteFail++
      continue
    }
    counts.tests++
    if (event.directive === 'SKIP') counts.skip++
    else if (event.directive === 'TODO') counts.todo++
    else if (event.ok) counts.pass++
    else counts.fail++
  }
  return counts
}

/** 解析 + 汇总，一步到位 */
export const tapCounts = (text) => countTap(parseTap(text))
