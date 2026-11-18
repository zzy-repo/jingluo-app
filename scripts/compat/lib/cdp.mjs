// 页级 CDP 最小客户端 —— 抄自 docs/ui/133-weak-device/cdp.mjs（issue #133 取证时写的），
// 只把输出目录改成参数，别的逻辑一字未动：
//   - Playwright 的 connectOverCDP 对 WebView 走不通（只有页面级 CDP），所以手搓；
//   - 老 WebView（58/74/83）协议版本低，只用到 Runtime.evaluate / Page.enable / Log.enable，
//     这三个在很老的版本上也有；
//   - 连不上不算失败：老内核上 CDP 可能整个没有，调用方要退到 uiautomator dump。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ADB, PACKAGE, sleep } from './device.mjs'

export { PACKAGE, sleep }

export const sh = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim()

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
  const evaluate = async (expression, timeoutMs = 240_000) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }
  return { socket, send, evaluate, listeners, close: () => socket.close() }
}

/** 找当前 WebView 的页面级调试目标（App 必须已在前台）。WebView 太老/没开调试时抛错。 */
export const attach = async ({ port = 9222 } = {}) => {
  const pid = sh('shell', 'pidof', PACKAGE)
  if (!pid) {
    throw new Error('进程不在，没法 attach')
  }
  // 必须清掉旧转发：App 重启后 pid 变了，残留转发会指向已死的 webview（attach 成功但 evaluate 石沉大海）
  sh('forward', '--remove-all')
  sh('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = JSON.parse(
    execFileSync(
      'node',
      [
        '-e',
        `fetch('http://127.0.0.1:${port}/json/list').then(r => r.text()).then(t => process.stdout.write(t))`,
      ],
      { encoding: 'utf8' }
    )
  )
  const page = list.find((item) => item.type === 'page')
  if (!page) {
    throw new Error(`没有 page 目标: ${JSON.stringify(list).slice(0, 300)}`)
  }
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

export const waitFor = async (cdp, expression, timeoutMs = 60_000, interval = 150) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return true
    await sleep(interval)
  }
  return false
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
