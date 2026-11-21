// [layer: unit | 依赖: 无（纯 Node，不发网络请求） | 耗时: <1s]
//
// Issue #487 W1-A：`src/services/consume/**` 的信封分派与额度解析，**输入全部是实测响应体**。
//
// 为什么用 fixtures 而不是自己编 JSON：这层的错法全是「形状假设错了」，编出来的 JSON 只会验证
// 编的人自己的想象。`tests/fixtures/consume/*.json` 是 2026-11-20 从 sub2api 实例（0.2.22）
// 只读探测抓到的原始响应体（主机名已脱敏移除，其余字节未改）。
//
// fixtures 分两批（文件名前缀就是来源）：
//   - `local-*`：**本地联调实例**（`http://127.0.0.1:18000`，0.2.20）真实 200/404，字段名以此为准；
//   - 其余（`error-*` / `usage-gateway` / `settings-public` …）：线上实例（0.2.22）只读探测的响应体。
// 两批都只做过「凭据脱敏」（token / key 换成占位符），其余字节未改。
//
// ⚠️ 风险披露：两个实例版本不同（0.2.20 / 0.2.22），已观测到的**信封形状**完全一致，但新版本可能
// 再加字段。所以这份用例钉的是「解析器对已观测形状不崩、且分支正确」，不是「字段永远只有这些」；
// 响应多字段不会红（解析器按名字取），少字段会红 —— 那种情况要改的是解析器，不是断言。
//
// 覆盖（逐条对应 #487 的「四套 JSON + 一套纯文本」）：
//   [1] 用户 401 `{code:"UNAUTHORIZED"}`      → middleware 信封（不是面板整数 code）
//   [2] admin 401（message 不同、code 相同）   → 结论与 [1] **完全一致**（证明不看 message）
//   [3] 网关 401 `API_KEY_REQUIRED`            → 文案走「未填 Key」
//   [4] 429 `{error:"rate limit exceeded"}`    → **没有 code 字段**，必须按状态码 + retry-after 分支
//   [5] 未知路径 404 **text/plain**            → 不能 JSON.parse，走纯文本分支（截断入 message）
//   [6] 网关 404 `{"error":{code:"model_not_found"}}` → gateway 信封
//   [7] 400 `api_key_in_query_deprecated`      → middleware 小写码（客户端 bug，不是用户错）
//   [8] 面板 404 `{code:404,...}`              → panel 整数信封
//   [9] 503 `MCP_OAUTH_NOT_CONFIGURED`         → 「功能没开」，不可重试
//   [10] 边缘反代 Basic 401（text/plain）      → 同样按纯文本处理
//   [11] `/v1/usage` 真实 200：`rate_limits` 键不存在、`quota.used` 恒 0、"已用"取 `usage.total.actual_cost`
//   [12] `/api/v1/settings/public` 真实 200：74 字段里的开关
//   [13] 超时档位来自配置（`__ENDPOINTS__.consume.timeoutMs`），调用点不写死毫秒数
//   [14] Key/JWT 只进 Authorization 头；query 里出现 `key` 当场拒绝
//   [15] 非原生平台不发请求（必须走 CapacitorHttp，不许 fetch 兜底）
//   [16] 卡密兑换超时 → 先查历史确认到账（**不盲目重试**）；历史为空 → `pending`（由用户确认再重试）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { parseSub2ApiError, resetConsumeGaps, unmappedConsumeCodes, isSessionError } = await import(
  '../../src/services/consume/errors.ts'
)
const { createConsumeHttp, emptyRawResponse } = await import('../../src/services/consume/http.ts')
const { getGatewayUsage } = await import('../../src/services/consume/usage.ts')
const { getPublicSettings } = await import('../../src/services/consume/auth.ts')
const { redeemCode } = await import('../../src/services/consume/redeem.ts')
const { toAuthSession: toAuthSessionForTest } = await import('../../src/services/consume/auth.ts')
const { toConsumeUser: toConsumeUserForTest } = await import('../../src/services/consume/auth.ts')
const { toConsumeApiKey: toConsumeApiKeyForTest, toConsumePage: toConsumePageForTest } = await import(
  '../../src/services/consume/keys.ts'
)
const { consumeTimeouts } = await import('../../scripts/lib/endpoints.mjs')

/** 读一份实测 fixture：返回 `{meta, body, raw}`（body 去掉 `_meta` / `_note` 这类说明键） */
const load = (name) => {
  const file = JSON.parse(readFileSync(new URL(`../fixtures/consume/${name}`, import.meta.url), 'utf8'))
  const meta = file._meta ?? {}
  const body = {}
  for (const [key, value] of Object.entries(file)) {
    if (key.startsWith('_')) continue
    body[key] = value
  }
  return { meta, body, file }
}

/** 把一份实测体包成 `ConsumeRawResponse`（content-type 取 `_meta` 里记的真值） */
const rawOf = (name, overrides = {}) => {
  const { meta, body } = load(name)
  const isText = (meta.content_type ?? '').includes('text') || body.__text !== undefined
  const text = overrides.text ?? JSON.stringify(body)
  return {
    status: overrides.status ?? meta.http_status ?? 200,
    ok: (overrides.status ?? meta.http_status ?? 200) < 300,
    text,
    json: overrides.json !== undefined ? overrides.json : isText ? null : body,
    headers: overrides.headers ?? {},
    contentType: overrides.contentType ?? meta.content_type ?? 'application/json',
  }
}

test('[1][2][3] 三套 401 形状：只看 code，不看 message', () => {
  const { body, file } = load('error-401.json')
  // 实测顶层体就是用户侧那一条
  assert.equal(body.code, 'UNAUTHORIZED')
  assert.equal(body.message, 'Authorization header is required')

  const user = parseSub2ApiError(rawOf('error-401.json'))
  assert.equal(user.envelope, 'middleware')
  assert.equal(user.kind, 'auth')
  assert.equal(user.code, 'UNAUTHORIZED')
  assert.equal(user.i18nKey, 'consumeErrUnauthorized')
  assert.equal(user.retryable, false)
  assert.equal(isSessionError(user), true, '会话类错误要能被 W1-B 认出来（据此决定 refresh）')

  // 实测记录里的 admin 变体：**code 相同、message 不同** → 结论必须一致
  const adminVariant = file._meta.variants_observed.find((item) => item.trigger.startsWith('/api/v1/admin'))
  assert.ok(adminVariant, 'fixture 里应当有 admin 401 变体')
  assert.notEqual(adminVariant.message, body.message)
  const admin = parseSub2ApiError({
    ...emptyRawResponse(),
    status: 401,
    text: JSON.stringify({ code: adminVariant.code, message: adminVariant.message }),
    json: { code: adminVariant.code, message: adminVariant.message },
    contentType: 'application/json',
  })
  assert.equal(admin.code, user.code)
  assert.equal(admin.kind, user.kind)
  assert.equal(admin.i18nKey, user.i18nKey, 'message 不同不许影响分支（admin 的文案是 "Authorization required"）')

  // 网关 401：同一个 401，文案要指「未填 Key」而不是「请登录」
  const gatewayVariant = file._meta.variants_observed.find((item) => item.code === 'API_KEY_REQUIRED')
  const gateway = parseSub2ApiError({
    ...emptyRawResponse(),
    status: 401,
    text: JSON.stringify({ code: gatewayVariant.code, message: gatewayVariant.message }),
    json: { code: gatewayVariant.code, message: gatewayVariant.message },
    contentType: 'application/json',
  })
  assert.equal(gateway.i18nKey, 'consumeErrKeyMissing')
})

test('[4] 429 是第三套信封：{error:"..."}，没有 code —— 必须按状态码 + retry-after 分支', () => {
  const { body, file } = load('error-429.json')
  assert.equal(body.error, 'rate limit exceeded')
  assert.equal(body.code, undefined, '实测 429 没有 code 字段：任何 if (body.code === ...) 都不会触发')

  const error = parseSub2ApiError(
    rawOf('error-429.json', { status: 429, headers: { 'retry-after': file._meta.retry_after_header } })
  )
  assert.equal(error.envelope, 'error_string')
  assert.equal(error.kind, 'rate_limit')
  assert.equal(error.code, 'HTTP_429', '没有服务端码时用状态码占位，不编一个假的 RATE_LIMITED')
  assert.equal(error.retryable, true)
  assert.equal(error.retryAfterMs, 59_000, '按 retry-after 秒数倒计时，客户端不自己算节奏')
  assert.equal(error.i18nKey, 'consumeErrRateLimited')
})

test('[5][10] 纯文本响应（未知路径 404 / 边缘反代 401）不许 JSON.parse', () => {
  const unknown = load('error-404-unknown-path.json')
  assert.equal(unknown.meta.content_type, 'text/plain')
  const notFound = parseSub2ApiError({
    ...emptyRawResponse(),
    status: 404,
    text: unknown.file._raw_text_body,
    json: null,
    contentType: 'text/plain',
  })
  assert.equal(notFound.envelope, 'text')
  assert.equal(notFound.nonJson, true)
  assert.equal(notFound.kind, 'unknown')
  assert.equal(notFound.code, 'HTTP_404')
  assert.match(notFound.message, /404 page not found/)

  // 边缘反代 Basic 认证：同样是 text/plain，但语义是「没权限」
  const basic = load('edge-basic-auth-401.json')
  assert.equal(basic.meta.http_status, 401)
  const unauthorized = parseSub2ApiError({
    ...emptyRawResponse(),
    status: 401,
    text: basic.file._raw_text_body ?? 'authentication required',
    json: null,
    contentType: 'text/plain',
  })
  assert.equal(unauthorized.envelope, 'text')
  assert.equal(unauthorized.kind, 'auth')
  assert.equal(unauthorized.i18nKey, 'consumeErrUnauthorized')
})

test('[6][7][8][9][11] 四种 JSON 信封 + 未知码记缺口', () => {
  resetConsumeGaps()

  // 网关：{error:{code,...}}，code 是小写 snake
  const gateway = parseSub2ApiError(rawOf('error-404-model-not-found.json', { status: 404 }))
  assert.equal(gateway.envelope, 'gateway')
  assert.equal(gateway.code, 'model_not_found')
  assert.equal(gateway.kind, 'unknown')

  // 中间件：小写码（api_key_in_query_deprecated）= 客户端 bug，归 bad_request
  const inQuery = parseSub2ApiError(rawOf('error-400-api-key-in-query.json', { status: 400 }))
  assert.equal(inQuery.envelope, 'middleware')
  assert.equal(inQuery.code, 'api_key_in_query_deprecated')
  assert.equal(inQuery.kind, 'key')

  // 面板：整数 code（业务开关关闭）
  const plaza = parseSub2ApiError(rawOf('error-404-model-plaza-disabled.json', { status: 404 }))
  assert.equal(plaza.envelope, 'panel')
  assert.equal(plaza.kind, 'unknown')
  assert.equal(plaza.code, 'HTTP_404', '面板整数 code 没有 reason 时不当业务码用')

  // 503 未配置：功能没开，不是「稍后重试」
  const mcp = parseSub2ApiError(rawOf('error-503-mcp-not-configured.json', { status: 503 }))
  assert.equal(mcp.code, 'MCP_OAUTH_NOT_CONFIGURED')
  assert.equal(mcp.kind, 'unknown')
  assert.equal(mcp.retryable, false)

  // 网关 404 的另一种：unknown API path
  const health = parseSub2ApiError(rawOf('health-404-unknown-api-path.json', { status: 404 }))
  assert.equal(health.envelope, 'gateway')
  assert.equal(health.kind, 'unknown')

  // 映射表覆盖不到的服务端码 → 记一条缺口（不静默、也不当成「未知错误」乱兜底）
  const unknownCode = parseSub2ApiError({
    ...emptyRawResponse(),
    status: 418,
    text: '{"code":"SOME_NEW_CODE","message":"x"}',
    json: { code: 'SOME_NEW_CODE', message: 'x' },
    contentType: 'application/json',
  })
  assert.equal(unknownCode.code, 'SOME_NEW_CODE')
  assert.ok(unmappedConsumeCodes().some((item) => item.includes('SOME_NEW_CODE')), '未映射的码要进缺口清单')
})

test('[12] /v1/usage 真实 200：rate_limits 键不存在、quota.used 不可信、"已用"取 actual_cost', async () => {
  const { body } = load('usage-gateway.json')
  assert.equal(body.rate_limits, undefined, '实测该键整个不存在')
  assert.equal(body.quota.used, 0, '实测 quota.used 恒为 0')
  assert.ok(body.usage.total.actual_cost > 0)

  const http = createConsumeHttp({
    apiKey: () => 'sk-test',
    transport: async () => ({
      kind: 'response',
      status: 200,
      text: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
  const result = await getGatewayUsage(http)
  assert.equal(result.ok, true)
  assert.equal(result.data.isValid, true)
  assert.equal(result.data.mode, 'quota_limited')
  assert.deepEqual(result.data.rateLimits, [], '缺键就是空数组，绝不 undefined.map')
  assert.equal(result.data.quota.limit, 2)
  assert.equal(result.data.remaining, 2)
  assert.ok(Math.abs(result.data.spent - 0.051435696) < 1e-9, '已用 = usage.total.actual_cost')
  assert.equal(result.data.usageTotal.requests, 616)
  assert.equal(result.data.usageTotal.totalTokens, 263063)
})

test('[13] /api/v1/settings/public 真实 200：开关是 74 个字段里的真值', async () => {
  const { body } = load('settings-public.json')
  const http = createConsumeHttp({
    accessToken: () => 'jwt-test',
    transport: async () => ({
      kind: 'response',
      status: 200,
      text: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
  const result = await getPublicSettings(http)
  assert.equal(result.ok, true)
  assert.equal(result.data.registrationEnabled, false)
  assert.equal(result.data.emailVerifyEnabled, false)
  assert.equal(result.data.invitationCodeEnabled, false)
  assert.equal(result.data.paymentEnabled, false)
  assert.equal(result.data.affiliateEnabled, false)
  assert.equal(result.data.modelPlazaEnabled, false)
  assert.equal(result.data.version, '0.2.22', '版本号是排查「字段为什么对不上」的第一手线索')
  assert.equal(result.data.siteName, 'Sub2API')
})

test('[14][15] 超时从配置读；Key/JWT 只进 header；非原生走 fetch 兜底（不再 unsupported）', async () => {
  const calls = []
  const http = createConsumeHttp({
    accessToken: () => 'jwt-abc',
    apiKey: () => 'sk-abc',
    transport: async (request) => {
      calls.push(request)
      return { kind: 'response', status: 200, text: '{}', headers: { 'content-type': 'application/json' } }
    },
  })

  await http.request({ method: 'GET', path: '/v1/usage' })
  await http.request({ method: 'POST', path: '/api/v1/redeem', body: { code: 'X' }, timeout: 'redeem' })

  assert.equal(calls[0].timeoutMs, consumeTimeouts.read, 'GET 走 read 档（配置值，不是硬编码）')
  assert.equal(calls[0].headers.authorization, 'Bearer sk-abc', '网关通道用 sk- Key')
  assert.equal(calls[1].timeoutMs, consumeTimeouts.redeem, '兑换走 redeem 档')
  assert.equal(calls[1].headers.authorization, 'Bearer jwt-abc', '面板通信用 JWT')
  assert.ok(!calls[0].url.includes('sk-abc'), 'Key 不许出现在 URL 里')

  // query 里塞鉴权参数：当场拒绝（sub2api 会回 400 api_key_in_query_deprecated）
  assert.throws(() => http.url('/v1/usage', { key: 'sk-abc' }), /鉴权参数/)

  /**
   * 非原生平台（浏览器预览）：默认 transport 现在**改走 fetch 兜底**（`webTransport`），
   * 目的是让维护者能在 Web 上真跑登录 / 注册。原生分支（`capacitorTransport`）**一个字都没改**：
   * 它仍然是原生下的唯一选择，上面那些断言照旧覆盖它。
   *
   * 所以这里断言的是新口径：非原生**不再**返回 `unsupported`，而是真的把请求发了出去
   * （node 里有全局 `fetch`，请求会真的打到配置里的 staging 地址并拿回 401；
   * 这里只要求「不是 `UNSUPPORTED_PLATFORM`」即可，证明选择点已经切到 fetch）。
   */
  const webFallback = createConsumeHttp({ apiKey: () => 'sk-abc' })
  const webResult = await webFallback.call({ method: 'GET', path: '/v1/usage' })
  assert.equal(webResult.ok, false, '没有真实上游时仍然失败')
  assert.notEqual(
    webResult.error.code,
    'UNSUPPORTED_PLATFORM',
    '非原生不再走 unsupported：默认 transport 已切到 fetch 兜底'
  )
})

test('[16] 卡密兑换超时：先查历史确认到账，绝不盲目重试', async () => {
  const code = 'MUSE-TEST-0000-ABCD-1234'
  const history = {
    code: 0,
    message: 'success',
    data: { items: [{ code: 'MUSE-****-1234', type: 'balance', value: 10 }], total: 1 },
  }

  const posts = []
  const http = createConsumeHttp({
    accessToken: () => 'jwt-abc',
    transport: async (request) => {
      if (request.method === 'POST' && request.url.endsWith('/api/v1/redeem')) {
        posts.push(request)
        return { kind: 'timeout' }
      }
      if (request.method === 'GET' && request.url.includes('/api/v1/redeem/history')) {
        return { kind: 'response', status: 200, text: JSON.stringify(history), headers: { 'content-type': 'application/json' } }
      }
      return { kind: 'network' }
    },
  })

  const credited = await redeemCode(http, { code })
  assert.equal(posts.length, 1, '第一发只发一次：超时也不重发')
  assert.equal(credited.kind, 'redeemed')
  assert.equal(credited.credited, 'history', '靠历史确认已到账，而不是靠重发去赌')

  // 历史查不到 → pending（可以重试，但必须由用户确认），且**不许**自动发第二枪
  const emptyHistory = { code: 0, message: 'success', data: { items: [], total: 0 } }
  const posts2 = []
  const http2 = createConsumeHttp({
    accessToken: () => 'jwt-abc',
    transport: async (request) => {
      if (request.method === 'POST') {
        posts2.push(request)
        return { kind: 'timeout' }
      }
      return { kind: 'response', status: 200, text: JSON.stringify(emptyHistory), headers: { 'content-type': 'application/json' } }
    },
  })
  const pending = await redeemCode(http2, { code })
  assert.equal(posts2.length, 1, '未确认到账也不许自动重试')
  assert.equal(pending.kind, 'pending')
  assert.equal(pending.verified, 'not_credited')
  assert.equal(pending.canRetry, true)

  // 用户确认后重试一次：这一次调用最多两发（首发 + 确认后的一发），且不再继续重试
  const before = posts2.length
  const confirmed = await redeemCode(http2, { code, retryAfterConfirm: true })
  assert.equal(posts2.length - before, 2, '用户确认后允许一次额外 POST，但仅此一次')
  assert.equal(confirmed.kind, 'pending', '第二次仍超时 → 仍是 pending，不进入无限重试')
  assert.equal(confirmed.retried, true)
})

test('[17] 本地实测 200：登录 / me / keys / 面板 usage 的字段名（不再靠推测）', async () => {
  const login = load('local-login-200.json')
  assert.equal(login.body.code, 0, '登录是面板信封 {code:0,message,data}')
  assert.deepEqual(Object.keys(login.body.data).sort(), ['access_token', 'expires_in', 'refresh_token', 'token_type', 'user'])

  const session = toAuthSessionForTest(login.body.data)
  assert.equal(session.tokenType, 'Bearer')
  assert.equal(session.expiresIn, 86400)
  assert.ok(session.accessToken.length > 0, 'access_token 必须被解析出来（W1-B 就靠它）')
  assert.equal(session.user.email, 'qa-test@local.test')
  assert.equal(session.user.role, 'user')
  assert.equal(typeof session.user.balance, 'number', 'balance 是数字（单位元，1 元 = 1 额度）')
  // 登录体里的 user 不带 identities（实测），绑定明细要另外读 /user/profile 或 /auth/me
  assert.equal(session.user.identities, undefined)

  const me = load('local-auth-me-200.json')
  const user = toConsumeUserForTest(me.body.data)
  assert.equal(user.id, 2)
  assert.equal(user.concurrency, 5)
  assert.equal(user.allowedGroups, null, 'allowed_groups:null = 不限，不是空数组')
  assert.equal(user.rpmLimit, 0)
  assert.equal(user.emailBound, true, 'identities.email.bound 要投影成 emailBound')
  assert.equal(user.identities?.email?.canUnbind, false, '绑定项自带 can_unbind，客户端不自己推')

  const keys = load('local-keys-list-200.json')
  const page = toConsumePageForTest(keys.body.data, toConsumeApiKeyForTest)
  assert.equal(page.total, 3)
  assert.equal(page.pageSize, 50)
  assert.equal(page.items.length, 3)
  const first = page.items[0]
  assert.equal(first.status, 'active')
  assert.equal(first.quota, 0, 'quota:0 = 不限')
  assert.equal(first.quotaUsed, 0)
  assert.equal(first.currentConcurrency, 0)
  assert.equal(first.rateLimit5h, 0)
  assert.equal(first.lastUsedAt !== undefined, true, 'last_used_at 可能是 null')

  const panelUsage = load('local-usage-panel-200.json')
  assert.deepEqual(Object.keys(panelUsage.body.data).sort(), ['items', 'page', 'page_size', 'pages', 'total'], '面板 /api/v1/usage 是分页信封')
})

test('[18] 本地实测错误态：redeem 404 带 reason；网关切权限时 error 里只有 type', () => {
  const redeem = parseSub2ApiError({
    status: 404,
    ok: false,
    text: JSON.stringify(load('local-redeem-404.json').body),
    json: load('local-redeem-404.json').body,
    headers: {},
    contentType: 'application/json',
  })
  assert.equal(redeem.envelope, 'panel')
  assert.equal(redeem.reason, 'REDEEM_CODE_NOT_FOUND', 'reason 优先于整数 code')
  assert.equal(redeem.code, 'REDEEM_CODE_NOT_FOUND')
  assert.equal(redeem.kind, 'redeem')
  assert.equal(redeem.i18nKey, 'consumeErrCardNotFound')

  const permission = parseSub2ApiError({
    status: 403,
    ok: false,
    text: JSON.stringify(load('local-gateway-403-permission.json').body),
    json: load('local-gateway-403-permission.json').body,
    headers: {},
    contentType: 'application/json',
  })
  assert.equal(permission.envelope, 'gateway')
  assert.equal(permission.code, 'permission_error', 'error.code 缺失时退回 error.type')
  assert.equal(permission.kind, 'key')
  assert.equal(permission.retryable, false)
})

test('[19] 本地 /v1/usage 真实 200：与线上同样没有 rate_limits、quota.used 为 0', async () => {
  const { body } = load('local-usage-gateway-200.json')
  assert.equal(body.rate_limits, undefined)
  assert.equal(body.quota.used, 0)
  const http = createConsumeHttp({
    apiKey: () => 'sk-test',
    transport: async () => ({
      kind: 'response',
      status: 200,
      text: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
  const result = await getGatewayUsage(http)
  assert.equal(result.ok, true)
  assert.equal(result.data.isValid, true)
  assert.equal(result.data.quota.limit, 1, 'quota.limit 来自创建 Key 时给的 1 元额度')
  assert.equal(result.data.spent, 0, '新 Key 没消耗 → actual_cost 0')
  assert.equal(result.data.usageTotal.requests, 0)
})
