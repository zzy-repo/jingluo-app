// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 正式包（非内测）回归：deepseek spec 下「深度思考 / 智能搜索 / 附件」入口一个不少，
// 并对比「改动前」的输入区按钮清单，证明空态加的模式切换没有动到输入区。
//
// #813 之后标准包的官方渠道是**精简工具栏**（只留最右边的文件上传回形针）：语音入口与文档入口
// （含 `data-attachment-entry="unavailable"` 那一支占位）**彻底不渲染**，所以本用例对这个渠道的
// 期望按能力表区分 —— 「语音入口在不在」不再是通用断言：
//   · 官方渠道（`kind === 'deepseek'`，标准包的默认渠道）：只有 深度思考 / 智能搜索 / 上传文件 / 发送；
//   · 其它渠道：语音本来也不渲染（三渠道 `caps.asr === false`），文档入口按 `acceptsDocuments()`
//     渲染成真入口或禁用态占位 —— 那半边由 `provider-channels` / `caps` / `compact-toolbar-813` 守。
// 单子 #813 的口径是「改门禁而不是回退 UI」，所以这里改的是期望，不是产品。
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
import { consumeApiV1Prefix, consumeBaseUrl } from '../../scripts/lib/endpoints.mjs'

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
   *
   * `settings/public` 是应用启动时**合法**要拉一次的服务端开关（`main.tsx` 的身份层接线），
   * 与本用例无关：登记成桩（精确 host + path）而不是让它掉进「未登记 → abort」，
   * 否则那两条 `ERR_FAILED` 会混进下面「console error = 0」的断言里（存量假红）。
   */
  await installEgressGate(page, {
    appUrl: url,
    stubs: [
      {
        name: 'settings-public',
        host: new URL(consumeBaseUrl).host,
        // `consumeBaseUrl` 自带路径前缀（/staging），所以 pathname = 前缀 + /api/v1 + /settings/public
        path: `${new URL(consumeBaseUrl).pathname}${consumeApiV1Prefix}/settings/public`,
        respond: () => ({ status: 200, body: '{}' }),
      },
    ],
  })
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
    // 显式钉住「官方渠道」：本用例断言的是 deepseek 这一档的入口清单（标准包的默认渠道也是它），
    // 写出来是为了让「按渠道区分期望」这件事在用例里看得见（#813）。
    window.localStorage.setItem('chat-demo:provider-kind', 'deepseek')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('textarea').first().waitFor({ timeout: 15000 })
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  return page
}

console.log('\n[1] 当前正式包（官方渠道）：精简工具栏')
const page = await open(plainUrl)
const labels = await readFunctionRow(page)
for (const name of [/深度思考/, /智能搜索/, /上传文件|附件/]) {
  expect(labels.some((label) => name.test(label)), `入口仍在：${name}`, labels.join(' / '))
}

/**
 * #813：官方渠道（`kind === 'deepseek'`）的输入框右侧**只留最右边的文件上传**。
 *
 * 这一节原来断言「语音入口在」+「文档入口的禁用态占位在」（#480 §7 / #538 定的口径），
 * 那是精简之前的现实。现在两者都**彻底不渲染**（不是渲成禁用态），所以期望整体翻过来：
 *   · 语音入口：DOM 里 0 个节点；
 *   · 文档入口：`attach-document` 0 个、`data-attachment-entry="unavailable"` 也是 0 个；
 *   · 回形针（图片入口 `attach-image`）仍在 —— 精简不许把「最右边那个」也删了。
 * 这不是把门禁放宽成「什么都不用有」：下面 [2] 仍然逐字对比 baseline（只减去 #813 有意移除的
 * 语音入口），其它渠道的入口显隐由 `provider-channels` / `compact-toolbar-813` 守。
 */
const officialEntries = await page.evaluate(() => ({
  voice: document.querySelectorAll('button[aria-label="语音输入"],body button[aria-label="Voice input"]').length,
  voiceLabels: [...document.querySelectorAll('button')]
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((label) => /语音|Voice/.test(label)),
  document: document.querySelectorAll('[data-testid="attach-document"]').length,
  image: document.querySelectorAll('[data-testid="attach-image"]').length,
}))
expect(
  officialEntries.voice === 0 && officialEntries.voiceLabels.length === 0,
  '语音输入入口不存在（官方渠道精简工具栏，#813）',
  JSON.stringify(officialEntries.voiceLabels)
)
// #480 §7 / #538 的「禁用态占位」在官方渠道也一起退场（#813）：两种状态都不许有节点
const unavailableDocEntry = await readUnavailableDocEntry(page)
expect(
  officialEntries.document === 0 && unavailableDocEntry.length === 0,
  '文档入口两种状态都不渲染（既没有真入口，也没有「不可用」占位）',
  `attach-document=${officialEntries.document} / unavailable=${unavailableDocEntry.length}`
)
expect(
  officialEntries.image === 1,
  '最右边的文件上传（attach-image）仍在',
  `attach-image=${officialEntries.image}`
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
/**
 * baseline 是「改动前」正式包的快照（含语音入口）。#813 有意从官方渠道移除了语音入口，
 * 所以对比前**只减去这一条**（`语音输入` / `Voice input`），其余一条都不许差：
 * 多出 / 少掉任何别的按钮仍然是红 —— 模式切换这条线（本用例的初衷）照旧被守住。
 */
const removedBy813 = /^(语音输入|Voice input)$/u
const expected = normalize(baselineLabels.filter((label) => !removedBy813.test(label)))
const same =
  JSON.stringify(normalize(labels.filter((label) => !/模式/.test(label)))) ===
  JSON.stringify(expected)
expect(
  same,
  '输入区功能性按钮与 baseline 一致（#813 移除的语音入口除外）',
  `current=[${normalize(labels).join(' | ')}] baseline(#813 后预期)=[${expected.join(' | ')}]`
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
