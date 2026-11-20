// 测试替身：会话库（IndexedDB）。N4-A / N4-B 需要「可注入失败、可控时序」的存储语义，
// 真 IndexedDB 在裸 Node 里不存在，所以把 `src/services/chat/db.ts` 整个换成这个薄壳：
// 每次调用都记进 `globalThis.__db.calls`，行为由用例当场装配的 `globalThis.__db.<name>` 决定。
//
// 断言对象仍是真 `src/services/chat/store.ts` 的状态机（排序 / 置顶字段 / 删除链路 / 缓存淘汰），
// 这里的替身只负责「存储这一侧说了什么、什么时候说」。
const hooks = () => globalThis.__db
const record = (name, args) => hooks().calls.push({ name, args })

export const loadSessionSummaries = () => {
  record('loadSessionSummaries', [])
  return hooks().loadSessionSummaries()
}

export const loadSession = (id) => {
  record('loadSession', [id])
  return hooks().loadSession(id)
}

export const saveSession = (session, files = []) => {
  record('saveSession', [session, files])
  return hooks().saveSession(session, files)
}

export const pinSession = (id, pinnedAt) => {
  record('pinSession', [id, pinnedAt])
  return hooks().pinSession(id, pinnedAt)
}

export const renameSession = (id, title) => {
  record('renameSession', [id, title])
  return hooks().renameSession(id, title)
}

export const deleteSession = (id) => {
  record('deleteSession', [id])
  return hooks().deleteSession(id)
}

export const saveFiles = async () => {}
export const loadFile = async () => undefined
export const clearStaging = async () => {}
export const addStagingSession = async () => {}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => []

/** 真实实现会把错误上报到诊断；这里只记下来，用例断言「失败被记录」而不是被吞掉 */
export const reportStorageError = (action) => (error) => {
  hooks().errors.push({ action, message: error instanceof Error ? error.message : String(error) })
}

export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
