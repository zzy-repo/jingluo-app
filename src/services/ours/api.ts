/**
 * 「我们的渠道」卡密服务的客户端契约层。
 *
 * 这一层只有纯逻辑：不碰 DOM、不 import @capacitor/*、不读 localStorage，
 * 所有网络请求都通过注入的 `OursTransport` 发出（原生 CapacitorHttp / Web fetch，
 * 见 transport.ts）。因此 Node 单测可以直接 import 本文件，用假 transport 断言
 * 「发了什么请求、怎么解释响应」。
 *
 * 服务端契约（2026-11-18 实测，端口 60012；6012 会连接超时）：
 *   GET  /api/plans                       → { plans: [{ id, name, price, quota, currency, enabled }] }
 *   GET  /api/balance                     → Authorization: Bearer <Key> → { api_key, balance }
 *                                           无 Authorization 时 200 { user_id: 0, balance: 0 }
 *                                           ⚠️ 所以 balance=0 不能判定为「Key 无效」
 *   POST /api/redeem   {card_no, api_key, request_id}
 *                                          → { ok, card_no, quota, api_key, balance_after, sync }
 *   GET  /api/order?out_trade_no=&order_token=
 *                                          → { out_trade_no, status, amount_fen, card_no, expire_at, message }
 *   POST /buy                              → { out_trade_no, order_token, pay_url:null }（网关未配置）
 *   错误统一 { code, message, request_id }
 *
 * 安全约束（硬性）：
 *   - API Key 只走 Authorization 请求头，**不进 URL query**（服务端只看头）。
 *   - 日志 / 提示文案里不出现完整 Key、完整卡密、带凭据的完整 URL：
 *     Key 只露尾 6 位，卡密只露尾 4 位，URL 只露 path。
 */

/** 卡密服务地址：注意端口是 60012（6012 不通） */
export const OURS_API_BASE = 'http://123.207.199.196:60012'

/**
 * 购买是否放开（beta.8 恒为 false）。
 *
 * 2026-11-18 实测：/buy 已经 302 到真实收银台 pay.xiaodouap.cn，但下单金额 money=0.10
 * 与套餐标价 9.90 不一致 —— 属资损风险，金额与套餐对齐并复核前一律不放开。
 * 界面上因此只保留一行「支付暂未开放」，不提供建单 / 查单入口：
 * 先建一单只会留下永远付不了款的订单，用户很容易误以为购买成功。
 * 下面的 createOrder / queryOrder / pollOrder 是完整契约实现（有单测覆盖），
 * 等支付放开后由界面接上即可。
 */
export const OURS_PAYMENT_OPEN = false

/** 各接口的读超时（毫秒）；超时与网络错误在状态里分开，文案也不同 */
export const OURS_TIMEOUTS = {
  balance: 10000,
  plans: 10000,
  redeem: 15000,
  order: 10000,
  buy: 12000,
  /** 订单轮询：间隔 2s、总时长上限 60s（不可调，契约要求） */
  poll: { intervalMs: 2000, timeoutMs: 60000 },
} as const

/** 一次请求的完整描述（`followRedirects` 恒为 false：/buy 要读 302 的 Location） */
export type OursHttpRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  followRedirects: false
}

/** transport 结果：区分「拿到响应」与「连不上 / 超时」（后者没有 status） */
export type OursHttpResult =
  | { kind: 'response'; status: number; text: string; location?: string }
  | { kind: 'timeout' }
  | { kind: 'network' }

export type OursTransport = (request: OursHttpRequest) => Promise<OursHttpResult>

/** 界面文案的 key（与 i18n/zh.ts 的键一致；服务层只回 key，不拼文案） */
export type OursMessageKey =
  | 'oursBalanceNeedsKey'
  | 'oursBalanceUnknown'
  | 'oursBalanceNetwork'
  | 'oursBalanceTimeout'
  | 'oursBalanceInvalidJson'
  | 'oursPlansFailed'
  | 'oursRedeemSynced'
  | 'oursRedeemPending'
  | 'oursRedeemNoDownstream'
  | 'oursRedeemIdempotent'
  | 'oursErrBadJson'
  | 'oursErrUnauthorized'
  | 'oursErrForbidden'
  | 'oursErrNotFound'
  | 'oursErrCardNotFound'
  | 'oursErrCardUsed'
  | 'oursErrCardMissing'
  | 'oursErrKeyMissing'
  | 'oursErrKeyInvalid'
  | 'oursErrRateLimited'
  | 'oursErrPlanNotFound'
  | 'oursErrOrderNotFound'
  | 'oursErrOrderTokenMissing'
  | 'oursOrderStatusPending'
  | 'oursOrderStatusPaid'
  | 'oursOrderStatusFulfilled'
  | 'oursOrderStatusExpired'
  | 'oursOrderStatusFailed'
  | 'oursErrNetwork'
  | 'oursErrTimeout'
  | 'oursErrInvalidResponse'
  | 'oursErrUnknown'

/** 错误码 → 文案 key（服务端 code 优先，其次按 HTTP 状态码兜底） */
export const OURS_ERROR_KEYS: Record<string, OursMessageKey> = {
  PLAN_NOT_FOUND: 'oursErrPlanNotFound',
  CARD_MISSING: 'oursErrCardMissing',
  API_KEY_MISSING: 'oursErrKeyMissing',
  API_KEY_INVALID: 'oursErrKeyInvalid',
  BAD_JSON: 'oursErrBadJson',
  UNAUTHORIZED: 'oursErrUnauthorized',
  FORBIDDEN: 'oursErrForbidden',
  CARD_NOT_FOUND: 'oursErrCardNotFound',
  ORDER_NOT_FOUND: 'oursErrOrderNotFound',
  CARD_ALREADY_USED: 'oursErrCardUsed',
  RATE_LIMITED: 'oursErrRateLimited',
}

/** 没有 code 时按状态码给个能看的文案（404 到底是卡密还是订单，只有 code 能区分） */
export const OURS_STATUS_KEYS: Record<number, OursMessageKey> = {
  400: 'oursErrBadJson',
  401: 'oursErrUnauthorized',
  403: 'oursErrForbidden',
  404: 'oursErrNotFound',
  409: 'oursErrCardUsed',
  429: 'oursErrRateLimited',
}

/** 卡密兑换的同步状态：synced 已同步下游 / pending 待同步 / no_downstream 只有本站记账 */
export type OursRedeemSync = 'synced' | 'pending' | 'no_downstream'

/** sync → 文案 key：no_downstream 绝不能写成「下游已到账」 */
export const REDEEM_SYNC_KEYS: Record<OursRedeemSync, OursMessageKey> = {
  synced: 'oursRedeemSynced',
  pending: 'oursRedeemPending',
  no_downstream: 'oursRedeemNoDownstream',
}

/** 脱敏：只保留尾部若干位，前面统一四个实心点（Key 默认 6 位、卡密 4 位） */
export const maskTail = (value: string, tail = 6): string => {
  const text = value.trim()
  if (text.length <= tail) {
    return '••••'
  }
  return `••••${text.slice(-tail)}`
}

/** Key 脱敏（尾 6 位） */
export const maskKey = (key: string): string => maskTail(key, 6)

/** 卡密脱敏（尾 4 位） */
export const maskCard = (cardNo: string): string => maskTail(cardNo, 4)

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

/** 超时 / 连不上 / 非法 JSON 这类传输层问题，统一换成可重试的文案 key */
const transportFailure = (result: Exclude<OursHttpResult, { kind: 'response' }>): OursMessageKey =>
  result.kind === 'timeout' ? 'oursErrTimeout' : 'oursErrNetwork'

// ------------------------------------------------------------------ 额度查询

/** 余额查询的终态（'loading' 由界面维护，服务层不产生） */
export type OursBalanceState =
  | { status: 'success'; balance: number; keyTail: string }
  | { status: 'unknown-balance'; keyTail: string }
  | { status: 'network'; keyTail: string }
  | { status: 'timeout'; keyTail: string }
  | { status: 'invalid-json'; keyTail: string }
  | { status: 'idle' }

/**
 * 查询兑换额度：GET /api/balance + Authorization: Bearer <key>，URL 里绝不带 Key。
 *
 * balance 的语义（实测）：没有携带 Authorization 时服务端仍返回 200 + balance:0，
 * 所以 0 只能解释成「查不到这个 Key 的额度，或额度本来就是 0」，不是错误、更不是「Key 无效」。
 */
export const fetchBalance = async (
  apiKey: string,
  transport: OursTransport
): Promise<OursBalanceState> => {
  const key = apiKey.trim()
  if (key === '') {
    return { status: 'idle' }
  }
  const keyTail = maskKey(key)
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/balance`,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.balance,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { status: result.kind === 'timeout' ? 'timeout' : 'network', keyTail }
  }
  // 鉴权失败也只说「查不到额度」：不把 Key 判死刑，更不提示额度不足
  if (result.status === 401 || result.status === 403) {
    return { status: 'unknown-balance', keyTail }
  }
  if (!isSuccessStatus(result.status)) {
    return { status: 'network', keyTail }
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return { status: 'invalid-json', keyTail }
  }
  // 响应体里的 api_key 是完整 Key：一律不读取、不返回、不落日志
  const balance = readNumber(asRecord(parsed.value), 'balance')
  if (balance === null || balance <= 0) {
    return { status: 'unknown-balance', keyTail }
  }
  return { status: 'success', balance, keyTail }
}

// ------------------------------------------------------------------ 套餐

export type OursPlan = {
  id: string
  name: string
  /** 价格（元）；格式化交给 formatPlanPrice */
  price: number
  /** 额度（token 数） */
  quota: number
  currency: string
  enabled: boolean
}

export type OursPlansState =
  | { status: 'success'; plans: OursPlan[] }
  | { status: 'error'; messageKey: OursMessageKey }

/** 价格文案：¥9.90 */
export const formatPlanPrice = (plan: OursPlan): string =>
  plan.currency === 'CNY' || plan.currency === ''
    ? `¥${plan.price.toFixed(2)}`
    : `${plan.price.toFixed(2)} ${plan.currency}`

/** 额度文案：1000000 → 100万；5000000 → 500万；100000000 → 1亿 */
export const formatQuota = (quota: number): string => {
  if (quota >= 100000000) {
    const value = quota / 100000000
    return `${Number.isInteger(value) ? value : value.toFixed(2)}亿`
  }
  if (quota >= 10000) {
    const value = quota / 10000
    return `${Number.isInteger(value) ? value : value.toFixed(2)}万`
  }
  return String(quota)
}

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
    quota: readNumber(record, 'quota') ?? 0,
    currency: readString(record, 'currency') || 'CNY',
    enabled: record.enabled !== false,
  }
}

/** 拉套餐：GET /api/plans（价格与额度以服务端为准，不在前端写死） */
export const fetchPlans = async (transport: OursTransport): Promise<OursPlansState> => {
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/plans`,
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.plans,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { status: 'error', messageKey: transportFailure(result) }
  }
  if (!isSuccessStatus(result.status)) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const raw = asRecord(parsed.value)?.plans
  if (!Array.isArray(raw)) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const plans = raw
    .map(parsePlan)
    .filter((plan): plan is OursPlan => plan !== null && plan.enabled)
  return plans.length === 0
    ? { status: 'error', messageKey: 'oursPlansFailed' }
    : { status: 'success', plans }
}

// ------------------------------------------------------------------ 卡密兑换

export type OursRedeemResult =
  | {
      kind: 'success'
      sync: OursRedeemSync
      /** IDEMPOTENT：同一卡密重复提交，服务端按成功处理 */
      idempotent: boolean
      /** 成功文案（同步状态 / 幂等） */
      messageKey: OursMessageKey
      balanceAfter: number | null
      cardTail: string
    }
  | {
      kind: 'error'
      code: string
      messageKey: OursMessageKey
      cardTail: string
      /** 网络 / 超时 / 服务端 5xx 这类可以原样重试（沿用同一个 request_id） */
      retryable: boolean
    }

/** 每次「逻辑提交」生成一个 request_id；重试必须复用同一个（服务端靠它去重） */
export const createRequestId = (now: number = Date.now(), random: number = Math.random()): string =>
  `redeem-${now}-${Math.round(random * 1e9).toString(36)}`

const readSync = (value: unknown): OursRedeemSync =>
  value === 'pending' || value === 'no_downstream' ? value : 'synced'

export type OursRedeemInput = { cardNo: string; apiKey: string; requestId: string }

/**
 * 卡密兑换：POST /api/redeem。
 * - request_id 由调用方传入（界面在「一次提交」里生成后一直复用，重试不换）
 * - IDEMPOTENT（200）按成功处理
 * - sync 决定文案：synced → 到账成功；pending → 到账成功，稍后自动同步；
 *   no_downstream → 只写「已在本站登记额度」，不能声称下游已到账
 */
export const redeemCard = async (
  input: OursRedeemInput,
  transport: OursTransport
): Promise<OursRedeemResult> => {
  const cardNo = input.cardNo.trim()
  const cardTail = maskCard(cardNo)
  if (cardNo === '') {
    return { kind: 'error', code: 'CARD_MISSING', messageKey: 'oursErrCardMissing', cardTail, retryable: false }
  }
  const key = input.apiKey.trim()
  if (key === '') {
    return { kind: 'error', code: 'API_KEY_MISSING', messageKey: 'oursErrKeyMissing', cardTail, retryable: false }
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
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
      cardTail,
      retryable: true,
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const code = readString(body, 'code')
  if (code === 'IDEMPOTENT') {
    return {
      kind: 'success',
      sync: readSync(readString(body, 'sync')),
      idempotent: true,
      messageKey: 'oursRedeemIdempotent',
      balanceAfter: readNumber(body, 'balance_after'),
      cardTail,
    }
  }
  if (isSuccessStatus(result.status) && body !== null && body.ok === true) {
    const sync = readSync(readString(body, 'sync'))
    return {
      kind: 'success',
      sync,
      idempotent: false,
      messageKey: REDEEM_SYNC_KEYS[sync],
      balanceAfter: readNumber(body, 'balance_after'),
      cardTail,
    }
  }
  if (!parsed.ok && isSuccessStatus(result.status)) {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse', cardTail, retryable: false }
  }
  return {
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: OURS_ERROR_KEYS[code] ?? OURS_STATUS_KEYS[result.status] ?? 'oursErrUnknown',
    cardTail,
    retryable: result.status >= 500,
  }
}

// ------------------------------------------------------------------ 订单

export type OursOrderStatus = 'pending' | 'paid' | 'fulfilled' | 'expired' | 'failed'

/** 终态：轮询到这些状态就停（paid 仍在等发卡，继续轮） */
const TERMINAL_ORDER_STATUSES: OursOrderStatus[] = ['fulfilled', 'expired', 'failed']

export const isTerminalOrderStatus = (status: OursOrderStatus): boolean =>
  TERMINAL_ORDER_STATUSES.includes(status)

export const ORDER_STATUS_KEYS: Record<OursOrderStatus, OursMessageKey> = {
  pending: 'oursOrderStatusPending',
  paid: 'oursOrderStatusPaid',
  fulfilled: 'oursOrderStatusFulfilled',
  expired: 'oursOrderStatusExpired',
  failed: 'oursOrderStatusFailed',
}

export type OursOrder = {
  outTradeNo: string
  status: OursOrderStatus
  amountFen: number
  /** 卡密只留尾 4 位；未发卡时为空串 */
  cardTail: string
  expireAt: string
}

export type OursOrderResult =
  | { kind: 'ok'; order: OursOrder }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

const parseOrderStatus = (value: string): OursOrderStatus | null =>
  value === 'pending' || value === 'paid' || value === 'fulfilled' || value === 'expired' || value === 'failed'
    ? value
    : null

const parseOrder = (value: unknown): OursOrder | null => {
  const record = asRecord(value)
  const status = parseOrderStatus(readString(record, 'status'))
  const outTradeNo = readString(record, 'out_trade_no')
  if (record === null || status === null || outTradeNo === '') {
    return null
  }
  const cardNo = readString(record, 'card_no')
  return {
    outTradeNo,
    status,
    amountFen: readNumber(record, 'amount_fen') ?? 0,
    // 只有 fulfilled 才有卡密；日志/界面都只留尾 4 位
    cardTail: status === 'fulfilled' && cardNo !== '' ? maskCard(cardNo) : '',
    expireAt: readString(record, 'expire_at'),
  }
}

/** 查单：GET /api/order?out_trade_no=&order_token=（order_token 必须带，否则 401） */
export const queryOrder = async (
  input: { outTradeNo: string; orderToken: string },
  transport: OursTransport
): Promise<OursOrderResult> => {
  const outTradeNo = input.outTradeNo.trim()
  const orderToken = input.orderToken.trim()
  if (outTradeNo === '' || orderToken === '') {
    return { kind: 'error', code: 'ORDER_TOKEN_MISSING', messageKey: 'oursErrOrderTokenMissing' }
  }
  const query = `out_trade_no=${encodeURIComponent(outTradeNo)}&order_token=${encodeURIComponent(orderToken)}`
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/order?${query}`,
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.order,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
    }
  }
  const parsed = parseJson(result.text)
  if (isSuccessStatus(result.status) && parsed.ok) {
    const order = parseOrder(parsed.value)
    return order === null
      ? { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse' }
      : { kind: 'ok', order }
  }
  const code = readString(parsed.ok ? asRecord(parsed.value) : null, 'code')
  return {
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: OURS_ERROR_KEYS[code] ?? OURS_STATUS_KEYS[result.status] ?? 'oursErrUnknown',
  }
}

/** 收银台地址只接受 https（原生插件也只放行 https），其余一律当作「没有支付入口」 */
export const isOpenableCheckout = (url: string): boolean => /^https:\/\//i.test(url.trim())

export type OursCreateOrderResult =
  | {
      kind: 'ok'
      outTradeNo: string
      /** 查单令牌：必须保存，界面拿它查 /api/order */
      orderToken: string
      /** null 表示网关未配置（当前线上就是 null）→ 购买按钮禁用 */
      payUrl: string | null
    }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

/**
 * 建单：POST /buy。
 * 请求层强制 `followRedirects: false`，只在 3xx 时读 Location 当收银台地址 ——
 * 跟随重定向会把 order_token 一起丢掉，之后再也查不到单。
 * 当前网关未配置：返回 { out_trade_no, order_token, pay_url: null }。
 */
export const createOrder = async (
  planId: string,
  transport: OursTransport
): Promise<OursCreateOrderResult> => {
  const result = await transport({
    method: 'POST',
    url: `${OURS_API_BASE}/buy`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ plan_id: planId }),
    timeoutMs: OURS_TIMEOUTS.buy,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const outTradeNo = readString(body, 'out_trade_no') || readString(body, 'outTradeNo')
  const orderToken = readString(body, 'order_token') || readString(body, 'orderToken')
  if (result.status >= 300 && result.status < 400) {
    // 302：只认 Location，不跟随
    const location = (result.location ?? '').trim()
    return {
      kind: 'ok',
      outTradeNo,
      orderToken,
      payUrl: isOpenableCheckout(location) ? location : null,
    }
  }
  if (!isSuccessStatus(result.status)) {
    const code = readString(body, 'code')
    return {
      kind: 'error',
      code: code || `HTTP_${result.status}`,
      messageKey: OURS_ERROR_KEYS[code] ?? OURS_STATUS_KEYS[result.status] ?? 'oursErrUnknown',
    }
  }
  if (outTradeNo === '') {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse' }
  }
  const payUrl = readString(body, 'pay_url') || readString(body, 'payUrl')
  return {
    kind: 'ok',
    outTradeNo,
    orderToken,
    payUrl: isOpenableCheckout(payUrl) ? payUrl : null,
  }
}

export type OursPollResult =
  | { kind: 'ok'; order: OursOrder; attempts: number }
  | { kind: 'timeout'; order: OursOrder | null; attempts: number }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

/**
 * 订单轮询：2s 一次、总时长不超过 60s，只在拿到 order_token 时可用（没有令牌直接返回，一次请求都不发）。
 * sleep / now 可注入，单测里用假时钟验证间隔与上限。
 */
export const pollOrder = async (
  input: {
    outTradeNo: string
    orderToken: string
    transport: OursTransport
    intervalMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
): Promise<OursPollResult> => {
  const intervalMs = input.intervalMs ?? OURS_TIMEOUTS.poll.intervalMs
  const timeoutMs = input.timeoutMs ?? OURS_TIMEOUTS.poll.timeoutMs
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const started = now()
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / intervalMs) + 1)
  let attempts = 0
  let last: OursOrder | null = null
  for (;;) {
    const result = await queryOrder({ outTradeNo: input.outTradeNo, orderToken: input.orderToken }, input.transport)
    attempts += 1
    if (result.kind === 'error') {
      return { kind: 'error', code: result.code, messageKey: result.messageKey }
    }
    last = result.order
    if (isTerminalOrderStatus(result.order.status)) {
      return { kind: 'ok', order: result.order, attempts }
    }
    if (now() - started + intervalMs > timeoutMs || attempts >= maxAttempts) {
      return { kind: 'timeout', order: last, attempts }
    }
    await sleep(intervalMs)
  }
}
