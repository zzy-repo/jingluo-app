// 测试替身：只关心「下载阶段拿到了完整的 File」，所以直接返回固定条数的结果摘要（#390）。
export const importHistory = async (file, options) => {
  globalThis.__imported.push({ size: file.size, name: file.name, type: file.type })
  options?.onProgress?.({ sessions: 1, totalSessions: 1, images: 0 })
  const count = globalThis.__importCount ?? 1
  return {
    mode: options?.mode ?? 'merge',
    count,
    added: count,
    overwritten: 0,
    skipped: 0,
    skippedTitles: [],
  }
}
