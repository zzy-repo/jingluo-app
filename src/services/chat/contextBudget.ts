/**
 * 请求侧上下文预算（#122）。
 *
 * 会话越长，`toRequestMessages()` 拼出的请求体越大：几百轮的会话每轮把全部历史重发一遍，
 * 首字节时间、流量和费用都随轮次线性增长，最终撞上下文上限硬失败。
 * 这里给出一个可配置的**双闸**预算：token 估算上限 + 轮次上限，任一超限就从最旧的一轮开始成对丢弃。
 *
 * 三条约束：
 * 1. 只裁历史：系统前缀（system）由请求侧单独拼，不经过这里；本轮提问与续写前缀永远保留；
 * 2. 成对裁剪：按「提问 + 回答」整轮丢弃，不会留下没有提问的回答；
 * 3. 默认值保守：宁可少裁 —— 正常长度的会话不该被裁，只有真的长到离谱才会动手。
 *
 * #345 追加的三条（上游前缀缓存的硬要求，见 `CONTEXT_LOW_WATERMARK_RATIO`）：
 * 4. **一次性**：越线后一次裁到低水位，而不是「刚好塞满」——否则裁剪边界每轮前移一格，
 *    第一条历史消息每轮都不一样，前缀缓存从第一个 token 起全部作废（0.19 分 → 4.70 分）；
 * 5. **冻结**：裁剪边界一旦形成就记住（`readRoundAnchor` / `rememberRoundAnchor`），
 *    只要预算不变、边界那一轮还在历史里，后续轮次原样沿用 —— 不重算、不回填、不重新序列化，
 *    同一轮重发（重试 / 重新生成）拿到的请求体逐字节相同；
 * 6. **保格式**：只做整轮丢弃，绝不做空白 / 换行 / 缩进层面的改写 —— 历史正文原样透传，
 *    角色扮演等场景的排版不会被压平（一次真实事故：服务端空白归一让输出风格跟着漂）。
 */

import { LIMITS } from '../limits.js'

/** 请求侧上下文预算：token 估算上限 + 轮次上限双闸 */
export type ContextBudget = {
  /** 历史 + 系统快照 + 本轮提问的估算 token 上限 */
  maxTokens: number
  /** 最多带多少轮历史（「提问 + 回答」成对计一轮，不含本轮提问） */
  maxRounds: number
}

/** 裁剪统计：给日志 / 诊断看的「本轮裁掉了多少」 */
export type ContextTrimReport = {
  /** 进入预算判断的轮次总数（已排除不可用轮次） */
  roundsTotal: number
  roundsKept: number
  roundsDropped: number
  /** 裁剪前后估算字符量（含本轮提问与系统快照） */
  charsBefore: number
  charsAfter: number
  tokensBefore: number
  tokensAfter: number
  maxTokens: number
  maxRounds: number
  /** 触发裁剪的闸：tokens / rounds / both；没裁剪为 none */
  reason: 'none' | 'tokens' | 'rounds' | 'both'
}

/**
 * 中英混排的粗略换算：英文约 4 字符/token，中文约 1.5 字符/token，取 3 作中性估算。
 * 只用于预算裁剪的相对判断，不是计费口径。
 */
export const CHARS_PER_TOKEN = 3

/** 附件按 Files API 的 file_id 引用，正文不在请求体里；按固定字符成本估算，避免附件多的会话绕过预算 */
export const FILE_BLOCK_CHARS = 1_500

/** 单条消息的结构开销（字段名、引号、逗号），让估算贴近真实 JSON body 体积 */
export const MESSAGE_OVERHEAD_CHARS = 64

/**
 * 默认预算：120k token（约 36 万字符）且最多 200 轮历史。
 * 明显高于日常会话（几十轮、几千字符一轮），因此正常使用不会被裁；只有几百轮的老会话才会触发。
 * 可调入口：`setContextBudget()` 全局配置，或 `toRequestMessages(..., { budget })` 单次覆盖。
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: LIMITS.contextBudget.maxTokens,
  maxRounds: LIMITS.contextBudget.maxRounds,
}

const positive = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

/** 估算一段请求内容（string / content block 数组 / 消息）的字符量 */
const estimateValue = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length
  }
  if (typeof value === 'number') {
    return String(value).length
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + estimateValue(item), 0)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // 文件块（image / document）只带 file_id，正文按固定成本估
    if (record.type === 'image' || record.type === 'document') {
      return FILE_BLOCK_CHARS
    }
    const inner = Object.values(record).reduce<number>((sum, item) => sum + estimateValue(item), 0)
    return typeof record.role === 'string' ? inner + MESSAGE_OVERHEAD_CHARS : inner
  }
  return 0
}

export const estimateChars = (value: unknown): number => estimateValue(value)

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

/**
 * 低水位比例（#345）：**越过上限后一次裁到上限的这个比例**，而不是只丢一轮。
 *
 * 为什么必须这样：上游上下文缓存按「请求前缀逐字节匹配」计费。旧实现「刚好塞满上限」
 * 的窗口会让**裁剪边界随历史增长每轮前移一格** —— 每加一轮就多丢最旧的一轮，
 * 于是第一条历史消息每轮都不一样，前缀缓存从第一个 token 起全部作废，
 * 命中价 0.19 分 vs 未命中价 4.70 分（实测差 25 倍，见 #345）。
 *
 * 越线时留出一半余量（迟滞 / hysteresis），边界就只在**越线的那些轮**动一次，
 * 之后几十轮都不动 —— 前缀缓存在绝大多数轮次里命中。
 * 代价是越线那一轮多丢掉一些历史：这是「一次性裁够」换「不再每轮重算」的交易。
 */
export const CONTEXT_LOW_WATERMARK_RATIO = 0.5

/** 双闸裁剪：从最新一轮往回累积，任一闸超限就停；永远至少保留最近一轮（哪怕它自己就超预算），
 * 这样「只剩最后一轮」的情况仍然发得出去，不会因为预算过小把整段历史裁空。 */
const windowFor = (
  roundChars: number[],
  budget: ContextBudget,
  fixedChars: number
): { kept: number; chars: number; reason: ContextTrimReport['reason'] } => {
  const limitChars = budget.maxTokens * CHARS_PER_TOKEN
  let kept = 0
  let chars = fixedChars
  let tokensHit = false
  let roundsHit = false
  for (let index = roundChars.length - 1; index >= 0; index -= 1) {
    const size = roundChars[index]
    if (kept > 0) {
      if (kept >= budget.maxRounds) {
        roundsHit = true
        break
      }
      if (chars + size > limitChars) {
        tokensHit = true
        break
      }
    }
    chars += size
    kept += 1
  }
  const reason = tokensHit && roundsHit ? 'both' : tokensHit ? 'tokens' : roundsHit ? 'rounds' : 'none'
  return { kept, chars, reason }
}

/** 低水位预算：越线后一次性裁到的目标（两道闸同时按比例收紧） */
export const lowWatermarkBudget = (budget: ContextBudget): ContextBudget => ({
  maxTokens: Math.max(1, Math.floor(budget.maxTokens * CONTEXT_LOW_WATERMARK_RATIO)),
  maxRounds: Math.max(1, Math.floor(budget.maxRounds * CONTEXT_LOW_WATERMARK_RATIO)),
})

/**
 * 裁剪锚点（#345「冻结」）：记住**上一轮实际用的裁剪边界**，下一轮原样沿用。
 *
 * 为什么非要记住：只做低水位（下面 `selectRoundWindow` 的第 2 步）还不够 ——
 * 「保留能装下的最近若干轮」这个规则本身每轮都会往前挪一格（历史又长了一轮，
 * 于是最旧的一轮被挤出去），边界照样每轮变，缓存照样全废。
 * 把边界钉死之后，历史只会**在尾部增长**，同一个请求前缀就一直在，命中缓存。
 *
 * 锚点跟着会话走（`anchorKey` = 会话 id），并且只在两件事都不变时有效：
 * 预算没改、边界那一轮还在历史里（用户删/改历史后自然失效，重新算一次）。
 */
type RoundAnchor = { fromId: string; budget: string }

const anchors = new Map<string, RoundAnchor>()

/** 锚点表上限：只是缓存，条目多了按最久未用淘汰（不影响正确性，只影响退化到「重算一次」） */
const ANCHOR_LIMIT = 64

const budgetKey = (budget: ContextBudget): string => `${budget.maxTokens}/${budget.maxRounds}`

/** 读锚点：上一轮边界那一轮的提问 id（预算变了就作废） */
export const readRoundAnchor = (key: string, budget: ContextBudget): string | undefined => {
  const anchor = anchors.get(key)
  return anchor && anchor.budget === budgetKey(budget) ? anchor.fromId : undefined
}

/** 记锚点：fromId 是「本轮第一个被保留的轮次」的提问 id */
export const rememberRoundAnchor = (
  key: string,
  fromId: string,
  budget: ContextBudget
): void => {
  // 重新插入以维持「最近使用」顺序
  anchors.delete(key)
  anchors.set(key, { fromId, budget: budgetKey(budget) })
  while (anchors.size > ANCHOR_LIMIT) {
    const oldest = anchors.keys().next().value
    if (oldest === undefined) {
      break
    }
    anchors.delete(oldest)
  }
}

/** 清空锚点（预算变更 / 用例隔离用） */
export const resetRoundAnchors = (): void => {
  anchors.clear()
}

/**
 * 选出本轮要保留的历史轮次。
 *
 * 三步，按优先级：
 * 1. **未越线**：原样保留全部轮次（正常会话永远走这一支，与 #122 完全一致）——
 *    这一支不看锚点：装得下就全发，别为了「保持窗口」白丢历史；
 * 2. **上一轮的边界还在上限内**：原样沿用（#345 的「冻结」）——
 *    这条是前缀稳定的真正来源：历史只在尾部增长，请求前缀逐字节不变；
 * 3. **必须新裁一次**：一次裁到低水位（`CONTEXT_LOW_WATERMARK_RATIO`），
 *    让下一次移动边界发生在「又长了一整截」之后，而不是下一轮。
 *
 * `reason` 记录的是**越线时**撞到的那道闸（tokens / rounds / both）：
 * 与「这一枪实际丢了比一轮更多」并不矛盾——低水位是越线的后果，不是另一个闸。
 */
export const selectRoundWindow = (
  roundChars: number[],
  budget: ContextBudget,
  fixedChars = 0,
  anchoredKept?: number
): { kept: number; chars: number; reason: ContextTrimReport['reason'] } => {
  const natural = windowFor(roundChars, budget, fixedChars)
  const limitChars = budget.maxTokens * CHARS_PER_TOKEN
  // 1. 装得下就全发（与 #122 一致；锚点不参与这一支）
  if (natural.reason === 'none') {
    return natural
  }
  // 2. 沿用上一轮的边界：只要它仍然落在两道闸之内
  if (
    typeof anchoredKept === 'number' &&
    anchoredKept >= 1 &&
    anchoredKept <= roundChars.length &&
    anchoredKept <= budget.maxRounds
  ) {
    let chars = fixedChars
    for (let index = roundChars.length - anchoredKept; index < roundChars.length; index += 1) {
      chars += roundChars[index]
    }
    if (chars <= limitChars) {
      return { kept: anchoredKept, chars, reason: natural.reason }
    }
  }
  // 3. 一次裁到低水位
  const low = windowFor(roundChars, lowWatermarkBudget(budget), fixedChars)
  // 低水位只可能保留更少；预算小到取整后反而更宽松时（maxTokens: 1 之类）退回自然窗口
  return low.kept <= natural.kept ? { ...low, reason: natural.reason } : natural
}

/** 空的裁剪统计，用于「没裁剪」时的统一口径 */
export const emptyContextTrimReport: ContextTrimReport = {
  roundsTotal: 0,
  roundsKept: 0,
  roundsDropped: 0,
  charsBefore: 0,
  charsAfter: 0,
  tokensBefore: 0,
  tokensAfter: 0,
  maxTokens: DEFAULT_CONTEXT_BUDGET.maxTokens,
  maxRounds: DEFAULT_CONTEXT_BUDGET.maxRounds,
  reason: 'none',
}

/** 一行可读的裁剪统计，写日志 / 诊断时直接用 */
export const formatContextTrim = (report: ContextTrimReport): string =>
  `上下文预算：裁掉 ${report.roundsDropped}/${report.roundsTotal} 轮（保留 ${report.roundsKept} 轮），` +
  `字符 ${report.charsBefore}→${report.charsAfter}，估算 token ${report.tokensBefore}→${report.tokensAfter}，` +
  `上限 ${report.maxTokens} token / ${report.maxRounds} 轮，触发 ${report.reason}`

/** 全局默认预算（可由设置项或调试入口覆盖） */
let active: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET }

/** 合法的部分配置与当前默认值合并；非法值（0 / 负数 / NaN）回落到默认，避免把历史裁空 */
export const resolveContextBudget = (patch?: Partial<ContextBudget>): ContextBudget => {
  const merged = { ...active, ...patch }
  return {
    maxTokens: positive(merged.maxTokens, DEFAULT_CONTEXT_BUDGET.maxTokens),
    maxRounds: positive(merged.maxRounds, DEFAULT_CONTEXT_BUDGET.maxRounds),
  }
}

export const getContextBudget = (): ContextBudget => ({ ...active })

/** 改默认预算（缺省字段保持原值）；返回生效后的完整预算 */
export const setContextBudget = (patch: Partial<ContextBudget>): ContextBudget => {
  const next = resolveContextBudget(patch)
  // 预算改了：旧锚点是按旧预算裁出来的，边界要重新算一次（#345）
  if (budgetKey(next) !== budgetKey(active)) {
    resetRoundAnchors()
  }
  active = next
  return getContextBudget()
}

export const resetContextBudget = (): ContextBudget => {
  active = { ...DEFAULT_CONTEXT_BUDGET }
  // 预算回到出厂值：旧锚点算出来的边界不再有参考价值（#345）
  resetRoundAnchors()
  return getContextBudget()
}

/** 最近一次裁剪的统计；没发生裁剪时是 emptyContextTrimReport */
let last: ContextTrimReport = emptyContextTrimReport

export const getLastContextTrim = (): ContextTrimReport => ({ ...last })

/** 记录一次裁剪：更新最近统计（观测不能影响请求本身） */
export const reportContextTrim = (report: ContextTrimReport): void => {
  last = report
}
