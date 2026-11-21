// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 正式包（非内测）回归：deepseek spec 下「深度思考 / 智能搜索 / 附件 / 语音」入口一个不少，
// 并对比「改动前」的输入区按钮清单，证明空态加的模式切换没有动到输入区。
//
//   node tests/integration/mode-switch-plain.test.mjs
//
// 前置全部自动处理（Issue #19）：
//   1) 当前正式包：需要时自动构建到 dist-plain/（DIST_OUT=dist-plain），然后自己起静态服务（PORT 可注入，默认 5191）；
//   2) baseline 基准：默认读 tests/fixtures/domain01-02/input-row-baseline.json（历史构建已不可复现）；
//      想用真实旧产物对比就传 BASELINE_URL=http://127.0.0.1:<port>。
// 以前要求手工准备两份 dist + 手动起 5191/5192，端口被占或产物缺失就假红。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
// 当前正式包：直接用标准产物 dist-standard（按 main 约定不隐式构建，缺就 SKIP(env)）
const PLAIN_DIST = process.env.STANDARD_DIST_DIR || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT
const BASELINE_URL = process.env.BASELINE_URL || ''
const BASELINE_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'domain01-02', 'input-row-baseline.json')

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

/**
 * 读出输入区（含所有功能性按钮）的可见文案/aria-label 列表。
 *
 * `[data-attachment-entry="unavailable"]` 的入口**不算功能性按钮**（#480 §7 / #538 / #527）：
 * 渠道不支持文本注入时，那个文档附件入口是有意保留的「禁用态图标按钮」—— 看得见、点下去给可读
 * 提示，但不提供任何功能。它的可访问名是一整句解释（「当前渠道不支持文档附件：…」），
 * 混进「功能按钮集合」就会让下面「与 baseline 完全一致」被一句话污染。
 *
 * 只按这个**显式标记**排除，不按通用状态排除：`发送` 在空输入时同样是 `aria-disabled="true"`，
 * 笼统过滤会把基线里的 `发送` 一起丢掉。停用入口「必须还在」由 [1] 的
 * `readUnavailableDocEntry` 单独断言 —— 所以这不是放宽。
 */
const readFunctionRow = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('textarea')?.closest('div[class*="wrapper"]')?.parentElement
    const scope = row ?? document.body
    return [...scope.querySelectorAll('button:not([data-attachment-entry="unavailable"])')]
      .map((button) => {
        const label = button.getAttribute('aria-label') || button.textContent?.trim() || ''
        const style = getComputedStyle(button)
        return style.display === 'none' || style.visibility === 'hidden' ? null : label
      })
      .filter(Boolean)
  })

/** 读出那个被标记的「不可用」文档附件入口，用来证明「不是把入口删了」 */
const readUnavailableDocEntry = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button[data-attachment-entry="unavailable"]')].map((button) => ({
      label: button.getAttribute('aria-label') || button.textContent?.trim() || '',
      ariaDisabled: button.getAttribute('aria-disabled'),
      visible: getComputedStyle(button).display !== 'none' && getComputedStyle(button).visibility !== 'hidden',
    }))
  )


const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
})
const consoleErrors = []

const open = async (url) => {
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   * 白名单 = 本页自己的 origin（正式包 / 可选的真实旧产物 baseline 各算一个；BASELINE_URL 为空时
   * 根本不打开第二页，白名单自然只剩一个）。
   */
  await installEgressGate(page, { appUrl: url })
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

// #480 §7 / #538：渠道不支持时那个文档附件入口是**禁用态**：必须还在（不许靠删入口对齐清单）、
// 必须仍然可见、必须带解释文案且 aria-disabled="true"，只是不计入上面的功能按钮集合。
const unavailableDocEntry = await readUnavailableDocEntry(page)
expect(
  unavailableDocEntry.length === 1 &&
    unavailableDocEntry[0].ariaDisabled === 'true' &&
    unavailableDocEntry[0].visible &&
    /文档附件/.test(unavailableDocEntry[0].label),
  '不可用的文档附件入口仍在（禁用态 + 解释文案），但不计入功能按钮',
  JSON.stringify(unavailableDocEntry)
)

const think = page.getByRole('button', { name: /深度思考/ }).first()
const search = page.getByRole('button', { name: /智能搜索/ }).first()
// #363 起缺省档位是专家模式：深度思考进来就是「开」的，点一下是关。
// 这里断言的是「可切换」（翻转 + 能复原），不写死某一档的初始值。
const thinkStart = await think.getAttribute('aria-pressed')
await think.click()
await search.click()
await wait(120)
expect(
  (await think.getAttribute('aria-pressed')) === (thinkStart === 'true' ? 'false' : 'true'),
  '深度思考可切换',
  `${thinkStart} → ${await think.getAttribute('aria-pressed')}`
)
expect((await search.getAttribute('aria-pressed')) === 'true', '智能搜索可切换')
await think.click()
await search.click()
await wait(120)
expect((await think.getAttribute('aria-pressed')) === thinkStart, '深度思考再点一次复原', await think.getAttribute('aria-pressed'))

const textarea = page.locator('textarea').first()
await textarea.type('正式包回归输入')
expect((await textarea.inputValue()) === '正式包回归输入', '输入框可正常输入')

const modeVisible = await page.getByRole('group', { name: /对话模式|Chat mode/ }).isVisible()
expect(modeVisible, '正式包里模式切换同样渲染在问候语下方')

const styles = await page.evaluate(async () => {
  // 选中态是有 CSS 过渡的：直接读 computedStyle 会读到过渡中间值
  // （实测 rgba(232, 237, 255, 0.647) / rgb(58, 77, 174)），慢机器上必假红。
  // 期望值不放宽，只是等样式连续两次读数一致再断言。
  const read = () => {
    const fast = document.querySelector('button[data-mode="fast"]')
    const expert = document.querySelector('button[data-mode="expert"]')
    return {
      fast: { bg: getComputedStyle(fast).backgroundColor, color: getComputedStyle(fast).color },
      expert: { bg: getComputedStyle(expert).backgroundColor, color: getComputedStyle(expert).color },
    }
  }
  let previous = read()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const next = read()
    const stable =
      next.fast.bg === previous.fast.bg &&
      next.fast.color === previous.fast.color &&
      next.expert.bg === previous.expert.bg &&
      next.expert.color === previous.expert.color
    if (stable) return next
    previous = next
  }
  return previous
})
// #363：缺省档位从 fast 改成 expert（默认就思考），所以选中态落在「专家模式」上
expect(
  styles.expert.bg === 'rgb(232, 237, 255)' &&
    styles.expert.color === 'rgb(77, 107, 254)' &&
    styles.fast.bg === 'rgba(0, 0, 0, 0)',
  '正式包默认选中「专家模式」（#363 缺省档 = 开思考）',
  `expert=${styles.expert.bg} / ${styles.expert.color}，fast=${styles.fast.bg}`
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
  console.log(`  ·   对比基线快照：tests/fixtures/domain01-02/input-row-baseline.json（${baselineFixture.recordedFrom}）`)
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

// #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）
assertNoEgress(failures)
await browser.close()
plainServed?.kill()
if (failures.length === 0) {
  console.log('\n正式包回归通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
