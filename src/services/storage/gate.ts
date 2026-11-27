/**
 * 启动闸门（#910 D1）：在 UI 挂载、store 首次读库**之前**决定真源，必要时跑迁移。
 *
 * 视图状态（`GateView`）是一个普通的可订阅对象，迁移页用 `useSyncExternalStore` 订阅；本文件不 import react。
 *
 *   checking ──(无注册运行时 / 开关关且未 committed)──────────────→ ready（行为与合并前一致）
 *   checking ──(路由=sqlite 或 indexeddb 且无需迁移)──────────────→ ready
 *   checking ──(开关开 + 能力满足 + 未 committed)──→ migrating ──→ succeeded ──(确认/停留)──→ ready
 *                                                         ├──→ failed（可「重试」/「重新检测」/「继续使用」）
 *                                                         └──→ blocked
 *   checking ──(开关开 + 可迁但 SQLite 运行时缺失)───────────────→ unsupported ──(确认)──→ ready
 *   checking ──(路由=blocked)──────────────────────────────────→ blocked（不进业务页，不显示空白欢迎页）
 *
 * 失败后**不自动重试**：同一次启动里只有用户点「重试」/「重新检测」才会再跑；下次启动若状态仍是 failed，会再自动跑一次。
 * 「继续使用」只对「仍以 IDB 为真源」的失败成立：点击时重新走一遍路由，路由说是 sqlite / blocked 就照办，不让用户落到过期的旧库。
 *
 * 两个一次性提示态（#916 交互缺口）：
 *  - `succeeded`：**只可能**由 `runMigration` 返回 `status:'committed'` 产生。而 `committed` 在编排器里只有一条路径——
 *    `report.ok === true` 的全量校验 + 提交前 `integrity_check` + 逐 store 计数复核 + 源指纹未变（见
 *    `migration/orchestrator.ts` 的 verifying / commit 两段）。所以「已完成迁移并通过完整性校验」这句话只会在真校验
 *    通过之后出现；report.ok 为 false / 未校验的路径全部落在 `failed`，压根到不了这个分支。
 *    它也不需要「只提示一次」的持久标记：下次冷启动路由已经是 sqlite，`needsMigration` 为假 → 直接 ready。
 *  - `unsupported`：本可以迁（原生 + 开关开）但 SQLite 运行时不可用。以前这里静默 `settle(ready)`，用户以为什么都没发生；
 *    现在明确告知一次（localStorage 记一笔），确认后照旧用 IndexedDB，不拦人。
 */
import { getFs } from '../fs/index.js'
import { NATIVE_SQLITE_MIGRATION_ENABLED } from './migration/config.js'
import { buildMigrationDeps, buildRouterDeps } from './migration/deps.js'
import { parseSpaceMessage, runMigration } from './migration/orchestrator.js'
import { getStorageRuntime, setEngineChoice, setMigrationRunning, type StorageRuntime } from './migration/runtime.js'
import type { MigrationFailure, MigrationPhase, StorageEngineChoice } from './migration/types.js'
import { resolveStorageEngine } from './router.js'

type BlockedChoice = Extract<StorageEngineChoice, { engine: 'blocked' }>

/**
 * 迁移页的体积提示（预检阶段发布）。
 *
 * `freeBytes` 是本文件自己从 `getFs()` 读的：编排器 `onProgress.preflight` 的载荷被单测钉成三个字段
 * （`tests/unit/migration-switch-preflight.test.mjs` 的 deepEqual），所以「可用空间」不走那条契约，
 * 而是闸门在同一个 fs 上读一次（见 `freeBytesNow`）。失败页的权威数字另有来源（见 `shortfallOf`）。
 */
export type MigrationSpace = {
  estimateBytes: number
  requiredBytes: number
  /** 读不到（Web / 原生桥缺 free 能力）时为 undefined，视图不显示数字而是给说明 */
  freeBytes?: number
  /** 越过 200MB 警告线（只影响措辞，不再决定「给不给数字」） */
  warn: boolean
}

/** 失败页的三个数：可用 / 所需 / 建议清理（`freeBytes` 缺失 = 无法确认可用空间）。 */
export type MigrationSpaceShortfall = {
  requiredBytes: number
  freeBytes?: number
  estimateBytes?: number
}

export type GateView =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'migrating'; phase: MigrationPhase; percent: number; preflight?: MigrationSpace }
  /** 迁移真校验通过后的成功提示（只有 `status:'committed'` 会走到这里），确认或短暂停留后进 App */
  | { kind: 'succeeded' }
  | { kind: 'failed'; failure: MigrationFailure; space?: MigrationSpaceShortfall }
  /** 本机暂不支持存储升级：明确告知一次，继续用 IndexedDB，不影响正常使用 */
  | { kind: 'unsupported' }
  | { kind: 'blocked'; reason: BlockedChoice['reason']; detail?: string }

export type GateOptions = {
  /** 测试注入；缺省取注册的运行时与编译期开关 */
  runtime?: StorageRuntime | undefined
  enabled?: boolean
}

/** `unsupported` 提示只出现一次：确认过就记一笔，别每次冷启动都拦一张卡片。 */
const UNSUPPORTED_NOTICE_KEY = 'chat-demo:storage-gate:unsupported-ack'

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

/** localStorage 可能不可用（隐私模式 / 单测环境没装 DOM 替身）：读不到就当作「还没提示过」。 */
const readNoticeFlag = (key: string): boolean => {
  try {
    if (typeof localStorage === 'undefined') {
      return false
    }
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const writeNoticeFlag = (key: string): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, '1')
    }
  } catch {
    // 写不进去最多是下次再提示一次，不影响迁移与真源判定
  }
}

/** 读当前可用空间：失败或非有限数一律 undefined（视图据此改说「无法确认」而不是编一个 0）。 */
const freeBytesNow = async (): Promise<number | undefined> => {
  try {
    const free = await getFs().freeBytes()
    return typeof free === 'number' && Number.isFinite(free) && free >= 0 ? free : undefined
  } catch {
    return undefined
  }
}

/** 失败页要的三个数。`insufficient-space` 用**判定那一刻**的 need/have（就在失败说明里），不重读磁盘。 */
const shortfallOf = (
  failure: MigrationFailure,
  seen: MigrationSpace | undefined,
  freeFallback: number | undefined,
): MigrationSpaceShortfall | undefined => {
  if (failure.code !== 'insufficient-space') {
    return undefined
  }
  const judged = parseSpaceMessage(failure.message)
  const requiredBytes = judged?.requiredBytes ?? seen?.requiredBytes
  if (requiredBytes === undefined) {
    // 连「需要多少」都不知道（例如复制中途磁盘写满的 quota 错误）：交给 UI 的兜底文案
    return undefined
  }
  const freeBytes = judged?.freeBytes ?? seen?.freeBytes ?? freeFallback
  return {
    requiredBytes,
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    ...(seen !== undefined ? { estimateBytes: seen.estimateBytes } : {}),
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
  // 只有「还是 IDB、且本来可以迁」的人才需要迁移：开关开 + 原生私有目录可用。
  const migratable = enabled && choice.engine === 'indexeddb' && choice.reason !== 'web' && getFs().supported
  if (!migratable) {
    return settle(choice)
  }
  if (!(await runtime.isSqliteAvailable())) {
    // 场景 3：能迁、但 SQLite 运行时缺失。以前这里是静默 `settle(ready)`，用户以为什么都没发生。
    // 现在明确告知一次（不拦人：一张卡片 + 一个按钮），之后静默 ready。
    if (!readNoticeFlag(UNSUPPORTED_NOTICE_KEY)) {
      setEngineChoice(choice)
      setMigrationRunning(false)
      publish({ kind: 'unsupported' })
      return view
    }
    return settle(choice)
  }
  return runMigrationUi(runtime)
}

const runMigrationUi = async (runtime: StorageRuntime): Promise<GateView> => {
  setMigrationRunning(true)
  publish({ kind: 'migrating', phase: 'idle', percent: 0 })
  const freeAtStart = await freeBytesNow()
  let space: MigrationSpace | undefined
  try {
    const outcome = await runMigration(
      buildMigrationDeps(runtime, {
        onProgress: ({ phase, percent, preflight }) => {
          // 预检信息只在预检时发一次，后续阶段沿用，迁移页一直能显示体积提示
          if (preflight !== undefined) {
            space = { ...preflight, ...(freeAtStart !== undefined ? { freeBytes: freeAtStart } : {}) }
          }
          publish({ kind: 'migrating', phase, percent, ...(space !== undefined ? { preflight: space } : {}) })
        },
      }),
    )
    setMigrationRunning(false)
    if (outcome.status === 'committed') {
      // 成功提示的唯一来源：编排器只在 校验 report.ok + 提交前 integrity_check + 逐 store 计数复核 + 源指纹
      // 全部通过后才写 committed 并返回 status:'committed'。真源已定（sqlite），这里只负责「说一声」再放行。
      setEngineChoice({ engine: 'sqlite' })
      publish({ kind: 'succeeded' })
      return view
    }
    if (outcome.status === 'blocked') {
      return settle({ engine: 'blocked', reason: 'needs-user-decision', detail: outcome.detail })
    }
    // 失败后再问一遍路由：「写完 meta 才失败」的窗口里真源其实已是 SQLite，不能让用户回到旧库。
    const after = await resolveStorageEngine(buildRouterDeps(runtime))
    if (after.engine === 'sqlite' || after.engine === 'blocked') {
      return settle(after)
    }
    const shortfall = shortfallOf(outcome.failure, space, freeAtStart)
    publish({ kind: 'failed', failure: outcome.failure, ...(shortfall !== undefined ? { space: shortfall } : {}) })
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

/**
 * 用户点「重新检测」：清掉本次启动的判定缓存，重新走一遍 `ensureStorageReady`（路由 + 预检）。
 * 与 `retryMigration` 的区别：这里重新判定「现在到底该不该迁」，而不是在失败路径上直接重跑复制。
 */
export const recheckStorage = (): Promise<GateView> => {
  if (view.kind !== 'failed') {
    return Promise.resolve(view)
  }
  inFlight = undefined
  return ensureStorageReady(lastOptions)
}

/** 用户点「继续使用」：仍以旧数据为真源。重新走路由，路由不同意就不放行。 */
export const continueWithLegacy = async (): Promise<GateView> => {
  const runtime = 'runtime' in lastOptions ? lastOptions.runtime : getStorageRuntime()
  if (runtime === undefined || view.kind !== 'failed') {
    return view
  }
  return settle(await resolveStorageEngine(buildRouterDeps(runtime)))
}

/**
 * 一次性提示态（`succeeded` / `unsupported`）的「知道了」：真源已经定好，这里只放行 `<App/>`。
 * `unsupported` 顺手记一笔，避免每次冷启动都拦卡片；`succeeded` 不需要记——下次启动路由已是 sqlite。
 */
export const acknowledgeGateNotice = (): GateView => {
  if (view.kind === 'succeeded') {
    publish({ kind: 'ready' })
  } else if (view.kind === 'unsupported') {
    writeNoticeFlag(UNSUPPORTED_NOTICE_KEY)
    publish({ kind: 'ready' })
  }
  return view
}

/** 仅测试用：重置闸门单例。 */
export const resetGateForTests = (): void => {
  inFlight = undefined
  lastOptions = {}
  setMigrationRunning(false)
  setEngineChoice(undefined)
  // 「只提示一次」的标记也要清：否则同一个测试进程里第二次跑「SQLite 不可用」用例会得不到提示态
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(UNSUPPORTED_NOTICE_KEY)
    }
  } catch {
    // 清不掉只是测试环境的事，不影响被测逻辑
  }
  publish({ kind: 'checking' })
}
