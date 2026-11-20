/**
 * 增量导入的冲突判定（Issue #390）。
 *
 * 现在导入有两种「不清空本地」的模式，判定口径**只**看会话 id：
 *   - **同一 sessionId ⇒ 同一会话**（本地已有就进入冲突分支）；
 *   - **不同 id、标题相同 ⇒ 两条不同会话**，各留各的（不按标题合并，标题是用户可改的展示字段）。
 *
 * merge 模式下冲突按**更新时间**取舍：包内更新的覆盖本地，本地更新的保留；
 * 时间戳相同按包内版本写入 —— 这样「刚导出就导回来」不会被当成冲突丢掉，同一份包重复导入
 * 也会得到同一个结果（幂等）。skip 模式不比较时间，本地已有同 id 就一律保留本地。
 */

/** 导入方式：merge 按更新时间取舍 / skip 跳过已存在 / overwrite 整包覆盖（清空本地，现有行为）。 */
export type ImportMode = 'merge' | 'skip' | 'overwrite'

/** 不清空本地的两种模式（overwrite 走整包替换，不经过冲突判定）。 */
export type MergePolicy = 'merge' | 'skip'

/** 单条会话的判定结果：新增（本地没有） / 覆盖（同 id，包内胜出） / 跳过（同 id，保留本地）。 */
export type ConflictDecision = 'added' | 'overwritten' | 'skipped'

/** 参与判定所需的会话元数据：只需要 id 与更新时间，标题仅用于结果明细。 */
export type SessionRef = { id: string; title: string; updatedAt: number }

/**
 * 单条会话的冲突判定。`localUpdatedAt` 为 undefined = 本地没有这个 id。
 * 除 id 之外不看任何字段：标题、消息内容都不参与「是不是同一条会话」的判定。
 */
export const resolveConflict = (
  localUpdatedAt: number | undefined,
  incoming: SessionRef,
  policy: MergePolicy
): ConflictDecision => {
  if (localUpdatedAt === undefined) {
    return 'added'
  }
  if (policy === 'skip') {
    return 'skipped'
  }
  return incoming.updatedAt >= localUpdatedAt ? 'overwritten' : 'skipped'
}

/** 一次增量导入的结果：条数统计 + 明细 + 「真正写入了哪些 id」（调用方据此搬运图片原件）。 */
export type MergePlan = {
  added: number
  overwritten: number
  skipped: number
  /** 被跳过（保留本地版本）的会话标题，按包内顺序 */
  skippedTitles: string[]
  /** 需要写入本地存储的会话 id（新增 + 覆盖），按包内顺序 */
  written: string[]
}

/**
 * 批量判定：`localUpdatedAt` 按 id 查本地会话的更新时间（查不到返回 undefined）。
 * **同步**：调用方（`db.mergeStaging`）要在一个 IndexedDB 事务里跑完，查表必须先做完再进来 ——
 * 事务里 await 一个非 IDB 的 Promise，某些实现上会被判成空闲而自动提交。
 * 包内 id 重复属调用方错误（导入端已按条目唯一性拦住），这里按出现顺序逐条判定，不合并。
 */
export const planMerge = (
  incoming: readonly SessionRef[],
  localUpdatedAt: (id: string) => number | undefined,
  policy: MergePolicy
): MergePlan => {
  const plan: MergePlan = { added: 0, overwritten: 0, skipped: 0, skippedTitles: [], written: [] }
  for (const session of incoming) {
    const decision = resolveConflict(localUpdatedAt(session.id), session, policy)
    if (decision === 'added') {
      plan.added += 1
    } else if (decision === 'overwritten') {
      plan.overwritten += 1
    } else {
      plan.skipped += 1
      plan.skippedTitles.push(session.title)
      continue
    }
    plan.written.push(session.id)
  }
  return plan
}
