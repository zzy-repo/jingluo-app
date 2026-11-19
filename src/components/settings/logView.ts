import type { EventKind, LogEntry, LogLevel, LogMeta } from '../../services/diagnostics/types.js'

/**
 * 日志展示层（纯函数，不依赖 React）：过滤 / 搜索 / 按一次操作分组 / 单条复制文本。
 *
 * 为什么单独一层：展示逻辑以前全写在 FeedbackDialog 的 JSX 里，只能在真浏览器里验，
 * 「过滤后到底是几条」这种问题没法在单测里断言（见 #305）。抽出来后 UI 只负责渲染。
 *
 * 三条约束（与采集层的边界）：
 * 1. **只读**：这里拿到的 `LogEntry` 一律不改写，筛选结果不回写快照 —— 用户筛掉什么，提交的还是全量；
 * 2. 不认识业务：只认 `EventKind` / `LogLevel`，不 import 任何业务模块；
 * 3. 脱敏在采集层做完了（`collector.ts` 写入缓冲前 redact），这里不再二次截断，只负责展示与复制。
 */

/** 关键字搜索命中的范围：`msg` + `meta` 的**值**（键名不参与，避免搜 "stage" 命中所有带 stage 的条目） */
export const entryMatchesQuery = (entry: LogEntry, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return true
  }
  if (typeof entry.msg === 'string' && entry.msg.toLowerCase().includes(needle)) {
    return true
  }
  const meta = entry.meta
  if (meta) {
    for (const value of Object.values(meta)) {
      if (metaValueText(value).toLowerCase().includes(needle)) {
        return true
      }
    }
  }
  return false
}

/** meta 值的文本形态：超长串与对象都不许让展示层抛异常（负向用例：5000 字符的 meta 值） */
const metaValueText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null || value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export type LogFilter = {
  /** 空数组 = 不限 */
  kinds: readonly EventKind[]
  /** 空数组 = 不限 */
  levels: readonly LogLevel[]
  /** 关键字（匹配 msg 与 meta 值，大小写不敏感） */
  query: string
}

export const EMPTY_FILTER: LogFilter = { kinds: [], levels: [], query: '' }

/** 当前筛选条件是否「收敛过」（决定要不要给「清除筛选」入口） */
export const isFilterActive = (filter: LogFilter): boolean =>
  filter.kinds.length > 0 || filter.levels.length > 0 || filter.query.trim() !== ''

/** 单条是否通过筛选：kind / level / 关键字三者取交集 */
export const matchesFilter = (entry: LogEntry, filter: LogFilter): boolean => {
  if (filter.kinds.length > 0 && !filter.kinds.includes(entry.kind)) {
    return false
  }
  if (filter.levels.length > 0 && !filter.levels.includes(entry.level)) {
    return false
  }
  return entryMatchesQuery(entry, filter.query)
}

export const filterLogs = (entries: readonly LogEntry[], filter: LogFilter): LogEntry[] =>
  entries.filter((entry) => matchesFilter(entry, filter))

/** 多选开关：已选则移除，未选则追加（chip 点击用，纯函数便于单测） */
export const toggleSelection = <T>(selected: readonly T[], value: T): T[] =>
  selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]

/** 缓冲区里出现过的事件类型（按出现次数降序，同次数按首次出现顺序）：只给用户看得见的选项 */
export const kindsPresent = (entries: readonly LogEntry[]): EventKind[] => {
  const counts = new Map<EventKind, number>()
  const firstSeen = new Map<EventKind, number>()
  entries.forEach((entry, index) => {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
    if (!firstSeen.has(entry.kind)) {
      firstSeen.set(entry.kind, index)
    }
  })
  return [...counts.keys()].sort((a, b) => {
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
    return byCount !== 0 ? byCount : (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0)
  })
}

// ---------------------------------------------------------------- 按一次操作分组（过渡方案）

/**
 * 事件族：一次「发消息 / 导入 / 一次请求」在日志里表现为同族的连续 kind 序列。
 * `traceId` 尚未落地（#301 维度 5），所以这里只能靠 kind 族 + 时间邻近**保守**推断。
 */
export type LogFamily = 'chat' | 'net' | 'import' | 'misc'

const FAMILY_OF: Partial<Record<EventKind, LogFamily>> = {
  chat_send: 'chat',
  chat_first_token: 'chat',
  chat_done: 'chat',
  chat_abort: 'chat',
  net_request: 'net',
  net_response: 'net',
  net_error: 'net',
  import_start: 'import',
  import_stage: 'import',
  import_done: 'import',
  import_error: 'import',
}

export const familyOf = (kind: EventKind): LogFamily => FAMILY_OF[kind] ?? 'misc'

/** 起点类 kind：出现第二个同族起点，就说明是「又一次操作」，不必等时间间隔 */
const STARTER_KINDS = new Set<EventKind>([
  'chat_send',
  'net_request',
  'import_start',
  'nav',
  'app_launch',
  'config_change',
])

/** 时间邻近窗口：相邻两条超过这个间隔就一定切成两组 */
export const GROUP_GAP_MS = 2000

export type LogGroup = {
  /** 稳定 key（首条时间 + 序号），React key 用 */
  key: string
  family: LogFamily
  /** 组头时间（第一条的 t） */
  startedAt: number
  /** 组内条目（时间正序） */
  items: LogEntry[]
  /** 组内是否出现过起点类条目（决定下一族是否开新组） */
  hasStarter: boolean
}

/**
 * 按一次操作分组：**过渡方案**，等 `traceId` 落地后应改为按 trace 分组。
 *
 * 规则（保守，宁可多切一组也不要把两次操作混在一起）：
 * 1. 相邻两条间隔 > `GROUP_GAP_MS`（或时间倒退）→ 新组；
 * 2. `misc` 族（`nav` / `error` / `warning` / `longtask` / `state_snapshot` / `app_*`）不是一次操作的主体，
 *    一律并入当前组，只在组首时自成一组；
 * 3. 换族（chat → net → import）→ 新组；
 * 4. 同族再来一个起点类 kind（第二次 `chat_send` / `net_request` …）→ 新组。
 */
export const groupByOperation = (entries: readonly LogEntry[]): LogGroup[] => {
  const groups: LogGroup[] = []
  let current: LogGroup | null = null
  entries.forEach((entry, index) => {
    const family = familyOf(entry.kind)
    let startNew = current === null
    if (!startNew && current) {
      const gap = entry.t - current.items[current.items.length - 1].t
      if (!(gap >= 0) || gap > GROUP_GAP_MS) {
        startNew = true
      } else if (family === 'misc') {
        startNew = false
      } else if (family !== current.family) {
        startNew = true
      } else if (STARTER_KINDS.has(entry.kind) && current.hasStarter) {
        startNew = true
      }
    }
    if (startNew || !current) {
      current = {
        key: `${entry.t}-${index}`,
        family,
        startedAt: entry.t,
        items: [entry],
        hasStarter: STARTER_KINDS.has(entry.kind),
      }
      groups.push(current)
      return
    }
    current.items.push(entry)
    if (STARTER_KINDS.has(entry.kind)) {
      current.hasStarter = true
    }
  })
  return groups
}

// ---------------------------------------------------------------- 单条复制

const pad3 = (value: number) => String(value).padStart(3, '0')
const pad2 = (value: number) => String(value).padStart(2, '0')

/** 复制用的时间：`HH:MM:SS.mmm`（预览里只到秒，复制时要能对齐到毫秒，才能和 net_* 的 durationMs 对上） */
export const formatLogTimePrecise = (t: number): string => {
  const date = new Date(t)
  if (Number.isNaN(date.getTime())) {
    return '--:--:--.---'
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(
    date.getMilliseconds()
  )}`
}

/** meta 值转单行文本：换行折成 `\n` 字面量，保证「一个键一行」不被值里的换行打断 */
const metaValueForCopy = (value: unknown): string =>
  metaValueText(value).replace(/\r?\n/g, '\\n')

/**
 * 单条日志的复制文本：时间（到毫秒）+ level + kind + msg + **完整 meta**（键值逐行）。
 *
 * 完整 = 采集层写进来的全部键（已脱敏、已按 `MAX_META_LENGTH` 截断），这里不再取舍：
 * 少一个 `requestId` 或 `http.status`，用户就没法把这一条对上服务端的日志。
 */
export const formatEntryForCopy = (entry: LogEntry): string => {
  const lines = [
    `${formatLogTimePrecise(entry.t)} [${entry.level}] ${entry.kind}  ${entry.msg}`,
  ]
  const meta: LogMeta | undefined = entry.meta
  const keys = meta ? Object.keys(meta) : []
  if (meta && keys.length > 0) {
    lines.push('meta:')
    for (const key of keys) {
      lines.push(`  ${key} = ${metaValueForCopy(meta[key])}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- 组装给 UI 的视图

export type LogView = {
  /** 缓冲区总条数（提交上限另算，见 collector 的 MAX_LOG_ENTRIES） */
  total: number
  /** 通过筛选的条数（可能大于预览上限） */
  matchedCount: number
  /** 实际渲染的条数（末尾截断到 limit） */
  shownCount: number
  /** 实际渲染的条目（时间正序，只含最近 limit 条匹配结果） */
  entries: LogEntry[]
  /** entries 按操作分组后的结果（分组开关关掉时 UI 不用它） */
  groups: LogGroup[]
  /** 匹配数超过预览上限（需要告诉用户「还有更多没显示」） */
  truncated: boolean
}

/**
 * 一次算出「口径文案 + 实际渲染的条目」：
 * 先过滤，再取**末尾** limit 条（最近的日志才有用），分组基于截断后的条目 —— 这样
 * 界面上的「显示最近 N 条」与真实渲染行数永远一致，不会出现文案与实际不符。
 */
export const buildLogView = (
  entries: readonly LogEntry[],
  filter: LogFilter,
  limit: number
): LogView => {
  const total = entries.length
  const matched = filterLogs(entries, filter)
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  const shown = safeLimit > 0 && matched.length > safeLimit ? matched.slice(-safeLimit) : matched
  return {
    total,
    matchedCount: matched.length,
    shownCount: shown.length,
    entries: shown,
    groups: groupByOperation(shown),
    truncated: matched.length > shown.length,
  }
}
