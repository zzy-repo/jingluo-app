// [layer: device | 依赖: Android 模拟器/真机 + adb | 耗时: 3~8 分钟] 说明见 tests/README.md
// 真机（Android WebView）验收：从链接导入 + CapacitorHttp 返回的 data 类型实测。
//
// 前置（脚本会自己处理能自动的部分）：
//   - 模拟器已启动（heavy-run ... -avd test34 -memory 1280）
//   - 5227 端口的静态服务由脚本自己拉起，提供 20MB / 40 会话的导出 ZIP
// 运行：node tests/device/url-import-device.test.mjs
// 说明：模拟器访问宿主机回环用 10.0.2.2；Playwright 的 connectOverCDP 不支持 WebView 的浏览器级
//       协议（Browser.setDownloadBehavior 报错），所以这里直接走 WebView 页面级 CDP。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { buildArchive } from '../fixtures/domain05/archive-fixture.mjs'

const ADB = process.env.ADB || '/root/android-sdk/platform-tools/adb'
const PACKAGE = 'com.example.deepseekchat'
const APK =
  process.env.APK || '/root/deepseek-app/android/app/build/outputs/apk/debug/app-debug.apk'
const PORT = Number(process.env.ARCHIVE_PORT || 5227)
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/tmp/device-archive'
// 外部真实 URL（如公网 OBS 签名链接）只从环境变量传入：DEVICE_ZIP_URL='https://…' 。
// 传了就用它、不起本地服务，会话数按界面提示的导入结果与 IndexedDB 对账。
const EXTERNAL_URL = process.env.DEVICE_ZIP_URL || ''
const ZIP_URL = EXTERNAL_URL || `http://10.0.2.2:${PORT}/deepseek_data.zip`
const SHOT_DIR = new URL('../../docs/ui/', import.meta.url).pathname

const sh = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
const check = (name, ok, detail = '') => {
  const line = `${name}${detail ? ` — ${detail}` : ''}`
  if (ok) {
    console.log(`  ✓ ${line}`)
  } else {
    failures.push(line)
    console.error(`  ✗ ${line}`)
  }
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket） */
const connectCdp = async (url) => {
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
    for (const listener of listeners) {
      listener(message)
    }
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
  return { socket, send, evaluate, listeners }
}

const shot = async (cdp, name) => {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = `${SHOT_DIR}1.4.0-beta.2-url-import-device-${name}.png`
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  console.log(`     截图 ${file}`)
}

const waitForText = async (cdp, texts, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(
      `(${JSON.stringify(texts)}).some((text) => document.body.innerText.includes(text))`
    )
    if (found) {
      return true
    }
    await sleep(300)
  }
  return false
}

/** 按钮文案中英通吃（设备默认语言可能是英文） */
const clickButton = async (cdp, names) =>
  cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(Array.isArray(names) ? names : [names])}
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
    const target = nodes.find((el) => wanted.includes(el.textContent.trim()))
    if (!target) {
      return 'not-found: ' + nodes.map((el) => el.textContent.trim()).filter(Boolean).join('|').slice(0, 400)
    }
    target.click()
    return 'ok'
  })()`)

/** 用 CDP 直接写输入框（真实 DOM 输入框 + React 受控组件），绕过 adb input text 的转义问题 */
const fillUrl = async (cdp, value) =>
  cdp.evaluate(`(() => {
    const input = document.querySelector('input[type="url"]')
    if (!input) { return 'not-found' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)

const sessionCount = (cdp) =>
  cdp.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('sessions')) { resolve(0); return }
      const count = db.transaction('sessions', 'readonly').objectStore('sessions').count()
      count.onsuccess = () => resolve(count.result)
      count.onerror = () => reject(count.error)
    }
  })`)

const run = async () => {
  // ── 被测包：外部真实 URL，或本地生成的 20MB / 40 会话导出 ZIP ─────────────
  let archive = null
  let server = null
  if (EXTERNAL_URL) {
    console.log(`被测 URL：外部真实链接（长度 ${EXTERNAL_URL.length} 字符，内容不打印）`)
  } else {
    archive = buildArchive({ sessionCount: 40, imageBytes: 512 * 1024 })
    mkdirSync(ARCHIVE_DIR, { recursive: true })
    writeFileSync(`${ARCHIVE_DIR}/deepseek_data.zip`, archive.zip)
    console.log(
      `被测 URL：本地 ${ZIP_URL}（${(archive.zip.byteLength / 1024 / 1024).toFixed(2)}MB / ${archive.entries} 条目 / ${archive.sessions} 个会话）`
    )
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '0.0.0.0'], {
      cwd: ARCHIVE_DIR,
      stdio: 'ignore',
    })
    await sleep(1200)
  }

  // ── 安装 APK 并启动 ─────────────────────────────────────────────────
  console.log(`\n[install] ${APK}`)
  console.log(sh('install', '-r', APK))
  sh('shell', 'am', 'force-stop', PACKAGE)
  sh('logcat', '-c')
  sh('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
  await sleep(6000)
  const pid = sh('shell', 'pidof', PACKAGE)
  sh('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`)
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const pageTarget = targets.find((target) => target.type === 'page')
  console.log(`pid=${pid} 页面=${pageTarget.url}`)

  const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl)
  const consoleErrors = []
  cdp.listeners.push((message) => {
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception')
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1500)

  console.log('\n[device 1] 运行环境')
  const env = await cdp.evaluate(
    `({ platform: window.Capacitor?.getPlatform?.(), native: window.Capacitor?.isNativePlatform?.(), hasNativePromise: typeof window.Capacitor?.nativePromise === 'function', href: location.href })`
  )
  check('Capacitor.getPlatform() = android', env.platform === 'android', String(env.platform))
  check('isNativePlatform() = true', env.native === true)
  check('原生桥 nativePromise 可用', env.hasNativePromise === true)

  // ── 实测 CapacitorHttp.get 返回的 data 类型 ──────────────────────────────
  // SKIP_MEASURE=1 跳过这一步：低内存模拟器上再多下一份 20MB 会把宿主机 memcg 顶爆。
  const skipMeasure = process.env.SKIP_MEASURE === '1'
  console.log('\n[device 2] CapacitorHttp.get({ responseType: "arraybuffer" }).data 实测类型')
  if (skipMeasure) {
    console.log('     跳过（SKIP_MEASURE=1，内存优先）')
  }
  if (!skipMeasure) {
    const measured = await cdp.evaluate(`(async () => {
      const startedAt = Date.now()
      const res = await window.Capacitor.nativePromise('CapacitorHttp', 'get', {
        url: ${JSON.stringify(ZIP_URL)},
        responseType: 'arraybuffer',
        connectTimeout: 30000,
        readTimeout: 180000,
        headers: { Accept: 'application/zip,application/octet-stream,*/*' },
      })
      const data = res?.data
      return {
        status: res?.status,
        dataType: typeof data,
        tag: Object.prototype.toString.call(data),
        base64Length: typeof data === 'string' ? data.length : null,
        decodedBytes: typeof data === 'string' ? atob(data.replace(/\\s/g, '')).length : (data?.byteLength ?? null),
        elapsedMs: Date.now() - startedAt,
        headers: res?.headers ?? null,
      }
    })()`)
    const contentLength =
      measured.headers?.['Content-Length'] ?? measured.headers?.['content-length']
    console.log(
      `     status=${measured.status} typeof data=${measured.dataType} ${measured.tag} ` +
        `base64=${measured.base64Length} 字符 → ${measured.decodedBytes} 字节 / ${measured.elapsedMs}ms / Content-Length=${contentLength}`
    )
    check('HTTP 200', measured.status === 200, String(measured.status))
    check(
      'data 实测为 base64 字符串（不是 ArrayBuffer）',
      measured.dataType === 'string',
      measured.tag
    )
    check('响应头带 Content-Length', contentLength != null, String(contentLength))
    check(
      '解码后字节数 = 响应头 Content-Length',
      Number(contentLength) === measured.decodedBytes,
      `${measured.decodedBytes} vs ${contentLength}`
    )
    check(
      'base64 长度 ≈ 字节数 × 4/3',
      Math.abs(measured.base64Length - (measured.decodedBytes * 4) / 3) < 4,
      `${measured.base64Length} vs ${(measured.decodedBytes * 4) / 3}`
    )
    if (archive) {
      check(
        '解码后字节数 = 源文件大小',
        measured.decodedBytes === archive.zip.byteLength,
        String(measured.decodedBytes)
      )
    }
  }

  // ── 真实 UI：设置 → 数据管理 → 从链接导入 20MB 包 ──────────────────────
  console.log('\n[device 3] 真实 UI：从链接导入 20MB 导出包')
  await cdp.evaluate('window.localStorage.clear()').catch(() => {})
  await cdp.send('Page.reload')
  await sleep(5000)
  if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`))) {
    check('打开设置', (await clickButton(cdp, ['设置', 'Settings'])) === 'ok')
    await sleep(1000)
  }
  check('切到数据管理', (await clickButton(cdp, ['数据管理', 'Data'])) === 'ok')
  await sleep(600)
  check(
    '原生端渲染了 URL 输入框',
    await cdp.evaluate(`!!document.querySelector('input[type="url"]')`)
  )
  check('导入前会话数 = 0', (await sessionCount(cdp)) === 0)
  const filledUrl = await fillUrl(cdp, ZIP_URL)
  check(
    '填入链接（长度一致，内容不打印）',
    filledUrl === ZIP_URL,
    `${String(filledUrl).length} 字符`
  )
  await shot(cdp, 'settings')
  check('点「从链接导入」', (await clickButton(cdp, ['导入', 'Import link'])) === 'ok')
  check(
    '覆盖确认弹窗出现',
    await waitForText(cdp, ['确认导入历史对话', 'Import chat history?'], 10000)
  )
  const startedAt = Date.now()
  check('点「确认导入」', (await clickButton(cdp, ['确认导入', 'Import'])) === 'ok')
  await sleep(1200)
  await shot(cdp, 'downloading')
  const downloading = await waitForText(cdp, ['下载中', 'Downloading'], 5000)
  check('下载中状态可见（「下载中...」）', downloading)
  // 20MB / 400+ 条目的包在模拟器上可能要几分钟，给足时间
  const imported = await waitForText(cdp, ['已导入', 'Imported'], 600_000)
  const elapsed = Date.now() - startedAt
  const count = await sessionCount(cdp)
  check('导入完成（界面给出「已导入 N 个对话」）', imported, `耗时 ${elapsed}ms，会话数 ${count}`)
  await shot(cdp, 'done')
  if (archive) {
    check(
      `IndexedDB 会话数 = ZIP 内会话数（${archive.sessions}）`,
      count === archive.sessions,
      String(count)
    )
  } else {
    check('IndexedDB 会话数 > 0（外部真实包）', count > 0, String(count))
  }
  check(
    '侧栏出现导入的会话',
    await cdp.evaluate(`document.body.innerText.includes('链接导入测试会话')`)
  )

  // ── 失败用例：错误链接要给可读提示，不能白屏/崩溃 ────────────────────────
  console.log('\n[device 4] 失败用例：404 链接')
  check('回到设置 → 数据管理', (await clickButton(cdp, ['数据管理', 'Data'])) === 'ok')
  await sleep(500)
  const badUrl = `http://10.0.2.2:${PORT}/not-exist.zip`
  check('填入错误链接', (await fillUrl(cdp, badUrl)) === badUrl)
  check('点「从链接导入」', (await clickButton(cdp, ['导入', 'Import link'])) === 'ok')
  await waitForText(cdp, ['确认导入历史对话', 'Import chat history?'], 10000)
  check('点「确认导入」', (await clickButton(cdp, ['确认导入', 'Import'])) === 'ok')
  const failed = await waitForText(cdp, ['HTTP 404', '异常状态', 'error status'], 60000)
  check('给出可读错误提示（含状态码）', failed)
  await shot(cdp, 'error')
  check(
    '导入失败后会话数不变',
    (await sessionCount(cdp)) === (archive ? archive.sessions : await sessionCount(cdp)),
    String(await sessionCount(cdp))
  )
  check(
    '界面仍可用（设置弹窗还在）',
    await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)
  )

  // ── logcat 证据 ───────────────────────────────────────────────────
  console.log('\n[device 5] logcat 证据（Capacitor / 网络）')
  const logcat = sh('logcat', '-d', '-t', '4000')
  const relevant = logcat
    .split('\n')
    .filter((line) => /Capacitor|CapacitorHttp|chromium|okhttp|NetworkSecurityConfig/i.test(line))
    .slice(-12)
  for (const line of relevant) {
    console.log(`     ${line}`)
  }
  check('logcat 有 Capacitor 相关日志', relevant.length > 0, `${relevant.length} 行`)
  const crashes = logcat
    .split('\n')
    .filter((line) => /FATAL EXCEPTION|ANR in com\.example\.deepseekchat/i.test(line))
  check('无崩溃 / ANR', crashes.length === 0, crashes.join(' | ').slice(0, 300))
  check('WebView console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))

  cdp.socket.close()
  server?.kill()

  if (failures.length > 0) {
    console.error(`\nFAIL 真机从链接导入：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(
    `\nPASS 真机从链接导入（${EXTERNAL_URL ? '外部真实 URL' : '本地 20MB / 40 会话'}，Android WebView）`
  )
}

await run()
