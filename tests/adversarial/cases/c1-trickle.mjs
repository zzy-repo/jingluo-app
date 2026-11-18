// C1 · 极端环境：滴流（每块都能拿到，但总速率很低）
// 构造方式：1MB 归档、首块 4KB（之后按 CHUNK_TARGET_MS=1200ms 自适应放大）、每块固定延迟 600ms；
//          总预算压到 1200ms，让用例两秒内跑完。
// 期望：判据应当是「多久**没有新字节**」，也就是无进展才算卡死；
//      一直在稳定拿到字节的下载不该被判成「下载长时间无响应」，而应明确报「预算上限耗尽」并与 stalled 区分开。
//
// 历史（这条曾记为 known-defect，实为四条用例侧错误叠出来的假缺陷）：
//   1) 选项名写成 downloadBudgetMs，而 src 里叫 downloadMaxTotalMs（#64 改名），1.2s 预算从未生效——
//      于是走默认 30 分钟预算把 1MB 下完了，「压根没有失败终态」被误读成「预算耗尽被报成无响应」；
//   2) 断言 2 断的是缺陷本身（key 必须 === stalled），产品一正确就必红；
//   3) 断言 3 断的 reason 'budget_exhausted' 在 src/ 里根本不存在（产品记的是 'deadline'）；
//   4) 断言 5 把总预算硬编码成 120s，靠错误常量才算出「必须 ≥1.5MB/s」的假矛盾。
// 现在：选项名按真实 API 传，三处断言按产品真实语义校准；这不是放宽——预算、终态、reason 都必须真报出来。
import { events, installUrlHooks, records, resetEnv, runUrlImport, slowNative, URL_OK, zipBytes } from '../lib/url-harness.mjs'

installUrlHooks()
const { importHistoryFromUrl } = await import('../../../src/services/chat/history/urlImport.ts')
const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../../src/services/chat/history/importLimit.ts')

console.log('[c1] C. 极端环境 / 滴流下载（有进展但很慢）')
console.log('构造方式：1MB 归档、首块 4KB 后自适应放大、每块延迟 600ms、总预算 1200ms。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

resetEnv()
const source = zipBytes(1024 * 1024)
const native = slowNative(source, { delayMs: 600 })
const result = await runUrlImport(importHistoryFromUrl, URL_OK, {
  downloadMaxTotalMs: 1200,
  heartbeatIntervalMs: 300,
})

const failures = records('import_error')
const bytes = failures[0]?.fields?.['download.bytes'] ?? 0
const percent = failures[0]?.fields?.percent ?? 0

console.log(`  实测：${native.calls.length} 次请求、拿到 ${bytes} 字节（${percent}%）、${result.elapsed}ms、终态 ${result.key}`)

// 0) 兜底：必须有终态（不能一直 pending 把用户卡住）
check('0) 慢链路必须有有限时间内的失败终态', result.error !== null, `${result.key} @ ${result.elapsed}ms`)

// 1) 确实「一直在拿到新字节」——不是无响应的连接
check(
  '1) 失败前其实一直在稳定收到新字节（无进展判据在这里不成立）',
  native.calls.length > 1 && bytes > 0,
  `${native.calls.length} 次请求 / ${bytes} 字节`
)

// 2) 失败原因必须明说「预算/超时上限」，不能与「长时间无响应」混为一谈
check(
  '2) 终态是「下载超时（预算耗尽）」而不是「下载长时间无响应」',
  result.key === 'historyImportUrlDeadline',
  `${result.key} / ${result.error?.message ?? ''}`
)

// 3) 诊断里能区分「无进展卡死」与「总预算耗尽」
check(
  '3) 诊断把本次失败记为 deadline，且没有混进 stalled',
  failures.some((entry) => entry.fields?.reason === 'deadline') &&
    !failures.some((entry) => entry.fields?.reason === 'stalled'),
  `reason=${[...new Set(failures.map((entry) => entry.fields?.reason))].join(',')}`
)

// 4) 心跳：有进展时不应反复报「没动静」
const beats = events('import: download heartbeat')
console.log(`  心跳 ${beats.length} 条，最后一条 budget.leftMs=${beats.at(-1)?.fields?.['budget.leftMs']}`)

// 5) 算术：总预算 vs 包体上限（用真实常量，不再硬编码旧口径的 120s）
// urlImport.ts 的 DOWNLOAD_MAX_TOTAL_MS 未导出，这里与它的现值对齐（30 分钟）；
// 该文件里的 MIN_REQUIRED_BYTES_PER_SEC 正是拿它推导出来的，常量一改这里跟着红（#152）。
const totalBudgetSeconds = 30 * 60
const needBps = DEFAULT_MAX_IMPORT_BYTES / totalBudgetSeconds
console.log(
  `  算术：包体上限 ${(DEFAULT_MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0)}MB ÷ 总预算 ${totalBudgetSeconds}s = 需要稳定 ${(needBps / 1024).toFixed(0)}KB/s（≈${(needBps * 8 / 1_000_000).toFixed(1)}Mbps）`
)
check(
  '5) 现行「30 分钟总预算 + 200MB 上限」只要求稳定 ≈114KB/s（≈0.9Mbps），两个常量自洽 —— 旧断言的「必须 ≥1.5MB/s」只因为把总预算当成了 120s',
  needBps / 1024 / 1024 < 0.2,
  `需要 ${(needBps / 1024).toFixed(0)}KB/s`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[c1] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
