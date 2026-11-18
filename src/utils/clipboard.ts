export const MAX_CLIPBOARD_UTF8_BYTES = 512 * 1024

export type CopyTextResult = 'copied' | 'too-large' | 'failed'

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

/**
 * Android WebView 的剪贴板走 Binder；这是防失败的保守阈值，不是系统精确上限。
 * 失败时不把 execCommand 的“已请求”当作成功。
 */
export const copyText = async (text: string): Promise<CopyTextResult> => {
  if (utf8Bytes(text) > MAX_CLIPBOARD_UTF8_BYTES) {
    return 'too-large'
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return 'copied'
    }
  } catch {
    // 剪贴板权限受限时尝试兼容方式。
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
  try {
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return document.execCommand('copy') ? 'copied' : 'failed'
  } catch {
    return 'failed'
  } finally {
    textarea.remove()
  }
}
