#!/usr/bin/env node
/**
 * P2 · 导入白屏 / OOM：本地 HTTP 服务喂不同体积与压缩比的导出包，走「设置 → Data → 从链接导入」实测。
 *
 * 为什么用 URL 导入这条路：它就是 Capacitor 原生网络栈 + 分段 Range 下载 + 整包 JSON 解析，
 * 全程在 WebView 里跑，内存/白屏问题最集中；而本地文件导入还要点系统文件选择器，
 * 老 WebView 上连选择器都可能起不来（那本身是另一个变量，先不混进来）。
 *
 * 归档不是另写一套：validate/serve 的是 lib/archives.mjs，它用的就是
 * tests/adversarial/lib/zip.mjs 那份手工 ZIP 构造器（声明尺寸 / 压缩比可控）。
 *
 * 用法：
 *   node scripts/compat/p2-import.mjs --api 26 --archive ctrl-1mb
 *   node scripts/compat/p2-import.mjs --api 26 --archive bomb-1000x --timeout 240
 *   node scripts/compat/p2-import.mjs --api 26 --dump        # 只把界面结构打出来（认选择器用）
 *
 * 观察项（全部原始值进 result-p2-<archive>.json）：
 *   每个采样点的可见文案 / 是否白屏 / __DEEPSEEK_BOOTED__ / 进程是否还在 / TOTAL PSS
 *   logcat 里的 lowmemorykiller / ActivityManager kill / OOM / chromium CONSOLE
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import {
  PACKAGE,
  adb,
  ensureDir,
  environment,
  evidenceDir,
  meminfoTotal,
  now,
  pidOf,
  saveJson,
  screencap,
  shell,
  sleep,
} from './lib/device.mjs'
import { BOOT_STATE, attach as attachCdp } from './lib/cdp.mjs'
import { ARCHIVE_NAMES, archiveOf } from './lib/archives.mjs'
import { click, dumpInteractive, typeInto, visibleTexts } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const API = option('api')
const ARCHIVE = option('archive', 'ctrl-1mb')
const PORT = Number(option('port', 5411))
const TIMEOUT_MS = Number(option('timeout', 240)) * 1000
const SAMPLE_MS = Number(option('sample', 1500))
const DUMP_ONLY = flag('dump')

if (!API) {
  console.error('用法：node scripts/compat/p2-import.mjs --api <NN> [--archive <name>] [--dump]')
  process.exit(2)
}

const TERMINAL = [
  /Imported \d+ chats?/,
  /Import from link failed/i,
  /exceeds the \d+MB limit/i,
  /Download failed/i,
  /Download timed out/i,
  /Network disconnected/i,
  /Invalid link/i,
  /No access to this link/i,
  /Import cancelled/i,
  // 注意：不要在这里放 "Parsing…" / "Downloading…" —— 那是过程态，命中就提前收工，看不到导入结果。
  // 产品自己的归档校验错误弹层（backupEntryUnreferenced / backupArchiveDamaged 一类）：
  // 文案里带条目序号，出现即说明「下载完成了、解析阶段被拒」，是终态。
  /Entry #\d+/,
  /is neither a session file/i,
  /may have been repacked/i,
  /ZIP is damaged/i,
  /内容不完整|不是有效压缩包|无法识别/,
]

/** 极简静态服务：支持 Range（App 是分段下载的），并如实回报 Content-Length / Content-Range。 */
const startServer = (port) => {
  const requests = []
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    const name = path.startsWith('/a/') ? path.slice(3) : null
    if (!name) {
      response.writeHead(404).end('not found')
      return
    }
    let bytes
    try {
      bytes = archiveOf(name)
    } catch (error) {
      response.writeHead(404).end(String(error.message))
      return
    }
    const total = bytes.length
    const range = request.headers.range
    const record = { at: Date.now(), method: request.method, path, range: range ?? null, total, status: 0, sent: 0 }
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const from = match && match[1] ? Number(match[1]) : 0
      const to = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
      if (from >= total) {
        record.status = 416
        requests.push(record)
        response.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
        return
      }
      const slice = bytes.subarray(from, to + 1)
      record.status = 206
      record.sent = slice.length
      requests.push(record)
      response.writeHead(206, {
        'Content-Type': 'application/zip',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${from}-${to}/${total}`,
        'Accept-Ranges': 'bytes',
      })
      response.end(request.method === 'HEAD' ? undefined : slice)
      return
    }
    record.status = 200
    record.sent = total
    requests.push(record)
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  })
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve({ server, requests, port }))
  })
}

const pageState = async (cdp) => {
  const boot = await cdp.evaluate(BOOT_STATE, 20_000).catch((error) => ({ error: error.message }))
  const texts = await visibleTexts(cdp).catch(() => [])
  return { boot, texts }
}

/** 进「设置 → Data」分区。每一步都记下来，失败时才知道卡在哪。 */
const openDataSection = async (cdp) => {
  const trace = []
  // 判据不能用 [role="tablist"]：主界面的 Fast/Expert 模式切换也是 tablist（见 p4-layout.mjs 的注释），
  // 用它判断「设置页开没开」会一直判成开着 → 侧栏和 Settings 都不点 → 后面全部找不到元素。
  // 真判据：设置弹层里的 General / Data 两颗 role=tab 按钮同时存在。
  let open = await cdp.evaluate(SETTINGS_OPEN_JS, 10_000).catch(() => false)
  trace.push({ step: 'settings-open-at-start', open })
  if (!open) {
    // 手机宽度下侧栏默认收起：先展开（aria 文案新旧版本不同，两个都试）
    for (const aria of ['Open sidebar', 'Expand sidebar']) {
      const expand = await click(cdp, { aria })
      trace.push({ step: `expand-sidebar:${aria}`, ...expand })
      if (expand.clicked) break
      await sleep(400)
    }
    await sleep(700)
    // 侧栏底部的 Settings 行是 button + 纯文本（class settings-xxxx），没有 aria-label，只能按文本点
    const settings = await click(cdp, { tag: 'button', text: 'Settings', exact: true })
    trace.push({ step: 'open-settings', ...settings })
    await sleep(1200)
    open = await cdp.evaluate(SETTINGS_OPEN_JS, 10_000).catch(() => false)
    trace.push({ step: 'settings-open-after-click', open })
  }
  const tab = await click(cdp, { tag: 'button', text: 'Data', exact: true })
  trace.push({ step: 'tab-data', ...tab })
  await sleep(500)
  const probe = await cdp
    .evaluate(
      `(() => {
        const input = Array.from(document.querySelectorAll('input')).find((node) => /https/.test(node.getAttribute('placeholder') || ''))
        return { urlInputPresent: Boolean(input), tabLabels: Array.from(document.querySelectorAll('[role="tab"]')).map((node) => (node.textContent || '').trim()) }
      })()`,
      10_000
    )
    .catch((error) => ({ error: error.message }))
  trace.push({ step: 'verify', ...probe })
  return trace
}

/** 「设置弹层是不是开着」的唯一判据：General / Data 两颗 role=tab 同时在。 */
const SETTINGS_OPEN_JS = `(() => {
  const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((node) => (node.textContent || '').trim())
  return labels.includes('General') && labels.includes('Data')
})()`

/**
 * 真机口径的填链接：adb tap 让输入框拿到焦点（真实触摸事件），再 adb input text 逐字敲。
 * 返回值里带「输入框 value / 焦点 / Import link 是否还 disabled」——只有 disabled 变 false
 * 才说明 React 的 onChange 真的收到了值（这是上一轮零请求的排查依据）。
 * 注意：CDP 给的 rect 是 CSS px，adb tap 要物理像素，得乘 devicePixelRatio。
 */
const typeViaAdb = async (cdp, url) => {
  const box = await cdp
    .evaluate(
      `(() => {
        const input = Array.from(document.querySelectorAll('input')).find((node) => /https/.test(node.getAttribute('placeholder') || ''))
        if (!input) return null
        input.scrollIntoView({ block: 'center' })
        const rect = input.getBoundingClientRect()
        return {
          x: Math.round((rect.left + rect.width / 2) * window.devicePixelRatio),
          y: Math.round((rect.top + rect.height / 2) * window.devicePixelRatio),
          dpr: window.devicePixelRatio,
        }
      })()`,
      10_000
    )
    .catch((error) => ({ error: error.message }))
  if (!box || box.error) {
    return { typed: false, reason: 'no-input', box }
  }
  shell('input', 'tap', String(box.x), String(box.y))
  await sleep(800)
  shell('input', 'text', url)
  await sleep(800)
  const state = await cdp
    .evaluate(
      `(() => {
        const input = Array.from(document.querySelectorAll('input')).find((node) => /https/.test(node.getAttribute('placeholder') || ''))
        const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent || '').trim() === 'Import link')
        return {
          value: input ? input.value : null,
          focused: document.activeElement === input,
          importDisabled: button ? button.disabled === true : null,
        }
      })()`,
      10_000
    )
    .catch((error) => ({ error: error.message }))
  return { typed: true, tap: box, state }
}

const main = async () => {
  const outDir = ensureDir(evidenceDir(API))
  ensureDir(`${outDir}/shots`)
  const startedAt = new Date().toISOString()
  const device = environment()
  console.log(`[${now()}] WebView：${device.webViewVersionLine}`)

  const { cdp } = await attachCdp()
  const result = {
    phase: 'p2-import',
    api: Number(API),
    archive: ARCHIVE,
    startedAt,
    device,
    navigation: [],
    samples: [],
    requests: [],
    serverPort: PORT,
  }

  if (DUMP_ONLY) {
    result.interactive = await dumpInteractive(cdp)
    result.texts = await visibleTexts(cdp)
    result.navigation = await openDataSection(cdp)
    result.interactiveAfter = await dumpInteractive(cdp)
    saveJson(`${outDir}/result-p2-dump.json`, result)
    console.log(JSON.stringify(result.interactiveAfter ?? result.interactive, null, 2))
    console.log(`dump 已写入 ${outDir}/result-p2-dump.json`)
    return
  }

  const { server, requests } = await startServer(PORT)
  const url = `http://10.0.2.2:${PORT}/a/${ARCHIVE}`
  console.log(`[${now()}] 服务 ${url}`)

  try {
    result.navigation = await openDataSection(cdp)

    // 填链接：真实触摸 + 真实按键为主，CDP 原生 setter 兜底（两条路都记进 typed）。
    const typed = await typeViaAdb(cdp, url)
    result.typed = typed
    console.log(`[${now()}] 填链接（adb）：${JSON.stringify(typed)}`)
    if (!typed.typed || typed.state?.importDisabled !== false) {
      const fallback = await typeInto(cdp, { tag: 'input', placeholder: 'https://' }, url)
      result.typedFallback = fallback
      console.log(`[${now()}] 退回 CDP setter：${JSON.stringify(fallback)}`)
      await sleep(400)
    }

    const start = await click(cdp, { tag: 'button', text: 'Import link', exact: true })
    result.startClick = start
    console.log(`[${now()}] 点开始：${JSON.stringify(start)}`)
    await sleep(900)

    // 确认弹层（historyImportConfirmTitle = "Import chat history?"，确认按钮纯文本 "Import"）。
    // 弹层可能晚一点挂上，最多等 10s；一直没出现就把当时的文案与可交互元素全记下来。
    let confirm = { clicked: false }
    const confirmDeadline = Date.now() + 10_000
    while (Date.now() < confirmDeadline) {
      confirm = await click(cdp, { tag: 'button', text: 'Import', exact: true })
      if (confirm.clicked) break
      await sleep(500)
    }
    result.confirmClick = confirm
    if (confirm.clicked) {
      console.log(`[${now()}] 已点确认`)
    } else {
      result.confirmDebug = {
        texts: await visibleTexts(cdp).catch(() => []),
        interactive: await dumpInteractive(cdp).catch((error) => ({ error: error.message })),
      }
      console.log(`[${now()}] 确认弹层没出现：${JSON.stringify((result.confirmDebug.texts ?? []).slice(0, 10))}`)
    }

    const deadline = Date.now() + TIMEOUT_MS
    let index = 0
    let terminal = null
    while (Date.now() < deadline) {
      index += 1
      const pid = pidOf()
      const memory = meminfoTotal()
      const state = pid ? await pageState(cdp) : { boot: null, texts: [] }
      const texts = state.texts ?? []
      const joined = texts.join(' | ')
      const sample = {
        at: Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 100) / 10,
        pid,
        totalPssKb: memory.totalPssKb,
        meminfoLine: memory.line,
        booted: state.boot?.booted ?? null,
        fallbackText: state.boot?.boxText ?? null,
        bodyTextLength: state.boot?.bodyTextLength ?? null,
        texts: texts.slice(0, 30),
        cdpError: state.boot?.error ?? null,
      }
      result.samples.push(sample)
      if (index === 1) {
        screencap(`${outDir}/shots/p2-${ARCHIVE}-start.png`)
      }
      terminal = TERMINAL.find((pattern) => pattern.test(joined)) ?? null
      console.log(
        `[${now()}] +${sample.at}s pid=${pid ?? 'DEAD'} pss=${memory.totalPssKb ?? '?'}MB? ${joined.slice(0, 120)}`
      )
      if (pid === null) {
        terminal = 'PROCESS_DEAD'
        break
      }
      if (terminal) {
        break
      }
      await sleep(SAMPLE_MS)
    }
    result.terminal = terminal === 'PROCESS_DEAD' ? 'PROCESS_DEAD' : (terminal?.source ?? terminal?.toString() ?? null)
    result.timedOut = terminal === null
    // 终态口径：进程死 / 命中终态文案 / 白屏（DOM 里没字）/ 一直没到终态
    const lastSample = result.samples[result.samples.length - 1] ?? {}
    result.pidSeen = [...new Set(result.samples.map((sample) => sample.pid ?? 'DEAD'))]
    result.pssPeakKb = result.samples.reduce(
      (peak, sample) => (typeof sample.totalPssKb === 'number' && (peak === null || sample.totalPssKb > peak) ? sample.totalPssKb : peak),
      null
    )
    result.verdict =
      result.terminal === 'PROCESS_DEAD'
        ? 'PROCESS_DEAD'
        : result.terminal
          ? `TERMINAL_TEXT:${result.terminal}`
          : (lastSample.bodyTextLength ?? 0) === 0
            ? 'WHITE_SCREEN_EMPTY_DOM'
            : 'NO_TERMINAL_TEXT'
    screencap(`${outDir}/shots/p2-${ARCHIVE}-end.png`)
    result.serverRequests = requests.slice(-200)
    result.requestCount = requests.length
    result.requestBytes = requests.reduce((sum, item) => sum + item.sent, 0)
    const logcat = adb(['logcat', '-d', '-v', 'threadtime'])
    writeFileSync(`${outDir}/logcat-p2-${ARCHIVE}.txt`, `${logcat}\n`)
    result.logcat = {
      file: `${outDir}/logcat-p2-${ARCHIVE}.txt`,
      kills: logcat
        .split(/\r?\n/)
        .filter((line) => /lowmemorykiller|ActivityManager.*(kill|Killing)|OOM|OutOfMemory|ANR in/.test(line))
        .slice(0, 60),
      console: logcat
        .split(/\r?\n/)
        .filter((line) => /chromium/.test(line))
        .slice(-80),
    }
    result.finishedAt = new Date().toISOString()
    saveJson(`${outDir}/result-p2-${ARCHIVE}.json`, result)
    console.log(`\n=== ${ARCHIVE} 结论 ===`)
    console.log(`终态：${result.terminal ?? '未到终态（超时）'}，进程：${pidOf() ?? 'DEAD'}`)
    console.log(`证据：${outDir}`)
  } finally {
    // App 用的是 keep-alive 连接，server.close() 不掐已建连接，node 会一直挂着不退出
    server.closeAllConnections?.()
    server.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`失败：${error.message}`)
    process.exit(1)
  })
