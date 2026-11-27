// [helper | 依赖: node:child_process node:sqlite node:crypto | 无全局副作用]
//
// #923：真实子进程 SIGKILL 的父进程侧。`runKilledWriter` 起 child-sqlite-writer.mjs，等它到达指定保持点，
// 然后 `kill('SIGKILL')`，并断言子进程确实是被信号 SIGKILL 结束（不是正常退出、不是超时）。
// `inspectBlobDb` 是**独立读回**：用父进程自己的 node:sqlite 连接、自己的期望字节生成器（与子进程里那份
// 是两份独立实现），逐块比字节，不 import src/**。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./child-sqlite-writer.mjs', import.meta.url))

/** 期望字节：与子进程同一公式的**独立重写**（LCG，逐字节）。公式漂移 → 读回比对必红。 */
export const expectedChunk = (blobIdx, chunkIdx, len) => {
  const out = new Uint8Array(len)
  let x = (blobIdx * 2654435761 + chunkIdx * 40503 + 12345) >>> 0
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}

/**
 * @param {{dbPath:string, synchronous?:string, blobs:number, chunksPerBlob:number, chunkBytes:number, mode?:'tx'|'split', holdAt?:string, killAt?:string, timeoutMs?:number}} cfg
 *   holdAt 缺省则不杀，让子进程正常跑完（用于基线）。killAt 同 holdAt（别名，语义更清楚）。
 * @returns {Promise<{killed:boolean, signal:string|null, code:number|null, config:object, lines:string[]}>}
 */
export const runKilledWriter = (cfg) =>
  new Promise((resolve, reject) => {
    const holdAt = cfg.killAt ?? cfg.holdAt
    const child = spawn(process.execPath, ['--no-warnings', CHILD, JSON.stringify({ ...cfg, holdAt })], { stdio: ['ignore', 'pipe', 'inherit'] })
    const lines = []
    let buf = ''
    let config
    let killed = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`writer child timed out; output so far:\n${lines.join('\n')}`))
    }, cfg.timeoutMs ?? 30_000)
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        lines.push(line)
        if (line.startsWith('CONFIG ')) config = JSON.parse(line.slice(7))
        if (holdAt !== undefined && line === `HOLD ${holdAt}` && !killed) {
          killed = true
          child.kill('SIGKILL') // 真信号：内核直接回收进程，没有任何 JS 清理机会
        }
      }
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ killed, signal, code, config, lines })
    })
  })

/**
 * 独立读回。返回 { integrity, heads:[{id, ok, problems}], orphanChunkIds, lastBlob, headCount, chunkRows }。
 * `ok=true` 当且仅当：块数、每块长度与 sha256、整体长度与 sha256 全部吻合，且逐字节等于独立期望。
 */
export const inspectBlobDb = (dbPath, { chunkBytes }) => {
  if (!existsSync(dbPath)) return { exists: false }
  const db = new DatabaseSync(dbPath, { readOnly: false })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)
    const hasTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('blob_head','blob_chunk','progress')").all().length === 3
    if (!hasTables) return { exists: true, integrity, tablesMissing: true, heads: [], orphanChunkIds: [], headCount: 0, chunkRows: 0 }
    const heads = []
    for (const h of db.prepare('SELECT id, total_len, sha256, chunks FROM blob_head ORDER BY id').all()) {
      const problems = []
      const rows = db.prepare('SELECT idx, len, sha256, data FROM blob_chunk WHERE id=? ORDER BY idx').all(h.id)
      if (rows.length !== h.chunks) problems.push(`chunk rows ${rows.length} != declared ${h.chunks}`)
      const whole = createHash('sha256')
      let total = 0
      const blobIdx = Number(h.id.replace('blob', ''))
      rows.forEach((r, i) => {
        if (r.idx !== i) problems.push(`gap/disorder at position ${i}: idx=${r.idx}`)
        const data = r.data
        total += data.length
        whole.update(data)
        if (data.length !== r.len) problems.push(`chunk ${r.idx}: length ${data.length} != recorded ${r.len}`)
        if (createHash('sha256').update(data).digest('hex') !== r.sha256) problems.push(`chunk ${r.idx}: sha256 mismatch`)
        const want = expectedChunk(blobIdx, r.idx, chunkBytes)
        if (data.length !== want.length || Buffer.compare(data, want) !== 0) problems.push(`chunk ${r.idx}: bytes differ from independent expectation`)
      })
      if (total !== h.total_len) problems.push(`total ${total} != declared ${h.total_len}`)
      if (whole.digest('hex') !== h.sha256) problems.push('whole-blob sha256 mismatch')
      heads.push({ id: h.id, ok: problems.length === 0, problems })
    }
    const headIds = new Set(heads.map((h) => h.id))
    const chunkIds = db.prepare('SELECT DISTINCT id FROM blob_chunk').all().map((r) => r.id)
    const orphanChunkIds = chunkIds.filter((id) => !headIds.has(id))
    const lastBlob = db.prepare("SELECT v FROM progress WHERE k='lastBlob'").get()?.v
    const chunkRows = db.prepare('SELECT COUNT(*) AS n FROM blob_chunk').get().n
    return { exists: true, integrity, heads, orphanChunkIds, lastBlob, headCount: heads.length, chunkRows }
  } finally {
    db.close()
  }
}
