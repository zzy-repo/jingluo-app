/**
 * 上游「参数错误」提示的可操作化（Issue #353）。
 *
 * 现象：用户只发一句「你好」就收到「请求被上游判定为参数错误，请检查设置里的模型与接口配置」——
 * 既没说哪个参数错，也没给上游原文，更没有跳到设置的口子，用户和反馈群都无从判断。
 *
 * 这里只放**纯函数**（不碰 DOM、不碰存储、不碰 i18n），好让 Node 单测直接 import：
 * - `sanitizeUpstreamError`：把上游原文压成一行、脱敏、截断，可以直接贴给用户看
 * - `checkSendConfig`：发送前的最小结构自检，拦下「一定发不出去」的配置，不等上游 400 打回
 *
 * 人类可读的文案由调用方用 i18n 拼装（`services/chat/describe.ts`、`components/chatInput/ChatInput.tsx`）。
 */

export type ProviderKindForCheck = 'deepseek' | 'anthropic' | 'openai' | 'ours'

export type SendConfigIssue =
  /** 模型名为空 */
  | 'modelEmpty'
  /** 模型名里带空格 / 换行：多半是从别处连标签一起粘进来的 */
  | 'modelHasSpaces'
  /** 接口地址为空 */
  | 'baseUrlEmpty'
  /** 接口地址不是 http(s)：多半漏了协议头 */
  | 'baseUrlNotHttp'
  /** 地址填成了具体接口（…/chat/completions）：这里只该填服务根地址 */
  | 'baseUrlLooksLikeEndpoint'

const MAX_UPSTREAM_CHARS = 240
/** 太短的串不当作密钥，避免把普通单词打码成乱码 */
const MIN_SECRET_CHARS = 8

/** 把出现在文案里的密钥整段替换成尾 6 位 */
export const maskSecrets = (text: string, secrets: readonly string[] = []): string => {
  let out = text
  for (const secret of secrets) {
    const value = secret.trim()
    if (value.length < MIN_SECRET_CHARS) {
      continue
    }
    out = out.split(value).join(`••••${value.slice(-6)}`)
  }
  return out
}

/**
 * 上游原文 → 可以贴给用户看的一行。
 *
 * 换行与连续空白压成单个空格：错误提示是单行 span，留着换行会被 HTML 折叠成一串难读的长句。
 * 空串表示上游什么都没给，调用方据此换一句「上游没有给出具体字段」。
 */
export const sanitizeUpstreamError = (message: string, secrets: readonly string[] = []): string => {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (!flat) {
    return ''
  }
  const masked = maskSecrets(flat, secrets)
  return masked.length > MAX_UPSTREAM_CHARS ? `${masked.slice(0, MAX_UPSTREAM_CHARS)}…` : masked
}

/** 用户误把完整接口粘进「服务地址」的两种典型形态 */
const ENDPOINT_SUFFIX = /\/(chat\/completions|messages|completions|responses)\/?$/i

/**
 * 发送前的最小自检：不做网络请求、不猜模型列表，只拦「一定发不出去」和「十有八九拼错」的配置。
 *
 * 注意**不校验** `/v1` 是否存在：各渠道的路径由 `providers.ts` 的 spec 拼装，
 * `joinUrl` 已经能把重复的版本段去重，`https://api.example.com` 与 `https://api.example.com/v1`
 * 两种写法都合法，硬校验反而会误伤。
 */
export const checkSendConfig = (config: {
  kind: ProviderKindForCheck
  baseUrl: string
  model: string
}): SendConfigIssue | null => {
  const model = config.model.trim()
  if (!model) {
    return 'modelEmpty'
  }
  if (/\s/.test(model)) {
    return 'modelHasSpaces'
  }
  const baseUrl = config.baseUrl.trim()
  if (!baseUrl) {
    return 'baseUrlEmpty'
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return 'baseUrlNotHttp'
  }
  // 官方渠道的地址由内置 spec 决定，用户改不了，没必要再挑
  if (config.kind === 'deepseek') {
    return null
  }
  if (ENDPOINT_SUFFIX.test(baseUrl)) {
    return 'baseUrlLooksLikeEndpoint'
  }
  return null
}
