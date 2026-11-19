// 页级 CDP 最小客户端（模拟器矩阵取证用）—— 协议核在 lib/cdp-core.mjs（Issue #289 收敛掉三份副本）。
//
// 本文件只保留 compat 这条线自己的差异点：
//   - 设备解析走 matrix.config.json / 环境变量（device.mjs），不在这里拼 adb 路径（#278）；
//   - 端口可传（P2 导入要在 9222 之外再开一路）；
//   - Page.enable / Runtime.enable 失败不算 attach 失败：老内核上这两个域可能整个没有，
//     调用方要能退到 uiautomator dump；
//   - 截图写到调用方给的路径（shotCdp），带 BOOT_STATE 这个与 src/index.html 同源的页内判据。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ADB, PACKAGE, sleep } from './device.mjs'
import { attachWebview, connectCdp, createSh, waitFor } from './cdp-core.mjs'

export { PACKAGE, sleep, connectCdp, waitFor }

export const sh = createSh(ADB)

/** 连当前前台 WebView 的页面级调试目标。WebView 太老/没开调试时抛错。 */
export const attach = async ({ port = 9222 } = {}) => {
  const { pid, page } = await attachWebview({ sh, pkg: PACKAGE, port })
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Runtime.enable').catch(() => {})
  return { cdp, pid, page }
}

export const shotCdp = async (cdp, file) => {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  return file
}

/**
 * 兜底页/白屏的页内判据（与被测的守卫代码同源：src/index.html 里的 #compatibility-error
 * 与 window.__DEEPSEEK_BOOTED__ / __DEEPSEEK_COMPATIBILITY_ERROR__）。
 */
export const BOOT_STATE = `(() => {
  const box = document.getElementById('compatibility-error')
  const root = document.getElementById('root')
  return {
    url: location.href,
    title: document.title,
    booted: window.__DEEPSEEK_BOOTED__ === true,
    compatibilityError: window.__DEEPSEEK_COMPATIBILITY_ERROR__ === undefined
      ? null
      : window.__DEEPSEEK_COMPATIBILITY_ERROR__,
    boxPresent: Boolean(box),
    boxHidden: box ? box.hasAttribute('hidden') : null,
    boxText: box ? (box.innerText || '').trim().slice(0, 400) : null,
    bodyTextLength: (document.body.innerText || '').length,
    bodyTextHead: (document.body.innerText || '').trim().slice(0, 300),
    rootChildren: root ? root.children.length : null,
    rootHtmlLength: root ? root.innerHTML.length : null,
    readyState: document.readyState,
    userAgent: navigator.userAgent,
    hasTextarea: Boolean(document.querySelector('textarea')),
  }
})()`
