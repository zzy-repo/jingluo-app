#!/usr/bin/env node
/**
 * 手机端两档视口 UI 截图工具（Issue #106 / #102 / #115 验收用）。
 *
 * 为什么要有这个脚本：仓库规则要求 UI 改动的验收证据必须带 **390 / 360 两档宽度**截图，
 * 但之前每次都是在 `scripts/shot-72.mjs` 或某个 integration 测试里临时写一段 Playwright，
 * 换一张 Issue 就复制一遍。这里把它收成**参数化**的一条命令：
 *
 *   node scripts/shot-mobile.mjs --list
 *   node scripts/shot-mobile.mjs --page=header-scroll-top --viewport=390,360
 *   pnpm run shot:mobile -- --page=reading-settings --out=docs/ui/102-reading-settings
 *
 * 设备参数：390 × 844（常见国产手机 CSS 像素档）与 360 × 740（更窄的旧机型档），
 * `deviceScaleFactor: 2` + `isMobile` + `hasTouch` + `locale: zh-CN`，与 DevTools 设备模拟一致。
 * **注意：这是浏览器视口截图，不是真机截图**（不能替代 adb / 真机取证，见 docs/ISSUE-STANDARD.md）。
 *
 * 被测产物：默认读 `dist/`（先 `pnpm build:internal`），用**本地 http 服务**打开而不是 `file://`
 * —— `file://` 下 `/static/...` 这类绝对路径会落到盘符根目录，ES module 也拿不到正常 origin。
 * 端口默认 5420，被占用时退到系统分配的空闲端口（`--port=` / `SHOT_PORT=` 可指定）。
 *
 * 每个「场景 × 视口」把量到的数字写进 `<out>/<宽度>/metrics.json` 并打到 stdout，
 * 这样「字号真的变了没有」「44px 点击区够不够」「有没有横向溢出」不靠眼睛猜。
 * 本脚本**只截图、只量数**，不改任何 src 代码（发现问题写进 Issue 评论，另开单修）。
 */
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 两档验收宽度：CSS 像素尺寸，高度取同档常见机型 */
export const VIEWPORTS = {
  390: { width: 390, height: 844, label: '390×844' },
  360: { width: 360, height: 740, label: '360×740' },
}
export const DEFAULT_VIEWPORTS = ['390', '360']
export const DEFAULT_PORT = 5420
export const DEFAULT_DIST = 'dist'

/** 与 src/services/chat/db.ts 的 DB_VERSION 保持一致；fixture 建库结构必须与之一致 */
export const DB_VERSION = 12
/** 假 Key：只喂给界面让「服务配置」不是空态；订单接口被 route 拦掉，不会真的发出去 */
const FIXTURE_API_KEY = 'sk-shot-mobile-fixture-0000'

// ---------------------------------------------------------------- 参数与命名（纯函数，单测直接 import）

const splitList = (value) =>
  String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

/**
 * 解析命令行。支持 `--key=value` 与两个开关（`--list` / `--help`）。
 * 环境变量兜底：SHOT_PAGES / SHOT_VIEWPORTS / SHOT_OUT / SHOT_DIST_DIR / SHOT_PORT。
 */
export const parseArgs = (argv = [], env = {}) => {
  const options = {
    pages: null,
    viewports: null,
    out: null,
    dist: null,
    port: null,
    list: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--list') {
      options.list = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const match = /^--([a-z-]+)=(.*)$/u.exec(arg)
    if (match === null) {
      throw new Error(`不认识的参数：${arg}（用 --help 看用法）`)
    }
    const [, key, value] = match
    if (key === 'page' || key === 'pages') {
      options.pages = splitList(value)
    } else if (key === 'viewport' || key === 'viewports') {
      options.viewports = splitList(value)
    } else if (key === 'out') {
      options.out = value.trim()
    } else if (key === 'dist') {
      options.dist = value.trim()
    } else if (key === 'port') {
      options.port = Number(value)
    } else {
      throw new Error(`不认识的参数：--${key}（用 --help 看用法）`)
    }
  }
  if (options.pages === null && env.SHOT_PAGES) {
    options.pages = splitList(env.SHOT_PAGES)
  }
  if (options.viewports === null && env.SHOT_VIEWPORTS) {
    options.viewports = splitList(env.SHOT_VIEWPORTS)
  }
  options.out ??= env.SHOT_OUT || null
  options.dist ??= env.SHOT_DIST_DIR || null
  options.port ??= env.SHOT_PORT ? Number(env.SHOT_PORT) : null
  if (options.port !== null && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error(`--port 需要 0~65535 的整数，收到：${options.port}`)
  }
  return options
}

/** 视口档位规范化：空 / `all` / `both` → 两档；其余逐项校验 */
export const resolveViewports = (spec) => {
  if (spec === null || spec === undefined || spec.length === 0) {
    return [...DEFAULT_VIEWPORTS]
  }
  const flat = spec.flatMap((item) => (item === 'all' || item === 'both' ? DEFAULT_VIEWPORTS : [item]))
  for (const key of flat) {
    if (!(key in VIEWPORTS)) {
      throw new Error(`不支持的视口档位：${key}（可选：${Object.keys(VIEWPORTS).join(' / ')} / all）`)
    }
  }
  return [...new Set(flat)]
}

/** 场景名规范化：空 → 全部；未注册的名字直接报错，避免「名字拼错却静默截了 0 张」 */
export const resolvePages = (spec, registry) => {
  const names = spec === null || spec === undefined || spec.length === 0 ? Object.keys(registry) : spec
  for (const name of names) {
    if (!(name in registry)) {
      throw new Error(`未注册的场景：${name}（可用：${Object.keys(registry).join(' / ')}）`)
    }
  }
  return [...new Set(names)]
}

/** 截图文件名：`<场景>-<状态>-<宽度>.png`，仓库里既有截图就是这个读法 */
export const shotFileName = ({ page, state, viewport }) => {
  for (const value of [page, state, viewport]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`截图文件名片段不能为空：${JSON.stringify({ page, state, viewport })}`)
    }
    if (/[\\/:*?"<>|\s]/u.test(value)) {
      throw new Error(`截图文件名片段不能带路径分隔符或空白：${value}`)
    }
  }
  if (!(String(viewport) in VIEWPORTS)) {
    throw new Error(`不支持的视口档位：${viewport}`)
  }
  return `${page}-${state}-${viewport}.png`
}

/** 每档视口落到 `<场景目录>/<宽度>/` 下，避免文件名里堆太多段 */
export const shotDir = (outDir, viewport) => path.join(outDir, String(viewport))

// ---------------------------------------------------------------- 本地静态服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 起一个只读静态服务。端口被占用时退到系统分配端口（0），
 * 与 tests/integration/feedback-scroll.test.mjs 的做法一致：并发跑不会互相打死。
 */
export const startStaticServer = async (distDir, preferredPort = DEFAULT_PORT) =>
  new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        let filePath = path.join(distDir, decodeURIComponent(url.pathname))
        // 目录穿越保护：拼出来的路径必须仍在 dist 内
        if (!filePath.startsWith(distDir)) {
          response.writeHead(403).end('forbidden')
          return
        }
        let info = await stat(filePath).catch(() => null)
        if (info?.isDirectory()) {
          filePath = path.join(filePath, 'index.html')
          info = await stat(filePath).catch(() => null)
        }
        // 没有扩展名的路径当 SPA 路由，回落 index.html
        if (info === null && path.extname(filePath) === '') {
          filePath = path.join(distDir, 'index.html')
          info = await stat(filePath).catch(() => null)
        }
        if (info === null) {
          response.writeHead(404).end('not found')
          return
        }
        response.writeHead(200, {
          'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'content-length': info.size,
          'cache-control': 'no-store',
        })
        createReadStream(filePath).pipe(response)
      } catch (error) {
        response.writeHead(500).end(String(error))
      }
    })
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && preferredPort !== 0) {
        startStaticServer(distDir, 0).then(resolve, reject)
        return
      }
      reject(error)
    })
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : preferredPort
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })

// ---------------------------------------------------------------- 会话 fixture（写进 IndexedDB 再开新页）

/** 在页面里建库并写会话；结构与 src/services/chat/db.ts 的 upgrade 保持一致 */
const seedInPage = async ({ sessions, version }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo', version)
    request.onupgradeneeded = () => {
      const opened = request.result
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
        if (!opened.objectStoreNames.contains(name)) {
          opened.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = opened.objectStoreNames.contains('sessionSummaries')
        ? request.transaction.objectStore('sessionSummaries')
        : opened.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (!opened.objectStoreNames.contains('appAssets')) {
        opened.createObjectStore('appAssets', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const session of sessions) {
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        fileIds: [],
      })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  return sessions.length
}

const userMessage = (id, text, createdAt) => ({ id, role: 'user', content: text, files: [], createdAt })

const assistantMessage = (id, blocks, createdAt) => ({
  id,
  role: 'assistant',
  createdAt,
  model: null,
  prefix: false,
  status: 'done',
  blocks,
})

/** #106 用的长会话：26 轮问答，滚到底后离首条足够远 */
const LONG_SESSION_TITLE = '截图-长会话-回顶'
const makeLongSession = () => {
  const now = Date.now()
  const messages = []
  for (let index = 1; index <= 26; index += 1) {
    const at = now + index * 1000
    messages.push(userMessage(`shot-long-u${index}`, `第 ${index} 个问题：这一轮的标题栏回到首条消息能用吗？`, at))
    messages.push(
      assistantMessage(
        `shot-long-a${index}`,
        [
          {
            type: 'text',
            text: `第 ${index} 条回答。这一段是为了把消息滚动层撑出足够的滚动距离，让「双击回顶」有东西可回；每条写三行左右，390 与 360 两档都能滚出好几屏。`,
          },
        ],
        at + 1
      )
    )
  }
  return {
    id: 'shot-long-session',
    title: LONG_SESSION_TITLE,
    createdAt: now,
    updatedAt: now + 26000,
    messages,
  }
}

/** #102 用的阅读样本会话：正文里放一句带标记的话，量字号时按这句话找元素 */
export const READING_SAMPLE_MARKER = '字号样本：这一行用来对比阅读设置的档位。'
const READING_SESSION_TITLE = '截图-阅读设置样本'
const makeReadingSession = () => {
  const now = Date.now()
  return {
    id: 'shot-reading-session',
    title: READING_SESSION_TITLE,
    createdAt: now,
    updatedAt: now + 2000,
    messages: [
      userMessage('shot-reading-u1', '把阅读设置的三个档位都试一遍给我看看。', now),
      assistantMessage(
        'shot-reading-a1',
        [
          {
            type: 'text',
            text: [
              READING_SAMPLE_MARKER,
              '第二段：阅读设置只作用于消息区，聊天正文、思考内容和自己发的消息都跟着变；设置面板和输入框不跟着变。',
              '第三段：字号调到「特大」、字重调到「粗体」、行高调到「宽松」之后，这段文字应该明显变大变粗、行距变松，但不能溢出屏幕宽度，也不能把顶栏和输入框挤出可视区。',
            ].join('\n\n'),
          },
        ],
        now + 1
      ),
    ],
  }
}

// ---------------------------------------------------------------- #49 导入跳过条目的样本包

/** 与真实导出同序（manifest → 会话 JSON → 索引 → 图片），其中 s3 截断、s4 整会话无法构造 */
const IMPORT_TIME = '2026-11-01T00:00:00.000Z'

const importMessage = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: IMPORT_TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

const importSessionFile = ({ id, title, messages, imagePath }) => {
  const list = [...messages]
  if (imagePath !== undefined) {
    list[0] = {
      ...list[0],
      fragments: [
        ...list[0].fragments,
        {
          type: 'FILE',
          files: [
            {
              id: 'f4',
              file_name: 'image.png',
              file_size: 128,
              token_usage: null,
              inserted_at: IMPORT_TIME,
              export_path: imagePath,
              is_image: true,
              width: 512,
              height: 512,
            },
          ],
        },
      ],
    }
  }
  return strToU8(
    JSON.stringify({
      id,
      title,
      pinned: false,
      current_message_id: list[list.length - 1].id,
      inserted_at: IMPORT_TIME,
      updated_at: IMPORT_TIME,
      messages: list,
    })
  )
}

const importIndex = (sessions) =>
  strToU8(
    JSON.stringify(
      sessions.map(({ id, title }) => ({
        id,
        title,
        pinned: false,
        message_count: 2,
        inserted_at: IMPORT_TIME,
        updated_at: IMPORT_TIME,
      }))
    )
  )

/** 写一个「部分合法 + 部分不可识别」的导出包到临时目录，返回路径 */
const writeBrokenArchive = async () => {
  const image = 'chat_sessions/s4_files/f4_image.png'
  const png = new Uint8Array(128)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const archive = zipSync(
    {
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/s1.json': importSessionFile({
        id: 's1',
        title: '完好会话一',
        messages: [importMessage(1, null, 'USER', '问题一'), importMessage(2, 1, 'ASSISTANT', '回答一')],
      }),
      'chat_sessions/s2.json': importSessionFile({
        id: 's2',
        title: '完好会话二',
        messages: [importMessage(1, null, 'USER', '问题二'), importMessage(2, 1, 'ASSISTANT', '回答二')],
      }),
      'chat_sessions/s3.json': importSessionFile({
        id: 's3',
        title: '悬空父消息会话',
        messages: [importMessage(1, null, 'USER', '问题三'), importMessage(2, 99, 'ASSISTANT', '回答三')],
      }),
      'chat_sessions/s4.json': importSessionFile({
        id: 's4',
        title: '整会话损坏',
        messages: [importMessage(1, 7, 'ASSISTANT', '无主的回答')],
        imagePath: image,
      }),
      'chat_session_index.json': importIndex([
        { id: 's1', title: '完好会话一' },
        { id: 's2', title: '完好会话二' },
        { id: 's3', title: '悬空父消息会话' },
        { id: 's4', title: '整会话损坏' },
      ]),
      [image]: png,
    },
    { level: 0 }
  )
  const file = path.join(tmpdir(), 'ds-49-broken-archive.zip')
  await writeFile(file, Buffer.from(archive))
  return file
}

/** 量「跳过了 N 处损坏数据」这块：条数、逐条定位文案、有没有横向溢出 */
const measureSkippedBox = () => {
  const node = document.querySelector('[data-skipped-box]')
  if (node === null) {
    return null
  }
  const rect = node.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth
  const rows = Array.from(node.querySelectorAll('[data-skipped-entry]'))
  return {
    rows: rows.length,
    keys: rows.map((row) => row.getAttribute('data-skipped-entry')),
    texts: rows.map((row) => (row.innerText ?? '').replace(/\s+/gu, ' ').trim()),
    header: ((node.querySelector('[data-skipped-header]')?.innerText ?? '').replace(/\s+/gu, ' ').trim()),
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    viewportWidth,
    horizontalOverflow: node.scrollWidth > node.clientWidth + 1,
    rowsBeyondViewport: rows.filter((row) => row.getBoundingClientRect().right > viewportWidth + 1).length,
  }
}

/**
 * 量「抖音号」这一行：胶囊的位置/字号/颜色（醒目不醒目看这些数）、值本身、
 * 以及左侧文字列有没有被挤成窄条（#57 的坑：.text 的 flex-basis:0 会把 label 压成竖排）。
 */
const measureDouyinRow = () => {
  const pill = document.querySelector('[data-testid="douyin-id-copy"]')
  if (pill === null) {
    return null
  }
  const actions = pill.parentElement
  const row = actions === null ? null : actions.parentElement
  const value = pill.querySelector('span')
  const labelNode =
    row === null
      ? null
      : Array.from(row.querySelectorAll('div')).find((element) => (element.textContent ?? '').trim() === '抖音号')
  const pillRect = pill.getBoundingClientRect()
  const valueRect = value?.getBoundingClientRect() ?? null
  const labelRect = labelNode?.getBoundingClientRect() ?? null
  const rowRect = row?.getBoundingClientRect() ?? null
  const pillStyle = getComputedStyle(pill)
  const valueStyle = value === null ? null : getComputedStyle(value)
  const labelStyle = labelNode === null ? null : getComputedStyle(labelNode)
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = document.documentElement.clientHeight
  const round = (value) => Math.round(value)
  const box = (rect) =>
    rect === null
      ? null
      : { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
  return {
    pillText: (pill.innerText ?? '').replace(/\s+/gu, ' ').trim(),
    pill: box(pillRect),
    row: box(rowRect),
    pillStyle: {
      color: pillStyle.color,
      borderColor: pillStyle.borderColor,
      borderRadius: pillStyle.borderRadius,
      fontFamily: pillStyle.fontFamily,
    },
    valueStyle:
      valueStyle === null
        ? null
        : { fontFamily: valueStyle.fontFamily, fontSize: valueStyle.fontSize, fontWeight: valueStyle.fontWeight },
    value: box(valueRect),
    label: box(labelRect),
    labelStyle:
      labelStyle === null ? null : { fontSize: labelStyle.fontSize, lineHeight: labelStyle.lineHeight },
    viewportWidth,
    viewportHeight,
    // 整行（含胶囊）必须落在视口内：否则这张图证明不了「一眼能看到」
    inViewport:
      rowRect !== null &&
      rowRect.top >= 0 &&
      rowRect.bottom <= viewportHeight &&
      pillRect.right <= viewportWidth + 1,
    horizontalOverflow: row === null ? null : row.scrollWidth > row.clientWidth + 1,
  }
}

// ---------------------------------------------------------------- 页面内取数（在浏览器里跑，必须自成一体）

/** 顶栏四件事：点击区尺寸、提示是否真的渲染、标题是否被提示挤掉、滚动层是否溢出 */
const measureHeader = () => {
  const scrollable = /(auto|scroll|overlay)/
  const queue = [document.body]
  let host = null
  while (queue.length > 0) {
    const element = queue.shift()
    if (element === null || element === undefined) break
    if (scrollable.test(getComputedStyle(element).overflowY) && element.scrollHeight - element.clientHeight > 0) {
      if (host === null || element.scrollHeight > host.scrollHeight) host = element
    }
    for (const child of element.children) queue.push(child)
  }
  const round = (value) => Math.round(value * 10) / 10
  const button = document.querySelector('button[aria-label*="回到首条消息"]')
  if (button === null) {
    return { found: false, scrollTop: host === null ? null : round(host.scrollTop) }
  }
  const rect = button.getBoundingClientRect()
  const spans = Array.from(button.querySelectorAll('span'))
  const hint = spans.find((span) => span.textContent === '双击回顶') ?? null
  const titleSpan = spans[0] ?? null
  const hintStyle = hint === null ? null : getComputedStyle(hint)
  const titleStyle = titleSpan === null ? null : getComputedStyle(titleSpan)
  return {
    found: true,
    hitArea: { width: round(rect.width), height: round(rect.height) },
    ariaLabel: button.getAttribute('aria-label'),
    hint:
      hint === null
        ? null
        : {
            text: hint.textContent,
            width: round(hint.getBoundingClientRect().width),
            visible: hintStyle.display !== 'none' && hintStyle.visibility !== 'hidden' && hintStyle.opacity !== '0',
            color: hintStyle.color,
            fontSize: hintStyle.fontSize,
          },
    title:
      titleSpan === null
        ? null
        : {
            text: titleSpan.textContent,
            width: round(titleSpan.getBoundingClientRect().width),
            fontSize: titleStyle.fontSize,
            truncated: titleSpan.scrollWidth > titleSpan.clientWidth,
          },
    scrollTop: host === null ? null : round(host.scrollTop),
    scrollHeight: host === null ? null : Math.round(host.scrollHeight),
    clientHeight: host === null ? null : Math.round(host.clientHeight),
  }
}

/** 量阅读样本：字号 / 字重 / 行高真的变了没有，以及消息区有没有横向溢出 */
const measureReadingSample = (marker) => {
  const round = (value) => Math.round(value * 10) / 10
  const root = document.documentElement
  const candidates = Array.from(document.querySelectorAll('p, div, span, li')).filter((element) =>
    (element.textContent ?? '').includes(marker)
  )
  const sample = candidates.length === 0 ? null : candidates[candidates.length - 1]
  const style = sample === null ? null : getComputedStyle(sample)
  const box = sample === null ? null : sample.getBoundingClientRect()
  const scrollable = /(auto|scroll|overlay)/
  const queue = [document.body]
  let host = null
  while (queue.length > 0) {
    const element = queue.shift()
    if (element === null || element === undefined) break
    if (scrollable.test(getComputedStyle(element).overflowY) && element.scrollHeight - element.clientHeight > 0) {
      if (host === null || element.scrollHeight > host.scrollHeight) host = element
    }
    for (const child of element.children) queue.push(child)
  }
  const viewportWidth = document.documentElement.clientWidth
  const overflow = []
  if (host !== null) {
    for (const element of host.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.right > viewportWidth + 1) {
        overflow.push({ tag: element.tagName, right: round(rect.right), text: (element.textContent ?? '').slice(0, 24) })
      }
    }
  }
  return {
    attributes: {
      size: root.getAttribute('data-ds-reading-size'),
      weight: root.getAttribute('data-ds-reading-weight'),
      line: root.getAttribute('data-ds-reading-line'),
    },
    sample:
      sample === null
        ? null
        : {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            color: style.color,
            width: round(box.width),
            height: round(box.height),
          },
    host:
      host === null
        ? null
        : {
            scrollWidth: Math.round(host.scrollWidth),
            clientWidth: Math.round(host.clientWidth),
            horizontalOverflow: host.scrollWidth > host.clientWidth + 1,
          },
    documentScrollWidth: Math.round(root.scrollWidth),
    viewportWidth,
    overflowCount: overflow.length,
    overflowSamples: overflow.slice(0, 5),
  }
}

// ---------------------------------------------------------------- UI 动作

const S = {
  openSider: '打开边栏',
  collapseSider: '收起边栏',
  settings: '设置',
  tabGeneral: '通用设置',
  tabData: '数据管理',
  fontSize: '字号',
  fontWeight: '字重',
  lineHeight: '行高',
  optionXLarge: '特大',
  optionBold: '粗体',
  optionRelaxed: '宽松',
  paymentRecordsOpen: '[data-testid="payment-records-open"]',
  douyinCopy: '[data-testid="douyin-id-copy"]',
  titleButton: 'button[aria-label*="回到首条消息"]',
}

const openSiderIfNeeded = async (page) => {
  const settingsButton = page.getByRole('button', { name: S.settings, exact: true })
  if (await settingsButton.isVisible().catch(() => false)) {
    return
  }
  const menu = page.getByRole('button', { name: S.openSider })
  await menu.waitFor({ state: 'visible', timeout: 8000 })
  await menu.click()
  await page.waitForTimeout(320)
}

const openSession = async (page, title) => {
  await openSiderIfNeeded(page)
  await page.getByText(title, { exact: true }).first().click()
  await page.waitForSelector(S.titleButton, { timeout: 10000 })
  await page.waitForTimeout(450)
}

const openSettings = async (page, sectionLabel = S.tabGeneral) => {
  await openSiderIfNeeded(page)
  await page.getByRole('button', { name: S.settings, exact: true }).click()
  await page.getByRole('tab', { name: S.tabGeneral }).waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(350)
  if (sectionLabel !== S.tabGeneral) {
    await page.getByRole('tab', { name: sectionLabel }).click()
    await page.waitForTimeout(350)
  }
}

/** 打开某个下拉、截图，再选中目标项；返回选完之后触发器上的文字 */
const pickOption = async ({ page, shot, triggerLabel, optionLabel, state, clip }) => {
  const trigger = page.getByRole('button', { name: triggerLabel, exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: triggerLabel })
  await listbox.waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(180)
  await shot(state, clip === undefined ? {} : { clip })
  await listbox.getByRole('option', { name: optionLabel, exact: true }).click()
  await page.waitForTimeout(240)
  return (await trigger.innerText()).trim()
}

const closeDialog = async (page) => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

/** 关掉侧边栏：设置面板关掉之后它还是开着的，不关就拍不到消息区 */
const closeSider = async (page, size) => {
  const settingsButton = page.getByRole('button', { name: S.settings, exact: true })
  if (!(await settingsButton.isVisible().catch(() => false))) {
    return
  }
  const collapse = page.getByRole('button', { name: S.collapseSider })
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click()
  } else {
    // 兜底：点抽屉遮罩（离右边缘留 12px，避开输入框与发送键）
    await page.mouse.click(Math.round(size.width - 12), Math.round(size.height / 2))
  }
  await page.waitForTimeout(360)
}

/** 量对话框/面板的可见矩形，用于给截图加 clip（手机上它是底部大半个屏的浮层） */
const dialogClip = async (page, minHeight = 200) =>
  page.evaluate((height) => {
    const candidates = Array.from(document.querySelectorAll('[role="dialog"], [role="tablist"]'))
    for (const element of candidates) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 200 && rect.height > height) {
        return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.round(rect.width), height: Math.round(rect.height) }
      }
    }
    return null
  }, minHeight)

// ---------------------------------------------------------------- 场景注册表

/**
 * 每个场景一条：
 *  - `dir`        截图默认落地目录（`--out=` 可覆盖）
 *  - `title`      一句话说明（`--list` 会打印）
 *  - `sessions`   IndexedDB fixture，返回要写进 `chat-demo` 的会话数组
 *  - `mockOrders` 是否把 `GET /api/orders` 换成空订单响应（只在付款记录场景打开）
 *  - `run`        该场景的截图与量数步骤
 */
export const PAGES = {
  'header-scroll-top': {
    dir: 'docs/ui/106-mobile-header-scroll-top',
    title: '#106 移动端顶栏：「双击回顶」提示、44px 点击区、双击后回到首条消息',
    sessions: () => [makeLongSession()],
    mockOrders: false,
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, LONG_SESSION_TITLE)
      const scrolled = await page.evaluate(() => {
        // 判据与 measureHeader 里的找法一致：可滚的 overflow-y + 真的溢出，取溢出最多那个
        const scrollable = /(auto|scroll|overlay)/
        const queue = [document.body]
        let host = null
        while (queue.length > 0) {
          const element = queue.shift()
          if (element === null || element === undefined) break
          if (scrollable.test(getComputedStyle(element).overflowY) && element.scrollHeight - element.clientHeight > 0) {
            if (host === null || element.scrollHeight > host.scrollHeight) host = element
          }
          for (const child of element.children) queue.push(child)
        }
        if (host === null) return { found: false }
        host.scrollTop = host.scrollHeight
        return {
          found: true,
          scrollTop: Math.round(host.scrollTop),
          scrollHeight: Math.round(host.scrollHeight),
          clientHeight: Math.round(host.clientHeight),
        }
      })
      if (!scrolled.found) {
        throw new Error('没找到消息滚动层：长会话没有溢出，回顶无从验证')
      }
      await page.waitForTimeout(450)
      record('messageHost', scrolled)
      record('headerAtBottom', await page.evaluate(measureHeader))
      await shot('01-topbar-scrolled-to-bottom')
      await shot('02-topbar-closeup', { clip: { x: 0, y: 0, width: ctx.size.width, height: 150 } })

      const scrollBefore = (await page.evaluate(measureHeader)).scrollTop
      await page.locator(S.titleButton).dblclick()
      // 动画上限 600ms，留够余量再量
      await page.waitForTimeout(1200)
      const after = await page.evaluate(measureHeader)
      record('doubleTapScroll', { before: scrollBefore, after: after.scrollTop, reachedTop: after.scrollTop === 0 })
      record('headerAtTop', after)
      await shot('03-after-double-tap-first-message')
      await shot('04-after-double-tap-closeup', { clip: { x: 0, y: 0, width: ctx.size.width, height: 150 } })
      if (after.scrollTop !== 0) {
        warn(`双击后没有回到首条：scrollTop=${after.scrollTop}（动画被打断或被跟随逻辑抢回）`)
      }
    },
  },

  'reading-settings': {
    dir: 'docs/ui/102-reading-settings',
    title: '#102 设置 → 通用设置 → 阅读设置：三个下拉的渲染，默认档与最大档的文字渲染对比',
    sessions: () => [makeReadingSession()],
    mockOrders: false,
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)
      record('before', await page.evaluate(measureReadingSample, READING_SAMPLE_MARKER))
      await shot('01-message-default')

      await openSettings(page, S.tabGeneral)
      const sizeTrigger = page.getByRole('button', { name: S.fontSize, exact: true })
      await sizeTrigger.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await shot('02-settings-reading-default')

      const clip = await dialogClip(page)
      const picked = {}
      picked.size = await pickOption({
        page,
        shot,
        triggerLabel: S.fontSize,
        optionLabel: S.optionXLarge,
        state: '03-settings-size-dropdown-open',
        clip: clip ?? undefined,
      })
      picked.weight = await pickOption({
        page,
        shot,
        triggerLabel: S.fontWeight,
        optionLabel: S.optionBold,
        state: '04-settings-weight-dropdown-open',
        clip: clip ?? undefined,
      })
      picked.line = await pickOption({
        page,
        shot,
        triggerLabel: S.lineHeight,
        optionLabel: S.optionRelaxed,
        state: '05-settings-lineheight-dropdown-open',
        clip: clip ?? undefined,
      })
      record('triggersAfterPick', picked)
      await sizeTrigger.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await shot('06-settings-reading-max')

      await closeDialog(page)
      await closeSider(page, ctx.size)
      await page.waitForTimeout(420)
      if (await page.getByRole('button', { name: S.settings, exact: true }).isVisible().catch(() => false)) {
        warn('侧边栏没关掉，「最大档」的消息区截图会拍到抽屉')
      }
      const after = await page.evaluate(measureReadingSample, READING_SAMPLE_MARKER)
      record('after', after)
      await shot('07-message-max')

      if (ctx.metrics.before?.sample && after?.sample) {
        if (ctx.metrics.before.sample.fontSize === after.sample.fontSize) {
          warn(`字号没有变化：默认档与最大档都是 ${after.sample.fontSize}`)
        }
        if (after.host?.horizontalOverflow === true) {
          warn(`最大档下消息区横向溢出：scrollWidth=${after.host.scrollWidth} > clientWidth=${after.host.clientWidth}`)
        }
      }
    },
  },

  'payment-records': {
    dir: 'docs/ui/115-payment-records',
    title: '#115 设置 → 数据管理 → 付款记录：入口与弹层（当前无订单，只截空状态）',
    sessions: () => [makeReadingSession()],
    mockOrders: true,
    run: async (ctx) => {
      const { page, shot, record } = ctx
      await openSettings(page, S.tabData)
      const entry = page.locator(S.paymentRecordsOpen)
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await shot('01-settings-data-entry')
      await entry.click()
      await page.waitForTimeout(700)
      // 付款记录是叠在设置面板之上的第二层对话框：取 DOM 里最后一个可见的，别把外层设置面板的量进去
      const dialog = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 200 && rect.height > 100
        })
        const element = dialogs[dialogs.length - 1]
        if (element === undefined) return null
        const rect = element.getBoundingClientRect()
        return {
          layers: dialogs.length,
          text: (element.innerText ?? '').trim(),
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        }
      })
      if (dialog === null) {
        throw new Error('付款记录弹层没有打开')
      }
      record('dialog', dialog)
      record('state', {
        empty: dialog.text.includes('还没有付款记录'),
        error: /Unauthorized|请求失败|网络错误|订单查询失败/i.test(dialog.text),
      })
      await shot('02-payment-records')
      await shot('03-payment-records-closeup', {
        clip: { x: dialog.box.x, y: dialog.box.y, width: dialog.box.width, height: dialog.box.height },
      })
    },
  },

  'import-skipped': {
    dir: 'docs/ui/49-import-skipped',
    title: '#49 设置 → 数据管理 → 导入历史：部分损坏的包照样导入，界面列出跳过的条数与逐条定位',
    sessions: () => [makeReadingSession()],
    mockOrders: false,
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSettings(page, S.tabData)
      await page.waitForTimeout(320)
      await shot('01-settings-data-before-import')

      const archive = await writeBrokenArchive()
      const input = page.locator('input[type="file"][accept*="zip"]')
      await input.waitFor({ state: 'attached', timeout: 10000 })
      await input.setInputFiles(archive)
      const confirm = page.getByRole('button', { name: '确认导入', exact: true })
      await confirm.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(200)
      await shot('02-import-confirm')
      await confirm.click()

      // 覆盖全部本地数据后才会重渲染；跳过明细在成功提示下面
      const box = page.locator('[data-skipped-box]')
      await box.waitFor({ state: 'visible', timeout: 30000 })
      await page.waitForTimeout(600)
      await box.scrollIntoViewIfNeeded()
      await page.waitForTimeout(320)

      const measured = await page.evaluate(measureSkippedBox)
      record('skippedUi', measured)
      const statusText = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return ((dialog?.innerText ?? '').replace(/\s+/gu, ' ').trim() || '').slice(0, 400)
      })
      record('dialogText', statusText)
      record('state', {
        hasPartialStatus: /已导入 3 个会话，跳过 4 处损坏数据/u.test(statusText),
        rowsMatch: measured !== null && measured.rows === 4,
        listsSessionTitles: statusText.includes('悬空父消息会话') && statusText.includes('整会话损坏'),
      })
      if (measured === null) {
        throw new Error('导入完成后没有渲染跳过明细（[data-skipped-box] 找不到）')
      }
      if (measured.rows !== 4) {
        warn(`跳过明细条数为 ${measured.rows}，期望 4`)
      }
      if (measured.horizontalOverflow) {
        warn(`跳过明细横向溢出：scrollWidth > clientWidth（视口 ${measured.viewportWidth}）`)
      }
      if (measured.rowsBeyondViewport > 0) {
        warn(`${measured.rowsBeyondViewport} 行超出右边界（视口 ${measured.viewportWidth}）`)
      }
      await shot('03-import-skipped-details')
      await shot('04-import-skipped-closeup', {
        clip: {
          x: Math.max(0, measured.box.x - 4),
          y: Math.max(0, measured.box.y - 4),
          width: Math.min(measured.box.width + 8, ctx.size.width),
          height: measured.box.height + 8,
        },
      })
    },
  },
  'settings-douyin': {
    dir: 'docs/ui/settings-douyin',
    title: '设置 → 数据管理 → 抖音号：shiro_0824 的胶囊展示（等宽 + 强调色）与点击复制',
    sessions: () => [makeReadingSession()],
    mockOrders: false,
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSettings(page, S.tabData)
      const pill = page.locator(S.douyinCopy)
      await pill.waitFor({ state: 'visible', timeout: 10000 })
      await pill.scrollIntoViewIfNeeded()
      await page.waitForTimeout(320)

      const row = await page.evaluate(measureDouyinRow)
      if (row === null) {
        throw new Error('找不到抖音号那一行（[data-testid="douyin-id-copy"]）')
      }
      record('douyinRow', row)
      if (!row.pillText.includes('shiro_0824')) {
        warn(`胶囊上的值不是 shiro_0824：${JSON.stringify(row.pillText)}`)
      }
      if (!row.inViewport) {
        warn('抖音号一行没有完整落在视口内：这张图证明不了「一眼看到」')
      }
      if (row.horizontalOverflow === true) {
        warn('抖音号一行横向溢出：row.scrollWidth > clientWidth')
      }
      if (row.label !== null && row.label.width < 60) {
        warn(`左侧文字列被压扁：label 宽 ${row.label.width}px（#57 的坑）`)
      }
      await shot('01-settings-data-douyin')
      const rowBox = row.row ?? { x: 0, y: 0, width: ctx.size.width, height: 0 }
      await shot('02-douyin-row-closeup', {
        clip: {
          x: Math.max(0, rowBox.x - 4),
          y: Math.max(0, rowBox.y - 4),
          width: Math.min(rowBox.width + 8, ctx.size.width),
          height: rowBox.height + 8,
        },
      })

      // 点一下复制：证据是 toast 文案 + 剪贴板真实内容（context 已授予 clipboard 权限）
      await pill.click()
      await page.waitForTimeout(260)
      const toastText = await page
        .getByRole('status')
        .innerText()
        .catch(() => '')
      const clipboard = await page.evaluate(() =>
        navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
      )
      record('copy', { toastText: toastText.replace(/\s+/gu, ' ').trim(), clipboard })
      if (clipboard !== 'shiro_0824') {
        warn(`剪贴板内容不是 shiro_0824：${JSON.stringify(clipboard)}`)
      }
      if (!toastText.includes('已复制')) {
        warn(`没看到复制成功的提示：${JSON.stringify(toastText)}`)
      }
      await shot('03-douyin-copied-toast')
    },
  },
}

// ---------------------------------------------------------------- 主流程

const printUsage = () => {
  console.log(`手机端两档视口截图工具

用法：
  node scripts/shot-mobile.mjs --page=<场景>[,<场景>] --viewport=390,360 --out=<目录> [--dist=dist] [--port=5420]

参数：
  --page      场景名，逗号分隔；省略＝全部。可用：${Object.keys(PAGES).join(' / ')}
  --viewport  390 / 360 / all；默认两档都截
  --out       截图落地目录，默认取场景自带的 docs/ui/<issue>-<主题>
  --dist      被测产物目录，默认 ${DEFAULT_DIST}（先 pnpm build:internal）
  --port      本地静态服务端口，默认 ${DEFAULT_PORT}；被占用自动退到空闲端口
  --list      只列出场景，不截图
环境变量：SHOT_PAGES / SHOT_VIEWPORTS / SHOT_OUT / SHOT_DIST_DIR / SHOT_PORT

产物：<out>/<宽度>/<场景>-<状态>-<宽度>.png 与 <out>/<宽度>/metrics.json
注意：这是浏览器视口截图（设备模拟），不是真机截图。`)
}

const makeContext = ({ page, def, pageName, viewport, outDir, log }) => {
  const size = VIEWPORTS[viewport]
  const dir = shotDir(outDir, viewport)
  const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')
  const metrics = { page: pageName, title: def.title, viewport: Number(viewport), size: size.label, shots: [], notes: [] }
  return {
    page,
    size,
    dir,
    metrics,
    shot: async (state, { clip } = {}) => {
      const file = path.join(dir, shotFileName({ page: pageName, state, viewport }))
      await page.screenshot({ path: file, clip, animations: 'disabled' })
      metrics.shots.push(relative(file))
      log(`  · 截图 ${relative(file)}`)
      return file
    },
    record: (label, data) => {
      metrics[label] = data
      log(`  · 量数 ${label}: ${JSON.stringify(data)}`)
    },
    warn: (message) => {
      metrics.notes.push(message)
      log(`  ! ${message}`)
    },
  }
}

export const main = async (argv = process.argv.slice(2), env = process.env) => {
  const options = parseArgs(argv, env)
  if (options.help) {
    printUsage()
    return 0
  }
  if (options.list) {
    for (const [name, def] of Object.entries(PAGES)) {
      console.log(`${name.padEnd(20)} ${def.dir.padEnd(40)} ${def.title}`)
    }
    return 0
  }
  const pageNames = resolvePages(options.pages, PAGES)
  const viewportKeys = resolveViewports(options.viewports)
  const distDir = path.resolve(ROOT, options.dist ?? DEFAULT_DIST)
  const indexFile = path.join(distDir, 'index.html')
  const hasDist = await stat(indexFile).then((info) => info.isFile()).catch(() => false)
  if (!hasDist) {
    throw new Error(`找不到被测产物：${indexFile}（先 pnpm build:internal，或用 --dist= 指定目录）`)
  }

  const log = (message) => console.log(message)
  const server = await startStaticServer(distDir, options.port ?? DEFAULT_PORT)
  log(`· 静态服务 ${server.origin} → ${distDir}`)
  const browser = await chromium.launch()
  const results = []
  try {
    for (const pageName of pageNames) {
      const def = PAGES[pageName]
      const outDir = path.resolve(ROOT, options.out ?? def.dir)
      for (const viewport of viewportKeys) {
        const size = VIEWPORTS[viewport]
        log(`\n[${pageName}] ${size.label}`)
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          reducedMotion: 'reduce',
          colorScheme: 'light',
          // 「点一下复制」类改动要能复核剪贴板真实内容，否则只能看 toast 猜
          permissions: ['clipboard-read', 'clipboard-write'],
        })
        await context.addInitScript(
          ({ apiKey }) => {
            try {
              localStorage.setItem('chat-demo:api-key', apiKey)
              localStorage.setItem('chat-demo:provider-kind', 'deepseek')
            } catch {
              // 首屏之前 localStorage 不可用就跳过：界面显示空配置，不影响截图
            }
          },
          { apiKey: FIXTURE_API_KEY }
        )
        if (def.mockOrders) {
          // 只拦只读的订单查询，回代码注释里记录的真实响应形状（orders 为空）：
          // 截到的是「真的没有订单」的空状态，不是伪造的订单列表
          await context.route('**/api/orders', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ customer_id: 10, total_paid_yuan: 0.0, orders: [] }),
            })
          )
        }
        try {
          await mkdir(shotDir(outDir, viewport), { recursive: true })
          if (typeof def.sessions === 'function') {
            // 先在一个临时页里把 fixture 写进 IndexedDB，再开新页让 store 首次 hydration 就读到
            const warmer = await context.newPage()
            await warmer.goto(server.origin, { waitUntil: 'domcontentloaded' })
            await warmer.evaluate(seedInPage, { sessions: def.sessions(), version: DB_VERSION })
            await warmer.close()
          }
          const page = await context.newPage()
          const consoleErrors = []
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text())
          })
          page.on('pageerror', (error) => consoleErrors.push(String(error)))
          await page.goto(server.origin, { waitUntil: 'domcontentloaded' })
          await page.waitForTimeout(600)
          const ctx = makeContext({ page, def, pageName, viewport, outDir, log })
          await def.run(ctx)
          ctx.record('consoleErrors', consoleErrors.slice(0, 10))
          const metricsFile = path.join(ctx.dir, 'metrics.json')
          await writeFile(metricsFile, `${JSON.stringify(ctx.metrics, null, 2)}\n`, 'utf8')
          log(`  · 量数落盘 ${path.relative(ROOT, metricsFile).split(path.sep).join('/')}`)
          results.push(ctx.metrics)
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  log(`\n完成：${results.length} 个「场景 × 视口」组合`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  )
}
