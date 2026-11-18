// Issue #133 取证用的最小 CDP + adb 工具（脚本自身不碰 src/）。
//
// 为什么不用 Playwright：WebView 只有页面级 CDP，connectOverCDP 走不通
// （tests/device/url-import-device.test.mjs 文件头已记录同一结论）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'
export const PACKAGE = 'com.example.deepseekchat'
export const OUT = new URL('.', import.meta.url).pathname.replace(/^\//, '')

export const sh = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim()
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 极简 CDP 客户端（Node 22 自带 WebSocket） */
export const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = (event) => reject(new Error(`ws error: ${event?.message ?? 'unknown'}`))
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)))
      } else {
        resolve(message.result)
      }
      return
    }
    for (const listener of listeners) listener(message)
  }
  const send = (method, params = {}, timeoutMs = 240_000) =>
    new Promise((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }
  return { socket, send, evaluate, listeners, close: () => socket.close() }
}

/** 找当前 WebView 的页面级调试目标（App 必须已在前台） */
export const attach = async () => {
  const pid = sh('shell', 'pidof', PACKAGE)
  // 必须清掉旧转发：App 重启后 pid 变了，残留的 9222 转发会指向已死的 webview，
  // 表现为 attach 成功但每条 evaluate 都石沉大海。
  sh('forward', '--remove-all')
  sh('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`)
  const list = JSON.parse(execFileSync('node', ['-e', `
    fetch('http://127.0.0.1:9222/json/list').then(r => r.text()).then(t => process.stdout.write(t))
  `], { encoding: 'utf8' }))
  const page = list.find((item) => item.type === 'page')
  if (!page) throw new Error(`没有 page 目标: ${JSON.stringify(list)}`)
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
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

/** 等页面里某个条件成立 */
export const waitFor = async (cdp, expression, timeoutMs = 60_000, interval = 150) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return true
    await sleep(interval)
  }
  return false
}
