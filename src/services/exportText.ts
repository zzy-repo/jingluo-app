import { Capacitor, registerPlugin } from '@capacitor/core'

interface ExportTextBridge {
  start(options: { name: string; mimeType: string }): Promise<{ id: string }>
  writeChunk(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ status: 'saved' | 'cancelled' }>
  abort(options: { id: string }): Promise<void>
}

const nativeExport = registerPlugin<ExportTextBridge>('ExportText')
const CHUNK_BYTES = 48 * 1024

const chunkUtf8 = (text: string): string[] => {
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of text) {
    const size = new TextEncoder().encode(character).byteLength
    if (current && bytes + size > CHUNK_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current) { chunks.push(current) }
  return chunks
}

export const saveText = async (options: { filename: string; mimeType: string; text: string }): Promise<'saved' | 'cancelled'> => {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('NATIVE_EXPORT_UNAVAILABLE')
  }
  const { id } = await nativeExport.start({ name: options.filename, mimeType: options.mimeType })
  try {
    for (const data of chunkUtf8(options.text)) {
      await nativeExport.writeChunk({ id, data })
    }
    return (await nativeExport.finish({ id })).status
  } catch (error) {
    await nativeExport.abort({ id }).catch(() => {})
    throw error
  }
}
