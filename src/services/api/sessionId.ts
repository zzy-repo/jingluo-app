/**
 * 会话标识（#576）：**一个会话一个 id，从建会话那一刻生成、全程不变**，
 * 随每一轮对话请求带给服务端，服务端据此把用量 / 记忆归到「哪段对话」。
 *
 * ## 为什么是请求头，不是请求体（issue 文本里两种方式都列了，这里只落一种）
 *
 * 服务端的落库口径是**只看请求头**，不看请求体：
 * - 表结构：`backend/migrations/187_add_usage_log_session_id.sql` —— `usage_logs.session_id VARCHAR(255)`，
 *   注释写明它来自 `session_id / X-Session-Id / X-Conversation-ID` 这些**请求头**；
 * - 取值只有一个口子：`backend/internal/service/session_id.go` 的 `ExtractClientSessionID(c)`，
 *   遍历的是 `clientSessionIDHeaders`（请求头白名单），**没有任何 body 字段参与**；
 * - 所有网关 handler 都调它（`handler/openai_chat_completions.go`、`gateway_handler.go`、
 *   `openai_gateway_handler.go`），写进 `UsageLog.SessionID`；
 * - 服务端自己的用例把这个口径钉死了：`service/session_id_test.go` 里
 *   `TestExtractClientSessionID_IgnoresNonSessionHeaders` 明确断言 request id / prompt_cache_key
 *   **不会**成为 session_id。
 *
 * 所以往请求体里塞 `session_id` 这一手**什么也不会发生**（服务端不读），而且会把一个
 * 协议里不存在的顶层字段发给上游 —— 裸 Anthropic 协议遇到未知顶层字段会 400（见
 * `providers.ts` 里 `extended.safetyCheck` 只给 deepseek 的理由）。请求头没有这个问题：
 * 收方对不认识的头按 RFC 9110 一律忽略，断言「不会让上游因未知字段报错」在协议层就成立。
 *
 * 顺带一条：`request_id`（服务端 `client:<uuid>`）救不了这事 —— 它是
 * `middleware/client_request_id.go` 在**每个请求**上现生成的（没带 `X-Client-Request-ID` 就
 * 新来一个 uuid），第 1 轮和第 10 轮必然不同，本来就不是会话标识。
 *
 * ## 能力表：一个渠道一行
 *
 * 与 `attachments/providerCapability.ts` 同一套写法：**判定只有这一处**，调用方不许自己写
 * `if (kind === ...)`。`null` = 这个渠道不发这个头。
 *
 * | 渠道 | 发不发 | 依据 |
 * | --- | --- | --- |
 * | `ours` | 发 | 就是本单要修的那个服务端（sub2api）—— 它读这个头，写进 `usage_logs.session_id` |
 * | `deepseek` | 发 | 官方端点的 CORS 预检**回显**请求头（`curl -X OPTIONS` 实测 `access-control-allow-headers` 原样包含 `x-session-id`），且服务端对未知头一律忽略 |
 * | `anthropic` / `openai` | 不发 | 地址与 CORS 白名单都是用户自填的第三方中转，**不可知**。仓库里有反例：#60010 那次带一个多余的头就让预检失败、整条链路变成网络错误（`providers.ts` 的 `anthropicVersion` 注释）。这两家服务端也没有这个字段可落，所以默认 fail-closed：**宁可不发，也不把不认识的头发给中转** |
 *
 * 把 `anthropic` / `openai` 打开只需把那一行的 `header` 填上 —— 这就是这张表存在的意义。
 */

import type { ProviderKind } from './providers.js'

/**
 * 头名取服务端白名单里的 `X-Session-Id`（`openai_gateway_scheduling.go` 的
 * `openCodeSessionIDHeader`）：语义是「会话」，跟 `usage_logs.session_id` 同名，
 * 且不会和别家客户端的 `session_id` 之类的约定撞车（服务端优先级里它排在后面，
 * 不会盖掉更具体的信号）。
 */
export const SESSION_ID_HEADER = 'X-Session-Id'

/**
 * 服务端列宽：`usage_logs.session_id` 是 `VARCHAR(255)`，超长值服务端会**整条丢弃**
 * （`sanitizeSessionID` 不做截断 —— 截断会让两个不同会话撞成一个）。
 * 所以客户端超长时也只能整个不发，不能发个截断版。
 */
export const MAX_SESSION_ID_LENGTH = 255

/** 一个渠道能不能带、带哪个头 */
export interface SessionIdCapability {
  /** 头名；`null` = 该渠道不发 */
  header: string | null
}

const CAPABILITIES: Record<ProviderKind, SessionIdCapability> = {
  deepseek: { header: SESSION_ID_HEADER },
  // 用户自填中转：预检白名单不可知，默认不发（见文件头的能力表）
  anthropic: { header: null },
  openai: { header: null },
  ours: { header: SESSION_ID_HEADER },
}

/** 该渠道要用的头名；不发返回 null（唯一判定处） */
export const sessionIdHeaderFor = (kind: ProviderKind): string | null =>
  CAPABILITIES[kind]?.header ?? null

/**
 * 归一化：与服务端 `sanitizeSessionID` 同一套口径（trim / 控制字符整条丢弃 / 超长整条丢弃），
 * 这样「客户端以为发了、服务端静默丢了」不会变成线上不可见的空洞。
 */
export const normalizeSessionId = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string') {
    return ''
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  let count = 0
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return ''
    }
    count += 1
    if (count > MAX_SESSION_ID_LENGTH) {
      return ''
    }
  }
  return trimmed
}

/**
 * 本轮请求要追加的会话头；**没有会话上下文 / 渠道不发 / 值不合法**时返回空对象
 * （并入 headers 展开，调用方不需要分支）。
 *
 * 这个函数不生成 id：id 必须由会话创建处生成一次并全程复用（#576 / #345）——
 * 这里若"顺手 new 一个"，就是每轮换 id 的老 bug 再来一遍。
 */
export const sessionIdHeaders = (
  kind: ProviderKind,
  sessionId: string | null | undefined
): Record<string, string> => {
  const header = sessionIdHeaderFor(kind)
  const value = normalizeSessionId(sessionId)
  if (!header || !value) {
    return {}
  }
  return { [header]: value }
}
