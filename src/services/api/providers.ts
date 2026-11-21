/**
 * 渠道（ProviderSpec）注册表：一个渠道 = 一个 spec 对象。
 *
 * 设置页的输入行、请求路径、鉴权头、能力入口（搜索/附件/语音/朗读/标题）
 * 以及请求体里能带哪些扩展字段，全部由这里驱动。
 *
 * 新增一个渠道只需要：把它加进 ProviderKind，并在 SPECS 里补一个对象；
 * 设置页与请求构造不用改任何结构（组件按 spec.fields 循环渲染、按 spec.caps 控制显隐）。
 * 协议不同（OpenAI 兼容）的额外工作是 openaiAdapter.ts 里的双向翻译，同样与组件无关。
 *
 * 四个渠道（1.4.0-beta.6：ours 改走 OpenAI 协议）：
 *   1. deepseek  DeepSeek 官方：地址与模型内置（https://api.deepseek.com / deepseek-flash），只需 Key，能力全开
 *   2. anthropic Anthropic 协议：地址 / 模型 / Key 都要自己填，只有对话 + 深度思考
 *   3. openai    OpenAI 兼容：地址 / 模型 / Key 都要自己填，只有基础对话；深度思考按 reasoningParam 三档（#297）
 *   4. ours      我们的渠道：地址与模型内置（见下），只需 Key，走 OpenAI 协议（/v1/chat/completions + Bearer），
 *                基础对话 + 深度思考（`reasoning_effort`，档位 high；#363 起真的下发）
 *
 * 内置地址/模型的渠道（deepseek / ours）在 fields 里没有 baseUrl / model，
 * 设置页因此不渲染地址与模型输入行，值只从 defaults 取。
 */
import { INTERNAL_BUILD } from './internalBuild.js'
import { LIMITS, type RequestTimeoutOverride } from '../limits.js'

export type ProviderKind = 'deepseek' | 'anthropic' | 'openai' | 'ours'

/**
 * 线上协议：决定请求体怎么构造、响应流怎么解析。
 * - 'anthropic'：Messages API（本应用内部就是这套事件，直接透传）
 * - 'openai'：chat/completions，经 openaiAdapter.ts 双向翻译
 */
export type ProviderProtocol = 'anthropic' | 'openai'

/** 需要用户填的字段；不在列表里的字段用 defaults 里的内置默认值 */
export type ProviderField = 'baseUrl' | 'apiKey' | 'model'

/** 鉴权头：'x-api-key' 走 Anthropic 风格（另带 anthropic-version），'bearer' 走 OpenAI 风格 */
export type ProviderAuth = 'x-api-key' | 'bearer'

/**
 * OpenAI 协议下的**显式思考参数**三档（#297）。OpenAI 的 chat/completions 没有通用的思考参数，
 * 各家中转的形状不一样，所以不能写死一个字段：
 * - `none`（第三方 openai 渠道的默认）：请求侧丢弃，`caps.thinking = false`（入口仍常驻，只改本地档位，#341）
 *   —— 第三方中转完全不受影响；`ours` 不再用这一档（#363：我们自己网关的能力是确定的，见下方 spec）
 * - `reasoning_effort`：开启思考时请求体加 `reasoning_effort: low|medium|high`（OpenAI / vLLM 系）
 * - `thinking_enabled`：开启思考时请求体加 `thinking: { type: 'enabled' }`（DeepSeek V3.1 系）
 *
 * Anthropic 协议（deepseek / anthropic）天生支持 `thinking` 块，不看这一档。
 */
export type ReasoningParam = 'none' | 'reasoning_effort' | 'thinking_enabled'

/** 允许的取值：非法值一律 fail-closed 归到 `none`（宁可不发，也不把不认识的字段发给中转） */
export const REASONING_PARAMS: readonly ReasoningParam[] = [
  'none',
  'reasoning_effort',
  'thinking_enabled',
]

/** `reasoning_effort` 的档位 */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/** 缺省档位：issue #297 验收口径里的 `reasoning_effort: 'medium'` */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

/** 能力开关：决定请求体里能带哪些扩展字段；UI 入口恒常驻（#341），不再由能力位决定显隐 */
export type ProviderCaps = {
  /** 基础文本对话（流式正文、停止、重新生成 / 编辑 / 分支） */
  text: boolean
  /**
   * 深度思考开关（thinking / reasoning）。
   * **派生值**：由 `thinkingAvailable(spec)` 算出来（协议 + reasoningParam），spec 里不再手写，
   * 避免「能力声明」与「请求侧真的发不发」两处各写一遍（#297）。
   */
  thinking: boolean
  /** 智能搜索（deepseek_web_search） */
  search: boolean
  /** 服务端自动生成会话标题 */
  title: boolean
  /**
   * **UI 上有没有图片附件入口**（不是「图片怎么发」——那是 `attachments/providerCapability.ts`
   * 的 `image` 维度，#562 的单一能力表）。
   *
   * 三个 base64 渠道（anthropic / openai / ours）从 #552 起置 true：它们不走 Files API，
   * 图片在本地编码后内联（`visionFor(kind).base64`），入口与通路同时打开，不会出现
   * 「入口亮着、点下去拿不到图」的假承诺。
   */
  vision: boolean
  /** 朗读（TTS） */
  tts: boolean
  /** 语音输入（ASR） */
  asr: boolean
}

export type ProviderPaths = {
  /** 模型列表 */
  models: string
  /** 发消息 */
  messages: string
  /** 语音等工具接口前缀 */
  tools: string
  /**
   * 附件上传（Files API）端点。**没有这一项 = 该渠道没有文件上传能力**（#303 / #37）。
   *
   * 为什么必须显式声明、而不是从 messages 前缀推：附件接口与对话接口是两条独立路由，
   * 以前用 `{messages}/files` 推出来，实际发出的是 `/v1/chat/completions/files`——
   * 网关没有这条路由，线上 2 小时吃了 2059 条 404（占日志 86%）。
   * 声明式的好处是「不能上传」这件事在类型上就说得清，前端据此禁用入口并给出可读提示，
   * 永远不靠猜路径。
   */
  files?: string
  /**
   * 向量化（embedding）端点。**没有这一项 = 该渠道没有 embedding 能力**（#397），
   * 与 `files` 同一套纪律：能力显式声明，绝不从别的路径猜。
   *
   * 为什么只有 OpenAI 兼容渠道声明：DeepSeek 官方与 Anthropic 协议都没有 `/embeddings`，
   * 猜一个过去只会变成日志里刷屏的 404（#303 的教训）。记忆检索在没有这一项的渠道上
   * 直接退化为纯 BM25，一次请求都不发。
   */
  embedding?: string
}

export type ProviderSpec = {
  kind: ProviderKind
  label: { zh: string; en: string }
  /** 线上协议：请求体与响应流按它选解析方式 */
  protocol: ProviderProtocol
  /** 需要用户填哪些字段，顺序即设置页里的渲染顺序 */
  fields: ProviderField[]
  /** 未显示的字段用内置默认；用户已存过的值仍然优先（升级无感兼容） */
  defaults?: { baseUrl?: string; model?: string }
  paths: ProviderPaths
  auth: ProviderAuth
  /**
   * x-api-key 鉴权时附带 anthropic-version 头的值。留空表示不发这个头。
   * 只在「打官方端点（defaults.baseUrl 的 host）」时才带：第三方中转的 CORS 白名单
   * 常常只放行 x-api-key，多带这个头会让浏览器预检直接失败（60010 实测），
   * 而官方端点不需要也无法避免（它是协议要求）。
   */
  anthropicVersion?: string
  caps: ProviderCaps
  /**
   * DeepSeek 扩展字段：safety_check 与 role:'latest_reminder'。
   * 裸 Anthropic 协议不认识它们（未知顶层字段 / 非法 role 都会 400），所以只能按 spec 发。
   */
  extended?: { safetyCheck: boolean; latestReminder: boolean }
  /** 开启 thinking 时需要附带的最小思考预算；不填表示该协议不需要这个字段 */
  thinkingBudget?: number
  /**
   * OpenAI 协议下思考参数的形状（#297）；缺省 = `none` = 请求侧丢弃。
   * 只有 `protocol: 'openai'` 的渠道看它，Anthropic 协议渠道忽略。
   */
  reasoningParam?: ReasoningParam
  /** `reasoningParam: 'reasoning_effort'` 时的档位；缺省 medium */
  reasoningEffort?: ReasoningEffort
  /**
   * 地址与模型由 defaults 钉死：已存值不参与（`chat-demo:base-url` 这类老数据一律忽略）。
   * 用于「用户不该知道后端地址」的渠道（ours）。只影响「配置从哪来」，
   * 不影响 paths / auth / caps / extended 这些协议行为。
   */
  locked?: boolean
}

/** Anthropic 风格接口要求的协议版本头 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 归一化思考参数档位：缺省 / 非法值一律按 `none`（fail-closed）。
 * 类型层已经把 `reasoningParam` 限成三档闭集，这里是运行期的第二道门禁：
 * 老配置、手工改过的 localStorage、后续新增档位没处理到的分支，都不会把不认识的字段发出去。
 */
export const reasoningParamOf = (
  spec: Pick<ProviderSpec, 'reasoningParam'>
): ReasoningParam =>
  (REASONING_PARAMS as readonly unknown[]).includes(spec.reasoningParam)
    ? (spec.reasoningParam as ReasoningParam)
    : 'none'

/** 归一化档位：非法 / 缺省 = medium（与 issue #297 验收口径一致） */
export const reasoningEffortOf = (
  spec: Pick<ProviderSpec, 'reasoningEffort'>
): ReasoningEffort =>
  (REASONING_EFFORTS as readonly unknown[]).includes(spec.reasoningEffort)
    ? (spec.reasoningEffort as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT

/**
 * 渠道是否支持深度思考 —— **唯一判定处**。
 * `caps.thinking`（这一档是否真生效）与 `REQUEST_GATES.reasoning_param`（请求侧发不发）
 * 都从它派生，所以不可能出现「开关在但请求不带参数」或反过来（#297 的核心口径）。
 * #341 起 UI 入口恒常驻：能力位只作为不可见的 `data-thinking-effective` 标记，
 * 不再参与「渲不渲染」的判断。
 * - Anthropic 协议：协议天生有 `thinking` 块，恒为 true
 * - OpenAI 协议：`reasoningParam !== 'none'` 才为 true。第三方 openai 渠道缺省 none（不猜别人的能力），
 *   我们自己的 ours 渠道是 `reasoning_effort` + high（#363：以前写 none，开关点了也不生效）
 */
export const thinkingAvailable = (
  spec: Pick<ProviderSpec, 'protocol' | 'reasoningParam'>
): boolean => (spec.protocol === 'anthropic' ? true : reasoningParamOf(spec) !== 'none')

/** caps.thinking 是派生值：原始 spec 里不写它，避免两处各写一遍 */
type RawProviderSpec = Omit<ProviderSpec, 'caps'> & { caps: Omit<ProviderCaps, 'thinking'> }

const RAW_SPECS: Record<ProviderKind, RawProviderSpec> = {
  deepseek: {
    kind: 'deepseek',
    label: { zh: 'DeepSeek 官方', en: 'DeepSeek Official' },
    protocol: 'anthropic',
    // 官方地址与模型内置，用户只需要填 Key；内置渠道优先 spec.defaults，
    // 只有老中转（共享 chat-demo:base-url 仍在用）才保留已存模型，见 apiConfig.ts（#339）
    fields: ['apiKey'],
    defaults: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    paths: { models: '/models', messages: '/anthropic/v1/messages', tools: '/v1/tools', files: '/anthropic/v1/files' },
    auth: 'x-api-key',
    // 官方 CORS 白名单包含 anthropic-version（实测 OPTIONS 允许 x-api-key,anthropic-version）
    anthropicVersion: ANTHROPIC_VERSION,
    caps: {
      text: true,
      search: true,
      title: true,
      vision: true,
      tts: true,
      asr: true,
    },
    extended: { safetyCheck: true, latestReminder: true },
  },
  anthropic: {
    kind: 'anthropic',
    label: { zh: 'Anthropic 协议', en: 'Anthropic-compatible' },
    protocol: 'anthropic',
    // 任意 Anthropic 兼容中转：地址与模型都要自己填
    fields: ['baseUrl', 'apiKey', 'model'],
    paths: { models: '/v1/models', messages: '/v1/messages', tools: '/v1/tools' },
    auth: 'x-api-key',
    // 故意不带 anthropic-version：中转的 CORS 白名单一般只放行 x-api-key，
    // 带上后预检失败会让每个请求都变成网络错误（60010 实测）。
    caps: {
      text: true,
      search: false,
      title: false,
      vision: true,
      tts: false,
      asr: false,
    },
    // 深度思考仍然可用（Anthropic 协议天生支持 thinking 块），但真 Anthropic 要求带 budget_tokens
    thinkingBudget: 4096,
  },
  openai: {
    kind: 'openai',
    label: { zh: 'OpenAI 兼容', en: 'OpenAI-compatible' },
    protocol: 'openai',
    // 任意 OpenAI 兼容上游（官方 / 中转 / 本地 vLLM、Ollama…）：地址与模型都要自己填
    fields: ['baseUrl', 'apiKey', 'model'],
    // OpenAI 兼容协议自带 /v1/embeddings（记忆检索的向量来源，#397）；deepseek / anthropic / ours 没有这条路由
    paths: {
      models: '/v1/models',
      messages: '/v1/chat/completions',
      tools: '',
      embedding: '/v1/embeddings',
    },
    // Authorization: Bearer <key>
    auth: 'bearer',
    /**
     * 只做基础对话：搜索/标题/语音/朗读全关；图片附件从 #552 起可用（本地 base64 内联，
     * 不需要 Files API —— 这个协议的上游一般也没有那条路由），文档走文本注入（#480）。
     * 深度思考走 reasoningParam 三档（#297）：默认 `none` = 请求侧丢弃 thinking，
     * 与 1.3.0 行为逐字一致（第三方中转不受影响）；配成另外两档才会露开关、才会发显式参数。
     */
    caps: {
      text: true,
      search: false,
      title: false,
      vision: true,
      tts: false,
      asr: false,
    },
    reasoningParam: 'none',
  },
  ours: {
    kind: 'ours',
    label: { zh: '内置渠道', en: 'Built-in' },
    protocol: 'openai',
    // 地址与模型内置（locked）：设置页只有 API Key 一行，用户看不到也不该看到后端地址
    fields: ['apiKey'],
    // 2026-11-18 起该上游走 OpenAI 协议：/v1/chat/completions + Authorization: Bearer
    // 地址唯一来源是 config/endpoints.json 的 chatBaseUrl（#274），构建期注入 __ENDPOINTS__
    defaults: { baseUrl: __ENDPOINTS__.chatBaseUrl, model: 'deepseek-v4.1-flash' },
    paths: { models: '/v1/models', messages: '/v1/chat/completions', tools: '' },
    auth: 'bearer',
    // 不带 anthropic-version：OpenAI 协议路径不需要；带上去反而会让中转 CORS 预检失败
    locked: true,
    caps: {
      text: true,
      search: false,
      title: false,
      vision: true,
      tts: false,
      asr: false,
    },
    /**
     * 我们自己的网关**认 `reasoning_effort`**（#363）：它是 sub2api 的 OpenAI 兼容面，
     * 服务端的临时兜底（`forceReasoning()`）已经在往上游塞同一个字段，说明这条链路的
     * 形状是确定的，不需要靠猜第三方能力（那是 openai 渠道保持 `none` 的理由）。
     *
     * 以前这里写 `none`：`thinkingAvailable()` 因此恒为 false → `REQUEST_GATES.reasoning_param`
     * 恒拦截 → 深度思考开关（#341 起四渠道恒常驻、可点、高亮照翻）**点了也不生效**，
     * 一个思考字段都不会发；加上默认档位是 fast，线上 1516 个请求里只有 1 个带 high，
     * 输出自然又短又平（#363 的 79–121 token）。
     */
    reasoningParam: 'reasoning_effort',
    /** 档位固定 high：产品预期是「开思考就真的思考」，medium 对输出长度没有实质改善（#363） */
    reasoningEffort: 'high',
  },
}

/**
 * 补上派生的 `caps.thinking`：原始 spec 里没有这个字段。
 * 它表示「请求侧是否真的发思考参数」（#297），同时以不可见的 `data-thinking-effective`
 * 暴露给 UI（#341）；UI 入口恒常驻，不再由它决定显隐。
 */
const withDerivedCaps = (raw: RawProviderSpec): ProviderSpec => ({
  ...raw,
  caps: { ...raw.caps, thinking: thinkingAvailable(raw) },
})

const SPECS: Record<ProviderKind, ProviderSpec> = {
  deepseek: withDerivedCaps(RAW_SPECS.deepseek),
  anthropic: withDerivedCaps(RAW_SPECS.anthropic),
  openai: withDerivedCaps(RAW_SPECS.openai),
  ours: withDerivedCaps(RAW_SPECS.ours),
}

/**
 * 默认渠道：内测构建默认「我们的渠道」，标准构建默认「DeepSeek 官方」。
 * 用户切换过就按 localStorage 里存的那一个来（见 apiConfig.ts）。
 */
export const DEFAULT_PROVIDER_KIND: ProviderKind = INTERNAL_BUILD ? 'ours' : 'deepseek'

/** 可切换的渠道（顺序即下拉里的展示顺序） */
export const PROVIDER_KINDS: ProviderKind[] = ['deepseek', 'anthropic', 'openai', 'ours']

/** 下拉里的选项（顺序即展示顺序） */
export const PROVIDER_SPECS: ProviderSpec[] = PROVIDER_KINDS.map((kind) => SPECS[kind])

export const isProviderKind = (value: unknown): value is ProviderKind =>
  typeof value === 'string' && (PROVIDER_KINDS as string[]).includes(value)

/** 取 spec：未知/缺省（旧用户没有这个 key）一律按 deepseek 处理 */
export const getSpec = (kind?: string | null): ProviderSpec =>
  isProviderKind(kind) ? SPECS[kind] : SPECS[DEFAULT_PROVIDER_KIND]

/**
 * 三段超时的**渠道解析**（#568）：表在 `LIMITS.requestTimeouts.channels`，这里只做查表 + 回落。
 *
 * 为什么要有这一层而不是各处直接读 LIMITS：调用方（`api/client.ts`）只关心
 * 「当前渠道 + 这一轮开不开深度思考」对应的三个数字，不该知道表怎么组织的；
 * 而渠道表本身属于「渠道的形状」，跟 paths / caps 放在同一份配置里才好对照着看。
 *
 * 缺项一律回落默认值：新增渠道不登记也能跑（拿默认档），只是享受不到按渠道放宽。
 */
/**
 * 渠道 → 三段超时的覆盖值（#568）。**逐行点名**，不用 `channels[spec.kind]` 动态索引：
 * - `Record<ProviderKind, …>` 让「新增渠道必须登记」变成编译期错误（漏登记不编译）；
 * - `tests/unit/limits-config.test.mjs` 的「每个 LIMITS 叶子都有人引用」门禁能逐条核对到，
 *   动态索引会让那张表的数字变成谁都查不到的孤儿。
 */
const CHANNEL_TIMEOUTS: Record<ProviderKind, RequestTimeoutOverride> = {
  deepseek: { thinkingFirstTokenMs: LIMITS.requestTimeouts.channels.deepseek.thinkingFirstTokenMs },
  anthropic: {
    thinkingFirstTokenMs: LIMITS.requestTimeouts.channels.anthropic.thinkingFirstTokenMs,
  },
  ours: {
    firstTokenMs: LIMITS.requestTimeouts.channels.ours.firstTokenMs,
    thinkingFirstTokenMs: LIMITS.requestTimeouts.channels.ours.thinkingFirstTokenMs,
  },
  openai: { thinkingFirstTokenMs: LIMITS.requestTimeouts.channels.openai.thinkingFirstTokenMs },
}

export const timeoutsFor = (
  spec: Pick<ProviderSpec, 'kind'>,
  options: { thinking?: boolean } = {}
): { connectMs: number; firstTokenMs: number; idleMs: number } => {
  const defaults = LIMITS.requestTimeouts
  const channel = CHANNEL_TIMEOUTS[spec.kind]
  const firstTokenMs = options.thinking
    ? (channel.thinkingFirstTokenMs ?? defaults.firstTokenMs)
    : (channel.firstTokenMs ?? defaults.firstTokenMs)
  return {
    connectMs: channel.connectMs ?? defaults.connectMs,
    firstTokenMs,
    idleMs: channel.idleMs ?? defaults.idleMs,
  }
}

/** 该渠道是否要用户自己填这个字段（不在 fields 里就是内置值） */
export const isUserField = (spec: ProviderSpec, field: ProviderField): boolean =>
  spec.fields.includes(field)

/**
 * 请求体字段的「发 / 不发」：集中成一张表，构造请求时只查表，不写 if-else 分支。
 * - safety_check / latest_reminder 是 DeepSeek 扩展（裸 Anthropic 会 400）
 * - tools / title 对应 caps.search / caps.title
 * - thinking_budget 表示开启 thinking 时要附 budget_tokens
 * - reasoning_param 表示该渠道允许下发**显式思考参数**（#297）：与 `caps.thinking` 同源
 *   （都由 `thinkingAvailable(spec)` 派生），所以开关出现必然意味着请求带参数、反之亦然
 */
export type RequestGate =
  | 'safety_check'
  | 'latest_reminder'
  | 'tools'
  | 'title'
  | 'thinking_budget'
  | 'reasoning_param'

export const REQUEST_GATES: RequestGate[] = [
  'safety_check',
  'latest_reminder',
  'tools',
  'title',
  'thinking_budget',
  'reasoning_param',
]

/** 某个 spec 下各字段是否发送 */
export const requestGates = (spec: ProviderSpec): Record<RequestGate, boolean> => ({
  safety_check: spec.extended?.safetyCheck ?? false,
  latest_reminder: spec.extended?.latestReminder ?? false,
  tools: spec.caps.search,
  title: spec.caps.title,
  thinking_budget: Boolean(spec.thinkingBudget),
  reasoning_param: thinkingAvailable(spec),
})

// 图片（vision）通路**不在这里**：`src/services/attachments/providerCapability.ts` 是唯一的
// 渠道能力表（#562）。它把「怎么收文档」（#480）与「怎么收图片」（#551）放在同一个
// `ChannelCapability` 对象里，一个渠道一行 —— 本文件只描述渠道的静态形状
// （`paths` 有没有端点、`caps` 有没有入口），不回答「附件该怎么发」。
