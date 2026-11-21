/**
 * 更新策略（Issue #517）：服务端在清单条目上下发「这次更新是不是必须装」。
 *
 * 本文件是**唯一**的判定实现，三个纯函数，无 IO、无 React、无构建期注入：
 *   · `parseUpdatePolicy`     —— 把服务端下发的任意脏数据收窄成一个完整策略（永不抛）；
 *   · `resolveUpdatePolicy`   —— 判定顺序（见下）；
 *   · `resolveUpdatePrompt`   —— 在判定结果上叠一层 snooze（「稍后提醒」期内不弹）。
 *
 * ## 服务端可下发的形状（写在清单条目的 `updatePolicy` 上，也接受 `policy` 别名）
 *
 * ```jsonc
 * {
 *   "updatePolicy": {
 *     "mode": "normal",              // normal | soft | forced
 *     "minSupportedVersionCode": 0,  // 低于此值 → 强制更新（服务端用它做「必须升级」）
 *     "snoozeHours": 24,             // soft 模式的默认暂缓时长
 *     "reason": "…",                 // forced 时给用户看的原因（可选）
 *     "expiresAt": "2026-12-31T23:59:59+08:00" // 策略过期即整体失效（可选，见下）
 *   }
 * }
 * ```
 *
 * ## 判定顺序（`resolveUpdatePolicy`，表驱动用例见 `tests/unit/update-policy-517.test.mjs`）
 *
 * 0. `expiresAt` 已过期 → **normal**（#517 §四.3）。陈旧缓存 / 误配不许把用户永久锁在强制弹窗里，
 *    所以这是**最外层**的安全阀门：连 `minSupportedVersionCode` 一起失效。服务端真想让老版本强制升级，
 *    重新下发一条未过期的策略即可。
 * 1. `versionCode < minSupportedVersionCode` → **forced**，**优先于** `mode`
 *    （服务端只要抬这个下限，就不必同时改 mode；「必须升级」只有一个开关）。
 * 2. 否则按 `mode`（normal / soft / forced）。
 * 3. `mode` 缺失 / 非法 / 整份策略不像对象 → **normal**。
 *    **绝不允许**因为服务端数据异常就把用户锁死在强制弹窗里 —— 判定失败一律站用户这边。
 *
 * 与 #517 正文草稿的差异（**按落地口径为准**）：草稿写的是「`mode:hard` 也必须有 `minVersionCode`
 * 且本地确实更低才算强制」。落地口径改为「mode 是服务端的明确表态，`minSupportedVersionCode`
 * 是另一条独立的下限」。两条都不会让脏数据把用户锁死（那是第 0/3 条在管），而前者会让
 * 「只想强调一下、但本地版本号刚好够新」的策略静默失效，反而更难解释。
 */

/** 三档策略。`forced` = 必须更新才能继续使用 */
export const UPDATE_POLICY_MODES = ['normal', 'soft', 'forced'] as const
export type UpdatePolicyMode = (typeof UPDATE_POLICY_MODES)[number]

/** soft 未下发 `snoozeHours` 时的默认暂缓时长（小时） */
export const DEFAULT_SNOOZE_HOURS = 24
/**
 * 暂缓时长的上下限：0 会让「稍后提醒」变成每开一次弹一次（等于没有这个按钮），
 * 30 天以上又等于永久静默 —— 两个极端都不是「稍后提醒」，所以夹在 [1, 720] 小时。
 */
export const MIN_SNOOZE_HOURS = 1
export const MAX_SNOOZE_HOURS = 720
const MS_PER_HOUR = 60 * 60 * 1000

export interface UpdatePolicy {
  mode: UpdatePolicyMode
  /** 低于它一律强制；0 = 没设下限 */
  minSupportedVersionCode: number
  /** soft 的暂缓时长（小时），已夹到 [MIN_SNOOZE_HOURS, MAX_SNOOZE_HOURS] */
  snoozeHours: number
  /** forced 时给用户看的原因 */
  reason?: string
  /** 策略过期时刻（毫秒时间戳）；到点后整条策略失效 */
  expiresAt?: number
}

/** 缺省策略：普通更新。任何「读不出策略」的情形都落到这里 */
export const DEFAULT_UPDATE_POLICY: UpdatePolicy = Object.freeze({
  mode: 'normal' as UpdatePolicyMode,
  minSupportedVersionCode: 0,
  snoozeHours: DEFAULT_SNOOZE_HOURS,
})

/** 判定依据：界面 / 日志据此说清「为什么强制」，也方便用例断言走的是哪一条 */
export type UpdatePolicyBasis =
  /** 服务端下发的 mode 生效 */
  | 'mode'
  /** 被 `minSupportedVersionCode` 顶成强制（优先于 mode） */
  | 'below-minimum'
  /** 策略过期，整体失效 */
  | 'expired'
  /** 没下发 / 非法，回落普通更新 */
  | 'default'

export interface ResolvedUpdatePolicy extends UpdatePolicy {
  basis: UpdatePolicyBasis
  /** 服务端原文里的 mode（可能非法，只用于排查，不参与任何展示决策） */
  declaredMode?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 服务端可能的 mode 写法 → 三档。**别名是容错，不是新协议**：
 * 服务端契约草稿用的是 `none|soft|hard`，落地字段是 `normal|soft|forced`，
 * 两种都得认，否则「上线了但 App 读不懂」就会静默退化成普通更新（用户永远收不到强制提示）。
 */
const MODE_ALIASES = new Map<string, UpdatePolicyMode>([
  ['normal', 'normal'],
  ['none', 'normal'],
  ['off', 'normal'],
  ['soft', 'soft'],
  ['forced', 'forced'],
  ['hard', 'forced'],
  ['force', 'forced'],
])

/**
 * 只在能确认是合法枚举时才返回，其余（含大写、未知词、非字符串）一律 undefined。
 * 用 `Map` 而不是对象 + `Object.hasOwn`：后者是 ES2022（Chrome 93+），老内核要靠入口 polyfill 兜；
 * 这个文件是纯判定、会被 L0 直接 import，不背那层依赖更省事。
 */
const modeOf = (value: unknown): UpdatePolicyMode | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  return MODE_ALIASES.get(value.trim().toLowerCase())
}

/** 正整数才认；其余（负数 / 小数 / 字符串 / NaN）一律 0 = 没设下限 */
const versionCodeOf = (value: unknown): number => {
  const code = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? code : 0
}

/** 暂缓时长：认数字与数字字符串，夹到 [1, 720]；非法 → 默认 24 */
const snoozeHoursOf = (value: unknown): number => {
  const hours = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    return DEFAULT_SNOOZE_HOURS
  }
  return Math.min(MAX_SNOOZE_HOURS, Math.max(MIN_SNOOZE_HOURS, Math.round(hours)))
}

/** 过期时刻：ISO 字符串或毫秒时间戳；解析不出来就当没下发（不因此强制，也不因此过期） */
const expiresAtOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : at
  }
  return undefined
}

/** 原因文案：只做长度与类型收窄（会不会显示由界面决定），不修剪内容 */
const reasonOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 500 ? value : undefined

/** 把条目上的策略取出来：`updatePolicy` 是落地字段，`policy` 是契约草稿里的写法 */
const policySource = (raw: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(raw)) {
    return undefined
  }
  if (isRecord(raw.updatePolicy)) {
    return raw.updatePolicy
  }
  return isRecord(raw.policy) ? raw.policy : undefined
}

interface Inspection {
  policy: UpdatePolicy
  /** 服务端原文 mode（保留原样，只用于排查） */
  declaredMode?: string
  /** 原文 mode 是否被识别成三档之一 */
  declaredKnown: boolean
}

/** `parseUpdatePolicy` 与 `resolveUpdatePolicy` 共用的收窄过程（只有一份，避免两处口径漂移） */
const inspect = (raw: unknown): Inspection => {
  // 传入的可能是「整条清单记录」，也可能已经是策略对象本身 —— 两种都认
  const source = isRecord(raw) && policySource(raw) !== undefined ? policySource(raw) : raw
  if (!isRecord(source)) {
    return { policy: { ...DEFAULT_UPDATE_POLICY }, declaredKnown: false }
  }
  const declaredMode = typeof source.mode === 'string' ? source.mode : undefined
  const mode = modeOf(source.mode)
  const minSupportedVersionCode = versionCodeOf(
    source.minSupportedVersionCode ?? source.minVersionCode
  )
  const snoozeHours = snoozeHoursOf(source.snoozeHours)
  const reason = reasonOf(source.reason)
  const expiresAt = expiresAtOf(source.expiresAt)
  return {
    policy: {
      mode: mode ?? DEFAULT_UPDATE_POLICY.mode,
      minSupportedVersionCode,
      snoozeHours,
      ...(reason === undefined ? {} : { reason }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    ...(declaredMode === undefined ? {} : { declaredMode }),
    declaredKnown: mode !== undefined,
  }
}

/**
 * 收窄成一条完整策略。**永不抛**：单测、清单解析、缓存回读都直接用它。
 * 缺字段 → 默认值；非法字段 → 丢掉（回落默认），不做「整条拒收」——
 * 一条脏策略只该让「强制」失效，不该让整个更新检查失败。
 */
export const parseUpdatePolicy = (raw: unknown): UpdatePolicy => inspect(raw).policy

/**
 * 判定这次的更新该怎么提示（判定顺序见文件头）。`now` 可注入，单测不靠 sleep。
 *
 * `currentVersionCode` 非法（0 / 负数 / 非整数 / 构建期没注入）时**不做下限判断** ——
 * 本机版本号读不出来不是「你必须升级」的证据；此时只剩 `mode` 与过期两条规则。
 */
export const resolveUpdatePolicy = (
  raw: unknown,
  currentVersionCode: number,
  now: number = Date.now()
): ResolvedUpdatePolicy => {
  const { policy, declaredMode, declaredKnown } = inspect(raw)
  // 0) 过期即整体失效（#517 §四.3）
  if (policy.expiresAt !== undefined && now >= policy.expiresAt) {
    return {
      ...policy,
      mode: 'normal',
      basis: 'expired',
      ...(declaredMode === undefined ? {} : { declaredMode }),
    }
  }
  // 1) 最低支持版本优先于 mode
  const current = Number.isSafeInteger(currentVersionCode) ? currentVersionCode : 0
  if (
    policy.minSupportedVersionCode > 0 &&
    current > 0 &&
    current < policy.minSupportedVersionCode
  ) {
    return {
      ...policy,
      mode: 'forced',
      basis: 'below-minimum',
      ...(declaredMode === undefined ? {} : { declaredMode }),
    }
  }
  // 2) 按 mode；3) 没认出来就是 default（= normal，不会强制）
  return {
    ...policy,
    basis: declaredKnown ? 'mode' : 'default',
    ...(declaredMode === undefined ? {} : { declaredMode }),
  }
}

/** 「稍后提醒」的到期时刻：`now + snoozeHours` 小时。夹取已在 `parseUpdatePolicy` 里做过 */
export const snoozeDeadline = (now: number, snoozeHours: number): number =>
  now + snoozeHoursOf(snoozeHours) * MS_PER_HOUR

/**
 * 是否还在 snooze 期内。
 *
 * 判定口径只有一条：`snoozeUntil > now`。几个必须挡住的脏值：
 * 0 / 负数（从没暂缓过）、NaN、非数字（localStorage 里被写成字符串 '"abc"'）——
 * 全部按「没暂缓」处理，**宁可多弹一次，也不要因为一个坏时间戳永远不弹**。
 */
export const isSnoozed = (
  snoozeUntil: number | undefined | null,
  now: number = Date.now()
): boolean => typeof snoozeUntil === 'number' && Number.isFinite(snoozeUntil) && snoozeUntil > now

export interface UpdatePrompt {
  mode: UpdatePolicyMode
  basis: UpdatePolicyBasis
  snoozeHours: number
  reason?: string
  /** 这次检查该不该弹窗 */
  show: boolean
  /** 仍在 snooze 期内时的到期时刻（`show === false` 的原因） */
  snoozedUntil?: number
}

/**
 * 「这次检查要不要弹窗」的唯一判定：策略 + snooze。
 *
 * 只有 **soft** 会被 snooze 挡住：forced 不能有「稍后」（写不进 snooze），
 * normal 本来就随时可关（用户下次检查再看到也无所谓）。
 */
export const resolveUpdatePrompt = (input: {
  policy: unknown
  currentVersionCode: number
  /** 本地存的 snooze 到期时刻（`chat-demo:update-snooze-until`）；没有就传 0 / undefined */
  snoozedUntil?: number | null
  now?: number
}): UpdatePrompt => {
  const now = input.now ?? Date.now()
  const resolved = resolveUpdatePolicy(input.policy, input.currentVersionCode, now)
  const base = {
    mode: resolved.mode,
    basis: resolved.basis,
    snoozeHours: resolved.snoozeHours,
    ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
  }
  if (resolved.mode === 'soft' && isSnoozed(input.snoozedUntil, now)) {
    return { ...base, show: false, snoozedUntil: Number(input.snoozedUntil) }
  }
  return { ...base, show: true }
}
