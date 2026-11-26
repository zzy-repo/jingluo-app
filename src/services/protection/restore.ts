/**
 * 从快照恢复（#909）。三条纪律：
 *  1. **用户确认由调用方（UI）负责**，本模块不会自己触发恢复；没有任何自动覆盖路径；
 *  2. **校验和不过不恢复**：先读出并校验快照，通过才碰任何数据；
 *  3. **先备份再替换**：当前库里有会话时，先把它写成一份 `pre-restore-<ts>.json`；备份失败就停，
 *     当前数据一个字不动。替换走现有整包替换通道（`commitStaging`，单事务，失败整体回滚），
 *     本模块只负责「把快照写进暂存」，提交由调用方注入的 `commit` 完成（它同时负责中止流、等空闲、
 *     失败时清暂存）。
 *
 * 取消：暂存阶段每条会话之间检查 `signal`；一旦进入提交（单事务）就不可取消，也不需要 ——
 * 提交要么全成要么保持原样。
 */
import type { Session } from '../chat/types.js'
import { reportProtectionFailure } from './diagnostics.js'
import type { SnapshotEntry, SnapshotFile, SnapshotMessage, SnapshotSession, Snapshots } from './snapshot.js'
import type { ProtectionDeps } from './types.js'

export type RestoreStage = 'verify' | 'backup' | 'stage' | 'commit'
export type RestoreProgress = { stage: RestoreStage; done: number; total: number }

export type RestoreOptions = {
  signal?: AbortSignal
  onProgress?: (progress: RestoreProgress) => void
  /** 整包替换通道：`write()` 把数据写进暂存，随后提交。由 store 注入（`importHistoryInto(write,'overwrite')`） */
  commit: (write: () => Promise<unknown>) => Promise<unknown>
}

export type RestoreResult =
  | { status: 'restored'; sessions: number; backup: string | null }
  /** 用户取消：本机数据没有改动 */
  | { status: 'cancelled' }
  /** 快照读不到 / 校验和不过 / 格式不对：没有碰任何数据 */
  | { status: 'corrupt' }
  /** 快照来自比本构建更新的库版本：没有碰任何数据 */
  | { status: 'incompatible' }
  /** 恢复前备份当前状态失败（空间不足等）：已停止，当前数据没有改动 */
  | { status: 'backup-failed'; kind: string }
  /** 其余失败（含提交失败）：整体回滚，当前数据没有改动 */
  | { status: 'failed'; kind: string }

export type RestorableSnapshot = {
  name: string
  kind: SnapshotEntry['kind']
  at: number
  /** 校验通过才有值；损坏的快照 `valid=false`，UI 只展示、不给恢复入口 */
  sessions: number | null
  valid: boolean
}

class RestoreCancelled extends Error {
  constructor() {
    super('restore cancelled')
    this.name = 'RestoreCancelled'
  }
}

class RestoreBackupFailed extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`restore backup failed: ${kind}`)
    this.name = 'RestoreBackupFailed'
    this.kind = kind
  }
}

const kindOf = (error: unknown): string => {
  const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : undefined
  return typeof kind === 'string' ? kind : 'unknown'
}

const messageFromSnapshot = (message: SnapshotMessage): Session['messages'][number] => {
  const branch = {
    ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
    ...(message.selectedChildId === undefined ? {} : { selectedChildId: message.selectedChildId }),
  }
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: message.content ?? '',
      createdAt: message.createdAt,
      ...branch,
      // 原件不在快照里：只还原元信息，serverId 置空、mimeType 未知 —— 与「导入的历史会话」同一状态，
      // 界面按既有口径显示「附件不可用」，发送时不重传（#379）
      files: (message.files ?? []).map((file) => ({
        id: file.id,
        serverId: null,
        name: file.name,
        size: file.size,
        isImage: file.isImage,
        mimeType: '',
      })),
    }
  }
  const text = message.text ?? ''
  return {
    id: message.id,
    role: 'assistant',
    createdAt: message.createdAt,
    ...branch,
    model: null,
    prefix: false,
    // 快照时还在生成的回复：恢复出来只能是「已停止」，不能凭空变成「正在生成」
    status: message.status === 'done' || message.status === 'error' ? message.status : 'stopped',
    blocks: text === '' ? [] : [{ type: 'text', text }],
  }
}

/** 瘦快照里的会话 → 完整会话结构（缺失的字段回落到默认；读入后仍会过一遍 `normalizeSession`） */
export const sessionFromSnapshot = (session: SnapshotSession): Session => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.pinnedAt === undefined ? {} : { pinnedAt: session.pinnedAt }),
  ...(session.customSystemPrompt === undefined ? {} : { customSystemPrompt: session.customSystemPrompt }),
  ...(session.rootMessageId === undefined ? {} : { rootMessageId: session.rootMessageId }),
  ...(session.branchOf === undefined ? {} : { branchOf: session.branchOf }),
  messages: session.messages.map(messageFromSnapshot),
})

export const createRestore = (deps: ProtectionDeps, snapshots: Snapshots) => {
  /** 列出可恢复的快照：逐份校验，损坏的也列出来（标 invalid），不静默吞掉 */
  const list = async (): Promise<RestorableSnapshot[]> => {
    if (!deps.fs.supported) {
      return []
    }
    const result: RestorableSnapshot[] = []
    for (const entry of await snapshots.list()) {
      let file: SnapshotFile | null = null
      try {
        file = await snapshots.read(entry.name)
      } catch (error) {
        reportProtectionFailure('snapshot-list', error)
      }
      result.push({
        name: entry.name,
        kind: entry.kind,
        at: entry.at,
        sessions: file === null ? null : file.sessions,
        valid: file !== null,
      })
    }
    return result
  }

  const restore = async (name: string, options: RestoreOptions): Promise<RestoreResult> => {
    const { signal, onProgress, commit } = options
    const progress = (stage: RestoreStage, done: number, total: number) => onProgress?.({ stage, done, total })
    const cancelled = () => signal?.aborted === true

    progress('verify', 0, 1)
    let file: SnapshotFile | null
    try {
      file = await snapshots.read(name)
    } catch (error) {
      reportProtectionFailure('restore-read', error)
      return { status: 'failed', kind: kindOf(error) }
    }
    if (file === null) {
      return { status: 'corrupt' }
    }
    if (file.schema > deps.storage.schemaVersion) {
      return { status: 'incompatible' }
    }
    if (cancelled()) {
      return { status: 'cancelled' }
    }

    let backup: string | null = null
    const write = async (): Promise<void> => {
      // 1. 恢复前备份当前状态（库是空的就没什么可备份）
      progress('backup', 0, 1)
      if ((await deps.storage.countSessions()) > 0) {
        const result = await snapshots.write({ kind: 'pre-restore', force: true })
        if (result.status !== 'written') {
          throw new RestoreBackupFailed(result.kind ?? result.status)
        }
        backup = result.file ?? null
      }
      // 2. 写暂存：每条之间都可取消
      const total = file.data.length
      let staged = 0
      for (const item of file.data) {
        if (cancelled()) {
          throw new RestoreCancelled()
        }
        await deps.storage.stageSession(sessionFromSnapshot(item))
        staged += 1
        progress('stage', staged, total)
      }
      if (cancelled()) {
        throw new RestoreCancelled()
      }
      progress('commit', 0, 1)
    }

    try {
      await commit(write)
    } catch (error) {
      if (error instanceof RestoreCancelled) {
        return { status: 'cancelled' }
      }
      if (error instanceof RestoreBackupFailed) {
        reportProtectionFailure('restore-backup', error, { 'protection.kind': error.kind })
        return { status: 'backup-failed', kind: error.kind }
      }
      reportProtectionFailure('restore-commit', error)
      return { status: 'failed', kind: kindOf(error) }
    }
    progress('commit', 1, 1)
    return { status: 'restored', sessions: file.sessions, backup }
  }

  return { list, restore }
}

export type Restore = ReturnType<typeof createRestore>
