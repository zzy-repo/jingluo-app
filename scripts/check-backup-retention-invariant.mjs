#!/usr/bin/env node
/**
 * check-backup-retention-invariant.mjs —— 备份保留策略的「删除逻辑」穷举验证（#1005 跟进）。
 *
 * ## 为什么会有这个脚本（下一个想删它的人先读这段）
 *
 * 2026-11-27 设备实测：磁盘被写满 → Chromium 判 IndexedDB 损坏 → 整库重建 → 48 个会话丢失。
 * 追下去发现两条互相放大的问题：① 每次「恢复」前都会先落一份安全备份，但它们**永不清理**
 * （`prune: false`）；② 这样一来备份目录只涨不跌（实测 3 份 → 5 份 / 226 MB），而「磁盘写满」
 * 正是那起事故的根因。修法是给安全备份加容量上限（`SAFETY_RETENTION_KEEP`），于是**第一次**
 * 有了「删除旧备份」的代码路径 —— 而删除逻辑是所有代码里最不该出错的那种：删错一份，
 * 用户失去的就可能是唯一能回去的那份数据，且**不可逆**。
 *
 * 单测能覆盖「想到了的场景」，覆盖不了「所有组合」。这个脚本做的是**完全枚举**：
 * 把备份数量 × 来源 × 校验结果 × 时间可读性 × 两组 keep 全组合一遍，逐例验证两条底线。
 * 它守的是不变量，不是某个用例——**别把它删了换成几个 example-based 单测**。
 * （先例：`selectPrunable` 用 `createdDesc` 排序时，`Date.parse` 失败会返回 NaN、比较器跟着
 * 返回 NaN，于是「时间读不出来」的项可能占住「最新」的保护位，真正最新的那份反被删掉。
 * 这个缺陷是穷举跑出来的，写单测时没人想到要造这个组合。见下面断言 ②。）
 *
 * ## 参数范围（冻结，不许缩）
 *
 * 备份份数 n ∈ {1,2,3,4}；每份取 12 种变体 =
 *   origin ∈ {缺省（= 常规）, 'regular', 'safety'} × checksumOk ∈ {true,false} × 时间 ∈ {可解析, 不可解析}
 * 两组 keep：regularKeep ∈ {1,2,3}、safetyKeep ∈ {0,1,2,3}
 * → 组合总数 = (12 + 144 + 1728 + 20736) × 12 = **271,440**
 *
 * 缩小范围 = 放弃保证。嫌慢请先看下面的性能红线，别改 `RANGES`。
 *
 * ## 断言（两条都必须 0 例）
 *
 * ① **删除计划执行后，至少仍剩一份 `checksumOk` 的备份**（只要输入里有）——
 *    「最后一份可恢复的备份被静默删掉」是本次事故之外最不能接受的结果。
 * ② **可信时间范围内最新的那份 `checksumOk` 不被删**——哪怕它被排到了「超出上限」那一档
 *    （时钟倒退 / 时间戳并列 / 上限被改小 / 有项时间读不出来）。
 *
 * 另外附带两条结构性校验：删除集合只能来自输入 id；安全组只能删「origin === 'safety'
 * 且时间可信」的项（`SAFETY_RETENTION_KEEP` 不许越界删常规备份）。
 *
 * ## 性能红线
 *
 * 纯内存枚举，本机 ~2s。**超过 15s 一律判红**（`PERF_LIMIT_MS`）：那说明实现方式退化了
 * （比如每例都重新载入模块、或枚举被写成指数展开），不是「机器慢」，不要靠调大超时解决。
 *
 * ## 边界
 *
 * 不联网、不碰 Android SDK、不依赖 chromium/Playwright、不读写设备文件——纯 CPU。
 * 用法：`node scripts/check-backup-retention-invariant.mjs`（或 `pnpm check:backup-retention`）。
 */
import { installTsResolve, loadTsModule } from '../tests/helpers/dom-env.mjs'

installTsResolve()

/** 冻结的枚举范围：见文件头「参数范围（冻结，不许缩）」 */
const RANGES = Object.freeze({
  counts: Object.freeze([1, 2, 3, 4]),
  origins: Object.freeze([undefined, 'regular', 'safety']),
  checksumOk: Object.freeze([true, false]),
  dated: Object.freeze([true, false]),
  regularKeep: Object.freeze([1, 2, 3]),
  safetyKeep: Object.freeze([0, 1, 2, 3]),
})

/** 性能红线：纯内存枚举超过这个时间说明实现退化 */
const PERF_LIMIT_MS = 15_000

const DATE_NEWEST = '2026-11-20T10:00:00.000Z'
const DATE_OLDER = '2026-11-19T10:00:00.000Z'
/** 故意用解析不出来但看着像日期的串：`Date.parse` → NaN */
const DATE_UNTRUSTED = 'not-a-date'

const parseable = (item) => Number.isFinite(Date.parse(item.createdAtUtc))

const describeItem = (item) =>
  `{ id: ${item.id}, origin: ${item.origin ?? '缺省(常规)'}, checksumOk: ${item.checksumOk}, createdAt: ${item.createdAtUtc} }`

const describeCase = (testCase) => {
  const lines = [`  keep: regularKeep=${testCase.regularKeep} / safetyKeep=${testCase.safetyKeep}`]
  lines.push(`  输入 ${testCase.items.length} 份备份：`)
  for (const item of testCase.items) {
    lines.push(`    - ${describeItem(item)}`)
  }
  return lines.join('\n')
}

const failures = { rule1: [], rule2: [], structural: [] }
let cases = 0

/** 单例检查：把 violation 收进对应篮子，不在循环里抛（要一次跑完拿全量计数） */
const inspect = (testCase) => {
  cases += 1
  const { items, regularKeep, safetyKeep } = testCase
  const plan = planRetention(items, { regularKeep, safetyKeep })
  const doomed = [...plan.regular, ...plan.safety]
  const ids = new Set(items.map((item) => item.id))

  // ---- 结构性校验：删除只能来自输入，安全组不许越界 ----
  for (const id of doomed) {
    if (!ids.has(id)) {
      failures.structural.push({ testCase, expected: '删除集合 ⊆ 输入 id', actual: `出现了输入里没有的 id: ${id}` })
      return
    }
  }
  for (const id of plan.safety) {
    const item = items.find((candidate) => candidate.id === id)
    const legal = item.origin === 'safety' && parseable(item)
    if (!legal) {
      failures.structural.push({
        testCase,
        expected: "安全组只删 origin === 'safety' 且时间可信的项",
        actual: `删了 ${describeItem(item)}`,
      })
      return
    }
  }

  const usableInputs = items.filter((item) => item.checksumOk)
  if (usableInputs.length === 0) {
    return
  }

  // ---- 断言 ①：删完必须仍有一份可恢复 ----
  const survivors = usableInputs.filter((item) => !doomed.includes(item.id))
  if (survivors.length === 0) {
    failures.rule1.push({
      testCase,
      expected: `至少 1 份 checksumOk 存活（输入有 ${usableInputs.length} 份）`,
      actual: `0 份存活；删除计划 = [${doomed.join(', ')}]`,
    })
  }

  // ---- 断言 ②：可信时间范围内最新的那份不许被删 ----
  const newestUsable = usableInputs.filter(parseable).sort((a, b) => Date.parse(b.createdAtUtc) - Date.parse(a.createdAtUtc))[0]
  if (newestUsable && doomed.includes(newestUsable.id)) {
    failures.rule2.push({
      testCase,
      expected: `可信时间内最新的 checksumOk 备份不被删: ${newestUsable.id}（${newestUsable.createdAtUtc}）`,
      actual: `被写进删除计划；删除计划 = [${doomed.join(', ')}]；存活的可恢复项 = [${survivors.map((item) => item.id).join(', ') || '无'}]`,
    })
  }
}

/** 按 RANGES 展开全部变体（顺序固定，保证可复现） */
const buildVariants = () => {
  const variants = []
  for (const origin of RANGES.origins) {
    for (const checksumOk of RANGES.checksumOk) {
      for (const dated of RANGES.dated) {
        variants.push({ origin, checksumOk, dated })
      }
    }
  }
  return variants
}

const VARIANTS = buildVariants()

const buildItems = (picks) =>
  picks.map((variant, index) => ({
    id: `b-${index}`,
    createdAtUtc: variant.dated ? (index === 0 ? DATE_NEWEST : DATE_OLDER) : DATE_UNTRUSTED,
    sizeBytes: 1024 * (index + 1),
    checksumOk: variant.checksumOk,
    ...(variant.origin === undefined ? {} : { origin: variant.origin }),
  }))

const runAll = () => {
  const walk = (count, picks = []) => {
    if (picks.length === count) {
      const items = buildItems(picks)
      for (const regularKeep of RANGES.regularKeep) {
        for (const safetyKeep of RANGES.safetyKeep) {
          inspect({ items, regularKeep, safetyKeep })
        }
      }
      return
    }
    for (const variant of VARIANTS) {
      walk(count, [...picks, variant])
    }
  }
  for (const count of RANGES.counts) {
    walk(count)
  }
}

const expectedCases = RANGES.counts.reduce(
  (total, n) => total + VARIANTS.length ** n * RANGES.regularKeep.length * RANGES.safetyKeep.length,
  0
)

const { planRetention } = await loadTsModule('src/services/backup/backupCore.ts')

const startedAt = performance.now()
runAll()
const elapsedMs = Math.round(performance.now() - startedAt)

const printFailures = (title, list, limit = 5) => {
  console.log(`❌ ${title}：${list.length} 例`)
  for (const failure of list.slice(0, limit)) {
    console.log('')
    console.log('  违反例：')
    console.log(describeCase(failure.testCase))
    console.log(`  期望：${failure.expected}`)
    console.log(`  实际：${failure.actual}`)
  }
  if (list.length > limit) {
    console.log(`  …另有 ${list.length - limit} 例未逐条打印（同上口径）`)
  }
}

console.log('check:backup-retention —— 备份保留策略的删除逻辑穷举验证（#1005 跟进）')
console.log(
  `枚举范围：n ∈ {${RANGES.counts.join(', ')}} × ${VARIANTS.length} 变体 × regularKeep {${RANGES.regularKeep.join(', ')}} × safetyKeep {${RANGES.safetyKeep.join(', ')}}`
)

if (cases !== expectedCases) {
  console.log(`❌ 枚举规模不符：跑了 ${cases} 例，按冻结范围应为 ${expectedCases} 例（枚举被改动过？）`)
  process.exit(1)
}

console.log(`枚举完成：${cases} 例，耗时 ${elapsedMs}ms（红线 ${PERF_LIMIT_MS}ms）`)

let failed = false

if (failures.structural.length > 0) {
  printFailures('结构性校验（删除集合越界）', failures.structural)
  failed = true
} else {
  console.log('✔ 结构性：删除集合 ⊆ 输入 id，安全组只删 safety 且时间可信的项')
}

if (failures.rule1.length > 0) {
  printFailures('断言①「删完至少剩一份 checksumOk」', failures.rule1)
  failed = true
} else {
  console.log(`✔ 断言①「删完至少剩一份 checksumOk」：违反 0 例（共 ${cases} 例）`)
}

if (failures.rule2.length > 0) {
  printFailures('断言②「可信时间内最新的 checksumOk 不被删」', failures.rule2)
  failed = true
} else {
  console.log(`✔ 断言②「可信时间内最新的 checksumOk 不被删」：违反 0 例（共 ${cases} 例）`)
}

if (elapsedMs > PERF_LIMIT_MS) {
  console.log(
    `❌ 性能红线：${elapsedMs}ms > ${PERF_LIMIT_MS}ms。纯内存枚举不该这么慢——先查实现是否退化，不要调大红线。`
  )
  failed = true
}

if (failed) {
  console.log('')
  console.log('结论：FAIL（保留策略的删除逻辑破了不变量；这条门禁守的是不可逆的数据丢失，别绕过）')
  process.exit(1)
}

console.log('')
console.log('结论：PASS（两条底线在全部组合下都成立）')
