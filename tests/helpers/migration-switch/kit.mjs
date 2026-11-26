// [helper | 依赖: node:sqlite 测试驱动 + src/services/fs/memoryFs.ts | 无全局副作用]
//
// #910/#916 switch-recovery 测试套件：内存 FS + 内存源 + 引擎桩 + 真 SQLite（node:sqlite）目标。
// 引擎桩（copyAll/verifyAll/fingerprintSource）只在 migration-engine 分支就绪前顶替；接口形状以 ports.ts 为准。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installTsResolve, loadTsModule } from '../dom-env.mjs'
import { createNodeOpenSqlDatabase, makeTempSqliteDir } from '../storage-sqlite/nodeSqliteDriver.mjs'

installTsResolve({ stubs: { '@capacitor/core': 'data:text/javascript,export const registerPlugin=(name)=>({__plugin:name})' } })

export const mods = {
  config: await loadTsModule('src/services/storage/migration/config.ts'),
  types: await loadTsModule('src/services/storage/migration/types.ts'),
  state: await loadTsModule('src/services/storage/migration/state.ts'),
  backup: await loadTsModule('src/services/storage/migration/backup.ts'),
  orchestrator: await loadTsModule('src/services/storage/migration/orchestrator.ts'),
  errors: await loadTsModule('src/services/storage/migration/errors.ts'),
  router: await loadTsModule('src/services/storage/router.ts'),
  schema: await loadTsModule('src/services/storage/sqlite/schema.ts'),
  memoryFs: await loadTsModule('src/services/fs/memoryFs.ts'),
  limits: await loadTsModule('src/services/limits.ts'),
}
export const STORES = mods.types.RAW_STORE_NAMES

export const sha256 = async (text) => createHash('sha256').update(text).digest('hex')

/** 每次调用 +1 的时钟：备份文件名（含时间戳）因此各不相同，也让用例可重复。 */
export const makeClock = (start = 1_000_000) => {
  let t = start
  return { now: () => (t += 1) }
}

export const sampleData = () => ({
  sessions: { s1: { id: 's1', title: '一', messages: ['a', 'b'] }, s2: { id: 's2', title: '二' }, s3: { id: 's3' } },
  sessionSummaries: { s1: { id: 's1', title: '一' }, s2: { id: 's2', title: '二' } },
  files: { f1: { id: 'f1', bytes: [1, 2, 3] } },
  sessionsStaging: {},
  filesStaging: {},
  appAssets: { bg: { key: 'bg', n: 1 } },
  attachments: { a1: { id: 'a1' } },
  attachmentTexts: { t1: { key: 't1', text: 'x' } },
  sessionMemory: { m1: { id: 'm1' }, m2: { id: 'm2' } },
})

/** 内存「IDB 源」：只读口。`data` 可被用例直接改（模拟迁移间隙源变化）。 */
export const makeSource = (data = sampleData(), { bytes = 1000 } = {}) => {
  const keys = (store) => Object.keys(data[store] ?? {}).sort()
  const source = {
    data,
    reads: 0,
    failReadOn: undefined,
    async count(store) {
      return keys(store).length
    },
    async readBatch(store, after, limit) {
      source.reads += 1
      if (source.failReadOn === store) throw new Error('source read failed')
      const all = keys(store).filter((key) => after === undefined || key > after)
      const page = all.slice(0, limit)
      return {
        rows: page.map((key) => ({ key, value: structuredClone(data[store][key]) })),
        next: all.length > limit ? page[page.length - 1] : undefined,
      }
    },
    async estimateBytes() {
      return bytes
    },
  }
  return source
}

const readAll = async (source, store) => {
  const rows = []
  let after
  for (;;) {
    const page = await source.readBatch(store, after, 50)
    rows.push(...page.rows)
    if (page.next === undefined) return rows
    after = page.next
  }
}

export const snapshotOf = async (source) => {
  const out = {}
  for (const store of STORES) out[store] = await readAll(source, store)
  return JSON.stringify(out)
}

/** 引擎桩：与真引擎同接口。批大小 2，便于产生多个检查点。 */
export const makeEngine = ({ failCopyAt, failVerify } = {}) => {
  const engine = {
    copies: 0,
    async fingerprintSource(source) {
      return createHash('sha256').update(await snapshotOf(source)).digest('hex')
    },
    async copyAll({ source, sink, checkpoints, onCheckpoint, signal }) {
      const done = new Map((checkpoints ?? []).map((entry) => [entry.store, entry]))
      const result = []
      for (const store of STORES) {
        let entry = done.get(store) ?? { store, lastKey: undefined, done: false }
        if (!entry.done) {
          for (;;) {
            if (signal?.aborted) throw new Error('aborted')
            const page = await source.readBatch(store, entry.lastKey, 2)
            engine.copies += 1
            if (failCopyAt !== undefined && engine.copies === failCopyAt) throw new Error('copy boom')
            if (page.rows.length > 0) await sink.writeBatch(store, page.rows)
            const last = page.rows.length > 0 ? page.rows[page.rows.length - 1].key : entry.lastKey
            entry = { store, lastKey: last, done: page.next === undefined }
            if (onCheckpoint) await onCheckpoint([...result, entry, ...STORES.slice(result.length + 1).map((s) => done.get(s) ?? { store: s, lastKey: undefined, done: false })])
            if (entry.done) break
          }
        }
        result.push(entry)
      }
      return result
    },
    async verifyAll({ source, target }) {
      const stores = []
      for (const store of STORES) {
        const [a, b] = [await readAll(source, store), await readAll(target, store)]
        const am = new Map(a.map((row) => [row.key, JSON.stringify(row.value)]))
        const bm = new Map(b.map((row) => [row.key, JSON.stringify(row.value)]))
        const missingKeys = [...am.keys()].filter((key) => !bm.has(key))
        const extraKeys = [...bm.keys()].filter((key) => !am.has(key))
        const contentMismatchKeys = [...am.keys()].filter((key) => bm.has(key) && bm.get(key) !== am.get(key))
        stores.push({ store, sourceCount: a.length, targetCount: b.length, keysMatch: !missingKeys.length && !extraKeys.length, missingKeys, extraKeys, contentMismatchKeys, full: true })
      }
      const ok = !failVerify && stores.every((s) => s.keysMatch && !s.contentMismatchKeys.length)
      return { ok, stores, semanticIssues: failVerify ? ['injected'] : [] }
    },
  }
  return engine
}

/** createTarget 桩：schema（含 meta）+ 一张 raw_rows 表；sqlite-schema 的 createSqliteRawSink 就绪后换真的。 */
export const createTarget = async (db) => {
  await mods.schema.applySchema(db)
  await db.run('CREATE TABLE IF NOT EXISTS raw_rows (store TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (store, k))')
  return {
    sink: {
      async writeBatch(store, rows) {
        await db.batch(rows.map((row) => ({ sql: 'INSERT OR REPLACE INTO raw_rows (store,k,v) VALUES (?,?,?)', params: [store, row.key, JSON.stringify(row.value)] })))
      },
      async clearAll() {
        await db.run('DELETE FROM raw_rows')
      },
    },
    source: {
      async count(store) {
        return Number((await db.all('SELECT COUNT(*) AS n FROM raw_rows WHERE store=?', [store]))[0].n)
      },
      async readBatch(store, after, limit) {
        const rows = await db.all('SELECT k,v FROM raw_rows WHERE store=? AND (? IS NULL OR k>?) ORDER BY k LIMIT ?', [store, after ?? null, after ?? null, limit + 1])
        const page = rows.slice(0, limit)
        return { rows: page.map((r) => ({ key: r.k, value: JSON.parse(r.v) })), next: rows.length > limit ? page[page.length - 1].k : undefined }
      },
      async estimateBytes() {
        return 0
      },
    },
  }
}

/** 一整套环境：一个内存 FS + 一个临时目录里的真 SQLite。同一个 env 反复 `deps()` = 同一份持久状态（模拟重启）。 */
export const makeEnv = ({ data, freeBytes, bytes } = {}) => {
  const tmp = makeTempSqliteDir('switch-')
  const open = createNodeOpenSqlDatabase({ dir: tmp.dir })
  const openSqlite = async (options) => {
    mkdirSync(dirname(join(tmp.dir, options.name)), { recursive: true })
    return open(options)
  }
  const fs = mods.memoryFs.createMemoryFs(freeBytes === undefined ? {} : { freeBytes })
  const source = makeSource(data, bytes === undefined ? {} : { bytes })
  const clock = makeClock()
  const env = {
    tmp,
    fs,
    source,
    open,
    openSqlite,
    clock,
    mainPath: join(tmp.dir, mods.config.MAIN_DB_NAME),
    sqliteFileExists: async () => existsSync(join(tmp.dir, mods.config.MAIN_DB_NAME)),
    deps(overrides = {}) {
      return { fs, openSqlite, createTarget, source, engine: makeEngine(), clock, sha256, sqliteFileExists: env.sqliteFileExists, ...overrides }
    },
    routerDeps(overrides = {}) {
      return { fs, isSqliteAvailable: () => true, openSqlite, sqliteFileExists: env.sqliteFileExists, sha256, clock, ...overrides }
    },
    async readState() {
      return mods.state.createStateStore(fs, sha256).read()
    },
    async writeState(partial) {
      const base = mods.state.freshState(clock.now())
      await mods.state.createStateStore(fs, sha256).write({ ...base, ...partial })
    },
    async mainTarget() {
      const db = await openSqlite({ name: mods.config.MAIN_DB_NAME })
      return { db, target: await createTarget(db) }
    },
    cleanup: () => {
      for (const handle of open.handles) void handle.db.close().catch(() => {})
      tmp.cleanup()
    },
  }
  return env
}

/** 把「第 k 个边界被杀」做成 hooks；`k` 缺省只计数。 */
export const killAt = (k) => {
  const state = { n: 0, names: [] }
  return {
    state,
    hooks: {
      boundary: (name) => {
        state.n += 1
        state.names.push(name)
        if (k !== undefined && state.n === k) throw { killed: true, at: name, index: k }
      },
    },
  }
}

export const mainRows = async (env) => {
  const { db, target } = await env.mainTarget()
  try {
    return await snapshotOf(target.source)
  } finally {
    await db.close()
  }
}
