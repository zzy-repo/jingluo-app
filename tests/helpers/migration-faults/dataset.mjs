// [helper | 依赖: node:crypto node:fs node:os node:path ./sources.mjs ./canon.mjs | 无全局副作用]
//
// #910 / #921：宿主机基准数据集生成器。**确定性**（同 seed 同输出），覆盖 9 个 store 的全部字段形态。
//
// 独立性：不 import `src/**`。字段形态来自对 `chat/types.ts`、`chat/db.ts`、`attachments/types.ts` 的
// 阅读，与被验收实现无代码依赖；形状漂移由 migration-dataset-selftest 里的「必含字段形态」用例盯住。
//
// 规模档（环境变量可调）：
//   MIGRATION_AUDIT_SCALE     small | medium | large（默认 small）
//   MIGRATION_AUDIT_SEED      整数种子（默认 910）
//   MIGRATION_AUDIT_LARGE_MB  large 档的附件总量下限，默认 220（要求 ≥200）
//   MIGRATION_AUDIT_TMPDIR    large 档落盘目录（默认 os.tmpdir()）
//
// 大数据流式：附件原件不进内存。`large` 档把每个 Blob 的字节**流式写进临时文件**再用 `fs.openAsBlob`
// 取回文件支撑的 Blob（读取时才分块进内存），所以 ≥200MB 的数据集在 ~100MB 堆里也能生成与比较。
// `small`/`medium` 用内存 Blob。调用方用完调用 `dataset.cleanup()`。
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, openAsBlob, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { digestValue, sha256Hex } from './canon.mjs'
import { cloneData, emptyData, STORE_NAMES } from './sources.mjs'

// ---------------------------------------------------------------- 确定性随机

export const mulberry32 = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const makeRng = (seed) => {
  const next = mulberry32(seed)
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = (list) => list[int(0, list.length - 1)]
  const chance = (p) => next() < p
  return { next, int, pick, chance }
}

// ---------------------------------------------------------------- 字符串形态

/** 必须原样往返的字符串。每一项都是合法 JS 字符串，IndexedDB 原样保存；TEXT 列/JSON/UTF-8 编码会各自破坏其中一部分。 */
export const TRICKY_STRINGS = Object.freeze({
  empty: '',
  space: ' ',
  cjk: '你好，鲸落。',
  emoji: 'a😀b👨‍👩‍👧‍👦c🇨🇳',
  nul: 'a\u0000b',
  nulOnly: '\u0000',
  loneHigh: 'a\ud800b',
  loneLow: 'a\udc00b',
  endsHigh: 'x\ud83d',
  startsLow: '\ude00x',
  bom: '\ufeffbom',
  lineSep: 'a\u2028b\u2029c',
  controls: '\u0001\u0008\u000b\u001f\u007f',
  crlf: 'a\r\nb\rc\nd',
  rtl: 'שלום עולם مرحبا',
  combining: 'e\u0301 \u0065\u0301',
  nonChar: '\ufffe\uffff',
  replacement: '\ufffd',
  quotes: '"\'`\\\\"',
  sqlish: "'; DROP TABLE sessions; --",
  jsonish: '{"a":1,"b":[null]}',
  longAscii: 'x'.repeat(200_000),
})

const LOREM = '会话正文 The quick brown fox 😀 jumps over the lazy dog. 汉字，标点；“引号”。\n第二行\t制表符\n'

const longText = (rng, units) => {
  let out = ''
  while (out.length < units) out += LOREM + rng.int(0, 1e9) + ' '
  // 避免把代理对从中间切开（切开会是**我们自己**造出孤立代理项，污染「必须原样往返」的区分）
  let s = out.slice(0, units)
  const last = s.charCodeAt(s.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  return s
}

// ---------------------------------------------------------------- Blob 生成

const BASE_BLOCK_BYTES = 1 << 20

const makeBaseBlock = (seed) => {
  const rng = mulberry32(seed ^ 0x9e3779b9)
  const block = Buffer.allocUnsafe(BASE_BLOCK_BYTES)
  for (let i = 0; i < block.length; i += 4) block.writeUInt32LE((rng() * 4294967296) >>> 0, i)
  return block
}

/**
 * 确定性字节流：第 `index` 个 blob，长度 `size`。每个 blob 的每个 64KiB 窗口都混入 (index, 窗口号)，
 * 所以任意两个 blob、同一 blob 的任意两块都不相同（改一块能被发现，块错位也能被发现）。
 */
function* blobChunks(baseBlock, index, size) {
  const WINDOW = 65536
  let produced = 0
  let w = 0
  while (produced < size) {
    const len = Math.min(WINDOW, size - produced)
    const start = ((index * 7919 + w * 104729) % (baseBlock.length - WINDOW)) | 0
    const chunk = Buffer.from(baseBlock.subarray(start, start + len)) // 拷贝，可改
    if (len >= 12) {
      chunk.writeUInt32LE(index >>> 0, 0)
      chunk.writeUInt32LE(w >>> 0, 4)
      chunk.writeUInt32LE((produced / WINDOW) >>> 0, 8)
    }
    yield chunk
    produced += len
    w++
  }
}

/** 造一个 Blob 并返回 {blob, sha256, size}。`dir` 给定 → 流式落盘 + openAsBlob（文件支撑，不占堆）。 */
const makeBlob = async (ctx, index, size, type) => {
  const hash = createHash('sha256')
  if (ctx.dir === undefined) {
    const parts = []
    for (const chunk of blobChunks(ctx.baseBlock, index, size)) {
      hash.update(chunk)
      parts.push(chunk)
    }
    return { blob: new Blob(parts, { type }), sha256: hash.digest('hex'), size }
  }
  const file = join(ctx.dir, `blob-${index}.bin`)
  const out = createWriteStream(file)
  for (const chunk of blobChunks(ctx.baseBlock, index, size)) {
    hash.update(chunk)
    if (!out.write(chunk)) await once(out, 'drain')
  }
  out.end()
  await once(out, 'close')
  return { blob: await openAsBlob(file, { type }), sha256: hash.digest('hex'), size }
}

// ---------------------------------------------------------------- 规模档

export const SCALES = Object.freeze({
  small: { sessions: 12, messagesPer: [0, 6], images: 4, docs: 3, memoriesPer: [0, 4], largeMB: 0, longTextUnits: 20_000 },
  medium: { sessions: 160, messagesPer: [0, 30], images: 40, docs: 25, memoriesPer: [0, 20], largeMB: 0, longTextUnits: 300_000 },
  large: { sessions: 400, messagesPer: [0, 40], images: 60, docs: 40, memoriesPer: [0, 30], largeMB: 220, longTextUnits: 1_000_000 },
})

export const scaleFromEnv = (env = process.env) => {
  const name = env.MIGRATION_AUDIT_SCALE ?? 'small'
  if (!(name in SCALES)) throw new Error(`MIGRATION_AUDIT_SCALE must be one of ${Object.keys(SCALES).join('/')}, got ${name}`)
  return name
}

const BASE_TIME = 1_700_000_000_000

/** 文档解析器版本串（与 attachments 的 `${sha256}:${parserVersion}` 主键口径一致）。 */
const PARSER = 'txt-1'

/**
 * 生成数据集。
 * @param {{scale?:string, seed?:number, largeMB?:number, tmpDir?:string, exoticKeys?:boolean, features?:object}} [options]
 *   features：逐项关掉形态（给历史版本样本用：`{ branchOf:false, attachments:false, memory:false, appAssets:false, pinned:false }`）
 * @returns {Promise<{data:Record<string,Map<string,any>>, meta:object, cleanup:()=>void}>}
 */
export const generateDataset = async (options = {}) => {
  const scaleName = options.scale ?? scaleFromEnv()
  const scale = SCALES[scaleName]
  if (scale === undefined) throw new Error(`unknown scale ${scaleName}`)
  const seed = options.seed ?? Number(process.env.MIGRATION_AUDIT_SEED ?? 910)
  const largeMB = options.largeMB ?? Number(process.env.MIGRATION_AUDIT_LARGE_MB ?? scale.largeMB)
  const feat = { branchOf: true, attachments: true, memory: true, appAssets: true, pinned: true, staging: true, legacyFields: true, ...(options.features ?? {}) }
  const rng = makeRng(seed)
  const data = emptyData()

  let dir
  let tmpRoot
  if (scaleName === 'large' || options.tmpDir !== undefined) {
    tmpRoot = options.tmpDir ?? process.env.MIGRATION_AUDIT_TMPDIR ?? tmpdir()
    mkdirSync(tmpRoot, { recursive: true })
    dir = mkdtempSync(join(tmpRoot, 'migration-audit-ds-'))
  }
  const cleanup = () => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
  const ctx = { dir, baseBlock: makeBaseBlock(seed) }
  let blobIndex = 0
  let totalBlobBytes = 0
  const nextBlob = async (size, type) => {
    const made = await makeBlob(ctx, blobIndex++, size, type)
    totalBlobBytes += size
    return made
  }

  try {
    const ids = { sessions: [], images: [], docs: [] }
    const tricky = Object.entries(TRICKY_STRINGS)
    const keyOf = (prefix, i) => {
      // 默认含非 ASCII 键；exoticKeys 额外含 NUL / emoji / 孤立代理项键（IndexedDB 允许）
      if (options.exoticKeys && i % 11 === 0) return `${prefix}-${['\u0000', '😀', '\ud800', '～', 'a b'][(i / 11) % 5 | 0]}-${i}`
      return i % 7 === 0 ? `${prefix}-会话-${i}` : `${prefix}-${i}`
    }

    // ---- 图片原件（files）
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const imageSizes = scaleName === 'large' ? [1 << 20, 3.5 * (1 << 20), 16 * (1 << 20)] : [0, 1, 17, 4096, 70_000]
    for (let i = 0; i < scale.images; i++) {
      const id = keyOf('img', i)
      const size = Math.round(imageSizes[i % imageSizes.length])
      const { blob } = await nextBlob(size, imageTypes[i % imageTypes.length])
      data.files.set(id, { id, blob })
      ids.images.push({ id, size, type: blob.type, name: `照片-${i}.${blob.type.split('/')[1]}` })
    }

    // ---- 文档附件（files 里的 attachment-<sha> 原件 + attachments 元数据 + attachmentTexts 全文）
    if (feat.attachments) {
      const docTypes = [
        ['text/plain', '.txt', 5 << 20],
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx', 20 << 20],
        ['application/pdf', '.pdf', 50 << 20],
      ]
      const docSizes = scaleName === 'large' ? [5 << 20, 20 << 20, 50 << 20] : [0, 3, 2048, 90_000]
      for (let i = 0; i < scale.docs; i++) {
        const [mime, ext] = docTypes[i % docTypes.length]
        const size = docSizes[i % docSizes.length]
        const made = await nextBlob(size, mime)
        const blobKey = `attachment-${made.sha256}`
        data.files.set(blobKey, { id: blobKey, blob: made.blob })
        const attId = keyOf('att', i)
        const status = ['success', 'partial', 'failed', 'success'][i % 4]
        const hasText = status === 'success' || status === 'partial'
        const textKey = `${made.sha256}:${PARSER}`
        const att = {
          id: attId,
          filename: `文档-${i}${ext}`,
          mimeType: mime,
          size,
          sha256: made.sha256,
          localPath: blobKey,
          status,
          createdAt: BASE_TIME + i * 1000,
          ...(hasText ? { parsedTextPath: textKey, characterCount: 100 + i, estimatedTokens: 50 + i, parserVersion: PARSER } : {}),
          ...(status === 'partial' ? { totalPages: 10, extractedPages: 7, warnings: ['部分页面无文字', 'page 8 skipped \u0000'] } : {}),
          ...(status === 'failed' ? { errorMessage: '解析失败：文件已损坏 😀' } : {}),
          // 显式 undefined 属性：IndexedDB 保留它，JSON 往返会丢
          ...(i % 5 === 0 ? { warnings: undefined } : {}),
        }
        data.attachments.set(attId, att)
        if (hasText && !data.attachmentTexts.has(textKey)) {
          data.attachmentTexts.set(textKey, {
            key: textKey,
            sha256: made.sha256,
            parserVersion: PARSER,
            text: i % 3 === 0 ? longText(rng, scale.longTextUnits) : `[第1页]\n${LOREM}`,
            characterCount: 100 + i,
            status: status === 'partial' ? 'partial' : 'success',
            createdAt: BASE_TIME + i * 1000 + 1,
            ...(status === 'partial' ? { totalPages: 10, extractedPages: 7, warnings: ['部分页面无文字'] } : {}),
          })
        }
        ids.docs.push({ id: attId, blobKey })
      }
    }

    // ---- 大档补足：附件总量不低于 largeMB（交替造 50MB 文档与 16MB 图片原件）
    if (largeMB > 0) {
      let pad = 0
      while (totalBlobBytes < largeMB * 1024 * 1024) {
        const isDoc = pad % 2 === 0
        const size = isDoc ? 50 << 20 : 16 << 20
        const made = await nextBlob(size, isDoc ? 'application/pdf' : 'image/jpeg')
        const id = isDoc ? `attachment-${made.sha256}` : keyOf('imgpad', pad)
        data.files.set(id, { id, blob: made.blob })
        if (!isDoc) ids.images.push({ id, size, type: made.blob.type, name: `大图-${pad}.jpg` })
        pad++
      }
    }

    // ---- 会话
    const sessionIds = []
    for (let i = 0; i < scale.sessions; i++) sessionIds.push(keyOf('s', i))
    for (let i = 0; i < scale.sessions; i++) {
      const id = sessionIds[i]
      const messages = []
      const nMsg = i === 0 ? 0 : rng.int(...scale.messagesPer)
      let prev
      const usedImages = []
      for (let m = 0; m < nMsg; m++) {
        const mid = `${id}-m${m}`
        const createdAt = BASE_TIME + i * 100_000 + m * 1000
        if (m % 2 === 0) {
          const files = []
          if (ids.images.length > 0 && rng.chance(0.3)) {
            const img = rng.pick(ids.images)
            files.push({ id: img.id, serverId: rng.chance(0.5) ? null : `file_${rng.int(1e6, 9e6)}`, name: img.name, size: img.size, isImage: true, mimeType: img.type })
            usedImages.push(img.id)
          }
          if (feat.attachments && ids.docs.length > 0 && rng.chance(0.2)) {
            const doc = rng.pick(ids.docs)
            const att = data.attachments.get(doc.id)
            files.push({ id: doc.id, serverId: null, name: att.filename, size: att.size, isImage: false, mimeType: att.mimeType })
          }
          if (rng.chance(0.1)) files.push({ id: `missing-orig-${i}-${m}`, serverId: null, name: '无原件.png', size: 10, isImage: true, mimeType: '' }) // 本地没有原件的附件：合法
          const content = m === 0 && i % 3 === 1 ? tricky[(i / 3) % tricky.length | 0][1] : rng.chance(0.15) ? longText(rng, scale.longTextUnits) : `${LOREM}${i}-${m}`
          const msg = { id: mid, role: 'user', content, files, createdAt }
          if (rng.chance(0.2)) msg.unavailable = [{ id: `gone-${m}`, name: '已不可用.pdf', reason: 'source-missing' }]
          if (rng.chance(0.2)) msg.availableAtSend = files.map((f) => ({ id: f.id, name: f.name }))
          if (prev !== undefined && rng.chance(0.5)) msg.parentId = prev
          if (m === 0) msg.parentId = null
          messages.push(msg)
        } else {
          const blocks = [{ type: 'thinking', thinking: `思考 ${LOREM}`, ...(rng.chance(0.5) ? { signature: `sig${rng.int(0, 1e9)}` } : {}), startedAt: createdAt, endedAt: createdAt + 5, elapsedSeconds: 0.005 }, { type: 'text', text: tricky[(i + m) % tricky.length][1], ...(rng.chance(0.2) ? { citations: [{ url: 'https://example.com/?q=😀', title: 'ex' }] } : {}) }]
          const msg = { id: mid, role: 'assistant', createdAt, model: rng.chance(0.2) ? null : 'deepseek-chat', prefix: false, status: ['done', 'stopped', 'error', 'done'][m % 4], blocks }
          if (rng.chance(0.3)) msg.thinking = true
          if (rng.chance(0.3)) msg.search = false
          if (rng.chance(0.2)) msg.latestReminder = undefined // 显式 undefined
          if (msg.status === 'done') msg.usage = { inputTokens: rng.int(0, 5000), outputTokens: rng.int(0, 5000) }
          if (msg.status === 'error') msg.error = { kind: 'upload', message: '补传失败', retryable: false, upstreamCode: undefined }
          if (prev !== undefined) msg.parentId = prev
          messages.push(msg)
        }
        prev = mid
      }
      const session = { id, title: i % 4 === 0 ? tricky[(i / 4) % tricky.length | 0][1] : `会话 ${i}`, createdAt: BASE_TIME + i * 100_000, updatedAt: BASE_TIME + i * 100_000 + 999, messages }
      if (i % 5 === 1) session.rootMessageId = messages.length > 0 ? messages[0].id : null
      if (i % 9 === 3) session.rootMessageId = undefined // 显式 undefined 与缺失键不同
      if (feat.pinned && i % 6 === 2) session.pinnedAt = BASE_TIME + 5_000_000 + i
      if (feat.pinned && i === 8) session.pinnedAt = 0 // 假值但存在
      if (feat.legacyFields && i % 8 === 4) session.userIdentity = '旧版双栏：身份说明'
      if (feat.legacyFields && i % 8 === 5) session.customSystemPrompt = tricky[(i * 3) % tricky.length][1]
      if (feat.appAssets && i % 10 === 6) session.background = { style: 'custom', opacity: 35, blur: 0 }
      if (feat.branchOf && i > 0 && i % 7 === 5) {
        const parent = sessionIds[rng.int(0, i - 1)]
        session.branchOf = { sessionId: parent, createdAt: BASE_TIME + i, ...(rng.chance(0.5) ? { messageId: `${parent}-m0` } : {}) }
      }
      if (feat.branchOf && i === scale.sessions - 1) session.branchOf = { sessionId: 'deleted-parent', createdAt: BASE_TIME } // 悬空的来源：父会话已被删，合法
      data.sessions.set(id, session)
      const summary = { id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, fileIds: [...new Set(messages.flatMap((x) => (x.role === 'user' ? x.files.map((f) => f.id) : [])))] }
      if (session.pinnedAt !== undefined) summary.pinnedAt = session.pinnedAt
      if (session.branchOf !== undefined) summary.branchOf = { ...session.branchOf }
      data.sessionSummaries.set(id, summary)
      ids.sessions.push(id)

      // 记忆
      if (feat.memory) {
        const nMem = rng.int(...scale.memoriesPer)
        for (let k = 0; k < nMem; k++) {
          const key = `chunk-${k}`
          const withVec = rng.chance(0.4)
          const dim = withVec ? 8 : 0
          const text = k % 5 === 0 ? tricky[(i + k) % tricky.length][1] : `记忆片段 ${LOREM}${k}`
          const vec = withVec ? Array.from({ length: dim }, () => rng.next() * 2 - 1) : undefined
          if (vec && k % 3 === 0) vec[0] = -0 // -0 必须保留
          const mem = { id: `${id}:${key}`, sessionId: id, key, text, bytes: Buffer.byteLength(text) + dim * 4, createdAt: BASE_TIME + k, updatedAt: BASE_TIME + k + 1 }
          if (withVec) Object.assign(mem, { vec, model: 'embed-x', dim })
          data.sessionMemory.set(mem.id, mem)
        }
      }
    }

    // ---- 应用素材
    if (feat.appAssets) {
      const bg = await nextBlob(scaleName === 'large' ? 2 << 20 : 5000, 'image/jpeg')
      data.appAssets.set('chat-background', { key: 'chat-background', blob: bg.blob, updatedAt: BASE_TIME })
      for (const sid of ids.sessions.filter((_, i) => i % 10 === 6)) {
        const sb = await nextBlob(1234, 'image/png')
        data.appAssets.set(`chat-background:session:${sid}`, { key: `chat-background:session:${sid}`, blob: sb.blob, updatedAt: BASE_TIME + 1 })
      }
    }

    // ---- 暂存（导入过程残留）：与正式数据**不同**的 id，内容也不同
    if (feat.staging) {
      for (let i = 0; i < 3; i++) {
        const sid = `staged-${i}`
        data.sessionsStaging.set(sid, { id: sid, title: `暂存 ${i}`, createdAt: BASE_TIME, updatedAt: BASE_TIME, messages: [] })
      }
      const sf = await nextBlob(777, 'image/png')
      data.filesStaging.set('staged-file-0', { id: 'staged-file-0', blob: sf.blob })
    }

    const meta = { scale: scaleName, seed, totalBlobBytes, blobCount: blobIndex, tmpDir: dir, counts: Object.fromEntries(STORE_NAMES.map((s) => [s, data[s].size])), synthetic: false }
    return { data, meta, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

// ---------------------------------------------------------------- manifest（宿主机基准：主键集合 + 行哈希）

/** 对一个数据集（`{store: Map}`）或 RawStoreSource 算 manifest。行哈希是 canon 的规范编码 sha256。 */
export const buildManifest = async (input, options = {}) => {
  const pageSize = options.pageSize ?? 64
  const stores = {}
  const iterate = async function* (store) {
    if (typeof input.readBatch === 'function') {
      let after
      for (;;) {
        const page = await input.readBatch(store, after, pageSize)
        yield* page.rows.map((r) => [r.key, r.value])
        if (page.next === undefined) return
        after = page.next
      }
    } else {
      yield* [...(input[store] ?? new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    }
  }
  for (const store of STORE_NAMES) {
    const rows = {}
    const keyHash = createHash('sha256')
    let count = 0
    for await (const [key, value] of iterate(store)) {
      rows[key] = await digestValue(value)
      keyHash.update(`${key.length}:${key}\n`, 'utf16le')
      count++
    }
    stores[store] = { count, keySetSha256: keyHash.digest('hex'), rows }
  }
  const body = JSON.stringify(Object.fromEntries(STORE_NAMES.map((s) => [s, [stores[s].count, stores[s].keySetSha256, Object.entries(stores[s].rows).map(([k, h]) => [k, h])]])))
  return { manifestVersion: 1, stores, manifestSha256: sha256Hex(body) }
}

// ---------------------------------------------------------------- 历史版本样本

/**
 * 各版本的 schema：store → {keyPath, indexes}。来自 `chat/db.ts` 的 `upgradeChatDB` 与各 tag 的 `db.ts`：
 *   v11 `783829d5`（仓库最早的 schema）：5 个 store + fileIds 索引；
 *   v12 `311f6a10`：+appAssets；  v13 `f6ca4d0d`：+attachments/attachmentTexts；
 *   v14 `f609ac62`：+sessionMemory；  v15 `a22abe41`：+sessionSummaries.branchOf 索引。
 * v1–v10：**synthetic**。仓库没有早于 v11 的历史，其真实 schema 无处可查；这里取「v11 的真子集」作为
 * 合成起点，只用来证明升级/迁移不依赖起点，**不代表任何真实用户的库**。
 */
const S5 = {
  sessions: { keyPath: 'id', indexes: [] },
  files: { keyPath: 'id', indexes: [] },
  sessionsStaging: { keyPath: 'id', indexes: [] },
  filesStaging: { keyPath: 'id', indexes: [] },
  sessionSummaries: { keyPath: 'id', indexes: [['fileIds', 'fileIds', { multiEntry: true }]] },
}
const S_ATT = {
  attachments: { keyPath: 'id', indexes: [['sha256', 'sha256', {}], ['parsedTextPath', 'parsedTextPath', {}]] },
  attachmentTexts: { keyPath: 'key', indexes: [['sha256', 'sha256', {}]] },
}
export const HISTORIC_SCHEMAS = Object.freeze({
  11: { ...S5 },
  12: { ...S5, appAssets: { keyPath: 'key', indexes: [] } },
  13: { ...S5, appAssets: { keyPath: 'key', indexes: [] }, ...S_ATT },
  14: { ...S5, appAssets: { keyPath: 'key', indexes: [] }, ...S_ATT, sessionMemory: { keyPath: 'id', indexes: [['sessionId', 'sessionId', {}]] } },
  15: {
    ...S5,
    sessionSummaries: { keyPath: 'id', indexes: [['fileIds', 'fileIds', { multiEntry: true }], ['branchOf', 'branchOf.sessionId', {}]] },
    appAssets: { keyPath: 'key', indexes: [] },
    ...S_ATT,
    sessionMemory: { keyPath: 'id', indexes: [['sessionId', 'sessionId', {}]] },
  },
})

/** 合成起点（v1–v10）：v11 schema 的子集。version → store 名单。 */
const SYNTHETIC_STORES = {
  1: [],
  2: ['sessions'],
  3: ['sessions', 'files'],
  4: ['sessions', 'files'],
  5: ['sessions', 'files', 'sessionSummaries-noindex'],
  6: ['sessions', 'files', 'sessionSummaries-noindex'],
  7: ['sessions', 'files', 'sessionSummaries'],
  8: ['sessions', 'files', 'sessionSummaries', 'sessionsStaging'],
  9: ['sessions', 'files', 'sessionSummaries', 'sessionsStaging', 'filesStaging'],
  10: ['sessions', 'files', 'sessionSummaries', 'sessionsStaging', 'filesStaging'],
}

export const historicSchemaOf = (version) => {
  if (HISTORIC_SCHEMAS[version]) return { schema: HISTORIC_SCHEMAS[version], synthetic: false }
  const list = SYNTHETIC_STORES[version]
  if (list === undefined) throw new Error(`no schema for version ${version}`)
  const schema = {}
  for (const name of list) {
    if (name === 'sessionSummaries-noindex') schema.sessionSummaries = { keyPath: 'id', indexes: [] }
    else schema[name] = S5[name]
  }
  return { schema, synthetic: true }
}

const FEATURES_BY_VERSION = {
  11: { attachments: false, memory: false, appAssets: false, branchOf: false },
  12: { attachments: false, memory: false, appAssets: true, branchOf: false },
  13: { attachments: true, memory: false, appAssets: true, branchOf: false },
  14: { attachments: true, memory: true, appAssets: true, branchOf: false },
  15: { attachments: true, memory: true, appAssets: true, branchOf: true },
}

/**
 * 某版本「升级前」的库内容。`data` 只含该版本 schema 里存在的 store（其余为空 Map）。
 * v1–v10：synthetic，只含 v11 形态里该版本有的 store 的行。
 */
export const generateHistoricDataset = async (version, options = {}) => {
  const { schema, synthetic } = historicSchemaOf(version)
  const base = FEATURES_BY_VERSION[Math.min(Math.max(version, 11), 15)]
  const full = await generateDataset({ scale: options.scale ?? 'small', seed: (options.seed ?? 910) + version, features: { ...base, staging: version >= 9 }, ...options })
  const data = emptyData()
  for (const store of Object.keys(schema)) {
    for (const [k, v] of full.data[store]) data[store].set(k, v)
  }
  // 摘要在没有 sessions 的合成起点里没有意义：保持一致
  if (!schema.sessions) data.sessionSummaries.clear()
  if (synthetic && schema.sessions && !schema.sessionSummaries) data.sessionSummaries.clear()
  const meta = { ...full.meta, version, synthetic, stores: Object.keys(schema), counts: Object.fromEntries(STORE_NAMES.map((s) => [s, data[s].size])), note: synthetic ? 'synthetic: 仓库无 v1–v10 历史，真实 schema 无处可查；v11 的真子集' : 'real schema（来自 db.ts 历史），数据为合成' }
  return { data, schema, meta, cleanup: full.cleanup }
}

/** 升级到 v15 后**应当**看到的内容：升级回调只新增 store/索引，不改任何已有行。独立的期望，不经应用代码。 */
export const expectedAfterUpgrade = (historic) => cloneData(historic.data)

export { cloneData }
