/**
 * Storage Protection 运行时入口（#909）。store 只经这里接入：
 *   · `checkAtStartup()`   启动读库后：库从有到无 → 返回 DataLostInfo（store 置 `dataLost`）
 *   · `afterSave()`        saveSession 成功后：抬高高水位（只升不降）
 *   · `afterExplicitChange()`  用户显式删除 / 清空 / 整包导入提交后：按实际数更新高水位并清掉待处理的丢失
 *   · `acknowledgeLoss()`  用户在横幅里点「知道了」：同上
 *
 * 保护层的任何故障都不许打断主流程：这里的方法都不抛（内部吞掉并留一条去重的诊断）。
 * 宿主没有 IndexedDB（单测 / 极端环境）时整体是 no-op。
 */
import { InfraError } from '../capability/errors.js'
import { reportProtectionFailure } from './diagnostics.js'
import { createFreeSpace, type FreeSpaceResult } from './freeSpace.js'
import { createHeal, type HealResult } from './heal.js'
import { createHighwater, detectDataLoss, type Highwater } from './highwater.js'
import { createRestore, type RestorableSnapshot, type RestoreOptions, type RestoreResult } from './restore.js'
import { createSnapshots, type SnapshotWriteResult, type Snapshots } from './snapshot.js'
import { createStorageAccess } from './storageAccess.js'
import type { DataLostInfo, ProtectionDeps } from './types.js'

export type { DataLostInfo } from './types.js'

export type Protection = {
  readonly highwater: Highwater
  readonly snapshots: Snapshots
  /** 保存前读剩余空间（缓存 10s）：ok / low / unknown，unknown 不得当成「足够」 */
  checkFreeSpace(): Promise<FreeSpaceResult>
  /** 摘要自愈：摘要数与会话数不一致就按 sessions 原子重建。不抛 */
  healSummaries(knownSummaries?: number): Promise<HealResult>
  listRestorable(): Promise<RestorableSnapshot[]>
  restore(name: string, options: RestoreOptions): Promise<RestoreResult>
  checkAtStartup(): Promise<DataLostInfo | null>
  /** saveSession 成功后：抬高水位 + 尝试快照（节流）。返回快照结果，调用方一般不需要等 */
  afterSave(options?: { flush?: boolean }): Promise<SnapshotWriteResult | null>
  /** 会话结束 / 切后台：绕过节流写一份快照 */
  flushSnapshot(): Promise<SnapshotWriteResult | null>
  afterExplicitChange(): Promise<void>
  acknowledgeLoss(): Promise<void>
}

export const createProtection = (deps: ProtectionDeps): Protection => {
  const highwater = createHighwater(deps)
  const snapshots = createSnapshots(deps)
  const freeSpace = createFreeSpace(deps)
  const restoring = createRestore(deps, snapshots)
  const healing = createHeal(deps)

  const guarded = async <T>(stage: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      // 高水位写/读失败已在 highwater.ts 里记过诊断；这里兜住其余意外
      if (!(error instanceof InfraError)) {
        reportProtectionFailure(stage, error)
      }
      return fallback
    }
  }

  /**
   * 当前会话数。摘要是小记录，读它便宜；摘要为 0 时才分页数真会话（空库 / 摘要缺失两种情形，
   * 都不会很大）。摘要多于会话（幽灵摘要）只会让高水位偏高一点，`summaries 自愈` 会把它收敛。
   */
  const currentCount = async (): Promise<number> => {
    const summaries = await deps.storage.countSummaries()
    return summaries > 0 ? summaries : deps.storage.countSessions()
  }

  const checkAtStartup = (): Promise<DataLostInfo | null> =>
    guarded(
      'startup-check',
      async () => {
        if (!deps.storage.available()) {
          return null
        }
        const [count, { mark }] = await Promise.all([currentCount(), highwater.read()])
        const verdict = detectDataLoss(count, mark)
        if (verdict.lost) {
          if (verdict.fresh) {
            // 把「已判定丢失」写进标记：用户忽略横幅、新建一条会话后，下次启动仍要提醒
            await guarded('highwater-mark-lost', () => highwater.write(count, { markLost: verdict.expectedSessions }), null)
          }
          return { expectedSessions: verdict.expectedSessions, lastSeenAt: verdict.lastSeenAt }
        }
        if (count > 0) {
          await highwater.write(count)
        }
        return null
      },
      null
    )

  let saving: Promise<SnapshotWriteResult | null> | undefined
  let dirty = false
  let pendingFlush = false
  const raise = async (): Promise<SnapshotWriteResult | null> => {
    let snapshot: SnapshotWriteResult | null = null
    do {
      const flush = pendingFlush
      dirty = false
      pendingFlush = false
      await guarded(
        'highwater-after-save',
        async () => {
          if (deps.storage.available()) {
            await highwater.write(await currentCount())
          }
        },
        undefined
      )
      // 快照读的是「现在」的库：合并期间又有保存就再来一轮，最后一轮的结果才算数
      // 已判定「库从有到无」、等用户处理期间暂停自动快照：新数据不该把还能恢复的旧快照轮转掉
      const suspended = await guarded('snapshot-suspend-check', () => highwater.lostPending(), false)
      snapshot = suspended
        ? { status: 'suspended' }
        : await guarded('snapshot-after-save', () => snapshots.write({ force: flush }), {
            status: 'failed',
            kind: 'unknown',
          })
    } while (dirty)
    return snapshot
  }
  /**
   * 保存很频繁：同一时刻只跑一个，期间的再次调用合并成「跑完再来一次」，
   * 全部返回同一个 promise —— 调用方 fire-and-forget，不占输入路径。
   */
  const afterSave = (options: { flush?: boolean } = {}): Promise<SnapshotWriteResult | null> => {
    if (options.flush) {
      pendingFlush = true
    }
    if (saving) {
      dirty = true
      return saving
    }
    saving = raise().finally(() => {
      saving = undefined
    })
    return saving
  }

  const settle = (stage: string): Promise<void> =>
    guarded(
      stage,
      async () => {
        if (deps.storage.available()) {
          await highwater.write(await currentCount(), { explicit: true, clearLost: true })
        }
      },
      undefined
    )

  return {
    highwater,
    snapshots,
    checkFreeSpace: freeSpace.check,
    healSummaries: healing.heal,
    listRestorable: restoring.list,
    restore: restoring.restore,
    checkAtStartup,
    afterSave,
    flushSnapshot: () => afterSave({ flush: true }),
    afterExplicitChange: () => settle('highwater-after-explicit'),
    acknowledgeLoss: () => settle('highwater-acknowledge'),
  }
}

let instance: Protection | undefined | null

const localStorageOrUndefined = () => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * 进程内单例。`fs` 模块**动态加载**：它带着原生桥（`@capacitor/core` 的 `registerPlugin`），
 * 加载失败（缺桥 / 单测里被替身顶掉）就让保护层整体不可用，而不是让 store 的模块求值炸掉。
 */
export const getProtection = async (): Promise<Protection | null> => {
  if (instance !== undefined) {
    return instance
  }
  try {
    if (typeof indexedDB === 'undefined') {
      return null
    }
    const { getFs } = await import('../fs/index.js')
    instance = createProtection({
      fs: getFs(),
      storage: createStorageAccess(),
      now: () => Date.now(),
      local: localStorageOrUndefined(),
    })
  } catch (error) {
    reportProtectionFailure('init', error)
    instance = null
  }
  return instance
}

/** 仅测试用：注入 / 清空单例（`undefined` = 下次重新构造） */
export const setProtectionForTests = (value: Protection | null | undefined): void => {
  instance = value
}

// ---- store 的接入点：一行一个，不抛、不阻塞调用方 ----

/** 启动：返回 dataLost 判定。只有「库里没有会话」时才需要在渲染前拿到结论，其余情形只更新标记 */
export const protectionCheckAtStartup = async (): Promise<DataLostInfo | null> =>
  (await getProtection())?.checkAtStartup() ?? null

/** saveSession 成功后调用（fire-and-forget） */
export const protectionAfterSave = (): void => {
  void getProtection().then((protection) => protection?.afterSave())
}

/** 启动自愈摘要：保护层不可用时返回 null（= 没做，调用方保持现状） */
export const protectionHealSummaries = async (knownSummaries?: number): Promise<HealResult | null> =>
  (await getProtection())?.healSummaries(knownSummaries) ?? null

export type { HealResult } from './heal.js'

/** 可恢复的快照列表（Web / 不支持 / 保护层不可用 = 空列表） */
export const protectionListRestorable = async (): Promise<RestorableSnapshot[]> =>
  (await getProtection())?.listRestorable() ?? []

/** 从快照恢复。调用方（UI）必须先让用户确认；`commit` 由 store 注入整包替换通道 */
export const protectionRestore = async (name: string, options: RestoreOptions): Promise<RestoreResult> =>
  (await getProtection())?.restore(name, options) ?? { status: 'failed', kind: 'unsupported' }

export type { RestorableSnapshot, RestoreOptions, RestoreProgress, RestoreResult } from './restore.js'

/** 保存前读剩余空间；保护层不可用时返回 null（= 不知道，调用方保持现状） */
export const protectionCheckFreeSpace = async (): Promise<FreeSpaceResult | null> =>
  (await getProtection())?.checkFreeSpace() ?? null

export type { FreeSpaceResult } from './freeSpace.js'

/** 切后台 / 会话结束：绕过快照节流（fire-and-forget） */
export const protectionFlushSnapshot = (): void => {
  void getProtection().then((protection) => protection?.flushSnapshot())
}

/** 用户显式删除 / 清空 / 导入提交后调用：高水位按实际数更新，待处理的丢失一并清掉 */
export const protectionAfterExplicitChange = async (): Promise<void> => {
  await (await getProtection())?.afterExplicitChange()
}

/** 横幅里「知道了」 */
export const protectionAcknowledgeLoss = async (): Promise<void> => {
  await (await getProtection())?.acknowledgeLoss()
}
