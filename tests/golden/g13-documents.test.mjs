// [layer: golden | 依赖: playwright + chromium + 标准产物 dist（CI 用 TEST_AUTH_SEAM=1 构建）+ 本机 mock 流式上游 + 真夹具 tiny.* | 预算: ≤60s]
//
// 黄金回归 · 域「文档附件」（A 线 #480；设计定调见 #404；#567 缺的 g13）：
//
//   选 tiny.txt → 解析成功（卡片 success）→ 发送「帮我总结」→ 收到回复
//
// 为什么只跑这一段：黄金层是「用户主路径还在不在」的哨兵，不是分支矩阵。文档域的细节分支
// （六种编码 / 空文件 / 加密 PDF / zip 炸弹 / 表格合并 / 跨页切分 / 预算截断 / 五态流转 /
// 取消与重试）都在 L0（`tests/unit/attachments-*`、`parsers-*`）与 L1（`fixtures/480/`）里，
// 这里**一条都不重复**：一条断言如果删掉它别处还有用例会因同一处坏掉而红，它就不该出现在这里。
//
// 只断三件事（#567 的清单，一条不多）：
//   ① 附件卡片进入 **success**（输入区卡片显示「已就绪」，不是「等待解析」「部分内容已就绪」「解析失败」）；
//   ② 上行 user message 里含 `<document name="tiny.txt">` 文本块，且正文真的是夹具内容
//      ——**请求体经真实链路取**：真 `AttachmentManager`（IndexedDB 落原件 + 真解析）→ 真
//      `parseTxtFile` → 真 `buildWithDocuments()` 注入 → 真 `buildMessageBody()` 组装 →
//      在**上游那一端**（本机 mock 的 HTTP 服务）把 POST 的 body 抓下来，不读任何中间变量；
//   ③ 请求体里**没有** base64 / 没有 `file_id` / 没有 `{type:'document'}` 块
//      （#480 §7 的硬约束：文档是当普通文本注进去的，不上传二进制、不 Base64、不要求原生文件能力）。
//
// 顺带覆盖 DOCX / PDF（同一份文件里的第二步，不是第二条路径）：只断「解析出非空正文 +
// 表格标记 `| 甲 | 乙 |` / 页码标记 `[第1页]` 在请求体里」，**不断言解析细节**（那是 L0 的事）。
//
// 后端全桩、一个真请求都不发：上游是 `tests/fixtures/domain01-02/mock-upstream.mjs`（端口 0，
// 内核分配，只认 `POST /messages`），渠道指向它（anthropic 协议，`textInjection: true`）。
// 夹具是**真二进制**（`tests/fixtures/golden/tiny.*`，随仓库入库）：不手拼 base64、不内联字节。
//
// 跑法（仓库根目录）：
//   TEST_AUTH_SEAM=1 pnpm run build      # 与 CI 的 golden job 同一条构建命令（登录接缝）
//   node --test tests/golden/g13-documents.test.mjs
//   node tests/run-golden.mjs --only g13 # 走黄金 runner（并行 + 耗时 + 一句话失败定位）
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { configureAnthropicChannel, startMockUpstream, writeStream } from '../fixtures/domain01-02/mock-upstream.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g13-000000000000000013'
/** 输入框里那句话：请求体尾部的「用户问题：<原文>」要逐字是它 */
const QUESTION = '帮我总结'

/** 夹具按真文件读（**不要**手拼字节 / 不要内联 base64，见 README「夹具怎么用」） */
const fixture = async (name) => readFile(new URL(`../fixtures/golden/${name}`, import.meta.url))

/** 三个夹具的 MIME：与 `manager.ts` 的 `MIME_BY_EXTENSION` 双判对得上，否则会以 mime-mismatch 被拒 */
const MIME = {
  'tiny.txt': 'text/plain',
  'tiny.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'tiny.pdf': 'application/pdf',
}

/** 文档附件入口（#480 / #527）：`accept=".txt,.docx,.pdf"` 的那个隐藏 input，走它自己的 onChange */
const docInput = (page) => page.locator('input[type=file][accept=".txt,.docx,.pdf"]')

/** 选中若干夹具（真 File 对象 + 真 MIME，走 UI 的 addFile → parse → 卡片那条路） */
const pickFixtures = async (page, names) => {
  await docInput(page).setInputFiles(
    await Promise.all(
      names.map(async (name) => ({ name, mimeType: MIME[name], buffer: await fixture(name) }))
    )
  )
}

/** 输入区的附件卡片：`AttachmentCard` 带 `role=button` + `aria-label=查看附件详情`，标题是文件名 */
const docCard = (page, filename) =>
  page.getByRole('button', { name: '查看附件详情' }).filter({ hasText: filename })

/** 卡片的状态行原文（`已就绪` / `等待解析` / `部分内容已就绪 · N 条警告` / `解析失败`） */
const cardStatus = async (card) => {
  const line = card.locator('[class*="statusText"]').first()
  return (await line.count()) === 0 ? '' : (await line.innerText()).replace(/\s+/gu, ' ').trim()
}

/** 消息正文：`content` 是字符串就取它，是块数组就取其中 text 块（与 `inject.ts::textOf` 同口径） */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
      : ''

/** 请求体里本轮的那条 user 消息（最后一条 user = 这一轮的提问，历史在它前面） */
const lastUserText = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return textOf(messages[index].content)
    }
  }
  return ''
}

/** 取 `<document name="…">` 那一块（含块头块尾）：用来只对某一份附件做断言，不被别人兜住 */
const documentBlockOf = (text, filename) => {
  const start = text.indexOf(`<document name="${filename}">`)
  if (start < 0) {
    return ''
  }
  const end = text.indexOf('</document>', start)
  return end < 0 ? '' : text.slice(start, end + '</document>'.length)
}

/**
 * ③ 的判据：一份请求体里**绝不该出现**的东西。
 *
 * 返回命中的项（空数组 = 通过），失败时把「命中了什么」原样写进一句话里，
 * 而不是只说「断言不成立」——负向验证要求能一眼看出是哪一种形态漏了进来。
 */
const forbiddenIn = (raw) => {
  const hits = []
  if (/file_id/u.test(raw)) {
    hits.push('file_id')
  }
  if (/["']?type["']?\s*:\s*["'](?:document|file|image)["']/u.test(raw)) {
    hits.push('{type:document|file|image} 块')
  }
  if (/;base64,/iu.test(raw) || /data:[a-z]+\/[a-z0-9.+-]+;/iu.test(raw)) {
    hits.push('base64 data URI')
  }
  // 无前缀的裸 base64（上传形态常常只有一串）：300 字符以上的纯 base64 字母表连着跑，
  // 中文 / 空格 / 标点都会打断它，所以这条判据在真文档正文上不会误伤
  const longToken = /[A-Za-z0-9+/]{300,}={0,2}/u.exec(raw)
  if (longToken !== null) {
    hits.push(`长 base64 串（${longToken[0].length} 字符）`)
  }
  return hits
}

test('G13 文档附件：选 tiny.txt → 解析成功 → 发送「帮我总结」→ 收到回复', async () => {
  const app = await serveGoldenApp()
  const mock = await startMockUpstream()
  // 上游的回答：一句能一眼认出「这一轮真的走完了」的正文（不断言措辞，只断言它到了）
  mock.state.respond = async (call, res) => {
    await writeStream(res, { chunks: ['总结如下：', '夹具三段话，', `第 ${call} 轮。`] })
  }
  // 出站总闸：只放行本机 mock 上游（端口 0），别的 host 一律拦下并记账（#667 跟进）
  const { page, close, guard } = await openGoldenPage(app.url, {
    backends: { allowHosts: [new URL(mock.url).host] },
  })
  try {
    // 渠道指向本机 mock（anthropic 协议 = `textInjection: true` 的那一档）；
    // 走 DeepSeek 官方档会**整条闸关掉**，那样这条用例测的就不是文档主路径了。
    await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForBoot(page)

    const result = await runGolden(
      { id: 'G13', domain: '文档附件', title: '选 tiny.txt → 解析成功 → 发送「帮我总结」→ 收到回复' },
      async (ctx) => {
        // ── 1. 选文件：真 input[type=file] 走 UI 的 addFile → parse ─────────────────
        ctx.begin('选择 tiny.txt')
        await pickFixtures(page, ['tiny.txt'])
        const card = docCard(page, 'tiny.txt')
        const appeared = await waitFor(page, async () => (await card.count()) > 0)
        if (!appeared) {
          ctx.abort('选完文件后输入区出现附件卡片', '一张 tiny.txt 的卡片', `body=${brief(await bodyText(page))}`)
        }

        // ── 2. ① 解析成功：卡片进入 success（状态行逐字是「已就绪」）──────────────────
        ctx.begin('解析成功')
        // 注意「部分内容已就绪 · N 条警告」也含「已就绪」三个字，所以这里比的是**整行相等**：
        // 把 partial 当成 success 放过去，正是这条主路径最容易出现的假绿。
        const ready = await waitFor(page, async () => (await cardStatus(card)) === '已就绪')
        ctx.expect('卡片进入 success（状态行 = 已就绪，不是等待解析 / 部分内容已就绪 / 解析失败）', ready, {
          expected: '已就绪',
          actual: `${brief(await cardStatus(card))}（卡片=${brief(await card.innerText())}）`,
        })

        // ── 3. 发送「帮我总结」并收到回复 ───────────────────────────────────────────
        ctx.begin('发送并收到回复')
        const textarea = page.locator('textarea').last()
        await textarea.click()
        await textarea.fill(QUESTION)
        await page.getByRole('button', { name: /^发送$/ }).first().click()
        const answered = await waitFor(page, async () => {
          const nodes = page.locator('.ds-assistant-message-main-content')
          return (await nodes.count()) > 0 && (await nodes.last().innerText()).includes('总结如下：')
        })
        ctx.expect('回复上屏（这一轮的请求真的走完并流回来了）', answered, {
          expected: '回答区含「总结如下：」',
          actual: `body=${brief(await bodyText(page))}`,
        })
        const sent = mock.state.chatCalls.length === 1
        ctx.expect('上行只发了 1 次回答请求（附件没有触发额外的上传 / 重发）', sent, {
          expected: '1 次回答请求',
          actual: `${mock.state.chatCalls.length} 次（${brief(mock.state.chatCalls.map((call) => call.url).join(' | '))}）`,
        })
        if (mock.state.chatCalls.length === 0) {
          ctx.abort('上游收到本轮请求', '1 次 POST /messages', '0 次（请求根本没发出去，后面的断言无从谈起）')
        }

        /**
         * ── 4. ② 上行 user message 含 `<document name="…">` 文本块 ──────────────────
         *
         * 证据来自**上游那一端**：mock 的 HTTP 服务把收到的 body 原样存下来（`state.chatCalls`），
         * 所以这里看到的就是「真 manager + 真 parser + 真 buildWithDocuments + 真 buildMessageBody」
         * 一路拼出来、并真的发出去的字节，不读任何中间变量。
         */
        ctx.begin('注入文本块')
        const body = mock.state.chatCalls[0].body
        const injected = lastUserText(body)
        const block = documentBlockOf(injected, 'tiny.txt')
        ctx.expect('上行 user message 里含 `<document name="tiny.txt">` 文本块', block !== '', {
          expected: '<document name="tiny.txt"> … </document>',
          actual: brief(injected),
        })
        ctx.expect(
          '块里是夹具真正文（真解析器读出来的那段话，不是文件名占位）',
          block.includes('黄金夹具 tiny.txt：中文一段。') && block.includes('第三段 end.'),
          { expected: '夹具正文的段首与段尾都在块内', actual: brief(block) }
        )
        ctx.expect('原始提问跟在块后面（`用户问题：<原文>`），没被吞掉', injected.includes(`用户问题：${QUESTION}`), {
          expected: `用户问题：${QUESTION}`,
          actual: brief(injected),
        })

        // ── 5. ③ 请求体里没有 base64 / file_id / document 块 ────────────────────────
        ctx.begin('没有二进制与文件引用')
        const raw = JSON.stringify(body)
        const hits = forbiddenIn(raw)
        ctx.expect('请求体里没有 base64 / file_id / {type:document|file|image} 块', hits.length === 0, {
          expected: '一处都没有',
          actual: hits.length === 0 ? '干净' : `命中：${hits.join('、')}`,
        })
        // 形态证据：文档是**当普通文本**注进去的 —— user content 必须还是纯字符串。
        // 一旦有人把它改成「文本块 + 文件块」数组，这里会先红（比只看 JSON 里有没有 <document> 更严）。
        const user = [...body.messages].reverse().find((message) => message.role === 'user')
        ctx.expect('上行 user content 仍是纯字符串（文本注入，不是块数组）', typeof user?.content === 'string', {
          expected: 'content 是 string',
          actual: `${typeof user?.content}${Array.isArray(user?.content) ? `（${user.content.map((item) => item?.type).join(',')}）` : ''}`,
        })

        // ── 6. 顺带覆盖 DOCX / PDF：只断「非空正文 + 表格/页码标记」────────────────────
        ctx.begin('顺带：DOCX / PDF')
        await pickFixtures(page, ['tiny.docx', 'tiny.pdf'])
        const docxCard = docCard(page, 'tiny.docx')
        const pdfCard = docCard(page, 'tiny.pdf')
        const bothParsed = await waitFor(page, async () => {
          // 「解析中 / 等待解析」都不是结论，等到两张卡都给出终态再发送（`canSend` 也卡在这里）
          const states = [await cardStatus(docxCard), await cardStatus(pdfCard)]
          return states.every((line) => line !== '' && !/等待解析|解析中/u.test(line))
        })
        if (!bothParsed) {
          ctx.abort('DOCX / PDF 两张卡片都解析完', '两张卡都有终态状态行', `body=${brief(await bodyText(page))}`)
        }
        ctx.expect('DOCX / PDF 都没有落到解析失败', !/解析失败/u.test(`${await cardStatus(docxCard)}${await cardStatus(pdfCard)}`), {
          expected: '两张卡都不是「解析失败」',
          actual: `docx=${brief(await cardStatus(docxCard))} / pdf=${brief(await cardStatus(pdfCard))}`,
        })
        await textarea.click()
        await textarea.fill('这两份说了什么')
        await page.getByRole('button', { name: /^发送$/ }).first().click()
        const replied = await waitFor(page, async () => mock.state.chatCalls.length === 2)
        if (!replied) {
          ctx.abort('第二轮请求发出', '第 2 次 POST /messages', `${mock.state.chatCalls.length} 次`)
        }
        const round2 = lastUserText(mock.state.chatCalls[1].body)
        const docxBlock = documentBlockOf(round2, 'tiny.docx')
        const pdfBlock = documentBlockOf(round2, 'tiny.pdf')
        // 只断「非空正文 + 标记存在」：表格怎么展开、页码怎么切是 L0 的事，这里不重复
        ctx.expect('DOCX 正文非空且表格被展开成 Markdown 行（`| 甲 | 乙 |`）', docxBlock.length > 40 && docxBlock.includes('| 甲 | 乙 |'), {
          expected: '块内有 `| 甲 | 乙 |` 且正文非空',
          actual: brief(docxBlock),
        })
        ctx.expect('PDF 正文非空且带页码标记（`[第1页]`）', pdfBlock.length > 30 && pdfBlock.includes('[第1页]'), {
          expected: '块内有 `[第1页]` 且正文非空',
          actual: brief(pdfBlock),
        })
        // 上面三个①②③ 的判据对**每一份**上行的请求都成立（第二轮同样不许出现二进制/文件引用）
        const allHits = mock.state.chatCalls.flatMap((call) => forbiddenIn(JSON.stringify(call.body)))
        ctx.expect('两轮请求体都没有 base64 / file_id / document 块', allHits.length === 0, {
          expected: '一处都没有',
          actual: allHits.length === 0 ? '干净' : `命中：${[...new Set(allHits)].join('、')}`,
        })

        // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ────────────
        ctx.begin('不连真实服务')
        guard.assertNoLeak(ctx)
      }
    )
    // runGolden 只记失败、不抛：抬成 node:test 的失败（`node --test` 单跑也才算真红）
    assert.equal(result.status, 'PASS', result.failures.join(' | '))
  } finally {
    await close()
    await mock.close()
    await app.close()
  }
})
