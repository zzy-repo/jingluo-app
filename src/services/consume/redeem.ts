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
 *     ⑤ `409 REDEEM_CODE_LOCKED` 是「正在处理」，**不是失败**，禁止提示换卡（#484 §4.4）。
 *
 * 另外两条：
 *   - 卡密原文只在请求体里出现，**不进日志、不进 query、不落任何上报字段**（只露尾 4 位由 UI 自己 mask）；
 *   - 到账语义是「余额 / 并发 / 订阅进了 sub2api 账号」，不是客户端账本 —— 客户端不缓存额度（#484 §4.5 第 10 条）。
 */

import { isRedeemLocked, isRedeemUsed, type Sub2ApiError } from './errors.js'
import type { ConsumeCallResult, ConsumeHttp } from './http.js'

/** 兑换成功体（`redeem_handler.go` 的 `{message, type, value, new_balance?, new_concurrency?}`） */
export type ConsumeRedeemResult = {
  message: string
  /** `balance`（USD）/ `concurrency`（整数）/ `subscription`（天数）/ `invitation` */
  type: string
  /** 面值：`balance` 是 USD、`concurrency` 是并发数、`subscription` 是天数 */
  value: number
  /** 兑换后的账户余额（USD），服务端给了才有 */
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
      /** 判定依据：`response` = 服务端直接回了成功；`history` = 超时后查历史确认已到账 */
      credited: 'response' | 'history'
      result: ConsumeRedeemResult
      /** 重新拉一次余额用的提示（界面据此决定要不要刷新 `/v1/usage`） */
      refreshUsage: boolean
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
  | { kind: 'processing'; error: Sub2ApiError }
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
    return { kind: 'redeemed', credited: 'response', result: result.data, refreshUsage: true }
  }
  const error = result.error

  // 「正在处理」不是失败：禁止提示换卡，也不重试（锁释放前再打只会更慢）
  if (isRedeemLocked(error)) {return { kind: 'processing', error }}

  // 「已用过」可能是自己上一次成功（没有幂等键）→ 必须先查历史再定性
  if (isRedeemUsed(error)) {
    const verified = await verifyCredited(http, code)
    if (verified === 'credited') {
      return {
        kind: 'redeemed',
        credited: 'history',
        result: { message: error.message, type: '', value: 0 },
        refreshUsage: true,
      }
    }
    return { kind: 'failed', error, verified }
  }

  // 传输层 / 5xx：结果不可知 → 查历史，未到账才允许（由用户确认后）重试
  if (error.retryable) {
    const verified = await verifyCredited(http, code)
    if (verified === 'credited') {
      return {
        kind: 'redeemed',
        credited: 'history',
        result: { message: error.message, type: '', value: 0 },
        refreshUsage: true,
      }
    }
    return { kind: 'pending', error, verified, retried, canRetry: true }
  }

  // 明确的业务失败（码不存在 / 过期 / 参数错）：不重试，也不去猜
  return { kind: 'failed', error, verified: 'unknown' }
}
