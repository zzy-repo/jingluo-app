/**
 * 基础设施统一错误（客户端基础设施规范 §4/§5）：错误类型与 `kind` 映射全仓只有这一份。
 *
 * `kind` 与 `StorageFailureKind`（chat/db.ts：quota / clone / unavailable / unknown）口径兼容：
 * 共有的三类含义相同，这里只做加法（`unsupported`、`permission`），不含存储专有的 `clone`。
 *
 * 本目录不 import chat/db.ts：能力层不依赖具体存储实现。
 */
export type InfraErrorKind = 'unsupported' | 'permission' | 'quota' | 'unavailable' | 'unknown'

export const INFRA_ERROR_KINDS: readonly InfraErrorKind[] = [
  'unsupported',
  'permission',
  'quota',
  'unavailable',
  'unknown',
]

export class InfraError extends Error {
  readonly kind: InfraErrorKind
  constructor(kind: InfraErrorKind, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'InfraError'
    this.kind = kind
    if (options && options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

export const isInfraError = (value: unknown): value is InfraError =>
  value instanceof InfraError

/**
 * 原生插件 reject 的 `code` → `kind`（Android 插件约定的码：QUOTA / PERMISSION / UNAVAILABLE；
 * Capacitor 自己对未实现的方法 reject 的是 UNIMPLEMENTED）。其余一律 unknown。
 */
export const infraKindOfRejection = (error: unknown): InfraErrorKind => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  switch (code) {
    case 'QUOTA':
      return 'quota'
    case 'PERMISSION':
      return 'permission'
    case 'UNAVAILABLE':
      return 'unavailable'
    case 'UNIMPLEMENTED':
      return 'unsupported'
    default:
      return 'unknown'
  }
}
