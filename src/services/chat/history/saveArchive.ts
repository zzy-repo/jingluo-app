/**
 * 历史归档 ZIP 的**唯一落盘出口**（Issue #536，收口 #483 / #390 两条导出路径）。
 *
 * 两个导出入口必须共用这一个函数：
 *   · 设置 → 数据管理 →「导出所有历史对话」（#483，`SettingsDialog` 的 `ExportHistory`）；
 *   · 侧栏选择模式 →「导出选中」（#390，`Sider` 的 `exportSelected`）。
 *
 * ## 为什么不能各走各的
 *
 * 打包（`exportHistory`）之后还要**落盘**，而落盘有两种完全不同的实现：
 *   · 原生（Android WebView）：`ExportText` 桥的 SAF 面板 + 二进制分块（`services/exportText.ts`
 *     的 `saveBlobFile`）—— 只有它能把文件真正写到用户选的位置；
 *   · Web（浏览器 / H5 兜底页）：`<a download>` + blob URL。
 *
 * WebView 里对 blob URL 的 `<a download>` 在 Android 上**通常静默失败**（没有 DownloadManager
 * 接管）：用户点了没反应，也不报错（#307 修好了全量导出，#536 才发现「导出选中」还留在老路上）。
 * 「判断是不是原生环境」这件事因此只在 `saveBlobFile` 一处做 —— 这里不重复判平台，也不另造下载
 * 实现，避免下一个导出入口再分叉出第三条路。
 *
 * ## 失败语义
 *
 * 原生桥的失败码（`START_FAILED` / `TOO_LARGE` / `WRITE_FAILED`）在这里**一次**翻译成上屏文案，
 * 调用方只管显示（`showToast` / 状态行），不再各自 catch 原始错误、各自映射 code ——
 * 那正是 #307 时全量导出修好、选中导出漏掉的根因。
 *
 * 用户在选择位置的面板上点了取消 = `cancelled`：既不是成功也不是失败，调用方既不该报错，
 * 也不该把「已导出」说出来（磁盘上还没有文件）。
 */
import type { TranslationKey, TranslationParams } from '../../../i18n/index.js'
import { saveBlobFile } from '../../exportText.js'

/** 归档包的 MIME：导出侧、原生桥允许的类型、导入侧的文件过滤器用的是同一个值 */
export const ARCHIVE_MIME_TYPE = 'application/zip'

/** 落盘结果三态：`name` 是**真正落盘**的文件名（SAF 可能按重名规则改名，Web 侧就是下载名） */
export type ArchiveSaveResult =
  | { kind: 'saved'; name: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; key: TranslationKey; params?: TranslationParams }

/**
 * 原生桥失败码 → 上屏文案。
 *
 * 三个码分别对应「打不开保存位置」「超过 200MB（与导入上限一致）导出上限」「写不进去」；
 * 其余（含抛的不是带 code 的 Error、Web 侧 `SAVE_UNAVAILABLE`）归到通用失败，原文由调用方
 * 作为 `{message}` 带出 —— 与服务端错误的既有口径一致（错误码决定文案，原始文本不上主文案）。
 */
export const archiveErrorKey = (error: unknown): TranslationKey => {
  const code = (error as { code?: string } | null)?.code
  if (code === 'START_FAILED') {
    return 'historyExportFailedStart'
  }
  if (code === 'TOO_LARGE') {
    return 'historyExportFailedTooLarge'
  }
  return code === 'WRITE_FAILED' ? 'historyExportFailedWrite' : 'historyExportFailed'
}

/** 通用失败文案要的 `{message}`：只做 `String()` 兜底，不在这里判错误类型 */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 把已经打好的归档落盘（**两个导出入口唯一该调的函数**）。
 *
 * 不抛错：所有失败都归一成 `{ kind: 'failed', key }`，调用方照自己的形态显示
 * （侧栏是 toast，设置页是状态行）。这样「失败有没有提示」不再取决于某个入口记不记得 try/catch。
 */
export const saveHistoryArchive = async (file: {
  filename: string
  blob: Blob
}): Promise<ArchiveSaveResult> => {
  try {
    const result = await saveBlobFile({
      filename: file.filename,
      mimeType: ARCHIVE_MIME_TYPE,
      blob: file.blob,
    })
    return result.status === 'saved'
      ? { kind: 'saved', name: result.name ?? file.filename }
      : { kind: 'cancelled' }
  } catch (error) {
    const key = archiveErrorKey(error)
    return key === 'historyExportFailed'
      ? { kind: 'failed', key, params: { message: errorText(error) } }
      : { kind: 'failed', key }
  }
}
