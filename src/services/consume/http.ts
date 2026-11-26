/**
 * sub2api 消费侧的**传输层**（Issue #484 §六 / #487 W1-A）。
 *
 * 这一层只做三件事：拼 URL、发请求、把**原始响应**原样交出去。
 *   - 不解释业务语义（`{code,message,data}` 三套信封的解析在 errors.ts）；
 *   - 不读 localStorage、不 import 界面代码 —— 地址、前缀、超时全部从构建期注入的
 *     `__ENDPOINTS__.consume` 取（唯一来源 `config/endpoints.json`，见 #484 §6.1/6.2）；
 *   - **原生走 `CapacitorHttp`，Web 走浏览器 `fetch`**（同一份产物既部署网页也打进 APK）。
 *     #484 §4.6 记的「`allowed_origins` 默认空数组 → WebView 裸 `fetch()` 必然失败」**在生产网关上
 *     不成立**（2026-11-23 实测 `consume.baseUrl` 指向的那台 sub2api，后端配置是
 *     `cors: { allowed_origins: ["*"], allow_credentials: false }`）：预检 `OPTIONS /api/v1/payment/orders/my` → **204** +
 *     `access-control-allow-origin: *` + `allow-headers` 含 `Authorization` + `max-age: 86400`；
 *     `GET /api/v1/pay-link` → 200 带 `*`；无 token 的 `GET /api/v1/payment/orders/my` → 401 **仍带** `*`。
 *     所以浏览器端可以直接 fetch。**但 `*` 等于不带 credentials**：身份**只能**走 `Authorization` 头，
 *     **不能**靠 cookie —— 这也正是本层唯一的鉴权方式；凭据也**绝不进 query**（见 `FORBIDDEN_QUERY_KEYS` 守卫）。
 *     两条分支返回**完全相同的形状**（`response` / `timeout` / `network`）；只有真的没有 `fetch` 的
 *     环境（`typeof fetch !== 'function'`）才回 `unsupported`，由调用方给「请在 App 内使用」——
 *     把「跑不了」伪装成「网络不好」是历史上最难查的一类假红。
 *
 * 安全（#484 §7 红线）：
 *   - Key / JWT **只进 `Authorization` 请求头**；URL 里出现 `key` / `api_key` / `token` /
 *     `access_token` 一律当场抛错（sub2api 会回 400 `api_key_in_query_deprecated`，那是客户端 bug）；
 *   - 本文件不打印任何请求头或请求体；错误文案由上层按 i18n key 出，不带 token / 卡密原文。
 *
 * 「401 → 单飞刷新 → 重放一次」（#740 ①）：本层**不做**刷新，也不 import 身份层 —— 它只提供一个
 * 注入点 `onUnauthorized`，由身份层（`services/auth/store.ts` 的 `handleUnauthorized`）决定
 * 「换到新凭据了吗、能不能重放」。这样刷新策略只有一份、单飞（同一时刻一次 `/auth/refresh`）也只有一份，
 * 而这一层仍然只认识状态码。重放**只重放一次**：重放后的 401 原样交上去，绝不进「刷新 → 401 → 刷新」的循环。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

import { classifyNetFailure, type NetFailureMeta } from '../net/networkPhase.js'
import { timeoutBudget } from '../net/timeoutBudget.js'
import { parseSub2ApiError, type Sub2ApiError } from './errors.js'

/** 一条 base 上的两套路由（之间**没有**重写规则，见 #484 §4.1 第 3 条） */
export type ConsumeChannel = 'panel' | 'gateway'

/** 超时档位：只读 / 写操作 / 卡密兑换（三档都在配置里，调用点不许写死毫秒数） */
export type ConsumeTimeoutClass = 'read' | 'write' | 'redeem'

export type ConsumeMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** `config/endpoints.json` 的 `consume` 段（形状与 `__ENDPOINTS__.consume` 一致） */
export type ConsumeEndpoints = {
  baseUrl: string
  apiV1Prefix: string
  gatewayPrefix: string
  timeoutMs: { read: number; write: number; redeem: number }
}

/** 鉴权通道：JWT（面板 `/api/v1/**`）与 sk- Key（网关 `/v1/**`）是**两条独立通道** */
export type ConsumeAuth = { kind: 'jwt'; token: string } | { kind: 'apiKey'; key: string }

/** 一次请求的描述（`path` 是**完整路径**，必须落在白名单内、且带配置里的前缀） */
export type ConsumeRequest = {
  method: ConsumeMethod
  /** 例如 `/api/v1/auth/login`、`/v1/usage`（白名单见 docs/consume-layer.md 与 check:consume-api） */
  path: string
  /** 查询串（可选）：鉴权参数不许放这里（`key` / `token` 等会被当场拒绝） */
  query?: Record<string, string | number | boolean | undefined | null>
  /** JSON 请求体（对象会被序列化；字符串原样发出） */
  body?: unknown
  /** 显式指定鉴权；缺省用 client 注入的 accessToken / apiKey；`null` = 匿名（公共接口，别带旧 token） */
  auth?: ConsumeAuth | null
  /** 超时档位；缺省按方法推（GET → read，其余 → write） */
  timeout?: ConsumeTimeoutClass
}

/** 原始响应：`status === 0` 表示**没拿到响应**（超时 / 连不上 / 平台不支持） */
export type ConsumeRawResponse = {
  /** HTTP 状态码；0 = 传输层失败（见 `failure`） */
  status: number
  ok: boolean
  text: string
  /** 解析出来的 JSON（解析不了就是 null，原文永远留在 text 里） */
  json: unknown
  /** 小写化的响应头 */
  headers: Record<string, string>
  /** `content-type`（小写、去参数）：错误分派要靠它判断「这是不是 JSON」（#487 实测：未知路径 404 是 text/plain） */
  contentType: string
  /** 只在 status === 0 时有值 */
  failure?: 'timeout' | 'network' | 'unsupported'
  /**
   * **分段归因**（#895 follow-up）：只在 `status === 0` 时有值，由 `failureOf()` 产出。
   *
   * 为什么要带上整个 meta 而不是只带 phase：上层（`consume/errors.ts`）只取 `phase`，
   * 但诊断日志迟早要 `evidence`（凭什么判的）—— 三处各判一遍必然会分叉（见 #895 文件头）。
   * 可选字段：老调用点 / 老替身 transport 不传它就等于「没有证据」，不影响任何既有形状。
   */
  net?: NetFailureMeta
  /**
   * **只在「401 + 换凭据没换成」时有值**（#740 ①）：把「刷新失败的两种性质」带到上层。
   *  - `expired`  ：刷新被服务端拒（401 / `REFRESH_TOKEN_EXPIRED`）—— 身份层已清态，界面该回登录；
   *  - `retryable`：刷新是网络 / 5xx 失败 —— **本地 token 还留着**，这次 401 只是「这次没换成」，
   *                 `call()` 会把 `error.retryable` 置 true（原来 401 一律不可重试，这条是唯一的例外）。
   */
  refreshFailure?: 'expired' | 'retryable'
}

/** 传输层入参（不含任何业务语义，测试可以直接断言它） */
export type ConsumeTransportRequest = {
  method: ConsumeMethod
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export type ConsumeTransportResult =
  | {
      kind: 'response'
      status: number
      text: string
      /** 小写化后的响应头（`location` 也在这里，别只看下面那个字段） */
      headers: Record<string, string>
      /**
       * `Location` 头（从上面那张表里按大小写不敏感取出来的同一份值）。
       * 两条分支都**不跟随重定向**，所以 3xx 的跳转目标只能这样交给上层解释；没有该头就是 `undefined`。
       */
      location?: string
    }
  | { kind: 'timeout'; net?: NetFailureMeta }
  | { kind: 'network'; net?: NetFailureMeta }
  | { kind: 'unsupported' }

/** 传输层：默认原生 CapacitorHttp；单测注入假 transport（不发真请求） */
export type ConsumeTransport = (request: ConsumeTransportRequest) => Promise<ConsumeTransportResult>

/**
 * 401 换凭据的**决策**（#740 ①，由身份层给）：
 *  - `retry`     ：已经换到新凭据 → 本层把原请求**重放一次**；
 *  - `expired`   ：刷新被服务端拒（401 / `REFRESH_TOKEN_EXPIRED`）→ 会话已清，别再试；
 *  - `retryable` ：刷新因网络 / 5xx 没成功，**本地 token 保留** → 这次 401 原样交上去但标成可重试。
 */
export type ConsumeRefreshDecision = 'retry' | 'expired' | 'retryable'

/**
 * 交给 `onUnauthorized` 的现场信息：**只有路由与动作**，没有任何凭据 ——
 * 身份层不需要、也不许拿它去记日志 / 埋点（#387 红线：token 类一律不进日志）。
 */
export type ConsumeUnauthorizedInfo = {
  method: ConsumeMethod
  path: string
}

/**
 * 「业务请求 401 了，要不要换凭据再来一次」的钩子。**由身份层注入**（`auth/store.ts`），
 * 本层不知道 refresh_token 在哪、也不碰存储。
 * 钩子抛异常时按「没换成、也不可重试」处理（原 401 原样交上去），见 `request()` 的 catch。
 */
export type ConsumeUnauthorizedHandler = (
  info: ConsumeUnauthorizedInfo
) => Promise<ConsumeRefreshDecision> | ConsumeRefreshDecision

/**
 * **绝不触发刷新**的路径：登录 / 注册 / 刷新自己 401 时不能去刷新（登录失败 ≠ 会话过期），
 * 否则「密码输错」会被当成「token 过期」把本地会话清掉（#740 ①行 7）。
 */
const NO_REFRESH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/login/2fa',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
])

/** URL 里不许出现的鉴权参数名（#484 §2.1：sub2api 对 query 里的 key 直接 400） */
const FORBIDDEN_QUERY_KEYS = ['key', 'api_key', 'apikey', 'token', 'access_token', 'refresh_token']

const TIMEOUT_HINTS = ['timeout', 'timed out', 'time out']

/**
 * 把 CapacitorHttp / fetch 抛出的异常折成「超时 / 连不上」**加上分段归因**（#895 follow-up）。
 *
 * 改前这里只回答一个问题（超时还是连不上），于是原生栈抛上来的
 * `UnknownHostException` / `ConnectException` / `SSLHandshakeException`
 * 全部被折成 `'network'` —— DNS / TCP / TLS 的原话是在**这一层**被扔掉的。
 * 现在把异常原文原样交给 `classifyNetFailure()`（判据只有一份，不在这里另写正则）：
 * 判得出就写 phase，判不出就 `undefined`，**不硬塞一个 tcp 冒充知道**。
 *
 * `kind` 的口径一个字没改（超时 → `timeout`，其余 → `network`）：
 * 上层按 `kind` 分支、按 `code` 决定文案，这次只是多带一份证据上去。
 */
const failureOf = (error: unknown): { kind: 'timeout' | 'network'; net: NetFailureMeta } => {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  const lower = text.toLowerCase()
  const timedOut = lower.includes('abort') || TIMEOUT_HINTS.some((hint) => lower.includes(hint))
  return {
    kind: timedOut ? 'timeout' : 'network',
    net: classifyNetFailure({ nativeMessage: text }),
  }
}

/**
 * 响应头归一：**小写 key** 的 `Record<string, string>`。原生与 Web 两条分支共用 ——
 * 上层靠 `content-type` 分派错误（缺了会误判），`Location` 也靠它统一大小写。
 */
const normalizeHeaders = (raw: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {headers[name.toLowerCase()] = String(value)}
  return headers
}

/** 拼「拿到了响应」的结果：两条分支共用，保证形状与语义（含 `location`）完全一致 */
const responseResult = (
  status: number,
  text: string,
  headers: Record<string, string>
): ConsumeTransportResult => ({
  kind: 'response',
  status,
  text,
  headers,
  // `location` 只是原样透传：原生侧因为 `disableRedirects` 能读到跳转目标，Web 侧跟随重定向后
  // 通常没有这个头（见 `webRequest` 注释）。**消费侧目前没有任何调用方读它**，留着是为了形状一致。
  location: headers.location === '' ? undefined : headers.location,
})

/**
 * 原生分支：`CapacitorHttp`。
 *
 * `connectTimeout` / `readTimeout` 全部来自配置档位；不跟随重定向（业务接口没有需要跟随的 3xx，
 * 跟随反而会把状态码与 Location 一起藏起来）。
 */
const nativeRequest = async (request: ConsumeTransportRequest): Promise<ConsumeTransportResult> => {
  try {
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      // string 原样发出：content-type 由 headers 决定（对象会被 Capacitor 再序列化一次）
      data: request.body,
      responseType: 'text',
      connectTimeout: request.timeoutMs,
      readTimeout: request.timeoutMs,
      disableRedirects: true,
    })
    const headers = normalizeHeaders((response.headers ?? {}) as Record<string, string>)
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    return responseResult(response.status, text, headers)
  } catch (error) {
    const failure = failureOf(error)
    return { kind: failure.kind, net: failure.net }
  }
}

/**
 * Web 分支：浏览器 `fetch`（同一份产物部署成网页时走这里）。
 *
 * 与 `nativeRequest` 的**语义逐条对齐**：
 *  - 超时用 `request.timeoutMs`（`AbortController` + `setTimeout`，`finally` 里清 timer；
 *    不用 `AbortSignal.timeout` —— Chromium 83 / 旧 Safari 没有它）；
 *  - 响应头同样**小写化**（`Headers.forEach` 的 name 已经是小写，仍显式归一，防止替身实现不守规矩）；
 *  - `responseType: 'text'` 等价于 `response.text()`；body 字符串原样发出，`Content-Type` 由 headers 决定；
 *  - 异常折叠沿用同一个 `failureOf()`（超时 → `timeout`，其它 → `network`），不另写一套判定。
 *
 * **重定向是一个有意保留的差异：Web 走 `redirect: 'follow'`，不跟原生对齐。**
 * 原生不跟随是因为 `CapacitorHttp` 拿得到状态码与 `Location`；浏览器跨域下 `redirect: 'manual'`
 * 只会给 opaque-redirect（`status 0`、头与体都读不到），既读不到 `Location`、又会把一次
 * 「http→https」这类本该自动过去的跳转变成「连不上」，比跟随更难查。业务接口本来就不该回 3xx，
 * 所以两种写法在正常路径上等价 —— 选一个出错时更容易解释的。
 *
 * 凭据只走 `Authorization` 头：生产网关的 CORS 是 `allowed_origins: ["*"]` + `allow_credentials: false`，
 * 带 cookie 的跨域请求会被浏览器直接拒（而且 `*` 本来就不带凭据），所以显式 `credentials: 'omit'`。
 */
const webRequest = async (request: ConsumeTransportRequest): Promise<ConsumeTransportResult> => {
  // 只有真的没有 `fetch` 的环境才算「跑不了」：这是 `unsupported`（不是「网络不好」）
  if (typeof fetch !== 'function') {return { kind: 'unsupported' }}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      // string 原样发出：content-type 由 headers 决定（与原生分支同一语义）
      body: request.body,
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {headers[name.toLowerCase()] = value})
    return responseResult(response.status, await response.text(), headers)
  } catch (error) {
    const failure = failureOf(error)
    return { kind: failure.kind, net: failure.net }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 默认传输：**本函数只做分派**，两条实现各自独立（不复制粘贴同一段）。
 *
 * 原生 → `CapacitorHttp`（不受 CORS 约束、可读任意响应头）；其余 → 浏览器 `fetch`。
 * 非原生**不再**一律返回 `unsupported`：生产网关的 CORS 是 `*`（见文件头实测），浏览器能直连，
 * 而 `unsupported` 只留给「连 `fetch` 都没有」的环境 —— 那时说「跑不了」才是真话。
 */
export const capacitorTransport: ConsumeTransport = (request) =>
  Capacitor.isNativePlatform() ? nativeRequest(request) : webRequest(request)

/**
 * 只走原生的传输：**给「本来就只能在 App 内做」的链路**（历史账号迁移 `services/legacy/migration`）。
 *
 * 为什么需要它：`capacitorTransport` 放开 Web 之后，非原生环境会真的发请求；而迁移那类链路
 * 在网页端本来就没有对应能力，旧行为是明确回 `unsupported` → 界面给「请在 App 内使用」。
 * 有了这个导出，业务代码里就不必再写 `if (isNativePlatform())`（平台分支只允许存在这一处）。
 */
export const nativeOnlyTransport: ConsumeTransport = async (request) =>
  Capacitor.isNativePlatform() ? nativeRequest(request) : { kind: 'unsupported' }

/** 配置读取失败（缺字段 / 明文 http / 不是绝对地址）：**启动即抛**，不带着错地址跑 */
export class ConsumeConfigError extends Error {
  readonly missing: readonly string[]

  constructor(message: string, missing: readonly string[] = []) {
    super(message)
    this.name = 'ConsumeConfigError'
    this.missing = missing
  }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

/**
 * 从 `__ENDPOINTS__.consume` 读配置并校验（每次调用都读，便于测试注入 / 少一份缓存副本）。
 *
 * 打包环境由 rspack 的 DefinePlugin 注入；`node --test` 由 tests/helpers/injected.mjs 预加载。
 * 非法时抛 `ConsumeConfigError` 并**点名缺了哪个键** —— 只抛一句「配置错误」等于让人去猜。
 */
export const readConsumeEndpoints = (): ConsumeEndpoints => {
  const injected = typeof __ENDPOINTS__ === 'undefined' ? undefined : __ENDPOINTS__
  const consume = injected?.consume as Partial<ConsumeEndpoints> | undefined
  if (!consume) {
    throw new ConsumeConfigError(
      '__ENDPOINTS__.consume 缺失：消费侧地址只能来自 config/endpoints.json 的 consume 段（#484 §6.1）',
      ['consume']
    )
  }
  const missing: string[] = []
  if (!isNonEmptyString(consume.baseUrl)) {missing.push('consume.baseUrl')}
  if (!isNonEmptyString(consume.apiV1Prefix)) {missing.push('consume.apiV1Prefix')}
  if (!isNonEmptyString(consume.gatewayPrefix)) {missing.push('consume.gatewayPrefix')}
  for (const key of ['read', 'write', 'redeem'] as const) {
    if (!isPositiveInt(consume.timeoutMs?.[key])) {missing.push(`consume.timeoutMs.${key}`)}
  }
  if (missing.length > 0) {
    throw new ConsumeConfigError(`__ENDPOINTS__.consume 缺字段或为空：${missing.join(' / ')}`, missing)
  }
  const baseUrl = (consume.baseUrl as string).trim()
  // https 是默认要求；**唯一例外（默认）**是本机回环（本地联调的 sub2api 实例就是回环上的明文，只有本机可达）。
  // 非回环的明文 http 一律拒绝：那等于把 Key 交给中间人（#484 §6.3 / §七 第 5 条）。
  //
  // 第二个例外是「产物自证」的 staging 明文联调包（Issue #601 守卫的补正面 / #651）：构建期
  // `ALLOW_INSECURE_CONSUME=true`（原生侧同名开关 `-PallowInsecureConsume=true`）会往 `__ENDPOINTS__`
  // 注入 `insecureConsume: true`，与 APK 里的 `INSECURE_CONSUME` meta-data、`BuildConfig.INSECURE_CONSUME`
  // **同源同一件事**。运行时不像构建期能读 -P / 环境变量，所以判据只能是产物里的标记：
  // 没有标记就一律拒绝，绝不按「这地址看起来是联调机」去猜。
  //
  // 这一层不是可选的：`src/main.tsx` 在**模块级**就调 `getConsumeClient()`，这里 throw 的后果是
  // 「装上了但一开就白屏」—— 只放行构建期、不放行运行时，产出的是 #601 形状的坏包（发出去不能用）。
  const insecureConsume = (injected as { insecureConsume?: boolean } | undefined)?.insecureConsume === true
  const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(baseUrl)
  if (!baseUrl.toLowerCase().startsWith('https://') && !loopback && !insecureConsume) {
    throw new ConsumeConfigError(
      `__ENDPOINTS__.consume.baseUrl 必须是 https（明文 http 一律拒绝，#484 §6.3）：${baseUrl}` +
        '（staging 明文联调包要用 ALLOW_INSECURE_CONSUME=true 出包，产物会带 INSECURE_CONSUME=true 标记且禁止公开分发）',
      ['consume.baseUrl']
    )
  }
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    apiV1Prefix: consume.apiV1Prefix as string,
    gatewayPrefix: consume.gatewayPrefix as string,
    /**
     * 超时的**取值**走运行期策略源（#896 3a）：默认值仍然是上面校验过的
     * `__ENDPOINTS__.consume.timeoutMs`（一个数字没动），但多了一层运行期覆盖
     * （弱网模式 / 联调 / 用例），不必为此重新构建产物。
     */
    timeoutMs: {
      read: timeoutBudget.consume('read'),
      write: timeoutBudget.consume('write'),
      redeem: timeoutBudget.consume('redeem'),
    },
  }
}

/** 「没有返回体」的成功态（204 / DELETE）：用它代替 `void` 作泛型参数（`void` 不能当类型用） */
export type ConsumeEmpty = undefined

/** 本地参数校验失败时用的空响应（没有真发请求，所以 status 0、body 空） */
export const emptyRawResponse = (): ConsumeRawResponse => ({
  status: 0,
  ok: false,
  text: '',
  json: null,
  headers: {},
  contentType: '',
})

/** `call()` 的结果：拿到 2xx 且信封合法 → `ok: true`；否则 `ok: false` + 归一化错误 */
export type ConsumeCallResult<T> =
  | { ok: true; data: T; status: number; raw: ConsumeRawResponse }
  | { ok: false; error: Sub2ApiError; raw: ConsumeRawResponse }

/** 创建 http 传输实例时注入的东西（W1-B 只管把 token 存取接上来，不用关心拼 URL） */
export type ConsumeHttpOptions = {
  transport?: ConsumeTransport
  /** JWT 提供者：每次请求取一次，刷新 token 之后立刻生效 */
  accessToken?: () => string | undefined
  /** sk- Key 提供者：只用于 `/v1/**`（网关 / 额度） */
  apiKey?: () => string | undefined
  /** 端点覆盖（默认读 `__ENDPOINTS__.consume`；只给测试用） */
  endpoints?: ConsumeEndpoints
  /**
   * 业务请求拿到 **401** 时的换凭据钩子（#740 ①②）：身份层注入，本层不认识 refresh_token。
   * 不给 = 老行为（401 原样抛给上层）。只在「JWT 通道 + 非登录/注册/刷新路径」时被调用。
   */
  onUnauthorized?: ConsumeUnauthorizedHandler
}

export type ConsumeHttp = {
  readonly endpoints: ConsumeEndpoints
  /** 通道 + 完整路径 → 绝对 URL（同时做前缀与 query 鉴权参数校验） */
  url: (path: string, query?: ConsumeRequest['query']) => string
  /** 发一次请求，返回**原始响应**（非 2xx 不抛错，交给 parseSub2ApiError 分派信封） */
  request: (request: ConsumeRequest) => Promise<ConsumeRawResponse>
  /** request + 信封解包 + 错误归一（业务模块用这个） */
  call: <T>(request: ConsumeRequest & { unwrap?: 'panel' | 'bare' }) => Promise<ConsumeCallResult<T>>
  /** 是否配了 sk- Key（卡密补偿里 `/v1/usage` 那条路要用） */
  hasApiKey: () => boolean
}

const buildQuery = (query: ConsumeRequest['query']): string => {
  if (!query) {return ''}
  const parts: string[] = []
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {continue}
    if (FORBIDDEN_QUERY_KEYS.includes(name.toLowerCase())) {
      throw new Error(
        `查询串里不许出现鉴权参数 ${name}：Key / JWT 只进 Authorization 头（sub2api 会回 400 api_key_in_query_deprecated）`
      )
    }
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/** 默认超时档位：只读请求走 read，其余走 write（卡密兑换显式传 redeem） */
const timeoutClassOf = (request: ConsumeRequest): ConsumeTimeoutClass =>
  request.timeout ?? (request.method === 'GET' ? 'read' : 'write')

const defaultHeaders: Record<string, string> = {
  accept: 'application/json',
}

/**
 * 创建传输实例。
 * 注意：**不做任何业务重试**。重试策略按端点分类（#484 §4.3），写在各自的业务模块里 ——
 * 传输出错就重发一次是这个仓库最贵的教训之一（卡密重复兑换、Key 重复创建都是这么来的）。
 *
 * 唯一的例外是「401 → 换凭据 → **重放一次**」（#740）：它重试的是**同一个**已经被服务端明确拒绝的
 * 请求（401 说明没有产生副作用），而且只重放一次；`onUnauthorized` 没注入时连这一次都没有。
 */
export const createConsumeHttp = (options: ConsumeHttpOptions = {}): ConsumeHttp => {
  // 唯一的选择点：`capacitorTransport` 自己分派（原生 `CapacitorHttp` / Web `fetch`），
  // 这里不再做平台判断 —— 平台分支只允许存在一份（`nativeRequest` / `webRequest`）。
  // 单测注入 `transport` 时完全不碰真实请求。
  const transport = options.transport ?? capacitorTransport
  const endpoints = options.endpoints ?? readConsumeEndpoints()

  const url = (path: string, query?: ConsumeRequest['query']): string => {
    if (!path.startsWith('/')) {throw new Error(`消费侧路径必须是以 / 开头的完整路径：${path}`)}
    if (!path.startsWith(endpoints.apiV1Prefix) && !path.startsWith(endpoints.gatewayPrefix)) {
      throw new Error(
        `路径 ${path} 不在配置的两个前缀之内（${endpoints.apiV1Prefix} / ${endpoints.gatewayPrefix}）：` +
          '两套路由之间没有重写规则（#484 §4.1）'
      )
    }
    return `${endpoints.baseUrl}${path}${buildQuery(query)}`
  }

  const resolveAuth = (request: ConsumeRequest): ConsumeAuth | null => {
    if (request.auth !== undefined) {return request.auth}

    // 网关路径只认 sk- Key；面板路径只认 JWT —— 混用的后果是 401 INVALID_API_KEY / INVALID_TOKEN
    if (request.path.startsWith(endpoints.gatewayPrefix)) {
      const key = options.apiKey?.()
      return key ? { kind: 'apiKey', key } : null
    }
    const token = options.accessToken?.()
    return token ? { kind: 'jwt', token } : null
  }

  /**
   * 发**一次**（不带任何 401 逻辑）：把这次的 `auth` 一起交回去 ——
   * 「这次 401 是不是 JWT 引起的」只能在这里判断（网关 sk- Key 的 401 不该去换 JWT）。
   */
  const send = async (req: ConsumeRequest): Promise<{ raw: ConsumeRawResponse; auth: ConsumeAuth | null }> => {
    // 每次请求都问一次运行期策略源（#896 3a）：默认值仍是这个实例的 `endpoints.timeoutMs`
    const timeoutClass = timeoutClassOf(req)
    const timeoutMs = timeoutBudget.consume(timeoutClass, endpoints.timeoutMs[timeoutClass])
    const headers: Record<string, string> = { ...defaultHeaders }
    const auth = resolveAuth(req)
    if (auth) {headers.authorization = `Bearer ${auth.kind === 'jwt' ? auth.token : auth.key}`}
    // 请求体：对象序列化成 JSON，字符串原样（调用点自己保证 content-type 与内容一致）
    const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    if (body !== undefined) {headers['content-type'] = 'application/json'}
    const result = await transport({ method: req.method, url: url(req.path, req.query), headers, body, timeoutMs })
    if (result.kind !== 'response') {
      return {
        auth,
        raw: {
          status: 0,
          ok: false,
          text: '',
          json: null,
          headers: {},
          contentType: '',
          failure: result.kind,
          ...('net' in result && result.net !== undefined ? { net: result.net } : {}),
        },
      }
    }
    let json: unknown = null
    if (result.text.trim() !== '') {
      try {
        json = JSON.parse(result.text)
      } catch {
        json = null
      }
    }
    return {
      auth,
      raw: {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        text: result.text,
        json,
        headers: result.headers,
        contentType: (result.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      },
    }
  }

  /**
   * 这次响应要不要去换凭据？四条同时成立才换（#740 ①）：
   *  1. 状态码是 **401**（403 是权限不足，刷新解决不了）；
   *  2. 这次请求带的是 **JWT**（sk- Key 的 401 与账号会话无关，拿 JWT 去重放只会更乱）；
   *  3. 路径**不是**登录 / 注册 / 刷新自己（见 `NO_REFRESH_PATHS`）；
   *  4. 身份层真的注入了钩子（没注入 = 老行为，401 原样交上去）。
   */
  const shouldTryRefresh = (req: ConsumeRequest, tried: { raw: ConsumeRawResponse; auth: ConsumeAuth | null }): boolean =>
    req.path !== '' &&
    tried.raw.status === 401 &&
    tried.auth?.kind === 'jwt' &&
    !NO_REFRESH_PATHS.has(req.path) &&
    typeof options.onUnauthorized === 'function'

  const request = async (req: ConsumeRequest): Promise<ConsumeRawResponse> => {
    const first = await send(req)
    if (!shouldTryRefresh(req, first)) {
      return first.raw
    }
    let decision: ConsumeRefreshDecision
    try {
      decision = await (options.onUnauthorized as ConsumeUnauthorizedHandler)({
        method: req.method,
        path: req.path,
      })
    } catch {
      // 钩子自己炸了（身份层不该抛，抛了也不能把业务请求带崩）：按「这次没换成」处理，
      // 但**不加** `retryable` 标记 —— 那是刷新「因为网络没成」的专用语义，不是「钩子写错了」。
      return first.raw
    }
    if (decision === 'retry') {
      // **只重放一次**：这次重放拿的是新 token（`resolveAuth` 每次现取），若又 401 就原样交上去，
      // 不再问钩子 —— 防「刷新 → 401 → 刷新」的死循环（#740 ①）。
      return (await send(req)).raw
    }
    return { ...first.raw, refreshFailure: decision }
  }

  const call = async <T>(req: ConsumeRequest & { unwrap?: 'panel' | 'bare' }): Promise<ConsumeCallResult<T>> => {
    const raw = await request(req)
    const unwrap = req.unwrap ?? (req.path.startsWith(endpoints.apiV1Prefix) ? 'panel' : 'bare')
    if (!raw.ok) {
      const error = parseSub2ApiError(raw, { path: req.path })
      // 401 + 刷新因网络 / 5xx 没成：**这次可以重试**（`error` 其余字段保持 401 语义不变，界面照常提示重新登录）。
      return { ok: false, error: raw.refreshFailure === 'retryable' ? { ...error, retryable: true } : error, raw }
    }
    // 空响应（204 / DELETE）也是成功：面板接口的 data 可能整个省掉
    if (raw.status === 204 || raw.text.trim() === '') {return { ok: true, data: undefined as T, status: raw.status, raw }}
    if (unwrap === 'bare') {
      // 网关 /v1/usage、/v1/sub2api/billing **不套** {code,message,data} 信封（#484 §四）
      return { ok: true, data: raw.json as T, status: raw.status, raw }
    }
    const envelope = raw.json as { code?: unknown; message?: unknown; data?: unknown } | null
    if (!envelope || typeof envelope !== 'object' || envelope.code !== 0) {
      // 2xx 但信封不对：不要把它当成功（否则界面会显示空数据而不是「响应异常」）
      return { ok: false, error: parseSub2ApiError(raw, { path: req.path }), raw }
    }
    return { ok: true, data: envelope.data as T, status: raw.status, raw }
  }

  return {
    endpoints,
    url,
    request,
    call,
    hasApiKey: () => Boolean(options.apiKey?.()),
  }
}
