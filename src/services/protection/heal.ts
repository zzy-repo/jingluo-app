/**
 * sessionSummaries 自愈（#909 第 5 项）。
 *
 * 摘要是列表的唯一数据源：摘要整表丢了 = 列表空白（看起来像数据全没了），而 `sessions` 里的正文其实还在。
 * 启动时发现「摘要为空而会话非空」或「摘要数 ≠ 会话数」，就按 sessions 重建摘要。
 *
 * 纪律：
 *  - 原子：重建是 `storageAccess.rebuildSummaries()` 的一个原子批，失败整体回滚，摘要保持原样；
 *  - 可重入：同一时刻只跑一轮，并发调用拿到同一个 promise；重复执行结果相同（幂等）；
 *  - 只动摘要，不动会话正文；不会因为摘要对不上就去删会话；
 *  - 失败不抛、不阻断启动：返回 `failed` 并记一条去重诊断，列表保持现状。
 *
 * 已知取舍：摘要数与会话数相等但 id 不同（极罕见）这里发现不了，Storage Module 没有廉价的「只读键」入口；
 * 发现要付出整库读，所以只比数量。
 */
import { reportProtectionFailure } from './diagnostics.js'
import type { ProtectionDeps } from './types.js'

export type HealResult =
  | { status: 'ok'; summaries: number }
  | { status: 'healed'; before: number; after: number }
  | { status: 'failed'; kind: string }
  | { status: 'skipped' }

export const createHeal = (deps: ProtectionDeps) => {
  let running: Promise<HealResult> | undefined

  const run = async (knownSummaries?: number): Promise<HealResult> => {
    if (!deps.storage.available()) {
      return { status: 'skipped' }
    }
    try {
      const summaries = knownSummaries ?? (await deps.storage.countSummaries())
      const sessions = await deps.storage.countSessions()
      if (summaries === sessions) {
        return { status: 'ok', summaries }
      }
      const after = await deps.storage.rebuildSummaries()
      return { status: 'healed', before: summaries, after }
    } catch (error) {
      reportProtectionFailure('heal-summaries', error)
      const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : undefined
      return { status: 'failed', kind: typeof kind === 'string' ? kind : 'unknown' }
    }
  }

  /** 并发调用合并成一轮：启动路径与后台复检可能同时进来 */
  const heal = (knownSummaries?: number): Promise<HealResult> => {
    if (running) {
      return running
    }
    running = run(knownSummaries).finally(() => {
      running = undefined
    })
    return running
  }

  return { heal }
}

export type Heal = ReturnType<typeof createHeal>
