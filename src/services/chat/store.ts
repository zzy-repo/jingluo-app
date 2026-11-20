import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import {
  classifyApiError,
  extractFileIds,
  getFileErrorCode,
  isRetryableApiError,
} from '../api/errors.js'
import { classifyKeyFailure } from '../api/keyFailure.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import {
  captureStateSnapshot,
  errorMeta,
  record,
  recordAction,
  recordError,
  recordEvent,
} from '../diagnostics/collector.js'
import { getApiKey, getBaseUrl, getCurrentSpec, getModel } from '../api/apiConfig.js'
import { buildMeta, endpointKeyFromUrl } from '../diagnostics/fields.js'
import { createStreamMeter, streamTimingMeta } from '../diagnostics/timing.js'
import { requestGates } from '../api/providers.js'
import { LIMITS } from '../limits.js'
import { useSettings } from '../settings.js'
import { generateSessionTitle } from './autoTitle.js'
import {
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
  type SessionDamageReporter,
} from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  foldReminders,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import { buildMessageBody } from './requestBody.js'
import { STREAM_NOTICE_TIERS } from './streamNotice.js'
import { composeWaitNotice, needsUpload, type WaitHint, type WaitStage } from './waitStage.js'
import type { MergePlan, ImportMode } from './history/mergeSessions.js'
import type { ImportSkip } from './history/toLocal.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 自动重试的最多次数（不含首次请求）：附件补传、断网、5xx、超时共用这一个上限 */
export const STREAM_RETRY_LIMIT = LIMITS.streamRetryLimit
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const RETRY_BASE_DELAY = LIMITS.retryBaseDelayMs

/**
 * 按当前服务类型的 spec 组装 system 与 messages：
 * 支持 latest_reminder 的协议（DeepSeek）原样发送快照行；
 * 不支持的协议把快照内容折进 system 前缀，并从 messages 里删掉这些行。
 */
const toRequestBody = (
  messages: ReturnType<typeof toRequestMessages>
): { system: string; messages: ReturnType<typeof toRequestMessages> } => {
  if (requestGates(getCurrentSpec()).latest_reminder) {
    return { system: SYSTEM_PROMPT, messages }
  }
  const folded = foldReminders(messages)
  return {
    system: [SYSTEM_PROMPT, ...folded.reminders].join('\n'),
    messages: folded.messages,
  }
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

/**
 * 自动标题（Anthropic / OpenAI 兼容模式）已经处理过的会话。
 * 生成成功、失败回退、以及用户手动改名都会加进来，保证同一会话只触发一次、永不覆盖用户的名字。
 */
const autoTitleDone = new Set<string>()
/** 正在请求中的自动标题任务：改名 / 删除 / 停止时取消，省掉无用的上游调用 */
const autoTitleTasks = new Map<string, AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 最近一次历史导入被跳过的条目（损坏的会话 / 消息），供「导入详情」展示（#49） */
  importSkipped: ImportSkip[]
  /** 最近一次历史导入的结果摘要（模式 + 新增/覆盖/跳过），供「导入详情」展示（#390）；没导过为 null */
  importSummary: HistoryImportSummary | null
  /**
   * 还在等首字的会话：当前该显示的等待提示（阶段 + 分档）；收到首字或本轮结束就删掉。
   * **不按秒写入**：秒数只活在叶子组件里（1Hz 只重渲染那一行），避免整棵消息列表每秒重渲染。
   */
  waitHints: Record<string, WaitHint>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  importSkipped: [],
  importSummary: null,
  waitHints: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

/**
 * 同一档提示重复写入时保持引用不变，避免组件无谓重渲染。
 * 阶段与分档也要进签名：只换了阶段/档位（文案 key 恰好没变，例如重试期升到 30s）时，
 * 组件仍需要拿到新的 `tier` / `actions`。
 */
const hintSignature = (hint: WaitHint) =>
  [
    hint.key,
    hint.params ? JSON.stringify(hint.params) : '',
    hint.stage ?? '',
    hint.tier?.afterMs ?? '',
    hint.actions ? '1' : '0',
  ].join('|')

/** 换掉/清掉某个会话的等待提示；清掉时不留空壳，组件订阅的是 key 本身 */
const setWaitHint = (sessionId: string, hint?: WaitHint) => {
  set((state) => {
    const current = state.waitHints[sessionId]
    if (hint) {
      return current && hintSignature(current) === hintSignature(hint)
        ? {}
        : { waitHints: { ...state.waitHints, [sessionId]: hint } }
    }
    if (!current) {
      return {}
    }
    const waitHints: Record<string, WaitHint> = {}
    for (const [id, hint] of Object.entries(state.waitHints)) {
      if (id !== sessionId) {
        waitHints[id] = hint
      }
    }
    return { waitHints }
  })
}

/**
 * 本轮的等待阶段（按会话）。`startedAt` 只在这里存一份：
 * 附件补齐 → 建连 → 等首字 → 思考，阶段变了只重算提示，**累计秒数不归零**（重试也不归零）。
 */
const waitStates = new Map<
  string,
  { startedAt: number; stage: WaitStage | null; retry?: { attempt: number; limit: number } }
>()

/** 按当前阶段与已等待时长重算提示；不足 5s（且不在重试）时什么都不显示 */
const syncWaitHint = (sessionId: string) => {
  const current = waitStates.get(sessionId)
  if (!current) {
    return
  }
  const hint = composeWaitNotice({
    stage: current.stage,
    startedAt: current.startedAt,
    now: Date.now(),
    retry: current.retry,
  })
  setWaitHint(sessionId, hint ?? undefined)
}

/**
 * 从点发送那一刻开始等待：三档定时器按「离 startedAt 还剩多久」挂，
 * 所以阶段切换（含附件补齐耗时）不会把 5s/30s/60s 重新计一遍（#328 G1/G6）。
 */
const armWaitHints = (sessionId: string, startedAt: number) => {
  clearWaitHints(sessionId)
  waitStates.set(sessionId, { startedAt, stage: null })
  waitHintTimers.set(
    sessionId,
    STREAM_NOTICE_TIERS.map((tier) =>
      setTimeout(() => syncWaitHint(sessionId), Math.max(0, startedAt + tier.afterMs - Date.now()))
    )
  )
}

/** 切换阶段（不重置 startedAt）；未 armed 时是 no-op，不会凭空造出提示 */
const setWaitStage = (
  sessionId: string,
  stage: WaitStage | null,
  retry?: { attempt: number; limit: number }
) => {
  const current = waitStates.get(sessionId)
  if (!current) {
    return
  }
  current.stage = stage
  current.retry = retry
  syncWaitHint(sessionId)
}

/** 收到首字或本轮结束：撤下提示并停掉没到点的定时器 */
const clearWaitHints = (sessionId: string) => {
  for (const timer of waitHintTimers.get(sessionId) ?? []) {
    clearTimeout(timer)
  }
  waitHintTimers.delete(sessionId)
  waitStates.delete(sessionId)
  setWaitHint(sessionId)
}

/**
 * 本轮真正会做附件补齐的文件：只有本条提问的附件（#379 起历史附件不再重传），
 * 其中还有没上到服务端的要单独显示「正在上传附件」阶段。
 */
const roundFiles = (request: Request) => request.question.files

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
/**
 * 服务端刚判失效、等着本轮重传的附件（本地 id → 附件）。
 * 只有「本来就有 file_id、被服务端判失效」的附件会登记在这里：原件在我们手上、当初上传成功过，
 * 重传是自愈（换服务地址后旧 file_id 全失效就是这条路径），不属于「重传历史记录」。
 * 导入会话的历史附件从来没上传成功过（`serverId` 一律是 null，见 `history/toLocal.ts`），
 * 永远进不了这个集合 —— 这正是 #379 的隔离点。
 */
const recoveringFiles = new Map<string, FileAttachment>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
/** 首字等待提示的升级定时器（按会话）：收到首字、本轮收尾或重开一轮时统一清掉 */
const waitHintTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/**
 * 按当前开关创建回复：快速/专家模式（settings.chatMode）对应 thinking，
 * 智能搜索控制 deepseek_web_search。模式一并写进回复快照，请求体由 streamReply 组装。
 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: getModel(),
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/**
 * 读到损坏数据时记一条诊断（issue #28）：只记字段 / 动作 / 条数，**不记正文**。
 * stage 固定 session.normalize，便于在日志里和会话加载失败区分开。
 */
const reportSessionDamage: SessionDamageReporter = (damage) => {
  const first = damage[0]
  recordError('session data repaired', {
    stage: 'session.normalize',
    reason: 'corrupt-storage',
    'damage.count': damage.length,
    'damage.fields': Array.from(new Set(damage.map((item) => `${item.field}:${item.action}`)))
      .sort()
      .join(','),
    ...(first === undefined ? {} : { 'damage.firstField': `${first.field}:${first.action}` }),
    ...(first?.received === undefined ? {} : { 'damage.received': first.received }),
    ...(first?.dropped === undefined ? {} : { 'damage.dropped': first.dropped }),
    ...(first?.messageId === undefined ? {} : { 'damage.messageId': first.messageId }),
  })
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored, reportSessionDamage))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/** write() 的返回值：本次导入被跳过的条目（损坏会话 / 消息），正常返回即「部分成功」。 */
export type HistoryImportResult = { skipped?: ImportSkip[] }

/** 从 write() 的返回值里取 skipped；旧调用方不返回值，按「没有跳过」处理。 */
const readSkipped = (value: unknown): ImportSkip[] => {
  const skipped = (value as HistoryImportResult | undefined)?.skipped
  return Array.isArray(skipped) ? skipped : []
}

/**
 * write() 抛出本错误表示「已写入暂存 staged 条，其余无法导入」（#49）。
 * replaceHistory 据此提交已写入部分并记录 skipped，而不是整包回滚。
 */
export class PartialHistoryImportError extends Error {
  /** 被跳过的条目，按会话 / 消息给出定位信息 */
  skipped: ImportSkip[]
  /** 已成功写入暂存的会话数；<=0 时仍按整包失败处理 */
  staged: number
  constructor(skipped: ImportSkip[], staged: number, cause?: unknown) {
    super(`history import partially failed: ${skipped.length} skipped`)
    this.name = 'PartialHistoryImportError'
    this.skipped = skipped
    this.staged = staged
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/** 抛出物是否代表「部分成功」：显式类，或任意带 skipped / staged 的、由导入方构造的错误。 */
const skippedOf = (error: unknown): { skipped: ImportSkip[]; staged: number } | null => {
  if (error instanceof PartialHistoryImportError) {
    return { skipped: error.skipped, staged: error.staged }
  }
  const value = error as { skipped?: unknown; staged?: unknown } | null
  if (!Array.isArray(value?.skipped)) {
    return null
  }
  return {
    skipped: value.skipped as ImportSkip[],
    staged: typeof value.staged === 'number' ? value.staged : value.skipped.length,
  }
}

/**
 * 一次历史导入的结果（#390）：模式 + 条数统计 + 明细。
 *
 * `count` 是本次**写入**的会话数（新增 + 覆盖）：整包覆盖模式下它就是包内会话数，
 * 增量模式下「跳过」的不算进 count，界面据此显示「新增 N / 覆盖 M / 跳过 K」。
 */
export type HistoryImportSummary = {
  mode: ImportMode
  count: number
  added: number
  overwritten: number
  skipped: number
  /** 因冲突被跳过的会话标题（本地版本胜出），用于导入结果明细 */
  skippedTitles: string[]
}

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话。
 *
 * 事务语义（#49）：仍按「整包一次原子替换」提交（db 的暂存→提交是单事务交换，按条提交需要 db 层的
 * 逐条事务与摘要记账，不在本条 lane 的所有权内），但**不再整包回滚**——
 * write() 正常返回并带上 skipped，或抛出「已暂存部分」的部分成功错误时，已写入的会话照常提交，
 * 失败条目记进 state.importSkipped 上报；只有整包不可用（一条都没写成）才清暂存并抛错。
 *
 * 返回写入的会话数（= 提交后本地会话总数），供旧调用方沿用。
 */
export const replaceHistory = async (write: () => Promise<unknown>): Promise<number> =>
  (await importHistoryInto(write, 'overwrite')).count

/**
 * 历史导入（#390）：与 `replaceHistory` 同一条解析 / 暂存路径，只在**提交**这一步按模式分叉——
 *   - `overwrite`（现有行为）：清空本地会话与附件后整包替换；
 *   - `merge` / `skip`：本地会话一条都不删，只把暂存里的会话合并进来
 *     （同 id 冲突按更新时间取舍 / 一律跳过，口径见 `history/mergeSessions.ts`）。
 */
export const importHistoryInto = async (
  // 允许返回 skipped 清单；返回 void / 数字的旧调用方照旧可用（返回类型统一按 unknown 收）
  write: () => Promise<unknown>,
  mode: ImportMode = 'overwrite'
): Promise<HistoryImportSummary> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    type Committed = { summaries: SessionSummary[]; plan: MergePlan | null }
    /** 提交暂存：整包覆盖是「清空 + 整体搬入」，增量模式是「按冲突口径合并」。 */
    const commit = async (): Promise<Committed> => {
      if (mode === 'overwrite') {
        return { summaries: await db.commitStaging(), plan: null }
      }
      const plan = await db.mergeStaging(mode)
      // 合并后本地会话是「原有的 + 新增的」，与包内会话数无关，必须重新读一遍列表。
      return { summaries: await db.loadSessionSummaries(), plan }
    }
    let committed: Committed
    let skipped: ImportSkip[] = []
    try {
      skipped = readSkipped(await write())
      committed = await commit()
    } catch (error) {
      // 部分成功：调用方已确认有会话写进暂存（staged > 0）并带上了 skipped，
      // 此时按「能导入的先导入」提交已写入部分，不整包回滚。
      const partial = skippedOf(error)
      if (partial === null || partial.staged <= 0) {
        await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
        throw error
      }
      skipped = partial.skipped
      record('import_done', 'warn', 'history import committed partially', {
        imported: partial.staged,
        skipped: partial.skipped.length,
      })
      try {
        committed = await commit()
      } catch (commitError) {
        await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
        throw commitError
      }
    }
    const { summaries, plan } = committed
    const summary: HistoryImportSummary = {
      mode,
      count: plan === null ? summaries.length : plan.added + plan.overwritten,
      added: plan === null ? summaries.length : plan.added,
      overwritten: plan?.overwritten ?? 0,
      skipped: plan?.skipped ?? 0,
      skippedTitles: plan?.skippedTitles ?? [],
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    if (mode === 'overwrite') {
      clearAllDrafts()
      set({
        ready: true,
        initError: false,
        sessions: sortSessions(summaries),
        sessionCache: {},
        sessionLoadErrors: {},
        sessionSaveErrors: {},
        importSkipped: skipped,
        importSummary: summary,
        activeId: null,
      })
    } else {
      // 增量模式只丢弃「本次被写入」那些会话的草稿：其余本地会话连草稿都不该被动到。
      for (const id of plan?.written ?? []) {
        clearDraft(id)
      }
      const activeId = get().activeId
      set({
        ready: true,
        initError: false,
        sessions: sortSessions(summaries),
        sessionCache: {},
        sessionLoadErrors: {},
        sessionSaveErrors: {},
        importSkipped: skipped,
        importSummary: summary,
        // 当前打开的会话本地还在就继续停在它上面，别把用户从正在看的那条会话上踢走。
        activeId: activeId !== null && summaries.some((item) => item.id === activeId) ? activeId : null,
      })
    }
    return summary
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (get().activeId !== id) {
    recordAction('nav', 'select-session', { sessions: get().sessions.length })
  }
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const pinSession = (id: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const session = get().sessions.find((item) => item.id === id)
  if (!session) {
    return
  }
  const pinnedAt = session.pinnedAt === undefined ? Date.now() : undefined
  set((state) => ({
    sessions: sortSessions(
      state.sessions.map((item) => (item.id === id ? { ...item, pinnedAt } : item))
    ),
  }))
  void db.pinSession(id, pinnedAt).catch(db.reportStorageError('pin session'))
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  // 用户手动改名（含主动清空）：本轮原生标题写入取消，本地自动标题也不再触发或覆盖
  autoTitleDone.add(id)
  autoTitleTasks.get(id)?.abort()
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    autoTitleTasks.get(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    autoTitleDone.delete(id)
    autoTitleTasks.delete(id)
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  // 关键业务动作：只记字符数、附件数与本轮模式，正文绝不进日志
  // （模式进日志是为了 issue #25 的取证口径：用户反馈「专家模式和快速没区别」时能直接对上）
  recordAction('chat_send', 'send-message', {
    chars: text.length,
    files: files.length,
    mode: useSettings.getState().chatMode,
    ...buildMeta({
      flow: 'chat',
      stage: 'chat.send',
      attempt: 1,
      endpointKey: endpointKeyFromUrl(getBaseUrl()),
    }),
    model: getModel(),
  })
  void captureStateSnapshot('after-chat-send')
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? getModel(),
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - **历史轮次的附件默认不补传**（#379）：它们属于既有消息记录，发新消息不该触发上传。
 *   导入会话的历史附件 `serverId` 一律是 null（`history/toLocal.ts` 的 `toFile`），旧代码每轮都
 *   拿本地原件重传一次；导入的文档没有原件则静默跳过，导入的图片有原件就真的打一次 Files API，
 *   失败态写进上传任务表、被卡片读成「上传失败」——纯文字消息也跟着背锅。
 *   现在没有 serverId 的历史附件由 `toFileBlocks` 自然排除在请求之外：只展示，不重传、不阻断发送。
 * - 例外：服务端判失效、由 `reuploadInvalidatedFiles` 登记进 `recoveringFiles` 的附件仍会重传一次
 *   （它们本来有 file_id，原件也在本机，重传是自愈；换服务地址后历史附件靠这条路径恢复）。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = getApiKey()
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  // 历史附件不补传（#379）：它们属于既有消息记录，发新消息不该触发上传。
  // 唯一的例外是服务端刚判失效、由 reuploadInvalidatedFiles 登记的附件（recoveringFiles）：
  // 那种附件本来有 file_id，重传是自愈，不是「重传历史记录」。
  const skipped = new Set<string>()
  for (const [user] of getContextRounds(request.history)) {
    for (const file of user.files) {
      if (file.serverId || serverIds.has(file.id)) {
        continue
      }
      const recovering = recoveringFiles.get(file.id)
      if (!recovering) {
        skipped.add(file.id)
        continue
      }
      // 一次请求只用一次：失败也不再排队重来，避免把失败态留在卡片上
      recoveringFiles.delete(file.id)
      signal.throwIfAborted()
      try {
        const serverId = await Promise.race([ensureServerId(apiKey, recovering), aborted])
        if (serverId) {
          serverIds.set(file.id, serverId)
          saveServerIds(sessionId, new Map([[file.id, serverId]]))
        }
      } catch {
        signal.throwIfAborted()
        // 自愈失败也不许把「上传失败」写进历史附件的卡片（#379 的症状就是这个）
        cancelUpload(file.id)
        record('chat_send', 'warn', 'history attachment recovery failed', {
          reason: 'history',
          status: 'error',
        })
      }
    }
  }
  if (skipped.size > 0) {
    record('chat_send', 'info', 'history attachments not re-uploaded', {
      count: skipped.size,
      reason: 'history',
    })
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      // 登记待重传：历史轮次的附件平时不补传（#379），只有这里登记过的才允许重传一次
      recoveringFiles.set(file.id, { ...file, serverId: null })
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 本轮失败后要怎么办：继续重试、按用户停止收尾、还是把原始报错展示出来 */
export type StreamRetryDecision = 'retry' | 'aborted' | 'final'

/**
 * 统一的重试口径（#105）。以前只有「附件失效补传」会重试，断网 / 5xx / 超时直接报错；
 * 现在把可自愈的失败也算进来，但都受同一个上限约束：
 * - 用户点了停止：abort 不是可重试错误，最高优先级，一次都不再发；
 * - 已经收到过内容块（含被丢弃的客户端工具调用）：重发会答两遍，不再重试；
 * - 重试次数到 STREAM_RETRY_LIMIT 就放弃，把原始报错交给界面；
 * - 可重试分类交给 isRetryableApiError（网络 / 超时 / 断流 / 限流 / 5xx）；
 * - 附件失效是 400，本身不可重试，但补传成功后可以再来一次，由 fileRecovered 兜住。
 */
export const decideStreamRetry = ({
  error,
  attempt,
  receivedContent,
  aborted,
  fileRecovered,
}: {
  error: unknown
  /** 已经重试过几次（首次请求为 0） */
  attempt: number
  receivedContent: boolean
  aborted: boolean
  fileRecovered: boolean
}): StreamRetryDecision => {
  if (aborted) {
    return 'aborted'
  }
  if (receivedContent || attempt >= STREAM_RETRY_LIMIT) {
    return 'final'
  }
  return isRetryableApiError(error) || fileRecovered ? 'retry' : 'final'
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 首轮回答正常结束后补一个会话标题（只在没有原生标题的协议上做，见 autoTitle.ts）。
 *
 * 触发规则沿用现有的 titleRequests 语义：
 * - 会话已有标题（含用户手动改名）→ 不触发、不覆盖；
 * - 同一会话只触发一次（autoTitleDone），失败回退后也算处理过；
 * - 异步执行，不阻塞 UI；失败只回退到本地截取，不向用户报错。
 */
const scheduleAutoTitle = (sessionId: string) => {
  if (requestGates(getCurrentSpec()).title) {
    // DeepSeek 官方模式：服务端在 message_delta 里返回 title，本地不生成
    return
  }
  if (autoTitleDone.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || session.title) {
    return
  }
  // 只喂第一条人类消息（不要问答对）
  const first = session.messages.find((message) => message.role === 'user')
  const text = first?.content?.trim() ?? ''
  autoTitleDone.add(sessionId)
  if (!text) {
    return
  }
  const task = new AbortController()
  autoTitleTasks.set(sessionId, task)
  void generateSessionTitle(text, task.signal)
    .then((title) => {
      if (!title || task.signal.aborted) {
        return
      }
      if (get().importingHistory || deletingSessions.has(sessionId)) {
        return
      }
      // 「只写一次」：期间用户改名了就保留用户的标题
      updateSession(sessionId, (current) => (current.title ? current : { ...current, title }))
      persist(sessionId)
    })
    .catch(() => {
      // 标题永远不影响对话：任何异常都吞掉
    })
    .finally(() => {
      if (autoTitleTasks.get(sessionId) === task) {
        autoTitleTasks.delete(sessionId)
      }
    })
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  /** 本轮开始时间：chat_first_token / chat_done / 中止都用它算耗时（老口径，保持不变） */
  const startedAt = Date.now()
  /**
   * 本轮分段计时（#306 / #101）：附件补齐 → 请求发出 → 响应头 → 首字 → 吐字，
   * 每一段都能单独比较。老口径的 startedAt 在附件补齐**之前**，混了上传耗时，
   * 所以「上游排队慢」和「弱网吐字慢」在旧日志里是同一个数。
   */
  const meter = createStreamMeter()
  /** 本轮是第几次尝试（重试会递增）：第一次就慢 与 重试后才成 必须分得开 */
  let attemptNo = 1
  /** 端点键（只写 config/endpoints.json 的键，不写完整 URL） */
  const endpointKey = () => endpointKeyFromUrl(getBaseUrl())
  /** 是否已记过第一个 token（只记一次） */
  let firstTokenLogged = false
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  /** 本轮是否正常收尾（stop）：只有正常结束才补会话标题 */
  let finished = false
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)
  // 等待提示从「点发送」就开始计时（#328）：附件补齐也在这段里，不再等请求发出才挂表
  armWaitHints(sessionId, startedAt)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 1 起计：日志里的 attempt 就是「第几次尝试」 */
      attemptNo = attempt + 1
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        setWaitStage(sessionId, needsUpload(roundFiles(request)) ? 'uploading' : 'preparing')
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件补齐完成、请求即将发出：阶段切到「正在连接上游」（秒数继续累加，不归零）
        setWaitStage(sessionId, 'connecting')
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const spec = getCurrentSpec()
        // 协议不支持思考（caps.thinking=false，由 reasoningParam 派生）时请求侧也不开，
        // 避免历史里带思考块回传
        const thinking = (initial.thinking ?? false) && spec.caps.thinking
        const { system, messages } = toRequestBody(
          toRequestMessages(
            prepared.history,
            prepared.question,
            prepared.prefix,
            thinking,
            latestReminder,
            // 裁剪边界跟着会话走（#345）：同一会话的后续轮次沿用同一个边界，
            // 请求前缀逐字节稳定，上游上下文缓存才会命中
            { anchorKey: sessionId }
          )
        )
        // 附件已补齐、请求即将发出：prepMs 到此为止，后面的耗时才是「等上游」
        meter.markRequest()
        // 字段发不发由 requestBody.ts 里的 REQUEST_GATES 决定，这里只把本轮信息传进去
        const body = buildMessageBody(spec, {
          model: initial.model ?? getModel(),
          system,
          messages,
          thinking,
          search: initial.search ?? false,
          title: titleRequests.has(controller),
        })
        const events = streamMessage(getApiKey(), body, controller.signal, {
          // 只接「响应头到手」这一个时刻：首字与分段的间隔在下面的事件循环里记（要带字符数）
          onHeaders: () => {
            meter.markHeaders()
            // 已连上、还没出字：「等首字」与「还没连上」在界面上要能分开（#328 G2/G3）
            setWaitStage(sessionId, 'awaitingFirstToken')
          },
        })
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          // 分段计时：只在**内容事件**上打点。message_start / ping 不是「首字」，
          // 拿它们当首字会把「建连完成」记成「用户看到第一个字」。
          if (event.type === 'content_block_start' || event.type === 'content_block_delta') {
            meter.markEvent(
              event.type === 'content_block_delta' && event.delta.type === 'text_delta'
                ? event.delta.text.length
                : 0
            )
          }
          if (
            !firstTokenLogged &&
            (event.type === 'content_block_start' || event.type === 'content_block_delta')
          ) {
            firstTokenLogged = true
            /**
             * 首字到了（#328）：第一个块是**思考**时提示不撤，改成「模型正在思考」——
             * 思考期可能几十秒没有正文（hidden 档连思考块都不显示），撤掉就成了无文案干等；
             * 正文/工具块才是「用户看到内容」，那时才撤。
             */
            if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
              setWaitStage(sessionId, 'thinking')
            } else {
              clearWaitHints(sessionId)
            }
            const firstToken = meter.snapshot()
            recordEvent('chat_first_token', `first token in ${Date.now() - startedAt}ms`, {
              ...buildMeta({
                flow: 'chat',
                stage: 'chat.stream',
                attempt: attemptNo,
                status: 'ok',
                endpointKey: endpointKey(),
                durationMs: Date.now() - startedAt,
                ...(firstToken.prepMs === null ? {} : { prepMs: firstToken.prepMs }),
                ...(firstToken.ttfbMs === null ? {} : { ttfbMs: firstToken.ttfbMs }),
                ...(firstToken.firstTokenMs === null
                  ? {}
                  : { firstTokenMs: firstToken.firstTokenMs }),
                chunks: firstToken.chunks,
              }),
              model: initial.model ?? getModel(),
            })
          }
          // 思考块之后开始吐正文/工具块：思考期的等待提示到此结束
          if (
            firstTokenLogged &&
            event.type === 'content_block_start' &&
            event.content_block.type !== 'thinking'
          ) {
            clearWaitHints(sessionId)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        const timing = meter.snapshot()
        recordEvent('chat_done', `chat done in ${Date.now() - startedAt}ms`, {
          ...buildMeta({
            flow: 'chat',
            stage: 'chat.settle',
            attempt: attemptNo,
            status: 'ok',
            endpointKey: endpointKey(),
            ...streamTimingMeta(timing),
            // 以最终渲染出来的正文长度为准（meter 只累加增量，丢帧时会少算）
            chars: reply.blocks.reduce(
              (total, block) => total + (block.type === 'text' ? block.text.length : 0),
              0
            ),
          }),
          model: initial.model ?? getModel(),
        })
        finished = true
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          const abortedTiming = meter.snapshot()
          recordEvent('chat_abort', `chat aborted after ${Date.now() - startedAt}ms`, {
            ...buildMeta({
              flow: 'chat',
              stage: 'chat.settle',
              attempt: attemptNo,
              status: 'aborted',
              endpointKey: endpointKey(),
              durationMs: Date.now() - startedAt,
              ...(abortedTiming.ttfbMs === null ? {} : { ttfbMs: abortedTiming.ttfbMs }),
              ...(abortedTiming.firstTokenMs === null
                ? {}
                : { firstTokenMs: abortedTiming.firstTokenMs }),
              chunks: abortedTiming.chunks,
              chars: abortedTiming.chars,
            }),
            // 与兄弟事件 chat_first_token / chat_done 同口径（#315）：中断也要能按模型切片
            model: initial.model ?? getModel(),
          })
          break
        }
        // 上下文超长（#122）：和普通失败分开，界面换成能照着做的固定文案，上游原文只进日志
        const condition = classifyApiError(error)
        const notice =
          condition === 'contextLimit'
            ? { key: 'replyContextLimit' as const }
            : condition === 'insufficientBalance'
              ? // 额度不足（#299）：界面文案固定（不认上游英文原文），日志也能看出「用户看到了什么」
                { key: 'replyInsufficientBalance' as const }
              : error instanceof ApiError && error.status === 401
                ? // 401（#303 问题 3）：上游说 Key 无效，界面就说同一件事，并把自动探测一起停掉
                  { key: 'apiKeyRejected' as const }
                : error instanceof ApiError
                  ? error.localMessage
                  : undefined
        // 失败必录：请求阶段、HTTP 状态、耗时、错误原文一次记全
        const failedTiming = meter.snapshot()
        const apiFailure = error instanceof ApiError ? error : null
        // 上游状态码：有就写真实码（400 / 422 / 502 …），没有（请求没到达）才写 'error'。
        // 这样失败日志里 `status` 一眼能看出「到底是上游回了个码，还是根本没连上」（#324）
        const failedStatus =
          apiFailure && typeof apiFailure.status === 'number' ? apiFailure.status : 'error'
        // 是否发生在 SSE 流里（error 帧 / 断流 / 空闲超时）：排查「上游有没有开始流」的第一分界
        const failedInStream =
          apiFailure !== null &&
          (apiFailure.kind === 'stream' ||
            apiFailure.kind === 'interrupted' ||
            apiFailure.kind === 'idle')
        // idle 触发标记（#150）：超时阈值原样落盘，便于和 streamIdleTimeoutMs 对账
        const idleMs = /no data (?:received )?for (\d+)ms/.exec(apiFailure?.detail ?? '')?.[1]
        record('error', 'error', 'chat stream failed', {
          ...buildMeta({
            flow: 'chat',
            stage: preparing ? 'chat.upload' : 'chat.stream',
            attempt: attemptNo,
            status: failedStatus,
            endpointKey: endpointKey(),
            durationMs: Date.now() - startedAt,
            ...(failedTiming.prepMs === null ? {} : { prepMs: failedTiming.prepMs }),
            ...(failedTiming.ttfbMs === null ? {} : { ttfbMs: failedTiming.ttfbMs }),
            ...(failedTiming.firstTokenMs === null
              ? {}
              : { firstTokenMs: failedTiming.firstTokenMs }),
            chunks: failedTiming.chunks,
            // 上游短码（error.code / error.type）：官方端点所有 400 都是 invalid_request_error，
            // 只有它和 message 能区分「模型不存在 / 参数错 / 内容拦截」（#324）
            ...(apiFailure?.upstreamCode ? { upstreamCode: apiFailure.upstreamCode } : {}),
          }),
          // 上游是不是已经开始了流（SSE）：true = 断在流里，false = 流开始前就失败
          streaming: failedInStream,
          ...(idleMs ? { 'idle.ms': Number(idleMs) } : {}),
          // 用户在界面上会看到什么：条件分类 + i18n 文案 key（用来核实「到底有没有提示」）
          'ui.condition': condition,
          ...(notice
            ? { 'ui.notice': notice.key }
            : { 'ui.notice': error instanceof ApiError ? error.kind : 'unknown' }),
          // 额度不足单独打标（#299）：诊断层不新增枚举，用结构化字段统计，
          // 这样「余额不足次数」能被单独筛出来，不会混进网络/限流错误里。
          ...(condition === 'insufficientBalance'
            ? {
                'billing.quota': 'exhausted',
                ...(error instanceof ApiError && error.upstreamCode
                  ? { 'billing.quota.code': error.upstreamCode }
                  : {}),
              }
            : {}),
          // 断流等情况的原始报错原文：只进日志，界面上给固定文案
          ...(error instanceof ApiError && error.detail ? { 'error.detail': error.detail } : {}),
          ...errorMeta(error),
        })
        void captureStateSnapshot('after-chat-error')
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效是 400（补传后才可自愈）：先确认「本来就要再发一次」再补传，避免白清 serverId。
        // 收到过内容块（含丢弃的客户端工具）后不自动重发。
        const mayRetry = attempt < STREAM_RETRY_LIMIT && !receivedContent && !controller.signal.aborted
        const fileRecovered =
          mayRetry &&
          !isRetryableApiError(error) &&
          reuploadInvalidatedFiles(sessionId, request, error)
        const decision = decideStreamRetry({
          error,
          attempt,
          receivedContent,
          aborted: controller.signal.aborted,
          fileRecovered,
        })
        if (decision === 'retry') {
          // 让用户看见「正在第 N 次重试」，而不是静默卡住；秒数从点发送累计，不因重试归零（#328 G6）
          setWaitStage(sessionId, 'retrying', {
            attempt: attempt + 1,
            limit: STREAM_RETRY_LIMIT,
          })
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            // 上游 code 一并存下来：刷新 / 换设备后仍能认出「额度不足」（#299）
            ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
            // 客户端错误码（#434）：`upstream_returned_html` 这个结论只有请求层知道，
            // 不落盘的话重新渲染会退回「空响应」文案（改前那个 bug 的第二半）。
            ...(error.code ? { code: error.code } : {}),
            // 上游给的原文摘要（#434）：折叠区刷新后还要在，所以随消息落盘
            ...(error.detail ? { detail: error.detail } : {}),
            // Key 失效的细分（#374）：**当次**就判好，连同 Key 尾号一起存下来。
            // 只用当前配置的 Key 判格式（请求层才知道那把 Key），历史回看没有它就跳过本地判定。
            ...(condition === 'unauthorized'
              ? {
                  keyFailure: classifyKeyFailure({
                    status: error.status,
                    code: error.upstreamCode,
                    message: error.message,
                    apiKey: getApiKey() || undefined,
                  }),
                }
              : {}),
            localMessage: notice,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
    // 首轮回答正常结束后异步补标题（不阻塞 UI；没有原生标题的协议才走本地生成）
    if (finished) {
      scheduleAutoTitle(sessionId)
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    // 失效自愈的登记只在同一轮的重试间有效：收尾即清，别让下一轮拿旧附件重传（#379）
    recoveringFiles.clear()
    // 本轮无论怎么结束，等待提示都要撤下（含用户停止与各类报错）
    clearWaitHints(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
