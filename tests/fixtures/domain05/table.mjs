// 域 5 表驱动用例的共用跑批器。
//
// 为什么自己写一层：本域的最小充分集是「一张表吃掉一族分支」（见 docs/testing/coverage/domain-05.md
// 第六节），每行只有输入与期望不同。用 node:test 的 subtests 会把「9 条用例」膨胀成上百条用例，
// 与维护者口径（用例条数尽量少、覆盖尽量全）相反；所以一条用例内部逐行跑，失败时一次性报出
// 「哪几行红了 + 每行的期望/实际」，定位粒度与一条一行断言一样。
//
// ## #611：**绿的时候不再逐行打印**（表的行数就是日志体积）
//
// 2026-11 CI 上出现过这种红：用例本身跑出了 ✓，但 `node --test` 父进程在
// `FileTest.parseMessage` 抛 `Unable to deserialize cloned data…`（runner 的 IPC 反序列化崩）。
// 触发条件是**链路上跑过的那段数据有多大**，而本文件过去每跑一行就 `console.log('  ✓ 行名')` ——
// 200+ 行的表（如 domain05-download-state-machine 的 206 分块表）在一条用例里就打出上百行，
// 这些 stdout 由 node 的 test runner 收进子进程消息，是该族里最大的一笔固定体积。
// 判定侧的兜底是 helpers/merge-verdict.mjs 的 INFRA 分类（判 INFRA + 单文件重跑，不再是「用例失败」），
// 这里做的是**减少复发**：绿了只打一行汇总，红了才逐行打失败行（诊断能力一点不少：红的那几行
// 仍然带「期望/实际」），把常态日志从「行数 × 一行」压到 1 行。
//
// 为什么不改为「该族排除出合并批次」：这条 IPC 通道只在 `node --test`（单文件跑法）里存在，
// 合并批次是同一进程内顺序 import，根本没有这条通道 —— 排除出批次只会让它**更常**走 `node --test`，
// 复发概率是升不是降。详见 #611 的取舍说明。

/**
 * @param {Array<{ name: string }> & Array<any>} rows 行数据，必须有 name
 * @param {(row: any) => Promise<void>|void} body 单行断言
 * @returns {Promise<void>} 任一行失败时抛出汇总错误
 */
export const runTable = async (rows, body) => {
  const failures = []
  for (const row of rows) {
    try {
      await body(row)
    } catch (error) {
      failures.push({ name: row.name, error })
    }
  }
  if (failures.length > 0) {
    // 红了才逐行打（含期望/实际）：这时体积是「失败行数」，不是「全部行数」
    for (const { name, error } of failures) {
      console.error(`  ✗ ${name}\n    ${String(error?.message ?? error).split('\n').join('\n    ')}`)
    }
    const summary = failures
      .map(({ name, error }) => `  ✗ ${name}: ${String(error?.message ?? error)}`)
      .join('\n')
    throw new Error(`表驱动用例中 ${failures.length}/${rows.length} 行失败：\n${summary}`)
  }
  // 绿：一行收口（#611：不再逐行打 ✓ —— 表有多大，日志就有多大）
  console.log(`  表 ${rows.length} 行全部通过`)
}

/** 期望值断言：把「这一行期望什么 / 实际是什么」一起带进失败信息，否则表驱动失败时不知道是哪一列。 */
export const expectEqual = (actual, expected, column) => {
  if (actual !== expected) {
    throw new Error(`${column} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

export const expectMatch = (actual, pattern, column) => {
  if (!pattern.test(String(actual))) {
    throw new Error(`${column} 应匹配 ${pattern}，实际 ${JSON.stringify(actual)}`)
  }
}

export const expectOk = (value, column) => {
  if (!value) {
    throw new Error(`${column} 期望为真，实际 ${JSON.stringify(value)}`)
  }
}

export const expectDeepEqual = (actual, expected, column) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) {
    throw new Error(`${column} 期望 ${right}，实际 ${left}`)
  }
}
