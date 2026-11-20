// 构造 DeepSeek 历史对话导出 ZIP，供「从链接导入」的用例当下载产物用。
// 格式按 src/services/chat/history/format.ts / paths.ts：manifest → 会话 JSON → index → 图片。
import { strToU8, zipSync } from 'fflate'

const TIME = '2026-11-01T00:00:00.000Z'

const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

/** PNG 头 + 伪随机负载：导入端按 magic bytes 认 MIME，随机字节也不会被当成损坏。 */
const imageBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let index = 8; index < size; index += 4093) {
    bytes[index] = (index * 31) % 251
  }
  return bytes
}

/**
 * @param {{sessionCount?: number, imageBytes?: number, titlePrefix?: string, padBytes?: number}} [options]
 *   sessionCount：会话数（每个会话 1 张图片 + 1 组问答）
 *   imageBytes：每个会话图片的字节数（0 表示不带图片）
 *   padBytes：额外塞一个未被引用的条目撑大包体（导入时被跳过），用于覆盖大包 / 分块解码
 * @returns {{zip: Uint8Array, sessions: number, entries: number}}
 */
export const buildArchive = ({
  sessionCount = 1,
  imageBytes: imageSize = 0,
  titlePrefix = '链接导入测试会话',
  padBytes = 0,
} = {}) => {
  const entries = { 'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })) }
  // 图片条目必须排在 index 之后：与 src/services/chat/history/exportArchive.ts 的写出顺序一致
  // （manifest → 全部会话 JSON → index → 全部图片）。图片夹在会话之间时，导入端在读到
  // chat_session_index.json 之前只认「刚读到的那个会话」的 _files/ 条目，会判成内容不完整（#32）。
  const imageEntries = {}
  const index = []
  // 会话标题里的序号让侧栏能直接看出导入数量
  const pad = String(Math.max(sessionCount, 2) - 1).length
  for (let number = 1; number <= sessionCount; number += 1) {
    const id = `link-session-${number}`
    const title = `${titlePrefix} ${String(number).padStart(pad, '0')}`
    const fragments = [
      message(1, null, 'USER', `问题 ${number}`),
      message(2, 1, 'ASSISTANT', `回答 ${number}`),
    ]
    if (imageSize > 0) {
      const fileId = `file-${number}`
      const exportPath = `chat_sessions/${id}_files/${fileId}_image.png`
      fragments[0].fragments.push({
        type: 'FILE',
        files: [
          {
            id: fileId,
            file_name: 'image.png',
            file_size: imageSize,
            token_usage: null,
            inserted_at: TIME,
            export_path: exportPath,
            is_image: true,
            width: 512,
            height: 512,
          },
        ],
      })
      imageEntries[exportPath] = imageBytes(imageSize)
    }
    entries[`chat_sessions/${id}.json`] = strToU8(
      JSON.stringify({
        id,
        title,
        pinned: false,
        current_message_id: 2,
        inserted_at: TIME,
        updated_at: TIME,
        messages: fragments,
      })
    )
    index.push({
      id,
      title,
      pinned: false,
      message_count: 2,
      inserted_at: TIME,
      updated_at: TIME,
    })
  }
  entries['chat_session_index.json'] = strToU8(JSON.stringify(index))
  if (padBytes > 0) {
    imageEntries['chat_sessions/link-session-1_files/unreferenced.png'] = imageBytes(padBytes)
  }
  // 图片与撑大包体的未引用条目统一排在 index 之后，与真实导出顺序一致
  Object.assign(entries, imageEntries)
  const zip = zipSync(entries, padBytes > 0 || imageSize > 0 ? { level: 0 } : {})
  return { zip, sessions: sessionCount, entries: Object.keys(entries).length }
}

/** 单会话小包的便捷封装（单测用） */
export const buildArchiveZip = (options) => buildArchive(options).zip

/** 非 ZIP 数据（纯文本），用于「不是有效的 ZIP」用例 */
export const textPayload = (text) => strToU8(text)
