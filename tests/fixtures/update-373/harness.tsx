/**
 * Issue #373 回归用例的被测入口：在浏览器里挂**真实的** `AppUpdateField`，只换掉原生桥。
 *
 * 为什么需要它：组件里「确认下载 / 安装更新」这条分支只有 APK 里才走
 * （`isAndroidUpdate()` → `nativeUpdate.*`），而原生桥 `registerPlugin('AppUpdate')`
 * 在本目录的 `capacitor-mock.ts` 里被 rspack alias 顶掉（见 update-stuck-button-373.test.mjs）。
 * 因此这里点的是真按钮、跑的是真 `downloadUpdate()`、读的是真组件状态，
 * 唯一被替换的是 `AppUpdatePlugin.java` 那一层的实现。
 */
import { createRoot } from 'react-dom/client'
import { AppUpdateField } from '../../../src/components/settings/AppUpdateField.js'

const host = document.getElementById('root')
if (!host) throw new Error('HARNESS_HOST_MISSING')

createRoot(host).render(<AppUpdateField />)

// 首帧之后再放行，避免用例读到还没挂上的空 DOM
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    ;(window as unknown as { __mounted?: boolean }).__mounted = true
  })
)
