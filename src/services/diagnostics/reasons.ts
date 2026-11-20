/**
 * 失败原因的**机器可读字典**（母单 #301 / 维度 3「可读性分层」+ 维度 2「结构化字段」）。
 *
 * 要解决的问题：改造前 `reason` 只是一个「恰好被白名单放行」的裸键 ——
 *   · 取值混了三种风格：camelCase（`backupInvalidFiles`）、kebab（`archive-too-large`）、裸词（`empty` / `none` / `nokey`）；
 *   · 还混进了三类本该各自有字段的东西：HTTP 码（`http-404`）、上游短码（`MANIFEST_HTTP_404`）、
 *     **界面 i18n key**（`oursPlansFailed`）；
 *   · 于是「这个月有多少次是卡密已用」这种问题，只能靠人肉读文案，切不了片。
 *
 * 本文件只做一件事：把「为什么」收敛成一个**封闭取值域**，并给出每个取值的默认可重试性。
 * 判定标准仍然是母单那一句话：一条日志能不能回答「发生了什么 / 在哪一步 / 怎么办」——
 * `kind` 答发生了哪类事，`stage` 答在哪一步，`reason` + `retryable` 答怎么办。
 *
 * 三条硬规则（写新埋点时照着来，不要自造）：
 *
 * 1. **值恒为 kebab-case**（`card-already-used`，不是 `CARD_ALREADY_USED` / `cardAlreadyUsed`）；
 * 2. **只描述「为什么」**：
 *    - HTTP 码 → `status`（白名单已有，别塞进 reason）；
 *    - 上游自己给的短码 → `upstreamCode`（`invalid_request_error` / `CARD_ALREADY_USED`）；
 *    - 给人看的一句话 → `msg`；
 * 3. **同一取值在任何链路上的默认 `retryable` 一致**（见 `REASON_RETRYABLE`）——
 *    链路可以覆盖（比如 404 的 `http-error`），但要显式写出来，不能靠各写一份默认值。
 *
 * 零依赖纯模块：不认识 collector / transport / 业务代码，`fields.ts` 反过来 import 它。
 */

/**
 * 原因字典本体：**变量名 = 读代码时想找的词，取值 = 落库的字符串**。
 *
 * 用「一张表 + 派生类型」而不是「一个 union + 一张数组」：两处维护迟早漂（#312 已经踩过
 * 「只往 `Stage` 类型加值、忘了同步 `STAGES` 数组，stage 被静默丢掉」的坑）。这里
 * `LogReason` 由本表推导，`REASONS` 也由本表推导，只有一处可改。
 */
export const REASON = {
  // ---------------------------------------------------------------- 传输（所有链路共用）
  network: 'network',
  timeout: 'timeout',
  offline: 'offline',
  refused: 'refused',
  /** 非 2xx：**必须配 `status`**，可重试性由状态码决定（见 `retryableFor`） */
  httpError: 'http-error',
  /** 响应体不是预期的形状（不是网络问题，重试没用） */
  responseInvalid: 'response-invalid',
  rateLimited: 'rate-limited',
  /** 用户取消 / AbortError：不是失败，重试通常有用（用户想再来一次） */
  cancelled: 'cancelled',
  /** 平台不支持（WebView 没有 Files API、没有原生通道） */
  unsupported: 'unsupported',

  // ---------------------------------------------------------------- 更新检查 → 下载 → 安装
  /** 本机安装包的变体（internal / standard）在清单里断链（#377 现场） */
  variantInvalid: 'variant-invalid',
  manifestParse: 'manifest-parse',
  manifestEmpty: 'manifest-empty',
  releaseIncomplete: 'release-incomplete',
  packageHashMismatch: 'package-hash-mismatch',
  packageSizeMismatch: 'package-size-mismatch',
  packageSignatureMismatch: 'package-signature-mismatch',
  storageInsufficient: 'storage-insufficient',
  /** 系统没给安装权限：**可重试**，但下一步是「去开权限」而不是再点一次 */
  installPermission: 'install-permission',
  downloadInterrupted: 'download-interrupted',

  // ---------------------------------------------------------------- 支付 / 额度 / 卡密 / 兑换
  keyMissing: 'key-missing',
  keyInvalid: 'key-invalid',
  cardMissing: 'card-missing',
  /** 409 的一种：这张卡已经被兑换过。与 `newbie-used` 必须分开记 */
  cardAlreadyUsed: 'card-already-used',
  cardLeased: 'card-leased',
  /** 409 的另一种：新人特惠已用过（同一状态码、下一步完全不同） */
  newbieUsed: 'newbie-used',
  planMissing: 'plan-missing',
  orderMissing: 'order-missing',
  serviceUnavailable: 'service-unavailable',
  /** 202 / 已受理未到账：**不是失败**，下一步是继续轮询 */
  pending: 'pending',

  // ---------------------------------------------------------------- 导入（文件 / URL）
  archiveTooLarge: 'archive-too-large',
  archiveUnreadable: 'archive-unreadable',
  invalidUrl: 'invalid-url',
  /** 连续 N 秒没有任何新字节（`urlImport` 的 stall 判定） */
  stalled: 'stalled',
  /** 整段下载超出总预算 */
  deadline: 'deadline',
  /** 断流：缺字节，但地址仍有效 */
  incomplete: 'incomplete',
  empty: 'empty',

  // ---------------------------------------------------------------- 附件上传
  channelUnsupported: 'channel-unsupported',
  quotaFiles: 'quota-files',
  quotaStorage: 'quota-storage',
  /** 本地校验直接拒（格式 / 大小），请求都没发 */
  fileInvalid: 'file-invalid',

  // ---------------------------------------------------------------- 会话流
  contextLimit: 'context-limit',
  insufficientBalance: 'insufficient-balance',
  keyRejected: 'key-rejected',
  serverBusy: 'server-busy',
  streamInterrupted: 'stream-interrupted',

  // ---------------------------------------------------------------- 本地存储
  corruptStorage: 'corrupt-storage',
  storageWriteFailed: 'storage-write-failed',
} as const

/** 合法取值的联合类型（由 `REASON` 推导，写错字符串编译期就红） */
export type LogReason = (typeof REASON)[keyof typeof REASON]

/** 全部合法取值（顺序即字典顺序，便于文档与快照比对） */
export const REASONS = Object.values(REASON) as readonly LogReason[]

const REASON_SET = new Set<string>(REASONS)

export const isLogReason = (value: unknown): value is LogReason =>
  typeof value === 'string' && REASON_SET.has(value)

/**
 * 原因所属的链路域（**只用于人读与分组，不参与校验**）。
 * 与 `FlowDomain` 不是一回事：`transfer`（network / timeout …）会被所有链路借用。
 */
export type ReasonDomain = 'transfer' | 'update' | 'payment' | 'import' | 'attachment' | 'chat' | 'local'

export const REASON_DOMAIN: Record<LogReason, ReasonDomain> = {
  network: 'transfer',
  timeout: 'transfer',
  offline: 'transfer',
  refused: 'transfer',
  'http-error': 'transfer',
  'response-invalid': 'transfer',
  'rate-limited': 'transfer',
  cancelled: 'transfer',
  unsupported: 'transfer',
  'variant-invalid': 'update',
  'manifest-parse': 'update',
  'manifest-empty': 'update',
  'release-incomplete': 'update',
  'package-hash-mismatch': 'update',
  'package-size-mismatch': 'update',
  'package-signature-mismatch': 'update',
  'storage-insufficient': 'update',
  'install-permission': 'update',
  'download-interrupted': 'update',
  'key-missing': 'payment',
  'key-invalid': 'payment',
  'card-missing': 'payment',
  'card-already-used': 'payment',
  'card-leased': 'payment',
  'newbie-used': 'payment',
  'plan-missing': 'payment',
  'order-missing': 'payment',
  'service-unavailable': 'payment',
  pending: 'payment',
  'archive-too-large': 'import',
  'archive-unreadable': 'import',
  'invalid-url': 'import',
  stalled: 'import',
  deadline: 'import',
  incomplete: 'import',
  empty: 'import',
  'channel-unsupported': 'attachment',
  'quota-files': 'attachment',
  'quota-storage': 'attachment',
  'file-invalid': 'attachment',
  'context-limit': 'chat',
  'insufficient-balance': 'chat',
  'key-rejected': 'chat',
  'server-busy': 'chat',
  'stream-interrupted': 'chat',
  'corrupt-storage': 'local',
  'storage-write-failed': 'local',
}

/**
 * 每个原因的**默认可重试性**：`true` / `false` 是定论，`null` = 「看 HTTP 状态码」。
 *
 * 为什么需要它：改造前「再试一次有没有用」是每条链路各写一份（`urlImport` 的
 * `RETRYABLE_FAILURES`、`purchases` 的 `RETRYABLE_KINDS`、`attachments` 的三元表达式），
 * 同一种失败在不同链路上会不会被标成可重试，全看当时写的人。收敛到一张表，链路要覆盖
 * （比如 404 的 `http-error` 其实是终态）就显式覆盖，别偷偷另写一版。
 */
export const REASON_RETRYABLE: Record<LogReason, boolean | null> = {
  network: true,
  timeout: true,
  offline: true,
  refused: true,
  'http-error': null,
  'response-invalid': false,
  'rate-limited': true,
  cancelled: true,
  unsupported: false,
  'variant-invalid': false,
  'manifest-parse': false,
  'manifest-empty': true,
  'release-incomplete': false,
  'package-hash-mismatch': false,
  'package-size-mismatch': false,
  'package-signature-mismatch': false,
  'storage-insufficient': false,
  'install-permission': true,
  'download-interrupted': true,
  'key-missing': false,
  'key-invalid': false,
  'card-missing': false,
  'card-already-used': false,
  'card-leased': false,
  'newbie-used': false,
  'plan-missing': false,
  'order-missing': false,
  'service-unavailable': true,
  pending: true,
  'archive-too-large': false,
  'archive-unreadable': false,
  'invalid-url': false,
  stalled: true,
  deadline: true,
  incomplete: true,
  empty: true,
  'channel-unsupported': false,
  'quota-files': false,
  'quota-storage': false,
  'file-invalid': false,
  'context-limit': false,
  'insufficient-balance': false,
  'key-rejected': false,
  'server-busy': true,
  'stream-interrupted': true,
  'corrupt-storage': false,
  'storage-write-failed': true,
}

/**
 * 「这个原因再试一次有没有用」的**唯一**判定入口。
 *
 * `http-error` 看状态码：5xx 是服务端的事（重试有意义），4xx 是请求本身不对（重试同一个结果）。
 * 拿不到状态码（原生通道没有 status）时按 `false` 处理 —— 没有证据就不要告诉用户「再试一次」，
 * 这正是 #313 里 `retryable` 值钱的地方。
 */
export const retryableFor = (reason: LogReason, status?: number | string): boolean => {
  const preset = REASON_RETRYABLE[reason]
  if (preset !== null) {
    return preset
  }
  const code = typeof status === 'number' ? status : Number(status)
  return Number.isFinite(code) ? code >= 500 : false
}

/**
 * 改造前已经在生产里写过的 `reason` 取值（**只读**：读老日志用，新代码写不进来）。
 *
 * 为什么留一张表而不是直接删：老日志（IndexedDB 里恢复的、已提交的工单）里全是这些值，
 * 判据必须是「能认得旧值」，和 `LEGACY_STAGES` 同一模式。表内按「来源」分组，方便迁移时
 * 一条条对上字典里的正式取值 —— **别把新代码写进这里**。
 */
export const LEGACY_REASONS: readonly string[] = [
  // 支付链路把**界面 i18n key** 当 reason 写（#312 遗留，待迁移到字典值）
  'oursPlansFailed',
  'oursPayLinkFailed',
  'oursRedeemFailed',
  'oursRecordsFailed',
  'oursPurchasesFailed',
  'oursKeyProbeFailed',
  // 支付 / 卡密链路的本地错误 kind（camelCase，语义能对上字典但值不同名）
  'keyMissing',
  'unauthorized',
  'notFound',
  'rejected',
  'server',
  'unavailable',
  'rateLimited',
  'badResponse',
  // 更新检查「为什么没有可装版本」（#377）：这是「结果」，不是「失败原因」
  'up-to-date',
  'no-internal-variant',
  'no-standard-variant',
  'prerelease-filtered',
  'none',
  // 导入链路的历史取值
  'signature',
  'expired',
  'forbidden',
  'permanent',
  'not-zip',
  'interrupted',
  'unreachable',
  'backupInvalidBranches',
  'backupInvalidFiles',
  'history',
  'http',
  'json',
  'html',
  'normalize',
  'nokey',
  'unbound',
  'invalid',
  'aborted',
  'unknown',
]
