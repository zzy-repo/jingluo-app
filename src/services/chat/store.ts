import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import {
  ApiError,
  getFirstTokenTimeout,
  getRequestTimeout,
  streamMessage,
} from '../api/client.js'
import {
  classifyApiError,
  extractFileIds,
  getFileErrorCode,
  isRetryableApiError,
} from '../api/errors.js'
import { classifyKeyFailure } from '../api/keyFailure.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
// #480 §7 / §9：文档正文的文本注入（渠道能力表 + ContextBuilder + 附件引用收集）。
// DeepSeek 官方 `textInjection === false`，这条链路一次都不进（见 streamReply 里的能力闸）。
import { buildWithDocuments, formatDocumentInjection, type ChatMessage } from '../attachments/contextBuilder.js'
import { acceptsDocuments, docInjectionFor, visionFor } from '../attachments/providerCapability.js'
// #551 / #552：图片的 base64 内联通路（编码产物缓存 + 编码入口）。
import {
  dropImagePart,
  ImageSourceError,
  imagePartBytes,
  imagePartOf,
  putImagePart,
  toImagePart,
  type ImagePart,
} from '../attachments/imageSource.js'
import {
  collectAttachmentsForRequest,
  stripAttachmentRefs,
} from '../attachments/requestDocs.js'
// #379：发送前的附件可用性审计 + 上传失败的点名文案（源缺失不重传、不阻断、不静默）
import { auditSendableAttachments } from '../attachments/sendAudit.js'
import type { UnavailableAttachment } from '../attachments/types.js'
import {
  AttachmentUploadError,
  attachmentUploadFailureOf,
  describeUploadFailure,
} from '../attachments/uploadFailure.js'
import {
  captureStateSnapshot,
  errorMeta,
  record,
  recordAction,
  recordError,
  recordEvent,
  reportStorageSaveFailure,
} from '../diagnostics/collector.js'
import { getApiKey, getBaseUrl, getCurrentSpec, getModel, getProviderKind } from '../api/apiConfig.js'
import { buildMeta, endpointKeyFromUrl } from '../diagnostics/fields.js'
import { REASON } from '../diagnostics/reasons.js'
import { createStreamMeter, streamTimingMeta } from '../diagnostics/timing.js'
import { requestGates, type ProviderKind } from '../api/providers.js'
import { LIMITS, mbOf } from '../limits.js'
import { useSettings } from '../settings.js'
import { generateSessionTitle } from './autoTitle.js'
import { estimateChars, estimateTokens } from './contextBudget.js'
import {
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
  type SessionDamageReporter,
} from './branches.js'
import * as db from './db.js'
// 失败分级从纯函数模块取（#938）：不从 `./db.js` 要 —— 那样每个把 `./db.js` 换成内存假库的
// L0 用例都得跟着补一个导出，而分类规则本身正是被测对象，不该被替身挡住。
// （纯 IndexedDB 基线上没有 `../storage/index.js` 那层后端抽象，写库一律走 `./db.js`。）
import { storageFailureOf } from './storageFailure.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { branchPointOf, planBranchSession, type BranchPoint } from './sessionBranch.js'
import {
  applyEvent,
  canContinueReply,
  foldReminders,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import { buildMessageBody, SYSTEM_PROMPT } from './requestBody.js'
import { pickErrorNotice, rowKey } from './errorNotice.js'
import { waitDeadlines } from './waitStage.js'
import { composeWaitNotice, needsUpload, type WaitHint, type WaitStage } from './waitStage.js'
import { removeSessionBackground } from './background.js'
import type { SessionBackground } from './sessionBackground.js'
import type { MergePlan, ImportMode } from './history/mergeSessions.js'
import type { ImportSkip } from './history/toLocal.js'
import { shouldRetryStreamTimeout, streamTimeoutStageOf } from './timeoutPolicy.js'
import {
  decideStreamBreakout,
  isStreamBreakoutKind,
} from './streamBreakout.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

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
  messages: ReturnType<typeof toRequestMessages>,
  system: string
): { system: string; messages: ReturnType<typeof toRequestMessages> } => {
  if (requestGates(getCurrentSpec()).latest_reminder) {
    return { system, messages }
  }
  const folded = foldReminders(messages)
  return {
    system: [system, ...folded.reminders].join('\n'),
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
  /**
   * 启动期读库失败的**具体档位**：`blocked`（另一个标签页攥着旧连接）/ `version`（库比代码新）。
   * 这两种都**不该**复用「加载失败请重试」——前者要用户去关别的页面，后者要用户更新应用，
   * 重试一万次都是同一个结果。`null` = 没有这一类失败。
   */
  initFailure: db.StorageInitFailure | null
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  /**
   * 会话没存到本机的原因（P0）。**值从布尔改成结构化分类**（`quota` / `clone` / `unavailable` / `unknown`），
   * 因为不同原因的文案与「要不要给重试按钮」完全不同；`boolean` 只为兼容旧值读取保留
   * （旧值 `true` 一律当可重试档，见 `db.normalizeStorageFailure`）。
   */
  sessionSaveErrors: Record<string, db.StorageFailure | boolean>
  /**
   * 附件降级（事务 B 失败）：**会话已经落盘**，坏的只是这些附件的 blob。
   * 与 `sessionSaveErrors` 分开存：混在一起会让「对话丢了」和「图看不清」用同一句话提示，
   * 而这两件事对用户的后果完全不同（前者丢内容，后者丢的是原件）。
   */
  degradedAttachments: Record<string, DegradedAttachments>
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

/** 附件降级：会话在、原件不在（只记 id / 字节数 / 分类，不存正文） */
export type DegradedAttachments = {
  failure: db.StorageFailure
  ids: string[]
  bytes: number
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  initFailure: null,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  degradedAttachments: {},
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
  {
    startedAt: number
    stage: WaitStage | null
    retry?: { attempt: number; limit: number }
    /**
     * 当前阶段自己的超时预算（#771）：连接段 = connectMs（60s），等首字 = 该渠道/思考态的首字预算。
     * 界面靠它算「判死档最早什么时候可以出现」，避免「提示已可停止、请求还在跑」。
     */
    stageBudgetMs?: number
  }
>()

/**
 * 当前阶段的超时预算（#771）。只有「在等上游」的三个阶段有预算：
 * 上传 / 准备 / 重试阶段没有上游请求在跑，停止本来就是安全的（返回 undefined）。
 */
const stageBudgetOf = (stage: WaitStage | null): number | undefined => {
  switch (stage) {
    case 'connecting':
      return getRequestTimeout()
    case 'awaitingFirstToken':
      return getFirstTokenTimeout()
    case 'thinking':
      return getFirstTokenTimeout(true)
    default:
      return undefined
  }
}

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
    stageBudgetMs: current.stageBudgetMs,
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
  armWaitTimers(sessionId, startedAt)
}

/**
 * 按当前阶段的预算重新挂升级定时器（#771）。
 *
 * 定时器清单来自 `waitStage.ts`（它又把 `streamNotice.ts` 的三档与 #771 的阶段预算合起来算），
 * 本文件只负责按会话挂 / 清，不在 store 里另写一套分档规则。
 *
 * 为什么阶段变化要重挂而不是只加一个：判死档的到点时刻取决于**该阶段自己的预算**
 * （连接段 60s、等首字才是 30s、思考档 45~120s），阶段一换这个时刻就变了。
 * 5s / 30s 两档仍是固定阈值，重挂只是把它们按同一个 startedAt 再算一遍（不重置计时）。
 */
const armWaitTimers = (sessionId: string, startedAt: number, stageBudgetMs?: number) => {
  for (const timer of waitHintTimers.get(sessionId) ?? []) {
    clearTimeout(timer)
  }
  waitHintTimers.set(
    sessionId,
    waitDeadlines(startedAt, stageBudgetMs).map((at) =>
      setTimeout(() => syncWaitHint(sessionId), Math.max(0, at - Date.now()))
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
  current.stageBudgetMs = stageBudgetOf(stage)
  armWaitTimers(sessionId, current.startedAt, current.stageBudgetMs)
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
/**
 * #959 B：会话的**内存版本号**与**已落盘版本号**，判据是「这次写进去的版本 == 当前内存版本」。
 *
 * 为什么必须是新增的单调序号（而不是现成的量）：
 *  · **`updatedAt` 不能用**：`updateSession()` 不集中 bump 时间戳，各调用点自己写，还有一批路径根本不写
 *    （所以它连「改过没有」都不可靠，更别说「谁更新」）；
 *  · **墙钟不能用**：系统时钟被改 / NTP 回拨会把「谁更新」判反，而判反的后果是**吃掉一次真实的新失败**
 *    —— 横幅消失、盘上没有用户刚才那次改动、界面还告诉他存好了；
 *  · 序号只在**本进程内**比较，不落盘、不进 IDB schema：冷启动后内存与盘都从盘重读、天然一致，
 *    跨进程没有可比的版本，也不需要有。
 */
let stateSeq = 0
const nextStateVersion = () => ++stateSeq
/** 内存里这条会话的版本；`updateSession()` 每产出新对象就取一个新号 */
const sessionVersion = new Map<string, number>()
/** 已经确认写进盘里的版本（`save()` 成功返回后才更新） */
const persistedVersion = new Map<string, number>()
/**
 * 每会话一条写链：保证「提交顺序 == 版本顺序」。
 *
 * 库还没打开时（`await getChatDB()` 之前）提交会被推迟 —— 快照对象同步抓取、**提交被推迟**；
 * 期间用户改出的新版本可能先落盘，旧快照后到就把新数据整行覆盖（`sessions.save` 是整行 REPLACE，
 * 而且**不报错**，用户以为存好了）。串行之后，旧快照轮到自己时要么被合并成最新内存、要么直接跳过。
 */
const writeChains = new Map<string, Promise<unknown>>()

/** 懒分配：第一次碰到这条会话就给它一个版本号，之后每次内存变更再加一个 */
const versionOf = (sessionId: string) => {
  const known = sessionVersion.get(sessionId)
  if (known !== undefined) {
    return known
  }
  const fresh = nextStateVersion()
  sessionVersion.set(sessionId, fresh)
  return fresh
}

const enqueueWrite = <T,>(sessionId: string, task: () => Promise<T>): Promise<T> => {
  const previous = writeChains.get(sessionId)
  /**
   * 队里没人时**立即发起**（不是排到微任务里）：存储已打开时，「同一 tick 就调到后端」是既有纪律 ——
   * pagehide / visibilitychange(hidden) 的 flush 靠它，页面正在关的那一下不能多等一个微任务。
   * 只有真的有一次写在飞时才排队，那时顺序才需要保证。
   */
  const next = previous === undefined ? task() : previous.then(task, task)
  // 前一次失败不能卡死后一次
  const tail = next.then(
    () => undefined,
    () => undefined
  )
  writeChains.set(sessionId, tail)
  void tail.then(() => {
    if (writeChains.get(sessionId) === tail) {
      writeChains.delete(sessionId)
    }
  })
  return next
}
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
/**
 * 不走 `persist()` 的元数据写入（置顶 / 改名）的重放队列，键 `会话 id|步骤`（#937）。
 * 失败一次就放进来，`retrySaveSessions()`（横幅「重试」）会再跑一次 —— 否则那个按钮对这条路是空点击。
 */
const pendingMetadataWrites = new Map<string, () => void>()
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
    // #959 B：内存里换了新对象 → 取一个新版本号。写链靠它判「这份快照是不是最新的」，
    // 清除判据靠它判「写进去的是不是当前内存」。
    sessionVersion.set(id, nextStateVersion())
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

const attachmentBytesOf = (files: db.StoredFile[] | undefined): number =>
  (files ?? []).reduce(
    (sum, file) => sum + (typeof file.blob?.size === 'number' ? file.blob.size : 0),
    0
  )

/** 还在排队等着写进去的原件 id：清理孤儿 blob 时必须避开它们（否则等于用腾空间制造新丢数据） */
const keepFileIds = (): string[] =>
  Array.from(pendingFiles.values()).flatMap((files) => files.map((file) => file.id))

/**
 * 同一个失败重复上报会刷爆日志（流式收尾会反复 persist）：
 * 只有「会话 + 分类 + 步骤」变了才再报一条，保存成功后清空。
 */
const reportedSaveFailures = new Set<string>()
const reportedDegradations = new Set<string>()
/** 「兜底剔除救回来了」只报一次：这个事实不会随保存成功而失效，同一个坏字段不该每次落盘都报 */
const reportedRecoveries = new Set<string>()

const failureAsError = (failure: db.StorageFailure): Error => {
  const error = new Error(failure.message ?? failure.kind)
  error.name = failure.name ?? 'StorageFailure'
  return error
}

const clearSaveFailure = (sessionId: string) =>
  set((state) => ({
    sessionSaveErrors: Object.fromEntries(
      Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
    ),
  }))

const clearDegraded = (sessionId: string) =>
  set((state) => ({
    degradedAttachments: Object.fromEntries(
      Object.entries(state.degradedAttachments).filter(([id]) => id !== sessionId)
    ),
  }))

/**
 * 会话没存到本机：**内存状态 + 诊断包一起记**（P0 治「下次还查不出来」）。
 *
 * 改造前只有 `sessionSaveErrors[id] = true`，而且只活在内存里 —— 进程一结束，
 * 数据丢了、连「丢过」这件事都没了。现在：
 *  · store 里留结构化分类（`kind`），横幅据此分档；
 *  · `reportStorageSaveFailure()` 写一条 error 级日志（kind / error.name / store / 消息条数 / 附件字节数）。
 */
const markSaveFailure = (
  sessionId: string,
  failure: db.StorageFailure,
  step: string,
  stats: { messages: number; attachmentBytes: number; strippedFields?: readonly string[] }
) => {
  const key = `${sessionId}|${failure.kind}|${step}`
  if (!reportedSaveFailures.has(key)) {
    reportedSaveFailures.add(key)
    reportStorageSaveFailure(
      {
        kind: failure.kind,
        stores: failure.stores ?? 'sessions,sessionSummaries',
        messages: stats.messages,
        attachmentBytes: stats.attachmentBytes,
        strippedFields: stats.strippedFields,
        step,
      },
      failureAsError(failure)
    )
  }
  set((state) => ({
    sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: failure },
  }))
}

/**
 * 附件降级（会话已落盘、blob 没写进去）：单独一条状态 + 单独一条诊断。
 *
 * 「只降级该附件」的落点就在这里 —— 会话记录已经在事务 A 提交了，这里连回滚的念头都不该有。
 * 原件引用留在 `pendingFiles` 里，用户点「重试」时会再写一次。
 */
const markDegradedAttachments = (
  sessionId: string,
  degraded: db.FileDegradation[],
  messages: number
) => {
  const bytes = degraded.reduce((sum, item) => sum + item.bytes, 0)
  const failure = degraded[0]?.failure ?? { kind: 'unknown' as const }
  const key = `${sessionId}|${failure.kind}|${degraded.map((item) => item.id).join(',')}|${bytes}`
  if (!reportedDegradations.has(key)) {
    reportedDegradations.add(key)
    reportStorageSaveFailure(
      {
        kind: failure.kind,
        stores: failure.stores ?? 'files',
        messages,
        attachmentBytes: bytes,
        step: 'save attachments',
      },
      failureAsError(failure)
    )
  }
  set((state) => ({
    degradedAttachments: {
      ...state.degradedAttachments,
      [sessionId]: { failure, ids: degraded.map((item) => item.id), bytes },
    },
  }))
}

/**
 * 读库失败的档位：只读错误对象上的 `initFailure` 标记 / 类名，**不 import 错误类** ——
 * 测试替身（`tests/fixtures/**` 的假 db）不必为实现两个错误类埋单，而真实现的
 * `StorageBlockedError` / `StorageVersionTooNewError` 自带 `initFailure`（见 `db.ts`）。
 */
const initFailureOf = (error: unknown): db.StorageInitFailure | null => {
  const bag = (typeof error === 'object' && error !== null ? error : {}) as {
    initFailure?: unknown
    name?: unknown
  }
  if (bag.initFailure === 'blocked' || bag.initFailure === 'version') {
    return bag.initFailure
  }
  if (bag.name === 'StorageBlockedError') {
    return 'blocked'
  }
  if (bag.name === 'StorageVersionTooNewError') {
    return 'version'
  }
  return null
}

/** `saveSession()` 的兜底形状：替身 / 老实现可能什么都不返回 */
const EMPTY_OUTCOME: db.SaveSessionOutcome = { failure: null, degradedFiles: [], strippedFields: [] }

/**
 * 落盘过程本身抛出（不是 `outcome.failure`）时的分类。
 *
 * #938：这里**不能**写死 `kind: 'unknown'`。满盘时最常走的恰好是这条抛出路径 ——
 * 库都打不开（`indexedDB.open` 抛 `DOMException: Encountered full disk while opening backing store`），
 * 写死成 unknown 就是「可重试」档，横幅让用户点一个必然再失败的「Retry」。
 * 交给 `storageFailureOf()` 走与 `outcome.failure` 同一条分类规则（含满盘文案兜底）。
 */
const failureOfThrown = (error: unknown, stores: string): db.StorageFailure =>
  storageFailureOf(error, stores)

const persist = (sessionId: string) => {
  const cached = getSession(sessionId)
  unsavedSessions.add(sessionId)
  if (deletingSessions.has(sessionId)) {
    return undefined
  }
  const epoch = historyEpoch
  const files = pendingFiles.get(sessionId)

  /** 落盘之后的状态收敛：缓存路径与「从库里读回来再写」路径共用这一份 */
  const settled = (
    session: Session,
    fromCache: boolean,
    outcome: db.SaveSessionOutcome,
    version: number
  ) => {
    if (epoch !== historyEpoch) {
      return undefined
    }
    // 事务 A 失败：会话**没**落盘。这才是「这段对话没存到本机」那一档，附件降级不走这里。
    if (outcome.failure) {
      markSaveFailure(sessionId, outcome.failure, 'save session', {
        messages: session.messages.length,
        attachmentBytes: attachmentBytesOf(files),
        strippedFields: outcome.strippedFields,
      })
      return false
    }
    if (outcome.strippedFields.length > 0) {
      // 兜底救回来了：会话落了盘，但「这次剔掉了哪些字段」必须留痕（不是用户的错，也不该无声）。
      // 同一个会话的同一次剔除只报一次：一个坏字段会被后续每次落盘都命中，全报就是刷屏。
      const recoveryKey = `${sessionId}|clone|${outcome.strippedFields.join(',')}`
      if (!reportedRecoveries.has(recoveryKey)) {
        reportedRecoveries.add(recoveryKey)
        recordError(
          'storage.saveFailure: recovered by stripping fields',
          {
            'storage.kind': 'clone',
            'storage.stores': 'sessions,sessionSummaries',
            'storage.messages': session.messages.length,
            'storage.attachmentBytes': attachmentBytesOf(files),
            'storage.stripped': outcome.strippedFields.join(','),
          },
          failureAsError({ kind: 'clone', name: 'DataCloneError' })
        )
      }
    }
    if (outcome.degradedFiles.length === 0) {
      if (pendingFiles.get(sessionId) === files) {
        pendingFiles.delete(sessionId)
      }
      clearDegraded(sessionId)
    } else {
      markDegradedAttachments(sessionId, outcome.degradedFiles, session.messages.length)
    }
    // #959 B：这段内容确实进了盘（只升不降）
    if (version > (persistedVersion.get(sessionId) ?? 0)) {
      persistedVersion.set(sessionId, version)
    }
    /**
     * 清除判据（#959 B）：**这次写进去的版本 == 当前内存版本**才清 —— 也就是「盘上确实等于内存」。
     * 只靠「这次写成功了」不够：写入期间内存可能又变了（用户接着改 / 流式收尾），
     * 那时盘落后于内存，之前那条「没存到本机」仍然是实话，横幅与重试入口都必须留着。
     */
    if (version === versionOf(sessionId)) {
      unsavedSessions.delete(sessionId)
      clearSaveFailure(sessionId)
      if (fromCache) {
        reportedSaveFailures.clear()
        trimSessionCache()
      }
    } else {
      unsavedSessions.add(sessionId)
    }
    // 附件降级时**留在待保存集合里**：点「重试」会再写一次这批 blob
    if (outcome.degradedFiles.length > 0) {
      unsavedSessions.add(sessionId)
    }
    return true
  }

  const save = (session: Session, fromCache: boolean) => {
    // 这份 `session` 对象取自内存那一刻的版本号
    const snapshotVersion = versionOf(sessionId)
    /**
     * 排进这条会话自己的写链（#959 B）：**提交顺序 == 版本顺序**。
     * 光有版本号挡不住「旧快照后到把新数据整行覆盖」—— 库还没打开时提交会被推迟，
     * 而写会话是整行 REPLACE、覆盖了也不报错。串行之后旧快照轮到自己时只有两种结局：
     * 被升级成最新内存（绝不落旧数据），或者直接跳过。
     */
    return enqueueWrite(sessionId, async (): Promise<boolean> => {
      // ① 盘上已经是这一版或更新（更晚的那次写入先落盘了）→ **跳过写入**，绝不覆盖新数据
      if (snapshotVersion <= (persistedVersion.get(sessionId) ?? 0)) {
        // 内存里若还有更新的内容没落盘，就如实返回「未落盘」（调用方据此决定是否留着草稿/横幅）
        return versionOf(sessionId) <= (persistedVersion.get(sessionId) ?? 0)
      }
      // ② 排到时内存已经是更新的一版 → 这次写升级成**最新内存**，不把旧快照写到盘上
      const latest = snapshotVersion < versionOf(sessionId) ? getSession(sessionId) : undefined
      const payload = latest ?? session
      const writtenVersion = latest ? versionOf(sessionId) : snapshotVersion
      // 同步发起落盘（与改造前一致：调用方在同一 tick 里就能看到写请求），同步抛出也转成 rejection
      const invoked = (() => {
        try {
          return db.saveSession(payload, files, { keepFileIds: keepFileIds() })
        } catch (error) {
          return Promise.reject(error)
        }
      })()
      try {
        const raw = await invoked
        return settled(payload, fromCache, raw ?? EMPTY_OUTCOME, writtenVersion) === true
      } catch (error) {
        db.reportStorageError('save session')(error)
        const failure = failureOfThrown(error, 'sessions,sessionSummaries')
        if (epoch === historyEpoch && (!fromCache || getSession(sessionId) !== undefined)) {
          markSaveFailure(sessionId, failure, 'save session', {
            messages: payload.messages.length,
            attachmentBytes: attachmentBytesOf(files),
          })
        }
        return false
      }
    })
  }

  if (cached !== undefined) {
    return save(cached, true)
  }
  /**
   * **缓存未命中不再静默 return**（改造前的 bug：`sessionCache` 里没有这条会话时直接返回，
   * 既不写库也不报错 —— 内存里看着一切正常，其实什么都没落盘）。现在改成从库里读回来再写；
   * 读不回来才标失败 —— 「读不回来」与「本来就没事」必须能分开。
   */
  return Promise.resolve(db.loadSession(sessionId))
    .catch((error: unknown) => {
      db.reportStorageError('read session for persist')(error)
      return undefined
    })
    .then((session) => {
      if (epoch !== historyEpoch) {
        return undefined
      }
      if (session === undefined) {
        markSaveFailure(
          sessionId,
          {
            kind: 'unknown',
            name: 'SessionMissingFromCache',
            message: 'session body is neither in memory nor readable from IndexedDB',
            stores: 'sessions',
            at: Date.now(),
          },
          'persist read-back',
          { messages: 0, attachmentBytes: attachmentBytesOf(files) }
        )
        return false
      }
      return save(session, false)
    })
}

export const saveSessionPrompt = async (id: string, draft: string) => {
  const session = getSession(id)
  if (!session || deletingSessions.has(id) || get().importingHistory) {
    return false
  }
  const prompt = draft || undefined
  updateSession(id, current => ({ ...current, customSystemPrompt: prompt }))
  /**
   * #959：落盘失败时**不回滚**内存。
   *
   * 回滚会把用户刚打的字从内存里抹掉，而 `persist()` 已经把这条会话留在 `unsavedSessions` 里；
   * 于是内存 = 旧值、盘 = 旧值、「待落盘」集合里却还挂着它 —— 用户点横幅「重试」，
   * `retrySaveSessions()` 跑 `persist(id)`，写的是**内存里的旧值**，「重试成功」、横幅消失，
   * 而新提示词从来没有落过盘。提示词只有内存与盘两份副本，回滚 = 两份都成旧值。
   *
   * 与正文同一套纪律：留在内存 + 留在 `unsavedSessions` + 横幅提示，重试（或下一次落盘）
   * 自然会把它写上去。返回值语义因此是「**未落盘**」，不再保证「内存未变」。
   */
  return (await persist(id)) === true
}

/**
 * 保存会话级聊天背景（本单）：`undefined` = **清掉覆盖、回到全局默认**（「恢复默认」走这条）。
 *
 * 与 `saveSessionPrompt` 同一套纪律（先改内存里的会话、再落盘、**失败不回滚**，#959），
 * 区别只在于字段是「三种来源 + 淡化 + 模糊」的复合值。图片本体不在这里写 ——
 * 它按 `chat-background:session:<id>` 存在 `appAssets`，由 `applySessionBackground` 负责，
 * 本函数只管这层 JSON 字段，于是「删图」与「清覆盖」是两个独立动作，谁也不会把对方弄坏。
 */
export const saveSessionBackground = async (
  id: string,
  background: SessionBackground | undefined
): Promise<boolean> => {
  const session = getSession(id)
  if (!session || deletingSessions.has(id) || get().importingHistory) {
    return false
  }
  updateSession(id, current => ({ ...current, background }))
  // #959：同一缺陷的第二处（见 `saveSessionPrompt`）：失败即丢弃用户的选择，同样是数据丢失
  return (await persist(id)) === true
}

export const retrySaveSessions = () => {
  if (get().importingHistory) {
    return
  }
  unsavedSessions.forEach(persist)
  // #937：置顶 / 改名不经过 `persist()`（它们没有「正文待落盘」这回事），所以横幅的「重试」
  // 必须单独把它们重放一遍，否则那个按钮对这条路是个空点击
  for (const replay of [...pendingMetadataWrites.values()]) {
    replay()
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
  set({ initError: false, initFailure: null })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true, initFailure: initFailureOf(error) })
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
    // 取值来自 reasons.ts 的字典（#301 维度 3），不是就地写的裸字符串
    reason: REASON.corruptStorage,
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
      // #959：这一步是「真的从盘里读回来了」——内存与盘重新一致，之前那条「没存到本机」不再成立。
      // （缓存命中时根本不会走到这里，所以它不会变成「打开会话就清」）
      /**
       * #959 B：读回后的版本。**注意两个量的语义不同，不能「对齐成同一个号」当成一件事办**：
       *  · `persistedVersion` = **盘上**已经写到第几版 —— 这里盘上确实就是刚读回来的那一版；
       *  · `sessionVersion`   = **内存里**现在是第几版 —— 只有内存内容与盘一致时才等于前者。
       * 下面 `if (session !== stored)` 分支里，归一化/修复让**内存前进了、盘上没有**，
       * 那时必须只抬 `sessionVersion`，绝不能顺手把 `persistedVersion` 也抬上去 ——
       * 那等于对系统撒谎说「盘上已是最新」，紧接着的修复回写会被写链的「盘上已最新 → 跳过」吞掉，
       * 盘上永远留着损坏数据（每次打开都「修一次内存」，却永远修不好盘，还没有任何报错）。
       */
      const diskVersion = nextStateVersion()
      persistedVersion.set(id, diskVersion)
      if (session === stored) {
        sessionVersion.set(id, diskVersion)
      }
      clearSaveFailure(id)
      if (session !== stored) {
        /** 修复过的内容是一个**新版本**，必须落盘：只抬内存版本，盘上版本保持不动 */
        sessionVersion.set(id, nextStateVersion())
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
        initFailure: null,
        sessions: sortSessions(summaries),
        sessionCache: {},
        sessionLoadErrors: {},
        sessionSaveErrors: {},
        degradedAttachments: {},
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
        initFailure: null,
        sessions: sortSessions(summaries),
        sessionCache: {},
        sessionLoadErrors: {},
        sessionSaveErrors: {},
        degradedAttachments: {},
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

/**
 * #831 会话级分支的请求：`messageId` 缺省 = 完整分支（整条会话复制），给了 = 从该消息处节点分支。
 * 两种都只读父会话（`sessionBranch.ts` 的 `planBranchSession()` 复制可见消息），父会话不动。
 */
export type SessionBranchRequest = { sessionId: string; messageId?: string }

/**
 * 预览分叉点（#831 第 2 条）：确认弹层创建前要显示「将从第 N 条消息处分支，之后的 M 条不会带入」。
 *
 * 会话可能还没进缓存（用户在会话列表里直接点「从此会话分支」），所以先确保详情加载完成；
 * 分叉点算不出来（消息已被删 / 数据损坏）返回 null，调用方据此**放弃这次分支**，不猜位置。
 */
export const previewSessionBranch = async (
  request: SessionBranchRequest
): Promise<BranchPoint | null> => {
  if (get().importingHistory) {
    return null
  }
  await ensureSessionLoaded(request.sessionId)
  const session = getSession(request.sessionId)
  if (session === undefined) {
    return null
  }
  return branchPointOf(session, request.messageId)
}

/**
 * 造一条分支会话（#831）：**复制**父会话当前可见的消息（节点分支只带分叉点及之前），
 * 落库成功后才切到新会话 —— 写入失败时不留一条「界面上有、库里没有」的幽灵会话。
 *
 * 三条边界（用例 ①③④⑤ 逐条断言）：
 *  1. `title` 由调用方给（默认 `<原标题>（分支）`，用户在确认弹层里可当场改）；
 *  2. **不传 `files`**：图片原件与文档附件记录一条都不复制，两侧引用同一批 id（按引用共享）；
 *  3. 父会话的标题 / 消息 / `updatedAt` 与它的落库记录一律不动（复制不是移动）。
 */
export const createSessionBranch = async (
  request: SessionBranchRequest & { title: string }
): Promise<string | null> => {
  if (get().importingHistory || deletingSessions.has(request.sessionId)) {
    return null
  }
  await ensureSessionLoaded(request.sessionId)
  const source = getSession(request.sessionId)
  if (source === undefined) {
    return null
  }
  const now = Date.now()
  const plan = planBranchSession({
    source,
    messageId: request.messageId,
    id: createId(),
    title: request.title,
    createdAt: now,
  })
  if (plan === null) {
    return null
  }
  try {
    await db.saveSession(plan.session)
  } catch (error) {
    db.reportStorageError('branch session')(error)
    return null
  }
  touchSession(plan.session.id)
  set((state) => ({
    sessions: sortSessions([toSessionSummary(plan.session), ...state.sessions]),
    sessionCache: { ...state.sessionCache, [plan.session.id]: plan.session },
    activeId: plan.session.id,
  }))
  trimSessionCache()
  return plan.session.id
}

/**
 * 未进 `sessionCache` 的会话，置顶 / 改名走的是「改一行列表元数据 + 写库」的老路径，
 * **不经过 `persist()`** —— 于是既不 `markSaveFailure()`（不进 `sessionSaveErrors`，横幅不出现），
 * 也不跑 `protectionCheckFreeSpace()`。满盘时实测：界面把会话挪进「Pinned chats」、库里什么都没变、
 * 用户零提示（#937 的现场：`[storage] pin session failed [object DOMException]` 只进了 console）。
 *
 * 这里把这条路径收进与 `persist()` **同一套**失败上报，不引入新状态机：
 *  · 失败 → `reportStorageError()`（现场日志，保持原样）+ `markSaveFailure()`（横幅 + 诊断包）；
 *  · 失败 → 把乐观更新**回滚**。未缓存会话没有别的待存内容，留一个库里不存在的新值，
 *    「重启后状态与界面一致」这条验收就通不过（已缓存会话走 `persist()`，那条语义不变）；
 *  · 失败 → 这次写入进 `pendingMetadataWrites`，腾出空间后点横幅「重试」真的会再写一次。
 */
const writeSessionMetadata = (options: {
  id: string
  step: 'pin session' | 'rename session'
  write: () => Promise<unknown>
  /** 失败回滚：只回滚「界面上还是本次写的那个值」的情况，别人后来写的值不许被抹掉 */
  revert: () => void
  /** 重放：把同一次写入按原参数再走一遍（含新的乐观更新） */
  retry: () => void
}): void => {
  const { id, step } = options
  const invoked = (() => {
    try {
      return options.write()
    } catch (error) {
      // 同步抛出（连接已关闭 / 库打不开）也要走失败上报，不许越出这条链
      return Promise.reject(error)
    }
  })()
  void Promise.resolve(invoked).then(
    () => {
      pendingMetadataWrites.delete(`${id}|${step}`)
      // 只清这一次的失败态：会话若还有没落盘的正文（`unsavedSessions`），那条失败仍然成立
      if (!unsavedSessions.has(id)) {
        clearSaveFailure(id)
      }
    },
    (error: unknown) => {
      db.reportStorageError(step)(error)
      options.revert()
      const failure = failureOfThrown(error, 'sessions,sessionSummaries')
      markSaveFailure(id, failure, step, {
        messages: getSession(id)?.messages.length ?? 0,
        attachmentBytes: 0,
      })
      pendingMetadataWrites.set(`${id}|${step}`, options.retry)
    }
  )
}

/** 置顶的乐观更新 + 落库；`previous` 只用于失败回滚 */
const playPin = (id: string, pinnedAt: number | undefined, previous: number | undefined): void => {
  set((state) => ({
    sessions: sortSessions(
      state.sessions.map((item) => (item.id === id ? { ...item, pinnedAt } : item))
    ),
  }))
  writeSessionMetadata({
    id,
    step: 'pin session',
    write: () => db.pinSession(id, pinnedAt),
    revert: () =>
      set((state) => ({
        sessions: sortSessions(
          state.sessions.map((item) =>
            item.id === id && item.pinnedAt === pinnedAt ? { ...item, pinnedAt: previous } : item
          )
        ),
      })),
    retry: () => playPin(id, pinnedAt, previous),
  })
}

export const pinSession = (id: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const session = get().sessions.find((item) => item.id === id)
  if (!session) {
    return
  }
  playPin(id, session.pinnedAt === undefined ? Date.now() : undefined, session.pinnedAt)
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
    return
  }
  playRename(id, title, get().sessions.find((item) => item.id === id)?.title ?? '')
}

/** 改名的乐观更新 + 落库（未缓存会话）；`previous` 只用于失败回滚 */
const playRename = (id: string, title: string, previous: string): void => {
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, title } : session
    ),
  }))
  writeSessionMetadata({
    id,
    step: 'rename session',
    write: () => db.renameSession(id, title),
    revert: () =>
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id && session.title === title ? { ...session, title: previous } : session
        ),
      })),
    retry: () => playRename(id, title, previous),
  })
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
    // 本单：会话没了，它自己的背景图也不该留在 IndexedDB 里（`appAssets` 按 sessionId 存 key，
    // 不清就是一条永远读不到、也永远算在占用里的孤儿 blob）。删库失败不影响删会话本身。
    await removeSessionBackground(id).catch(db.reportStorageError('delete session background'))
    if (epoch !== historyEpoch) {
      return true
    }
    autoTitleDone.delete(id)
    autoTitleTasks.delete(id)
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    // #959 B：会话没了，版本号也一并丢掉（留着只会让同 id 的重建撞上旧版本）
    sessionVersion.delete(id)
    persistedVersion.delete(id)
    // 会话已经删了：它的置顶 / 改名重放也要撤掉，否则「重试」会往一个不存在的会话上再写一次
    pendingMetadataWrites.delete(`${id}|pin session`)
    pendingMetadataWrites.delete(`${id}|rename session`)
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
      degradedAttachments: Object.fromEntries(
        Object.entries(state.degradedAttachments).filter(([key]) => key !== id)
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
  // `documents`：文档附件引用（#480 / #527）。它们没有 blob、也没有 serverId ——
  // 原件与解析全文在 AttachmentManager 里，消息只存 id。
  const { text, files, documents } = prepared
  /**
   * #538 第二道防线（**服务层，绕过 UI 也挡得住**）：当前渠道收不了文档时，绝不构造一条
   * 「只有附件引用、content 为空」的用户消息往上发。
   *
   * 为什么会漏到这里：UI 的入口门（`ChatInput.canAttachDocs`）只在**添加附件**那一刻生效，
   * 而草稿里的文档引用可以来自**另一个渠道** —— 用户在 OpenAI 渠道挂好文档后切到 DeepSeek，
   * 卡片与引用都还在；或者有人从控制台直接调 `sendMessage()`。DeepSeek 既不注入正文
   * （`textInjection: false`），也没有可用的原生上传（#360），那样发出去就是一条空消息。
   *
   * 判据与 UI 同源（`acceptsDocuments()`），所以两边永远不会说不一致的话。
   * 返回 `false`（发送未发生：不清草稿、不新增消息），并留一条 error 日志便于取证。
   */
  if (documents.length > 0 && !acceptsDocuments(getCurrentSpec().kind)) {
    recordError('文档附件不被当前渠道支持，本条消息未发送（#538）', {
      ...buildMeta({
        flow: 'chat',
        stage: 'chat.send',
        status: 'error',
        attempt: 1,
        endpointKey: endpointKeyFromUrl(getBaseUrl()),
      }),
      documents: documents.length,
    })
    return false
  }
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
      customSystemPrompt: getDraft(null).customSystemPrompt,
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
    files: [
      ...files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
        id,
        serverId,
        name,
        size,
        isImage,
        mimeType,
      })),
      // 文档附件带 `att-` 前缀的 id，`isImage: false`、`serverId: null`：
      // 请求侧按「非图片 files[].id」收引用（attachments/requestDocs.ts），
      // 孤儿清扫也按它认引用（attachments/manager.ts 的 collectReferencedAttachmentIds）。
      ...documents,
    ],
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  // 只登记真正有原件的上传件；文档附件的原件归 manager，不进 files 表
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
const ensureServerId = async (
  apiKey: string,
  file: FileAttachment,
  /**
   * 内存里的原件（本轮刚发出的附件）：`persist` 是异步的，`db.loadFile()` 可能还读不到。
   * 少了这一手，刚发出的图在某些时序下会拿不到 `serverId` → `toFileBlocks()` 直接不产块 →
   * **静默丢图**（#548 明令禁止）。
   */
  direct?: Blob
): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = direct ?? (await db.loadFile(file.id))
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
 * 图片编码失败 / 原件缺失这类「本地就能判死」的错误，转成带可读文案的 ApiError，
 * 这样 streamReply 的失败分支会把它当 `localMessage` 显示给用户（而不是泛化的「生成失败」）。
 * 文案取自 `imageSource` 抛出的 `localMessage`，与选图阶段的提示是同一份 key。
 */
const imageFailure = (error: unknown): unknown =>
  error instanceof ImageSourceError
    ? new ApiError('protocol', error.localMessage)
    : error

/**
 * base64 渠道的图片准备（#551）：把本轮 + 历史里的图片在本地编码成内联块。
 *
 * 三条口径：
 * 1. **不发任何上传请求**（这些渠道没有 `paths.files`，#360 的 404 就是这么来的）；
 * 2. 本轮提问的图片**要么成功、要么明确报错**：原件缺失 / 格式不支持 / 编码失败 / 超限
 *    都会中止发送并给出可读原因 —— 绝不静默丢图（母单 #548 的硬约束）；
 * 3. 历史图片有原件就编（导入会话的图片因此也能发，顺带修好 `serverId` 恒 null 的老问题），
 *    编不出来只记日志、不阻断发送（与 #379「历史附件不阻断发送」同一口径）。
 *
 * 选图阶段（`drafts.prepareInline`）已经把本轮的图编好了，这里的 `imagePartOf()` 直接命中；
 * 没命中才补编一次（导入的历史 / 换渠道前选的老图）。编码结果按「附件 id + 参数」缓存，
 * 同一张图每次得到的字节相同（#345 前缀稳定的前提）。
 */
const prepareInlineImages = async (
  sessionId: string,
  request: Request,
  signal: AbortSignal,
  /** 本轮已判定「本机没有原件」的附件 id（#379）：它们交给消息里的提示，不在这里当编码失败 */
  unavailableIds: ReadonlySet<string>
): Promise<void> => {
  /**
   * 取原件：刚发出的消息可能还没落盘（`persist` 是异步的），先看内存里的 pendingFiles，
   * 再回落到 IndexedDB —— 只查 db 会有「图片还没写完就读」的空窗。
   */
  const blobOf = async (id: string): Promise<Blob | undefined> => {
    const pending = pendingFiles.get(sessionId)?.find((item) => item.id === id)?.blob
    return pending ?? (await db.loadFile(id))
  }
  const encode = async (file: FileAttachment): Promise<ImagePart> => {
    const cached = imagePartOf(file.id)
    if (cached) {
      return cached
    }
    const blob = await blobOf(file.id)
    if (!blob) {
      throw new ImageSourceError({ key: 'imageSourceMissing' }, false)
    }
    return toImagePart(blob)
  }

  const questionImages = request.question.files.filter(
    (file) => file.isImage && !unavailableIds.has(file.id)
  )
  if (questionImages.length > LIMITS.images.maxCount) {
    throw new ApiError('protocol', {
      key: 'imageTooMany',
      params: { count: LIMITS.images.maxCount },
    })
  }
  let total = 0
  for (const file of questionImages) {
    signal.throwIfAborted()
    let part: ImagePart
    try {
      part = await encode(file)
    } catch (error) {
      throw imageFailure(error)
    }
    putImagePart(file.id, part)
    total += imagePartBytes(part)
  }
  if (total > LIMITS.images.maxTotalBytes) {
    throw new ApiError('protocol', {
      key: 'imageTotalTooLarge',
      params: { size: mbOf(LIMITS.images.maxTotalBytes) },
    })
  }

  let skipped = 0
  for (const [user] of getContextRounds(request.history)) {
    for (const file of user.files) {
      // 源缺失的历史图片（#379）不再算「编码失败」：它们已经在发送前的审计里进了消息提示
      if (!file.isImage || imagePartOf(file.id) || unavailableIds.has(file.id)) {
        continue
      }
      signal.throwIfAborted()
      try {
        putImagePart(file.id, await encode(file))
      } catch {
        // 历史图片编不出来（原件损坏 / 超限）：跳过它这一张，不阻断本次发送
        skipped++
      }
    }
  }
  if (skipped > 0) {
    record('chat_send', 'warn', 'history images not inlined', {
      count: skipped,
      reason: 'history',
      status: 'error',
    })
  }
}

/**
 * #379：把「本机不可用的附件」记到这条 user 消息上。
 *
 * 为什么落消息而不是 toast：这是**这条消息的事实**（哪几个附件没跟着发出去），用户回看时必须还在；
 * toast 一闪而过，用户既看不到是哪个附件，也没法在事后确认「我当时发的到底是文字还是带图」。
 *
 * 只在「有变化」时写库：
 * - 有不可用附件 → 覆盖成最新清单（重发同一个附件时名字/顺序以本轮为准）；
 * - 一个都不可用、消息上却挂着旧清单（用户后来补回了原件）→ 删掉字段，别留假话。
 */
const markUnavailableAttachments = (
  sessionId: string,
  messageId: string,
  unavailable: UnavailableAttachment[],
  sendable: FileAttachment[]
) => {
  const session = getSession(sessionId)
  const message = session?.messages.find((item) => item.id === messageId)
  if (message === undefined || message.role !== 'user') {
    return
  }
  const current = message.unavailable ?? []
  if (!current.length && !unavailable.length) {
    return
  }
  const available = new Map<string, string>()
  if (unavailable.length) {
    for (const file of sendable) {
      available.set(file.id, file.name)
    }
  }
  const previous = message.availableAtSend
  const unchanged =
    previous !== undefined && previous.length === available.size &&
    previous.every((file) => available.get(file.id) === file.name) &&
    current.length === unavailable.length &&
    current.every((item, index) => item.id === unavailable[index]?.id && item.name === unavailable[index]?.name)
  if (unchanged) {
    return
  }
  updateSession(sessionId, (value) => ({
    ...value,
    messages: value.messages.map((item) => {
      if (item.id !== messageId || item.role !== 'user') {
        return item
      }
      if (unavailable.length === 0) {
        const cleared: UserMessage = { ...item }
        delete cleared.availableAtSend
        delete cleared.unavailable
        return cleared
      }
      return {
        ...item,
        unavailable: unavailable.map((entry) => ({ ...entry })),
        availableAtSend: Array.from(available, ([id, name]) => ({ id, name })),
      }
    }),
  }))
  persist(sessionId)
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
  /**
   * 本渠道的图片通路（#551，`providerCapability.visionFor()` 唯一判定，#562 的单一能力表）。
   * `base64 = false` 时下面每一条都以**原样**执行 —— 这就是 deepseek 路径零改动的意思。
   */
  const vision = visionFor(getCurrentSpec().kind)
  /**
   * 本渠道的文档通路（#978，与上面同出一张能力表 `providerCapability.docInjectionFor()`）。
   *
   * `nativeFile = false` 的意思是「**本仓库对该渠道没有可用的原生文档上传实现**」——四个已登记
   * 渠道（deepseek / anthropic / openai / ours）与未知渠道在表里全是 `false`，所以「上传文档」
   * 这条通路在任何渠道都不该被走到：文档要么走文本注入（`textInjection`），要么在
   * `sendMessage` 的 `acceptsDocuments()` 闸就被拒。
   *
   * 判据只从能力表读（#978 的硬要求）：这里绝不写第二套「按类型 / 按渠道名」的判断，
   * 否则就是把同一个错误换个地方犯 —— 根因正是有人只读了 `image.nativeFile`，没读这一条。
   */
  const documents = docInjectionFor(getCurrentSpec().kind)
  /**
   * #379：**发送前的附件可用性审计**（唯一判定处，见 `attachments/sendAudit.ts`）。
   *
   * 只看一件事：这一轮请求会引用到的附件里，哪些在本机没有原件。导入会话的附件只有元信息
   * （ZIP 只带图片原件），所以「源缺失」是**预期状态**而不是异常：它既没有东西可重传，
   * 也不该把这条消息拖下水。审计结果有三处用途 ——
   *   · 本轮提问里源缺失的附件：跳过（不补传、不内联），消息按剩下的内容照常发出；
   *   · 历史轮次里源缺失的附件：本来就不进请求，这里只是把「为什么没发」收集起来；
   *   · 汇总成 `UnavailableAttachment[]` 落到 user 消息上 → 界面在消息里点名提示
   *     （不是 toast：用户回头看这条消息时原因还在）。
   *
   * 官方渠道的请求体**不受影响**：被跳过的附件本来就没有 `serverId`、也不会拼出 `file_id` 块，
   * 去掉它们与「它们不存在」逐字节相同（#480 立的规矩）。
   */
  const freshIds = new Set((pendingFiles.get(sessionId) ?? []).map((item) => item.id))
  /**
   * 这一轮会引用到的全部附件 = 本轮提问 + 历史轮次。
   * 刻意写成 `for…of` + `push`（不用 `flatMap`）：老内核基线下 `Array.prototype.flatMap` 是
   * `docs/capabilities/api.md` 里单独记账的一条，为一行便利再添一处命中不值当。
   */
  const referencedFiles: FileAttachment[] = [...request.question.files]
  for (const [user] of getContextRounds(request.history)) {
    for (const file of user.files) {
      referencedFiles.push(file)
    }
  }
  const audit = await auditSendableAttachments(referencedFiles, {
    isOwnUpload: (id) => freshIds.has(id),
    hasSource: async (id) => (await db.loadFile(id)) !== undefined,
  })
  /**
   * #955：查原件的读失败**不阻断发送**（审计里已经按 `source-unreadable` 跳过它），但绝不许静默 ——
   * 那是本机存储层出了问题（读不出来 ≠ 当初没导入原件），排查时要能落到具体错误。
   */
  if (audit.readErrors.length > 0) {
    const first = audit.readErrors[0].error
    record('chat_send', 'warn', 'history attachment source unreadable', {
      count: audit.readErrors.length,
      reason: 'history',
      status: 'error',
      ...errorMeta(first),
    })
  }
  // 源缺失的附件全被跳过、提问又只有它（没有文字）：这条消息没有任何东西可发，明说而不是空发
  if (
    request.question.content.trim() === '' &&
    request.question.files.length > 0 &&
    request.question.files.every((file) => audit.unavailableIds.has(file.id))
  ) {
    throw new ApiError('protocol', { key: 'attachUnavailableNoText' })
  }
  const hasImage = request.question.files.some(
    (file) => file.isImage && !audit.unavailableIds.has(file.id)
  )
  if (hasImage && !vision.base64 && !vision.nativeFile) {
    // 既不能内联、也没有 Files API：明确报错并提示换渠道，绝不静默丢图（母单 #548）
    throw new ApiError('protocol', { key: 'visionUnsupported' })
  }
  if (vision.base64) {
    // base64 渠道：图片本地编码内联，**一个上传请求都不发**
    await prepareInlineImages(sessionId, request, signal, audit.unavailableIds)
  }
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      // 源缺失（#379）：没有东西可传，跳过 —— 不补传、不阻断，提示已落到消息上
      if (audit.unavailableIds.has(file.id)) {
        return
      }
      // base64 渠道的图片不进 Files API（#360：这条渠道没有上传端点，也不许回落）
      if (file.isImage && vision.base64) {
        return
      }
      /**
       * #978：本渠道没有原生文档上传实现就**不上传文档**。
       *
       * 修之前，这条路径只跳过「图片走 base64」的那一档，文档既不命中上面两条、也没人问过
       * `documents.nativeFile`，于是被送进 `ensureServerId()` → `uploadAttachment()`：**向一个
       * 能力表明确写着「收不了文档」的渠道上传文档**，失败即整条消息 `kind:'upload'`
       * （界面显示「上传失败」）。默认内置渠道（`ours`）上，任何 DOCX / PDF / TXT 都必然失败。
       *
       * 跳过之后文档不会丢：`textInjection` 的渠道由 `withRequestDocuments()` 注入正文
       * （`#480 §9`），`acceptsDocuments() === false` 的渠道在 `sendMessage` 就被拒，
       * 两条路都与「有没有 `serverId`」「有没有 `file_id` 块」无关。
       */
      if (!file.isImage && !documents.nativeFile) {
        return
      }
      if (file.isImage) {
        /**
         * 这张图本渠道按 `file_id` 发原图（deepseek 通路）。若它在**选图时**已经因为渠道是
         * base64 而编过一份（用户中途换了渠道），那份产物就不再代表这次真正发出去的字节：
         * 清掉缓存，卡片才不会拿 webp 的体积去描述一次原图上传（#552）。
         * 只碰展示缓存 —— 请求本身（上传 + file_id）与改造前逐字节一致。
         */
        dropImagePart(file.id)
      }
      try {
        const serverId = await ensureServerId(
          apiKey,
          file,
          pendingFiles.get(sessionId)?.find((item) => item.id === file.id)?.blob
        )
        if (serverId) {
          serverIds.set(file.id, serverId)
        }
      } catch (error) {
        // #379：上传失败要说得清是哪个附件（以前只剩一句「上传失败」）。原始错误留在 cause 里，
        // 上面的重试判定与诊断字段仍然读它，这里只补「哪张图 / 哪个文件」。
        throw new AttachmentUploadError(file, error)
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
      // base64 渠道的图片不参与补传：它们的正文在本地，压根不需要 file_id
      if (file.isImage && vision.base64) {
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
  // #379：源缺失的附件已经跳过（不重传、不阻断），但**不许静默** —— 把清单落到这条 user 消息上，
  // 界面在消息里点名提示（哪个附件、为什么没发）。清单为空时顺手清掉旧提示（附件又可用时不留假话）。
  markUnavailableAttachments(sessionId, request.question.id, audit.unavailable, audit.sendable)
  if (audit.unavailable.length > 0) {
    record('chat_send', 'warn', 'attachments unavailable at send', {
      ...buildMeta({ flow: 'chat', stage: 'chat.request', status: 'error' }),
      retryable: false,
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
  /**
   * 三段超时（#568）：先按 `chat/timeoutPolicy.ts` 的矩阵判，**已经出过内容的空闲超时
   * 一律不重发**——重发会重复输出、重复计费，而退避那一层完全不知道用户已经看了半句。
   * 连接/首字两段此时用户还什么都没看到，重发是安全的。
   */
  const staged =
    error instanceof ApiError ? shouldRetryStreamTimeout(error.code, receivedContent) : null
  if (staged !== null) {
    return staged && attempt < STREAM_RETRY_LIMIT ? 'retry' : 'final'
  }
  if (receivedContent || attempt >= STREAM_RETRY_LIMIT) {
    return 'final'
  }
  return isRetryableApiError(error) || fileRecovered ? 'retry' : 'final'
}

/** #105 通用档的退避：`基值 × 2^attempt`（断流档**不用**这个，见下面的 waitForRetry） */
const genericRetryDelayMs = (attempt: number) => RETRY_BASE_DELAY * 2 ** attempt

/**
 * 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾。
 *
 * 等多久由**调用方**给（`delayMs`），本函数只负责「等」与「可被停止打断」：
 * - 断流两档的退避是 1s / 2s / 4s / 8s 封顶，由 `chat/streamBreakout.ts` 的
 *   `retryDelayMs` 算（那一档最多 5 次，一路翻倍会把用户晾半分钟）；
 * - 其余档仍是 `genericRetryDelayMs(attempt)`（#105 的 1s / 2s）。
 * 把档位算法收在判定里，这里就不再复制一份 `2 ** attempt`。
 */
const waitForRetry = (delayMs: number, signal: AbortSignal) =>
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
      delayMs
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
  void generateSessionTitle(text, task.signal, sessionId)
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
 * 文档注入（#480 §9）：把消息上的附件引用换成正文注入，返回可以上行的 messages。
 *
 * **只有 `textInjection === true` 的渠道会调用本函数**（调用点在 `streamReply` 里，闸门在
 * `docInjectionFor(kind)`）。DeepSeek 官方走原生 `file_id`，一条都不进这里。
 *
 * 三件事都在 `buildWithDocuments()` 里，不在本函数重新实现一遍：
 * 1. 按需读正文（预算用尽就**不再** `getText`）；
 * 2. 预算分配 + 单附件/总预算两条上限，超了在正文里标「已截断，剩余 N 字符未发送」；
 * 3. 与 #345 的历史裁剪协同：`messages` 已经是裁剪后的结果，被裁掉的轮次连同它的
 *    附件引用一起消失（引用是挂在消息上的），所以「窗口外的文档」天然不会被注入。
 *
 * 降级策略（§10：文档是增强项，不是发送前置条件）：
 * - `buildWithDocuments()` 内部把「解析失败 / 未就绪 / 预算耗尽 / 读失败 / 空正文」
 *   记进 `warnings` 并跳过那一份 —— 提问照发，notice 里给 UI 的说明；
 * - 它自己抛错（不该发生）时这里兜一次：剥掉 `attachments` 引用键（协议里没这个字段，
 *   原样上行会被上游当未知字段），按「没有文档」的请求继续发送。
 */
const withRequestDocuments = async (
  messages: ChatMessage[],
  kind: ProviderKind,
  system: string
): Promise<{ messages: ChatMessage[]; notice: string }> => {
  // 本函数只被文本注入渠道调用；能力表这里再问一次，是给「将来有人从别处调」兜底
  if (!docInjectionFor(kind).textInjection) {
    return { messages: stripAttachmentRefs(messages), notice: '' }
  }
  const refs = collectAttachmentsForRequest(messages)
  if (refs.length === 0) {
    // 这条请求没有文档：连 buildWithDocuments() 都不进，消息数组原样上行
    return { messages, notice: '' }
  }
  try {
    const result = await buildWithDocuments(messages, [], {
      /**
       * 上下文窗口：本仓库没有按模型登记窗口的表，唯一的「窗口级」数字是请求侧预算
       * （`LIMITS.contextBudget.maxTokens`，与 `toRequestMessages()` 用的是同一个上限）。
       * `reservedTokens` 把「系统提示 + 已裁好的历史 + 本轮提问」扣掉，剩下的才是文档的，
       * 这与 issue §9 的公式同形；两边取小（`docBudgetTokens` 也会再取一次小）。
       */
      contextWindowTokens: LIMITS.contextBudget.maxTokens,
      reservedTokens: estimateTokens(estimateChars(messages) + system.length),
    })
    const notice = [...result.warnings, formatDocumentInjection(result)].join('；')
    return { messages: result.messages, notice }
  } catch (error) {
    // 埋点规范 R3：error 级至少两个可切片键 —— 除了 stage 再记「哪个渠道 × 几份文档」，
    // 否则事后只能看到「注入失败」，分不清是单份解析炸了还是多渠道某一档不支持。
    recordError(
      '文档注入失败，本次请求不带附件正文',
      { stage: 'chat.request', provider: kind, attachments: refs.length },
      error
    )
    return {
      messages: stripAttachmentRefs(messages),
      notice: '附件正文注入失败，本次只发送提问内容',
    }
  }
}

/**
 * 把一条回复**已经展示给用户的内容**清空，回到「还没出字」的待生成态。
 *
 * 只服务于断流的 `discardPartial`（首字节后断开、内容不足 150 字）：那一档要求「丢弃重来」，
 * 旧内容必须跟着一起消失 —— 否则同一条回复里会同时出现前一版和新一版的正文（用户看到两份、
 * 上游重复计费）。清的是**这一条回复本身**：不新建回复、不动 `id` / 分支结构、不调
 * `regenerateReply`，所以 `updateReply`（按 `message.id` 整条替换）与 `persist`
 * 写进 IndexedDB 的仍是同一个 `session.messages` 项，库里不会多出一份。
 *
 * 思考块一起清：`receivedCharsOf` 把思考也算作「用户已看到的内容」，留着思考而清正文
 * 一样是「两份」。
 */
const discardReplyContent = (reply: AssistantMessage): AssistantMessage => ({
  ...reply,
  status: 'pending',
  blocks: [],
  stopReason: undefined,
  stopDetails: undefined,
})

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const session = getSession(sessionId)
  const prompt = session?.customSystemPrompt
  const systemPrompt = typeof prompt === 'string' && prompt ? SYSTEM_PROMPT + '\n\n' + prompt : SYSTEM_PROMPT
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
  /**
   * 断流两档**自己**已经重试过几次（`chat/streamBreakout.ts` 的 `retriedCount`）。
   *
   * 为什么不用 `attempt`：那个计数器把 #105 通用档（弱网 / 5xx / 附件失效补传）的重试
   * 也算进去了，而两档的**上限不同**（断流 5 次 / 1 次，通用 2 次）。混算会让
   * 「先 5xx 重试过一次、再断流」的轮次提前判成预算用完 —— 用户无感的那几次补救就白丢了。
   */
  let breakoutRetries = 0
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
      /**
       * 这一轮**已经展示给用户**的字符数（正文 + 思考）：断流后「要不要静默重发」看它。
       *
       * 与 `receivedContent` 的分工：那个是布尔（有没有出过内容块），这里要的是量 ——
       * 产品口径按「首字节前 / 首字节后」分档（见 `chat/streamBreakout.ts`），
       * 而 `content_block_start` 到达时正文可能还是空的（思考块先到），按块判会把
       * 「用户已经看着思考在滚」当成「什么都没看到」。
       */
      let receivedChars = 0
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
        /**
         * 文档注入的能力闸（#480 §7 / §9）：**只有 `textInjection === true` 才走注入**。
         *
         * DeepSeek 官方 `textInjection === false`（`nativeFile` 同样为 `false`，本仓库没有
         * 可用的原生上传实现，见 #360 / #538），于是下面三件事**一件都不发生**：消息上不挂
         * 附件引用（`attachmentRefs: false`）、不进 `withRequestDocuments()`、不读一次附件正文
         * —— `toRequestMessages()` 的入参
         * 与改动前完全一致（多出来的只是一个 `false` 选项，产物无差别），`messages` 原样
         * 传给 `toRequestBody()`，请求体逐字节等于原路径。
         * 这条闸是**代码级**保证，不是约定。
         */
        const documentInjection = docInjectionFor(spec.kind).textInjection
        const preparedMessages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          thinking,
          latestReminder,
          // 裁剪边界跟着会话走（#345）：同一会话的后续轮次沿用同一个边界，
          // 请求前缀逐字节稳定，上游上下文缓存才会命中
          // vision：本渠道图片走 file_id 还是 base64 内联（#551）；deepseek 仍只认 file_id
          { anchorKey: sessionId, personaChars: systemPrompt.length - SYSTEM_PROMPT.length, attachmentRefs: documentInjection, vision: visionFor(spec.kind) }
        )
        /**
         * 注入正文（#480 §9）：`buildWithDocuments()` 是**唯一入口** —— 它按预算挑正文、
         * 与历史裁剪协同（被裁掉的轮次其上引用也一起消失了，见 `toRequestMessages` 的出参）。
         *
         * 失败只降级：解析 failed / 预算耗尽 / 读失败都由它自己记进 `warnings` 并跳过那一份，
         * 提问照发；真抛错时这里兜一次，剥掉引用键继续发（文档是增强项，不是发送前置条件）。
         */
        const injected = documentInjection
          ? await withRequestDocuments(preparedMessages, spec.kind, systemPrompt)
          : { messages: preparedMessages, notice: '' }
        if (injected.notice) {
          recordEvent('chat_send', injected.notice, {
            ...buildMeta({ flow: 'chat', stage: 'chat.request', status: 'ok' }),
            model: initial.model ?? getModel(),
          })
        }
        const { system, messages } = toRequestBody(injected.messages, systemPrompt)
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
          // 会话标识（#576）：`sessionId` 是这段对话的**主键，建会话时生成一次**（见 sendMessage 里
          // 的 `createId()`），首轮就有、后续每一轮都相同 —— 服务端 `usage_logs.session_id`
          // 因此能把整段对话的请求串起来。这里绝不重新生成 id：id 一变，#345 的稳定前缀
          // 缓存和「记忆归属」两件事会一起失效。
          sessionId,
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
          // 「用户看到了多少字」：正文与思考增量都算（见 receivedChars 的注释）
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              receivedChars += event.delta.text.length
            } else if (event.delta.type === 'thinking_delta') {
              receivedChars += event.delta.thinking.length
            }
          }
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
      } catch (rawError) {
        /**
         * #379：发送前附件补齐失败时，抛上来的是 `AttachmentUploadError`（里面捆着「哪个附件」
         * 和原始错误）。界面文案要用前者、重试判定与诊断字段要用后者 —— 在这一处拆开，
         * 下游（分类 / 重试 / 埋点）继续只看原始错误，不必认识这个包装类。
         */
        const uploadFailure = attachmentUploadFailureOf(rawError)
        const error = uploadFailure === undefined ? rawError : uploadFailure.cause
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
        /**
         * 界面文案由**一张表**决定（#771）：`chat/errorNotice.ts` 的
         * 「判据 → 文案 key → 是否可重试 → 是否显示重新生成」。
         * 改前这里是三层嵌套三元（contextLimit / 额度 / 401），加一档就要往里再塞一层，
         * review 时看不出「哪些场景其实会掉进 replyUnknownError」。
         */
        const apiError = error instanceof ApiError ? error : null
        const noticeCtx = {
          kind: apiError?.kind,
          code: apiError?.code,
          status: apiError?.status,
          upstreamCode: apiError?.upstreamCode,
          condition,
          providerKind: getProviderKind(),
          receivedContent,
          // store 这边手里只有我们自己那句本地化文案，不作为「未分类是否自证」的证据
          hasReadableText: false,
        }
        const noticeRow = pickErrorNotice(noticeCtx)
        const noticeKey = rowKey(noticeRow, noticeCtx)
        /**
         * 落盘的 `localMessage` 只在**请求层已经把同一句连同占位符算好**时沿用
         * （`{seconds}` 之类）。表只负责「这条失败落在哪一句」，不负责重新拼文案 ——
         * 需要参数的那些行（参数错 / 模型名 / 4xx 原文）由 `describe.ts` 渲染时按落盘信息补齐，
         * 在这里塞一个不带参数的 key 只会让界面出现「请求参数有误（{status}）」这种未替换的模板。
         */
        const notice =
          apiError?.localMessage && apiError.localMessage.key === noticeKey
            ? apiError.localMessage
            : noticeRow.paramsFromRenderer
              ? undefined
              : { key: noticeKey }
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
          /**
           * 三段超时的可观察字段（#568）：超时到底卡在哪一段。
           * 「是不是我们的超时太短、还是上游真的慢」只能靠这两个字段回答，
           * 混在 kind='timeout' 里谁也分不出连接慢还是首字慢。
           */
          ...(apiFailure?.code && streamTimeoutStageOf(apiFailure.code)
            ? {
                'timeout.code': apiFailure.code,
                'timeout.stage': streamTimeoutStageOf(apiFailure.code) as string,
              }
            : {}),
          ...(idleMs ? { 'idle.ms': Number(idleMs) } : {}),
          // 用户在界面上会看到什么：条件分类 + i18n 文案 key（用来核实「到底有没有提示」）
          'ui.condition': condition,
          // 界面上会看到什么：表判出来的那一句（没算参数 key 也照记，便于按文案切片）
          'ui.notice': notice?.key ?? noticeKey,
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
            // #379：说清是哪个附件、为什么 —— 只有拿不到附件上下文时才退回泛化文案
            localMessage:
              uploadFailure === undefined
                ? describeUploadError(error)
                : describeUploadFailure(uploadFailure.fileName, error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效是 400（补传后才可自愈）：先确认「本来就要再发一次」再补传，避免白清 serverId。
        // 收到过内容块（含丢弃的客户端工具）后不自动重发。
        const mayRetry =
          attempt < STREAM_RETRY_LIMIT && !receivedContent && !controller.signal.aborted
        const fileRecovered =
          mayRetry &&
          !isRetryableApiError(error) &&
          reuploadInvalidatedFiles(sessionId, request, error)
        /**
         * 断流两档（interrupted / idle）走**自己那套口径**（`chat/streamBreakout.ts`）：
         * - 首字节前断开 → 静默重试 **5** 次（1s/2s/4s/8s 封顶，60s 总预算优先于次数）；
         * - 首字节后有内容且 **< 150 字** → 补 1 次，且**丢弃已收到内容重来**（`discardPartial`）；
         * - 首字节后有内容且 **>= 150 字** → 0 次，软提示 + 「重新生成」，内容保留。
         *
         * `decideStreamRetry` 的口径**不动**：它服务的是弱网 / 5xx / 连接超时 / 首字超时、
         * 以及附件失效补传，那些档位有自己的上限与提示。这里只是在断流两档上做一次收口，
         * 两者不重叠（`isStreamBreakoutKind` 只认 interrupted / idle）。
         */
        const errorKind = error instanceof ApiError ? error.kind : undefined
        const breakoutKind = isStreamBreakoutKind(errorKind) ? errorKind : undefined
        const breakout = decideStreamBreakout({
          receivedChars,
          // 只数断流档自己的重试（见 breakoutRetries 的注释：不能和 #105 通用档混算）
          retriedCount: breakoutRetries,
          // 总预算从点发送算起（含附件补齐与前面几次退避的等待）：超了立刻停，不再重发
          elapsedMs: Date.now() - startedAt,
          kind: errorKind,
        })
        const decision = breakoutKind
          ? controller.signal.aborted
            ? 'aborted'
            : breakout.retry
              ? 'retry'
              : 'final'
          : decideStreamRetry({
              error,
              attempt,
              receivedContent,
              aborted: controller.signal.aborted,
              fileRecovered,
            })
        if (decision === 'retry') {
          if (breakoutKind) {
            breakoutRetries += 1
          }
          /**
           * 丢弃半截内容重来（`discardPartial`）：首字节后断开、内容不足 150 字时，
           * 判定要求「重发前把已收到内容清干净」，否则同一条回复里会同时有前一版和新一版
           * 的正文 —— 用户看到两遍、上游重复计费，这就是「绝不出现两份」的执行点。
           *
           * 三件事一起做，缺一不可：
           * 1. `reply` 置空（正文 / 思考块全清、状态回到 pending）—— 内存里只剩这一份；
           * 2. `updateReply` 立刻把清空后的回复写回会话（不等 rAF，避免一帧的旧内容回闪）；
           * 3. `persist` 落盘：库里存的也是同一个 `session.messages` 项（按 `message.id`
           *    整条替换），**不新增版本、不调 regenerateReply**，所以持久化层面不会有两份。
           */
          if (breakout.discardPartial) {
            reply = discardReplyContent(reply)
            updateReply(sessionId, reply)
            void persist(sessionId)
            /**
             * 首字到达时 `clearWaitHints` 已经把 `waitStates` 删掉了，这时候 `setWaitStage`
             * 是 no-op —— 「正在重新生成」这条既有提示（`chatRetrying`）根本不会出现。
             * 丢弃重来等于重新开始一次等待，所以在这里重新挂表（秒数仍从点发送累计，不归零）。
             */
            armWaitHints(sessionId, startedAt)
          }
          // 让用户看见「正在第 N 次重试」，而不是静默卡住；秒数从点发送累计，不因重试归零（#328 G6）
          // 「共 N 次」用这一档自己的预算（断流 5 次 / 1 次），不能照抄 #105 的 2
          setWaitStage(sessionId, 'retrying', {
            attempt: breakoutKind ? breakoutRetries : attempt + 1,
            limit: breakout.maxRetries > 0 ? breakout.maxRetries : STREAM_RETRY_LIMIT,
          })
          // 退避时长也由判定给：断流档 1s/2s/4s/8s 封顶，其余档仍是 #105 的 base × 2^attempt
          await waitForRetry(
            breakoutKind ? breakout.retryDelayMs : genericRetryDelayMs(attempt),
            controller.signal
          )
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
