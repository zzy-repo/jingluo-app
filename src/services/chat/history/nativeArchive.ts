import { registerPlugin } from '@capacitor/core'
import { LIMITS } from '../../limits.js'
import type { ArchiveRangeReader } from './zipReader.js'

/**
 * 大包导入的原生半边（Issue #34）：**下载在原生侧流式落盘，JS 只按区间回读**。
 *
 * 为什么要它（理由已贴在 #34 的 issue 评论里）：旧的 `CapacitorHttp.get` 是「整包一次性回给
 * JS」的语义，20MB 包在 WebView 里至少两份（分块数组 + `new File()` 的副本），200MB 直接
 * 撞上内存天花板。原生插件把「网络读 + 写文件」整段留在 Java 侧，过桥的只剩
 * 「已下载多少字节」这个数字，内存由块大小决定、与包体无关。
 *
 * 边界（别越界用）：
 * - 这里只负责**下载与临时文件**，不做任何超时/停滞判定——判定全在 `urlImport.ts`，
 *   按「字节是否在增长 + 硬上限」走（#38：不存在「总墙钟 N 秒」这种判死方式）。
 * - `read()` 单次上限 {@link LIMITS.importRangeReadBytes}（1MiB）。ZIP 中央目录、条目头、
 *   压缩块都远小于它，所以解析链路（zipReader）可以原样工作，只是把 `file.slice()` 换成区间读。
 */

/** 原生下载的启动结果。除参数非法外永远 `resolve`，由 JS 侧按 `state` 分档。 */
export type NativeDownloadStart =
  /** 后台已经在写：`path` 是 App 私有目录里的临时文件 */
  | { state: 'downloading'; path: string; bytes: number; total?: number; restarted?: boolean }
  /** 响应头声明的总量就超上限：原生侧在写第一个字节之前断开，磁盘上什么都没有 */
  | { state: 'tooLarge'; declared: number }
  /** 非 2xx：`status` + 错误体前 4KB（OBS 的错误码在里面，用来区分过期/签名错误） */
  | { state: 'http'; status: number; body: string }
  /** 建连阶段异常：`error` 是原生异常类名 + message，JS 侧据此分类 */
  | { state: 'failed'; error: string }

/** 轮询到的下载进度：只有数字与状态，没有一个字节的包体。 */
export type NativeDownloadProgress = {
  state: 'idle' | 'downloading' | 'done' | 'failed'
  bytes: number
  total?: number
  restarted?: boolean
  error?: string
  path?: string
}

/** 下载完成后交给解析链路的句柄：临时文件路径 + 权威长度。 */
export type NativeArchiveHandle = { kind: 'native'; path: string; size: number }

type NativeDownloadRequest = {
  url: string
  maxBytes: number
  connectTimeoutMs: number
  readTimeoutMs: number
}

interface HistoryArchivePluginApi {
  startDownload(options: NativeDownloadRequest): Promise<NativeDownloadStart>
  getProgress(): Promise<NativeDownloadProgress>
  abortDownload(options: { keep: boolean }): Promise<{ bytes: number; kept: boolean }>
  readFileRange(options: { path: string; offset: number; length: number }): Promise<{ data: string }>
  statFile(options: { path: string }): Promise<{ size: number }>
  deleteFile(options: { path: string }): Promise<{ deleted: boolean }>
}

/** 原生插件代理：注册在 `MainActivity`（见 HistoryArchivePlugin.java）。 */
const plugin = registerPlugin<HistoryArchivePluginApi>('HistoryArchive')

/**
 * base64 → 字节。单次最多 {@link LIMITS.importRangeReadBytes}（1MiB），
 * 所以一次 atob 就够，不再像旧代码那样为了几十 MB 的整包分块解码。
 * 原生侧用 `Base64.NO_WRAP`，不带换行；这里仍先去掉空白，防御别的实现。
 */
const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export const nativeArchive = {
  /**
   * 开始下载。返回 `state=downloading` 表示后台线程已经在写盘；
   * 返回 `tooLarge` / `http` / `failed` 时**磁盘上没有临时文件**（建连与判定都在写之前完成）。
   */
  start: (request: NativeDownloadRequest): Promise<NativeDownloadStart> => plugin.startDownload(request),

  /** 轮询进度：调用方按固定节拍问「到哪儿了」，插件不回推事件（避免跨线程回调）。 */
  progress: (): Promise<NativeDownloadProgress> => plugin.getProgress(),

  /**
   * 释放原生侧的下载状态但**保留**临时文件：成功下载后调用，
   * 让随后的解析阶段按区间读这个文件（文件由调用方在导入结束时删）。
   */
  release: async (): Promise<void> => {
    await plugin.abortDownload({ keep: true })
  },

  /**
   * 中止下载并**立刻删掉**临时文件（原生侧同步删完再返回）。
   * 失败 / 取消路径必须走这里：关闭条件 4 的「跑完立刻查残留」是在这之后查的。
   */
  discard: async (): Promise<void> => {
    await plugin.abortDownload({ keep: false })
  },

  /** 删临时文件（导入结束后的清理；幂等）。 */
  remove: async (path: string): Promise<void> => {
    await plugin.deleteFile({ path })
  },

  /** 临时文件长度；文件不在时返回 -1。 */
  size: async (path: string): Promise<number> => (await plugin.statFile({ path })).size,

  /** 按区间读临时文件（单次 ≤ 1MiB，内部自动分片）。 */
  read: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = []
    let read = 0
    while (read < length) {
      const span = Math.min(LIMITS.importRangeReadBytes, length - read)
      const { data } = await plugin.readFileRange({ path, offset: offset + read, length: span })
      const bytes = decodeBase64(data)
      chunks.push(bytes)
      read += bytes.length
      // 原生侧短读：不再空转，交给上层按「长度不足」判定结构损坏。
      if (bytes.length !== span) {
        break
      }
    }
    if (chunks.length === 1) {
      return chunks[0] as Uint8Array
    }
    const out = new Uint8Array(read)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  },

  /** 把下载句柄包装成 `zipReader` 认的区间读；解析链路因此完全不用知道来源是文件还是内存。 */
  reader: (handle: NativeArchiveHandle): ArchiveRangeReader => ({
    size: handle.size,
    read: (start, length) =>
      nativeArchive.read(handle.path, start, Math.max(0, Math.min(length, handle.size - start))),
  }),
}
