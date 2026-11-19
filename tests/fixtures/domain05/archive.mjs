// 域 5（历史导入 / 导出）共用的归档夹具。
//
// 只造「结构」不造大文件：真实字节一律现场生成（几 KB 的伪 ZIP / 伪 PNG），
// 需要「声称很大」的用例一律走中央目录里的声明尺寸（declaredSize / declaredCrc），
// 绝不为了造 200MB / 800MB 的包真的分配内存。
//
// ZIP 构造复用对抗层的 buildZip（tests/adversarial/lib/zip.mjs）：它按条目数组原样写字节，
// 能控制物理顺序、重名、原始文件名字节、声明尺寸 / CRC 与截断位置 —— fflate 的 zipSync 会
// 规范化文件名并去重，造不出本域要验的那些坏包。
import { strToU8 } from 'fflate'
import { buildZip } from '../../adversarial/lib/zip.mjs'

export const TIME = '2026-11-01T00:00:00.000Z'
export const MB = 1024 * 1024

/** 导出格式的一条消息（ChatMessage）：域 5 的导入侧只看这个形状。 */
export const message = (id, parentId, role, content, extra = {}) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
  ...extra,
})

/** 一条带图片附件的用户提问：files 里的 export_path 决定导入端会不会去 ZIP 里找原件。 */
export const imageMessage = (id, parentId, { fileId, fileName, exportPath, isImage = true, size = 128 }) =>
  message(id, parentId, 'USER', `带了图片 ${fileName}`, {
    fragments: [
      {
        type: 'FILE',
        files: [
          {
            id: fileId,
            file_name: fileName,
            file_size: size,
            token_usage: null,
            inserted_at: TIME,
            export_path: exportPath,
            is_image: isImage,
            width: null,
            height: null,
          },
        ],
      },
      { type: 'REQUEST', content: `带了图片 ${fileName}` },
    ],
  })

/** chat_sessions/{id}.json 的合法内容。 */
export const sessionFile = ({ id, title = id, messages }) => {
  const list = messages ?? [
    message(1, null, 'USER', `${id} 的问题`),
    message(2, 1, 'ASSISTANT', `${id} 的回答`),
  ]
  return {
    id,
    title,
    pinned: false,
    current_message_id: list.length === 0 ? 0 : list[list.length - 1].id,
    inserted_at: TIME,
    updated_at: TIME,
    messages: list,
  }
}

export const sessionJson = (spec) => strToU8(JSON.stringify(sessionFile(spec)))

export const manifestBytes = (version = 3) => strToU8(JSON.stringify({ export_format_version: version }))

export const indexEntry = (id, overrides = {}) => ({
  id,
  title: id,
  pinned: false,
  message_count: 2,
  inserted_at: TIME,
  updated_at: TIME,
  ...overrides,
})

/** chat_session_index.json：ids 可以是字符串数组，也可以是完整的索引项（用来造重复 id / 缺 title）。 */
export const indexBytes = (ids) =>
  strToU8(JSON.stringify(ids.map((entry) => (typeof entry === 'string' ? indexEntry(entry) : entry))))

/** PNG 头 + 伪随机负载：导入端按 magic bytes 认 MIME，随机字节不会被当成损坏。 */
export const png = (size = 128) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let index = 8; index < size; index += 1) {
    bytes[index] = (index * 31) % 251
  }
  return bytes
}

/** 认不出 magic 的「图片」字节：用来验「MIME 识别失败仍按图片」。 */
export const unknownBytes = (size = 64) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 17 + 3) % 251
  }
  return bytes
}

/**
 * 造 ZIP 字节。entries 是 [名字, 内容]（或带覆盖字段的对象）的有序数组，
 * 顺序就是导入端看到的物理顺序；同名条目原样保留（buildZip 不去重）。
 */
export const zipBytes = (entries, { compress = false, comment = null } = {}) =>
  buildZip(
    entries.map((entry) =>
      Array.isArray(entry)
        ? { name: entry[0], data: entry[1], compress }
        : { compress, ...entry }
    ),
    { comment }
  )

/** 包成 File：导入侧只吃 File（要 size / slice / stream）。 */
export const zipFile = (entries, { compress = false, name = 'deepseek_data.zip', comment = null } = {}) =>
  new File([zipBytes(entries, { compress, comment })], name, { type: 'application/zip' })

/** 「正常导出」的骨架：manifest → 会话 JSON → index（与 exportArchive 的写出顺序一致）。 */
export const normalArchive = (ids, extra = [], options = {}) =>
  zipFile(
    [
      ['manifest.json', manifestBytes()],
      ...ids.map((id) => [`chat_sessions/${id}.json`, sessionJson({ id })]),
      ['chat_session_index.json', indexBytes(ids)],
      ...extra
    ],
    options
  )

/** 生成一个「临时文件 / 被读文件」形状的 File（非 ZIP 内容，用于 backupUnrecognized）。 */
export const notZipFile = (text = '{"not":"a zip"}') =>
  new File([strToU8(text)], 'deepseek_data.zip', { type: 'application/zip' })
