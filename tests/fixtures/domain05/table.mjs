// 域 5 表驱动用例的共用跑批器。
//
// 为什么自己写一层：本域的最小充分集是「一张表吃掉一族分支」（见 docs/testing/coverage/domain-05.md
// 第六节），每行只有输入与期望不同。用 node:test 的 subtests 会把「9 条用例」膨胀成上百条用例，
// 与维护者口径（用例条数尽量少、覆盖尽量全）相反；所以一条用例内部逐行跑，失败时一次性报出
// 「哪几行红了 + 每行的期望/实际」，日志里仍逐行打印 ✓，定位粒度与一条一行断言一样。

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
      console.log(`  ✓ ${row.name}`)
    } catch (error) {
      failures.push({ name: row.name, error })
      console.error(`  ✗ ${row.name}\n    ${String(error?.message ?? error).split('\n').join('\n    ')}`)
    }
  }
  if (failures.length > 0) {
    const summary = failures
      .map(({ name, error }) => `  ✗ ${name}: ${String(error?.message ?? error)}`)
      .join('\n')
    throw new Error(`表驱动用例中 ${failures.length}/${rows.length} 行失败：\n${summary}`)
  }
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
