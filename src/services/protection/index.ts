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
import { createHighwater, detectDataLoss, type Highwater } from './highwater.js'
import { createStorageAccess } from './storageAccess.js'
import type { DataLostInfo, ProtectionDeps } from './types.js'

export type { DataLostInfo } from './types.js'

export type Protection = {
  readonly highwater: Highwater
  checkAtStartup(): Promise<DataLostInfo | null>
  afterSave(): Promise<void>
  afterExplicitChange(): Promise<void>
  acknowledgeLoss(): Promise<void>
}

export const createProtection = (deps: ProtectionDeps): Protection => {
  const highwater = createHighwater(deps)

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

  const checkAtStartup = (): Promise<DataLostInfo | null> =>
    guarded(
      'startup-check',
      async () => {
        if (!deps.storage.available()) {
          return null
        }
        const [count, { mark }] = await Promise.all([deps.storage.countSessions(), highwater.read()])
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

  let saving: Promise<void> | undefined
  let dirty = false
  const raise = async (): Promise<void> => {
    do {
      dirty = false
      await guarded(
        'highwater-after-save',
        async () => {
          if (deps.storage.available()) {
            await highwater.write(await deps.storage.countSessions())
          }
        },
        undefined
      )
    } while (dirty)
  }
  /** 保存很频繁：同一时刻只跑一个，期间的再次调用合并成「跑完再来一次」 */
  const afterSave = (): Promise<void> => {
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
          await highwater.write(await deps.storage.countSessions(), { explicit: true, clearLost: true })
        }
      },
      undefined
    )

  return {
    highwater,
    checkAtStartup,
    afterSave,
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

/** 用户显式删除 / 清空 / 导入提交后调用：高水位按实际数更新，待处理的丢失一并清掉 */
export const protectionAfterExplicitChange = async (): Promise<void> => {
  await (await getProtection())?.afterExplicitChange()
}

/** 横幅里「知道了」 */
export const protectionAcknowledgeLoss = async (): Promise<void> => {
  await (await getProtection())?.acknowledgeLoss()
}
