// [layer: integration | 依赖: playwright + chromium + 真实 dist 产物（APP_URL 由 run-layer 注入） | 耗时: 1~3 分钟]
//
// 域 5 / N9：**UI 单通路（导入 + 导出 + 置灰）**（docs/testing/coverage/domain-05.md §6.2 N9，半表）。
//
// 覆盖功能点：
//   F-05-01 从本地 ZIP 导入整包（确认弹窗 → 进度文案 → 侧栏出现会话）
//   F-05-09 导入进度反馈（「已导入 N 个会话」是用户唯一能看见的完成信号）
//   F-05-11 本地 ZIP 文件导入（网页版 / 手动下载路径）
//   F-05-23 导出全部历史为 ZIP（真实按钮 → 真实下载产物）
//   F-05-26 空历史置灰（空历史点不动，有会话时可点，导出结束后必须回到可再点状态）
//   F-05-28 导出后立即导入（**同一页面里先导出再导入**，这是任何 L0 都替代不了的一段）
//   F-05-23b「导出选中」也真的产出文件（#536）：它在 #390 落地时走的是 Web 锚点下载，
//   在 Android WebView 里对 blob URL 会**静默失败**；现在与全量导出共用同一个落盘出口，
//   这里钉的是「同一条路在浏览器里仍然真的下载、且产物只含勾中的会话」。
//
// 不可下放 L0：需要真实 DOM（确认弹窗、进度文案、disabled 态）与真实下载通道；
// 「同一页面里先导出再导入」是壳层与 Web 的跨层契约，只能在这里验。
//
// F-05-24 / F-05-25（导出进度、导出取消）在本分支上**功能尚未实现**（#336 未落地），
// 因此这里只钉「导出结束后按钮回到可再点状态」这一条稳定契约；进度条与取消入口落地后在本文件补两条断言，
// 不新增用例条数。
//
//   node tests/run-layer.mjs integration --case tests/integration/domain05-ui-export-import.test.mjs
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { buildArchiveZip } from '../fixtures/domain05/archive-fixture.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import { BUILTIN_KEY_CLAIM_STUB } from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'


const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const TITLE_PREFIX = '域5往返会话'
const SESSION_COUNT = 2

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 真库里的会话条数（不是看 DOM，避免「界面显示 2 条但库里 4 条」这种假绿）。 */
const sessionCount = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('sessions')) {
            resolve(0)
            return
          }
          const count = db.transaction('sessions', 'readonly').objectStore('sessions').count()
          count.onsuccess = () => resolve(count.result)
          count.onerror = () => reject(count.error)
        }
      })
  )

const run = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    // 桌面宽度：侧栏常驻，才能直接断言「导入后侧栏出现会话标题」
    // （窄屏下侧栏在抽屉里，断言会退化成「抽屉里有没有」，与本用例关心的通路无关）
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   * 本用例的全部通路（导入 ZIP / 导出下载）都在被测产物自己的 origin 上，白名单里只需要它。
   */
  await installEgressGate(page, { stubs: [BUILTIN_KEY_CLAIM_STUB], appUrl: APP_URL })
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
  await page.waitForTimeout(800)

  if ((await page.getByRole('dialog').count()) === 0) {
    await page
      .getByRole('button', { name: /设置|Settings/ })
      .last()
      .click()
  }
  await page.getByTestId('settings-row-data').first().click()

  const exportButton = page.getByRole('button', { name: '下载', exact: true })
  const fileInput = page.locator('input[type="file"][accept*="zip"]')

  console.log('\n[N9-1] 空历史：导出按钮置灰（F-05-26）')
  check('空历史时导出按钮存在', (await exportButton.count()) === 1)
  check('空历史时导出按钮不可点', await exportButton.isDisabled())
  check('空历史时库里会话数 = 0', (await sessionCount(page)) === 0)

  console.log('\n[N9-2] 本地 ZIP 导入：确认弹窗 → 进度文案 → 侧栏出现会话（F-05-01/09/11）')
  const dir = await mkdtemp(path.join(tmpdir(), 'domain05-ui-'))
  const fixturePath = path.join(dir, 'deepseek_data.zip')
  await writeFile(
    fixturePath,
    buildArchiveZip({ sessionCount: SESSION_COUNT, imageBytes: 1024, titlePrefix: TITLE_PREFIX })
  )
  await fileInput.setInputFiles(fixturePath)
  const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirm.waitFor({ timeout: 5000 })
  check('确认弹窗出现（不会一点就覆盖）', (await confirm.count()) === 1)
  await confirm.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.getByText(/已导入 2 个会话/).waitFor({ timeout: 30000 })
  check('进度文案「已导入 2 个会话」出现', true)
  check('导入后库里会话数 = 2', (await sessionCount(page)) === SESSION_COUNT)
  check(
    '侧栏出现导入的会话标题',
    (await page.getByText(new RegExp(TITLE_PREFIX)).count()) > 0
  )

  console.log('\n[N9-3] 有会话后导出可点，产物是合法命名的 ZIP（F-05-23）')
  check('有会话时导出按钮可点', await exportButton.isDisabled() === false)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), exportButton.click()])
  const exportedPath = path.join(dir, 'exported.zip')
  await download.saveAs(exportedPath)
  const name = download.suggestedFilename()
  check(
    `下载文件名符合 deepseek_data-日期.zip（实际 ${name}）`,
    /^deepseek_data-\d{4}-\d{2}-\d{2}\.zip$/.test(name)
  )
  const exportedSize = (await stat(exportedPath)).size
  check(`产物非空（${(exportedSize / 1024).toFixed(1)}KB）`, exportedSize > 0)
  const head = await readFile(exportedPath)
  check('产物以 ZIP 头 PK\\x03\\x04 开头', head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4)
  check('导出失败提示未出现', (await page.getByText(/导出失败/).count()) === 0)

  console.log('\n[N9-4] 导出结束后按钮回到可再点状态（#336 验收 1 的最小可观测形态）')
  await page.waitForTimeout(200)
  check('导出结束后按钮可再点', (await exportButton.isDisabled()) === false)

  console.log('\n[N9-5] 同一页面里把刚导出的包再导入（F-05-28 往返）')
  await fileInput.setInputFiles(exportedPath)
  const confirmAgain = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirmAgain.waitFor({ timeout: 5000 })
  await confirmAgain.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.getByText(/已导入 2 个会话/).waitFor({ timeout: 30000 })
  check(
    '自产包能再次导入（会话数仍是 2，说明是替换而不是叠加）',
    (await sessionCount(page)) === SESSION_COUNT
  )
  check('导入后标题仍然可读', (await page.getByText(new RegExp(TITLE_PREFIX)).count()) > 0)

  console.log('\n[N9-6] 「导出选中」走同一个落盘出口，浏览器里仍然真的下载（#536）')
  // 先退出设置弹层：选择模式在侧栏上，弹层还开着会挡住点击
  await page.getByRole('button', { name: /关闭|Close/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTestId('sider-select-toggle').click()
  const boxes = page.locator('[role="checkbox"]')
  await boxes.first().waitFor({ timeout: 10000 })
  check('选择模式下每条会话都有勾选框', (await boxes.count()) === SESSION_COUNT)
  // 只勾**一条**：这样「产物里只有勾中的会话」才是有差别的断言（全勾就等于全量导出）
  await boxes.first().click()
  check(
    '底栏计数跟着变化',
    (await page.getByTestId('sider-selection-count').innerText()).includes('1')
  )
  const [selectedDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByTestId('sider-export-selected').click(),
  ])
  const selectedPath = path.join(dir, 'selected.zip')
  await selectedDownload.saveAs(selectedPath)
  const selectedName = selectedDownload.suggestedFilename()
  check(
    `「导出选中」也产出了 deepseek_data-日期.zip（实际 ${selectedName}）`,
    /^deepseek_data-\d{4}-\d{2}-\d{2}\.zip$/.test(selectedName)
  )
  const selectedBytes = await readFile(selectedPath)
  check(
    '「导出选中」产物同样是 ZIP',
    selectedBytes[0] === 0x50 && selectedBytes[1] === 0x4b && selectedBytes[2] === 3 && selectedBytes[3] === 4
  )
  const selectedIndex = JSON.parse(strFromU8(unzipSync(new Uint8Array(selectedBytes))['chat_session_index.json']))
  check(`产物里只有勾中的 1 条会话（实际 ${selectedIndex.length} 条）`, selectedIndex.length === 1)
  // 落盘成功才说「已导出」：提示里带真正写下去的文件名（#536 的新文案）
  check(
    '提示里报出了落盘文件名',
    (await page.getByText(new RegExp(`文件：${selectedName.replaceAll('.', '\\.')}`)).count()) > 0
  )
  check('导出选中没有留下失败提示', (await page.getByText(/导出失败/).count()) === 0)
  // 导出成功后自动退出选择模式（#390 的既有行为）
  check('导出完成后退出选择模式', (await page.getByTestId('sider-select-toggle').count()) === 1)

  console.log('\n[N9-7] 整条通路没有 console error / 未捕获异常')
  check('console error = 0', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）
  assertNoEgress(failures)

  await browser.close()
  if (failures.length > 0) {
    console.error(`\nFAIL 域5 UI 单通路（导入 + 导出 + 置灰）：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log('\nPASS 域5 UI 单通路（导入 + 导出 + 置灰）')
}

await run()
