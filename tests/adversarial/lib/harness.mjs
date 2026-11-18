// 红队用例的公共装置：
//   1) 用 module.registerHooks 把 .js 说明符映射到 .ts（Node 22 的 type stripping 能直接跑 TS），
//      并把 db / errors 换成替身，这样 history 目录下的真实实现可以在 Node 里直接跑。
//   2) 造归档：manifest / 会话 / index 的合法 JSON 样本，以及 File 包装。
//   3) 断言辅助：抓 BackupError 的 key/params/message，测耗时与内存。
//
// 注意：断言只针对 src 里的**既有行为**与 docs/ISSUE-STANDARD.md 里写下的语义，不凭空造期望。
import { registerHooks } from 'node:module'

const ZH_URL = new URL('../../../src/i18n/zh.ts', import.meta.url).href

// errors.ts 用了 TS 参数属性，strip-only 模式不支持；替身与真实实现等价，
// message 仍从 src/i18n/zh.ts 取真实文案，这样「用户看到的话」可被断言。
const errorsSource = `
import { zh } from ${JSON.stringify(ZH_URL)}

const render = (key, params) =>
  String(zh[key] ?? key).replace(/\\{(\\w+)\\}/g, (placeholder, name) =>
    typeof params?.[name] === 'string' || typeof params?.[name] === 'number'
      ? String(params[name])
      : placeholder
  )

export class BackupError extends Error {
  constructor(key, params) {
    super(render(key, params))
    this.name = 'BackupError'
    this.key = key
    this.params = params
  }
}

export const fail = (key, params) => {
  throw new BackupError(key, params)
}
`

const dbSource = `
const sessions = []
const files = []
const types = []
const calls = { addStagingSession: 0, saveStagingFiles: 0, updateStagingFileTypes: 0 }
export const __staging = { sessions, files, types, calls }
export const addStagingSession = async (session) => {
  calls.addStagingSession += 1
  sessions.push(session)
}
export const saveStagingFiles = async (list) => {
  calls.saveStagingFiles += 1
  for (const item of list) files.push(item)
}
export const updateStagingFileTypes = async (map) => {
  calls.updateStagingFileTypes += 1
  types.push(map)
}
export const clearStaging = async () => {}
export const loadSession = async () => undefined
export const loadSessionSummaries = async () => []
export const saveSession = async () => {}
`

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`

const ERRORS_URL = dataUrl(errorsSource)
const DB_URL = dataUrl(dbSource)

let installed = false

/** 安装解析钩子。同一个进程里重复调用无副作用。 */
export const installHooks = () => {
  if (installed) {
    return
  }
  installed = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './errors.js' || specifier === '../errors.js' || /(^|\/)errors\.js$/.test(specifier)) {
        return { url: ERRORS_URL, shortCircuit: true }
      }
      if (/(^|\/)db\.js$/.test(specifier)) {
        return { url: DB_URL, shortCircuit: true }
      }
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        // .ts 源码内部写的是 ESM 风格的 .js 说明符，磁盘上只有 .ts。
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
        }
        throw error
      }
    },
  })
}

/** 取 db 替身的暂存记录（所有 importArchive 用例共用一个模块实例）。 */
export const staging = () => import(DB_URL)

export const resetStaging = async () => {
  const module = await staging()
  module.__staging.sessions.length = 0
  module.__staging.files.length = 0
  module.__staging.types.length = 0
  module.__staging.calls.addStagingSession = 0
  module.__staging.calls.saveStagingFiles = 0
  module.__staging.calls.updateStagingFileTypes = 0
}

export const TIME = '2026-11-01T00:00:00.000Z'
export const MANIFEST_PATH = 'manifest.json'
export const INDEX_PATH = 'chat_session_index.json'
export const USER_PATH = 'user.json'

export const manifestJson = (overrides = {}) => JSON.stringify({ export_format_version: 3, ...overrides })

/** 一条最小合法消息（字段与 src/services/chat/history/format.ts 一致）。 */
const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

/** 合法会话文件：id 必须与文件名里的 id 相同（导入端会比对）。 */
export const sessionJson = (id, { title = `会话 ${id}`, rounds = 1, extra = {} } = {}) => {
  const messages = []
  let parent = null
  for (let round = 1; round <= rounds; round += 1) {
    const question = round * 2 - 1
    const answer = round * 2
    messages.push(message(question, parent, 'USER', `问题 ${round}`))
    messages.push(message(answer, question, 'ASSISTANT', `回答 ${round}`))
    parent = answer
  }
  return JSON.stringify({
    id,
    title,
    pinned: false,
    current_message_id: parent,
    inserted_at: TIME,
    updated_at: TIME,
    messages,
    ...extra,
  })
}

export const indexJson = (ids, overrides = {}) =>
  JSON.stringify(
    ids.map((id) => ({
      id,
      title: `会话 ${id}`,
      pinned: false,
      message_count: 2,
      inserted_at: TIME,
      updated_at: TIME,
      ...overrides,
    }))
  )

export const sessionPathOf = (id) => `chat_sessions/${id}.json`

/** 包装成 File（导入端口签名的入参）。 */
export const archiveFile = (bytes, name = 'archive.zip') =>
  new File([bytes], name, { type: 'application/zip' })

/** 抓 BackupError；不是 BackupError 就把原错误抛出去（避免把真 bug 当成通过）。 */
export const captureFailure = async (run) => {
  try {
    await run()
  } catch (error) {
    if (error && error.name === 'BackupError') {
      return { key: error.key, params: error.params, message: error.message }
    }
    throw error
  }
  throw new Error('期望失败，但调用成功了')
}

/** 两可结果：成功返回 { ok: true }，BackupError 返回 { ok: false, key, params, message }；其它错误照抛。 */
export const attempt = async (run) => {
  try {
    await run()
    return { ok: true }
  } catch (error) {
    if (error && error.name === 'BackupError') {
      return { ok: false, key: error.key, params: error.params, message: error.message }
    }
    throw error
  }
}

/** 抓任意错误（用于断言「不是 BackupError，而是 ArchiveError/TypeError」这类差别）。 */
export const captureAny = async (run) => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('期望抛错，但调用成功了')
}

export const stopwatch = () => {
  const started = process.hrtime.bigint()
  return () => Number(process.hrtime.bigint() - started) / 1e6
}

export const memoryMb = () => {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss / 1024 / 1024,
    heap: usage.heapUsed / 1024 / 1024,
    external: usage.external / 1024 / 1024,
    arrayBuffers: (usage.arrayBuffers ?? 0) / 1024 / 1024,
  }
}

/** 打印一行「测量结果」，方便报告里直接引用实测数字。 */
export const report = (label, value) => {
  process.stdout.write(`  · ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`)
}
