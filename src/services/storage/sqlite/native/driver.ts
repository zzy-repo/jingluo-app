/**
 * Native SQLite 适配器（#913）：唯一允许碰 `@capacitor/*` 的位置。
 *
 * - 探测 `AppSqlite` 插件（方法清单 + ping）
 * - 过桥编解码（null/number/string/BLOB、整数安全范围、结果大小）
 * - 事务句柄管理（令牌 ↔ 活跃事务）
 * - 错误标准化（code → kind，不吞异常）
 * - 语句参数与结果行映射
 */

import { registerPlugin } from '@capacitor/core'
import { infraErrorOfProbe, probeNativePlugin } from '../../../capability/probe.js'
import { infraKindOfRejection } from '../../../capability/errors.js'
import { InfraError } from '../../../capability/errors.js'
import type {
  SqlDatabase,
  SqlErrorShape,
  SqlRow,
  SqlTx,
  SqlValue,
  OpenSqlDatabase,
} from '../driver.js'

/**
 * 与 `AppSqlitePlugin.java` 一一对应的桥接口。
 * {@code error.data} 里携带 {@code kind} / {@code code} / {@code retryable} / {@code message}；
 * {@code error.index}（可选）标记批中出错语句下标。
 */
export interface AppSqliteBridge {
  open(options: { name: string }): Promise<void>
  run(options: { name: string; sql: string; params?: unknown[] }): Promise<{ changes: number }>
  all(options: { name: string; sql: string; params?: unknown[] }): Promise<{ rows: SqlRow[] }>
  batch(options: {
    name: string
    statements: readonly { sql: string; params?: unknown[] }[]
  }): Promise<{ results: { changes: number }[] }>
  txBegin(options: { name: string; txTimeoutMs?: number }): Promise<{ token: string }>
  txRun(options: { name: string; token: string; sql: string; params?: unknown[] }): Promise<{ changes: number }>
  txAll(options: { name: string; token: string; sql: string; params?: unknown[] }): Promise<{ rows: SqlRow[] }>
  txCommit(options: { name: string; token: string }): Promise<void>
  txRollback(options: { name: string; token: string }): Promise<void>
  backupTo(options: { name: string; path: string }): Promise<{ bytes: number }>
  integrityCheck(options: { name: string }): Promise<{ problems: string[] }>
  info(options: { name: string }): Promise<{
    sqliteVersion: string
    journalMode: string
    synchronous: string
    foreignKeys: boolean
    busyTimeout: number
    path: string
    kind: 'native-android' | 'native-ios'
  }>
  close(options: { name: string }): Promise<void>
  capabilities(): Promise<{ methods: string[] }>
  ping(): Promise<void>
}

export const APP_SQLITE_PLUGIN_NAME = 'AppSqlite'

/** 本实现用到的全部桥方法；任一缺失都判 method-missing。 */
const REQUIRED_METHODS = [
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
] as const

const getNativeBridge = (): AppSqliteBridge => registerPlugin<AppSqliteBridge>(APP_SQLITE_PLUGIN_NAME)

/** 过桥 Promise 拒绝 → SqlErrorShape（kind / code / message / retryable）。 */
const errorShapeOf = (error: unknown): SqlErrorShape => {
  const data = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const kind = typeof data.kind === 'string' ? data.kind : infraKindOfRejection(error)
  const code =
    typeof data.code === 'string'
      ? (data.code as SqlErrorShape['code'])
      : typeof data.kind === 'string'
        ? (data.kind as SqlErrorShape['code'])
        : 'OTHER'
  const message =
    typeof data.message === 'string'
      ? data.message
      : typeof error === 'object' && error !== null && (error as { message?: unknown }).message
        ? String((error as { message?: unknown }).message)
        : String(error)
  return { kind: kind as SqlErrorShape['kind'], code, message }
}

/**
 * 过桥结果的一行。检查：null/number/string 透传；{@code {"$b64":"..."}} 还原成 Uint8Array；
 * 整数超 2^53 拒绝；其余类型报错。
 */
const decodeRow = (raw: Record<string, unknown>): SqlRow => {
  const row: SqlRow = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      row[key] = null
    } else if (typeof value === 'number') {
      const n = value
      if (!Number.isFinite(n)) {
        throw new Error(`non-finite number at column ${key}`)
      }
      row[key] = n
    } else if (typeof value === 'string') {
      row[key] = value
    } else if (typeof value === 'object' && '$b64' in value && typeof (value as { $b64: unknown }).$b64 === 'string') {
      const b64 = (value as { $b64: string }).$b64
      try {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i)
        }
        row[key] = bytes
      } catch (error) {
        throw new Error(`bad base64 blob at column ${key}`)
      }
    } else {
      throw new Error(`unsupported column type at ${key}: ${typeof value}`)
    }
  }
  return row
}

/** 参数序列化：null/number/string 透传；Uint8Array 编成 {"$b64":"..."}；整数超 2^53 拒绝。 */
const encodeParams = (params: readonly SqlValue[] | undefined): unknown[] | undefined => {
  if (!params) {
    return undefined
  }
  return params.map((value, index) => {
    if (value === null) {
      return null
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`non-finite number at param ${index}`)
      }
      if (Math.abs(value) > 9007199254740991) {
        throw new Error(`integer param ${index} exceeds safe range [-(2^53-1), 2^53-1]`)
      }
      return value
    }
    if (typeof value === 'string') {
      return value
    }
    if (value instanceof Uint8Array) {
      let b64 = ''
      for (let i = 0; i < value.length; i += 0x8000) {
        b64 += String.fromCharCode(...value.subarray(i, i + 0x8000))
      }
      return { $b64: btoa(b64) }
    }
    throw new Error(`unsupported param type at ${index}: ${typeof value}`)
  })
}

/**
 * 首次 I/O 前做一次完整探测（方法清单 + 运行时 ping）。通过后记住；失败不记（瞬时失败下次还能恢复），
 * 并抛对应 kind 的 `InfraError`。
 */
const createReadyGate = (bridge: AppSqliteBridge): (() => Promise<void>) => {
  let verified = false
  return async () => {
    if (verified) {
      return
    }
    const result = await probeNativePlugin(APP_SQLITE_PLUGIN_NAME, {
      bridge,
      methods: REQUIRED_METHODS,
      ping: () => bridge.ping(),
    })
    if (!result.available) {
      const error = infraErrorOfProbe(result, 'native sqlite')
      throw new InfraError(error.kind, error.message)
    }
    verified = true
  }
}

/** 一条活跃的写事务（整个库级别一条，其它调用排队）。 */
interface ActiveTx {
  token: string
  tx: SqlTx
}

/** 创建 {@code SqlTx} 面：只能在回调里用，回调结束或超时立刻失效。 */
const createTx = (name: string, token: string, bridge: AppSqliteBridge): SqlTx => ({
  async run(sql, params) {
    const result = await bridge.txRun({ name, token, sql, params: encodeParams(params) })
    return result
  },
  async all(sql, params) {
    const result = await bridge.txAll({ name, token, sql, params: encodeParams(params) })
    return result.rows.map(decodeRow)
  },
})

const createNativeSqliteDatabase = (name: string, bridge: AppSqliteBridge): SqlDatabase => {
  let activeTx: ActiveTx | undefined

  return {
    async run(sql, params) {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction; use tx methods')
      }
      try {
        return await bridge.run({ name, sql, params: encodeParams(params) })
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async all(sql, params) {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction; use tx methods')
      }
      try {
        const result = await bridge.all({ name, sql, params: encodeParams(params) })
        return result.rows.map(decodeRow)
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async batch(statements) {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction; use tx methods')
      }
      try {
        const result = await bridge.batch({
          name,
          statements: statements.map(stmt => ({
            sql: stmt.sql,
            params: encodeParams(stmt.params),
          })),
        })
        return result.results
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async transaction(work, options) {
      if (activeTx) {
        throw new InfraError('unavailable', 'nested transactions not supported')
      }
      let token: string
      try {
        const beginResult = await bridge.txBegin({ name, txTimeoutMs: options?.txTimeoutMs })
        token = beginResult.token
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }

      const tx = createTx(name, token, bridge)
      activeTx = { token, tx }
      try {
        const result = await work(tx)
        await bridge.txCommit({ name, token })
        activeTx = undefined
        return result
      } catch (error) {
        activeTx = undefined
        try {
          await bridge.txRollback({ name, token })
        } catch {
          // 回滚失败时不掩盖原始错误
        }
        if (error instanceof InfraError) {
          throw error
        }
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async backupTo(destRelativePath) {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction')
      }
      try {
        return await bridge.backupTo({ name, path: destRelativePath })
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async integrityCheck() {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction')
      }
      try {
        const result = await bridge.integrityCheck({ name })
        return result.problems
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async info() {
      try {
        const result = await bridge.info({ name })
        return {
          sqliteVersion: result.sqliteVersion,
          journalMode: result.journalMode,
          synchronous: result.synchronous as 'FULL' | 'NORMAL' | 'OFF' | 'EXTRA' | string,
          foreignKeys: result.foreignKeys,
          path: result.path,
          kind: result.kind,
        }
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },

    async close() {
      if (activeTx) {
        throw new InfraError('unavailable', 'connection is inside a transaction; close after commit/rollback')
      }
      try {
        await bridge.close({ name })
      } catch (error) {
        const shape = errorShapeOf(error)
        throw new InfraError(shape.kind, shape.message)
      }
    },
  }
}

/** 探测并打开 Native SQLite。如果不可用就抛 InfraError（不降级）。 */
export const openNativeSqlite: OpenSqlDatabase = async (options) => {
  const bridge = getNativeBridge()
  const ready = createReadyGate(bridge)

  await ready()

  try {
    await bridge.open({ name: options.name })
  } catch (error) {
    const shape = errorShapeOf(error)
    throw new InfraError(shape.kind, shape.message)
  }

  return createNativeSqliteDatabase(options.name, bridge)
}

/**
 * 检查 Native SQLite 是否可用（非阻塞，仅同步部分 + ping）。
 * 返回 true 仅表示「本次探测成功」，下次启动时可能变成 false（例如权限状态变化）。
 * 供路由层决策是否优先尝试 Native，不能用来断定最终能否打开。
 */
export const isNativeSqliteAvailable = async (): Promise<boolean> => {
  const bridge = getNativeBridge()
  const result = await probeNativePlugin(APP_SQLITE_PLUGIN_NAME, {
    bridge,
    methods: REQUIRED_METHODS,
    ping: () => bridge.ping(),
  })
  return result.available
}
