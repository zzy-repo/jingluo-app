// 测试替身：正常路径与 backup.mjs 行为一致（记一笔已导入，返回会话数）；
// 给了 globalThis.__importError 就在「解析归档」这一步抛出它 —— 用来模拟
// FileReader / File.slice().arrayBuffer() 在读取阶段抛 DOMException 的现场（issue #195）。
export const importHistory = async (file, options) => {
  globalThis.__imported.push({ size: file.size, name: file.name, type: file.type })
  const failure = globalThis.__importError
  if (failure !== undefined) {
    throw failure
  }
  options?.onProgress?.({ sessions: 1, totalSessions: 1, images: 0 })
  return globalThis.__importCount ?? 1
}
