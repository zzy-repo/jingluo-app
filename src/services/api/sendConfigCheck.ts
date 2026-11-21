/**
 * 发送前「必错配置」判定（#490）：**纯函数，零运行时依赖**（只 import 类型 + 渠道表）。
 *
 * #347 / #353 把「上游回了什么」搬上了界面，但它们明确划界给 #490 的部分是另一半：
 * 有五类配置**一定发不出去**，今天的用户却要先发一条消息、等一个 4xx 才知道。
 *  1. 模型名为空
 *  2. 模型名带空格（首尾或中间）
 *  3. 服务地址为空
 *  4. 服务地址缺 `http(s)` 协议
 *  5. 把 `…/chat/completions` 这种**具体接口路径**填进服务地址
 *
 * 三条纪律：
 *
 * - **判据不误伤**（#490 明写）：`https://api.example.com` 与 `https://api.example.com/v1`
 *   两种写法都必须放行 —— 后者是自填渠道最常见、也完全正确的一种填法
 *   （`apiConfig.joinUrl` 会把重复的版本段去重，见那里的长注释）。
 *   所以第 5 类只认「地址里已经含了某个**具体接口**的尾巴」，不是「地址里有路径就拦」。
 * - **接口尾巴从渠道表派生**（`providers.ts` 的 `paths`），不另抄一张清单：新增渠道 /
 *   改路径时这里自动跟上，不会出现「地址填错了但门禁不知道」。
 * - **Key 不进这里**：Key 的判定只有一份 —— `apiConfig.checkApiKeyBeforeSend()`
 *   （底层 #374 的 `isKeyFormatInvalid` + #596 的 `managedKeyVerdict`）。
 *   同一个字段判两次，迟早会出现「发送时说过没问题、失败文案说有问题」这种互相打架的状态。
 *
 * 返回结构里的 `messageKey` / `jumpTo` 是给调用方直接用的：toast 的文案就是它，
 * 设置里要定位到哪一行也是它（`sendBlocked*` 的键在 `src/i18n/{zh,en}.ts`）。
 *
 * #793 在同一份「发送前判定」里加了另一半：{@link checkSendPrerequisites} ——
 * 五类说的是「填错了」，它说的是「根本没有身份」（未登录 + 没有可用 Key）。
 * 两者用各自的一张表（`SEND_BLOCK_TABLE` / `SEND_PREREQ_TABLE`），互不顶替：
 * 前者的落点是某个输入行，后者的落点是「服务 Tab → 模型来源」那三行。
 */
import type { TranslationKey } from '../../i18n/index.js'
import { PROVIDER_SPECS, type ProviderSpec } from './providers.js'

/** 五类必错配置的机器码（日志 / 断言用；文案与落点都不从这里二次判断，见 `SEND_BLOCK_TABLE`） */
export type SendBlockCode =
  | 'base_url_empty'
  | 'base_url_no_protocol'
  | 'base_url_endpoint_path'
  | 'model_empty'
  | 'model_space'

/** 命中后要跳到设置里的哪一行 */
export type SendBlockField = 'baseUrl' | 'model'

export type SendConfigVerdict =
  | { ok: true }
  | { ok: false; code: SendBlockCode; messageKey: TranslationKey; jumpTo: SendBlockField }

/**
 * 机器码 → 「说给用户的那句话 + 该去改哪一行」。
 * 一张表而不是 if-else：命中路径与文案 / 落点一一对应，`check:i18n` 也在这里看到 5 个 key 的引用。
 */
export const SEND_BLOCK_TABLE: Record<
  SendBlockCode,
  { messageKey: TranslationKey; jumpTo: SendBlockField }
> = {
  base_url_empty: { messageKey: 'sendBlockedBaseUrlEmpty', jumpTo: 'baseUrl' },
  base_url_no_protocol: { messageKey: 'sendBlockedBaseUrlNoProtocol', jumpTo: 'baseUrl' },
  base_url_endpoint_path: { messageKey: 'sendBlockedBaseUrlEndpointPath', jumpTo: 'baseUrl' },
  model_empty: { messageKey: 'sendBlockedModelEmpty', jumpTo: 'model' },
  model_space: { messageKey: 'sendBlockedModelSpace', jumpTo: 'model' },
}

/** 命中码 → 该跳到的设置行（界面按它决定在哪一行显示这段红字） */
export const sendBlockFieldOf = (code: SendBlockCode): SendBlockField =>
  SEND_BLOCK_TABLE[code].jumpTo

/** 命中码 → toast / 行内提示的文案 key */
export const sendBlockMessageKeyOf = (code: SendBlockCode): TranslationKey =>
  SEND_BLOCK_TABLE[code].messageKey

const block = (code: SendBlockCode): SendConfigVerdict => ({
  ok: false,
  code,
  messageKey: SEND_BLOCK_TABLE[code].messageKey,
  jumpTo: SEND_BLOCK_TABLE[code].jumpTo,
})

// ============================================================
// 凭据门（#793）：既没登录、也没有一把能用的 Key → 连上游都不该碰
// ============================================================

/**
 * 「凭据」门的机器码（#793）。今天只有一类：**未登录 + 没有可用 Key**。
 *
 * 为什么单开一张表、不并进上面的五类：那五类是「用户填错了字段」，命中后要跳到**那一行**去改；
 * 这里不是某个字段填错，而是**根本没有可用的身份**（web / 新装机上既没登录、也没领到 Key）。
 * 落点因此不是某个输入行，而是「服务 Tab → 模型来源」那三行 —— 用户要先选一个来源、再拿 Key。
 * 混进 `SEND_BLOCK_TABLE` 会让「五类必错配置」的口径（#490 的关闭条件，用例按码集合钉着）
 * 多出第六个码，也让 `sendBlockFieldOf()` 的返回值类型混进一个不是输入行的落点。
 */
export type SendPrereqCode = 'no_credentials'

export type SendPrereqVerdict =
  | { ok: true }
  | {
      ok: false
      code: SendPrereqCode
      /** toast 正文：请先登录或选择模型渠道 */
      messageKey: TranslationKey
      /** toast 上的动作按钮文案：去选择渠道（点了切到「服务 Tab → 模型来源」） */
      actionKey: TranslationKey
    }

/**
 * 机器码 → 「说给用户的那句话 + 按钮文案」。
 * 与 `SEND_BLOCK_TABLE` 同一套写法（表驱动、不写 if-else），`check:i18n` 也在这里看到两个 key 的引用。
 */
export const SEND_PREREQ_TABLE: Record<
  SendPrereqCode,
  { messageKey: TranslationKey; actionKey: TranslationKey }
> = {
  no_credentials: {
    messageKey: 'sendBlockedNoCredentials',
    actionKey: 'sendBlockedPickProvider',
  },
}

/**
 * 发送前**凭据**判定（#793）：没有身份就不要发车。
 *
 * 判据是**合取**（issue 原文「无登录态 **且** 无可用渠道/Key」）：
 *  - 已登录：放行 —— 我们的渠道可以现领 Key，自填渠道也可能只是还没填 Key（那条由
 *    `ensureApiKey` 用「去填 Key」的口径拦，两个提示不该互相顶替）；
 *  - 未登录但有一把**能用**的 Key（`apiConfig.checkApiKeyBeforeSend() === 'ok'`）：放行 ——
 *    自填渠道本来就是「拿自己的 Key 直接发」，跟登录没关系。
 * 只有「两样都没有」时才拦：那时的请求只会带着空 `x-api-key` / `Authorization` 打上游，
 * 换回一个 401，界面转圈到超时也说不清该干什么。
 *
 * 判定本身只有一行（`authenticated || hasUsableKey`），入参是两个**布尔**而不在这里读存储：
 * 与 `checkSendConfig` 同一条纪律 —— 纯函数、可单测，Key 的判定仍然只有
 * `apiConfig.checkApiKeyBeforeSend()` 那一份。
 */
export const checkSendPrerequisites = (input: {
  authenticated: boolean
  hasUsableKey: boolean
}): SendPrereqVerdict => {
  if (input.authenticated || input.hasUsableKey) {
    return { ok: true }
  }
  return { ok: false, code: 'no_credentials', ...SEND_PREREQ_TABLE.no_credentials }
}

/**
 * 渠道表里那些**整段就是接口本身**的路径。
 *
 * 刻意排除 `paths.tools`：它是**前缀**（ASR / TTS 还要在后面再拼一段，见 `getToolsBaseUrl`），
 * 用户把 `https://gw.example.com/v1/tools` 填成地址时并不是「填了具体接口」这一类的错，
 * 拦下来只会变成一次误伤。
 */
const ENDPOINT_PATHS_OF = (spec: ProviderSpec): string[] => [
  spec.paths.messages,
  spec.paths.models,
  ...(spec.paths.files ? [spec.paths.files] : []),
  ...(spec.paths.embedding ? [spec.paths.embedding] : []),
]

/**
 * 一条路径能暴露出的「接口尾巴」：完整路径 + 末一段 + 末两段。
 *
 * 为什么要后两种：用户手上那串地址常常是**去掉版本段**拷贝过来的（`…/chat/completions`），
 * 或者干脆只拷了最后一段。渠道表里写的是 `/v1/chat/completions`，只认完整路径就漏掉了它们。
 * 例：`/v1/chat/completions` → `/v1/chat/completions`、`/chat/completions`、`/completions`。
 */
const endpointTailsOf = (path: string): string[] => {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) {
    return []
  }
  const tails = [`/${segments.join('/')}`]
  tails.push(`/${segments[segments.length - 1]}`)
  if (segments.length >= 2) {
    tails.push(`/${segments.slice(-2).join('/')}`)
  }
  return tails
}

/** 某个 spec 的接口尾巴（写 for 循环而不是 flatMap：与本仓「不引入基线外 API」的口径一致） */
const tailsOfSpec = (spec: ProviderSpec): string[] => {
  const tails: string[] = []
  for (const path of ENDPOINT_PATHS_OF(spec)) {
    if (!path) {
      continue
    }
    for (const tail of endpointTailsOf(path)) {
      tails.push(tail)
    }
  }
  return tails
}

/**
 * 「具体接口路径」尾巴集合：**从渠道表派生**（四个渠道的全部接口路径），不手写清单。
 *
 * 派生结果（当前渠道表）：`/completions` `/chat/completions` `/messages` `/v1/messages`
 * `/models` `/v1/models` `/files` `/v1/files` `/embeddings` `/v1/embeddings`。
 * 判据是「地址的 pathname 以其中之一结尾」—— 所以 `/v1` 这种**版本段**永远放行。
 */
const ENDPOINT_TAILS: readonly string[] = (() => {
  const unique = new Set<string>()
  for (const spec of PROVIDER_SPECS) {
    for (const tail of tailsOfSpec(spec)) {
      unique.add(tail.toLowerCase())
    }
  }
  return Array.from(unique)
})()

/** 地址的 pathname（去掉尾斜杠）；解析不了返回 null —— 判不清就不拦，交给上游回一句可读的 4xx */
const pathnameOf = (url: string): string | null => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** 地址里是不是已经含了某个**具体接口**（`…/chat/completions` 这类），而不是只到域名 / 版本段 */
const hasEndpointPath = (url: string, spec: ProviderSpec): boolean => {
  const pathname = pathnameOf(url)
  if (!pathname) {
    return false
  }
  const lower = pathname.toLowerCase()
  // 当前渠道自己的接口先判（命中就是「本渠道的接口填进了地址」，最常见），再判其它渠道的
  for (const tail of tailsOfSpec(spec)) {
    if (lower.endsWith(tail.toLowerCase())) {
      return true
    }
  }
  for (const tail of ENDPOINT_TAILS) {
    if (lower.endsWith(tail)) {
      return true
    }
  }
  return false
}

/**
 * 发送前判定：五类必错配置各给一个机器码 + 一句人话 + 该改哪一行。
 *
 * 入参必须是**配置里填的值**（不套 `DEFAULT_MODEL` / `DEFAULT_BASE_URL` 那两个构建期兜底）——
 * 那两个兜底是给「只有 DeepSeek 官方一个渠道」的年代用的，对一个自填渠道来说它们是**错值**：
 * 用户在 OpenAI 兼容渠道里没填模型时，`getModel()` 会回 `deepseek-flash`，看着「非空」，
 * 实际发出去必然是 400。判定要看用户到底填了什么（见 `apiConfig.configuredModel`）。
 *
 * 判定顺序固定（多类同时坏时先说第一个，测试里钉着这一条）：
 * 地址三项 → 模型两项（与设置页里输入行的先后一致：地址在上面）。
 */
export const checkSendConfig = (input: {
  spec: ProviderSpec
  baseUrl: string
  model: string
}): SendConfigVerdict => {
  const baseUrl = input.baseUrl.trim()
  const model = input.model

  if (baseUrl === '') {
    return block('base_url_empty')
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return block('base_url_no_protocol')
  }
  if (hasEndpointPath(baseUrl, input.spec)) {
    return block('base_url_endpoint_path')
  }
  if (model.trim() === '') {
    return block('model_empty')
  }
  // 首尾空格 + 中间空格 + 换行 / 制表符：模型名必须是连续的一串，上游对带空白的名字一律 400
  if (/\s/.test(model)) {
    return block('model_space')
  }
  return { ok: true }
}
