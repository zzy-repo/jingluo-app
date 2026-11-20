/**
 * 「我们的渠道」卡密 / 支付服务的客户端契约层。
 *
 * 这一层只有纯逻辑：不碰 DOM、不 import @capacitor/*、不读 localStorage，
 * 所有网络请求都通过注入的 `OursTransport` 发出（原生 CapacitorHttp / Web fetch，
 * 见 transport.ts）。因此 Node 单测可以直接 import 本文件，用假 transport 断言
 * 「发了什么请求、怎么解释响应」。
 *
 * 服务端契约（2026-11-19 实测，地址取 `__ENDPOINTS__.pay.baseUrl`，全站 HTTPS）：
 *   GET  /api/plans                      → { plans: [{ id, name, price, points, currency, enabled }] }
 *                                          价格与积分由服务端决定，App 不得硬编码
 *                                          （Issue #331：套餐全线下架，现返回 {"plans": []}）
 *   GET  /api/pay-link                   → { ok, url, note } —— 联动小铺固定收款页地址
 *   POST /api/redeem {card_no, api_key, request_id}
 *                                        → { ok, card_no, points, api_key, sync }
 *                                          202 CREDIT_PENDING 是「处理中」，不是失败
 *   GET  /api/balance  Authorization: Bearer <Key>
 *                                        → { api_key: "…013812", valid: true }
 *                                          ⚠️ 只反映 Key 是否有效，**不返回剩余积分**：
 *                                          额度去消费侧后端读（services/consume/usage.ts），本层不持有账本
 *   错误统一 { code, message, request_id }
 *
 * Issue #331：支付已切到联动小铺 —— 收款页地址由 `/api/pay-link` 下发、在 App 内浏览器打开，
 * 付款后卡密由小铺直接发给买家。**我们不建单、不查单、不轮询**：老的 302 收银台、
 * 建单接口、查单接口与那一套订单轮询已整条删除（连函数名都没留），别再拼回来
 * （订单归属 cid / order_token 存档那套一并消失）；卡密兑换链路不受影响。
 *
 * 安全约束（硬性）：
 *   - API Key 只走 Authorization 请求头 / 请求体，**不进 URL query**。
 *   - 日志 / 提示文案里不出现完整 Key、完整卡密、带凭据的完整 URL：
 *     Key 只露尾 6 位，卡密只露尾 4 位；收款页地址只当作「要打开的链接」，不落日志。
 */

import { record, recordAction } from '../diagnostics/collector.js'
import { buildMeta } from '../diagnostics/fields.js'
import { formatMoney, formatMoneyValue, formatYuan, pointsToYuan } from '../../utils/money.js'
import { maskCard, maskKey, maskTail } from './mask.js'

export { maskCard, maskDeviceId, maskKey, maskTail } from './mask.js'

/**
 * 卡密 / 支付服务地址（HTTPS）：价格、积分、发卡、兑换都问它。
 *
 * 地址**不在源码里**：唯一来源是 `config/endpoints.json` 的 `pay.baseUrl`，构建期由 rspack 的
 * DefinePlugin 注入 `__ENDPOINTS__.pay.baseUrl`（Web）与 `BuildConfig.PAY_BASE`（原生），
 * 与 `services/consume` 用的是同一份端点表的另一组（#484 §6.1 / #484 §九 A6：源码零字面量）。
 */
export const OURS_API_BASE = __ENDPOINTS__.pay.baseUrl

/** 各接口的读超时（毫秒）；超时与网络错误在状态里分开，文案也不同 */
export const OURS_TIMEOUTS = {
  plans: 10000,
  keyProbe: 10000,
  redeem: 15000,
  /** Issue #331：收款页地址是一个只读的小接口，给 10s 足够（超时与网络错误分开给文案） */
  payLink: 10000,
} as const

/**
 * 一次请求的完整描述。
 *
 * `followRedirects` 在业务请求里**一律 false**：/buy 必须读 302 的 Location，
 * 跟随重定向会把 out_trade_no / order_token 一起丢掉，之后再也查不到单。
 */
export type OursHttpRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  followRedirects: boolean
}

/**
 * transport 结果：区分「拿到响应」与「连不上 / 超时」（后者没有 status）。
 * `location` 只在 3xx 时有值（/buy 的收银台地址就从这里取）。
 */
export type OursHttpResult =
  | { kind: 'response'; status: number; text: string; location?: string }
  | { kind: 'timeout' }
  | { kind: 'network' }

export type OursTransport = (request: OursHttpRequest) => Promise<OursHttpResult>

/** 界面文案的 key（与 i18n/zh.ts 的键一致；服务层只回 key，不拼文案） */
export type OursMessageKey =
  | 'oursQuotaNeedsClaim'
  | 'oursQuotaNeedsBind'
  | 'oursKeyProbeValid'
  | 'oursKeyProbeInvalid'
  | 'oursKeyProbeNetwork'
  | 'oursKeyProbeTimeout'
  | 'oursPlansFailed'
  | 'oursPlansLoading'
  | 'oursRedeemSuccess'
  | 'oursRedeemPending'
  | 'oursErrBadJson'
  | 'oursErrUnauthorized'
  | 'oursErrForbidden'
  | 'oursErrNotFound'
  | 'oursErrCardNotFound'
  | 'oursErrCardNotFoundOrExpired'
  | 'oursErrCardLeased'
  | 'oursErrApiKeyNotIssued'
  | 'oursErrCardUsed'
  | 'oursErrCardMissing'
  | 'oursErrKeyMissing'
  | 'oursErrKeyInvalid'
  | 'oursErrVerifyUnavailable'
  | 'oursErrRateLimited'
  | 'oursErrPlanNotFound'
  | 'oursErrPlanMissing'
  /** Issue #331：收款通道（联动小铺收款页）不可用 / 没能在 App 内打开 */
  | 'oursPayUnavailable'
  | 'oursPayOpenFailed'
  | 'oursErrCustomerNeedsKey'
  | 'oursErrNetwork'
  | 'oursErrTimeout'
  | 'oursErrInvalidResponse'
  | 'oursErrUnknown'

/** 错误码 → 文案 key（服务端 code 优先，其次按 HTTP 状态码兜底） */
export const OURS_ERROR_KEYS: Record<string, OursMessageKey> = {
  PLAN_NOT_FOUND: 'oursErrPlanNotFound',
  PLAN_MISSING: 'oursErrPlanMissing',
  BAD_INPUT: 'oursErrBadJson',
  BAD_JSON: 'oursErrBadJson',
  UNAUTHORIZED: 'oursErrUnauthorized',
  FORBIDDEN: 'oursErrForbidden',
  NOT_FOUND: 'oursErrNotFound',
  CARD_NOT_FOUND: 'oursErrCardNotFound',
  CARD_ALREADY_USED: 'oursErrCardUsed',
  /** 卡密已迁到本机池兑换通道（与「已被使用」是两件事，文案必须分开） */
  CARD_LEASED: 'oursErrCardLeased',
  CARD_MISSING: 'oursErrCardMissing',
  API_KEY_MISSING: 'oursErrKeyMissing',
  API_KEY_INVALID: 'oursErrKeyInvalid',
  VERIFY_UNAVAILABLE: 'oursErrVerifyUnavailable',
  RATE_LIMITED: 'oursErrRateLimited',
  /**
   * 客户编号不存在（实测 `{"code":"CID_UNKNOWN","message":"客户不存在，请回 App 重新领取 Key"}`）：
   * 只能靠重新领取 Key 解决 —— 复用现有文案，别让它落到 400 兜底的「请求格式有误」上。
   */
  CID_UNKNOWN: 'oursErrCustomerNeedsKey',
}

/** 没有 code 时按状态码给个能看的文案（404 到底是卡密还是订单，只有 code 能区分） */
export const OURS_STATUS_KEYS: Record<number, OursMessageKey> = {
  400: 'oursErrBadJson',
  401: 'oursErrUnauthorized',
  403: 'oursErrForbidden',
  404: 'oursErrNotFound',
  409: 'oursErrCardUsed',
  429: 'oursErrRateLimited',
  503: 'oursErrVerifyUnavailable',
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  if (text.trim() === '') {
    return { ok: false }
  }
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? { ok: true, value } : { ok: false }
  } catch {
    return { ok: false }
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readString = (record: Record<string, unknown> | null, field: string): string => {
  const value = record?.[field]
  return typeof value === 'string' ? value : ''
}

const readNumber = (record: Record<string, unknown> | null, field: string): number | null => {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300

/** 超时 / 连不上这类传输层问题，统一换成可重试的文案 key */
const transportFailure = (result: Exclude<OursHttpResult, { kind: 'response' }>): OursMessageKey =>
  result.kind === 'timeout' ? 'oursErrTimeout' : 'oursErrNetwork'

/** 服务端错误码 → 文案 key（先看 code，再看状态码） */
const messageKeyFor = (code: string, status: number): OursMessageKey =>
  OURS_ERROR_KEYS[code] ?? OURS_STATUS_KEYS[status] ?? 'oursErrUnknown'

// ------------------------------------------------------------------ 额度文案（元）

/**
 * 额度文案（**元**口径）：例 `formatPoints(300, t('oursPointsUnit'))` → zh「3.00 元」/ en「3.00 CNY」。
 *
 * 单位**必须**由调用方从 i18n key `oursPointsUnit` 传入（Issue #94）：本模块是纯逻辑层，
 * 不读语言 store，也**不许**再在这里写死「元」——写死过一次，en 语言下就上屏了中文。
 *
 * 数值口径（Issue #487 / 后端 8b12ab2）：**100 积分 = 1 元**，所以先把点数折算成元再上屏。
 * 早前「只显示积分、不做折算」（#75）是「1 元 = 100 积分」还没被后端确认时的妥协；维护者现在
 * 要求统一计量（1 元 = 1 额度，无 USD / 积分两套并列），旧口径作废。折算系数只有一处：
 * `src/utils/money.ts` 的 `POINTS_PER_YUAN`。
 */
export const formatPoints = (points: number, unit: string): string =>
  unit === '' ? formatYuan(pointsToYuan(points)) : `${formatMoneyValue(pointsToYuan(points))} ${unit}`

// ------------------------------------------------------------------ Key 校验

/**
 * Key 校验结果。**只回答「这把 Key 服务端认不认」**，不携带任何额度信息：
 * 额度属于消费侧后端（客户端不持有账本，读法见 services/consume/usage.ts），不要拿这里当余额用。
 */
export type OursKeyProbe =
  | { status: 'valid' | 'invalid'; keyTail: string }
  | { status: 'network' | 'timeout' | 'invalid-json'; keyTail: string }

/** 校验 Key：GET /api/balance + Authorization: Bearer <Key>，URL 里绝不带 Key */
export const probeApiKey = async (apiKey: string, transport: OursTransport): Promise<OursKeyProbe> => {
  const startedAt = Date.now()
  const key = apiKey.trim()
  const keyTail = key === '' ? '' : maskKey(key)
  /** 日志里的 Key 尾号：4 位（`maskKey` 是界面用的 6 位，两处口径分开，谁也不许放宽） */
  const logTail = key === '' ? 'none' : maskTail(key, 4)
  /** 最近一次拿到 HTTP 状态码（拿不到就保持 undefined，绝不写 0 冒充） */
  let httpStatus: number | undefined
  /**
   * 出口埋点（#312）：`valid / invalid / network / timeout / invalid-json` 五种结论必须能在
   * 日志里分开 —— 界面上它们只差一个图标颜色，「Key 无效」和「服务不可达」靠口述是分不出来的。
   * 503 与 401 都落到 `invalid`，所以再带上 `status`；Key 只留尾 4 位，原文不落库。
   */
  const settle = (probe: OursKeyProbe): OursKeyProbe => {
    recordAction('nav', 'ours-key-probe', {
      ...buildMeta({
        stage: 'quota.balance',
        durationMs: Date.now() - startedAt,
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
      }),
      result: probe.status,
      'key.tail': logTail,
    })
    return probe
  }
  if (key === '') {
    return settle({ status: 'invalid', keyTail })
  }
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/balance`,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.keyProbe,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return settle({ status: result.kind === 'timeout' ? 'timeout' : 'network', keyTail })
  }
  httpStatus = result.status
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return settle({ status: 'invalid-json', keyTail })
  }
  const body = asRecord(parsed.value)
  // 响应体里的 api_key 是打过码的（…013812）：仍然一律不读取、不返回、不落日志
  const valid = body?.valid === true
  return settle({ status: valid && isSuccessStatus(result.status) ? 'valid' : 'invalid', keyTail })
}

// ------------------------------------------------------------------ 套餐

export type OursPlan = {
  id: string
  name: string
  /** 价格（元）；格式化交给 formatPlanPrice */
  price: number
  /** 套餐给的额度，单位是旧体系的「积分」（100 积分 = 1 元，见 utils/money.ts 的 pointsToYuan） */
  points: number
  currency: string
  enabled: boolean
}

export type OursPlansState =
  | { status: 'success'; plans: OursPlan[] }
  /**
   * 套餐列表为空。**不是失败**：Issue #331 之后套餐已全线下架，服务端就是返回 `{"plans": []}`，
   * 把它报成「加载失败」会让用户以为是自己网络坏了、反复重试。
   * 调用方应当展示「套餐列表已下架，点『前往购买』到联动小铺选购」这类空态，购买入口照常可用。
   */
  | { status: 'empty' }
  | { status: 'error'; messageKey: OursMessageKey }

/**
 * 价格文案：`¥3.00`。币种按后端下发的 `currency` **按值渲染**（`CNY`→`¥`，认不得的退化成
 * `3.00 ABC`），符号映射只在 `src/utils/money.ts` 的 `CURRENCY_SYMBOLS` 里写一份。
 */
export const formatPlanPrice = (plan: OursPlan): string => formatMoney(plan.price, plan.currency)

/** 套餐副标题：`¥3.00 · 3.00 元` / `¥3.00 · 3.00 CNY`（单位从 i18n 传入，见 formatPoints） */
export const formatPlanMeta = (plan: OursPlan, unit: string): string =>
  `${formatPlanPrice(plan)} · ${formatPoints(plan.points, unit)}`

const parsePlan = (value: unknown): OursPlan | null => {
  const record = asRecord(value)
  const id = readString(record, 'id')
  if (id === '' || record === null) {
    return null
  }
  return {
    id,
    name: readString(record, 'name') || id,
    price: readNumber(record, 'price') ?? 0,
    points: readNumber(record, 'points') ?? readNumber(record, 'quota') ?? 0,
    currency: readString(record, 'currency') || 'CNY',
    enabled: record.enabled !== false,
  }
}

/** 拉套餐：GET /api/plans（价格与积分以服务端为准，前端不写死） */
export const fetchPlans = async (transport: OursTransport): Promise<OursPlansState> => {
  const startedAt = Date.now()
  /** 最近一次拿到 HTTP 状态码（连不上 / 超时没有状态码，就不写这个键） */
  let httpStatus: number | undefined
  /**
   * 出口埋点（#312）：401 / 503 / 空列表 / JSON 坏在界面上全收敛成一句 `oursPlansFailed`，
   * 只有日志能分开「套餐下架（empty）」与「真的拉失败了（error）」。失败另记一条 warning
   * 带 `reason`（= 文案 key），这样「是哪种失败」不用再从 msg 里猜。
   */
  const settle = (state: OursPlansState): OursPlansState => {
    const base = {
      ...buildMeta({
        stage: 'quota.plans',
        durationMs: Date.now() - startedAt,
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
      }),
      result: state.status,
    }
    if (state.status === 'error') {
      record('warning', 'warn', 'ours plans failed', { ...base, reason: state.messageKey })
      return state
    }
    record('nav', 'info', 'ours plans fetched', {
      ...base,
      count: state.status === 'success' ? state.plans.length : 0,
    })
    return state
  }
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/plans`,
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.plans,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return settle({ status: 'error', messageKey: transportFailure(result) })
  }
  httpStatus = result.status
  if (!isSuccessStatus(result.status)) {
    return settle({ status: 'error', messageKey: 'oursPlansFailed' })
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return settle({ status: 'error', messageKey: 'oursPlansFailed' })
  }
  const raw = asRecord(parsed.value)?.plans
  if (!Array.isArray(raw)) {
    return settle({ status: 'error', messageKey: 'oursPlansFailed' })
  }
  const plans = raw
    .map(parsePlan)
    .filter((plan): plan is OursPlan => plan !== null && plan.enabled)
  // 空列表是「套餐已下架」这个正常状态，不是错误（#331）：别让界面读成「加载失败」
  return settle(plans.length === 0 ? { status: 'empty' } : { status: 'success', plans })
}

// ------------------------------------------------------------------ 收款页（Issue #331）

/**
 * 联动小铺固定收款页地址：`GET /api/pay-link`。
 *
 * 只取地址，不建单：付款与发卡都由联动小铺负责，我们这边**没有订单**、也不轮询。
 * 地址**每次都现取**：小铺随时可能换链接，写死在客户端等于发版才能改价。
 */
export const payLinkUrl = (): string => `${OURS_API_BASE}/api/pay-link`

export type OursPayLinkState =
  | { status: 'ok'; url: string; note: string }
  | { status: 'error'; messageKey: OursMessageKey }

/**
 * 取收款页地址。每种失败都给可读文案，界面上绝不停在白屏：
 *  - 503 / `ok:false` / 其它非 2xx → 「收款通道暂不可用，请稍后再试」（oursPayUnavailable）
 *  - 连不上 / 超时               → 复用 oursErrNetwork / oursErrTimeout（可重试）
 *  - 非法 JSON / 缺 url / 非 https → 同样按「通道不可用」处理：地址不可信就绝不打开
 *
 * **必须走 `OursTransport`（原生 CapacitorHttp），不能裸 fetch**：`/api/pay-link`
 * 与 `/api/plans` 一样**不返回 `Access-Control-Allow-Origin`**（实测响应头只有
 * Server / Date / Content-Type / Content-Length / Connection）。在 App 的 WebView 里
 * （origin 是 `https://localhost`）裸 `fetch()` 会被 CORS 拦成 `Failed to fetch`，
 * 而原生网络栈不受同源策略约束 —— 这也是本渠道所有取数都只走 transport 的原因。
 * 服务端不改（不加 CORS），所以「发请求」这件事只能留在原生侧。
 */
export const fetchPayLink = async (transport: OursTransport): Promise<OursPayLinkState> => {
  const startedAt = Date.now()
  /** 最近一次拿到 HTTP 状态码（连不上 / 超时没有状态码，就不写这个键） */
  let httpStatus: number | undefined
  /**
   * 出口埋点（#312）：这是「下单」这一步现在的唯一入口（#331 之后收款页地址现取、我们不再建单）。
   * 打不开 / 地址不可信 / 通道 503 在界面都只变成一句提示，日志里必须能分开；
   * 注意**不记收款页 URL**（带签名与金额，见文件头安全约束），只记结论与状态码。
   */
  const settle = (state: OursPayLinkState): OursPayLinkState => {
    const base = {
      ...buildMeta({
        stage: 'quota.pay',
        durationMs: Date.now() - startedAt,
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
      }),
      result: state.status,
    }
    if (state.status === 'error') {
      record('warning', 'warn', 'ours pay link failed', { ...base, reason: state.messageKey })
      return state
    }
    record('nav', 'info', 'ours pay link resolved', base)
    return state
  }
  const result = await transport({
    method: 'GET',
    url: payLinkUrl(),
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.payLink,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return settle({ status: 'error', messageKey: transportFailure(result) })
  }
  httpStatus = result.status
  if (!isSuccessStatus(result.status)) {
    return settle({ status: 'error', messageKey: 'oursPayUnavailable' })
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return settle({ status: 'error', messageKey: 'oursPayUnavailable' })
  }
  const body = asRecord(parsed.value)
  if (body === null || body.ok !== true) {
    return settle({ status: 'error', messageKey: 'oursPayUnavailable' })
  }
  const url = readString(body, 'url').trim()
  if (!isOpenableCheckout(url)) {
    return settle({ status: 'error', messageKey: 'oursPayUnavailable' })
  }
  return settle({ status: 'ok', url, note: readString(body, 'note') })
}

// ------------------------------------------------------------------ 卡密兑换

export type OursRedeemResult =
  | { kind: 'success'; points: number; cardTail: string }
  /** 202 CREDIT_PENDING：服务端受理但还没记账，**不是失败** */
  | { kind: 'pending'; cardTail: string }
  | {
      kind: 'error'
      code: string
      messageKey: OursMessageKey
      cardTail: string
      /** 网络 / 超时 / 503 这类可以原样重试（沿用同一个 request_id） */
      retryable: boolean
    }

/**
 * request_id 固定用卡密本身。
 *
 * 服务端按 request_id 去重：同一张卡超时重发时，重发必须能被识别成同一笔，
 * 而 card_no 天然一一对应、不需要额外保存一份 id（也就少一处会丢的状态）。
 */
export const requestIdForCard = (cardNo: string): string => cardNo.trim()

export type OursRedeemInput = { cardNo: string; apiKey: string; requestId: string }

/**
 * 卡密兑换：POST /api/redeem。
 * - 202 / CREDIT_PENDING → kind='pending'（处理中，界面不能说「失败」，也不催用户重试）
 * - 409 CARD_ALREADY_USED → 提示不要重复提交
 * - 400 API_KEY_INVALID → 提示重填 Key；503 VERIFY_UNAVAILABLE → 可重试
 */
export const redeemCard = async (
  input: OursRedeemInput,
  transport: OursTransport
): Promise<OursRedeemResult> => {
  const startedAt = Date.now()
  const cardNo = input.cardNo.trim()
  const cardTail = cardNo === '' ? '' : maskCard(cardNo)
  /** 最近一次拿到 HTTP 状态码（连不上 / 超时没有状态码，就不写这个键） */
  let httpStatus: number | undefined
  /**
   * 出口埋点（#312）：202（受理）/ 409（已用过）/ 404（卡不存在）/ 503（校验服务不可用）
   * 在界面上是一句话，但含义完全不同 —— 用户付过钱之后的这一步必须留证据。
   * `pending` 单独一个 result 值，不许并进 error（服务端受理不是失败）。
   * 卡密只留尾 4 位；`request_id`（= 卡密原文）与 api_key 一个字都不落库。
   */
  const settle = (outcome: OursRedeemResult): OursRedeemResult => {
    const base = {
      ...buildMeta({
        stage: 'quota.redeem',
        durationMs: Date.now() - startedAt,
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
        ...(outcome.kind === 'error'
          ? { upstreamCode: outcome.code, retryable: outcome.retryable }
          : {}),
      }),
      result: outcome.kind,
      'card.tail': outcome.cardTail === '' ? 'none' : outcome.cardTail,
    }
    if (outcome.kind === 'error') {
      record('warning', 'warn', 'ours redeem failed', base)
    } else {
      record('nav', 'info', outcome.kind === 'pending' ? 'ours redeem pending' : 'ours redeem done', base)
    }
    return outcome
  }
  if (cardNo === '') {
    return settle({
      kind: 'error',
      code: 'CARD_MISSING',
      messageKey: 'oursErrCardMissing',
      cardTail,
      retryable: false,
    })
  }
  const key = input.apiKey.trim()
  if (key === '') {
    return settle({
      kind: 'error',
      code: 'API_KEY_MISSING',
      messageKey: 'oursErrKeyMissing',
      cardTail,
      retryable: false,
    })
  }
  const result = await transport({
    method: 'POST',
    url: `${OURS_API_BASE}/api/redeem`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ card_no: cardNo, api_key: key, request_id: input.requestId }),
    timeoutMs: OURS_TIMEOUTS.redeem,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return settle({
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
      cardTail,
      retryable: true,
    })
  }
  httpStatus = result.status
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  // 业务码兼容两种信封：顶层 {code}（本服务）与 {error:{code}}（本机池那条链路）
  const code = readString(body, 'code') || readString(asRecord(body?.error), 'code')
  if (result.status === 202 || code === 'CREDIT_PENDING') {
    return settle({ kind: 'pending', cardTail })
  }
  if (isSuccessStatus(result.status) && body !== null && body.ok === true) {
    return settle({ kind: 'success', points: readNumber(body, 'points') ?? 0, cardTail })
  }
  if (!parsed.ok && isSuccessStatus(result.status)) {
    return settle({
      kind: 'error',
      code: 'INVALID_RESPONSE',
      messageKey: 'oursErrInvalidResponse',
      cardTail,
      retryable: false,
    })
  }
  return settle({
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: messageKeyFor(code, result.status),
    cardTail,
    retryable: result.status >= 500,
  })
}

/** 收款页地址只接受 https（App 内浏览器也只放行 https），其余一律当作「没有支付入口」 */
export const isOpenableCheckout = (url: string): boolean => /^https:\/\//i.test(url.trim())
