// 「真 store + 假存储」的最小装配（#937 / #938）。
//
// 为什么要有它：这两单要断言的是**同一条链路**上的两个位置 ——
//   ① `chat/store.ts` 把写库失败交给 `markSaveFailure()`（横幅 / 诊断）而不是 `console.error` 后吞掉；
//   ② 「错误 → 档位」这一段（`failureOfThrown()` / `classifyStorageFailure()`）走的是与
//      `outcome.failure` **同一条**分类规则，不写死 `unknown`。
// 前者要「存储这一侧说了什么、什么时候说」（`tests/fixtures/domain03-04/session-db.mjs`）。
// 两份用例逐字抄一遍装配会被 `check:test-duplication` 的 R1 判红，所以收在这里；
// **store / db 都是真代码**，替身只落在一个边界上：
//   · `chat/store.ts` 的 `./db.js` → 内存假 db（`__db` 可注入失败）
//
// 与 origin/main 上同名文件的差异（Issue #992，纯 IndexedDB 基线）：那份还要替身
// `../storage/index.js`（后端抽象）与 `../protection/index.js`（数据保护层）——
// 两者都属 #931 的 Storage Module，在本基线上**不存在**，所以这两条 onResolve 已去掉，
// 写库一律直接走 `./db.js`。随之去掉的还有 `protectionRefreshFreeSpace()` 那条
// 「失败后绕缓存重读剩余空间」的记账（基线没有 `lowSpace` 这个概念）。
//
// 用法（hook 必须在**动态** import 之前装好，所以本模块导出的是 async 装载函数）：
//
//   import { loadStoreEnv } from '../helpers/store-storage-env.mjs'
//   const { chat, db, callsOf, reset } = await loadStoreEnv()
import {
  fixtureUrl,
  installEndpointsGlobals,
  installTsResolve,
  loadTsModule,
  setupDom,
} from './dom-env.mjs'

const SESSION_DB = fixtureUrl('domain03-04/session-db.mjs')

/** 每行起点：干净的 store 状态 + 干净的存储替身（默认全成功） */
export const freshDb = (overrides = {}) => {
  globalThis.__db = {
    calls: [],
    errors: [],
    loadSessionSummaries: async () => [],
    loadSession: async () => undefined,
    saveSession: async () => {},
    pinSession: async () => {},
    renameSession: async () => {},
    deleteSession: async () => {},
    ...overrides,
  }
  return globalThis.__db
}

export const callsOf = (name) => globalThis.__db.calls.filter((entry) => entry.name === name)

export const logRecords = () => globalThis.__log.records

export const summaryOf = (id, extra = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...extra,
})

export const sessionOf = (id, extra = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  messages: [],
  rootMessageId: null,
  ...extra,
})

/** 满盘在 IDB 这一侧的两种真实形态之一：DOMException(UnknownError) + Chromium 的固定句式 */
export const fullDiskDomException = () => {
  const error = new Error('Encountered full disk while opening backing store for indexedDB.open.')
  error.name = 'UnknownError'
  return error
}

/** 另一种形态：原生/插件把 errno 原样带出来 */
export const noSpaceLeftError = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })

export const loadStoreEnv = async () => {
  installTsResolve({
    stubs: [
      [/^@capacitor\/core$/, fixtureUrl('domain03-04/capacitor.mjs')],
      [/diagnostics\/collector\.js$/, fixtureUrl('domain03-04/collector.mjs')],
    ],
    onResolve: (specifier, context) => {
      const parent = String(context.parentURL ?? '')
      if (!parent.endsWith('/chat/store.ts')) {
        return undefined
      }
      if (specifier === './db.js') {
        return SESSION_DB
      }
      return undefined
    },
  })
  installEndpointsGlobals()
  const dom = setupDom()
  // 上游一律不参与：本套用例只跑本地状态机
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'not used in this case' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  const chat = await loadTsModule('src/services/chat/store.ts')
  // 纯函数（选档 / 分类 / 文案）直接用真实现，不经桩
  const db = await loadTsModule('src/services/chat/db.ts')
  const reset = ({ sessions = [], cache = {}, activeId = null, streaming = {} } = {}, dbOverrides = {}) => {
    freshDb(dbOverrides)
    globalThis.__log.records = []
    chat.useChatStore.setState({
      ready: true,
      initError: false,
      importingHistory: false,
      sessions,
      sessionCache: cache,
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      degradedAttachments: {},
      activeId,
      streaming,
      importSkipped: [],
      waitHints: {},
    })
  }
  return { chat, db, dom, reset }
}

/** 等异步写链路（fire-and-forget）落地 */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
