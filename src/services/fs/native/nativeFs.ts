/**
 * Android 原生实现（#907）：桥接 `AppFileSystemPlugin.java`，落在 `getFilesDir()/app-fs/` 下。
 *
 * 字节过桥用 base64（与 ExportText 同口径）。原子写、fsync、ENOSPC 分类都在 Java 侧完成，
 * 这里只做：路径校验（先于过桥）、编解码、首次 I/O 前的能力探测、把 reject 的 `code` 映射成 `FsError.kind`。
 * 这是 fs 模块里唯一可以碰 `@capacitor/*` 的文件（客户端基础设施规范 §2）。Web / iOS 见 `../unsupportedFs.ts`。
 */
import { registerPlugin } from '@capacitor/core'
import { infraErrorOfProbe, probeNativePlugin } from '../../capability/probe.js'
import { infraKindOfRejection } from '../../capability/errors.js'
import { FsError, fromBytes, toBytes, validateFsPath, type AppFileSystem, type FsEntry } from '../types.js'

export const APP_FS_PLUGIN_NAME = 'AppFileSystem'

/** 与 `AppFileSystemPlugin.java` 一一对应的桥接口 */
export interface AppFileSystemBridge {
  writeAtomic(options: { path: string; data: string }): Promise<void>
  read(options: { path: string }): Promise<{ exists: boolean; data?: string }>
  list(options: { dir: string }): Promise<{ entries: FsEntry[] }>
  remove(options: { path: string }): Promise<void>
  freeBytes(): Promise<{ bytes?: number }>
  /** 方法清单（能力探测用，不靠「调了看会不会炸」） */
  capabilities(): Promise<{ methods: string[] }>
  /** 轻量运行时探针：私有目录可创建且可写 */
  ping(): Promise<void>
}

/** 本实现用到的全部桥方法；`capabilities()` 缺任何一个都判 method-missing */
export const REQUIRED_METHODS = ['writeAtomic', 'read', 'list', 'remove', 'freeBytes', 'ping'] as const

export const getNativeBridge = (): AppFileSystemBridge =>
  registerPlugin<AppFileSystemBridge>(APP_FS_PLUGIN_NAME)

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const wrap = async <T>(action: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof FsError) {
      throw error
    }
    const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined
    throw new FsError(infraKindOfRejection(error), `${action} failed: ${typeof message === 'string' ? message : 'unknown'}`, {
      cause: error,
    })
  }
}

/**
 * 首次 I/O 前做一次完整探测（方法清单 + 运行时 ping）。通过后记住；失败不记（瞬时失败下次还能恢复），
 * 并抛对应 kind 的 `FsError`：方法缺失 → unsupported，ping 失败 → unavailable。
 */
const createReadyGate = (bridge: AppFileSystemBridge): (() => Promise<void>) => {
  let verified = false
  return async () => {
    if (verified) {
      return
    }
    const result = await probeNativePlugin(APP_FS_PLUGIN_NAME, {
      bridge,
      methods: REQUIRED_METHODS,
      ping: () => bridge.ping(),
    })
    if (!result.available) {
      const error = infraErrorOfProbe(result, 'app file system')
      throw new FsError(error.kind, error.message)
    }
    verified = true
  }
}

export const createNativeFs = (bridge: AppFileSystemBridge): AppFileSystem => {
  const ready = createReadyGate(bridge)
  return {
    supported: true,
    writeAtomic: async (path, data) => {
      validateFsPath(path)
      const encoded = toBase64(toBytes(data))
      await ready()
      await wrap('writeAtomic', () => bridge.writeAtomic({ path, data: encoded }))
    },
    read: async (path) => {
      validateFsPath(path)
      await ready()
      const result = await wrap('read', () => bridge.read({ path }))
      return result.exists ? fromBase64(result.data ?? '') : undefined
    },
    readText: async (path) => {
      validateFsPath(path)
      await ready()
      const result = await wrap('readText', () => bridge.read({ path }))
      return result.exists ? fromBytes(fromBase64(result.data ?? '')) : undefined
    },
    list: async (dir) => {
      validateFsPath(dir, true)
      await ready()
      const result = await wrap('list', () => bridge.list({ dir }))
      return Array.isArray(result.entries) ? result.entries : []
    },
    remove: async (path) => {
      validateFsPath(path)
      await ready()
      await wrap('remove', () => bridge.remove({ path }))
    },
    freeBytes: async () => {
      await ready()
      const result = await wrap('freeBytes', () => bridge.freeBytes())
      return typeof result.bytes === 'number' && Number.isFinite(result.bytes) ? result.bytes : undefined
    },
  }
}
