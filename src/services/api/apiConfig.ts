import { create } from 'zustand'
import { captureStateSnapshot, recordAction } from '../diagnostics/collector.js'
import { cacheCustomerId, resetCustomerIdCache } from '../ours/customerId.js'
import {
  identityOnKeyWrite,
  identityOnSuccess,
  keyIdentityView,
  parseKeyIdentity,
  serializeKeyIdentity,
  type KeyIdentity,
  type KeyIdentityView,
} from '../invite/keyIdentity.js'
import { isKeyFormatInvalid } from './keyFailure.js'
import { checkSendConfig, type SendConfigVerdict } from './sendConfigCheck.js'
import {
  managedKeyVerdict,
  serverKeyMark,
  usesManagedKey,
  type ManagedKeyVerdict,
  type ServerKeyMark,
} from './managedKey.js'
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
 * 老用户共享的 chat-demo:base-url / chat-demo:model 只属于 DeepSeek 官方，且**只有老中转地址仍在用时**
 * 才算数（#339）：地址已经回到官方默认，共享键里的模型就是别的渠道串过来的残留，不再参与请求，
 * 由 configMigration.ts 在升级启动时一次性清掉。
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
  /**
   * Key 身份记录（Issue #451）：`{ f: 指纹, b: 绑定时间, s: 最近一次确认可用时间 }`。
   * 与 `chat-demo:api-key` 分开存：Key 会被各种路径覆写 / 清空，身份记录要能跟着指纹判断
   * 「这条记录还是不是当前这把 Key 的」（判定在 `../invite/keyIdentity.ts`，这里只管读写）。
   */
  keyIdentity: 'chat-demo:key-identity',
  /**
   * 「我们的渠道」服务端下发标记（Issue #596）：`{f: 指纹, tail: 尾 4 位, at: 下发时间, id?: Key 的 id}`。
   *
   * 与 `chat-demo:api-key` 分开存，理由和上面的身份记录一样：Key 会被多条路径覆写，
   * 而「这把 Key 是服务端给的那把吗」必须能独立回答。**只有下发成功才会写它**
   * （`applyManagedKey`），手填走 `setApiKey` 写不到这里 —— 所以「手填混过发送前校验」
   * 在结构上不可能发生。
   */
  serverKey: 'chat-demo:ours-server-key',
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

/**
 * 老中转是否还在用：共享地址存在、且不是当前 spec 的官方默认地址。
 *
 * 老用户的中转地址（共享 `chat-demo:base-url`）与模型（共享 `chat-demo:model`）是**一套配置**，
 * 必须一起保留或一起忽略（#339）：
 * - 还在用中转 → 模型继续生效（1.2.3 升级无感的契约，`tests/integration/legacy-config.test.mjs` 锁着）；
 * - 地址已回到官方默认 → 那个模型一定是从别的渠道串过来的残留，不许再参与请求。
 */
export const isLegacyRelayInUse = (kind: ProviderKind): boolean => {
  if (kind !== LEGACY_KIND) {
    return false
  }
  const stored = storedBaseUrl(kind)
  return Boolean(stored) && stored !== getSpec(kind).defaults?.baseUrl
}

/**
 * 已保存的模型：
 * - 锁定渠道（ours）恒为空串：模型只认 spec.defaults
 * - 字段不可编辑的内置渠道（官方 deepseek）：**不读**共享键残留，只有老中转仍在用时才保留旧值（#339）
 * - 自填渠道（anthropic / openai）：读各自的 `chat-demo:model:<渠道>`
 *
 * 守卫顺序很关键：`isUserField` 必须在 legacy 分支**之前**，否则内置渠道永远走不到「不读残留」。
 */
const storedModel = (kind: ProviderKind): string => {
  const spec = getSpec(kind)
  if (spec.locked || !isUserField(spec, 'model')) {
    return kind === LEGACY_KIND && isLegacyRelayInUse(kind)
      ? (read(CONFIG_KEYS.model) ?? '').trim()
      : ''
  }
  return (read(scopedKey('model', kind)) ?? '').trim()
}

/** 迁移专用：老版共享模型键的当前值（1.2.x 遗留；这里是它唯一的读点） */
export const readLegacySharedModel = (): string => (read(CONFIG_KEYS.model) ?? '').trim()

/** 迁移专用：清掉老版共享模型键（等价于用户手工 `removeItem('chat-demo:model')`） */
export const clearLegacySharedModel = (): void => write(CONFIG_KEYS.model, null)

/**
 * 迁移专用：按原样读 / 写任意配置键。
 *
 * localStorage 的访问只发生在 apiConfig.ts（配置层的唯一宿主能力入口）：
 * 迁移模块借这两个口子读写版本号，不要自己去碰 localStorage —— 既保持「存储异常一律吞掉」
 * 的口径统一，也让宿主能力盘点（docs/capabilities/host.md）只多一个调用点而不是一个新文件。
 */
export const readConfigValue = (key: string): string | null => read(key)
export const writeConfigValue = (key: string, value: string | null): void => write(key, value)

/**
 * 迁移专用：清键之后把界面 state 里的模型同步成当前渠道真正生效的值。
 *
 * store 的初值是在模块加载时读进来的，清掉 localStorage 不会自动改它；
 * 不同步的话，「键清了但这一轮还在发旧模型」，看起来像迁移没生效。
 */
export const syncModelFromStorage = (): void => {
  useApiConfig.setState({ model: storedModel(getProviderKind()) })
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

// ---------------------------------------------------------------- 发送前必错配置（#490）

/**
 * 已存地址的**原样**（不经过 `normalizeBaseUrl`，只按已下线主机那条既有规矩丢弃）。
 *
 * 为什么不复用 `storedBaseUrl`：那个函数回答的是「发请求时用哪个地址」，非法值会被
 * `normalizeBaseUrl` 判成 `''`（于是请求悄悄落到构建期默认地址上）；而 #490 要回答的是
 * 「用户到底填了什么」—— 填成 `api.example.com`（缺协议）时，`storedBaseUrl` 已经把它抹成 `''`，
 * 于是「缺协议」这一类**永远命中不了**。原样读出来才判得清他是没填，还是填错了。
 */
const rawStoredBaseUrl = (kind: ProviderKind): string => {
  const spec = getSpec(kind)
  if (spec.locked || !isUserField(spec, 'baseUrl')) {
    // 内置地址的渠道（ours）与地址不可编辑的官方渠道：用户没有「填过」，不该被这一栏判死
    return ''
  }
  const key = kind === LEGACY_KIND ? CONFIG_KEYS.baseUrl : scopedKey('baseUrl', kind)
  return dropLegacyHost((read(key) ?? '').trim())
}

/**
 * 「地址到底填了什么」：已存值优先，其次 spec 内置默认；**不套构建期的 `DEFAULT_BASE_URL`**。
 *
 * 为什么要与 `getBaseUrl()` 分开：那个兜底（`__API_ORIGIN__`）是给「只有一个官方渠道」的年代
 * 用的，对自填渠道来说它是**别人的地址**。判定「用户填了没有」必须看用户真正填的那一份，
 * 否则空地址会被兜底填成一个看着合法的 URL，拦截永远命中不了（#490 的第 3 类）。
 */
export const configuredBaseUrl = (): string => {
  const spec = getCurrentSpec()
  if (spec.locked) {
    return spec.defaults?.baseUrl ?? ''
  }
  return rawStoredBaseUrl(spec.kind) || spec.defaults?.baseUrl || ''
}

/**
 * 「模型到底填了什么」：与 `configuredBaseUrl` 同一个理由，**不套 `DEFAULT_MODEL`**。
 *
 * 以前自填渠道没填模型时，`getModel()` 会回 `deepseek-flash`（官方渠道的默认值），
 * 于是一个「必错配置」在界面上看着完全正常 —— 请求发出去只会换回 400 模型不存在（#490 的第 1 类）。
 */
export const configuredModel = (): string => {
  const spec = getCurrentSpec()
  if (spec.locked) {
    return spec.defaults?.model ?? ''
  }
  return storedModel(spec.kind) || spec.defaults?.model || ''
}

/**
 * 发送前必错配置判定：把「当前渠道 + 用户真正填的值」喂给纯函数 `checkSendConfig()`。
 *
 * 判定逻辑一个字都不在这里（`sendConfigCheck.ts` 是纯函数、可单测）；这里只负责**取哪几个值**。
 * `spec` 也传进去：接口尾巴是从渠道表派生的，判定要知道「当前渠道的接口长什么样」。
 */
export const checkCurrentSendConfig = (): SendConfigVerdict =>
  checkSendConfig({ spec: getCurrentSpec(), baseUrl: configuredBaseUrl(), model: configuredModel() })

// ------------------------------------------------------------------ Key 身份（Issue #451）

/** 存储里的原始记录（坏数据 → null，见 `parseKeyIdentity`） */
export const getKeyIdentity = (): KeyIdentity | null =>
  parseKeyIdentity(read(CONFIG_KEYS.keyIdentity))

/**
 * 当前这把 Key 的身份视图：`none` = 本机没有它的记录（从没写过 / 存储被清 / 记录是上一把 Key 的）。
 * 界面据此决定「显示两个时间」还是「说一句没有记录」，绝不把上一把 Key 的绑定时间挂到这把上。
 */
export const getCurrentKeyIdentity = (): KeyIdentityView =>
  keyIdentityView(getKeyIdentity(), getApiKey())

/**
 * 记一次「这把 Key 刚刚被确认可用」（Issue #451 第 1 点）。
 *
 * **只在真的拿到成功应答时调**：设置里校验 Key、连通性测试、我们的渠道 Key 探测、
 * 重置额度、兑换卡密五处。当前没有 Key → 什么都不写（返回 false）。
 *
 * 为什么不在这里猜测聊天是否成功：那条路径在 `services/chat/*`，不在 #451 允许改动的文件面内，
 * 口径与原因写在 `../invite/keyIdentity.ts` 的文件头。
 */
export const recordKeySuccess = (apiKey?: string, at: number = Date.now()): boolean => {
  const key = (apiKey ?? getApiKey()).trim()
  const next = identityOnSuccess(getKeyIdentity(), key, at)
  if (next === null) {
    return false
  }
  write(CONFIG_KEYS.keyIdentity, serializeKeyIdentity(next))
  return true
}

/**
 * 服务端下发标记的存储形态（Issue #596）：键名压到最短，坏数据一律当没有。
 * 只留指纹 / 尾号 / 时间 / id —— **Key 原文不进这条记录**（与 #451 的身份记录同一口径）。
 */
const isServerKeyMark = (value: unknown): value is ServerKeyMark => {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.fingerprint === 'string' &&
    record.fingerprint !== '' &&
    typeof record.tail === 'string' &&
    typeof record.at === 'number' &&
    Number.isFinite(record.at)
  )
}

/** 已记录的服务端下发标记；没下发过 / 记录坏了都是 null */
export const getServerKeyMark = (): ServerKeyMark | null => {
  const raw = read(CONFIG_KEYS.serverKey)
  if (raw === null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isServerKeyMark(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 记下「服务端刚才把这把 Key 下发给了本机」。**只在下发成功之后调用**（见 managedKey.ts）。
 *
 * 单独一个函数而不是塞进 `setApiKey`：手填 Key 与下发 Key 必须走两条路，
 * 否则「标记还在、Key 被换掉」这种事故就能靠手填复现（#596 第 3 条要防的就是它）。
 */
export const markServerKey = (apiKey: string, id?: number, at: number = Date.now()): boolean => {
  const value = apiKey.trim()
  if (value === '') {
    return false
  }
  const mark = serverKeyMark(value, at, id)
  write(CONFIG_KEYS.serverKey, JSON.stringify(mark))
  return true
}

/** 清掉下发标记（退出账号 / 记录坏了自愈时用）；不动 Key 本身 */
export const clearServerKeyMark = (): void => {
  write(CONFIG_KEYS.serverKey, null)
}

/**
 * 落盘一把**服务端下发**的 Key：Key 本身 + 下发标记**同时写**（Issue #596 第 3 条）。
 *
 * 两件事分开写会出现「界面尾号来自 A、请求用的是 B」的中间态；这一个入口保证
 * 「显示的那把 = 发送时用的那把 = 服务端刚下发的那把」。
 */
export const applyManagedKey = (apiKey: string, id?: number): boolean => {
  const value = apiKey.trim()
  if (value === '') {
    return false
  }
  setApiKey(value)
  markServerKey(value, id)
  return true
}

/**
 * 「我们的渠道」下本机 Key 与服务端的关系（Issue #596 的判据）。
 * 其它渠道恒为 `ok` —— 那是用户自己的 Key，我们不管。
 */
export const getManagedKeyVerdict = (): ManagedKeyVerdict =>
  usesManagedKey(getProviderKind())
    ? managedKeyVerdict({ localKey: getApiKey(), mark: getServerKeyMark() })
    : 'ok'

/**
 * 发送前能不能放行（Issue #451 第 2 点）：`ok` 放行 / `missing` 没填 / `format` 本地就能判死的格式问题。
 *
 * 三态而不是布尔：调用方对前三者的处理不同 ——
 *  - `missing` 走 #374 之前就有的那条路（打开设置、选中「数据管理」）；
 *  - `format` 要**额外说清原因**（含空格 / 换行 / 长度不像一把 Key），因为用户手上明明「有 Key」，
 *    不给他这句话，他只会以为 Key 被删了；
 *  - 两者都**不发请求**，所以拿不到 401 也拿不到上游原文 —— 这条拦截的全部价值就在这里。
 *
 * #596 给「我们的渠道」加了两档（`claim` / `stale`），排在最前面：这两档说的是
 * 「本地 Key 不是服务端那把」，先于格式判断 —— 一把格式完美的手填 Key 同样要被拦。
 *
 * 判据只有 `isKeyFormatInvalid`（#374 定的口径）+ `managedKeyVerdict`（#596），本函数不另立一套：
 * 两处判断一旦分叉，就会出现「发送被拦、但失败文案说没问题」这种互相打架的状态。
 */
export type PreSendApiKeyStatus = 'ok' | 'missing' | 'format' | 'claim' | 'stale'

export const checkApiKeyBeforeSend = (): PreSendApiKeyStatus => {
  if (usesManagedKey(getProviderKind())) {
    const verdict = getManagedKeyVerdict()
    if (verdict !== 'ok') {
      return verdict === 'stale' ? 'stale' : 'claim'
    }
    return 'ok'
  }
  const apiKey = getApiKey()
  if (apiKey.trim() === '') {
    return 'missing'
  }
  return isKeyFormatInvalid(apiKey) ? 'format' : 'ok'
}

/**
 * 拼接 baseUrl 与 spec 里的路径（#303）。
 *
 * 自填渠道的用户经常把版本段也写进地址（`https://host/v1`），而 spec 的路径同样以 `/v1/...`
 * 开头，天真相加会得到 `/v1/v1/chat/completions`——网关对这条路径只回裸 404
 * （线上取证：`POST /v1/v1/chat/completions → 404 page not found`，而 `/v1/chat/completions`
 * 本身是通的）。所以「路径首段与地址尾段相同」时只保留一份。
 *
 * 只消一次、只消首段：地址里别的路径段（`/openai/v1`）与多段重复不在本函数职责内，
 * 那种地址本身就是用户填错，界面上会表现为可读的 4xx，而不是靠这里猜。
 */
export const joinUrl = (baseUrl: string, path: string): string => {
  if (!path) {
    return baseUrl
  }
  const base = baseUrl.replace(/\/+$/, '')
  if (!path.startsWith('/')) {
    return `${base}/${path}`
  }
  const [first] = path.slice(1).split('/')
  if (first && base.endsWith(`/${first}`)) {
    return `${base}${path.slice(first.length + 1)}`
  }
  return `${base}${path}`
}

/** GET 模型列表：baseUrl + paths.models（官方 /models，Anthropic 兼容 /v1/models） */
export const getModelsUrl = (): string => joinUrl(getBaseUrl(), getCurrentSpec().paths.models)
/** 发消息：baseUrl + paths.messages */
export const getMessagesUrl = (): string => joinUrl(getBaseUrl(), getCurrentSpec().paths.messages)
/** ASR / TTS 等工具接口前缀 */
export const getToolsBaseUrl = (): string => joinUrl(getBaseUrl(), getCurrentSpec().paths.tools)

/**
 * 附件上传地址：当前渠道**真的**有 Files API 时才返回，否则 null。
 *
 * 这一条是 #303 的核心：`null` 表示「这个渠道传不了文件」，调用方必须据此禁用入口/降级，
 * 不允许再拿 messages 前缀拼出 `/v1/chat/completions/files` 这种凭猜测的路径。
 */
export const getFilesUrl = (): string | null => {
  const path = getCurrentSpec().paths.files
  return path ? joinUrl(getBaseUrl(), path) : null
}

/** 当前渠道是否支持附件上传（入口显隐与提示都看它，不再只看 caps.vision） */
export const supportsFileUpload = (): boolean => Boolean(getCurrentSpec().paths.files)

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
  /**
   * #451：Key 身份记录跟着这次写入走 ——
   *  - 同一把 Key 重复保存：绑定时间**不刷新**（点两次保存不等于换了两次 Key）；
   *  - 换了一把（或清空）：旧记录作废，新记录从这一刻起算、成功时间清空。
   * 放在 `write` 之后：读的 `getKeyIdentity()` 是上一次的原始记录，两者不会互相覆盖。
   */
  const identity = identityOnKeyWrite(getKeyIdentity(), value, Date.now())
  write(CONFIG_KEYS.keyIdentity, identity === null ? null : serializeKeyIdentity(identity))
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
