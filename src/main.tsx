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

// The ES5 HTML guard runs before the deferred bundle, including parse/import failures.
// Keep its actionable message visible rather than replacing it with a partial React tree.
if ((window as Window & { __DEEPSEEK_COMPATIBILITY_ERROR__?: string[] }).__DEEPSEEK_COMPATIBILITY_ERROR__) {
  throw new Error('WEBVIEW_CAPABILITY_MISSING')
}

ensureKatex()
setupTheme()

// 诊断：恢复上次落盘的日志并装上 window.onerror / console / fetch 等 hook（采集层与上传层解耦，见 services/diagnostics）
void initDiagnostics({ facts: readDiagnosticsFacts })
// 仅当 URL 带 ?diag-debug 时把调试入口挂到 window（本地验收脚本用，正常使用不暴露）
installDiagnosticsDebugHandle()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
