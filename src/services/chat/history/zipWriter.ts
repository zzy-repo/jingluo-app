import { Zip, ZipPassThrough } from 'fflate'
import { isWithinExportLimit } from './importLimit.js'

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
 * 成品超出导出上限（issue #336）。与 {@link ArchiveLimitError} 不是一回事：
 * 那个是「格式装不下」（ZIP64），这个是「本 App 自己导不回来」（导出上限 = 导入上限 200MB）。
 * `bytes` 是算出来的成品字节数，服务层拿它拼「实际多大 / 上限多少」的人话。
 */
export class ExportTooLargeError extends Error {
  /** 算准的成品字节数（= zipWriter 里的 expectedSize） */
  readonly bytes: number

  // 显式赋值而不是构造函数参数属性：单测用 node 的 strip-only 模式直接 import 本文件，
  // 参数属性那种写法在那里是语法错误（errors.ts 也有同样的坑，测试里用替身绕开）。
  constructor(bytes: number) {
    super(`History archive of ${bytes} bytes exceeds the export limit`)
    this.name = 'ExportTooLargeError'
    this.bytes = bytes
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
  // 导出上限闸（issue #336）：这里是唯一一个「字节数已经算准、但一个字节都还没写」的时刻 ——
  // expectedSize 就是成品 ZIP 的精确大小（下面还有 size !== expectedSize 的自校验兜着），
  // 而原生保存面板（SAF）是在本函数返回之后才打开的。所以在这里拒掉，用户不会先选一次位置、
  // 再看一句「文件过大」。上限只有一处：importLimit.MAX_EXPORT_BYTES = 导入上限本身。
  if (!isWithinExportLimit(expectedSize)) {
    throw new ExportTooLargeError(expectedSize)
  }
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
