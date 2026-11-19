// [layer: unit | 依赖: 一个 127.0.0.1 本地 SSE 桩服务器；无浏览器无外网 | 耗时: <2s]
// Issue #306（母单 #301 维度 6 / #101 的遗留）：首字与分段耗时打点。
//
// 改造前的口径问题：`chat_first_token.durationMs` 从「点发送之前」起算，把
// 「附件补齐」和「等上游首字」混成一个数，于是 #101 的三条候选慢因分不开：
//   ① 上游排队 / 建连慢 → ttfbMs 大、streamMs 小
//   ② 弱网吞吐低       → ttfbMs 正常、streamMs 大、charsPerSec 低、gapMaxMs 大
//   ③ 附件补齐占掉时间 → prepMs 大
//
// 本文件跑的是**真代码路径**：真实 `streamMessage`（含真实 fetch、真实 socket 流）
// + 真实采集层 `record()`。桩服务器只决定「什么时候吐哪一段」，不参与算耗时 ——
// 耗时全部由 meter 在真实事件到达时打点，再由采集层落库。
//
// 断言：
//   A 假时钟：分段算术精确（不靠 sleep 猜）
//   B 真流：ttfb / 首字 / 吐字 / 分段 / 吞吐 都是真实数字，且能从采集层读回来
//   C 落库的 meta 键全部通过字段契约（没有被清洗掉）
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { listenFreePort } from '../helpers/ports.mjs'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false

// apiConfig 把渠道/地址存 localStorage：内存版就够，用例把 baseUrl 指到本地桩服务器
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

const { streamMessage } = await import('../../src/services/api/client.ts')
const { setApiKey, setBaseUrl, setModel, setProviderKind } = await import(
  '../../src/services/api/apiConfig.ts'
)
const { applyEvent } = await import('../../src/services/chat/reply.ts')
const { buildMeta, META_KEYS } = await import('../../src/services/diagnostics/fields.ts')
const { createStageTimer, createStreamMeter, streamTimingMeta } = await import(
  '../../src/services/diagnostics/timing.ts'
)
// 真实采集层（不是替身）：耗时数字必须能真的落进日志缓冲，才算「采到了」
const collector = await import('../../src/services/diagnostics/collector.ts')

const KEY = 'sk-log-fields-test'
const BODY = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }
const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

const frame = (event, data) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, '', ''].join('\n')
const deltaFrame = (text) =>
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })

// ---------------------------------------------------------------- A 假时钟

test('A 分段算术：假时钟钉死时间轴，各段互不串味', () => {
  let clock = 1000
  const meter = createStreamMeter({ now: () => clock })
  // 点发送 → 附件补齐花了 120ms
  clock += 120
  meter.markRequest()
  // 请求发出 → 响应头 480ms（上游排队 + 建连）
  clock += 480
  meter.markHeaders()
  // 响应头 → 首个内容块 300ms
  clock += 300
  meter.markEvent(10)
  // 首字 → 第二段 200ms，第二段 → 第三段 900ms（卡了一下）
  clock += 200
  meter.markEvent(20)
  clock += 900
  meter.markEvent(30)
  // 最后一段 → 流结束 100ms
  clock += 100
  const timing = meter.snapshot()

  assert.equal(timing.prepMs, 120, '点发送 → 请求发出')
  assert.equal(timing.ttfbMs, 480, '请求发出 → 响应头')
  assert.equal(timing.firstTokenMs, 780, '请求发出 → 首字（ttfb + 头到首字）')
  assert.equal(timing.streamMs, 1100, '首字 → 最后一段（最后那 100ms 是流关闭，不算吐字）')
  assert.equal(timing.totalMs, 2000, '点发送 → 最后一段')
  assert.equal(timing.chunks, 3)
  assert.equal(timing.gapMaxMs, 900, '最大分段间隔 = 最卡的那一下')
  assert.equal(timing.chars, 60)
  assert.equal(timing.charsPerSec, 54.5, '60 字 / 1.1s')

  // meta 里只写「有值」的键：没有响应头时不许写 ttfbMs=0
  const partial = createStreamMeter({ now: () => clock })
  const meta = buildMeta({ flow: 'chat', stage: 'chat.stream', ...streamTimingMeta(partial.snapshot()) })
  assert.equal(meta.ttfbMs, undefined, '还没拿到响应头 → 不写 ttfbMs')
  assert.ok(!('ttfbMs' in meta))
})

// ---------------------------------------------------------------- B/C 真流

const emptyReply = () => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 0,
  status: 'pending',
  blocks: [],
  prefix: false,
})

/** 起本地 SSE 桩：头立刻发，首字等 FIRST_TOKEN_DELAY_MS，之后每 SEGMENT_GAP_MS 一段 */
const startStub = async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, sseHeaders)
    res.write(
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 9, output_tokens: 0 } },
      })
    )
    const segments = ['第一段', '第二段', '第三段', '第四段', '第五段']
    let index = 0
    const push = () => {
      if (index === 0) {
        // content_block_start 与第一段正文一起发：真实上游也是首字才开块，
        // 提前发会让「首字」被算成「建连完成」，B 的两条断言就分不开了
        res.write(
          frame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })
        )
      }
      if (index < segments.length) {
        res.write(deltaFrame(segments[index]))
        index += 1
        setTimeout(push, SEGMENT_GAP_MS)
        return
      }
      res.write(frame('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(
        frame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 9, output_tokens: 8 },
        })
      )
      res.write(frame('message_stop', { type: 'message_stop' }))
      res.end()
    }
    setTimeout(push, FIRST_TOKEN_DELAY_MS)
  })
  const port = await listenFreePort(server)
  const origin = `http://127.0.0.1:${port}`
  setProviderKind('anthropic')
  setModel('deepseek-flash')
  assert.equal(setBaseUrl(origin), true, '本地桩服务器地址必须是合法 baseUrl')
  setApiKey(KEY)
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

/** 首字等待：**故意比 ttfb 大得多**，这样「首字慢」和「建连慢」不是同一个数 */
const FIRST_TOKEN_DELAY_MS = 150
/** 分段间隔：五个分段各隔这么久，gapMaxMs 才有意义 */
const SEGMENT_GAP_MS = 40

test('B 真流：ttfb / 首字 / 吐字 / 分段 / 吞吐 是真实数字，且能从采集层读回来', async () => {
  const stubServer = await startStub()
  try {
    const meter = createStreamMeter()
    const timer = createStageTimer()
    const controller = new AbortController()
    const blockIndexes = new Map()
    let reply = emptyReply()
    let firstTokenLogged = false

    // 与 store.ts 的接线完全一致：markRequest → 请求 → 响应头回调 → 每段 markEvent
    meter.markRequest()
    const prepMs = timer.lap()
    let firstTokenEntry
    for await (const event of streamMessage(KEY, BODY, controller.signal, {
      onHeaders: () => meter.markHeaders(),
    })) {
      // 与 store 同一口径：只把内容事件当「首字」，message_start 不算
      if (event.type === 'content_block_start' || event.type === 'content_block_delta') {
        meter.markEvent(
          event.type === 'content_block_delta' && event.delta.type === 'text_delta'
            ? event.delta.text.length
            : 0
        )
      }
      if (
        !firstTokenLogged &&
        (event.type === 'content_block_start' || event.type === 'content_block_delta')
      ) {
        firstTokenLogged = true
        const timing = meter.snapshot()
        firstTokenEntry = collector.recordEvent('chat_first_token', `first token in ${timing.totalMs}ms`, {
          ...buildMeta({
            flow: 'chat',
            stage: 'chat.stream',
            attempt: 1,
            status: 'ok',
            endpointKey: 'other',
            durationMs: timing.totalMs,
            ...(timing.prepMs === null ? {} : { prepMs: timing.prepMs }),
            ...(timing.ttfbMs === null ? {} : { ttfbMs: timing.ttfbMs }),
            ...(timing.firstTokenMs === null ? {} : { firstTokenMs: timing.firstTokenMs }),
            chunks: timing.chunks,
          }),
          model: 'deepseek-flash',
        })
      }
      reply = applyEvent(reply, event, 0, blockIndexes)
    }

    const timing = meter.snapshot()
    const chars = reply.blocks.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
    const doneEntry = collector.recordEvent('chat_done', `chat done in ${timing.totalMs}ms`, {
      ...buildMeta({
        flow: 'chat',
        stage: 'chat.settle',
        attempt: 1,
        status: 'ok',
        endpointKey: 'other',
        ...streamTimingMeta(timing),
        chars,
      }),
      model: 'deepseek-flash',
    })

    // --- B1 数字全是真的，且分段互不串味
    assert.ok(prepMs >= 0 && prepMs < 100, `prepMs 应在 0-100ms（实测 ${prepMs}）`)
    assert.ok(timing.ttfbMs !== null && timing.ttfbMs < FIRST_TOKEN_DELAY_MS, `ttfb 应小于首字等待（实测 ${timing.ttfbMs}ms）`)
    assert.ok(
      timing.firstTokenMs !== null && timing.firstTokenMs >= FIRST_TOKEN_DELAY_MS - 10,
      `首字至少等 FIRST_TOKEN_DELAY_MS（实测 ${timing.firstTokenMs}ms）`
    )
    assert.ok(timing.streamMs !== null && timing.streamMs >= SEGMENT_GAP_MS * 4 - 10, `吐字时长应覆盖 5 段（实测 ${timing.streamMs}ms）`)
    assert.ok(timing.gapMaxMs >= SEGMENT_GAP_MS - 10, `最大分段间隔应接近 ${SEGMENT_GAP_MS}ms（实测 ${timing.gapMaxMs}ms）`)
    assert.ok(timing.chunks >= 5, `分段数至少 5（实测 ${timing.chunks}）`)
    assert.equal(timing.chars, chars, 'meter 累加的字符数与最终正文一致')
    assert.ok(timing.charsPerSec !== null && timing.charsPerSec > 0, '吞吐必须是正数')

    // --- C 采集层落库：键必须原样通过字段契约（没被清洗掉）
    const logs = collector.getSnapshot().logs
    const stored = logs.find((entry) => entry === doneEntry) ?? { meta: {} }
    for (const key of ['durationMs', 'ttfbMs', 'firstTokenMs', 'streamMs', 'chunks', 'gapMaxMs', 'chars', 'charsPerSec', 'stage', 'attempt', 'endpointKey', 'flow', 'status', 'model']) {
      assert.ok(key in (stored.meta ?? {}), `采集层丢了这个键: ${key}`)
    }
    for (const key of Object.keys(stored.meta ?? {})) {
      assert.ok(META_KEYS.includes(key) || ['model'].includes(key), `出现了契约外的键: ${key}`)
    }
    // 首字那条也要能读回来（用户提交反馈时看到的就是它）
    const firstStored = (firstTokenEntry?.meta ?? {})
    assert.ok('ttfbMs' in firstStored && 'firstTokenMs' in firstStored, '首字那条必须带 TTFB 与首字耗时')

    // --- 证据表：阶段名 + durationMs（这些数字来自上面这条真流）
    const table = [
      ['chat.upload（附件补齐）', prepMs],
      ['chat.request（TTFB，请求→响应头）', timing.ttfbMs],
      ['chat.stream（首字，请求→首个内容块）', timing.firstTokenMs],
      ['chat.stream（吐字，首字→流结束）', timing.streamMs],
      ['chat.settle（总计，点发送→流结束）', timing.totalMs],
    ]
    console.log('  阶段                                  durationMs')
    for (const [name, value] of table) {
      console.log(`  ${String(name).padEnd(36)} ${String(value)}`)
    }
    console.log(
      `  chunks=${timing.chunks} gapMaxMs=${timing.gapMaxMs} chars=${timing.chars} charsPerSec=${timing.charsPerSec}`
    )
    console.log(`  落库的 chat_done.meta = ${JSON.stringify(doneEntry.meta)}`)
  } finally {
    await stubServer.close()
  }
})
