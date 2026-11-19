/**
 * REPRO ONLY（Issue #373）：在浏览器里挂载**真实的** `AppUpdateField`，只换原生桥。
 *
 * 之所以要单独起一个 harness：组件在 APK 里才走「确认下载 / 安装更新」分支
 * （`isAndroidUpdate()` → `nativeUpdate.*`），而原生桥 `registerPlugin('AppUpdate')`
 * 在 rspack alias 里被换成了 tests/tools/repro-373/capacitor-mock.ts，
 * 所以这里点的是真按钮、跑的是真 `downloadUpdate()`、读的是真组件状态。
 */
import { createRoot } from 'react-dom/client'
import { AppUpdateField } from '../../../src/components/settings/AppUpdateField.js'

const host = document.getElementById('root')
if (!host) throw new Error('REPRO_HOST_MISSING')

createRoot(host).render(<AppUpdateField />)

// 首帧之后再放行，避免 driver 读到未挂载的空 DOM
requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __mounted?: boolean }).__mounted = true)))
