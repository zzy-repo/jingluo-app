import type { AppFileSystem } from '../fs/types.js'

/**
 * Storage Protection 需要的存储能力（窄接口）。
 *
 * 实现只有 `storageAccess.ts` 一个文件（protection/** 里唯一碰 `chat/db.ts` 的地方），
 * #906 的 Storage Module 合入后只需把那一个文件换成 `getStorage()`。
 * 其余模块只依赖这个接口，所以单测可以注入内存实现。
 */
export interface ProtectionStorage {
  /** 当前库结构版本（写进高水位 / 快照头部） */
  readonly schemaVersion: number
  /** IndexedDB 是否可用；不可用时保护层整体跳过（主流程自己会报「读库失败」） */
  available(): boolean
  /** `sessions` store 的记录数（不是摘要数） */
  countSessions(): Promise<number>
}

/** Web 端高水位标记的存放处（localStorage 的最小子集）；原生端不使用它 */
export type LocalMarkerStore = Pick<Storage, 'getItem' | 'setItem'>

export type ProtectionDeps = {
  fs: AppFileSystem
  storage: ProtectionStorage
  now: () => number
  /** 只在 `fs.supported === false`（Web）时使用；缺省 = 连 localStorage 都没有 */
  local: LocalMarkerStore | undefined
}

/** 「库从有到无」的判定结果：给 store / 横幅用 */
export type DataLostInfo = {
  /** 高水位记录的会话数（丢之前本机至少有这么多条） */
  expectedSessions: number
  /** 标记最后一次写入的时间（≈ 数据最后一次存在的时间） */
  lastSeenAt: number
}
