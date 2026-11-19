import { hasApi } from './capabilities.js'

export const copyText = async (text: string): Promise<boolean> => {
  try {
    // 能力探测统一走 capabilities（#209）：`navigator.clipboard` 在非安全上下文里可能是 null，
    // 老 WebView 上整个 API 都没有 —— 判一次、进缓存，不让每个调用点各写一套 typeof。
    if (hasApi('navigator.clipboard.writeText')) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 剪贴板权限受限时尝试兼容方式。
  }

  // 兼容手机通过局域网 HTTP 访问的情况。
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'

  try {
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

/** 剪贴板能稳定写入的上限：超过后浏览器/WebView 会静默截断或返回伪成功，改为提供「保存 TXT」出口。 */
export const COPY_LIMIT_BYTES = 512 * 1024

/**
 * UTF-8 字节数：中文 3 字节、emoji 4 字节，不能按字符数判断。
 * 不用 TextEncoder 是为了和 `services/diagnostics/export.ts`、`services/exportText.ts` 的计数口径一致
 * （老 WebView 上 TextEncoder 可能缺失，这几条路径都必须能走）。
 */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

export const exceedsCopyLimit = (text: string): boolean => utf8ByteLength(text) > COPY_LIMIT_BYTES

/** 提示里显示的 KiB 数（向上取整） */
export const kibibytes = (text: string): number => Math.ceil(utf8ByteLength(text) / 1024)
