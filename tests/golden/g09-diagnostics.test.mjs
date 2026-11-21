// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 本机 mock 上游 | 预算: ≤60s]
//
// 黄金回归 · 域 9「诊断」（Issue #404 第二批）。**只跑 1 条主路径**：
//   触发一次真实失败 → 用户点「复制诊断信息」→ 复制出的内容已脱敏
//
// 为什么这条值钱：这段文本是**用户会直接贴进 Issue / 工单**的东西。它一旦不脱敏，
// 泄漏的不是日志而是账号：API Key、设备码（= 账号）、卡密、手机号原文都会跟着飞出去（#387 的 15 格红）。
// 所以这条路径同时钉住两件事：**失败之后还有可自证的诊断出口**（#324：不是一句「未知错误」），
// 以及**出口里的值是打过码的**（#387 的值维度脱敏，`redact()` 的留尾 4 位口径）。
//
// 与 L0/L1 的分工（tests/unit/domain08-redact-* 已逐条覆盖脱敏规则与负例、diagnostics.test.mjs
// 已覆盖采集/环形缓冲/上传）：这里**不重测规则表**，只验「用户真的点得着这个按钮、拿到的是脱敏后的文本」。
//
// 上游用本机 mock（tests/fixtures/domain01-02/mock-upstream.mjs）：418 + 一段**带满敏感值**的英文报错，
// 这是「未分类失败」的典型形态（有状态码、无可读中文、没有上游 code）——正是会给出可复制诊断的那一档。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g09-diagnostics.test.mjs
import { configureAnthropicChannel, startMockUpstream, writeJsonError } from '../fixtures/domain01-02/mock-upstream.mjs'
import { sendChat } from '../helpers/helpers.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g09-0123456789abcdef'
const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const CARD = 'GOLD-1234-5678-9012-ABCD'
const PHONE = '13800138000'
const TOKEN = 'golden-token-7f3a91'
/** 上游原文：一段「什么都带一点」的英文报错（英文 → 界面不给原文，只给可复制的诊断） */
const UPSTREAM_MESSAGE = `upstream rejected the request: key ${KEY} device ${DEVICE_ID} card ${CARD} phone ${PHONE} token=${TOKEN}`

/** 剪贴板桩：把「复制」的落点收在页面里（headless 下真剪贴板不可靠） */
const clipboardStub = () => {
  window.__goldenCopied = ''
  const writeText = async (text) => {
    window.__goldenCopied = String(text ?? '')
  }
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  } catch {
    navigator.clipboard = { writeText }
  }
}

const result = await runGolden(
  { id: 'G9', domain: '诊断', title: '触发错误 → 诊断复制内容已脱敏' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const mock = await startMockUpstream()
    // 418：不参与退避重试（不是 429/5xx），且没有上游 code → 落到「可复制诊断」那一档
    mock.state.respond = async (_call, res) =>
      writeJsonError(res, 418, { message: UPSTREAM_MESSAGE })
    // 出站总闸：只放行本机 mock 上游（端口 0），别的 host 一律拦下并记账（#667 跟进）
    const { page, close, guard } = await openGoldenPage(app.url, {
      initScripts: [{ fn: clipboardStub, arg: null }],
      backends: { allowHosts: [new URL(mock.url).host] },
    })
    try {
      await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForBoot(page)

      // ── 1. 触发错误：发一条消息，上游 418 拒绝 ────────────────────────────────
      ctx.begin('触发错误')
      await sendChat(page, '这条提问会被上游拒绝')
      const copyButton = page.getByRole('button', { name: /^复制诊断信息$|^Copy diagnostics$/ }).first()
      const failedWithEntry = await waitFor(page, async () => (await copyButton.count()) > 0)
      if (!failedWithEntry) {
        ctx.abort(
          '失败后给出「复制诊断信息」出口（不是只一句「未知错误」）',
          '存在按钮「复制诊断信息」',
          `body=${brief(await bodyText(page))}`
        )
      }
      const noticeText = await bodyText(page)
      ctx.expect('失败提示里带上可自证的信息（HTTP 418）', /418/.test(noticeText), {
        expected: 'body 含「418」',
        actual: brief(noticeText),
      })

      // ── 2. 复制诊断：点按钮，文本落到剪贴板 ──────────────────────────────────
      ctx.begin('复制诊断信息')
      await copyButton.click()
      const copiedReady = await waitFor(page, async () => (await page.evaluate(() => window.__goldenCopied)) !== '')
      const copied = await page.evaluate(() => window.__goldenCopied)
      if (!copiedReady) {
        ctx.abort('点「复制诊断信息」把文本写进剪贴板', '非空文本', '（剪贴板为空）')
      }
      ctx.expect('复制内容是一份可贴进 Issue 的诊断', copied.includes('DeepSeek 回答失败诊断') && copied.includes('HTTP 状态: 418'), {
        expected: '含「DeepSeek 回答失败诊断」+「HTTP 状态: 418」',
        actual: brief(copied),
      })
      ctx.expect('复制成功后界面给出提示', /诊断信息已复制/.test(await bodyText(page)), {
        expected: 'body 含「诊断信息已复制」',
        actual: brief(await bodyText(page)),
      })

      // ── 3. 已脱敏：密钥 / 设备码 / 卡密 / 手机号 / token 都不原文出现 ──────────
      ctx.begin('脱敏')
      const leaks = [
        ['API Key', KEY],
        ['设备码', DEVICE_ID],
        ['卡密', CARD],
        ['手机号', PHONE],
        ['token', TOKEN],
      ].filter(([, value]) => copied.includes(value))
      ctx.expect('复制内容里没有任何一项敏感值原文', leaks.length === 0, {
        expected: '0 项原文泄漏',
        actual: leaks.map(([name]) => name).join(',') || '0 项',
      })
      // 正向：脱敏不是「整段删掉」，而是按口径留尾 4 位 / 打 ***，仍然能用于排查
      ctx.expect('密钥被打成 sk-***', copied.includes('sk-***') && !copied.includes(KEY), {
        expected: '含「sk-***」且不含完整 Key',
        actual: brief(copied),
      })
      ctx.expect('token 值的整段被打掉（token=***）', copied.includes('token=***') && !copied.includes(TOKEN), {
        expected: '含「token=***」',
        actual: brief(copied),
      })
      ctx.expect('设备码 / 卡密 / 手机号只留尾 4 位', ['cdef', 'ABCD', '8000'].every((tail) => copied.includes(`••••${tail}`)), {
        expected: '含 ••••cdef / ••••ABCD / ••••8000',
        actual: brief(copied, 200),
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
