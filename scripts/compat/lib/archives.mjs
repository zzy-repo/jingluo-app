// 测试归档构造：给「导入白屏 / OOM」这条线喂的 ZIP。
//
// 直接用 tests/adversarial/lib/zip.mjs（同仓库红队用例手工拼 ZIP 的唯一一份）——
// 导入端要看的正是「声明尺寸 / 压缩比 / 条目顺序」这些手工可控的字节。
// 这里原先放过一份字节完全相同的副本（scripts/compat/lib/zip.mjs），Issue #289 已删掉：
// 补畸形包时夹具版本不一致，会让同一条结论在红队用例与 P2 取证两边得出相反结果。
import { deflateRawSync } from 'node:zlib'
import { buildZip } from '../../../tests/adversarial/lib/zip.mjs'

const MB = 1024 * 1024
const TIME = '2026-11-01T00:00:00.000Z'

const sessionId = (index) => `session-${String(index).padStart(3, '0')}`

/** 合法会话 JSON：id 必须与文件名一致（导入端会比对），消息链不断。 */
const sessionJson = (id, messageContents, title) => {
  const messages = []
  let parent = null
  messageContents.forEach((content, index) => {
    const questionId = (index + 1) * 2 - 1
    const answerId = (index + 1) * 2
    messages.push({
      id: questionId,
      parent_id: parent,
      role: 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: TIME,
      fragments: [{ type: 'REQUEST', content: `问题 ${index + 1}` }],
    })
    messages.push({
      id: answerId,
      parent_id: questionId,
      role: 'ASSISTANT',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: TIME,
      fragments: [{ type: 'RESPONSE', content }],
    })
    parent = answerId
  })
  return JSON.stringify({
    id,
    title,
    pinned: false,
    current_message_id: parent,
    inserted_at: TIME,
    updated_at: TIME,
    messages,
  })
}

const indexJson = (ids) =>
  JSON.stringify(
    ids.map((id) => ({
      id,
      title: `会话 ${id}`,
      pinned: false,
      message_count: 2,
      inserted_at: TIME,
      updated_at: TIME,
    }))
  )

/** 正文填充：用可打印 ASCII，避免 JSON 转义把体积算歪（转义会让「压缩比」失真）。 */
const filler = (bytes) => {
  const unit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789  '
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
}

/**
 * 造一个「总大小 ≈ targetBytes」的合法导出包（store 不压缩，大小可控）。
 * 做法：先按 payload 造，再按差值补一条正文，最多迭代 4 次收敛到 ±几百字节。
 */
export const validArchive = (targetBytes) => {
  let payload = Math.max(0, targetBytes - 4096)
  let bytes = null
  for (let round = 0; round < 4; round += 1) {
    const chunk = 8 * MB
    const count = Math.max(1, Math.ceil(payload / chunk))
    const contents = []
    let left = payload
    for (let index = 0; index < count; index += 1) {
      const size = Math.min(chunk, Math.max(0, left))
      contents.push(filler(size))
      left -= size
    }
    const id = sessionId(1)
    // 条目顺序是导入端写死的契约（paths.ts 第 1 行）：manifest → user → 全部会话 → index → 图片。
    // 顺序错了会先读到 index，后面的会话文件就被判成「无主条目」（backupEntryUnreferenced）。
    bytes = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
      { name: 'user.json', data: JSON.stringify({ name: 'compat' }) },
      { name: `chat_sessions/${id}.json`, data: sessionJson(id, contents, '兼容性压测会话') },
      { name: 'chat_session_index.json', data: indexJson([id]) },
    ])
    const delta = targetBytes - bytes.length
    if (Math.abs(delta) < 1024) {
      break
    }
    payload = Math.max(1024, payload + delta)
  }
  return bytes
}

/**
 * 高压缩比炸弹：解压后 64MB 全同一个字符，deflate 后只有几十 KB（≈1000:1）。
 * declaredSize 可选地谎报（默认不谎报，谎报那档单独一个 spec）。
 */
export const bombArchive = ({ uncompressedBytes = 64 * MB, declaredSize = null } = {}) => {
  const id = sessionId(1)
  const body = 'A'.repeat(uncompressedBytes)
  const session = sessionJson(id, [body], '炸弹')
  return buildZip([
    { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
    {
      name: `chat_sessions/${id}.json`,
      data: session,
      compress: true,
      ...(declaredSize === null ? {} : { declaredSize }),
    },
    { name: 'chat_session_index.json', data: indexJson([id]) },
  ])
}

/**
 * 归档里夹一个「消息分支已损坏」的会话（#49 的回归点：应降级为跳过 + 可定位详情，
 * 而不是整包失败）。做法：parent_id 指向不存在的消息 id，链断掉。
 */
export const corruptBranchArchive = () => {
  const good = sessionId(1)
  const broken = sessionId(2)
  const brokenSession = JSON.parse(sessionJson(broken, ['正常一条'], '坏会话'))
  brokenSession.messages[1].parent_id = 999_999
  return buildZip([
    { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
    { name: `chat_sessions/${good}.json`, data: sessionJson(good, ['好会话正文'], '好会话') },
    { name: `chat_sessions/${broken}.json`, data: JSON.stringify(brokenSession) },
    { name: 'chat_session_index.json', data: indexJson([good, broken]) },
  ])
}

/** 半截包：把合法归档从中间切断，验证「文件内容不完整 / 不是有效压缩包」的文案（#32 的邻居）。 */
export const truncatedArchive = () => {
  const bytes = validArchive(4 * MB)
  return bytes.subarray(0, Math.floor(bytes.length * 0.55))
}

const cache = new Map()

/** 名字 → 字节。按需生成并缓存（200MB 那档一次就够，别重复造）。 */
export const archiveOf = (name) => {
  if (cache.has(name)) {
    return cache.get(name)
  }
  const table = {
    'ctrl-1mb': () => validArchive(1 * MB),
    'ctrl-10mb': () => validArchive(10 * MB),
    'ctrl-50mb': () => validArchive(50 * MB),
    // 200MB 是 importLimit 的上限默认值；判定是 `declared > max` 才算超，所以正好 200MB 应该放行
    'edge-200mb': () => validArchive(200 * MB),
    // 超限那档：验证「先拒绝、不进暂存、不白屏」
    'over-220mb': () => validArchive(220 * MB),
    'bomb-1000x': () => bombArchive(),
    // 谎报解压后 4GB（真实只有 64MB）：验证读的是声明值还是真实流
    'bomb-liar-4gb': () => bombArchive({ declaredSize: 4 * 1024 * MB }),
    // #49 回归：某条会话消息链断掉 → 应跳过该会话并给出可定位详情
    'corrupt-branch': () => corruptBranchArchive(),
    // #32 邻居：包被截断 → 应报「内容不完整 / 不是有效压缩包」而不是白屏
    'truncated': () => truncatedArchive(),
  }
  const factory = table[name]
  if (!factory) {
    throw new Error(`未知归档：${name}（可用：${Object.keys(table).join(', ')}）`)
  }
  const bytes = factory()
  cache.set(name, bytes)
  return bytes
}

export const ARCHIVE_NAMES = [
  'ctrl-1mb',
  'ctrl-10mb',
  'ctrl-50mb',
  'edge-200mb',
  'over-220mb',
  'bomb-1000x',
  'bomb-liar-4gb',
  'corrupt-branch',
  'truncated',
]

export { MB, deflateRawSync }
