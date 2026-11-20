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

import { inviteBaseUrl } from './lib/endpoints.mjs'
// #386 的「流式中」截图要把 streaming 这个状态撑开：用同一份 ours 上游契约回 SSE（含 CORS 头），
// 只是刻意延后 4 秒再回，好在上翻之后再截。
import { OURS_CHAT_PATH, OURS_CORS, openAiSse } from '../tests/fixtures/domain03-04/ours-upstream.mjs'

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
/**
 * #235：套餐 / 档案都是只读接口，打桩地址与集成测试同一份（明文邀请服 + 卡密主站）。
 * 邀请服地址来自 config/endpoints.json（#274），这里不再写字面量。
 */
const SHOT_INVITE_API = inviteBaseUrl
const SHOT_CARD_API = 'https://apia.ecsafe.cn'

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

// ---------------------------------------------------------------- #324 官方渠道失败样本

/** 会话标题：截图里靠它进会话 */
const ERROR_SESSION_TITLE = '截图-失败分类-324'
/**
 * #324 用的失败样本会话：消息体里的 status / message / upstreamCode 都是
 * 2026-11-19 对官方端点（https://api.deepseek.com/anthropic/v1/messages）的真实抓取，
 * 只截掉 request_id。第三条是「上游给了状态码与短码但我们还不认识」的形态
 * （官方端点目前没抓到这种，用 451 构造成一个不会撞上既有档位的样本），
 * 用来验证兜底提示确实带状态码 + 短码，且「复制诊断信息」能真的复制出内容。
 */
const makeErrorSession = () => {
  const now = Date.now()
  const failed = (id, createdAt, error) => ({
    ...assistantMessage(id, [], createdAt),
    status: 'error',
    error,
  })
  return {
    id: 'shot-error-session',
    title: ERROR_SESSION_TITLE,
    createdAt: now,
    updatedAt: now + 4000,
    messages: [
      userMessage('shot-error-u1', '用一个不存在的模型名发一句试试。', now),
      failed('shot-error-a1', now + 1, {
        kind: 'http',
        status: 400,
        upstreamCode: 'invalid_request_error',
        message:
          'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed no-such-model.',
      }),
      userMessage('shot-error-u2', '再来一个上游没见过的错误形态。', now + 2),
      failed('shot-error-a2', now + 3, {
        kind: 'http',
        status: 451,
        upstreamCode: 'unsupported_region',
        message: 'totally new upstream failure shape',
      }),
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

// ---------------------------------------------------------------- #386 回到底部

/**
 * 把 #386 的取数工具装进页面（`window.__toBottom`）。
 *
 * `page.evaluate` 的函数体在页面里**自成一体**，调不到 Node 侧的函数，所以这里装一次、
 * 之后每次取值只写一行 `page.evaluate(() => window.__toBottom.measure())`。
 */
const installToBottomHelpers = () => {
  /** 消息滚动层：可滚的 overflow-y 且真溢出，取溢出最多那个（与 measureHeader 同一判据） */
  const findHost = () => {
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
    return host
  }

  const round = (value) => Math.round(value * 10) / 10

  window.__toBottom = {
    /**
     * 离底部多远、按钮在不在、按钮压在输入框上面还是挡住它。
     * 「挡住」的判据是**按钮下沿 ≤ 输入框上沿**（textarea 的 top），不靠目测。
     */
    measure: () => {
      const host = findHost()
      const button = document.querySelector('[data-scroll-to-bottom]')
      const style = button === null ? null : getComputedStyle(button)
      const rect = button === null ? null : button.getBoundingClientRect()
      const textarea = document.querySelector('textarea')
      const textareaRect = textarea === null ? null : textarea.getBoundingClientRect()
      return {
        distance: host === null ? null : Math.round(host.scrollHeight - host.scrollTop - host.clientHeight),
        scrollTop: host === null ? null : Math.round(host.scrollTop),
        button:
          rect === null
            ? null
            : {
                width: round(rect.width),
                height: round(rect.height),
                right: round(rect.right),
                bottom: round(rect.bottom),
                ariaLabel: button.getAttribute('aria-label'),
                opacity: Number(style.opacity),
                // reduced-motion 档应该是 none，正常档是 ds-scroll-to-bottom-in
                animationName: style.animationName,
                backgroundColor: style.backgroundColor,
                hasNewDot: button.querySelector('span') !== null,
              },
        textareaTop: textareaRect === null ? null : round(textareaRect.top),
        clearsComposer: rect === null || textareaRect === null ? null : rect.bottom <= textareaRect.top,
      }
    },

    /** 把消息滚动层挪 delta（负值向上），模拟用户上翻 */
    scrollBy: (delta) => {
      const host = findHost()
      if (host === null) {
        return { found: false }
      }
      host.scrollTop += delta
      return {
        found: true,
        scrollTop: Math.round(host.scrollTop),
        distance: Math.round(host.scrollHeight - host.scrollTop - host.clientHeight),
      }
    },

    /**
     * 往消息内容列尾部塞一段空白，**模拟流式期间内容长高**（不连上游，也不伪造回复文案）：
     * 消息组件用 ResizeObserver 盯内容列高度，长高就会走「有新内容」那条分支。
     */
    grow: (height) => {
      const host = findHost()
      if (host === null) {
        return { found: false }
      }
      const row = host.querySelector('[data-row-id]')
      const column = row === null ? null : row.parentElement
      if (column === null) {
        return { found: false }
      }
      const spacer = document.createElement('div')
      spacer.dataset.shotSpacer = '386'
      spacer.style.height = `${height}px`
      column.append(spacer)
      return { found: true, height }
    },

    removeGrown: () => {
      for (const spacer of document.querySelectorAll('[data-shot-spacer="386"]')) {
        spacer.remove()
      }
      return { removed: true }
    },

    /** 点一下按钮并按帧采样 scrollTop：连续增长＝平滑，一步到位＝直接跳 */
    clickAndSample: async () => {
      const host = findHost()
      const button = document.querySelector('[data-scroll-to-bottom]')
      if (host === null || button === null) {
        return { found: false }
      }
      const before = Math.round(host.scrollTop)
      button.click()
      const samples = []
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        samples.push(Math.round(host.scrollTop))
      }
      return {
        found: true,
        before,
        samples,
        distance: Math.round(host.scrollHeight - host.scrollTop - host.clientHeight),
      }
    },
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

/**
 * 拦 `GET /api/orders`（#115 / #158 截图用）。
 *
 * 两个坑（踩过才写下来）：
 *  1. 不能用通配 glob（两颗星后缀）去匹配：请求带查询串（`?limit=&offset=`）时整串匹配不上，
 *     route 根本不触发，请求会真的发到线上域名再超时——截出来是「正在加载」的假象；
 *  2. 跨域带 `Authorization` 头会先发 **OPTIONS 预检**，只回 GET 不够：
 *     预检必须 204 + 一套 CORS 头，否则浏览器按 CORS 失败处理。
 * 所以这里用正则匹配路径、GET 与 OPTIONS 都接住、并给齐 `Access-Control-*`。
 */
const routeOrders = async (context, makeBody) => {
  await context.route(/\/api\/orders(?:\?|$)/u, async (route) => {
    const request = route.request()
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization,accept,content-type',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Max-Age': '600',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers,
      body: JSON.stringify(makeBody(new URL(request.url()))),
    })
  })
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
  oursServicesOpen: '[data-testid="ours-services-open"]',
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

/**
 * #215 用：按 Tab 走 focus，直到当前焦点落在文本恰好等于 label 的按钮 / 标签上。
 * 走键盘是本页的关键 —— 只有键盘语义下 Chromium 才会匹配 :focus-visible。
 */
const tabTo = async (page, label, limit = 40) => {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(40)
    const hit = await page.evaluate((text) => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement)) return false
      const focusable = /^(?:BUTTON|A|INPUT|SELECT|TEXTAREA)$/u.test(el.tagName) || el.getAttribute('role') === 'tab'
      if (!focusable) return false
      return (el.textContent ?? '').replace(/\s+/gu, ' ').trim() === text
    }, label)
    if (hit) return true
  }
  return false
}

/** 读某个元素此刻的焦点环（outline 与 box-shadow 都算），并回报 :focus-visible 是否匹配 */
const ringOf = async (locator) =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el)
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
    const shadow = style.boxShadow !== 'none' && style.boxShadow.trim() !== ''
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40),
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      outlineOffset: style.outlineOffset,
      boxShadow: style.boxShadow,
      ringVisible: Boolean(outline || shadow),
      focusVisible: el.matches(':focus-visible'),
      isActive: el === document.activeElement,
    }
  })

/** 元素外扩 8px 的裁剪框：焦点环特写用 */
const clipAround = async (locator, size) => {
  const box = await locator.boundingBox()
  if (box === null) return undefined
  return {
    x: Math.max(0, box.x - 8),
    y: Math.max(0, box.y - 8),
    width: Math.min(box.width + 16, size.width - Math.max(0, box.x - 8)),
    height: box.height + 16,
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
 *  - `mockPurchases` 用给定订单回真实的 `GET /api/orders`（带 limit/offset/status 过滤），
 *    这样分页与筛选 tab 截到的是「真的走了一遍请求」的结果，见 #158
 *  - `providerKind` 覆盖 localStorage 里的渠道类型（默认 deepseek）；自有渠道的入口只在 ours 下出现
 *  - `run`        该场景的截图与量数步骤
 */
export const PAGES = {
  'header-scroll-top': {
    dir: 'docs/ui/106-mobile-header-scroll-top',
    title: '#106 移动端顶栏：「双击回顶」提示、44px 点击区、双击后回到首条消息',
    sessions: () => [makeLongSession()],
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

  'scroll-to-bottom': {
    dir: 'docs/ui/386-scroll-to-bottom',
    title: '#386 输入框上方「回到底部」小箭头：上翻浮现 / 点击回底 / 流式中的新内容圆点 / 深色主题',
    sessions: () => [makeLongSession()],
    // 流式那条要真的走 ours 上游（被 route 打到本地桩），所以渠道也切到 ours
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn, size } = ctx
      await openSession(page, LONG_SESSION_TITLE)
      await page.evaluate(installToBottomHelpers)

      // ① 首次进会话就在底部：不该有按钮（否则它会白挡住正文）
      const atBottom = await page.evaluate(() => window.__toBottom.measure())
      record('atBottom', atBottom)
      if (atBottom.button !== null) {
        warn('刚进会话还没上翻就出现了回到底部按钮')
      }
      await shot('01-at-bottom-no-button')

      // ② 上翻 1200px（> 200px 阈值）：按钮浮现，且不压住输入框
      record('scrollUp', await page.evaluate(() => window.__toBottom.scrollBy(-1200)))
      await page.waitForTimeout(300)
      const shown = await page.evaluate(() => window.__toBottom.measure())
      record('scrolledUp', shown)
      if (shown.button === null) {
        throw new Error('上翻 1200px 后没有出现「回到底部」按钮')
      }
      if (shown.button.hasNewDot) {
        warn('还没开始流式，按钮上就带了「有新内容」圆点')
      }
      if (shown.clearsComposer !== true) {
        warn(`按钮下沿 ${shown.button.bottom} 压到了输入框上沿 ${shown.textareaTop}`)
      }
      await shot('02-scrolled-up-button')

      // ③ 真的发一条消息（上游被 route 压 4 秒），在「流式中」这段窗口里上翻取证：
      //    位置不能被拽回底部，按钮要补一个「有新内容」圆点。
      await page.route(`**${OURS_CHAT_PATH}`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: OURS_CORS })
          return
        }
        // 刻意压 4 秒：把 streaming 这个状态撑开，不是测试里的 sleep
        await new Promise((resolve) => setTimeout(resolve, 4000))
        await route.fulfill({
          status: 200,
          headers: { ...OURS_CORS, 'content-type': 'text/event-stream' },
          body: openAiSse('流式期间上翻不该被拽回底部；这条回复只用来把流式状态撑开。'),
        })
      })
      const textarea = page.locator('textarea').last()
      await textarea.click()
      await textarea.fill('#386 流式取证：先发一条，再上翻')
      await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
      await page.getByRole('button', { name: /停止生成/ }).first().waitFor({ timeout: 10000 })
      record('streaming', { stopButtonVisible: true })
      record('scrollUpInStream', await page.evaluate(() => window.__toBottom.scrollBy(-900)))
      await page.waitForTimeout(250)
      const streamUp = await page.evaluate(() => window.__toBottom.measure())
      record('streamScrolledUp', streamUp)
      // 内容长高用 DOM 注入模拟「新 token 到达」：不伪造回复文案，只把内容列撑高
      record('grow', await page.evaluate(() => window.__toBottom.grow(200)))
      await page.waitForTimeout(400)
      const grown = await page.evaluate(() => window.__toBottom.measure())
      record('afterGrow', grown)
      if (grown.button === null || grown.button.hasNewDot !== true) {
        warn('流式期间内容长高后，按钮上没有出现「有新内容」圆点')
      }
      if (grown.button !== null && grown.button.ariaLabel !== '回到底部（有新内容）') {
        warn(`圆点状态下 aria-label 不对：${grown.button.ariaLabel}`)
      }
      if (streamUp.scrollTop !== grown.scrollTop) {
        warn(`流式期间内容长高把位置拽动了：${streamUp.scrollTop} → ${grown.scrollTop}`)
      }
      await shot('03-new-content-dot-in-stream')

      // ④ 点击回到底部（本场景浏览器上下文默认 reducedMotion=reduce → 应直接跳），
      //    并确认流式结束后按钮自己收起来
      record('clickInStream', await page.evaluate(() => window.__toBottom.clickAndSample()))
      await page.waitForTimeout(300)
      const back = await page.evaluate(() => window.__toBottom.measure())
      record('afterClick', back)
      if (back.distance !== 0) {
        warn(`点击后没到底：distance=${back.distance}`)
      }
      await shot('04-after-click-bottom')
      // 等这条 mock 回复落地，别让「流式中」串到后面几档
      await page
        .getByRole('button', { name: /停止生成/ })
        .first()
        .waitFor({ state: 'detached', timeout: 15000 })
        .catch(() => warn('mock 回复 15 秒还没收尾'))
      await page.evaluate(() => window.__toBottom.removeGrown())

      // ⑤ 正常动效档：按钮淡入 + scrollTo 平滑滚动（按帧采样证明是渐变而不是瞬移）
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(() => window.__toBottom.scrollBy(-1600))
      await page.waitForTimeout(300)
      const animated = await page.evaluate(() => window.__toBottom.measure())
      record('normalMotion', animated)
      if (animated.button === null || !animated.button.animationName.startsWith('ds-scroll-to-bottom-in')) {
        warn(`正常动效档下按钮没有淡入：animationName=${animated.button === null ? 'null' : animated.button.animationName}`)
      }
      await shot('05-button-fade-in')

      const smooth = await page.evaluate(() => window.__toBottom.clickAndSample())
      record('clickSmooth', smooth)
      const peak = smooth.found ? Math.max(...smooth.samples) : 0
      const intermediate = smooth.found
        ? smooth.samples.filter((value) => value > smooth.before && value < peak).length
        : 0
      if (smooth.found && intermediate === 0) {
        warn(`正常动效档下点击没有平滑过程，采样=${smooth.samples.join(',')}（只有老内核 / reduced-motion 才该直接跳）`)
      }
      await page.waitForTimeout(400)
      await shot('06-after-smooth-bottom')

      // ⑥ 深色主题：把 body 上那个属性打上（与 App 内主题开关同一属性），确认按钮还有对比度
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', 'dark'))
      await page.evaluate(() => window.__toBottom.scrollBy(-1200))
      await page.waitForTimeout(300)
      record('darkTheme', await page.evaluate(() => window.__toBottom.measure()))
      record('viewport', size)
      await shot('07-dark-theme-button')
    },
  },

  'reading-settings': {
    dir: 'docs/ui/102-reading-settings',
    title: '#102 设置 → 通用设置 → 阅读设置：三个下拉的渲染，默认档与最大档的文字渲染对比',
    sessions: () => [makeReadingSession()],
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

  'ours-buy-inapp': {
    dir: 'docs/ui/235-pay-return',
    title: '#235 设置 → 数据管理 → 我们的渠道：套餐列表 / 去支付 / 收银台提示（390 与 360 两档）',
    sessions: () => [makeReadingSession()],
    // 入口只在自有渠道出现（#166 的门禁思路），与支付记录/我的购买同一份判定
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      // /me 与 /api/plans 都是只读接口：回集成测试里那份真契约数据，
      // 截到的是「真的发了一次请求再渲染」的结果，不是摆拍。
      const json = (body) => ({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      })
      await page.route(`${SHOT_INVITE_API}/**`, async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/me') {
          await route.fulfill(
            json({
              customer_id: 4210,
              invite_code: 'G7TA7UR3',
              invited_count: 1,
              max_invites: 20,
              bonus_points: 10,
              redeemed: true,
              quota_points: 100,
              used_points: 0,
              remaining_points: 100,
              key_status: 'active',
            })
          )
          return
        }
        await route.fulfill(json({}))
      })
      await page.route(`${SHOT_CARD_API}/api/plans`, async (route) => {
        await route.fulfill(
          json({
            plans: [
              { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
              { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
            ],
          })
        )
      })
      await page.route(`${SHOT_CARD_API}/api/balance`, async (route) => {
        await route.fulfill(json({ valid: true }))
      })

      await openSettings(page, S.tabData)
      const entry = page.locator(S.oursServicesOpen)
      await entry.waitFor({ state: 'visible', timeout: 10000 })
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await entry.click()

      const dialog = page.locator('[data-testid="ours-services-dialog"]')
      await dialog.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(700)

      const plans = page.locator('[data-testid="ours-plans"]')
      await plans.scrollIntoViewIfNeeded()
      await page.waitForTimeout(360)
      const buy = page.locator('[data-testid="ours-buy"]')
      const notice = page.locator('[data-testid="ours-pay-notice"]')
      const buyBox = await buy.boundingBox()
      const noticeText = (await notice.textContent()) ?? ''
      // 计划里换了「App 内打开收银台」的说明文案：这段是原生端文案，
      // Chromium 视口里 isNativePlatform() 为 false，会渲染网页版那条 —— 记下来，别当成漏改。
      record('purchase', {
        plans: await page.locator('[data-testid="ours-plans"] [data-testid^="ours-plan-"]').count(),
        buyBox: buyBox === null ? null : { w: Math.round(buyBox.width), h: Math.round(buyBox.height) },
        notice: noticeText.trim(),
        nativeCopy: noticeText.includes('App 内'),
      })
      if (buyBox === null || buyBox.height < 44) {
        warn(`「去支付」点击区不足 44px：${buyBox === null ? 'null' : Math.round(buyBox.height)}`)
      }
      // 套餐列表、去支付按钮和提示在同一屏里（两档宽度都如此），一张就够：
      // 提示文案紧跟按钮，不另起一张一模一样的图。
      await shot('01-plans-and-pay')
      const clip = await dialogClip(page)
      if (clip !== null) {
        await shot('02-purchase-closeup', { clip })
      }
    },
  },

  'account-consume': {
    dir: 'docs/ui/account-consume',
    title:
      '#487 设置 → 数据管理 → 账户与消费：我的卡密（未兑换 / 已兑换 / 复制 / 兑换结果）/ 购买（套餐 / 收款页）/ 我的额度 / 账号 四个 tab（390 与 360 两档）',
    sessions: () => [makeReadingSession()],
    // 入口仍然只在自有渠道出现（#166 的判据没变，只是三联格并成了一格）
    providerKind: 'ours',
    // 「我的卡密」的数据就是 apia 的 GET /api/orders：按真契约形状回两张卡 ——
    // 一张 issued/leased（未兑换）、一张 redeemed/used（已兑换），列表的两种状态各截一张。
    mockPurchases: {
      totalPaidYuan: 40,
      orders: [
        {
          out_trade_no: 'CP202611200000001',
          plan_id: 'standard',
          plan_name: '标准包 500万 token',
          plan_points: 3900,
          amount_yuan: 39.0,
          status: 'FULFILLED',
          status_text: '已完成',
          card_no: 'MUSE-3CYP-5NA3-AHSE-A3SR',
          card_status: 'leased',
          redeem_state: 'issued',
          created_at: 1795055400,
          paid_at: 1795055460,
        },
        {
          out_trade_no: 'CP202611190000002',
          plan_id: 'starter',
          plan_name: '体验包 100万 token',
          plan_points: 300,
          amount_yuan: 1.0,
          status: 'FULFILLED',
          status_text: '已完成',
          card_no: 'MUSE-9KQ2-7WHB-TT44-Q7ZM',
          card_status: 'used',
          redeem_state: 'redeemed',
          created_at: 1794969000,
          paid_at: 1794969060,
        },
      ],
    },
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      const json = (body) => ({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      })
      await page.route(`${SHOT_CARD_API}/api/plans`, async (route) => {
        await route.fulfill(
          json({
            plans: [
              { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
              { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
            ],
          })
        )
      })
      await page.route(`${SHOT_CARD_API}/api/pay-link`, async (route) => {
        await route.fulfill(json({ ok: true, url: 'https://pay.example.com/checkout/shot', note: '' }))
      })

      await openSettings(page, S.tabData)
      const entry = page.locator('[data-testid="account-consume-open"]')
      await entry.waitFor({ state: 'visible', timeout: 10000 })
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await entry.click()

      const panel = page.locator('[data-testid="account-consume-page"]')
      await panel.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(700)

      // ① 四个 tab 一行放得下、弹层不横向溢出（390 与 360 都要成立）
      const layout = await page.evaluate(() => {
        // 注意作用域：设置层自己也有一个 role="tablist"（通用设置 / 数据管理），
        // 直接从 document 取第一个会把两张截图量成设置页的 tab —— 必须从本页往上找它自己的弹层。
        const body = document.querySelector('[data-testid="account-consume-page"]')
        const dialog = body === null ? null : body.closest('[role="dialog"]')
        const tablist = dialog === null ? null : dialog.querySelector('[role="tablist"]')
        if (tablist === null || body === null) {
          return null
        }
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]')).map((tab) => {
          const rect = tab.getBoundingClientRect()
          return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top) }
        })
        const box = body.getBoundingClientRect()
        return {
          tabs,
          tabRows: new Set(tabs.map((tab) => tab.top)).size,
          panelRight: Math.round(box.right),
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }
      })
      record('layout', layout)
      if (layout === null) {
        warn('没量到 tablist / 页面主体：布局断言无从判断')
      } else {
        if (layout.tabRows !== 1) {
          warn(`四个 tab 折成了 ${layout.tabRows} 行（390/360 两档要求同一行）`)
        }
        const tooShort = layout.tabs.filter((tab) => tab.h < 32)
        if (tooShort.length > 0) {
          warn(`有 ${tooShort.length} 个 tab 的点击高度不足 32px：${JSON.stringify(tooShort)}`)
        }
        if (layout.scrollWidth > layout.viewport) {
          warn(`页面出现横向滚动：scrollWidth=${layout.scrollWidth} > viewport=${layout.viewport}`)
        }
      }

      // ③ Tab 1「我的卡密」：两种状态（未兑换 / 已兑换）+ 复制 + 去兑换
      const rows = page.locator('[data-testid="account-consume-card-row"]')
      record('cards', {
        count: await rows.count(),
        rows: (await rows.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()),
      })
      if ((await rows.count()) !== 2) {
        warn(`卡密列表应有 2 条（未兑换 + 已兑换），实际 ${await rows.count()}`)
      }
      await shot('01-my-cards')

      // ④ 兑换：Chromium 里 CapacitorHttp 不可用（isNativePlatform() === false），
      //    所以这一次一定「拿不到响应」。截的是**真实发生的那一态**，不是摆拍成功页；
      //    redeemed / processing / pending→重试 三态由 tests/unit/consume-envelope.test.mjs 覆盖。
      await page.getByTestId('account-consume-redeem-input').fill('MUSE-3CYP-5NA3-AHSE-A3SR')
      await page.getByTestId('account-consume-redeem-submit').click()
      const redeemStatus = page.getByTestId('account-consume-redeem-status')
      await redeemStatus.waitFor({ state: 'visible', timeout: 10000 })
      record('redeemStatus', { text: (await redeemStatus.innerText()).replace(/\s+/g, ' ').trim() })
      await shot('02-redeem-result')

      // ⑤ Tab 2「购买」：套餐列表（apia /api/plans）
      await page.getByTestId('account-consume-tab-buy').click()
      await page.getByTestId('account-consume-buy-plan').first().waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(320)
      record('buyPlans', { count: await page.getByTestId('account-consume-buy-plan').count() })
      await shot('03-buy-plans')

      // ⑥ 点「去支付」：非原生环境 openPayLinkInApp() 恒为 false → 必须给可读提示，不许整页跳走
      await page.getByTestId('account-consume-buy-open').first().click()
      const buyStatus = page.getByTestId('account-consume-buy-status')
      await buyStatus.waitFor({ state: 'visible', timeout: 10000 })
      record('buyOpen', { text: (await buyStatus.innerText()).replace(/\s+/g, ' ').trim() })
      await shot('04-buy-open-unavailable')

      // ⑦ Tab 3「我的额度」/ Tab 4「账号」：面板本体来自 W1-C2（`components/consume/index.ts`），
      //    截出来证明外壳把同一个客户端与登录出口递下去了（面板自己拉数据，这里只等它出终态）
      await page.getByTestId('account-consume-tab-quota').click()
      await page.waitForSelector('[data-testid="account-consume-page"]', { timeout: 10000 })
      await page.waitForTimeout(900)
      await shot('05-quota-panel')
      await page.getByTestId('account-consume-tab-account').click()
      await page.waitForTimeout(900)
      await shot('06-account-panel')
    },
  },

  'import-skipped': {
    dir: 'docs/ui/49-import-skipped',
    title: '#49 设置 → 数据管理 → 导入历史：部分损坏的包照样导入，界面列出跳过的条数与逐条定位',
    sessions: () => [makeReadingSession()],
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

  'focus-215': {
    dir: 'docs/ui/215-focus-visible',
    title: ':focus-visible（#215）：键盘走到控件时出焦点环，鼠标点击同一控件不出环',
    sessions: () => [makeReadingSession()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx

      // ---- A. 侧边栏「设置」按钮（.settings，box-shadow 环）----
      await openSiderIfNeeded(page)
      const settingsButton = page.getByRole('button', { name: S.settings, exact: true })
      await settingsButton.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(320)
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })

      let byKeyboard = await tabTo(page, S.settings)
      if (!byKeyboard) {
        // 兜底：脚本 focus（Chromium 在「上一次输入是键盘」时仍按键盘态判）
        await settingsButton.focus()
        warn('Tab 40 次没走到侧边栏「设置」按钮，改用脚本 focus')
      }
      await page.waitForTimeout(240)
      const keyboardRing = await ringOf(settingsButton)
      record('sidebarSettings.keyboard', keyboardRing)
      if (!keyboardRing.ringVisible) warn('键盘聚焦侧边栏「设置」按钮时看不到焦点环')
      if (!keyboardRing.focusVisible) warn('键盘聚焦时 :focus-visible 没匹配上，这张图证明不了键盘态')
      await shot('01-键盘-侧边栏设置按钮')
      const settingsClip = await clipAround(settingsButton, ctx.size)
      if (settingsClip !== undefined) await shot('02-键盘-侧边栏设置按钮-特写', { clip: settingsClip })

      // ---- B. 鼠标点击进设置，再鼠标点「数据管理」标签 → 现代内核不该出环 ----
      await settingsButton.click()
      await page.getByRole('tab', { name: S.tabGeneral }).waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(360)
      const dataTab = page.getByRole('tab', { name: S.tabData })
      await dataTab.click()
      await page.waitForTimeout(280)
      const mouseRing = await ringOf(dataTab)
      record('settingsDataTab.mouse', mouseRing)
      if (mouseRing.ringVisible) warn('鼠标点击「数据管理」标签后出现了焦点环（高内核回归，issue #215 的验收项）')
      if (mouseRing.focusVisible) warn('鼠标点击后 :focus-visible 竟然匹配上了，判定口径可疑')
      await shot('03-鼠标点击-数据管理标签-无焦点环')

      // ---- C. 键盘回到同一个标签 → 出环 ----
      // 先 Tab 走开再 Shift+Tab 回来，等价于「纯键盘把焦点移到这个标签上」
      await page.keyboard.press('Tab')
      await page.waitForTimeout(140)
      await page.keyboard.press('Shift+Tab')
      await page.waitForTimeout(240)
      const backOnTab = await dataTab.evaluate((el) => el === document.activeElement)
      if (!backOnTab) {
        await dataTab.focus()
        warn('Tab/Shift+Tab 没把焦点送回「数据管理」标签，改用脚本 focus')
        await page.waitForTimeout(180)
      }
      const tabKeyboardRing = await ringOf(dataTab)
      record('settingsDataTab.keyboard', tabKeyboardRing)
      if (!tabKeyboardRing.ringVisible) warn('键盘聚焦「数据管理」标签时看不到焦点环')
      await shot('04-键盘-数据管理标签-焦点环')
      const tabClip = await clipAround(dataTab, ctx.size)
      if (tabClip !== undefined) await shot('05-键盘-数据管理标签-特写', { clip: tabClip })
    },
  },

  'chat-error-324': {
    dir: 'docs/ui/324-official-error-classify',
    title: '#324 官方渠道失败分类：模型不可用 / 未识别带状态码与诊断，390 与 360 两档',
    sessions: () => [makeErrorSession()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, ERROR_SESSION_TITLE)

      const readNotice = async (locator, label) => {
        await locator.scrollIntoViewIfNeeded()
        const box = await locator.boundingBox()
        const data = {
          text: (await locator.innerText()).replace(/\s+/gu, ' ').trim(),
          box,
          inViewport:
            box !== null &&
            box.y >= 0 &&
            box.y + box.height <= ctx.size.height + 1 &&
            box.x >= 0 &&
            box.x + box.width <= ctx.size.width + 1,
          horizontalOverflow: await locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        }
        record(label, data)
        if (!data.inViewport) warn(`${label} 没完整落在视口内：这张图证明不了「不用滚就能看全」`)
        if (data.horizontalOverflow) warn(`${label} 横向溢出：x 方向被裁了`)
        return data
      }

      // A. 官方端点真实的 400：模型名不被支持 —— 改前这里是「未知错误」
      const modelInvalid = page.getByText('当前模型在上游不可用', { exact: false }).first()
      await modelInvalid.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(280)
      const a = await readNotice(modelInvalid, 'modelInvalid')
      if (!a.text.includes('不要重试')) warn('模型不可用的文案里没写「不要重试」')
      if (a.text.includes('未知错误')) warn('模型不可用仍被说成「未知错误」')
      await shot('01-模型不可用-不要重试')

      // B. 未识别但有状态码 + 短码：兜底提示要能自证，并带「复制诊断信息」
      const unclassified = page.getByText('HTTP 451', { exact: false }).first()
      await unclassified.waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(280)
      const b = await readNotice(unclassified, 'unclassified')
      if (!b.text.includes('HTTP 451') || !b.text.includes('unsupported_region')) {
        warn('兜底提示里没有状态码或上游短码')
      }
      const copyButton = page.getByRole('button', { name: '复制诊断信息' })
      const buttonVisible = await copyButton.first().isVisible().catch(() => false)
      record('copyButton', { visible: buttonVisible })
      if (!buttonVisible) warn('未识别的失败没有「复制诊断信息」按钮')
      await shot('02-未识别-带状态码与诊断按钮')

      // C. 真的点一下：证据是 toast 文案 + 剪贴板真实内容（context 已授予 clipboard 权限）
      await copyButton.first().click()
      await page.waitForTimeout(280)
      const toastText = await page
        .getByRole('status')
        .innerText()
        .catch(() => '')
      const clipboard = await page.evaluate(() =>
        navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
      )
      record('copy', { toastText: toastText.replace(/\s+/gu, ' ').trim(), clipboard })
      if (!toastText.includes('已复制')) warn(`没看到复制成功的提示：${JSON.stringify(toastText)}`)
      if (!String(clipboard).includes('HTTP 状态: 451')) {
        warn(`剪贴板里没有诊断内容：${JSON.stringify(clipboard)}`)
      }
      if (!String(clipboard).includes('上游 code: unsupported_region')) {
        warn('剪贴板里的诊断缺上游短码')
      }
      await shot('03-复制诊断信息')

      // 已识别的档位不该出现诊断按钮（它不需要）：顺手量一下
      const modelCopyButton = await modelInvalid.evaluate(
        (el) => el.textContent?.includes('复制诊断信息') ?? false
      )
      record('modelInvalidHasCopyButton', { value: modelCopyButton })
      if (modelCopyButton) warn('模型不可用这条也带了「复制诊断信息」：已识别的档位不需要')
    },
  },

  'update-check': {
    dir: 'docs/ui/310-update-failure',
    title: '#310 检查更新失败的分类文案：渠道不可达 / 清单 404 / 清单非法 JSON / 无可用版本',
    sessions: () => [makeReadingSession()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      /**
       * 清单夹具：`/releases.json` 由 route 拦下来现造，**四种失败模式共用一份合法记录形状**，
       * 这样「界面说得出是哪一类失败」才不是靠不同夹具凑出来的。
       * 记录里同时给 internal / standard 两种变体：截图产物可能是 build:internal 也可能是普通 build。
       */
      const releaseRow = (extra = {}) => ({
        version: '1.5.0',
        versionCode: 9999,
        size: 6180000,
        file: 'apk/deepseek-chat-1.5.0.apk',
        changes: ['优化更新链路'],
        buildType: 'stable',
        sha256: 'a'.repeat(64),
        ...extra,
      })
      const releases = (items) => ({
        releases: items.flatMap((item) => [
          { ...item, artifactVariant: 'internal' },
          { ...item, artifactVariant: 'standard' },
        ]),
      })
      /** 当前模式：按顺序换，一次检查换一种失败原因 */
      let mode = 'unreachable'
      await page.route('**/releases.json', async (route) => {
        if (mode === 'unreachable') {
          // 断网 / 分发机不可达：连接直接失败（与「返回 404」必须是两种文案）
          await route.abort('connectionrefused')
          return
        }
        if (mode === 'http-404') {
          await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
          return
        }
        if (mode === 'bad-json') {
          // 负向用例：200 但返回的不是合法 JSON
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"releases": [ {"version": "1.5.0", ',
          })
          return
        }
        if (mode === 'no-version') {
          // 合法清单，但没有任何一条高于当前 versionCode → 无可用版本
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(releases([releaseRow({ versionCode: 1, version: '0.0.1' })])),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(releases([releaseRow()])),
        })
      })

      /** 读弹窗里的状态文案 + 是否存在诊断区（改前没有这两个元素，改后才有） */
      const readDialog = () =>
        page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          const dialog = dialogs[dialogs.length - 1]
          if (dialog === null || dialog === undefined) {
            return { present: false }
          }
          const status = dialog.querySelector('[role="status"]')
          const diagnostics = dialog.querySelector('[data-testid="update-diagnostics"]')
          const copy = dialog.querySelector('[data-testid="update-diagnostics-copy"]')
          const text = (node) => (node === null ? '' : (node.textContent ?? '').replace(/\s+/gu, ' ').trim())
          const rect = dialog.getBoundingClientRect()
          const facts = diagnostics === null ? null : diagnostics.getBoundingClientRect()
          return {
            present: true,
            status: text(status),
            diagnostics: text(diagnostics),
            copyButton: text(copy),
            // 诊断区能不能塞进 360 档：超宽就说明长地址把弹窗撑开了（#172 的同一类问题）
            layout: {
              dialogWidth: Math.round(rect.width),
              dialogHeight: Math.round(rect.height),
              factsWidth: facts === null ? null : Math.round(facts.width),
              factsOverflow: facts === null ? null : facts.scrollWidth > facts.clientWidth + 1,
              pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
            },
          }
        })

      await openSettings(page, S.tabGeneral)
      const entry = page.getByRole('button', { name: '检查更新', exact: true }).first()
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await shot('00-settings-entry')

      const steps = [
        { mode: 'unreachable', state: '01-渠道不可达' },
        { mode: 'http-404', state: '02-清单404' },
        { mode: 'bad-json', state: '03-清单非法JSON' },
        { mode: 'no-version', state: '04-无可用版本' },
        { mode: 'update-available', state: '05-有可用更新' },
      ]
      for (const [index, step] of steps.entries()) {
        mode = step.mode
        if (index === 0) {
          await entry.click()
        } else {
          const again = page.getByRole('button', { name: '重新检查', exact: true })
          await again.waitFor({ state: 'visible', timeout: 8000 })
          await again.click()
        }
        await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 8000 })
        // 等状态行从「正在检查更新…」变成结论：失败/无新版都会在一帧内换掉，留 600ms 余量
        await page.waitForTimeout(700)
        const dialog = await readDialog()
        record(step.mode, dialog)
        if (dialog.present !== true) {
          throw new Error(`检查更新弹窗没打开（模式 ${step.mode}）`)
        }
        if (dialog.status === '正在检查更新…') {
          warn(`${step.mode}：状态行停在「正在检查更新…」，结论没出来`)
        }
        if (step.mode !== 'update-available' && dialog.status === '') {
          warn(`${step.mode}：失败时状态行为空，用户看不到任何原因`)
        }
        await shot(step.state)
        if (index === 0 && dialog.copyButton !== '') {
          // 一键复制诊断信息：读剪贴板真实内容（context 已授予 clipboard 权限），不看 toast 猜
          const copy = page.locator('[data-testid="update-diagnostics-copy"]').first()
          await copy.scrollIntoViewIfNeeded()
          await copy.click()
          await page.waitForTimeout(240)
          const clipboard = await page.evaluate(() =>
            navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
          )
          record('clipboard', clipboard)
          for (const banned of ['http://', 'https://', '/apk/', 'token=', '    at ']) {
            if (clipboard.includes(banned)) {
              warn(`复制的诊断信息里出现了内部细节 ${banned}`)
            }
          }
          await shot(`${step.state}-复制后`)
        }
      }
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
          // 深色主题要能出可复现的证据：场景可声明 `colorScheme: 'dark'`，默认 light
          colorScheme: def.colorScheme ?? 'light',
          // 「点一下复制」类改动要能复核剪贴板真实内容，否则只能看 toast 猜
          permissions: ['clipboard-read', 'clipboard-write'],
        })
        await context.addInitScript(
          ({ apiKey, providerKind }) => {
            try {
              localStorage.setItem('chat-demo:api-key', apiKey)
              localStorage.setItem('chat-demo:provider-kind', providerKind)
            } catch {
              // 首屏之前 localStorage 不可用就跳过：界面显示空配置，不影响截图
            }
          },
          { apiKey: FIXTURE_API_KEY, providerKind: def.providerKind ?? 'deepseek' }
        )
        if (def.mockPurchases) {
          // 只拦只读的订单查询，按真实契约回数据：`status` 大写、`status_text` 中文、
          // 时间和金额都是数字（时间按秒，与服务端一致），并真的按 limit / offset / status 过滤。
          // 分页与筛选 tab 截到的是「真的发了一次请求再渲染」的结果，不是摆拍。
          const fixtureOrders = def.mockPurchases.orders
          const fixtureTotalPaid = def.mockPurchases.totalPaidYuan
          await routeOrders(context, (url) => {
            const limit = Number(url.searchParams.get('limit') ?? 20)
            const offset = Number(url.searchParams.get('offset') ?? 0)
            const status = (url.searchParams.get('status') ?? '').trim().toUpperCase()
            const matched =
              status === ''
                ? fixtureOrders
                : fixtureOrders.filter((item) => String(item.status).toUpperCase() === status)
            return {
              customer_id: 10,
              total: matched.length,
              limit,
              offset,
              total_paid_yuan: fixtureTotalPaid,
              orders: matched.slice(offset, offset + limit),
            }
          })
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
