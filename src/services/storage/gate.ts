/**
 * 启动闸门（#910 D1）：在 UI 挂载、store 首次读库**之前**决定真源，必要时跑迁移。
 *
 * 视图状态（`GateView`）是一个普通的可订阅对象，迁移页用 `useSyncExternalStore` 订阅；本文件不 import react。
 *
 *   checking ──(无注册运行时 / 开关关且未 committed / 能力不满足)──→ ready（行为与合并前一致）
 *   checking ──(路由=sqlite 或 indexeddb 且无需迁移)──────────────→ ready
 *   checking ──(开关开 + 能力满足 + 未 committed)──→ migrating ──→ ready（committed）
 *                                                         ╰──→ failed（可「重试」/「继续使用」）
 *   checking ──(路由=blocked)──────────────────────────────────→ blocked（不进业务页，不显示空白欢迎页）
 *
 * 失败后**不自动重试**：同一次启动里只有用户点「重试」才会再跑；下次启动若状态仍是 failed，会再自动跑一次。
 * 「继续使用」只对「仍以 IDB 为真源」的失败成立：点击时重新走一遍路由，路由说是 sqlite / blocked 就照办，不让用户落到过期的旧库。
 */
import { getFs } from '../fs/index.js'
import { NATIVE_SQLITE_MIGRATION_ENABLED } from './migration/config.js'
import { buildMigrationDeps, buildRouterDeps } from './migration/deps.js'
import { runMigration } from './migration/orchestrator.js'
import { getStorageRuntime, setEngineChoice, setMigrationRunning, type StorageRuntime } from './migration/runtime.js'
import type { MigrationFailure, MigrationPhase, StorageEngineChoice } from './migration/types.js'
import { resolveStorageEngine } from './router.js'

type BlockedChoice = Extract<StorageEngineChoice, { engine: 'blocked' }>

export type GateView =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | {
      kind: 'migrating'
      phase: MigrationPhase
      percent: number
      preflight?: { estimateBytes: number; requiredBytes: number; warn: boolean }
    }
  | { kind: 'failed'; failure: MigrationFailure }
  | { kind: 'blocked'; reason: BlockedChoice['reason']; detail?: string }

export type GateOptions = {
  /** 测试注入；缺省取注册的运行时与编译期开关 */
  runtime?: StorageRuntime | undefined
  enabled?: boolean
}

let view: GateView = { kind: 'checking' }
const listeners = new Set<() => void>()
let inFlight: Promise<GateView> | undefined
let lastOptions: GateOptions = {}

const publish = (next: GateView): void => {
  view = next
  for (const listener of [...listeners]) {
    listener()
  }
}

export const getGateView = (): GateView => view
export const subscribeGate = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const settle = (choice: StorageEngineChoice): GateView => {
  setEngineChoice(choice)
  setMigrationRunning(false)
  if (choice.engine === 'blocked') {
    publish({ kind: 'blocked', reason: choice.reason, ...(choice.detail !== undefined ? { detail: choice.detail } : {}) })
  } else {
    publish({ kind: 'ready' })
  }
  return view
}

const decide = async (options: GateOptions): Promise<GateView> => {
  const runtime = 'runtime' in options ? options.runtime : getStorageRuntime()
  const enabled = options.enabled ?? NATIVE_SQLITE_MIGRATION_ENABLED
  if (runtime === undefined) {
    setEngineChoice(undefined)
    publish({ kind: 'ready' })
    return view
  }
  const routerDeps = buildRouterDeps(runtime)
  const choice = await resolveStorageEngine(routerDeps)
  // 只有「还是 IDB、且本来可以迁」的人才需要迁移：能力满足（私有目录可用 + SQLite 可用）+ 开关开。
  const needsMigration =
    enabled && choice.engine === 'indexeddb' && choice.reason !== 'web' && getFs().supported && (await runtime.isSqliteAvailable())
  if (!needsMigration) {
    return settle(choice)
  }
  return runMigrationUi(runtime)
}

const runMigrationUi = async (runtime: StorageRuntime): Promise<GateView> => {
  setMigrationRunning(true)
  publish({ kind: 'migrating', phase: 'idle', percent: 0 })
  try {
    const outcome = await runMigration(
      buildMigrationDeps(runtime, {
        onProgress: ({ phase, percent, preflight }) => {
          // 预检信息只在预检时发一次，后续阶段沿用，迁移页一直能显示体积提示
          const kept = preflight ?? (view.kind === 'migrating' ? view.preflight : undefined)
          publish({ kind: 'migrating', phase, percent, ...(kept ? { preflight: kept } : {}) })
        },
      }),
    )
    setMigrationRunning(false)
    if (outcome.status === 'committed') {
      return settle({ engine: 'sqlite' })
    }
    if (outcome.status === 'blocked') {
      return settle({ engine: 'blocked', reason: 'needs-user-decision', detail: outcome.detail })
    }
    // 失败后再问一遍路由：「写完 meta 才失败」的窗口里真源其实已是 SQLite，不能让用户回到旧库。
    const after = await resolveStorageEngine(buildRouterDeps(runtime))
    if (after.engine === 'sqlite' || after.engine === 'blocked') {
      return settle(after)
    }
    publish({ kind: 'failed', failure: outcome.failure })
    return view
  } catch (error) {
    setMigrationRunning(false)
    publish({
      kind: 'failed',
      failure: { code: 'unknown', message: error instanceof Error ? error.message : String(error), at: Date.now() },
    })
    return view
  }
}

/** 启动入口：幂等，并发调用共享同一次执行。 */
export const ensureStorageReady = (options: GateOptions = {}): Promise<GateView> => {
  if (inFlight === undefined) {
    lastOptions = options
    publish({ kind: 'checking' })
    inFlight = decide(options).catch((error: unknown) =>
      settle({ engine: 'blocked', reason: 'needs-user-decision', detail: error instanceof Error ? error.message : String(error) }),
    )
  }
  return inFlight
}

/** 用户点「重试」：同一启动内的再一次迁移（手动触发，不是自动循环）。 */
export const retryMigration = async (): Promise<GateView> => {
  const runtime = 'runtime' in lastOptions ? lastOptions.runtime : getStorageRuntime()
  if (runtime === undefined || view.kind !== 'failed') {
    return view
  }
  inFlight = runMigrationUi(runtime)
  return inFlight
}

/** 用户点「继续使用」：仍以旧数据为真源。重新走路由，路由不同意就不放行。 */
export const continueWithLegacy = async (): Promise<GateView> => {
  const runtime = 'runtime' in lastOptions ? lastOptions.runtime : getStorageRuntime()
  if (runtime === undefined || view.kind !== 'failed') {
    return view
  }
  return settle(await resolveStorageEngine(buildRouterDeps(runtime)))
}

/** 仅测试用：重置闸门单例。 */
export const resetGateForTests = (): void => {
  inFlight = undefined
  lastOptions = {}
  setMigrationRunning(false)
  setEngineChoice(undefined)
  publish({ kind: 'checking' })
}
