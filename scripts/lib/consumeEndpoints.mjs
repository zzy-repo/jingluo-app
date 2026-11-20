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

/** 报错前缀：`config/endpoints.json:13 ` （拿不到行号时退回文件名） */
const where = (lineLines, key) => {
  const line = lineLines?.get(key)
  return line ? `${ENDPOINTS_LABEL}:${line}` : ENDPOINTS_LABEL
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

/** 废弃域 / 明文 http 检查（两个 base 共用一段判据，避免两边各写一套） */
const checkBase = (problems, keyLines, key, value, extraLegacyHosts) => {
  const label = where(keyLines, key)
  const url = parseBaseUrl(value)
  if (!url) {
    problems.push(`${label} ${key} 缺失或不是合法的绝对 URL：${JSON.stringify(value)}`)
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    problems.push(
      `${label} ${key} 必须是 https（明文 http 直接中止构建，#484 §6.3）：${value}` +
        '（唯一例外是本机回环 127.0.0.1 / localhost，用于本地联调实例）'
    )
  }
  if (url.username || url.password) {
    problems.push(`${label} ${key} 不许带凭据（user:pass@）：${value}`)
  }
  if (url.search || url.hash) {
    problems.push(`${label} ${key} 只能是「https://主机[:端口]」，不许带查询串 / 片段：${value}`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    problems.push(
      `${label} ${key} 只能是「https://主机[:端口]」，不许带路径：${value}` +
        '（两套前缀由 apiV1Prefix / gatewayPrefix 拼，写在 base 上会拼成双份）'
    )
  }
  if (value.trim().endsWith('/')) {
    problems.push(`${label} ${key} 末尾不要带 /：${value}（拼 /api/v1/... 会变成 //api/v1/...）`)
  }
  for (const marker of [...DEPRECATED_MARKERS, ...extraLegacyHosts]) {
    if (typeof value === 'string' && value.includes(marker)) {
      problems.push(`${label} ${key} 命中废弃域黑名单 ${marker}（旧池域已下线，#484 §七）：${value}`)
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
 * 校验 `consume` / `pay` 两段，返回问题清单（空数组 = 通过）。
 * `text` 是配置文件原文（用于行号）；不传就没有行号，其它判据不变。
 */
export const validateConsumePay = (raw, text = '') => {
  const keyLines = text ? collectKeyLines(text) : null
  const problems = []
  if (!isPlainObject(raw)) return [`${ENDPOINTS_LABEL} 不是 JSON 对象`]

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
    consumeUrl = checkBase(problems, keyLines, 'consume.baseUrl', consume.baseUrl, readLegacyHosts(raw))
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
    payUrl = checkBase(problems, keyLines, 'pay.baseUrl', pay.baseUrl, readLegacyHosts(raw))
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
export const loadConsumePay = (file = ENDPOINTS_FILE) => {
  const text = readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${ENDPOINTS_LABEL} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const problems = validateConsumePay(raw, text)
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
