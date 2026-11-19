/**
 * 诊断字段契约（**零依赖纯模块**）：让一条日志能被**切片**（阶段 / 尝试次数 / 端点 / 缓存）
 * 与**度量**（耗时 / 字节 / 吞吐）。
 *
 * 为什么单独一层（Issue #306 / 母单 #301 维度 2）：
 * 改造前每条日志的 `meta` 是谁想写什么就写什么 —— 同一个「阶段」有 `check` / `staging` / `stream`
 * 三种写法，耗时有时叫 `durationMs` 有时叫 `elapsedMs`，「多大」有时叫 `bytes` 有时叫
 * `download.bytes` 有时叫 `logSize`。键不统一就切不了片：按 stage 聚合不了，按 endpoint 对不上
 * `config/endpoints.json`，用户说「回复慢」时也拿不到一个能比较的数字。
 *
 * 两条铁律：
 * 1. **只用原始值**（string / number / boolean）—— 对象、数组、null、NaN、Infinity 一律丢弃；
 * 2. **键必须来自白名单** —— 结构化字段的类型由 `MetaInput` 收紧（写错键编译期就过不去），
 *    历史点号键（`error.msg` / `url.path` …）走运行期兼容表，表外的一律丢弃。
 *
 * 本模块不认识 collector / transport：采集层 import 它，它谁也不 import（除零依赖的 redact）。
 */

import { redact, truncate } from './redact.js'

// ---------------------------------------------------------------- 流程域

/**
 * 流程域：`stage` 按域各自收紧（见 `Stage`）。
 * 有了域，后端/排查看「这次慢在哪一段」时不用先猜这个 stage 属于哪条链路。
 */
export type FlowDomain = 'chat' | 'import' | 'net' | 'update' | 'quota' | 'feedback' | 'ui' | 'app'

export const FLOW_DOMAINS: readonly FlowDomain[] = [
  'chat',
  'import',
  'net',
  'update',
  'quota',
  'feedback',
  'ui',
  'app',
]

// ---------------------------------------------------------------- 阶段枚举

/**
 * 阶段枚举（**新值一律带域前缀**）：一个 stage 串就能定位到「哪条链路的哪一步」。
 * 每个域只允许自己那段取值（`chat.*` 不许出现在导入日志里），这就是「按流程域收紧」。
 */
export type Stage =
  // 会话流（#101）：附件补齐 → 请求发出 → 首字/流式 → 收尾
  | 'chat.send'
  | 'chat.upload'
  | 'chat.request'
  | 'chat.stream'
  | 'chat.settle'
  // 导入：体积检查 → 格式检查 → 暂存写入 → 下载（链接导入） → 提交
  | 'import.size'
  | 'import.check'
  | 'import.stage'
  | 'import.download'
  | 'import.commit'
  // 网络（采集层 hook）
  | 'net.request'
  | 'net.response'
  | 'net.error'
  // 更新检查（每次检查三步）
  | 'update.check.installed'
  | 'update.check.manifest'
  | 'update.check.select'
  | 'update.download'
  | 'update.install'
  // 额度 / 卡密查询（链路尚未埋点，先定取值）
  | 'quota.query'
  // 反馈上传
  | 'feedback.upload'
  // 启动与渲染
  | 'app.launch'
  | 'ui.render'

export const STAGES: readonly Stage[] = [
  'chat.send',
  'chat.upload',
  'chat.request',
  'chat.stream',
  'chat.settle',
  'import.size',
  'import.check',
  'import.stage',
  'import.download',
  'import.commit',
  'net.request',
  'net.response',
  'net.error',
  'update.check.installed',
  'update.check.manifest',
  'update.check.select',
  'update.download',
  'update.install',
  'quota.query',
  'feedback.upload',
  'app.launch',
  'ui.render',
]

/**
 * 改造前已经在库里的 stage 取值（**只读兼容**，新调用点不许再用）。
 *
 * 不直接删掉它们的原因：老日志（IndexedDB 里恢复的、已提交的工单）里全是这些值，
 * 判据必须是「能认得旧值」而不是「旧值消失」。新代码写 `Stage`，写不了这里。
 */
export const LEGACY_STAGES: readonly string[] = [
  'stream',
  'upload',
  'check',
  'size',
  'staging',
  'download',
  'click',
  'visibility',
  'console',
  'window.onerror',
  'unhandledrejection',
  'fetch-hook',
  'http-hook',
  'feedback-upload',
]

export const isStage = (value: unknown): value is Stage =>
  typeof value === 'string' && (STAGES as readonly string[]).includes(value)

// ---------------------------------------------------------------- 端点键

/**
 * 端点键：对应 `config/endpoints.json` 的顶层键，**不写完整 URL**（地址写进日志就等于泄漏中转地址，
 * 也没法跨版本聚合）。`other` = 用户自填地址（自建 / 中转），只靠 `url.host` 区分。
 */
export type EndpointKey = 'chatBaseUrl' | 'inviteBaseUrl' | 'feedbackUrl' | 'other'

export const ENDPOINT_KEYS: readonly EndpointKey[] = [
  'chatBaseUrl',
  'inviteBaseUrl',
  'feedbackUrl',
  'other',
]

export const isEndpointKey = (value: unknown): value is EndpointKey =>
  typeof value === 'string' && (ENDPOINT_KEYS as readonly string[]).includes(value)

/** 构建期注入的端点表（非打包环境没有就退化成空表，绝不能因此抛） */
type EndpointTable = Partial<Record<Exclude<EndpointKey, 'other'>, string>>

const readEndpointTable = (): EndpointTable => {
  try {
    if (typeof __ENDPOINTS__ === 'undefined' || !__ENDPOINTS__) {
      return {}
    }
    const table = __ENDPOINTS__ as unknown as Record<string, unknown>
    const out: EndpointTable = {}
    for (const key of ['chatBaseUrl', 'inviteBaseUrl', 'feedbackUrl'] as const) {
      const value = table[key]
      if (typeof value === 'string' && value) {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 只取 `scheme://host[:port]`：路径与 query 不参与比较（同一端点不同路径是同一台机器） */
const originOf = (value: string): string | null => {
  try {
    const url = new URL(value, 'http://redacted.local')
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * 把一次请求的地址映射成端点键。相对路径（同源请求）按当前页面 origin 兜底 —— 与 `redactHost` 同口径。
 * 认不出来一律 `other`：宁可粗一档，也不把一个自建中转错标成官方端点。
 */
export const endpointKeyFromUrl = (url: string): EndpointKey => {
  const origin = originOf(url)
  if (!origin) {
    return 'other'
  }
  const table = readEndpointTable()
  for (const key of ['chatBaseUrl', 'inviteBaseUrl', 'feedbackUrl'] as const) {
    const base = table[key]
    if (base && originOf(base) === origin) {
      return key
    }
  }
  return 'other'
}

// ---------------------------------------------------------------- 状态

/**
 * 状态：HTTP 状态码（0–599 的整数）或内部状态枚举。
 * 两者共用一个键 = 排查时只要看 `status` 就能判断「这次到底成了没有」，
 * 不用先分清它是 HTTP 还是业务状态（旧日志的数值状态仍在 `http.status`）。
 */
export type StatusCode =
  | number
  | 'ok'
  | 'partial'
  | 'error'
  | 'timeout'
  | 'aborted'
  | 'rejected'
  | 'retrying'

export const STATUS_VALUES = [
  'ok',
  'partial',
  'error',
  'timeout',
  'aborted',
  'rejected',
  'retrying',
] as const

export const isStatusCode = (value: unknown): value is StatusCode =>
  (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 599) ||
  (typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value))

// ---------------------------------------------------------------- 结构化字段

/**
 * 一条日志允许携带的结构化字段（**键与取值都在这里定死**）。
 *
 * 故意不写成 `Record<string, …>`：写成开放 map，随便一个字符串键都能混进来，
 * 后端永远不知道有哪些键可切；写成这个类型，写错键名 / 传对象 `pnpm type` 就红。
 */
export type MetaInput = {
  /** 流程域，与 stage 前缀一致 */
  flow?: FlowDomain
  /** 当前阶段（按域收紧，见 Stage） */
  stage?: Stage
  /** 第几次尝试（1 起）：重试/退避场景必须带上，否则「第一次就慢」和「重试后才成」分不开 */
  attempt?: number
  /** HTTP 状态码或内部状态枚举 */
  status?: StatusCode
  /** 对应 config/endpoints.json 的键；绝不写完整 URL */
  endpointKey?: EndpointKey
  /** 链路 id：另一条线（维度 5）未落地时写 TRACE_ID_PENDING 占位 */
  traceId?: string
  /**
   * 上游响应体里的机器可读错误码（`error.code` / `error.type`，如 `invalid_request_error`、
   * `insufficient_balance`；#324）。
   *
   * 为什么要新增这一个键、而不复用现有键：现有键里没有一个能装「上游自己给的短码」——
   * `status` 是 HTTP 码、`stage` 是本地环节、`error.detail` / `detail` 是**错误原文**
   * （多行、可能英文长句），塞进去就没法按 code 聚合。而「这个月有多少次
   * invalid_request_error」恰恰是 #324 要回答的问题：官方端点所有 400 的 `error.type`
   * 都是同一个 `invalid_request_error`，只有短码能切片。取值恒为短字符串（≤300 字符，
   * 走 cleanString 脱敏后落库），不引入新的取值域。
   */
  upstreamCode?: string
  /** 这一段本身花了多久 */
  durationMs?: number
  /**
   * 排队等待耗时：从「提交任务」到「任务真正开始发请求」之间的等待（#313）。
   *
   * 为什么必须单独一个键：附件上传有并发上限（`MAX_CONCURRENT`），用户一次选 5 张图时
   * 后 2 张要排队。`durationMs` 是「调用到结束」的总时长，把排队和上传混成一个数，
   * 「点了半天没反应」到底是排队卡住还是网络慢就分不出来（母单 #301 维度 2）。
   * 上传耗时 = durationMs − queueMs。
   */
  queueMs?: number
  /**
   * 这次失败再试一次有没有用（#313）：false = 重试也是同一个结果
   * （渠道没有 Files API、4xx 终态、链接过期、包本身不是 ZIP）。
   *
   * 为什么不是从 `status` / `error.msg` 猜：失败分级本来就散在文案里，用户照着「再试一次」
   * 点下去才被告知别试了。写成一个布尔就能直接切片「哪些失败是人可以挽回的」。
   */
  retryable?: boolean
  /** 已传输 / 已处理的字节数 */
  bytes?: number
  /** 总量（下载总字节、请求体总长）：与 bytes 一起才能算进度百分比 */
  totalBytes?: number
  /** 速率（字节/秒）：弱网判定靠它，不靠 durationMs 自己猜 */
  speedBps?: number
  /** 点发送 → 请求真正发出（附件补齐 + 构体）：首字还没开始等，时间已经花在这里 */
  prepMs?: number
  /** 请求发出 → 响应头（上游排队 + 建连） */
  ttfbMs?: number
  /** 请求发出 → 首个内容块（首字） */
  firstTokenMs?: number
  /** 首个内容块 → 流结束（真正的「吐字」时长） */
  streamMs?: number
  /** 流式分段数：分段少 = 一次刷出，分段多 = 一字一字冒 */
  chunks?: number
  /** 相邻分段的最大间隔：卡顿的直接证据 */
  gapMaxMs?: number
  /** 文本字符数 */
  chars?: number
  /** 吞吐（字符/秒） */
  charsPerSec?: number
  /** 命中了缓存（服务端/本地都算，由调用方判定） */
  cacheHit?: boolean
  /** 数据来自本地缓存（未发请求或走了本地副本） */
  fromCache?: boolean
}

/** 结构化字段的键名集合 */
export type MetaKey = keyof MetaInput

export const META_KEYS: readonly MetaKey[] = [
  'flow',
  'stage',
  'attempt',
  'status',
  'endpointKey',
  'traceId',
  'upstreamCode',
  'prepMs',
  'durationMs',
  'queueMs',
  'retryable',
  'bytes',
  'totalBytes',
  'speedBps',
  'ttfbMs',
  'firstTokenMs',
  'streamMs',
  'chunks',
  'gapMaxMs',
  'chars',
  'charsPerSec',
  'cacheHit',
  'fromCache',
]

// ---------------------------------------------------------------- 上限

/** 单个字符串值截断长度（与改造前 collector 的 MAX_META_LENGTH 一致，不许放宽） */
export const META_VALUE_MAX = 300
/** 单条 meta 最多几个键：多到离谱的 meta 只会挤掉同一行里更有用的东西 */
export const MAX_META_KEYS = 24
/** 单个耗时字段上限（24 小时）：超过它的一定是时钟坏了，写进去会让统计失真 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000
/** 计数类字段上限（1e12）：同样是为了挡住时钟/计数器异常值 */
export const MAX_COUNTER = 1e12
/** 尝试次数上限 */
export const MAX_ATTEMPT = 1000
/** 吞吐上限（字符/秒）：正常回答远低于此，超过即为异常值 */
export const MAX_RATE = 1e9

/** 链路 id 未落地时的占位值（不是伪造的 id，读日志时一眼能看出来） */
export const TRACE_ID_PENDING = 'pending'
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

// ---------------------------------------------------------------- 取值归一

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 计数/耗时归一：负数与超过上限的取值**不写**（返回 undefined）。
 *
 * 为什么负数不夹成 0：0 是一个合法且有意义的值（真的 0 字节、真的 0ms），
 * 把 -1（时钟倒退 / 计数器坏了）夹成 0 就等于让「量不出来」冒充「量出来是 0」——
 * 这正是 #211 里 `bytes: -1` 与 `bytes: 0` 必须分开的同一条理由。
 * 超上限（时钟跳变）则夹到上限：数字再离谱也比丢掉整条好，且不会污染聚合。
 */
const clampCounter = (value: number, max: number): number | undefined => {
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.round(value) >= max ? max : Math.round(value)
}

const normalizeStatus = (value: unknown): StatusCode | undefined => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined
    }
    const status = Math.round(value)
    // 0 = 「拿不到状态」（原生通道没有 status 时的既有语义），599 以上不是 HTTP 码
    return status >= 0 && status <= 599 ? status : undefined
  }
  return isStatusCode(value) && typeof value === 'string' ? value : undefined
}

const normalizeTraceId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) {
    return undefined
  }
  if (value === TRACE_ID_PENDING) {
    return value
  }
  // 不是合法 id 就换成占位值而不是丢弃：字段位本身是契约的一部分，读日志的人要知道「还没有」
  return TRACE_ID_PATTERN.test(value) ? value : TRACE_ID_PENDING
}

/** 单个结构化字段的归一：非法值返回 undefined（= 这个键不写，绝不写「猜的值」） */
const normalizeField = (key: MetaKey, value: unknown): string | number | boolean | undefined => {
  if (value === undefined) {
    return undefined
  }
  switch (key) {
    case 'flow':
      return typeof value === 'string' && (FLOW_DOMAINS as readonly string[]).includes(value)
        ? value
        : undefined
    case 'stage':
      return isStage(value) ? value : undefined
    case 'endpointKey':
      return isEndpointKey(value) ? value : 'other'
    case 'status':
      return normalizeStatus(value)
    case 'traceId':
      return normalizeTraceId(value)
    case 'upstreamCode':
      // 短码：只收非空字符串（长度与脱敏由采集层的 cleanString 收口），其余一律不写
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    case 'attempt': {
      if (!isFiniteNumber(value)) {
        return undefined
      }
      const attempt = Math.round(value)
      // attempt 从 1 起：0 / 负数说明调用方传错了，宁可不写
      return attempt >= 1 && attempt <= MAX_ATTEMPT ? attempt : undefined
    }
    case 'prepMs':
    case 'durationMs':
    case 'queueMs':
    case 'ttfbMs':
    case 'firstTokenMs':
    case 'streamMs':
    case 'gapMaxMs':
      return isFiniteNumber(value) ? clampCounter(value, MAX_DURATION_MS) : undefined
    case 'bytes':
    case 'totalBytes':
    case 'speedBps':
    case 'chunks':
    case 'chars':
      return isFiniteNumber(value) ? clampCounter(value, MAX_COUNTER) : undefined
    case 'charsPerSec':
      return isFiniteNumber(value)
        ? Math.min(Math.round(value * 10) / 10, MAX_RATE)
        : undefined
    case 'cacheHit':
    case 'fromCache':
    case 'retryable':
      return typeof value === 'boolean' ? value : undefined
    default:
      return undefined
  }
}

/**
 * 结构化 meta 构造入口：**新埋点一律用它**。
 *
 * - 入参类型是 `MetaInput`：键写错 / 传对象编译期就红（这就是「不要让随便一个字符串键混进来」）；
 * - 运行期再归一一次（JS 调用方、`as any`、NaN 都挡得住），非法值直接不写，不写占位假数据。
 */
export const buildMeta = (input: MetaInput): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}
  for (const key of Object.keys(input) as MetaKey[]) {
    if (!(META_KEYS as readonly string[]).includes(key)) {
      continue
    }
    const value = normalizeField(key, input[key])
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------- 采集层清洗（负向入口）

/** 历史点号键：改造前就在用的字段族（读旧日志 / 未迁移调用点仍要能过） */
const EXTRA_KEY_PATTERNS: readonly RegExp[] = [
  /^error\.(?:msg|name|stack|detail)$/,
  /^http\.(?:status|channel|entry|hook|platform|proxy)$/,
  /^url\.(?:host|path)$/,
  /^req\.bodyBytes$/,
  /^fetch\.channel$/,
  /^download\.(?:bytes|total)$/,
  /^progress\.(?:bytes|state)$/,
  /^request\.(?:from|span)$/,
  /^idle\.ms$/,
  /^stall\.(?:ms|leftMs)$/,
  /^max\.total\.ms$/,
  /^limit\.bytes$/,
  /^min\.bytes\.per\.sec$/,
  /^ui\.(?:condition|notice)$/,
  /^damage\.(?:count|dropped|fields|firstField|messageId|received)$/,
]

/** 历史裸键：同上，逐个人工确认过的取值 */
const EXTRA_KEYS: readonly string[] = [
  'method',
  'requestId',
  'native',
  'reason',
  'elapsedMs',
  'threshold',
  'onLine',
  'effectiveType',
  'downlink',
  'rtt',
  'saveData',
  'netType',
  'version',
  'versionCode',
  'buildType',
  'platform',
  'device',
  'sessions',
  'files',
  'provider',
  'model',
  'view',
  'configured',
  'storageBytes',
  'action',
  // 续传标记：urlImport 早就在写 `resume: 'yes' | 'no'`，但一直不在白名单里 —— 生产日志里
  // 这个键被整条丢掉，「这次是不是从断点接着下」查不出来（#313 的「续传」要求）
  'resume',
  'target',
  'role',
  'trigger',
  'visible',
  'noticeText',
  'match',
  'delayMs',
  'stale',
  'transport',
  'logs',
  'logSize',
  'line',
  'mode',
  'image',
  'aborted',
  'count',
  'source',
  'host',
  'streaming',
  'didCrash',
  'nativeAt',
  'detail',
  'event',
  'correlationId',
  'result',
  // #314：i18n 缺 key 的上报字段。key 名本身是标识符（不是凭证），但 `key` 这个名字会命中
  // 下面的 SECRET_SEGMENTS 被整条丢掉，所以用 `i18nKey`；`locale` 只是语言标识；
  // `param` 只记占位符名字（`count` / `total`），不记参数值。
  // 不加这几条的话，日志里就只剩 stage/reason，反查不到缺的是哪个 key —— 正是 #314 要治的病。
  'i18nKey',
  'locale',
  'param',
]

/** 键名里出现这些「最后一段」就当作密钥字段：值里可能是 Key 原文，整条丢掉比脱敏更安全 */
const SECRET_SEGMENTS = new Set([
  'key',
  'apikey',
  'api_key',
  'accesskey',
  'accesskeyid',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'authorization',
  'cookie',
  'signature',
  'credential',
  'credentials',
])

const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/
/** 值里出现的完整地址（含 query 里的签名）一律压成 path */
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>]+/gi

const isAllowedKey = (key: string): boolean => {
  if (!KEY_SHAPE.test(key)) {
    return false
  }
  if ((META_KEYS as readonly string[]).includes(key)) {
    return true
  }
  if (EXTRA_KEYS.includes(key)) {
    return true
  }
  return EXTRA_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

const hasSecretName = (key: string): boolean => {
  const last = key.split('.').pop()?.toLowerCase() ?? key.toLowerCase()
  return SECRET_SEGMENTS.has(last)
}

/** 字符串值：先脱敏（sk- / Bearer / token= …）→ 再把完整 URL 压成 path → 最后截断 */
const cleanString = (value: string): string => {
  const withoutUrl = value.replace(ABSOLUTE_URL, (match) => {
    try {
      const url = new URL(match)
      return redact(url.pathname) || '/'
    } catch {
      return '/'
    }
  })
  return truncate(redact(withoutUrl), META_VALUE_MAX)
}

/**
 * 采集层唯一的清洗入口（`record()` 里调）：
 *
 * | 输入 | 处理 |
 * | --- | --- |
 * | 白名单外的键（含形状不合法） | **丢弃** |
 * | 键名像密钥（`apiKey` / `token` / `secret` …） | **丢弃整条** |
 * | 对象 / 数组 / null / undefined / NaN / Infinity / function | **丢弃** |
 * | 超长字符串 | 截断到 `META_VALUE_MAX` |
 * | 字符串里的完整 URL / 密钥 | 压成 path / `sk-***` |
 * | 键数超过 `MAX_META_KEYS` | 丢弃后面的（按传入顺序，调用方把重要的放前） |
 *
 * 任何输入都不许抛：日志采集坏了不能把业务拖下水（调用方在 catch 里也要能继续跑）。
 */
export const sanitizeMeta = (meta: unknown): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return out
  }
  let kept = 0
  let source: [string, unknown][]
  try {
    source = Object.entries(meta as Record<string, unknown>)
  } catch {
    return out
  }
  for (const [key, value] of source) {
    if (kept >= MAX_META_KEYS) {
      break
    }
    if (typeof key !== 'string' || !isAllowedKey(key) || hasSecretName(key)) {
      continue
    }
    if (typeof value === 'string') {
      out[key] = cleanString(value)
      kept += 1
      continue
    }
    if (typeof value === 'boolean') {
      out[key] = value
      kept += 1
      continue
    }
    if (isFiniteNumber(value)) {
      // 数字不夹取：老键（`http.status`、`line`）语义由调用方定，这里只挡非有限值
      out[key] = value
      kept += 1
    }
    // 其余（对象 / 数组 / null / NaN / function / symbol）一律丢弃
  }
  return out
}
