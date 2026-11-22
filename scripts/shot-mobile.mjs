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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from 'playwright'

// 消费层（sub2api）地址同样来自 `config/endpoints.json`（#274）：#608 的已登录态要点打桩，
// 这里不许写字面量端口，否则本机改了 `config/endpoints.json` 之后这张截图会静默打到别处。
import {
  consumeApiV1Prefix,
  consumeBaseUrl,
  consumeGatewayPrefix,
  inferenceBaseUrl,
  inviteBaseUrl,
} from './lib/endpoints.mjs'
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

/**
 * 与 src/services/chat/db.ts 的 DB_VERSION 保持一致；fixture 建库结构必须与之一致。
 * #480 把库升到 v13（新增 `attachments` / `attachmentTexts` 两个 store）：这里只建基线四张表 +
 * `sessionSummaries`，附件两张表交给应用自己的 v12 → v13 升级路径去建 —— 顺带每次截图都走一遍真升级。
 *
 * #399 把库升到 v14（新增窗口记忆 `sessionMemory` + `sessionId` 索引）之后，这个常量停在了 13：
 * 冷启动的 warmer 页会先把库按 14 建出来，`seedInPage` 再 `open(…, 13)` 直接 VersionError ——
 * 于是**全部 `--page` 场景一条都跑不起来**（与 #486 无关，存量问题）。常量必须跟着 `db.ts` 走。
 */
export const DB_VERSION = 14
/** 假 Key：只喂给界面让「服务配置」不是空态；订单接口被 route 拦掉，不会真的发出去 */
const FIXTURE_API_KEY = 'sk-shot-mobile-fixture-0000'
/**
 * #235：套餐 / 档案都是只读接口，打桩地址与集成测试同一份（明文邀请服 + 卡密主站）。
 * 邀请服地址来自 config/endpoints.json（#274），这里不再写字面量。
 */
const SHOT_INVITE_API = inviteBaseUrl
const SHOT_CARD_API = 'https://apia.ecsafe.cn'

/**
 * #608「账号」tab 截图用的假账号：字段名与 sub2api 的 `User` DTO 一致（snake_case），
 * 映射交给消费层（`toConsumeUser` / `toAuthUser`），这里不预先 camelCase 化。
 * 金额 / 额度一律服务端说了算 —— 这几个数只为了让界面有东西可读，不参与任何推导。
 */
const SHOT_ACCOUNT_USER = {
  id: 2,
  email: 'demo@example.com',
  username: 'demo',
  role: 'user',
  balance: 128.5,
  frozen_balance: 0,
  concurrency: 5,
  status: 'active',
  identities: { email: { bound: true } },
}

/**
 * 原生桥桩（Capacitor 替身）—— 与 `tests/golden/g15-purchase.test.mjs` /
 * `g16-account-optional.test.mjs` 同一套配方（出处见 `tests/golden/README.md`）。
 *
 * 为什么截图需要它：消费层（`services/consume/http.ts`，#484 §4.6）**只走原生**
 * `CapacitorHttp` —— sub2api 的 CORS 默认拒绝所有跨域，WebView 里裸 fetch 必然失败，
 * 所以浏览器里 `Capacitor.isNativePlatform()` 为假时它直接返回 `unsupported`，面板上只会出现
 * 「当前版本不支持这个功能」（#487 留下的旧链路截图就是那样）。也就是说：**浏览器里这套接口
 * 一个请求都发不出去**，「已登录态到底长什么样」根本拍不到。
 *
 * 做法：`window.androidBridge` 存在 → 平台判定为 android → `isNativePlatform()` 为真；
 * `window.Capacitor.PluginHeaders` 把 `CapacitorHttp.request` 声明成 promise 方法 → 核心层调
 * `nativePromise` 而不是 web 实现。这里让 `nativePromise` **在页面里真发一次 `fetch`** ——
 * 于是请求仍然落在本场景自己的 `page.route` 路由表上（打桩、CORS 预检、响应映射全部照旧），
 * 替身只负责「让原生通道存在」，不替用例改任何响应。
 */
const nativeBridgeStub = () => {
  window.androidBridge = { postMessage: () => {} }
  window.Capacitor = {
    // `request` 供消费层（`consume/http.ts` 只走 CapacitorHttp.request）；
    // `get` 供连通性探测（`api/client.ts` 的 `probeProvider` 在原生平台走 `CapacitorHttp.get`）。
    // 只多声明一个方法，两者都由下面的 `nativePromise` 转成一次 fetch，不改任何产品行为。
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }, { name: 'get', rtype: 'promise' }] },
    ],
    nativePromise: async (plugin, method, options) => {
      if (plugin !== 'CapacitorHttp') {
        return {}
      }
      const headers = {}
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        headers[String(name).toLowerCase()] = String(value)
      }
      const init = { method: String(options?.method ?? 'GET'), headers }
      if (typeof options?.data === 'string' && options.data !== '') {
        init.body = options.data
      }
      const response = await fetch(String(options?.url ?? ''), init)
      const text = await response.text()
      const responseHeaders = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      return { status: response.status, headers: responseHeaders, data: text, url: response.url }
    },
    nativeCallback: async () => '',
  }
}

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
 * 量 A7 那一格「账户与消费」（#487 阶段② 的验收判据，不是「看着像」）：
 *
 *   - `account-consume-open` 只能有 **1** 个（三个钱入口合成一格，多一个就是没合干净）；
 *   - 旧三个入口（`payment-records-open` / `purchases-open` / `payment-trail-open`）必须 **各 0 个**
 *     —— 它们真的搬进新页面了，而不是藏在别处；
 *   - 设置页正文里不许再出现「付款记录 / 我的购买 / 支付记录」三种旧叫法（同一件东西两份名字，
 *     用户会以为是两件事）；
 *   - 窄档不许横向溢出；「查看」按钮的点击区高度 ≥ 44px（移动端下限）；
 *   - 这一格必须**完整落在视口内**，否则这张图证明不了「设置里一眼就能看到」。
 */
const measureAccountConsumeEntry = () => {
  const open = document.querySelector('[data-testid="account-consume-open"]')
  const round = (value) => Math.round(value)
  const box = (rect) =>
    rect === null
      ? null
      : { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
  const count = (testid) => document.querySelectorAll(`[data-testid="${testid}"]`).length
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  // 正文文本取「数据管理」那一栏的可视文本，去掉按钮里的「查看」这类噪声后再判断旧叫法
  const text = (document.body.innerText ?? '').replace(/\s+/gu, ' ')
  const legacyWordings = ['付款记录', '我的购买', '支付记录'].filter((word) => text.includes(word))
  if (open === null) {
    return {
      present: false,
      accountConsumeOpen: 0,
      legacyEntries: {
        'payment-records-open': count('payment-records-open'),
        'purchases-open': count('purchases-open'),
        'payment-trail-open': count('payment-trail-open'),
      },
      legacyWordings,
      horizontalOverflow: document.documentElement.scrollWidth > viewport.width + 1,
      viewport,
    }
  }
  const rect = open.getBoundingClientRect()
  const cell = open.closest('div')
  const row = cell === null ? null : cell.parentElement
  const rowRect = row === null ? null : row.getBoundingClientRect()
  return {
    present: true,
    accountConsumeOpen: count('account-consume-open'),
    legacyEntries: {
      'payment-records-open': count('payment-records-open'),
      'purchases-open': count('purchases-open'),
      'payment-trail-open': count('payment-trail-open'),
    },
    legacyWordings,
    label: (row?.innerText ?? '').replace(/\s+/gu, ' ').trim(),
    button: box(rect),
    row: box(rowRect),
    inViewport: rect.top >= 0 && rect.bottom <= viewport.height + 1,
    clickTargetHeight: round(rect.height),
    horizontalOverflow: document.documentElement.scrollWidth > viewport.width + 1,
    viewport,
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

// ---------------------------------------------------------------- #480 文档附件场景夹具

/**
 * 手搓一份最小 PDF（真文本层，Helvetica / ASCII）。
 *
 * 为什么自己拼而不是拿现成文件：截图要两种**真实解析行为**，都在文件字节里决定，不靠桩：
 *  - `pages.length` 很大 → 逐页取文本要好几秒，`parsing` 态的进度条与取消按钮才有稳定的取证窗口；
 *  - 某一页 `corrupt: true` → 该页内容流声明 `FlateDecode` 但数据是坏的，pdfjs 取这一页文本时抛错，
 *    `parsePdfFile` 按「单页失败不中断整篇」记账 → `extractedPages < pages` + 「第 N 页提取失败」warning
 *    → manager 落 `partial`。这是**真文件**造成的 partial（`pdftotext` 对同一份文件也报
 *    `Unknown compression method in flate stream` 并跳过那一页），不是往解析器里注故障。
 *
 * 文字只用 ASCII：`/Length` 与实际字节数必须逐字节相等，多字节字符会让长度算错、把好页也拖坏。
 */
const buildShotPdf = (pages) => {
  const escapeText = (value) => value.replace(/([()\\])/gu, '\\$1')
  const pageStream = (lines) =>
    `BT /F1 10 Tf 20 180 Td 12 TL ${lines.map((line) => `(${escapeText(line)}) Tj T*`).join(' ')} ET`
  const pageIds = pages.map((_, index) => 3 + index)
  const contentIds = pages.map((_, index) => 3 + pages.length + index)
  const fontId = 3 + pages.length * 2
  const objects = [
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>`],
  ]
  pages.forEach((_, index) => {
    objects.push([
      pageIds[index],
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 300]/Contents ${contentIds[index]} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`,
    ])
  })
  pages.forEach((page, index) => {
    if (page.corrupt === true) {
      // 合法 zlib 头 + 半截 deflate 数据：解不开，但整份文件的结构（xref / 对象偏移）仍然完好，
      // 所以坏的是「这一页」而不是「整篇」（整篇坏会走 openFailed，那是另一条分支）
      const payload = 'x\u009c\u0093\u00f3'
      objects.push([
        contentIds[index],
        `<</Length ${payload.length}/Filter/FlateDecode>>\nstream\n${payload}\nendstream`,
      ])
      return
    }
    const stream = pageStream(page.lines)
    objects.push([contentIds[index], `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`])
  })
  objects.push([fontId, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'])

  const chunks = ['%PDF-1.4\n']
  const offsets = new Map()
  let cursor = chunks[0].length
  for (const [id, body] of objects) {
    offsets.set(id, cursor)
    const piece = `${id} 0 obj\n${body}\nendobj\n`
    chunks.push(piece)
    cursor += piece.length
  }
  const maxId = Math.max(...objects.map(([id]) => id))
  const xrefStart = cursor
  chunks.push(`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n')
  for (let id = 1; id <= maxId; id += 1) {
    chunks.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  chunks.push(`trailer\n<</Size ${maxId + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.from(chunks.join(''), 'latin1')
}

/**
 * 「解析要好几秒」的那份 PDF：页多、每页字少。
 * 每页 2 行是为了把总字符数压在 `ATTACHMENT_LIMITS.maxExtractedChars`（40 万）之内 ——
 * 超了 manager 会额外记一条「超过单份注入预算」warning，那是另一个话题（注入预算），
 * 不该混进「解析进度」这张图里。
 *
 * 页数**必须 ≤ `pdfMaxPages`（500）**：这个夹具原本是 1600 页（#555 时期还没有页数上限），
 * #599 加了「超过 500 页直接抛 `tooManyPages`」之后，1600 页的样本在**取第一页之前**就被拒了，
 * 进度条永远走不到 2%，本场景会挂。#574 重拍时按上限改成 480 页（仍是「页多」的量级）。
 */
const SLOW_PDF_PAGES = 480
const makeSlowPdf = () => {
  const pages = []
  for (let index = 1; index <= SLOW_PDF_PAGES; index += 1) {
    pages.push({
      // 只用 ASCII：`/Length` 必须与实际字节数一致，多字节字符会让页内容流错位，
      // 结果是「整篇看起来像没有文本层」（noTextLayer），而不是我们想看到的进度
      lines: [
        `Slow 480 fixture page ${index} line 1: page-by-page text extraction keeps the progress bar moving.`,
        `Slow 480 fixture page ${index} line 2: ascii only, so every stream length is exact.`,
      ],
    })
  }
  return buildShotPdf(pages)
}

/**
 * 扫描版 PDF 的等价物：3 页、结构完好、**每页都没有文本对象**（`BT ET` 空文本块）。
 *
 * 这不是伪造错误码，而是「扫描件」在解析器眼里的本质 —— pdfjs 取得到页、取得到内容流，
 * 但 `getTextContent()` 一个字符都没有 → 平均每页 0 字符 < `pdfMinCharsPerPage` →
 * 解析器按 `noTextLayer` 硬失败（#480 §5.3）。#574 用它证明「扫描版」在界面上说的是
 * 那句明确提示，而不是「未知问题」。
 */
const makeTextlessPdf = () =>
  buildShotPdf([
    { lines: [] },
    { lines: [] },
    { lines: [] },
  ])

/**
 * 超过页数上限的 PDF：**800 页**（上限 500，见 `src/services/limits.ts` 的 `pdfMaxPages`）。
 * 页数检查在取任何一页之前，所以这份样本解析得很快，也不会读满内存。
 */
const TOO_MANY_PAGES = 800
const makeTooManyPagesPdf = () => {
  const pages = []
  for (let index = 1; index <= TOO_MANY_PAGES; index += 1) {
    pages.push({ lines: [`Over-limit fixture page ${index}`] })
  }
  return buildShotPdf(pages)
}

/** 3 页里第 2 页内容流坏掉：真 partial（`第 2 页提取失败` + `第 2/3 页`） */
const makePartialPdf = () =>
  buildShotPdf([
    { lines: ['Hello 480 partial page 1', 'second line page 1'] },
    { corrupt: true, lines: ['Hello 480 partial page 2'] },
    { lines: ['Hello 480 partial page 3', 'second line page 3'] },
  ])

/** 消息内附件的正文标记：只该出现在文档与请求体里，不该出现在消息气泡 / 卡片 / 面板上 */
const DOC_ONLY_MARKER = '480 截图夹具：这句话只应出现在文档里，不该出现在消息气泡里。'
const makeMessageDocTxt = () =>
  Buffer.from(
    [
      DOC_ONLY_MARKER,
      '第二段：这份 TXT 会走真实的解析链路（编码识别 → 规范化 → 落库 → 注入）。',
      '第三段：消息里只保留附件 id 引用，卡片上只有文件名 / 大小 / 状态。',
    ].join('\n\n'),
    'utf8'
  )

/** 输入区文档入口的文案（与 i18n 一致；改文案时这里要跟着改，否则截图会等不到元素） */
const ATTACH_LABELS = {
  pickEnabled: '添加文档（TXT / DOCX / PDF）',
  openDetail: '查看附件详情',
  cancelParse: '取消解析',
  retryParse: '重新解析',
  statusSuccess: '已就绪',
  statusFailed: '解析失败，点击查看原因',
  statusCancelled: '解析已取消',
  failureUnknown: '解析过程中出现了未知问题',
}

/**
 * 量输入区的文档附件入口：可用态（`AttachmentPicker`）与禁用态（`aria-disabled` + toast 原因）的差别。
 * 判据取**无障碍属性**而不是类名：禁用的是 `aria-disabled="true"` + `attachChannelUnsupported` 文案。
 */
const measureDocEntry = (labels) => {
  const round = (value) => Math.round(value * 10) / 10
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'))
  const byLabel = (pattern) =>
    buttons.find((button) => pattern.test(button.getAttribute('aria-label') ?? '')) ?? null
  const describe = (button) => {
    if (button === null) {
      return null
    }
    const rect = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    return {
      ariaLabel: button.getAttribute('aria-label'),
      ariaDisabled: button.getAttribute('aria-disabled'),
      disabled: button.disabled,
      opacity: style.opacity,
      cursor: style.cursor,
      box: { width: round(rect.width), height: round(rect.height) },
    }
  }
  const enabled = byLabel(/添加文档/u)
  const disabled = byLabel(/当前渠道不支持文档附件/u)
  const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((input) => ({
    accept: input.getAttribute('accept'),
    multiple: input.multiple,
    hidden: input.hidden,
  }))
  return {
    // 当前渠道：三张「可用态」截图的像素是一样的（入口长相同一张），靠这一项证明
    // 确实是切到不同渠道之后的同一处渲染，而不是把一张图复制三份
    channelKind: (() => {
      try {
        return localStorage.getItem('chat-demo:provider-kind')
      } catch {
        return null
      }
    })(),
    enabled: enabled !== null,
    disabled: disabled !== null,
    entry: describe(enabled ?? disabled),
    docInputs: inputs.filter((input) => input.accept === '.txt,.docx,.pdf').length,
    allFileInputs: inputs.length,
    expectedPickLabel: labels.pickEnabled,
  }
}

/** 读当前 toast（`role="status"`）：禁用入口点下去必须给一句带原因的人话 */
const readToast = () => {
  const node = document.querySelector('[role="status"]')
  return node === null ? null : (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * 量附件卡片（输入区 / 消息内同一组件，只有 `variant` 不同）。
 *
 * 卡片没有 `data-testid`（#541 明确复用既有 `FileCard`、不新加测试钩子），所以按**语义**找：
 * `AttachmentCard` 给卡片的 `activator.label` 就是「查看附件详情」。
 * 进度条 / 角标 / 状态行按 CSS Module 的**类名前缀**取（构建后形如 `progressBar-_282ec`）。
 */
const measureAttachmentCards = () => {
  const round = (value) => Math.round(value * 10) / 10
  const text = (node) => (node === null ? '' : (node.textContent ?? '').replace(/\s+/gu, ' ').trim())
  const hasClass = (node, prefix) =>
    Array.from(node.classList).some((name) => name.startsWith(`${prefix}-`))
  const pick = (root, prefix, selector = 'div,span') =>
    Array.from(root.querySelectorAll(selector)).find((node) => hasClass(node, prefix)) ?? null
  const viewportWidth = document.documentElement.clientWidth
  const cards = Array.from(document.querySelectorAll('[role="button"][aria-label]')).filter(
    (node) => node.getAttribute('aria-label') === '查看附件详情'
  )
  const panels = Array.from(document.querySelectorAll('[role="dialog"]')).map((panel) => {
    const rect = panel.getBoundingClientRect()
    const warnings = Array.from(panel.querySelectorAll('li')).map((item) => text(item))
    return {
      label: panel.getAttribute('aria-label'),
      title: text(pick(panel, 'title')),
      meta: text(pick(panel, 'meta')),
      failureTitle: text(pick(panel, 'failureTitle')),
      raw: text(pick(panel, 'rawText')),
      warnings,
      actions: Array.from(panel.querySelectorAll('button'))
        .map((button) => button.getAttribute('aria-label') ?? text(button))
        .filter((label) => label !== ''),
      box: {
        left: round(rect.left),
        right: round(rect.right),
        width: round(rect.width),
        insideViewport:
          rect.left >= 0 && rect.right <= viewportWidth + 1 && rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
      },
      // 位置怎么定下来的（inline style 是 `useAnchoredPosition` 算出来的结果，
      // 越界时靠它判断是「算错了」还是「宽度根本放不下」）
      position: {
        inline: panel.getAttribute('style'),
        computedLeft: getComputedStyle(panel).left,
        computedTop: getComputedStyle(panel).top,
        maxHeight: getComputedStyle(panel).maxHeight,
      },
    }
  })
  const read = (card) => {
    const rect = card.getBoundingClientRect()
    const style = getComputedStyle(card)
    const bar = pick(card, 'progressBar', 'span')
    const track = pick(card, 'progress')
    const corner = pick(card, 'warnCorner', 'span')
    return {
      variant: hasClass(card, 'messageCard') ? 'message' : 'draft',
      expanded: card.getAttribute('aria-expanded') === 'true',
      name: text(pick(card, 'caption')),
      subCaption: text(pick(card, 'subCaption')),
      status: text(pick(card, 'statusText')),
      corner: corner === null ? null : { count: text(corner), title: corner.getAttribute('title') },
      progress:
        bar === null
          ? null
          : {
              text: text(pick(card, 'statusText')),
              width: round(bar.getBoundingClientRect().width),
              trackWidth: track === null ? null : round(track.getBoundingClientRect().width),
            },
      actions: Array.from(card.querySelectorAll('button'))
        .map((button) => button.getAttribute('aria-label') ?? text(button))
        .filter((label) => label !== ''),
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      box: {
        left: round(rect.left),
        right: round(rect.right),
        width: round(rect.width),
        height: round(rect.height),
        insideViewport: rect.left >= 0 && rect.right <= viewportWidth + 1,
      },
    }
  }
  const overflow = []
  for (const element of document.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.right > viewportWidth + 1) {
      overflow.push({
        tag: element.tagName,
        right: round(rect.right),
        text: (element.textContent ?? '').slice(0, 24),
      })
    }
  }
  return {
    cardCount: cards.length,
    cards: cards.map(read),
    panels,
    viewportWidth,
    documentScrollWidth: Math.round(document.documentElement.scrollWidth),
    bodyScrollWidth: Math.round(document.body.scrollWidth),
    overflowCount: overflow.length,
    overflowSamples: overflow.slice(0, 5),
  }
}

/**
 * 页面上**看得见的文字**（`innerText`）：用来断言「文档正文没有漏到界面上」。
 * §3.5 要求卡片与面板只显示元信息 —— 所以把文档正文里那句独一无二的标记拿去搜，
 * 消息气泡、卡片、详情面板整页都不该出现它。
 */
const readVisibleText = () => (document.body.innerText ?? '').replace(/\s+/gu, ' ').trim()

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
  // #562：钱入口并成「账户与消费」一页（旧 `ours-services-open` 已随弹层删除）
  accountConsumeOpen: '[data-testid="account-consume-open"]',
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

/**
 * #480：输入区那个隐藏的文档 `<input type="file">`。
 *
 * **不能**用 `accept*=".docx"` 找：「图片 / 文件上传」那个入口的 `ACCEPT` 白名单里同样有
 * pdf / txt / docx（历史上 Files API 也传文档），按包含关系找会选中错的那个 input。
 * 文档入口的 accept 是 `ACCEPT_DOCUMENTS = SUPPORTED_EXTENSIONS.join(',')`，只这三样，按**精确值**取。
 */
const ATTACH_DOC_ACCEPT = '.txt,.docx,.pdf'
const attachDocInput = (page) =>
  page.locator(`input[type="file"][accept="${ATTACH_DOC_ACCEPT}"]`).first()

/**
 * 等附件卡片从「等待解析 / 解析中」落到终态（成功 / partial / 失败 / 已取消）。
 * 判据取卡片第三行状态文案：`parsing` 才有进度，终态一定没有「解析中」这行。
 */
const waitForAttachSettled = async (page, timeout = 60000) => {
  await page.waitForFunction(
    () => {
      const cards = Array.from(document.querySelectorAll('[role="button"][aria-label]')).filter(
        (node) => node.getAttribute('aria-label') === '查看附件详情'
      )
      if (cards.length === 0) {
        return false
      }
      return cards.every((card) => {
        const lines = Array.from(card.querySelectorAll('div')).map((node) =>
          (node.textContent ?? '').trim()
        )
        return !lines.some((line) => line.startsWith('解析中') || line === '等待解析')
      })
    },
    undefined,
    { timeout }
  )
  // 让状态行的过渡动画走完再截图
  await page.waitForTimeout(260)
}

/**
 * 等输入区的附件卡片**达到 N 张**（新塞进去的文件在 React 里是下一帧才出现）。
 *
 * 只 `waitForAttachSettled()` 是不够的：它判的是「现有卡片都落终态」，而新卡还没挂上去时
 * 上一张已经是终态了 —— 于是它立刻返回，量到的却是「解析中 · 校验文件」那一帧（#574 重拍时踩到）。
 */
const waitForAttachCardCount = async (page, count, timeout = 20000) => {
  await page.waitForFunction(
    (expected) => {
      const cards = Array.from(document.querySelectorAll('[role="button"][aria-label]')).filter(
        (node) => node.getAttribute('aria-label') === '查看附件详情'
      )
      return cards.length >= expected
    },
    count,
    { timeout }
  )
}

/** 点开第一张附件卡片的详情面板（`AttachmentCard` 的整卡就是激活器） */
const openAttachPanel = async (page) => {
  await page
    .locator('[role="button"][aria-label="查看附件详情"]')
    .first()
    .click()
  await page.getByRole('dialog', { name: '查看附件详情' }).waitFor({ state: 'visible', timeout: 8000 })
  await page.waitForTimeout(260)
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
// ---------------------------------------------------------------- #486 P0 渲染样本

/** 会话标题：截图里靠它进会话 */
const MARKDOWN_SESSION_TITLE = '截图-Markdown-渲染-486'

/**
 * 代码块内容：第 4 行故意写得比任何一档视口都长 —— 「换行关掉」时必须出现横向滚动，
 * 否则那张图证明不了开关真的生效。行数固定 14 行，行号断言按 `MARKDOWN_CODE_LINES` 数。
 */
const MARKDOWN_CODE = [
  'def summarize(items):',
  '    """把明细汇总成一张表：这段是块注释，故意跨两行',
  '    用来验证跨行 token 在行号切分后仍然完整。"""',
  '    total = sum(item["amount"] for item in items if item["amount"] is not None and not item["refunded"])  # 这一行故意写得很长，用来验证「自动换行 / 横向滚动」的切换',
  '    rows = []',
  '    for item in items:',
  '        rows.append([item["name"], item["amount"]])',
  '    return {',
  '        "total": total,',
  '        "count": len(items),',
  '        "rows": rows,',
  '    }',
  '',
  'print(summarize([]))',
].join('\n')
const MARKDOWN_CODE_LINES = MARKDOWN_CODE.split('\n').length

/** 表格样本：一列左对齐、一列居中、一列右对齐；含行内代码与强调，复制出来才能验序列化 */
const MARKDOWN_TABLE = [
  '| 能力 | 开关位置 | 默认值 |',
  '| :--- | :---: | ---: |',
  '| 行号 | 标题栏「行号」 | 关 |',
  '| 换行 | 标题栏「换行」 | `开` |',
  '| 公式复制 | 公式右上角 | **悬停出现** |',
].join('\n')

/** 行间公式：复制出来应当是纯 TeX（不含 `$$`） */
const MARKDOWN_MATH = '\\int_0^1 x^2\\,\\mathrm{d}x = \\frac{1}{3}'

const makeMarkdownSession = () => {
  const now = Date.now()
  const fence = '```'
  const text = [
    '## Markdown 渲染细节（#486 P0）',
    '行内公式 $a^2 + b^2 = c^2$ 用来验行内公式的复制入口；下面依次是代码块、表格与行间公式。',
    [`${fence}python`, MARKDOWN_CODE, fence].join('\n'),
    MARKDOWN_TABLE,
    ['$$', MARKDOWN_MATH, '$$'].join('\n'),
  ].join('\n\n')
  return {
    id: 'shot-markdown-486',
    title: MARKDOWN_SESSION_TITLE,
    createdAt: now,
    updatedAt: now + 2000,
    messages: [
      userMessage('shot-markdown-u1', '给我一段带代码块、表格和公式的回答。', now),
      assistantMessage('shot-markdown-a1', [{ type: 'text', text }], now + 1),
    ],
  }
}


// ---------------------------------------------------------------- #821 KaTeX 不支持宏

/** 会话标题：截图里靠它进会话 */
const KATEX_821_SESSION_TITLE = '截图-KaTeX-不支持宏-821'

/**
 * 票面「美化4.1（安卓深色）」的真实输出：一个用排版宏「画」出来的气泡卡片。
 *
 * `\sf` 开无衬线，四个模块用 `\\[2pt]` 分隔：标题栏（`\colorbox` 底色 + `\raisebox` 叠头像 +
 * `\rule` 画分隔线）／名字行（`\scalebox` 缩放 + 时间戳）／气泡正文（`\smash` + `\rotatebox`
 * 角标）／已读行。**`\scalebox` 与 `\rotatebox` 是 KaTeX 没有的命令**，改动前一个就把整块
 * 打成 ParseError → 整块换成原文（一屏反斜杠）。
 */
const KATEX_821_BEAUTY = [
  '\\[',
  '\\sf',
  '\\colorbox{#1e1e20}{\\textcolor{#e6e6e6}{\\text{  DeepSeek  }}}\\hspace{-0.33em}\\raisebox{70pt}[0pt][0pt]{\\text{◖◗}}\\hspace{-2em}\\rule{30em}{0pt}',
  '\\\\[2pt]',
  '\\scalebox{1.2}[1.2]{\\text{小助手}}\\hspace{-0.33em}\\colorbox{#2b2b2b}{\\text{\\textcolor{#fff}{ 今天 14:02 }}}',
  '\\\\[6pt]',
  '\\smash{\\text{◖◗}}\\hspace{-0.33em}\\colorbox{#2b2b2b}{\\text{\\textcolor{#e6e6e6}{ 你好，我是助手 }}}\\raisebox{70pt}[0pt][0pt]{\\rotatebox{15}{\\text{o}}}',
  '\\\\[2pt]',
  '\\rule{30em}{0pt}\\hspace{-2em}\\text{\\textcolor{#888}{已读}}',
  '\\]',
].join('\n')

const makeKatex821Session = () => {
  const now = Date.now()
  return {
    id: 'shot-katex-821',
    title: KATEX_821_SESSION_TITLE,
    createdAt: now,
    updatedAt: now + 2000,
    messages: [
      userMessage('shot-katex-821-u1', '用美化4.1（安卓深色）给我排一条气泡消息。', now),
      assistantMessage(
        'shot-katex-821-a1',
        [
          {
            type: 'text',
            text: [
              '美化4.1（安卓深色）排出来的气泡：',
              KATEX_821_BEAUTY,
              '行内那次也要稳住：$\\scalebox{1.2}{\\text{行内}} 不该整段变成源码$，正常公式 $a^2+b^2=c^2$ 仍然照常渲染。',
              // 第二段：A 方案救不回来的命令（KaTeX 没有 tikz 环境）—— 走 B/C 的降级分支
              [
                '\\[',
                '\\rule{20em}{0.4pt}',
                '\\\\[2pt]',
                '\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}',
                '\\\\[2pt]',
                '\\text{上一行是画图命令，KaTeX 没有实现}',
                '\\]',
              ].join('\n'),
            ].join('\n\n'),
          },
        ],
        now + 1
      ),
    ],
  }
}

/** 页面里量一遍：渲染了哪些、泄露了哪些、有没有横向溢出 */
const KATEX_821_PROBE = () => {
  // 改动前渲染失败时根本没有 `.md-math-block`（整块被换成 `<p>` 原文），所以按「公式容器」取
  const mathBlocks = Array.from(document.querySelectorAll('.ds-markdown-math, .ds-markdown-paragraph'))
  /**
   * 源码外露的判据：**可见文本**里出现 TeX 命令。两个例外必须先摘掉，否则会误报：
   * `.md-math-unsupported`（降级块里本来就该显示原文）与 `.katex-mathml`（KaTeX 藏起来的 MathML annotation）。
   */
  const visibleTextOf = (element) => {
    const clone = element.cloneNode(true)
    // 内联 script 的源码在 textContent 里也算「文字」，会把 `\btoken` 这种误报成外露的 TeX
    for (const node of clone.querySelectorAll('.md-math-unsupported, .katex-mathml, script, style')) {
      node.remove()
    }
    return clone.textContent ?? ''
  }
  /** 只看正文（`.ds-markdown`）：改动前失败时正文是 `<p>` 原文，也在里面 */
  const bodyText = () => {
    const marks = Array.from(document.querySelectorAll('.ds-markdown'))
    return marks.length > 0 ? marks.map(visibleTextOf).join(' ') : visibleTextOf(document.body)
  }
  const leakedCommands = (bodyText().match(/\\[a-zA-Z]{3,}/gu) ?? []).sort()
  /** 尺寸参数残渣（`\raisebox` 的可选参数曾被当文字打出来） */
  const leakedSizes =
    bodyText().match(/\[\s*[-+]?\d+(?:\.\d+)?\s*(?:pt|em|ex|mm|cm|px)\s*\]/gu) ?? []
  const scrollable = /(auto|scroll|overlay)/
  const absorbed = (element) => {
    let node = element.parentElement
    while (node !== null) {
      if (scrollable.test(getComputedStyle(node).overflowX)) {
        return true
      }
      node = node.parentElement
    }
    return false
  }
  let overflowCount = 0
  let worst = 0
  for (const element of document.querySelectorAll('body *')) {
    const excess = element.getBoundingClientRect().right - document.documentElement.clientWidth
    if (excess > 1 && !absorbed(element)) {
      overflowCount += 1
      worst = Math.max(worst, Math.round(excess))
    }
  }
  return {
    mathBlockCount: mathBlocks.length,
    /** KaTeX 自己的红字错误块：改动前后都应该是 0（改动前是原文，不是红字） */
    katexErrorBlocks: document.querySelectorAll('.katex-error').length,
    /** 真正渲染出来的 KaTeX 子树（MathML 存在 = 渲染成功） */
    katexSubtrees: document.querySelectorAll('.katex-mathml').length,
    /** 降级视图里的「能渲染的模块」行数 */
    degradedLines: document.querySelectorAll('.md-math-degraded-line').length,
    /** 降级视图里的「这一行用了不支持的排版命令」块数 */
    unsupportedBlocks: document.querySelectorAll('.md-math-unsupported').length,
    /** 可折叠的「查看原文」入口（B/C 方案的兜底开关） */
    sourceToggles: document.querySelectorAll('.md-math-unsupported-detail > summary').length,
    /** 近似提示（A 方案做过映射时出现） */
    simplifiedNotes: document.querySelectorAll('.md-math-degraded-note').length,
    leakedCommands,
    leakedSizes,
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    overflowCount,
    worstOverflowPx: worst,
  }
}

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
    title: '#235 设置 → 数据管理 → 账户与消费 → 购买：套餐列表 / 去支付 / 收银台提示（390 与 360 两档）',
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

      // #562：旧 `OursServicesDialog` 已退役，「套餐 / 去支付」这一段搬进「账户与消费」页的
      // 「购买」tab（`components/consume/BuyTab.tsx`）。入口 testid 也从 `ours-services-open`
      // 换成 `account-consume-open`，页面根节点是 `account-consume-page`。
      await openSettings(page, S.tabData)
      const entry = page.locator(S.accountConsumeOpen)
      await entry.waitFor({ state: 'visible', timeout: 10000 })
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(240)
      await entry.click()

      const dialog = page.locator('[data-testid="account-consume-page"]')
      await dialog.waitFor({ state: 'visible', timeout: 10000 })
      await page.getByTestId('account-consume-tab-buy').click()
      await page.waitForTimeout(700)

      const plans = page.locator('[data-testid="account-consume-buy-plan"]').first()
      await plans.scrollIntoViewIfNeeded()
      await page.waitForTimeout(360)
      const buy = page.locator('[data-testid="account-consume-buy-open"]').first()
      const buyBox = await buy.boundingBox()
      // 「购买」tab 的说明文案就在列表上方（`oursPayHint`）；通道不可用的状态行只在失败态出现，
      // 这里按「有提示就记下来」处理，不把「本次没触发失败」当成漏改。
      const notice = page.locator('[data-testid="account-consume-buy"] p').first()
      const noticeText = (await notice.textContent().catch(() => '')) ?? ''
      record('purchase', {
        plans: await page.locator('[data-testid="account-consume-buy-plan"]').count(),
        buyBox: buyBox === null ? null : { w: Math.round(buyBox.width), h: Math.round(buyBox.height) },
        notice: noticeText.trim(),
        nativeCopy: noticeText.includes('App 内'),
      })
      if (buyBox === null || buyBox.height < 44) {
        warn(`「去支付」点击区不足 44px：${buyBox === null ? 'null' : Math.round(buyBox.height)}`)
      }
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

      // ⑦ #817：「我的额度」整页退场（余额卡里的入口也删了）—— 这一拍改成钱包页首：
      //    余额卡 + 付款入口**同一行**（`account-consume-wallet-head`）。
      //    `docs/ui/account-consume/` 里那张 `05-quota-panel` 是 #487 时代的历史取证，不重截。
      await page.getByTestId('account-consume-wallet').click()
      await page.getByTestId('account-consume-wallet-head').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(900)
      await shot('05-wallet-head')
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
  '711-settings-no-memory': {
    // 与 `before/`（改前对照）并列：默认落 `after/`，两档都在同一目录下
    dir: 'docs/ui/711-settings-no-memory/after',
    title: '#711 设置弹窗侧边栏下线「记忆」分组：只剩「通用设置 / 数据管理」两项，且打不开记忆页',
    // 不 seed 会话：本单只看侧边栏，`seedInPage` 那条路依赖 `DB_VERSION`（main 上脚本还写着 13，
    // src 已经是 14，任何带 `sessions` 的场景现在都会 VersionError —— 与本单无关，见 PR 的「未测边界」）。
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      /**
       * 横向溢出：`overflowCount` 是本单的硬指标（390 / 360 两档都必须 **0**，口径同 #106），
       * 每次状态都量一次；非 0 直接抛（`warn` 不进判定，等于没断言）。
       */
      const measureOverflow = () =>
        page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth
          const overflow = []
          for (const element of document.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.right > viewportWidth + 1) {
              overflow.push({
                tag: element.tagName,
                right: Math.round(rect.right),
                text: (element.textContent ?? '').slice(0, 24),
              })
            }
          }
          return {
            viewportWidth,
            documentScrollWidth: Math.round(document.documentElement.scrollWidth),
            overflowCount: overflow.length,
            overflowSamples: overflow.slice(0, 5),
          }
        })
      const overflowSeen = []
      const requireNoOverflow = async (label) => {
        const measured = await measureOverflow()
        overflowSeen.push({ label, overflowCount: measured.overflowCount })
        if (measured.overflowCount !== 0) {
          throw new Error(
            `${label} 出现横向溢出 ${measured.overflowCount} 处：${JSON.stringify(measured.overflowSamples)}`
          )
        }
        return measured
      }

      /** 侧边栏真相：tab 数量 / 文案 / 当前选中项 / 记忆开关的 testid 命中数 */
      const readAside = async () => {
        const tabs = page.getByRole('tab')
        const texts = (await tabs.allInnerTexts()).map((text) => text.replace(/\s+/gu, ' ').trim())
        return {
          tabCount: await tabs.count(),
          tabTexts: texts,
          selected: (await page.getByRole('tab', { selected: true }).allInnerTexts()).map((text) =>
            text.replace(/\s+/gu, ' ').trim()
          ),
          memoryTabCount: texts.filter((text) => /记忆|Memory/u.test(text)).length,
          memoryToggleCount: await page.locator('[data-testid="memory-embedding-toggle"]').count(),
        }
      }

      await openSettings(page)
      const general = await readAside()
      const dialogText = await page.getByRole('dialog').last().innerText()
      record('asideGeneral', general)
      record('dialogText', dialogText.replace(/\s+/gu, ' ').trim().slice(0, 400))
      record('dialogHasMemoryWord', /记忆/u.test(dialogText))
      await requireNoOverflow('通用设置')

      // ---- 硬判据：侧边栏只剩两项、没有「记忆」、没有那个 embedding 开关 ----
      if (general.tabCount !== 2) {
        throw new Error(`侧边栏应只有 2 项，实际 ${general.tabCount} 项：${JSON.stringify(general.tabTexts)}`)
      }
      if (JSON.stringify(general.tabTexts) !== JSON.stringify([S.tabGeneral, S.tabData])) {
        throw new Error(`侧边栏两项应为「${S.tabGeneral} / ${S.tabData}」，实际 ${JSON.stringify(general.tabTexts)}`)
      }
      if (general.memoryTabCount !== 0) {
        throw new Error(`侧边栏出现了「记忆」项：${JSON.stringify(general.tabTexts)}`)
      }
      if (general.memoryToggleCount !== 0) {
        throw new Error(`DOM 里仍有 memory-embedding-toggle（${general.memoryToggleCount} 个）`)
      }
      if (JSON.stringify(general.selected) !== JSON.stringify([S.tabGeneral])) {
        throw new Error(`默认应落在「${S.tabGeneral}」，实际选中 ${JSON.stringify(general.selected)}`)
      }
      await shot('01-侧边栏-通用设置')

      // 侧边栏特写：只看导航条这一块（两项并排、没有第三个 tab）
      const navBox = await page.getByRole('tablist').first().boundingBox()
      if (navBox !== null) {
        await shot('02-侧边栏特写', {
          clip: {
            x: Math.max(0, navBox.x - 4),
            y: Math.max(0, navBox.y - 4),
            width: Math.min(navBox.width + 8, ctx.size.width),
            height: navBox.height + 8,
          },
        })
      } else {
        warn('拿不到侧边栏（role=tablist）的位置，跳过特写')
      }

      // ---- 剩下那一项仍能打开、面板不是空的 ----
      await page.getByRole('tab', { name: S.tabData }).click()
      await page.waitForTimeout(350)
      const dataPanel = await page.getByRole('tabpanel').first().innerText()
      const data = await readAside()
      record('asideData', data)
      record('dataPanelNonEmpty', dataPanel.trim().length > 20)
      if (JSON.stringify(data.selected) !== JSON.stringify([S.tabData])) {
        throw new Error(`点了「${S.tabData}」但选中态不是它：${JSON.stringify(data.selected)}`)
      }
      if (dataPanel.trim().length <= 20) {
        throw new Error(`「${S.tabData}」面板是空的（${dataPanel.length} 字符）`)
      }
      // 切到数据管理后依然不许出现记忆开关（两档面板都验一遍）
      if (data.memoryToggleCount !== 0) {
        throw new Error(`切到「${S.tabData}」后仍出现 memory-embedding-toggle`)
      }
      await requireNoOverflow('数据管理')
      await shot('03-数据管理')

      // 切回去：general 面板也非空（收窄三元只留一支 general，不能在数据管理之外渲染空白）
      await page.getByRole('tab', { name: S.tabGeneral }).click()
      await page.waitForTimeout(350)
      const generalPanel = await page.getByRole('tabpanel').first().innerText()
      record('generalPanelNonEmpty', generalPanel.trim().length > 20)
      record('generalPanelFirstLines', generalPanel.split('\n').filter(Boolean).slice(0, 3))
      if (generalPanel.trim().length <= 20) {
        throw new Error(`「${S.tabGeneral}」面板是空的（${generalPanel.length} 字符）`)
      }
      await requireNoOverflow('通用设置-回切')

      record('overflowSeen', overflowSeen)
      record('overflowCount', Math.max(...overflowSeen.map((entry) => entry.overflowCount)))
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

  'a7-entry': {
    dir: 'docs/ui/487-a7-entry',
    title:
      '#487 A7：设置 → 数据管理里「付款记录 / 我的购买 / 支付时间线」三个钱入口已合成一格「账户与消费」（390 宽验收）',
    sessions: () => [makeReadingSession()],
    // 这一格只在自有渠道出现（#166）：别的渠道没有自己的卡密与套餐
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSettings(page, S.tabData)
      const entry = page.locator(S.accountConsumeOpen)
      await entry.waitFor({ state: 'visible', timeout: 15000 })
      await entry.scrollIntoViewIfNeeded()
      await page.waitForTimeout(320)

      const measured = await page.evaluate(measureAccountConsumeEntry)
      record('accountConsumeEntry', measured)
      if (!measured.present) {
        throw new Error('设置 → 数据管理里没有「账户与消费」这一格（[data-testid="account-consume-open"]）')
      }
      if (measured.accountConsumeOpen !== 1) {
        warn(`「账户与消费」入口有 ${measured.accountConsumeOpen} 个，应该恰好 1 个（三个入口合成一格）`)
      }
      for (const [testid, n] of Object.entries(measured.legacyEntries)) {
        if (n !== 0) warn(`旧入口 ${testid} 还有 ${n} 个：钱入口没合干净`)
      }
      if (measured.legacyWordings.length > 0) {
        warn(`设置页正文里还有旧叫法：${measured.legacyWordings.join(' / ')}`)
      }
      if (measured.horizontalOverflow) warn('设置页横向溢出（scrollWidth > clientWidth）')
      if (measured.clickTargetHeight < 44) {
        warn(`「查看」按钮点击区只有 ${measured.clickTargetHeight}px（移动端下限 44px）`)
      }
      if (!measured.inViewport) warn('这一格没有完整落在视口内：这张图证明不了「一眼看到」')
      await shot('01-settings-data-account-consume-entry')
      const box = measured.row ?? measured.button ?? { x: 0, y: 0, width: ctx.size.width, height: 0 }
      await shot('02-entry-closeup', {
        clip: {
          x: Math.max(0, box.x - 4),
          y: Math.max(0, box.y - 4),
          width: Math.min(box.width + 8, ctx.size.width),
          height: box.height + 8,
        },
      })
    },
  },

  '727-consume-page': {
    dir: 'docs/ui/727-consume-page',
    title:
      '#727 验收取证（对 main 上的实现拍）：设置 →「账户与消费」一级入口整页 —— 模型来源底部 sheet / 连通性正常态 / 我的钱包余额卡 / 我的卡密 / 历史消费 / 账号（未登录 segmented 卡片 + 已登录资料）· 390 与 360 两档',
    sessions: () => [makeReadingSession()],
    // 入口只在自有渠道出现（#166）：卡密与套餐来自 apia，别的渠道没有自己的订单
    providerKind: 'ours',
    mockPurchases: {
      totalPaidYuan: 40,
      orders: [
        {
          out_trade_no: 'CP202611200000727',
          plan_id: 'standard',
          plan_name: '标准包 500万 token',
          plan_points: 3900,
          amount_yuan: 39,
          status: 'FULFILLED',
          status_text: '已完成',
          card_no: 'MUSE-7270-0000-0000-RRQY',
          card_status: 'used',
          redeem_state: 'redeemed',
          created_at: 1795055400,
          paid_at: 1795055460,
        },
        {
          out_trade_no: 'CP202611180000728',
          plan_id: 'starter',
          plan_name: '入门包 5 元额度',
          plan_points: 500,
          amount_yuan: 5,
          status: 'FULFILLED',
          status_text: '已完成',
          card_no: 'MUSE-7270-0000-0000-JP9Q',
          card_status: 'leased',
          redeem_state: 'issued',
          created_at: 1794882600,
          paid_at: 1794882660,
        },
      ],
    },
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      const reply = (body, status = 200) => ({
        status,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      })
      const preflight = {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization,accept,content-type,x-session-id',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-max-age': '600',
        },
      }
      /** 消费层统一信封（`services/consume/http.ts` 只认 `{code,message,data}`） */
      const envelope = (data) => reply({ code: 0, message: 'success', data })
      /** 横向溢出硬指标（#106 口径）：本页要求 390 / 360 两档每个状态都是 0 */
      const measureOverflow = () =>
        page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth
          const overflow = []
          for (const element of document.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.right > viewportWidth + 1) {
              overflow.push({ tag: element.tagName, right: Math.round(rect.right), text: (element.textContent ?? '').slice(0, 24) })
            }
          }
          return {
            viewportWidth,
            documentScrollWidth: Math.round(document.documentElement.scrollWidth),
            overflowCount: overflow.length,
            overflowSamples: overflow.slice(0, 5),
          }
        })
      const overflowSeen = []
      const requireNoOverflow = async (label) => {
        const measured = await measureOverflow()
        overflowSeen.push({ label, overflowCount: measured.overflowCount })
        if (measured.overflowCount !== 0) {
          throw new Error(`${label} 出现横向溢出 ${measured.overflowCount} 处：${JSON.stringify(measured.overflowSamples)}`)
        }
        return measured
      }

      // 未登录 → 已登录：同一台机器上翻态，接口才给数据（与真实的 `restoreAuth()` 时序一致）
      let signedIn = false
      await page.route(`${consumeBaseUrl}${consumeApiV1Prefix}/**`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill(preflight)
          return
        }
        const { pathname } = new URL(route.request().url())
        if (pathname.endsWith('/settings/public')) {
          await route.fulfill(
            envelope({ registration_enabled: true, email_verify_enabled: false, invitation_code_enabled: true })
          )
          return
        }
        if (!signedIn) {
          await route.fulfill(reply({ code: 401, message: 'unauthorized' }, 401))
          return
        }
        if (pathname.endsWith('/auth/me') || pathname.endsWith('/user/profile')) {
          await route.fulfill(envelope(SHOT_ACCOUNT_USER))
          return
        }
        if (pathname.endsWith('/keys')) {
          await route.fulfill(
            envelope({
              items: [
                { id: 11, name: '主力 Key', key: 'sk-shot-mobile-fixture-0000', status: 'active', quota: 5000000, quota_used: 1250000, created_at: '2026-11-01T10:00:00+08:00' },
              ],
              total: 1,
              page: 1,
              page_size: 20,
              pages: 1,
            })
          )
          return
        }
        if (pathname.endsWith('/user/aff')) {
          await route.fulfill(
            envelope({ aff_code: 'SHOT727', aff_count: 2, aff_quota: 12.5, aff_frozen_quota: 0, aff_history_quota: 12.5 })
          )
          return
        }
        // 消费记录（`/api/v1/usage` 一族）：给两条，让「历史消费」不是空态
        if (pathname.includes('/usage')) {
          await route.fulfill(
            envelope({
              items: [
                { id: 1, model: 'deepseek-v4.1-flash', created_at: '2026-11-21T14:32:00+08:00', cost: 0.12, requests: 1 },
                { id: 2, model: 'deepseek-v4.1-flash', created_at: '2026-11-20T21:08:00+08:00', cost: 0.36, requests: 1 },
              ],
              total: 2,
              page: 1,
              pages: 1,
            })
          )
          return
        }
        await route.fulfill(envelope({ items: [], total: 0, page: 1, pages: 0 }))
      })
      // 余额链（`GET /v1/usage`，sk- Key 通道，**裸 JSON 不套信封**）：`usage.total.actual_cost` 才是「已用」
      await page.route(`${consumeBaseUrl}${consumeGatewayPrefix}/**`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill(preflight)
          return
        }
        await route.fulfill(
          reply({
            mode: 'unrestricted',
            isValid: true,
            balance: 128.5,
            remaining: 128.5,
            unit: 'CNY',
            rate_limits: [],
            usage: { total: { requests: 12, input_tokens: 1000, output_tokens: 500, total_tokens: 1500, actual_cost: 12.34 } },
            quota: { limit: 0, used: 0, remaining: 0, unit: 'CNY' },
            days_until_expiry: 27,
          })
        )
      })
      // 连通性：点下去才发请求（复用 `probeProvider` → GET /v1/models）
      // #812：ours 推理/模型探测打的是登录环境（consume.baseUrl），不再是旧池域 chatBaseUrl
      await page.route(`${inferenceBaseUrl}/v1/models`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill(preflight)
          return
        }
        await route.fulfill(reply({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-pro' }] }))
      })

      // 打桩装好之后 reload：`settings/public`（注册开关）与登录恢复都在**首屏**读。
      // `nativeBridgeStub` 只提供传输（消费层只走 CapacitorHttp），不绕登录、不给产物留旁路。
      await page.addInitScript(nativeBridgeStub)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(400)

      /** 打开设置 → 点**一次**「账户与消费」（一级入口）→ 整页 */
      const openConsumePage = async (label, entryShot) => {
        await openSettings(page)
        const entry = page.locator(S.accountConsumeOpen)
        await entry.waitFor({ state: 'visible', timeout: 15000 })
        if (entryShot !== undefined) {
          await page.waitForTimeout(400)
          await shot(entryShot)
        }
        const entryCount = await entry.count()
        record(label, { entryCount, entryText: (await entry.innerText()).replace(/\s+/gu, ' ').trim() })
        if (entryCount !== 1) {
          throw new Error(`设置里「账户与消费」入口有 ${entryCount} 个，必须恰好 1 个（不许两套入口并存）`)
        }
        await entry.click()
        await page.locator('[data-testid="account-consume-page"]').waitFor({ state: 'visible', timeout: 15000 })
        await page.waitForTimeout(600)
      }

      const readHome = () =>
        page.evaluate(() => {
          const text = (selector) => {
            const node = document.querySelector(selector)
            return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
          }
          // 34px 大标题（`.pageTitle`）：按「算出来的字号」找，不猜 DOM 层级
          const title = Array.from(document.querySelectorAll('[role="dialog"] *')).find((node) => {
            const text = (node.textContent ?? '').trim()
            return text === '账户与消费' && getComputedStyle(node).fontSize === '34px'
          })
          const rows = Array.from(document.querySelectorAll('[data-testid^="account-consume-tab-"]')).map((node) => ({
            text: (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
            height: Math.round(node.getBoundingClientRect().height),
            selected: node.getAttribute('aria-selected'),
          }))
          return {
            titleFontSize: title === null ? null : getComputedStyle(title).fontSize,
            source: text('[data-testid="account-consume-source"]'),
            conn: text('[data-testid="account-consume-conn-state"]'),
            balance: text('[data-testid="account-consume-balance"]'),
            rows,
            tabCount: rows.length,
          }
        })

      // ── ① 一级入口 + 整页（未登录）─────────────────────────────────────
      await openConsumePage('entry', '00-settings-entry')
      const home = await readHome()
      record('signedOutHome', { ...home, ...(await requireNoOverflow('整页（未登录）')) })
      if (home.tabCount !== 4) {
        throw new Error(`四个分区入口应当都在，只有 ${home.tabCount} 个`)
      }
      const shortRow = home.rows.filter((row) => row.height < 56)
      if (shortRow.length > 0) {
        warn(`有 ${shortRow.length} 行的行高不足 56px：${JSON.stringify(shortRow)}`)
      }
      await shot('01-page-home-signed-out')

      // ── ② 模型来源：底部 sheet ─────────────────────────────────────────
      await page.getByTestId('account-consume-source').click()
      await page.locator('[data-testid="account-consume-source-sheet"]').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(400)
      const sheet = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="account-consume-source-sheet"]')
        const rect = node === null ? null : node.getBoundingClientRect()
        // 只数「可选项」（四个来源），不含 mask / cancel / save 这几个同前缀的兄弟节点
        const options = Array.from(node?.querySelectorAll('[data-testid^="account-consume-source-"][aria-pressed]') ?? []).map(
          (item) => (item.textContent ?? '').replace(/\s+/gu, ' ').trim()
        )
        return {
          options,
          bottomGap: rect === null ? null : Math.round(document.documentElement.clientHeight - rect.bottom),
          width: rect === null ? null : Math.round(rect.width),
          viewport: document.documentElement.clientWidth,
        }
      })
      record('sourceSheet', { ...sheet, ...(await requireNoOverflow('模型来源 sheet')) })
      if (sheet.options.length !== 4) {
        throw new Error(`模型来源选项应当等于既有 ProviderKind 的 4 条，拿到 ${sheet.options.length} 条`)
      }
      await shot('02-source-sheet')
      await page.getByTestId('account-consume-source-cancel').click()
      await page.waitForTimeout(300)

      // ── ③ 连通性：点一下才有结果（复用既有 probeProvider）────────────────
      await page.getByTestId('account-consume-conn').click()
      await page.waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="account-consume-conn-state"]')
          const text = node === null ? '' : (node.textContent ?? '')
          return !text.includes('测试中') && !text.includes('未测试')
        },
        { timeout: 15000 }
      )
      await page.waitForTimeout(300)
      const conn = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="account-consume-conn-state"]')
        const dot = node === null ? null : node.querySelector('i')
        return {
          text: node === null ? null : (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
          dotColor: dot === null ? null : getComputedStyle(dot).backgroundColor,
        }
      })
      record('connectivity', { ...conn, ...(await requireNoOverflow('连通性（正常）')) })
      if (conn.text === null || !conn.text.includes('ms')) {
        throw new Error(`连通性没有落到「正常 N ms」：${String(conn.text)}`)
      }
      await shot('03-connectivity-ok')

      // ── ④ 我的卡密（脱敏 + badge + 动作；完整卡密不进 DOM）──────────────
      await page.getByTestId('account-consume-tab-cards').click()
      await page.locator('[data-testid="account-consume-card-row"]').first().waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(400)
      const cards = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="account-consume-card-row"]'))
        return {
          count: rows.length,
          leaksFullCard: (document.body.innerText ?? '').includes('MUSE-7270-0000-0000-RRQY'),
          actions: Array.from(rows[0]?.querySelectorAll('button') ?? []).map((node) => (node.textContent ?? '').trim()),
        }
      })
      record('cards', { ...cards, ...(await requireNoOverflow('我的卡密')) })
      if (cards.leaksFullCard) {
        throw new Error('完整卡密进了 DOM 文本（只许脱敏显示，全文只进剪贴板）')
      }
      await shot('04-cards')

      /**
       * ── ⑤ 历史消费（**未登录**）：这一张只能是空态，因为 `HistoryView` 在 `signedIn === false`
       * 时**一个请求都不发**（`HistoryView.tsx` 的 `load()`：没登录 / 没 Key 直接给空列表 ——
       * 拿 JWT 硬打 `/v1/usage` 只会 401）。所以它不是「mock 形状没被认出来」，
       * 而是**拍的时间点还没登录**；「有扣费记录」的那一态在 ⑨。
       */
      await page.getByTestId('account-consume-history').click()
      await page.locator('[data-testid="account-consume-history-empty"]').waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(400)
      const history = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="account-consume-page"]')
        const empty = document.querySelector('[data-testid="account-consume-history-empty"]')
        return {
          text: body === null ? null : (body.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400),
          emptyText: empty === null ? null : (empty.innerText ?? '').replace(/\s+/gu, ' ').trim(),
          rows: document.querySelectorAll('[data-testid="account-consume-history-row"]').length,
        }
      })
      record('historySignedOut', { ...history, ...(await requireNoOverflow('历史消费（未登录·空态）')) })
      if (history.rows !== 0 || history.emptyText === null) {
        throw new Error(`未登录的历史消费应当是空态（不发请求）：rows=${history.rows} empty=${String(history.emptyText)}`)
      }
      await shot('05-history')

      // ── ⑥ 账号（未登录）：登录 / 注册入口 + segmented，**不是登录墙** ────────
      await page.getByTestId('account-consume-tab-account').click()
      await page.locator('[data-testid="account-optional-notice"]').waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(500)
      const signedOut = await page.evaluate(() => {
        const text = (selector) => {
          const node = document.querySelector(selector)
          return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
        }
        const card = document.querySelector('[data-testid="account-auth-card"]')
        return {
          notice: text('[data-testid="account-optional-notice"]'),
          fillKey: document.querySelectorAll('[data-testid="account-fill-key"]').length,
          authCard: card === null ? 0 : 1,
          segments: ['login', 'register'].filter(
            (key) => document.querySelector(`[data-testid="auth-segmented-${key}"]`) !== null
          ),
          passwordFields: document.querySelectorAll('input[type="password"]').length,
        }
      })
      record('accountSignedOut', { ...signedOut, ...(await requireNoOverflow('账号（未登录）')) })
      if (!String(signedOut.notice ?? '').includes('不登录也可以')) {
        throw new Error(`账号分区未登录态没有「不登录也可以」那句：${String(signedOut.notice)}`)
      }
      if (signedOut.segments.length !== 2) {
        throw new Error(`登录 / 注册的 segmented 应当是两段，拿到 ${JSON.stringify(signedOut.segments)}`)
      }
      await shot('06-account-signed-out')

      // ── ⑦ 已登录态：落盘凭据 → reload → 后台恢复真的跑一遍 ────────────────
      signedIn = true
      await page.evaluate(({ persisted }) => {
        localStorage.setItem('chat-demo:auth-token', persisted)
        // 来源保持 ours（入口只在自有渠道出现，reload 后还要能重新进这一页）
        localStorage.setItem('chat-demo:provider-kind', 'ours')
      }, {
        persisted: JSON.stringify({
          v: 1,
          token: { accessToken: 'shot-mobile-access-token', tokenType: 'Bearer', expiresAt: Date.now() + 86_400_000 },
          user: { id: 2, email: 'demo@example.com', username: 'demo', role: 'user', emailVerified: true },
        }),
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 })
      await openConsumePage('entrySignedIn')
      const signedInHome = await readHome()
      record('signedInHome', { ...signedInHome, ...(await requireNoOverflow('整页（已登录）')) })
      if (!String(signedInHome.balance ?? '').includes('128.50')) {
        throw new Error(`余额卡没有显示服务端余额（`/v1/usage` 的 balance）：${String(signedInHome.balance)}`)
      }
      await shot('07-page-home-signed-in')

      await page.getByTestId('account-consume-tab-account').click()
      await page.locator('[data-testid="account-consume-profile"]').waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(500)
      const signedInAccount = await page.evaluate(() => {
        const text = (selector) => {
          const node = document.querySelector(selector)
          return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
        }
        return {
          profile: text('[data-testid="account-consume-profile"]'),
          accountId: text('[data-testid="account-consume-id"]'),
          bindEmail: text('[data-testid="account-consume-bind-email"]'),
          loginMethod: text('[data-testid="account-consume-login-method"]'),
          signOut: document.querySelectorAll('[data-testid="account-consume-signout"]').length,
          hasSignedOutNotice: document.querySelector('[data-testid="account-optional-notice"]') !== null,
          tokenOnScreen: (document.body.innerText ?? '').includes('shot-mobile-access-token'),
        }
      })
      record('accountSignedIn', { ...signedInAccount, ...(await requireNoOverflow('账号（已登录）')) })
      // 资料头显示的是**服务端脱敏后的**邮箱（`d•••@example.com`）：只断言它确实落在资料头里，
      // 不去要求明文（明文邮箱上屏本身就是 #484 §七 要避免的）
      if (!String(signedInAccount.profile ?? '').includes('@example.com')) {
        throw new Error(`已登录态资料头没有邮箱：${String(signedInAccount.profile)}`)
      }
      if (signedInAccount.tokenOnScreen) {
        throw new Error('JWT 字面量出现在界面文本上（#484 §七 第 4 条）')
      }
      await shot('08-account-signed-in')

      /**
       * ── ⑨ 历史消费（**已登录 + 有数据**）─────────────────────────────────
       *
       * 为什么必须单独一张：⑤ 那张拍在登录之前，空态是 `HistoryView` 的既定行为（不发请求），
       * 于是 #727 验收里「历史消费」这一项**只被空态覆盖过** —— 真实扣费记录怎么排版、
       * 日期怎么分组、金额带不带负号，一次都没进过仓库。这里在 ⑦ 恢复完登录态之后
       * 再点一次「历史消费」，`/api/v1/usage` 的打桩这时才真的命中（见上面 `signedIn` 开关）。
       */
      await page.getByTestId('account-consume-history').click()
      const historyRows = page.locator('[data-testid="account-consume-history-row"]')
      await historyRows.first().waitFor({ state: 'visible', timeout: 15000 })
      await historyRows.first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      const historyData = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="account-consume-page"]')
        /**
         * 记录列表容器按 **`account-consume-history-list`** 取（#763 把重名拆开了）。
         * 以前 `account-consume-history` 在页面上有**两份**（钱包里那个「历史消费」行按钮 +
         * `HistoryView` 的根节点），`querySelector` 会拿到行按钮（它里面没有记录行），
         * 于是这里曾按「里面真的有记录行」挑那一份。现在按钮与列表各有一个名字，直接取即可；
         * `testIdNodes` 仍然统计按钮那个名字的节点数 —— 重名回归时会变成 2，能被看出来。
         */
        const historyNodes = Array.from(document.querySelectorAll('[data-testid="account-consume-history"]'))
        const container = document.querySelector('[data-testid="account-consume-history-list"]')
        const rows = Array.from(document.querySelectorAll('[data-testid="account-consume-history-row"]')).map((node) =>
          (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
        )
        const containerText = container === null ? '' : (container.innerText ?? '')
        return {
          rows,
          containerFound: container !== null,
          testIdNodes: historyNodes.length,
          // 日期分组的小标题（`.ghead` = `yyyy-mm-dd`）：按日期原文取，
          // 不认 CSS module 哈希后的类名（类名带 hash，类名后缀不是契约）
          groups: containerText.match(/\d{4}-\d{2}-\d{2}/gu) ?? [],
          // 金额一律带负号（原型 `−¥0.12`），且是 `formatCurrency` 那一份口径
          negativeAmounts: rows.filter((text) => text.includes('−¥')).length,
          emptyState: document.querySelector('[data-testid="account-consume-history-empty"]') !== null,
          text: body === null ? null : (body.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400),
        }
      })
      record('historySignedIn', { ...historyData, ...(await requireNoOverflow('历史消费（已登录·有数据）')) })
      if (historyData.rows.length < 2) {
        throw new Error(`已登录的历史消费应有扣费记录（打桩给了 2 条），实际 ${historyData.rows.length} 条`)
      }
      if (historyData.groups.length < 2) {
        throw new Error(`历史消费应按日期分组（两条记录跨两天）：实际分组 ${JSON.stringify(historyData.groups)}`)
      }
      if (historyData.negativeAmounts !== historyData.rows.length) {
        throw new Error(`每条扣费都要带负号：${JSON.stringify(historyData.rows)}`)
      }
      if (historyData.emptyState) {
        throw new Error('已登录且打桩命中时仍显示空态')
      }
      // 松开焦点再截：点过的那一行会留一圈 `:focus-visible` 蓝框（行为是对的，但不是这一格要说明的事）
      await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          active.blur()
        }
      })
      await page.waitForTimeout(160)
      await shot('09-history-signed-in')

      // 顶层标量：`metrics.json` 里直接能读到 `overflowCount`（#727 的硬指标，两档都必须是 0）
      record('overflowCount', Math.max(...overflowSeen.map((item) => item.overflowCount)))
      record('overflow', {
        overflowCount: Math.max(...overflowSeen.map((item) => item.overflowCount)),
        assertion: 'overflowCount === 0（390 / 360 两档，每个状态各量一次）',
        states: overflowSeen,
      })
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

  // ------------------------------------------------ #480 文档附件（390 / 360 两档）

  '480-attach-entry': {
    dir: 'docs/ui/480-attachments',
    title: '#480 输入区文档入口：anthropic / openai / ours 三渠道可用，DeepSeek 禁用并给出原因（toast）',
    sessions: () => [makeReadingSession()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      /**
       * 换渠道走**设置页里那个「渠道」选择器**（真实用户路径）。
       *
       * 为什么不直接改 localStorage 再 reload：`addInitScript` 每次导航都会把
       * `chat-demo:provider-kind` 重置成本场景的默认渠道（`def.providerKind`），reload 之后就白改了；
       * 而 store 的初值在模块加载时读进内存，不 reload 又读不到。走 UI 避开这两条，还顺带证明了
       * 「切渠道 → 入口开关跟着变」是真的接线了（#538 的 UI 门）。
       */
      const switchChannel = async (optionLabel) => {
        // 「渠道」选择器在设置页第二格（服务配置那块），不是「通用设置」
        await openSettings(page, S.tabData)
        const trigger = page.getByRole('button', { name: '渠道', exact: true })
        await trigger.click()
        const listbox = page.getByRole('listbox', { name: '渠道' })
        await listbox.waitFor({ state: 'visible', timeout: 5000 })
        await listbox.getByRole('option', { name: optionLabel, exact: true }).click()
        await page.waitForTimeout(320)
        await closeDialog(page)
        // 设置是从抽屉里进去的：关掉设置还得把抽屉收起来，否则输入区被遮罩盖着，
        // 截出来的是「侧栏」而不是「附件入口」
        await closeSider(page, ctx.size)
        await page.waitForTimeout(320)
      }

      // ①②③ 三个走「文本注入」的渠道：入口渲染成可选，且背后挂着隐藏的文档 file input
      const enabled = [
        ['Anthropic 协议', 'anthropic'],
        ['OpenAI 兼容', 'openai'],
        ['我们的渠道', 'ours'],
      ]
      for (const [index, [optionLabel, kind]] of enabled.entries()) {
        await switchChannel(optionLabel)
        const state = await page.evaluate(measureDocEntry, ATTACH_LABELS)
        record(`entry-${kind}`, state)
        if (state.enabled !== true) {
          throw new Error(`${kind} 渠道（${optionLabel}）的文档入口没有渲染出来（该渠道 acceptsDocuments 为真）`)
        }
        if (state.docInputs !== 1) {
          throw new Error(`${kind} 渠道没有挂上文档 file input（accept="${ATTACH_DOC_ACCEPT}" 找不到）`)
        }
        await shot(`0${index + 1}-doc-entry-${kind}-enabled`)
      }

      // ④ DeepSeek：入口是既有禁用态，点下去必须给一句**带原因**的提示
      await switchChannel('DeepSeek 官方')
      const disabled = await page.evaluate(measureDocEntry, ATTACH_LABELS)
      record('entry-deepseek', disabled)
      if (disabled.enabled !== false || disabled.disabled !== true) {
        throw new Error('DeepSeek 渠道的文档入口没有渲染成禁用态（#538 的入口门没生效）')
      }
      if (disabled.docInputs !== 0) {
        throw new Error('DeepSeek 渠道仍然挂着文档 file input：入口藏了但别的路还能塞进来')
      }
      await shot('04-doc-entry-deepseek-disabled')
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button[aria-label]')).find((node) =>
          /当前渠道不支持文档附件/u.test(node.getAttribute('aria-label') ?? '')
        )
        if (button !== undefined) {
          button.click()
        }
      })
      await page.waitForFunction(() => document.querySelector('[role="status"]') !== null, undefined, {
        timeout: 6000,
      })
      const toast = await page.evaluate(readToast)
      record('deepseekReasonToast', toast)
      if (toast === null || !toast.includes('不支持文档附件')) {
        warn(`DeepSeek 禁用入口点下去没给出原因：${String(toast)}`)
      }
      await shot('05-doc-entry-deepseek-reason-toast')
    },
  },

  '480-attach-parsing': {
    dir: 'docs/ui/480-attachments',
    title: '#480 附件卡片 parsing 态：逐页进度条 + 取消按钮，取消后落「已取消」（480 页真 PDF）',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)
      const started = Date.now()
      await attachDocInput(page).setInputFiles({
        name: '480-长文档-480页.pdf',
        mimeType: 'application/pdf',
        buffer: makeSlowPdf(),
      })
      // 等到进度真的在动（≥ 2%）：0% 那一帧证明不了「进度在走」
      await page.waitForFunction(
        () => {
          const card = Array.from(document.querySelectorAll('[role="button"][aria-label]')).find(
            (node) => node.getAttribute('aria-label') === '查看附件详情'
          )
          const statusLine = Array.from(card === undefined ? [] : card.querySelectorAll('div'))
            .map((node) => (node.textContent ?? '').trim())
            .find((line) => line.startsWith('解析中'))
          const percent = /解析中 (\d+)%/u.exec(statusLine ?? '')
          return percent !== null && Number(percent[1]) >= 2
        },
        undefined,
        { timeout: 30000 }
      )
      const parsing = await page.evaluate(measureAttachmentCards)
      record('parsing', parsing)
      record('parsingAfterMs', Date.now() - started)
      const card = parsing.cards[0]
      if (card === undefined) {
        throw new Error('没等到附件卡片')
      }
      if (card.progress === null) {
        throw new Error('解析中却没有进度条（progress 元素没渲染）')
      }
      if (!card.actions.includes(ATTACH_LABELS.cancelParse)) {
        throw new Error(`解析中的卡片没有「取消解析」按钮：${JSON.stringify(card.actions)}`)
      }
      await shot('01-card-parsing-progress')

      // 取消 → 视图立刻转「已取消」（中性色，不给红）：证明取消按钮真的接上了 abort
      await page.getByRole('button', { name: ATTACH_LABELS.cancelParse }).first().click()
      await page.waitForTimeout(700)
      const cancelled = await page.evaluate(measureAttachmentCards)
      record('cancelled', cancelled)
      if (cancelled.cards[0]?.status !== ATTACH_LABELS.statusCancelled) {
        warn(`点了取消，卡片状态却是「${cancelled.cards[0]?.status}」`)
      }
      await shot('02-card-cancelled')
    },
  },

  '480-attach-partial': {
    dir: 'docs/ui/480-attachments',
    title: '#480 附件卡片 partial 态：黄色警告角标 + 点开详情看 warnings（真 PDF 第 2 页内容流损坏）',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)
      await attachDocInput(page).setInputFiles({
        name: '480-部分页提取失败.pdf',
        mimeType: 'application/pdf',
        buffer: makePartialPdf(),
      })
      await waitForAttachSettled(page)
      const settled = await page.evaluate(measureAttachmentCards)
      record('partial', settled)
      const card = settled.cards[0]
      if (card === undefined) {
        throw new Error('没等到附件卡片')
      }
      if (!card.status.startsWith('部分内容已就绪')) {
        throw new Error(`期望 partial（部分内容已就绪），实际「${card.status}」`)
      }
      if (card.corner === null) {
        throw new Error('partial 态的卡片没有黄色警告角标')
      }
      await shot('01-card-partial-warn-corner')

      // 点卡片 → 详情面板：warnings 列表（解析器原文）+ 页数元信息
      await openAttachPanel(page)
      const opened = await page.evaluate(measureAttachmentCards)
      const panel = opened.panels[0]
      record('panel', panel)
      if (panel === undefined) {
        throw new Error('点卡片没有弹出详情面板')
      }
      if (!panel.warnings.some((warning) => warning.includes('第 2 页提取失败'))) {
        warn(`详情面板的 warnings 没点名失败页：${JSON.stringify(panel.warnings)}`)
      }
      if (!panel.meta.includes('第 2/3 页')) {
        warn(`详情面板没显示页数元信息：${panel.meta}`)
      }
      if (panel.box.insideViewport !== true) {
        warn(`详情面板超出视口：right=${panel.box.right}（视口宽 ${opened.viewportWidth}）`)
      }
      await shot('02-panel-warnings')
    },
  },

  '480-attach-failed': {
    dir: 'docs/ui/480-attachments',
    title: '#480 附件卡片 failed 态：红色卡片 + 失败原因 + 重新解析（扩展名骗人的 PDF）',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)
      await attachDocInput(page).setInputFiles({
        name: '480-伪装成PDF的文本.pdf',
        mimeType: 'application/pdf',
        // 扩展名骗人的「PDF」：没有 `%PDF-` 文件头 → PdfParseError('notPdfFile') → 卡片落 failed。
        // 不用仓库里的夹具文件：`tests/fixtures/480/` 属于 #545 的验收用例集（PR #545，未并入集成分支），
        // 截图脚本不该依赖它的存在，所以这里现造同一份「假 PDF」字节。
        buffer: Buffer.from('this file is plain text renamed to .pdf, no PD F header here\n', 'utf8'),
      })
      await waitForAttachSettled(page)
      const failed = await page.evaluate(measureAttachmentCards)
      record('failed', failed)
      const card = failed.cards[0]
      if (card === undefined) {
        throw new Error('没等到附件卡片')
      }
      if (card.status !== ATTACH_LABELS.statusFailed) {
        warn(`期望「${ATTACH_LABELS.statusFailed}」，实际「${card.status}」`)
      }
      await shot('01-card-failed')

      // 详情面板：失败原因（人话）+ 技术信息原文 + 「重新解析」
      await openAttachPanel(page)
      const opened = await page.evaluate(measureAttachmentCards)
      const panel = opened.panels[0]
      record('panel', panel)
      if (panel === undefined) {
        throw new Error('点卡片没有弹出详情面板')
      }
      if (panel.raw.length === 0) {
        warn('失败面板没有给技术信息原文：排查时唯一的线索缺了')
      }
      if (!panel.actions.includes(ATTACH_LABELS.retryParse)) {
        warn(`失败面板没有「重新解析」按钮：${JSON.stringify(panel.actions)}`)
      }
      await shot('02-panel-failure-and-retry')

      // 点「重新解析」：真的又跑了一遍（同一份坏文件 → 仍旧失败），证明按钮不是摆设
      const retry = page.getByRole('button', { name: ATTACH_LABELS.retryParse }).first()
      if ((await retry.count()) > 0) {
        await retry.click()
        await waitForAttachSettled(page)
        const again = await page.evaluate(measureAttachmentCards)
        record('afterRetry', { status: again.cards[0]?.status, cardCount: again.cardCount })
        await shot('03-after-retry')
      }
    },
  },

  '480-attach-failure-copy': {
    dir: 'docs/ui/480-attachments',
    // #574：失败面板**按码给文案**。这两张图就是「不再落「未知问题」」的视觉证据：
    // 标题是那句人话（带出路），真正的原因原文进「技术信息」折叠区。
    title: '#480/#574 失败原因按码出文案：扫描版 PDF（noTextLayer）与页数超限（tooManyPages）',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)

      /**
       * 一档两张：先传扫描件（无文本层），再传 800 页（超上限），各点开面板截一张。
       *
       * 判据是**面板标题的整句**（不是「含某个词」）：本单的回归就是「标题错了但原因还看得见」，
       * 只查 `raw` 里有没有那句话是查不出这个缺口的（缺口正是 raw 有、标题错）。
       */
      const cases = [
        {
          state: '01-panel-no-text-layer',
          name: '480-扫描件-无文本层.pdf',
          buffer: makeTextlessPdf(),
          expected: '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF，请上传包含文本层的 PDF 文件',
          rawMustInclude: '未检测到可提取的文本',
          code: 'noTextLayer',
          index: 0,
        },
        {
          state: '02-panel-too-many-pages',
          name: `480-超页数-${TOO_MANY_PAGES}页.pdf`,
          buffer: makeTooManyPagesPdf(),
          expected: `PDF 共 ${TOO_MANY_PAGES} 页，超过上限 500 页，请拆分后再上传`,
          rawMustInclude: '页上限',
          code: 'tooManyPages',
          index: 1,
        },
      ]

      for (const item of cases) {
        await attachDocInput(page).setInputFiles({
          name: item.name,
          mimeType: 'application/pdf',
          buffer: item.buffer,
        })
        // 先等这一张真的挂到列表上（索引 = 第几张），再等它落终态
        await waitForAttachCardCount(page, item.index + 1)
        await waitForAttachSettled(page)
        const settled = await page.evaluate(measureAttachmentCards)
        record(`${item.code}-cards`, settled.cards)
        const card = settled.cards[item.index]
        if (card === undefined) {
          throw new Error(`${item.code}：没等到第 ${item.index + 1} 张附件卡片`)
        }
        if (card.status !== ATTACH_LABELS.statusFailed) {
          throw new Error(`${item.code}：期望「${ATTACH_LABELS.statusFailed}」，实际「${card.status}」`)
        }

        // 点开这一张的详情面板（`openAttachPanel` 只点第一张，这里按序号点）
        await page
          .locator('[role="button"][aria-label="查看附件详情"]')
          .nth(item.index)
          .click()
        await page
          .getByRole('dialog', { name: '查看附件详情' })
          .waitFor({ state: 'visible', timeout: 8000 })
        await page.waitForTimeout(260)
        const opened = await page.evaluate(measureAttachmentCards)
        const panel = opened.panels[0]
        record(`${item.code}-panel`, panel)
        if (panel === undefined) {
          throw new Error(`${item.code}：点卡片没有弹出详情面板`)
        }
        // 【本单的核心断言】标题必须是那句人话，不能是兜底
        if (panel.failureTitle !== item.expected) {
          throw new Error(
            `${item.code}：失败标题不对 —— 期望「${item.expected}」，实际「${panel.failureTitle}」` +
              '（回落成「未知问题」就是 #574 的缺口复发了）'
          )
        }
        if (panel.failureTitle.includes(ATTACH_LABELS.failureUnknown)) {
          throw new Error(`${item.code}：失败标题落到了「${ATTACH_LABELS.failureUnknown}」兜底`)
        }
        if (!panel.raw.includes(item.rawMustInclude)) {
          warn(`${item.code}：「技术信息」里没有解析器原文（排障依据丢了）：${panel.raw}`)
        }
        if (panel.box.insideViewport !== true) {
          warn(`${item.code}：详情面板超出视口 right=${panel.box.right}（视口宽 ${opened.viewportWidth}）`)
        }
        await shot(item.state)

        // 收起面板，避免下一轮的点击被浮层挡住
        await page.keyboard.press('Escape')
        await page.getByRole('dialog', { name: '查看附件详情' }).waitFor({ state: 'hidden', timeout: 5000 })
        await page.waitForTimeout(160)
      }
    },
  },

  '480-attach-in-message': {
    dir: 'docs/ui/480-attachments',
    title: '#480 用户消息里的附件卡片：只有元信息（文件名 / 大小 / 状态），正文只在请求体里',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, READING_SESSION_TITLE)
      // 拦 ours 上游：把**真实请求体**留下来，用来对照「正文进了请求、没进消息」
      let requestBody = null
      await page.route(`**${OURS_CHAT_PATH}`, async (route) => {
        const request = route.request()
        if (request.method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: OURS_CORS })
          return
        }
        requestBody = request.postData()
        await route.fulfill({
          status: 200,
          headers: { ...OURS_CORS, 'content-type': 'text/event-stream' },
          body: openAiSse('收到这份文档了，正文我读到了。'),
        })
      })

      await attachDocInput(page).setInputFiles({
        name: '480-会议纪要.txt',
        mimeType: 'text/plain',
        buffer: makeMessageDocTxt(),
      })
      await waitForAttachSettled(page)
      const draft = await page.evaluate(measureAttachmentCards)
      record('draft', draft)
      if (draft.cards[0]?.status !== ATTACH_LABELS.statusSuccess) {
        warn(`草稿卡片状态不是「${ATTACH_LABELS.statusSuccess}」：${draft.cards[0]?.status}`)
      }
      await shot('01-draft-card-ready')

      const textarea = page.locator('textarea').last()
      await textarea.click()
      await textarea.fill('这份文档你看到了吗？')
      await page.getByRole('button', { name: /^发送$|^Send$/u }).first().click()
      await page.getByText('收到这份文档了，正文我读到了。').first().waitFor({ timeout: 15000 })
      await page.waitForTimeout(400)

      const message = await page.evaluate(measureAttachmentCards)
      record('message', message)
      const visibleText = await page.evaluate(readVisibleText)
      record('messageCard', {
        cards: message.cards.map((item) => ({
          variant: item.variant,
          name: item.name,
          subCaption: item.subCaption,
          status: item.status,
        })),
        bodyHasDocumentText: visibleText.includes(DOC_ONLY_MARKER),
      })
      if (message.cards.length === 0) {
        throw new Error('消息里没有渲染附件卡片')
      }
      if (message.cards.some((item) => item.variant !== 'message')) {
        warn('消息里的附件卡片没有走 message 变体')
      }
      if (visibleText.includes(DOC_ONLY_MARKER)) {
        throw new Error('文档正文漏到界面上了（§3.5 只允许元信息）')
      }
      record('requestBody', {
        captured: requestBody !== null,
        chars: requestBody === null ? 0 : requestBody.length,
        hasDocumentText: requestBody !== null && requestBody.includes(DOC_ONLY_MARKER),
      })
      if (requestBody === null) {
        warn('没能抓到请求体：注入是否真的发生无法对照')
      } else if (!requestBody.includes(DOC_ONLY_MARKER)) {
        warn('请求体里没有文档正文：注入没生效（或标记被转义）')
      }

      await shot('02-message-attachment-card')

      // 消息里的卡片点开：还是只有元信息（页数 / 字符数 / 警告条数），没有正文
      await openAttachPanel(page)
      const opened = await page.evaluate(measureAttachmentCards)
      record('messagePanel', opened.panels[0])
      const panelText = await page.evaluate(readVisibleText)
      if (panelText.includes(DOC_ONLY_MARKER)) {
        throw new Error('详情面板里出现了文档正文')
      }
      await shot('03-message-panel-metadata')
    },
  },

  /**
   * #608 拆掉登录墙的三份验收证据 —— 为什么必须新拍，而不是复用 #487 的旧图：
   * 拆墙**之前**「未登录」只有一种界面（整屏登录页），所以「未登录进 App 能直接看到主界面」
   * 这件事没有任何历史截图能证明；而「账号」tab 在未登录 / 已登录下的差别（引导态 vs 数据态）
   * 正是这次改动的落点，两态都得留证据。
   *
   * 已登录那张**不是摆拍**：先往 localStorage 写一份真实格式的落盘凭据
   * （`chat-demo:auth-token` = `{v:1,token,user}`，见 `services/auth/store.ts`）再整页 reload，
   * 让 `main.tsx` 的后台 `restoreAuth()` 真的走一遍（`/auth/me` + `/user/profile` + `/keys` +
   * `/user/aff` 全由本页打桩）。登录态的唯一真值来源仍是 `useAuthStore`，没有第二条旁路。
   *
   * 未登录那张的反向证据同样重要：sub2api 一律回 **401**（真实口径），首屏照样进得去 ——
   * 这正是「登录墙没了」与「接口挡着」两件事互不干扰的证明。
   */
  '487-account-optional': {
    dir: 'docs/ui/487-account-optional',
    title:
      '#608 拆掉登录墙：未登录直接进主界面（无登录墙）/ 账号 tab 的未登录引导 + 可选登录卡 / 已登录态（390 与 360 两档）',
    sessions: () => [makeReadingSession()],
    providerKind: 'ours',
    // 打开这一页默认落在「我的卡密」，它会拉 apia 的订单（fetch 通道）：按真契约形状回一条，
    // 免得本页 console 里全是跨域报错、把真正的失败盖住（卡密内容不是本单要看的东西）。
    mockPurchases: {
      totalPaidYuan: 0,
      orders: [
        {
          out_trade_no: 'CP202611200000608',
          plan_id: 'standard',
          plan_name: '标准包 500万 token',
          plan_points: 3900,
          amount_yuan: 39,
          status: 'FULFILLED',
          status_text: '已完成',
          card_no: 'MUSE-6080-0000-0000-0001',
          card_status: 'leased',
          redeem_state: 'issued',
          created_at: 1795055400,
          paid_at: 1795055460,
        },
      ],
    },
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      const reply = (body, status = 200) => ({
        status,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      })
      /**
       * 横向溢出：`overflowCount` 是本单的硬指标（390 / 360 两档都必须是 **0**，见 #106 的口径）。
       * 量的是文档范围（设置弹层与「账户与消费」页都在里面），每次 `record` 都带上这个数，
       * `metrics.json` 的顶层 `overflowCount` 会取所有记录里的最大值 —— 也就是「这一档最坏的那一屏」。
       */
      const measureOverflow = () =>
        page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth
          const overflow = []
          for (const element of document.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.right > viewportWidth + 1) {
              overflow.push({ tag: element.tagName, right: Math.round(rect.right), text: (element.textContent ?? '').slice(0, 24) })
            }
          }
          return {
            viewportWidth,
            documentScrollWidth: Math.round(document.documentElement.scrollWidth),
            overflowCount: overflow.length,
            overflowSamples: overflow.slice(0, 5),
          }
        })
      /** 每次量到的溢出都记在这里：结尾汇总成 `metrics.json` 顶层的 `overflowCount` */
      const overflowSeen = []
      /** 溢出必须是 0：这一条不许只 warn（`warn` 不进 CI 判定，等于没断言） */
      const requireNoOverflow = async (label) => {
        const measured = await measureOverflow()
        overflowSeen.push({ label, overflowCount: measured.overflowCount })
        if (measured.overflowCount !== 0) {
          throw new Error(`${label} 出现横向溢出 ${measured.overflowCount} 处：${JSON.stringify(measured.overflowSamples)}`)
        }
        return measured
      }
      /** 消费层统一信封 `{code:0,message:'success',data}`（`services/consume/http.ts` 只认这个形状） */
      const envelope = (data) => reply({ code: 0, message: 'success', data })

      // 先「未登录」，拍完前两张再翻成「已登录」并 reload —— 一个路由处理器管两种态，
      // 比注册两套 route 更接近真实：同一台机器上登录态翻了，接口才开始给数据。
      let signedIn = false
      await page.route(`${consumeBaseUrl}${consumeApiV1Prefix}/**`, async (route) => {
        // 带 `Authorization` 的跨域请求会先发预检：预检必须自己回，否则真实请求根本发不出去
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-headers': 'authorization,accept,content-type,x-session-id',
              'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
              'access-control-max-age': '600',
            },
          })
          return
        }
        const { pathname } = new URL(route.request().url())
        // 开关是**公开**接口（`auth: null`）：未登录也必须读得到，注册入口的显隐全靠它
        if (pathname.endsWith('/settings/public')) {
          await route.fulfill(
            envelope({ registration_enabled: true, email_verify_enabled: false, invitation_code_enabled: true })
          )
          return
        }
        if (!signedIn) {
          await route.fulfill(reply({ code: 401, message: 'unauthorized' }, 401))
          return
        }
        if (pathname.endsWith('/auth/me') || pathname.endsWith('/user/profile')) {
          await route.fulfill(envelope(SHOT_ACCOUNT_USER))
          return
        }
        if (pathname.endsWith('/keys')) {
          await route.fulfill(
            envelope({
              items: [
                { id: 11, name: '主力 Key', key: 'sk-shot-mobile-fixture-0000', status: 'active', quota: 5000000, quota_used: 1250000, created_at: '2026-11-01T10:00:00+08:00' },
                { id: 12, name: '备用 Key', key: 'sk-shot-mobile-fixture-1111', status: 'inactive', quota: 1000000, quota_used: 0, created_at: '2026-11-12T10:00:00+08:00' },
              ],
              total: 2,
              page: 1,
              page_size: 20,
              pages: 1,
            })
          )
          return
        }
        if (pathname.endsWith('/user/aff')) {
          await route.fulfill(
            envelope({ aff_code: 'SHOT608', aff_count: 3, aff_quota: 12.5, aff_frozen_quota: 0, aff_history_quota: 12.5 })
          )
          return
        }
        // 其余（额度 / 卡密 / 订单）这一页不看，给空信封即可，别让 401 把面板画成错误态
        await route.fulfill(envelope({}))
      })

      // ── ① 未登录冷启动：主界面必须在，登录墙必须不在 ───────────────────────
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(500)
      const boot = await page.evaluate(() => {
        const text = (document.body.innerText ?? '').replace(/\s+/gu, ' ')
        return {
          hasComposer: document.querySelector('textarea') !== null,
          // 登录墙的判据：整屏表单会带一个密码框；没有它才叫「拆掉了」
          passwordFields: document.querySelectorAll('input[type="password"]').length,
          hasAuthCard: document.querySelector('[data-testid="account-auth-card"]') !== null,
          hasSiderEntry: Array.from(document.querySelectorAll('button')).some((button) =>
            ['打开边栏', '设置'].includes((button.textContent ?? '').trim())
          ),
          head: text.slice(0, 160),
        }
      })
      record('signedOutBoot', { ...boot, ...(await requireNoOverflow('首屏（未登录）')) })
      if (!boot.hasComposer) {
        throw new Error('未登录冷启动没有输入框：登录墙没拆干净（首屏进不了主界面）')
      }
      if (boot.passwordFields > 0) {
        throw new Error('未登录冷启动出现了密码输入框：首屏仍被登录页挡着')
      }
      await shot('01-signed-out-boot-main-ui')

      // ── ② 设置 → 数据管理 → 账户与消费 → 「账号」tab（未登录态）────────────
      const openAccountTab = async () => {
        await openSettings(page, S.tabData)
        const entry = page.locator(S.accountConsumeOpen)
        await entry.waitFor({ state: 'visible', timeout: 10000 })
        await entry.scrollIntoViewIfNeeded()
        await page.waitForTimeout(240)
        await entry.click()
        await page.locator('[data-testid="account-consume-page"]').waitFor({ state: 'visible', timeout: 10000 })
        await page.getByTestId('account-consume-tab-account').click()
        await page.waitForTimeout(700)
      }

      await openAccountTab()
      const signedOut = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector)
          return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
        }
        const body = document.querySelector('[data-testid="account-consume-page"]')
        const dialog = body === null ? null : body.closest('[role="dialog"]')
        const card = document.querySelector('[data-testid="account-auth-card"]')
        return {
          notice: read('[data-testid="account-optional-notice"]'),
          signedOutState: read('[data-testid="account-signed-out-state"]'),
          keep: read('[data-testid="account-optional-keep"]'),
          // 局部登录卡的判据：卡在、且**表单真的渲染出来了**（有密码框）
          hasInlineAuthCard: card !== null,
          inlineCardHasPassword: card === null ? false : card.querySelector('input[type="password"]') !== null,
          // 未登录时不该有「已登录」才有的东西
          hasLoggedInStatus: document.querySelector('[data-testid="account-optional-status"]') !== null,
          dialogWidth: dialog === null ? null : Math.round(dialog.getBoundingClientRect().width),
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }
      })
      record('signedOutAccountTab', { ...signedOut, ...(await requireNoOverflow('账号 tab（未登录）')) })
      if (signedOut.notice === null || !signedOut.notice.includes('不登录也可以')) {
        throw new Error(`未登录态顶部没有「不登录也可以」那句：${String(signedOut.notice)}`)
      }
      if (!signedOut.inlineCardHasPassword) {
        throw new Error('未登录态的局部登录卡没渲染出表单（密码框缺失）')
      }
      if (signedOut.hasLoggedInStatus) {
        throw new Error('未登录却显示了「已登录」状态行')
      }
      if (signedOut.scrollWidth > signedOut.viewport) {
        warn(`未登录态出现横向滚动：scrollWidth=${signedOut.scrollWidth} > viewport=${signedOut.viewport}`)
      }
      await shot('02-signed-out-account-tab')

      // 局部登录卡拉到视口中央再拍一张：它是这次改动的核心（登录从「墙」变成「可选的一块」）
      await page.locator('[data-testid="account-auth-card"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(320)
      const inline = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="account-auth-card"]')
        const dialog = card === null ? null : card.closest('[role="dialog"]')
        const cardRect = card === null ? null : card.getBoundingClientRect()
        const dialogRect = dialog === null ? null : dialog.getBoundingClientRect()
        return {
          cardWidth: cardRect === null ? null : Math.round(cardRect.width),
          dialogWidth: dialogRect === null ? null : Math.round(dialogRect.width),
          // 局部形态**不许**占满一屏：卡高必须小于弹层可视高度（`min-height: 100vh` 会顶破这里）
          cardHeight: cardRect === null ? null : Math.round(cardRect.height),
          viewportHeight: document.documentElement.clientHeight,
        }
      })
      record('inlineLoginCard', { ...inline, ...(await requireNoOverflow('局部登录卡')) })
      if (inline.cardHeight !== null && inline.cardHeight >= inline.viewportHeight) {
        warn(`局部登录卡高度 ${inline.cardHeight} ≥ 视口高 ${inline.viewportHeight}：embedded 形态没生效`)
      }
      await shot('03-signed-out-inline-login-card')

      // ── ③ 钱包页首（未登录）：余额卡给「—」/「…」+ 付款入口在同一行 ────────────
      //    #817 之前这一拍截的是「我的额度」未登录引导态；那个面板已整页删除，
      //    现在断的是新页首（余额卡 + 付款入口），并顺手证明额度入口真的不在了。
      await page.getByTestId('account-consume-wallet').click()
      await page.locator('[data-testid="account-consume-wallet-head"]').waitFor({ state: 'visible', timeout: 10000 })
      await page.waitForTimeout(400)
      const walletHead = await page.evaluate(() => {
        const head = document.querySelector('[data-testid="account-consume-wallet-head"]')
        const card = document.querySelector('[data-testid="account-consume-balance"]')
        const pay = document.querySelector('[data-testid="account-consume-wallet-pay"]')
        return {
          headText: head === null ? null : (head.innerText ?? '').replace(/\s+/gu, ' ').trim(),
          // 入口与余额卡必须是**同一行**（y 轴中点差在 2px 内）
          sameRow:
            card !== null &&
            pay !== null &&
            Math.abs(
              card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2 -
                (pay.getBoundingClientRect().top + pay.getBoundingClientRect().height / 2)
            ) < 2,
          quotaEntries: document.querySelectorAll('[data-testid="account-consume-tab-quota"]').length,
        }
      })
      record('signedOutWalletHead', { ...walletHead, ...(await requireNoOverflow('钱包页首（未登录）')) })
      if (walletHead.headText === null || !walletHead.headText.includes('剩余余额')) {
        throw new Error(`钱包页首没有余额卡：${String(walletHead.headText)}`)
      }
      if (walletHead.sameRow !== true) {
        throw new Error('余额卡与付款入口不在同一行（#817 的版式契约）')
      }
      if (walletHead.quotaEntries !== 0) {
        throw new Error(`「我的额度」入口还在（#817 之后必须删掉），实际 ${walletHead.quotaEntries} 个`)
      }
      await shot('04-signed-out-wallet-head')

      // ── ④ 已登录态：写落盘凭据 → reload → 后台恢复真的跑一次 ────────────────
      signedIn = true
      await page.evaluate(
        ({ persisted }) => {
          localStorage.setItem('chat-demo:auth-token', persisted)
        },
        {
          persisted: JSON.stringify({
            v: 1,
            token: {
              accessToken: 'shot-mobile-access-token',
              tokenType: 'Bearer',
              // 远未来：不触发续期，让恢复只走 `me()` 这一条（截图不该依赖 refresh 的时序）
              expiresAt: Date.now() + 86_400_000,
            },
            user: { id: 2, email: 'demo@example.com', username: 'demo', role: 'user', emailVerified: true },
          }),
        }
      )
      /**
       * 原生桥桩（**只在这一步注入**，注释见模块顶部的 `nativeBridgeStub`）。
       *
       * 它不改产品行为：没有绕过登录（凭据是真格式的落盘值，`restoreAuth()` 真跑一遍），
       * 也没有给产物留旁路（这是截图脚本，不进 bundle）。**只在 ③ 之前**注入 ——
       * ①② 两张图仍是浏览器真实行为（未登录、不发请求），不为拍照去改被测物。
       */
      await page.addInitScript(nativeBridgeStub)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 15000 })
      await openAccountTab()
      await page.locator('[data-testid="account-optional-status"]').waitFor({ state: 'visible', timeout: 15000 })
      const signedInState = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector)
          return node === null ? null : (node.innerText ?? '').replace(/\s+/gu, ' ').trim()
        }
        return {
          status: read('[data-testid="account-optional-status"]'),
          profile: read('[data-testid="account-profile"]'),
          keyRows: document.querySelectorAll('[data-testid="account-key-row"]').length,
          hasSignedOutNotice: document.querySelector('[data-testid="account-optional-notice"]') !== null,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          // 凭据不许上屏（#484 §七 第 4 条）：整页文本里不能出现 token 字面量
          tokenOnScreen: (document.body.innerText ?? '').includes('shot-mobile-access-token'),
        }
      })
      record('signedInAccountTab', { ...signedInState, ...(await requireNoOverflow('账号 tab（已登录）')) })
      if (signedInState.status === null || !signedInState.status.includes('demo@example.com')) {
        throw new Error(`已登录态没有显示账号邮箱：${String(signedInState.status)}`)
      }
      if (signedInState.hasSignedOutNotice) {
        throw new Error('已登录却仍在显示未登录引导')
      }
      if (signedInState.tokenOnScreen) {
        throw new Error('JWT 字面量出现在界面文本上（#484 §七 第 4 条）')
      }
      await shot('05-signed-in-account-tab')

      // 收口：顶层 `overflowCount` = 这一档里所有状态的最大值（本单要求是 0）。
      // 逐状态已经在上面各自断言过；这里落一个总账，让人只看 metrics.json 也能核对「两档都是 0」。
      record('overflow', {
        overflowCount: Math.max(...overflowSeen.map((entry) => entry.overflowCount)),
        assertion: 'overflowCount === 0（390 / 360 两档，每个状态各量一次）',
        states: overflowSeen,
      })
    },
  },

  'katex-unsupported-821': {
    dir: 'docs/ui/821-katex-macros',
    title: '#821 KaTeX 不支持宏（美化包气泡）：按模块降级、可读原文、390/360 不横向溢出',
    sessions: () => [makeKatex821Session()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      // KaTeX 的「No character metrics」是 console.warn（不是 error），单收一份用来解释 ◖◗
      const warnings = []
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text())
      })
      await openSession(page, KATEX_821_SESSION_TITLE)
      // KaTeX 是懒加载的：等「出结果」——渲染成功 / 降级提示 / 或（改动前那种）原文段落
      await page
        .waitForFunction(
          () =>
            document.querySelector('.katex-mathml') !== null ||
            document.querySelector('.md-math-unsupported') !== null ||
            /\\[a-zA-Z]{3,}/u.test(document.body === null ? '' : document.body.innerText),
          undefined,
          { timeout: 20000 }
        )
        .catch(() => warn('20s 内没有任何结果：页面可能还停在 KaTeX 加载中'))
      await page.waitForTimeout(400)

      const probe = await page.evaluate(KATEX_821_PROBE)
      record('render', probe)
      record('katexWarnings', [...new Set(warnings)].slice(0, 5))
      await shot('01-full')
      const mathBox = await page.locator('.md-math-block, .ds-markdown').first().boundingBox()
      if (mathBox !== null) {
        await shot('02-bubble-closeup', {
          clip: {
            x: 0,
            y: Math.max(0, mathBox.y - 8),
            width: ctx.size.width,
            height: Math.min(mathBox.height + 16, ctx.size.height - 8),
          },
        })
      }
      // 「查看原文」开关：有降级块就能展开，展开后再截一张
      const toggle = page.locator('.md-math-unsupported-detail > summary').first()
      if ((await toggle.count()) > 0) {
        await toggle.click()
        await page.waitForTimeout(250)
        await shot('03-source-toggle-opened')
      }

      if (probe.overflowCount > 0) {
        throw new Error(
          `横向溢出 ${probe.overflowCount} 处（最宽多出 ${probe.worstOverflowPx}px）：${ctx.size.label}`
        )
      }
      if (probe.katexErrorBlocks > 0) {
        throw new Error(`出现 ${probe.katexErrorBlocks} 个 katex-error 红字错误块`)
      }
      if (probe.leakedCommands.length > 0 || probe.leakedSizes.length > 0) {
        throw new Error(
          `源码外露：气泡里露出 ${probe.leakedCommands.length} 个 TeX 命令、${probe.leakedSizes.length} 处尺寸残渣（${[...probe.leakedCommands, ...probe.leakedSizes].slice(0, 6).join(' ')}）`
        )
      }
      if (probe.katexSubtrees === 0) {
        throw new Error('一个 KaTeX 子树都没有：气泡完全没渲染出来')
      }
      if (probe.simplifiedNotes === 0) {
        throw new Error('丢过缩放/旋转却没有「部分排版命令已简化显示」提示')
      }
      // 第二段里有一个 KaTeX 真没有的命令（tikz 环境）：必须降级成可读提示 + 「查看原文」
      if (probe.unsupportedBlocks === 0) {
        throw new Error('整段不可渲染时没有降级成可读提示（应该出现「这一行用了不支持的排版命令」）')
      }
      if (probe.sourceToggles !== probe.unsupportedBlocks) {
        throw new Error(`降级块数量与「查看原文」开关对不上：${probe.unsupportedBlocks} vs ${probe.sourceToggles}`)
      }
    },
  },

  '486-markdown-render': {
    dir: 'docs/ui/486-markdown-render',
    title: '#486 P0：代码块行号 / 自动换行（持久化）、公式源码复制、表格复制 GFM、代码下载',
    sessions: () => [makeMarkdownSession()],
    run: async (ctx) => {
      const { page, shot, record, warn } = ctx
      await openSession(page, MARKDOWN_SESSION_TITLE)
      const codeBlock = page.locator('.md-code-block').first()
      await codeBlock.waitFor({ state: 'visible', timeout: 15000 })
      // KaTeX 是懒加载的：annotation 出现 = MathML 子树真的渲染完（复制公式就是从它取原文）
      // MathML 子树对肉眼是隐藏的（KaTeX 用 clip 藏起来），所以等 attached 而不是 visible
      await page.waitForSelector('.katex-mathml annotation[encoding="application/x-tex"]', {
        state: 'attached',
        timeout: 20000,
      })
      await page.waitForTimeout(300)

      /**
       * 横向溢出：`overflowCount` 是本车道的硬指标（390 / 360 两档都必须是 0）。
       * 每换一个状态量一次，只 `warn` 不算断言 —— 这里直接抛错。
       */
      let worstOverflow = 0
      const checkOverflow = async (label) => {
        const measured = await page.evaluate(() => {
          const width = document.documentElement.clientWidth
          /**
           * 口径：宽表 / 长代码行**故意**在自己的滚动容器里横向滚（`.markdown-table-wrapper`、
           * `.md-code-block > pre`），那部分溢出不撑破页面，不算「横向溢出」；
           * 只要有一个祖先能吃掉这个宽度（`overflow-x` 是 auto / scroll / overlay），就不记。
           * 这条口径能同时抓住「表格把页面撑宽」和「代码块把页面撑宽」—— 那时文档自己会滚。
           */
          const absorbedByScrollAncestor = (element) => {
            let node = element.parentElement
            while (node !== null) {
              if (/(auto|scroll|overlay)/u.test(getComputedStyle(node).overflowX)) {
                return true
              }
              node = node.parentElement
            }
            return false
          }
          const offenders = []
          for (const element of document.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.right > width + 1 && !absorbedByScrollAncestor(element)) {
              offenders.push(`${element.tagName}.${String(element.className).slice(0, 24)}`)
            }
          }
          return {
            viewportWidth: width,
            documentScrollWidth: Math.round(document.documentElement.scrollWidth),
            documentOverflow: document.documentElement.scrollWidth > width + 1,
            overflowCount: offenders.length,
            overflowSamples: offenders.slice(0, 4),
          }
        })
        record(`overflow-${label}`, measured)
        worstOverflow = Math.max(worstOverflow, measured.overflowCount)
        if (measured.overflowCount !== 0) {
          throw new Error(`${label} 出现横向溢出 ${measured.overflowCount} 处：${JSON.stringify(measured.overflowSamples)}`)
        }
        return measured
      }

      /**
       * 行号与源码列的几何关系（量数，不靠看图）：
       *   gutterGap  —— 行号右边缘到源码起点的像素空隙（小于 2px 就是「数字贴着代码」）
       *   wrappedLine —— 取第一条**折行**的代码行，量它的第二段（续行）左边缘与首段左边缘的差
       *                  （悬挂缩进生效时两者应当相等，误差 ≤1px）
       */
      const gutterGeometry = () =>
        codeBlock.evaluate((root) => {
          const lines = Array.from(root.querySelectorAll('.md-code-block-line'))
          if (lines.length === 0) {
            return { gutterGap: null, wrappedLine: null }
          }
          const rangeOf = (line, afterGutter) => {
            const range = document.createRange()
            range.selectNodeContents(line)
            if (afterGutter) {
              const gutter = line.querySelector('.md-code-block-lineno')
              if (gutter === null) return null
              range.setStartAfter(gutter)
            }
            return range
          }
          const first = lines[0]
          const firstRange = rangeOf(first, true)
          const firstRects = firstRange === null ? [] : Array.from(firstRange.getClientRects())
          // 量的是「数字字形」的右边缘（行号槽本身有 padding，槽的 box 右边缘看不出空隙）
          const numberRange = document.createRange()
          numberRange.selectNodeContents(first.querySelector('.md-code-block-lineno'))
          const numberRect = numberRange.getBoundingClientRect()
          const wrappedLine = (() => {
            for (const line of lines) {
              const range = rangeOf(line, true)
              const rects = range === null ? [] : Array.from(range.getClientRects())
              if (rects.length > 1) {
                return {
                  text: (line.textContent ?? '').slice(0, 12),
                  segments: rects.length,
                  firstLeft: Math.round(rects[0].left * 10) / 10,
                  continuationLeft: Math.round(rects[1].left * 10) / 10,
                  delta: Math.round((rects[1].left - rects[0].left) * 10) / 10,
                }
              }
            }
            return null
          })()
          return {
            gutterGap: firstRects.length === 0 ? null : Math.round((firstRects[0].left - numberRect.right) * 10) / 10,
            codeColumn: firstRects.length === 0 ? null : Math.round(firstRects[0].left * 10) / 10,
            wrappedLine,
          }
        })

      /** 代码块当前状态：行号个数 / 数字文案 / 换行计算样式 / 是否横向滚动 */
      const codeState = async () => ({
        ...(await codeBlock.evaluate((root) => {
          const pre = root.querySelector('pre')
          const lines = root.querySelectorAll('.md-code-block-lineno')
          const style = pre === null ? null : getComputedStyle(pre)
          return {
            lineNumbers: root.getAttribute('data-line-numbers'),
            wrap: root.getAttribute('data-wrap'),
            whiteSpace: style === null ? null : style.whiteSpace,
            gutterItems: lines.length,
            firstLineNo: lines.length === 0 ? null : lines[0].textContent,
            lastLineNo: lines.length === 0 ? null : lines[lines.length - 1].textContent,
            preScrollWidth: pre === null ? null : Math.round(pre.scrollWidth),
            preClientWidth: pre === null ? null : Math.round(pre.clientWidth),
            horizontalScroll: pre === null ? null : pre.scrollWidth > pre.clientWidth + 1,
          }
        })),
        ...(await gutterGeometry()),
      })

      const banner = codeBlock.locator('.md-code-block-banner')
      const lineNumbersButton = banner.getByRole('button', { name: '行号', exact: true })
      const wrapButton = banner.getByRole('button', { name: '换行', exact: true })

      // ① 默认态 = 改造前的现状：没有行号、长行折行（基线不许被这次改动改动）
      const initial = await codeState()
      record('codeDefault', initial)
      if (initial.lineNumbers !== 'false' || initial.gutterItems !== 0) {
        throw new Error(`默认态出现了行号：${JSON.stringify(initial)}`)
      }
      if (initial.whiteSpace !== 'pre-wrap') {
        warn(`默认换行不是 pre-wrap（${initial.whiteSpace}）：与改造前的 markdown.css 不一致`)
      }
      await shot('01-默认-无行号-折行')
      await checkOverflow('default')

      // ② 打开行号：每个逻辑行一个数字，行尾 token 不丢
      await lineNumbersButton.click()
      await page.waitForTimeout(220)
      const numbered = await codeState()
      record('codeLineNumbersOn', numbered)
      if (numbered.gutterItems !== MARKDOWN_CODE_LINES) {
        throw new Error(`行号数量 ${numbered.gutterItems} ≠ 代码行数 ${MARKDOWN_CODE_LINES}`)
      }
      if (numbered.firstLineNo !== '1' || numbered.lastLineNo !== String(MARKDOWN_CODE_LINES)) {
        throw new Error(`行号不是 1…${MARKDOWN_CODE_LINES}：${numbered.firstLineNo}…${numbered.lastLineNo}`)
      }
      await codeBlock.scrollIntoViewIfNeeded()
      await shot('02-行号开')
      await checkOverflow('line-numbers')

      // ③ 关掉换行：切成 white-space: pre，长行横向滚动（pre 内滚，不撑破页面）
      await wrapButton.click()
      await page.waitForTimeout(220)
      const noWrap = await codeState()
      record('codeWrapOff', noWrap)
      if (noWrap.whiteSpace !== 'pre') {
        throw new Error(`关掉换行后 white-space 不是 pre：${noWrap.whiteSpace}`)
      }
      if (noWrap.horizontalScroll !== true) {
        warn('关掉换行后长行没有出现横向滚动（样本行可能不够长）')
      }
      await shot('03-行号开-换行关-横向滚动')
      await checkOverflow('wrap-off')

      // ④ 刷新：两个开关必须还在（这就是「持久化」的证据，不靠读 localStorage 自证）
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(400)
      await openSession(page, MARKDOWN_SESSION_TITLE)
      await codeBlock.waitFor({ state: 'visible', timeout: 15000 })
      await page.waitForTimeout(300)
      const afterReload = await codeState()
      record('codeAfterReload', afterReload)
      if (afterReload.lineNumbers !== 'true') {
        throw new Error(`刷新后行号开关丢了：${JSON.stringify(afterReload)}`)
      }
      if (afterReload.wrap !== 'false') {
        throw new Error(`刷新后换行开关丢了：${JSON.stringify(afterReload)}`)
      }
      if (afterReload.gutterItems !== MARKDOWN_CODE_LINES) {
        throw new Error(`刷新后行号数量 ${afterReload.gutterItems} ≠ ${MARKDOWN_CODE_LINES}`)
      }
      await shot('04-刷新后开关仍生效')
      await checkOverflow('after-reload')

      // ⑤ 换行再打开：行号 + 折行同时开着，行号必须仍与逻辑行对齐
      await wrapButton.click()
      await page.waitForTimeout(220)
      const wrapped = await codeState()
      record('codeWrapOnWithLineNumbers', wrapped)
      if (wrapped.whiteSpace !== 'pre-wrap') {
        throw new Error(`换行打开后 white-space 不是 pre-wrap：${wrapped.whiteSpace}`)
      }
      if (wrapped.wrappedLine === null) {
        warn('样本里没有折行的代码行，续行对齐这条量数没取到（不影响行号本身）')
      } else if (Math.abs(wrapped.wrappedLine.delta) > 1) {
        throw new Error(
          `折行后的续行没有对齐源码列：首段 ${wrapped.wrappedLine.firstLeft} / 续行 ${wrapped.wrappedLine.continuationLeft}`
        )
      }
      if (wrapped.gutterGap !== null && wrapped.gutterGap < 2) {
        warn(`行号与源码之间只有 ${wrapped.gutterGap}px 空隙（数字贴着代码）`)
      }
      await shot('05-行号开-换行开')
      await checkOverflow('wrap-on')

      // ⑥ 表格一键复制为 GFM
      const tableBlock = page.locator('.md-table-block').first()
      await tableBlock.scrollIntoViewIfNeeded()
      const tableCopy = tableBlock.locator('.md-table-copy')
      const opacityHidden = await tableCopy.evaluate((el) => getComputedStyle(el).opacity)
      await tableBlock.hover()
      await page.waitForTimeout(260)
      const opacityShown = await tableCopy.evaluate((el) => getComputedStyle(el).opacity)
      record('tableCopyReveal', { opacityHidden, opacityShown })
      if (Number(opacityShown) <= Number(opacityHidden)) {
        warn(`表格复制按钮没有因为悬停显形：${opacityHidden} → ${opacityShown}`)
      }
      await shot('06-表格悬停出复制')
      await tableCopy.click()
      await page.waitForTimeout(280)
      const tableClipboard = await page.evaluate(() =>
        navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
      )
      record('tableClipboard', { text: tableClipboard })
      if (!String(tableClipboard).startsWith('| ') || !String(tableClipboard).includes('| :--- |')) {
        throw new Error(`表格复制出来不是标准 GFM：${JSON.stringify(tableClipboard)}`)
      }
      await shot('07-表格已复制')
      // 复制按钮点完会带焦点（现代内核里鼠标点击不给环，但 83 兜底是给的）：点完收掉，
      // 免得后面几张图里挂着一圈蓝色焦点环
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      })
      await page.mouse.move(4, 4)
      await page.waitForTimeout(200)

      // ⑦ 公式源码复制：从 katex-mathml 的 annotation 取纯 TeX（不带 $$），并给出行内公式的入口
      const mathBlock = page.locator('.md-math-block').first()
      await mathBlock.scrollIntoViewIfNeeded()
      await mathBlock.hover()
      await page.waitForTimeout(260)
      await shot('08-行间公式悬停出复制')
      await mathBlock.locator('.md-math-copy').click()
      await page.waitForTimeout(280)
      const mathClipboard = await page.evaluate(() =>
        navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
      )
      record('mathClipboard', { text: mathClipboard })
      if (/^\$/.test(String(mathClipboard))) {
        throw new Error(`公式复制带了 $ 定界符：${JSON.stringify(mathClipboard)}`)
      }
      if (!String(mathClipboard).includes('\\frac')) {
        warn(`公式复制的不是 TeX 原文：${JSON.stringify(mathClipboard)}`)
      }
      await shot('09-行间公式已复制')

      // 行内公式：矩形中心多半落在行盒的空白处（Playwright 的 hover 会判成被段落拦截），
      // 所以这里走**键盘路径**：聚焦按钮 → 父级 `:focus-within` 显形 → Enter 触发。
      // 顺带证明「按钮不是不可见的 Tab 停靠点」（它真的能聚焦、能显形、能按下去）。
      const inlineMath = page.locator('.md-math-inline').first()
      await inlineMath.scrollIntoViewIfNeeded()
      const inlineCopy = inlineMath.locator('.md-math-copy')
      const inlineOpacityBefore = await inlineCopy.evaluate((el) => getComputedStyle(el).opacity)
      await inlineCopy.focus()
      await page.waitForTimeout(260)
      const inlineOpacityFocused = await inlineCopy.evaluate((el) => getComputedStyle(el).opacity)
      record('inlineMathCopyReveal', {
        opacityHidden: inlineOpacityBefore,
        opacityFocused: inlineOpacityFocused,
      })
      if (Number(inlineOpacityFocused) <= Number(inlineOpacityBefore)) {
        warn(`行内公式复制按钮聚焦后没有显形：${inlineOpacityBefore} → ${inlineOpacityFocused}`)
      }
      await shot('10-行内公式复制入口-键盘聚焦')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(280)
      const inlineClipboard = await page.evaluate(() =>
        navigator.clipboard.readText().catch((error) => `读不到：${String(error)}`)
      )
      record('inlineMathClipboard', { text: inlineClipboard })
      if (!String(inlineClipboard).includes('c^2')) {
        warn(`行内公式复制的不是 TeX 原文：${JSON.stringify(inlineClipboard)}`)
      }
      await shot('11-行内公式已复制')

      // ⑧ 代码下载：Web 端走 savePlainText → saveTextFile 的 Blob 分支（与原生 ExportText 同一函数）
      const downloadButton = banner.getByRole('button', { name: '下载代码', exact: true })
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        downloadButton.click(),
      ])
      const savedPath = await download.path()
      const savedText = savedPath === null ? '' : await readFile(savedPath, 'utf8')
      record('codeDownload', {
        suggestedFilename: download.suggestedFilename(),
        bytes: savedText.length,
        firstLine: savedText.split('\n')[0],
        matchesCodeBlock: savedText === MARKDOWN_CODE,
      })
      if (download.suggestedFilename() !== 'snippet.py') {
        warn(`下载文件名不是按语言猜的 snippet.py：${download.suggestedFilename()}`)
      }
      if (savedText !== MARKDOWN_CODE) {
        throw new Error('下载的文件内容与代码块不一致')
      }
      await page.waitForTimeout(260)
      const downloadToast = await page
        .getByRole('status')
        .innerText()
        .catch(() => '')
      record('codeDownloadToast', { text: downloadToast.replace(/\s+/gu, ' ').trim() })
      await shot('12-代码已下载')

      record('overflowCount', worstOverflow)
      if (worstOverflow !== 0) {
        throw new Error(`横向溢出最大值 ${worstOverflow}，两档都必须是 0`)
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
      多个场景共用一个 --out 目录时：每个场景落 metrics-<场景>.json，另落一份汇总 metrics.json
注意：这是浏览器视口截图（设备模拟），不是真机截图。`)
}

const makeContext = ({ page, def, pageName, viewport, outDir, log, metricsName = 'metrics.json' }) => {
  const size = VIEWPORTS[viewport]
  const dir = shotDir(outDir, viewport)
  const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')
  const metrics = { page: pageName, title: def.title, viewport: Number(viewport), size: size.label, shots: [], notes: [] }
  return {
    page,
    metricsName,
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

  /**
   * 每个「场景 × 视口」都往 `<out>/<宽度>/metrics.json` 落一份；**多个场景共用一个目录时**
   * （#480 的五个附件场景都落 `docs/ui/480-attachments`）后跑的那份会把前一份覆盖掉，
   * 于是「两档 overflowCount 是不是 0」这种按目录看的证据就丢了。
   *
   * 规则：目录只被一个场景用 → 仍叫 `metrics.json`（老文档里的路径不变）；
   * 被多个场景共用 → 每个场景落 `metrics-<场景>.json`，再在目录里落一份**汇总** `metrics.json`
   * （顶层 `overflowCount` 是所有场景里最大的那个，`pages` 里逐场景列出关键量）。
   */
  const outDirs = new Map()
  for (const pageName of pageNames) {
    for (const viewport of viewportKeys) {
      const key = `${path.resolve(ROOT, options.out ?? PAGES[pageName].dir)}|${viewport}`
      outDirs.set(key, (outDirs.get(key) ?? 0) + 1)
    }
  }
  const metricsNameFor = (pageName, viewport) => {
    const key = `${path.resolve(ROOT, options.out ?? PAGES[pageName].dir)}|${viewport}`
    return (outDirs.get(key) ?? 1) > 1 ? `metrics-${pageName}.json` : 'metrics.json'
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
          const ctx = makeContext({
            page,
            def,
            pageName,
            viewport,
            outDir,
            log,
            metricsName: metricsNameFor(pageName, viewport),
          })
          await def.run(ctx)
          ctx.record('consoleErrors', consoleErrors.slice(0, 10))
          const metricsFile = path.join(ctx.dir, ctx.metricsName)
          await writeFile(metricsFile, `${JSON.stringify(ctx.metrics, null, 2)}\n`, 'utf8')
          log(`  · 量数落盘 ${path.relative(ROOT, metricsFile).split(path.sep).join('/')}`)
          results.push({ ...ctx.metrics, outDir: ctx.dir, metricsName: ctx.metricsName })
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  /**
   * 共用目录的汇总：顶层 `overflowCount` 取该目录里所有场景/视口里最大的那个 ——
   * 只有它能回答「390 / 360 两档有没有横向溢出」这个按目录验收的问题（0 才算干净）。
   *
   * 每个场景自己记的 `record()` 里也可能带 `overflowCount`（卡片、面板、列表各自量过），
   * 所以先逐场景取「自己所有量数里的最大值」，再对整个目录取最大值。
   */
  const maxOverflowOf = (item) => {
    let max = typeof item.overflowCount === 'number' ? item.overflowCount : 0
    for (const value of Object.values(item)) {
      if (value !== null && typeof value === 'object' && typeof value.overflowCount === 'number') {
        max = Math.max(max, value.overflowCount)
      }
    }
    return max
  }
  const groups = new Map()
  for (const item of results) {
    const key = `${item.outDir}|${item.viewport}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  for (const [, items] of groups) {
    if (items.length < 2) {
      continue
    }
    const pages = items.map((item) => ({
      page: item.page,
      metrics: item.metricsName,
      overflowCount: maxOverflowOf(item),
      shots: item.shots.length,
      notes: item.notes,
    }))
    const summary = {
      page: `${items.length} 个场景汇总`,
      viewport: items[0].viewport,
      size: items[0].size,
      overflowCount: Math.max(...pages.map((entry) => entry.overflowCount)),
      pages,
    }
    const file = path.join(items[0].outDir, 'metrics.json')
    await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    log(`  · 汇总落盘 ${path.relative(ROOT, file).split(path.sep).join('/')}（overflowCount=${summary.overflowCount}）`)
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
