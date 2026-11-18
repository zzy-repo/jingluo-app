import { Capacitor } from '@capacitor/core'
import { saveText } from '../exportText.js'
import type { SaveFeedbackText } from './export.js'

/** Blob download belongs only to web. Android always uses the common SAF bridge. */
export const saveFeedbackText: SaveFeedbackText = async (file) => {
  if (Capacitor.isNativePlatform()) {
    return saveText(file)
  }
  if (
    typeof Blob === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof document === 'undefined' ||
    typeof JSON.stringify !== 'function'
  ) {
    throw new Error('此浏览器暂不支持保存日志，请使用支持文件下载的浏览器重试')
  }
  const anchor = document.createElement('a')
  if (!('download' in anchor)) {
    throw new Error('此浏览器暂不支持文件下载，请更换浏览器重试')
  }
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mimeType};charset=utf-8` }))
  anchor.href = url
  anchor.download = file.filename
  try {
    document.body.appendChild(anchor)
    anchor.click()
    return 'saved'
  } finally {
    anchor.remove()
    // Give browsers time to consume the download; do not store the body anywhere else.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
