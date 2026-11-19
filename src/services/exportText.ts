import { Capacitor, registerPlugin } from '@capacitor/core'

/** 保存结果：`name` 是真正落盘的文件名（SAF 可能按重名规则改名），Web 侧为 null。 */
export type SaveResult = { status: 'saved' | 'cancelled'; name?: string | null }

interface ExportTextBridge {
  start(options: {
    name: string
    mimeType: string
    /** true = 二进制模式（只接受 application/zip，上限按归档算） */
    binary?: boolean
  }): Promise<{ id?: string; status?: 'ready' | 'cancelled' }>
  writeChunk(options: { id: string; data: string }): Promise<void>
  writeBinaryChunk(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ status: 'saved' | 'cancelled'; name?: string | null }>
  abort(options: { id: string }): Promise<void>
}

const nativeExport = registerPlugin<ExportTextBridge>('ExportText')
const CHUNK_BYTES = 48 * 1024

const chunkUtf8 = (text: string): string[] => {
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (current && bytes + size > CHUNK_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current) {
    chunks.push(current)
  }
  return chunks
}

/** 字节 → base64。按 32KiB 分批 String.fromCharCode，避免把整段字节摊进一次调用参数。 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/**
 * 原生保存的唯一控制流：开面板 → 分块写 → 收尾。
 * 中途任何失败都 abort（清掉 App 私有临时文件，目标位置不会出现半截产物），
 * 用户取消 SAF 面板按 `cancelled` 返回，不当作失败。
 */
const runNativeExport = async (
  start: () => Promise<{ id?: string; status?: 'ready' | 'cancelled' }>,
  write: (id: string) => Promise<void>
): Promise<SaveResult> => {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('NATIVE_EXPORT_UNAVAILABLE')
  }
  let id: string | undefined
  try {
    const started = await start()
    if (started.status === 'cancelled' || !started.id) {
      return { status: 'cancelled' }
    }
    id = started.id
    await write(id)
    return await nativeExport.finish({ id })
  } catch (error) {
    if (id) {
      await nativeExport.abort({ id }).catch(() => {})
    }
    if ((error as { code?: string })?.code === 'CANCELLED') {
      return { status: 'cancelled' }
    }
    throw error
  }
}

export const saveText = async (options: {
  filename: string
  mimeType: string
  text: string
}): Promise<'saved' | 'cancelled'> =>
  (
    await runNativeExport(
      () => nativeExport.start({ name: options.filename, mimeType: options.mimeType }),
      async (id) => {
        for (const data of chunkUtf8(options.text)) {
          await nativeExport.writeChunk({ id, data })
        }
      }
    )
  ).status

/**
 * 保存二进制文件（历史归档 ZIP）：Android 走 ExportText 的二进制分块，Web 走 Blob 下载。
 * 与 `saveTextFile` 同一个出口、同一套取消/失败语义，只是编解码不同 —— 不另造一套下载实现。
 */
export const saveBinary = async (file: {
  filename: string
  mimeType: string
  blob: Blob
}): Promise<SaveResult> =>
  runNativeExport(
    () => nativeExport.start({ name: file.filename, mimeType: file.mimeType, binary: true }),
    async (id) => {
      for (let offset = 0; offset < file.blob.size; offset += CHUNK_BYTES) {
        const bytes = new Uint8Array(await file.blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
        await nativeExport.writeBinaryChunk({ id, data: toBase64(bytes) })
      }
    }
  )

/** Web 侧锚点下载：浏览器原生行为，能力缺失时抛错由调用方提示。 */
const downloadBlob = (file: { filename: string; mimeType: string; blob: Blob }): SaveResult => {
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
    throw new Error('SAVE_UNAVAILABLE')
  }
  const anchor = document.createElement('a')
  if (!('download' in anchor)) {
    throw new Error('SAVE_UNAVAILABLE')
  }
  const url = URL.createObjectURL(file.blob)
  anchor.href = url
  anchor.download = file.filename
  try {
    document.body.appendChild(anchor)
    anchor.click()
    return { status: 'saved', name: file.filename }
  } finally {
    anchor.remove()
    // 给浏览器留出消费下载的时间，正文不落到别处。
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** 保存二进制文件：Android 走原生 SAF，Web 走 Blob 下载。 */
export const saveBlobFile = async (file: {
  filename: string
  mimeType: string
  blob: Blob
}): Promise<SaveResult> =>
  Capacitor.isNativePlatform() ? saveBinary(file) : downloadBlob(file)

/**
 * 保存纯文本文件：Android 走 ExportText 原生桥（SAF 面板，可取消），Web 走 Blob 下载。
 * 能力缺失或写入失败时抛错，由调用方提示，不做静默降级；反馈日志导出与「保存为 TXT」共用这套出口。
 */
export const saveTextFile = async (file: {
  filename: string
  mimeType: string
  text: string
}): Promise<'saved' | 'cancelled'> => {
  if (Capacitor.isNativePlatform()) {
    return saveText(file)
  }
  if (typeof Blob === 'undefined') {
    throw new Error('SAVE_UNAVAILABLE')
  }
  return downloadBlob({
    filename: file.filename,
    mimeType: file.mimeType,
    blob: new Blob([file.text], { type: `${file.mimeType};charset=utf-8` }),
  }).status
}
