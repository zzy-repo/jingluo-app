import { Zip, ZipPassThrough } from 'fflate'
import { DEFAULT_MAX_IMPORT_BYTES, formatImportBytes, maxImportMegabytes } from './importLimit.js'

// ZIP32 字段中的哨兵值表示需要 ZIP64；当前格式不支持 ZIP64。
const ZIP64_SIZE = 0xffffffff
const ZIP64_COUNT = 0xffff

export class ArchiveLimitError extends Error {
  constructor() {
    super('History archive requires unsupported ZIP64 fields')
    this.name = 'ArchiveLimitError'
  }
}

/**
 * 导出上限（#336 §3）：**是导入上限的转出，不是第二个数字**。
 *
 * 导出物必须能被本 App 导回，而导入侧按 `file.size > DEFAULT_MAX_IMPORT_BYTES` 拒绝；
 * 导出上限只要比导入上限大一个字节，就会出现「导得出、导不回」的死区
 * （用户手里拿到一个 App 永远读不回来的包，却提示「已保存」）。
 * 所以这里不写数字，直接引用导入侧那一个；以后改导入上限，导出侧自动跟着走。
 */
export const MAX_EXPORT_BYTES = DEFAULT_MAX_IMPORT_BYTES

/** 上限判定：与导入侧同一个 `<=` 口径（等于上限能导回，超一个字节就不能）。 */
export const isWithinExportLimit = (
  bytes: number,
  limitBytes: number = MAX_EXPORT_BYTES
): boolean => bytes <= limitBytes

/**
 * 体积超限（#336 §3）。带实测体积与上限，供上层拼成「当前历史约 xxMB，超过 200MB 导出上限」
 * 这类能告诉用户「怎么办」的文案 —— 只说「文件过大」等于把问题丢回给用户。
 *
 * 不用 TS 参数属性（`constructor(readonly x: T)`）：本文件在用例里被 node 直接加载，
 * strip-only 模式不支持那种写法（errors.ts 因此才在测试里有替身）。
 */
export class ExportTooLargeError extends Error {
  readonly expectedBytes: number
  readonly limitBytes: number

  constructor(expectedBytes: number, limitBytes: number = MAX_EXPORT_BYTES) {
    super(
      `History archive is ${formatImportBytes(expectedBytes)}, over the ${maxImportMegabytes(limitBytes)}MB export limit`
    )
    this.name = 'ExportTooLargeError'
    this.expectedBytes = expectedBytes
    this.limitBytes = limitBytes
  }
}

/**
 * 体积闸：**在写第一个字节之前**判定。
 *
 * 调用点在 `expectedSize` 算完之后 —— 那一刻字节数已经算准、一个字节都还没写，
 * 而保存对话框（原生 SAF / 浏览器下载）是在 `writeArchive` 返回之后才打开的。
 * 所以超限时是「零字节写出 + 零次保存面板弹出」，不是「先选位置再说文件太大」。
 */
export const assertWithinExportLimit = (
  expectedBytes: number,
  limitBytes: number = MAX_EXPORT_BYTES
): void => {
  if (!isWithinExportLimit(expectedBytes, limitBytes)) {
    throw new ExportTooLargeError(expectedBytes, limitBytes)
  }
}

const invalid = (): never => {
  throw new Error('Invalid history archive entry')
}

/** 与读取端保持相同路径规则，成品必须能再次导入。 */
const entryName = (name: string) => {
  const normalized = name.normalize('NFC')
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid()
  }
  const bytes = new TextEncoder().encode(normalized)
  if (bytes.length > 0xffff) {
    throw new ArchiveLimitError()
  }
  // 拒绝孤立代理项，避免编码时替换成 U+FFFD 后改变附件的关联路径。
  if (new TextDecoder().decode(bytes) !== normalized) {
    invalid()
  }
  return { name: normalized, byteLength: bytes.length }
}

/** STORE 流式写入；成品必须能再次导入。 */
export const writeArchive = async (entries: { name: string; blob: Blob }[]): Promise<Blob> => {
  if (entries.length >= ZIP64_COUNT) {
    throw new ArchiveLimitError()
  }
  const names = new Set<string>()
  let dataSize = 0
  let directorySize = 0
  const prepared = entries.map(({ name, blob }) => {
    const normalized = entryName(name)
    if (names.has(normalized.name)) {
      invalid()
    }
    names.add(normalized.name)
    if (blob.size >= ZIP64_SIZE) {
      throw new ArchiveLimitError()
    }
    dataSize += blob.size + 46 + normalized.byteLength
    directorySize += 46 + normalized.byteLength
    if (dataSize >= ZIP64_SIZE || directorySize >= ZIP64_SIZE) {
      throw new ArchiveLimitError()
    }
    return { name: normalized.name, blob }
  })

  const expectedSize = dataSize + directorySize + 22
  // #336 §3：先判业务上限再写字节。ZIP32 硬限在上面，是「格式装不下」；这里是「导回来装不下」。
  assertWithinExportLimit(expectedSize)
  const chunks: Blob[] = []
  let size = 0
  let completed = false
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      throw error
    }
    size += chunk.byteLength
    if (size > expectedSize) {
      invalid()
    }
    chunks.push(new Blob([chunk]))
    completed = final
  })
  try {
    for (const { name, blob } of prepared) {
      const entry = new ZipPassThrough(name)
      entry.mtime = new Date(1980, 0, 1)
      zip.add(entry)
      const reader = blob.stream().getReader()
      let written = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          written += value.byteLength
          if (written > blob.size) {
            invalid()
          }
          entry.push(value)
        }
        if (written !== blob.size) {
          invalid()
        }
        entry.push(new Uint8Array(), true)
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    zip.end()
    if (!completed || size !== expectedSize) {
      invalid()
    }
    return new Blob(chunks, { type: 'application/zip' })
  } finally {
    zip.terminate()
  }
}
