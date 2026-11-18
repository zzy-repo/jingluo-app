// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// Web 端（5181）验收：不提供「从链接导入」，只保留手动上传 ZIP；顺带回归本地文件上传。
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { defaultDist, verifyAppUrl } from '../helpers/env.mjs'
import { buildArchive } from '../fixtures/archive-fixture.mjs'

const APP_URL = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '5181'}`
// 环境守卫：端口撞车 / 产物陈旧 → SKIP(env)，不产生假红（Issue #19）
await verifyAppUrl(APP_URL, defaultDist(), { variant: 'standard' })
const SHOT_DIR = new URL('../../docs/ui/', import.meta.url).pathname
const TITLE_PREFIX = '网页上传测试会话'
/** 夹具会给标题加序号（单会话是「<prefix> 1」），侧栏显示的就是这个名字 */
const SESSION_TITLE = `${TITLE_PREFIX} 1`

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

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
  await page
    .getByRole('tab', { name: /数据管理|Data/ })
    .first()
    .click()

  console.log('\n[web 1] 网页端不渲染「从链接导入」入口，并给出替代提示')
  check('URL 输入框数量 = 0', (await page.locator('input[type="url"]').count()) === 0)
  check('无障碍标签「从链接导入」不存在', (await page.getByLabel('从链接导入').count()) === 0)
  check(
    '「导入」按钮（链接入口）不存在',
    (await page.getByRole('button', { name: '导入', exact: true }).count()) === 0
  )
  const hint = page.getByText(/网页版无法直接下载导出链接/)
  check('提示「网页版无法直接下载导出链接，请手动下载 ZIP 后上传」', (await hint.count()) > 0)
  check(
    '本地「上传」按钮仍存在',
    (await page.getByRole('button', { name: /上传|Upload/ }).count()) > 0
  )
  // 证据截图：数据管理分组里只有「上传」，没有任何链接导入入口，说明里给出替代做法
  await page.screenshot({ path: `${SHOT_DIR}1.4.0-beta.2-url-import-web.png` })

  console.log('\n[web 2] 回归：本地文件上传仍可用')
  const dir = await mkdtemp(path.join(tmpdir(), 'deepseek-archive-'))
  const zipPath = path.join(dir, 'deepseek_data.zip')
  // 夹具参数是 titlePrefix（历史名字叫 title，改名后这里曾静默失效 → Issue #19）
  const { zip } = buildArchive({ titlePrefix: TITLE_PREFIX })
  await writeFile(zipPath, zip)
  check('上传前会话数 = 0', (await sessionCount(page)) === 0)
  await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipPath)
  const confirmDialog = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirmDialog.waitFor({ timeout: 5000 })
  await page.screenshot({ path: `${SHOT_DIR}1.4.0-beta.2-url-import-web-confirm.png` })
  await confirmDialog.getByRole('button', { name: '确认导入', exact: true }).click()
  // 文案契约（src/i18n/zh.ts）：1.4.0-beta.8 起「已导入 N 个对话」→「已导入 N 个会话」，
  // 这里兼容两种措辞，避免每次改词都假红。
  await page.getByText(/已导入 1 个(对话|会话)/).waitFor({ timeout: 30000 })
  check('上传导入后会话数 = 1', (await sessionCount(page)) === 1)
  check(
    '侧栏出现导入的会话',
    (await page.getByText(SESSION_TITLE).count()) > 0,
    `找不到标题「${SESSION_TITLE}」`
  )

  console.log('\n[web 3] console error = 0')
  check('console error = 0', consoleErrors.length === 0, consoleErrors.join(' | '))

  await browser.close()
  if (failures.length > 0) {
    console.error(`\nFAIL Web 端链接导入行为 + 文件上传回归：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log('\nPASS Web 端链接导入行为 + 文件上传回归')
}

await run()
