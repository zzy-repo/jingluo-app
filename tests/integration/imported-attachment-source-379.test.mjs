// [layer: integration | 依赖: playwright + chromium + 真实 dist 产物（APP_URL 由 run-layer 注入） | 耗时: 1~2 分钟]
//
// Issue #379：导入的历史会话（曾带附件）继续聊天报「上传失败」，官方渠道也复现，新会话正常。
//
// 这是**用户可见 bug**，所以这一层不看内部状态，只钉四件用户在屏幕上能看到的事（4 行场景表）：
//
//   [1] 导入会话 + 附件**源缺失**（元信息在、原件不在）+ 发纯文字
//       → 消息真的发出去（有回答）、**没有**「上传失败」、消息里有一条**持久**提示点名是哪个附件；
//   [2] 导入会话 + 附件**源存在**
//       → 与正常会话一致：消息照发，**不误报**「附件不可用」；
//   [3] 新会话带附件
//       → 完全不受本改动影响：附件照旧上传、`file_id` 照旧进请求体；
//   [4] 官方渠道（deepseek）+ 源缺失附件
//       → 抓真请求体：「有这个附件」与「根本没这个附件」两份 body **逐字节相同**（#480 的规矩）。
//
// 这一层为什么不可下放 L0：源缺失的后果在 L0 里是「函数返回值」，在真浏览器里是
// 「用户到底看见什么」—— 红字、提示、附件卡片，以及提示在**刷新之后还在不在**。
// issue 报的是官方渠道（deepseek），所以这里不用 mock 的兼容渠道：真按 deepseek 协议
// （`/anthropic/v1/messages`）拼请求、抓字节。上游用 `page.route` 接住，一个字节都不出网。
//
// 夹具：`fixtures/domain05/archive-fixture.mjs` 的 `imageExportPath: 'none'` —— fragment（元信息：
// id / 文件名 / 体积 / is_image）照写、包里没有原件，正是「导出只保留文件信息」的附件在客户端
// 看起来的样子。守则：**靠终态等待，不靠 sleep**（docs/TESTING-POLICY.md §11.5）。
//
// 跑法（仓库根目录）：
//   pnpm run build && node tests/run-layer.mjs integration --case tests/integration/imported-attachment-source-379.test.mjs
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { buildArchiveZip } from '../fixtures/domain05/archive-fixture.mjs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
/** 假域名：所有请求都被 page.route 接住，不会出网 */
const FAKE_BASE = 'https://deepseek.379.test'
const API_KEY = 'sk-379-official-0123456789'
const ANSWER = '收到，我们接着聊。'
/** 导入档案里那条附件的文件名（archive-fixture 的 fragment 字段） */
const ATTACHMENT_NAME = 'image.png'
const TITLE_NO_SOURCE = '导入无原件会话'
const TITLE_WITH_SOURCE = '导入带原件会话'
/** 归档里那条历史提问的正文（两个包都只有这一轮，内容一字不差） */
const HISTORY_TEXT = '问题 1'
const PNG = path.join(import.meta.dirname, '..', 'fixtures', 'golden', 'tiny.png')

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** deepseek（Anthropic 协议）的整段 SSE：少一个事件客户端都拿不到正文 */
const sseBody = (text) =>
  [
    [
      'message_start',
      {
        message: {
          id: 'msg-379',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { index: 0 }],
    [
      'message_delta',
      { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    ],
    ['message_stop', {}],
  ]
    .map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    .join('')

/** 会话里最后一条回答的正文（与其它 L1 用同一个内容选择器） */
const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  if ((await nodes.count()) === 0) {
    return ''
  }
  return (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

/** 打开侧栏里的某个会话：点标题 → 等这条会话自己的历史内容上屏（终态，不 sleep） */
const openSession = async (page, title) => {
  await page.getByText(title, { exact: false }).first().click()
  await page.getByText(HISTORY_TEXT, { exact: false }).first().waitFor({ timeout: 20000 })
}

/** 发一条纯文字消息（textarea + 发送按钮），等这条回答的正文真的上屏 */
const sendText = async (page, text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  const send = page.getByRole('button', { name: /^发送$|^Send$/ }).first()
  await send.waitFor({ timeout: 20000 })
  await send.click()
  await page.getByText(ANSWER, { exact: false }).last().waitFor({ timeout: 30000 })
}

/** 关掉可能开着的设置弹层，等它真的消失 */
const closeSettings = async (page) => {
  if ((await page.getByRole('dialog').count()) > 0) {
    await page
      .getByRole('button', { name: /关闭|Close/ })
      .first()
      .click()
    await page.getByRole('dialog').first().waitFor({ state: 'hidden', timeout: 10000 })
  }
}

const run = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  /** 抓真请求体：`chats` 只要问答请求（自动标题请求带 max_tokens，单列） */
  const chats = []
  const uploads = []
  await page.route(`${FAKE_BASE}/**`, async (route) => {
    const request = route.request()
    const url = request.url()
    const postData = request.postData() ?? ''
    if (url.includes('/files')) {
      uploads.push(url)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'file-api-379', object: 'file', purpose: 'user_data' }),
      })
      return
    }
    let body = {}
    try {
      body = JSON.parse(postData)
    } catch {
      body = {}
    }
    if (body.max_tokens === undefined) {
      chats.push(postData)
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody(ANSWER),
    })
  })

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([base, key]) => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:provider-kind', 'deepseek')
      window.localStorage.setItem('chat-demo:api-key', key)
      // 官方渠道（deepseek）的地址本来内置；这里指到假域名，请求全被 route 接住。
      // 两个键都要写：deepseek 是「老共享键」渠道（apiConfig 的 LEGACY_KIND 读 `chat-demo:base-url`），
      // 只写按渠道分开的那个键不生效 —— 请求会真的打到 api.deepseek.com。
      window.localStorage.setItem('chat-demo:base-url', base)
      window.localStorage.setItem('chat-demo:base-url:deepseek', base)
    },
    [FAKE_BASE, API_KEY]
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await closeSettings(page)
  await page.locator('textarea').first().waitFor({ timeout: 30000 })

  // ── 造两个 fixture 并导入：同一条历史消息记录，一个附件只有元信息、一个带原件 ────────────
  const dir = await mkdtemp(path.join(tmpdir(), 'issue379-'))
  const zipNoSource = path.join(dir, 'no-source.zip')
  const zipWithSource = path.join(dir, 'with-source.zip')
  await writeFile(
    zipNoSource,
    buildArchiveZip({
      sessionCount: 1,
      imageBytes: 2048,
      imageExportPath: 'none',
      // 两个包的会话 id 必须岔开：合并导入按 id 判「是不是同一条会话」（#390 的 resolveConflict）
      idPrefix: 'issue379-no-source',
      titlePrefix: TITLE_NO_SOURCE,
    })
  )
  await writeFile(
    zipWithSource,
    buildArchiveZip({
      sessionCount: 1,
      imageBytes: 2048,
      imageExportPath: 'zip',
      idPrefix: 'issue379-with-source',
      titlePrefix: TITLE_WITH_SOURCE,
    })
  )

  const importZip = async (zipPath, title) => {
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
    await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipPath)
    const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
    await confirm.waitFor({ timeout: 20000 })
    await confirm.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByText(/已导入 \d+ 个会话/).waitFor({ timeout: 60000 })
    await closeSettings(page)
    await page.getByText(title, { exact: false }).first().waitFor({ timeout: 20000 })
    check(`导入完成：${title}`, (await page.getByText(title, { exact: false }).count()) > 0)
  }

  await importZip(zipNoSource, TITLE_NO_SOURCE)
  await importZip(zipWithSource, TITLE_WITH_SOURCE)

  console.log('\n[1] 导入会话 + 附件源缺失 + 发纯文字：消息真的发出去，且消息里有持久提示')
  await openSession(page, TITLE_NO_SOURCE)
  check(
    '导入会话里能看见那条历史附件',
    (await page.getByText(ATTACHMENT_NAME, { exact: false }).count()) > 0
  )
  const uploadsBefore = uploads.length
  await sendText(page, '开始')
  check('消息真的发出去了（有回答）', (await answerText(page)).includes(ANSWER))
  check('没有出现「上传失败」红字', (await page.getByText('上传失败').count()) === 0)
  check(
    '源缺失的附件没有触发上传请求',
    uploads.length === uploadsBefore,
    `uploads +${uploads.length - uploadsBefore}`
  )
  const notice = page.getByRole('note').filter({ hasText: '在本机不可用' })
  check('消息里有一条「附件不可用」提示', (await notice.count()) === 1)
  const noticeText = (await notice.count()) > 0 ? await notice.first().innerText() : ''
  check('提示点名了是哪个附件', noticeText.includes(ATTACHMENT_NAME), noticeText)
  check('提示说明本条按纯文字发出', noticeText.includes('本条已按纯文字发送'), noticeText)
  const bodyNoSource = chats[chats.length - 1] ?? ''
  check(
    '官方渠道请求体里没有这个附件（既无 file_id，也无 file 块）',
    bodyNoSource.length > 0 && !/file_id|"file"/.test(bodyNoSource)
  )

  console.log('\n[1b] 提示是持久的：刷新页面后还在（不是 toast）')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await closeSettings(page)
  await page.locator('textarea').first().waitFor({ timeout: 30000 })
  await openSession(page, TITLE_NO_SOURCE)
  const noticeAfterReload = page.getByRole('note').filter({ hasText: '在本机不可用' })
  check('刷新后提示仍在', (await noticeAfterReload.count()) === 1)
  check(
    '刷新后提示里仍然点名附件',
    (await noticeAfterReload.count()) > 0 &&
      (await noticeAfterReload.first().innerText()).includes(ATTACHMENT_NAME)
  )
  check('刷新后仍然没有「上传失败」', (await page.getByText('上传失败').count()) === 0)

  console.log('\n[2] 导入会话 + 附件源存在：与正常会话一致，不误报')
  await openSession(page, TITLE_WITH_SOURCE)
  const chatsBeforeSource = chats.length
  await sendText(page, '开始')
  check('源存在时消息照常发出', (await answerText(page)).includes(ANSWER))
  check('源存在时没有「上传失败」', (await page.getByText('上传失败').count()) === 0)
  check(
    '源存在时不许出现「附件不可用」提示（误报比不报更糟）',
    (await page.getByRole('note').filter({ hasText: '在本机不可用' }).count()) === 0
  )
  const bodyWithSource = chats[chatsBeforeSource] ?? ''
  check(
    '源存在那轮请求体里同样没有历史附件（历史附件不重传，#444 不回归）',
    bodyWithSource.length > 0 && !/file_id|"file"/.test(bodyWithSource)
  )

  console.log('\n[3] 新会话带附件：完全不受影响（照旧上传 + file_id 进请求体）')
  await page
    .getByRole('button', { name: /开启新对话|新建对话|New chat/ })
    .first()
    .click()
  await page
    .getByText(/今天有什么可以帮到你|How can I help/)
    .first()
    .waitFor({ timeout: 20000 })
  const uploadsBeforeNew = uploads.length
  const chatsBeforeNew = chats.length
  const uploadResponse = page.waitForResponse(
    (response) => response.url().includes('/files') && response.status() === 200,
    { timeout: 30000 }
  )
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: await readFile(PNG) })
  await uploadResponse
  check('新会话的附件真的上传了一次', uploads.length === uploadsBeforeNew + 1)
  await sendText(page, '这张图是什么颜色')
  check('新会话消息发出去了', (await answerText(page)).includes(ANSWER))
  check('新会话没有「上传失败」', (await page.getByText('上传失败').count()) === 0)
  check(
    '新会话没有「附件不可用」提示（本轮真附件不受本改动影响）',
    (await page.getByRole('note').filter({ hasText: '在本机不可用' }).count()) === 0
  )
  const newBody = chats[chatsBeforeNew] ?? ''
  check('新会话请求体里带着 file_id（deepseek 通路不变）', newBody.includes('file-api-379'))

  console.log('\n[4] 官方渠道：源缺失附件「去掉」与「它不存在」逐字节相同')
  // 两个会话的消息内容一字不差（都只有「问题 1 / 回答 1」），唯一差别是那条附件有没有原件；
  // 源缺失那份被跳过 → 两份请求体除**会话标识**（#576 的 conversation_id / session_id，天生不同）外
  // 必须逐字节相同。**只**归一化这两个字段的值，其余一个字节都不许动。
  const stripSessionIds = (raw) =>
    raw
      .replace(/("conversation_id":")[^"]*(")/g, '$1<id>$2')
      .replace(/("session_id":")[^"]*(")/g, '$1<id>$2')
  check('抓到了两份官方渠道请求体', bodyNoSource.length > 0 && bodyWithSource.length > 0)
  check(
    '源缺失附件「去掉」与「它不存在」请求体逐字节相同（仅会话标识归一）',
    bodyNoSource.length > 0 && stripSessionIds(bodyNoSource) === stripSessionIds(bodyWithSource),
    `长度差 ${stripSessionIds(bodyNoSource).length - stripSessionIds(bodyWithSource).length}`
  )

  console.log('\n[5] 窄屏截图留档（390 / 360）')
  // 先在宽屏把那条会话打开，再缩窗口截图 —— 窄屏下侧栏变抽屉，切会话要先开抽屉、等抽屉动画，
  // 那一段与本用例要看的「提示在不在」无关，只会把结论拖进时序噪声（实测会偶发点击超时）。
  const shots = process.env.SHOTS_DIR || path.join(tmpdir(), 'issue379-shots')
  await page.setViewportSize({ width: 1280, height: 900 })
  await openSession(page, TITLE_NO_SOURCE)
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 780 })
    const narrowNotice = page.getByRole('note').filter({ hasText: '在本机不可用' })
    await narrowNotice.first().waitFor({ timeout: 15000 })
    await page.screenshot({ path: path.join(shots, `issue379-notice-${width}.png`) })
    check(`${width} 宽下提示仍可见`, (await narrowNotice.count()) === 1)
  }
  console.log(`  截图：${shots}`)

  console.log('\n[6] 整条通路没有 console error / 未捕获异常')
  check('console error = 0', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  await browser.close()

  if (failures.length > 0) {
    console.error(`\n失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}

await run()
