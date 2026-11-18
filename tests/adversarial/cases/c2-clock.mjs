// C2 · 极端环境：系统时间被调整 / 回拨
// 构造方式：把 Date.now 包一层，在下载中途让它前跳 1 小时（模拟用户改系统时间、NTP 校正、
//          调试时调时间），以及后跳 1 小时（模拟时钟回拨）。
// 期望：下载是否「卡死」应当按单调时间（performance.now / 收到的字节）判断，
//      系统时间怎么变都不该影响健康链路的判断，也不该出现负数时间差。
// 实际：见下。
import { installUrlHooks, records, resetEnv, runUrlImport, URL_OK, zipBytes } from '../lib/url-harness.mjs'

installUrlHooks()
const { importHistoryFromUrl } = await import('../../../src/services/chat/history/urlImport.ts')

console.log('[c2] C. 极端环境 / 系统时间前跳与回拨')
console.log('构造方式：包一层 Date.now，在第 3 次原生请求前后让它偏移 ±1 小时。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew

const runWithSkew = async (source, { applyAt, delta, budgetMs = 60_000 }) => {
  resetEnv()
  skew = 0
  let applied = false
  const native = { native: true, calls: [], get: undefined }
  native.get = (options) => {
    const attempt = native.calls.length
    if (!applied && attempt >= (applyAt ?? 0)) {
      applied = true
      skew = delta
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
    const from = match ? Number(match[1]) : 0
    const to = match ? Number(match[2]) : source.length - 1
    const end = Math.min(to, source.length - 1)
    const slice = source.slice(from, end + 1)
    return Promise.resolve({
      status: 206,
      url: URL_OK,
      headers: {
        'Content-Range': `bytes ${from}-${end}/${source.length}`,
        'Content-Length': String(slice.length),
      },
      data: slice.buffer,
    })
  }
  globalThis.__native = native
  const result = await runUrlImport(importHistoryFromUrl, URL_OK, { downloadBudgetMs: budgetMs })
  skew = 0
  return { ...result, native }
}

// A) 前跳 1 小时：链路本身是健康的（同一条链路不加偏移时 <100ms 就下完）
const forward = await runWithSkew(zipBytes(2 * 1024 * 1024), { applyAt: 2, delta: 3_600_000 })
console.log(`  A 实测：${forward.native.calls.length} 次请求、${forward.elapsed}ms、终态 ${forward.key ?? '成功'}`)
check(
  'A) 系统时间前跳 1 小时 → 健康链路不应被判「下载长时间无响应」',
  forward.error === null,
  `${forward.key ?? '成功'} / ${forward.error?.message ?? ''}`
)
check(
  'A) 前跳后诊断记录里出现「预算耗尽」而不是真实的无进展',
  !records('import_error').some((entry) => entry.fields?.reason === 'stalled') || forward.error === null,
  `reason=${[...new Set(records('import_error').map((entry) => entry.fields?.reason))].join(',') || '无'}`
)

// B) 回拨 1 小时：健康下载能成功，但时间轴会出现负数
const backward = await runWithSkew(zipBytes(256 * 1024), { applyAt: 2, delta: -3_600_000 })
const negativeTrace = backward.trace.filter((entry) => entry.at < 0)
console.log(
  `  B 实测：${backward.key ?? '成功'}、trace ${backward.trace.length} 条、其中 at<0 的 ${negativeTrace.length} 条（最负 ${Math.min(0, ...backward.trace.map((entry) => entry.at))}ms）`
)
check(
  'B) 回拨后时间轴不应出现负数时间差（trace.at / durationMs 都是 Date.now 相减）',
  negativeTrace.length === 0,
  negativeTrace.length === 0 ? '无负数' : `${negativeTrace.length} 条负数，最负 ${Math.min(...negativeTrace.map((entry) => entry.at))}ms`
)

Date.now = realNow

const failed = checks.filter((item) => !item.pass)
console.log(`[c2] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
