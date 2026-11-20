/**
 * 老账号额度迁移的**唯一一次调用**（Issue #498 §二 / §六 第 4 条）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 契约（#498 §二）：`POST {migration.baseUrl}{migration.endpoint}`，body 只有四个字段
 * `{ oldApiKey?, deviceId?, deviceFp?, jwt }`；`jwt` 必填（服务端拿它换 `user_id` 当迁移目标，
 * 客户端**不传**任何目标账号 id —— 传过去的 id 一律不可信）。
 *
 * 六条不许在这里破的约定：
 *   1. **只发一次**：本模块不做任何自动重试 / 退避 / 队列（#498 §六 第 4 条）。重试只由用户点按钮触发，
 *      所以这里没有 `for` 循环、没有 `retry` 参数 —— 加回来之前先读 #484 §4.3 那笔学费。
 *   2. **绝不抛**：超时 / 连不上 / 平台不支持 / 响应是乱码，全部折成
 *      `{ status:'failed', retryable }` 返回。登录后那一次调用是 `void` 掉的，
 *      这里抛一个未捕获的 rejection 就等于「登录被迁移拖红」（#498 §六 第 3 条）。
 *   3. **`oldApiKey` 是明文凭据**（#387 同型事故）：它只出现在**请求体**里。
 *      本文件**没有**任何 console / 埋点 / 文案拼接；也不许加 —— 不进日志、不进埋点、
 *      不进剪贴板、不进 DOM。`reason` 来自服务端，`readReason()` 收敛成全文本才允许上界面。
 *   4. **开关三处都判**：`config.migration.enabled === false` → 不采集（这里在采集之前就返回）、
 *      不请求；`LegacyMigrationButton.tsx` 另判一次（不显示按钮）。默认值是 `false`。
 *   5. **超时只从配置读**（`migration.timeoutMs`，默认 20000）：本文件不写毫秒字面量。
 *   6. **走原生传输层**：复用 `services/consume/http.ts` 的 `capacitorTransport`（`CapacitorHttp`），
 *      不自己写 fetch / 不用 XMLHttpRequest —— sub2api 系后端的 CORS `allowed_origins` 默认是空的
 *      （#484 §4.6），WebView 里裸 fetch 必然失败，且失败原因会被误读成「网络不好」。
 *      这里只借传输层，不用 `createConsumeHttp`：那个实例强制路径落在
 *      `apiV1Prefix` / `gatewayPrefix` 之内、且 base 是 consume 的，而迁移服务是**另一台后端**。
 */

import { capacitorTransport } from '../../services/consume/http.js'
import { collectLegacyIdentity, isIdentityEmpty } from './collect.js'
import { CLAIM_STATUSES, type ClaimResult, type LegacyIdentity } from './types.js'

/**
 * `config/endpoints.json` 的 `migration` 段（构建期经 `__ENDPOINTS__.migration` 注入）。
 * 形状与 rspack 的 DefinePlugin 一一对应；`enabled` 默认 `false`。
 */
export type MigrationConfig = {
  enabled: boolean
  baseUrl: string
  endpoint: string
  timeoutMs: number
}

/** 契约里的默认端点（配置里少了 `endpoint` 时用它；#498 §一） */
const DEFAULT_ENDPOINT = '/legacy/claim'

/** 超时取值范围（毫秒）：太小等于必然超时，太大等于永不超时 —— 与 `scripts/lib/consumeEndpoints.mjs` 同口径 */
const TIMEOUT_MIN_MS = 1000
const TIMEOUT_MAX_MS = 120000

/**
 * 本机回环：只有这几种 host 允许明文 http（本地联调自建的迁移服务）。
 * 生产必须是 https（#498 §六 第 2 条：base 必须是 https 且不得是回环）。
 */
const LOOPBACK_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

/**
 * 读注入的 `migration` 段。
 *
 * `src/env.d.ts` 已经声明了这一段的类型（rspack 的 DefinePlugin 注入，`@remove-after 1.6.0`），
 * 但**非打包环境**（`node --test` / 老壳子 / 未经 rspack 的预览页）里 `__ENDPOINTS__` 可能整个
 * 不存在或没有 `migration` 这一段 —— 取不到就是「关闭」，绝不因此抛错：
 * 这条尾巴不许影响任何别的路径。
 */
const injectedMigration = (): Partial<MigrationConfig> | undefined => {
  if (typeof __ENDPOINTS__ === 'undefined') {
    return undefined
  }
  const injected: Partial<MigrationConfig> | undefined = __ENDPOINTS__.migration
  return injected
}

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

/**
 * 读并校验配置。**任何一项不合法都返回 `null`（= 当作关闭）**，不抛错：
 * 运行时宁可不迁移，也不能因为一个拼错的配置把登录流程炸掉。
 * 「开了开关但 baseUrl 是空的」这种更严重的错误由构建期 fail-fast 拦（`rspack.config.ts`
 * 的 `assertMigrationConfig`），不允许它活到运行时。
 */
export const readMigrationConfig = (): MigrationConfig | null => {
  const raw = injectedMigration()
  if (!raw || raw.enabled !== true) {
    return null
  }
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : ''
  if (baseUrl === '' || (!baseUrl.toLowerCase().startsWith('https://') && !LOOPBACK_PATTERN.test(baseUrl))) {
    return null
  }
  const endpoint = typeof raw.endpoint === 'string' && raw.endpoint.trim() !== '' ? raw.endpoint.trim() : DEFAULT_ENDPOINT
  if (!endpoint.startsWith('/')) {
    return null
  }
  const timeoutMs = raw.timeoutMs
  if (!isPositiveInt(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    return null
  }
  return { enabled: true, baseUrl, endpoint, timeoutMs }
}

/** 开关是否打开（供界面判断「显不显示按钮」用；读配置失败 = 关闭） */
export const isMigrationEnabled = (): boolean => readMigrationConfig() !== null

/**
 * 服务端 `reason` 的收敛：去掉控制字符、压平空白、截断。
 * 这样做只为「别把一坨乱码 / 换行塞进按钮下面那一行」，不是为了脱敏 ——
 * 真正的脱敏底线是：**我们只把服务端自己给的 reason 上屏，绝不把请求体里的任何凭据拼进文案**。
 */
const readReason = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  // eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符并抹掉
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned === '' ? undefined : cleaned.slice(0, 200)
}

/**
 * 金额：只接受有限非负数；其它形状当「服务端没给」（界面显示占位，不自己猜）。
 * 真实契约（`sub2api-private@8b12ab2`）是 `{ amount, currency }`，**单位是元**；
 * 客户端**不做任何换算**（#498 §3.4），只把这两个值原样交给界面按币种显示。
 */
const readAmount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** 币种：只认 3 位字母代码（`CNY` / `USD`…），大写归一；认不出来当没给（界面只显示数字） */
const readCurrency = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const code = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : undefined
}

/** `failed` 之外的状态一律不带 `retryable`（判别联合的边界在这一处收口） */
const isClaimStatus = (value: unknown): value is (typeof CLAIM_STATUSES)[number] =>
  typeof value === 'string' && (CLAIM_STATUSES as readonly string[]).includes(value)

// ─────────────────────────────────────────────────────────────────────────────
// 后端字段名只在这里出现（#498 的契约 vs 后端真实契约）
//
// 上一步：`toBackendPayload()` 是**唯一**拼请求体的地方。
// 下一步：`fromBackendResult()` 是**唯一**认识后端状态名的地方。
//
// 维护者已确认后端写好了但真实契约还在核对（#498 的字段名是「参考契约」）。等它落地时，
// 需要改的**只有这两个函数**：换键名、换状态名、换信封层级都在这里收口，
// 调用点（claimLegacyMigration / 界面 / 接线点）一行都不用动。别的文件不许出现这四个字段名。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本地线索 + JWT → 请求体（**唯一**的字段名映射点，见上面那段注释）。
 *
 * 三个可选字段：没收集到就**不出现**（`JSON.stringify` 丢掉 `undefined` 键，服务端按可选处理），
 * 绝不拿空串 / `null` / 占位值冒充「有」—— 那会让服务端把无凭据当成有凭据（#498 §3.2）。
 */
export const toBackendPayload = (identity: LegacyIdentity, jwt: string): Record<string, string> => {
  const payload: Record<string, string> = { jwt }
  if (identity.oldApiKey !== undefined) {
    payload.oldApiKey = identity.oldApiKey
  }
  if (identity.deviceId !== undefined) {
    payload.deviceId = identity.deviceId
  }
  if (identity.deviceFp !== undefined) {
    payload.deviceFp = identity.deviceFp
  }
  return payload
}

/**
 * 响应体（已 `JSON.parse`）→ `ClaimResult`（**唯一**的后端状态名映射点）。
 *
 * 认不出来就返回 `null`，由调用方折成 `failed + retryable:false`
 * （契约破坏不是「网络不好」，重试 100 次也不会变好）。
 */
export const fromBackendResult = (body: unknown): ClaimResult | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const record = body as Record<string, unknown>
  const status = record.status
  if (typeof status !== 'string' || status.trim() === '') {
    return null
  }
  if (!isClaimStatus(status)) {
    // 枚举外状态（实测后端会回 `unauthorized` / `upstream_error`，以后还可能有别的）：
    // 一律归成 `failed + retryable:false` —— **不当成功、不崩、不重试**。
    // `reason` 只记一个固定标记，不把后端内部状态名端给用户看（那对用户没有行动价值）。
    return { status: 'failed', retryable: false, reason: 'unknown_status' }
  }
  const reason = readReason(record.reason)
  switch (status) {
    // 真实契约：金额是 `{ amount, currency }`（元），不是 `usdAmount`（见 toBackendPayload 上方那段）
    case 'migrated':
      return withAmount({ status }, record)
    case 'already_migrated':
      return withAmount({ status }, record)
    case 'no_legacy':
      return reason === undefined ? { status } : { status, reason }
    case 'need_manual':
      return reason === undefined ? { status } : { status, reason }
    case 'expired':
      return reason === undefined ? { status } : { status, reason }
    case 'failed':
      // 只有服务端显式说 `retryable: true` 才算可重试：默认值取「不可重试」，
      // 免得服务端漏字段时把用户按在一个永远失败的按钮上。
      return reason === undefined
        ? { status, retryable: record.retryable === true }
        : { status, retryable: record.retryable === true, reason }
  }
}

/**
 * 把 `{ amount, currency }` 挂到结果上；两个都没给就返回原对象（界面显示占位）。
 * 只有 `migrated` / `already_migrated` 走这条路 —— 其它状态带金额只会让界面显示不该显示的数。
 */
const withAmount = <T extends ClaimResult>(base: T, record: Record<string, unknown>): T => {
  const amount = readAmount(record.amount)
  const currency = readCurrency(record.currency)
  if (amount === undefined) {
    return base
  }
  return { ...base, amount, ...(currency === undefined ? {} : { currency }) } as T
}

/** 非 2xx 里哪些值得让用户再点一次（5xx / 429 / 408）；其余（4xx）重试也没意义 */
const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429 || status === 425

/**
 * 迁移这一次（#498 §四）。**不抛错，不重试，不写日志。**
 *
 * `token` 是当前 sub2api 的 access token（JWT）：服务端必须拿它换 `user_id`。
 * 空 token 直接返回失败（不采集、不发请求）—— 没登录就没什么可迁的。
 */
export const claimLegacyMigration = async (token: string): Promise<ClaimResult> => {
  // 开关第 1 处（此处判在采集之前：关掉时**连读取本地槽位都不做**，#498 §一）
  const config = readMigrationConfig()
  if (config === null) {
    return { status: 'failed', retryable: false, reason: 'migration_disabled' }
  }

  const jwt = token.trim()
  if (jwt === '') {
    return { status: 'failed', retryable: false, reason: 'missing_token' }
  }

  const identity = collectLegacyIdentity()
  // 三条线索都没有：这台设备没有老账号痕迹，**不发无用请求**，按契约静默处理（no_legacy）
  if (isIdentityEmpty(identity)) {
    return { status: 'no_legacy', reason: 'no_identity' }
  }

  try {
    const outcome = await capacitorTransport({
      method: 'POST',
      url: `${config.baseUrl}${config.endpoint}`,
      // 契约只把 jwt 放在 body 里（#498 §二）；这里不带 Authorization 头，避免两处身份来源打架
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      // 字段名只在 toBackendPayload() 里出现（后端契约对齐时只改那一个函数）
      body: JSON.stringify(toBackendPayload(identity, jwt)),
      timeoutMs: config.timeoutMs,
    })

    if (outcome.kind !== 'response') {
      // 超时 / 连不上：契约要求「不抛，返回可重试」（#498 §六 第 4 条 + 任务验收）
      if (outcome.kind === 'unsupported') {
        // 非原生环境（浏览器 / 预览页）永远打不通，让用户重试只会永远失败：不提供重试
        return { status: 'failed', retryable: false, reason: 'unsupported_platform' }
      }
      return { status: 'failed', retryable: true }
    }

    let body: unknown
    try {
      body = JSON.parse(outcome.text)
    } catch {
      body = undefined
    }
    // **先看 body，再看 HTTP 状态码**：实测后端「业务失败一律 200」，从不回 401，
    // 所以靠状态码判成败会把 `need_manual` / `already_migrated` 误当成网络错误。
    // 只要 body 里有认识的（或枚举外的）`status`，就以它为准 —— 哪怕这一趟是 4xx / 5xx
    // （反代把自己的错误页塞进 502 时，body 里没有 `status`，那才轮到下面的兜底）。
    const parsed = fromBackendResult(body)
    if (parsed !== null) {
      return parsed
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      return {
        status: 'failed',
        retryable: isRetryableStatus(outcome.status),
        reason: `http_${outcome.status}`,
      }
    }
    return { status: 'failed', retryable: false, reason: 'bad_response' }
  } catch {
    // 传输层理论上不抛（它自己吞了），这里是最后一道保险：任何异常都不许冒到登录流程
    return { status: 'failed', retryable: true }
  }
}
