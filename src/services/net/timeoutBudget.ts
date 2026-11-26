/**
 * 运行期可读的**超时预算**（Issue #896 的 3a，母单 #894）。
 *
 * ## 为什么要有这一层
 *
 * 改前：`consume` / `pay` / `migration` 三处的超时各按自己的方式取值 ——
 * `consume` 每次调用读 `__ENDPOINTS__.consume.timeoutMs`，`pay` 直接读 `ours/api.ts` 里的
 * `OURS_TIMEOUTS` 常量，`migration` 把 `__ENDPOINTS__.migration.timeoutMs` 塞进配置对象。
 * 三处都**只能**在构建期定死：改一个数字要么重新打包产物，要么改代码。
 *
 * 而「不可靠网络」恰恰要求超时是**策略**而不是常数：同一个请求在弱网下该给的预算，
 * 与在 Wi-Fi 下不是一回事；#896 的下一步（`RequestClass` 单一策略表）还要按
 * control / data / stream 三类请求分别给 connect / firstByte / idle / total。
 * 所以先把**取值**这一环沉到运行期可读、可覆盖的地方 —— 本文件就是那个唯一的入口。
 *
 * ## 这一版**不改变任何行为**
 *
 * - 默认值仍然来自改前的来源（`config/endpoints.json` 经 `__ENDPOINTS__` 注入 / `OURS_TIMEOUTS`），
 *   一个数字都没搬、没重写、没取整：`timeoutBudget.consume('read')` 与改前逐字相等；
 * - 覆盖层默认**空**：没有调用 `setTimeoutBudgetOverlay()` 时，返回值与「直接读原来源」完全相同；
 *   这条由 `tests/unit/timeout-budget-896.test.mjs` 钉住（改前改后取到同一批数字）。
 * - 非法覆盖值（0 / 负数 / 非整数 / NaN）**一律丢弃**，并保留原值：把预算调成 0 等于「永不超时」，
 *   那是本仓库最贵的一类事故（请求永远挂着，界面永远转圈）。失败方向必须是「保守」，不是「放开」。
 *
 * ## 谁该用、谁不该用
 *
 * 只有**横向传输预算**（一次请求允许等多久）走这里。业务阈值（条数上限、字节上限、退避次数…）
 * 仍然只在 `services/limits.ts` 里 —— 那是 `check:limits` 门禁守的地盘，别混进来。
 */

/** 消费侧（面板 / 网关 / 卡密）的三档，与 `config/endpoints.json` 的 `consume.timeoutMs` 同构 */
export type ConsumeTimeoutTier = 'read' | 'write' | 'redeem'

/** 支付侧（`ours/api.ts` 的请求）的槽位，与改前的 `OURS_TIMEOUTS` 同名 */
export type PayTimeoutSlot = 'keyProbe' | 'redeem' | 'payLink'

export type TimeoutBudgetOverlay = {
  consume?: Partial<Record<ConsumeTimeoutTier, number>>
  pay?: Partial<Record<PayTimeoutSlot, number>>
  migration?: number
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** 覆盖层：默认空 = 完全走构建期来源（行为与改前逐字相同） */
let overlay: {
  consume: Partial<Record<ConsumeTimeoutTier, number>>
  pay: Partial<Record<PayTimeoutSlot, number>>
  migration?: number
} = { consume: {}, pay: {} }

/**
 * 装一层运行期覆盖（弱网模式 / 联调 / 用例）。传 `null` / `undefined` 的槽位 = 不动它。
 *
 * 写法是**合并**而不是替换：只覆盖这次想动的那几档，其余继续走原来源 ——
 * 「弱网只放宽 stream 的首字预算」这种需求不该顺带把卡密兑换的预算也改掉。
 */
export const setTimeoutBudgetOverlay = (next: TimeoutBudgetOverlay | null | undefined): void => {
  if (!next) {
    return
  }
  const consume = { ...overlay.consume }
  for (const tier of ['read', 'write', 'redeem'] as const) {
    const value = next.consume?.[tier]
    if (isPositiveInt(value)) {
      consume[tier] = value
    }
  }
  const pay = { ...overlay.pay }
  for (const slot of ['keyProbe', 'redeem', 'payLink'] as const) {
    const value = next.pay?.[slot]
    if (isPositiveInt(value)) {
      pay[slot] = value
    }
  }
  const migration = isPositiveInt(next.migration) ? next.migration : overlay.migration
  overlay = { consume, pay, ...(migration === undefined ? {} : { migration }) }
}

/** 清空覆盖层（用例收尾 / 退出弱网模式）：清完之后取值与「从没设置过」完全一致 */
export const resetTimeoutBudgetOverlay = (): void => {
  overlay = { consume: {}, pay: {} }
}

/** 当前覆盖层（只读快照，诊断 / 用例断言用；改它不影响生效值） */
export const currentTimeoutBudgetOverlay = (): Readonly<TimeoutBudgetOverlay> => ({
  consume: { ...overlay.consume },
  pay: { ...overlay.pay },
  ...(overlay.migration === undefined ? {} : { migration: overlay.migration }),
})

/** 构建期注入的那一段（`__ENDPOINTS__.consume.timeoutMs`）；非打包环境返回 undefined */
const injectedConsume = (tier: ConsumeTimeoutTier): number | undefined => {
  try {
    const injected = typeof __ENDPOINTS__ === 'undefined' ? undefined : __ENDPOINTS__
    const value = injected?.consume?.timeoutMs?.[tier]
    return isPositiveInt(value) ? value : undefined
  } catch {
    return undefined
  }
}

export const timeoutBudget = {
  /**
   * 消费侧某一档的预算（毫秒）。
   *
   * 取值顺序：运行期覆盖 → `__ENDPOINTS__.consume.timeoutMs[tier]` → 抛错。
   * **没有第三档默认值**：这里不写「读不到就给 10 秒」那种兜底 —— 缺配置就该在
   * `readConsumeEndpoints()` 那里红，而不是悄悄拿一个谁都不知道来源的数字继续跑。
   */
  consume(tier: ConsumeTimeoutTier, base?: number): number {
    const overridden = overlay.consume[tier]
    if (overridden !== undefined) {
      return overridden
    }
    // `base` 由调用方给（通常是它自己那份 `endpoints.timeoutMs`）：**每次请求都重读一次**，
    // 于是运行期改预算对「已经创建好的 http 实例」立刻生效 —— 不必重建实例、更不必重新打包。
    if (base !== undefined) {
      return base
    }
    const injected = injectedConsume(tier)
    if (injected === undefined) {
      throw new Error(
        `消费侧超时缺配置：__ENDPOINTS__.consume.timeoutMs.${tier}（唯一来源 config/endpoints.json，#484 §6.1）`
      )
    }
    return injected
  },

  /** 支付侧某个槽位的预算：运行期覆盖 → 改前那个常量（作为 `base` 传进来，避免两处各写一份数字） */
  pay(slot: PayTimeoutSlot, base: number): number {
    return overlay.pay[slot] ?? base
  },

  /** 迁移那一次调用的预算：运行期覆盖 → 配置里的 `migration.timeoutMs` */
  migration(base: number): number {
    return overlay.migration ?? base
  },
} as const
