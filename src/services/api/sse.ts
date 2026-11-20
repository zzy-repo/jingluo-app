/**
 * SSE（text/event-stream）解析，按 WHATWG 规范实现：
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * 字节流 → UTF-8 解码 → 按 CRLF / LF / CR 切行 → 字段累积 → 空行派发事件。
 * 注释行（如服务端保活的 `: keep-alive`）直接忽略；`retry` 只对 EventSource 重连有意义，这里不处理。
 */

export type ServerSentEvent = {
  /** `event` 字段，缺省为 `message` */
  event: string
  /** 多行 `data` 以 `\n` 连接 */
  data: string
  /** 最近一次 `id` 字段 */
  lastEventId: string
}

const LINE_BREAK = /\r\n|\r|\n/g

export class ServerSentEventDecoder {
  private buffer = ''
  private data = ''
  private hasData = false
  private eventType = ''
  private lastEventId = ''

  /** 输入一段已解码的文本，返回其中完整的事件 */
  push(text: string): ServerSentEvent[] {
    this.buffer += text
    const events: ServerSentEvent[] = []
    let lineStart = 0
    LINE_BREAK.lastIndex = 0
    for (let match = LINE_BREAK.exec(this.buffer); match; match = LINE_BREAK.exec(this.buffer)) {
      // 结尾的 CR 可能是 CRLF 的前半，等下一段再判断
      if (match[0] === '\r' && LINE_BREAK.lastIndex === this.buffer.length) {
        break
      }
      const event = this.processLine(this.buffer.slice(lineStart, match.index))
      if (event) {
        events.push(event)
      }
      lineStart = LINE_BREAK.lastIndex
    }
    this.buffer = this.buffer.slice(lineStart)
    return events
  }

  /** 流结束：结尾的 CR 是完整的换行，其余未以空行结尾的事件按规范丢弃 */
  end(): ServerSentEvent[] {
    const event = this.buffer.endsWith('\r') ? this.processLine(this.buffer.slice(0, -1)) : null
    this.buffer = ''
    this.data = ''
    this.hasData = false
    this.eventType = ''
    return event ? [event] : []
  }

  private processLine(line: string): ServerSentEvent | null {
    if (line === '') {
      return this.dispatch()
    }
    if (line.startsWith(':')) {
      return null
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }
    switch (field) {
      case 'data':
        this.data = this.hasData ? `${this.data}\n${value}` : value
        this.hasData = true
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value
        }
        break
      default:
        break
    }
    return null
  }

  private dispatch(): ServerSentEvent | null {
    const event: ServerSentEvent | null = this.hasData
      ? { event: this.eventType || 'message', data: this.data, lastEventId: this.lastEventId }
      : null
    this.data = ''
    this.hasData = false
    this.eventType = ''
    return event
  }
}

/**
 * 「一个字节都没来」已经超过约定时长（#150）。
 * 单独一类错误：它既不是连接断了（interrupted），也不是请求没发出去（timeout），
 * 上层要能自己判断（保留已收内容、允许重试）。
 */
export class StreamIdleTimeoutError extends Error {
  /** 判定为空闲超时用的阈值（毫秒） */
  readonly idleMs: number

  constructor(idleMs: number) {
    super(`no data received for ${idleMs}ms`)
    this.name = 'StreamIdleTimeoutError'
    this.idleMs = idleMs
  }
}

/**
 * 响应头到手之后、**第一个 SSE 事件**还没来，且已经超过约定时长（#568）。
 *
 * 与「空闲超时」分开的核心理由：两段能不能重试不一样。
 * - 首字超时的时候还没向用户输出任何内容，重发是安全的（同一份请求体再打一次即可）；
 * - 空闲超时可能发生在正文中途（吐半句后不动），重发会重复输出 / 重复计费。
 * 混成一个错误，上层就只能二选一：要么误重试、要么白丢一个本可以自愈的失败。
 */
export class StreamFirstTokenTimeoutError extends Error {
  /** 首字预算（毫秒） */
  readonly firstTokenMs: number

  constructor(firstTokenMs: number) {
    super(`no sse event within ${firstTokenMs}ms after response headers`)
    this.name = 'StreamFirstTokenTimeoutError'
    this.firstTokenMs = firstTokenMs
  }
}

/**
 * 响应体阶段的两段预算（#568）。两者都是「空闲」口径，不是总时长：
 * - `firstEventMs`：响应头到手 → **第一个事件**。这段时间**不因为收到保活注释而重置**
 *   （保活只证明连接活着，不证明模型开始出字；重置它等于把首字超时废掉）；
 * - `idleMs`：此后**每读到一段数据**就重新计时（含保活注释 —— 它确实证明连接还在，
 *   在这里杀掉是误杀正常长回答，#150 的口径不变）。
 * 不传 / 非正数表示该段不启用。
 */
export type StreamBudgets = {
  firstEventMs?: number
  idleMs?: number
}

/** 合法正数才生效（0 / NaN / 负数一律当「不启用」） */
const budgetOf = (value: number | undefined): number =>
  Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : 0

/**
 * 逐个产出字节流中的 SSE 事件；流读完即结束。
 * 中止或调用方提前退出时取消读取以释放连接，不依赖底层网络把中止传到响应体。
 *
 * 计时范围见 `StreamBudgets`：首字一段、此后空闲一段，各自独立。
 * 两段都没配时与改造前完全一致（只读、不计时）。
 */
export async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  budgets: StreamBudgets = {}
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // TextDecoder 默认会去掉开头的 BOM；stream: true 保证多字节字符跨分片时不被截断
  const textDecoder = new TextDecoder()
  const decoder = new ServerSentEventDecoder()
  const idleBudget = budgetOf(budgets.idleMs)
  const firstEventBudget = budgetOf(budgets.firstEventMs)
  /**
   * 首字预算从**第一次读**开始算（= 响应头到手那一刻，调用方拿到 response 就直接开始迭代），
   * 并且跨多次 read 连续计时：分片进来但还没凑成一个完整事件时，剩下的预算继续有效。
   */
  const firstEventDeadline = firstEventBudget ? Date.now() + firstEventBudget : 0
  let firstEventPending = firstEventBudget > 0
  /**
   * 读下一段数据，同时给这次等待套一个预算。
   * 到点先取消读取（真正断开连接，不留悬挂 socket），再抛对应那一段的超时。
   */
  const readWithinBudget = async (
    budgetMs: number,
    makeError: () => Error
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 先判定超时，再断开连接：反过来会让 cancel 先把挂起的 read 结算成 done，
        // 上层会把它当成「流正常结束」而不是超时。
        reject(makeError())
        reader.cancel().catch(() => {})
      }, budgetMs)
    })
    try {
      return await Promise.race([reader.read(), expired])
    } finally {
      clearTimeout(timer)
    }
  }
  /** 本次读要等多久、超时算哪一段：首字还没来就用剩余的首字预算，否则用空闲预算 */
  const nextBudget = (): { ms: number; makeError: () => Error } | null => {
    if (firstEventPending) {
      return {
        ms: firstEventDeadline - Date.now(),
        makeError: () => new StreamFirstTokenTimeoutError(firstEventBudget),
      }
    }
    return idleBudget
      ? { ms: idleBudget, makeError: () => new StreamIdleTimeoutError(idleBudget) }
      : null
  }
  let finished = false
  try {
    for (;;) {
      const budget = nextBudget()
      if (budget && budget.ms <= 0) {
        // 首字预算在两次 read 之间就耗尽了（分片一直在来但始终不成事件）
        throw budget.makeError()
      }
      const { done, value } = budget
        ? await readWithinBudget(budget.ms, budget.makeError)
        : await reader.read()
      if (done) {
        finished = true
        yield* decoder.push(textDecoder.decode())
        yield* decoder.end()
        return
      }
      const events = decoder.push(textDecoder.decode(value, { stream: true }))
      if (firstEventPending && events.length > 0) {
        // 第一个事件到了：首字段结束，此后一律按空闲口径计时
        firstEventPending = false
      }
      yield* events
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!finished) {
      reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
