/**
 * protection/** 与存储之间**唯一**的接触面（规范 §7）：只经 Storage Module 的公开入口 `getStorage()`，
 * 不 import `chat/db.ts`（#917 的 storage-boundary 门禁）。
 */
import { getStorage } from '../storage/index.js'
import type { Session } from '../chat/types.js'
import type { ProtectionStorage } from './types.js'

/**
 * 库结构版本，写进高水位 / 快照头部，仅用于诊断与「快照来自更新版本的库」的提示。
 * Storage Module 目前不对外暴露版本号，这里是第二处来源：`tests/unit/protection-storage-909.test.mjs`
 * 把它与 `chat/db.ts` 的 `DB_VERSION` 钉在一起，schema 升级时那条用例会红，提醒同步改这里。
 */
export const PROTECTION_SCHEMA_VERSION = 15

/** 分页读会话的页大小：一次只把这么多条完整会话放进内存 */
const PAGE = 100

const eachSessionPage = async (visit: (page: readonly Session[]) => void): Promise<void> => {
  const { sessions } = await getStorage()
  let after: string | undefined
  for (;;) {
    const page = await sessions.listFull(after === undefined ? { limit: PAGE } : { after, limit: PAGE })
    visit(page.items)
    if (page.next === null) {
      return
    }
    after = page.next
  }
}

/**
 * 按 sessions 重建 sessionSummaries：**一个原子批**（`runAtomic`），失败整体回滚，重复执行结果相同。
 *  1. 逐页把每条会话重新 `save`（会话与摘要一起写，摘要含 `fileIds` 索引字段）；
 *  2. 再删掉「没有对应会话」的幽灵摘要（`delete` 对不存在的会话只清摘要与它名下的记忆）。
 * 顺序不能反：先写好真实摘要，幽灵摘要删原件时的「是否还有人引用」才数得对。
 */
const rebuildSummaries = async (): Promise<number> => {
  const storage = await getStorage()
  return storage.runAtomic(async (repos) => {
    const ids = new Set<string>()
    let after: string | undefined
    for (;;) {
      const page = await repos.sessions.listFull(after === undefined ? { limit: PAGE } : { after, limit: PAGE })
      for (const session of page.items) {
        ids.add(session.id)
        await repos.sessions.save(session)
      }
      if (page.next === null) {
        break
      }
      after = page.next
    }
    for (const summary of await repos.sessions.listSummaries()) {
      if (!ids.has(summary.id)) {
        await repos.sessions.delete(summary.id)
      }
    }
    return ids.size
  })
}

export const createStorageAccess = (): ProtectionStorage => ({
  schemaVersion: PROTECTION_SCHEMA_VERSION,
  available: () => typeof indexedDB !== 'undefined',
  countSessions: async () => {
    let count = 0
    await eachSessionPage((page) => {
      count += page.length
    })
    return count
  },
  countSummaries: async () => (await (await getStorage()).sessions.listSummaries()).length,
  loadSessions: async () => {
    const all: Session[] = []
    await eachSessionPage((page) => {
      all.push(...page)
    })
    return all
  },
  loadSummaries: async () => (await getStorage()).sessions.listSummaries(),
  rebuildSummaries,
  stageSession: async (session) => (await getStorage()).staging.addSession(session),
})
