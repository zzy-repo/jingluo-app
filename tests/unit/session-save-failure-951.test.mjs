// [layer: unit | 依赖: node:sqlite（Node 22 自带）+ 真 native/driver.ts + 真 chat/store.ts | 耗时: <60s]
//
// #951 内测「频繁 这段对话没存到本机，点重试」+ 提示词丢失 —— 根因定位的可复现实验。
//
// 为什么要有这一份：真机上「保存失败」的三种判定都在 `chat/store.ts` 的 `markSaveFailure` 三处，
// 而原生后端与 Node 测试驱动**行为不同**（`nodeSqliteDriver.mjs` 把并发事务**排队**，真机插件是
// **拒绝**——`guardIdle()` 抛 `connection is inside a transaction`）。用排队驱动测「并发写」永远绿，
// 所以这里用**忠实复刻 AppSqlitePlugin 行为的桥替身**（单写连接 + guardIdle + 4 MiB 结果上限 +
// Capacitor 的 `{message, code, data}` 拒绝形状），把真机语义搬进 Node。
//
// 三条实验线（都走真实代码：native/driver.ts → sqlite/backend.ts → repos → chat/store.ts）：
//   E1 4 MiB 读上限：写成功、读不回来 → 上层会不会报成「保存失败」（写路径有没有同类上限）
//   E2 并发写：同一连接上两次 `sessions.save()` —— 真机语义下第二次直接失败
//   E3 提示词：保存失败后内存里那份提示词还活着吗 / 重试能不能把它落盘 / 冷启动后还在不在
//
// 跑法：node --test tests/unit/session-save-failure-951.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve({
  stubs: {
    '@capacitor/core': 'data:text/javascript,export const registerPlugin=(name)=>globalThis.__sqliteBridge;',
  },
})
installEndpointsGlobals()

// 宿主是原生壳 + AppSqlite 已注册（`capability/probe.ts` 的第 1、2 步）。
globalThis.Capacitor = {
  isNativePlatform: () => true,
  isPluginAvailable: (name) => name === 'AppSqlite',
}

// ---------------------------------------------------------------------------
// 忠实复刻 AppSqlitePlugin 的桥（android/.../AppSqlitePlugin.java 的可执行口径）
// ---------------------------------------------------------------------------

/** Java 的 `MAX_RESULT_BYTES`（AppSqlitePlugin.java:60）——超过就报错，**不截断**。 */
const MAX_RESULT_BYTES = 4 * 1024 * 1024
const MAX_SAFE_INTEGER = 9007199254740991

/** Capacitor 的拒绝形状：`call.reject(message, code, error, data)` → `{message, code, data}`。 */
const reject = (kind, code, message, retryable = false) => {
  const error = new Error(message)
  error.code = kind === 'quota' ? 'QUOTA' : kind === 'unavailable' ? 'UNAVAILABLE' : 'UNKNOWN'
  error.data = { kind, code, retryable, message }
  throw error
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const unB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'))

/** 参数：null / number / string 原样，`{$b64}` 还原成 BLOB（与 Java `bind()` 同口径）。 */
const bindParams = (params) =>
  (params ?? []).map((value) => {
    if (value !== null && typeof value === 'object' && typeof value.$b64 === 'string') {
      return unB64(value.$b64)
    }
    return value
  })

/** 结果列：null / number / string 透传，BLOB 包成 `{$b64}`（与 Java `encode()` 同口径）。 */
const encodeRow = (row) => {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      out[key] = { $b64: b64(value) }
    } else if (typeof value === 'bigint') {
      if (value > BigInt(MAX_SAFE_INTEGER) || value < -BigInt(MAX_SAFE_INTEGER)) {
        reject('unknown', 'OTHER', `integer ${String(value)} exceeds the 2^53 safe range and cannot cross the bridge`)
      }
      out[key] = Number(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 建一份桥替身。
 * @param {{ dir: string, maxResultBytes?: number }} options
 */
const createBridge = ({ dir, maxResultBytes = MAX_RESULT_BYTES }) => {
  const connections = new Map()
  const transactions = new Map()
  let nextHandle = 0
  const stats = { rejected: [] }

  const connectionOf = (name) =>
    connections.get(name) ??
    reject('unavailable', 'OTHER', `database is not open: ${name}`)

  /** AppSqlitePlugin.guardIdle：事务期间同连接的普通调用必须失败（排队会死锁）。 */
  const guardIdle = (connection) => {
    if (connection.transaction !== undefined) {
      reject('unavailable', 'OTHER', 'connection is inside a transaction')
    }
  }

  const queryOn = (connection, sql, params) => {
    const rows = connection.db.prepare(sql).all(...bindParams(params))
    // 字节口径与 Java 一致：字符串按 UTF-16 单元长度计（`statement.getText().length()`），
    // BLOB 按字节数，每行再加列名长度与 2 字节分隔。
    let bytes = 2
    const encoded = []
    for (const row of rows) {
      const out = encodeRow(row)
      for (const [key, value] of Object.entries(out)) {
        const size =
          value === null ? 4 : typeof value === 'number' ? 20 : typeof value === 'string' ? value.length : 4
        bytes += size + key.length
      }
      encoded.push(out)
      bytes += 2
      if (bytes > maxResultBytes) {
        stats.rejected.push({ sql: sql.slice(0, 80), bytes })
        // `SqliteFailure.resultTooLarge()`：kind 仍是 unknown，但 code 是稳定码（#940）
        reject('unknown', 'RESULT_TOO_LARGE', `result exceeds ${maxResultBytes} bytes; refusing to truncate`)
      }
    }
    return { rows: encoded }
  }

  const runOn = (connection, sql, params) => {
    connection.db.prepare(sql).run(...bindParams(params))
    const changes = connection.db.prepare('SELECT changes() AS c').get()?.c ?? 0
    return { changes: Number(changes) }
  }

  const transactionOf = (token) => {
    const transaction = transactions.get(token)
    if (transaction === undefined) {
      reject('unavailable', 'OTHER', `transaction not found: ${token}`)
    }
    return transaction
  }

  const bridge = {
    async open({ name }) {
      if (connections.has(name)) {
        reject('unavailable', 'OTHER', `database already open: ${name}`)
      }
      const db = new DatabaseSync(join(dir, `${name}.db`))
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA busy_timeout = 5000')
      connections.set(name, { name, db, transaction: undefined })
    },
    async run({ name, sql, params }) {
      const connection = connectionOf(name)
      guardIdle(connection)
      return runOn(connection, sql, params)
    },
    async all({ name, sql, params }) {
      const connection = connectionOf(name)
      guardIdle(connection)
      return queryOn(connection, sql, params)
    },
    async batch({ name, statements }) {
      const connection = connectionOf(name)
      guardIdle(connection)
      const results = []
      connection.db.exec('BEGIN IMMEDIATE')
      try {
        for (const statement of statements) {
          results.push(runOn(connection, statement.sql, statement.params))
        }
        connection.db.exec('COMMIT')
      } catch (error) {
        connection.db.exec('ROLLBACK')
        throw error
      }
      return { results }
    },
    async txBegin({ name }) {
      const connection = connectionOf(name)
      guardIdle(connection)
      connection.db.exec('BEGIN IMMEDIATE')
      const token = `tx-${nextHandle++}`
      const transaction = { token, connection }
      connection.transaction = transaction
      transactions.set(token, transaction)
      return { token }
    },
    async txRun({ token, sql, params }) {
      const transaction = transactionOf(token)
      return runOn(transaction.connection, sql, params)
    },
    async txAll({ token, sql, params }) {
      const transaction = transactionOf(token)
      return queryOn(transaction.connection, sql, params)
    },
    async txCommit({ token }) {
      const transaction = transactionOf(token)
      transactions.delete(token)
      transaction.connection.transaction = undefined
      transaction.connection.db.exec('COMMIT')
    },
    async txRollback({ token }) {
      const transaction = transactionOf(token)
      transactions.delete(token)
      transaction.connection.transaction = undefined
      if (transaction.connection.db.isTransaction) {
        transaction.connection.db.exec('ROLLBACK')
      }
    },
    async info({ name }) {
      connectionOf(name)
      return {
        sqliteVersion: '3.50.1',
        journalMode: 'wal',
        synchronous: 'FULL',
        foreignKeys: true,
        busyTimeout: 5000,
        path: join(dir, `${name}.db`),
        kind: 'native-android',
      }
    },
    async integrityCheck() {
      return { problems: [] }
    },
    async backupTo() {
      reject('unknown', 'OTHER', 'backupTo not implemented in the fake bridge')
    },
    async close({ name }) {
      const connection = connections.get(name)
      if (connection === undefined) {
        return
      }
      connection.db.close()
      connections.delete(name)
    },
    async capabilities() {
      return {
        methods: [
          'open',
          'run',
          'all',
          'batch',
          'txBegin',
          'txRun',
          'txAll',
          'txCommit',
          'txRollback',
          'backupTo',
          'integrityCheck',
          'info',
          'close',
          'ping',
        ],
      }
    },
    async ping() {},
  }
  return { bridge, stats }
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const native = await loadTsModule('src/services/storage/sqlite/native/driver.ts')
const mapping = await loadTsModule('src/services/storage/sqlite/mapping.ts')
/** 主键一律是 UTF-16BE 的 BLOB（`repos/rows.ts` 头注释）：裸 SQL 里也必须用同一个编码。 */
const keyOfId = (id) => mapping.encodeKey(id)
const backendModule = await loadTsModule('src/services/storage/sqlite/backend.ts')
const { resetProbeCache } = await loadTsModule('src/services/capability/probe.ts')
const { resetCapabilityCache } = await loadTsModule('src/utils/capabilities.ts')

const roots = []
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'save-failure-951-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响结论
    }
  }
})

/** 打开一套「真机语义」的 SQLite 存储后端（同一目录可重复打开 = 冷启动语义）。 */
const openBackend = async (dir, options = {}) => {
  const { bridge, stats } = createBridge({ dir, ...options })
  globalThis.__sqliteBridge = bridge
  resetProbeCache()
  resetCapabilityCache()
  const db = await native.openNativeSqlite({ name: 'deepseek-app' })
  const backend = await backendModule.openSqliteStorage(async () => db)
  return { backend, db, stats }
}

/** 会话夹具：提示词 + N 条消息；`filler` 控制单条正文长度。 */
const sessionFixture = (id, { messages = 3, filler = '你好', prompt = '你是我的私人助理，回答要简短。' } = {}) => {
  const now = 1_770_000_000_000
  return {
    id,
    title: `会话 ${id}`,
    createdAt: now,
    updatedAt: now,
    customSystemPrompt: prompt,
    rootMessageId: null,
    messages: Array.from({ length: messages }, (_unused, index) => ({
      id: `${id}-m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      createdAt: now + index,
      ...(index % 2 === 0
        ? { content: `${filler}-${index}`, files: [] }
        : { status: 'done', blocks: [{ type: 'text', text: `${filler}-${index}` }] }),
      ...(index === 0 ? { parentId: null } : {}),
    })),
  }
}

/**
 * 分块把一行的 doc 全文读出来（`SELECT substr(doc, …)` 每块远小于 4 MiB，
 * 因此可以如实回答「盘上到底有没有、内容是不是完整」这个与读上限无关的问题）。
 */
const readDocByChunks = async (db, store, id) => {
  const step = 512 * 1024
  const parts = []
  for (let offset = 0; ; offset += step) {
    const row = (await db.all(`SELECT substr(doc, ?, ?) AS part FROM ${store} WHERE id = ?`, [
      offset + 1,
      step,
      keyOfId(id),
    ]))[0]
    const part = row?.part
    if (typeof part !== 'string' || part.length === 0) {
      break
    }
    parts.push(part)
    if (part.length < step) {
      break
    }
  }
  return JSON.parse(parts.join(''))
}

test('smoke：桥 + 后端 + 仓储能开库、写读一条小会话', async () => {
  const dir = makeRoot()
  const { backend } = await openBackend(dir)
  const session = sessionFixture('smoke')
  const outcome = await backend.sessions.save(session, [])
  assert.deepEqual(outcome, { failure: null, degradedFiles: [], strippedFields: [] })
  const read = await backend.sessions.get('smoke')
  assert.equal(read.customSystemPrompt, session.customSystemPrompt)
  assert.equal(read.messages.length, session.messages.length)
  await backend.close()
})

// ---------------------------------------------------------------------------
// E1 · 4 MiB：写路径有没有上限？写成功之后读得回来吗？
// ---------------------------------------------------------------------------

test('E1 >4 MiB 的会话：写成功、读回完整、列表仍在（4 MiB 只是读侧限制）', async (t) => {
  const dir = makeRoot()
  const { backend, db, stats } = await openBackend(dir)
  // 单条正文 1 MiB UTF-16 单元 × 5 条 ≈ 5 MiB > MAX_RESULT_BYTES
  const big = sessionFixture('big', { messages: 5, filler: '长'.repeat(1024 * 1024) })
  const outcome = await backend.sessions.save(big, [])
  // 写：**成功**（`run` 只回报 changes，没有结果字节上限 —— 上限只在读侧）
  assert.equal(outcome.failure, null, `写路径不该有上限：${JSON.stringify(outcome.failure)}`)

  const size = (await db.all('SELECT length(doc) AS n FROM sessions WHERE id = ?', [keyOfId('big')]))[0].n
  t.diagnostic(`盘上 doc 长度 = ${size} 个 UTF-16 单元（原生单次结果上限 ${MAX_RESULT_BYTES}）`)
  assert.ok(size > MAX_RESULT_BYTES, '夹具必须真的超过 4 MiB，否则这条实验没有意义')

  // 读：撞上限之后必须自动改走「按列分块」（#940/#949），**一个字段都不许丢**
  const read = await backend.sessions.get('big')
  assert.equal(read.customSystemPrompt, big.customSystemPrompt)
  assert.deepEqual(read.messages, big.messages)
  // 直读一定撞过上限（第一步的语句本身就是「LENGTH + 整列」，原生拒绝且不截断），
  // 然后才退回按列分块 —— 这两步都得发生过，这条实验才真的踩到了边界。
  assert.ok(
    stats.rejected.length > 0,
    `读回必须触发过「结果超限」再走分块：${JSON.stringify(stats.rejected)}`
  )
  // 双证：直接从盘上分块读回，与 getRow 的结果一致（排除「分块拼错了」）
  const onDisk = await readDocByChunks(db, 'sessions', 'big')
  assert.deepEqual(onDisk.messages, big.messages)

  // 摘要表不受影响 → 冷启动仍能列出这条会话
  const summaries = await backend.sessions.listSummaries()
  assert.equal(summaries.length, 1)
  await backend.close()
})

test('E1b 参数编码：中文 / emoji / 代理对 / U+0000 过桥后逐字节不变', async () => {
  const dir = makeRoot()
  const { backend, db } = await openBackend(dir)
  // 代理对（𝄞 U+1D11E）、ZWJ emoji（👨‍👩‍👧‍👦）、控制字符 U+0000
  const tricky = '中文字符：𝄞👨‍👩‍👧‍👦\u0000\u0001\u001f 结尾'
  const session = sessionFixture('tricky', { prompt: tricky, messages: 2, filler: tricky.repeat(5000) })
  const outcome = await backend.sessions.save(session, [])
  assert.equal(outcome.failure, null, `参数编码不该失败：${JSON.stringify(outcome.failure)}`)
  const read = await backend.sessions.get('tricky')
  assert.equal(read.customSystemPrompt, tricky)
  assert.deepEqual(read.messages, session.messages)
  // 双证：直接从盘上分块读回，与 getRow 的结果一致
  const onDisk = await readDocByChunks(db, 'sessions', 'tricky')
  assert.equal(onDisk.customSystemPrompt, tricky)
  await backend.close()
})

// ---------------------------------------------------------------------------
// E2 · 并发写：真机是「单写连接 + 拒绝」，叠着发就必然有一次被拒
// ---------------------------------------------------------------------------

test('E2 叠着发的保存全部落盘：真机语义下并发事务必须排队，不许互撞', async (t) => {
  const dir = makeRoot()
  const { backend } = await openBackend(dir)
  // 8 条会话同时发 —— 对应 store 侧「流式追加 + 自动标题 + 重试扇出 + pagehide 兜底」叠在一起
  const sessions = Array.from({ length: 8 }, (_unused, index) => sessionFixture(`c${index}`))
  const outcomes = await Promise.all(sessions.map((session) => backend.sessions.save(session, [])))
  const failures = outcomes.filter((outcome) => outcome.failure !== null)
  t.diagnostic(
    `并发 ${sessions.length} 次保存 → 失败 ${failures.length} 次；首个失败 = ${JSON.stringify(failures[0]?.failure ?? null)}`
  )
  // #951 之前这里必然 ≥1 次失败（`connection is inside a transaction`），
  // 而失败带着 kind=unknown 一路上去就是「这段对话没存到本机，点重试」。
  assert.deepEqual(failures, [], '并发保存不许因为「连接在事务里」而失败')
  for (const session of sessions) {
    const read = await backend.sessions.get(session.id)
    assert.deepEqual(read.messages, session.messages, `${session.id} 应该完整落盘`)
  }
  await backend.close()
})

test('E2b 边写边读：并发的直读不许被正在进行的写事务拒掉', async () => {
  const dir = makeRoot()
  const { backend } = await openBackend(dir)
  const save = sessionFixture('mix', { messages: 200, filler: '正文'.repeat(500) })
  const [, , summaries] = await Promise.all([
    backend.sessions.save(save, []),
    backend.sessions.get('mix'),
    backend.sessions.listSummaries(),
  ])
  assert.ok(Array.isArray(summaries))
  await backend.close()
})

// ---------------------------------------------------------------------------
// E4 · 冷启动完整性：关掉后端重开（= 新进程、无内存缓存），逐字段比对
// ---------------------------------------------------------------------------

test('E4 冷启动完整性：提示词与每一条消息逐字段一致', async () => {
  const dir = makeRoot()
  const prompt = '你是我的私人助理，回答要简短。'
  const session = sessionFixture('cold', { messages: 7, prompt })
  const first = await openBackend(dir)
  assert.equal((await first.backend.sessions.save(session, [])).failure, null)
  await first.backend.close()

  // 新实例、新连接、无进程内缓存
  const second = await openBackend(dir)
  const restored = await second.backend.sessions.get('cold')
  assert.equal(restored.customSystemPrompt, prompt, '提示词必须在冷启动后还在')
  assert.equal(restored.messages.length, session.messages.length)
  assert.deepEqual(restored.messages, session.messages)
  const [summary] = await second.backend.sessions.listSummaries()
  assert.equal(summary.id, 'cold')
  await second.backend.close()
})
