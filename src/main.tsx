// 低内核 WebView 运行时补齐（issue #13）：必须是**第一个** import —— ESM 按声明顺序求值，
// 放在最前面才能保证下面所有模块（以及 React）拿到的是补齐后的 Object.hasOwn / at / structuredClone。
import './polyfills/legacy.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ErrorBoundary } from './app/ErrorBoundary.js'
import { setupTheme } from './app/theme.js'
import { setupReading } from './app/reading.js'
import { readDiagnosticsFacts } from './app/diagnosticsContext.js'
import { openOursServices } from './components/settings/settingsDialogState.js'
import { consumeOrderReturn } from './services/ours/returnParams.js'
import { getApiKey } from './services/api/apiConfig.js'
import { fetchCustomerIdFromProfile, setCustomerIdProvider } from './services/ours/customerId.js'
import { fetchPaymentRecords } from './services/ours/paymentRecords.js'
import { httpTransport, setCustomerMissingNotice } from './services/ours/transport.js'
import { showToast } from './components/base/toastState.js'
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

// index.html 里的 ES5 守卫在脚本加载/解析阶段就判定过能力（那时本包可能连解析都没过）。
// 它已经把可读提示画进 #root 了，就别再用半装的 React 树把它覆盖成白屏。
if ((window as Window & { __DEEPSEEK_COMPATIBILITY_ERROR__?: string[] }).__DEEPSEEK_COMPATIBILITY_ERROR__) {
  throw new Error('WEBVIEW_CAPABILITY_MISSING')
}

ensureKatex()
setupTheme()
// flex gap 兜底（issue #173）：WebView 83 的 CSS.supports('gap') 是假阳性（grid 支持、flex 不生效），
// 只能实测；不支持才挂 html[data-flex-gap-fallback]，兜底间距全部写在该属性之下。
setupFlexGapFallback()
// 消息区阅读设置（#102）：首屏渲染前就把字号 / 字重 / 行高档位挂到根元素上
setupReading()

// 诊断：恢复上次落盘的日志并装上 window.onerror / console / fetch 等 hook（采集层与上传层解耦，见 services/diagnostics）
void initDiagnostics({ facts: readDiagnosticsFacts })
// 仅当 URL 带 ?diag-debug 时把调试入口挂到 window（本地验收脚本用，正常使用不暴露）
installDiagnosticsDebugHandle()

// 告诉 index.html 的 ES5 守卫「入口跑起来了」，它就不用再兜底报白屏（见 src/index.html）。
;(window as Window & { __DEEPSEEK_BOOTED__?: boolean }).__DEEPSEEK_BOOTED__ = true
// 网页版付款回跳（Issue #36）：地址栏带 ?no=<out_trade_no>&order_token=<token> 时，
// 先解析并清掉参数（order_token 等同凭据，不该留在历史里），再直接打开「我们的渠道」弹层
// 进入订单查询（2s 一次、最多 60s；fulfilled 才显示卡密）。
const orderReturn = consumeOrderReturn(window)
if (orderReturn !== null) {
  // Issue #157：回跳是网页版**唯一**能拿到新单号的时机（顶层导航读不到 Location），
  // consumeOrderReturn 已经把存档覆盖成这一单；覆盖过未完成旧单时带一句提示进弹层。
  openOursServices({ replacedUnpaidOrder: orderReturn.replacedUnpaidOrder })
}

// 下单归属客户（cid）的来源（Issue #115）：/buy 不带 cid 就会建出一张不知道属于谁的单，
// 付款成功后 App 只能一直显示「等待支付」。这里把「怎么拿到 cid」注入给业务层：
//  1. 有 API Key：直接用 GET /api/orders 返回的 customer_id（实测唯一可靠的来源）；
//  2. 没有 Key（还没绑定的首购用户）：退回设备码通道 GET <invite>/me?device_id=…。
// 两条都失败就返回 null —— 业务层会拒绝下单，而不是发出一次没有 cid 的 /buy。
// 拿不到 cid 时（网页版「去支付」）用 App 自己的轻提示，不弹原生 alert
setCustomerMissingNotice((message) => showToast(message))

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
