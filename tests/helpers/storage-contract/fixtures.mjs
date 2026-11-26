// 存储契约套件的公共夹具：造数据与「只经接口」的整库快照。
//
// 约束（Issue #906）：本目录只依赖 node 与 `StorageBackend` 接口。不 import `src/**`、react、zustand、DOM；
// 环境搭建（fake-indexeddb / 将来的 SQLite）留在各后端的 runner 文件里。
import assert from 'node:assert/strict'

export const T0 = 1_700_000_000_000

/**
 * 文档原件键前缀。**这是契约的一部分**（#531：整包替换必须保留它），不是实现细节：
 * 仓储本身不内置它（`BlobRepo.clearExcept` 的 `keep` 由调用方给），`StagingRepo.commit` 与
 * `AttachmentRepo` 必须认得它。口径的实现在 `src/services/attachments/blobKeys.ts`，这里按契约重述。
 */
export const ATT_PREFIX = 'attachment-'
export const attKey = (sha256) => `${ATT_PREFIX}${sha256}`
export const SHA_A = 'a'.repeat(64)
export const SHA_B = 'b'.repeat(64)

export const blobOf = (content, type = 'image/png') => new Blob([content], { type })
export const stored = (id, content = 'bytes', type = 'image/png') => ({ id, blob: blobOf(content, type) })
export const fold = async (blob) => (blob === undefined ? undefined : { type: blob.type, size: blob.size, text: await blob.text() })

export const fileRef = (id, over = {}) => ({
  id,
  serverId: null,
  name: `${id}.png`,
  size: 3,
  isImage: true,
  mimeType: 'image/png',
  ...over,
})
export const userMsg = (id, content, files = []) => ({ id, role: 'user', content, files, createdAt: T0 })
export const assistantMsg = (id, text) => ({
  id,
  role: 'assistant',
  createdAt: T0,
  status: 'done',
  model: 'deepseek-flash',
  blocks: [{ type: 'text', text }],
})

/** `files`：本会话 user 消息引用的原件 id；`extra` 里的同名字段覆盖默认值。 */
export const sessionOf = (id, { files = [], ...extra } = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: T0,
  updatedAt: T0 + 1,
  messages: files.length > 0 ? [userMsg(`${id}-u`, `问-${id}`, files.map((fid) => fileRef(fid)))] : [],
  ...extra,
})

/** 带一问一答的会话（暂存 / 合并用例要看 user 消息的 files 被改写、assistant 消息原样不动）。 */
export const chatOf = (id, { files = [], ...extra } = {}) =>
  sessionOf(id, {
    messages: [userMsg(`${id}-u`, `问-${id}`, files.map((fid) => fileRef(fid))), assistantMsg(`${id}-a`, `答-${id}`)],
    ...extra,
  })

export const attDraft = (over = {}) => ({
  id: 'att-1',
  filename: 'a.txt',
  mimeType: 'text/plain',
  size: 4,
  sha256: SHA_A,
  status: 'pending',
  createdAt: 1,
  ...over,
})

/** 记忆条目：`id = ${sessionId}:${key}`（主键里带会话 id 是隔离的落点，见 `StoredSessionMemory`）。 */
export const memOf = (sessionId, key, over = {}) => ({
  id: `${sessionId}:${key}`,
  sessionId,
  key,
  text: `记忆-${key}`,
  bytes: 10,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

export const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
export const ids = (rows) => rows.map((row) => row.id)

/** 把分页方法一页页读完。`limit` 缺省时不传（验证「不传 = 全部」）。返回每一页。 */
export const drain = async (fetchPage, limit, start) => {
  const pages = []
  let after = start
  for (let round = 0; round < 1000; round += 1) {
    const query = {}
    if (after !== undefined) query.after = after
    if (limit !== undefined) query.limit = limit
    const page = await fetchPage(query)
    pages.push(page)
    if (page.next === null) return pages
    after = page.next
  }
  throw new Error('分页不收敛：连续 1000 页仍有 next（游标没前进？）')
}
export const allItems = async (fetchPage, limit, start) => (await drain(fetchPage, limit, start)).flatMap((page) => [...page.items])

/**
 * 整库快照，**只经接口**读：会话（listFull）、摘要、全部原件（listKeys + get）、附件元数据、
 * 以及调用方点名的会话的记忆与解析全文。可直接 deepEqual（Blob 折成 {type,size,text}）。
 * 不覆盖暂存区：暂存不对外可读，要证明「暂存没被半途消耗」只能再调一次 commit / merge。
 */
export const snapshot = async (backend, { memoryOf = [], textKeys = [] } = {}) => {
  const sessions = (await allItems((q) => backend.sessions.listFull(q), 40)).sort(byId)
  const summaries = [...(await backend.sessions.listSummaries())].sort(byId)
  const keys = (await allItems((q) => backend.blobs.listKeys(q), 40)).sort()
  const blobs = {}
  for (const key of keys) blobs[key] = await fold(await backend.blobs.get(key))
  const memory = {}
  for (const sid of memoryOf) memory[sid] = await backend.memory.listBySession(sid)
  const texts = {}
  for (const key of textKeys) texts[key] = await backend.attachments.readText(key)
  const attachments = [...(await backend.attachments.list())].sort(byId)
  return { sessions, summaries, blobs, memory, attachments, texts }
}

export const assertThrowsNamed = async (promise, name, message) =>
  assert.rejects(promise, (error) => error?.name === name, message)

/** 把一个会话直接写进正式库（不带原件）。 */
export const seed = async (backend, session, files = []) => {
  const outcome = await backend.sessions.save(session, files)
  assert.equal(outcome.failure, null, `seed ${session.id} 失败：${JSON.stringify(outcome.failure)}`)
  assert.deepEqual(outcome.degradedFiles, [], `seed ${session.id} 的原件被降级`)
}

/** 暂存：先清、再逐条写。 */
export const stage = async (backend, { sessions = [], files = [], clear = true } = {}) => {
  if (clear) await backend.staging.clear()
  for (const session of sessions) await backend.staging.addSession(session)
  if (files.length > 0) await backend.staging.putFiles(files)
}

/**
 * 注入一次写失败并返回句柄。`inject.failNextWrite` 的契约见 `suite.mjs` 的 `injectDoc`。
 * 用 try/finally 包住使用，保证还原。
 */
export const withFault = async (inject, kind, options, body) => {
  const handle = inject.failNextWrite(kind, options)
  try {
    return await body(handle)
  } finally {
    handle.restore()
  }
}

/** 断言 promise 以注入的那种错误 reject（名字取自 inject 句柄，由 runner 声明各后端的映射）。 */
export const rejectsAs = (promise, handle, message) =>
  assert.rejects(promise, (error) => error?.name === handle.errorName, message ?? `应以 ${handle.errorName} reject`)

export const sorted = (rows) => [...rows].sort(byId)
