// 100MB 级复制 + 全量校验的实测脚本（#915）：源与目标都是「生成式」存储，Blob 内容按位置确定性生成、
// 从不整块落进内存；sink 只做流式摘要（模拟「读 Blob 分片写入」），目标保存每行的摘要而不是内容。
//   node --expose-gc tests/helpers/migration-engine/bench-large.mjs [totalMB=100] [mode=many|single|file]
// mode=file：真 Blob（fs.openAsBlob，文件支撑、不进内存）；sink 把字节真的流式复制到另一个文件，
// 目标是复制出来的文件 → 校验比较的是两份真实文件的字节。
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { installTsResolve, loadTsModule } from '../dom-env.mjs'
import { GeneratedBlob, STORE_NAMES } from './mem.mjs'

installTsResolve()
const { copyAll } = await loadTsModule('src/services/storage/migration/copy.ts')
const { verifyAll } = await loadTsModule('src/services/storage/migration/verify.ts')

const totalMb = Number(process.argv[2] ?? 100)
const mode = process.argv[3] ?? 'many'
const MB = 1024 * 1024
const rowSizes = mode === 'single' ? [totalMB(totalMb)] : Array.from({ length: Math.ceil(totalMb / 5) }, () => 5 * MB)
function totalMB(n) {
  return n * MB
}

const tmp = mode === 'file' ? await mkdtemp(join(tmpdir(), 'mig-bench-')) : undefined
const fileBlobs = []
if (tmp) {
  // 生成源文件：按 1MiB 写，不整块驻留
  for (let i = 0; i < Math.ceil(totalMb / 5); i++) {
    const path = join(tmp, `src-${i}.bin`)
    const gen = new GeneratedBlob(5 * MB, i + 1)
    const out = createWriteStream(path)
    for (let at = 0; at < gen.size; at += MB) {
      out.write(Buffer.from(await gen.slice(at, at + MB).arrayBuffer()))
    }
    await new Promise((resolve) => out.end(resolve))
    fileBlobs.push({ path, blob: await openAsBlob(path, { type: 'application/pdf' }) })
  }
}
const rows = tmp ? fileBlobs.map((f, i) => ({ key: `attachment-${String(i).padStart(4, '0')}`, value: { id: `attachment-${i}`, blob: f.blob } })) : rowSizes.map((size, i) => ({
  key: `attachment-${String(i).padStart(4, '0')}`,
  value: { id: `attachment-${String(i).padStart(4, '0')}`, blob: new GeneratedBlob(size, i + 1, 0, 'application/pdf') },
}))
const lightRows = Array.from({ length: 300 }, (_, i) => ({ key: `s${String(i).padStart(4, '0')}`, value: { id: `s${i}`, title: `t${i}`, messages: [] } }))

// 源：生成式
const sourceRows = { files: rows, sessions: lightRows }
const readFrom = (rowsByStore) => ({
  count: async (store) => (rowsByStore[store] ?? []).length,
  readBatch: async (store, after, limit) => {
    const all = rowsByStore[store] ?? []
    const rest = after === undefined ? all : all.filter((r) => r.key > after)
    const page = rest.slice(0, limit)
    return rest.length > limit ? { rows: page, next: page.at(-1).key } : { rows: page }
  },
  estimateBytes: async () => 0,
})
const source = readFrom(sourceRows)

// 目标：sink 流式读 Blob 分片做 sha256，只存「摘要 Blob」（同尺寸的生成式替身，内容与源一致，不占内存）
const stored = {}
const sink = {
  writeBatch: async (store, batch) => {
    for (const row of batch) {
      const copy = { ...row.value }
      if (tmp && copy.blob) {
        const dest = join(tmp, `dst-${row.key}.bin`)
        const index = Number(row.key.slice(-4))
        await pipeline(createReadStream(fileBlobs[index].path), createWriteStream(dest))
        copy.blob = await openAsBlob(dest, { type: 'application/pdf' })
      } else if (copy.blob && typeof copy.blob.slice === 'function') {
        const hash = createHash('sha256')
        for (let at = 0; at < copy.blob.size; at += MB) {
          hash.update(new Uint8Array(await copy.blob.slice(at, Math.min(copy.blob.size, at + MB)).arrayBuffer()))
        }
        hash.digest()
        copy.blob = copy.blob // 目标沿用生成式 Blob（等价于「读回时按位置生成」）
      }
      ;(stored[store] ??= []).push({ key: row.key, value: copy })
    }
  },
  clearAll: async () => {},
}

let peakRss = 0
let peakExternal = 0
let peakHeap = 0
const sample = () => {
  const m = process.memoryUsage()
  peakRss = Math.max(peakRss, m.rss)
  peakExternal = Math.max(peakExternal, m.external + m.arrayBuffers)
  peakHeap = Math.max(peakHeap, m.heapUsed)
}
const timer = setInterval(sample, 5)
globalThis.gc?.()
const baseline = process.memoryUsage()

const t0 = performance.now()
const result = await copyAll({ source, sink, batchSize: 200 })
const t1 = performance.now()
const report = await verifyAll({ source, target: readFrom(stored) })
const t2 = performance.now()
clearInterval(timer)
sample()

const mb = (n) => (n / MB).toFixed(1)
console.log(
  JSON.stringify(
    {
      mode,
      totalMB: totalMb,
      rowsCopied: result.rowsCopied,
      batches: result.batches,
      maxBatchEstimateMB: Number(mb(result.maxBatchBytesSeen)),
      copyMs: Math.round(t1 - t0),
      verifyMs: Math.round(t2 - t1),
      verifyOk: report.ok,
      baselineRssMB: Number(mb(baseline.rss)),
      peakRssMB: Number(mb(peakRss)),
      peakRssDeltaMB: Number(mb(peakRss - baseline.rss)),
      peakHeapMB: Number(mb(peakHeap)),
      peakExternalMB: Number(mb(peakExternal)),
      stores: STORE_NAMES.length,
    },
    null,
    1
  )
)
if (tmp) await rm(tmp, { recursive: true, force: true })
process.exit(report.ok ? 0 : 1)
