/**
 * 诊断模块的共享类型（契约层）。
 *
 * 这一层只能有类型和常量：**不允许 import collector / transport**，
 * 这样采集层与上传层可以各自依赖它，而彼此互不相识。
 * FeedbackPayload 的字段严格对齐后端 `POST {BASE}/api/v1/feedback` 的请求体。
 */

/** 提交接口的 schema 版本，后端按此字段做兼容 */
export const FEEDBACK_SCHEMA_VERSION = 1

export type LogLevel = 'error' | 'warn' | 'info'

/**
 * 事件类型枚举：每条日志都必须带 kind，便于排查时按类型切片。
 * 生命周期 / 界面 / 配置 / 网络（成功与失败都记）/ 会话流 / 导入 / 异常 / 长任务 / 周期快照。
 */
export type EventKind =
  | 'app_launch'
  | 'app_pause'
  | 'app_resume'
  | 'nav'
  | 'config_change'
  | 'net_request'
  | 'net_response'
  | 'net_error'
  | 'chat_send'
  | 'chat_first_token'
  | 'chat_done'
  | 'chat_abort'
  | 'import_start'
  | 'import_stage'
  | 'import_done'
  | 'import_error'
  | 'error'
  | 'warning'
  | 'longtask'
  | 'ui_rendered'
  | 'state_snapshot'

/** 日志附加信息只允许可序列化的原始值，避免把 DOM / Blob 之类的对象写进 payload */
export type LogMeta = Record<string, string | number | boolean>

/**
 * 一条日志：时间戳（epoch ms）、事件类型、级别、正文（已脱敏、已截断）、可选附加信息。
 * meta 用扁平的点号键，便于后端直接按 key 检索：`http.status`、`url.path`、`error.msg`、
 * `error.stack`、`stage`、`durationMs`、`reason`…
 */
export type LogEntry = {
  t: number
  kind: EventKind
  level: LogLevel
  msg: string
  meta?: LogMeta
}

/** 反馈分类：问题反馈 / 功能建议 / 其他 */
export type FeedbackCategory = 'bug' | 'feature' | 'other'

export type FeedbackContent = {
  description: string
  category: FeedbackCategory
  /** 可选联系方式；UI 暂不采集时为空字符串（后端按空串处理） */
  contact: string
}

export type AppInfo = {
  /** 应用版本号：优先构建期注入（gradle versionName / APP_VERSION），web 兜底 package.json */
  version: string
  /** Android versionCode */
  versionCode: number
  /** 构建类型：internal（内测）/ standard（正式） */
  buildType: string
  /** 运行平台：android / ios / web */
  platform: string
}

export type SystemInfo = {
  appVersionName?: string
  appVersionCode?: number
  artifactVariant?: string
  appSource?: string
  androidSdk?: number
  androidRelease?: string
  manufacturer?: string
  brand?: string
  webviewPackage?: string
  webviewVersion?: string
  fontScale?: number
  density?: number
  networkType?: string
  online?: boolean
  capabilities?: Record<string, boolean>
  nativePath?: string
  browserPath?: string
}

export type DeviceInfo = {
  /** 机型；拿不到写 unknown */
  model: string
  /** Android 版本；拿不到写 unknown */
  androidVersion: string
  /** WebView 内核版本；拿不到写 unknown */
  webviewVersion: string
  /** 屏幕：宽x高 */
  screen: string
  /** 界面语言 */
  locale: string
  /** 浏览器 UA（截断 200 字）：web 端机型解析不出来时靠它定位环境 */
  userAgent?: string
  /** 设备像素比（devicePixelRatio） */
  pixelRatio?: number
  /** 逻辑核数（navigator.hardwareConcurrency） */
  hardwareConcurrency?: number
  /** 内存 GB（navigator.deviceMemory，非标准） */
  deviceMemory?: number
  /** 单次采集并缓存的系统与运行时能力快照 */
  system?: SystemInfo
}

export type ClientInfo = {
  /** 设备级 UUID，持久化在 localStorage */
  clientId: string
  /** 每次启动新生成的会话级 UUID */
  sessionId: string
}

/** 上传给后端的完整载荷 */
export type FeedbackPayload = {
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION
  app: AppInfo
  device: DeviceInfo
  client: ClientInfo
  feedback: FeedbackContent
  logs: LogEntry[]
  screenshot?: string
}

/**
 * 采集层产出的快照：FeedbackPayload 中「只与运行环境、日志有关」的部分。
 * 采集层不关心用户填了什么，所以不含 feedback / screenshot —— 由门面（index.ts）在提交时补齐。
 */
export type LogSnapshot = Omit<FeedbackPayload, 'feedback' | 'screenshot'>

/** 提交前自检的提示项（只提示、不阻断上传） */
export type ValidationWarning = 'few_logs' | 'no_network' | 'short_span'

/** 上传失败的机器可读原因，UI 据此区分网络 / 体积 / 限流 / 服务端 */
export type FeedbackErrorCode =
  | 'network'
  | 'timeout'
  | 'too_large'
  | 'unauthorized'
  | 'rate_limited'
  | 'server'
  | 'rejected'
  | 'unknown'

/**
 * 上传结果：`error` 为机器可读原因码，`detail` 为后端给的可读详情（可选）。
 * `logSize` 是服务端回显的实际收到字节数（legacy 通道用它做量化验证），
 * `logBytes` 是本地实际发出的 log 字节数，`retried` 表示走过降级重试。
 */
export type FeedbackTransportResult =
  | { ok: true; id: string; logSize?: number; logBytes?: number; retried?: boolean }
  | { ok: false; error: string; detail?: string; logBytes?: number }

/**
 * 上传层接口 —— 换上传方案时只需要新写一个实现（transport.xxx.ts），采集层完全不用动。
 * 只依赖 FeedbackPayload，不认识 collector。
 */
export interface FeedbackTransport {
  readonly name: string
  send(payload: FeedbackPayload): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}
