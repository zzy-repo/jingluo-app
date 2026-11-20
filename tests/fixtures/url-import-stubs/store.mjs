// 测试替身：store 负责「事务 + 状态」，本层只关心拒绝时机，替换成直通实现。
export const replaceHistory = async (run) => await run()

/**
 * #390：backup.ts 的提交入口（按模式分发）。本层只关心「什么时候被拒绝」，
 * 所以替身直接按 overwrite 跑一遍并把条数当摘要返回。
 */
export const importHistoryInto = async (run) => {
  await run()
  return { mode: 'overwrite', count: 1, added: 1, overwritten: 0, skipped: 0, skippedTitles: [] }
}

export const useChatStore = {
  getState: () => ({ sessions: [], sessionCache: {} }),
}
