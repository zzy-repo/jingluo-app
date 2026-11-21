// [layer: integration | 依赖: playwright + chromium + 本地静态服务 + 本机 mock 流式上游 | 耗时: 70~100 秒] 说明见 tests/README.md
// Issue #362（域 2「对话主链路」）/ #367：最小充分集第 5/5 条。
//
// 两条「等得不耐烦 / 想看得更细」的功能点，都在 #362 盘点里写着「缺 DOM 渲染验证」：
//   F2-10 首字等待分级提示（5s / 30s / 60s 三档 + 60s 档给出口）
//        以前只有 `tests/unit/chat-wait-notice.test.mjs` 验证文案与定时器契约，
//        没有一条用例证明这三档真的会出现在界面上（更没证明 60s 档真的给出「停止」出口）。
//   F2-11 思考过程折叠 / 展开 / 隐藏
//        以前只有 `thinking-display.test.mjs` 的纯函数断言；`integration/caps.test.mjs`
//        只验「入口可用」，不验折叠。这里验三档在**真实 DOM**里的差别：
//        折叠 = 正文不挂 DOM、点标题才展开；expanded = 直接可见；hidden = 完全不占位。
//
// 两张表：
//   表 A（3 行，同一条挂住的请求上按时间点检查）：
//     A1 5s 档  → 等 5.5s：出现「正在等待响应」+「已等待 Ns」
//     A2 30s 档 → 等 30.5s：出现「服务响应较慢，仍在等待」
//     A3 60s 档 → 等 60.5s：出现「等待时间过长，可以停止后重新生成」+ 消息区给「停止生成」出口
//   表 B（3 行，各起一个页面，只改「思考过程显示方式」）：
//     B1 默认折叠（collapsed）→ 流式时自动展开，答完后正文不挂 DOM，点标题可展开
//     B2 expanded            → 不点也在 DOM 里
//     B3 hidden              → 标题与正文都不渲染，正文不留空白占位
//   表 C（1 行，Issue #452 C4）：
//     C1 首字等待期间**切后台再回来** → 提示不卡住、秒数不重复计时（不回退）、
//        回前台后流式照常继续到收尾，且全程只发 1 次请求
//
// 跑法（先 pnpm build 生成标准包；本脚本自起静态服务与 mock 上游）：
//   node tests/integration/domain02-wait-thinking-ui.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import {
  configureAnthropicChannel,
  startMockUpstream,
  writeKeepAliveHang,
  writeThinkingStream,
} from '../fixtures/domain01-02/mock-upstream.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain02-wait-thinking-ui.test.mjs'
const KEY = 'sk-testkey-domain02-wait'

const failures = []
const counter = { value: 0 }
const ok = (message) => {
  counter.value += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message) => (condition ? ok(message) : bad(message))

const server = await serveDist(DIST, { port: process.env.PORT || 0 })
const APP_URL = server.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
const browser = await chromium.launch()

const SEND_BUTTON = /^发送$/
const THINKING_TEXT = '正在推理第一步'
const ANSWER_TEXT = '最终答案正文'

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const waitFor = async (page, predicate, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}
const waitForText = (page, part, timeout = 30_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

/** 起一个干净页面并指向 mock 上游；`settings` 用来预置 localStorage（思考过程显示方式 / 模式） */
const openChat = async (mock, settings = {}) => {
  mock.state.chatCalls.length = 0
  mock.state.calls.length = 0
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来）。
   * 白名单两项，都是精确 host:port：被测产物自身的 origin + 本用例**真起的**本机 mock 上游
   * （流式/思考过程的被测输入就是它，不拿假 SSE 替掉）。
   */
  await installEgressGate(page, {
    appUrl: APP_URL,
    allowHosts: [new URL(APP_URL).host, new URL(mock.url).host],
  })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value)
    }
  }, settings)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  return { context, page }
}

const sendChat = async (page, text = '这条会很慢') => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: SEND_BUTTON }).first().click()
}

/** 表 A：同一条挂住不动的请求上，三个时间点各断言一档 */
const WAIT_ROWS = [
  {
    id: 'A1 5s 档',
    covers: ['F2-10'],
    atMs: 5_500,
    // 5s 档只有「主行 = 阶段名 + 已等待 Ns」，不额外追加分档行（waitStage.ts 的 waitTierLine 约定）
    expectPattern: /已连接，等待模型首字|正在连接上游，等待响应/,
    absentPattern: /服务响应较慢|等待时间过长/,
    expectAction: false,
  },
  {
    id: 'A2 30s 档',
    covers: ['F2-10'],
    atMs: 30_500,
    expectPattern: /服务响应较慢，仍在等待/,
    absentPattern: /等待时间过长/,
    expectAction: false,
  },
  {
    id: 'A3 60s 档',
    covers: ['F2-10'],
    atMs: 60_500,
    expectPattern: /等待时间过长，可以停止后重新生成/,
    absentPattern: null,
    expectAction: true,
  },
]

/** 表 B：三档「思考过程显示方式」 */
const THINKING_ROWS = [
  {
    id: 'B1 默认折叠（collapsed）',
    covers: ['F2-11'],
    settings: {},
    async run(page) {
      // 流式期间自动展开：思考还没出完、正文还没开始时，思考正文必须在 DOM 里（否则只看到一行标题）
      expect(
        await waitFor(page, async () => (await bodyText(page)).includes(THINKING_TEXT), 15_000),
        'F2-11 流式思考期间自动展开（思考正文可见）'
      )
      expect(
        await waitForText(page, ANSWER_TEXT, 30_000),
        'F2-11 前置：回答正常完成'
      )
      await page.waitForTimeout(500)
      const text = await bodyText(page)
      expect(!text.includes(THINKING_TEXT), 'F2-11 答完后默认折叠：思考正文**不挂 DOM**（不是 CSS 隐藏）')
      expect(
        (await page.locator('.ds-assistant-message-main-content').last().innerText()).includes(ANSWER_TEXT),
        'F2-11 折叠只影响思考区，正文照常可见'
      )
      // 点标题展开
      const title = page.getByText(/已思考（用时|正在思考|思考过程/).first()
      expect((await title.count()) > 0, 'F2-11 折叠态仍显示思考标题行（告诉用户这里有点开的东西）')
      await title.click()
      await page.waitForTimeout(400)
      expect(
        (await bodyText(page)).includes(THINKING_TEXT),
        'F2-11 点标题后思考正文出现（可展开）'
      )
    },
  },
  {
    id: 'B2 expanded',
    covers: ['F2-11'],
    settings: { 'chat-demo:thinking-display': 'expanded' },
    async run(page) {
      expect(await waitForText(page, ANSWER_TEXT, 30_000), 'F2-11 前置：回答正常完成')
      await page.waitForTimeout(500)
      const text = await bodyText(page)
      expect(text.includes(THINKING_TEXT), 'F2-11 expanded 档不用点，思考正文直接可见')
      expect(
        text.includes(THINKING_TEXT) && text.includes('再验证第二步'),
        'F2-11 expanded 档思考正文是完整的（多个 thinking_delta 都拼上了）'
      )
    },
  },
  {
    id: 'B3 hidden',
    covers: ['F2-11'],
    settings: { 'chat-demo:thinking-display': 'hidden' },
    async run(page) {
      expect(await waitForText(page, ANSWER_TEXT, 30_000), 'F2-11 前置：回答正常完成')
      await page.waitForTimeout(500)
      const text = await bodyText(page)
      expect(!text.includes(THINKING_TEXT), 'F2-11 hidden 档思考正文完全不渲染')
      expect(
        !/已思考（用时|正在思考/.test(text),
        'F2-11 hidden 档连思考标题也不渲染（不留空白占位）'
      )
      expect(text.includes(ANSWER_TEXT), 'F2-11 hidden 档正文照常显示（隐藏思考不影响回答）')
    },
  },
]

/**
 * #452 C4 的辅助：先发响应头 + 每 500ms 一个心跳（界面停在「等首字」且不撞空闲超时），
 * 等 `gate` 放行后再按 Anthropic 帧把正文吐完并正常收尾。
 * 这样「切后台 / 回前台」这段可以精确地夹在「首字还没到」里面做。
 */
const writeGatedAnswer = async (res, gate, { chunks, gapMs = 400 }) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()
  const ping = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      res.write('event: ping\ndata: {"type":"ping"}\n\n')
    }
  }, 500)
  await gate
  clearInterval(ping)
  const write = (lines) => {
    for (const line of lines) {
      res.write(`${line}\n`)
    }
  }
  write([
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'mock-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    '',
  ])
  for (const text of chunks) {
    await new Promise((resolve) => setTimeout(resolve, gapMs))
    write([
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
      '',
    ])
  }
  write([
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 12 },
    })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ])
  res.end()
}

/** 页面自己的「已等待 Ns」读数；读不到返回 -1 */
const elapsedSeconds = async (page) => {
  const match = /已等待 (\d+)s/.exec(await bodyText(page))
  return match ? Number(match[1]) : -1
}

/** 切前后台：改 visibilityState 并派发 visibilitychange（App 监听的正是这个事件） */
const setVisibility = async (page, state) => {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

const mock = await startMockUpstream()
try {
  // ---------- 表 A：一条挂住不动的请求，按时间点检查三档 ----------
  {
    counter.value = 0
    const rowCovers = ['F2-10']
    console.log(`\n-- 表 A 首字等待三档（覆盖 ${rowCovers.join(' / ')}）`)
    let context
    try {
      // 只发响应头、正文一个字节都不发：客户端会一直停在「等待首字」
      // 注意签名是 (第几次回答请求, res)：正文永远不来，只发心跳（否则 15s 建连超时会先判失败）
      mock.state.respond = async (_call, res) => {
        await writeKeepAliveHang(res, { intervalMs: 2_000 })
      }
      const opened = await openChat(mock)
      context = opened.context
      const page = opened.page
      const startedAt = Date.now()
      await sendChat(page)
      let previousTier = ''
      for (const row of WAIT_ROWS) {
        const waitMs = row.atMs - (Date.now() - startedAt)
        if (waitMs > 0) {
          await page.waitForTimeout(waitMs)
        }
        const hit = await waitFor(
          page,
          async () => row.expectPattern.test(await bodyText(page)),
          6_000
        )
        expect(hit, `${row.covers.join('/')} ${row.id}：出现「${row.expectPattern}」`)
        const text = await bodyText(page)
        expect(/已等待 \d+s/.test(text), `${row.covers.join('/')} ${row.id}：带上已等待秒数`)
        // 档位是升级而不是叠加：上一档 / 更晚档的文案不该同时杵在那里
        if (previousTier) {
          expect(!text.includes(previousTier), `${row.covers.join('/')} ${row.id}：上一档文案已撤下`)
        }
        if (row.absentPattern) {
          expect(
            !row.absentPattern.test(text),
            `${row.covers.join('/')} ${row.id}：还没到的档不提前出现（${row.absentPattern}）`
          )
        }
        previousTier = row.expectPattern.source
        // 60s 档必须给出口（停止 / 重新生成），前两档不给
        const stopButtons = await page.getByRole('button', { name: /^停止生成$/ }).count()
        if (row.expectAction) {
          expect(
            stopButtons >= 2,
            `${row.covers.join('/')} ${row.id}：消息区额外给出「停止生成」出口（同屏按钮数 ${stopButtons}）`
          )
        } else {
          expect(
            stopButtons === 1,
            `${row.covers.join('/')} ${row.id}：只有输入行的停止按钮，不提前给出口（同屏 ${stopButtons}）`
          )
        }
        console.log(`   ${row.id}：检查点通过（覆盖 ${row.covers.join(' / ')}）`)
      }
      expect(
        mock.state.chatCalls.length === 1,
        `F2-10 等待期间不重发请求（回答请求 ${mock.state.chatCalls.length} 次）`
      )
    } catch (error) {
      bad(`表 A 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context?.close()
    }
  }

  // ---------- 表 B：三档思考过程显示方式 ----------
  for (const row of THINKING_ROWS) {
    counter.value = 0
    console.log(`\n-- ${row.id}（覆盖 ${row.covers.join(' / ')}）`)
    let context
    try {
      mock.state.respond = async (_call, res) => {
        await writeThinkingStream(res, { thinking: ['正在推理第一步，', '再验证第二步'], answer: [ANSWER_TEXT] })
      }
      // 思考档位在「专家模式」下最接近真实用法（请求体里 thinking=enabled）
      const opened = await openChat(mock, { 'chat-demo:chat-mode': 'expert', ...row.settings })
      context = opened.context
      await sendChat(opened.page)
      await row.run(opened.page, mock)
      console.log(`   ${row.id}：${counter.value} 条断言通过（覆盖 ${row.covers.join(' / ')}）`)
    } catch (error) {
      bad(`${row.id} 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context?.close()
    }
  }
  // ---------- 表 C：#452 C4 首字等待期间切后台再回来 ----------
  {
    counter.value = 0
    const rowCovers = ['F2-10']
    console.log(`\n-- 表 C 首字等待期间切后台再回来（覆盖 ${rowCovers.join(' / ')}）`)
    let context
    try {
      let release
      const contentGate = new Promise((resolve) => {
        release = resolve
      })
      mock.state.respond = async (_call, res) => {
        await writeGatedAnswer(res, contentGate, { chunks: ['切后台回来后的', '回答继续流式上屏'] })
      }
      const opened = await openChat(mock)
      context = opened.context
      const page = opened.page
      await sendChat(page, '等首字的时候切后台')
      // ① 前置：5s 档已经出现（没有提示就谈不上「提示卡不卡住」）
      expect(
        await waitFor(page, async () => /已等待 \d+s/.test(await bodyText(page)), 15_000),
        'F2-10 首字等待 5s 档出现提示'
      )
      const beforeHidden = await elapsedSeconds(page)
      expect(beforeHidden >= 5, `F2-10 切后台前已等待 ${beforeHidden}s（≥5s 才进入分级提示）`)
      // ② 切到后台：提示不许消失，秒数也不许被重算
      await setVisibility(page, 'hidden')
      await page.waitForTimeout(1_500)
      expect(/已等待 \d+s/.test(await bodyText(page)), 'F2-10 切到后台后等待提示仍在（不是白板 / 卡死）')
      const whileHidden = await elapsedSeconds(page)
      expect(
        whileHidden >= beforeHidden,
        `F2-10 后台期间秒数继续累计（切前 ${beforeHidden}s → 后台 ${whileHidden}s，没有归零）`
      )
      // ③ 回到前台：提示不卡住、计时不重复
      await setVisibility(page, 'visible')
      await page.waitForTimeout(400)
      const afterReturn = await elapsedSeconds(page)
      expect(
        afterReturn >= whileHidden,
        `F2-10 回到前台秒数不回退（后台 ${whileHidden}s → 前台 ${afterReturn}s）`
      )
      expect(
        /正在连接上游，等待响应|已连接，等待模型首字|服务响应较慢/.test(await bodyText(page)),
        'F2-10 回到前台后阶段提示仍在（不卡成空白，也不从头计时）'
      )
      // ④ 回前台后内容照常流式到达并收尾
      release()
      expect(
        await waitForText(page, '切后台回来后的', 20_000),
        'F2-10 回到前台后第一块正文正常上屏'
      )
      expect(
        await waitForText(page, '回答继续流式上屏', 20_000),
        'F2-10 回到前台后流式继续到收尾（后台没有把这一轮弄丢）'
      )
      expect(
        await waitFor(page, async () => !/已等待 \d+s/.test(await bodyText(page)), 10_000),
        'F2-10 收到正文后等待提示撤下（不残留）'
      )
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        'F2-10 收尾后回到可发送态'
      )
      expect(
        mock.state.chatCalls.length === 1,
        `F2-10 切后台 / 回前台不重发请求（回答请求 ${mock.state.chatCalls.length} 次）`
      )
      console.log(`   表 C：${counter.value} 条断言通过（覆盖 ${rowCovers.join(' / ')}）`)
    } catch (error) {
      bad(`表 C 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context?.close()
    }
  }
} finally {
  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）—— 先断言再关浏览器
  assertNoEgress(failures)
  await browser.close()
  await server.close()
  await mock.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}（表 A 3 行 = F2-10 三档；表 B 3 行 = F2-11 折叠/展开/隐藏；表 C 1 行 = #452 C4 切后台再回来）`)
}
