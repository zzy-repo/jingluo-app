/**
 * 域10 harness 的被测入口（#362 §3.2 N5）。
 *
 * 在浏览器里挂**真实的** `AppUpdateField`，只把原生桥换掉：
 * `@capacitor/core` 由 rspack alias 指向本目录的 `capacitor-mock.ts`（见 rspack.harness.config.ts）。
 *
 * 因此 `tests/integration/domain10-update-install-flow.test.mjs` 里点的是真按钮、
 * 跑的是真 `downloadUpdate()`、读的是真组件状态 —— 唯一被替换的是
 * `android/…/AppUpdatePlugin.java` 那一层的实现（本机没有 Android，也不该为了测 JS 装一台）。
 */
import { createRoot } from 'react-dom/client'
import { AppUpdateField } from '../../../src/components/settings/AppUpdateField.js'

const host = document.getElementById('root')
if (!host) throw new Error('HARNESS_HOST_MISSING')

createRoot(host).render(<AppUpdateField />)

// 双 rAF：等 React 把首帧真的挂上 DOM 之后再放行，用例不会读到空树
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    ;(window as unknown as { __mounted?: boolean }).__mounted = true
  })
)
