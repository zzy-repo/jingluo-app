export const MAX_TEXT_IMPORT_BYTES = 8 * 1024 * 1024

export class TextImportError extends Error {
  readonly code: 'too-large' | 'cancelled' | 'read-failed'
  constructor(code: 'too-large' | 'cancelled' | 'read-failed') {
    super(code)
    this.code = code
  }
}

export const readTextFile = async (
  file: Blob & { size: number },
  options: { signal?: AbortSignal; yieldEveryBytes?: number } = {}
): Promise<string> => {
  if (file.size > MAX_TEXT_IMPORT_BYTES) { throw new TextImportError('too-large') }
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const yieldEvery = options.yieldEveryBytes ?? 256 * 1024
  let text = ''
  let readBytes = 0
  try {
    for (;;) {
      if (options.signal?.aborted) { throw new TextImportError('cancelled') }
      const part = await reader.read()
      if (part.done) { break }
      readBytes += part.value.byteLength
      if (readBytes > MAX_TEXT_IMPORT_BYTES) { throw new TextImportError('too-large') }
      text += decoder.decode(part.value, { stream: true })
      if (readBytes >= yieldEvery && readBytes % yieldEvery < part.value.byteLength) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof TextImportError) { throw error }
    throw new TextImportError('read-failed')
  }
}
