// 测试替身：真实 src/services/chat/db.ts 要 IndexedDB，这里只记下 importArchive 往 staging 写了什么。
// 覆盖 #32 关心的三件事：图片有没有落盘、会话有没有逐个入 staging、文件类型表有没有交回去。
export const saveStagingFiles = async (files) => {
  globalThis.__stagedFiles.push(...files)
}

export const addStagingSession = async (session) => {
  globalThis.__stagedSessions.push(session)
}

export const updateStagingFileTypes = async (stored) => {
  globalThis.__stagedTypes = stored
}
