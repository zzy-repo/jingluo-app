// C3 · 极端环境：离线 / 不可用端口 / 对端直接拒
// 构造方式：原生桥对每个请求立刻抛错，错误形态分别取
//   (1) 浏览器 fetch 的通用形态 TypeError: Failed to fetch（真离线、被墙端口都长这样）
//   (2) Chromium 的 net::ERR_UNSAFE_PORT（WHATWG 禁用端口的直连失败）
//   (3) net::ERR_INTERNET_DISCONNECTED（明确离线，对照用）
// 期望：「网络已断开」这条文案只在真的是断网时出现；端口被拒这种永久不可用的链接
//      不该按「可重试的网络故障」去重试。
// 实际：见下。
import { installUrlHooks, records, resetEnv, runUrlImport, URL_OK, zipBytes, slowNative } from '../lib/url-harness.mjs'

installUrlHooks()
const { importHistoryFromUrl } = await import('../../../src/services/chat/history/urlImport.ts')

console.log('[c3] C. 极端环境 / 离线与不可用端口')
console.log('构造方式：原生桥对每个请求立刻抛错，错误形态分别取通用 fetch 失败 / 禁用端口 / 明确离线。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const source = zipBytes(512 * 1024)

const runFailure = async (error, { onLine = true } = {}) => {
  resetEnv()
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine, connection: undefined },
    configurable: true,
    writable: true,
  })
  const native = slowNative(source, { failWhen: () => error })
  const result = await runUrlImport(importHistoryFromUrl, URL_OK, { downloadBudgetMs: 5000 })
  const failures = records('import_error')
  return { ...result, native, failures, reason: failures[0]?.fields?.reason }
}

// 1) 明确离线：文案正确（对照组）
const offline = await runFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))
check(
  '1) net::ERR_INTERNET_DISCONNECTED → 「网络已断开」',
  offline.key === 'historyImportUrlOffline',
  `${offline.key} / ${offline.error?.message ?? ''}`
)

// 2) 浏览器 fetch 的通用失败形态（真离线在部分 WebView 上就是这个样子）
const fetchFail = await runFailure(new TypeError('Failed to fetch'), { onLine: false })
check(
  '2) TypeError: Failed to fetch + navigator.onLine=false → 应判「网络已断开」',
  fetchFail.key === 'historyImportUrlOffline',
  `${fetchFail.key} / ${fetchFail.error?.message ?? ''} / onLine=false`
)

// 3) WHATWG 禁用端口（例如 1、7、6667）：fetch 直接失败，说明这个链接永久不可用
const unsafePort = await runFailure(new TypeError('net::ERR_UNSAFE_PORT'), { onLine: true })
check(
  '3) net::ERR_UNSAFE_PORT（永久不可用）→ 不应作为可重试网络故障反复重试',
  unsafePort.native.calls.length === 1,
  `终态 ${unsafePort.key} / 请求 ${unsafePort.native.calls.length} 次`
)

// 4) 重试次数与耗时：永久失败也要把重试用完才报错吗
console.log(
  `  实测：通用失败重试 ${fetchFail.native.calls.length} 次、${fetchFail.elapsed}ms；禁用端口 ${unsafePort.native.calls.length} 次、${unsafePort.elapsed}ms`
)
check(
  '4) 诊断里记录的重试次数与实际请求次数一致（可回查「导入没反应」）',
  fetchFail.native.calls.length >= 2 && fetchFail.failures.length >= 1,
  `请求 ${fetchFail.native.calls.length} 次 / 失败记录 ${fetchFail.failures.length} 条`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[c3] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
