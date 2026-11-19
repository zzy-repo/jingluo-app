/**
 * 检查更新失败的**分类层**（Issue #310）。
 *
 * 改造前所有异常都收敛成同一句「检查更新失败，请稍后重试。」——用户没法判断是断网、
 * 分发机挂了、清单数据坏了，还是装到了坏包；反馈单里也问不出来。这里只做一件事：
 * 把内部异常翻译成「**哪一类** + **要不要重试** + **一句人话**」。
 *
 * 三条约束：
 * 1. **纯函数、零依赖**：不 import React / 采集层 / transport，单测可以直接跑（也只有它适合被单测钉住文案）；
 * 2. **不泄漏内部细节**：文案里不出现 URL、IP、堆栈、包名——上游短码只在诊断文本与日志里出现；
 * 3. **不猜**：表里没有的上游码一律归 `unknown`，宁可粗一档，也不把网络错误说成数据错误。
 */

/** 失败分类：用户能据此决定「再点一次」还是「找我们」 */
export type UpdateFailureKind =
  /** 渠道 / 分发地址不可达（断网、DNS、分发机挂了） */
  | 'network'
  /** 更新服务回了错误状态（404 / 5xx：渠道地址配错、该渠道在这台分发机上没发布、分发机出错） */
  | 'service'
  /** 清单解析失败（返回的不是合法 JSON、记录字段不合法、路径不合法） */
  | 'manifest'
  /** 签名或校验不通过（大小 / SHA-256 / 包名 / 签名不符） */
  | 'integrity'
  /** 下载中断（网络断开、存储不足、HTTP 错误） */
  | 'download'
  /** 无可用版本（该渠道没有比当前更新的记录，或记录缺少渠道 / SHA256） */
  | 'no-version'
  /** 本机环境不满足（当前安装包缺少渠道标识） */
  | 'env'
  /** 用户自己取消 */
  | 'cancelled'
  /** 未归类 */
  | 'unknown'

export interface UpdateFailure {
  kind: UpdateFailureKind
  /** 上游短码（`INVALID_RELEASE` / `HASH_MISMATCH` …）：只进日志与诊断文本，界面不直接展示 */
  code: string
  /** 再点一次有没有意义 */
  retryable: boolean
}

/** 上游短码 → 分类。表外的码一律 `unknown`（不猜） */
const KIND_OF_CODE: Record<string, UpdateFailureKind> = {
  // 取清单阶段：连接层面失败
  MANIFEST_NETWORK: 'network',
  NETWORK_UNREACHABLE: 'network',
  TIMEOUT: 'network',
  // 取清单 / 解析阶段：数据不合法
  INVALID_JSON: 'manifest',
  INVALID_MANIFEST: 'manifest',
  INVALID_RELEASE: 'manifest',
  INVALID_APK_URL: 'manifest',
  INVALID_CURRENT_VERSION: 'manifest',
  MANIFEST_TOO_LARGE: 'manifest',
  AMBIGUOUS_RELEASE: 'manifest',
  INCOMPLETE_RELEASE: 'manifest',
  // 下载 / 安装阶段：包本身对不上（原生侧只给短码，见 #311 的边界）
  HASH_MISMATCH: 'integrity',
  SIZE_MISMATCH: 'integrity',
  SIGNATURE_MISMATCH: 'integrity',
  PACKAGE_MISMATCH: 'integrity',
  VERSION_MISMATCH: 'integrity',
  VARIANT_MISMATCH: 'integrity',
  // 下载阶段：传输没走完
  DOWNLOAD_HTTP: 'download',
  DOWNLOAD_INTERRUPTED: 'download',
  INSUFFICIENT_STORAGE: 'download',
  // 选版本阶段
  NO_VERSION: 'no-version',
  // 环境
  VARIANT_MISSING: 'env',
  // 用户操作
  CANCELLED: 'cancelled',
}

/** 每类默认要不要重试：传输类的重试有意义，数据 / 包 / 环境类的重试是白费用户时间 */
const RETRYABLE: Record<UpdateFailureKind, boolean> = {
  network: true,
  // 5xx 是分发机临时出错（可重试），404 是渠道地址 / 发布记录不存在（重试没用）——
  // 具体哪一种由状态码决定，见 classifyUpdateError
  service: false,
  manifest: false,
  integrity: false,
  download: true,
  'no-version': true,
  env: false,
  cancelled: true,
  unknown: true,
}

/** 我们自己抛的上游短码形状：全大写 + 下划线（与 updateManifest / 原生桥的既有码一致） */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,39}$/
/** 带状态码的取清单短码（updateManifest.fetchBody 抛的）：`MANIFEST_HTTP_404` */
const HTTP_CODE_SHAPE = /^MANIFEST_HTTP_(\d{3})$/

const nameOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    return typeof name === 'string' ? name : ''
  }
  return ''
}

const messageOf = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return ''
}

/**
 * 上游短码归一：把任意 throw 出来的东西压成一个短码。
 * 顺序很重要——先认「我们自己的短码」，再认异常类型（AbortError / SyntaxError / TypeError），
 * 最后才落到 `UNKNOWN`：`fetch failed` 与 `{bad` 必须分成两类，否则「断网」和「服务端数据坏了」又混在一起。
 */
export const shortCodeOf = (error: unknown): string => {
  const message = messageOf(error).trim()
  if (CODE_SHAPE.test(message)) {
    return message
  }
  const name = nameOf(error)
  if (name === 'AbortError' || /aborted|cancelled|canceled/i.test(message)) {
    return 'CANCELLED'
  }
  if (name === 'TimeoutError') {
    return 'TIMEOUT'
  }
  if (name === 'SyntaxError') {
    // JSON.parse('{bad') 抛的就是它：清单拿到了但读不出来
    return 'INVALID_JSON'
  }
  if (name === 'TypeError' || /fetch|network|offline|connection|failed to load/i.test(message)) {
    return 'NETWORK_UNREACHABLE'
  }
  return 'UNKNOWN'
}

/** 任意异常 → 分类结果（不抛异常：它自己就在 catch 里跑） */
export const classifyUpdateError = (error: unknown): UpdateFailure => {
  const code = shortCodeOf(error)
  return updateFailureOf(code)
}

/** 短码 → 分类：HTTP 状态码那条要看具体数字（5xx 可重试、4xx 不可），所以单独判 */
export const updateFailureOf = (code: string): UpdateFailure => {
  const http = HTTP_CODE_SHAPE.exec(code)
  if (http) {
    const status = Number(http[1])
    return { kind: 'service', code, retryable: status >= 500 }
  }
  const kind = KIND_OF_CODE[code] ?? 'unknown'
  return { kind, code, retryable: RETRYABLE[kind] }
}

/** 文案上下文：只放用户已经知道的信息（渠道名、当前版本、记录数），不放地址 */
export interface UpdateFailureContext {
  /** 渠道的中文名（「稳定版」/「稳定版与预发布版」），不写地址 */
  channel: string
  /** 当前版本号，例如 1.4.0-beta.10 */
  version: string
  /** 清单里缺渠道 / 缺 SHA256 的记录数：用来区分「确实没新版」与「有记录但不敢装」 */
  incomplete?: number
}

export interface UpdateFailureView {
  kind: UpdateFailureKind
  /** 上游短码：只给诊断文本与日志用，界面不展示 */
  code: string
  /** 短标签：界面上的「失败原因：<label>」 */
  label: string
  /** 一句人话：哪一类、为什么 */
  detail: string
  /** 再点一次有没有意义 */
  retryable: boolean
  /** 拼好的整句（界面、复制文本、日志摘要共用同一句，避免两处说法不一致） */
  text: string
}

const LABELS: Record<UpdateFailureKind, string> = {
  network: '更新服务不可达',
  service: '更新服务返回错误',
  manifest: '版本信息无法解析',
  integrity: '安装包校验未通过',
  download: '下载未完成',
  'no-version': '暂无可用版本',
  env: '当前安装包信息缺失',
  cancelled: '已取消',
  unknown: '未预期的错误',
}

const RETRY_HINT = '这类问题多半是临时的，点「重新检查」可以再试一次。'
const NO_RETRY_HINT = '客户端再试一次通常还是同样的结果，请点「复制诊断信息」把这段反馈给我们。'

const detailOf = (failure: UpdateFailure, ctx: UpdateFailureContext): string => {
  switch (failure.kind) {
    case 'network':
      return `连不上更新服务（渠道「${ctx.channel}」）——可能是设备网络不通，也可能是更新服务器暂时不可用。`
    case 'service': {
      const status = Number(HTTP_CODE_SHAPE.exec(failure.code)?.[1] ?? 0)
      return status >= 500
        ? `更新服务返回了 HTTP ${status}（渠道「${ctx.channel}」）——分发机这一侧临时出错。`
        : `更新服务返回了 HTTP ${status}（渠道「${ctx.channel}」）——渠道地址可能配错，或这个渠道还没在这台分发机上发布。`
    }
    case 'manifest':
      return `更新服务返回的版本信息读不出来（渠道「${ctx.channel}」），格式不符合约定。这是更新服务一侧的数据问题，不是你设备的问题。`
    case 'integrity':
      return '下载到的安装包与发布记录不一致（大小或 SHA-256 不符），已中止，避免装到被篡改或不完整的包。'
    case 'download':
      return '下载过程中断了——可能是网络断开、切换了网络，或设备存储空间不足。已下载的部分不会被使用。'
    case 'no-version':
      return noVersionDetail(ctx)
    case 'env':
      return '当前安装包缺少渠道标识（内测 / 正式），客户端无法判断该装哪个版本，因此不会贸然下载。'
    case 'cancelled':
      return '这次操作是你自己取消的。'
    default:
      return '检查更新时出现了客户端没有预料到的错误。'
  }
}

/** 「无可用版本」的两条真实原因：确实没有新记录；或者有记录但缺渠道 / SHA256 不敢装 */
const noVersionDetail = (ctx: UpdateFailureContext): string => {
  const current = `当前版本 ${ctx.version}，渠道「${ctx.channel}」`
  const incomplete = ctx.incomplete ?? 0
  if (incomplete > 0) {
    return `${current}下没有可直接安装的新版本：另有 ${incomplete} 条发布记录缺少渠道或 SHA256，未作为更新目标。`
  }
  return `${current}已是最新，该渠道没有更高的版本。`
}

/** 分类 + 上下文 → 界面文案（含「可重试 / 不可重试」的明确说明） */
export const describeUpdateFailure = (
  failure: UpdateFailure,
  ctx: UpdateFailureContext
): UpdateFailureView => {
  const label = LABELS[failure.kind]
  const detail = detailOf(failure, ctx)
  // 「无可用版本」「已取消」不是故障：不摆重试失败的口吻，直接说清现状
  const hint =
    failure.kind === 'no-version' || failure.kind === 'cancelled'
      ? ''
      : failure.retryable
        ? RETRY_HINT
        : NO_RETRY_HINT
  return {
    kind: failure.kind,
    code: failure.code,
    label,
    detail,
    retryable: failure.retryable,
    text: `${label}：${detail}${hint}`,
  }
}

/** 检查成功且没有更新时的界面文案（issue #310 验收：无新版也要说清版本号） */
export const describeUpToDate = (ctx: UpdateFailureContext): UpdateFailureView =>
  describeUpdateFailure(updateFailureOf('NO_VERSION'), ctx)
