/**
 * 「我们的渠道」的 Key 由**服务端**下发（Issue #596）。
 *
 * ## 为什么这是一条硬规矩，不是体验优化
 *
 * 手填入口放开的这段时间里出过三类真事故（见 #596 正文）：
 *
 *  1. 用户换过 Key 之后本机还留着上一把 —— 界面显示 `···e8494c`，服务端早就是新的了，
 *     用户一直 401，却以为是「服务器繁忙」；
 *  2. 用户把 Key 复制到别的客户端 —— 实测同一批 Key 被 7 台手机 / 8 个 IP / 跨 4 个省共用；
 *  3. 手填的 Key 可能属于**别的账号** —— 扣费不知道该扣谁，出问题无法追溯。
 *
 * 根因是「本地那一把」与「服务端那一把」可以各说各话。所以本模块只做一件事：
 * 让「我们的渠道」下本机存的 Key **只能来自服务端**，并且**随时能判出它还是不是服务端那把它**。
 *
 * ## 判据（{@link managedKeyVerdict}）
 *
 * 服务端下发成功的那一刻，本机同时记一条「下发标记」（只存短指纹与尾号，见
 * `apiConfig.markServerKey`）。之后每次发送前拿本机 Key 去比这条标记：
 *
 *  - 本机没有 Key            → `unclaimed`（还没领取过）
 *  - 本机有 Key、但没有标记  → `unclaimed`（这把不是服务端给的：手填的、或老版本留下的）
 *  - 指纹与标记不一致        → `stale`（服务端换过了，本机这把是旧的）
 *  - 指纹一致                → `ok`（就是服务端那一把）
 *
 * 「没有标记也按未领取处理」是**故意 fail-closed** 的：手填一条 Key 不会顺手写标记
 * （`markServerKey` 只在下发成功后被调用），所以「手填 → 混过校验」这条路在结构上就不存在。
 *
 * ## 领取走哪条链路（不新建通道）
 *
 * 服务端**没有** `/apply`、`/rotate` 这两个名字（`docs/sub2api-client-contract.md` §3.7 把它们
 * 列在「典型幻觉清单」里，写了就是错的）。现行等价链路是面板的 Key 管理三条现成接口，
 * 与「账号 → 账户与消费 → 账号」面板里已经在用的是同一条：
 *
 *   POST /api/v1/keys       领取（首次下发 / 换一把）。`name` 去重 → 同一台设备重复领取是**幂等**的
 *   GET  /api/v1/keys       读服务端当前那把（面板列表；本模块用不上，留给面板）
 *   PUT  /api/v1/keys/:id   换 Key 之后把旧那把置为 inactive（近似 /rotate 的收尾）
 *
 * 「领取」= 按**本机固定的 Key 名**调 create（同名命中即返回已有那把，不会长出新 Key）；
 * 「重新领取」= 用带时间戳的新名字调 create（必然是新 Key），成功后把旧那把停用。
 *
 * 纯逻辑：不碰 DOM、不读存储、不发请求（`ManagedKeySource` 由调用方注入），Node 单测可直接 import。
 */
import type { ConsumeApiKey, ConsumeCallResult, ConsumePage } from '../consume/index.js'
import { keyFingerprint } from '../invite/keyIdentity.js'
import type { ProviderKind } from './providers.js'

/** 哪些渠道的 Key 由服务端管理。今天只有 `ours` 一条，写成函数是为了将来加渠道时只有一个改动点。 */
export const usesManagedKey = (kind: ProviderKind): boolean => kind === 'ours'

/** 本机 Key 与服务端下发标记的关系（判据见文件头） */
export type ManagedKeyVerdict = 'ok' | 'unclaimed' | 'stale'

/** 服务端下发标记：**只留指纹与尾号**，Key 原文一个字都不进这里（与 #451 的存储口径一致） */
export type ServerKeyMark = {
  /** `keyFingerprint()` 的结果：同一把 Key 恒定、换一把必变、不可反推 */
  fingerprint: string
  /** 尾 4 位，只用于界面显示「当前 Key ···e849」 */
  tail: string
  /** 下发（或确认）时间，毫秒 */
  at: number
  /** 服务端那把 Key 的 id：重新领取后要把旧那把停用，靠它 */
  id?: number
}

/**
 * 判定本机 Key 与服务端那把的关系。
 *
 * 注意入参是**值**而不是从存储里读：判定要能在单测里逐格跑，也要保证
 * 「显示尾号」与「发送时用的 Key」永远来自同一个来源（#596 第 3 条）。
 */
export const managedKeyVerdict = (input: {
  localKey: string
  mark: ServerKeyMark | null
}): ManagedKeyVerdict => {
  const local = input.localKey.trim()
  if (local === '') {
    return 'unclaimed'
  }
  if (input.mark === null) {
    return 'unclaimed'
  }
  return input.mark.fingerprint === keyFingerprint(local) ? 'ok' : 'stale'
}

/** 界面显示的尾号：取**实际会用于请求的那一把**（调用方传 `getApiKey()` 的结果） */
export const managedKeyTail = (apiKey: string, length: number = 4): string => {
  const value = apiKey.trim()
  return value === '' ? '' : value.slice(-length)
}

/** 生成一条下发标记（下发成功后调用；不写存储，存储只在 `apiConfig` 里） */
export const serverKeyMark = (
  apiKey: string,
  at: number = Date.now(),
  id?: number
): ServerKeyMark => {
  const mark: ServerKeyMark = { fingerprint: keyFingerprint(apiKey), tail: managedKeyTail(apiKey), at }
  if (id !== undefined) {
    mark.id = id
  }
  return mark
}

/**
 * 本机 Key 名（设备固定）：服务端 `create` 按 name 去重，所以同一个设备重复「领取」拿回的是同一把。
 *
 * 名字里带设备码前 16 位而不是一个常量：常量会让**所有设备**在第二次领取时去重到同一把 Key ——
 * 那正是 #596 里「7 台手机共用一把 Key」的事故本身。
 */
export const managedKeyName = (deviceId: string): string =>
  `app-${deviceId.trim().replace(/^d-/, '').slice(0, 16)}`

/** 「重新领取」用的新名字：带时间戳（秒 + 36 进制），保证与上一次不同名，从而真的换一把 */
export const rotatedKeyName = (deviceId: string, at: number): string =>
  `${managedKeyName(deviceId)}-${Math.floor(at / 1000).toString(36)}`

/** 领取链路要用到的服务端能力（结构化取子集 → 单测不必造整个 client） */
export type ManagedKeySource = {
  keys: {
    list: (query?: {
      page?: number
      pageSize?: number
      search?: string
    }) => Promise<ConsumeCallResult<ConsumePage<ConsumeApiKey>>>
    create: (input: { name: string }) => Promise<ConsumeCallResult<ConsumeApiKey>>
    update: (
      id: number,
      input: { status: 'active' | 'inactive' }
    ) => Promise<ConsumeCallResult<ConsumeApiKey>>
  }
}

/** 一次领取的结果：Key 原文只在内存里过一手，随后由调用方落盘（并写标记） */
export type ManagedKeyClaim = {
  /** 服务端下发的 Key（`sk-…`）。**不进日志、不进 DOM 全文** */
  key: string
  id: number
  name: string
  /** `true` = 这次是「重新领取」（换了一把），而不是首次领取 / 幂等确认 */
  rotated: boolean
}

/**
 * 领取（`rotate: false`）/ 重新领取（`rotate: true`）。
 *
 * 失败原样返回服务端的错误（`ConsumeCallResult`），**不在这一层翻译文案**：
 * 文案归界面的 `toPanelError`，与面板里其它按钮同一套口径。
 *
 * `rotate` 成功后由 {@link retireManagedKey} 把旧那把停用；停用失败**不让领取失败**
 * （新 Key 已经到手且可用，旧的那把下次还能再停用一次）。
 */
export const claimManagedKey = async (
  source: ManagedKeySource,
  options: { deviceId: string; rotate: boolean; now?: number }
): Promise<ConsumeCallResult<ManagedKeyClaim>> => {
  const at = options.now ?? Date.now()
  const name = options.rotate ? rotatedKeyName(options.deviceId, at) : managedKeyName(options.deviceId)
  const created = await source.keys.create({ name })
  if (!created.ok) {
    return created
  }
  return {
    ok: true,
    status: created.status,
    raw: created.raw,
    data: {
      key: created.data.key,
      id: created.data.id,
      name: created.data.name,
      rotated: options.rotate,
    },
  }
}

/**
 * 「重新领取」的收尾：把旧那把置为 inactive（服务端没有 `/rotate`，用 PUT 状态位等价表达
 * 「这一把不再用了」）。返回是否成功，失败只影响下一次还能不能再停用一次，不影响新 Key。
 */
export const retireManagedKey = async (
  source: ManagedKeySource,
  previousId: number | undefined
): Promise<boolean> => {
  if (previousId === undefined) {
    return true
  }
  const result = await source.keys.update(previousId, { status: 'inactive' })
  return result.ok
}

/**
 * 启动时的对齐（等价于 issue 里「每次启动从服务端拿 key 覆盖本地」那一条）。
 *
 * 用**幂等的领取**（按设备固定名 create）去问服务端「这台设备那把是哪把」，不额外读列表：
 *  - 服务端没有 → 顺手下发一把（首次启动的正常路径）；
 *  - 服务端有   → 直接返回那一把（不会长出新 Key）。
 *
 * 落不落盘由调用方比 `claim.key` 与本机 `getApiKey()` 后决定：只要不一样就**必须**覆盖本地
 * —— 否则就是我们一直在修的「界面显示旧尾号、请求用旧 Key」。
 */
export const syncManagedKey = (
  source: ManagedKeySource,
  options: { deviceId: string; now?: number }
): Promise<ConsumeCallResult<ManagedKeyClaim>> =>
  claimManagedKey(source, {
    deviceId: options.deviceId,
    rotate: false,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
