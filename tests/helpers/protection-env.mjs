// Storage Protection（#909）单测共用装配：解析钩子 + 内存 FS（fs 模块自带的 createMemoryFs，不复制）+
// 内存存储替身（ProtectionStorage 窄接口）+ 会话夹具。
//
//   import { loadProtection, setupProtection, makeSession } from '../helpers/protection-env.mjs'
//   const P = await loadProtection()
//   const env = setupProtection(P, { native: true, sessions: [makeSession('a')] })
import { chatCollectorStub, chatStub, installTsResolve, loadTsModule } from './dom-env.mjs'

export const loadProtection = async () => {
  installTsResolve({
    stubs: [
      [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
      [/diagnostics\/collector\.js$/, chatCollectorStub()],
    ],
  })
  globalThis.__log = { records: [], events: [], actions: [] }
  const [memoryFs, fsTypes, index, highwater, constants, diagnostics, snapshot, freeSpace, restore] = await Promise.all([
    loadTsModule('src/services/fs/memoryFs.ts'),
    loadTsModule('src/services/fs/types.ts'),
    loadTsModule('src/services/protection/index.ts'),
    loadTsModule('src/services/protection/highwater.ts'),
    loadTsModule('src/services/protection/constants.ts'),
    loadTsModule('src/services/protection/diagnostics.ts'),
    loadTsModule('src/services/protection/snapshot.ts'),
    loadTsModule('src/services/protection/freeSpace.ts'),
    loadTsModule('src/services/protection/restore.ts'),
  ])
  return { ...memoryFs, ...fsTypes, ...index, ...highwater, ...constants, ...diagnostics, ...snapshot, ...freeSpace, ...restore }
}

export const makeSession = (id, extra = {}) => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1000,
  updatedAt: 2000,
  messages: [
    {
      id: `${id}-u1`,
      role: 'user',
      content: `你好 ${id}`,
      createdAt: 1001,
      files: [{ id: `${id}-f1`, serverId: null, name: 'a.png', size: 12, isImage: true, mimeType: 'image/png' }],
    },
    {
      id: `${id}-a1`,
      role: 'assistant',
      createdAt: 1002,
      model: null,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: `回答 ${id}` }],
    },
  ],
  ...extra,
})

/**
 * 内存存储替身：`state.sessions` 就是「库里的会话」，`state.summaries` 缺省时由会话推出；
 * 单独改 `state.summaries` 可以模拟「摘要缺失 / 不一致」。
 */
export const memoryStorage = (state) => {
  const derived = () => state.sessions.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
  const summaries = () => state.summaries ?? derived()
  return {
    schemaVersion: 15,
    available: () => state.available !== false,
    countSessions: async () => state.sessions.length,
    countSummaries: async () => summaries().length,
    loadSessions: async () => state.sessions.map((session) => structuredClone(session)),
    loadSummaries: async () => summaries().map((summary) => ({ ...summary })),
    rebuildSummaries: async () => {
      state.summaries = undefined
      return state.sessions.length
    },
    stageSession: async (session) => {
      ;(state.staging ??= []).push(structuredClone(session))
    },
  }
}

export const localStore = () => {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  }
}

export const setupProtection = (P, { native = true, sessions = [], now = { value: 1_700_000_000_000 }, freeBytes } = {}) => {
  const fs = P.createMemoryFs(freeBytes === undefined ? {} : { freeBytes })
  if (!native) {
    fs.supported = false
  }
  const state = { sessions, available: true }
  const local = localStore()
  const protection = P.createProtection({ fs, storage: memoryStorage(state), now: () => now.value, local })
  return { fs, state, local, now, protection }
}

export const records = () => globalThis.__log.records
export const resetRecords = () => {
  records().length = 0
}

/**
 * 整包替换通道的内存模拟（语义对齐 `importHistoryInto(write,'overwrite')`）：清暂存 → write → 一次性替换 → 清暂存；
 * write / 提交任一失败：清暂存并原样抛出，`state.sessions` 一个字不动。
 */
export const makeCommit = (state, { failAfterWrite = false } = {}) => async (write) => {
  state.staging = []
  try {
    await write()
    if (failAfterWrite) {
      throw new Error('injected commit failure')
    }
    state.sessions = (state.staging ?? []).map((session) => structuredClone(session))
    state.summaries = undefined
  } catch (error) {
    state.staging = []
    throw error
  }
  state.staging = []
}
