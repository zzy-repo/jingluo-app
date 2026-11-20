// 测试替身：正常路径与 backup.mjs 行为一致（记一笔已导入，返回结果摘要）；
// 给了 globalThis.__importError 就在「解析归档」这一步抛出它 —— 用来模拟
// FileReader / File.slice().arrayBuffer() 在读取阶段抛 DOMException 的现场（issue #195）。
//
// 返回形状随 b34ffb4（#471，#390 增量导入）变更：`importHistory` 不再返回裸数字，
// 而是 `HistoryImportSummary`（`count` 是本次写入的会话数，跳过的另算）。
// 同族替身 `backup.mjs` 当时已同步，本文件漏改 —— 于是 urlImport.ts 读 `summary.count`
// 拿到 undefined，`import-refuse-before-download` 的「小包照常导入」用例假红。
export const importHistory = async (file, options) => {
  globalThis.__imported.push({ size: file.size, name: file.name, type: file.type })
  const failure = globalThis.__importError
  if (failure !== undefined) {
    throw failure
  }
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
