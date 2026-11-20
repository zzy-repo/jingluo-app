#!/usr/bin/env node
/**
 * sub2api 契约 mock 服务器（本地联调用；**不是** sub2api 实现，也不进打包）。
 *
 * 目的：真实 sub2api 实例还没起来时，B/C/E 三条 UI 线也要能发请求、能看错误态。
 * 所以这个 mock **严格按 `docs/sub2api-client-contract.md` §3 白名单**实现端点与信封，
 * 它是「契约的可执行版本」：mock 与文档不一致时立刻暴露，比等真实实例划算。
 *
 * 运行：`pnpm mock:sub2api`（或 `node tools/mock-sub2api/server.mjs`）
 * 监听：`127.0.0.1:18080`（真实实例用 18000；换端口用 `MOCK_SUB2API_PORT`）
 *
 * 硬约束（与 #484 一致，改这里之前先改契约文档）：
 *   1. 只实现白名单端点；白名单外的路径一律 text/plain 404（**不回 JSON**）。
 *   2. 五种错误信封必须与真实实例的形状一致（见 README「错误态」一节）：
 *      用户 401 / admin 401 / 429 / 网关 error 对象 / 未知路径 text 404。
 *   3. 零第三方依赖，只用 `node:http`（+ `node:crypto` 造 id 与假 JWT）。
 *   4. 内存存储，进程一停数据就没了 —— 这是联调工具，不是后端。
 *
 * 已知与真实实例的差异，全部记在 `tools/mock-sub2api/README.md`。
 */
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

// ------------------------------------------------------------------ 运行参数

/** 监听地址：只绑回环，避免被同网段别人打到 */
const HOST = process.env.MOCK_SUB2API_HOST || '127.0.0.1'

/** 监听端口：真实实例用 18000，这里用 18080 避免撞车 */
const PORT = Number(process.env.MOCK_SUB2API_PORT || 18080)

/** access_token 名义有效期（秒）；mock 不真的校验过期，只为让响应形状与真实一致 */
const ACCESS_TOKEN_TTL_SECONDS = 3600

/** 每个响应都带这个头，免得有人把 mock 的响应当成真实实例抓包结果 */
const MOCK_MARKER = ['x-mock-server', 'sub2api-contract-mock']

/**
 * 401 的 `code` 用哪一套：
 *   - `contract`（默认）：契约/白名单口径的数字码 40101 / 40102（#484 正文用这一套）；
 *   - `real`：真实 0.2.22 实例抓包口径的字符串码 `"UNAUTHORIZED"`（message 仍是两种）。
 * 两套并存是**故意的**：真实实例与契约文档在这里不一致，mock 让 UI 两条都能联调，
 * 差异记在 README「与真实实例的已知差异」。`MOCK_SUB2API_ENVELOPE=real` 切到真实口径。
 */
const ENVELOPE_MODE = (process.env.MOCK_SUB2API_ENVELOPE || 'contract').toLowerCase() === 'real' ? 'real' : 'contract'

/**
 * 启动时就存在的一把 `sk-` Key（`/v1/usage` 开箱可用，不必先过一遍创建流程）。
 * 形状与真实一致：`sk-` + 64 位 hex（`service/api_key_service.go` 的 `sk-` + 32 字节 hex）。
 */
const SEEDED_API_KEY = `sk-${'c0ffee'.repeat(10)}c0ff`

/** 网关 Key 的三段退化顺序（契约 §2）：Authorization Bearer → x-api-key → x-goog-api-key */
const GATEWAY_KEY_HEADERS = ['x-api-key', 'x-goog-api-key']

// ------------------------------------------------------------------ 通用小工具

const nowISO = () => new Date().toISOString()

/** `YYYY-MM-DD`（相对今天偏移 offsetDays 天），给 /v1/usage 的 daily_usage 用 */
const dayISO = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10)

/** base64url 编码 JSON —— 只为了造一个「长得像 JWT」的 token，不用于任何安全用途 */
const b64urlJSON = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/**
 * 签发一个形状真实的 token（header.payload.signature）。
 * **签名是假的**：mock 不做验签，token 是否有效只看内存里的 Map。
 * 这么做的价值是：UI 层想解 payload 拿 `exp` / `sub` 时不会因为形状不对而炸。
 */
const issueToken = (user, kind) => {
  const iat = Math.floor(Date.now() / 1000)
  const payload = {
    sub: String(user.id),
    uid: user.id,
    email: user.email,
    role: user.role,
    kind,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  }
  const signature = randomBytes(32).toString('base64url')
  return `${b64urlJSON({ alg: 'HS256', typ: 'JWT' })}.${b64urlJSON(payload)}.${signature}`
}

/** 读请求体并按 JSON 解析；空体当 `{}`。抛错 → 上层回面板 400 信封（与 gin binding 失败同口径） */
const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1048576) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })

const str = (value) => (typeof value === 'string' ? value.trim() : '')

// ------------------------------------------------------------------ 响应信封

/**
 * 统一出口：所有 JSON 响应都过这里，顺便打 CORS 与 mock 标记头。
 * 真实实例的 `/api/v1/settings/public` 实测带 `access-control-allow-origin: *`，
 * mock 全站放开是为了浏览器直连联调（原生壳走 CapacitorHttp 不受影响）。
 */
const send = (res, status, contentType, body, extraHeaders = {}) => {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers':
      'authorization, content-type, x-api-key, x-goog-api-key, x-mock-error, x-session-id',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-expose-headers': '*',
    'access-control-max-age': '86400',
    'x-request-id': randomUUID(),
    [MOCK_MARKER[0]]: MOCK_MARKER[1],
    ...extraHeaders,
  })
  res.end(payload)
}

const sendJSON = (res, status, body, extraHeaders) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), extraHeaders)

// --- 信封 1/2：面板成功 `{code:0, message:'success', data}` -----------------
/** 面板成功信封（`pkg/response.Success`）。202 时 message 是 `accepted`，与真实一致 */
const ok = (res, data, status = 200) =>
  sendJSON(res, status, { code: 0, message: status === 202 ? 'accepted' : 'success', data })

/** 面板分页信封（`pkg/response.PaginatedData`） */
const okPaginated = (res, items, total, page, pageSize) =>
  ok(res, {
    items,
    total,
    page,
    page_size: pageSize,
    pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  })

// --- 信封 3：面板失败 `{code:<HTTP 整数>, message, reason?}` ----------------
/** 面板失败信封（`pkg/response.ErrorWithDetails`）：`code` 是 HTTP 状态码整数，不是业务码 */
const fail = (res, status, message, reason) =>
  sendJSON(res, status, reason ? { code: status, message, reason } : { code: status, message })

// --- 信封 4/5/6/7：五种必须忠实实现的错误态 --------------------------------

/**
 * ①用户 401（契约码 40101）。message 是 `Authorization header is required`。
 * 注意：admin 变体的 message 是 `Authorization required`（少一个 header is），见 ②。
 * `MOCK_SUB2API_ENVELOPE=real` 时改成真实实例的字符串码 `"UNAUTHORIZED"`。
 */
const errUserUnauthorized = (res) =>
  sendJSON(res, 401, {
    code: ENVELOPE_MODE === 'real' ? 'UNAUTHORIZED' : 40101,
    message: 'Authorization header is required',
  })

/** ②admin 401（契约码 40102）。message 与用户态**不同**，UI 不许按 message 分支 */
const errAdminUnauthorized = (res) =>
  sendJSON(res, 401, {
    code: ENVELOPE_MODE === 'real' ? 'UNAUTHORIZED' : 40102,
    message: 'Authorization required',
  })

/** ③限流 429：**没有 `code` 字段**，按 HTTP 状态码 + `retry-after` 分支 */
const errRateLimited = (res) =>
  sendJSON(
    res,
    429,
    { error: 'rate limit exceeded', message: 'Too many requests, please try again later' },
    { 'retry-after': '59' },
  )

/** ④网关错误 `{error:{message,type}}`（`middleware` 的网关分支，不是面板信封） */
const errGateway = (res, message, type = 'upstream_error', status = 502) =>
  sendJSON(res, status, { error: { message, type } })

/**
 * 中间件 UPPER_SNAKE 信封 `{code:'UPPER_SNAKE', message}`（契约 §4 第三行）。
 * 用在 `/v1/*` 的 Key 缺失/无效上 —— 真实实例这里回的是这个形状，不是 `{error:{}}`。
 */
const errMiddleware = (res, status, code, message) => sendJSON(res, status, { code, message })

/** ⑤未知路径 404：**text/plain 纯文本**，不是 JSON（gin 的默认 404 体） */
const errNotFoundText = (res) => send(res, 404, 'text/plain', '404 page not found')

/** apia 侧的错误信封（支付线自己的形状）：`{code:'UPPER_SNAKE', message}` */
const errApia = (res, status, code, message) => sendJSON(res, status, { code, message })

// ------------------------------------------------------------------ 错误态触发开关

/**
 * `?mock_error=<kind>` 或请求头 `x-mock-error: <kind>` 强制返回某种错误态。
 * 这是 mock 的核心用途之一：让 UI 一条条走完错误分支，不用等真实限流/断网。
 * 别名放宽，是因为手敲 curl 时大小写和下划线很难记。
 */
const MOCK_ERROR_KINDS = new Map([
  ['auth', 'auth'],
  ['401', 'auth'],
  ['user401', 'auth'],
  ['unauthorized', 'auth'],
  ['admin', 'admin401'],
  ['admin401', 'admin401'],
  ['429', 'rateLimit'],
  ['ratelimit', 'rateLimit'],
  ['rate_limit', 'rateLimit'],
  ['rate-limit', 'rateLimit'],
  ['ratelimited', 'rateLimit'],
  ['404', 'text404'],
  ['text404', 'text404'],
  ['404text', 'text404'],
  ['text', 'text404'],
  ['502', 'gateway'],
  ['gateway', 'gateway'],
  ['gatewayerror', 'gateway'],
  ['gateway_error', 'gateway'],
])

/** 取本次请求要强制的错误态；没给或认不出来 → null（走正常路由） */
const pickMockError = (req, url) => {
  const raw = url.searchParams.get('mock_error') || req.headers['x-mock-error']
  const key = str(Array.isArray(raw) ? raw[0] : raw).toLowerCase()
  return MOCK_ERROR_KINDS.get(key) ?? null
}

/** 把强制错误态真正写出去 */
const applyMockError = (res, kind) => {
  if (kind === 'auth') return errUserUnauthorized(res)
  if (kind === 'admin401') return errAdminUnauthorized(res)
  if (kind === 'rateLimit') return errRateLimited(res)
  if (kind === 'text404') return errNotFoundText(res)
  if (kind === 'gateway') return errGateway(res, 'upstream provider error (mock)', 'upstream_error', 502)
  return errNotFoundText(res)
}

// ------------------------------------------------------------------ 公共设置（74 字段真形状）

/**
 * `GET /api/v1/settings/public` 的 `data`：**74 个字段全量**，键名与顺序照
 * `sub2api-fixtures/settings-public.json`（真实 0.2.22 实例抓包）抄，一个不少。
 *
 * 只动三个开关（联调要「能注册 + 能填邀请码 + 不验邮箱」这条路）：
 *   registration_enabled: false -> true
 *   invitation_code_enabled: false -> true
 *   email_verify_enabled: false（与真实实例同值）
 * **其余 71 个字段一律照真实实例**（含 `model_plaza_enabled:false`、`affiliate_enabled:false`
 * 这类会改变 UI 分支的）—— 客户端不许维护第二份开关副本，那 mock 也不许乱改开关值，
 * 否则「UI 在我这儿是好的」会变成假的。
 *
 * 想临时翻某个开关（例如联调邀请返利页需要 `affiliate_enabled:true`）时不用改代码：
 *   MOCK_SUB2API_SETTINGS='{"affiliate_enabled":true}' pnpm mock:sub2api
 * 未知键会被打印出来（拼错字段名比缺功能更难查）。
 */
const settingsOverrides = (() => {
  const raw = process.env.MOCK_SUB2API_SETTINGS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    process.stderr.write(`[mock-sub2api] MOCK_SUB2API_SETTINGS 不是合法 JSON，已忽略：${error.message}\n`)
    return {}
  }
})()

const PUBLIC_SETTINGS = Object.freeze({
  registration_enabled: true,
  email_verify_enabled: false,
  force_email_on_third_party_signup: false,
  registration_email_suffix_whitelist: [],
  registration_email_domain_quota_enabled: false,
  promo_code_enabled: true,
  password_reset_enabled: false,
  invitation_code_enabled: true,
  totp_enabled: false,
  passkey_enabled: false,
  login_agreement_enabled: false,
  login_agreement_mode: 'modal',
  login_agreement_updated_at: '2026-03-31',
  login_agreement_revision: '0eff189d66e0af4e',
  login_agreement_documents: [
    { id: 'terms', title: '服务条款', content_md: '' },
    { id: 'usage-policy', title: '使用政策', content_md: '' },
    { id: 'supported-regions', title: '支持的国家和地区', content_md: '' },
    { id: 'service-specific-terms', title: '服务特定条款', content_md: '' },
  ],
  turnstile_enabled: false,
  turnstile_site_key: '',
  tencent_captcha_enabled: false,
  tencent_captcha_app_id: '',
  tencent_captcha_region: 'cn',
  aliyun_captcha_enabled: false,
  aliyun_captcha_scene_id: '',
  aliyun_captcha_prefix: '',
  aliyun_captcha_region: 'cn',
  site_name: 'Sub2API',
  site_logo: '',
  site_subtitle: 'Subscription to API Conversion Platform',
  api_base_url: '',
  contact_info: '',
  doc_url: '',
  home_content: '',
  compact_home_enabled: false,
  hide_ccs_import_button: false,
  purchase_subscription_enabled: false,
  purchase_subscription_url: '',
  table_default_page_size: 20,
  table_page_size_options: [10, 20, 50],
  custom_menu_items: [],
  custom_endpoints: [],
  dingtalk_oauth_enabled: false,
  linuxdo_oauth_enabled: false,
  wechat_oauth_enabled: false,
  wechat_oauth_open_enabled: false,
  wechat_oauth_mp_enabled: false,
  wechat_oauth_mobile_enabled: false,
  oidc_oauth_enabled: false,
  oidc_oauth_provider_name: 'OIDC',
  github_oauth_enabled: false,
  google_oauth_enabled: false,
  backend_mode_enabled: false,
  mcp_enabled: false,
  payment_enabled: false,
  payment_balance_disabled: false,
  version: '0.2.22',
  server_timezone: 'Asia/Shanghai',
  server_utc_offset: '+08:00',
  balance_low_notify_enabled: false,
  account_quota_notify_enabled: false,
  balance_low_notify_threshold: 0,
  balance_low_notify_recharge_url: '',
  channel_monitor_enabled: true,
  channel_monitor_mode: 'v1',
  channel_monitor_default_interval_seconds: 60,
  channel_monitor_hide_throughput: true,
  channel_monitor_show_quota: false,
  channel_monitor_hide_user_ranking: false,
  available_channels_enabled: false,
  subscription_enabled: true,
  model_plaza_enabled: false,
  model_plaza_require_auth: false,
  plugin_management_enabled: false,
  affiliate_enabled: false,
  risk_control_enabled: false,
  allow_user_view_error_requests: false,
  // 环境变量给的临时覆盖放最后：只覆盖已有键，键名拼错会打印警告
  ...settingsOverrides,
})

// 拼错的开关名是最难查的那类 bug（UI 等一个永远为 false 的开关），启动时就吼一声
for (const key of Object.keys(settingsOverrides)) {
  if (!(key in PUBLIC_SETTINGS)) {
    process.stderr.write(`[mock-sub2api] MOCK_SUB2API_SETTINGS 里有未知键：${key}\n`)
  }
}

// ------------------------------------------------------------------ 内存存储

/** 自增 id（真实是数据库自增 int64；mock 只需要单调） */
let nextUserId = 1
let nextKeyId = 1
let nextRedeemId = 1

/** email -> user */
const users = new Map()
/** access_token -> user */
const accessTokens = new Map()
/** refresh_token -> user */
const refreshTokens = new Map()
/** user.id -> APIKey[] */
const apiKeys = new Map()
/** user.id -> RedeemCode[]（新→旧） */
const redeemHistory = new Map()

/** `dto.User` 形状（`handler/dto/types.go`） */
const makeUser = (email, overrides = {}) => {
  const createdAt = nowISO()
  return {
    id: nextUserId++,
    email,
    username: email.split('@')[0],
    role: 'user',
    balance: 2,
    frozen_balance: 0,
    concurrency: 5,
    status: 'active',
    allowed_groups: [],
    created_at: createdAt,
    updated_at: createdAt,
    balance_notify_enabled: false,
    balance_notify_threshold_type: 'fixed',
    balance_notify_threshold: null,
    balance_notify_extra_emails: [],
    total_recharged: 0,
    rpm_limit: 0,
    ...overrides,
  }
}

/** `dto.APIKey` 形状（`quota:0` = 不限，**不是**零额度） */
const makeApiKey = (userId, { name, quota = 0, expiresInDays = 0, customKey = '' }) => ({
  id: nextKeyId++,
  user_id: userId,
  key: customKey || `sk-${randomBytes(32).toString('hex')}`,
  name,
  group_id: null,
  status: 'active',
  ip_whitelist: [],
  ip_blacklist: [],
  last_used_at: null,
  last_used_ip: null,
  quota,
  quota_used: 0,
  expires_at: expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null,
  created_at: nowISO(),
  updated_at: nowISO(),
  current_concurrency: 0,
  rate_limit_5h: 0,
  rate_limit_1d: 0,
  rate_limit_7d: 0,
  usage_5h: 0,
  usage_1d: 0,
  usage_7d: 0,
  window_5h_start: null,
  window_1d_start: null,
  window_7d_start: null,
})

const keysOf = (userId) => {
  if (!apiKeys.has(userId)) apiKeys.set(userId, [])
  return apiKeys.get(userId)
}

const historyOf = (userId) => {
  if (!redeemHistory.has(userId)) redeemHistory.set(userId, [])
  return redeemHistory.get(userId)
}

/** 身份绑定摘要（`service.UserIdentitySummary`），邮箱是已绑定态，第三方全是未绑定 */
const identitySummary = (provider, bound, extra = {}) => ({
  provider,
  bound,
  bound_count: bound ? 1 : 0,
  can_bind: !bound,
  can_unbind: bound && provider !== 'email',
  ...extra,
})

const identitiesOf = (user) => ({
  email: identitySummary('email', true, { display_name: user.email, provider_key: user.email, verified_at: user.created_at }),
  linuxdo: identitySummary('linuxdo', false, { bind_start_path: '/api/v1/auth/oauth/linuxdo/start' }),
  oidc: identitySummary('oidc', false, { bind_start_path: '/api/v1/auth/oauth/oidc/start' }),
  wechat: identitySummary('wechat', false, { bind_start_path: '/api/v1/auth/oauth/wechat/start' }),
  dingtalk: identitySummary('dingtalk', false, { bind_start_path: '/api/v1/auth/oauth/dingtalk/start' }),
})

/**
 * `userProfileResponse` 形状（`handler/user_handler.go` 的 struct，嵌入 `dto.User`）：
 * 用户字段 + 头像来源 + 5 个身份摘要 + `email_bound` 这类扁平布尔。
 */
const profileOf = (user) => {
  const identities = identitiesOf(user)
  const bindings = {
    email: identities.email,
    linuxdo: identities.linuxdo,
    oidc: identities.oidc,
    wechat: identities.wechat,
    dingtalk: identities.dingtalk,
  }
  return {
    ...user,
    avatar_url: '',
    identities,
    auth_bindings: bindings,
    identity_bindings: bindings,
    email_bound: true,
    linuxdo_bound: false,
    oidc_bound: false,
    wechat_bound: false,
    dingtalk_bound: false,
  }
}

/** `AffiliateDetail` 形状（`service/affiliate_service.go`）：返利按 USD */
const affiliateOf = (user) => ({
  user_id: user.id,
  aff_code: `AFF${String(user.id).padStart(4, '0')}`,
  inviter_id: null,
  aff_count: 0,
  aff_quota: 0,
  aff_frozen_quota: 0,
  aff_history_quota: 0,
  effective_rebate_rate_percent: 10,
  invitees: [],
})

// 种子数据：一个演示账号 + 一把开箱可用的 sk- Key
const demoUser = makeUser('demo@mock.local')
users.set(demoUser.email, demoUser)
keysOf(demoUser.id).push(
  makeApiKey(demoUser.id, { name: 'mock-seed', customKey: SEEDED_API_KEY }),
)

// ------------------------------------------------------------------ 鉴权

/** 从请求头解析 Bearer token（JWT 通道**只认 header**，cookie 无效 —— 契约 §2） */
const readBearer = (req) => {
  const raw = req.headers.authorization
  if (!raw) return { kind: 'missing' }
  const matched = /^Bearer\s+(.+)$/i.exec(String(raw).trim())
  if (!matched) return { kind: 'bad_format' }
  return { kind: 'ok', token: matched[1].trim() }
}

/**
 * JWT 通道鉴权：失败一律回**用户 401**（40101）。
 * 真实实例在「无 header / 格式错 / token 无效」三种情况下 message 不同（UNAUTHORIZED /
 * INVALID_AUTH_HEADER / INVALID_TOKEN），mock 统一成一种 —— 因为契约只给了 40101 这一码，
 * 差异记在 README。要验证「任意 token 都 401」这一条，用它就够了。
 */
const requireUser = (req, res) => {
  const bearer = readBearer(req)
  if (bearer.kind !== 'ok') {
    errUserUnauthorized(res)
    return null
  }
  const user = accessTokens.get(bearer.token)
  if (!user) {
    errUserUnauthorized(res)
    return null
  }
  return user
}

/** 网关 Key 通道：`Authorization: Bearer sk-…` → `x-api-key` → `x-goog-api-key` */
const readGatewayKey = (req) => {
  const bearer = readBearer(req)
  if (bearer.kind === 'ok' && bearer.token.startsWith('sk-')) return bearer.token
  for (const header of GATEWAY_KEY_HEADERS) {
    const value = str(req.headers[header])
    if (value) return value
  }
  return ''
}

/** 网关通道鉴权：缺 Key → `API_KEY_REQUIRED`，错 Key → `INVALID_API_KEY`（都是中间件信封） */
const requireGatewayKey = (req, res) => {
  const key = readGatewayKey(req)
  if (!key) {
    errMiddleware(
      res,
      401,
      'API_KEY_REQUIRED',
      'API key is required in Authorization header (Bearer scheme), x-api-key header, or x-goog-api-key header',
    )
    return null
  }
  for (const list of apiKeys.values()) {
    const found = list.find((item) => item.key === key)
    if (found) return found
  }
  errMiddleware(res, 401, 'INVALID_API_KEY', 'Invalid API key')
  return null
}

// ------------------------------------------------------------------ 处理函数

/** GET /api/v1/settings/public —— 启动必读，74 字段全量 */
const handleSettingsPublic = ({ res }) => ok(res, PUBLIC_SETTINGS)

/** 校验邮箱/密码。密码 ≥8 位（真实允许 min=6，mock 用 8，见 README 差异表） */
const validateCredentials = (body) => {
  const email = str(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || !email.includes('@')) return { error: 'Invalid request: email is required' }
  if (!password) return { error: 'Invalid request: password is required' }
  if (password.length < 8) return { error: 'Invalid request: password must be at least 8 characters' }
  return { email, password }
}

/** 认证响应体（`AuthResponse`）：token 对 + 用户 */
const authPayload = (user) => {
  const accessToken = issueToken(user, 'access')
  const refreshToken = issueToken(user, 'refresh')
  accessTokens.set(accessToken, user)
  refreshTokens.set(refreshToken, user)
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    token_type: 'Bearer',
    user: profileOf(user),
  }
}

/** POST /api/v1/auth/register —— 任意邮箱 + 密码 ≥8 位即可注册；邮箱重复回 409 EMAIL_EXISTS */
const handleRegister = ({ res, body }) => {
  const valid = validateCredentials(body)
  if (valid.error) {
    fail(res, 400, valid.error)
    return
  }
  if (users.has(valid.email)) {
    fail(res, 409, 'email already exists', 'EMAIL_EXISTS')
    return
  }
  const user = makeUser(valid.email)
  users.set(user.email, user)
  ok(res, authPayload(user))
}

/**
 * POST /api/v1/auth/login —— 任意已注册/未注册邮箱 + 密码 ≥8 位都成功。
 * 未注册的邮箱会**自动建号**（联调便利；真实实例回 401）。
 */
const handleLogin = ({ res, body }) => {
  const valid = validateCredentials(body)
  if (valid.error) {
    fail(res, 400, valid.error)
    return
  }
  let user = users.get(valid.email)
  if (!user) {
    user = makeUser(valid.email)
    users.set(user.email, user)
  }
  ok(res, authPayload(user))
}

/** POST /api/v1/auth/send-verify-code —— 不回验证码本身，只回倒计时（真实形状） */
const handleSendVerifyCode = ({ res, body }) => {
  if (!str(body.email)) {
    fail(res, 400, 'Invalid request: email is required')
    return
  }
  ok(res, { message: 'verify code sent (mock: any 6 digits will pass)', countdown: 60 })
}

/** POST /api/v1/auth/refresh —— 用 refresh_token 换一对新 token */
const handleRefresh = ({ res, body }) => {
  const token = str(body.refresh_token)
  if (!token) {
    fail(res, 400, 'Invalid request: refresh_token is required')
    return
  }
  const user = refreshTokens.get(token)
  if (!user) {
    fail(res, 401, 'invalid or expired refresh token', 'INVALID_REFRESH_TOKEN')
    return
  }
  refreshTokens.delete(token)
  ok(res, authPayload(user))
}

/** GET /api/v1/auth/me —— 当前用户（`UserResponse` = profile + run_mode） */
const handleAuthMe = ({ res, user }) => ok(res, { ...profileOf(user), run_mode: 'standard' })

/** GET /api/v1/user/profile —— 资料 / 邮箱绑定态 / 余额（USD） */
const handleUserProfile = ({ res, user }) => ok(res, profileOf(user))

/** GET /api/v1/user/aff —— 我的邀请 */
const handleUserAff = ({ res, user }) => ok(res, affiliateOf(user))

/** GET /api/v1/keys —— 分页列表（page / page_size / search / status） */
const handleKeysList = ({ res, user, url }) => {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 20))
  const search = str(url.searchParams.get('search')).toLowerCase()
  const status = str(url.searchParams.get('status'))

  const filtered = keysOf(user.id).filter((item) => {
    if (search && !item.name.toLowerCase().includes(search)) return false
    if (status && item.status !== status) return false
    return true
  })
  const start = (page - 1) * pageSize
  okPaginated(res, filtered.slice(start, start + pageSize), filtered.length, page, pageSize)
}

/** POST /api/v1/keys —— 创建（`name` 必填；`custom_key` 撞车回 409 API_KEY_EXISTS） */
const handleKeysCreate = ({ res, user, body }) => {
  const name = str(body.name)
  if (!name) {
    fail(res, 400, 'Invalid request: name is required')
    return
  }
  const list = keysOf(user.id)
  const customKey = str(body.custom_key)
  if (customKey) {
    if (!customKey.startsWith('sk-') || customKey.length < 20) {
      fail(res, 400, 'invalid custom key', 'API_KEY_TOO_SHORT')
      return
    }
    if (list.some((item) => item.key === customKey)) {
      fail(res, 409, 'api key already exists', 'API_KEY_EXISTS')
      return
    }
  }
  const quota = Number.isFinite(Number(body.quota)) ? Number(body.quota) : 0
  const expiresInDays = Number.isFinite(Number(body.expires_in_days)) ? Number(body.expires_in_days) : 0
  const created = makeApiKey(user.id, { name, quota, expiresInDays, customKey })
  list.unshift(created)
  // 真实实例这里也是 200 + Success 信封（不是 201），照抄
  ok(res, created)
}

/**
 * 按 id 找 Key。真实实例把 `:id` 当 int64 解析，`/api/v1/keys/rotate` 这种「像端点其实是
 * 占位符」的路径会先 400 而不是 404 —— mock 照抄，这样 §3.7 的幻觉路径不会伪装成合法端点。
 */
const findKey = (user, id) => keysOf(user.id).find((item) => String(item.id) === String(id))

/** `:id` 不是正整数 → 400（面板信封）；返回 null 表示已经写过响应 */
const rejectBadKeyId = (res, rawId) => {
  if (/^\d+$/.test(String(rawId))) return false
  fail(res, 400, 'Invalid request: invalid api key id')
  return true
}

/** GET /api/v1/keys/:id */
const handleKeysGet = ({ res, user, params }) => {
  if (rejectBadKeyId(res, params.id)) return
  const found = findKey(user, params.id)
  if (!found) {
    fail(res, 404, 'api key not found')
    return
  }
  ok(res, found)
}

/** PUT /api/v1/keys/:id —— 改名 / 停用 / 改额度（请求体**没有** `key`，无法原位换值） */
const handleKeysUpdate = ({ res, user, params, body }) => {
  if (rejectBadKeyId(res, params.id)) return
  const found = findKey(user, params.id)
  if (!found) {
    fail(res, 404, 'api key not found')
    return
  }
  if (typeof body.name === 'string' && body.name.trim()) found.name = body.name.trim()
  if (typeof body.status === 'string') {
    if (body.status !== 'active' && body.status !== 'inactive') {
      fail(res, 400, 'Invalid request: status must be active or inactive')
      return
    }
    found.status = body.status
  }
  if (Number.isFinite(Number(body.quota))) found.quota = Number(body.quota)
  if (body.reset_quota === true) found.quota_used = 0
  found.updated_at = nowISO()
  ok(res, found)
}

/** DELETE /api/v1/keys/:id —— 已删除再删按 404（契约 §5） */
const handleKeysDelete = ({ res, user, params }) => {
  if (rejectBadKeyId(res, params.id)) return
  const list = keysOf(user.id)
  const index = list.findIndex((item) => String(item.id) === String(params.id))
  if (index === -1) {
    fail(res, 404, 'api key not found')
    return
  }
  list.splice(index, 1)
  ok(res, { message: 'API key deleted successfully' })
}

/**
 * GET /v1/usage —— 网关通道，**扁平 JSON，不套 `data` 外壳**。
 *
 * 关键口径（契约 §3.3 + #487 实测）：
 *   - `quota.used` **恒 0**（mock 不做记账），真实花费放 `usage.total.actual_cost`；
 *   - **没有 `rate_limits[]`** —— 真实实例只在 Key 配了限速时才吐这个键，硬 map 会崩；
 *   - `mode` 固定 `quota_limited`（另两种 `unrestricted` 形态 mock 不模拟）。
 */
const handleGatewayUsage = ({ res }) => {
  const totalCost = 0.051435696
  const quotaLimit = 10
  sendJSON(res, 200, {
    mode: 'quota_limited',
    isValid: true,
    status: 'active',
    quota: { limit: quotaLimit, used: 0, remaining: quotaLimit, unit: 'USD' },
    remaining: quotaLimit,
    unit: 'USD',
    usage: {
      average_duration_ms: 4671.670454545455,
      rpm: 0,
      tpm: 0,
      today: {
        actual_cost: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        requests: 0,
        total_tokens: 0,
      },
      // 真实花费只放这里：`quota.used` 永远是 0，UI 别拿它当已用额度
      total: {
        actual_cost: totalCost,
        cache_creation_tokens: 0,
        cache_read_tokens: 89326,
        cost: totalCost,
        input_tokens: 121901,
        output_tokens: 51836,
        requests: 616,
        total_tokens: 263063,
      },
    },
    daily_usage: [
      {
        date: dayISO(-2),
        requests: 575,
        input_tokens: 117928,
        output_tokens: 49463,
        cache_read_tokens: 82549,
        cache_write_tokens: 0,
        total_tokens: 249940,
        cost: 0.049320915,
        actual_cost: 0.049320915,
      },
      {
        date: dayISO(-1),
        requests: 41,
        input_tokens: 3973,
        output_tokens: 2373,
        cache_read_tokens: 6777,
        cache_write_tokens: 0,
        total_tokens: 13123,
        cost: 0.002114781,
        actual_cost: 0.002114781,
      },
    ],
    model_stats: [
      {
        model: 'deepseek-v4.1-flash',
        requests: 616,
        input_tokens: 121901,
        output_tokens: 51836,
        cache_creation_tokens: 0,
        cache_read_tokens: 89326,
        total_tokens: 263063,
        cost: totalCost,
        actual_cost: totalCost,
        account_cost: totalCost,
      },
    ],
  })
}

/**
 * 卡密：`MOCK-OK-0001` 成功、`MOCK-USED-0001` 回 409、其它一律 404。
 * 三条都能被 UI 的「余额已到账 / 已用过 / 卡号错」三个分支各自命中。
 */
const REDEEM_FIXTURES = new Map([
  ['MOCK-OK-0001', { type: 'balance', value: 10 }],
  ['MOCK-USED-0001', { state: 'used' }],
])

/** POST /api/v1/redeem —— 请求体只有 `{code}`，**没有幂等键**（契约 §5 的前提） */
const handleRedeem = ({ res, user, body }) => {
  const code = str(body.code)
  if (!code) {
    fail(res, 400, 'Invalid request: code is required')
    return
  }
  const card = REDEEM_FIXTURES.get(code)
  if (!card) {
    fail(res, 404, 'redeem code not found', 'REDEEM_CODE_NOT_FOUND')
    return
  }
  if (card.state === 'used') {
    fail(res, 409, 'redeem code already used', 'REDEEM_CODE_USED')
    return
  }
  user.balance = Number((user.balance + card.value).toFixed(6))
  user.updated_at = nowISO()
  const history = historyOf(user.id)
  history.unshift({
    id: nextRedeemId++,
    code: `****${code.slice(-4)}`,
    type: card.type,
    value: card.value,
    status: 'used',
    used_by: user.id,
    used_at: nowISO(),
    created_at: nowISO(),
    group_id: null,
    validity_days: 0,
  })
  ok(res, {
    message: 'redeem code redeemed successfully',
    type: card.type,
    value: card.value,
    new_balance: user.balance,
  })
}

/** GET /api/v1/redeem/history —— 不带分页参数回数组（旧的兼容形态），带了回分页信封 */
const handleRedeemHistory = ({ res, user, url }) => {
  const history = historyOf(user.id)
  if (!url.searchParams.has('page') && !url.searchParams.has('page_size')) {
    ok(res, history)
    return
  }
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 20))
  const start = (page - 1) * pageSize
  okPaginated(res, history.slice(start, start + pageSize), history.length, page, pageSize)
}

/** POST /api/v1/user/account-bindings/email/send-code —— 绑定/换绑发码 */
const handleEmailSendCode = ({ res, body }) => {
  if (!str(body.email)) {
    fail(res, 400, 'Invalid request: email is required')
    return
  }
  ok(res, { message: 'verify code sent (mock: any 6 digits will pass)', countdown: 60 })
}

/**
 * POST /api/v1/user/account-bindings/email —— 提交 `{email, verify_code}` 完成绑定。
 * 真实实例还要求 `password`（`BindEmailIdentityRequest`）；mock 不校验，方便 UI 反复试。
 */
const handleEmailBind = ({ res, user, body }) => {
  const email = str(body.email)
  if (!email || !email.includes('@')) {
    fail(res, 400, 'Invalid request: email is required')
    return
  }
  if (!str(body.verify_code)) {
    fail(res, 400, 'Invalid request: verify_code is required')
    return
  }
  user.email = email
  user.username = email.split('@')[0]
  user.updated_at = nowISO()
  ok(res, profileOf(user))
}

/** DELETE /api/v1/user/account-bindings/:provider —— 解绑；mock 只允许解绑第三方 */
const handleUnbind = ({ res, user, params }) => {
  const provider = String(params.provider || '').toLowerCase()
  if (provider === 'email') {
    // 真实实例里邮箱是主身份，不允许解绑（can_unbind=false）
    fail(res, 400, 'email identity cannot be unbound', 'CANNOT_UNBIND_PRIMARY_IDENTITY')
    return
  }
  if (!['linuxdo', 'oidc', 'wechat', 'dingtalk'].includes(provider)) {
    fail(res, 404, `unknown provider: ${provider}`)
    return
  }
  fail(res, 404, 'identity is not bound', 'IDENTITY_NOT_BOUND')
}

// --- apia（支付线）：形状照 `src/services/ours/*.ts` 的既有契约注释 -------------

/** GET /api/plans —— `{plans:[{id,name,price,points,currency,enabled}]}`（价格由服务端定） */
const handlePlans = ({ res }) =>
  sendJSON(res, 200, {
    plans: [
      { id: 'plan-mock-30', name: '体验套餐（mock）', price: 9.9, points: 1000, currency: 'CNY', enabled: true },
      { id: 'plan-mock-90', name: '标准套餐（mock）', price: 29.9, points: 3500, currency: 'CNY', enabled: true },
      { id: 'plan-mock-retired', name: '已下架套餐（mock）', price: 99, points: 12000, currency: 'CNY', enabled: false },
    ],
  })

/** GET|POST /api/pay-link —— `{ok, url, note}`：App 内打开这个收款页，不建单不轮询 */
const handlePayLink = ({ res }) =>
  sendJSON(res, 200, {
    ok: true,
    url: 'https://pay.mock.invalid/mock-shop',
    note: 'mock 收款页地址，打开会失败；用来跑通「App 内打开链接」这条 UI 路径',
  })

/** GET /api/orders —— `{customer_id,total,limit,offset,total_paid_yuan,orders:[...]}` */
const handleOrders = ({ res, url }) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  const orders = [mockOrder('MOCK-ORDER-0001', 'paid'), mockOrder('MOCK-ORDER-0002', 'created')]
  sendJSON(res, 200, {
    customer_id: 'mock-cid-0001',
    total: orders.length,
    limit,
    offset,
    total_paid_yuan: 9.9,
    orders: orders.slice(offset, offset + limit),
  })
}

/** 订单形状（`src/services/ours/trail.ts` 的 `/api/trail` 契约：含 timeline 与 card） */
const mockOrder = (outTradeNo, status) => {
  const createdAt = Math.floor(Date.now() / 1000) - 3600
  const card = status === 'paid' ? { card_no: 'MOCKCARD0001', points: 1000, state: 'redeemed', redeemed_at: createdAt + 60, redeemed_by_customer_id: 'mock-cid-0001', redeemed_key_tail: '8427' } : null
  return {
    out_trade_no: outTradeNo,
    plan_id: 'plan-mock-30',
    amount_yuan: 9.9,
    status,
    status_text: status === 'paid' ? '已支付' : '待支付',
    created_at: createdAt,
    paid_at: status === 'paid' ? createdAt + 30 : null,
    expire_at: createdAt + 1800,
    card,
    timeline: [
      { at: createdAt, event: 'order_created', text: '订单创建（mock）', detail: null },
      ...(status === 'paid'
        ? [
            { at: createdAt + 30, event: 'order_paid', text: '支付成功（mock）', detail: null },
            { at: createdAt + 60, event: 'card_issued', text: '发卡（mock）', detail: { card_no_tail: '0001' } },
          ]
        : []),
    ],
    next_step: status === 'paid' ? null : 'pay',
  }
}

/** GET /api/card/trail?card_no= —— `{card_no, purchase, redemption}` 三段式 */
const handleCardTrail = ({ res, url }) => {
  const cardNo = str(url.searchParams.get('card_no'))
  if (!cardNo) {
    errApia(res, 400, 'BAD_INPUT', '缺少 card_no')
    return
  }
  if (cardNo === 'MOCKCARD9999') {
    errApia(res, 404, 'CARD_NOT_FOUND', '卡密不存在')
    return
  }
  const paidAt = Math.floor(Date.now() / 1000) - 3500
  sendJSON(res, 200, {
    card_no: cardNo,
    purchase: { out_trade_no: 'MOCK-ORDER-0001', plan_id: 'plan-mock-30', amount_yuan: 9.9, paid_at: paidAt, customer_id: 'mock-cid-0001' },
    redemption: { state: 'redeemed', points: 1000, redeemed_at: paidAt + 60, redeemed_by_customer_id: 'mock-cid-0001', redeemed_key_tail: '8427' },
  })
}

// ------------------------------------------------------------------ 路由表（白名单）

/**
 * 白名单：[方法, 路径模板, 处理函数, 是否需要 JWT]。
 * 路径模板里的 `:id` / `:provider` 是单段占位符，与契约 §3 的写法一致。
 * 表外的路径一律 text/plain 404 —— 白名单是**硬边界**，不是建议。
 */
const ROUTES = [
  // §3.1 公共 + 认证
  ['GET', '/api/v1/settings/public', handleSettingsPublic, false],
  ['POST', '/api/v1/auth/register', handleRegister, false],
  ['POST', '/api/v1/auth/login', handleLogin, false],
  ['POST', '/api/v1/auth/send-verify-code', handleSendVerifyCode, false],
  ['POST', '/api/v1/auth/refresh', handleRefresh, false],
  // §3.1 账号与身份（JWT）
  ['GET', '/api/v1/auth/me', handleAuthMe, true],
  ['GET', '/api/v1/user/profile', handleUserProfile, true],
  // §3.1b 邀请（JWT）
  ['GET', '/api/v1/user/aff', handleUserAff, true],
  // §3.2 Key 管理（JWT）
  ['GET', '/api/v1/keys', handleKeysList, true],
  ['POST', '/api/v1/keys', handleKeysCreate, true],
  ['GET', '/api/v1/keys/:id', handleKeysGet, true],
  ['PUT', '/api/v1/keys/:id', handleKeysUpdate, true],
  ['DELETE', '/api/v1/keys/:id', handleKeysDelete, true],
  // §3.3 额度（sk- Key）
  ['GET', '/v1/usage', handleGatewayUsage, 'gateway'],
  // §3.4 卡密兑换（JWT）
  ['POST', '/api/v1/redeem', handleRedeem, true],
  ['GET', '/api/v1/redeem/history', handleRedeemHistory, true],
  // §3.1c 邮箱（JWT；发码那条也是 JWT，未登录场景用 /auth/send-verify-code）
  ['POST', '/api/v1/user/account-bindings/email/send-code', handleEmailSendCode, true],
  ['POST', '/api/v1/user/account-bindings/email', handleEmailBind, true],
  ['DELETE', '/api/v1/user/account-bindings/:provider', handleUnbind, true],
  // §3.5 支付（apia）
  ['GET', '/api/plans', handlePlans, false],
  ['GET', '/api/pay-link', handlePayLink, false],
  ['POST', '/api/pay-link', handlePayLink, false],
  ['GET', '/api/orders', handleOrders, false],
  ['GET', '/api/card/trail', handleCardTrail, false],
]

/** 把 `/api/v1/keys/:id` 编译成正则 + 参数名（只支持单段占位符，够用且不会误匹配跨段） */
const compileRoute = ([method, template, handler, auth]) => {
  const names = []
  const pattern = template.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    names.push(name)
    return '/([^/]+)'
  })
  return { method, template, handler, auth, pattern: new RegExp(`^${pattern}$`), names }
}

const COMPILED_ROUTES = ROUTES.map(compileRoute)

// ------------------------------------------------------------------ 服务器

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  // 预检：浏览器直连联调要过这一关
  if (req.method === 'OPTIONS') {
    send(res, 204, 'text/plain', '')
    return
  }

  // ① 错误态触发开关：优先级最高，命中就直接回，不进路由
  const forced = pickMockError(req, url)
  if (forced) {
    applyMockError(res, forced)
    log(req.method, pathname, `forced:${forced}`)
    return
  }

  // ② admin 面：白名单里没有，但真实实例在 `/api/v1/admin/*` 上回的是**另一个 401 信封**
  //    （40102 / `Authorization required`）。留这一条是为了让 UI 能验证「admin message 不同」，
  //    不是为了实现管理台 —— 任何 admin 路径都只回 401，没有数据。
  if (pathname === '/api/v1/admin' || pathname.startsWith('/api/v1/admin/')) {
    errAdminUnauthorized(res)
    log(req.method, pathname, 401)
    return
  }

  // ③ 白名单路由
  const route = COMPILED_ROUTES.find(
    (item) => item.method === req.method && item.pattern.test(pathname),
  )
  if (!route) {
    // 白名单外（含方法不匹配）：text/plain 404，与真实实例的 gin 默认体一致
    errNotFoundText(res)
    log(req.method, pathname, 404)
    return
  }

  let body = {}
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, `Invalid request: ${error.message}`)
      log(req.method, pathname, 400)
      return
    }
  }

  const rawParams = route.pattern.exec(pathname) ?? []
  const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(rawParams[index + 1] ?? '')]))

  let user = null
  if (route.auth === true) {
    user = requireUser(req, res)
    if (!user) {
      log(req.method, pathname, 401)
      return
    }
  } else if (route.auth === 'gateway') {
    if (!requireGatewayKey(req, res)) {
      log(req.method, pathname, 401)
      return
    }
  }

  route.handler({ req, res, url, params, body, user })
  log(req.method, pathname, 200)
})

/** 一行访问日志：只打方法/路径/结果，不打任何凭据（契约 §7 第 4 条） */
const log = (...parts) => {
  process.stdout.write(`[mock-sub2api] ${parts.join(' ')}\n`)
}

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

/**
 * 端口被占时不要静默换端口：**换了端口的 mock 比没起来更坏**（请求打到了别人的服务上，
 * UI 会「跑绿」在错误的目标上，这就是 #406 说的假绿）。所以打印明确指引再退出。
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      [
        `[mock-sub2api] 端口 ${PORT} 已被占用（${HOST}:${PORT}）。`,
        `[mock-sub2api] 先看清占用者是谁：ss -ltnp | grep :${PORT}`,
        `[mock-sub2api] 真实 sub2api 实例默认在 18000；18080 是 mock 的端口，被别的进程占了就换一个：`,
        `[mock-sub2api]   MOCK_SUB2API_PORT=18081 node tools/mock-sub2api/server.mjs`,
        '',
      ].join('\n'),
    )
    process.exit(1)
  }
  process.stderr.write(`[mock-sub2api] server error: ${error.message}\n`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  // PORT=0 时由内核分配（自检脚本用这个，避免和机器上任何固定端口撞车）
  const actualPort = server.address().port
  const base = `http://${HOST}:${actualPort}`
  process.stdout.write(
    [
      `[mock-sub2api] listening on ${base}`,
      `[mock-sub2api] 白名单路由 ${ROUTES.length} 条（${new Set(ROUTES.map((r) => r[1])).size} 个路径模板）`,
      `[mock-sub2api] 401 码口径 ${ENVELOPE_MODE}（MOCK_SUB2API_ENVELOPE=contract|real）`,
      `[mock-sub2api] 种子账号 demo@mock.local / mock-password（任意邮箱 + 密码≥8 位也能登录）`,
      `[mock-sub2api] 种子 Key ${SEEDED_API_KEY.slice(0, 8)}…${SEEDED_API_KEY.slice(-4)} → GET /v1/usage`,
      `[mock-sub2api] 错误态：加 ?mock_error=auth|admin401|rateLimit|text404|gateway`,
      '',
    ].join('\n'),
  )
})

/** 优雅退出：Ctrl-C 就停，不留连接 */
const shutdown = () => {
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
