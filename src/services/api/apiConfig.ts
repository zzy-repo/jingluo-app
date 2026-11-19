import { create } from 'zustand'
import { captureStateSnapshot, recordAction } from '../diagnostics/collector.js'
import { cacheCustomerId, resetCustomerIdCache } from '../ours/customerId.js'
import {
  DEFAULT_PROVIDER_KIND,
  getSpec,
  isUserField,
  isProviderKind,
  type ProviderKind,
  type ProviderSpec,
} from './providers.js'

/**
 * 配置：当前渠道 + 三个字段，全部存 localStorage。
 * - chat-demo:provider-kind        当前渠道（deepseek / anthropic / openai / ours）；旧用户没有这个 key，
 *                                  按当前构建的默认渠道处理（内测包 ours / 标准包 deepseek）
 * - chat-demo:api-key              API Key：**所有渠道共用一把**（切换渠道不丢，界面会提示可重填）
 * - chat-demo:base-url:<渠道>      用户自填渠道（anthropic / openai）的服务地址，按渠道分开存，
 *                                  切渠道不会把 A 的地址带给 B
 * - chat-demo:model:<渠道>         同上，按渠道分开存的模型
 *
 * 内置地址/模型的渠道（deepseek / ours）在 spec.fields 里没有 baseUrl / model：
 * 设置页不渲染这两行，setter 直接拒绝写入，值只从 spec.defaults 取。
 * 老用户共享的 chat-demo:base-url / chat-demo:model 只有 DeepSeek 官方这一路还当兜底读（升级无感）。
 *
 * 请求路径与鉴权头都来自 ProviderSpec（providers.ts），这里只负责「当前用哪个 spec + 取到值」。
 */
export type ApiConfig = {
  kind: ProviderKind
  apiKey: string
  baseUrl: string
  model: string
}

/** 构建期注入的默认服务地址，仅在服务类型与已存值都取不到时兜底 */
export const DEFAULT_BASE_URL: string = __API_ORIGIN__
export const DEFAULT_MODEL = 'deepseek-flash'

export const CONFIG_KEYS = {
  kind: 'chat-demo:provider-kind',
  apiKey: 'chat-demo:api-key',
  /** 1.2.2 之前只有这一份地址/模型（当时只有 DeepSeek 官方），保留为老用户兜底 */
  baseUrl: 'chat-demo:base-url',
  model: 'chat-demo:model',
} as const

/** 用户自填字段按渠道分开存：chat-demo:base-url:anthropic 这类 */
export const scopedKey = (field: 'baseUrl' | 'model', kind: ProviderKind): string =>
  `chat-demo:${field === 'baseUrl' ? 'base-url' : 'model'}:${kind}`

/** 老用户那份共享地址/模型只属于 DeepSeek 官方（当年只有它一个渠道） */
const LEGACY_KIND: ProviderKind = 'deepseek'

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/**
 * 服务地址校验：必须是 http(s) 且能被 new URL() 解析，保存时去掉尾斜杠。
 * 返回 null 表示非法。
 */
export const normalizeBaseUrl = (value: string): string | null => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    if (!url.hostname) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}

/** 当前生效的渠道；没选过（老用户没有这个 key）就按构建默认渠道 */
export const getProviderKind = (): ProviderKind => {
  const saved = read(CONFIG_KEYS.kind)
  return isProviderKind(saved) ? saved : DEFAULT_PROVIDER_KIND
}

/** 配置保存被拒（校验失败）：UI 的保存分支失败时调用，日志里能看到「改了但没生效」 */
export const recordConfigRejection = (field: 'baseUrl' | 'model' | 'apiKey', reason: string) => {
  recordAction('config_change', `provider-${field}`, { result: 'rejected', reason })
}

/** 日志里只记 host：完整地址可能带路径与凭证，没必要写进日志 */
const readHost = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'invalid'
  }
}

/**
 * 已下线的主机（写死 IP 时代的产品地址，#181 服务端迁移）：
 * - 第一代：beta.5 之前的 Anthropic Messages 协议上游
 * - 第二代：beta.8 及之前的对话上游（现行地址见 providers.ts 的 ours.defaults）
 *
 * 用户本地存过这些地址的话，升级后它们已经不通了；读到即视为「没配过」，
 * 回落到当前 spec 的内置默认（对话上游 = config/endpoints.json 的 chatBaseUrl）。
 *
 * 名单本身来自 config/endpoints.json 的 `legacyHosts`（#274）：它是**旧域名重写表**，
 * 迁移一次加一行，删了会让老配置失联，所以只搬来源、不删不缩。
 */
export const LEGACY_HOSTS: readonly string[] = __ENDPOINTS__.legacyHosts

/** 已存地址是否指向已下线的主机 */
const isLegacyHost = (baseUrl: string): boolean => {
  try {
    return (LEGACY_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/** 丢掉指向已下线主机的已存地址（等同「没配过」） */
const dropLegacyHost = (value: string): string => (isLegacyHost(value) ? '' : value)

/**
 * 已保存的地址：
 * - 锁定渠道（ours）恒为空串：地址只认 spec.defaults
 * - DeepSeek 官方：读老用户那份共享的 chat-demo:base-url（1.2.2 只有它一个渠道），
 *   升级后老中转地址仍然生效；界面不渲染这一行，用户改不了
 * - 自填渠道（anthropic / openai）：读各自的 chat-demo:base-url:<渠道>
 */
const storedBaseUrl = (kind: ProviderKind): string => {
  const spec = getSpec(kind)
  if (spec.locked) {
    return ''
  }
  if (kind === LEGACY_KIND) {
    return dropLegacyHost(normalizeBaseUrl(read(CONFIG_KEYS.baseUrl) ?? '') ?? '')
  }
  if (!isUserField(spec, 'baseUrl')) {
    return ''
  }
  return dropLegacyHost(normalizeBaseUrl(read(scopedKey('baseUrl', kind)) ?? '') ?? '')
}

/** 已保存的模型：规则同地址（老用户那份 chat-demo:model 只属于 DeepSeek 官方） */
const storedModel = (kind: ProviderKind): string => {
  const spec = getSpec(kind)
  if (spec.locked) {
    return ''
  }
  if (kind === LEGACY_KIND) {
    return (read(CONFIG_KEYS.model) ?? '').trim()
  }
  if (!isUserField(spec, 'model')) {
    return ''
  }
  return (read(scopedKey('model', kind)) ?? '').trim()
}

const initialKind = getProviderKind()

/** 已保存的原始值（空串表示没配置过，使用默认值） */
export const useApiConfig = create<ApiConfig>(() => ({
  kind: initialKind,
  apiKey: read(CONFIG_KEYS.apiKey) ?? '',
  baseUrl: storedBaseUrl(initialKind),
  model: storedModel(initialKind),
}))

/**
 * 当前渠道是不是「我们的渠道」（自有渠道）。
 *
 * 判定源只有渠道本身（`chat-demo:provider-kind === 'ours'`，见 providers.ts 的 spec），
 * 不看地址、不看域名——第三方 / 自定义 baseUrl 一律不算，所以这里也不硬编码任何主机。
 * 额度 / 套餐 / 卡密 / 支付记录 / 我的购买这些入口都只在这条渠道下有意义，
 * 组件里一律走这个 hook，别各自再写一份 `kind === 'ours'`。
 * 它是 useApiConfig 的选择器：会话中切渠道时订阅者会跟着重渲染。
 */
export const useIsOursChannel = (): boolean => useApiConfig((state) => state.kind === 'ours')

/** 当前生效的 spec：路径、鉴权头、能力开关都从它取 */
export const getCurrentSpec = (): ProviderSpec => getSpec(getProviderKind())

/**
 * 服务地址：已存的值优先（升级前配过中转的用户保持原样），
 * 其次用当前 spec 的内置默认，最后回落到构建期地址。
 */
const resolveBaseUrl = (): string => {
  const spec = getCurrentSpec()
  if (spec.locked) {
    // 内置锁定渠道（ours）：地址由 spec.defaults 决定，已存值一律不参与
    return spec.defaults?.baseUrl ?? DEFAULT_BASE_URL
  }
  const stored = storedBaseUrl(spec.kind)
  if (stored) {
    return stored
  }
  return spec.defaults?.baseUrl ?? DEFAULT_BASE_URL
}

/** 模型：同上，已存值优先，其次 spec 默认，最后 deepseek-flash */
const resolveModel = (): string => {
  const spec = getCurrentSpec()
  if (spec.locked) {
    // 内置锁定渠道（ours）：模型由 spec.defaults 决定，已存值一律不参与
    return spec.defaults?.model ?? DEFAULT_MODEL
  }
  const stored = storedModel(spec.kind)
  if (stored) {
    return stored
  }
  return spec.defaults?.model ?? DEFAULT_MODEL
}

/** 每次请求都重新读取，切换/修改后立即生效 */
export const getApiKey = (): string => read(CONFIG_KEYS.apiKey) ?? ''
export const getBaseUrl = (): string => resolveBaseUrl()
export const getModel = (): string => resolveModel()

/** GET 模型列表：baseUrl + paths.models（官方 /models，Anthropic 兼容 /v1/models） */
export const getModelsUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.models}`
/** 发消息：baseUrl + paths.messages */
export const getMessagesUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.messages}`
/** Messages 前缀，附件接口挂在其下（`{messages}/files`） */
export const getMessagesBaseUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.messages}`
/** ASR / TTS 等工具接口前缀 */
export const getToolsBaseUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.tools}`

/** 保存渠道并立即生效（路径、鉴权头、输入行、能力入口随之切换）；API Key 保持不动（共用一把） */
export const setProviderKind = (kind: ProviderKind) => {
  const next = isProviderKind(kind) ? kind : DEFAULT_PROVIDER_KIND
  write(CONFIG_KEYS.kind, next)
  // 地址/模型按渠道分开存，切换后要把界面上的已存值换成新渠道的
  useApiConfig.setState({ kind: next, baseUrl: storedBaseUrl(next), model: storedModel(next) })
  recordAction('config_change', 'provider-kind', { result: 'saved', kind: next })
  void captureStateSnapshot('after-config-change')
}

/** 保存 API Key；空值等于清除（回到未配置状态） */
export const setApiKey = (apiKey: string) => {
  const value = apiKey.trim()
  const previous = getApiKey()
  write(CONFIG_KEYS.apiKey, value || null)
  useApiConfig.setState({ apiKey: value })
  // Issue #135：换 Key 等于换账号，cid 是跟着人走的。旧 cid 留着会把新账号的订单挂到上一个
  // 客户名下（付了钱 `/api/orders` 还是查不到，App 一直「等待支付」），所以换号就丢弃，
  // 下次下单重新解析。同一把 Key 重复保存不动缓存，免得每次保存都白丢一次往返。
  if (previous !== value) {
    resetCustomerIdCache()
    cacheCustomerId(null)
  }
  // 只记「有没有 / 多长」，密钥原文绝不进日志
  recordAction('config_change', 'provider-api-key', {
    result: value ? 'saved' : 'cleared',
    present: value.length > 0,
    length: value.length,
  })
}

/** 保存服务地址；非法返回 false 且不写入。空值等于清除（回到内置默认地址） */
export const setBaseUrl = (baseUrl: string): boolean => {
  const spec = getCurrentSpec()
  if (!isUserField(spec, 'baseUrl')) {
    // 内置地址的渠道（deepseek / ours）：写不进去（设置页也不渲染这一行）
    return false
  }
  const key = scopedKey('baseUrl', spec.kind)
  if (!baseUrl.trim()) {
    write(key, null)
    useApiConfig.setState({ baseUrl: '' })
    return true
  }
  const value = normalizeBaseUrl(baseUrl)
  if (!value) {
    recordAction('config_change', 'provider-base-url', { result: 'invalid', reason: 'normalize' })
    return false
  }
  write(key, value)
  useApiConfig.setState({ baseUrl: value })
  recordAction('config_change', 'provider-base-url', { result: 'saved', host: readHost(value) })
  void captureStateSnapshot('after-config-change')
  return true
}

/** 保存模型；空值非法（返回 false），清除请传 null */
export const setModel = (model: string, reset = false): boolean => {
  const spec = getCurrentSpec()
  if (!isUserField(spec, 'model')) {
    // 内置模型的渠道（deepseek / ours）：写不进去（设置页也不渲染这一行）
    return false
  }
  const key = scopedKey('model', spec.kind)
  if (reset) {
    write(key, null)
    useApiConfig.setState({ model: '' })
    return true
  }
  const value = model.trim()
  if (!value) {
    recordAction('config_change', 'provider-model', { result: 'invalid', reason: 'empty' })
    return false
  }
  write(key, value)
  useApiConfig.setState({ model: value })
  recordAction('config_change', 'provider-model', { result: 'saved', model: value })
  void captureStateSnapshot('after-config-change')
  return true
}
