/**
 * 原生瘦快照（#909）：saveSession 成功后，把「会话文本 + 摘要」写到应用私有目录
 * `snapshots/<ts>.json`（带格式版本、会话数、sha256），保留最近 N 份。
 *
 * 边界：
 *  - **不含图片 / 附件 blob**：消息里的附件只留元信息（id / 名字 / 大小），正文不进快照；
 *  - 宿主没有私有文件系统（Web / iOS）→ 返回 `{ status: 'unsupported' }`，不写、不报错、不打日志；
 *  - 写失败（quota 等）**不影响主流程**：返回 `{ status: 'quota' | 'failed' }` 并记一条去重诊断；
 *  - 写入由调用方放在空闲 / 后台（`protectionAfterSave` 是 fire-and-forget），这里本身不阻塞输入。
 */
import { InfraError, type InfraErrorKind } from '../capability/errors.js'
import type { Session, SessionBranchOrigin, SessionSummary } from '../chat/types.js'
import { sha256OfText } from './checksum.js'
import {
  SNAPSHOT_DIR,
  SNAPSHOT_FORMAT_VERSION,
  PRE_RESTORE_KEEP,
  SNAPSHOT_KEEP,
  SNAPSHOT_MIN_INTERVAL_MS,
} from './constants.js'
import { kindOf, reportProtectionFailure } from './diagnostics.js'
import type { ProtectionDeps } from './types.js'

/** 快照里的消息：附件只留元信息，图片 / 文件的字节不进快照 */
export type SnapshotMessage = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  parentId?: string | null
  selectedChildId?: string
  content?: string
  files?: { id: string; name: string; size: number; isImage: boolean }[]
  text?: string
  status?: string
}

export type SnapshotSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinnedAt?: number
  customSystemPrompt?: string
  /** 消息树的根；缺省 = 线性会话（与 Session 同口径，`null` = 空会话） */
  rootMessageId?: string | null
  branchOf?: SessionBranchOrigin
  messages: SnapshotMessage[]
}

export type SnapshotFile = {
  v: number
  /** 写入时间（也是文件名） */
  at: number
  /** 写入时的库结构版本 */
  schema: number
  sessions: number
  summaries: SessionSummary[]
  data: SnapshotSession[]
  /** 覆盖除自身外全部字段的 sha256 */
  checksum: string
}

/** auto = 保存后自动快照；pre-restore = 恢复前对当前库状态的备份（单独轮转，不挤占 auto 的名额） */
export type SnapshotKind = 'auto' | 'pre-restore'

/** suspended：已判定库丢失、待用户处理时暂停自动快照（避免新数据把还能恢复的旧快照轮转掉） */
export type SnapshotStatus = 'written' | 'throttled' | 'suspended' | 'unsupported' | 'quota' | 'failed'

export type SnapshotWriteResult = {
  status: SnapshotStatus
  /** written 时的文件名（`<ts>.json`） */
  file?: string
  sessions?: number
  /** 非成功时的错误分类（与 InfraError.kind 同口径） */
  kind?: InfraErrorKind
}

const encoder = new TextEncoder()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const textOf = (message: { blocks?: { type: string; text?: string }[] }): string =>
  (message.blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')

/** 瘦身：只留可恢复对话所需的文本与元信息，blob / base64 / 用量 / 错误详情一律不带 */
export const toSnapshotSession = (session: Session): SnapshotSession => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.pinnedAt === undefined ? {} : { pinnedAt: session.pinnedAt }),
  ...(session.customSystemPrompt === undefined ? {} : { customSystemPrompt: session.customSystemPrompt }),
  ...(session.rootMessageId === undefined ? {} : { rootMessageId: session.rootMessageId }),
  ...(session.branchOf === undefined ? {} : { branchOf: session.branchOf }),
  messages: session.messages.map((message): SnapshotMessage => {
    const branch = {
      ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
      ...(message.selectedChildId === undefined ? {} : { selectedChildId: message.selectedChildId }),
    }
    if (message.role === 'user') {
      return {
        id: message.id,
        role: 'user',
        createdAt: message.createdAt,
        ...branch,
        content: message.content,
        files: message.files.map((file) => ({
          id: file.id,
          name: file.name,
          size: file.size,
          isImage: file.isImage,
        })),
      }
    }
    return {
      id: message.id,
      role: 'assistant',
      createdAt: message.createdAt,
      ...branch,
      text: textOf(message),
      status: message.status,
    }
  }),
})

const bodyOf = (file: Omit<SnapshotFile, 'checksum'>): string => JSON.stringify(file)

const serialize = async (file: Omit<SnapshotFile, 'checksum'>): Promise<string> => {
  const body = bodyOf(file)
  return JSON.stringify({ ...(JSON.parse(body) as object), checksum: await sha256OfText(body) })
}

/** 读侧校验：格式不对 / 校验和不过一律返回 null（损坏快照不许被当成可恢复） */
export const parseSnapshot = async (text: string): Promise<SnapshotFile | null> => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isRecord(raw) ||
    raw.v !== SNAPSHOT_FORMAT_VERSION ||
    typeof raw.at !== 'number' ||
    typeof raw.schema !== 'number' ||
    typeof raw.sessions !== 'number' ||
    !Array.isArray(raw.summaries) ||
    !Array.isArray(raw.data) ||
    typeof raw.checksum !== 'string' ||
    raw.data.length !== raw.sessions
  ) {
    return null
  }
  const { checksum, ...rest } = raw
  return (await sha256OfText(JSON.stringify(rest))) === checksum ? (raw as SnapshotFile) : null
}

const NAME = /^(pre-restore-)?(\d+)\.json$/u
const PREFIX: Record<SnapshotKind, string> = { auto: '', 'pre-restore': 'pre-restore-' }
const KEEP: Record<SnapshotKind, number> = { auto: SNAPSHOT_KEEP, 'pre-restore': PRE_RESTORE_KEEP }

export type SnapshotEntry = { name: string; kind: SnapshotKind; at: number; size: number }

export const createSnapshots = (deps: ProtectionDeps) => {
  let lastWrittenAt = 0

  const list = async (kind?: SnapshotKind): Promise<SnapshotEntry[]> => {
    const found: SnapshotEntry[] = []
    for (const entry of await deps.fs.list(SNAPSHOT_DIR)) {
      const match = NAME.exec(entry.name)
      if (!match) {
        continue
      }
      const entryKind: SnapshotKind = match[1] === undefined ? 'auto' : 'pre-restore'
      if (kind === undefined || kind === entryKind) {
        found.push({ name: entry.name, kind: entryKind, at: Number(match[2]), size: entry.size })
      }
    }
    return found.sort((left, right) => right.at - left.at)
  }

  /** 读并校验一份快照；不存在 / 损坏返回 null（损坏记一条诊断） */
  const read = async (name: string): Promise<SnapshotFile | null> => {
    const text = await deps.fs.readText(`${SNAPSHOT_DIR}/${name}`)
    if (text === undefined) {
      return null
    }
    const parsed = await parseSnapshot(text)
    if (!parsed) {
      reportProtectionFailure('snapshot-read', new Error('snapshot checksum mismatch or malformed'), {
        'protection.file': name,
      })
    }
    return parsed
  }

  const rotate = async (kind: SnapshotKind, keepName: string): Promise<void> => {
    const entries = await list(kind)
    const doomed = entries.filter((entry) => entry.name !== keepName).slice(KEEP[kind] - 1)
    for (const entry of doomed) {
      await deps.fs.remove(`${SNAPSHOT_DIR}/${entry.name}`)
    }
  }

  /**
   * 写一份快照。
   * `force`：会话结束 / 切后台时绕过 15s 节流（仍受「内容没变就不写」约束：调用方决定）。
   */
  const write = async (options: { force?: boolean; kind?: SnapshotKind } = {}): Promise<SnapshotWriteResult> => {
    if (!deps.fs.supported) {
      return { status: 'unsupported' }
    }
    const kind = options.kind ?? 'auto'
    const at = deps.now()
    if (kind === 'auto' && !options.force && at - lastWrittenAt < SNAPSHOT_MIN_INTERVAL_MS) {
      return { status: 'throttled' }
    }
    const [sessions, summaries] = await Promise.all([deps.storage.loadSessions(), deps.storage.loadSummaries()])
    const file: Omit<SnapshotFile, 'checksum'> = {
      v: SNAPSHOT_FORMAT_VERSION,
      at,
      schema: deps.storage.schemaVersion,
      sessions: sessions.length,
      summaries,
      data: sessions.map(toSnapshotSession),
    }
    const text = await serialize(file)
    const name = `${PREFIX[kind]}${at}.json`
    try {
      await deps.fs.writeAtomic(`${SNAPSHOT_DIR}/${name}`, encoder.encode(text))
      await rotate(kind, name)
    } catch (error) {
      reportProtectionFailure('snapshot-write', error, { 'protection.sessions': sessions.length })
      const kind = kindOf(error)
      const mapped: InfraErrorKind = kind === 'quota' || kind === 'permission' || kind === 'unsupported' ? kind : 'unknown'
      return { status: mapped === 'quota' ? 'quota' : 'failed', kind: mapped, sessions: sessions.length }
    }
    if (kind === 'auto') {
      lastWrittenAt = at
    }
    return { status: 'written', file: name, sessions: sessions.length }
  }

  return { write, list, read }
}

export type Snapshots = ReturnType<typeof createSnapshots>

/** 供调用方判断「这次失败要不要当错误抛」：快照写失败永远不抛（主流程优先） */
export const snapshotFailure = (result: SnapshotWriteResult): InfraError | null =>
  result.status === 'quota' || result.status === 'failed'
    ? new InfraError(result.kind ?? 'unknown', `snapshot: ${result.status}`)
    : null

