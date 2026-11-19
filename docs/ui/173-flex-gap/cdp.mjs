// Issue #173 取证用的最小 CDP + adb 工具（脚本自身不碰 src/）—— 协议核在
// scripts/compat/lib/cdp-core.mjs（Issue #289 收敛掉三份副本）。
//
// 本文件只保留 #173 这条线自己的差异点（量 flex gap 是「问一句就走」的短命令流，与
// #133 / compat 的「长时间订阅 + 截大图」不是同一套生命周期，所以适配层各自保留）：
//   - 超时默认 60s（量布局秒回；等待由调用方自己 sleep，不靠长超时兜）；
//   - 不订阅 CDP 事件（events: false），只认请求响应；
//   - attach() 直接返回 cdp 当句柄，不返回 {cdp,pid,page}；
//   - 截图挂在 cdp.shot() 上、只回 base64，写哪个文件由调用方决定；
//   - adb 路径走 process.env.ADB（写死的默认值属 #278）。
import { attachWebview, connectCdp as connectCdpCore, createSh, sleep } from '../../../scripts/compat/lib/cdp-core.mjs'

const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'
export const PACKAGE = 'com.example.deepseekchat'

export const sh = createSh(ADB)
export { sleep }

/** 极简 CDP 客户端：60s 默认超时、不收事件（与本目录命令流一致） */
export const connectCdp = (url) => connectCdpCore(url, { defaultTimeoutMs: 60_000, events: false })

/** 连当前前台 WebView 的页面级调试目标（App 必须已在前台） */
export const attach = async () => {
  const { page } = await attachWebview({ sh, pkg: PACKAGE })
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  // 截图随句柄返回 base64：本目录的 scan.mjs 要自己决定文件名（<tag>-wv<内核>-<宽度>-<页>.png）
  cdp.shot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    return data
  }
  return cdp
}

/** 当前 WebView 版本（判定「这台机器上是哪个内核」的唯一依据） */
export const webviewVersion = (cdp) => cdp.evaluate('navigator.userAgent')
