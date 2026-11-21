// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 本机 mock 流式上游 | 预算: ≤60s]
//
// 黄金回归 · 域 2「对话」（Issue #404）。**只跑 1 条主路径**：
//   发送 → 流式接收 → 停止 → 重新生成
//
// 为什么这条进第一批：对话是产品的全部价值所在，而「流式 + 可停止 + 可重生成」正好是最容易
// 被一次重构弄断的三段（异步状态机）。L1 的 domain02 用例有 6 行（首字未到就停、连点三次、
// 切版本回看…），那些是分支细节，这里不重复。
//
// 上游用 tests/fixtures/domain01-02/mock-upstream.mjs：`page.route` 一次性把整段 SSE 塞进去
// 造不出「正在流」的中间态，而「正在流」正是这条主路径的前提。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g02-chat.test.mjs
import {
  configureAnthropicChannel,
  startMockUpstream,
  writePartialThenHang,
  writeStream,
} from '../fixtures/domain01-02/mock-upstream.mjs'
import { sendChat } from '../helpers/helpers.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g02'
const FIRST_PIECE = '第一段正文'
const FINAL_ANSWER = '重新生成后的完整回答'

/** 最后一条回答的正文（与 L1 用同一个内容选择器） */
const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  return (await nodes.count()) === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

const result = await runGolden(
  { id: 'G2', domain: '对话', title: '发送 → 流式接收 → 停止 → 重新生成' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const mock = await startMockUpstream()
    // 第 1 次回答：吐两块正文后挂住（造「正在流」），第 2 次（重新生成）：完整回答
    mock.state.respond = async (call, res) => {
      if (call === 1) {
        await writePartialThenHang(res, { chunks: [FIRST_PIECE, '第二段正文'] })
        return
      }
      await writeStream(res, { chunks: [FINAL_ANSWER] })
    }
    // 出站总闸：本机 mock 上游（端口 0）显式放行，别的 host 一律拦下并记账（#667 跟进）
    const { page, close, guard } = await openGoldenPage(app.url, {
      backends: { allowHosts: [new URL(mock.url).host] },
    })
    try {
      await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForBoot(page)

      // ── 1. 发送：一条提问发出去，输入框让位给「停止生成」 ────────────────────────
      ctx.begin('发送')
      await sendChat(page, '黄金主路径提问')
      const started = await waitFor(page, async () => (await page.getByRole('button', { name: /^停止生成$/ }).count()) > 0)
      if (!started) {
        ctx.abort('出现「停止生成」按钮（请求已发出、正在生成）', '按钮「停止生成」存在', `body=${brief(await bodyText(page))}`)
      }

      // ── 2. 流式接收：正文边收边上屏（不是等整段一次性蹦出） ──────────────────────
      ctx.begin('流式接收')
      const streamed = await waitFor(page, async () => (await answerText(page)).includes('第二段正文'))
      ctx.expect('流式期间已收到的正文已在 DOM 上', streamed, {
        expected: `回答区含「${FIRST_PIECE}」「第二段正文」`,
        actual: `回答区=${brief(await answerText(page))}`,
      })

      // ── 3. 停止：点下去就真的停，已收到的内容保留 ──────────────────────────────
      ctx.begin('停止')
      await page.getByRole('button', { name: /^停止生成$/ }).first().click()
      const stopped = await waitFor(page, async () => (await page.getByRole('button', { name: /^发送$/ }).count()) > 0)
      ctx.expect('点停止后立刻回到可发送态', stopped, {
        expected: '「发送」按钮回来',
        actual: `body=${brief(await bodyText(page))}`,
      })
      const kept = await answerText(page)
      ctx.expect('停止不丢已收到的正文', kept.includes(FIRST_PIECE), {
        expected: `回答区仍含「${FIRST_PIECE}」`,
        actual: `回答区=${brief(kept)}`,
      })

      // ── 4. 重新生成：同一问题再生成一版，新回答上屏 ────────────────────────────
      ctx.begin('重新生成')
      const regenerate = page.getByRole('button', { name: /^重新生成$/ })
      const hasRegenerate = await waitFor(page, async () => (await regenerate.count()) > 0)
      if (!hasRegenerate) {
        ctx.abort('回答底部有「重新生成」入口', '存在按钮「重新生成」', `body=${brief(await bodyText(page))}`)
      }
      await regenerate.first().click()
      const regenerated = await waitFor(page, async () => (await answerText(page)).includes(FINAL_ANSWER))
      ctx.expect('重新生成后新回答上屏', regenerated, {
        expected: `回答区含「${FINAL_ANSWER}」`,
        actual: `回答区=${brief(await answerText(page))}`,
      })
      ctx.expect('重新生成真的又发了一次回答请求', mock.state.chatCalls.length === 2, {
        expected: '回答请求 2 次（首发 1 + 重新生成 1）',
        actual: `${mock.state.chatCalls.length} 次`,
      })

      // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ──────────────
      ctx.begin('不连真实服务')
      guard.assertNoLeak(ctx)
    } finally {
      await close()
      await mock.close()
      await app.close()
    }
  }
)

export default result
