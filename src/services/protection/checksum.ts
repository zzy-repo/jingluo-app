import { sha256Hex } from '../attachments/sha256.js'

const encoder = new TextEncoder()

/** 文本的 SHA-256（十六进制）。复用附件模块的实现：WebCrypto 优先，缺失时走纯 JS 兜底。 */
export const sha256OfText = async (text: string): Promise<string> => {
  const bytes = encoder.encode(text)
  return sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}
