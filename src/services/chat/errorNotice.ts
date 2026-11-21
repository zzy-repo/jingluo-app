import type { TranslationKey } from '../../i18n/index.js'
import { isRetryableStatus, type ApiErrorCondition } from '../api/errors.js'
import { shouldRetryStreamTimeout } from './timeoutPolicy.js'

/**
 * 报错的**表驱动分类矩阵**（#771）。
 *
 * 为什么要有这张表：#568 把超时拆成三段之后，`chat/store.ts` 里长出了一串嵌套三元
 * （`condition === 'contextLimit' ? … : condition === 'insufficientBalance' ? … : 401 ? …`），
 * 而 `describe.ts` 又按 `classifyErrorSignature` 的结果另写了一遍 switch。同一件事
 * 「这条失败该说什么、能不能重试、要不要给重新生成按钮」被拆在两个文件里，
 * review 时无法逐行核对，也说不清「哪些场景其实落进了 replyUnknownError」。
 *
 * 这里把它收成**一张表**（照 `chat/timeoutPolicy.ts` 的先例）：一行 = 一个场景，
 * 判据 → 文案 key → 是否可重试 → 是否显示「重新生成」。用法：
 *
 * ```ts
 * const ctx = errorNoticeContextOf(error)   // 分类只算一次
 * const row = pickErrorNotice(ctx)          // 第一行命中即用，最后一行是兜底
 * ```
 *
 * 三条纪律：
 * 1. **判据复用既有分类**（`classifyApiError` / `classifyErrorSignature` 的 condition、
 *    `timeoutPolicy` 的重试矩阵），本文件不新造判定逻辑，只做「判定结果 → 文案」的映射；
 * 2. **`replyUnknownError` 只出现在最后一行**（真未知：没有状态码、没有上游 code、也没有任何
 *    可读原文）。任何能判定的场景走到它都是 bug，`pickErrorNotice` 的返回值里 `id === 'unknown'`
 *    只可能在那一行；
 * 3. **文案不许与阶段矛盾**：连接段失败（`connect_timeout`）用的是「连不上上游」那套话，
 *    「已连上」只属于首字超时（`first_token_timeout`）那一行。
 *
 * 中英文案在 `src/i18n/zh.ts` / `en.ts` 成对维护（`node scripts/check-i18n.mjs` 会拦住缺项），
 * 本文件只引用 key，不写文案。
 */

/** 表格行 id：日志 / 用例 / 排查时按它对齐，不用记文案 key */
export type ErrorNoticeId =
  | 'connectTimeout'
  | 'firstTokenTimeout'
  | 'idleTimeout'
  | 'idleStalled'
  | 'emptyStream'
  | 'upstreamReturnedHtml'
  | 'streamInterrupted'
  | 'networkUnreachable'
  | 'unauthorized'
  | 'insufficientBalance'
  | 'rateLimited'
  | 'serverBusy'
  | 'contentFilter'
  | 'modelInvalid'
  | 'badRequest'
  | 'contextLimit'
  | 'upstreamRejected'
  | 'unclassified'
  | 'unknown'

/**
 * 判定用的最小输入：请求层（`ApiError`）与界面层（落盘的 error）都能给出这些字段，
 * 两边走**同一张表**，不会出现「日志说额度不足、界面说网络异常」（#299 的口径）。
 */
export type ErrorNoticeContext = {
  /** `ApiError.kind`：http / stream / network / interrupted / protocol / timeout / idle / upload */
  kind?: string
  /** 客户端错误码（`ApiError.code`）：connect_timeout / first_token_timeout / idle_timeout / … */
  code?: string
  status?: number
  /** 上游响应体里的机器可读码（error.code / error.type） */
  upstreamCode?: string
  /** `classifyApiError` / `classifyErrorSignature` 的结论 */
  condition?: ApiErrorCondition
  /** 当前渠道（`ours` = 我们的渠道，401 的出路不同） */
  providerKind?: string
  /** 上游点名的字段（400 / 422，#347 / #353） */
  field?: string
  /** 这一轮是否已经向用户输出过内容（空闲超时能不能重发就看它） */
  receivedContent?: boolean
  /**
   * 报错原文里有没有**能给人看的内容**（中文 / 日文 / 韩文原话）。
   * 未分类那一档靠它判断「是不是一点都不自证」——英文内部报错不算，那种只进折叠区。
   */
  hasReadableText?: boolean
}

/** 行上附带的入口：文案里说「去某处」，界面上就得有一个能点的东西 */
export type ErrorNoticeAction = 'apiKey' | 'topUp' | 'settings'

export type ErrorNoticeRow = {
  id: ErrorNoticeId
  /** 判据的人话版本（逐行 review 用；机器判据在 `match` 里） */
  criterion: string
  match: (ctx: ErrorNoticeContext) => boolean
  /** 文案 key；同一档按渠道 / 字段分两句时用函数 */
  key: TranslationKey | ((ctx: ErrorNoticeContext) => TranslationKey)
  /**
   * 原则上能不能重试（= 自动重试与「文案说可以重试」共用的口径）。
   * 超时三行直接问 `chat/timeoutPolicy.ts`，不在这里写第二份判据。
   */
  retryable: boolean | ((ctx: ErrorNoticeContext) => boolean)
  /** 是否显示「重新生成」按钮：终态错误（Key / 额度 / 参数 / 内容拦截）点了也一样 */
  regenerate: boolean | ((ctx: ErrorNoticeContext) => boolean)
  action?: ErrorNoticeAction
  /**
   * 这一行的文案带占位符，取值只有**渲染时**才有（上游点名的字段、可用模型列表、诊断短码）。
   * 这类行不落盘 `localMessage` —— 塞一个不带参数 key 进消息里，界面就会显示未替换的模板
   * （「请求参数有误（{status}）」），由 `describe.ts` 渲染时按落盘信息补齐。
   */
  paramsFromRenderer?: boolean
}

const hasUpstreamCode = (ctx: ErrorNoticeContext): boolean =>
  typeof ctx.upstreamCode === 'string' && ctx.upstreamCode.trim().length > 0

/**
 * 「未分类」里还能不能自证：有状态码 / 上游 code / 能给人看的原文，就比一句「未知错误」有用。
 *
 * 这里**刻意不看** `ApiError.message`：客户端的 message 就是我们自己那句本地化文案
 * （「连接中断…」），拿它当证据会让**每一类**失败都变成「未分类」，
 * `replyUnknownError` 就永远不可达了（#324 的负向口径）。
 */
const selfEvident = (ctx: ErrorNoticeContext): boolean =>
  typeof ctx.status === 'number' || hasUpstreamCode(ctx) || ctx.hasReadableText === true

/**
 * 报错分类矩阵（唯一判定处，**顺序敏感**：第一条命中即用，顺序变了就是行为变了）。
 *
 * | 场景 | 判据 | 文案 key | 可重试 | 重新生成 |
 * | --- | --- | --- | --- | --- |
 * | 连接段超时 | `code=connect_timeout` | `requestTimeout` | ✅ | ✅ |
 * | 网络不可达 / DNS / 跨域 | `kind=network` 且无 `status` | `replyNetworkUnreachable` | ✅ | ✅ |
 * | 首字超时 | `code=first_token_timeout` | `replyFirstTokenTimeout` | ✅ | ✅ |
 * | 空闲超时 | `code=idle_timeout` | `replyIdleTimeout` | ⚠️ 仅未出字 | ✅ |
 * | 401 / Key 无效 | `status=401`（或 condition=unauthorized） | `apiKeyRejectedOurs` / `apiKeyRejected` | ❌ | ❌ |
 * | 429 限流 | `status=429` | `replyRateLimited` | ✅ | ✅ |
 * | 5xx / 502 / 504 | `status>=500` | `replyServerBusy` | ✅ | ✅ |
 * | 余额不足 | `condition=insufficientBalance` | `replyInsufficientBalance` | ❌ | ❌ |
 * | 参数 / 模型名错 | `replyBadRequest` / `replyModelInvalid` / `replyParamInvalid` | 同左 | ❌ | ❌ |
 * | 内容拦截 | `condition=contentFilter` | `replyContentFiltered` | ❌ | ❌ |
 * | 空响应 | `code=stream_empty` / `condition=emptyStream` | `replyEmptyStream` | ✅ | ✅ |
 * | 断流 | `kind=interrupted` | `replyStreamInterrupted` | ✅ | ✅ |
 * | 其余未分类 | 有状态码 / 上游 code / 原文 | `replyUnclassifiedRetryable` / `replyUnclassifiedFatal` | 按状态 | 同左 |
 * | 真未知（最后一道） | 什么都不自证 | `replyUnknownError` | ✅ | ✅ |
 *
 * 表外还有两行是既有分类的延续（`contextLimit` / `upstreamRejected` / `upstreamReturnedHtml`），
 * 它们本来就有固定文案，必须留在表里 —— 否则这些已知场景会掉进最后一行。
 */
export const ERROR_NOTICE_ROWS: readonly ErrorNoticeRow[] = [
  {
    id: 'connectTimeout',
    criterion: 'code=connect_timeout（发起到响应头超了 connectMs）',
    match: (ctx) => ctx.code === 'connect_timeout',
    // 连接段失败**不能说「已连上」**（那是首字超时的话）：这条只讲连不上 / 上游没接、
    // 检查网络与代理后再发。文案里 {seconds} 由请求层按实际阈值注入。
    key: 'requestTimeout',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'firstTokenTimeout',
    criterion: 'code=first_token_timeout（响应头到手，第一个 SSE 事件没来）',
    match: (ctx) => ctx.code === 'first_token_timeout',
    // 全表唯一可以说「已连上上游」的一行：连接确实通了，卡在模型出第一个字。
    key: 'replyFirstTokenTimeout',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'idleTimeout',
    criterion: 'code=idle_timeout（已经出过字之后连续一段没有新数据）',
    match: (ctx) => ctx.code === 'idle_timeout',
    key: 'replyIdleTimeout',
    // 已出字后重发会重答、可能重复计费 —— 判据问 timeoutPolicy，不在这里另写一遍
    retryable: (ctx) => shouldRetryStreamTimeout('idle_timeout', ctx.receivedContent ?? false) ?? false,
    regenerate: true,
  },
  {
    id: 'idleStalled',
    criterion: 'kind=idle（旧数据 / 没有 code 的空闲超时）',
    match: (ctx) => ctx.kind === 'idle',
    key: 'replyWaitingStalled',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'emptyStream',
    criterion: 'code=stream_empty 或 condition=emptyStream（200 却没有任何内容）',
    match: (ctx) => ctx.code === 'stream_empty' || ctx.condition === 'emptyStream',
    key: 'replyEmptyStream',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'upstreamReturnedHtml',
    criterion: 'code=upstream_returned_html 或 condition=upstreamReturnedHtml（打到了网关 / 报错页）',
    match: (ctx) =>
      ctx.code === 'upstream_returned_html' || ctx.condition === 'upstreamReturnedHtml',
    key: 'upstreamReturnedHtml',
    retryable: false,
    regenerate: false,
  },
  {
    id: 'streamInterrupted',
    criterion: 'kind=interrupted（流在 message_stop 之前结束）',
    match: (ctx) => ctx.kind === 'interrupted',
    key: 'replyStreamInterrupted',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'networkUnreachable',
    criterion: 'kind=network 且没有 status（断网 / DNS / 跨域，请求没到上游）',
    match: (ctx) => ctx.kind === 'network' && typeof ctx.status !== 'number',
    // 明说「不是上游慢」：这句是用户最常搞错的一步（以为是模型慢，实际是本地网络 / 代理）
    key: 'replyNetworkUnreachable',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'unauthorized',
    criterion: 'status=401 或 condition=unauthorized（Key 无效 / 过期 / 被吊销）',
    match: (ctx) => ctx.status === 401 || ctx.condition === 'unauthorized',
    // #596：我们的渠道没有「重新填写」这条路，只有「重新领取」—— 两句分开，别把人指到不存在的输入框
    key: (ctx) => (ctx.providerKind === 'ours' ? 'apiKeyRejectedOurs' : 'apiKeyRejected'),
    retryable: false,
    regenerate: false,
    action: 'apiKey',
  },
  {
    id: 'insufficientBalance',
    criterion: 'condition=insufficientBalance（402 / 上游说额度用完）',
    match: (ctx) => ctx.condition === 'insufficientBalance',
    key: 'replyInsufficientBalance',
    // 充值之前重发多少次都是同一个结果（#299）
    retryable: false,
    regenerate: false,
    action: 'topUp',
  },
  {
    id: 'rateLimited',
    criterion: 'status=429 或 condition=rateLimited',
    match: (ctx) => ctx.status === 429 || ctx.condition === 'rateLimited',
    key: 'replyRateLimited',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'serverBusy',
    criterion: 'status>=500 或 condition=serverBusy（5xx / 502 / 504）',
    match: (ctx) => ctx.condition === 'serverBusy' || (ctx.status ?? 0) >= 500,
    key: 'replyServerBusy',
    retryable: true,
    regenerate: true,
  },
  {
    id: 'contentFilter',
    criterion: 'condition=contentFilter（上游安全审核拦截）',
    match: (ctx) => ctx.condition === 'contentFilter',
    key: 'replyContentFiltered',
    // 原文重发一定还是被拦 => 换问法，不重试
    retryable: false,
    regenerate: false,
  },
  {
    id: 'modelInvalid',
    criterion: 'condition=modelInvalid（模型不存在 / 已下线）',
    match: (ctx) => ctx.condition === 'modelInvalid',
    key: 'replyModelInvalid',
    retryable: false,
    regenerate: false,
    action: 'settings',
    // 文案带 {model} / {models}：实际发出的模型名与上游可用列表都来自落盘原文
    paramsFromRenderer: true,
  },
  {
    id: 'contextLimit',
    criterion: 'condition=contextLimit（413 或上游说超出上下文上限）',
    match: (ctx) => ctx.condition === 'contextLimit',
    key: 'replyContextLimit',
    retryable: false,
    regenerate: false,
  },
  {
    id: 'badRequest',
    criterion: 'condition=badRequest / tooLarge 或 status=400 / 413 / 422（参数不合法）',
    match: (ctx) =>
      ctx.condition === 'badRequest' ||
      ctx.condition === 'tooLarge' ||
      ctx.status === 400 ||
      ctx.status === 422,
    // 上游点名了字段就用 replyParamInvalid（指到具体设置项），否则退到 replyBadRequest
    key: (ctx) => (ctx.field ? 'replyParamInvalid' : 'replyBadRequest'),
    retryable: false,
    regenerate: false,
    action: 'settings',
    // 文案里的 {status} / {field} 只有渲染时才知道（#347 / #353）
    paramsFromRenderer: true,
  },
  {
    id: 'upstreamRejected',
    criterion: 'condition=upstreamRejected（403 / 404 / 405 / 409 / 415）',
    match: (ctx) => ctx.condition === 'upstreamRejected',
    key: 'replyUpstreamRejected',
    retryable: false,
    regenerate: false,
    // 文案带 {status}
    paramsFromRenderer: true,
  },
  {
    id: 'unclassified',
    criterion: '未识别，但自证（有状态码 / 上游 code / 原文）',
    match: (ctx) => selfEvident(ctx),
    key: (ctx) => (isRetryableSignatureOf(ctx) ? 'replyUnclassifiedRetryable' : 'replyUnclassifiedFatal'),
    retryable: (ctx) => isRetryableSignatureOf(ctx),
    regenerate: (ctx) => isRetryableSignatureOf(ctx),
    // 文案带 {detail}（HTTP 状态码 + 上游短码），渲染时才有
    paramsFromRenderer: true,
  },
  {
    id: 'unknown',
    criterion: '真未知：没有状态码、没有上游 code、也没有原文（**只在最后一道**）',
    match: () => true,
    key: 'replyUnknownError',
    // 连错在哪都不知道时，重发是唯一能做的事；这也是改前的行为，不在这里收紧
    retryable: true,
    regenerate: true,
  },
]

/**
 * 「未分类」那两行的判据（#324 的既有口径）：没有状态码（请求没到达服务端）、429、5xx
 * 都还是临时故障，其余 4xx 重发也是同样结果。与请求层 `isRetryableStatus` 同口径。
 */
const isRetryableSignatureOf = (ctx: ErrorNoticeContext): boolean =>
  typeof ctx.status !== 'number' || isRetryableStatus(ctx.status)

/** 命中哪一行（第一条命中即用；最后一行的 `match` 恒为 true，所以永远有结果） */
export const pickErrorNotice = (ctx: ErrorNoticeContext): ErrorNoticeRow =>
  ERROR_NOTICE_ROWS.find((row) => row.match(ctx)) as ErrorNoticeRow

/** 某一行的文案 key（要看渠道 / 字段的行用函数形式） */
export const rowKey = (row: ErrorNoticeRow, ctx: ErrorNoticeContext): TranslationKey =>
  typeof row.key === 'function' ? row.key(ctx) : row.key

/** 这一行对应的文案 key */
export const errorNoticeKey = (ctx: ErrorNoticeContext): TranslationKey =>
  rowKey(pickErrorNotice(ctx), ctx)

/** 这一行能不能重试（自动重试与「文案说可以重试」共用这一个结论） */
export const errorNoticeRetryable = (ctx: ErrorNoticeContext): boolean => {
  const row = pickErrorNotice(ctx)
  return typeof row.retryable === 'function' ? row.retryable(ctx) : row.retryable
}

/** 要不要在界面上给「重新生成」按钮 */
export const errorNoticeRegenerate = (ctx: ErrorNoticeContext): boolean => {
  const row = pickErrorNotice(ctx)
  return typeof row.regenerate === 'function' ? row.regenerate(ctx) : row.regenerate
}
