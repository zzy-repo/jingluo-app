/**
 * 满盘保护（#909）：保存前读剩余空间，低于阈值就让界面升档，而不是等写失败、甚至整库被删之后才知道。
 *
 * 三态，调用方必须能区分：
 *  - `ok`      读到了，且 ≥ 阈值；
 *  - `low`     读到了，且 < 阈值（恰好等于阈值算 ok）；
 *  - `unknown` 读不到（宿主不支持 / 原生调用失败）。**不得当成「空间足够」**：调用方保持现有行为
 *              （既不升档也不清除已有的升档），失败原因记一条去重诊断。
 * 读数缓存 `FREE_SPACE_CACHE_MS`，期间重复调用不再跨桥。
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

  const check = async (): Promise<FreeSpaceResult> => {
    const now = deps.now()
    if (cached && now - cached.at < FREE_SPACE_CACHE_MS) {
      return cached.result
    }
    const result = await measure()
    cached = { at: now, result }
    if (result.status === 'low' && lastStatus !== 'low') {
      noteProtection('free-space-low', { 'protection.freeBytes': result.freeBytes ?? -1, 'protection.minBytes': minBytes })
    }
    if (result.status !== 'unknown') {
      lastStatus = result.status
    }
    return result
  }

  return { check }
}

export type FreeSpace = ReturnType<typeof createFreeSpace>
