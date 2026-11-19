// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 本机 mock 上游 | 预算: ≤60s]
//
// 黄金回归 · 域 3「渠道」（Issue #404 第二批）。**只跑 1 条主路径**：
//   切渠道（DeepSeek 官方 → Anthropic 协议）→ Key 校验 → 发一条消息成功
//
// 为什么这条值钱：渠道切换是「一次配置改动就静默打断所有请求」的地方 —— 地址/模型/鉴权头任何一项
// 接错，界面都不报错，只是消息永远发不出去（或打到上一家渠道）。这里把三件套填进设置页，
// 用**用户点得着的「测试」按钮**验一次连通性，再真的发一条消息，并核对请求落在新渠道的
// 路径（`/v1/messages`）与鉴权头（`x-api-key`，Anthropic 协议**不带** anthropic-version）。
//
// 与 L1 的分工（tests/integration/provider-channels.test.mjs 已有四渠道 × 入口 × 请求体矩阵）：
// 这里**不**重复四个渠道的入口显隐、不重复请求体逐字节对比、不重复能力文案检查，
// 只回答一个问题：**普通用户把渠道切过去、把 Key 填对、点测试、再发一句话，还通不通。**
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g03-channel.test.mjs
import { configureAnthropicChannel, startMockUpstream, writeStream } from '../fixtures/domain01-02/mock-upstream.mjs'
import {
  captureProbeRequests,
  clickTest,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  selectProviderKind,
  sendChat,
} from '../helpers/helpers.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g03-0123456789abcdef'
const MODEL = 'mock-model'
/** 上游回答正文：只在「真的发出去了」时才可能出现在回答区 */
const ANSWER = '渠道切换后的回答'

const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  return (await nodes.count()) === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

const result = await runGolden(
  { id: 'G3', domain: '渠道', title: '切渠道 → Key 校验 → 发一条消息成功' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const mock = await startMockUpstream()
    mock.state.respond = async (_call, res) => writeStream(res, { chunks: [ANSWER] })
    // 探测请求（GET {baseUrl}/v1/models）由 mock 上游的 /models 路由应答，这里只负责记录
    const { page, close } = await openGoldenPage(app.url, { storage: {} })
    const probes = captureProbeRequests(page)
    try {
      await waitForBoot(page)

      // ── 1. 切渠道：服务类型 → Anthropic 协议，露出地址 / 模型 / Key 三件套 ──────────
      ctx.begin('切渠道')
      if ((await page.getByRole('dialog').count()) === 0) {
        await page
          .getByRole('button', { name: /设置|Settings/ })
          .last()
          .click()
      }
      await page
        .getByRole('tab', { name: /数据管理|Data/ })
        .first()
        .click()
      await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)
      const threeFields = await waitFor(
        page,
        async () =>
          (await page.locator('input[inputmode="url"]').count()) === 1 &&
          (await page.getByLabel(/^模型$|^Model$/).count()) === 1 &&
          (await page.locator('input[type="password"]').count()) === 1
      )
      if (!threeFields) {
        ctx.abort(
          '切到 Anthropic 协议后露出「服务地址 + 模型 + API Key」三件套',
          'url=1 / 模型=1 / password=1',
          `body=${brief(await bodyText(page))}`
        )
      }
      // 地址指到本机 mock 上游：不连真实服务，但走的是真实请求路径
      await fillBaseUrl(page, mock.url)
      await fillModel(page, MODEL)
      await fillApiKey(page, KEY)
      await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
      const stored = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
      if (stored !== KEY) {
        ctx.abort('Key 落盘（chat-demo:api-key）', KEY, String(stored))
      }

      // ── 2. Key 校验：点「测试」→ GET {baseUrl}/v1/models + x-api-key → 一句可读结论 ──
      ctx.begin('Key 校验')
      await clickTest(page)
      const probed = await waitFor(page, async () => probes.length > 0)
      if (!probed) {
        ctx.abort(
          '点「测试」真的发出一次模型列表探测',
          `GET ${mock.url}/v1/models`,
          `body=${brief(await bodyText(page))}`
        )
      }
      ctx.expect('探测打的是刚填的那条地址', probes[0].url === `${mock.url}/v1/models`, {
        expected: `${mock.url}/v1/models`,
        actual: probes[0].url,
      })
      ctx.expect('探测用 x-api-key 带上刚填的 Key（Anthropic 协议）', probes[0].apiKey === KEY, {
        expected: 'x-api-key = 刚填的那把 Key',
        actual: `x-api-key=${probes[0].apiKey === undefined ? '（没带）' : '带了'} / authorization=${probes[0].authorization === undefined ? '（没带）' : '带了'}`,
      })
      const probeOk = await waitFor(page, async () => (await bodyText(page)).includes('连接成功'))
      ctx.expect('校验结论是「连接成功」', probeOk, {
        expected: 'body 含「连接成功（HTTP 200）」',
        actual: `body=${brief(await bodyText(page))}`,
      })

      // ── 3. 发一条消息：请求落到新渠道，正文上屏 ──────────────────────────────────
      ctx.begin('发一条消息')
      const dialog = page.getByRole('dialog').first()
      if ((await dialog.count()) > 0) {
        await dialog
          .getByRole('button', { name: /^关闭$|^Close$/ })
          .first()
          .click()
          .catch(() => {})
      }
      await waitFor(page, async () => (await page.locator('textarea').count()) > 0)
      await sendChat(page, '渠道切换后的第一条提问')
      const answered = await waitFor(page, async () => (await answerText(page)).includes(ANSWER))
      ctx.expect('回答上屏（流式正文出现在回答区）', answered, {
        expected: `回答区含「${ANSWER}」`,
        actual: `回答区=${brief(await answerText(page))}`,
      })
      const call = mock.state.chatCalls[0]
      if (!call) {
        ctx.abort('发出的回答请求落到新渠道', '≥1 次 POST /v1/messages', '0 次')
      }
      const pathname = new URL(call.url, mock.url).pathname
      ctx.expect('请求打到 Anthropic 协议的 /v1/messages', pathname === '/v1/messages', {
        expected: '/v1/messages',
        actual: pathname,
      })
      ctx.expect('请求头带 x-api-key 且不带 anthropic-version（中转 CORS 口径）', call.headers['x-api-key'] === KEY && !call.headers['anthropic-version'], {
        expected: 'x-api-key 带上 Key，且没有 anthropic-version',
        actual: `x-api-key=${call.headers['x-api-key'] === KEY ? '对' : '不对/缺失'}，anthropic-version=${call.headers['anthropic-version'] === undefined ? '（没带）' : '带了'}`,
      })
      // 兜底：configureAnthropicChannel 只用来证明「同样的渠道配置也能被 localStorage 直接表达」，
      // 这里不调用它 —— 保留导入是为了让「本地存储键名」这层契约在改动时立刻红。
      void configureAnthropicChannel
    } finally {
      await close()
      await mock.close()
      await app.close()
    }
  }
)

export default result
