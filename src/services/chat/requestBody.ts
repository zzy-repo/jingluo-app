/**
 * 本轮请求体的组装（issue #297 抽出来的一层）。
 *
 * 为什么单独一层：思考参数「发不发」必须只有一个判定处。以前这段逻辑写死在
 * `chat/store.ts` 的 createReply 里，单测只能靠 store + IndexedDB + UI 才能碰到；
 * 抽成纯函数后，`tests/unit/thinking-adapters.test.mjs` 能拿**真代码**拼出请求体，
 * 再交给真正的 `client.streamMessage` 打到 mock 上游上，断言 mock 收到的 JSON。
 *
 * 职责划分（与 #297 的边界一致）：
 * - 这里（service 层）只看 `REQUEST_GATES` 决定**字段发不发**；
 * - `api/openaiAdapter.ts` 只做协议翻译（`thinking` → `reasoning_effort` / `thinking:{type}`）；
 * - 两处都不自己判断渠道能力，能力只来自 `providers.ts` 的 `thinkingAvailable()`。
 *
 * #480 §7 追加的接线点：文档正文的文本注入（`injectDocuments`）。它同样只问
 * `providerCapability.ts` 的能力表，不看协议 —— `textInjection: false`（DeepSeek 官方）
 * 在 `withDocuments()` 里**第一行就早返回入参数组本身**，原路径连一次拷贝都不发生。
 */
import { injectDocuments, type InjectDocument } from '../attachments/inject.js'
import { docInjectionFor } from '../attachments/providerCapability.js'
import { requestGates, type ProviderSpec } from '../api/providers.js'
import type { CreateMessageRequest } from '../api/types.js'

/** 所有生成请求统一携带的助手身份说明 */
export const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 安全审核固定开启，所有请求都走扩展模式 */
export const SAFETY_CHECK = { level: 'high' } as const

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
export const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

export type MessageBodyInput = {
  model: string
  /** 已按渠道折叠过 latest_reminder 的 system */
  system: string
  messages: CreateMessageRequest['messages']
  /** 用户本轮是否要思考（settings.thinking → AssistantMessage.thinking） */
  thinking: boolean
  /** 智能搜索开关（gates.tools 放行时才有意义） */
  search: boolean
  /** 本轮是否带自动起标题请求（gates.title 放行时才有意义） */
  title: boolean
  /**
   * 本轮要注入的附件正文（#480 §7）。**只有文本注入渠道会填它**：
   * `chat/store.ts` 先问 `docInjectionFor(kind).textInjection`，为 false（DeepSeek 官方）
   * 时根本不读附件、这里恒为 `undefined`。
   */
  documents?: InjectDocument[]
}

/**
 * 文档注入的**唯一接线点**（#480 §7）。
 *
 * 两条路径泾渭分明：
 * - `textInjection === false`（DeepSeek 官方：原生 `file_id` 能力）：**原样返回入参**，
 *   不拷贝、不遍历、不改一个字符 —— 这条早返回就是「DeepSeek 路径零改动」的代码级保证；
 * - `textInjection === true`（anthropic / openai / ours）：交给纯函数 `injectDocuments()`。
 *
 * 放在这里而不是 `injectDocuments()` 里：能力判断与「消息怎么拼」分开，
 * 纯函数那边也保留了同一道闸（双保险），任何调用方都绕不过能力表。
 */
export const withDocuments = (
  spec: ProviderSpec,
  messages: CreateMessageRequest['messages'],
  documents?: InjectDocument[]
): CreateMessageRequest['messages'] => {
  if (!docInjectionFor(spec.kind).textInjection) {
    return messages
  }
  if (!documents || documents.length === 0) {
    return messages
  }
  return injectDocuments(messages, documents, spec.kind)
}

/**
 * 组装请求体：字段发不发只看 REQUEST_GATES，不看协议。
 *
 * 思考相关的两条 gate：
 * - `reasoning_param`：该渠道允许下发显式思考参数（与 `caps.thinking` 同源）。
 *   不放行时 `thinking.type` 恒为 `disabled`，OpenAI 适配层于是什么都不加（#297）。
 * - `thinking_budget`：真 Anthropic 协议才需要 `budget_tokens`；其它协议带上就是多一个字段。
 */
export const buildMessageBody = (
  spec: ProviderSpec,
  input: MessageBodyInput
): CreateMessageRequest => {
  const gates = requestGates(spec)
  // 渠道不支持思考时请求侧也不开，避免历史里带思考块回传（会 400）
  const thinking = input.thinking && gates.reasoning_param
  // 文档注入（#480 §7）：不走注入的渠道拿到的是入参数组本身，其它字段与改动前逐字节一致
  const messages = withDocuments(spec, input.messages, input.documents)
  return {
    model: input.model,
    system: input.system,
    messages,
    thinking: {
      type: thinking ? 'enabled' : 'disabled',
      // 真 Anthropic 协议开启 thinking 时必须给预算
      ...(thinking && gates.thinking_budget && spec.thinkingBudget
        ? { budget_tokens: spec.thinkingBudget }
        : {}),
    },
    ...(gates.safety_check ? { safety_check: SAFETY_CHECK } : {}),
    ...(gates.tools ? { tools: serverTools(input.search) } : {}),
    ...(input.title && gates.title ? { title: { enabled: true } } : {}),
  }
}
