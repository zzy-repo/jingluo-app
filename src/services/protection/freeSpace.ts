/**
 * 满盘保护（#909）：保存前读剩余空间，低于阈值就让界面升档，而不是等写失败、甚至整库被删之后才知道。
 *
 * 三态，调用方必须能区分：
 *  - `ok`      读到了，且 ≥ 阈值；
 *  - `low`     读到了，且 < 阈值（恰好等于阈值算 ok）；
 *  - `unknown` 读不到（宿主不支持 / 原生调用失败）。**不得当成「空间足够」**：调用方保持现有行为
 *              （既不升档也不清除已有的升档），失败原因记一条去重诊断。
 * 读数缓存 `FREE_SPACE_CACHE_MS`，期间重复调用不再跨桥；`refresh()` 绕开缓存（写失败后当场重读，#938）。
 *
 * **口径（#938 实测，不要改）**：`deps.fs.freeBytes()` 在原生端读的是 `StatFs.getAvailableBytes()`
 * —— ext4 的 `f_bavail`，即**本进程还能写多少**。不是 `getFreeBytes()`（`f_bfree`）、也不是 `df`：
 * 两者都含 root 保留块，实测保留块约 139MB，`f_bavail = 0`（已经写不进去、报 `ENOSPC` /
 * `SET_UP_METADATA`）时 `f_bfree` / `df` 仍显示上百 MB。换成那个口径的后果是：横幅在「一个字都
 * 写不进去」的那一刻显示还有空间，恰好在最该报警的时候沉默。阈值本身才是可调旋钮
 * （`FREE_SPACE_MIN_BYTES`，改数字只改 constants.ts 一处）。
 */
import { FREE_SPACE_CACHE_MS, FREE_SPACE_MIN_BYTES } from './constants.js'
import { noteProtection, reportProtectionFailure } from './diagnostics.js'
import type { ProtectionDeps } from './types.js'

export type FreeSpaceStatus = 'ok' | 'low' | 'unknown'
export type FreeSpaceResult = { status: FreeSpaceStatus; freeBytes?: number }

export const createFreeSpace = (deps: ProtectionDeps, minBytes: number = FREE_SPACE_MIN_BYTES) => {
  let cached: { at: number; result: FreeSpaceResult } | undefined
  let lastStatus: FreeSpaceStatus | undefined

  const measure = async (): Promise<FreeSpaceResult> => {
    let free: number | undefined
    try {
      free = await deps.fs.freeBytes()
    } catch (error) {
      reportProtectionFailure('free-space', error)
      return { status: 'unknown' }
    }
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) {
      return { status: 'unknown' }
    }
    return { status: free < minBytes ? 'low' : 'ok', freeBytes: free }
  }

  /** 落一次读数：替换缓存 + 「刚变低」记一条诊断（`unknown` 不算状态变化） */
  const publish = (result: FreeSpaceResult, at: number): FreeSpaceResult => {
    cached = { at, result }
    if (result.status === 'low' && lastStatus !== 'low') {
      noteProtection('free-space-low', { 'protection.freeBytes': result.freeBytes ?? -1, 'protection.minBytes': minBytes })
    }
    if (result.status !== 'unknown') {
      lastStatus = result.status
    }
    return result
  }

  const check = async (): Promise<FreeSpaceResult> => {
    const now = deps.now()
    if (cached && now - cached.at < FREE_SPACE_CACHE_MS) {
      return cached.result
    }
    return publish(await measure(), now)
  }

  /**
   * 绕开缓存重读（#938）：写失败之后调用。保存前那次 `check()` 命中的可能是几分钟前的读数，
   * 满盘发生在那之后时，横幅会停在「上次读到的 ok」上 —— 失败是「现在真的写不进去」的铁证，
   * 这一读必须看现实，不能等缓存过期。
   */
  const refresh = async (): Promise<FreeSpaceResult> => publish(await measure(), deps.now())

  return { check, refresh }
}

export type FreeSpace = ReturnType<typeof createFreeSpace>
