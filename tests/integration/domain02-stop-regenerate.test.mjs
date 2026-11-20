// [layer: integration | 依赖: playwright + chromium + 本地静态服务 + 本机 mock 流式上游 | 耗时: 30~60 秒] 说明见 tests/README.md
// Issue #362（域 2「对话主链路」）/ #367：最小充分集第 3/5 条。
//
// #362 盘点里这一格的原话是：
//   F2-03「部分覆盖（缺点击停止的 DOM 断言）」——全仓没有一处 `.click()` 点停止按钮，
//         `full-acceptance` / `real-upstream` 只 `count()` 过它；
//   F2-04「部分覆盖（仅被间接调用）」——`regenerateReply` 只被当「取请求体」的手段，没有版本保留断言。
// 所以这一条的**核心**就是：真的点上停止、真的点重新生成、真的切回上一版。
//
// 覆盖功能点：
//   F2-03 生成中停止（3 行：流到一半停 / 首字未到就停 / **停止后立刻重发** + 停止后会话仍可用）
//   F2-04 重新生成（3 行：停止后重新生成 / 完整回答后重新生成 / 连点两次三个版本）
//   F2-02 流式逐字渲染（停止前断言「已收到的正文已经在 DOM 上」，而不是等整段）
//
// Issue #452 C2（取消后立即重发）加在第 7 行 A4：上一轮被 abort 的请求不能污染新回答 ——
// 旧流迟到的块不许追加到新回答、旧的 abort 信号不许把新请求掐掉、两条消息不许串。
//
// 上传用的是本机 mock 上游（tests/fixtures/domain01-02/mock-upstream.mjs）：
// `page.route` + `route.fulfill` 是一次性把整段 SSE 塞进去，造不出「正在流」的中间态，
// 而「正在流」正是这一格的前提。
//
// 行（表驱动，7 行 = 2 组 × 3 + #452 C2）：
//   A1 流到一半点停止        → F2-03 / F2-02
//   A2 首字未到就点停止      → F2-03
//   A3 停止后同一会话再发一条 → F2-03
//   A4 停止后**立刻**重发     → F2-03 / F2-02（#452 C2：旧流不污染新回答）
//   B1 停止后点重新生成      → F2-04 / F2-03
//   B2 完整回答后重新生成    → F2-04
//   B3 连续两次重新生成      → F2-04
//
// 跑法（先 pnpm build 生成标准包；本脚本自起静态服务与 mock 上游）：
//   node tests/integration/domain02-stop-regenerate.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import {
  configureAnthropicChannel,
  startMockUpstream,
  writePartialThenHang,
  writeStream,
} from '../fixtures/domain01-02/mock-upstream.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain02-stop-regenerate.test.mjs'
const KEY = 'sk-testkey-domain02-stop'

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

const STOP_BUTTON = /^停止生成$/
const SEND_BUTTON = /^发送$/
const REGENERATE = /^重新生成$/

const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  const count = await nodes.count()
  return count === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/g, ' ').trim()
}
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const waitFor = async (page, predicate, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}
const waitForText = (page, part, timeout = 20_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

/** 每行一个干净的页面 + 干净的 mock 上游调用计数 */
const openChat = async (mock) => {
  mock.state.calls.length = 0
  mock.state.chatCalls.length = 0
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  return { context, page }
}

const sendChat = async (page, text = '开始生成吧') => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: SEND_BUTTON }).first().click()
}

/** 点「停止生成」（这就是 #362 说的「全仓没有一处 .click() 点停止」） */
const clickStop = async (page) => {
  const stop = page.getByRole('button', { name: STOP_BUTTON })
  await stop.first().click()
  await page.waitForTimeout(500)
}

/** 切版本之后的断言：等正文真的换成那一版（切换是异步的，固定 sleep 会飘） */
const waitForAnswer = (page, part, timeout = 10_000) =>
  waitFor(page, async () => (await answerText(page)).includes(part), timeout)

const versionSwitcher = (page) => page.locator('[data-message-version]').first()
const versionLabel = async (page) => {
  const switcher = versionSwitcher(page)
  if ((await switcher.count()) === 0) {
    return ''
  }
  return (await switcher.innerText()).replace(/\s+/g, ' ').trim()
}

const ROWS = [
  {
    id: 'A1 流到一半点停止',
    covers: ['F2-03', 'F2-02'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        if (call === 1) {
          await writePartialThenHang(res, { chunks: ['第一段正文', '第二段正文'] })
          return
        }
        await writeStream(res, { chunks: ['第二次回答'] })
      }
    },
    async run(page, mock) {
      await sendChat(page)
      // F2-03 前提：生成中确实有「停止」按钮，且「发送」让位给它
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: STOP_BUTTON }).count()) > 0, 10_000),
        'F2-03 生成中给出「停止生成」按钮'
      )
      expect(
        (await page.getByRole('button', { name: SEND_BUTTON }).count()) === 0,
        'F2-03 生成中「发送」按钮让位（不会误点成再发一条）'
      )
      // F2-02：流式过程中已收到的正文就已经在 DOM 上（不是等整段一次性蹦出）
      expect(
        await waitFor(page, async () => (await answerText(page)).includes('第二段正文'), 10_000),
        'F2-02 流式期间已收到的正文实时上屏（等到第二段）'
      )
      const beforeStop = await answerText(page)
      await clickStop(page)
      // F2-03 立刻停：停止按钮消失、发送按钮回来
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        'F2-03 点停止后立刻回到可发送态（停得下来）'
      )
      expect(
        (await page.getByRole('button', { name: STOP_BUTTON }).count()) === 0,
        'F2-03 点停止后「停止生成」按钮撤下'
      )
      // F2-03 已收内容保留：半句不许被丢
      expect(beforeStop.length > 0, `F2-03 停止前半句已上屏：${JSON.stringify(beforeStop)}`)
      const afterStop = await answerText(page)
      expect(
        afterStop.includes('第一段正文') && afterStop.includes('第二段正文'),
        'F2-03 停止后已收到的内容全部保留（没被丢掉）'
      )
      // 停止之后不许再往里追加（上游还挂着也不会自己继续）
      await page.waitForTimeout(1200)
      expect((await answerText(page)) === afterStop, 'F2-03 停止后正文不再增长（真的停了）')
      // F2-03 失败表现的反向断言：用户自己停的不许被说成「连接中断」
      const text = await bodyText(page)
      expect(!text.includes('连接中断'), 'F2-03 用户主动停止不误报「连接中断」')
      expect(!/生成失败|未知错误/.test(text), 'F2-03 停止不冒错误提示')
      // 停止不是失败：不重发（重试只属于失败分支）
      expect(
        mock.state.chatCalls.length === 1,
        `F2-03 停止后不自动重发请求（回答请求 ${mock.state.chatCalls.length} 次）`
      )
    },
  },
  {
    id: 'A2 首字未到就点停止',
    covers: ['F2-03'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        if (call === 1) {
          // 只有响应头，正文一个字节都不发：一直停在「等待首字」
          await writePartialThenHang(res, { chunks: [] })
          return
        }
        await writeStream(res, { chunks: ['第二次回答'] })
      }
    },
    async run(page, mock) {
      await sendChat(page)
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: STOP_BUTTON }).count()) > 0, 10_000),
        'F2-03 首字未到时也能看到「停止生成」（不是只能干等转圈）'
      )
      await clickStop(page)
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        'F2-03 首字未到时点停止同样立刻回到可发送态'
      )
      const text = await bodyText(page)
      expect(!text.includes('连接中断'), 'F2-03 首字未到就停止，不误报「连接中断」')
      expect(!/未知错误|生成失败/.test(text), 'F2-03 首字未到就停止，不冒错误提示')
      expect((await answerText(page)) === '', 'F2-03 一个 token 都没收到时停止，主区不留半截正文')
      expect(
        mock.state.chatCalls.length === 1,
        `F2-03 停止后不自动重发（回答请求 ${mock.state.chatCalls.length} 次）`
      )
    },
  },
  {
    id: 'A3 停止后同一会话再发一条',
    covers: ['F2-03'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        if (call === 1) {
          await writePartialThenHang(res, { chunks: ['被停下的半句'] })
          return
        }
        await writeStream(res, { chunks: ['停止之后的', '正常回答'] })
      }
    },
    async run(page, mock) {
      await sendChat(page, '第一问')
      await waitFor(page, async () => (await page.getByRole('button', { name: STOP_BUTTON }).count()) > 0, 10_000)
      await clickStop(page)
      // 停止不把这个会话弄坏：还能接着发，并且第二次真的把完整回答收下来
      await sendChat(page, '停止之后的第二问')
      expect(
        await waitForText(page, '正常回答', 20_000),
        'F2-03 停止之后同一会话继续提问，回答正常完整上屏'
      )
      expect(
        mock.state.chatCalls.length === 2,
        `F2-03 第一问只发 1 次 + 第二问 1 次 = 2 次（实际 ${mock.state.chatCalls.length} 次）`
      )
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        'F2-03 第二轮结束后回到可发送态'
      )
    },
  },
  {
    id: 'A4 停止后立刻重发（旧流不污染新回答）',
    covers: ['F2-03', 'F2-02'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        if (call === 1) {
          // 第一轮：吐一块之后挂住。第二块与「点停止」几乎同时到达 —— 就是「旧流迟到的块」。
          await writePartialThenHang(res, { chunks: ['旧流的第一句', '旧流的迟到内容'] })
          return
        }
        await writeStream(res, { chunks: ['新回答的', '完整内容'] })
      }
    },
    async run(page, mock) {
      await sendChat(page, '第一问')
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: STOP_BUTTON }).count()) > 0, 10_000),
        'F2-03 生成中给出「停止生成」按钮'
      )
      expect(
        await waitFor(page, async () => (await answerText(page)).includes('旧流的第一句'), 10_000),
        'F2-02 停止前第一块正文已上屏'
      )
      // 点停止之后**立刻**发下一条：不等待、不刷新（这正是「取消后立即重发」）
      await page.getByRole('button', { name: STOP_BUTTON }).first().click()
      await sendChat(page, '第二问')
      expect(
        await waitForText(page, '完整内容', 20_000),
        'F2-03 取消后立刻重发，新回答完整上屏（没被上一次的 abort 掐掉）'
      )
      await page.waitForTimeout(600)
      const bubbles = page.locator('.ds-assistant-message-main-content')
      const count = await bubbles.count()
      expect(count === 2, `F2-02 两条助手消息各就各位（实际 ${count} 条）`)
      const firstText = count >= 1 ? (await bubbles.nth(0).innerText()).replace(/\s+/g, ' ').trim() : ''
      const secondText = count >= 2 ? (await bubbles.nth(1).innerText()).replace(/\s+/g, ' ').trim() : ''
      // F2-02 不串消息：旧流的迟到内容不许出现在新回答里，新回答也不许回流到上一条
      expect(!secondText.includes('旧流'), 'F2-02 旧流的迟到内容没有串进新回答')
      expect(secondText.includes('新回答的') && secondText.includes('完整内容'), 'F2-02 第二条是新请求的回答')
      expect(!firstText.includes('新回答的'), 'F2-02 新回答没有串回上一条（消息不串）')
      expect(firstText.includes('旧流的第一句'), 'F2-03 被停下的那条仍保留自己已收到的内容')
      // 旧 abort 信号没有被新请求复用：新请求自己正常收尾，界面回到可发送态
      expect(
        await waitFor(page, async () => (await page.getByRole('button', { name: SEND_BUTTON }).count()) > 0, 10_000),
        'F2-03 新回答正常收尾后回到可发送态'
      )
      expect(
        mock.state.chatCalls.length === 2,
        `F2-03 停下 1 次 + 重发 1 次 = 2 次回答请求（实际 ${mock.state.chatCalls.length} 次）`
      )
      const text = await bodyText(page)
      expect(!/连接中断|未知错误/.test(text), 'F2-03 取消后重发不冒断流 / 未知错误提示')
    },
  },
  {
    id: 'B1 停止后点重新生成',
    covers: ['F2-03', 'F2-04'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        if (call === 1) {
          await writePartialThenHang(res, { chunks: ['第一次只说了半句'] })
          return
        }
        await writeStream(res, { chunks: ['第二次', '完整回答'] })
      }
    },
    async run(page, mock) {
      await sendChat(page, '重新生成吧')
      await waitFor(page, async () => (await page.getByRole('button', { name: STOP_BUTTON }).count()) > 0, 10_000)
      // 必须等第一块正文真的上屏再点停止：否则「第 1 版」是空回答，
      // 后面「切回第 1 版能看到停止时的内容」就变成在断言一个不存在的半句（会随机假红）。
      expect(
        await waitFor(page, async () => (await answerText(page)).includes('第一次只说了半句'), 10_000),
        'F2-03 停止前已收到第一块正文'
      )
      await clickStop(page)
      // F2-04：点回答底部的「重新生成」图标（不是通过 store 间接调用）
      const regenerate = page.getByRole('button', { name: REGENERATE })
      expect(
        await waitFor(page, async () => (await regenerate.count()) > 0, 10_000),
        'F2-04 停止后回答底部就有「重新生成」入口'
      )
      await regenerate.first().click()
      expect(
        await waitForText(page, '完整回答', 20_000),
        'F2-04 点重新生成后真的又发了一次请求并流式生成新回答'
      )
      expect(
        mock.state.chatCalls.length === 2,
        `F2-04 重新生成发出第 2 次回答请求（实际 ${mock.state.chatCalls.length} 次）`
      )
      // F2-04 核心：旧回答保留为版本，可切回
      expect(
        await waitFor(page, async () => (await versionLabel(page)).includes('/'), 10_000),
        'F2-04 生成出第二个版本（版本切换器出现）'
      )
      expect((await versionLabel(page)) === '2 / 2', `F2-04 当前停在第 2 版（实际 ${await versionLabel(page)}）`)
      const second = await answerText(page)
      expect(second.includes('第二次') && !second.includes('第一次只说了半句'), 'F2-04 第 2 版显示的是新回答')
      await page.getByRole('button', { name: /^上一个版本$/ }).first().click()
      expect(
        await waitFor(page, async () => (await versionLabel(page)) === '1 / 2', 10_000),
        `F2-04 能切回第 1 版（实际 ${await versionLabel(page)}）`
      )
      expect(
        await waitForAnswer(page, '第一次只说了半句'),
        'F2-04 切回第 1 版能看到停止时的原回答（旧回答没被覆盖）'
      )
      // 切回去不重发请求（只是显示已保存的版本）
      expect(
        mock.state.chatCalls.length === 2,
        'F2-04 切版本不产生新请求（不重复计费）'
      )
    },
  },
  {
    id: 'B2 完整回答后重新生成',
    covers: ['F2-04'],
    async setup(mock) {
      mock.state.respond = async (call, res) => {
        await writeStream(res, { chunks: [call === 1 ? '第一版回答内容' : '第二版回答内容'] })
      }
    },
    async run(page, mock) {
      await sendChat(page, '再生成一次')
      expect(await waitForText(page, '第一版回答内容'), 'F2-04 前置：第一版正常完成')
      await page.getByRole('button', { name: REGENERATE }).first().click()
      expect(await waitForText(page, '第二版回答内容'), 'F2-04 重新生成后新回答上屏')
      expect((await versionLabel(page)) === '2 / 2', `F2-04 版本数变成 2（实际 ${await versionLabel(page)}）`)
      expect(
        mock.state.chatCalls[1]?.body?.messages?.length === 1,
        'F2-04 重新生成的请求仍然只带那一条提问（新回答挂在同一问题下，不是新开一轮）'
      )
      await page.getByRole('button', { name: /^上一个版本$/ }).first().click()
      expect(
        await waitForAnswer(page, '第一版回答内容'),
        'F2-04 切回第 1 版仍是第一版原文（旧回答保留）'
      )
      await page.getByRole('button', { name: /^下一个版本$/ }).first().click()
      expect(
        await waitForAnswer(page, '第二版回答内容'),
        'F2-04 再切回第 2 版（两个版本都能来回看）'
      )
    },
  },
  {
    id: 'B3 连续两次重新生成',
    covers: ['F2-04'],
    async setup(mock) {
      const texts = ['版本一内容', '版本二内容', '版本三内容']
      mock.state.respond = async (call, res) => {
        await writeStream(res, { chunks: [texts[call - 1] ?? '多余版本'] })
      }
    },
    async run(page, mock) {
      await sendChat(page, '连点两次')
      expect(await waitForText(page, '版本一内容'), 'F2-04 前置：第 1 版完成')
      await page.getByRole('button', { name: REGENERATE }).first().click()
      expect(await waitForText(page, '版本二内容'), 'F2-04 第 2 版完成')
      await page.getByRole('button', { name: REGENERATE }).first().click()
      expect(await waitForText(page, '版本三内容'), 'F2-04 第 3 版完成')
      expect((await versionLabel(page)) === '3 / 3', `F2-04 三个版本都在（实际 ${await versionLabel(page)}）`)
      // 从最新往回逐版本切，每一版都能看到各自的内容（不是相互覆盖）
      await page.getByRole('button', { name: /^上一个版本$/ }).first().click()
      expect(await waitForAnswer(page, '版本二内容'), 'F2-04 第 2 版可切回')
      await page.getByRole('button', { name: /^上一个版本$/ }).first().click()
      expect(await waitForAnswer(page, '版本一内容'), 'F2-04 第 1 版可切回（三版互不覆盖）')
      expect(
        mock.state.chatCalls.length === 3,
        `F2-04 三次回答请求各一次（实际 ${mock.state.chatCalls.length} 次）`
      )
    },
  },
]

const mock = await startMockUpstream()
try {
  for (const row of ROWS) {
    raw.count = 0
    console.log(`\n-- ${row.id}（覆盖 ${row.covers.join(' / ')}）`)
    let context
    try {
      await row.setup(mock)
      const opened = await openChat(mock)
      context = opened.context
      await row.run(opened.page, mock)
      console.log(`   ${row.id}：${raw.count} 条断言通过（覆盖 ${row.covers.join(' / ')}）`)
    } catch (error) {
      bad(`${row.id} 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context?.close()
    }
  }
} finally {
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
  console.log(`\nPASS ${name}（7 行 = F2-03 停止 4 行（含 #452 C2 取消后立刻重发）/ F2-04 重新生成 3 行）`)
}
