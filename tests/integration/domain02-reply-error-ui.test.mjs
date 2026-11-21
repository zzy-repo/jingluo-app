// [layer: integration | 依赖: playwright + chromium + 本地静态服务 + 本机 mock 流式上游 | 耗时: 60~90 秒] 说明见 tests/README.md
// Issue #362（域 2「对话主链路」）/ #367：最小充分集第 4/5 条。
//
// 一条表驱动把「回答失败了，界面到底怎么说话」的六种真实形态各跑一行，每行都断言四件事：
//   ① 文案属于**这一档**（不串档：额度不足不许说成限流、断流不许说成断网、4xx 不许说成未知错误）
//   ② 请求次数（终态错误只发 1 次；限流 / 5xx 按上限自动重试）
//   ③ 文案有没有告诉用户「可以重试」（可重试档）／不误导成临时故障（终态档）
//   ④ 出口动作（换 Key / 去充值 / 重新生成）到底在不在
//
// 覆盖功能点：
//   F2-05 Key 无效 401      —— 行 1（含「更换 API Key」出口 + 只发 1 次）
//   F2-07 限流 / 服务端繁忙 —— 行 2（429）、行 3（502）：各自文案 + 自动重试
//   F2-08 上下文超长 413    —— 行 4：明确「重发没用」且只发 1 次
//   F2-09 断流 / 空闲超时   —— 行 5（断流）、行 6（空闲超时）：两种文案分开 + 半句保留
//   F2-06 额度不足          —— 行 7：只做 1 行回归（细节断言已在 integration/quota-exhausted.test.mjs）
//
// 为什么以前只有 L0：#362 盘点里 F2-05/F2-08/F2-09 都写着「缺 L1」，即这些文案只在纯函数的
// 单测里被断言过，没有任何用例证明「store → 文案 → DOM」这条线没断。
//
// 跑法（先 pnpm build 生成标准包；本脚本自起静态服务与 mock 上游）：
//   node tests/integration/domain02-reply-error-ui.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import {
  configureAnthropicChannel,
  startMockUpstream,
  writeCut,
  writeJsonError,
  writeStream,
} from '../fixtures/domain01-02/mock-upstream.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain02-reply-error-ui.test.mjs'
const KEY = 'sk-testkey-domain02-errors'

const failures = []
const raw = { count: 0 }
const ok = (message) => {
  raw.count += 1
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
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  const count = await nodes.count()
  return count === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/g, ' ').trim()
}
const waitFor = async (page, predicate, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(120)
  }
  return false
}
const waitForText = (page, part, timeout = 30_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

const openChat = async (mock) => {
  mock.state.chatCalls.length = 0
  mock.state.calls.length = 0
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   *
   * 白名单 = 被测产物自己的 origin ∪ **本机真起的 mock 流式上游**（精确 `host:port`，`startMockUpstream`
   * 起在 `127.0.0.1` 的随机端口上，端口在这一刻已知，所以写得出精确值 —— 不用 `allowLoopback`
   * 那种「本机任意端口」的宽口径）。这一档的响应形态（SSE 断流 / 空闲 / 4xx）就是被测物要看的输入，
   * 换成 `page.route` 的假 SSE 等于把「真连接真的被掐断」这件事一起替掉，所以这里是**放行到真服务**
   * 而不是打桩：闸要管的是「有没有打到白名单以外的机器」。
   */
  await installEgressGate(page, { appUrl: APP_URL, allowHosts: [new URL(mock.url).host] })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  return { context, page }
}

const sendChat = async (page, text = '这条会失败') => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: SEND_BUTTON }).first().click()
}

/**
 * 表驱动的 7 行。列就是断言口径：
 *   expectText   界面必须出现的那句话（这一档的招牌文案）
 *   notText      不许出现的串档文案（正则）
 *   calls        回答请求的**准确**次数（终态 1 / 可重试按上限 3）
 *   saysRetryable 文案有没有告诉用户「可以重试」
 *   action       出口动作：apiKey / topUp / null
 */
const ROWS = [
  {
    id: '行 1 401 Key 无效',
    covers: ['F2-05'],
    respond: (res) => writeJsonError(res, 401, { type: 'authentication_error', message: 'invalid api key' }),
    expectText: 'API Key 无效或已被删除',
    notText: /请求过于频繁|余额不足|服务器繁忙|未知错误/,
    calls: 1,
    saysRetryable: false,
    action: 'apiKey',
    timeout: 20_000,
  },
  {
    id: '行 2 429 限流',
    covers: ['F2-07'],
    respond: (res) => writeJsonError(res, 429, { type: 'rate_limit_error', message: 'rate limit exceeded' }),
    expectText: '请求过于频繁',
    notText: /余额不足|API Key 无效|未知错误/,
    calls: 3,
    saysRetryable: true,
    action: null,
    timeout: 40_000,
  },
  {
    id: '行 3 502 服务端繁忙',
    covers: ['F2-07'],
    respond: (res) => writeJsonError(res, 502, { type: 'api_error', message: 'bad gateway' }),
    expectText: '服务器繁忙',
    notText: /余额不足|API Key 无效|请求过于频繁|未知错误/,
    calls: 3,
    saysRetryable: true,
    action: null,
    timeout: 40_000,
  },
  {
    id: '行 4 413 上下文超长',
    covers: ['F2-08'],
    respond: (res) =>
      writeJsonError(res, 413, {
        type: 'invalid_request_error',
        message: "prompt is too long: 210000 tokens > 200000 maximum",
      }),
    expectText: '超出模型的上下文上限',
    notText: /请求过于频繁|服务器繁忙|未知错误/,
    calls: 1,
    saysRetryable: false,
    action: null,
    timeout: 20_000,
  },
  {
    id: '行 5 断流（连接中断）',
    covers: ['F2-09'],
    // 发一块正文后直接结束响应、不发 message_stop
    respond: (res) => writeCut(res, { chunks: ['半句就断了'] }),
    expectText: '连接中断',
    notText: /网络异常|未知错误|服务器繁忙/,
    calls: 1,
    saysRetryable: true,
    action: null,
    timeout: 30_000,
  },
  {
    id: '行 6 空闲超时（上游不再吐字）',
    covers: ['F2-09'],
    // 只发响应头 + 一块正文，然后一直不动：60s 空闲超时（LIMITS.requestTimeouts.idleMs，#568 从 45s 放宽）后收口
    respond: (res) => writeCut(res, { chunks: ['收到一句后上游不动了'] }),
    idle: true,
    expectText: '等待时间过长',
    notText: /连接中断|网络异常|未知错误/,
    calls: 1,
    // 空闲超时的文案是「等待时间过长：连续 N 秒没有收到新内容，可以停止后重新生成」（replyIdleTimeout），不是「可以重试」：
    // 连接还在、上游不动了，出路是换一条连接重生成，而不是干等重试。
    retryHint: /可以停止后重新生成/,
    saysRetryable: false,
    action: null,
    timeout: 90_000,
  },
  {
    id: '行 7 额度不足',
    covers: ['F2-06'],
    respond: (res) =>
      writeJsonError(res, 402, {
        type: 'invalid_request_error',
        message: 'Insufficient balance, please top up your account.',
        code: 'insufficient_balance',
      }),
    expectText: '余额或额度不足',
    notText: /请求过于频繁|服务器繁忙|未知错误/,
    calls: 1,
    saysRetryable: false,
    action: 'topUp',
    timeout: 20_000,
  },
]

/**
 * 行 6 需要「上游发了半句之后就不动了」：`writeCut` 会立刻结束响应（那是行 5 的断流），
 * 所以这里单独用「发一块然后挂住、永不 end」的形态，让客户端自己撞上 45s 空闲超时。
 */
const hangAfterChunk = async (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.flushHeaders?.()
  for (const line of [
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
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '收到一句后上游不动了' },
    })}`,
    '',
  ]) {
    res.write(`${line}\n`)
  }
  // 之后不发任何字节、也不 end：客户端会在 requestTimeouts.idleMs（60s，#568）后按「空闲超时」收口
  await new Promise((resolve) => res.on('close', resolve))
}

const mock = await startMockUpstream()
try {
  for (const row of ROWS) {
    raw.count = 0
    console.log(`\n-- ${row.id}（覆盖 ${row.covers.join(' / ')}）`)
    let context
    try {
      mock.state.respond = async (call, res) => {
        await (row.idle ? hangAfterChunk(res) : row.respond(res))
        // 之后的重试（如果有）同样落到这一行的形态上
        void call
      }
      const opened = await openChat(mock)
      context = opened.context
      const page = opened.page
      await sendChat(page)
      const hit = await waitForText(page, row.expectText, row.timeout)
      const text = await bodyText(page)
      expect(hit, `${row.covers.join('/')} 界面出现这一档文案 ${JSON.stringify(row.expectText)}`)
      if (!hit) {
        console.log(`     ↳ 实际界面：${JSON.stringify(text.slice(0, 260))}`)
      }
      expect(
        !row.notText.test(text),
        `${row.covers.join('/')} 没有被串到别的档（不许出现 ${row.notText}）`
      )
      const calls = mock.state.chatCalls.length
      expect(calls === row.calls, `${row.covers.join('/')} 回答请求次数 = ${row.calls}（实际 ${calls}）`)
      if (row.retryHint) {
        expect(row.retryHint.test(text), `${row.covers.join('/')} 文案给了可走的路（${row.retryHint}）`)
      }
      if (row.saysRetryable) {
        expect(/可以重试|点重新生成|再试/.test(text), `${row.covers.join('/')} 文案告诉用户可以重试`)
      } else {
        expect(!/可以重试/.test(text), `${row.covers.join('/')} 终态错误不误导成「可以重试」`)
      }
      if (row.action === 'apiKey') {
        expect(
          (await page.getByRole('button', { name: /更换 API Key/ }).count()) > 0,
          'F2-05 提示里带「更换 API Key」出口'
        )
      } else if (row.action === 'topUp') {
        const entry = page.getByRole('link', { name: /前往充值|去充值/ }).or(
          page.getByRole('button', { name: /去充值|兑换卡密|前往充值/ })
        )
        expect((await entry.count()) > 0, 'F2-06 提示里带充值 / 卡密出口')
      }
      // 结束态：不管哪一档，界面都要回到「可以继续发」的状态（不许永远转圈）
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        `${row.covers.join('/')} 失败收口后回到可发送态（不是永远生成中）`
      )
      // 断言「半句保留」的行：断流 / 空闲超时都必须把已收到的那半句留在界面上
      if (row.id === '行 5 断流（连接中断）' || row.idle) {
        expect((await answerText(page)).length > 0, `${row.covers.join('/')} 已收到的半句仍然保留在界面上`)
      }
      console.log(`   ${row.id}：${raw.count} 条断言通过（覆盖 ${row.covers.join(' / ')}）`)
    } catch (error) {
      bad(`${row.id} 用例异常：${error instanceof Error ? error.message : String(error)}`)
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
  console.log(`\nPASS ${name}（7 行：F2-05 / F2-07×2 / F2-08 / F2-09×2 / F2-06）`)
}
