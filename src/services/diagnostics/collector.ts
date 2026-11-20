import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { MAX_LOG_ENTRIES, MAX_LOG_MESSAGE_LENGTH } from './config.js'
import {
  FEEDBACK_SCHEMA_VERSION,
  type AppInfo,
  type DeviceInfo,
  type EventKind,
  type LogEntry,
  type LogLevel,
  type LogMeta,
  type LogSnapshot,
  type SystemInfo,
} from './types.js'
import { redact, redactUrl, safeString, truncate } from './redact.js'
import { endpointKeyFromUrl, sanitizeMeta } from './fields.js'
import { bytesPerSecond } from './timing.js'
import { readCapabilityTruth } from './capabilityTruth.js'
import { isFetchPatched } from '../../utils/capabilities.js'

/**
 * 采集层：只负责「记什么」。
 *
 * 三条硬规则：
 * 1. 不认识上传：本文件**不 import transport**，对外只给 getSnapshot()，谁发、发到哪由门面决定；
 * 2. 脱敏在采集时完成（写入缓冲之前），上传层拿到的东西已经是干净的；
 * 3. 绝不采集 API Key 原文与用户对话正文，只记长度 / 条数这类统计量。
 *
 * 「有效覆盖」的四个防空机制也在这里：
 * - 启动即写 app_launch（缓冲区永不为空）；
 * - 每 30 秒 + 关键动作后写 state_snapshot；
 * - 最近 50 个用户动作留痕（点击 / 导航 / 切前后台）；
 * - 所有 catch / 非 2xx / 超时强制写 error 级日志（带 status、durationMs、错误原文、阶段）。
 *
 * 保留策略是**双限**：最多 500 条 **且** 只保留最近 30 分钟（取交集）。
 */

/** 环形缓冲条数上限 */
const MAX_ENTRIES = MAX_LOG_ENTRIES
/** 单条 msg 截断长度 */
const MAX_MSG_LENGTH = MAX_LOG_MESSAGE_LENGTH
/** meta 里字符串值的截断长度（够定位问题即可） */
const MAX_META_LENGTH = 300
/** 时间维度保留：只留最近 30 分钟 */
export const RETENTION_MS = 30 * 60 * 1000
/** 最近保留的用户动作条数（动作链） */
export const MAX_ACTION_TRAIL = 50
/** 周期快照间隔 */
const SNAPSHOT_INTERVAL_MS = 30_000

const DB_NAME = 'chat-diagnostics'
const DB_VERSION = 1
const STORE = 'logs'
const CLIENT_ID_KEY = 'chat-demo:diagnostics-client-id'

type StoredLog = { seq: number } & LogEntry

interface DiagnosticsDB extends DBSchema {
  logs: { key: number; value: StoredLog }
}

// ---------------------------------------------------------------- 脱敏

// 规则本体搬到零依赖的 redact.ts：错误页（src/app/errorReport.ts）要用同一套规则，
// 而错误页不该被 IndexedDB / Capacitor 的依赖拖进来。这里保持原有导出名不变。
export { redact, redactUrl } from './redact.js'

export const UNKNOWN_HOST = 'unknown'

/**
 * 只取 host（**不含端口、不含 query/fragment、不含 userinfo**），用于区分「直连官方」还是「自建中转」。
 *
 * - 绝对地址：取 URL.hostname —— 它是 IP 就照实记 IP（本仓只出现过一处旧池域），排查必需；
 * - 相对地址（/v1/messages）：真实目标是当前页面的 origin，取 location.hostname；
 * - 解析失败：正则兜底，剥协议头、userinfo、端口，再走一遍脱敏规则，确保 host 不会绕过脱敏。
 */
export const redactHost = (value: string): string => {
  // 绝对地址（https://host/x）与协议相对地址（//host/x）都能直接解析出 host
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  const protocolRelative = value.startsWith('//')
  if (absolute || protocolRelative) {
    try {
      const host = new URL(protocolRelative ? `http:${value}` : value).hostname
      if (host) {
        return truncate(redact(host), 120)
      }
    } catch {
      // 落到下面的兜底
    }
  } else if (typeof location !== 'undefined' && location.hostname) {
    // 相对地址：记当前页面 host（同源请求的真实目标）
    return truncate(redact(location.hostname), 120)
  }
  try {
    const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    const authority = withoutScheme.split(/[/?#]/)[0] ?? ''
    const hostOnly = (authority.split('@').pop() ?? authority).split(':')[0] ?? ''
    return truncate(redact(hostOnly), 120) || UNKNOWN_HOST
  } catch {
    return UNKNOWN_HOST
  }
}

/**
 * meta 清洗：**规则本体在 fields.ts**（键白名单 / 非原始值丢弃 / 超长截断 / 完整 URL 压成 path）。
 * 采集层只负责在写入缓冲之前调它 —— 三条硬规则里「脱敏在采集时完成」这条不许绕过。
 */
const cleanMeta = (meta: LogMeta | undefined): LogMeta | undefined => {
  if (!meta) {
    return undefined
  }
  const cleaned = sanitizeMeta(meta)
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

const attachHeadersOf = (headers: Headers): boolean | undefined => {
  // 「命中缓存」只看服务端/CDN 明确声明的那几个头：没有头就是未知（不写 false 冒充「没命中」）
  const xCache = (headers.get('x-cache') ?? '').toUpperCase()
  const cfCache = (headers.get('cf-cache-status') ?? '').toUpperCase()
  const age = Number(headers.get('age') ?? '')
  if (xCache.includes('HIT') || cfCache === 'HIT') {
    return true
  }
  if (xCache.includes('MISS') || cfCache === 'MISS' || cfCache === 'BYPASS') {
    return false
  }
  // age > 0 说明这份响应在中间层待过（Redis / 网关缓存），算命中
  return Number.isFinite(age) && age > 0 ? true : undefined
}

/** 错误对象拆成 error.msg / error.name / error.stack / http.status 等扁平字段（业务 catch 里也用它） */
export const errorMeta = (error: unknown): LogMeta => {
  const meta: LogMeta = { 'error.msg': truncate(redact(safeString(error)), MAX_META_LENGTH) }
  if (error instanceof Error) {
    meta['error.name'] = error.name
    if (error.stack) {
      meta['error.stack'] = truncate(redact(error.stack), MAX_MSG_LENGTH)
    }
  }
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') {
    meta['http.status'] = status
  }
  return meta
}

// ---------------------------------------------------------------- 环形缓冲（条数 + 时间双限）

let entries: LogEntry[] = []
/** 与 entries 一一对应的落盘序号（环形缓冲溢出时一起丢，才能同步删库） */
let entrySeqs: number[] = []
/** 下一条日志的序号：单调递增，缓冲溢出后也不回退，用作 IndexedDB 的 key */
let nextSeq = 1

let dbPromise: Promise<IDBPDatabase<DiagnosticsDB>> | null = null
/** 落盘串行链：保证「清空 / 刷新 / 测试 flush」时能等到确实写完了 */
let pendingWrites: Promise<unknown> = Promise.resolve()

const getDB = (): Promise<IDBPDatabase<DiagnosticsDB>> => {
  dbPromise ??= openDB<DiagnosticsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'seq' })
      }
    },
  })
  return dbPromise
}

/** 落盘：失败只在内存里保留（隐私模式 / 存储被禁用时不影响业务） */
const persist = (entry: LogEntry, seq: number): void => {
  pendingWrites = pendingWrites
    .then(async () => {
      const db = await getDB()
      await db.put(STORE, { seq, ...entry })
    })
    .catch(() => {
      // 存储不可用：仅内存生效
    })
}

const dropPersisted = (seqs: number[]): void => {
  if (seqs.length === 0) {
    return
  }
  pendingWrites = pendingWrites
    .then(async () => {
      const db = await getDB()
      const tx = db.transaction(STORE, 'readwrite')
      for (const seq of seqs) {
        void tx.store.delete(seq)
      }
      await tx.done
    })
    .catch(() => {
      // 存储不可用：仅内存生效
    })
}

/** 双限裁剪：先按时间（30 分钟）丢过期，再按条数（500）丢最旧 */
const prune = (now = Date.now()): void => {
  const expiredAt = entries.findIndex((entry) => now - entry.t <= RETENTION_MS)
  const dropByTime = expiredAt < 0 ? entries.length : expiredAt
  const dropByCount = Math.max(0, entries.length - dropByTime - MAX_ENTRIES)
  const drop = dropByTime + dropByCount
  if (drop <= 0) {
    return
  }
  entries.splice(0, drop)
  dropPersisted(entrySeqs.splice(0, drop))
}

const push = (entry: LogEntry): void => {
  const seq = nextSeq
  nextSeq += 1
  entries.push(entry)
  entrySeqs.push(seq)
  persist(entry, seq)
  prune()
}

// ---------------------------------------------------------------- 记录 API

/** 各事件类型的默认级别：异常类一律 error，长任务/警告类 warn，其余 info */
const DEFAULT_LEVEL: Partial<Record<EventKind, LogLevel>> = {
  error: 'error',
  net_error: 'error',
  import_error: 'error',
  warning: 'warn',
  longtask: 'warn',
}

/**
 * 记录一条日志（主入口）：先脱敏再截断，写内存环形缓冲并落盘。
 * 返回写入的那条（validatePayload 自动补快照时会用到）。
 */
export const record = (
  kind: EventKind,
  level: LogLevel,
  msg: string,
  meta?: LogMeta
): LogEntry => {
  const cleaned = cleanMeta(meta)
  const entry: LogEntry = {
    t: Date.now(),
    kind,
    level,
    msg: truncate(redact(typeof msg === 'string' ? msg : safeString(msg)), MAX_MSG_LENGTH),
    ...(cleaned ? { meta: cleaned } : {}),
  }
  push(entry)
  maybeProbeUiNotice(kind, entry.meta)
  return entry
}

/**
 * 关键失败路径自动挂一次「提示是否真的渲染」的探测：
 * - chat 失败：业务侧写 error 时带了 `ui.condition`（说明它会弹提示）；
 * - 导入失败：import_error。
 * 采集层不 import 业务代码，靠日志自身的特征识别，业务侧无需改动。
 */
const maybeProbeUiNotice = (kind: EventKind, meta?: LogMeta): void => {
  if (kind === 'import_error') {
    scheduleUiNoticeProbe('import-error')
    return
  }
  if (kind === 'error' && meta?.['ui.condition'] !== undefined) {
    scheduleUiNoticeProbe('chat-error')
  }
}

/** 按 kind 自动选级别的记录入口 */
export const recordEvent = (kind: EventKind, msg: string, meta?: LogMeta): LogEntry =>
  record(kind, DEFAULT_LEVEL[kind] ?? 'info', msg, meta)

/** 失败必录：所有 catch / 非 2xx / 超时都走这里，强制 error 级并带上错误原文 */
export const recordError = (msg: string, meta: LogMeta = {}, error?: unknown): LogEntry =>
  record('error', 'error', msg, {
    ...(error === undefined ? {} : errorMeta(error)),
    ...meta,
  })

/** 等待落盘队列清空（测试与「清空后立刻导出」场景用） */
export const flushLogs = (): Promise<void> => pendingWrites.then(() => undefined)

/** 清空本地日志（内存 + IndexedDB） */
export const clearLogs = async (): Promise<void> => {
  entries = []
  entrySeqs = []
  actionTrail = []
  try {
    const db = await getDB()
    await db.clear(STORE)
  } catch {
    // 存储不可用：内存已清空
  }
  await flushLogs()
}

/** 启动时把上次落盘的日志读回缓冲（保留本次启动已写的 app_launch，旧的排在前） */
const restore = async (): Promise<void> => {
  try {
    const db = await getDB()
    const stored = await db.getAll(STORE)
    if (stored.length === 0) {
      return
    }
    const kept = stored
      // 历史启动的 app_launch 丢掉：本次启动已经写过一条，旧的 clientId/sessionId 只会误导排查
      .filter((item) => item.kind !== 'app_launch')
      .map((item) => ({
        t: item.t,
        kind: item.kind,
        level: item.level,
        msg: item.msg,
        ...(item.meta ? { meta: item.meta } : {}),
      }))
    // 恢复的旧日志排在本次启动的日志前面，再按双限裁剪
    entries = [...kept, ...entries]
    entrySeqs = [...stored.map((item) => item.seq), ...entrySeqs]
    nextSeq = Math.max(nextSeq, (stored.at(-1)?.seq ?? 0) + 1)
    prune()
  } catch {
    // 读不出来就当没有历史日志
  }
}

// ---------------------------------------------------------------- 环境信息

const UNKNOWN = 'unknown'

/** 构建期注入的应用版本（rspack DefinePlugin），取不到时读 html meta */
const readAppVersion = (): string => {
  try {
    if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
      return String(__APP_VERSION__)
    }
  } catch {
    // 非打包环境（node 直接 import 源码）
  }
  try {
    return (
      document
        .querySelector('meta[name="application-version"]')
        ?.getAttribute('content') ?? UNKNOWN
    )
  } catch {
    return UNKNOWN
  }
}

/** 构建期注入的 versionCode（来自 android/app/build.gradle） */
const readVersionCode = (): number => {
  try {
    if (typeof __APP_VERSION_CODE__ !== 'undefined') {
      return Number(__APP_VERSION_CODE__) || 0
    }
  } catch {
    // 非打包环境
  }
  return 0
}

const readBuildType = (): string => {
  try {
    return typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__ ? 'internal' : 'standard'
  } catch {
    return 'standard'
  }
}

const readPlatform = (): string => {
  try {
    return Capacitor.getPlatform()
  } catch {
    return typeof navigator === 'undefined' ? UNKNOWN : 'web'
  }
}

/** 从 UA 里尽量解析机型 / Android 版本 / WebView 内核版本，解析不到就写 unknown */
const parseAndroidFromUA = (ua: string) => {
  const androidVersion = /Android\s+([\d.]+)/i.exec(ua)?.[1] ?? UNKNOWN
  // 形如 "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv)"
  const model =
    /Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i.exec(ua)?.[1]?.trim() ?? UNKNOWN
  // WebView 的 UA 带 "wv" 标记，内核版本即 Chrome/xxx
  const webviewVersion = /\bwv\b/.test(ua) ? (/Chrome\/([\d.]+)/i.exec(ua)?.[1] ?? UNKNOWN) : UNKNOWN
  return { androidVersion, model, webviewVersion }
}

/** Network Information API（Chromium / Android WebView 有，Safari / Firefox 多数没有） */
type NetworkInformation = {
  effectiveType?: string
  downlink?: number
  rtt?: number
  saveData?: boolean
  type?: string
}

/**
 * 网络状态快照：区分「飞行模式」与「弱网」的关键证据。
 *
 * - `onLine=false` → 设备侧认为自己离线（飞行模式 / 没连 Wi-Fi）；
 * - `onLine=true` + `effectiveType=2g/3g` + 大 `rtt` → 弱网（onLine 骗人，请求照样失败）；
 * - 两个都取不到 → 只有 error.msg（比如某些 WebView 阉割了 Network Information API）。
 * 非标准 API 一律 try/catch，拿不到就不写这个 key（不写 unknown，避免和「真的是 4g」混淆）。
 */
export const readNetworkStatus = (): LogMeta => {
  const meta: LogMeta = {}
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      meta.onLine = navigator.onLine
    }
  } catch {
    // 取不到就不写
  }
  try {
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection
    if (connection) {
      if (connection.effectiveType) {
        meta.effectiveType = connection.effectiveType
      }
      if (typeof connection.downlink === 'number' && Number.isFinite(connection.downlink)) {
        meta.downlink = connection.downlink
      }
      if (typeof connection.rtt === 'number' && Number.isFinite(connection.rtt)) {
        meta.rtt = connection.rtt
      }
      if (typeof connection.saveData === 'boolean') {
        meta.saveData = connection.saveData
      }
      if (connection.type) {
        meta.netType = connection.type
      }
    }
  } catch {
    // 同上：没有这个 API 就只留 onLine
  }
  return meta
}

/** web 端补充信息：UA（截断 200）/ devicePixelRatio / 逻辑核数 / 内存（非标准，取不到就不写） */
const readWebExtras = () => {
  const extras: Pick<
    DeviceInfo,
    'userAgent' | 'pixelRatio' | 'hardwareConcurrency' | 'deviceMemory'
  > = {}
  if (typeof navigator !== 'undefined') {
    if (navigator.userAgent) {
      extras.userAgent = truncate(navigator.userAgent, 200)
    }
    const extended = navigator as Navigator & {
      hardwareConcurrency?: number
      deviceMemory?: number
    }
    if (typeof extended.hardwareConcurrency === 'number' && extended.hardwareConcurrency > 0) {
      extras.hardwareConcurrency = extended.hardwareConcurrency
    }
    if (typeof extended.deviceMemory === 'number' && extended.deviceMemory > 0) {
      extras.deviceMemory = extended.deviceMemory
    }
  }
  if (typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number') {
    extras.pixelRatio = window.devicePixelRatio
  }
  return extras
}

let systemInfoCache: SystemInfo | undefined
let systemInfoPromise: Promise<SystemInfo> | undefined

const readBrowserSystemInfo = (): SystemInfo => {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }
  // #220：能力不再只报一个布尔。入口兜底（polyfills/legacy.ts，main.tsx 第一个 import）早就装完了，
  // 在这里直接探 typeof 只会得到「装完之后」的 true —— 那等于把「内核原生具备」和「自家兜底补齐」
  // 混成同一句话。现在拆成两个维度（runtime 能调 / native 原生）再连同兜底台账一起上报。
  const truth = readCapabilityTruth()
  return {
    appVersionName: readAppVersion(),
    appVersionCode: readVersionCode(),
    artifactVariant: readBuildType(),
    appSource: 'build-macro-fallback',
    networkType: nav?.connection?.type ?? nav?.connection?.effectiveType ?? UNKNOWN,
    online: typeof nav?.onLine === 'boolean' ? nav.onLine : undefined,
    capabilities: truth.runtime,
    nativeCapabilities: truth.native,
    polyfilled: truth.polyfilled,
    degradedClones: truth.degradedClones,
    browserPath: 'browser',
  }
}

const readSystemInfo = async (): Promise<SystemInfo> => {
  if (systemInfoCache) {
    return systemInfoCache
  }
  if (systemInfoPromise) {
    return systemInfoPromise
  }
  systemInfoPromise = (async () => {
    const browser = readBrowserSystemInfo()
    if (readPlatform() !== 'android') { systemInfoCache = browser; return browser }
    try {
      const bridge = Capacitor.registerPlugin<{ snapshot(): Promise<SystemInfo> }>('DiagnosticsDevice')
      const native = await bridge.snapshot()
      systemInfoCache = { ...browser, ...native, nativePath: 'DiagnosticsDevice' }
    } catch {
      systemInfoCache = { ...browser, nativePath: 'unavailable' }
    }
    return systemInfoCache
  })()
  return systemInfoPromise
}

const readDeviceInfo = (system?: SystemInfo): DeviceInfo => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const parsed = parseAndroidFromUA(ua)
  const screen =
    typeof window !== 'undefined' && window.screen
      ? `${window.screen.width}x${window.screen.height}`
      : UNKNOWN
  return {
    // 真机（Capacitor）机型优先靠 UA 解析：本项目没有装 @capacitor/device，
    // 所以解析不出来时保持 unknown（装了之后可以在这一处接 Device.getInfo() 覆盖）。
    model: parsed.model,
    androidVersion: parsed.androidVersion,
    webviewVersion: parsed.webviewVersion,
    screen,
    locale: typeof navigator === 'undefined' ? UNKNOWN : navigator.language || UNKNOWN,
    ...readWebExtras(),
    ...(system ? { system } : {}),
  }
}

const readAppInfo = (): AppInfo => ({
  version: readAppVersion(),
  versionCode: readVersionCode(),
  buildType: readBuildType(),
  platform: readPlatform(),
})

// ---------------------------------------------------------------- clientId / sessionId

const createId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 降级
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let clientIdCache: string | null = null
let sessionIdCache: string | null = null

/** 设备级 UUID：持久化在 localStorage，清不掉就只在本次进程内有效 */
const readClientId = (): string => {
  if (clientIdCache) {
    return clientIdCache
  }
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY)
    if (saved) {
      clientIdCache = saved
      return saved
    }
    const created = createId()
    localStorage.setItem(CLIENT_ID_KEY, created)
    clientIdCache = created
    return created
  } catch {
    clientIdCache = createId()
    return clientIdCache
  }
}

/** 会话级 UUID：每次启动新生成（同一个页面里刷新也算新会话） */
const readSessionId = (): string => (sessionIdCache ??= createId())

// ---------------------------------------------------------------- 动作链 / 状态快照

export type SnapshotFacts = {
  sessions: number
  files: number
  provider: string
  model: string
  view: string
  configured: boolean
}

export type FactsProvider = () => SnapshotFacts | Promise<SnapshotFacts>

/** 应用侧注入的「当前状态」读取器（会话数、附件数、provider/model、当前界面） */
let factsProvider: FactsProvider | null = null

export const setSnapshotFactsProvider = (provider: FactsProvider): void => {
  factsProvider = provider
}

const defaultFacts: SnapshotFacts = {
  sessions: 0,
  files: 0,
  provider: UNKNOWN,
  model: UNKNOWN,
  view: UNKNOWN,
  configured: false,
}

const readStorageBytes = async (): Promise<number | undefined> => {
  try {
    const estimate = await navigator.storage.estimate()
    return typeof estimate.usage === 'number' ? estimate.usage : undefined
  } catch {
    return undefined
  }
}

/** 周期性 / 关键动作后的状态快照：会话数、附件数、IndexedDB 占用、provider/model、当前界面 */
export const captureStateSnapshot = async (reason: string): Promise<LogEntry> => {
  let facts: SnapshotFacts = defaultFacts
  try {
    if (factsProvider) {
      facts = await factsProvider()
    }
  } catch {
    // 拿不到就用默认值，快照本身仍然要写
  }
  const storageBytes = await readStorageBytes()
  return record('state_snapshot', 'info', `state: sessions=${facts.sessions} files=${facts.files} ${facts.provider}/${facts.model} view=${facts.view}`, {
    reason,
    sessions: facts.sessions,
    files: facts.files,
    provider: facts.provider,
    model: facts.model,
    view: facts.view,
    configured: facts.configured,
    ...(storageBytes === undefined ? {} : { storageBytes }),
  })
}

export type ActionRecord = { t: number; action: string }

/** 最近 50 个用户动作（点击 / 导航 / 切前后台），出事时用来还原操作序列 */
let actionTrail: ActionRecord[] = []

export const getActionTrail = (): ActionRecord[] => actionTrail.slice()

/**
 * 用户动作：进动作链（最多 50 条）+ 写一条 nav 日志。
 * 只记控件标识（aria-label / role / 标签名），不记用户输入的文本。
 */
export const recordUserAction = (action: string, meta: LogMeta = {}): LogEntry => {
  const entry = record('nav', 'info', `action: ${action}`, meta)
  actionTrail.push({ t: entry.t, action })
  if (actionTrail.length > MAX_ACTION_TRAIL) {
    actionTrail = actionTrail.slice(-MAX_ACTION_TRAIL)
  }
  return entry
}

/** 关键业务动作（发消息 / 切配置 / 导入 / 上传）：动作链 + 指定的 kind */
export const recordAction = (kind: EventKind, action: string, meta: LogMeta = {}): LogEntry => {
  const entry = record(kind, DEFAULT_LEVEL[kind] ?? 'info', `action: ${action}`, {
    action,
    ...meta,
  })
  actionTrail.push({ t: entry.t, action })
  if (actionTrail.length > MAX_ACTION_TRAIL) {
    actionTrail = actionTrail.slice(-MAX_ACTION_TRAIL)
  }
  return entry
}

// ---------------------------------------------------------------- 界面提示是否真的渲染

/**
 * 「后端返回了错误但前端没显示」这类 bug 只能靠 DOM 侧证据区分：
 * 有 error 日志、但页面上没有任何可见提示 → 说明问题在渲染层，不在网络层。
 *
 * 采集层不认识业务组件（也不该认识），所以用**候选节点 + 可见性**的方式做通用探测：
 * 只要失败路径上有 alert/live 区域或带 notice/toast/error 的类名节点，就把文案抓下来。
 */
const NOTICE_SELECTOR =
  '[role="alert"],[role="status"],[aria-live],[class*="notice"],[class*="toast"],[class*="error"]'

/** 触发时刻的「已有提示」快照：用来排除上一次失败留下的旧提示（避免张冠李戴） */
type NoticeBaseline = Map<Element, string>

export type RenderedNotice = {
  /** 实际渲染的文案（已压缩空白、已脱敏、截断 200 字） */
  text: string
  /** 是否可见（getComputedStyle + 布局盒判断，display:none / visibility:hidden / opacity:0 / 无布局都算不可见） */
  visible: boolean
  /** 命中方式（role=alert / class*=notice …），排查用 */
  match: string
  /** true = 这是失败发生前就已经在页面上的旧提示（文本与触发前一致），仅供参考 */
  stale?: boolean
}

const describeMatch = (element: Element): string => {
  const role = element.getAttribute('role')
  if (role) {
    return `role=${role}`
  }
  if (element.getAttribute('aria-live')) {
    return `aria-live=${element.getAttribute('aria-live')}`
  }
  const className = element.getAttribute('class') ?? ''
  const hit = /notice|toast|error/i.exec(className)
  return hit ? `class*=${hit[0].toLowerCase()}` : element.tagName.toLowerCase()
}

const isRendered = (element: Element): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  // 有布局盒就说明参与了排版（含 position: fixed 的情况）
  if (element.getClientRects().length === 0 && (element as HTMLElement).offsetParent === null) {
    return false
  }
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false
  }
  const opacity = Number(style.opacity === '' ? '1' : style.opacity)
  return !(Number.isFinite(opacity) && opacity <= 0.01)
}

/**
 * 读当前页面上的「提示」：优先可见的，同优先级取文档里靠后的（最新渲染的那个）。
 * 找不到任何候选节点返回 null。测试与业务侧都可以直接调用。
 */
/** 记下当前页面上所有提示节点的文案（探测前调用，用于排除旧提示） */
const captureNoticeBaseline = (): NoticeBaseline => {
  const baseline: NoticeBaseline = new Map()
  if (typeof document === 'undefined') {
    return baseline
  }
  for (const element of document.querySelectorAll(NOTICE_SELECTOR)) {
    baseline.set(element, (element.textContent ?? '').replace(/\s+/g, ' ').trim())
  }
  return baseline
}

export const readRenderedNotice = (baseline?: NoticeBaseline): RenderedNotice | null => {
  if (typeof document === 'undefined') {
    return null
  }
  let freshVisible: RenderedNotice | null = null
  let visibleHit: RenderedNotice | null = null
  let anyHit: RenderedNotice | null = null
  for (const element of document.querySelectorAll(NOTICE_SELECTOR)) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 2) {
      continue
    }
    const candidate: RenderedNotice = {
      text: truncate(redact(text), 200),
      visible: isRendered(element),
      match: describeMatch(element),
    }
    // 与触发前文案一模一样 = 旧提示（这次失败没有刷新它）
    const stale = baseline ? baseline.get(element) === text : false
    anyHit = { ...candidate, ...(stale ? { stale: true } : {}) }
    if (candidate.visible) {
      visibleHit = anyHit
      if (!stale) {
        freshVisible = anyHit
      }
    }
  }
  // 优先「新出现的、可见的」→「可见的（可能旧）」→「存在但不可见」
  return freshVisible ?? visibleHit ?? anyHit
}

/** 探测节拍：先快照一次（React 同步渲染），再补两次（异步渲染 / 网络回包后才出现提示） */
const UI_PROBE_DELAYS_MS = [150, 700, 1600]
let uiProbeSeq = 0

/**
 * 失败路径专用：延迟探测「提示到底有没有渲染出来」，写一条 ui_rendered。
 * 新一轮失败会作废上一轮未完成的探测（以最近一次失败为准）。
 */
export const scheduleUiNoticeProbe = (trigger: string): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }
  uiProbeSeq += 1
  const token = uiProbeSeq
  // 先记下触发前的提示，后面只认「新出现的」那个
  const baseline = captureNoticeBaseline()
  let recorded = false
  UI_PROBE_DELAYS_MS.forEach((delay, index) => {
    setTimeout(() => {
      if (token !== uiProbeSeq || recorded) {
        return
      }
      const notice = readRenderedNotice(baseline)
      const isLast = index === UI_PROBE_DELAYS_MS.length - 1
      if (notice?.visible) {
        recorded = true
        record('ui_rendered', 'info', `ui_rendered: ${trigger} notice shown`, {
          trigger,
          visible: true,
          noticeText: notice.text,
          match: notice.match,
          delayMs: delay,
          ...(notice.stale ? { stale: true } : {}),
        })
        return
      }
      if (isLast) {
        recorded = true
        // visible=false 本身就是有效结论：错误发生了，但界面上没给用户任何可见提示
        record(
          'ui_rendered',
          notice ? 'warn' : 'error',
          notice ? `ui_rendered: ${trigger} notice invisible` : `ui_rendered: ${trigger} no notice`,
          {
            trigger,
            visible: false,
            noticeText: notice?.text ?? '',
            match: notice?.match ?? 'none',
            delayMs: delay,
          }
        )
      }
    }, delay)
  })
}

/** 立即读一次并写 ui_rendered（业务侧若想手动确认提示，可显式调用） */
export const captureUiNotice = (trigger: string): LogEntry => {
  const notice = readRenderedNotice()
  return record('ui_rendered', notice?.visible ? 'info' : 'warn', `ui_rendered: ${trigger}`, {
    trigger,
    visible: notice?.visible ?? false,
    noticeText: notice?.text ?? '',
    match: notice?.match ?? 'none',
  })
}

// ---------------------------------------------------------------- hooks

let hooksInstalled = false
/**
 * 重入标记：`installCapacitorHttpHook` 记一条 `native: true` 之前先进 `inNativeHttp += 1`，
 * 万一这条原生调用内部还落回页面 `fetch`，`installFetchHook` 那层看到计数 > 0 就闭嘴，
 * 同一条请求不会记两遍。
 *
 * 挂点已搬到 `Capacitor.nativePromise`（issue #248：插件代理本身挂不上），所以它现在**直接覆盖原生
 * 通道本身**；宿主桥接换掉 `window.fetch` 的那条形态（issue #210）仍由 `detectFetchChannel` 在安装时
 * 判定 —— 不是原生就整层不接管、只留一条降级信号，见 installFetchHook。
 */
let inNativeHttp = 0
let requestSeq = 0

const newRequestId = (): string => {
  requestSeq += 1
  return `r${requestSeq}`
}

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { name?: string }).name === 'AbortError' ||
    (error as { name?: string }).name === 'TimeoutError')

const isTimeoutError = (error: unknown): boolean =>
  /timeout|timed out|time out|ERR_TIMED_OUT/i.test(
    error instanceof Error ? `${error.name} ${error.message}` : String(error)
  )

/**
 * `net_response.bytes` 报「不可测」时的取值（#211）。
 *
 * 语义在这里定死，不许模棱两可：
 * - `>= 0`：真实字节数（`Content-Length` 声明的，或读完副本实测的）；
 * - `BYTES_UNMEASURABLE`：**量不出来**（流式响应等主动放弃精确体积的响应）。
 *
 * **0 只表示「确实是零字节」**，不许拿 0 顶替「不可测」—— 两者混成一个 0，这份诊断就在说谎。
 */
export const BYTES_UNMEASURABLE = -1

/** 流式响应的 media type：读副本会阻塞到流关闭，所以只看类型、绝不碰 body */
const STREAMING_CONTENT_TYPES = ['text/event-stream']

/** 取 media type：`text/event-stream; charset=utf-8` → `text/event-stream`；缺头 → 空串 */
const mediaTypeOf = (contentType: string | null): string => {
  const raw = (contentType ?? '').trim().toLowerCase()
  const end = raw.indexOf(';')
  return end < 0 ? raw : raw.slice(0, end).trim()
}

const isStreamingMediaType = (contentType: string | null): boolean =>
  STREAMING_CONTENT_TYPES.includes(mediaTypeOf(contentType))

/**
 * 解析 `Content-Length`：缺失 / 空串 / 非数字 / 负数**一律返回 null（≠ 0）**。
 *
 * 老写法是 `Number(headers.get('Content-Length') ?? '')`，而 `Number('') === 0`（空串不是 NaN），
 * 于是「没有这个头」被当成「0 字节」直接 return，下面那个读副本的兜底**从来没被执行过**（#211）。
 */
const parseContentLength = (raw: string | null): number | null => {
  if (raw === null) {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const length = Number(trimmed)
  return Number.isFinite(length) && length >= 0 ? length : null
}

/**
 * 读响应体积，供 `net_response.bytes` 使用（#211）。
 *
 * 顺序：`Content-Length` 声明值 → 流式响应主动放弃精确体积 → 其余才读副本实测。
 *
 * 为什么流式响应不能读副本：`response.clone().text()` 要**等整条流关闭**才 resolve（分块一直在推、
 * 流到 t=1200ms 才关，clone 也在 t=1205ms 才 resolve —— 见 tests/unit/diagnostics-response-bytes
 * 的 ⑤ 对照断言），而这个函数在 `collector.ts:950` 是**先把 response 交还调用方之前**被 await 的，
 * 等于把 SSE 首字节推迟到回答结束。**宁可少一个数字，不要卡住诊断。**
 */
export const readBytesOf = async (response: Response): Promise<number> => {
  const declared = parseContentLength(response.headers.get('Content-Length'))
  if (declared !== null) {
    return declared
  }
  if (isStreamingMediaType(response.headers.get('Content-Type'))) {
    return BYTES_UNMEASURABLE
  }
  try {
    const text = await response.clone().text()
    return new TextEncoder().encode(text).length
  } catch {
    // 副本读不了（body 已被消费 / 已上锁 / 流已死）：同样只能报「不可测」，不许拿 0 冒充
    return BYTES_UNMEASURABLE
  }
}

const readBytesOfValue = (value: unknown): number => {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).length
  }
  try {
    return value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

const installWindowErrorHook = (): void => {
  window.addEventListener('error', (event) => {
    const error = event.error
    record('error', 'error', `uncaught: ${safeString(error ?? event.message)}`, {
      stage: 'window.onerror',
      ...errorMeta(error ?? new Error(String(event.message || 'resource error'))),
      ...(event.filename ? { 'url.path': redactUrl(event.filename) } : {}),
      ...(event.lineno ? { line: event.lineno } : {}),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    record('error', 'error', `unhandled rejection: ${safeString(event.reason)}`, {
      stage: 'unhandledrejection',
      ...errorMeta(event.reason),
    })
  })
}

/** 包装 console.error / console.warn：先记录，再原样转发给原实现（不吞日志） */
const installConsoleHook = (): void => {
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        record(level === 'warn' ? 'warning' : 'error', level, args.map((arg) => safeString(arg)).join(' '), {
          stage: 'console',
        })
      } catch {
        // 采集异常不能影响业务日志输出
      }
      original(...args)
    }
  }
}

/** `window.fetch` 现在挂在谁手上：原生 / 宿主桥接 / 不认识的包装 */
type FetchChannel = 'native' | 'host-bridge' | 'wrapped'

/** V8 里原生函数（含 bind 出来的）源码就是这个形状 */
const ENGINE_NATIVE_HINT = '[native code]'
/** native-bridge 换 fetch 之前会把原函数存在这个字段上：宿主接管的确定性信号 */
const BRIDGE_SAVED_FETCH_KEY = 'CapacitorWebFetch'
/** 桥接实现里的运行时痕迹，压缩也改不到（与 utils/capabilities.ts 同一套判据） */
const BRIDGE_SOURCE_HINT = /CapacitorHttp|CapacitorWebFetch|nativePromise/u

const readFunctionSource = (fn: unknown): string => {
  if (typeof fn !== 'function') {
    return ''
  }
  try {
    return Function.prototype.toString.call(fn)
  } catch {
    return ''
  }
}

/**
 * 认 `window.fetch` 的身份（issue #210）。
 *
 * 采集层以前默认「进到这里时 window.fetch 就是引擎原生实现」，那是错的：宿主桥接层
 * （Capacitor native-bridge 的 doPatchHttp）会在页面脚本之前把 `window.fetch` 换成走原生网络栈的
 * 包装。把别人的包装当原生会同时错三件事：
 * 1. 双份 —— 那条路走 `cap.nativePromise`，不经过 JS 侧 CapacitorHttp 代理，`inNativeHttp` 为 0，
 *    我们照旧记一条，原生通道那边再记一条，同一次请求在两处各留一份；
 * 2. 通道标错 —— 我们那条不带 `native: true`，原生通道的请求被当成页面 fetch，排障时方向直接反；
 * 3. 流式退化 —— 桥接实现是拼出来的 Response，`response.body` 不是真流，SSE 会静默变哑。
 *
 * 所以先认身份：`native` 才接管；其余（宿主桥接 / 不认识的包装）整层不接管，只留一条降级信号。
 */
const detectFetchChannel = (impl: unknown): FetchChannel => {
  const host = window as unknown as Record<string, unknown>
  if (typeof host[BRIDGE_SAVED_FETCH_KEY] === 'function') {
    return 'host-bridge'
  }
  // isFetchPatched() 的结果按 key 缓存（#212）：本次调用之前若已被别的探测写死，这里可能拿到旧值，
  // 所以只用它当「加分项」，真正的判据是下面这次新鲜探测。
  if (isFetchPatched() || BRIDGE_SOURCE_HINT.test(readFunctionSource(impl))) {
    return 'host-bridge'
  }
  return readFunctionSource(impl).includes(ENGINE_NATIVE_HINT) ? 'native' : 'wrapped'
}

/**
 * 包装 fetch：**成功与失败都记**（net_request / net_response / net_error）。
 * 「一直加载」往往是「请求发出但没有响应」，只看失败记录永远查不出来，所以成功也要留痕。
 *
 * 只在 `window.fetch` 确认是引擎原生实现时才接管（见 detectFetchChannel）。被宿主接管时不接管
 * 也不入库，改留一条降级信号：宁可少一份网络日志，也不要两份互相矛盾、通道还是错的日志。
 */
const installFetchHook = (): void => {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return
  }
  const channel = detectFetchChannel(window.fetch)
  if (channel !== 'native') {
    const who = channel === 'host-bridge' ? '宿主桥接' : '未知包装'
    record('warning', 'warn', `fetch 已被${who}接管，采集降级：无 net_* 记录，且拿不到真流（SSE 不可用）`, {
      stage: 'fetch-hook',
      'fetch.channel': channel,
      native: true,
      streaming: 'unsupported',
    })
    return
  }
  const original = window.fetch.bind(window)
  // @types/node 的 undici fetch 与 DOM 的 fetch 重载不同，这里按 DOM 的签名接管
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = Date.now()
    const request = typeof input === 'string' || input instanceof URL ? null : input
    const url = request ? request.url : String(input)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const path = redactUrl(url)
    // 只记 host（不带端口 / query），用来区分直连官方还是自建中转
    const host = redactHost(url)
    // JS 侧 CapacitorHttp 代理自己会记一条（native: true），避免同一条请求记两遍。
    // 注意：这个计数器只覆盖那条路径；宿主桥接换掉的 fetch 不进代理，靠上面的通道探测拦住。
    const quiet = inNativeHttp > 0
    const requestId = newRequestId()
    if (!quiet) {
      record('net_request', 'info', `request: ${method} ${host}${path}`, {
        method,
        'url.host': host,
        'url.path': path,
        requestId,
        // 端点键：对得上 config/endpoints.json 才能跨版本聚合（#306）
        endpointKey: endpointKeyFromUrl(url),
        stage: 'net.request',
        ...(init?.body === undefined
          ? {}
          : { 'req.bodyBytes': readBytesOfValue(typeof init.body === 'string' ? init.body : '') }),
      })
    }
    try {
      const response = await original(input, init)
      if (!quiet) {
        const ok = response.ok
        const duration = Date.now() - startedAt
        const responseBytes = await readBytesOf(response)
        const fromCache = attachHeadersOf(response.headers)
        const speed = bytesPerSecond(responseBytes, duration)
        record(
          'net_response',
          ok ? 'info' : 'error',
          `response: ${method} ${host}${path} → ${response.status}`,
          {
            method,
            'url.host': host,
            'url.path': path,
            requestId,
            endpointKey: endpointKeyFromUrl(url),
            stage: 'net.response',
            // status 与 http.status 同值：新口径统一叫 status，旧的留着兼容既有查询
            status: response.status,
            'http.status': response.status,
            durationMs: duration,
            bytes: responseBytes,
            ...(speed === undefined ? {} : { speedBps: speed }),
            ...(fromCache === undefined ? {} : { fromCache }),
            ...(ok ? {} : { 'error.msg': `HTTP ${response.status} ${response.statusText}`.trim() }),
          }
        )
      }
      return response
    } catch (error) {
      if (!quiet) {
        const aborted = isAbortError(error)
        const timeout = isTimeoutError(error)
        record(
          'net_error',
          aborted && !timeout ? 'info' : 'error',
          `request error: ${method} ${host}${path} ${aborted ? '(aborted)' : timeout ? '(timeout)' : safeString(error)}`,
          {
            // 网络状态放最前：断网（onLine:false）与弱网（2g/3g、大 rtt）一眼可辨
            ...readNetworkStatus(),
            method,
            'url.host': host,
            'url.path': path,
            requestId,
            endpointKey: endpointKeyFromUrl(url),
            stage: 'net.error',
            status: aborted ? 'aborted' : timeout ? 'timeout' : 'error',
            durationMs: Date.now() - startedAt,
            reason: aborted ? 'aborted' : timeout ? 'timeout' : 'network',
            ...errorMeta(error),
          }
        )
      }
      throw error
    }
  }
  window.fetch = patched as unknown as typeof window.fetch
}

type NativeHttpResponse = { status?: number; data?: unknown }

/**
 * CapacitorHttp 的**真实**可拦截入口（issue #248）。
 *
 * `@capacitor/core@8.6.2` 的 `registerPlugin()` 返回 `new Proxy({}, { get })`：
 * - `get` 每次都调一遍 `createPluginMethodWrapper(prop)` 现造一个**新**函数 ——
 *   `CapacitorHttp.get === CapacitorHttp.get` 是 `false`；
 * - 没有 `set` 陷阱，赋值落到那个空 target 上，而 `get` 从不读 target ——
 *   写了等于没写，**而且不报错**。
 *
 * 所以老写法 `target[name] = wrapper`（往插件代理上挂）在 Capacitor 8 上全程静默失败：
 * 一条 `net_*` 都不写，也不留任何信号 —— 排障时会被读成「这段时间没有网络请求」，
 * 比「记错」更坏：它连「我坏了」都不说。
 *
 * 真正能挂的是 `Capacitor.nativePromise`：插件代理在**调用时**才读 `cap.nativePromise`
 * （dist/index.js 里 `(options) => cap.nativePromise(pluginName, prop.toString(), options)`），
 * 而 native-bridge 自己的 HTTP 通道（含被 doPatchHttp 换掉的 `window.fetch`）也收敛到这一处。
 * 它是普通对象上的普通函数，赋值真会落地 —— 但落地与否当场探测，不靠假设。
 */

/** 原生通道上 CapacitorHttp 的调用形态：`nativePromise('CapacitorHttp', method, options)` */
const NATIVE_HTTP_PLUGIN = 'CapacitorHttp'
/** 降级信号的 stage，与 #210 的 `stage: 'fetch-hook'` 同一套风格 */
const HTTP_HOOK_STAGE = 'http-hook'

/** 插件代理是不是「每次取值都现造一个新函数」那种挂不上的形态（issue #248 的成因） */
const proxyRebuildsOnGet = (): boolean => {
  try {
    const plugin = CapacitorHttp as unknown as Record<string, unknown>
    return plugin['get'] !== plugin['get']
  } catch {
    return false
  }
}

/** 挂不上时统一走这里：信号里必须能看出「哪个通道不可用 + 为什么 + 后果」 */
const recordNativeHttpDegraded = (reason: string, detail: LogMeta): void => {
  record(
    'warning',
    'warn',
    `原生通道采集不可用：${reason}，原生 HTTP 请求不会有 net_* 记录（分不清「没发请求」还是「没采到」）`,
    {
      stage: HTTP_HOOK_STAGE,
      'http.channel': 'native',
      'http.entry': 'nativePromise',
      'http.proxy': proxyRebuildsOnGet() ? 'rebuilt-on-get' : 'stable',
      native: true,
      ...detail,
    }
  )
}

/**
 * 包装原生 HTTP 通道：原生端不走页面 fetch，同样成功与失败都记。
 *
 * 挂点从插件代理搬到 `Capacitor.nativePromise`（原因见上），并且**拦不到就出声**：
 * 拿不到这个函数、或赋值不落地，都写一条 `stage: 'http-hook'` 的降级信号。
 */
const installCapacitorHttpHook = (): void => {
  const cap = Capacitor as unknown as Record<string, unknown>
  const platform = typeof cap['getPlatform'] === 'function' ? String((cap['getPlatform'] as () => unknown)()) : 'unknown'
  // 网页环境没有原生通道：CapacitorHttp 那时走 web 实现（最终落到 fetch），由 installFetchHook 负责。
  // 这种「零 native 记录」是应该的，不许乱报降级。
  if (typeof cap['isNativePlatform'] !== 'function' || cap['isNativePlatform']() !== true) {
    return
  }
  const original = cap['nativePromise']
  if (typeof original !== 'function') {
    recordNativeHttpDegraded(`Capacitor.nativePromise 不存在（平台 ${platform}）`, {
      'http.hook': 'missing',
      'http.platform': platform,
    })
    return
  }
  // 挂之前当场探一次：赋进去再读回来，读回的还是我那个才算挂上。
  // 「typeof 是 function 就说明挂得上」这个假设正是本单的成因 —— CapacitorHttp 看着有 get/post，
  // 赋值却一步都不落地。所以这里必须真写一次、真读一次。
  const probe = function probeNativePromise(): void {}
  let landed = false
  let probeError: unknown
  try {
    cap['nativePromise'] = probe
    landed = cap['nativePromise'] === probe
  } catch (error) {
    probeError = error
  } finally {
    try {
      cap['nativePromise'] = original
    } catch {
      // 还原不回去也不能把业务拖坏：下面按「挂不上」写信号，不再改造
      landed = false
    }
  }
  if (!landed) {
    recordNativeHttpDegraded(`Capacitor.nativePromise 挂不上（赋值不落地，平台 ${platform}）`, {
      'http.hook': 'unassignable',
      'http.platform': platform,
      ...(probeError === undefined ? {} : { 'error.msg': safeString(probeError) }),
    })
    return
  }

  const call = original as (
    pluginName: string,
    methodName: string,
    options?: Record<string, unknown>
  ) => Promise<NativeHttpResponse>

  cap['nativePromise'] = async function patchedNativePromise(
    pluginName: string,
    methodName: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    // 只认 CapacitorHttp：别的插件（App / Filesystem …）原样直通，不许多记也不许多包一层
    if (pluginName !== NATIVE_HTTP_PLUGIN) {
      return call.call(Capacitor, pluginName, methodName, options)
    }
    const startedAt = Date.now()
    // 插件直调时 options 里没有 method（methodName 本身就是 'get' / 'post' …）；
    // 桥接换掉的 fetch 一律 methodName='request' + options.method —— 两种形态都要取到真实方法名
    const method = String(options?.method ?? methodName ?? 'GET').toUpperCase()
    const rawUrl = String(options?.url ?? '')
    const path = redactUrl(rawUrl)
    const host = redactHost(rawUrl)
    const requestId = newRequestId()
    // 原生通道不会落回页面 fetch，这个计数留着当 #210 约定的兜底：
    // 万一哪条实现真绕回 fetch 那层，installFetchHook 的 `quiet` 能挡住重复记录
    inNativeHttp += 1
    record('net_request', 'info', `request: ${method} ${host}${path}`, {
      method,
      'url.host': host,
      'url.path': path,
      requestId,
      endpointKey: endpointKeyFromUrl(rawUrl),
      stage: 'net.request',
      native: true,
    })
    try {
      const response = await call.call(Capacitor, pluginName, methodName, options)
      const status = typeof response?.status === 'number' ? response.status : 0
      const ok = status >= 200 && status < 300
      const duration = Date.now() - startedAt
      const responseBytes = readBytesOfValue(response?.data)
      const speed = bytesPerSecond(responseBytes, duration)
      record('net_response', ok ? 'info' : 'error', `response: ${method} ${host}${path} → ${status}`, {
        method,
        'url.host': host,
        'url.path': path,
        requestId,
        endpointKey: endpointKeyFromUrl(rawUrl),
        stage: 'net.response',
        status,
        'http.status': status,
        durationMs: duration,
        bytes: responseBytes,
        ...(speed === undefined ? {} : { speedBps: speed }),
        native: true,
        ...(ok ? {} : { 'error.msg': `HTTP ${status}` }),
      })
      return response
    } catch (error) {
      const timeout = isTimeoutError(error)
      record(
        'net_error',
        'error',
        `request error: ${method} ${host}${path} ${timeout ? '(timeout)' : safeString(error)}`,
        {
          ...readNetworkStatus(),
          method,
          'url.host': host,
          'url.path': path,
          requestId,
          endpointKey: endpointKeyFromUrl(rawUrl),
          stage: 'net.error',
          status: timeout ? 'timeout' : 'error',
          durationMs: Date.now() - startedAt,
          reason: timeout ? 'timeout' : 'network',
          native: true,
          ...errorMeta(error),
        }
      )
      throw error
    } finally {
      inNativeHttp -= 1
    }
  }
}

/**
 * 长任务：排查「点了没反应 / 卡死」的关键证据。
 *
 * 不用 Long Tasks API —— 实测无头 Chromium 与部分 Android WebView 里 PerformanceObserver
 * 收不到 longtask 条目，会静默漏采。改成事件循环看门狗：每 TICK 毫秒对一次表，
 * 实际间隔比预期多出来的部分就是主线程被阻塞的时间（稳定、跨浏览器）。
 */
const LONG_TASK_TICK_MS = 100
const LONG_TASK_THRESHOLD_MS = 150
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let longTaskPaused = false
let visibilityGeneration = 0

const installLongTaskHook = (): void => {
  if (typeof setInterval !== 'function' || watchdogTimer) {
    return
  }
  let expected = Date.now() + LONG_TASK_TICK_MS
  let generation = visibilityGeneration
  watchdogTimer = setInterval(() => {
    const now = Date.now()
    if (generation !== visibilityGeneration) {
      generation = visibilityGeneration
      expected = now + LONG_TASK_TICK_MS
      return
    }
    if (longTaskPaused || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      expected = now + LONG_TASK_TICK_MS
      return
    }
    const lag = now - expected
    expected = now + LONG_TASK_TICK_MS
    if (lag >= LONG_TASK_THRESHOLD_MS) {
      record('longtask', 'warn', `longtask: main thread blocked ${lag}ms`, {
        durationMs: lag,
        threshold: LONG_TASK_THRESHOLD_MS,
      })
    }
  }, LONG_TASK_TICK_MS)
}

/** 切前台 / 切后台 */
const installVisibilityHook = (): void => {
  if (typeof document === 'undefined') {
    return
  }
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden'
    longTaskPaused = hidden
    visibilityGeneration += 1
    recordAction(hidden ? 'app_pause' : 'app_resume', hidden ? 'app-pause' : 'app-resume', {
      stage: 'visibility',
    })
    if (!hidden) {
      void captureStateSnapshot('resume')
    }
  })
}

/** 点击留痕：只记控件标识，不记输入内容 */
const installClickHook = (): void => {
  if (typeof document === 'undefined') {
    return
  }
  let lastAt = 0
  let lastLabel = ''
  document.addEventListener(
    'click',
    (event) => {
      const element = event.target instanceof Element ? event.target : null
      if (!element) {
        return
      }
      const control = element.closest('[aria-label],button,[role="tab"],[role="option"]')
      if (!control) {
        return
      }
      const label = (
        control.getAttribute('aria-label') ??
        (control.textContent ?? '').trim().slice(0, 40) ??
        control.tagName
      ).slice(0, 60)
      const now = Date.now()
      // 同一控件 300ms 内的连点只记一次
      if (label === lastLabel && now - lastAt < 300) {
        return
      }
      lastAt = now
      lastLabel = label
      recordUserAction(`click:${label}`, {
        stage: 'click',
        target: control.tagName.toLowerCase(),
        role: control.getAttribute('role') ?? 'button',
      })
    },
    true
  )
}

const installHooks = (): void => {
  if (hooksInstalled || typeof window === 'undefined') {
    return
  }
  hooksInstalled = true
  installWindowErrorHook()
  installConsoleHook()
  installFetchHook()
  installCapacitorHttpHook()
  installLongTaskHook()
  installVisibilityHook()
  installClickHook()
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null
let launchRecorded = false

// ---------------------------------------------------------------- 对外 API

export type CollectorOptions = {
  /** 是否安装全局 hook（默认 true；测试里想完全手动喂日志可关掉） */
  installHooks?: boolean
  /** 状态快照的数据来源（由应用侧注入，采集层不认识业务 store） */
  facts?: FactsProvider
}

/**
 * 初始化采集层：
 * 1. 第一件事就写 app_launch（缓冲区永不为空）；
 * 2. 装 hook、生成 sessionId、恢复上次落盘的日志；
 * 3. 起 30 秒一次的周期快照。
 * 重复调用是安全的（不会重复装 hook，也不会换 sessionId）。
 */
// ---------------------------------------------------------------- 原生渲染进程事件（Issue #44）

/** 原生侧入口：MainActivity 接管 onRenderProcessGone 后把事件写进 SharedPreferences，这里只读回显 */
const RENDER_EVENTS_PLUGIN = 'DiagnosticsDevice'
/** 已消费到的时间水位线：同一条原生记录不重复入日志 */
const RENDER_EVENTS_SEEN_KEY = 'chat-demo:render-process-events-seen-at'

const readRenderEventsWatermark = (): number => {
  try {
    const raw = localStorage.getItem(RENDER_EVENTS_SEEN_KEY)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

const writeRenderEventsWatermark = (value: number): void => {
  try {
    localStorage.setItem(RENDER_EVENTS_SEEN_KEY, String(value))
  } catch {
    // 隐私模式 / 存储满：水位线写不进去最多让下次重复记一条，不影响主流程。
  }
}

type NativeRenderEvent = { at?: number; event?: string; didCrash?: boolean; detail?: string }

/**
 * 把原生层落盘的渲染进程事件搬进诊断日志。
 *
 * onRenderProcessGone 的接管发生在原生层，日志缓冲却活在渲染进程里：进程一死，这段记忆
 * 就一起没了。所以 MainActivity 先写 SharedPreferences，渲染进程重建后由这里补记一条
 * warning —— 用户下次提交反馈时才看得到「什么时候死过、有没有自愈」。
 */
const drainNativeRenderProcessEvents = async (): Promise<void> => {
  if (readPlatform() !== 'android') {
    return
  }
  try {
    const plugin = Capacitor.registerPlugin<{
      renderProcessEvents(): Promise<{ events?: NativeRenderEvent[] }>
    }>(RENDER_EVENTS_PLUGIN)
    const result = await plugin.renderProcessEvents()
    const events = Array.isArray(result?.events) ? result.events : []
    const watermark = readRenderEventsWatermark()
    let next = watermark
    for (const item of events) {
      const at = typeof item?.at === 'number' ? item.at : 0
      if (!(at > watermark)) {
        continue
      }
      if (at > next) {
        next = at
      }
      const event = typeof item?.event === 'string' ? item.event : 'unknown'
      record('warning', item?.didCrash === true ? 'error' : 'warn', `render process ${event}`, {
        event,
        didCrash: item?.didCrash === true,
        detail: typeof item?.detail === 'string' ? item.detail : '',
        nativeAt: at,
      })
    }
    if (next > watermark) {
      writeRenderEventsWatermark(next)
    }
  } catch {
    // 老版本 APK / 插件缺失：静默跳过，诊断缺这一条也要能用。
  }
}

export const initCollector = async (options: CollectorOptions = {}): Promise<void> => {
  if (options.facts) {
    factsProvider = options.facts
  }
  const app = readAppInfo()
  const system = await readSystemInfo()
  const device = readDeviceInfo(system)
  if (!launchRecorded) {
    launchRecorded = true
    // 启动即写：先落 app_launch，后面的 restore / hook 都不影响「缓冲区非空」。
    // 机型/Android/WebView/屏幕/语言与 clientId/sessionId 都已在 header 行里（不占 meta 的 300 字额度）。
    record('app_launch', 'info', `launch ${app.version}(${app.versionCode}) ${app.buildType} on ${app.platform}`, {
      version: app.version,
      versionCode: app.versionCode,
      buildType: app.buildType,
      platform: app.platform,
      // 启动瞬间的网络状态：与后面的 net_error 对照，才能分清「一直断」还是「中途掉」
      ...readNetworkStatus(),
      device: `${device.model}/${device.screen}/${device.locale}`,
    })
  }
  if (options.installHooks !== false) {
    installHooks()
  }
  // 渲染进程死过一次的话，这里把它补回诊断日志（原生侧落盘 -> JS 缓冲）。
  await drainNativeRenderProcessEvents()
  await restore()
  void captureStateSnapshot('launch')
  snapshotTimer ??= setInterval(() => {
    void captureStateSnapshot('interval')
  }, SNAPSHOT_INTERVAL_MS)
}

/** 采集层唯一的出口：当前环境的日志快照（不含用户填写的 feedback 与截图） */
export const getSnapshot = (): LogSnapshot => {
  prune()
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    app: readAppInfo(),
    device: readDeviceInfo(systemInfoCache ?? readBrowserSystemInfo()),
    client: { clientId: readClientId(), sessionId: readSessionId() },
    logs: entries.slice(),
  }
}

/** 当前缓冲里的日志条数 */
export const getLogCount = (): number => {
  prune()
  return entries.length
}
