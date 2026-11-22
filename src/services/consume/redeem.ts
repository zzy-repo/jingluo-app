/**
 * 卡密兑换 —— Issue #484 §3.4 / §五（**全仓最不能写错的一段**），W1-A。
 *
 *   POST /api/v1/redeem          兑换卡密 → 余额（请求体只有 `{code}`，JWT）
 *   GET  /api/v1/redeem/history  兑换历史（**幂等补偿**的判断依据）
 *
 * 为什么这里绝不能「失败就重试」（#484 §4.3 / §五）：
 *   sub2api 的兑换**没有幂等键**（`redeem_handler.go` 只收 `code`），保护措施只有针对**码**的
 *   分布式锁。于是超时之后：
 *     · 上一次其实成功了 → 再发一次得到 `409 REDEEM_CODE_USED`，用户看到的是「卡被别人用了」；
 *     · 上一次其实没成功 → 用户以为兑换过，卡还在自己手里但界面说失败。
 *   两种都不可接受。所以本模块的规则是：
 *
 *     ① 第一发**只发一次**（超时也不重发）；
 *     ② 不确定成败时（超时 / 连不上 / 5xx）→ 先查 `GET /api/v1/redeem/history` 核对是否已到账；
 *     ③ 已到账 → 按成功返回（`credited: 'history'`），文案提示「已到账，无需重复兑换」；
 *     ④ 未到账 / 查不到 → 返回 `pending`（`canRetry: true`），**由用户手动确认后**再调一次
 *        （`retryAfterConfirm: true`）—— 客户端不许自己重开那一枪；
 *     ⑤ `409 REDEEM_CODE_LOCKED` 是「正在处理」，**不是失败**，禁止提示换卡（#484 §4.4）；
 *     ⑥ **`202` / `status:"accepted|processing|pending"` 是「已受理，结果待定」，不等于到账**
 *        （契约 §4 的异步形状）：同样先查一次 history，**只有核对确认到账才回 `redeemed`**，
 *        否则回 `processing`（不给 `canRetry` —— 服务端已经接了单，再打一枪就是重复兑换）。
 *
 * #840 补的第 ⑦ 条（这条是重复兑换显示成功的根因）：
 *   **`4xx` 一律是终态，不回查历史。** `409 REDEEM_CODE_USED`（别人已兑换 / 自己以前兑换）与
 *   `409 REDEEM_CODE_ALREADY_REDEEMED`（本人已兑换）直接按失败返回、直接显示服务端 `message`。
 *   历史里「有这张卡」证明不了「这一次成功」—— 它同样能证明「这张卡以前就兑换过」。
 *
 * 另外两条：
 *   - 卡密原文只在请求体里出现，**不进日志、不进 query、不落任何上报字段**（只露尾 4 位由 UI 自己 mask）；
 *   - 到账语义是「余额 / 并发 / 订阅进了 sub2api 账号」，不是客户端账本 —— 客户端不缓存额度（#484 §4.5 第 10 条）；
 *   - 兑换成功后**调用方要重拉 `GET /api/v1/user/profile`**（`refreshProfile`）刷新 `balance`，
 *     **不是**刷新某把 Key 的 `quota`（#676 §五 / §九 第 3 条：余额口径统一为元，Key 的旧额度已迁进 balance）。
 */

import { isRedeemLocked, type Sub2ApiError } from './errors.js'
import type { ConsumeCallResult, ConsumeHttp } from './http.js'

/** 兑换成功体（`redeem_handler.go` 的 `{message, type, value, new_balance?, new_concurrency?}`） */
export type ConsumeRedeemResult = {
  message: string
  /** `balance`（元）/ `concurrency`（整数）/ `subscription`（天数）/ `invitation` */
  type: string
  /** 面值：`balance` 是元、`concurrency` 是并发数、`subscription` 是天数 */
  value: number
  /** 兑换后的账户余额（元），服务端给了才有 */
  newBalance?: number
  /** 兑换后的并发上限，服务端给了才有 */
  newConcurrency?: number
}

/** 兑换历史的分页信封（字段名服务端可能演，这里按分页取、拿不到就当空） */
export type ConsumeRedeemHistoryItem = {
  /** 卡密码：可能是全码，也可能被服务端打码（`MUSE-****-1234`） */
  code?: string
  type?: string
  value?: number
  createdAt?: string
  raw: Record<string, unknown>
}

export type ConsumeRedeemHistory = { items: ConsumeRedeemHistoryItem[]; total: number }

/** 到账核对结果：`credited` 已到账 / `not_credited` 确认没到账 / `unknown` 查不出来（不能据此重试） */
export type ConsumeCreditedCheck = 'credited' | 'not_credited' | 'unknown'

/** 兑换的四种结局（`pending` ≠ 失败，`processing` ≠ 失败） */
export type ConsumeRedeemOutcome =
  | {
      kind: 'redeemed'
      /** 判定依据：`response` = 服务端直接回了到账；`history` = 查历史确认已到账（超时 / 连不上 / 5xx / 202 受理态走这条） */
      credited: 'response' | 'history'
      result: ConsumeRedeemResult
      /**
       * 「该重拉哪个接口」的唯一提示：**`/api/v1/user/profile` 的 `balance`**（#676 §五）。
       *
       * 到账进的是 `user.balance`，**不是某把 Key 的 `quota`** —— 所以这里不再叫 `refreshUsage`
       * （那个名字会把人引去刷 `/v1/usage`，读到的是 Key 的额度而不是账户余额）。恒为 `true`：
       * 兑换成功后**没有**不需要刷新余额的情况。
       */
      refreshProfile: boolean
    }
  | {
      kind: 'pending'
      error: Sub2ApiError
      /** 到账核对结果：`not_credited` 才能重试，`unknown` 必须先让用户自己去看一眼 */
      verified: ConsumeCreditedCheck
      /** 是否已经重试过一次（同一张卡最多两次 POST，且第二次必须由用户确认） */
      retried: boolean
      /** 永远为 true：重试要用户手动点，不许自动 */
      canRetry: boolean
    }
  | {
      kind: 'processing'
      error: Sub2ApiError
      /**
       * 到账核对结果：受理态（`202`）会核对一次 history 才给结论，所以这里带得出来；
       * `REDEEM_CODE_LOCKED`（409）不核对，故可选。`not_credited` / `unknown` 都**不代表失败**。
       */
      verified?: ConsumeCreditedCheck
    }
  | { kind: 'failed'; error: Sub2ApiError; verified: ConsumeCreditedCheck }

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const toRedeemResult = (value: unknown): ConsumeRedeemResult => {
  const body = asRecord(value)
  const out: ConsumeRedeemResult = {
    message: str(body.message),
    type: str(body.type),
    value: num(body.value) ?? 0,
  }
  const newBalance = num(body.new_balance)
  if (newBalance !== undefined) {out.newBalance = newBalance}
  const newConcurrency = num(body.new_concurrency)
  if (newConcurrency !== undefined) {out.newConcurrency = newConcurrency}
  return out
}

/** 首发的 POST（**只发一次**，绝不在这里加重试循环） */
const postRedeem = (http: ConsumeHttp, code: string): Promise<ConsumeCallResult<ConsumeRedeemResult>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/redeem', body: { code }, timeout: 'redeem' })
    .then((result) => (result.ok ? { ...result, data: toRedeemResult(result.data) } : result))

/** 兑换历史（只读，可重试）：幂等补偿与「已到账」判定的唯一依据 */
export const getRedeemHistory = (
  http: ConsumeHttp,
  query: { page?: number; pageSize?: number } = {}
): Promise<ConsumeCallResult<ConsumeRedeemHistory>> =>
  http
    .call<unknown>({
      method: 'GET',
      path: '/api/v1/redeem/history',
      query: { page: query.page ?? 1, page_size: query.pageSize ?? 20 },
      timeout: 'read',
    })
    .then((result) => (result.ok ? { ...result, data: toRedeemHistory(result.data) } : result))

const toRedeemHistory = (value: unknown): ConsumeRedeemHistory => {
  const body = asRecord(value)
  // 服务端可能回数组，也可能回分页信封（`{items:…}`）：两种都认，认不出来就是空列表
  const rawItems = Array.isArray(value) ? value : Array.isArray(body.items) ? body.items : []
  const items = rawItems.map((item): ConsumeRedeemHistoryItem => {
    const record = asRecord(item)
    const entry: ConsumeRedeemHistoryItem = { raw: record }
    if (typeof record.code === 'string') {entry.code = record.code}
    if (typeof record.card_no === 'string') {entry.code = record.card_no}
    if (typeof record.type === 'string') {entry.type = record.type}
    const amount = num(record.value)
    if (amount !== undefined) {entry.value = amount}
    if (typeof record.created_at === 'string') {entry.createdAt = record.created_at}
    return entry
  })
  return { items, total: num(body.total) ?? items.length }
}

/** 收集一条历史记录里所有字符串值（字段名会变，所以按**值**比对，不按字段名） */
const collectStrings = (value: unknown, out: string[], depth = 0): void => {
  if (depth > 4 || out.length > 64) {return}
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {collectStrings(item, out, depth + 1)}
    return
  }
  const record = asRecord(value)
  for (const item of Object.values(record)) {collectStrings(item, out, depth + 1)}
}

/** 归一化：去掉分隔符与大写（`MUSE-ABCD-1234` 与打码形态都能对上） */
const normalizeCode = (value: string): string => value.replace(/[^0-9A-Za-z]/g, '').toUpperCase()

/**
 * 这条历史记录是不是本次兑换的那张卡。
 *
 * 判据：归一化后**包含完整卡密**，或**以卡密尾 4 位结尾**（服务端可能把中间打码成 `****`）。
 * 尾 4 位是唯一能被 mask 保住的片段，也是 `mask.ts` 既有的口径。
 */
export const matchesRedeemCode = (item: ConsumeRedeemHistoryItem, code: string): boolean => {
  const target = normalizeCode(code)
  if (target === '') {return false}
  const tail = target.slice(-4)
  const strings: string[] = []
  collectStrings(item.raw, strings)
  if (item.code) {strings.push(item.code)}
  return strings.some((value) => {
    const candidate = normalizeCode(value)
    if (candidate === '') {return false}
    if (candidate.includes(target)) {return true}
    // 打码形态：`MUSE****1234` → 只信尾 4 位，且长度要比尾 4 位明显长（避免「1234」这种误判）
    return tail.length === 4 && candidate.endsWith(tail) && candidate.length >= tail.length + 4
  })
}

/**
 * 到账核对：**先历史，后余额**，两者都查不出来就老实说 `unknown`。
 *
 * 为什么不在查不到时当成「没到账」：`/redeem/history` 只翻第一页（20 条），刚兑换的那条一定在最新一条，
 * 但如果接口不通 / 分页字段变了，空结果和「没兑换」长得一模一样。把不可知当已知是最贵的错。
 */
export const verifyCredited = async (http: ConsumeHttp, code: string): Promise<ConsumeCreditedCheck> => {
  const history = await getRedeemHistory(http, { page: 1, pageSize: 20 })
  if (history.ok) {
    return history.data.items.some((item) => matchesRedeemCode(item, code)) ? 'credited' : 'not_credited'
  }
  return 'unknown'
}

/** 服务端表达「已受理、结果待定」的三个状态字（与 `202` 同义，见契约 §4 的异步形状） */
const ACCEPTED_STATUS = new Set(['accepted', 'processing', 'pending'])

/** 体里的受理状态字：面板信封的 `status` 与 `data.status` 两种放法都认，取不到就是空串 */
const statusWordOf = (json: unknown): string => {
  const body = asRecord(json)
  return (str(body.status) || str(asRecord(body.data).status)).toLowerCase()
}

/** 成功返回的 `call()` 结果（`ok: true` 的那一支） */
type RedeemOkResult = Extract<ConsumeCallResult<ConsumeRedeemResult>, { ok: true }>

/**
 * 这一发是不是「**已受理**」而不是「**已到账**」。
 *
 * 两种表达等价（契约 §4）：HTTP `202`，或体里 `status: accepted|processing|pending`。
 * 之所以要单独判：`202 {code:0,message:"accepted"}` 过 `http.call()` 时与
 * `200 {code:0,message:"success",data:{…}}` **长得一模一样**（都是 2xx + `code:0`），
 * 语义却差一个「结果还没定」（#512 记录的缺口 1）。
 */
const isAccepted = (result: RedeemOkResult): boolean =>
  result.status === 202 || ACCEPTED_STATUS.has(statusWordOf(result.raw.json))

/**
 * 受理态的定性：**只有 history 确认到账才算成功**（C11：结果不确定不许判成功，也不许盲目重试）。
 *
 * 三条出口：
 *   · 核对命中 → `redeemed`（`credited: 'history'`：结论来自历史，不是服务端那句 `accepted`）；
 *   · 核对未命中 → `processing`（`verified: 'not_credited'`）；
 *   · 核对本身失败 → `processing`（`verified: 'unknown'`，不可知不许当没到账）。
 *
 * 两条出口都**不给 `canRetry`**：服务端已经接单，用户点「再试一次」就会变成重复兑换 ——
 * 界面按 `consumeRedeemProcessing`（「正在确认兑换结果」）提示，需要时再轮询一次 `redeem.history()`。
 */
const settleAccepted = async (
  http: ConsumeHttp,
  code: string,
  result: RedeemOkResult
): Promise<ConsumeRedeemOutcome> => {
  const verified = await verifyCredited(http, code)
  if (verified === 'credited') {
    return { kind: 'redeemed', credited: 'history', result: result.data, refreshProfile: true }
  }
  return {
    kind: 'processing',
    verified,
    error: {
      kind: 'redeem',
      // 自造码（服务端只给了「已受理」）：排查时能一眼看出「这是 202，不是业务失败」
      code: 'REDEEM_ACCEPTED',
      message: result.data.message,
      status: result.status,
      retryable: false,
      envelope: 'panel',
      i18nKey: 'consumeRedeemProcessing',
    },
  }
}

/**
 * 兑换卡密（**幂等补偿版**，语义见文件头）。
 *
 * @param input.code             卡密（唯一入参；sub2api 不收 `request_id`，自造一个会被静默忽略）
 * @param input.retryAfterConfirm 用户**明确确认**「我查过没到账，再试一次」之后才传 true。
 *                                不传 = 只发一次；`pending` 由界面提示用户自己确认。
 */
export const redeemCode = async (
  http: ConsumeHttp,
  input: { code: string; retryAfterConfirm?: boolean }
): Promise<ConsumeRedeemOutcome> => {
  const code = input.code.trim()
  if (code === '') {
    return {
      kind: 'failed',
      verified: 'unknown',
      error: {
        kind: 'bad_request',
        code: 'REDEEM_CODE_EMPTY',
        message: '卡密为空',
        status: 0,
        retryable: false,
        envelope: 'none',
        i18nKey: 'consumeErrBadRequest',
      },
    }
  }

  const first = await postRedeem(http, code)
  const outcome = await interpret(http, code, first, false)
  if (outcome.kind === 'pending' && input.retryAfterConfirm === true) {
    const second = await postRedeem(http, code)
    return interpret(http, code, second, true)
  }
  return outcome
}

/** 把一次 POST 的结果翻译成四态；不确定成败的一律先核对到账，再决定能不能重试 */
const interpret = async (
  http: ConsumeHttp,
  code: string,
  result: ConsumeCallResult<ConsumeRedeemResult>,
  retried: boolean
): Promise<ConsumeRedeemOutcome> => {
  if (result.ok) {
    // 2xx 不等于到账：`202 accepted` / `status:"processing"` 是「受理，结果待定」→ 先核对 history 再定性
    if (isAccepted(result)) {return settleAccepted(http, code, result)}
    return { kind: 'redeemed', credited: 'response', result: result.data, refreshProfile: true }
  }
  const error = result.error

  // 「正在处理」不是失败：禁止提示换卡，也不重试（锁释放前再打只会更慢）
  if (isRedeemLocked(error)) {return { kind: 'processing', error }}

  /**
   * **#840：4xx 一律是终态，不回查历史。**
   *
   * 历史回查原本是给「网络超时、请求其实成功了」兜底的，但它分不清两件事：
   *   · 这次兑换成功了，只是响应丢了；
   *   · 这张卡**以前**就兑换过，这次是重复点击。
   * 两种情况下历史里都有这张卡，于是 409 `REDEEM_CODE_USED` 被当成「自己上次成功」判成功 ——
   * 页面显示「兑换成功」，余额却没变。现在起：只有**没拿到结论**的失败才去核对
   * （传输层失败 `status === 0` / 5xx），4xx（含 `REDEEM_CODE_USED` /
   * `REDEEM_CODE_ALREADY_REDEEMED` / `REDEEM_CODE_DISABLED` / `REDEEM_CODE_EXPIRED` /
   * `REDEEM_CODE_NOT_FOUND` / 429）直接按失败返回，界面显示服务端 `message`。
   */
  if (error.status !== 0 && error.status < 500) {
    return { kind: 'failed', error, verified: 'unknown' }
  }

  // 传输层（超时 / 连不上）/ 5xx：结果不可知 → 查历史，未到账才允许（由用户确认后）重试
  const verified = await verifyCredited(http, code)
  if (verified === 'credited') {
    return {
      kind: 'redeemed',
      credited: 'history',
      result: { message: error.message, type: '', value: 0 },
      refreshProfile: true,
    }
  }
  return { kind: 'pending', error, verified, retried, canRetry: true }
}
