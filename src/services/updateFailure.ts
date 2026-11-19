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
 *
 * 另外两条（#373）：
 * 4. **一条码一句真话**：同一类里的不同上游码必须说清各自的实际原因——
 *    以前 `VERSION_MISMATCH / VARIANT_MISMATCH / SIGNATURE_MISMATCH / PACKAGE_MISMATCH`
 *    全被说成「大小或 SHA-256 不符」，把「装到了别家的包 / 别的渠道的包」误报成「下载坏了」；
 * 5. **zh/en 成对**：文案以 `{ zh, en }` 成对给出（与设置页 `PROVIDER_SPECS.label` 同一套形状），
 *    调用方按界面语言取一侧。这里不 import `src/i18n`：那是 React 侧的地基（settings store / 采集层），
 *    拉进来这条纯函数就没法在 unit 层裸跑了。
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

/** 界面语言：只决定文案取哪一侧，不影响分类与可重试性 */
export type FailureLocale = 'zh' | 'en'

/** 一句人话的双语对（与设置页 `PROVIDER_SPECS.label` 同一套形状，不重复造第二套约定） */
export interface FailureText {
  zh: string
  en: string
}

/** 文案上下文：只放用户已经知道的信息（渠道名、当前版本、记录数），不放地址 */
export interface UpdateFailureContext {
  /** 渠道名的双语对（「稳定版」/「稳定版与预发布版」），不写地址 */
  channel: FailureText
  /** 当前版本号，例如 1.4.0-beta.10 */
  version: string
  /** 清单里缺渠道 / 缺 SHA256 的记录数：用来区分「确实没新版」与「有记录但不敢装」 */
  incomplete?: number
  /** 界面语言，默认 zh（诊断文本与日志一律用默认值，保证反馈里只有一种语言） */
  locale?: FailureLocale
}

/** 「标签 + 详情」之间的连接：中文用全角冒号，英文用「: + 空格」 */
const JOIN: Record<FailureLocale, string> = { zh: '：', en: ': ' }

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

const LABELS: Record<UpdateFailureKind, FailureText> = {
  network: { zh: '更新服务不可达', en: 'Update service unreachable' },
  service: { zh: '更新服务返回错误', en: 'Update service returned an error' },
  manifest: { zh: '版本信息无法解析', en: 'Release information could not be parsed' },
  integrity: { zh: '安装包校验未通过', en: 'Package verification failed' },
  download: { zh: '下载未完成', en: 'Download did not finish' },
  'no-version': { zh: '暂无可用版本', en: 'No installable version' },
  env: { zh: '当前安装包信息缺失', en: 'Installed package information is missing' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  unknown: { zh: '未预期的错误', en: 'Unexpected error' },
}

const RETRY_HINT: FailureText = {
  zh: '这类问题多半是临时的，点「重新检查」可以再试一次。',
  en: 'This is usually temporary — tap "Check again" to retry.',
}
const NO_RETRY_HINT: FailureText = {
  zh: '客户端再试一次通常还是同样的结果，请点「复制诊断信息」把这段反馈给我们。',
  en: 'Retrying in the app will usually fail the same way — tap "Copy diagnostics" and send it to us.',
}

/**
 * `integrity` 下面挂着六个不同的上游码，**原因各不相同**（#373）：
 * 以前它们共用一句「大小或 SHA-256 不符」，把「装到了别的应用 / 别的渠道的包」也说成「下载坏了」，
 * 用户和反馈单都会被带偏。这里一条码一句真话，表外的码才回落到通用那句（不猜）。
 */
const INTEGRITY_DETAIL: Record<string, FailureText> = {
  HASH_MISMATCH: {
    zh: '下载到的安装包与发布记录对不上（SHA-256 不符），已丢弃，避免装到被篡改或不完整的包。',
    en: 'The downloaded package does not match the release record (SHA-256 mismatch). It was discarded so a tampered or incomplete file cannot be installed.',
  },
  SIZE_MISMATCH: {
    zh: '下载到的安装包大小与发布记录不符（可能没下完，或被网络中间层改过），已丢弃。',
    en: 'The downloaded package size does not match the release record (truncated, or altered in transit). It was discarded.',
  },
  SIGNATURE_MISMATCH: {
    zh: '这个安装包的签名与本机已装的应用不是同一个（可能被重新签过名，或渠道包串了），系统会拒绝覆盖安装。',
    en: 'This package is signed with a different key than the installed app (re-signed, or a package from another channel), so Android will refuse to update over it.',
  },
  PACKAGE_MISMATCH: {
    zh: '这个安装包不是本应用（包名不一致），已中止——多半是分发地址下到了别的应用或残缺文件。',
    en: 'This package is not this app (package name mismatch), so the update was aborted — the download address likely served another app or a broken file.',
  },
  VERSION_MISMATCH: {
    zh: '这个安装包的版本号不对（不高于当前已安装的版本，或与发布记录不一致），装上去也不会变成新版。',
    en: 'This package carries the wrong version code (not higher than the installed one, or different from the release record), so updating would not give you a newer version.',
  },
  VARIANT_MISMATCH: {
    zh: '这个安装包与本机已装版本的渠道不一致（内测包 / 正式包串了），只能装同一渠道的包才能覆盖安装。',
    en: 'This package belongs to a different channel build than the installed app (internal vs standard); only a package from the same channel can update over it.',
  },
}

const INTEGRITY_FALLBACK: FailureText = {
  zh: '下载到的安装包与发布记录不一致（大小或 SHA-256 不符），已中止，避免装到被篡改或不完整的包。',
  en: 'The downloaded package does not match the release record (size or SHA-256), so the update was aborted to avoid installing a tampered or incomplete file.',
}

const integrityDetail = (code: string): FailureText => INTEGRITY_DETAIL[code] ?? INTEGRITY_FALLBACK

const detailOf = (
  failure: UpdateFailure,
  ctx: UpdateFailureContext,
  lang: FailureLocale
): FailureText => {
  const channel = ctx.channel[lang]
  switch (failure.kind) {
    case 'network':
      return {
        zh: `连不上更新服务（渠道「${channel}」）——可能是设备网络不通，也可能是更新服务器暂时不可用。`,
        en: `Cannot reach the update service (channel "${channel}") — either the device has no working network, or the update server is temporarily unavailable.`,
      }
    case 'service': {
      const status = Number(HTTP_CODE_SHAPE.exec(failure.code)?.[1] ?? 0)
      return status >= 500
        ? {
            zh: `更新服务返回了 HTTP ${status}（渠道「${channel}」）——分发机这一侧临时出错。`,
            en: `The update service returned HTTP ${status} (channel "${channel}") — the distribution host is temporarily failing.`,
          }
        : {
            zh: `更新服务返回了 HTTP ${status}（渠道「${channel}」）——渠道地址可能配错，或这个渠道还没在这台分发机上发布。`,
            en: `The update service returned HTTP ${status} (channel "${channel}") — the channel address may be wrong, or this channel has not been published on that host.`,
          }
    }
    case 'manifest':
      return {
        zh: `更新服务返回的版本信息读不出来（渠道「${channel}」），格式不符合约定。这是更新服务一侧的数据问题，不是你设备的问题。`,
        en: `The release information returned by the update service could not be read (channel "${channel}"). This is a data problem on the update service side, not your device.`,
      }
    case 'integrity':
      return integrityDetail(failure.code)
    case 'download':
      return {
        zh: '下载过程中断了——可能是网络断开、切换了网络，或设备存储空间不足。已下载的部分不会被使用。',
        en: 'The download was interrupted — the network dropped or changed, or the device ran out of storage. The partial file is not used.',
      }
    case 'no-version':
      return noVersionDetail(ctx, lang)
    case 'env':
      return {
        zh: '当前安装包缺少渠道标识（内测 / 正式），客户端无法判断该装哪个版本，因此不会贸然下载。',
        en: 'The installed package carries no channel marker (internal / standard), so the app cannot tell which build to fetch and will not download blindly.',
      }
    case 'cancelled':
      return {
        zh: '这次操作是你自己取消的。',
        en: 'You cancelled this operation.',
      }
    default:
      return {
        zh: '检查更新时出现了客户端没有预料到的错误。',
        en: 'The update check hit an error the app did not expect.',
      }
  }
}

/** 「无可用版本」的两条真实原因：确实没有新记录；或者有记录但缺渠道 / SHA256 不敢装 */
const noVersionDetail = (ctx: UpdateFailureContext, lang: FailureLocale): FailureText => {
  const channel = ctx.channel[lang]
  const incomplete = ctx.incomplete ?? 0
  if (incomplete > 0) {
    return {
      zh: `当前版本 ${ctx.version}，渠道「${channel}」下没有可直接安装的新版本：另有 ${incomplete} 条发布记录缺少渠道或 SHA256，未作为更新目标。`,
      en: `Current version ${ctx.version}, channel "${channel}": there is no directly installable newer build; ${incomplete} more release record(s) lack a channel or SHA256 and were not used.`,
    }
  }
  return {
    zh: `当前版本 ${ctx.version}，渠道「${channel}」已是最新，该渠道没有更高的版本。`,
    en: `Current version ${ctx.version}, channel "${channel}": already up to date, the channel has no higher version.`,
  }
}

/** 分类 + 上下文 → 界面文案（含「可重试 / 不可重试」的明确说明） */
export const describeUpdateFailure = (
  failure: UpdateFailure,
  ctx: UpdateFailureContext
): UpdateFailureView => {
  const lang: FailureLocale = ctx.locale ?? 'zh'
  const label = LABELS[failure.kind][lang]
  const detail = detailOf(failure, ctx, lang)[lang]
  // 「无可用版本」「已取消」不是故障：不摆重试失败的口吻，直接说清现状
  const hint =
    failure.kind === 'no-version' || failure.kind === 'cancelled'
      ? ''
      : (failure.retryable ? RETRY_HINT : NO_RETRY_HINT)[lang]
  return {
    kind: failure.kind,
    code: failure.code,
    label,
    detail,
    retryable: failure.retryable,
    text: `${label}${JOIN[lang]}${detail}${hint}`,
  }
}

/** 检查成功且没有更新时的界面文案（issue #310 验收：无新版也要说清版本号） */
export const describeUpToDate = (ctx: UpdateFailureContext): UpdateFailureView =>
  describeUpdateFailure(updateFailureOf('NO_VERSION'), ctx)
