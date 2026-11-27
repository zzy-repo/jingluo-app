/**
 * 设置页「本地存储状态」这一节的**纯视图映射**（无 React、无副作用、不碰存储）。
 *
 * 为什么单独一个 `.ts`：这一节要回答的问题（数据升级到哪一步了）只有一个来源 ——
 * 启动闸门的视图（`getGateView()`）与路由结论（`getEngineChoice()`）。把它们判成几个显示态是纯函数，
 * 抽出来就能在 Node 里直接断言，不必渲染组件（与 `logView.ts` / `managedKeyView.ts` 同一套做法）。
 *
 * 面向普通用户：**界面只展示「升级状态」与「确实可用的操作入口」**。
 * 底层存储引擎（SQLite / IndexedDB）属于技术实现，不展示给用户 —— 它只在诊断快照里出现
 * （见 `src/app/diagnosticsContext.ts` 的 `readDiagnosticsFacts()`），供开发排查。
 * `backend` 字段因此保留但**不再渲染**：它是诊断信息的中转，不是用户可见文案。
 *
 * 口径（只读、不猜）：
 *  · 拿不到就报 `unknown`（=「正在检测」），**不**用「大概没问题」之类的话糊过去；
 *  · `unavailable` 只在两种确凿情形出现：宿主没有可用的持久化后端，或本包/本平台没有注册迁移运行时；
 *  · 闸门 `failed` 单独判成 `failed`（「升级失败」）—— 它与「暂未升级」是两件事：
 *    前者是尝试过但失败了，后者是从未迁移；用户看到的下一步动作也不同（前者给重试，后者无操作）；
 *  · 只有 `failed` 允许手动重试，这正是 `retryMigration()` 自带的既有前提（视图不是 failed 时它是 no-op）。
 */
import type { GateView } from '../../services/storage/gate.js'
import type { StorageEngineChoice } from '../../services/storage/migration/types.js'

/**
 * 当前真源后端。`unavailable` = 宿主没有可用的持久化后端（或路由判 blocked）。
 * **仅供诊断使用，不进用户界面。**
 */
export type StorageBackendStatus = 'sqlite' | 'indexeddb' | 'unavailable' | 'unknown'

/** 数据升级状态（用户可见）。`failed` 与 `not-migrated` 必须分开：一个是失败过，一个是没试过 */
export type StorageMigrationStatus =
  | 'migrated'
  | 'not-migrated'
  | 'failed'
  | 'migrating'
  | 'unavailable'
  | 'unknown'

export type StorageStatusInput = {
  view: GateView
  /** 本次启动的路由结论；还没判定出来时是 `undefined` */
  choice: StorageEngineChoice | undefined
  /** 有没有注册迁移运行时（`getStorageRuntime() !== undefined`）：没有 = 本包/本平台没有迁移能力 */
  runtimeRegistered: boolean
  /** 宿主有没有可用的持久化后端（`isStorageAvailable()`，能力探测，不触发打开） */
  storageAvailable: boolean
}

export type StorageStatus = {
  /** 诊断用；界面不展示 */
  backend: StorageBackendStatus
  migration: StorageMigrationStatus
  /** 是否允许「主动重试」：与 `retryMigration()` 的既有前提一致（只在启动迁移失败时） */
  canRetry: boolean
}

/**
 * 后端判定。`choice === undefined` 且没有注册运行时 = 恒为 IndexedDB —— 这是 `storage/index.ts`
 * 里写明的既有契约（`openRouted()` 在 runtime 为空时直接开 IDB），属于**已知事实而不是猜测**。
 */
const backendOf = ({
  choice,
  runtimeRegistered,
  storageAvailable,
}: StorageStatusInput): StorageBackendStatus => {
  if (!storageAvailable) {
    return 'unavailable'
  }
  if (choice === undefined) {
    return runtimeRegistered ? 'unknown' : 'indexeddb'
  }
  if (choice.engine === 'blocked') {
    return 'unavailable'
  }
  return choice.engine
}

const migrationOf = ({
  view,
  choice,
  runtimeRegistered,
  storageAvailable,
}: StorageStatusInput): StorageMigrationStatus => {
  if (!runtimeRegistered) {
    // 没有迁移运行时：这个包/平台压根没有迁移能力
    return 'unavailable'
  }
  if (!storageAvailable) {
    // 宿主没有可用的持久化后端：连真源都读不到，迁移状态无从谈起
    return 'unavailable'
  }
  switch (view.kind) {
    case 'migrating':
      return 'migrating'
    case 'succeeded':
      // 闸门的成功提示态：只可能由 `committed` 产生，且发布前已把路由结论写成 sqlite
      return 'migrated'
    case 'unsupported':
      // 「能迁但 SQLite 运行时缺失」：真源仍是 IndexedDB（闸门里就是 `setEngineChoice(indexeddb)`）。
      // 这里**不用**「不可用」，而是「暂未升级（仍用原存储）」——用户确认后闸门会 settle 成
      // ready + indexeddb，同一个事实不能在两处显示成两个词；「不可用」只留给真没迁移能力/真源不可读。
      return 'not-migrated'
    case 'failed':
      // 尝试过但失败了。真源仍是 IndexedDB（路由第 7 条），但**不能**跟「从未迁移」混成一个词：
      // 用户需要知道「这次升级没成功」，并且这是唯一会出现重试入口的状态。
      return 'failed'
    case 'blocked':
      return 'unavailable'
    case 'checking':
      return 'unknown'
    case 'ready':
      if (choice?.engine === 'sqlite') {
        return 'migrated'
      }
      if (choice?.engine === 'indexeddb') {
        return 'not-migrated'
      }
      // 路由判 blocked（真源暂时不可用）或还没拿到结论：不猜
      return choice?.engine === 'blocked' ? 'unavailable' : 'unknown'
  }
}

export const readStorageStatus = (input: StorageStatusInput): StorageStatus => ({
  backend: backendOf(input),
  migration: migrationOf(input),
  canRetry: input.view.kind === 'failed',
})
