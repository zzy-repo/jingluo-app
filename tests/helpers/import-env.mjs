// 导入域（`src/services/chat/history/{importArchive,zipReader}.ts`）的公共装配 —— Issue #408 收尾批。
//
// 为什么有它：这 6 个用例文件的装配逐字相同 ——
//   1) `./errors.js` 换成等价替身（真实 `errors.ts` 用了 TS 参数属性，`node --experimental-strip-types`
//      的 strip-only 模式跑不了；替身把 key / params 原样带出，message 用真实 zh 文案渲染）；
//   2) `../db.js` 只对 `history/importArchive.ts` 换成假存储（IndexedDB 在裸 Node 里不存在）；
//   3) `.js→.ts` 解析（源码里写的是构建产物名）。
// 这段 22~30 行在 archive-fixture-roundtrip / import-archive-unclassified / import-hardening /
// import-skipped-ui / domain05-archive-reject-matrix / domain05-skip-degrade-matrix 里各有一份，
// `check:test-duplication` 抓到 2 组；假存储本体又抓到 1 组。
//
// **替身内容逐字沿用原文件**：每个文件的假存储语义不同（谁记 storedTypes、谁记 typeUpdates、
// 有没有 reportStorageError），所以假存储仍由调用方给，这里只收「装哪几个钩子」。
//
//   installImportEnv({ db: importStagingDb({ expose: '__archiveFixtureDB' }) })
//   const db = globalThis.__archiveFixtureDB
//
// 需要额外替身（例如 domains05 的 zipReader 观测点）就传 `extraStubs`，口径同 `installTsResolve`。

import { fixtureUrl, inlineModule, installTsResolve } from './dom-env.mjs'

/** 导入域 errors.ts 的等价替身 URL（`import-archive-stubs/errors.mjs`） */
export const importErrorsStub = () => fixtureUrl('import-archive-stubs/errors.mjs')

/**
 * 全套暂存 API 的假存储：会话数组、图片字节 Map、回填的 MIME Map，外加三个清理 / 追加函数。
 *
 * `expose` 是挂到 `globalThis` 上的名字（用例里 `const db = globalThis.__xxx` 直接读）——
 * 各文件用各自的键名，避免同一进程（合并批次）里互相踩。
 */
export const importStagingDb = ({ expose }) => inlineModule(`
export const stagingSessions = []
export const stagingFiles = new Map()
export const stagingFileTypes = new Map()
export const clearStaging = async () => {
  stagingSessions.length = 0
  stagingFiles.clear()
  stagingFileTypes.clear()
}
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async (files) => {
  for (const file of files) {
    stagingFiles.set(file.id, file.blob)
  }
}
export const updateStagingFileTypes = async (types) => {
  for (const [id, type] of types) {
    stagingFileTypes.set(id, type)
  }
}
export const loadFile = async () => undefined
export const loadSession = async () => undefined
export const saveSession = async () => {}
globalThis.${expose} = { stagingSessions, stagingFiles, stagingFileTypes, clearStaging }
`)

/**
 * 装导入域的解析钩子：`./errors.js` 等价替身 → `../db.js`（仅 importArchive.ts 的）→ `.js→.ts`。
 * `db` 必填：每个文件的假存储语义不同，不能由这里替它们决定。
 */
export const installImportEnv = ({ db, extraStubs = [] } = {}) => {
  if (db === undefined) {
    throw new Error('installImportEnv 需要 db：假存储由调用方给（各文件的语义不同）')
  }
  installTsResolve({
    stubs: [['./errors.js', importErrorsStub()], ...extraStubs],
    onResolve: (specifier, context) => (
      specifier === '../db.js' && String(context.parentURL ?? '').endsWith('/history/importArchive.ts')
        ? db
        : undefined
    ),
  })
}
