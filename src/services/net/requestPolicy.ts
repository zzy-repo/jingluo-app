/**
 * **唯一策略源**：一类请求「允许等多久」与「等不到之后怎么办」都在这一个文件里。
 *
 * 本文件是 Issue #896 的 3a + 3b + 3c-1 合并之后的形态（母单 #894）。
 *
 * ## 合并前是什么样（为什么必须合）
 *
 * 3a 建了 `net/timeoutBudget.ts`，回答「一条请求允许等多久」，键是**传输槽位**
 * （`consume.read` / `pay.redeem` / `migration` …）；
 * 3b 建了本文件的策略表，回答「等不到之后怎么办」，键是**请求语义类**
 * （`control` / `data` / `stream`）。
 *
 * 两个模块各自都说得通，合在一起却断了一条链：**没有任何地方能回答「这个槽位属于哪个类」**。
 * 于是同一件事又有两套字段、两套默认值、两套覆盖层：
 *
 *  - `stream` 类的 connect 预算是 `LIMITS.requestTimeouts.connectMs`（60s）；
 *  - `consume.read` 这档的预算是 `config/endpoints.json` 里的 `10s`；
 *  - 两者都被叫作「超时」，都能被调用方拿去用，但它们**不是同一个东西的两面，是两家各自为政的表**；
 *  - 想知道「`consume.redeem` 能不能自动重发」，只能去读调用点的 if —— 那正是 #896 立项要消灭的形态。
 *
 * 合并后的形状：**一张类表 + 一张槽位表**，槽位表只声明「我属于哪个类」，
 * 不写任何数字；类表是 connect / firstByte / idle / total / retry / backoff / idempotent 的
 * 唯一出处。槽位自己的「整条请求预算」仍然来自配置（`config/endpoints.json` / `OURS_TIMEOUTS`），
 * 但它的**重试语义**、**阶段预算**、**覆盖层**全部来自类表 —— 两条链路读到的是同一行。
 *
 * ## 三个类（按语义分，不按接口分）
 *
 *  - `control`：有**副作用且不可撤销**的控制类（卡密兑换、创建 Key、登录 / 注册、扣费）。
 *    失败了要**人**决定要不要再来一次 —— 自动重发可能兑换两次、建两把 Key。
 *  - `data`：**幂等**的数据请求（上传补传、自动标题、设置 / 公告 / 额度查询、导入下载）。
 *    重发最多多花一点流量，不会多扣一次钱。
 *  - `stream`：**流式生成**。重发的前提是「用户还什么都没看到」，否则会答两遍、重复计费。
 *
 * ## 429：唯一口径
 *
 * **429 = 可重试（临时）**（判据在 `net/failureKind.ts`）。两个必须一起写死的边界：
 *  1. 上游用 429 / 400 表达**额度用完**时不是限流，那一档归 `api/errors` 的 `insufficientBalance`（终态）
 *     —— 调用方必须在问本表**之前**判掉额度；
 *  2. 服务端给了 `Retry-After` 就按它退避（`backoffOf` 的 `retryAfterMs` 优先）。
 *
 * ## 谁该用、谁不该用
 *
 * 只有**横向传输预算**（一次请求允许等多久）与**重试语义**走这里。
 * 业务阈值（条数上限、字节上限、附件大小…）仍然只在 `services/limits.ts` 里 ——
 * 那是 `check:limits` 门禁守的地盘。本文件的毫秒值**全部指向 `LIMITS`**，不新写数字。
 */

import { retryableFailure, type RequestFailureKind } from './failureKind.js'
import { LIMITS } from '../limits.js'

/** 请求语义分类（不是接口分类）：`control` 有不可撤销的副作用，`data` 幂等，`stream` 是生成流 */
export const REQUEST_CLASSES = ['control', 'data', 'stream'] as const

export type RequestClass = (typeof REQUEST_CLASSES)[number]

/**
 * 一类请求的完整策略。
 *
 * 字段名刻意用**短名**（`connect` 而不是 `connectMs`）：这张表要在一行里读得下，
 * 单位由类型注释与 `LIMITS` 的命名（`connectMs`）兜住，不在表里重复 9 次 `Ms`。
 */
export type RequestPolicy = {
  /** 建连预算（含 DNS / TCP / TLS）：这一段还没有「服务端在想」的成分，最该短 */
  connect: number
  /** 响应头 → 首个字节 / 首个 SSE 事件；`0` = 这一类不单独计这一段 */
  firstByte: number
  /** 相邻两次数据之间（流式专用）；`0` = 不适用 */
  idle: number
  /** 整条请求的上限；`0` = 不设（由各段预算兜底，不叠加第二个总超时） */
  total: number
  /** 自动重发上限（**不含**首发）；`0` = 一次都不自动发 */
  retry: number
  /** 退避基数（毫秒）：第 n 次重发等 `backoff × backoffFactor^n` */
  backoff: number
  backoffFactor: number
  /** 这一类请求重发是否安全（幂等）。false 的类**永不**自动重发，`retryable` 只给界面用 */
  idempotent: boolean
  /** 重发前是否要求「用户还什么都没看到」（流式：出过字就不许重发） */
  requiresNoContent: boolean
  /**
   * `stream` 专属的**静默补试档**；其它类为 `null`。
   *
   * 它和上面那组「看得见的重试」是两档不同的事：`retry` 那是界面会说「正在第 N 次重试（共 2 次）」
   * 的档，这一档是「用户一个字都没看到时悄悄再试，成了就当无事发生」。两档共用一行，
   * 是为了让「`stream` 一共有几种补试、各自几次、各自什么预算」在一个地方读得完。
   */
  silent: SilentRetryPolicy | null
}

/** 静默补试档（只有 `stream` 有）：次数、总预算、半截内容那一档的阈值 */
export type SilentRetryPolicy = {
  /** 首字节前的静默补试上限 */
  attempts: number
  /** 静默补试的总时长预算（毫秒）：超了立刻停，次数没用完也不许再发 */
  budgetMs: number
  /** 首字节后、内容 `< partialMaxChars` 时的补试上限 */
  partialAttempts: number
  /** 「内容已经够多就不补试」的阈值（严格小于） */
  partialMaxChars: number
  /** 第 n 次补试前的等待（毫秒序列，用完就封顶在末项，绝不指数爆炸） */
  delaysMs: readonly number[]
}

/**
 * 退避曲线的共享部分：`1s / 2s / 4s / 8s`（`LIMITS.retryBaseDelayMs` 的 1/2/4/8 倍）。
 *
 * 为什么不是 `base × 2^attempt` 一直翻：5 次补试若一路翻倍，末次要等 16s、总退避 31s，
 * 而 60s 预算一撞就白等；反过来固定 1s 又会在上游短暂抖动时把 5 次全烧完。
 * 1→2→4→8（然后 8）是「前两次快速补救、后面放慢」的折中。序列从基数算出，不是新数字。
 */
const SILENT_DELAYS_MS = [1, 2, 4, 8].map((n) => LIMITS.retryBaseDelayMs * n) as readonly number[]

/** 三个类共用的建连预算（一处定义，三行引用 —— 合并前是同一行字面量抄三遍） */
const CONNECT = LIMITS.requestTimeouts.connectMs
/** 共用的退避基数与倍数 */
const BACKOFF = LIMITS.retryBaseDelayMs
const BACKOFF_FACTOR = 2

/**
 * 单一策略表（**唯一判定处**）。
 *
 * `0` 一律当「这一类没有这一段预算」，不是「0 毫秒超时」—— 取值为 0 的段不参与计时。
 */
export const REQUEST_POLICY: Record<RequestClass, RequestPolicy> = {
  /**
   * 控制类：卡密兑换 / 创建 Key / 登录 / 扣费 / 导入落库。
   *
   * `retry: 0` 是**产品决定**，不是保守：#484 §4.3 的教训是「卡密重复兑换、Key 重复创建
   * 都是重试重出来的」。所以这一类只回答「这次失败值不值得让用户再点一次」（`retryable`），
   * 绝不自己发第二枪。`idempotent: false` 把这条决定写在表里，而不是散在各调用点的 if 里。
   */
  control: {
    connect: CONNECT,
    firstByte: 0,
    idle: 0,
    total: 0,
    retry: 0,
    backoff: BACKOFF,
    backoffFactor: BACKOFF_FACTOR,
    idempotent: false,
    requiresNoContent: false,
    silent: null,
  },
  /**
   * 数据类：上传补传 / 自动标题 / 设置与公告 / 额度查询 / 导入下载。
   *
   * 与流式共用 `streamRetryLimit`（#105 的「附件补传、断网、5xx、超时共用这一个上限」），
   * 但**没有** firstByte / idle 这两段预算 —— 非流式请求读到的是一次完整响应体。
   */
  data: {
    connect: CONNECT,
    firstByte: 0,
    idle: 0,
    total: 0,
    retry: LIMITS.streamRetryLimit,
    backoff: BACKOFF,
    backoffFactor: BACKOFF_FACTOR,
    idempotent: true,
    requiresNoContent: true,
    silent: null,
  },
  /**
   * 流式类：三段预算（连接 / 首字 / 空闲）各管一段（#568），重发上限沿用 #105 的通用档，
   * 另有一档**静默补试**（`silent`）在「用户一个字都没看到」时用。
   *
   * `requiresNoContent: true` 是硬纪律：已经吐出字再重发 = 答两遍 + 重复计费（#105 / #150）。
   */
  stream: {
    connect: CONNECT,
    firstByte: LIMITS.requestTimeouts.firstTokenMs,
    idle: LIMITS.requestTimeouts.idleMs,
    total: 0,
    retry: LIMITS.streamRetryLimit,
    backoff: BACKOFF,
    backoffFactor: BACKOFF_FACTOR,
    idempotent: true,
    requiresNoContent: true,
    silent: {
      attempts: LIMITS.streamBreakout.silentAttempts,
      budgetMs: LIMITS.streamBreakout.silentBudgetMs,
      partialAttempts: LIMITS.streamBreakout.partialAttempts,
      partialMaxChars: LIMITS.streamBreakout.partialMaxChars,
      delaysMs: SILENT_DELAYS_MS,
    },
  },
}

// ------------------------------------------------------------------ 传输槽位（原 timeoutBudget.ts）

/**
 * 传输槽位：**同一条策略在不同传输上的落点**。
 *
 * 这里是全仓库唯一一处「槽位 → 类」的映射。它**不写任何毫秒值**：阶段预算、重试语义、
 * 覆盖层一律从 `REQUEST_POLICY[cls]` 取；槽位自己的「整条请求预算」由配置给（见
 * {@link transportBudgetOf}）。改前这份映射不存在，调用方各自「心里知道」——
 * 那就是「同一件事在四层有四种答案」的最后一条缝隙。
 */
export const TRANSPORT_SLOTS = {
  /** 面板 / 网关的只读请求（额度、卡密列表、订单） */
  'consume.read': { cls: 'data' },
  /** 面板 / 网关的写请求（提交、绑定…）：可能产生服务端状态，按不可撤销处理 */
  'consume.write': { cls: 'control' },
  /** 卡密兑换：重复兑换是 #484 §4.3 的事故形状 */
  'consume.redeem': { cls: 'control' },
  /** 「我们的渠道」Key 探测：只读，重发最多多一问 */
  'pay.keyProbe': { cls: 'data' },
  /** 支付兑换 / 下单 */
  'pay.redeem': { cls: 'control' },
  /** 取收款页地址（只读小接口），但属于支付链路，保守归 control */
  'pay.payLink': { cls: 'control' },
  /** 旧版数据迁移的那一次调用：落库，不可撤销 */
  migration: { cls: 'control' },
} as const satisfies Record<string, { cls: RequestClass }>

export type TransportSlot = keyof typeof TRANSPORT_SLOTS

/** 七个槽位的名字（顺序稳定，方便用例与诊断逐格断言） */
export const TRANSPORT_SLOT_NAMES = Object.keys(TRANSPORT_SLOTS) as readonly TransportSlot[]

// ------------------------------------------------------------------ 覆盖层（运行期可改）

/** 可以按类覆盖的四段预算（重试语义不许运行期改：那是产品决定，不是网络条件） */
export type ClassBudgetOverride = Partial<Pick<RequestPolicy, 'connect' | 'firstByte' | 'idle' | 'total'>>

export type BudgetOverlay = {
  classes?: Partial<Record<RequestClass, ClassBudgetOverride>>
  slots?: Partial<Record<TransportSlot, number>>
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/**
 * 覆盖层：默认空 = 完全走表里的值与配置里的预算（行为与改前逐字相同）。
 *
 * 只装**正整数的合法覆盖值**。把预算调成 0 等于「永不超时」—— 那是本仓库最贵的一类事故
 * （请求永远挂着、界面永远转圈），所以非法值一律丢弃并保留原值：失败方向必须是「保守」，不是「放开」。
 */
let overlay: { classes: Partial<Record<RequestClass, ClassBudgetOverride>>; slots: Partial<Record<TransportSlot, number>> } =
  { classes: {}, slots: {} }

/**
 * 装一层运行期覆盖（弱网模式 / 联调 / 用例）。传 `null` / `undefined` 的槽位 = 不动它。
 *
 * 写法是**合并**而不是替换：只覆盖这次想动的那几档，其余继续走原来源 ——
 * 「弱网只放宽 stream 的首字预算」不该顺带把卡密兑换的预算也改掉。
 */
export const setBudgetOverlay = (next: BudgetOverlay | null | undefined): void => {
  if (!next) {
    return
  }
  const classes = { ...overlay.classes }
  for (const cls of REQUEST_CLASSES) {
    const patch = next.classes?.[cls]
    if (!patch) {
      continue
    }
    const merged = { ...classes[cls] }
    for (const field of ['connect', 'firstByte', 'idle', 'total'] as const) {
      const value = patch[field]
      if (isPositiveInt(value)) {
        merged[field] = value
      }
    }
    if (Object.keys(merged).length > 0) {
      classes[cls] = merged
    }
  }
  const slots = { ...overlay.slots }
  for (const slot of TRANSPORT_SLOT_NAMES) {
    const value = next.slots?.[slot]
    if (isPositiveInt(value)) {
      slots[slot] = value
    }
  }
  overlay = { classes, slots }
}

/** 清空覆盖层（用例收尾 / 退出弱网模式）：清完之后取值与「从没设置过」完全一致 */
export const resetBudgetOverlay = (): void => {
  overlay = { classes: {}, slots: {} }
}

/** 当前覆盖层（只读快照，诊断 / 用例断言用；改它不影响生效值） */
export const currentBudgetOverlay = (): Readonly<BudgetOverlay> => ({
  classes: { ...overlay.classes },
  slots: { ...overlay.slots },
})

// ------------------------------------------------------------------ 取值

/**
 * 取某一类的策略（只读）。覆盖层的 `classes` 部分在这里**合并**进来，
 * 所以「两条链路读到同一行」不靠调用方自觉。
 */
export const requestPolicyOf = (cls: RequestClass): RequestPolicy => {
  const base = REQUEST_POLICY[cls]
  const patch = overlay.classes[cls]
  return patch === undefined ? base : { ...base, ...patch }
}

/**
 * 某一个传输槽位的策略：**类 + 该类此刻生效的整行策略**。
 *
 * 这是「槽位属于哪个类」的唯一入口 —— 想知道 `consume.redeem` 能不能自动重发，
 * 问这里，别在调用点写 `if (kind === 'redeem')`。
 */
export const transportPolicyOf = (
  slot: TransportSlot
): { slot: TransportSlot; cls: RequestClass; policy: RequestPolicy } => {
  const cls = TRANSPORT_SLOTS[slot].cls
  return { slot, cls, policy: requestPolicyOf(cls) }
}

/** 构建期注入的那一段（`__ENDPOINTS__.consume.timeoutMs` 等）；非打包环境返回 undefined */
const injectedSlot = (slot: TransportSlot): number | undefined => {
  try {
    const injected = typeof __ENDPOINTS__ === 'undefined' ? undefined : __ENDPOINTS__
    if (slot.startsWith('consume.')) {
      const tier = slot.slice('consume.'.length) as 'read' | 'write' | 'redeem'
      const value = injected?.consume?.timeoutMs?.[tier]
      return isPositiveInt(value) ? value : undefined
    }
    if (slot === 'migration') {
      const value = injected?.migration?.timeoutMs
      return isPositiveInt(value) ? value : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 某一个槽位的**整条请求预算**（毫秒）。取值链只有一条，从窄到宽：
 *
 *  1. 运行期覆盖（`setBudgetOverlay({ slots })`）；
 *  2. 调用方给的 `base`（通常是它自己那份配置：`endpoints.timeoutMs[tier]` / `OURS_TIMEOUTS[slot]`）；
 *     每次请求都重读一次，于是运行期改预算对「已经创建好的 http 实例」立刻生效；
 *  3. 构建期注入的 `__ENDPOINTS__` 那一段；
 *  4. 该类策略的 `total`（`> 0` 时）；
 *  5. 都没有 → **抛错**。
 *
 * **没有兜底默认值**：这里不写「读不到就给 10 秒」—— 缺配置就该在 `readConsumeEndpoints()`
 * 那里红，而不是悄悄拿一个谁都不知道来源的数字继续跑。第 4 步存在的意义是
 * 「类表里显式给了 total 的类」不必再去配置里重复一遍，而不是给缺配置擦屁股。
 */
export const transportBudgetOf = (slot: TransportSlot, base?: number): number => {
  const overridden = overlay.slots[slot]
  if (overridden !== undefined) {
    return overridden
  }
  if (base !== undefined) {
    return base
  }
  const injected = injectedSlot(slot)
  if (injected !== undefined) {
    return injected
  }
  const { total } = transportPolicyOf(slot).policy
  if (isPositiveInt(total)) {
    return total
  }
  throw new Error(
    `传输预算缺配置：${slot}（${TRANSPORT_SLOTS[slot].cls} 类的 total 为 0，需要 config/endpoints.json 或调用方给 base，#484 §6.1）`
  )
}

/**
 * 失败分类与「值不值得再试」的判据不在这里：它们在 `net/failureKind.ts`（零依赖纯模块）。
 * 本文件只回答「哪一类请求、多少毫秒、几次、怎么退避」。
 */
export {
  RATE_LIMIT_RETRYABLE,
  failureOfStatus,
  retryableFailure,
  type RequestFailureKind,
} from './failureKind.js'

/**
 * 这一类在这条失败上「能不能自动再发一次」——**次数与内容两条判据一起给**。
 *
 * 调用方只需要把「已经试过几次」「用户看到内容了吗」交给它，不必各自去比 `attempt < 上限`
 * 或各写一遍 `receivedContent && ...`。
 */
export const canAutoRetry = (input: {
  cls: RequestClass
  failure: RequestFailureKind
  /** 已经重试过几次（首发 = 0） */
  attempt: number
  /** 这一轮是否已经向用户输出过内容（流式专用；非流式传 false） */
  receivedContent?: boolean
}): boolean => {
  const policy = requestPolicyOf(input.cls)
  if (!policy.idempotent) {
    return false
  }
  if (!retryableFailure(input.failure)) {
    return false
  }
  if (policy.requiresNoContent && input.receivedContent === true) {
    return false
  }
  return input.attempt < policy.retry
}

/**
 * 重发前的等待（毫秒）。
 *
 * `retryAfterMs` 优先（服务端说了算，429 的 `Retry-After` 就从这里进来）；
 * 没给就按本类的 `backoff × backoffFactor^attempt` 指数退避。
 * **不在这里加随机抖动**：抖动的形状各调用点不同（设置页要 300~800ms 带抖动、聊天要可中断的 sleep），
 * 那是「怎么等」而不是「等多久」，混进来会让两边都不好用。
 */
export const backoffOf = (
  cls: RequestClass,
  attempt: number,
  retryAfterMs?: number | null
): number => {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.round(retryAfterMs)
  }
  const { backoff, backoffFactor } = requestPolicyOf(cls)
  return backoff * backoffFactor ** Math.max(0, Math.round(attempt))
}

/**
 * 静默补试档（只有 `stream` 有）。非 stream 类调用 = 抛错（不是 `null`）：
 * 那不是「今天没有」，是「用错了类」—— 让它当场红，比返回一个静默的空值安全。
 */
export const silentRetryOf = (cls: RequestClass): SilentRetryPolicy => {
  const silent = requestPolicyOf(cls).silent
  if (silent === null) {
    throw new Error(`静默补试档只属于 stream 类，${cls} 没有这一档（#896）`)
  }
  return silent
}

/**
 * 第 `retried` 次静默补试（0 起）该等多久：序列用完就**封顶**在末项，绝不指数爆炸。
 */
export const silentRetryDelayMs = (retried: number): number => {
  const delays = silentRetryOf('stream').delaysMs
  const index = Number.isFinite(retried) ? Math.max(0, Math.trunc(retried)) : 0
  return delays[Math.min(index, delays.length - 1)] as number
}
