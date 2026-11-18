// 测试替身：只关心「下载阶段拿到了完整的 File」，所以直接返回固定会话数。
export const importHistory = async (file, options) => {
  globalThis.__imported.push({ size: file.size, name: file.name, type: file.type })
  options?.onProgress?.({ sessions: 1, totalSessions: 1, images: 0 })
  return globalThis.__importCount ?? 1
}
