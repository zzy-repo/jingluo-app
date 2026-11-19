// 页面级 CDP 协议核 —— 三处「极简 CDP 客户端」唯一共用的一份实现（Issue #289）。
//
// 为什么会有这个文件：scripts/compat/lib/cdp.mjs、docs/ui/133-weak-device/cdp.mjs、
// docs/ui/173-flex-gap/cdp.mjs 三份各自实现了同一件事（连 adb → 取 webview socket →
// WebSocket 说话 → 发 Runtime.evaluate），其中「连接建立 / 请求响应配对 / 超时 / adb 转发
// 与目标发现」这几段是**逐字相同**的。协议细节改一处漏两处，取证脚本挂住时就分不清是被测
// WebView 的问题还是某个副本的问题 —— 所以这部分只留这里一份。
//
// 这里**只**放真正重复的东西，三个调用方各自的差异留在各自的适配器里，一个都不抹平：
//   - 超时默认值：compat / 133 是 240s（P2 导入 200MB 包要等），173 是 60s（量布局秒回）；
//   - 事件分发：compat / 133 收 Log.entryAdded / Runtime.consoleAPICalled，173 只发命令不订阅；
//   - attach 返回形状与生命周期：compat/133 返回 {cdp,pid,page} 且要自己管 close，
//     173 直接把 cdp 当句柄返回、把截图挂在 cdp.shot() 上；
//   - 截图落盘策略：compat 写到调用方给的路径，133 写到 OUT/screens/<name>.png，
//     173 只回 base64 由调用方决定写哪；
//   - 设备解析：compat 走 matrix.config.json（device.mjs），docs/ui 两份走 process.env.ADB
//     （路径配置化归 #278，本文件不碰，所以这里不 import 任何配置）。
//
// 为什么会自己写而不用 Playwright：WebView 只有页面级 CDP，connectOverCDP 走不通
// （tests/device/url-import-device.test.mjs 文件头已记录同一结论）。老 WebView（58/74/83）
// 协议版本低，这里只用 Runtime.evaluate / Page.enable / Runtime.enable / Log.enable 这类
// 很老的内核也有的命令。
//
// 连不上不算失败：老内核上 CDP 可能整个没有，调用方要退到 uiautomator dump。
import { execFileSync } from 'node:child_process'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** adb 执行器：adb 路径由调用方决定（env / 矩阵配置），这里只管怎么调 —— 一律 execFileSync 传数组，
 *  不经过 shell，避免 MSYS 把 `/sdcard/x` 改写成 `D:/Program Files/Git/sdcard/x`。 */
export const createSh = (adb) => (...args) => execFileSync(adb, args, { encoding: 'utf8' }).trim()

/**
 * 极简 CDP 客户端（Node 22 自带 WebSocket）。
 *
 * @param url               页面级调试目标的 webSocketDebuggerUrl
 * @param defaultTimeoutMs  每条命令的默认超时；调用方按自己的场景钉（240s / 60s）
 * @param events            true = 把带 id 的响应之外的消息分发给 listeners（命令事件订阅）；
 *                          false = 只认请求响应，其余丢弃（173 那种「只问一句就走」的场景）
 */
export const connectCdp = async (url, { defaultTimeoutMs = 240_000, events = true } = {}) => {
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
    if (!events) {
      return
    }
    for (const listener of listeners) listener(message)
  }
  const send = (method, params = {}, timeoutMs = defaultTimeoutMs) =>
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
  const evaluate = async (expression, timeoutMs = defaultTimeoutMs) => {
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

/**
 * 连到「当前前台 WebView」的页面级调试目标（App 必须已在前台）。
 *
 * 三份实现里这段逐字相同，所以只留一份：
 *   pidof <pkg> → forward --remove-all → forward tcp:<port> localabstract:webview_devtools_remote_<pid>
 *   → GET /json/list → 取第一个 type=page 的目标。
 *
 * 必须清掉旧转发：App 重启后 pid 变了，残留转发会指向已死的 webview —— 表现为 attach 成功
 * 但每条 evaluate 都石沉大海（docs/ui/133-weak-device/README.md 记过这个坑，三处都要防）。
 *
 * @param sh         createSh(adb) 得到的 adb 执行器
 * @param pkg        包名
 * @param port       本地转发端口（默认 9222）
 * @returns {{ pid: string, page: object }} page 是 /json/list 里的目标对象
 */
export const attachWebview = async ({ sh, pkg, port = 9222 }) => {
  const pid = sh('shell', 'pidof', pkg)
  if (!pid) {
    // 三份实现里只有 compat 那份原来查了这个；不查就是 adb forward 报一句难懂的错。
    // 统一成一句人话，三处都受益（不改任何成功路径的行为）。
    throw new Error('进程不在，没法 attach')
  }
  sh('forward', '--remove-all')
  sh('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
  // 用子进程发这一次 HTTP：保持三份实现原来的取目标方式不变（不引新依赖、不受本进程代理环境影响）
  const raw = execFileSync(
    'node',
    [
      '-e',
      `fetch('http://127.0.0.1:${port}/json/list').then(r => r.text()).then(t => process.stdout.write(t))`,
    ],
    { encoding: 'utf8' }
  )
  const list = JSON.parse(raw)
  const page = list.find((item) => item.type === 'page')
  if (!page) {
    throw new Error(`没有 page 目标: ${JSON.stringify(list).slice(0, 300)}`)
  }
  return { pid, page }
}

/** 等页面里某个条件成立（两份实现逐字相同，抽到这里）。 */
export const waitFor = async (cdp, expression, timeoutMs = 60_000, interval = 150) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return true
    await sleep(interval)
  }
  return false
}
