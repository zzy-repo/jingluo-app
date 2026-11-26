/**
 * 迁移与路由的错误（#910）。都是 `InfraError` 子类，`kind` 沿用基础设施口径。
 */
import { InfraError } from '../../capability/errors.js'
import type { MigrationFailure, StorageEngineChoice } from './types.js'

/** 迁移某一步失败，带要写进状态的 `MigrationFailure.code`。 */
export class MigrationStepError extends InfraError {
  readonly code: MigrationFailure['code']
  constructor(code: MigrationFailure['code'], message: string, options?: { cause?: unknown }) {
    super(code === 'insufficient-space' ? 'quota' : code === 'unsupported' ? 'unsupported' : 'unknown', message, options)
    this.name = 'MigrationStepError'
    this.code = code
  }
}

type BlockedChoice = Extract<StorageEngineChoice, { engine: 'blocked' }>

/** 真源不可用，业务读写一律拒绝。绝不回退到旧 IndexedDB、绝不返回内存实现。 */
export class StorageEngineBlockedError extends InfraError {
  readonly reason: BlockedChoice['reason']
  readonly detail: string | undefined
  constructor(reason: BlockedChoice['reason'], detail?: string) {
    super('unavailable', `storage engine blocked: ${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'StorageEngineBlockedError'
    this.reason = reason
    this.detail = detail
  }
}

/** 迁移进行中，业务不得读写存储（启动闸门之后才会放行）。 */
export class StorageMigratingError extends InfraError {
  constructor() {
    super('unavailable', 'storage is migrating; business reads/writes are rejected until the migration finishes')
    this.name = 'StorageMigratingError'
  }
}

/** 进程被杀的测试替身标记：编排器见到它必须原样抛出，不写 `failed`（真杀进程什么都来不及写）。 */
export const isKilled = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true
