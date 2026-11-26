/**
 * 应用内部文件系统端口（#907，本期只含 Storage Protection #909 需要的最小能力）。
 *
 * 边界：
 * - 所有路径都相对「应用私有目录」（Android：`getFilesDir()/app-fs`），不碰外部存储、不碰 SAF；
 *   文件选择 / 导出 / 外部接收属于 HostFiles（#908），不在这里。
 * - 本目录不得 import react / zustand / components / app / i18n / diagnostics。
 *   只有 `native/` 下的文件可以碰 `@capacitor/*`（客户端基础设施规范 §2）。
 */
import { InfraError, type InfraErrorKind } from '../capability/errors.js'

/** 文件系统失败分类：就是基础设施统一的 `InfraErrorKind`（与 `StorageFailureKind` 兼容：quota / unavailable / unknown 同义） */
export type FsErrorKind = InfraErrorKind

/**
 * 文件系统失败。`kind`：磁盘满 → quota；宿主没有此能力（Web / iOS / 插件缺失）→ unsupported；
 * 权限不足 → permission；运行时暂不可用 → unavailable；其余 → unknown。
 */
export class FsError extends InfraError {
  constructor(kind: FsErrorKind, message: string, options?: { cause?: unknown }) {
    super(kind, message, options)
    this.name = 'FsError'
  }
}

/** 路径不合法（绝对路径 / `..` / 空段 / NUL / 反斜杠）。调用方 bug，不是环境问题。 */
export class FsPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsPathError'
  }
}

export type FsEntry = { name: string; size: number; modifiedAt: number }

/**
 * 应用私有目录文件系统端口。契约由 `tests/helpers/fs-contract/` 钉住，实现必须全部通过。
 *
 * 路径规则：相对路径，以 `/` 分段；拒绝绝对路径、`.` / `..` 段、空段（含首尾 `/`、`//`）、NUL、`\`，
 * 违反抛 `FsPathError`（先于任何 I/O）。`list('')` 例外：空串表示根目录。
 */
export interface AppFileSystem {
  /** false = 本宿主没有私有文件系统（Web / iOS / 插件缺失）；此时所有 I/O 方法抛 `FsError('unsupported')`，绝不降级到内存 */
  readonly supported: boolean
  /**
   * 原子写：同目录临时文件 → fsync → rename 覆盖目标。
   * 失败（含磁盘满、写到一半崩溃）不留半成品、不破坏旧文件。父目录不存在时自动创建。
   */
  writeAtomic(path: string, data: Uint8Array | string): Promise<void>
  /** 不存在返回 undefined */
  read(path: string): Promise<Uint8Array | undefined>
  /** UTF-8 文本；不存在返回 undefined */
  readText(path: string): Promise<string | undefined>
  /** 只列直接子文件（不含子目录、不含内部临时文件）；目录不存在返回 [] */
  list(dir: string): Promise<FsEntry[]>
  /** 删文件，或递归删目录；不存在不抛 */
  remove(path: string): Promise<void>
  /** 私有目录所在分区剩余字节；不支持返回 undefined */
  freeBytes(): Promise<number | undefined>
}

/** 内部临时文件后缀。写入过程中的临时文件以它结尾，`list()` 不返回，调用方也不能直接用它命名文件。 */
export const FS_TMP_SUFFIX = '.fstmp'

/** 校验并规范化相对路径；`allowRoot` 仅 `list` 使用。返回分段后的规范路径。 */
export const validateFsPath = (path: unknown, allowRoot = false): string => {
  if (typeof path !== 'string') {
    throw new FsPathError('path must be a string')
  }
  if (path === '') {
    if (allowRoot) {
      return ''
    }
    throw new FsPathError('path must not be empty')
  }
  if (path.includes('\0')) {
    throw new FsPathError('path must not contain NUL')
  }
  if (path.includes('\\')) {
    throw new FsPathError('path must not contain backslash')
  }
  if (path.startsWith('/')) {
    throw new FsPathError('path must be relative')
  }
  for (const segment of path.split('/')) {
    if (segment === '') {
      throw new FsPathError('path must not contain empty segments')
    }
    if (segment === '.' || segment === '..') {
      throw new FsPathError('path must not contain . or .. segments')
    }
  }
  if (path.endsWith(FS_TMP_SUFFIX)) {
    throw new FsPathError(`path must not end with ${FS_TMP_SUFFIX}`)
  }
  return path
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const toBytes = (data: Uint8Array | string): Uint8Array =>
  typeof data === 'string' ? encoder.encode(data) : data

export const fromBytes = (bytes: Uint8Array): string => decoder.decode(bytes)
