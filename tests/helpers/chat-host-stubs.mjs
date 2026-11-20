// 聊天层用例的**宿主替身**（只在边界上换实现：IndexedDB / 诊断收集器 / Capacitor / 浏览器全局）。
//
// 为什么抽出来：`src/services/chat/store.ts` 一 import 就会拉 zustand、IndexedDB、诊断收集器，
// 裸 Node 里跑不起来。原先每个聊天用例各抄一份 ~70 行的 stub 装配（#408 的重复门禁会判红），
// 这里收成一处；**store / reply / contextBudget / requestBody 仍然是真代码**，替身只在最外层。
//
// 用法（必须在 import `src/**` 之前调用，resolve 钩子才生效）：
//
//   import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'
//   installChatHostStubs()
//   const { useChatStore } = await import('../../src/services/chat/store.ts')
//
// 需要自己造 `__log` 之类全局的用例，可以在调用后用 `globalThis.__log` 读写（本模块已初始化）。
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

/** 内存版 db：替换 IndexedDB 落点，store 照旧 saveSession / loadSession */
const fakeDB = `data:text/javascript,${encodeURIComponent(`
const memory = new Map()
const host = () => globalThis.__stubChatHost ?? {}
const summary = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})
// 预置会话由用例在 installChatHostStubs 时传入：模块首次求值即写进内存 db
for (const session of host().sessions ?? []) {
  memory.set(session.id, structuredClone(session))
}
export const loadSessionSummaries = async () => [...memory.values()].map(summary)
export const loadSession = async (id) => (memory.has(id) ? structuredClone(memory.get(id)) : undefined)
export const saveSession = async (session) => {
  memory.set(session.id, structuredClone(session))
}
export const saveFiles = async () => {}
// 附件原件：用例给什么就返回什么；默认没有任何原件（导入时只保留元信息的情况）
export const loadFile = async (id) => (host().loadFile ? host().loadFile(id) : undefined)
export const deleteSession = async (id) => {
  memory.delete(id)
}
export const pinSession = async () => {}
export const renameSession = async () => {}
export const clearStaging = async () => {}
export const addStagingSession = async () => {}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => []
export const reportStorageError = () => () => {}
export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
`)}`

/** 诊断收集器替身：`__log` 里可查到 recordError，其余导出照旧 */
const collectorStub = `data:text/javascript,${encodeURIComponent(`
export * from '${stub('collector.mjs')}'
export const recordError = (message, fields = {}) => {
  globalThis.__log.records.push({ kind: 'error', level: 'error', message, fields })
}
`)}`

/** 浏览器 / 打包期注入的全局：Node 里没有，缺一个 store 就 import 不起来 */
const installGlobals = () => {
  // 打包期注入（rspack DefinePlugin）：标准构建 → 默认渠道 deepseek
  globalThis.__ENDPOINTS__ ??= Object.freeze({
    chatBaseUrl: 'https://chat.test.invalid',
    inviteBaseUrl: 'https://invite.test.invalid',
    feedbackUrl: 'https://feedback.test.invalid',
    legacyHosts: Object.freeze([]),
    allowedHosts: Object.freeze([]),
  })
  globalThis.__API_ORIGIN__ ??= 'https://api.test.invalid'
  globalThis.INTERNAL_BUILD ??= false
  globalThis.__INTERNAL_BUILD__ ??= false
  globalThis.__log ??= { records: [], events: [], actions: [] }

  const memory = new Map()
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => {
      memory.set(key, String(value))
    },
    removeItem: (key) => {
      memory.delete(key)
    },
  }
  globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
}

/**
 * 装好全部替身：解析钩子（Capacitor / 诊断收集器 / 内存 db / `.js` → `.ts`）+ 浏览器全局。
 * 必须在 import `src/**` 之前调用一次。
 *
 * @param {{
 *   sessions?: object[]
 *   loadFile?: (id: string) => Promise<Blob | undefined> | Blob | undefined
 * }} [options]
 *   `sessions`：预置进内存 db 的会话（`initChat()` 之后就在列表里，`selectSession()` 能加载）；
 *   `loadFile`：附件原件的读取入口（默认不返回任何原件，即「导入时只保留元信息」那种情况）。
 */
export const installChatHostStubs = (options = {}) => {
  installGlobals()
  // db 模块首次求值时读它：预置会话与原件读取入口，不需要用例自己拼 db 替身
  globalThis.__stubChatHost = { sessions: options.sessions ?? [], loadFile: options.loadFile }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@capacitor/core') {
        return { url: stub('capacitor.mjs'), shortCircuit: true }
      }
      if (/diagnostics\/collector\.js$/.test(specifier)) {
        return { url: collectorStub, shortCircuit: true }
      }
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const parent = String(context.parentURL ?? '')
        if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
          return { url: fakeDB, shortCircuit: true }
        }
        // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
        }
        throw error
      }
    },
  })
}
