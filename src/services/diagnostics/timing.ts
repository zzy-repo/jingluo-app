/**
 * 耗时打点（Issue #306 / 母单 #301 维度 6，#101 的遗留）：把「慢」拆成能量化的几段。
 *
 * 为什么要拆（#101 的三条候选慢因，各不相同）：
 * - **上游排队 / 建连慢**：`ttfbMs` 大、`streamMs` 小 —— 点发送后长时间空白，随后整段刷出；
 * - **弱网吞吐低**：`ttfbMs` 正常、`streamMs` 大、`charsPerSec` 低、`gapMaxMs` 大 —— 一字一字冒；
 * - **附件补齐占掉时间**：`prepMs` 大 —— 首字还没开始等，时间已经花在上传附件上了。
 *
 * 改造前 `chat_first_token.durationMs` 从「点发送之前」起算，把上面第一和第三种混成一个数，
 * 于是「慢」只能靠体感描述。本模块只做一件事：用**单调递增的时钟**把同一轮请求的
 * 关键时刻记下来，最后算成一个可直接比较的结构（`StreamTiming`）。
 *
 * 纯函数 + 可注入时钟（单测能给定时间轴，不靠 sleep 猜）。
 */

/** 一轮流式请求的分段耗时（全部毫秒；取不到的写 null，**不许用 0 冒充**） */
export type StreamTiming = {
  /** 点发送 → 请求真正发出（附件补齐 + 构体），首字等待从这里才开始算 */
  prepMs: number | null
  /** 请求发出 → 响应头到手（上游排队 + 建连 + 网关） */
  ttfbMs: number | null
  /** 请求发出 → 首个内容块（用户看到的「首字」） */
  firstTokenMs: number | null
  /** 首个内容块 → 流结束（真正的吐字时长） */
  streamMs: number | null
  /** 点发送 → 流结束 */
  totalMs: number
  /** 分段数（收到的内容增量个数） */
  chunks: number
  /** 相邻分段的最大间隔：卡顿的直接证据 */
  gapMaxMs: number
  /** 文本字符数 */
  chars: number
  /** 吞吐（字符/秒）：弱网判定用它，不靠 durationMs 猜 */
  charsPerSec: number | null
}

export type StreamMeter = {
  /** 请求即将发出（附件已补齐）：`prepMs` 到此为止 */
  markRequest: () => void
  /** 响应头到手：`ttfbMs` 到此为止 */
  markHeaders: () => void
  /** 收到一段内容增量：`chars` 是本段字符数（0 也可以，只影响分段计数与间隔） */
  markEvent: (chars?: number) => void
  /** 当前快照（可随时取；流没结束也能取，用来说明「卡在哪一段」） */
  snapshot: () => StreamTiming
}

const elapsed = (from: number, to: number): number => Math.max(0, Math.round(to - from))

/**
 * 建一个本轮请求的计时器。**必须在「点发送」那一刻创建**（`startedAt` 就是它）。
 * `now` 可注入：单测用假时钟钉住时间轴，业务侧用 `Date.now`。
 */
export const createStreamMeter = (options: { now?: () => number } = {}): StreamMeter => {
  const now = options.now ?? Date.now
  const startedAt = now()
  let requestAt: number | null = null
  let headersAt: number | null = null
  let firstAt: number | null = null
  let lastAt: number | null = null
  let chunks = 0
  let chars = 0
  let gapMaxMs = 0
  let lastChunkAt: number | null = null

  const snapshot = (): StreamTiming => {
    const endAt = lastAt ?? now()
    const streamMs = firstAt === null ? null : elapsed(firstAt, endAt)
    const perSecond =
      streamMs === null || streamMs <= 0 ? null : Math.round((chars / (streamMs / 1000)) * 10) / 10
    return {
      prepMs: requestAt === null ? null : elapsed(startedAt, requestAt),
      ttfbMs: requestAt === null || headersAt === null ? null : elapsed(requestAt, headersAt),
      firstTokenMs: requestAt === null || firstAt === null ? null : elapsed(requestAt, firstAt),
      streamMs,
      totalMs: elapsed(startedAt, endAt),
      chunks,
      gapMaxMs,
      chars,
      charsPerSec: perSecond,
    }
  }

  return {
    markRequest: () => {
      requestAt = now()
    },
    markHeaders: () => {
      if (headersAt === null) {
        headersAt = now()
      }
    },
    markEvent: (delta = 0) => {
      const at = now()
      if (firstAt === null) {
        firstAt = at
      } else if (lastChunkAt !== null) {
        // 「分段间隔」只看相邻两段之间，不从首字算起（否则 gapMax 恒等于 streamMs）
        gapMaxMs = Math.max(gapMaxMs, elapsed(lastChunkAt, at))
      }
      lastChunkAt = at
      lastAt = at
      chunks += 1
      if (Number.isFinite(delta) && delta > 0) {
        chars += Math.round(delta)
      }
    },
    snapshot,
  }
}

/**
 * 把分段耗时转成 meta 字段（走 `buildMeta` 的键名，合法值由契约层再归一一次）。
 * `durationMs` 取总耗时：老口径（`chat_done.durationMs`）保持不变，新增分量另立键，
 * 这样既不断后端的既有聚合，又能切开「首字」与「吐字」。
 */
export const streamTimingMeta = (timing: StreamTiming): {
  durationMs: number
  prepMs?: number
  ttfbMs?: number
  firstTokenMs?: number
  streamMs?: number
  chunks: number
  gapMaxMs: number
  chars: number
  charsPerSec?: number
} => ({
  durationMs: timing.totalMs,
  ...(timing.prepMs === null ? {} : { prepMs: timing.prepMs }),
  ...(timing.ttfbMs === null ? {} : { ttfbMs: timing.ttfbMs }),
  ...(timing.firstTokenMs === null ? {} : { firstTokenMs: timing.firstTokenMs }),
  ...(timing.streamMs === null ? {} : { streamMs: timing.streamMs }),
  chunks: timing.chunks,
  gapMaxMs: timing.gapMaxMs,
  chars: timing.chars,
  ...(timing.charsPerSec === null ? {} : { charsPerSec: timing.charsPerSec }),
})

export type StageTimer = {
  /** 上一段到此为止的耗时（调用一次就是一段；第一段从创建时刻算） */
  lap: () => number
  /** 建表以来的总耗时 */
  total: () => number
}

/**
 * 分阶段计时器：导入 / 更新检查这类「一串步骤」用它，每次 `lap()` 拿到上一段的耗时。
 * 不自己维护 stage 名 —— stage 由调用点给（见 `Stage`），这里只负责数字。
 */
export const createStageTimer = (options: { now?: () => number } = {}): StageTimer => {
  const now = options.now ?? Date.now
  const startedAt = now()
  let mark = startedAt
  return {
    lap: () => {
      const at = now()
      const duration = elapsed(mark, at)
      mark = at
      return duration
    },
    total: () => elapsed(startedAt, now()),
  }
}

/** 速率：字节/秒（时长为 0 或非有限值时返回 undefined，不写假的 0） */
export const bytesPerSecond = (
  bytes: number | undefined,
  durationMs: number | undefined
): number | undefined => {
  if (bytes === undefined || durationMs === undefined) {
    return undefined
  }
  if (!Number.isFinite(bytes) || !Number.isFinite(durationMs) || bytes <= 0 || durationMs <= 0) {
    return undefined
  }
  return Math.round((bytes / durationMs) * 1000)
}
