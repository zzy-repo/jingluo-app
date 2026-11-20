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
import { setCustomerIdProvider } from './services/ours/customerId.js'
import { fetchPaymentRecords } from './services/ours/paymentRecords.js'
import { httpTransport } from './services/ours/transport.js'
import { setupFlexGapFallback } from './utils/flexGap.js'
import { restoreAuth, setAuthTransport } from './services/auth/store.js'
import { createAuthTransport, createPublicSettingsReader } from './services/auth/transport.js'
import { loadAuthFlags, setPublicSettingsReader } from './services/auth/flags.js'
import { getConsumeClient } from './services/consumeClient.js'
import {
  attachmentManager,
  collectReferencedAttachmentIds,
} from './services/attachments/manager.js'
import { setAttachmentService } from './components/attachments/attachmentService.js'
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
// Issue #331 之后下单链路已停用（我们不建单），cid 只剩「查历史订单」这一个用途。
//
// W1-B 后半（#487）**摘掉旧设备码通道**：启动时不再生成 device_id，也不再拿它去
// `GET <旧池域>/me` 换 cid —— 身份已换成 JWT 账号（`services/auth`），设备码体系作废（#482 / #484 §二）。
// 现在只有一条来源：本机 API Key 对应的 `GET /api/orders` 里的 customer_id（实测唯一可靠）。
// 拿不到就返回 null —— 查记录时按「查不到」处理，不再阻断任何流程。
setCustomerIdProvider(async () => {
  const key = getApiKey()
  if (key === '') {
    return null
  }
  const records = await fetchPaymentRecords(key, httpTransport)
  return records.kind === 'ok' ? records.data.customerId : null
})

// 身份层接线（W1-B，#487）：JWT 通道与 `settings/public` 开关都走 W1-A 的消费层客户端。
// 客户端是**全应用共用的一个实例**（`services/consumeClient.ts`）：凭据提供者按请求现取，
// JWT 续期 / 换 Key 之后下一条请求立刻生效；`apiKey` 只服务 `/v1/**`。
const consumeClient = getConsumeClient()
setAuthTransport(createAuthTransport(consumeClient))
setPublicSettingsReader(createPublicSettingsReader(consumeClient))

/**
 * 文档附件接线（#480 / #527）：把 `AttachmentManager` 单例注入 UI。
 *
 * 为什么在入口注入而不是组件里静态 import：`components/attachments/**` 只声明 manager 的
 * 公开签名（`AttachmentService`），不依赖它的实现 —— 单测 / 宿主可以换替身，UI 也永远不会自己
 * 造一套附件状态机（状态的权威在 manager：IndexedDB 记录 + 五态状态机 + 解析缓存去重）。
 * 与上面 `consumeClient` 的模式一致：入口一次注入，组件通过 `getAttachmentService()` 使用。
 *
 * `collectReferencedAttachmentIds` 一起注册：删除会话 / 消息后的孤儿清扫要先知道
 * 「还有哪些附件被消息引用着」，否则会把在用的记录一起清掉。
 */
setAttachmentService({
  addFile: (file) => attachmentManager.addFile(file),
  parse: (id, options) => attachmentManager.parse(id, options),
  remove: (id) => attachmentManager.remove(id),
  getMeta: (id) => attachmentManager.getMeta(id),
  sweepOrphans: (referenced) => attachmentManager.sweepOrphans(referenced),
  collectReferencedAttachmentIds,
})

/**
 * 启动时的登录态恢复（#608 拆登录墙之后）—— **后台静默，不挡首屏**。
 *
 * 拆掉登录墙之前，根部被 AuthGate 包着整个 App，于是未登录冷启动只有登录页，连「官方渠道 +
 * 自己的 Key」都用不了（#487 引入、#608 拆掉）。现在账户是「我们的渠道 → 账户与消费 → 账号」
 * 里的一块可选能力，规则的边界在这里：
 *
 *  - **不阻塞**：先把 `<App/>` 渲出去，恢复在后台跑；首屏不等任何网络。
 *  - **不跳页**：恢复结果只改 `useAuthStore` 的登录态（账号面板 / 额度面板据此切自己的局部
 *    登录卡或引导态），没有任何一条「未登录就换整屏」的分支。
 *  - **失败静默**：没登录 / 续期失败 / 离线都只是「这台机器当前没有账号」，`restoreAuth` 内部
 *    已经按「网络错误保留本地会话、JWT 不认才清态」处理；这里再兜一层 catch，绝不让恢复把
 *    启动路径带崩（`) => {}` 是这段代码的一部分，不是省事）。
 *  - 开关（`settings/public` 的注册 / 邀请码 / 验证码）同批读一次：账号区的局部登录卡要靠它
 *    决定注册入口显不显示，读不到就落保守默认（隐藏），与 #484 §3.1d 一致。
 *
 * `__TEST_AUTH_STATE__` 是构建期常量（见 `scripts/lib/testAuthSeam.mjs`）：测试构建里它已经被
 * 内联成假会话，此时**绝不能**再跑 `restoreAuth()` —— 盘上没有凭据，恢复会把假会话清成未登录，
 * 黄金回归的「启动即进主界面」就不再成立。生产构建里它折叠成 `undefined`，这个 `if` 恒真。
 */
declare const __TEST_AUTH_STATE__: unknown
if (typeof __TEST_AUTH_STATE__ === 'undefined') {
  void restoreAuth().catch(() => {})
  void loadAuthFlags()
}

// 根部包一层错误边界：渲染期异常不再是整屏白屏，而是一张可读的错误页（issue #28）
createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
