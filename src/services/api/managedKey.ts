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
import type { ConsumeApiKey, ConsumeCallResult, ConsumePage, Sub2ApiError } from '../consume/index.js'
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
    /**
     * 创建。第二个参数是 #484 §4.3 那道「重试前先 GET」的开关：
     * {@link ensureManagedKey} **已经自己查过重**（同一组 `page/page_size/search`），
     * 所以它传 `dedupe: false` —— 一处判据、一次请求；「重新领取」那条路不查重，用默认的 `true`。
     */
    create: (
      input: { name: string },
      options?: { dedupe?: boolean }
    ) => Promise<ConsumeCallResult<ConsumeApiKey>>
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
 * 「对齐」= 幂等的「确保这台设备有一把 Key」（#596 的老名字，实现已并入 {@link ensureManagedKey}）。
 *
 * 语义（三条都不许变，变了就是 #596 第 1/3 条事故的形状）：
 *  - **不 rotate**：对齐不是「换一把」。用户手上那把 Key 不许因为一次对齐就作废；
 *  - 服务端没有 → 顺手下发一把（首次启动的正常路径）；服务端有 → 直接沿用那一把（不会长出新 Key）；
 *  - 落不落盘由调用方比 `key` 与本机 `getApiKey()` 后决定：只要不一样就**必须**覆盖本地
 *    —— 否则就是我们一直在修的「界面显示旧尾号、请求用旧 Key」。
 *
 * #803 起它多带了两件事（都来自 `ensureManagedKey`）：先 `GET /api/v1/keys` 查重（不是靠服务端
 * create 去重）、失败自动重试一次。名字保留，是因为 `App` / 账号页 / 发送前拦截那三处叫的就是它。
 */
export const syncManagedKey = (
  source: ManagedKeySource,
  options: { deviceId: string; refresh?: () => Promise<ManagedKeyRefreshOutcome> }
): Promise<ManagedKeyEnsureResult> => ensureManagedKey(source, options)

// ---------------------------------------------------------------- 「确保有 Key」的完整流程（#803）

/**
 * ## 为什么还要在上面这些之上再加一层（#803）
 *
 * #596/#717 那一套只回答了「怎么领」（按设备固定名 create，服务端按 name 去重），
 * 但没有回答「**什么时候**领、领不到怎么办」。staging 上抓到的两种真实失败：
 *
 *  1. 注册成功了，`POST /auth/register 200` 之后**一次 `/api/v1/keys` 都没有** ——
 *     真正在跑的那条对齐挂在「启动 + 渠道是 ours + 已登录」这个组合上，
 *     而「先未登录进 App、再注册」时 `signedIn` 从那一刻起**没变过**，effect 不会重跑；
 *  2. 另有一轮 `GET /keys` / `profile` / `auth/refresh` / `POST /keys` **全 401** ——
 *     拿的是上一个账号的旧 token：建 Key 那次用的凭据已经作废，而注册完成时**没有再来一遍**。
 *
 * 所以这一层只做三件事，都写在返回值和日志里，不静默：
 *  - **先查重**：`GET /api/v1/keys?page=1&page_size=20&search=app-<设备前缀>`，命中同名就直接用它
 *    （#803 第 2 条：不重复创建 —— 上一次超时到底成没成，这一查就有答案）；
 *  - 没有才 `POST /api/v1/keys`，`name` 沿用 {@link managedKeyName}，**不传 `group_id`**
 *    （#803 第 3 条：分组由服务端按账号定，客户端指定会把 Key 建到错的分组里）；
 *  - **失败自动重试一次**（上限 {@link MANAGED_KEY_MAX_ATTEMPTS} = 2 次尝试，绝不循环）；
 *    401 这种「凭据不认」的失败，重试前**必须先换凭据**，换不到就停在原地 ——
 *    拿旧 token 再打一次，就是上面第 2 条那一轮 401 的复现条件。
 *
 * 纯逻辑：不发请求、不读存储、不 import 身份层（换凭据的能力由调用方注入 `refresh`），
 * 所以「三种失败各重试一次」「401 必须先刷新」都能在 Node 单测里逐格跑。
 */

/** 一次尝试失败的性质（#803 第 4 条把这三类都算「没拿到」） */
export type ManagedKeyFailureKind =
  /** 超时 / 连不上 / 平台不支持：`status === 0`（与 `ConsumeRawResponse.status` 同一口径） */
  | 'transport'
  /** 非 2xx（含信封不合法） */
  | 'http'
  /** 回了 2xx，但响应里**没有 Key 值** —— 拿不到能用的 Key 就是失败，不许当成功 */
  | 'empty'

/** 失败的细节：进日志、也进界面（界面只取 `kind` / `status` 决定说哪句话） */
export type ManagedKeyFailure = {
  kind: ManagedKeyFailureKind
  /** HTTP 状态码；传输层失败为 0 */
  status: number
  /** 服务端给的码（`UNAUTHORIZED` / `HTTP_500` / `TIMEOUT` …）；没有就是空串 */
  code: string
  /** 失败发生在哪一步，排查用 */
  step: 'list' | 'create'
  /** 一句可读原因（**不含 Key 与 token 原文**，与 #484 §7 同一条红线） */
  detail: string
}

/**
 * 成功：`created === false` 表示查重命中、「直接沿用了服务端那一把」，这次没有 POST
 * （`key` 就是列表里那把的**完整明文**，调用方必须落盘并生效 —— #812）
 */
export type ManagedKeyEnsureSuccess = {
  ok: true
  key: string
  id: number
  name: string
  created: boolean
  /** 实际用了几次尝试（1 = 一次就成；2 = 重试过一次） */
  attempts: number
}

/** 失败：`failures` 是每次尝试的失败（1~2 条），最后一条就是界面要显示的那条 */
export type ManagedKeyEnsureFailure = {
  ok: false
  failures: ManagedKeyFailure[]
  attempts: number
  /**
   * 为什么停在这里：
   *  - `attempts-exhausted`：重试那一次也用完了（#803 第 5 条：交给界面提示 + 重试按钮）
   *  - `refresh-failed`   ：401 之后没换成新凭据（会话失效 / 网络）→ **不许**拿旧 token 再试
   */
  stop: 'attempts-exhausted' | 'refresh-failed'
  /** 这次是否真的换到过新凭据（只有 401 分支会变成 true） */
  refreshed: boolean
}

export type ManagedKeyEnsureResult = ManagedKeyEnsureSuccess | ManagedKeyEnsureFailure

/**
 * 自动重试上限：**首次 + 一次重试**（#803 第 9 条「只自动重试一次，不许无限循环」）。
 *
 * 写成常量而不是散在循环条件里：这条上限是验收项，用例直接 import 它断言，
 * 将来谁想改成 3 次必须同时改用例，改不动就是没读见这行注释。
 */
export const MANAGED_KEY_MAX_ATTEMPTS = 2

/** 换凭据的结局（与 `auth/store.ts` 的 `SessionRefreshOutcome` 同形；本层不 import 身份层） */
export type ManagedKeyRefreshOutcome = 'refreshed' | 'expired' | 'retryable'

/**
 * 「先查重」那一次查询（#803 第 2 条）：`GET /api/v1/keys?page=1&page_size=20&search=app-<设备前缀>`。
 *
 * 入参是**已经算好的 Key 名**（`managedKeyName(deviceId)`），不是设备码 —— 这里要是再调一次
 * `managedKeyName()`，名字会变成 `app-app-…`（同一个换算做两遍），查重就永远查不到。
 *
 * `search` 用设备固定名而不是账号名或空串：设备名是**可判定的**（同名 = 同一台机器上次领的那把），
 * 宽泛搜索会把别的设备的 Key 也捞进来，而「按名字命中就直接沿用」的前提是命中项真的属于这台设备。
 */
export const managedKeyLookupQuery = (
  keyName: string
): { page: number; pageSize: number; search: string } => ({
  page: 1,
  pageSize: 20,
  search: keyName,
})

/**
 * 从查重结果里挑出「这台设备**该用**的那一把」（#812）。
 *
 * 为什么要挑，而不是 `find(名字相同)`：服务端**允许同名**（`POST /keys` 没有幂等键，
 * 一次超时重发就是第二把），所以同名命中可能不止一条，而列表顺序不保证是「最近下发的那把在前」。
 * 以前取第一条，等于把「哪一把能用」交给服务端的分页顺序 —— 先撞上一条 `inactive`（换过 Key
 * 之后被 `PUT` 停用的旧那把）就会一直 401「Key 无效」，本机却以为已经领到了。判据四层：
 *
 *  1. **名字精确相等**：`search` 是模糊匹配，`app-abc-2` 会被搜到 `app-abc` 的查询里；
 *  2. **`status === 'active'` 优先**：停用的那把服务端已经不认（用它必然 401）；
 *  3. 同状态里**取最新**：`createdAt` 大者优先，缺时间戳时退回 `id` 大者（服务端自增）；
 *  4. **明文必须非空**：列表每项的 `key` 是完整明文 —— 取不到明文就等于没拿到，不许当命中。
 *
 * 返回 `undefined` = 没有可用的同名 Key（调用方据此去 `POST`）；返回项里的 `key` 已是 trim 过的明文。
 */
export const pickManagedKey = (
  items: readonly ConsumeApiKey[],
  name: string
): ConsumeApiKey | undefined => {
  const candidates = items.filter((item) => item.name === name && item.key.trim() !== '')
  if (candidates.length === 0) {
    return undefined
  }
  const recency = (item: ConsumeApiKey): number => {
    const at = item.createdAt === undefined ? Number.NaN : Date.parse(item.createdAt)
    // 时间戳缺失 / 不可解析时退回 id：两者都是「越大越新」，混用时也只用来在同类里排序
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
  }
  const active = candidates.filter((item) => item.status === 'active')
  const pool = active.length > 0 ? active : candidates
  return pool.reduce((best, item) => {
    if (recency(item) !== recency(best)) {
      return recency(item) > recency(best) ? item : best
    }
    return item.id > best.id ? item : best
  })
}

/** 服务端错误 → 失败细节（`status === 0` 一律归为 `transport`，与 http 层同一口径） */
const managedKeyFailureOf = (step: 'list' | 'create', error: Sub2ApiError): ManagedKeyFailure => ({
  kind: error.status === 0 ? 'transport' : 'http',
  status: error.status,
  code: error.code,
  step,
  detail: `${step === 'list' ? 'GET' : 'POST'} /api/v1/keys 失败：${error.code || 'UNKNOWN'}（status ${error.status}）`,
})

/** 2xx 但没有 Key 值（服务端只回了个壳）：这是失败，不是「领到了空 Key」 */
const emptyKeyFailure = (step: 'list' | 'create', status: number): ManagedKeyFailure => ({
  kind: 'empty',
  status,
  code: 'EMPTY_KEY',
  step,
  detail: `${step === 'list' ? 'GET' : 'POST'} /api/v1/keys 回了 ${status}，但响应里没有 Key 值`,
})

/** 一次尝试的结局（内部用；外面的 {@link ensureManagedKey} 负责重试与换凭据） */
type ManagedKeyAttempt =
  | { ok: true; key: string; id: number; name: string; created: boolean }
  | { ok: false; failure: ManagedKeyFailure }

/**
 * **尝试一次**「确保这台设备有一把 Key」：先查重，没有才建。
 *
 * 顺序不能换（#803 第 2/3 条）：先 `POST` 再查重没有意义 —— `POST /keys` 没有幂等键，
 * 重发一次就是多一把 Key、多一份额度入口（#484 §4.3）。
 */
const ensureOnce = async (source: ManagedKeySource, name: string): Promise<ManagedKeyAttempt> => {
  const listed = await source.keys.list(managedKeyLookupQuery(name))
  if (listed.ok) {
    // 命中的那一把**必须连明文一起取回**（#812）：列表每项的 `key` 是完整明文，
    // 少了这一步就只是「名字存在」—— 本机仍然没有能用的 Key，请求照旧 401「Key 无效」。
    // 多把同名时按 `pickManagedKey()` 的判据挑（active 优先、再取最新）。
    const hit = pickManagedKey(listed.data.items, name)
    if (hit !== undefined) {
      return { ok: true, key: hit.key.trim(), id: hit.id, name: hit.name, created: false }
    }
    // 同名命中但没有明文（`key` 为空）：这仍然是「没拿到」，不许当成功（#803 第 4 条）。
    const namedWithoutKey = listed.data.items.filter((item) => item.name === name)
    if (namedWithoutKey.length > 0) {
      return { ok: false, failure: emptyKeyFailure('list', listed.status) }
    }
  } else {
    return { ok: false, failure: managedKeyFailureOf('list', listed.error) }
  }
  // 查重确认「同名不存在」才建：body 只有 `name`（不传 group_id，见 #803 第 3 条）。
  // `dedupe: false` = 「查重这件事本层刚做过」的显式声明（#484 §4.3 要求真要第二把时必须显式说明意图）；
  // 不传就是再查一遍，一次领取会打两次同样的 GET（重试时也一样白跑）。
  const created = await source.keys.create({ name }, { dedupe: false })
  if (!created.ok) {
    return { ok: false, failure: managedKeyFailureOf('create', created.error) }
  }
  const key = created.data.key.trim()
  if (key === '') {
    return { ok: false, failure: emptyKeyFailure('create', created.status) }
  }
  return { ok: true, key, id: created.data.id, name: created.data.name, created: true }
}

/**
 * 「确保此刻手里有一把可用的 Key」：查重 → 建 → **失败自动重试一次** → 401 先换凭据。
 *
 * 三条边界，都是 #803 的验收项而不是风格：
 *  1. **只重试一次**（`MANAGED_KEY_MAX_ATTEMPTS`）：`POST /keys` 不是无副作用的读，无限重试会把
 *     额度入口污染成一片（#484 §4.3 的老教训）；
 *  2. **401 必须先换凭据**：`options.refresh` 由身份层注入（真实现是单飞的 `refreshSessionOnce`）。
 *     没注入、或换不到（`expired` / `retryable`）→ 以 `stop: 'refresh-failed'` 收场，
 *     **不拿旧 token 再打一次** —— 否则就是在重演 staging 上那一轮全 401；
 *  3. **不在这里落盘**：Key 与下发标记由调用方 `applyManagedKey()` 一次写（#596 第 3 条），
 *     这一层连 localStorage 都不 import。
 */
export const ensureManagedKey = async (
  source: ManagedKeySource,
  options: { deviceId: string; refresh?: () => Promise<ManagedKeyRefreshOutcome> }
): Promise<ManagedKeyEnsureResult> => {
  const name = managedKeyName(options.deviceId)
  const failures: ManagedKeyFailure[] = []
  let refreshed = false
  for (let attempt = 1; attempt <= MANAGED_KEY_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await ensureOnce(source, name)
    if (outcome.ok) {
      return {
        ok: true,
        key: outcome.key,
        id: outcome.id,
        name: outcome.name,
        created: outcome.created,
        attempts: attempt,
      }
    }
    failures.push(outcome.failure)
    if (attempt >= MANAGED_KEY_MAX_ATTEMPTS) {
      return { ok: false, failures, attempts: attempt, stop: 'attempts-exhausted', refreshed }
    }
    if (outcome.failure.status === 401) {
      let next: ManagedKeyRefreshOutcome = 'expired'
      if (options.refresh !== undefined) {
        try {
          next = await options.refresh()
        } catch {
          // 换凭据自己炸了 = 这次没换成（与 http 层对 `onUnauthorized` 抛异常的口径一致）
          next = 'retryable'
        }
      }
      if (next !== 'refreshed') {
        return { ok: false, failures, attempts: attempt, stop: 'refresh-failed', refreshed: false }
      }
      refreshed = true
    }
  }
  // 上限是常量 2，正常走不到这里；写着是为了任何路径都有确定返回值（不许 undefined 漏给界面）
  return { ok: false, failures, attempts: failures.length, stop: 'attempts-exhausted', refreshed }
}
