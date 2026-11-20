import type { TranslationKey } from '../i18n/index.js'
import { saveBlobFile } from './exportText.js'

/**
 * 历史归档的统一保存出口（#536）。
 *
 * 导出有两条入口：设置页「导出所有历史对话」（#307）与会话列表「导出选中」（#390）。
 * 两者必须走**同一条**出口 —— 曾经「导出选中」自己走 `utils/downloadBlob` 的锚点下载，
 * 而 WebView 里 `<a download>` 对 blob URL 不会落盘：用户点了没反应，也没有任何报错。
 *
 * 这里只留一条路：Android 走原生 SAF 面板（可取消），Web / 兜底页仍走锚点下载。
 */

export type HistoryArchiveSaveResult = { status: 'saved'; name: string } | { status: 'cancelled' }

/**
 * 保存历史归档 ZIP：原生环境走 SAF，Web 走 Blob 下载。
 *
 * 用户在选择位置的面板上点了取消 → 返回 `cancelled`：既不是成功也不是失败，
 * 调用方应回到「可以再点一次」的状态，不要提示失败。
 */
export const saveHistoryArchive = async (file: {
  name: string
  blob: Blob
}): Promise<HistoryArchiveSaveResult> => {
  const result = await saveBlobFile({
    filename: file.name,
    mimeType: 'application/zip',
    blob: file.blob,
  })
  return result.status === 'saved'
    ? { status: 'saved', name: result.name ?? file.name }
    : { status: 'cancelled' }
}

/**
 * 原生保存出口的失败码 → 人话文案：Java 侧 reject 的 message 是中文，
 * 英文界面直接透传就成了「English UI + 中文原因」。认得的码走对应文案，认不得的仍透传错误原文。
 */
export const exportErrorKey = (error: unknown): TranslationKey => {
  const code = (error as { code?: string })?.code
  if (code === 'START_FAILED') {
    return 'historyExportFailedStart'
  }
  if (code === 'TOO_LARGE') {
    return 'historyExportFailedTooLarge'
  }
  return code === 'WRITE_FAILED' ? 'historyExportFailedWrite' : 'historyExportFailed'
}
