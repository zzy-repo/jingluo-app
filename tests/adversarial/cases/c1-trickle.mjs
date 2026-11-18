// C1 · 极端环境：滴流（每块都能拿到，但总速率很低）
// 构造方式：1MB 归档，每 4KB 分块固定延迟 600ms 返回；总预算压到 1200ms 让用例几秒内跑完。
// 期望：判据应当是「多久**没有新字节**」，也就是无进展才算卡死；
//      一直在稳定拿到字节的下载不该被判成「下载长时间无响应」。
// 实际：见下。顺带把「总预算 120 秒」与「包体上限 200MB」的算术矛盾算出来。
import { events, installUrlHooks, records, resetEnv, runUrlImport, slowNative, URL_OK, zipBytes } from '../lib/url-harness.mjs'

installUrlHooks()
const { importHistoryFromUrl } = await import('../../../src/services/chat/history/urlImport.ts')
const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../../src/services/chat/history/importLimit.ts')

console.log('[c1] C. 极端环境 / 滴流下载（有进展但很慢）')
console.log('构造方式：1MB 归档、每块 4KB 延迟 600ms、总预算 1200ms。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

resetEnv()
const source = zipBytes(1024 * 1024)
const native = slowNative(source, { delayMs: 600 })
const result = await runUrlImport(importHistoryFromUrl, URL_OK, {
  downloadBudgetMs: 1200,
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

// 2) 实际给出的原因：说「长时间无响应」
check(
  '2) 实际文案是「下载长时间无响应」（与「一直在收到字节」相矛盾）',
  result.key === 'historyImportUrlStalled',
  `${result.key} / ${result.error?.message ?? ''}`
)

// 3) 诊断里能区分「无进展」与「总预算耗尽」吗
check(
  '3) 诊断应区分「无进展卡死」与「总预算耗尽」（stalled vs budget_exhausted）',
  failures.some((entry) => entry.fields?.reason === 'budget_exhausted'),
  `reason=${[...new Set(failures.map((entry) => entry.fields?.reason))].join(',')}`
)

// 4) 心跳：有进展时不应反复报「没动静」
const beats = events('import: download heartbeat')
console.log(`  心跳 ${beats.length} 条，最后一条 budget.leftMs=${beats.at(-1)?.fields?.['budget.leftMs']}`)

// 5) 算术：总预算 vs 包体上限
const seconds = 120
const needBps = DEFAULT_MAX_IMPORT_BYTES / seconds
console.log(
  `  算术矛盾：包体上限 ${(DEFAULT_MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0)}MB ÷ 总预算 ${seconds}s = 需要稳定 ${(needBps / 1024 / 1024).toFixed(2)}MB/s（≈${(needBps * 8 / 1_000_000).toFixed(1)}Mbps）才可能成功`
)
check(
  '5) 现行「120s 总预算 + 200MB 上限」要求稳定 ≥1.5MB/s，低于它的网络即便持续有进展也必然失败',
  needBps / 1024 / 1024 > 1.5,
  `需要 ${(needBps / 1024 / 1024).toFixed(2)}MB/s`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[c1] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
