// 低内核 WebView 运行时补齐（issue #13）：必须是**第一个** import —— ESM 按声明顺序求值，
// 放在最前面才能保证下面所有模块（以及 React）拿到的是补齐后的 Object.hasOwn / at / structuredClone。
import './polyfills/legacy.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ErrorBoundary } from './app/ErrorBoundary.js'
import { setupTheme } from './app/theme.js'
import { setupReading } from './app/reading.js'
import { readDiagnosticsFacts } from './app/diagnosticsContext.js'
import { getApiKey } from './services/api/apiConfig.js'
import { migrateConfigOnce } from './services/api/configMigration.js'
import { fetchCustomerIdFromProfile, setCustomerIdProvider } from './services/ours/customerId.js'
import { fetchPaymentRecords } from './services/ours/paymentRecords.js'
import { httpTransport } from './services/ours/transport.js'
import { INVITE_API_BASE } from './services/invite/api.js'
import { ensureDeviceId } from './services/invite/device.js'
import { setupFlexGapFallback } from './utils/flexGap.js'
import {
  initDiagnostics,
  installDiagnosticsDebugHandle,
} from './services/diagnostics/index.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './styles/reading.css'
import './app/global.css'
import './app/motion.css'

/**
 * index.html 里的 ES5 守卫（issue #180 之后）写下的结构化诊断。三条出口都写它：
 * ① missing-api（探针缺失）/ ② runtime-error（启动期脚本报错）/ ③ boot-timeout（12 秒没启动）。
 * 原始异常文本只在这个对象里，用户可见文案走 src/index.html 的本地化模板。
 */
type BootGuardDiagnostics = {
  branch: string
  code: string
  message: string
  missing: string[]
  url: string | null
  line: number | null
  col: number | null
  ua: string
  webviewVersion: string | null
}

// 守卫在脚本加载/解析阶段就判定过能力（那时本包可能连解析都没过）。
// 它已经把可读提示画进 #root 了，就别再用半装的 React 树把它覆盖成白屏。
const bootGuardError = (window as Window & { __DEEPSEEK_COMPATIBILITY_ERROR__?: BootGuardDiagnostics })
  .__DEEPSEEK_COMPATIBILITY_ERROR__
if (bootGuardError) {
  // 原始细节（出口分支 / 内核版本 / 异常文本 / 行列号）守卫已经打进 console.error 与
  // window.__DEEPSEEK_COMPATIBILITY_ERROR__，这里只负责别让半装的 React 树覆盖掉提示。
  throw new Error('WEBVIEW_CAPABILITY_MISSING')
}

ensureKatex()
setupTheme()
// flex gap 兜底（issue #173）：WebView 83 的 CSS.supports('gap') 是假阳性（grid 支持、flex 不生效），
// 只能实测；不支持才挂 html[data-flex-gap-fallback]，兜底间距全部写在该属性之下。
setupFlexGapFallback()
// 消息区阅读设置（#102）：首屏渲染前就把字号 / 字重 / 行高档位挂到根元素上
setupReading()

// 一次性配置迁移（#339）：1.2.x 把模型名写进了所有渠道共用的 chat-demo:model，内置渠道已不再读它；
// 这里把残留值清掉并记一条 config_change/legacy-model 诊断，用户不必再手工改 localStorage。
// 放在 initDiagnostics 之前：collector 是模块级环形缓冲，早起写入的这条一样会随日志导出。
migrateConfigOnce()
// 诊断：恢复上次落盘的日志并装上 window.onerror / console / fetch 等 hook（采集层与上传层解耦，见 services/diagnostics）
void initDiagnostics({ facts: readDiagnosticsFacts })
// 仅当 URL 带 ?diag-debug 时把调试入口挂到 window（本地验收脚本用，正常使用不暴露）
installDiagnosticsDebugHandle()

// 告诉 index.html 的 ES5 守卫「入口跑起来了」，它就不用再兜底报白屏（见 src/index.html）。
;(window as Window & { __DEEPSEEK_BOOTED__?: boolean }).__DEEPSEEK_BOOTED__ = true
// 客户编号（cid）的来源：付款记录 / 购买记录（GET /api/orders）要靠它认出「这是谁的订单」。
// Issue #331 之后下单链路已停用（我们不建单），cid 只剩「查历史订单」这一个用途：
//  1. 有 API Key：直接用 GET /api/orders 返回的 customer_id（实测唯一可靠的来源）；
//  2. 没有 Key：退回设备码通道 GET <invite>/me?device_id=…。
// 两条都失败就返回 null —— 查记录时按「查不到」处理，不再阻断任何购买流程。

setCustomerIdProvider(async () => {
  const key = getApiKey()
  if (key !== '') {
    const records = await fetchPaymentRecords(key, httpTransport)
    if (records.kind === 'ok' && records.data.customerId !== null) {
      return records.data.customerId
    }
  }
  return fetchCustomerIdFromProfile({
    base: INVITE_API_BASE,
    deviceId: ensureDeviceId(),
    transport: httpTransport,
  })
})

// 根部包一层错误边界：渲染期异常不再是整屏白屏，而是一张可读的错误页（issue #28）
createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
