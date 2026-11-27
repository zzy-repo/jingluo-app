import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * 原生备份目录的文件出口（Issue #993 任务 2）。
 *
 * 这一层只做一件事：把 {@link BackupFilePlugin} 的分块读写包成 Promise，并把原生错误码原样带出来
 * （`code` 字段，供上层分类成人话）。**它不含任何备份语义** —— 清单、保留策略、校验判定都在
 * `backupApi.ts`，这里不认识「备份」这个概念，只认识文件。
 *
 * 三条纪律：
 *  1. **不把整档读进内存**：写走 `blob.slice()` 逐块（默认 48KiB），读走 `readChunk` 偏移读；
 *  2. **让出事件循环**：每写若干块 `setTimeout 0` 让一次，聊天生成与界面不被备份挤出帧；
 *  3. **失败只清临时文件**：原生侧 `abort()` 只删 `.part`，已提交的备份一个字节都不动。
 */

/** 目录里的一份正式文件（`.part` 不出现）。 */
export type NativeFileEntry = { name: string; sizeBytes: number; mtimeMs: number }

/** 一次成功落盘的文件：`sha256` 由原生侧对**磁盘上的字节**重算并校验过。 */
export type WrittenFile = { name: string; sizeBytes: number; sha256: string }

interface BackupFileBridge {
  /** `allowOverwrite` 只为状态文件而存在：原生侧只对白名单名字（`status.json`）放行同名替换。 */
  begin(options: { name: string; allowOverwrite?: boolean }): Promise<{ name: string }>
  writeChunk(options: { data: string }): Promise<void>
  finish(options: { name: string }): Promise<WrittenFile>
  abort(): Promise<void>
  list(): Promise<{ files: NativeFileEntry[] }>
  readChunk(options: { name: string; offset: number; length: number }): Promise<{ data: string; eof: boolean }>
  hash(options: { name: string }): Promise<{ sha256: string; sizeBytes: number }>
  remove(options: { name: string }): Promise<void>
  freeBytes(): Promise<{ bytes: number }>
}

const bridge = registerPlugin<BackupFileBridge>('BackupFile')

/** 单块原始字节数：与历史归档导出同一个 48KiB，单次过桥的数据量与整包大小无关。 */
export const CHUNK_BYTES = 48 * 1024
/** 每写多少块让出一个宏任务（约 2MB）：`setTimeout 0` 而不是微任务，渲染才有机会插队。 */
const YIELD_EVERY_CHUNKS = 40

/** 进度回调：`stage` 由调用方定义（写 / 读 / 校验），这里只报「已处理多少字节」。 */
export type NativeProgress = (done: number, total: number, stage: string) => void

/** 宿主没有这个原生出口（Web / 老壳）：备份功能整体不可用，调用方据此给出「本设备不支持」。 */
export class BackupStorageUnavailableError extends Error {
  readonly code = 'UNSUPPORTED'

  constructor() {
    super('Native backup storage is not available on this platform')
    this.name = 'BackupStorageUnavailableError'
  }
}

/** 能力探测：只有原生平台才有 App 私有目录。**不缓存** —— 平台判定本身是常量级开销。 */
export const isBackupStorageAvailable = (): boolean => Capacitor.isNativePlatform()

const requireNative = (): void => {
  if (!isBackupStorageAvailable()) {
    throw new BackupStorageUnavailableError()
  }
}

/** 原生 / 网络错误的 `code`（`NO_SPACE` / `CHECKSUM_MISMATCH` / …），没有则 undefined。 */
export const nativeCodeOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) {
      return code
    }
  }
  return undefined
}

const isNotFound = (error: unknown): boolean => nativeCodeOf(error) === 'NOT_FOUND'

const yieldMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/** 字节 → base64：按 32KiB 分批 `String.fromCharCode`，避免把整段字节摊进一次调用参数。 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const fromBase64 = (data: string): Uint8Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * 原子写入一份文件：`begin` → 逐块 `writeChunk` → `finish`（原生侧重读校验 + rename）。
 *
 * 任何一步失败都 `abort()` 只删临时文件再抛出 —— 上一份有效备份不受影响。
 * 返回的 `sha256` 是原生侧对落盘内容重算的结果，上层把它写进清单。
 *
 * `allowOverwrite` **只给状态文件用**（它是可变状态，不是备份）：原生侧收到 true 也只是「不再因
 * 同名而提前拒绝」，名字不在白名单里照样 `TARGET_EXISTS`。真正的替换发生在 `finish` 的
 * `rename(2)`，rename 成功之前旧文件一直可读 —— 所以任何一步失败都不会让旧文件消失。
 */
export const writeFileAtomically = async (options: {
  name: string
  blob: Blob
  onProgress?: NativeProgress
  allowOverwrite?: boolean
}): Promise<WrittenFile> => {
  requireNative()
  const { name, blob, onProgress, allowOverwrite } = options
  const total = blob.size
  await bridge.begin({ name, allowOverwrite: allowOverwrite === true })
  try {
    let chunks = 0
    for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
      const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, total))
      const bytes = new Uint8Array(await slice.arrayBuffer())
      await bridge.writeChunk({ data: toBase64(bytes) })
      onProgress?.(Math.min(offset + bytes.length, total), total, 'write')
      chunks += 1
      if (chunks % YIELD_EVERY_CHUNKS === 0) {
        await yieldMacrotask()
      }
    }
    return await bridge.finish({ name })
  } catch (error) {
    await bridge.abort().catch(() => {})
    throw error
  }
}

/** 整档摘要（恢复前校验）：原生侧流式读一遍，不经过 JS 内存。 */
export const hashFile = (name: string): Promise<{ sha256: string; sizeBytes: number }> => {
  requireNative()
  return bridge.hash({ name })
}

/**
 * 把一份文件读成 Blob（恢复时喂给导入链路）：按偏移逐块读，**每块之间让出事件循环**。
 *
 * 说明（未测边界）：读完后仍然是一份完整的 Blob 驻留内存 —— 导入链路（`readArchive`）吃的是
 * `File`，要彻底避免这一步需要原生侧直接解析 ZIP，超出本单范围；块大小与让出策略保证的是
 * 「不把整档塞进一次过桥调用」和「读的过程中界面不假死」。
 */
export const readFileBlob = async (options: {
  name: string
  sizeBytes: number
  onProgress?: NativeProgress
}): Promise<Blob> => {
  requireNative()
  const { name, sizeBytes, onProgress } = options
  const parts: BlobPart[] = []
  let offset = 0
  let chunks = 0
  while (offset < sizeBytes) {
    const { data, eof } = await bridge.readChunk({
      name,
      offset,
      length: Math.min(CHUNK_BYTES, sizeBytes - offset),
    })
    const bytes = fromBase64(data)
    if (bytes.length === 0) {
      break
    }
    // 复制到独立的 ArrayBuffer 再进 Blob：BlobPart 只接受 ArrayBuffer 支撑的视图
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    parts.push(buffer)
    offset += bytes.length
    onProgress?.(Math.min(offset, sizeBytes), sizeBytes, 'read')
    chunks += 1
    if (chunks % YIELD_EVERY_CHUNKS === 0) {
      await yieldMacrotask()
    }
    if (eof) {
      break
    }
  }
  if (offset < sizeBytes) {
    // 短读 = 文件被截断，不是「读完了」：交给上层按损坏处理
    throw Object.assign(new Error('Backup file is shorter than expected'), { code: 'SHORT_READ' })
  }
  return new Blob(parts, { type: 'application/zip' })
}

/** 读一份小文本文件（清单 / 状态）；不存在返回 null。 */
export const readTextFile = async (name: string): Promise<string | null> => {
  requireNative()
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    let chunk: { data: string; eof: boolean }
    try {
      chunk = await bridge.readChunk({ name, offset, length: CHUNK_BYTES })
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }
      throw error
    }
    const bytes = fromBase64(chunk.data)
    if (bytes.length === 0) {
      break
    }
    parts.push(bytes)
    offset += bytes.length
    if (chunk.eof || offset > 4 * 1024 * 1024) {
      break
    }
  }
  const merged = new Uint8Array(offset)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return new TextDecoder().decode(merged)
}

/** 目录里已有的正式文件。 */
export const listFiles = async (): Promise<NativeFileEntry[]> => {
  requireNative()
  const { files } = await bridge.list()
  return files
}

/** 删一份文件（保留策略由上层决定删哪些，这里只执行）。 */
export const removeFile = async (name: string): Promise<void> => {
  requireNative()
  await bridge.remove({ name })
}

/** 可用字节数；原生读不到时返回 `null`（调用方按「未知」处理，不要当成 0）。 */
export const availableBytes = async (): Promise<number | null> => {
  if (!isBackupStorageAvailable()) {
    return null
  }
  try {
    const { bytes } = await bridge.freeBytes()
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : null
  } catch {
    return null
  }
}
