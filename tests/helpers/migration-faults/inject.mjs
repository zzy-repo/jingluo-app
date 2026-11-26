// [helper | 依赖: node:crypto | 无全局副作用]
//
// #910 / #923：故障注入工具箱。包装 RawStoreSource / RawStoreSink / SqlDatabase / AppFileSystem
// （按**结构**包装：任何有这些方法的对象都行，不 import src/**）。
//
// 一个 `FaultController` 管一次试验的全部规则与调用日志。用法：
//
//   const ctl = createFaultController()
//   const source = ctl.wrapSource(realSource)                 // 名字 'source'
//   const sink   = ctl.wrapSink(realSink)                     // 名字 'sink'
//   const db     = ctl.wrapSql(realDb)                        // 名字 'sql'
//   const fs     = ctl.wrapFs(realFs)                         // 名字 'fs'
//   ctl.failNth('sink.writeBatch', 3)                         // 第 3 次 writeBatch 抛 unknown 错
//   ctl.enospc('fs.writeAtomic', { nth: 2, path: /state\.json$/ })
//   ctl.killAfter('fs.writeAtomic', { path: /state\.json$/, nth: 4 })   // 第 4 次写状态文件**成功之后**杀协调器
//   ctl.afterCall('fs.writeAtomic', { path: /manifest/ }, (c) => corruptFile(realFs, c.args[0], 'flip-byte'))
//
// 规则字段：
//   target     'source.readBatch' 这样的 "<对象名>.<方法名>"，方法名可写 '*' 匹配全部
//   nth        1-based，只对**满足 match 的调用**计数；缺省 = 每次命中都触发
//   times      最多触发几次（缺省 1；0 = 不限）
//   match      (call) => boolean，call = { target, method, args, n, seq }；`path`/`store`/`sql` 简写见 normalizeMatch
//   phase      'before'（默认：方法没执行）| 'after'（方法已成功执行，结果已落地，再触发）
//   effect     'throw' | 'kill' | 函数 (call, ctl) => void|Promise（可改状态、可抛）
//
// 「杀协调器」的语义：`killAfter/killBefore` 在触发点抛 `CoordinatorKilled`，并把控制器置为 dead：
// 此后**任何**经包装对象发起的调用都抛 `CoordinatorKilled`（像进程没了，在飞的异步工作也无法再落地）。
// 持久状态（被包装的真实对象：文件系统、SQLite 文件、IDB 数据）原封不动保留；测试用 `ctl.revive()` 或新建
// 控制器 + 新协调器，**只带持久状态**重新开始，内存里的一切都丢弃。这是逻辑杀进程；真 SIGKILL 子进程
// 见 `killproc.mjs`（#923 要求 SQLite 层必须是真子进程）。
import { createHash } from 'node:crypto'

export class CoordinatorKilled extends Error {
  constructor(where) {
    super(`coordinator killed ${where}`)
    this.name = 'CoordinatorKilled'
    this.where = where
  }
}

/** 注入错误的统一工厂。形状取各端口文档里的 `kind/code`；字段齐全，测试里按 kind/code 断言，不靠 message。 */
export const makeError = (flavor, message) => {
  switch (flavor) {
    case 'enospc-fs': // AppFileSystem：磁盘满 → kind 'quota'
      return Object.assign(new Error(message ?? 'ENOSPC: no space left on device'), { name: 'FsError', kind: 'quota', code: 'ENOSPC' })
    case 'enospc-sql': // SqlDatabase：SQLITE_FULL
      return Object.assign(new Error(message ?? 'database or disk is full'), { name: 'SqliteDriverError', kind: 'quota', code: 'SQLITE_FULL' })
    case 'enospc-idb': // IDB 侧 / RawStoreSink：配额
      return Object.assign(new Error(message ?? 'QuotaExceededError'), { name: 'QuotaExceededError', kind: 'quota' })
    case 'corrupt-sql':
      return Object.assign(new Error(message ?? 'database disk image is malformed'), { name: 'SqliteDriverError', kind: 'unavailable', code: 'SQLITE_CORRUPT' })
    case 'ioerr-sql':
      return Object.assign(new Error(message ?? 'disk I/O error'), { name: 'SqliteDriverError', kind: 'unavailable', code: 'SQLITE_IOERR' })
    case 'busy-sql':
      return Object.assign(new Error(message ?? 'database is locked'), { name: 'SqliteDriverError', kind: 'unknown', code: 'SQLITE_BUSY' })
    case 'clone': // 行无法克隆
      return Object.assign(new Error(message ?? 'could not be cloned'), { name: 'DataCloneError' })
    case 'unavailable':
      return Object.assign(new Error(message ?? 'unavailable'), { name: 'InfraError', kind: 'unavailable' })
    case 'permission':
      return Object.assign(new Error(message ?? 'permission denied'), { name: 'InfraError', kind: 'permission' })
    default:
      return Object.assign(new Error(message ?? 'injected failure'), { name: 'InjectedError', kind: 'unknown' })
  }
}

const SOURCE_METHODS = ['count', 'readBatch', 'estimateBytes']
const SINK_METHODS = ['writeBatch', 'clearAll']
const SQL_METHODS = ['run', 'all', 'transaction', 'batch', 'backupTo', 'integrityCheck', 'info', 'close']
const TX_METHODS = ['run', 'all']
const FS_METHODS = ['writeAtomic', 'read', 'readText', 'list', 'remove', 'freeBytes']

const normalizeMatch = (rule) => {
  const { match, path, store, sql, key } = rule
  return (call) => {
    if (match && !match(call)) return false
    if (path !== undefined) {
      const p = call.args[0]
      if (typeof p !== 'string') return false
      if (path instanceof RegExp ? !path.test(p) : p !== path) return false
    }
    if (store !== undefined && call.args[0] !== store) return false
    if (sql !== undefined) {
      const text = typeof call.args[0] === 'string' ? call.args[0] : ''
      if (sql instanceof RegExp ? !sql.test(text) : !text.includes(sql)) return false
    }
    if (key !== undefined) {
      // writeBatch(store, rows)：rows 里含该主键
      const rows = call.args[1]
      if (!Array.isArray(rows) || !rows.some((r) => (key instanceof RegExp ? key.test(r.key) : r.key === key))) return false
    }
    return true
  }
}

export const createFaultController = () => {
  const rules = []
  const log = []
  let seq = 0
  let dead = false
  let deadWhere

  const ctl = {
    /** 全部调用日志（含被注入失败的）：`{seq, target, method, args(截断), phase, outcome}` */
    log,
    get dead() { return dead },
    get deadWhere() { return deadWhere },
    revive() { dead = false; deadWhere = undefined },
    kill(where = 'manually') { dead = true; deadWhere = where },
    /** 清空规则与日志（保留 dead 状态由 revive 管）。 */
    reset() { rules.length = 0; log.length = 0; seq = 0 },

    /** 添加规则。返回规则对象（含 `fired` 计数，测试可断言「注入确实发生了」）。 */
    addRule(rule) {
      const r = { phase: 'before', times: 1, effect: 'throw', ...rule, seen: 0, fired: 0, matcher: normalizeMatch(rule) }
      rules.push(r)
      return r
    },
    failNth(target, nth, options = {}) {
      return ctl.addRule({ target, nth, ...options, error: options.error ?? makeError('unknown') })
    },
    failAlways(target, options = {}) {
      return ctl.addRule({ target, times: 0, ...options, error: options.error ?? makeError('unknown') })
    },
    /** 磁盘满：flavor 按对象前缀推断（fs.* → FsError quota；sql.* → SQLITE_FULL；其余 QuotaExceededError）。 */
    enospc(target, options = {}) {
      const flavor = target.startsWith('fs.') ? 'enospc-fs' : target.startsWith('sql') ? 'enospc-sql' : 'enospc-idb'
      return ctl.addRule({ target, times: options.times ?? 1, ...options, error: options.error ?? makeError(flavor) })
    },
    killBefore(target, options = {}) {
      return ctl.addRule({ target, ...options, phase: 'before', effect: 'kill' })
    },
    killAfter(target, options = {}) {
      return ctl.addRule({ target, ...options, phase: 'after', effect: 'kill' })
    },
    /** 方法成功执行之后做点事（损坏文件、改源数据、写目标…）。 */
    afterCall(target, options, fn) {
      return ctl.addRule({ target, ...options, phase: 'after', effect: fn })
    },
    beforeCall(target, options, fn) {
      return ctl.addRule({ target, ...options, phase: 'before', effect: fn })
    },
    callCount(target) {
      const [obj, method] = target.split('.')
      return log.filter((l) => l.target === obj && (method === '*' || l.method === method) && l.phase === 'start').length
    },

    // ------------------------------------------------------------ 包装器
    wrapSource: (source, name = 'source') => wrapMethods(ctl, source, name, SOURCE_METHODS),
    wrapSink: (sink, name = 'sink') => wrapMethods(ctl, sink, name, SINK_METHODS),
    wrapFs: (fs, name = 'fs') => wrapMethods(ctl, fs, name, FS_METHODS),
    wrapSql: (db, name = 'sql') => wrapSql(ctl, db, name),

    /** @internal */
    _run: (name, method, args, invoke) => runWithRules(name, method, args, invoke),
  }

  const runWithRules = async (name, method, args, invoke) => {
    if (dead) throw new CoordinatorKilled(`(already dead: ${deadWhere}) before ${name}.${method}`)
    const call = { target: name, method, args, seq: ++seq, n: 0 }
    log.push({ seq: call.seq, target: name, method, phase: 'start', args: summarizeArgs(args) })
    const hit = (phase) =>
      rules.filter((r) => {
        if (r.phase !== phase) return false
        if (r.target !== `${name}.${method}` && r.target !== `${name}.*`) return false
        return true
      })
    const fire = async (r, phase) => {
      if (!r.matcher(call)) return
      r.seen++
      call.n = r.seen
      if (r.nth !== undefined && r.seen !== r.nth) return
      if (r.times !== 0 && r.fired >= r.times) return
      r.fired++
      log.push({ seq: call.seq, target: name, method, phase: `inject-${phase}`, effect: typeof r.effect === 'function' ? 'fn' : r.effect })
      if (r.effect === 'kill') {
        dead = true
        deadWhere = `${phase} ${name}.${method}#${r.seen}`
        throw new CoordinatorKilled(deadWhere)
      }
      if (r.effect === 'throw') throw r.error ?? makeError('unknown')
      await r.effect(call, ctl)
    }
    for (const r of hit('before')) await fire(r, 'before')
    let result
    try {
      result = await invoke()
    } catch (error) {
      log.push({ seq: call.seq, target: name, method, phase: 'end', outcome: `error:${error?.name}` })
      throw error
    }
    log.push({ seq: call.seq, target: name, method, phase: 'end', outcome: 'ok' })
    call.result = result
    for (const r of hit('after')) await fire(r, 'after')
    if (dead) throw new CoordinatorKilled(`(died during) ${name}.${method}`)
    return result
  }

  return ctl
}

const summarizeArgs = (args) =>
  args.map((a) => {
    if (typeof a === 'string') return a.length > 60 ? `${a.slice(0, 60)}…` : a
    if (Array.isArray(a)) return `Array(${a.length})`
    if (a instanceof Uint8Array) return `Uint8Array(${a.length})`
    if (a && typeof a === 'object') return `{${Object.keys(a).slice(0, 4).join(',')}}`
    return a
  })

const wrapMethods = (ctl, target, name, methods) => {
  const wrapped = Object.create(target)
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue
    wrapped[method] = (...args) => ctl._run(name, method, args, () => target[method](...args))
  }
  // 非方法属性（如 fs.supported）按原样透传
  for (const key of Object.keys(target)) if (!(key in wrapped) || typeof target[key] !== 'function') wrapped[key] = target[key]
  return wrapped
}

const wrapSql = (ctl, db, name) => {
  const wrapped = wrapMethods(ctl, db, name, SQL_METHODS.filter((m) => m !== 'transaction'))
  wrapped.transaction = (work, options) =>
    ctl._run(name, 'transaction', [work, options], () =>
      db.transaction((tx) => work(wrapMethods(ctl, tx, `${name}.tx`, TX_METHODS)), options)
    )
  return wrapped
}

// ---------------------------------------------------------------- 文件损坏 / 源数据变动

/**
 * 损坏 `fs` 里的一个文件。`fs` 必须是**未包装**的真实 fs（否则注入规则会拦住损坏动作自己）。
 * mode: 'flip-byte' 翻一个字节 | 'truncate' 截断到一半 | 'empty' 清空 | 'delete' 删除 | 'garbage' 换成无关内容 |
 *       'append-junk' 尾部追加垃圾 | 'stale' 换成 `staleContent`
 */
export const corruptFile = async (fs, path, mode, options = {}) => {
  if (mode === 'delete') return fs.remove(path)
  const current = await fs.read(path)
  if (current === undefined) throw new Error(`corruptFile: ${path} does not exist`)
  let next
  switch (mode) {
    case 'flip-byte': {
      next = Uint8Array.from(current)
      const at = options.at ?? Math.floor(next.length / 2)
      next[at] ^= 0x01
      break
    }
    case 'truncate':
      next = current.slice(0, Math.max(0, Math.floor(current.length / 2)))
      break
    case 'empty':
      next = new Uint8Array(0)
      break
    case 'garbage':
      next = new TextEncoder().encode('\u0000not json at all\u0000')
      break
    case 'append-junk':
      next = Uint8Array.from([...current, ...new TextEncoder().encode('\n}}}{{')])
      break
    case 'stale':
      next = typeof options.staleContent === 'string' ? new TextEncoder().encode(options.staleContent) : options.staleContent
      break
    default:
      throw new Error(`unknown corrupt mode ${mode}`)
  }
  await fs.writeAtomic(path, next)
}

/** 直接改磁盘上的文件（给真文件系统/SQLite 文件用）：翻转 `offset` 处一个字节。 */
export const flipByteInFile = async (absPath, offset) => {
  const { open } = await import('node:fs/promises')
  const handle = await open(absPath, 'r+')
  try {
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, offset)
    buf[0] ^= 0xff
    await handle.write(buf, 0, 1, offset)
  } finally {
    await handle.close()
  }
}

/**
 * 迁移间隙里改源数据。`data` 是 `{store: Map}`（memorySource 的底层）。
 * op: 'add' | 'delete' | 'mutate' | 'replace-blob-byte'
 */
export const mutateSourceData = async (data, op) => {
  const m = data[op.store]
  switch (op.kind) {
    case 'add':
      m.set(op.key, op.value)
      break
    case 'delete':
      m.delete(op.key)
      break
    case 'mutate': {
      const v = structuredClone(m.get(op.key))
      op.fn(v)
      m.set(op.key, v)
      break
    }
    case 'replace-blob-byte': {
      const row = m.get(op.key)
      const bytes = new Uint8Array(await row.blob.arrayBuffer())
      bytes[op.offset ?? 0] ^= 0xff
      m.set(op.key, { ...row, blob: new Blob([bytes], { type: row.blob.type }) })
      break
    }
    default:
      throw new Error(`unknown mutation ${op.kind}`)
  }
}

// ---------------------------------------------------------------- 测试用内存 AppFileSystem（不 import src）

/**
 * 结构上满足 `AppFileSystem` 的内存实现，仅作**宿主机测试替身**（它不是生产降级路径）。
 * 额外能力：`snapshot()` / `restore()`（模拟「进程死后磁盘上留下什么」）、`freeBytes` 可设、写入前按 `capacity` 判 ENOSPC。
 * `writeAtomic` 是真原子的：要么整文件换成新内容，要么保持旧内容（注入点在调用前/后，不在中间）。
 */
export const createHostFs = (options = {}) => {
  const files = new Map()
  let capacity = options.capacity ?? Infinity
  const enc = new TextEncoder()
  const used = () => [...files.values()].reduce((n, b) => n + b.length, 0)
  const fs = {
    supported: true,
    files,
    setCapacity(n) { capacity = n },
    async writeAtomic(path, data) {
      const bytes = typeof data === 'string' ? enc.encode(data) : Uint8Array.from(data)
      const old = files.get(path)?.length ?? 0
      if (used() - old + bytes.length > capacity) throw makeError('enospc-fs')
      files.set(path, bytes)
    },
    async read(path) { const b = files.get(path); return b === undefined ? undefined : Uint8Array.from(b) },
    async readText(path) { const b = files.get(path); return b === undefined ? undefined : new TextDecoder().decode(b) },
    async list(dir) {
      const prefix = dir === '' ? '' : `${dir}/`
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, b]) => ({ name: p.slice(prefix.length), size: b.length, modifiedAt: 0 }))
    },
    async remove(path) {
      files.delete(path)
      for (const p of [...files.keys()]) if (p.startsWith(`${path}/`)) files.delete(p)
    },
    async freeBytes() { return capacity === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(0, capacity - used()) },
    snapshot() { return new Map([...files].map(([p, b]) => [p, Uint8Array.from(b)])) },
    restore(snap) { files.clear(); for (const [p, b] of snap) files.set(p, Uint8Array.from(b)) },
    sha256Of(path) { const b = files.get(path); return b === undefined ? undefined : createHash('sha256').update(b).digest('hex') },
  }
  return fs
}
