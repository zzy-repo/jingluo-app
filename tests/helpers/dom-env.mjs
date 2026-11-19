// L0（单元层）的**公共装配**：`.js→.ts` 解析 hook + 模块桩 + 浏览器全局。
//
// 为什么要有它（Issue #366 第一批）：90/121 个 L0 文件各自抄了一遍同一套装配 ——
// `import { registerHooks } from 'node:module'` + 本地 `asTypescript()` + 逐个 `stub(...)` 分支，
// 每个文件 40~60 行、合计约 3000 行样板。样板本身没有断言，却把「Node 的 loader 约定」
// 复制了 90 份：换一次解析规则就要改 90 处，漏一处就是一条假红或一条假绿。
//
// 现在收成一个入口，新用例只需要：
//
//   import { installTsResolve, loadTsModule, fixtureUrl, setupDom } from '../helpers/dom-env.mjs'
//
//   installTsResolve({
//     stubs: {
//       '@capacitor/core': fixtureUrl('url-import-stubs/capacitor.mjs'),
//       './errors.js': fixtureUrl('url-import-stubs/errors.mjs'),
//     },
//   })
//   const { importHistoryFromUrl } = await loadTsModule('src/services/chat/history/urlImport.ts')
//
// **顺序要求**：hook 必须在*动态* `import()` 被测源码之前装好 —— 静态 import 会被提升到 hook
// 之前求值（那时 hook 还不存在，`.js` 说明符依然解析不到 `.ts`）。
//
// 分工：`helpers/env.mjs` 管集成层「环境守卫」（端口 / 产物 / variant），`helpers/runtime.mjs`
// 管「跑一个用例进程」，本文件只管单测的「模块装配」，三者互不依赖。
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（tests/helpers/ → ../..） */
export const ROOT = path.resolve(HERE, '../..')

/** 仓库内相对路径 → file:// URL（`moduleUrl('src/services/limits.ts')`） */
export const moduleUrl = (repositoryPath) => pathToFileURL(path.join(ROOT, repositoryPath)).href

/** tests/fixtures/ 下的替身 → file:// URL（`fixtureUrl('chat-stubs/capacitor.mjs')`） */
export const fixtureUrl = (relativePath) => pathToFileURL(path.join(ROOT, 'tests', 'fixtures', relativePath)).href

/** `data:text/javascript,...` 内联模块（一行桩，不用为它建 fixture 文件） */
export const inlineModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`

/**
 * `.js` 说明符 → 同名 `.ts`（NodeNext 约定：源码里写 `./providers.js`，实际文件是 `providers.ts`，
 * 裸 node 不会自己换后缀）。返回 null = 不归这条规则管（裸包名 / 非相对路径 / `.ts` 不存在）。
 */
export const resolveTypescript = (specifier, parentURL) => {
  if (!parentURL || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return null
  }
  const target = fileURLToPath(new URL(specifier, parentURL)).replace(/\.js$/, '.ts')
  return existsSync(target) ? pathToFileURL(target).href : null
}

const isUrl = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value)

/**
 * 装 `.js→.ts` 解析 hook（进程级，装一次即可；重复调用会叠加，别在循环里调）。
 *
 *   stubs    说明符替换：`{ '说明符原文': 目标 }` 精确匹配，或 `[[/正则/, 目标]]` 按模式匹配
 *            （`./db.js`、`diagnostics/collector.js` 这类按父模块 / 按路径后缀区分的必须用后者）。
 *            目标是 `fixtureUrl()` / `inlineModule()` / 仓库相对路径，命中即 short-circuit。
 *   onResolve  兜底钩子：处理「按父模块区分」这类一次性规则（例：只有 store.ts 里的 `./db.js`
 *            才换成内存库）。返回 URL / `{ url, shortCircuit }` 表示接管，返回 undefined 表示放行。
 *
 * 判定顺序：stubs → onResolve → `.js→.ts` → 原样交给 Node（裸包名照常走 node_modules）。
 */
export const installTsResolve = ({ stubs = {}, onResolve } = {}) => {
  const entries = (Array.isArray(stubs) ? stubs : Object.entries(stubs)).map(([key, target]) => [
    key instanceof RegExp ? key : new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    typeof target === 'string' && !isUrl(target) ? moduleUrl(target) : target,
  ])
  const stubOf = (specifier) => {
    for (const [pattern, target] of entries) {
      if (pattern.test(specifier)) {
        return target
      }
    }
    return undefined
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const stub = stubOf(specifier)
      if (stub !== undefined) {
        return { url: stub, shortCircuit: true }
      }
      const custom = onResolve?.(specifier, context)
      if (custom !== undefined) {
        return typeof custom === 'string' ? { url: custom, shortCircuit: true } : custom
      }
      const typescript = resolveTypescript(specifier, context.parentURL)
      if (typescript !== null) {
        return { url: typescript, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

/** 仓库相对路径的源码动态加载（hook 装好之后再调）：`loadTsModule('src/services/chat/store.ts')` */
export const loadTsModule = (repositoryPath) => import(moduleUrl(repositoryPath.replace(/^\.\//, '')))

/**
 * 浏览器全局的最小替身：单测要的只有「被测源码启动时不炸」，不需要真 DOM 实现
 * （真布局 / 真排版归 L1 集成层，那里有 Playwright）。
 *
 *   const dom = setupDom()        // localStorage / document / window / requestAnimationFrame
 *   dom.localStorage.setItem('k', 'v')
 *   t.after(() => dom.restore())  // 同一进程里还有别的文件时还原干净
 */
export const setupDom = ({ visibilityState = 'visible' } = {}) => {
  const storage = new Map()
  const installed = [
    [
      'localStorage',
      {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => {
          storage.set(key, String(value))
        },
        removeItem: (key) => {
          storage.delete(key)
        },
        clear: () => storage.clear(),
      },
    ],
    ['document', { visibilityState, addEventListener() {}, removeEventListener() {} }],
    ['window', { addEventListener() {}, removeEventListener() {} }],
    // rAF 用 setImmediate 而不是 setTimeout(cb, 0)：两者都是「下一个宏任务」，
    // 但 setTimeout 有 ~1ms 的钳制，逐帧刷新的用例（如 420 轮长会话，每轮好几帧）会白等几分钟之一。
    ['requestAnimationFrame', (callback) => setImmediate(callback)],
    ['cancelAnimationFrame', (id) => clearImmediate(id)],
  ]
  const had = installed.map(([key]) => [key, Object.hasOwn(globalThis, key)])
  for (const [key, value] of installed) {
    globalThis[key] = value
  }
  return {
    localStorage: globalThis.localStorage,
    restore: () => {
      for (const [key, existed] of had) {
        if (existed) {
          continue
        }
        delete globalThis[key]
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 构建期注入值 + 端点全局 —— Issue #408 收尾批
//
// 为什么补这一段：`globalThis.__ENDPOINTS__ ??= Object.freeze({...})` + `__API_ORIGIN__` +
// `__INTERNAL_BUILD__` + `__log` 这 8 行，在 6 个 L0 文件里逐字相同（`check:test-duplication`
// 抓到 3 组），而且**数值必须和 config/endpoints.json 一致** —— 抄错一位就是连错环境。
//
// 端点值全部经 scripts/lib/endpoints.mjs（唯一事实来源）取，与 `tests/helpers/injected.mjs`
// 的 `--import` 预加载同一份；这里再做一次 `??=` 只是为了让文件单独跑（不经 run-layer）也不炸。
//
//   installEndpointsGlobals()                    // 默认 api.deepseek.com / 非内部构建
//   installEndpointsGlobals({ resetLogRecords: false }) // 保留同进程里别的文件留下的 __log
// ---------------------------------------------------------------------------

/** `__log` 的初始形状：诊断替身往 records 里 push，用例读它做断言 */
export const resetLog = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
}

/**
 * 挂构建期注入值。`??=` 语义保持原样：同进程（合并批次）里别的文件已经设过就不覆盖 ——
 * **只有 `__log` 默认清空**，因为那是每个文件自己的记账本。
 */
export const installEndpointsGlobals = ({
  apiOrigin = 'https://api.deepseek.com',
  internalBuild = false,
  resetLogRecords = true,
} = {}) => {
  globalThis.__ENDPOINTS__ ??= Object.freeze({
    chatBaseUrl,
    inviteBaseUrl: 'https://invite.test.invalid',
    feedbackUrl: 'https://feedback.test.invalid',
    legacyHosts: Object.freeze([...legacyHosts]),
    allowedHosts: Object.freeze([]),
  })
  globalThis.__API_ORIGIN__ ??= apiOrigin
  globalThis.__INTERNAL_BUILD__ ??= internalBuild
  if (resetLogRecords) resetLog()
}

/**
 * 会话矩阵（N4-A 增删改 / N4-B 加载三态）的整段装配：原生桥 + 诊断 + **按父模块**换掉
 * `chat/store.ts` 的 `./db.js` + 构建期注入值。
 *
 * 这两条用例的被测对象是真 `chat/store.ts`，装配逐字相同（28 行），差别只在 db 替身的行为，
 * 所以装配收成一处；`setupDom()` 仍由各文件自己调（加载矩阵还要额外桩 fetch）。
 */
export const installSessionMatrixEnv = () => {
  installTsResolve({
    stubs: [
      [/^@capacitor\/core$/, fixtureUrl('domain03-04/capacitor.mjs')],
      [/diagnostics\/collector\.js$/, fixtureUrl('domain03-04/collector.mjs')],
    ],
    onResolve: (specifier, context) => (
      specifier === './db.js' && String(context.parentURL ?? '').endsWith('/chat/store.ts')
        ? fixtureUrl('domain03-04/session-db.mjs')
        : undefined
    ),
  })
  installEndpointsGlobals()
}

// ---------------------------------------------------------------------------
// chat 一族（chat-stubs + 真 store）的公共装配 —— Issue #408
//
// 为什么补这一段：`installTsResolve` 收掉了 `.js→.ts` 那一层，但「chat 一族的替身表」还是
// 5 个文件各抄一份 —— 每个文件 41 行里，17 行的假 db、5 行的诊断写入口替身、6 行的 install
// 调用逐字相同（check:test-duplication 一次就能抓到 6 组）。换一个导出就要改 5 处。
//
//   import { installChatEnv } from '../helpers/dom-env.mjs'
//   const { stub } = installChatEnv()                       // 原生桥 / 诊断 / 存储替身一次装好
//   const { stub } = installChatEnv({ stubs: [[/^x$/, y]] }) // 需要额外替身时按 installTsResolve 的口径追加
//
// 需要换一套存储语义（例如读持久化失败）就传 `db`：
//   installChatEnv({ db: chatFakeDb({ reportStorageError: 'async () => () => {}' }) })
// ---------------------------------------------------------------------------

/** chat-stubs 下的替身 → file:// URL（`chatStub('capacitor.mjs')`） */
export const chatStub = (name) => fixtureUrl(`chat-stubs/${name}`)

/**
 * `chat/db.ts` 的存储层替身：只要「被 import 时不炸」，断言都打在 `chat/store.ts` 的状态上。
 * `reportStorageError` 给两种形状：默认返回一个空的上报函数；`async` 形状用于「落盘失败要等」的用例。
 */
export const chatFakeDb = ({ reportStorageError = '() => () => {}' } = {}) => inlineModule(`
export const loadSessionSummaries = async () => []
export const loadSession = async () => undefined
export const saveSession = async () => {}
export const saveFiles = async () => {}
export const loadFile = async () => undefined
export const deleteSession = async () => {}
export const pinSession = async () => {}
export const renameSession = async () => {}
export const clearStaging = async () => {}
export const addStagingSession = async () => {}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => []
export const reportStorageError = ${reportStorageError}
export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
`)

/** 诊断写入口替身：包住真实 collector，`recordError` 落到 `globalThis.__log.records`（用例自己初始化） */
export const chatCollectorStub = () => inlineModule(`
export * from '${chatStub('collector.mjs')}'
export const recordError = (message, fields = {}) => {
  globalThis.__log.records.push({ kind: 'error', level: 'error', message, fields })
}
`)

/**
 * 只要「原生桥 + 诊断入口」，**不换存储**的那一档装配（auto-title / chat-stream 一族）。
 *
 * 为什么不直接复用 `installChatEnv`：那些用例根本不 import `chat/store.ts`，换上假 db 属于
 * 无谓地改变装配面。这一段原先也是 3 个文件各抄一份 23 行 `registerHooks`（#408 收尾批收掉）。
 *
 *   import { installChatBridge } from '../helpers/dom-env.mjs'
 *   installChatBridge()
 */
export const installChatBridge = () =>
  installTsResolve({
    stubs: [
      [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
      [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
    ],
  })

/**
 * chat 一族的装配：原生桥 `@capacitor/core` + 诊断写入口 + **按父模块**把 `chat/store.ts` 的
 * `./db.js` 换成假库（其余 `./db.js` 照旧解析回真文件）。
 *
 * `@capacitor/*` 里只有 core 是整族共用；其他能力（filesystem / clipboard…）由调用方用 `stubs` 追加，
 * 避免这里替所有用例决定它们的行为。
 */
export const installChatEnv = ({ db = chatFakeDb(), collector = chatCollectorStub(), stubs = [] } = {}) => {
  installTsResolve({
    stubs: [
      [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
      [/diagnostics\/collector\.js$/, collector],
      ...(Array.isArray(stubs) ? stubs : Object.entries(stubs)),
    ],
    onResolve: (specifier, context) => (
      specifier === './db.js' && String(context.parentURL ?? '').endsWith('/chat/store.ts') ? db : undefined
    ),
  })
  return { stub: chatStub, db, collector }
}
