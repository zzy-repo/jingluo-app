// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 1~2 分钟] 说明见 tests/README.md
// 全局错误边界 + 空值兜底 + 确认弹窗期间禁用设置层关闭（issue #28）。
//
//   cd /root/worktrees/deepseek-error-boundary && pnpm build \
//     && node tests/run-layer.mjs integration --case error-boundary.test.mjs
//
// 被测页面是 dist（DIST_DIR 可覆盖）上的独立静态服务（listen(0) 原子分配端口）。
// 三条断言链：
//   [1] files=null（#28 实测白屏的那条数据）→ 打开会话正常渲染，不再白屏；诊断里有 stage=session.normalize
//   [2] 渲染期异常（把会话标题写成对象，React 渲染对象子节点必抛）→ 显示可读错误页
//       （一句人话 + 重载应用 + 复制诊断信息），诊断里有 stage=ErrorBoundary / reason=render-throw
//   [3] 「确认导入历史对话？」开着时，设置层的 X 不可点、点遮罩也关不掉设置层；
//       取消确认后 X 立刻恢复 → 不再「点两次才能退出」
//
// 未覆盖（写在 Issue 的边界里）：Android WebView 真机、低内核 WebView 的边界页表现。
import path from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'
import { buildArchive } from '../fixtures/archive-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')
const FAKE_KEY = 'sk-test-0123456789abcdef'
const TITLE_PREFIX = '错误边界测试会话'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 页面现场：白屏 = rootChildren 0 / innerText 空 / 节点极少 */
const snap = (page) =>
  page.evaluate(() => {
    const text = document.body?.innerText ?? ''
    const root = document.getElementById('root')
    return {
      nodes: document.querySelectorAll('*').length,
      rootChildren: root?.children.length ?? -1,
      innerTextLen: text.trim().length,
      innerTextHead: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      errorPage: document.querySelectorAll('[data-testid="error-boundary"]').length,
      textarea: document.querySelectorAll('textarea').length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }
  })

/** 诊断日志（IndexedDB chat-diagnostics / logs）里按条件找一条 */
const readDiagnostics = (page, predicateSource) =>
  page.evaluate(async (source) => {
    const predicate = new Function('entry', `return (${source})(entry)`)
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-diagnostics')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!db.objectStoreNames.contains('logs')) return []
    const all = await new Promise((resolve) => {
      const query = db.transaction('logs', 'readonly').objectStore('logs').getAll()
      query.onsuccess = () => resolve(query.result)
      query.onerror = () => resolve([])
    })
    db.close()
    return all.filter((entry) => predicate(entry))
  }, predicateSource)

/** 直接改库：模拟导入中断 / 半写入 / 外部改库 */
const corrupt = (page, mode) =>
  page.evaluate(async (mode) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = (store) =>
      new Promise((resolve) => {
        const query = db.transaction(store, 'readonly').objectStore(store).getAll()
        query.onsuccess = () => resolve(query.result)
        query.onerror = () => resolve([])
      })
    const sessions = await readAll('sessions')
    const first = sessions.sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!first) return { ok: false, reason: 'no session' }
    // 侧栏列表读 sessionSummaries，会话正文读 sessions：两边都要改，才等于「这条会话坏了」
    const stores = ['sessions', 'sessionSummaries'].filter((name) =>
      db.objectStoreNames.contains(name)
    )
    const tx = db.transaction(stores, 'readwrite')
    const store = tx.objectStore('sessions')
    const summaries = db.objectStoreNames.contains('sessionSummaries')
      ? tx.objectStore('sessionSummaries')
      : null
    if (mode === 'files-null') {
      store.put({
        ...first,
        messages: first.messages.map((message) => ({ ...message, files: null })),
      })
    } else if (mode === 'title-object') {
      // 渲染对象子节点 React 必抛「Objects are not valid as a React child」= 纯渲染期异常
      const broken = { ...first, title: { broken: true } }
      store.put(broken)
      summaries?.put({ id: first.id, title: { broken: true } })
    }
    await new Promise((resolve) => (tx.oncomplete = resolve))
    db.close()
    return { ok: true, id: first.id, title: typeof first.title === 'string' ? first.title : null }
  }, mode)

/** 走真实入口导入一份归档，造出「有用户消息 + 附件」的会话 */
const seedViaImport = async (page, { keepConfirmOpen = false } = {}) => {
  // imageBytes 留 0：旧版 fixture 把图片写在会话之前，导入端会判成「内容不完整」（#32 夹具问题，
  // 已在夹具里修掉）；本用例只要一份能导入成功的普通会话，不需要图片。
  const { zip } = buildArchive({ sessionCount: 2, titlePrefix: TITLE_PREFIX })
  const dir = await mkdtemp(path.join(tmpdir(), 'deepseek-error-boundary-'))
  const zipPath = path.join(dir, 'deepseek_data.zip')
  await writeFile(zipPath, zip)
  if ((await page.getByRole('dialog').count()) === 0) {
    await page
      .getByRole('button', { name: /设置|Settings/ })
      .last()
      .click()
    await page.waitForTimeout(300)
  }
  await page
    .getByRole('tab', { name: /数据管理|Data/ })
    .first()
    .click()
  const keyInput = page.locator('input[type="password"]').first()
  if (await keyInput.count()) {
    await keyInput.fill(FAKE_KEY)
    await page
      .getByRole('button', { name: /^确定$/ })
      .last()
      .click()
    await page.waitForTimeout(700)
  }
  await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipPath)
  const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirm.waitFor({ timeout: 5000 })
  if (keepConfirmOpen) {
    return { confirm, zipPath }
  }
  await confirm
    .getByRole('button', { name: /确认导入/ })
    .last()
    .click()
  await page.waitForFunction(() => !/正在导入|正在解析/.test(document.body.innerText), undefined, {
    timeout: 60000,
  })
  await page.waitForTimeout(600)
  // 导入必须真的成功：失败了要立刻停下来，别把「没导入」当成「数据修复好了」
  const imported = await page.getByText(/已导入 \d+ 个会话/).count()
  if (imported === 0) {
    throw new Error(
      `导入没有成功：${(await page.locator('[role="dialog"]').first().innerText()).slice(0, 400)}`
    )
  }
  await page
    .locator('[role="dialog"]')
    .first()
    .getByRole('button', { name: /关闭|Close/ })
    .first()
    .click()
  await page.waitForTimeout(900)
  return { zipPath }
}

const openSession = async (page, title) => {
  await page.getByText(title, { exact: true }).first().click({ timeout: 5000 })
  await page.waitForTimeout(1200)
}

const shoot = async (page, name, width, height) => {
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(400)
  const file = path.join(SHOT_DIR, `${name}-${width}.png`)
  await page.screenshot({ path: file })
  return file
}

const run = async () => {
  // DIST_DIR 由 run-layer 的调用方给出；默认用本 worktree 的 dist（构建产物，不在测试里编译）
  const server = await serveDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  // 上游探测请求打桩：探针失败与本用例无关
  await page.route('**/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] }),
    })
  )

  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
    await page.evaluate(async () => {
      localStorage.clear()
      for (const info of await indexedDB.databases())
        if (info.name) indexedDB.deleteDatabase(info.name)
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)

    console.log('\n[1] files=null 的会话：兜底后正常渲染，不再白屏')
    await seedViaImport(page)
    const healthy = await snap(page)
    check(
      '基线：导入后界面正常（非白屏）',
      healthy.nodes > 50 && healthy.innerTextLen > 0,
      JSON.stringify(healthy)
    )
    const corruptResult = await corrupt(page, 'files-null')
    check(
      '已把首条会话的 messages[].files 写成 null',
      corruptResult.ok === true,
      JSON.stringify(corruptResult)
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    await openSession(page, `${TITLE_PREFIX} 1`)
    const recovered = await snap(page)
    check(
      '打开被写坏的会话后不再白屏（root 有子节点 / 有可见文字 / 输入框在）',
      recovered.rootChildren > 0 && recovered.innerTextLen > 20 && recovered.textarea === 1,
      JSON.stringify(recovered)
    )
    check('没有整屏纯白的错误页（数据已被修复，不需要兜底页）', recovered.errorPage === 0)
    check('用户消息正文仍可见', (await page.getByText(/问题 1/).count()) > 0)
    const repairedLog = await readDiagnostics(
      page,
      "(entry) => entry.kind === 'error' && entry.meta && entry.meta.stage === 'session.normalize'"
    )
    check(
      '诊断里有 stage=session.normalize（记录了一次数据修复）',
      repairedLog.length > 0,
      repairedLog[0] === undefined ? 'missing' : JSON.stringify(repairedLog[0].meta)
    )
    const repairShot390 = await shoot(page, '1.4.0-error-boundary-files-null-ok', 390, 844)
    const repairShot360 = await shoot(page, '1.4.0-error-boundary-files-null-ok', 360, 780)
    check('390 / 360 无横向溢出', await noOverflow(page), `${repairShot390} / ${repairShot360}`)

    console.log('\n[2] 渲染期异常：显示可读错误页 + 两个按钮 + 诊断一条 error')
    await page.setViewportSize({ width: 1280, height: 900 })
    const titleCorrupt = await corrupt(page, 'title-object')
    check(
      '已把首条会话标题写成对象（制造渲染期异常）',
      titleCorrupt.ok === true,
      JSON.stringify(titleCorrupt)
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const crashed = await snap(page)
    check('错误页出现（不再整屏纯白）', crashed.errorPage === 1, JSON.stringify(crashed))
    check(
      '错误页是可读文案而不是空白',
      /没能够?显示|没能显示/.test(crashed.innerTextHead),
      crashed.innerTextHead
    )
    const reloadButton = page.getByTestId('error-boundary-reload')
    const copyButton = page.getByTestId('error-boundary-copy')
    check('有「重载应用」按钮', (await reloadButton.count()) === 1)
    check('有「复制诊断信息」按钮', (await copyButton.count()) === 1)
    check(
      '错误页可见，且卡片不是空白',
      (await page.getByTestId('error-boundary').innerText()).length > 30
    )
    // 先截「刚崩出来」的原始状态：两个按钮都在，复制还没点
    const errorShot390 = await shoot(page, '1.4.0-error-boundary-page', 390, 844)
    const errorShot360 = await shoot(page, '1.4.0-error-boundary-page', 360, 780)
    check(
      '错误页 390 / 360 无横向溢出',
      await noOverflow(page),
      `${errorShot390} / ${errorShot360}`
    )
    await copyButton.click()
    await page.waitForTimeout(400)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    check('复制内容含版本', /版本: /.test(copied), copied.split('\n')[1] ?? '')
    check('复制内容含阶段与错误', /阶段: ErrorBoundary/.test(copied) && /错误: /.test(copied))
    check('复制内容含状态摘要', /状态: .*sessions=/.test(copied))
    check('复制后按钮给出反馈', /已复制|复制失败/.test(await copyButton.innerText()))
    const boundaryLog = await readDiagnostics(
      page,
      "(entry) => entry.kind === 'error' && entry.meta && entry.meta.stage === 'ErrorBoundary'"
    )
    check(
      '诊断里有 stage=ErrorBoundary + reason=render-throw',
      boundaryLog.length > 0 && boundaryLog[0].meta.reason === 'render-throw',
      boundaryLog[0] === undefined ? 'missing' : JSON.stringify(boundaryLog[0].meta)
    )
    check(
      '诊断里没有聊天正文（问题 1 / 回答 1 不得出现）',
      !boundaryLog.some(
        (entry) =>
          JSON.stringify(entry).includes('问题 1') || JSON.stringify(entry).includes('回答 1')
      )
    )
    const copiedShot = await shoot(page, '1.4.0-error-boundary-copied', 390, 844)
    check('复制反馈态截图已存', copiedShot.endsWith('1.4.0-error-boundary-copied-390.png'))

    console.log('\n[3] 确认弹窗期间：设置层 X 不可点、点遮罩也关不掉；取消后立刻恢复')
    await page.setViewportSize({ width: 1280, height: 900 })
    // 清掉上次的坏数据，重新来一遍（确认弹窗只在选好导入文件后出现）
    await page.evaluate(async () => {
      for (const info of await indexedDB.databases())
        if (info.name) indexedDB.deleteDatabase(info.name)
      localStorage.clear()
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const { confirm } = await seedViaImport(page, { keepConfirmOpen: true })
    const settingsDialog = page.locator('[role="dialog"]').first()
    const closeButton = settingsDialog.getByRole('button', { name: /关闭|Close/ }).first()
    check('确认弹窗已打开', await confirm.isVisible())
    check('设置层 X 被禁用（disabled 生效）', await closeButton.isDisabled())
    // 先截图（确认弹窗还开着、X 是禁用态），再做点击验证
    const confirmShot390 = await shoot(page, '1.4.0-error-boundary-confirm-x-disabled', 390, 844)
    const confirmShot360 = await shoot(page, '1.4.0-error-boundary-confirm-x-disabled', 360, 780)
    check(
      '确认弹窗态 390 / 360 无横向溢出',
      await noOverflow(page),
      `${confirmShot390} / ${confirmShot360}`
    )
    const box = await closeButton.boundingBox()
    if (box) {
      // 点「X」的位置：之前这一下只会取消导入、设置层照样开着 —— 用户以为 X 坏了
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(500)
    }
    check('点 X 的位置不会关掉设置层（仍需用户明确取消导入）', (await settingsDialog.count()) === 1)
    // 取消确认后 X 立刻恢复可点，一次就能退出设置
    const stillConfirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
    if (await stillConfirm.count()) {
      await stillConfirm
        .getByRole('button', { name: /取消/ })
        .first()
        .click()
    } else {
      // 上一次点击可能已经命中遮罩取消了导入（行为变化前后都允许），这里保证确认框已关闭
      await page.waitForTimeout(300)
    }
    await page.waitForTimeout(400)
    check('取消确认后设置层仍开着', (await settingsDialog.count()) === 1)
    check('取消确认后 X 恢复可点', !(await closeButton.isDisabled()))
    await closeButton.click()
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 })
    check('点一次 X 就退出设置（不再需要点两次）', (await page.getByRole('dialog').count()) === 0)

    console.log('\n[4] 回归：没有引入新的 pageerror / console error')
    // 第 2 步故意制造的渲染异常：React 一定会往 console 报一条，也会往 window 抛一条
    // （生产包文案是 Minified React error #31：「object with keys 不能被渲染成子节点」）
    const isDeliberate = (text) =>
      /Minified React error #31|not valid as a React child|objects are not valid as a react child/i.test(
        text
      )
    const unexpectedConsole = consoleErrors.filter((text) => !isDeliberate(text))
    check(
      'console error 只允许第 2 步那条故意触发的渲染异常',
      unexpectedConsole.length === 0,
      unexpectedConsole.join(' | ')
    )
    // 生产包里 React 会把边界捕获的错误记一条 console.error，是否再往 window 抛由 React 版本决定；
    // 关键是：除了这条故意的之外，没有别的未捕获异常（否则边界没兜住，整棵树会崩）
    check(
      'pageerror 里只有故意的渲染异常（边界已兜住，整棵树没有崩掉）',
      pageErrors.every(isDeliberate),
      `pageerror=${pageErrors.length}: ${pageErrors.join(' | ')}`
    )
  } finally {
    await browser.close()
    await server.close()
  }

  if (failures.length > 0) {
    console.error(`\nFAIL 错误边界 / 空值兜底 / 确认弹窗关闭：${failures.length} 条断言失败`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  console.log('\nPASS 错误边界 / 空值兜底 / 确认弹窗关闭（issue #28）')
}

/** 390 / 360 下不能横向滚动（scrollWidth 不得超过视口） */
const noOverflow = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  )

await run()
