/**
 * 第三方服务的**协议自动适配**（Issue #794）。
 *
 * 背景：#794 取消了「第三方服务」子页里的 OpenAI / Anthropic 协议二选一 —— 用户只填
 * 「服务地址 / API Key / 模型」，协议由本模块判定。判定结果**不新造状态**：最终仍然落到既有的
 * `ProviderKind`（`openai` / `anthropic`）上（写回 `chat-demo:provider-kind`），
 * 请求路径、鉴权头、能力位继续照 `providers.ts` 的 spec 走，一个字都不用改。
 *
 * ## 判据（越具体越先；前三条不碰网络）
 *
 *  1. `baseUrl` 主机：等于 `api.anthropic.com` 或主机名里含 `anthropic` → anthropic；
 *  2. 模型名：以 `claude` 开头（不区分大小写）→ anthropic；
 *  3. 判定缓存（按 baseUrl 存，见 `apiConfig.rememberProtocol`）：上次实测的结论直接用；
 *  4. 兜底探测：向 baseUrl 发一次极轻量的 `GET {base}/v1/models`，`Authorization: Bearer`（OpenAI 风格）
 *     与 `x-api-key`（Anthropic 风格）各试一次。**只有两者结论不同才算探明白**，探明白才落缓存；
 *  5. 沿用既有协议字段：`chat-demo:provider-kind` 里现在的那个（#794 之前用户亲手选的就是它，
 *     「旧配置提示」因此**不需要新键、不需要迁移** —— 它原值就在这位上，读坏值也已有 fail-closed）。
 *
 * 关于 3/4/5 与 issue 编号的差别（3 排在「旧配置提示」之前、5 排在探测之后）：issue 的第 3 条是
 * 「沿用 `chat-demo:provider-kind`」，而那个键**几乎总是有值**；若把它排在缓存与探测之前，
 * 缓存就永远写不进去、探测永远轮不到，自动适配会退化成「一直沿用第一次的值」。
 * 所以实际顺序是「**实测证据**（缓存 / 探测）优先，其次是**沿用既有值**」，两者都是 issue 要的
 * 「老配置作为初始提示」，只是把「提示」放在「没有证据时」的位置上。
 *
 * ## 不阻塞首条消息（issue 的 3s 口径）
 *
 * 只有走到第 4 步才需要网络，且那一步在发送链路里按预算等（`PROTOCOL_DECIDE_BUDGET_MS` = 3s）：
 *  - 预算内探明白 → 当场应用（并落缓存）；
 *  - 超时 / 探不出结论 → **一个字段都不改**，这条消息按第 5 步的「既有协议」发出去，探测留在
 *    后台继续跑，结论只进缓存，下一条消息直接用。绝不拿没验证过的猜测去改写用户的 `ProviderKind`
 *    ——那会把一个能用的配置改成必然 400 的请求。
 */
import {
  adoptThirdPartyConfig,
  getApiKey,
  getBaseUrl,
  getModel,
  getProviderKind,
  isThirdPartyKind,
  joinUrl,
  normalizeBaseUrl,
  readCachedProtocol,
  rememberProtocol,
  setProviderKind,
} from './apiConfig.js'
import type { ProviderProtocol } from './providers.js'

/** Anthropic 官方端点：主机完全相等即判定 */
export const ANTHROPIC_OFFICIAL_HOST = 'api.anthropic.com'

/** 主机名里的「anthropic」标记（自建中转常写成 `anthropic-proxy.example.com`） */
export const ANTHROPIC_HOST_MARK = 'anthropic'

/** Claude 模型的前缀（`claude-3-5-sonnet-20241022` / `Claude-3-opus` 都算） */
export const CLAUDE_MODEL_PREFIX = 'claude'

/** 探测请求的路径：只取模型列表，不产生费用 */
export const PROTOCOL_PROBE_PATH = '/v1/models'

/** 探测本身的超时（issue：≤3s） */
export const PROTOCOL_PROBE_TIMEOUT_MS = 3000

/** 判定结论的出处：`source` 只用于诊断与测试断言，不参与请求构造 */
export type ProtocolSource = 'host' | 'model' | 'cache' | 'legacy-hint' | 'default' | 'probe'

export type ProtocolVerdict = {
  protocol: ProviderProtocol
  source: ProtocolSource
  /** `true` = 这只是兜底值，还没探过（调用方应在预算内探一次） */
  needsProbe: boolean
}

/** 主机判据：`baseUrl` 的主机名含 `anthropic`（含官方域）→ anthropic；其余 null（不表态） */
export const protocolFromHost = (baseUrl: string): ProviderProtocol | null => {
  const raw = baseUrl.trim()
  if (raw === '') {
    return null
  }
  let host = ''
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    // 非法地址不在这里判死：保存时 `normalizeBaseUrl` 已经拦过，这里只需要「不表态」
    return null
  }
  if (host === '') {
    return null
  }
  if (host === ANTHROPIC_OFFICIAL_HOST || host.includes(ANTHROPIC_HOST_MARK)) {
    return 'anthropic'
  }
  return null
}

/** 模型判据：`claude` 前缀（不区分大小写）→ anthropic；其余 null */
export const protocolFromModel = (model: string): ProviderProtocol | null =>
  model.trim().toLowerCase().startsWith(CLAUDE_MODEL_PREFIX) ? 'anthropic' : null

/**
 * 纯判定（无 IO、无存储）：把已知线索收成一个结论。
 *
 * 前三档给出确定结论（`needsProbe: false`）；都不成立时返回**兜底**结论并置 `needsProbe: true`
 * —— 兜底值就是「既有协议字段」（`currentKind`，老配置里等于用户当年选的那个；第三方槽位
 * 首次进入时是 `openai`），调用方据此在预算内探一次：探明白就用探测结论，探不出来就用它。
 *
 * 测试与调用方都只看这一个函数的口径；`ensureThirdPartyProtocol()` 在外面只加两件事
 * —— 需要时探一次、把结论应用回 `ProviderKind`。
 */
export const resolveProtocol = (input: {
  baseUrl: string
  model: string
  /** 这条 baseUrl 上次探测的结论（`apiConfig.readCachedProtocol`） */
  cached?: ProviderProtocol | null
  /** 既有协议字段（`chat-demo:provider-kind`）当前的值；不是第三方渠道就是 null */
  currentKind?: ProviderProtocol | null
}): ProtocolVerdict => {
  const byHost = protocolFromHost(input.baseUrl)
  if (byHost !== null) {
    return { protocol: byHost, source: 'host', needsProbe: false }
  }
  const byModel = protocolFromModel(input.model)
  if (byModel !== null) {
    return { protocol: byModel, source: 'model', needsProbe: false }
  }
  if (input.cached === 'anthropic' || input.cached === 'openai') {
    return { protocol: input.cached, source: 'cache', needsProbe: false }
  }
  const fallback = input.currentKind === 'anthropic' || input.currentKind === 'openai' ? input.currentKind : null
  return {
    protocol: fallback ?? 'openai',
    source: fallback === null ? 'default' : 'legacy-hint',
    needsProbe: true,
  }
}

/**
 * 把判定结论应用回 `ProviderKind`：协议变了就**先搬值再换 kind**（幂等，同一个结论不动任何东西）。
 *
 * 「搬值」见 `apiConfig.adoptThirdPartyConfig` —— 地址/模型按渠道分开存，协议一换、键一换，
 * 用户刚填的地址就会凭空消失（#794 第 2 条验收要防的就是这个）。
 */
const applyProtocol = (protocol: ProviderProtocol): boolean => {
  const current = getProviderKind()
  if (!isThirdPartyKind(current) || current === protocol) {
    return false
  }
  adoptThirdPartyConfig(protocol)
  setProviderKind(protocol)
  return true
}

export type ProtocolProbeInput = {
  baseUrl: string
  apiKey: string
  /** 总预算（两次尝试共享），默认 `PROTOCOL_PROBE_TIMEOUT_MS` */
  timeoutMs?: number
  /** 测试注入用；不传就是全局 `fetch` */
  fetchImpl?: typeof fetch
}

/**
 * 极轻量探测：`GET {base}/v1/models`，两种鉴权各试一次 —— `Authorization: Bearer`（OpenAI 风格）
 * 与 `x-api-key`（Anthropic 风格）。
 *
 * **只有两种鉴权给出不同答案时才定论**：
 *  - 只有 Bearer 通 → `openai`；只有 `x-api-key` 通 → `anthropic`；
 *  - 两种都通（宽松网关 / 中转不校验鉴权头）或都不通 → `null`（没有结论）。
 *
 * 为什么要求「不同」：宽松网关对两种头都回 200，谁先谁赢的写法会稳定地猜错一半；
 * 空头/鉴权无关的网关更是完全不可判。没有结论时不改写任何东西（见 `ensureThirdPartyProtocol`），
 * 比按一个假结论把协议换掉安全得多。
 *
 * 刻意**不落任何副作用**（不 `markKeyRejected`、不写存储）：探测失败不代表这把 Key 不可用
 * ——它只是「这个地址不是那种协议」，把它记成「Key 被判死」会让模型列表与自动探测一起停摆（#303）。
 */
export const probeProtocol = async (input: ProtocolProbeInput): Promise<ProviderProtocol | null> => {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (!baseUrl) {
    return null
  }
  const apiKey = input.apiKey.trim()
  if (apiKey === '') {
    // 没有 Key 只能拿回 401：两把都试也只是两次必然失败，直接兜底
    return null
  }
  const url = joinUrl(baseUrl, PROTOCOL_PROBE_PATH)
  const timeoutMs = input.timeoutMs ?? PROTOCOL_PROBE_TIMEOUT_MS
  const doFetch = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const attempt = async (headers: Record<string, string>): Promise<boolean> => {
    try {
      const response = await doFetch(url, { method: 'GET', headers, signal: controller.signal })
      return response.ok
    } catch {
      return false
    }
  }
  try {
    const bearerOk = await attempt({ Authorization: `Bearer ${apiKey}` })
    if (controller.signal.aborted) {
      return null
    }
    const apiKeyOk = await attempt({ 'x-api-key': apiKey })
    if (bearerOk === apiKeyOk) {
      // 两种头得到同一答案 = 这个网关不按鉴权头区分协议，探不出东西
      return null
    }
    return bearerOk ? 'openai' : 'anthropic'
  } finally {
    clearTimeout(timer)
  }
}

/** 本会话已经探过的地址：遵守「只探一次」（失败也不反复打，重启应用自然重来） */
const probedHosts = new Set<string>()

/** 同一条地址的探测正在跑：并发发送共用同一次探测，不重复打上游 */
const inflight = new Map<string, Promise<ProviderProtocol | null>>()

/**
 * 「只探一次」的入口：同一条 baseUrl 在同一会话里最多真正探一次，并发调用共用同一个 Promise。
 * 探测失败的地址也记账（`probedHosts`），所以不会每条消息都去打一遍上游。
 */
export const probeProtocolOnce = (input: ProtocolProbeInput): Promise<ProviderProtocol | null> => {
  const key = input.baseUrl.trim()
  if (key === '' || input.apiKey.trim() === '') {
    // 没有地址 / 没有 Key 都不记账：那种情况探测一定失败，但它说明的是「配置还没填完」，
    // 不该把这条地址永久标记成「探过了」，否则用户填好 Key 之后反而再也探不到。
    return Promise.resolve(null)
  }
  const running = inflight.get(key)
  if (running !== undefined) {
    return running
  }
  if (probedHosts.has(key)) {
    return Promise.resolve(null)
  }
  probedHosts.add(key)
  const task = probeProtocol(input).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, task)
  return task
}

/** 测试用：清掉「本会话探过哪些地址」与在途探测（生产代码不会调它） */
export const resetProtocolProbeState = (): void => {
  probedHosts.clear()
  inflight.clear()
}

export type ProtocolDecision = {
  protocol: ProviderProtocol
  source: ProtocolSource
  /** 这次真的探了上游 */
  probed: boolean
  /** kind 是否因此改变了（`false` = 判定结论与当前一致） */
  applied: boolean
}

/**
 * 发送链路里的协议对齐（#794）：**纯本地、同步、零网络**。
 *
 * 只在第三方服务上有动作（其余渠道返回 `null`）。判据全部是本地信息
 * （主机 → 模型 → 判定缓存 → 既有协议字段），所以它绝不会拖慢首条消息 ——
 * issue 要的「不阻塞首条消息超过 3s」，这里是最强的形态：**一次网络等待都没有**。
 *
 * 网络探测（兜底那一档）放在 `detectThirdPartyProtocol()`：由设置页进入第三方子页时在后台跑一次
 * （那是用户刚填完地址/模型的时刻），结论落盘缓存，之后每次发送直接用缓存。这样「判定」始终在
 * 服务层的同一条链路上（同一份 `resolveProtocol` + 同一个缓存），而发送路径不必为一个
 * 不可靠的探测付 3 秒的代价。
 */
export const syncThirdPartyProtocol = (): ProtocolDecision | null => {
  const current = getProviderKind()
  if (!isThirdPartyKind(current)) {
    return null
  }
  const baseUrl = getBaseUrl()
  const verdict = resolveProtocol({
    baseUrl,
    model: getModel(),
    cached: readCachedProtocol(baseUrl),
    currentKind: current,
  })
  return {
    protocol: verdict.protocol,
    source: verdict.source,
    probed: false,
    applied: applyProtocol(verdict.protocol),
  }
}

/**
 * 兜底探测的入口（issue 的「优先级 4」）：本地判据都说不清时，向 baseUrl 探一次。
 *
 * 调用点只有设置页（进入第三方子页时后台跑一次）—— 它**不在发送路径上**，所以不必为了
 * 「不阻塞首条消息」做预算赛跑：用户正在看这一页，等它探完再更新 `ProviderKind` 即可
 * （界面上三个字段与协议无关，不会跳、不会丢）。
 *
 * 行为：
 *  - 本地判据已经能定（主机 / 模型 / 缓存）→ 不动网络，直接返回同一个结论；
 *  - 需要探测 → `probeProtocolOnce`（同一地址在同一会话只探一次，总超时 ≤3s）：
 *    探明白 → 落盘缓存 + 应用；探不出来（超时 / 两种鉴权同一答案 / 没填 Key）→ **什么都不改**。
 *
 * 为什么探不出来不改：这条路径本来就没有证据，拿一个没验证过的猜测去改写用户的 `ProviderKind`，
 * 会把一个能用的配置改成必然 400 的请求 —— 比「继续用既有协议」更坏。此时既有协议字段
 * （`chat-demo:provider-kind`，issue 说的「旧配置提示」）就是答案。
 */
export const detectThirdPartyProtocol = async (): Promise<ProtocolDecision | null> => {
  const current = getProviderKind()
  if (!isThirdPartyKind(current)) {
    return null
  }
  const baseUrl = getBaseUrl()
  const verdict = resolveProtocol({
    baseUrl,
    model: getModel(),
    cached: readCachedProtocol(baseUrl),
    currentKind: current,
  })
  if (!verdict.needsProbe) {
    return {
      protocol: verdict.protocol,
      source: verdict.source,
      probed: false,
      applied: applyProtocol(verdict.protocol),
    }
  }
  const probed = await probeProtocolOnce({ baseUrl, apiKey: getApiKey() })
  if (probed === null) {
    return {
      protocol: verdict.protocol,
      source: verdict.source,
      probed: true,
      applied: false,
    }
  }
  rememberProtocol(baseUrl, probed)
  return { protocol: probed, source: 'probe', probed: true, applied: applyProtocol(probed) }
}
