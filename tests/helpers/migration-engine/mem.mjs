// 迁移引擎单测的公共替身（#910）：内存版 RawStoreSource / RawStoreSink、可复现的夹具、「生成式」大 Blob。
// 只有装配，不含断言。校验器与复制器的用例都从这里取，避免各写一份内存后端。
import { createHash } from 'node:crypto'

export const STORE_NAMES = [
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'filesStaging',
  'appAssets',
  'attachments',
  'attachmentTexts',
  'sessionMemory',
]

const cloneValue = (value) => structuredClone(value)

/**
 * 内存后端。`source`/`sink` 共用一份数据，所以同一个实例既能当源也能当目标。
 * hooks：`onRead(store, after, nth)` / `onWrite(store, rows, nth)` 在第 nth 次调用时抛错即可注入故障（nth 从 1 数）。
 */
export const createMem = (initial = {}) => {
  const data = new Map(STORE_NAMES.map((name) => [name, new Map()]))
  for (const [store, rows] of Object.entries(initial)) {
    for (const { key, value } of rows) {
      data.get(store).set(key, value)
    }
  }
  const counters = { reads: 0, writes: 0, writeRowsByStore: {} }
  const hooks = { onRead: undefined, onWrite: undefined }
  const sortedKeys = (store) => [...data.get(store).keys()].sort()
  const source = {
    count: async (store) => data.get(store).size,
    readBatch: async (store, after, limit) => {
      counters.reads += 1
      hooks.onRead?.(store, after, counters.reads)
      const keys = sortedKeys(store).filter((key) => after === undefined || key > after)
      const page = keys.slice(0, limit)
      const rows = page.map((key) => ({ key, value: data.get(store).get(key) }))
      return keys.length > limit ? { rows, next: page[page.length - 1] } : { rows }
    },
    estimateBytes: async () => 0,
  }
  const sink = {
    writeBatch: async (store, rows) => {
      counters.writes += 1
      hooks.onWrite?.(store, rows, counters.writes)
      counters.writeRowsByStore[store] = (counters.writeRowsByStore[store] ?? 0) + rows.length
      for (const row of rows) {
        data.get(store).set(row.key, cloneValue(row.value))
      }
    },
    clearAll: async () => {
      for (const rows of data.values()) {
        rows.clear()
      }
    },
  }
  return {
    data,
    source,
    sink,
    hooks,
    counters,
    get: (store, key) => data.get(store).get(key),
    set: (store, key, value) => data.get(store).set(key, value),
    remove: (store, key) => data.get(store).delete(key),
    size: (store) => data.get(store).size,
    totalRows: () => [...data.values()].reduce((sum, rows) => sum + rows.size, 0),
  }
}

export const clone = cloneValue

export class QuotaExceededError extends Error {
  constructor(message = 'quota exceeded') {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

// ---------------------------------------------------------------- 夹具

const bytesOf = (text) => new TextEncoder().encode(text)
const sha = (text) => createHash('sha256').update(text).digest('hex')

/** 一份「像真的」的库：会话 + 摘要 + 图片原件 + 附件（原件/全文）+ 记忆 + 素材 + 暂存。 */
export const makeFixture = ({ sessions = 6, memoriesPerSession = 3 } = {}) => {
  const rows = Object.fromEntries(STORE_NAMES.map((name) => [name, []]))
  const put = (store, key, value) => rows[store].push({ key, value })
  for (let i = 0; i < sessions; i++) {
    const id = `s${String(i).padStart(3, '0')}`
    const fileId = `img-${id}`
    const session = {
      id,
      title: `会话 ${i}`,
      createdAt: 1000 + i,
      updatedAt: 2000 + i,
      ...(i % 3 === 0 ? { pinnedAt: 3000 + i } : {}),
      ...(i === 4 ? { branchOf: { sessionId: 's000', messageId: 's000-m1', createdAt: 1500 } } : {}),
      messages: [
        { id: `${id}-m1`, role: 'user', content: `你好 ${i} 😀`, createdAt: 1000 + i, files: [{ id: fileId, name: `${fileId}.png`, mimeType: 'image/png', size: 8 }] },
        { id: `${id}-m2`, role: 'assistant', content: `回答 ${i}`, createdAt: 1001 + i, blocks: [{ type: 'text', text: 'x' }] },
      ],
    }
    put('sessions', id, session)
    put('sessionSummaries', id, {
      id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.pinnedAt === undefined ? {} : { pinnedAt: session.pinnedAt }),
      ...(session.branchOf === undefined ? {} : { branchOf: { ...session.branchOf } }),
      fileIds: [fileId],
    })
    put('files', fileId, { id: fileId, blob: new Blob([bytesOf(`png-bytes-${i}`)], { type: 'image/png' }) })
    for (let j = 0; j < memoriesPerSession; j++) {
      const key = `chunk-${j}`
      put('sessionMemory', `${id}:${key}`, {
        id: `${id}:${key}`,
        sessionId: id,
        key,
        text: `记忆 ${i}-${j}`,
        vec: j === 0 ? [0.25, -0.5, 1.5] : undefined,
        ...(j === 0 ? { model: 'm', dim: 3 } : {}),
        bytes: 20,
        createdAt: 10 + j,
        updatedAt: 20 + j,
      })
    }
    if (i < 2) {
      const digest = sha(`doc-${i}`)
      const textKey = `${digest}:v1`
      put('files', `attachment-${digest}`, { id: `attachment-${digest}`, blob: new Blob([bytesOf(`doc-${i}`)], { type: 'text/plain' }) })
      put('attachments', `att-${i}`, {
        id: `att-${i}`,
        filename: `doc-${i}.txt`,
        mimeType: 'text/plain',
        size: 5,
        sha256: digest,
        localPath: `attachment-${digest}`,
        parsedTextPath: textKey,
        status: 'success',
        characterCount: 5,
        warnings: ['w1'],
        createdAt: 5,
      })
      put('attachmentTexts', textKey, {
        key: textKey,
        sha256: digest,
        parserVersion: 'v1',
        text: `全文 ${i}`,
        characterCount: 4,
        status: 'success',
        createdAt: 6,
      })
    }
  }
  put('appAssets', 'chat-background:default', {
    key: 'chat-background:default',
    blob: new Blob([bytesOf('bg')], { type: 'image/jpeg' }),
    updatedAt: 99,
  })
  put('sessionsStaging', 'stg-1', { id: 'stg-1', title: 'staging', createdAt: 1, updatedAt: 1, messages: [] })
  return rows
}

/** 夹具 → 内存后端 */
export const memFromFixture = (options) => createMem(makeFixture(options))

// ---------------------------------------------------------------- 生成式大 Blob

const byteAt = (seed, index) => (index * 31 + (index >>> 8) * 7 + seed) & 0xff

/**
 * 不占内存的「大 Blob」：只有 size/type/slice/arrayBuffer，内容按位置确定性生成。
 * `Symbol.toStringTag` 报 `Blob`，哈希器会把它当 Blob 按字节处理。
 */
export class GeneratedBlob {
  constructor(size, seed = 1, offset = 0, type = 'application/octet-stream') {
    this.size = size
    this.type = type
    this.seed = seed
    this.offset = offset
  }

  get [Symbol.toStringTag]() {
    return 'Blob'
  }

  slice(start = 0, end = this.size) {
    const from = Math.max(0, Math.min(this.size, start))
    const to = Math.max(from, Math.min(this.size, end))
    return new GeneratedBlob(to - from, this.seed, this.offset + from, this.type)
  }

  async arrayBuffer() {
    const out = new Uint8Array(this.size)
    for (let i = 0; i < this.size; i++) {
      out[i] = byteAt(this.seed, this.offset + i)
    }
    return out.buffer
  }

  /** 独立于被测代码的期望值：node:crypto 流式 sha256 */
  expectedSha256() {
    const hash = createHash('sha256')
    const chunk = 1 << 20
    for (let at = 0; at < this.size; at += chunk) {
      const len = Math.min(chunk, this.size - at)
      const buf = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) {
        buf[i] = byteAt(this.seed, this.offset + at + i)
      }
      hash.update(buf)
    }
    return hash.digest('hex')
  }
}
