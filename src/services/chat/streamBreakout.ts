/**
 * 断流（stream break）的**体验口径**：哪些情况该自动重试、重试几次、退避多久、已收到的内容留还是丢。
 *
 * 为什么要有这份判定：用户报「流式传输中断时前端会报错」。复现（`docs/ui/streambreak-before-*.png`）
 * 看到的事实是 —— 三种断流形态（首字节前 / 首字节后 / 长时间无数据）**全部**渲染成红色错误条
 * `rgb(236,19,19)` + ⚠ 图标，而其中两种其实已经收到了内容。**「中断」不是「报错」**：
 * 用户已经看到字了，用报错语气吓他、还让他以为内容丢了，是错的。
 *
 * 产品口径（2026-11-25 拍板，本文件是**唯一判定处**，改口径只改这里）：
 *
 * | 场景 | 自动重试 | 用户看到 | 已收到的内容 |
 * | --- | --- | --- | --- |
 * | 首字节前断开（`receivedChars === 0`） | **5** 次，退避 1s / 2s / 4s / 8s，**总预算 60s**（超了立刻停） | 全程尽量无感，只有 5 次全失败 / 超预算才给软提示 | 无内容 |
 * | 首字节后断开，内容 **< 150** 字 | **1** 次 | 重试中的既有提示（`chatRetrying`） | **丢弃重来**（`discardPartial`） |
 * | 首字节后断开，内容 **≥ 150** 字 | 0 次 | 软提示 + 「重新生成」 | 保留 |
 * | idle 卡住，0 字 | 同「首字节前」 | 同上 | 无内容 |
 * | idle 卡住，有内容 | 按 150 字阈值 | 同上 | 同上 |
 * | 4xx / 内容审核 / 额度 / 鉴权 / 参数错 | 0 次 | 既有 `errorNotice` 表（红色） | 保留 |
 *
 * 三条纪律：
 * 1. **「重发」和「留着旧内容」不能同时成立** —— 那就是用户看到两份、上游重复计费。
 *    所以 `discardPartial` 只在 `retry && receivedChars > 0` 时为 true，执行方必须在重发前
 *    把这条回复的正文 / 思考块清空（见 `store.streamReply` 里的 `discardReplyContent`）。
 * 2. **预算优先于次数**：60s 到了就停，哪怕 5 次还没用完。反过来，「退避序列全用满 ≈ 23s」
 *    也必须落在预算之内（单测钉住，免得将来改退避把两者改矛盾）。
 *    预算**只属于「首字节前」那一档**（每次都会连着试 5 次）；有内容那一档只补 1 次、
 *    不叠预算 —— 否则 `idle` 永远走不到（它的判死阈值本身就是 60s，见下文 3/4 分支的注释）。
 * 3. **不改错误分类、不改文案文字**：本文件只裁 `interrupted` / `idle` 两档，其余 kind 原样
 *    返回 `tone: 'error'`、`retry: false`，由既有的 `errorNotice.ts` 表继续决定文案与按钮；
 *    具体句子仍由 `describe.ts` 从 i18n 取。
 *
 * 为什么「首字节前」敢连试 5 次：那时候用户一个字都没看到，重发不产生任何可见重复，
 * 也不存在「两份内容」的错觉；弱网 / 上游抖动绝大多数在前两三次就恢复。而一旦已经出字，
 * 重发的代价就变成「用户把同一段再看一遍」，所以内容越多越不许重发（150 字是那条线）。
 *
 * ## 那五个 `STREAM_BREAK_*` 常量去哪了（#896 3c-1）
 *
 * 改前本文件自己定义 `STREAM_BREAK_RETRY_LIMIT = 5` / `STREAM_BREAK_RETRY_BUDGET_MS = 60_000` /
 * `STREAM_BREAK_PARTIAL_MAX_CHARS = 150` / 退避序列 —— 而「同一类（stream）的补试档」在
 * `net/requestPolicy.ts` 里还有一份（`retry = streamRetryLimit = 2`）。两处都能改、都能编译通过，
 * 改哪一处生效取决于「谁问了哪个问题」，这就是 #896 要收掉的东西。
 *
 * 现在**数字只在 `LIMITS.streamBreakout` 写一次**，`REQUEST_POLICY.stream.silent` 是它的策赂投影，
 * 本文件通过 {@link silentRetryOf} 读那一行；下面五个导出名保留，是为了让调用点与既有用例
 * （`stream-break-ux.test.mjs` / `domain02-chat-anomaly.test.mjs`）一行都不用改 ——
 * 它们是**同一份策略的只读视图**，不再是可以各改各的常量。
 *
 * 与 `timeoutPolicy.ts` 的区别（那条「不 import 任何东西」的纪律**不**适用于本文件）：
 * `timeoutPolicy.ts` 会被 `chat-staged-timeout-568.test.mjs` 整份复制到临时目录做负向对照，
 * 有了 import 就解析不到依赖；本文件没有那个用途，所以可以（也应该）直接读策略表。
 */

import { silentRetryDelayMs, silentRetryOf } from '../net/requestPolicy.js'

/**
 * 这一类（`stream`）此刻生效的静默补试档 —— 本文件唯一的数字来源。
 * 它在模块加载时取一次：策略表是编译期常量（重试语义不许运行期改，那是产品决定）。
 */
const SILENT = silentRetryOf('stream')

/** 断流两档：连接断掉（interrupted）与连上了但不动（idle） */
export type StreamBreakoutKind = 'interrupted' | 'idle'

/**
 * 提示的视觉语气：
 * - `soft`：中性状态行（用户什么都没看到 / 已经重试过），最轻；
 * - `warn`：警示状态行（内容已收到、需要用户点一下），比 `soft` 显眼，但**不是**报错；
 * - `error`：红色错误条（只在真错误上出现：鉴权 / 额度 / 参数 / 网关…）。
 */
export type StreamBreakoutTone = 'soft' | 'warn' | 'error'

/** 断流两档**实际**会用的语气（永远不含 `error`）：渲染层只接这个类型 */
export type StreamBreakoutSoftTone = Exclude<StreamBreakoutTone, 'error'>

export type StreamBreakoutInput = {
  /** 这一轮**已经向用户输出过**的字符数（正文 + 思考；0 = 一个字都没看到） */
  receivedChars: number
  /** `ApiError.kind`；不属于断流的值原样放过（不在本文件扩权） */
  kind: string | undefined
  /**
   * 这一轮**已经自动重试过几次**（0 = 还没重试过）：上限与退避档位都按它算。
   * 调用点用「断流档自己的计数器」，不要拿 #105 通用重试的 attempt 混算。
   */
  retriedCount?: number
  /**
   * 上一代的布尔入参（`retried: true` 等价于 `retriedCount: 1`）。
   * 保留是因为渲染层（`describe.ts`）只需要语气、不关心次数；新代码请用 `retriedCount`。
   */
  retried?: boolean
  /**
   * 本轮**已经耗时**多少毫秒（从点发送算起，含前面几次重试的退避）：用于 60s 总预算。
   * 不传 / 传非法值按 0 处理（= 未超预算），免得调用点算不出来时把重试全掐掉。
   */
  elapsedMs?: number
}

export type StreamBreakoutDecision = {
  /** 是否自动重发同一条请求 */
  retry: boolean
  /** 提示该用什么语气渲染 */
  tone: StreamBreakoutTone
  /** 这一档允许的自动重试**总次数**（0 = 不重试）；调用点用它算「共 N 次」 */
  maxRetries: number
  /**
   * 重发前是否**丢弃已收到内容**重来。
   * 只在 `retry === true && receivedChars > 0` 时可能为 true —— 见文件头纪律 1。
   */
  discardPartial: boolean
  /** 这次重发前要等多久（毫秒）；`retry === false` 时恒为 0 */
  retryDelayMs: number
  /** 这一档的总时长预算（毫秒；0 = 不设预算，即非重试档） */
  budgetMs: number
}

/**
 * 首字节前断开的静默补试上限（**5** 次）—— 取自 `REQUEST_POLICY.stream.silent.attempts`
 * （数字本身在 `LIMITS.streamBreakout.silentAttempts`）。
 *
 * 与「看得见的重试」（`streamRetryLimit` = 2 次）**故意分开**：那一档会显示
 * 「正在第 N 次重试（共 2 次）」，这一档要的是「悄悄再试几次，成了就当无事发生；不成再说话」。
 * 混用一个数字，要么静默补试被砍成 2 次（弱网恢复率下降），要么把 #105 的通用重试
 * 放大到 5 次（请求量炸开）。两条理由都写在策略表里，本文件只读结论。
 */
export const STREAM_BREAK_RETRY_LIMIT = SILENT.attempts

/** 首字节后断开的补试上限（**1** 次：这次重发要丢掉已经收到的半截，代价高，只补一次） */
export const STREAM_BREAK_PARTIAL_RETRY_LIMIT = SILENT.partialAttempts

/**
 * 断流重试的**总时长预算**（60s）：从点发送算到「还要不要再发一次」。
 * 它不是「单次请求超时」，而是「用户愿意为这一条回答等多久」——超了就给提示让他决定。
 */
export const STREAM_BREAK_RETRY_BUDGET_MS = SILENT.budgetMs

/**
 * 「已经有内容」这一档的**阈值**（150 字）：`receivedChars < 150` 才允许补一次。
 * 口径是**严格小于**：149 补、150 不补（单测钉死，免得边界漂移）。
 */
export const STREAM_BREAK_PARTIAL_MAX_CHARS = SILENT.partialMaxChars

/**
 * 退避序列（毫秒）：1s / 2s / 4s / 8s，用完最后一个就**封顶**在 8s。
 *
 * 为什么不是 `base × 2^attempt` 一直翻：5 次补试若一路翻倍，末次要等 16s、总退避 31s，
 * 用户在小半分钟里看不到任何东西，而 60s 预算一撞就白等；反过来固定 1s 又会在上游
 * 短暂抖动时把 5 次全烧完。1→2→4→8（然后 8）是「前两次快速补救、后面放慢」的折中。
 * 序列由 `LIMITS.retryBaseDelayMs` 的 1/2/4/8 倍算出，不是另抄一份字面量。
 */
export const STREAM_BREAK_RETRY_DELAYS_MS: readonly number[] = SILENT.delaysMs

/** 这个 kind 是不是断流两档之一（其余一律不是本文件的裁决对象） */
export const isStreamBreakoutKind = (kind: string | undefined): kind is StreamBreakoutKind =>
  kind === 'interrupted' || kind === 'idle'

/** 第 `retriedCount` 次重试（0 起）该等多久：序列用完就封顶，绝不指数爆炸 */
export const streamBreakRetryDelayMs = (retriedCount: number): number =>
  silentRetryDelayMs(retriedCount)

/** 什么都不做的判定（非断流档、以及「已经收口」的档共用） */
const noRetry = (
  tone: StreamBreakoutTone,
  maxRetries: number,
  budgetMs: number
): StreamBreakoutDecision => ({
  retry: false,
  tone,
  maxRetries,
  discardPartial: false,
  retryDelayMs: 0,
  budgetMs,
})

/**
 * **唯一判定处**：给定「收到多少字 / 已经重试几次 / 耗时多久 / 哪一档」，
 * 回答「要不要再发一次、等多久、旧内容留不留」与「提示多软」。
 *
 * 判定顺序有讲究（先看 kind、再看内容、最后看预算），各分支互斥：
 * 1. 不是断流 → 不重发、红色（交给既有错误表）；
 * 2. 一个字都没有（含 idle 没出字）→ 静默重试，次数与预算双闸；
 * 3. 有内容但不足 150 字 → 补一次，且**必须丢弃重来**（否则用户看到两份）；
 * 4. 有内容且 ≥ 150 字 → 不重发，警示状态行 + 重新生成。
 */
export const decideStreamBreakout = ({
  receivedChars,
  kind,
  retriedCount,
  retried,
  elapsedMs,
}: StreamBreakoutInput): StreamBreakoutDecision => {
  // 防御：NaN / 负数字符数按「没收到」处理（调用点算错了也不该判成「有内容」而误伤重试）
  const received = Number.isFinite(receivedChars) && receivedChars > 0 ? receivedChars : 0
  const done = Math.max(
    0,
    Math.trunc(Number.isFinite(retriedCount) ? (retriedCount as number) : retried ? 1 : 0)
  )
  const elapsed = Number.isFinite(elapsedMs) && (elapsedMs as number) > 0 ? (elapsedMs as number) : 0
  /** 预算是否已经用完（预算优先于次数：超了一秒也不许再发） */
  const overBudget = elapsed >= STREAM_BREAK_RETRY_BUDGET_MS

  // 1. 非断流：本文件不扩权（红色与文案由 errorNotice 表决定）
  if (!isStreamBreakoutKind(kind)) {
    return noRetry('error', 0, 0)
  }

  // 2. 首字节前（含 idle 一个字都没出）：5 次 + 60s 预算
  if (received === 0) {
    const limit = STREAM_BREAK_RETRY_LIMIT
    if (done >= limit || overBudget) {
      return noRetry('soft', limit, STREAM_BREAK_RETRY_BUDGET_MS)
    }
    return {
      retry: true,
      // 用户什么都没看到：这一档的终态也只用软状态行
      tone: 'soft',
      maxRetries: limit,
      // 没有内容可丢（有内容才谈得上丢弃，见文件头纪律 1）
      discardPartial: false,
      retryDelayMs: streamBreakRetryDelayMs(done),
      budgetMs: STREAM_BREAK_RETRY_BUDGET_MS,
    }
  }

  // 3. 有内容但不足 150 字：补一次，丢弃重来
  // 4. 内容已经够多（>= 150）：一次都不重发，警示 + 重新生成
  const limit = received < STREAM_BREAK_PARTIAL_MAX_CHARS ? STREAM_BREAK_PARTIAL_RETRY_LIMIT : 0
  /**
   * 有内容这一档的语气：`idle` 用软状态行、`interrupted` 用警示状态行。
   *
   * 两者都不是红色报错；`idle` 更软是因为「连接还在、只是不动」比「连接断了」更容易
   * 被上游自己救回来，文案也本来就说「等待时间过长」而不是「网络跑掉」。
   */
  const tone: StreamBreakoutSoftTone = kind === 'idle' ? 'soft' : 'warn'
  /**
   * 这一档**不叠 60s 总预算**（预算只钉在「首字节前」那一档，`budgetMs: 0` = 不设）。
   *
   * 为什么：60s 预算管的是「首字节前连着试 5 次」那一档的兜底；而有内容这一档只补 1 次。
   * 真把它也套上预算，`idle` 就永远走不到 —— 空闲超时的判死阈值本身就是 `idleMs = 60s`
   * （`LIMITS.requestTimeouts.idleMs`），等它判死的那一刻 60s 预算必然已经用光，
   * 于是「idle 有内容补 1 次」变成永远走不到的死代码（实测：浏览器验收里 idle 形态
   * 只发了 1 次请求、没补试）。这是跑出来的事实，不是推断。
   */
  if (limit === 0 || done >= limit) {
    return noRetry(tone, limit, 0)
  }
  return {
    retry: true,
    tone,
    maxRetries: limit,
    // 要重发 + 已经有内容 ⇒ 必须丢弃重来（这是「不许出现两份」的唯一执行口径）
    discardPartial: true,
    retryDelayMs: streamBreakRetryDelayMs(done),
    budgetMs: 0,
  }
}

/**
 * 断流两档实际会用的语气：这两档**永远**不返回 `error`（红色是鉴权 / 额度 / 参数 / 网关那些
 * 真错误的专属），所以给渲染层一个收窄过的入口 —— 免得到处写 `as` 或各判一次 if。
 *
 * 非断流 kind 传进来时按 `warn` 兜底（而不是 `error`）：调用点写错了也不会把一条断流
 * 重新染成红色报错 —— 那正是这次要修掉的 bug。
 */
export const streamBreakoutTone = (input: StreamBreakoutInput): StreamBreakoutSoftTone => {
  const { tone } = decideStreamBreakout(input)
  return tone === 'error' ? 'warn' : tone
}

/**
 * 一条回复**已经向用户展示过**多少字符（正文 + 思考，工具块不算）。
 *
 * 为什么把思考也算进来：深度思考档里用户在正文出现之前就已经看着思考在滚了 ——
 * 这时候重发同样是「让他把同一段再看一遍」，属于必须拦住的那一类。
 *
 * 入参用结构化类型而不是 `AssistantMessage`：本文件保持零依赖，L0 用例能直接跑真代码。
 */
export const receivedCharsOf = (
  reply: { blocks?: readonly { type: string; text?: string; thinking?: string }[] } | null | undefined
): number => {
  const blocks = reply?.blocks
  if (!blocks || blocks.length === 0) {
    return 0
  }
  return blocks.reduce((total, block) => {
    if (block.type === 'text') {
      return total + (block.text?.length ?? 0)
    }
    if (block.type === 'thinking') {
      return total + (block.thinking?.length ?? 0)
    }
    return total
  }, 0)
}
