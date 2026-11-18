// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 正式包（非内测）回归：deepseek spec 下「深度思考 / 智能搜索 / 附件 / 语音」入口一个不少，
// 并对比「改动前」的输入区按钮清单，证明空态加的模式切换没有动到输入区。
//
//   node tests/integration/mode-switch-plain.test.mjs
//
// 前置全部自动处理（Issue #19）：
//   1) 当前正式包：需要时自动构建到 dist-plain/（DIST_OUT=dist-plain），然后自己起静态服务（PORT 可注入，默认 5191）；
//   2) baseline 基准：默认读 tests/fixtures/input-row-baseline.json（历史构建已不可复现）；
//      想用真实旧产物对比就传 BASELINE_URL=http://127.0.0.1:<port>。
// 以前要求手工准备两份 dist + 手动起 5191/5192，端口被占或产物缺失就假红。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
// 当前正式包：直接用标准产物 dist-standard（按 main 约定不隐式构建，缺就 SKIP(env)）
const PLAIN_DIST = process.env.STANDARD_DIST_DIR || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT
const BASELINE_URL = process.env.BASELINE_URL || ''
const BASELINE_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'input-row-baseline.json')

// 端口自动发现（PORT 可注入）：不再固定 5191；产物目录也不用手工准备
const plainServed = process.env.PLAIN_URL
  ? null
  : await serveDir(PLAIN_DIST, { port: PORT, label: '标准产物 dist-standard' })
const plainUrl = process.env.PLAIN_URL || plainServed.url
await verifyAppUrl(plainUrl, PLAIN_DIST, { variant: 'standard' })
const baselineFixture = JSON.parse(readFileSync(BASELINE_FIXTURE, 'utf8'))

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (cond, message, detail) => {
  if (cond) {
    ok(detail ? `${message}（${detail}）` : message)
  } else {
    bad(detail ? `${message}（实际：${detail}）` : message)
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 读出输入区（含所有功能性按钮）的可见文案/aria-label 列表 */
const readFunctionRow = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('textarea')?.closest('div[class*="wrapper"]')?.parentElement
    const scope = row ?? document.body
    return [...scope.querySelectorAll('button')]
      .map((button) => {
        const label = button.getAttribute('aria-label') || button.textContent?.trim() || ''
        const style = getComputedStyle(button)
        return style.display === 'none' || style.visibility === 'hidden' ? null : label
      })
      .filter(Boolean)
  })

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
})
const consoleErrors = []

const open = async (url) => {
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${url} :: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`${url} :: ${String(error)}`))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.localStorage.clear()
    // 种一个 API Key，避免空态自动弹「设置」挡住输入区（与本用例无关）
    window.localStorage.setItem('chat-demo:api-key', 'sk-plain-regression-0001')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('textarea').first().waitFor({ timeout: 15000 })
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  return page
}

console.log('\n[1] 当前正式包：输入区入口齐全')
const page = await open(plainUrl)
const labels = await readFunctionRow(page)
for (const name of [/深度思考/, /智能搜索/, /上传文件|附件/, /语音|Voice/]) {
  expect(labels.some((label) => name.test(label)), `入口仍在：${name}`, labels.join(' / '))
}

const think = page.getByRole('button', { name: /深度思考/ }).first()
const search = page.getByRole('button', { name: /智能搜索/ }).first()
await think.click()
await search.click()
await wait(120)
expect((await think.getAttribute('aria-pressed')) === 'true', '深度思考可切换')
expect((await search.getAttribute('aria-pressed')) === 'true', '智能搜索可切换')
await think.click()
await search.click()

const textarea = page.locator('textarea').first()
await textarea.type('正式包回归输入')
expect((await textarea.inputValue()) === '正式包回归输入', '输入框可正常输入')

const modeVisible = await page.getByRole('group', { name: /对话模式|Chat mode/ }).isVisible()
expect(modeVisible, '正式包里模式切换同样渲染在问候语下方')

const styles = await page.evaluate(() => {
  const fast = document.querySelector('button[data-mode="fast"]')
  const expert = document.querySelector('button[data-mode="expert"]')
  return {
    fast: { bg: getComputedStyle(fast).backgroundColor, color: getComputedStyle(fast).color },
    expert: { bg: getComputedStyle(expert).backgroundColor, color: getComputedStyle(expert).color },
  }
})
expect(
  styles.fast.bg === 'rgb(232, 237, 255)' && styles.fast.color === 'rgb(77, 107, 254)',
  '正式包默认选中「快速模式」',
  `${styles.fast.bg} / ${styles.fast.color}`
)

console.log('\n[2] 与 baseline 对比输入区按钮清单')
const normalize = (list) => [...new Set(list)].sort()
let baselineLabels
let baselineHasMode
if (BASELINE_URL) {
  console.log(`  ·   对比真实旧产物：${BASELINE_URL}`)
  const baseline = await open(BASELINE_URL)
  baselineLabels = await readFunctionRow(baseline)
  baselineHasMode = await baseline.getByRole('group', { name: /对话模式|Chat mode/ }).count()
} else {
  console.log(`  ·   对比基线快照：tests/fixtures/input-row-baseline.json（${baselineFixture.recordedFrom}）`)
  baselineLabels = baselineFixture.functionRowButtons
  baselineHasMode = baselineFixture.modeSwitchRendered ? 1 : 0
}
const same =
  JSON.stringify(normalize(labels.filter((label) => !/模式/.test(label)))) ===
  JSON.stringify(normalize(baselineLabels))
expect(
  same,
  '输入区功能性按钮与 baseline 完全一致',
  `current=[${normalize(labels).join(' | ')}] baseline=[${normalize(baselineLabels).join(' | ')}]`
)
expect(baselineHasMode === 0, 'baseline 确实没有模式切换（对比基准有效）')

expect(consoleErrors.length === 0, 'console error = 0', consoleErrors.join(' | '))

await browser.close()
plainServed?.kill()
if (failures.length === 0) {
  console.log('\n正式包回归通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
