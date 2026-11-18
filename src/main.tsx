// 低内核 WebView 运行时补齐（issue #13）：必须是**第一个** import —— ESM 按声明顺序求值，
// 放在最前面才能保证下面所有模块（以及 React）拿到的是补齐后的 Object.hasOwn / at / structuredClone。
import './polyfills/legacy.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { readDiagnosticsFacts } from './app/diagnosticsContext.js'
import {
  initDiagnostics,
  installDiagnosticsDebugHandle,
} from './services/diagnostics/index.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'
import './app/motion.css'

// index.html 里的 ES5 守卫在脚本加载/解析阶段就判定过能力（那时本包可能连解析都没过）。
// 它已经把可读提示画进 #root 了，就别再用半装的 React 树把它覆盖成白屏。
if ((window as Window & { __DEEPSEEK_COMPATIBILITY_ERROR__?: string[] }).__DEEPSEEK_COMPATIBILITY_ERROR__) {
  throw new Error('WEBVIEW_CAPABILITY_MISSING')
}

ensureKatex()
setupTheme()

// 诊断：恢复上次落盘的日志并装上 window.onerror / console / fetch 等 hook（采集层与上传层解耦，见 services/diagnostics）
void initDiagnostics({ facts: readDiagnosticsFacts })
// 仅当 URL 带 ?diag-debug 时把调试入口挂到 window（本地验收脚本用，正常使用不暴露）
installDiagnosticsDebugHandle()

// 告诉 index.html 的 ES5 守卫「入口跑起来了」，它就不用再兜底报白屏（见 src/index.html）。
;(window as Window & { __DEEPSEEK_BOOTED__?: boolean }).__DEEPSEEK_BOOTED__ = true
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
