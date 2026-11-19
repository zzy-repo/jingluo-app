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
 * 双闸裁剪：从最新一轮往回累积，任一闸超限就停；永远至少保留最近一轮（哪怕它自己就超预算），
 * 这样「只剩最后一轮」的情况仍然发得出去，不会因为预算过小把整段历史裁空。
 */
export const selectRoundWindow = (
  roundChars: number[],
  budget: ContextBudget,
  fixedChars = 0
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
  active = resolveContextBudget(patch)
  return getContextBudget()
}

export const resetContextBudget = (): ContextBudget => {
  active = { ...DEFAULT_CONTEXT_BUDGET }
  return getContextBudget()
}

/** 最近一次裁剪的统计；没发生裁剪时是 emptyContextTrimReport */
let last: ContextTrimReport = emptyContextTrimReport

export const getLastContextTrim = (): ContextTrimReport => ({ ...last })

/** 全局裁剪监听（诊断层启动时接一次即可；单次调用也可以自己传 onTrim） */
let listener: ((report: ContextTrimReport) => void) | null = null

export const setContextTrimListener = (next: ((report: ContextTrimReport) => void) | null) => {
  listener = next
}

/** 记录一次裁剪：更新最近统计并通知监听者，回调异常不影响请求 */
export const reportContextTrim = (report: ContextTrimReport): void => {
  last = report
  try {
    listener?.(report)
  } catch {
    // 观测失败不能影响请求本身
  }
}
