// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 「导入历史会话 → 从链接导入」原生（APK）链路的自动化验收。
//
// 在真实 dist 上运行，只把 Capacitor 的原生桥替换掉：
//   - window.androidBridge 存在 → Capacitor.isNativePlatform() === true（与 Android WebView 一致）
//   - window.Capacitor.PluginHeaders 声明 CapacitorHttp.get → @capacitor/core 的 registerPlugin
//     会把 CapacitorHttp.get 转成 cap.nativePromise('CapacitorHttp','get',options)，
//     我们在这里返回构造好的响应（data 为 ArrayBuffer 或 base64，两种都覆盖）。
//
// 因此断言走的是真实代码：CapacitorHttp.get → urlImport 解析 → importHistory → staging → IndexedDB。
import { chromium } from 'playwright'
import { buildArchiveZip, textPayload } from '../fixtures/archive-fixture.mjs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const SHOT_DIR = new URL('../../docs/ui/', import.meta.url).pathname
const ZIP_URL = 'https://obs.example.test/deepseek_data-2026-11-01.zip'
const SESSION_TITLE = '链接导入测试会话'
const OVER_LIMIT_BYTES = 300 * 1024 * 1024

const base64 = (bytes) => Buffer.from(bytes).toString('base64')

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 打开应用并进入「设置 → 数据管理」；mock 的原生桥已经装好。 */
const openApp = async ({ payload, deferred = false }) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
  })
  await context.addInitScript(
    ({ payload, deferred }) => {
      window.androidBridge = { postMessage: () => {} }
      const bytesOf = (base64Value) => {
        const binary = atob(base64Value)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index)
        }
        return bytes
      }
      const mock = { calls: [], payload, deferred, resolve: null }
      const responseOf = () => {
        const bytes = bytesOf(mock.payload.data)
        const data = mock.payload.kind === 'base64-string' ? mock.payload.data : bytes.buffer
        return {
          status: mock.payload.status,
          headers: mock.payload.headers ?? {},
          url: mock.payload.url ?? '',
          data,
        }
      }
      window.__capMock = mock
      window.Capacitor = {
        PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] }],
        nativePromise: (pluginName, methodName, options) => {
          mock.calls.push({ pluginName, methodName, options })
          if (mock.payload.kind === 'reject') {
            return Promise.reject(new Error(mock.payload.message))
          }
          if (mock.deferred) {
            return new Promise((resolve) => {
              mock.resolve = () => resolve(responseOf())
            })
          }
          return Promise.resolve(responseOf())
        },
      }
    },
    { payload, deferred }
  )
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
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
  return { browser, page, consoleErrors }
}

/** IndexedDB 里的会话数：sessions 为正式数据，sessionsStaging 为空说明事务已提交。 */
const dbCounts = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const read = (store) =>
            new Promise((done, fail) => {
              if (!db.objectStoreNames.contains(store)) {
                done(0)
                return
              }
              const count = db.transaction(store, 'readonly').objectStore(store).count()
              count.onsuccess = () => done(count.result)
              count.onerror = () => fail(count.error)
            })
          Promise.all([read('sessions'), read('sessionsStaging'), read('filesStaging')])
            .then(([sessions, sessionsStaging, filesStaging]) => {
              resolve({ sessions, sessionsStaging, filesStaging })
            })
            .catch(reject)
        }
      })
  )

/** 填链接 → 点「导入」→ 在确认弹窗点「确认导入」（cancel=true 时改为点「取消」） */
const startUrlImport = async (page, { url = ZIP_URL, cancel = false } = {}) => {
  await page.getByLabel('从链接导入').fill(url)
  await page.getByRole('button', { name: '导入', exact: true }).click()
  const confirmDialog = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirmDialog.waitFor({ timeout: 5000 })
  if (cancel) {
    await confirmDialog.getByRole('button', { name: '取消', exact: true }).click()
  } else {
    await confirmDialog.getByRole('button', { name: '确认导入', exact: true }).click()
  }
}

const sessionCount = async (page) => (await dbCounts(page)).sessions

const zipBytes = buildArchiveZip({ title: SESSION_TITLE })
const zipPayload = {
  status: 200,
  headers: { 'Content-Length': String(zipBytes.byteLength), 'Content-Type': 'application/zip' },
  data: base64(zipBytes),
  kind: 'arraybuffer',
}

const run = async () => {
  // ── 用例 1：ArrayBuffer 数据 → 走完 importHistory，会话 +1 ───────────────────
  {
    console.log('\n[case 1] ArrayBuffer 数据：走完 importHistory 链路 + IndexedDB +1')
    const { browser, page, consoleErrors } = await openApp({ payload: zipPayload })
    check('原生判定：URL 输入框已渲染', (await page.getByLabel('从链接导入').count()) === 1)
    check('导入前会话数 = 0', (await sessionCount(page)) === 0)
    await startUrlImport(page)
    await page.getByText('已导入 1 个会话').waitFor({ timeout: 20000 })
    const calls = await page.evaluate(() => window.__capMock.calls)
    check('CapacitorHttp.get 被调用 1 次', calls.length === 1, `实际 ${calls.length}`)
    check(
      '走的是原生桥 CapacitorHttp.get',
      calls[0]?.pluginName === 'CapacitorHttp' && calls[0]?.methodName === 'get',
      JSON.stringify(calls[0] ?? null)
    )
    check('url 透传', calls[0]?.options?.url === ZIP_URL, String(calls[0]?.options?.url))
    check('responseType = arraybuffer', calls[0]?.options?.responseType === 'arraybuffer')
    // 超时数值会随下载策略调整（6bad149 起分块下载：连接 10s / 读 12s），
    // 这里只断言「有有限的单请求超时，且不超过下载阶段总预算」这条不变式，
    // 避免下次调整取值又把用例弄红。
    const DOWNLOAD_BUDGET_MS = 120_000
    const finiteWithinBudget = (value) =>
      Number.isFinite(value) && value > 0 && value <= DOWNLOAD_BUDGET_MS
    check(
      'connectTimeout 有限且 <= 下载总预算',
      finiteWithinBudget(calls[0]?.options?.connectTimeout),
      String(calls[0]?.options?.connectTimeout)
    )
    check(
      'readTimeout 有限且 <= 下载总预算',
      finiteWithinBudget(calls[0]?.options?.readTimeout),
      String(calls[0]?.options?.readTimeout)
    )
    check(
      'Accept 头覆盖 zip/octet-stream',
      String(calls[0]?.options?.headers?.Accept ?? '').includes('application/zip')
    )
    const counts = await dbCounts(page)
    check('IndexedDB sessions = 1', counts.sessions === 1, `实际 ${counts.sessions}`)
    check(
      'staging 已清空（替换事务提交）',
      counts.sessionsStaging === 0 && counts.filesStaging === 0,
      JSON.stringify(counts)
    )
    check('侧栏出现导入的会话', (await page.getByText(SESSION_TITLE).count()) > 0)
    await page.screenshot({ path: `${SHOT_DIR}1.4.0-beta.2-url-import-native.png` })
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 2：实测的真实返回形态（base64 字符串）→ 同样导入成功 ────────────────
  {
    console.log('\n[case 2] base64 字符串数据（Android CapacitorHttp 实际返回形态）')
    const { browser, page, consoleErrors } = await openApp({
      payload: { ...zipPayload, kind: 'base64-string' },
    })
    await startUrlImport(page)
    await page.getByText('已导入 1 个会话').waitFor({ timeout: 20000 })
    check('base64 数据也能导入，sessions = 1', (await sessionCount(page)) === 1)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 3：非 ZIP 数据 → 报「不是有效的 ZIP」且不写入 ─────────────────────
  {
    console.log('\n[case 3] 非 ZIP 数据：报错且不写入')
    const text = textPayload('this is definitely not a zip archive')
    const { browser, page, consoleErrors } = await openApp({
      payload: {
        status: 200,
        headers: { 'Content-Length': String(text.byteLength) },
        data: base64(text),
        kind: 'arraybuffer',
      },
    })
    await startUrlImport(page)
    const notZip = page.getByText(/不是有效的 ZIP 文件/)
    await notZip.waitFor({ timeout: 20000 })
    check(
      '提示「不是有效的 ZIP 文件」',
      /不是有效的 ZIP 文件/.test((await notZip.first().textContent()) ?? '')
    )
    check('会话数仍为 0', (await sessionCount(page)) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 4：Content-Length 超过 200MB → 拒绝 ─────────────────────────────
  {
    console.log('\n[case 4] Content-Length > 200MB：直接拒绝')
    const { browser, page, consoleErrors } = await openApp({
      payload: {
        status: 200,
        headers: { 'Content-Length': String(OVER_LIMIT_BYTES) },
        data: base64(zipBytes),
        kind: 'arraybuffer',
      },
    })
    await startUrlImport(page)
    const tooLarge = page.getByText(/文件过大（200MB）/)
    await tooLarge.waitFor({ timeout: 20000 })
    check(
      '提示「文件过大（200MB），暂不支持」',
      /文件过大（200MB）/.test((await tooLarge.first().textContent()) ?? '')
    )
    check('会话数仍为 0', (await sessionCount(page)) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 5：下载中取消 → 界面恢复、不写入 ────────────────────────────────
  {
    console.log('\n[case 5] 下载中取消：界面恢复可用且不写入')
    const { browser, page, consoleErrors } = await openApp({ payload: zipPayload, deferred: true })
    await startUrlImport(page, { cancel: true })
    const dialogGone = (await page.getByRole('dialog', { name: /确认导入历史对话/ }).count()) === 0
    check('确认弹窗已关闭', dialogGone)
    check(
      '「导入」按钮恢复可用',
      await page.getByRole('button', { name: '导入', exact: true }).isEnabled()
    )
    // 模拟下载此刻才返回：结果必须被丢弃
    await page.evaluate(() => window.__capMock.resolve?.())
    await page.waitForTimeout(2000)
    check('取消后不写入：sessions = 0', (await sessionCount(page)) === 0)
    check('取消后不提示成功', (await page.getByText('已导入 1 个会话').count()) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 6：网络失败 → 提示检查网络 ───────────────────────────────────────
  {
    console.log('\n[case 6] 网络失败：提示「下载失败，请检查网络连接后重试」')
    const { browser, page, consoleErrors } = await openApp({
      payload: { kind: 'reject', message: 'Failed to connect to /10.0.2.2:5199' },
    })
    await startUrlImport(page)
    const network = page.getByText(/(网络已断开|下载失败，请检查网络)/)
    await network.waitFor({ timeout: 20000 })
    check('提示网络类失败（离线/连接失败）', (await network.count()) > 0)
    check('会话数仍为 0', (await sessionCount(page)) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 7：超时 → 提示下载超时 ─────────────────────────────────────────
  {
    console.log('\n[case 7] 超时：提示「下载超时，请检查网络后重试」')
    const { browser, page, consoleErrors } = await openApp({
      payload: { kind: 'reject', message: 'Read timed out after 180000ms' },
    })
    await startUrlImport(page)
    const timeout = page.getByText(/下载超时，请检查网络后重试/)
    await timeout.waitFor({ timeout: 20000 })
    check('提示下载超时', (await timeout.count()) > 0)
    check('会话数仍为 0', (await sessionCount(page)) === 0)
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  // ── 用例 8：5MB 大包 + Android Base64.DEFAULT 换行 → 跨分块解码仍完整 ──────────
  {
    console.log('\n[case 8] 5MB 大包（base64 每 76 字符换行）：跨解码分块仍完整导入')
    const bigZip = buildArchiveZip({
      sessionId: 'big-link-session',
      title: SESSION_TITLE,
      padBytes: 5 * 1024 * 1024,
    })
    const wrapped = base64(bigZip).replace(/(.{76})/g, '$1\n')
    const { browser, page, consoleErrors } = await openApp({
      payload: {
        status: 200,
        headers: { 'Content-Length': String(bigZip.byteLength) },
        data: wrapped,
        kind: 'base64-string',
      },
    })
    await startUrlImport(page, { url: 'https://obs.example.test/big.zip' })
    await page.getByText('已导入 1 个会话').waitFor({ timeout: 60000 })
    check(
      `5MB 包（${bigZip.byteLength} 字节）导入成功，sessions = 1`,
      (await sessionCount(page)) === 1
    )
    check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))
    await browser.close()
  }

  if (failures.length > 0) {
    console.error(`\nFAIL 从链接导入（原生链路）：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log('\nPASS 从链接导入（原生链路）：全部断言通过')
}

await run()
