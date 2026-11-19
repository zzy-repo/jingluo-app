// Issue #133 取证用的最小 CDP + adb 工具（脚本自身不碰 src/）—— 协议核在
// scripts/compat/lib/cdp-core.mjs（Issue #289 收敛掉三份副本）。
//
// 本文件只保留 #133 这条线自己的差异点：
//   - 证据目录钉在本目录（OUT），截图 = OUT/screens/<name>.png；
//   - 额外要 Runtime.getHeapUsage（弱网/弱机是在看内存与首屏，heap 是这一线的核心指标）；
//   - adb 路径走 process.env.ADB（换机器设环境变量，写死的默认值属 #278）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { attachWebview, connectCdp, createSh, sleep, waitFor } from '../../../scripts/compat/lib/cdp-core.mjs'

const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'
export const PACKAGE = 'com.example.deepseekchat'
export const OUT = new URL('.', import.meta.url).pathname.replace(/^\//, '')

export const sh = createSh(ADB)
export { sleep, connectCdp, waitFor }

/** 连当前前台 WebView 的页面级调试目标（App 必须已在前台） */
export const attach = async () => {
  const { pid, page } = await attachWebview({ sh, pkg: PACKAGE })
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Runtime.enable').catch(() => {})
  return { cdp, pid, page }
}

export const shot = async (cdp, name) => {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${OUT}screens/${name}.png`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  return file
}

export const heap = async (cdp) => {
  const usage = await cdp.send('Runtime.getHeapUsage')
  return {
    usedMB: +(usage.usedSize / 1024 / 1024).toFixed(1),
    totalMB: +(usage.totalSize / 1024 / 1024).toFixed(1),
  }
}
