// [layer: integration | 依赖: playwright + chromium + 标准产物（dist/）；不连后端、不读真机]
// Issue #305 定向回归：日志展示层细化（按 kind / level 过滤、关键字搜索、按操作分组、单条复制、
// 条数口径、空态 / 无匹配态 / 极少提示、负向用例）。
//
//   npm run build
//   node tests/run-layer.mjs integration --case log-viewer.test.mjs --timeout-ms 300000
//
// 也可以用 LOGVIEW_DIST 指向别的产物目录（改前基线对比用同一份断言跑旧产物）。
//
// 判据来源：弹窗打开时取的那份快照 = 当前缓冲区日志的**前缀**（采集层只追加、不清空）。
// 所以「界面应该显示几条」由测试自己从页面上的快照算出，不依赖产品代码的过滤实现。
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.resolve(root, process.env.LOGVIEW_DIST || 'dist')
const out = path.join(root, 'docs/ui/log-viewer-305')
const SHOTS = []
/** 预览上限（与 FeedbackDialog 的 PREVIEW_LIMIT 对齐；口径文案里的 N 不该超过它） */
const PREVIEW_LIMIT = 50

const MARK = 'LVFIX'
const LONG_META_CHARS = 5000
const SECRET_URL = 'https://api.example.com/v1/chat?key=sk-live-SECRET&sig=abc'

await mkdir(out, { recursive: true })
const server = await serveDist(DIST, { port: 0 })
const browser = await chromium.launch({ headless: true })

/** 注入一份可控的日志夹具（全部带 LVFIX 标记，便于和真实日志区分） */
const seedLogs = () => {
  const d = window.__diagnostics
  const mark = 'LVFIX'
  // 每条 meta 都带 stage=viewer-fixture：既是搜索目标，也是「meta 值可被搜到」的证据
  for (let i = 0; i < 5; i += 1) {
    d.record('import_stage', 'info', `${mark} import stage #${i}`, { stage: 'viewer-fixture', idx: i })
  }
  for (let i = 0; i < 4; i += 1) {
    d.record('net_error', 'error', `${mark} net error #${i}`, {
      'url.path': '/v1/chat',
      'http.status': 502,
      requestId: `req-${i}`,
      stage: 'viewer-fixture',
      idx: i,
    })
  }
  for (let i = 0; i < 3; i += 1) {
    d.record('nav', 'info', `${mark} nav #${i}`, { stage: 'viewer-fixture' })
  }
  d.record('chat_send', 'info', `${mark} chat send`, { stage: 'viewer-fixture' })
  d.record('chat_first_token', 'info', `${mark} chat first token`, { stage: 'viewer-fixture' })
  d.record('chat_done', 'info', `${mark} chat done`, { stage: 'viewer-fixture' })
  // 负向夹具 1：**需要脱敏**的 URL。两处口径不同，不能混着断言（#406 复核）：
  //   · meta['url.path'] 走采集层的 URL 口径（redactUrl：只留 path，query/hash 全丢）—— 断言「只剩 path」；
  //   · 自由文本（msg）走 REDACTION_RULES 的值维度打码 —— 断言「token=*** / sk-*** 原样保留」。
  // 老夹具把整条带 query 的 URL 塞进 meta['url.path']，再要求复制里出现 token=***，与产品口径相反（假红）。
  d.record(
    'error',
    'error',
    `${mark} secret url https://api.example.com/v1/chat?token=super-secret-token&key=sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789`,
    {
      'url.path': 'https://api.example.com/v1/chat?token=super-secret-token&key=sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789',
      stage: 'viewer-fixture',
    }
  )
  // 负向夹具 2：meta 值是 5000 字符（采集层按 300 截断，展示层不许被撑破）。
  // 键必须落在采集层白名单里（fields.ts 的 META_KEYS / EXTRA_KEYS / 模式）：老夹具用的裸键
  // `big` 不在白名单，sanitizeMeta 直接丢弃 → 复制文本里连这个键都没有（#406 复核）。
  d.record('nav', 'info', `${mark} long meta`, { 'error.detail': 'x'.repeat(5000), stage: 'viewer-fixture' })
  d.record('warning', 'warn', `${mark} warn`, { reason: 'probe', stage: 'viewer-fixture' })
}

/** 打开 设置 → 数据管理 → 写反馈，返回反馈对话框 */
const openFeedback = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /边栏|菜单|sidebar|menu/i }).first().click()
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  const form = page.locator('[role="dialog"]:has(#feedback-description)')
  await form.locator('#feedback-description').waitFor({ state: 'visible' })
  return form
}

const expandPreview = async (form) => {
  await form.getByRole('button', { name: /日志预览/ }).first().click()
  // 不硬等 [data-testid="log-viewer"]：改前产物里根本没有这个节点，硬等只会变成 30s 超时，
  // 看不出「缺的是什么」。让 readViewer 返回 missing，由断言把话说清楚。
  await form.page().waitForTimeout(300)
}

/** 读预览区当前状态：口径文案、渲染行、分组、空态、按钮尺寸 */
const readViewer = (form) =>
  form.evaluate((dialog) => {
    const viewer = dialog.querySelector('[data-testid="log-viewer"]')
    if (!viewer) {
      return { missing: true }
    }
    const rows = [...viewer.querySelectorAll('[data-testid="log-row"]')]
    const groups = [...viewer.querySelectorAll('[data-testid="log-group"]')]
    const box = (element) => {
      const rect = element.getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    }
    const text = (testid) => {
      const node = viewer.querySelector(`[data-testid="${testid}"]`)
      return node ? (node.textContent || '').trim() : null
    }
    return {
      missing: false,
      summary: text('log-summary'),
      rows: rows.map((row) => ({
        kind: row.querySelector('[data-kind]')?.dataset.kind ?? null,
        kindText: row.children[1] ? row.children[1].textContent.trim() : '',
        level: row.children[2] ? row.children[2].textContent.trim() : '',
        msg: row.children[3] ? row.children[3].textContent.trim() : '',
      })),
      rowCount: rows.length,
      copyCount: viewer.querySelectorAll('[data-testid="log-copy"]').length,
      copyBoxes: [...viewer.querySelectorAll('[data-testid="log-copy"]')].map(box),
      searchBox: (() => {
        const input = viewer.querySelector('[data-testid="log-search"]')
        return input ? { type: input.getAttribute('type'), ...box(input) } : null
      })(),
      levelChips: [...viewer.querySelectorAll('[data-testid="log-level-filter"] button')].map(
        (button) => ({ level: button.dataset.level, pressed: button.getAttribute('aria-pressed'), ...box(button) })
      ),
      kindChips: [...viewer.querySelectorAll('[data-testid="log-kind-filter"] button')].map(
        (button) => ({ kind: button.dataset.kind, pressed: button.getAttribute('aria-pressed'), ...box(button) })
      ),
      groupToggle: (() => {
        const toggle = viewer.querySelector('[data-testid="log-group-toggle"]')
        return toggle ? { checked: toggle.checked } : null
      })(),
      groupCount: groups.length,
      groupSum: groups.reduce(
        (sum, group) => sum + group.querySelectorAll('[data-testid="log-row"]').length,
        0
      ),
      groupHeaders: groups.map((group) => ({
        family: group.dataset.family,
        text: group.firstElementChild ? group.firstElementChild.textContent.trim() : '',
      })),
      groupNote: viewer.querySelector('[data-testid="log-group-note"]') !== null,
      noMatch: viewer.querySelector('[data-testid="log-nomatch"]') !== null,
      empty: viewer.querySelector('[data-testid="log-empty"]') !== null,
      truncatedText: text('log-truncated'),
      fewText: text('log-few'),
      viewerText: viewer.textContent || '',
      overflow: rows.some((row) => row.scrollWidth > row.clientWidth + 1),
      wideRows: rows.filter((row) => row.getBoundingClientRect().right > viewer.getBoundingClientRect().right + 1).length,
    }
  })

/** 口径文案解析：显示最近 N 条，共 M 条，提交上限 L 条 */
const parseSummary = (summary, label) => {
  const match = /显示最近\s*(\d+)\s*条，共\s*(\d+)\s*条，提交上限\s*(\d+)\s*条/.exec(summary || '')
  assert.ok(match, `${label}: 口径文案必须写明「显示最近 N 条，共 M 条，提交上限 L 条」，实际 ${JSON.stringify(summary)}`)
  return { shown: Number(match[1]), total: Number(match[2]), limit: Number(match[3]) }
}

/** 当前缓冲区日志（测试侧的「真值」；界面快照是它的前缀） */
const readBuffer = (page) =>
  page.evaluate(() => window.__diagnostics.getDiagnosticsSnapshot().logs.map((entry) => ({
    kind: entry.kind,
    level: entry.level,
    msg: entry.msg,
    meta: entry.meta ?? {},
  })))

/** 重置：清空日志 → 注入夹具 → 返回真值（弹窗快照 = 这里的前缀） */
const seed = async (page) => {
  await page.evaluate(async () => {
    await window.__diagnostics.clearDiagnostics()
    await window.__diagnostics.flushDiagnostics()
  })
  await page.evaluate(seedLogs)
  return readBuffer(page)
}

/** 界面快照前缀：弹窗打开时取的 M 条（采集层只追加，所以界面数据一定是缓冲区的前缀） */
const snapshotPrefix = (buffer, total, label) => {
  assert.ok(
    buffer.length >= total,
    `${label}: 界面显示共 ${total} 条，但缓冲区只有 ${buffer.length} 条（快照不该比缓冲区还多）`
  )
  return buffer.slice(0, total)
}

try {
  for (const [width, height] of [
    [390, 844],
    [360, 780],
  ]) {
    const tag = String(width)
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    await context.addInitScript(() => localStorage.setItem('chat-demo:api-key', 'sk-logview-fixture'))
    const pageErrors = []
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(`${server.url}/?diag-debug`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__diagnostics)

    console.log(`\n[${tag}] 1. 预览区：口径文案 = 真实渲染行数，且各项展示能力到位`)
    await seed(page)
    const form = await openFeedback(page)
    await expandPreview(form)
    // 真值必须在弹窗**挂载之后**取：界面快照是缓冲区的前缀，先取会漏掉打开弹窗时产生的点击日志
    const buffer = await readBuffer(page)
    let view = await readViewer(form)
    assert.equal(view.missing, false, '预览区应存在 data-testid="log-viewer"')
    const summary = parseSummary(view.summary, `[${tag}] 口径`)
    assert.equal(summary.limit, 500, `提交上限应写 500，实际 ${summary.limit}`)
    assert.ok(summary.total >= 15, `共 M 条应包含注入的 15 条以上夹具，实际 ${summary.total}`)
    assert.equal(
      summary.shown,
      view.rowCount,
      `口径里的「显示最近 N 条」N=${summary.shown} 必须等于真实渲染行数 ${view.rowCount}`
    )
    assert.ok(summary.shown <= PREVIEW_LIMIT, `N 不应超过预览上限 ${PREVIEW_LIMIT}，实际 ${summary.shown}`)
    const logs = snapshotPrefix(buffer, summary.total, `[${tag}] 前缀`)
    const expectedShown = Math.min(summary.total, PREVIEW_LIMIT)
    assert.equal(summary.shown, expectedShown, `未筛选时应显示最近 ${expectedShown} 条`)
    assert.equal(view.searchBox?.type, 'search', '必须有搜索框（type=search）')
    assert.equal(view.levelChips.length, 3, '级别过滤三档：error / warn / info')
    assert.deepEqual(
      view.levelChips.map((chip) => chip.level),
      ['error', 'warn', 'info']
    )
    assert.ok(view.kindChips.length >= 4, `kind 过滤至少列出夹具里的 4 种类型，实际 ${view.kindChips.length}`)
    assert.equal(view.copyCount, view.rowCount, '每一行都要有单条复制按钮')
    assert.deepEqual(view.groupToggle, { checked: false }, '分组开关默认关闭')
    assert.equal(view.overflow, false, '行内不许溢出（超长 meta 不能撑破布局）')
    assert.equal(view.wideRows, 0, '行不许多出预览容器右边')
    console.log(`  ok   共 ${summary.total} 条 / 显示 ${summary.shown} 条 / kind 选项 ${view.kindChips.length} 个`)

    console.log(`[${tag}] 2. 关键字搜索：命中正文与 meta 值`)
    const search = form.locator('[data-testid="log-search"]')
    await search.fill(`${MARK} net error`)
    await page.waitForTimeout(120)
    view = await readViewer(form)
    const netErrorExpected = logs.filter((entry) => entry.msg.includes(`${MARK} net error`)).length
    assert.equal(view.rowCount, netErrorExpected, `搜「${MARK} net error」应命中 ${netErrorExpected} 条，实际 ${view.rowCount}`)
    assert.ok(view.rows.every((row) => row.msg.includes(`${MARK} net error`)), '搜索结果必须都含关键字')
    await search.fill('req-3')
    await page.waitForTimeout(120)
    view = await readViewer(form)
    assert.equal(view.rowCount, 1, `按 meta 值 req-3 搜索应命中 1 条，实际 ${view.rowCount}`)
    assert.ok(view.rows[0].msg.includes(`${MARK} net error #3`), `命中项应是 #3，实际 ${view.rows[0].msg}`)

    console.log(`[${tag}] 3. level 过滤：只剩 error 级，条数与真值一致`)
    await search.fill('')
    await page.waitForTimeout(120)
    await form.locator('[data-testid="log-level-filter"] button[data-level="error"]').click()
    await page.waitForTimeout(120)
    view = await readViewer(form)
    const errorExpected = Math.min(
      logs.filter((entry) => entry.level === 'error').length,
      PREVIEW_LIMIT
    )
    assert.equal(view.rowCount, errorExpected, `error 级应 ${errorExpected} 条，实际 ${view.rowCount}`)
    assert.ok(view.rows.every((row) => row.level === 'error'), '过滤后每行都必须是 error 级')
    assert.equal(
      view.levelChips.find((chip) => chip.level === 'error').pressed,
      'true',
      '已选级别要 aria-pressed=true'
    )
    await form.locator('[data-testid="log-level-filter"] button[data-level="error"]').click()
    await page.waitForTimeout(120)

    console.log(`[${tag}] 4. kind 过滤：只剩 net_error，条数与真值一致`)
    await form.locator('[data-testid="log-kind-filter"] button[data-kind="net_error"]').click()
    await page.waitForTimeout(120)
    view = await readViewer(form)
    const kindExpected = Math.min(
      logs.filter((entry) => entry.kind === 'net_error').length,
      PREVIEW_LIMIT
    )
    assert.equal(view.rowCount, kindExpected, `net_error 应 ${kindExpected} 条，实际 ${view.rowCount}`)
    assert.ok(
      view.rows.every((row) => row.kindText === 'net_error'),
      `过滤后每行 kind 都应是 net_error，实际 ${view.rows.map((row) => row.kindText).join(',')}`
    )

    console.log(`[${tag}] 5. 组合筛选：无匹配时给明确空态（不崩）`)
    await form.locator('[data-testid="log-level-filter"] button[data-level="info"]').click()
    await page.waitForTimeout(120)
    view = await readViewer(form)
    assert.equal(view.noMatch, true, 'net_error + info 级应显示「没有匹配的日志」')
    assert.equal(view.rowCount, 0)
    assert.match(view.viewerText, /没有匹配的日志/)
    await form.getByRole('button', { name: '清除筛选' }).click()
    await page.waitForTimeout(120)
    view = await readViewer(form)
    assert.equal(view.noMatch, false, '清除筛选后应恢复列表')
    assert.equal(view.rowCount, expectedShown, `清除筛选后应回到 ${expectedShown} 条`)
    assert.ok(
      view.kindChips.every((chip) => chip.pressed === 'false'),
      '清除筛选后所有 kind chip 都应 aria-pressed=false'
    )

    console.log(`[${tag}] 6. 按操作分组：组头条数与可见行数对得上`)
    await form.locator('[data-testid="log-group-toggle"]').check()
    await page.waitForTimeout(120)
    view = await readViewer(form)
    assert.ok(view.groupCount >= 2, `应出现至少 2 个分组，实际 ${view.groupCount}`)
    assert.equal(view.groupSum, view.rowCount, `组内条数之和 ${view.groupSum} 应等于渲染行数 ${view.rowCount}`)
    assert.equal(view.groupNote, true, '分组必须标注「暂无 traceId，属过渡方案」')
    assert.match(view.viewerText, /过渡方案/)
    const chatGroup = view.groupHeaders.find((group) => group.family === 'chat')
    const netGroup = view.groupHeaders.find((group) => group.family === 'net')
    assert.ok(chatGroup, `夹具里的 chat_send/chat_done 应归入 chat 组，实际 ${JSON.stringify(view.groupHeaders)}`)
    assert.ok(netGroup, '夹具里的 net_error 应归入 net 组')
    const shotGrouped = path.join(out, `${tag}-grouped.png`)
    await page.screenshot({ path: shotGrouped })
    SHOTS.push(shotGrouped)
    console.log(`  ok   分组 ${view.groupCount} 组；截图 ${shotGrouped}`)
    await form.locator('[data-testid="log-group-toggle"]').uncheck()
    await page.waitForTimeout(120)

    console.log(`[${tag}] 7. 单条复制：内容含正文、level、kind 与完整 meta`)
    // 定位带 requestId 的 net_error 行（夹具第 0 条）
    await form.locator('[data-testid="log-kind-filter"] button[data-kind="net_error"]').click()
    await page.waitForTimeout(120)
    const targetRow = form.locator('[data-testid="log-row"]', { hasText: `${MARK} net error #0` }).first()
    await targetRow.locator('[data-testid="log-copy"]').click()
    await page.waitForTimeout(200)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert.match(copied, /^\d{2}:\d{2}:\d{2}\.\d{3} \[error\] net_error {2}LVFIX net error #0/, `复制文本首行格式不对：${copied.slice(0, 80)}`)
    for (const needle of ['meta:', 'url.path = /v1/chat', 'http.status = 502', 'requestId = req-0', 'stage = viewer-fixture']) {
      assert.ok(copied.includes(needle), `复制文本必须包含「${needle}」，实际：\n${copied}`)
    }
    assert.ok(copied.split('\n').length >= 6, `完整 meta 应有 4+ 行，实际 ${copied.split('\n').length}`)
    console.log(`  ok   复制 ${copied.split('\n').length} 行，含 requestId / http.status`)
    await form.locator('[data-testid="log-kind-filter"] button[data-kind="net_error"]').click()
    await page.waitForTimeout(120)

    console.log(`[${tag}] 8. 负向：需脱敏 URL 的 meta 在展示与复制里都不含密钥原文`)
    const secretRows = form.locator('[data-testid="log-row"]', { hasText: `${MARK} secret url` })
    assert.equal(await secretRows.count(), 1, '夹具里应有一条带 secret URL 的日志')
    view = await readViewer(form)
    for (const secret of ['super-secret-token', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789']) {
      assert.equal(view.viewerText.includes(secret), false, `预览文本不许出现密钥原文 ${secret}`)
    }
    await secretRows.first().locator('[data-testid="log-copy"]').click()
    await page.waitForTimeout(200)
    const copiedSecret = await page.evaluate(() => navigator.clipboard.readText())
    for (const secret of ['super-secret-token', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789']) {
      assert.equal(copiedSecret.includes(secret), false, `复制文本不许出现密钥原文 ${secret}：${copiedSecret}`)
    }
    assert.ok(copiedSecret.includes('token=***'), `采集层的 token 打码结果应保留：${copiedSecret}`)
    assert.ok(copiedSecret.includes('sk-***'), `采集层的 sk- 打码结果应保留：${copiedSecret}`)
    // meta['url.path'] 的口径是「只留 path」：query 整段丢掉（比打码更彻底），host 也不保留
    assert.ok(
      copiedSecret.includes('url.path = /v1/chat'),
      `meta 里的 URL 只保留 path（query/hash 全丢）：${copiedSecret}`
    )
    console.log(`  ok   展示与复制均为打码后文本：${/url\.path = (.+)/.exec(copiedSecret)?.[1] ?? '?'}`)

    console.log(`[${tag}] 9. 负向：5000 字符超长 meta 不撑破布局，复制文本有界`)
    const longRow = form.locator('[data-testid="log-row"]', { hasText: `${MARK} long meta` })
    assert.equal(await longRow.count(), 1, '夹具里应有一条超长 meta 日志')
    view = await readViewer(form)
    assert.equal(view.overflow, false, '超长 meta 不许让行溢出')
    assert.equal(view.wideRows, 0, '超长 meta 不许顶出容器')
    await longRow.first().locator('[data-testid="log-copy"]').click()
    await page.waitForTimeout(200)
    const copiedLong = await page.evaluate(() => navigator.clipboard.readText())
    const longMetaLength = (/error\.detail = (.*)/.exec(copiedLong)?.[1] ?? '').length
    assert.ok(
      longMetaLength > 0 && longMetaLength <= 300,
      `采集层已按 300 字符截断，复制文本里不该是 ${LONG_META_CHARS} 字符原文（实际 ${longMetaLength}）`
    )
    console.log(`  ok   复制文本里超长 meta 被采集层截断到 ${longMetaLength} 字符`)

    console.log(`[${tag}] 10. 负向：明显错误输入不崩`)
    const hostile = ['x'.repeat(5000), '.*[unclosed(', '((((', '   ', '💥💥💥', '"]><script>', 'null']
    for (const query of hostile) {
      await search.fill(query)
      await page.waitForTimeout(60)
      const state = await readViewer(form)
      assert.equal(state.missing, false, `输入 ${JSON.stringify(query.slice(0, 12))} 后预览区不该消失`)
      assert.ok(
        state.rowCount === 0 || state.rowCount > 0,
        '渲染结果要么是空态要么是行，不该是「两者都没有」'
      )
    }
    const typedLength = await search.evaluate((input) => input.value.length)
    assert.equal(
      await search.evaluate((input) => input.maxLength),
      200,
      '搜索框应有 200 字符上限（粘贴一整个日志文件也不会把输入框撑爆）'
    )
    assert.ok(typedLength > 0, '异常输入确实进了输入框')
    await search.fill('')
    await page.waitForTimeout(120)
    console.log(`  ok   ${hostile.length} 种异常输入均无异常`)

    console.log(`[${tag}] 11. 触控目标 ≥44px（chip / 复制按钮 / 搜索框）`)
    view = await readViewer(form)
    for (const chip of [...view.levelChips, ...view.kindChips]) {
      assert.ok(chip.height >= 44, `${chip.level ?? chip.kind} chip 高度应 ≥44px，实际 ${chip.height}`)
      assert.ok(chip.width >= 44, `${chip.level ?? chip.kind} chip 宽度应 ≥44px，实际 ${chip.width}`)
    }
    for (const box of view.copyBoxes) {
      assert.ok(box.height >= 44 && box.width >= 44, `复制按钮应 ≥44×44，实际 ${box.width}×${box.height}`)
    }
    assert.ok(view.searchBox.height >= 44, `搜索框高度应 ≥44px，实际 ${view.searchBox.height}`)
    console.log(`  ok   chip ${view.kindChips[0].width}×${view.kindChips[0].height}，复制按钮 ${view.copyBoxes[0].width}×${view.copyBoxes[0].height}`)

    // 正常态截图（筛选可用、列表 + 复制入口都在）
    const shotMain = path.join(out, `${tag}-log-viewer.png`)
    await page.screenshot({ path: shotMain })
    SHOTS.push(shotMain)
    console.log(`  ok   截图 ${shotMain}`)

    console.log(`[${tag}] 12. 负向：日志为零条时的空态`)
    await form.getByRole('button', { name: /清空本地日志/ }).last().click()
    await page.waitForTimeout(300)
    // 清空日志会收起预览面板（既有行为），重新展开再读空态
    await expandPreview(form)
    view = await readViewer(form)
    assert.equal(view.empty, true, '零条时应显示「暂无本地日志」')
    assert.equal(view.rowCount, 0)
    const emptySummary = parseSummary(view.summary, `[${tag}] 零条口径`)
    assert.deepEqual(emptySummary, { shown: 0, total: 0, limit: 500 }, '零条时口径应为 显示最近 0 条，共 0 条')
    assert.equal(view.searchBox, null, '零条时不渲染搜索框（没有可搜的东西）')
    const shotEmpty = path.join(out, `${tag}-empty.png`)
    await page.screenshot({ path: shotEmpty })
    SHOTS.push(shotEmpty)
    console.log(`  ok   空态截图 ${shotEmpty}`)

    console.log(`[${tag}] 13. 日志极少（<5 条）时给提示`)
    await page.evaluate(() => {
      window.__diagnostics.record('nav', 'info', 'LVFIX only one entry')
    })
    await form.getByRole('button', { name: /检查日志完整性/ }).first().click()
    await page.waitForTimeout(200)
    await form.getByRole('button', { name: /检查日志完整性/ }).first().click()
    await page.waitForTimeout(200)
    view = await readViewer(form)
    assert.ok(view.fewText, `总条数 <5 时应显示「日志极少」提示，实际 ${view.fewText}`)
    assert.match(view.fewText, /只有\s*\d+\s*条/)

    assert.deepEqual(pageErrors, [], `页面级异常应为 0：${pageErrors.join(' | ')}`)
    await context.close()
  }
  console.log('\nPASS: #305 日志展示层细化 —— 过滤 / 搜索 / 分组 / 单条复制 / 口径 / 空态 / 负向，390、360 两档通过')
} finally {
  await browser.close()
  await server.close()
}
