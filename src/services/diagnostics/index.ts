import {
  captureStateSnapshot,
  captureUiNotice,
  clearLogs,
  flushLogs,
  getActionTrail,
  getLogCount,
  getSnapshot,
  initCollector,
  readNetworkStatus,
  readRenderedNotice,
  record,
  recordAction,
  recordError,
  recordEvent,
  recordUserAction,
  redact,
  redactHost,
  redactUrl,
  setSnapshotFactsProvider,
  type ActionRecord,
  type CollectorOptions,
  type RenderedNotice,
  type SnapshotFacts,
} from './collector.js'
import {
  describeFeedbackError,
  payloadBytes,
  toFeedbackErrorCode,
} from './shared.js'
import { fitPayload, prepareScreenshot } from './transport.http.js'
import { HttpTransport } from './transport.http.js'
import { LegacyTransport, buildLegacyLog, buildLegacyRequest } from './transport.legacy.js'
import {
  FEEDBACK_SCHEMA_VERSION,
  type EventKind,
  type FeedbackCategory,
  type FeedbackErrorCode,
  type FeedbackPayload,
  type FeedbackTransport,
  type FeedbackTransportResult,
  type LogEntry,
  type LogSnapshot,
  type ValidationWarning,
} from './types.js'

/**
 * 门面：把「采集」和「上传」串起来。
 *
 * - collector.ts 不认识上传（只给 getSnapshot()）；
 * - transport.ts 不认识采集（只接受 FeedbackPayload）；
 * - 换上传方案：实现 FeedbackTransport 后 setFeedbackTransport() 注入即可，本文件的
 *   其余逻辑与采集层都不用动。
 */

/**
 * 默认通道：**legacy**（后端实际接口只认 content/type/contact/version，没有 logs 的位置）。
 * 等后端按 v1 契约（/api/v1/feedback + logs/screenshot）扩展后，把下面这一行换成
 * `new HttpTransport('<v1 base url>')`（来自 ./transport.http.js）即可切回，采集层与 UI 都不用动。
 * 注意 base url 是**显式入参**：那个指向废弃域名的占位常量已在 #274 删除，不再有默认值。
 */
let transport: FeedbackTransport = new LegacyTransport()

export type DiagnosticsOptions = CollectorOptions & {
  /** 自定义上传通道（测试注入 mock，或换成 transport.xxx.ts 的实现） */
  transport?: FeedbackTransport
  /** 「当前状态」读取器：会话数、附件数、provider/model、当前界面（由应用侧注入） */
  facts?: () => SnapshotFacts | Promise<SnapshotFacts>
}

/** 启动诊断：写 app_launch → 装 hook → 恢复本地日志 → 起周期快照 */
export const initDiagnostics = async (options: DiagnosticsOptions = {}): Promise<void> => {
  if (options.transport) {
    transport = options.transport
  }
  await initCollector(options)
}

/** 替换上传通道（换方案只改这里） */
export const setFeedbackTransport = (next: FeedbackTransport): void => {
  transport = next
}

/** 当前通道名（写进日志摘要与反馈表单，便于排查「这次走的是哪条链路」） */
export const getFeedbackTransportName = (): string => transport.name

/** 采集层快照（不含用户填写内容） */
export const getDiagnosticsSnapshot = (): LogSnapshot => getSnapshot()

/** 本地日志条数 */
export const getDiagnosticsLogCount = (): number => getLogCount()

/** 最近 50 个用户动作 */
export const getDiagnosticsActionTrail = (): ActionRecord[] => getActionTrail()

/** 清空本地日志（内存 + IndexedDB） */
export const clearDiagnostics = (): Promise<void> => clearLogs()

/** 等待日志落盘完成 */
export const flushDiagnostics = (): Promise<void> => flushLogs()

/** 手动写一条状态快照（关键动作后调用，也供自检使用） */
export const captureDiagnosticsSnapshot = (reason: string): Promise<LogEntry> =>
  captureStateSnapshot(reason)

// ---------------------------------------------------------------- 提交前自检

/** 一份日志在「能不能定位问题」这件事上的覆盖情况 */
export type LogCoverage = {
  /** 条数 */
  count: number
  /** 时间跨度（ms） */
  spanMs: number
  /** 出现过的事件类型 */
  kinds: EventKind[]
  /** 建议至少出现一次、但这次缺失的事件类型 */
  missing: EventKind[]
  /** 提交前自检的提示（只提示、不阻断上传） */
  warnings: ValidationWarning[]
  /** 最近动作链 */
  actions: ActionRecord[]
}

/** 建议每条反馈里都能看到的类型（缺了就等于少了一类证据） */
const EXPECTED_KINDS: EventKind[] = [
  'app_launch',
  'state_snapshot',
  'nav',
  'net_request',
  'net_response',
]

/** 日志条数太少 / 没有网络记录 / 时间跨度 <1 秒 —— 都会让日志「有效覆盖」不足 */
const analyze = (logs: LogEntry[]): Omit<LogCoverage, 'actions'> => {
  const kinds = [...new Set(logs.map((entry) => entry.kind))]
  const spanMs = logs.length > 1 ? logs[logs.length - 1].t - logs[0].t : 0
  const warnings: ValidationWarning[] = []
  if (logs.length < 10) {
    warnings.push('few_logs')
  }
  if (!kinds.some((kind) => kind === 'net_request' || kind === 'net_response' || kind === 'net_error')) {
    warnings.push('no_network')
  }
  if (spanMs < 1000) {
    warnings.push('short_span')
  }
  return {
    count: logs.length,
    spanMs,
    kinds,
    missing: EXPECTED_KINDS.filter((kind) => !kinds.includes(kind)),
    warnings,
  }
}

/** 自检当前缓冲区（不修改任何东西）：「检查日志完整性」按钮用 */
export const inspectLogCoverage = (): LogCoverage => ({
  ...analyze(getSnapshot().logs),
  actions: getActionTrail(),
})

/**
 * 提交前自检：返回提示项（只提示、不阻断上传），
 * 并在缺少 state_snapshot 时**自动补一条当前快照**（直接追加到传入的 payload.logs）。
 */
export const validatePayload = async (
  payload: FeedbackPayload
): Promise<{ warnings: ValidationWarning[] }> => {
  const analysis = analyze(payload.logs)
  if (!analysis.kinds.includes('state_snapshot')) {
    const entry = await captureStateSnapshot('validate')
    payload.logs = [...payload.logs, entry]
  }
  return { warnings: analysis.warnings }
}

// ---------------------------------------------------------------- 提交

export type SubmitFeedbackInput = {
  description: string
  category: FeedbackCategory
  contact?: string
  /** data URL；由 prepareScreenshot() 压缩后传入 */
  screenshot?: string
}

export type SubmitFeedbackResult =
  | {
      ok: true
      id: string
      transport: string
      warnings: ValidationWarning[]
      /** 服务端回显的日志字节数 */
      logSize?: number
      /** 本地实际发出的日志字节数 */
      logBytes?: number
      /** 走过降级重试（413 / 连接重置后用 50KB 的 log 重发成功） */
      retried?: boolean
    }
  | {
      ok: false
      error: FeedbackErrorCode
      message: string
      detail?: string
      transport: string
      warnings: ValidationWarning[]
    }

/**
 * 提交反馈：快照 + 用户填写内容拼成 FeedbackPayload，先自检再交给当前 transport。
 * 不抛异常，失败一律收敛成错误码 + 中文可读提示。
 */
export const submitFeedback = async (
  input: SubmitFeedbackInput
): Promise<SubmitFeedbackResult> => {
  const name = transport.name
  // 先记一条「这次用哪个通道提交」的日志，随本次 payload 一起上传（日志摘要里能看出走的是哪条链路）
  recordAction('nav', 'feedback-submit', { transport: name, logs: getLogCount() })
  const snapshot = getSnapshot()
  const payload: FeedbackPayload = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    app: snapshot.app,
    device: snapshot.device,
    client: snapshot.client,
    feedback: {
      description: input.description.trim(),
      category: input.category,
      contact: input.contact?.trim() ?? '',
    },
    logs: snapshot.logs,
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
  }
  const { warnings } = await validatePayload(payload)
  try {
    // 接口签名只保证 { ok, id } / { ok, error }；logSize 这类附加字段按实现可选透传
    const result = (await transport.send(payload)) as FeedbackTransportResult
    if (result.ok) {
      recordAction('nav', 'feedback-accepted', {
        transport: name,
        id: result.id,
        ...(result.logSize === undefined ? {} : { logSize: result.logSize }),
      })
      return {
        ok: true,
        id: result.id,
        transport: name,
        warnings,
        ...(result.logSize === undefined ? {} : { logSize: result.logSize }),
        ...(result.logBytes === undefined ? {} : { logBytes: result.logBytes }),
        ...(result.retried ? { retried: true } : {}),
      }
    }
    const code = toFeedbackErrorCode(result.error)
    recordError(`feedback rejected: ${code}`, { stage: 'feedback-upload', transport: name })
    return { ok: false, error: code, message: describeFeedbackError(code), transport: name, warnings }
  } catch (error) {
    recordError('feedback failed', { stage: 'feedback-upload', transport: name }, error)
    return {
      ok: false,
      error: 'unknown',
      message: describeFeedbackError('unknown'),
      transport: name,
      warnings,
    }
  }
}

/** UI 用：相册选图 → 压缩后的 data URL（非图片 / 解不开会抛 `ScreenshotError`，见 #388） */
export { prepareScreenshot }
export { ScreenshotError } from './transport.http.js'
export type { ScreenshotErrorCode } from './transport.http.js'

/** UI 用：错误码 → i18n 之外的兜底中文提示 */
export { describeFeedbackError }

/** 应用侧记录业务动作 / 错误（带上事件类型，便于按类型切片） */
export { recordAction, recordError, recordEvent, recordUserAction, setSnapshotFactsProvider }

/** 提示是否真的渲染出来了（chat / import 失败路径已在采集层自动探测，也可手动确认） */
export { captureUiNotice, readRenderedNotice, readNetworkStatus, redactHost, type RenderedNotice }

/** 两套 transport 实现都对外暴露，便于测试注入与后端扩展后切换 */
export { HttpTransport } from './transport.http.js'
export { LegacyTransport, buildLegacyLog, buildLegacyRequest } from './transport.legacy.js'

/**
 * 本地验收用的调试入口：只有 URL 带 `?diag-debug` 时才挂到 window 上。
 * 默认（正式使用）不暴露任何东西；验收脚本用它注入 mock transport、构造日志、断言体积控制与自检结果。
 */
export const installDiagnosticsDebugHandle = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    if (!new URLSearchParams(window.location.search).has('diag-debug')) {
      return
    }
  } catch {
    return
  }
  Object.assign(window, {
    __diagnostics: {
      initDiagnostics,
      setFeedbackTransport,
      getFeedbackTransportName,
      getDiagnosticsSnapshot,
      getDiagnosticsLogCount,
      getDiagnosticsActionTrail,
      submitFeedback,
      clearDiagnostics,
      flushDiagnostics,
      captureDiagnosticsSnapshot,
      inspectLogCoverage,
      validatePayload,
      record,
      recordEvent,
      // 验收脚本的便捷入口：按级别推 kind（error / warning / nav）
      recordLog: (level: 'error' | 'warn' | 'info', msg: string, meta?: Record<string, string | number | boolean>) =>
        record(level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'nav', level, msg, meta),
      recordError,
      recordAction,
      recordUserAction,
      redact,
      redactUrl,
      redactHost,
      readNetworkStatus,
      readRenderedNotice,
      captureUiNotice,
      fitPayload,
      payloadBytes,
      prepareScreenshot,
      buildLegacyLog,
      buildLegacyRequest,
      HttpTransport,
      LegacyTransport,
      transport: () => transport,
    },
  })
}
