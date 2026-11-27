/**
 * 内存文件系统：测试替身，同时是 `AppFileSystem` 契约的第一个被测实现（#907）。
 *
 * 为了能验证「原子」，它不是一个裸 Map：写入走和原生实现同样的三步 ——
 * 临时文件落盘 → （模拟 fsync）→ rename 覆盖。临时文件与正式文件在同一张表里，
 * 失败注入点落在这三步之间，所以「写到一半崩溃」时旧文件是否完好是被真实检验的，不是被假设的。
 */
import {
  FS_TMP_SUFFIX,
  FsError,
  fromBytes,
  toBytes,
  validateFsPath,
  type AppFileSystem,
  type FsEntry,
} from './types.js'

type MemoryFile = { data: Uint8Array; modifiedAt: number }

export type MemoryFsOptions = {
  /** `freeBytes()` 的返回值；默认 1 GiB。传 `null` 表示该实现不支持（返回 undefined） */
  freeBytes?: number | null
  now?: () => number
}

export interface MemoryFs extends AppFileSystem {
  /** 下一次 `writeAtomic` 在临时文件写入阶段抛 ENOSPC（→ `FsError('quota')`），一次性 */
  injectEnospc(): void
  /** 下一次 `writeAtomic` 在临时文件只写了一半、rename 之前崩溃（→ `FsError('unknown')`），一次性 */
  injectCrashMidWrite(): void
  /** 下一次 `writeAtomic` 以任意其他原因失败（→ `FsError('unavailable')`），一次性 */
  injectUnavailable(): void
  /** 目前残留的内部临时文件名（`list()` 看不到它们）；契约用它断言「失败不留半成品」 */
  tempFiles(): string[]
}

type Injection = 'enospc' | 'crash' | 'unavailable'

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const createMemoryFs = (options: MemoryFsOptions = {}): MemoryFs => {
  const files = new Map<string, MemoryFile>()
  const now = options.now ?? (() => Date.now())
  let pending: Injection | undefined
  let tmpCounter = 0

  const takeInjection = (): Injection | undefined => {
    const current = pending
    pending = undefined
    return current
  }

  const writeAtomic = async (path: string, data: Uint8Array | string): Promise<void> => {
    validateFsPath(path)
    const bytes = toBytes(data).slice()
    const injection = takeInjection()
    // 1. 临时文件：与目标同目录，名字带自增序号，不会撞上调用方的正式文件
    tmpCounter += 1
    const tmpPath = `${path}.${tmpCounter}${FS_TMP_SUFFIX}`
    try {
      if (injection === 'enospc') {
        // 磁盘满发生在写临时文件时：先落下一截（真实文件系统也会留下半截），再抛
        files.set(tmpPath, { data: bytes.slice(0, Math.floor(bytes.length / 2)), modifiedAt: now() })
        throw new FsError('quota', 'ENOSPC: no space left on device')
      }
      if (injection === 'unavailable') {
        throw new FsError('unavailable', 'storage unavailable')
      }
      if (injection === 'crash') {
        files.set(tmpPath, { data: bytes.slice(0, Math.floor(bytes.length / 2)), modifiedAt: now() })
        throw new FsError('unknown', 'crashed mid-write')
      }
      files.set(tmpPath, { data: bytes, modifiedAt: now() })
      // 2. fsync：内存里无事可做，保留步骤名以对齐原生实现
      // 3. rename：同一张表内一步替换，目标要么是旧内容、要么是新内容
      files.set(path, { data: bytes, modifiedAt: now() })
      files.delete(tmpPath)
    } catch (error) {
      files.delete(tmpPath)
      throw error
    }
  }

  const read = async (path: string): Promise<Uint8Array | undefined> => {
    validateFsPath(path)
    const file = files.get(path)
    return file ? file.data.slice() : undefined
  }

  const readText = async (path: string): Promise<string | undefined> => {
    const bytes = await read(path)
    return bytes ? fromBytes(bytes) : undefined
  }

  const list = async (dir: string): Promise<FsEntry[]> => {
    validateFsPath(dir, true)
    const entries: FsEntry[] = []
    for (const [path, file] of files) {
      if (path.endsWith(FS_TMP_SUFFIX) || parentOf(path) !== dir) {
        continue
      }
      entries.push({ name: baseOf(path), size: file.data.length, modifiedAt: file.modifiedAt })
    }
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }

  const remove = async (path: string): Promise<void> => {
    validateFsPath(path)
    files.delete(path)
    const prefix = `${path}/`
    for (const key of [...files.keys()]) {
      if (key.startsWith(prefix)) {
        files.delete(key)
      }
    }
  }

  const freeBytes = async (): Promise<number | undefined> =>
    options.freeBytes === null ? undefined : (options.freeBytes ?? 1024 * 1024 * 1024)

  return {
    supported: true,
    writeAtomic,
    read,
    readText,
    list,
    remove,
    freeBytes,
    injectEnospc: () => {
      pending = 'enospc'
    },
    injectCrashMidWrite: () => {
      pending = 'crash'
    },
    injectUnavailable: () => {
      pending = 'unavailable'
    },
    tempFiles: () => [...files.keys()].filter((key) => key.endsWith(FS_TMP_SUFFIX)),
  }
}
