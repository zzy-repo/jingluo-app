/**
 * consumeEndpoints.mjs —— `config/endpoints.json` 的 `consume`（sub2api）/ `pay`（apia）两段的
 * **形状 + fail-fast 校验**（Issue #484 §六 / #487 W1-A）。
 *
 * 为什么单独一个文件、而不并进 `endpointsSchema.mjs`：
 *   - `endpointsSchema.mjs` 的既有判据（三个端点在**同一台机器**、主机 / 端口白名单）针对的是
 *     旧池域那三份地址，`consume` / `pay` 是**另外两台机器**，语义上不该被那条规则牵连；
 *   - `validateConsumePay` 需要**配置文件行号**（#484 §6.3 第 4 条：缺字段 / 未知键要打印具体键名
 *     与文件行号），而 `validateEndpoints` 是纯形状校验、拿不到原文。行号靠 `collectKeyLines`
 *     对原文做一次只读扫描得到（不引入 jsonc 解析器，也不许配置文件里出现注释）。
 *
 * 谁读它：
 *   - `scripts/build.mjs`：打包前 fail-fast（不合法直接中止，不留到运行时）；
 *   - `scripts/check-consume-api.mjs`（`pnpm check:consume-api`）：门禁的配置那一条；
 *   - `scripts/lib/endpoints.mjs`：`loadEndpoints()` 顺带校验这两段（脚本 / 测试共用一份事实）。
 *   - `android/app/build.gradle`：同一份 JSON 的另一端，字段与判据**必须一一对应**（改这里要
 *     同步改 gradle 的 `[consume]` 段，否则会出现「pnpm check:consume-api 绿、assembleRelease 红」）。
 *
 * 硬规则（#484 §6.3）：
 *   1. 两个 base 必须 https —— 明文 http 直接中止构建；
 *      **唯一例外**：本机回环（`127.0.0.1` / `localhost` / `[::1]`）。本地联调的 sub2api 实例就是
 *      `http://127.0.0.1:<port>`（维护者 2026-11-20 明确：联调与 base URL 都以本地实例为准）。
 *      例外只对回环成立：任何**非回环**的 `http://` 仍然中止构建 —— 明文出网等于把 Key 交给中间人。
 *   1b. **显式放行通道**（#601 守卫的补正面）：环境变量 `ALLOW_INSECURE_CONSUME=true` 时，非回环明文
 *      与「废弃域黑名单」两条按显式放行处理；产物由构建期打上 `INSECURE_CONSUME=true` 自证标记
 *      （staging-only，`verify:apk` 不带 `--allow-insecure` 直接 exit 1）。**只认字面 true**：
 *      `yes` / `1` / `false` 一律按配置错误处理 —— 逃生舱不能靠拼写猜。
 *      未设置（默认）→ 与以前逐字一致：非回环明文仍然中止。原生侧同一开关是 `-PallowInsecureConsume=true`。
 *   2. base 不得命中废弃域黑名单（`140.210.13.146` / `:60013` / `legacyHosts` 里的旧机器）；
 *   3. `consume.baseUrl` 与 `pay.baseUrl` 不得相同（两个后端职责不能混）；
 *   4. 缺字段 / 空值 / 未知键 → 报出**键名 + 文件行号**。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 端点配置文件（唯一事实来源） */
export const ENDPOINTS_FILE = path.resolve(LIB_DIR, '..', '..', 'config', 'endpoints.json')

/** 配置文件在报错里的显示名 */
export const ENDPOINTS_LABEL = 'config/endpoints.json'

/**
 * 废弃域黑名单（#484 §6.3 第 2 条 / §七 第 1 条）。
 * 这里必须写出这些字面量才能拦住它们，所以整行带 `check-ip-allow`（理由写在这行后面）。
 */
export const DEPRECATED_MARKERS = [
  '140.210.13.146', // check-ip-allow: 门禁黑名单本体，写出来才能拦住「再写一次」
  ':60013', // check-ip-allow: 旧池域端口，出现在任何 base 里都算违规
]

/**
 * web 层地址覆盖通道的环境变量名（Issue #651）。
 *
 * 为什么需要它：`-PconsumeBase` 只写 `BuildConfig.CONSUME_BASE`，**没有任何 Java/Kotlin 读它**；
 * 真正发请求的是 web 层的 `__ENDPOINTS__.consume.baseUrl`，那个值在 `pnpm build` 时就注进产物了。
 * 于是「-PconsumeBase 出包」得到的是「看起来改了、实际仍打生产」的包（#651 实测：override 设成
 * 16000，APK 里 16000 命中 0、生产域名命中 1，形状同 #601）。这里给出**真正能改到 web 层**的通道：
 * 构建期读环境变量改写注入值，优先级 `CONSUME_BASE_OVERRIDE` > `config/endpoints.json`。
 *
 * 判据与配置文件同一套（https / 回环例外 / 废弃域黑名单 / consume≠pay），不放宽任何一条。
 * 名字的唯一出处就是下面这张表 —— 日志、rspack 注入、gradle 交叉核对、文档都引它。
 */
export const BASE_OVERRIDE_ENV = Object.freeze({
  consume: 'CONSUME_BASE_OVERRIDE',
  pay: 'PAY_BASE_OVERRIDE',
})

/**
 * 非回环明文的**显式放行通道**（Issue #601 守卫的补正面；#651 的发版铁律要求 staging 包指向
 * 明文 staging 主机，地址由构建参数传入）。与 gradle 侧的 `-PallowInsecureConsume=true` 是同一件事的两个入口：
 *   · 原生构建期（`-P`）：`android/app/build.gradle` 读，管 BuildConfig + APK 里的 `INSECURE_CONSUME`；
 *   · web 构建期（本文件读的环境变量）：`scripts/build.mjs` / `rspack.config.ts` 读，管产物里的
 *     `__ENDPOINTS__.insecureConsume`（**运行时**据此才肯接受明文，见 `src/services/consume/http.ts`）。
 * 两个入口必须一起传，否则会出「原生侧放了、web 侧还是拒」或反过来的半套包（装上就白屏）。
 */
export const ALLOW_INSECURE_ENV = 'ALLOW_INSECURE_CONSUME'

/**
 * 解析放行开关的取值（**只认字面 true**，与 gradle 的 `-PallowInsecureConsume` 同一条规则）。
 * 返回 `{ allowInsecure, error }`：`error` 非空表示「设了但不合法」，调用方必须中止，不许猜。
 */
export const parseAllowInsecure = (raw) => {
  if (raw === undefined || raw === null) return { allowInsecure: false, error: null }
  const value = String(raw).trim()
  if (value === '') return { allowInsecure: false, error: null }
  if (value === 'true') return { allowInsecure: true, error: null }
  return {
    allowInsecure: false,
    error:
      `${ALLOW_INSECURE_ENV} 只接受字面 true（收到 '${value}'）：这个开关决定「明文 http 的包能不能出、` +
      '以及产物要不要打上 INSECURE_CONSUME 自证标记」，不能靠拼写猜（#601）。要关掉就不设置它，别写 false / 0 / yes。',
  }
}

/** 从环境变量读放行开关（默认 `process.env`，便于用例注入） */
export const allowInsecureFromEnv = (env = process.env) => parseAllowInsecure(env?.[ALLOW_INSECURE_ENV])

/** 每段允许出现的键（未知键 = 拼错的字段，静默忽略只会让人以为配置生效了） */
export const CONSUME_KEYS = ['baseUrl', 'apiV1Prefix', 'gatewayPrefix', 'timeoutMs']
export const PAY_KEYS = ['baseUrl', 'timeoutMs']

/** 超时档位：`consume` 多一档 `redeem`（卡密兑换要等事务落库，#484 §6.1） */
export const CONSUME_TIMEOUT_KEYS = ['read', 'write', 'redeem']
export const PAY_TIMEOUT_KEYS = ['read', 'write']

/** 两个前缀是 sub2api 路由的既有事实（`router.go` 的 `/api/v1` group 与 `gateway.go` 的 `/v1` group） */
export const EXPECTED_API_V1_PREFIX = '/api/v1'
export const EXPECTED_GATEWAY_PREFIX = '/v1'

/** 超时取值范围（毫秒）：太小等于必然超时，太大等于永不超时；上限 120s（#484 §4.3 的 10s/20s/30s 档位） */
export const TIMEOUT_MIN_MS = 1000
export const TIMEOUT_MAX_MS = 120000

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPositiveInt = (value) => Number.isInteger(value) && value > 0

/**
 * 扫一遍配置原文，得到「键路径 → 行号」。
 *
 * 只做一件事：认字符串键 + `:` + 嵌套深度，够用来给报错加行号。
 * 不解析值（值的合法性由调用方按字段判），也不容忍注释 —— 配置文件必须是严格 JSON。
 */
export const collectKeyLines = (text) => {
  const lines = new Map()
  const stack = []
  let line = 1
  let inString = false
  let escaped = false
  let token = ''
  let pendingKey = null
  let expectKey = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') line += 1
    if (inString) {
      if (escaped) {
        escaped = false
        token += ch
      } else if (ch === '\\') {
        escaped = true
        token += ch
      } else if (ch === '"') {
        inString = false
        pendingKey = token
        token = ''
      } else {
        token += ch
      }
      continue
    }
    if (ch === '"') {
      inString = true
      token = ''
      continue
    }
    if (ch === ':') {
      if (expectKey && pendingKey !== null) {
        stack.push(pendingKey)
        lines.set(stack.join('.'), line)
        pendingKey = null
      }
      expectKey = false
      continue
    }
    if (ch === '{' || ch === '[') {
      expectKey = ch === '{'
      continue
    }
    if (ch === '}' || ch === ']') {
      stack.pop()
      pendingKey = null
      expectKey = ch === '}'
      continue
    }
    if (ch === ',') {
      expectKey = true
      pendingKey = null
    }
  }
  return lines
}

/**
 * 报错前缀：`config/endpoints.json:13 ` （拿不到行号时退回文件名）。
 * `label` 用于**非配置文件**的取值来源（环境变量覆盖，见 `applyBaseOverrides`）：
 * 那种值没有行号可指，报错前缀换成环境变量名，否则会把人引到一行没问题的配置上。
 */
const where = (lineLines, key, label = ENDPOINTS_LABEL) => {
  const line = lineLines?.get(key)
  return line ? `${ENDPOINTS_LABEL}:${line}` : label
}

/** 本机回环：只有这几种 host 允许明文 http（本地联调的 sub2api 实例） */
export const isLoopbackHost = (hostname) =>
  hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'

/** 解析 base URL；形态不对返回 null（调用方统一报「缺失或不是合法 URL」） */
export const parseBaseUrl = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value.trim())
  } catch {
    return null
  }
}

/**
 * 废弃域 / 明文 http 检查（两个 base 共用一段判据，避免两边各写一套）。
 *
 * `options.allowInsecure === true`（来自 `ALLOW_INSECURE_CONSUME=true`；gradle 侧同名开关是
 * `-PallowInsecureConsume=true`）时，只放宽两条**与「明文联调」同源**的判据：
 *   · 非回环明文 http；
 *   · 废弃域黑名单命中（staging 机往往就是那台旧 IP —— 不豁免这条，flag 传了也构建不出来）。
 * 形态判据（凭据 / 查询串 / 路径 / 末尾斜杠）、`consume ≠ pay`、超时档位**一条都不放宽**。
 * 放宽时通过 `options.onNotice(消息)` 上报（构建期打 warning，日志里留痕），绝不静默。
 */
const checkBase = (problems, keyLines, key, value, extraLegacyHosts, label = ENDPOINTS_LABEL, options = {}) => {
  const at = where(keyLines, key, label)
  const allowInsecure = options.allowInsecure === true
  const notice = typeof options.onNotice === 'function' ? options.onNotice : () => {}
  const url = parseBaseUrl(value)
  if (!url) {
    problems.push(`${at} ${key} 缺失或不是合法的绝对 URL：${JSON.stringify(value)}`)
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    if (allowInsecure) {
      notice(
        `${at} ${key} 是非回环明文 ${value}：已按 ${ALLOW_INSECURE_ENV}=true 显式放行` +
          '（staging-only；产物会打 INSECURE_CONSUME=true，禁止公开分发）'
      )
    } else {
      problems.push(
        `${at} ${key} 必须是 https（明文 http 直接中止构建，#484 §6.3）：${value}` +
          '（唯一例外是本机回环 127.0.0.1 / localhost，用于本地联调实例）' +
          `（staging 联调包确实要明文时：显式设 ${ALLOW_INSECURE_ENV}=true，原生侧同时传 ` +
          '-PallowInsecureConsume=true；产物会带 INSECURE_CONSUME=true 标记，禁止公开分发）'
      )
    }
  }
  if (url.username || url.password) {
    problems.push(`${at} ${key} 不许带凭据（user:pass@）：${value}`)
  }
  if (url.search || url.hash) {
    problems.push(`${at} ${key} 只能是「https://主机[:端口]」，不许带查询串 / 片段：${value}`)
  }
  // 允许**路径前缀**（如 `/staging`）：客户端拼装是 `${baseUrl}${path}`（见 src/services/consume/http.ts），
  // base 带 `/staging` 与 path 带 `/api/v1` 拼出来的正是 `/staging/api/v1/...`，不会双份。
  // 真正要防的是「base 自己已经含了前缀」→ 那才会拼成 `/api/v1/api/v1`。见 #727 P0 裁决（2026-11-21）。
  const basePath = url.pathname.replace(/\/+$/, '')
  if (basePath !== '' && basePath !== '/') {
    const doubled = [EXPECTED_API_V1_PREFIX, EXPECTED_GATEWAY_PREFIX].some(
      (prefix) => basePath === prefix || basePath.endsWith(prefix)
    )
    if (doubled) {
      problems.push(
        `${at} ${key} 的路径前缀已经包含 ${EXPECTED_API_V1_PREFIX} / ${EXPECTED_GATEWAY_PREFIX}，会拼成双份前缀：${value}` +
          '（base 只写环境前缀，如 `/staging`；两套接口前缀由 apiV1Prefix / gatewayPrefix 拼）'
      )
    }
    if (basePath.includes('//')) {
      problems.push(`${at} ${key} 的路径前缀里出现连续斜杠：${value}`)
    }
  }
  if (value.trim().endsWith('/')) {
    problems.push(`${at} ${key} 末尾不要带 /：${value}（拼 /api/v1/... 会变成 //api/v1/...）`)
  }
  for (const marker of [...DEPRECATED_MARKERS, ...extraLegacyHosts]) {
    if (typeof value === 'string' && value.includes(marker)) {
      if (allowInsecure) {
        // staging 主机往往就是「那台旧池域机器」（地址由构建参数传入，本文件不写死）：不放宽这条，flag 传了也构建不出来。
        // 放宽**只**发生在显式 flag 下，且日志留痕；产物侧另有 INSECURE_CONSUME 标记与 verify:apk 兜底。
        notice(`${at} ${key} 命中废弃域黑名单 ${marker}，已按 ${ALLOW_INSECURE_ENV}=true 显式豁免：${value}`)
        continue
      }
      problems.push(`${at} ${key} 命中废弃域黑名单 ${marker}（旧池域已下线，#484 §七）：${value}`)
    }
  }
  return url
}

/** 一段 `timeoutMs` 的形状 + 单调性（read ≤ write，consume 再多一档 redeem） */
const checkTimeouts = (problems, keyLines, section, value, keys) => {
  const base = `${section}.timeoutMs`
  if (!isPlainObject(value)) {
    problems.push(`${where(keyLines, base)} ${base} 缺失或不是对象（需要 ${keys.join(' / ')} 三档毫秒数）`)
    return null
  }
  const out = {}
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      problems.push(`${where(keyLines, `${base}.${key}`)} ${base}.${key} 是未知键（只认 ${keys.join(' / ')}）`)
    }
  }
  for (const key of keys) {
    const ms = value[key]
    if (!isPositiveInt(ms)) {
      problems.push(`${where(keyLines, `${base}.${key}`)} ${base}.${key} 缺失或不是正整数（毫秒）：${JSON.stringify(ms)}`)
      continue
    }
    if (ms < TIMEOUT_MIN_MS || ms > TIMEOUT_MAX_MS) {
      problems.push(
        `${where(keyLines, `${base}.${key}`)} ${base}.${key} 超出范围 ${TIMEOUT_MIN_MS}–${TIMEOUT_MAX_MS}ms：${ms}`
      )
      continue
    }
    out[key] = ms
  }
  const order = keys.filter((key) => key in out)
  for (let i = 1; i < order.length; i += 1) {
    if (out[order[i]] < out[order[i - 1]]) {
      problems.push(
        `${where(keyLines, `${base}.${order[i]}`)} ${base} 档位必须递增（${order[i - 1]} ≤ ${order[i]}）：` +
          `${out[order[i - 1]]} > ${out[order[i]]}`
      )
    }
  }
  return out
}

/**
 * 把「明文放行开关」归一成 `checkBase` 认的那份 options（**只认字面 true**）。
 * 显式入参 > 环境变量；环境变量设了但取值不合法 → 带 `error`，由调用方记成一条硬错误。
 */
const resolveInsecureFlags = (options = {}) => {
  const onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {}
  if (options.allowInsecure !== undefined) {
    return { allowInsecure: options.allowInsecure === true, onNotice, error: null }
  }
  const fromEnv = allowInsecureFromEnv()
  return { allowInsecure: fromEnv.allowInsecure, onNotice, error: fromEnv.error }
}

/**
 * 校验 `consume` / `pay` 两段，返回问题清单（空数组 = 通过）。
 * `text` 是配置文件原文（用于行号）；不传就没有行号，其它判据不变。
 */
export const validateConsumePay = (raw, text = '', options = {}) => {
  const keyLines = text ? collectKeyLines(text) : null
  const problems = []
  if (!isPlainObject(raw)) return [`${ENDPOINTS_LABEL} 不是 JSON 对象`]
  // 明文放行开关（#601 守卫的补正面）：显式传进来的优先（用例 / 构建脚本），否则读环境变量（只认字面 true）。
  const flags = resolveInsecureFlags(options)
  if (flags.error) problems.push(`${ENDPOINTS_LABEL} ${flags.error}`)

  // `consume` 段：sub2api（账号 / 额度 / 卡密兑换 / Key 管理）
  const consume = raw.consume
  let consumeUrl = null
  let consumePrefixes = null
  if (!isPlainObject(consume)) {
    problems.push(`${where(keyLines, 'consume')} consume 缺失：消费侧（sub2api）的地址与超时唯一来源`)
  } else {
    for (const key of Object.keys(consume)) {
      if (!CONSUME_KEYS.includes(key)) {
        problems.push(
          `${where(keyLines, `consume.${key}`)} consume.${key} 是未知键（只认 ${CONSUME_KEYS.join(' / ')}）`
        )
      }
    }
    for (const key of CONSUME_KEYS) {
      if (!(key in consume)) problems.push(`${where(keyLines, `consume.${key}`)} consume.${key} 缺失`)
    }
    consumeUrl = checkBase(problems, keyLines, 'consume.baseUrl', consume.baseUrl, readLegacyHosts(raw), ENDPOINTS_LABEL, flags)
    if (consume.apiV1Prefix !== EXPECTED_API_V1_PREFIX) {
      problems.push(
        `${where(keyLines, 'consume.apiV1Prefix')} consume.apiV1Prefix 必须是 ${EXPECTED_API_V1_PREFIX}：` +
          `sub2api 的 JWT 路由 group 就是它（${JSON.stringify(consume.apiV1Prefix)}）`
      )
    }
    if (consume.gatewayPrefix !== EXPECTED_GATEWAY_PREFIX) {
      problems.push(
        `${where(keyLines, 'consume.gatewayPrefix')} consume.gatewayPrefix 必须是 ${EXPECTED_GATEWAY_PREFIX}：` +
          `sub2api 的 API Key 路由 group 就是它（${JSON.stringify(consume.gatewayPrefix)}）`
      )
    }
    const timeouts = checkTimeouts(problems, keyLines, 'consume', consume.timeoutMs, CONSUME_TIMEOUT_KEYS)
    if (timeouts && timeouts.read && timeouts.write && timeouts.redeem) {
      consumePrefixes = { apiV1Prefix: consume.apiV1Prefix, gatewayPrefix: consume.gatewayPrefix }
    }
  }

  // `pay` 段：apia（只负责买卡，不迁）
  const pay = raw.pay
  let payUrl = null
  if (!isPlainObject(pay)) {
    problems.push(`${where(keyLines, 'pay')} pay 缺失：支付侧（apia）的地址与超时唯一来源`)
  } else {
    for (const key of Object.keys(pay)) {
      if (!PAY_KEYS.includes(key)) {
        problems.push(`${where(keyLines, `pay.${key}`)} pay.${key} 是未知键（只认 ${PAY_KEYS.join(' / ')}）`)
      }
    }
    for (const key of PAY_KEYS) {
      if (!(key in pay)) problems.push(`${where(keyLines, `pay.${key}`)} pay.${key} 缺失`)
    }
    payUrl = checkBase(problems, keyLines, 'pay.baseUrl', pay.baseUrl, readLegacyHosts(raw), ENDPOINTS_LABEL, flags)
    checkTimeouts(problems, keyLines, 'pay', pay.timeoutMs, PAY_TIMEOUT_KEYS)
  }

  // 两个后端职责不能混（#484 §6.3 第 3 条）
  if (consumeUrl && payUrl) {
    const normalize = (url) => `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '').toLowerCase()
    if (normalize(consumeUrl) === normalize(payUrl)) {
      problems.push(
        `${where(keyLines, 'consume.baseUrl')} consume.baseUrl 与 pay.baseUrl 相同：${consumeUrl.href}` +
          '（消费侧与支付侧是两个后端，职责不能混）'
      )
    }
  }

  void consumePrefixes
  return problems
}

/**
 * 占位地址提醒（**不是错误**，不影响 exit code）。
 *
 * 维护者还没给出 sub2api 真实 host 时，`consume.baseUrl` 只能是 RFC 2606 的保留域名
 * （`*.invalid` 永不解析）。构建与门禁要能过，但每次都要说清楚「现在这个地址是占位的」——
 * 悄悄用一个连不上的地址出包，比构建失败更难查（#487 W1-A 的待填项）。
 */
export const placeholderNotice = (raw) => {
  const url = parseBaseUrl(raw?.consume?.baseUrl)
  if (!url) return null
  if (url.hostname.endsWith('.invalid')) {
    return (
      `consume.baseUrl 仍是占位地址 ${url.hostname}（维护者待提供 sub2api 真实 host，见 #487）：` +
      '消费侧接口在真机上一定连不上，出正式包前必须替换'
    )
  }
  if (isLoopbackHost(url.hostname)) {
    return (
      `consume.baseUrl 指向本机回环 ${url.host}（本地联调实例，见 #487 W1-A）：` +
      '真机 / 正式包必须换成 https 域名，否则手机上的 127.0.0.1 指的是手机自己'
    )
  }
  return null
}

/** 配置里登记的旧机器（`legacyHosts`）：它们同样不许出现在任何 base 里 */
const readLegacyHosts = (raw) => {
  const hosts = Array.isArray(raw?.legacyHosts) ? raw.legacyHosts : []
  return hosts.filter((host) => typeof host === 'string' && host.trim() !== '').map((host) => host.trim())
}

/**
 * 读盘 + 校验，不合法立刻抛（构建期 fail-fast 的唯一入口）。
 * 返回冻结对象：`consume` / `pay` 两段，字段名与 JSON 一一对应。
 */
export const loadConsumePay = (file = ENDPOINTS_FILE, options = {}) => {
  const text = readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${ENDPOINTS_LABEL} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const problems = validateConsumePay(raw, text, options)
  if (problems.length > 0) {
    throw new Error(`${ENDPOINTS_LABEL} 的 consume / pay 两段不合法：\n  - ${problems.join('\n  - ')}`)
  }
  return Object.freeze({
    consume: Object.freeze({
      baseUrl: raw.consume.baseUrl.trim(),
      apiV1Prefix: raw.consume.apiV1Prefix,
      gatewayPrefix: raw.consume.gatewayPrefix,
      timeoutMs: Object.freeze({ ...raw.consume.timeoutMs }),
    }),
    pay: Object.freeze({
      baseUrl: raw.pay.baseUrl.trim(),
      timeoutMs: Object.freeze({ ...raw.pay.timeoutMs }),
    }),
  })
}

/** 比较两个 base 是否「同一个地址」：忽略末尾 `/` 与大小写（与 gradle 侧的判据同口径） */
export const normalizeBaseForCompare = (value) =>
  (typeof value === 'string' ? value.trim() : '').replace(/\/+$/, '').toLowerCase()

/**
 * 把环境变量里的覆盖值套到已校验的 `consume` / `pay` 上（Issue #651）。
 *
 * 语义：**优先级 `CONSUME_BASE_OVERRIDE` > `config/endpoints.json`**（`PAY_BASE_OVERRIDE` 同理）。
 * 这是 web 层**唯一真正有效**的换地址通道：`__ENDPOINTS__.consume.baseUrl` 在 `pnpm build` 时
 * 就注进产物了，`-PconsumeBase` 只写原生侧 `BuildConfig`、没有任何 Java/Kotlin 读它（#651）。
 *
 * 判据与配置文件**同一套**（`checkBase` + consume≠pay），一条都不放宽：
 *   https（本机回环例外）、不带凭据 / 查询串 / 路径 / 末尾 `/`、不命中废弃域黑名单、
 *   `consume` 与 `pay` 生效值不许相同。
 *
 * 返回 `{ config, overrides }`：
 *   - `config`：覆盖后的冻结配置（字段与 `loadConsumePay` 一致，供 rspack 注入）；
 *   - `overrides`：本次真正生效的覆盖（`{ consume?: string, pay?: string }`），构建日志据此打印
 *     `consume=<base> (override by CONSUME_BASE_OVERRIDE)`，让人**一眼看出这份产物不是配置里的地址**。
 */
export const applyBaseOverrides = (config, raw = {}, env = process.env, options = {}) => {
  const legacyHosts = readLegacyHosts(raw)
  const problems = []
  const overrides = {}
  // 覆盖值走**同一套**判据，包括「明文放行」那一条（#601 守卫的补正面）：staging 覆盖成
  // 明文 staging 主机时，只有 ALLOW_INSECURE_CONSUME=true 才放行；
  // 没这个开关，覆盖值照样按 https 判据中止（与配置文件里的值同等待遇，不放宽）。
  const flags = resolveInsecureFlags({ ...options, onNotice: options.onNotice ?? ((msg) => process.stderr.write(`[build][WARN] ${msg}\n`)) })
  if (flags.error) {
    throw new Error(`构建期 base 覆盖不合法（判据与 ${ENDPOINTS_LABEL} 同源）：\n  - ${flags.error}`)
  }

  /** 取某一段的生效 base：环境变量（去掉首尾空白）优先，空值等同于没传 */
  const pickBase = (section) => {
    const envName = BASE_OVERRIDE_ENV[section]
    const provided = env?.[envName]
    const fromConfig = config[section].baseUrl
    if (typeof provided !== 'string' || provided.trim() === '') return fromConfig
    const value = provided.trim()
    overrides[section] = value
    // 判据复用配置文件那一套：不另写一份校验，也不放宽任何一条
    checkBase(problems, null, `${section}.baseUrl`, value, legacyHosts, envName, flags)
    return value
  }

  const consumeBaseUrl = pickBase('consume')
  const payBaseUrl = pickBase('pay')

  // 两个后端职责不能混的判据，对**生效值**再判一次（覆盖后可能撞车，而配置里并不相同）
  if (normalizeBaseForCompare(consumeBaseUrl) === normalizeBaseForCompare(payBaseUrl)) {
    const source = overrides.consume
      ? BASE_OVERRIDE_ENV.consume
      : overrides.pay
        ? BASE_OVERRIDE_ENV.pay
        : ENDPOINTS_LABEL
    problems.push(
      `${source} consume.baseUrl 与 pay.baseUrl 相同（${consumeBaseUrl}）：` +
        '消费侧（sub2api）与支付侧（apia）是两个后端，职责不能混（#484 §6.3）'
    )
  }

  if (problems.length > 0) {
    throw new Error(`构建期 base 覆盖不合法（判据与 ${ENDPOINTS_LABEL} 同源）：\n  - ${problems.join('\n  - ')}`)
  }

  return Object.freeze({
    config: Object.freeze({
      consume: Object.freeze({ ...config.consume, baseUrl: consumeBaseUrl }),
      pay: Object.freeze({ ...config.pay, baseUrl: payBaseUrl }),
    }),
    overrides: Object.freeze({ ...overrides }),
  })
}
