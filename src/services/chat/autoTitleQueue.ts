/**
 * 自动标题请求的背压（issue #112）。
 *
 * `autoTitle.ts` 的标题请求是非流式批量请求：会话一多，首轮回答集中结束时就会同时打出去一批，
 * 没有上限。在弱网 / 低端机上这会两个方向出问题：上游限流（429）和内存抖动（每个请求都要
 * 缓存一份响应体）。这里给这批请求一份**预算**，只做三件事，不碰标题逻辑本身：
 *
 * 1. 并发上限：同时最多 `concurrency` 个在飞，默认 2（与低端机内存对齐的保守值）
 * 2. 有界队列：超出的先进队列等坑位（**排队 ≠ 丢弃**）；队列也满了就明确跳过并计入 `dropped`，
 *    不静默吞——跳过只是不发请求，调用方照旧回退到本地截取，用户看到的是可用标题
 * 3. 限流可区分：429 / 上游限流语义单列一个 outcome（`throttled`），不能混进普通失败，
 *    更不能当成功——否则「被限流」会在统计和日志里彻底消失
 *
 * 计数只进内存（诊断信息走 diagnostics 的地方不在这里，避免与 relay 层耦合）；
 * 单测用 `autoTitleStats()` / `resetAutoTitleStats()` 读口径。
 */
import { classifyApiError } from '../api/errors.js'
import { LIMITS } from '../limits.js'

/** 并发上限默认值：保守取 2（同时 2 个非流式请求，低端机内存抖动可控） */
export const AUTO_TITLE_MAX_CONCURRENCY = LIMITS.autoTitle.concurrency

/** 队列长度默认值：并发 2 + 队列 6 → 同时在系统内的请求最多 8 个 */
export const AUTO_TITLE_MAX_QUEUE = LIMITS.autoTitle.maxQueue

/** 一次请求的结局（用于记账）。`ok` / `empty` 都算请求成功，只是清洗后有没有标题的区别 */
export type AutoTitleOutcome = 'ok' | 'empty' | 'throttled' | 'failed'

/** 没能发出去的两种原因：队列溢出跳过 / 排队期间被调用方取消 */
export type AutoTitleSkipReason = 'dropped' | 'aborted'

export type AutoTitleLimits = {
  /** 同时最多几个在飞 */
  concurrency: number
  /** 队列最多排几个（不含在飞的） */
  maxQueue: number
}

export const AUTO_TITLE_DEFAULT_LIMITS: AutoTitleLimits = {
  concurrency: AUTO_TITLE_MAX_CONCURRENCY,
  maxQueue: AUTO_TITLE_MAX_QUEUE,
}

/** 计数口径：单测与排障都按这个读，字段名即语义 */
export type AutoTitleStats = {
  /** 当前在飞数 */
  active: number
  /** 当前排队数 */
  queued: number
  /** 历史峰值在飞数（证明并发上限真的生效） */
  peak: number
  /** 真正发出去的请求总数 */
  started: number
  /** 走完的请求数（含失败） */
  completed: number
  /** 队列溢出被跳过 */
  dropped: number
  /** 排队期间被取消 */
  aborted: number
  /** 成功且拿到标题 */
  ok: number
  /** 成功但没有可用标题（清洗后为空） */
  empty: number
  /** 被上游限流（429 / 限流语义） */
  throttled: number
  /** 其它失败（超时 / 网络 / 5xx / 协议异常） */
  failed: number
}

export type AutoTitleRunResult<T> =
  | { status: 'done'; value: T }
  | { status: 'skipped'; reason: AutoTitleSkipReason }
  /** 任务自身抛错（调用方应当兜底；坑位照常释放） */
  | { status: 'error' }

export type AutoTitleLimiter = {
  limits: AutoTitleLimits
  /** 调整预算（并发 / 队列）。已经排队的不受影响，坑位空出来后按新上限放行 */
  configure: (next: Partial<AutoTitleLimits>) => void
  run: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<AutoTitleRunResult<T>>
  /** 记账一次请求结局（由请求方在拿到结果后调用） */
  note: (outcome: AutoTitleOutcome) => void
  stats: () => AutoTitleStats
  /** 清零计数（在飞 / 排队的现场不动：只在空闲时用，单测里用的就是它） */
  reset: () => void
}

type Entry = {
  task: () => Promise<unknown>
  resolve: (result: AutoTitleRunResult<unknown>) => void
  signal?: AbortSignal
  /** 排队期间监听取消；一旦出队（在飞 / 跳过）就摘掉，避免泄漏监听 */
  onAbort?: () => void
}

const zeroCounts = () => ({
  started: 0,
  completed: 0,
  dropped: 0,
  aborted: 0,
  ok: 0,
  empty: 0,
  throttled: 0,
  failed: 0,
})

/**
 * 创建一个限流器。生产用下面的 `autoTitleLimiter` 单例（全局共享，多个会话打进来才谈得上「批量」）；
 * 单测可以造独立的实例验证预算，不污染生产单例。
 */
export const createAutoTitleLimiter = (
  options: Partial<AutoTitleLimits> = {}
): AutoTitleLimiter => {
  const limits: AutoTitleLimits = { ...AUTO_TITLE_DEFAULT_LIMITS, ...options }
  const queue: Entry[] = []
  let active = 0
  let peak = 0
  let counts = zeroCounts()

  const normalize = () => {
    const concurrency = Math.floor(limits.concurrency)
    limits.concurrency = Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : 1
    const maxQueue = Math.floor(limits.maxQueue)
    limits.maxQueue = Number.isFinite(maxQueue) && maxQueue >= 0 ? maxQueue : 0
  }

  const detach = (entry: Entry) => {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.onAbort = undefined
  }

  const launch = (entry: Entry) => {
    active += 1
    counts.started += 1
    peak = Math.max(peak, active)
    detach(entry)
    void entry
      .task()
      .then(
        (value) => ({ status: 'done' as const, value }),
        () => ({ status: 'error' as const })
      )
      .then((result) => {
        active -= 1
        counts.completed += 1
        // 先结算再放行下一个：调用方的 finally（保存标题）不必等下一个请求起跑
        entry.resolve(result)
        pump()
      })
  }

  const pump = () => {
    while (active < limits.concurrency && queue.length > 0) {
      const entry = queue.shift()
      if (!entry) {
        return
      }
      launch(entry)
    }
  }

  const run = <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<AutoTitleRunResult<T>> => {
    normalize()
    // 已经取消的调用不必占坑，也不必排队
    if (signal?.aborted) {
      counts.aborted += 1
      return Promise.resolve({ status: 'skipped', reason: 'aborted' })
    }
    return new Promise<AutoTitleRunResult<T>>((resolve) => {
      const settle = resolve as (result: AutoTitleRunResult<unknown>) => void
      const entry: Entry = { task: task as () => Promise<unknown>, resolve: settle, signal }
      // 有空位且没人排队：直接发
      if (active < limits.concurrency && queue.length === 0) {
        launch(entry)
        return
      }
      // 队列也满了：明确跳过并计数（调用方回退本地截取，用户无感）
      if (queue.length >= limits.maxQueue) {
        counts.dropped += 1
        settle({ status: 'skipped', reason: 'dropped' })
        return
      }
      if (signal) {
        entry.onAbort = () => {
          const index = queue.indexOf(entry)
          if (index >= 0) {
            queue.splice(index, 1)
            detach(entry)
            counts.aborted += 1
            settle({ status: 'skipped', reason: 'aborted' })
          }
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      queue.push(entry)
    })
  }

  return {
    limits,
    configure: (next) => {
      Object.assign(limits, next)
      normalize()
    },
    run,
    note: (outcome) => {
      counts[outcome] += 1
    },
    stats: () => ({ active, queued: queue.length, peak, ...counts }),
    reset: () => {
      counts = zeroCounts()
      peak = active
    },
  }
}

/**
 * 生产单例：所有会话的自动标题请求都从这里走，所以「并发 / 队列」是全局口径。
 * 预算可调：`setAutoTitleLimits({ concurrency: 3 })`（默认 2 / 6）。
 */
export const autoTitleLimiter = createAutoTitleLimiter()

export const setAutoTitleLimits = (next: Partial<AutoTitleLimits>): void => {
  autoTitleLimiter.configure(next)
}

export const autoTitleStats = (): AutoTitleStats => autoTitleLimiter.stats()

export const resetAutoTitleStats = (): void => {
  autoTitleLimiter.reset()
}

/** 限流语义的文案特征：状态码之外，中转经常只回一句话 */
const THROTTLE_MESSAGE = /rate[\s_-]?limit|too\s+many\s+requests/i

/**
 * 这次失败是不是「被上游限流」。
 * 先按统一分类（429 → rateLimited）判断，再兜一层报文特征：有些中转把限流写成 400/403 + 一句话。
 */
export const isAutoTitleThrottled = (error: unknown): boolean => {
  if (classifyApiError(error) === 'rateLimited') {
    return true
  }
  const status = (error as { status?: unknown } | null)?.status
  if (status === 429) {
    return true
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return THROTTLE_MESSAGE.test(message)
}
