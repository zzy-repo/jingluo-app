// 迁移结果独立校验（#921 / #910 验收）：把**设备上**的 SQLite 库经原始读口读出来，
// 与迁移前的 IndexedDB 导出逐行逐字段比对（键集合、每个字段、Blob 字节）。
//
// 用法：
//   1) 迁移前在 WebView 里导出 IDB → /tmp/idb-before.json（见验收报告里的 CDP 片段）
//   2) adb shell "run-as <pkg> cat files/storage-engine/deepseek-app.db" > /tmp/devdb/deepseek-app.db
//   3) node scripts/migration-device-verify.mjs
//
// 判据不经过 Storage 仓储实现（只用 raw 读口 + 本文件自己的规范化序列化），也不看 UI。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const { loadTsModule, installTsResolve } = await import('../tests/helpers/dom-env.mjs')
installTsResolve({ stubs: { '@capacitor/core': 'data:text/javascript,export const registerPlugin=()=>({})' } })
const { DatabaseSync } = await import('node:sqlite')

const DUMP = process.env.IDB_DUMP ?? '/tmp/idb-before.json'
const DIR = process.env.DEVICE_DB_DIR ?? '/tmp/devdb'
const NAME = process.env.DEVICE_DB_NAME ?? 'deepseek-app.db'
const dump = JSON.parse(readFileSync(DUMP, 'utf8'))
// 用仓库自己的 Node 测试驱动包一层（提供 transaction/all/run/info 等 SqlDatabase 面）
const { createNodeOpenSqlDatabase } = await import('../tests/helpers/storage-sqlite/nodeSqliteDriver.mjs')
const openDb = createNodeOpenSqlDatabase({ dir: DIR })
const db = await openDb({ name: NAME })

const { createSqliteRawSource } = await loadTsModule('src/services/storage/sqlite/raw.ts')
const src = createSqliteRawSource(db)

const ser = (v) => {
  if (v instanceof Blob) return { __blob: null }
  if (v instanceof Date) return { __date: v.getTime() }
  if (v instanceof ArrayBuffer) return { __blob: Array.from(new Uint8Array(v)) }
  if (ArrayBuffer.isView(v)) return { __blob: Array.from(new Uint8Array(v.buffer)) }
  if (Array.isArray(v)) return v.map(ser)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = ser(v[k])
    return o
  }
  return v
}
// Blob → 字节（异步）
const serAsync = async (v) => {
  if (v instanceof Blob) return { __blob: Array.from(new Uint8Array(await v.arrayBuffer())) }
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await serAsync(x)); return a }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = await serAsync(v[k])
    return o
  }
  return ser(v)
}

const STORES = ['sessions','sessionSummaries','files','sessionsStaging','filesStaging','appAssets','attachments','attachmentTexts','sessionMemory']
let ok = true
const report = []
for (const store of STORES) {
  const want = dump.stores[store]
  const rows = []
  let after
  for (;;) {
    const page = await src.readBatch(store, after, 100)
    for (const r of page.rows) rows.push({ key: String(r.key), value: await serAsync(r.value) })
    if (page.next === undefined) break
    after = page.next
  }
  rows.sort((a,b)=> a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const missing = want.filter(w => !rows.some(r => r.key === w.key)).map(w=>w.key)
  const extra = rows.filter(r => !want.some(w => w.key === r.key)).map(r=>r.key)
  const diff = []
  for (const w of want) {
    const t = rows.find(r => r.key === w.key)
    if (!t) continue
    const a = JSON.stringify(w.value), b = JSON.stringify(t.value)
    if (a !== b) diff.push({ key: w.key, idb: createHash('sha256').update(a).digest('hex').slice(0,12), sqlite: createHash('sha256').update(b).digest('hex').slice(0,12) })
  }
  const good = missing.length === 0 && extra.length === 0 && diff.length === 0
  ok &&= good
  report.push({ store, idb: want.length, sqlite: rows.length, missing, extra, diff, ok: good })
}
console.log(JSON.stringify({ ok, report }, null, 1))
await db.close()
process.exit(ok ? 0 : 1)
