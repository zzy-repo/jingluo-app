/** #236 的实测工具：窄屏滚动容器（`.scroll`）在「滚动条出现」那一刻内容横向位移多少。
 *
 * 为什么要有这个脚本：`scrollbar-gutter` / `overflow-y` 这类改动的正确性**只能量**，不能靠推理。
 * #216 那轮是靠静态守卫 + 推理收口的，留了个尾巴（窄屏 `.scroll` 没有任何槽位处置），
 * 这里把「量」这一步补齐，改动前后跑同一份脚本对比。
 *
 * 量的到底是什么：
 *  1. 用**真实 CSS 文件**（`src/app/global.css` + `src/components/messages/MessageList.module.css`）
 *     和**真实组件结构**（`MessageList.tsx` 的窄屏分支：`.container > .scroll > .column > rows`，
 *     `isMobile` 为真时滚动层是 `.scroll`，与 `@media not all and (min-width: 768px)` 同一档）在
 *     Chromium 里搭一页；
 *  2. 先让列表短（不满一屏，无滚动条），量 `.column` 与第一行（同一个元素）的矩形；
 *  3. 往末尾追加内容直到真的溢出（滚动条出现），再量同一批元素；
 *  4. 位移 = 追加前后同元素的 `left/right/width` 差。期望恒为 0。
 *
 * 两个必须诚实标注的点：
 *  - **滚动条必须是 classic（占位式）才量得到**：overlay 滚动条宽度为 0，怎么改都不会跳。
 *    所以这里不开 `--hide-scrollbars`，并且在量之前先探一次「本环境滚动条占多少宽度」，
 *    探到 0 就直接报错退出 —— 绝不能在「本来就不跳」的环境里量出「不跳」然后当成证据。
 *    实测过这条环境差异（Playwright 1.64.1 / Chromium 1248，Windows）：
 *      `chromium.launch()`（headless shell）、`channel: 'chromium'`（新 headless）滚动条都是 **0 宽**，
 *      只有 `headless: false`（有窗口）才是 classic 的 **15px**。所以本脚本**必须** headed 跑。
 *  - **Chromium 83 是等价模拟，不是真机**：运行时下限 WebView 83 上，`scrollbar-gutter` 是未知声明
 *    （整条丢弃）、`@supports (scrollbar-gutter: …)` 判假。`--css=legacy83` 就是把 CSS 里这两种东西
 *    机械地删掉 —— 与 Chromium 83 计算出的 CSS 等价，但**没有在任何 83 内核上跑过**。
 *
 * 用法：
 *   node scripts/measure-narrow-scroll-shift.mjs [--width=390,360] [--css=current,legacy83]
 *                                                [--pointer=fine,coarse] [--expect=no-shift|shift] [--json]
 *
 * 退出码：量完照 `--expect` 判定；不给 `--expect` 就只打印不判定（默认 no-shift）。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

import { matrixConfig } from './compat/lib/matrix-config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// 档位来自 scripts/compat/matrix.config.json:captureWidths（与 p4-layout.mjs / shot-72.mjs 同一处），
// 免得加一档时漏改其中一处、报告里写着「两档已覆盖」但其实只跑了一档（issue #278）。
const DEFAULT_WIDTHS = matrixConfig().captureWidths

const parseArgs = (argv) => {
  const options = {
    widths: DEFAULT_WIDTHS,
    cssModes: ['current'],
    pointers: ['fine'],
    expect: 'no-shift',
    json: false,
  }
  for (const arg of argv) {
    const [key, raw] = arg.replace(/^--/u, '').split('=')
    const value = (raw ?? '').trim()
    if (key === 'width') options.widths = value.split(',').map((item) => Number(item.trim())).filter(Number.isFinite)
    else if (key === 'css') options.cssModes = value.split(',').map((item) => item.trim()).filter(Boolean)
    else if (key === 'pointer') options.pointers = value.split(',').map((item) => item.trim()).filter(Boolean)
    else if (key === 'expect') options.expect = value === 'shift' ? 'shift' : 'no-shift'
    else if (key === 'json') options.json = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

// ---------------------------------------------------------------- CSS 装载与 Chromium 83 等价模拟

const CSS_FILES = ['src/app/global.css', 'src/components/messages/MessageList.module.css']

/**
 * 把 CSS 变成「Chromium 83 计算出来的那一份」。
 *
 * Chromium 83 不认识 `scrollbar-gutter`：声明被整条丢弃、`@supports (scrollbar-gutter: …)` 块判假。
 * 所以等价变换只有两步，都要机械地做，不要顺手改别的：
 *  1. 删掉所有 `scrollbar-gutter: …;` 声明；
 *  2. 删掉所有条件里含 `scrollbar-gutter` 的 `@supports` 块（含嵌套块整体）。
 */
/** 把注释遮成等长空白（保留换行，索引不变）：注释里写着 `@supports` / `scrollbar-gutter` 时
 * 也不能让块匹配从注释里起头，否则会删错块、花括号失衡，变换结果不可信。 */
const maskComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, (whole) => whole.replace(/[^\n]/gu, ' '))

export const toLegacy83 = (css) => {
  // 只遮注释、不删注释：用遮过的文本做匹配与删除，输出即为「低内核看到的声明集」
  const masked = maskComments(css)
  const withoutDeclarations = masked.replace(/(?:^|[;{])\s*[\w-]*\s*scrollbar-gutter\s*:\s*[^;}]*/gu, (whole) =>
    whole.startsWith(';') || whole.startsWith('{') ? whole[0] : '',
  )
  const dropSupportsBlocks = (text) => {
    let out = text
    // 从内到外反复删：每轮删掉一个「条件含 scrollbar-gutter」的 @supports 块（含其嵌套内容）
    for (;;) {
      const start = findSupportsGutterBlock(out)
      if (start === -1) return out
      const end = matchBrace(out, out.indexOf('{', start))
      out = `${out.slice(0, start)}${out.slice(end + 1)}`
    }
  }
  const result = dropSupportsBlocks(withoutDeclarations)
  const open = (result.match(/\{/gu) ?? []).length
  const close = (result.match(/\}/gu) ?? []).length
  if (open !== close) {
    throw new Error(`legacy83 变换把 CSS 花括号改失衡了（${open} 个 { / ${close} 个 }）：变换结果不可信，先修变换`)
  }
  return result
}

const findSupportsGutterBlock = (text) => {
  const re = /@supports[^{]*\{/gu
  let match
  while ((match = re.exec(text)) !== null) {
    const prelude = text.slice(match.index, match.index + match[0].length)
    if (/scrollbar-gutter/u.test(prelude)) return match.index
    re.lastIndex = match.index + match[0].length
  }
  return -1
}

/** 从 `{` 的下标找到配对 `}` 的下标 */
const matchBrace = (text, openIndex) => {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return text.length - 1
}

/** 骨架页：结构照抄 `MessageList.tsx` 的窄屏分支，只补应用层提供的外壳高度 */
const buildHtml = (css) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>
  /* 应用层外壳：真实布局里 MessageList 外面还有一层撑满高度的纵向 flex */
  html, body { height: 100%; }
  #app { display: flex; flex-direction: column; height: 100%; }
  /* 行内容：只为让「宽度少 15px」真的改变折行，样式不参与被测逻辑 */
  .harness-row > p { margin: 0 0 12px; line-height: 22px; }
  .harness-footer { flex: none; height: 56px; }
  #harness-scrollbar-probe {
    position: fixed;
    left: -9999px;
    top: 0;
    width: 100px;
    height: 10px;
    overflow-y: scroll;
  }
  #harness-scrollbar-probe > div { height: 200px; }
</style>
</head>
<body>
<div id="app">
  <div class="container">
    <div class="scroll">
      <div class="column"></div>
    </div>
    <div class="harness-footer"></div>
  </div>
</div>
<!-- 环境探针：一个必然常驻滚动条的离屏小盒子，用来量「本环境的 classic 滚动条有多宽」。
     放在 .container 外面，不参与被测布局。 -->
<div id="harness-scrollbar-probe" aria-hidden="true"><div></div></div>
</body>
</html>`

// 样本文字长度是挑过的：让 350px 宽时折 2 行、335px 宽时折 3 行，这样「已渲染的行重新折行」也能量出来。
const ROW_TEXT = '窄屏滚动容器在滚动条出现的那一刻，已经渲染的行会重新折行，这一行用来量宽度。'

const appendRows = (args) => {
  const column = document.querySelector('.scroll > .column') ?? document.querySelector('.column')
  for (let index = 0; index < args.count; index += 1) {
    const row = document.createElement('div')
    row.className = 'harness-row'
    row.dataset.row = String(args.seed + index)
    const p = document.createElement('p')
    p.textContent = `${args.seed + index} ${args.text}`
    row.append(p)
    column.append(row)
  }
  return column.children.length
}

// ---------------------------------------------------------------- 量数（在浏览器里跑）

const measure = () => {
  const round = (value) => Math.round(value * 100) / 100
  const box = (element) => {
    if (element === null) return null
    const rect = element.getBoundingClientRect()
    return { left: round(rect.left), right: round(rect.right), width: round(rect.width) }
  }
  const scroll = document.querySelector('.scroll')
  const column = document.querySelector('.scroll > .column') ?? document.querySelector('.column')
  if (scroll === null || column === null) return { error: '没找到 .scroll / .column：结构假设已失效' }
  const rows = Array.from(column.querySelectorAll('.harness-row'))
  const first = rows[0] ?? null
  const last = rows[rows.length - 1] ?? null
  const lineCount = (row) => {
    if (row === null) return null
    const p = row.querySelector('p')
    if (p === null) return null
    const style = getComputedStyle(p)
    const height = p.getBoundingClientRect().height
    const lineHeight = Number.parseFloat(style.lineHeight)
    return Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(height / lineHeight) : null
  }
  const scrollStyle = getComputedStyle(scroll)
  return {
    // 环境自证：classic 滚动条才量得到；pointer 决定窄屏那条处置是否生效
    environment: {
      pointerFine: matchMedia('(hover: hover) and (pointer: fine)').matches,
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      gutterSupported: CSS.supports('scrollbar-gutter', 'stable'),
      viewportWidth: document.documentElement.clientWidth,
      classicScrollbarWidth: (() => {
        const probe = document.querySelector('#harness-scrollbar-probe')
        return probe === null ? 0 : probe.offsetWidth - probe.clientWidth
      })(),
    },
    // 被测层：滚动条的宽度变化是「因」，内容矩形变化是「果」
    scroll: {
      ...box(scroll),
      overflowY: scrollStyle.overflowY,
      scrollbarGutter: scrollStyle.scrollbarGutter,
      clientWidth: scroll.clientWidth,
      offsetWidth: scroll.offsetWidth,
      scrollbarWidth: scroll.offsetWidth - scroll.clientWidth,
      scrollHeight: Math.round(scroll.scrollHeight),
      clientHeight: scroll.clientHeight,
      overflows: scroll.scrollHeight > scroll.clientHeight,
    },
    column: box(column),
    firstRow: box(first),
    firstRowLines: lineCount(first),
    // 逐行折行数：滚动条出现后拿同一批行再量一次，变了的行就是「重新折行」的实证
    rowLines: Object.fromEntries(rows.map((row) => [row.dataset.row, lineCount(row)])),
    lastRow: box(last),
    lastRowLines: lineCount(last),
    rows: rows.length,
  }
}

// ---------------------------------------------------------------- 主流程

const startServer = async (html) => {
  const server = createServer(async (request, response) => {
    if (request.url === '/' || request.url?.startsWith('/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const makeContext = async (browser, pointer, width) => {
  const base = {
    viewport: { width, height: 844 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  }
  if (pointer === 'fine') return browser.newContext(base)
  // coarse：走真实触摸模拟（`isMobile` + `hasTouch`），Blink 据此把 pointer/hover 报成粗指针
  const context = await browser.newContext({ ...base, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  return context
}

const runOne = async ({ browser, width, cssMode, pointer, css }) => {
  const html = buildHtml(css)
  const server = await startServer(html)
  const context = await makeContext(browser, pointer, width)
  try {
    const page = await context.newPage()
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(120)

    // 一行一行加到「再加一行就会溢出」为止：此刻列表刚好不满一屏、没有滚动条，
    // 这一批行就是真实场景里「用户已经看到的那些消息」。
    await page.evaluate(appendRows, { count: 1, seed: 0, text: ROW_TEXT })
    await page.waitForTimeout(80)
    let before = await page.evaluate(measure)
    let guard = 0
    for (;;) {
      if (before.scroll.clientHeight === 0) break
      const rows = await page.evaluate(appendRows, { count: 1, seed: 1 + guard, text: ROW_TEXT })
      await page.waitForTimeout(16)
      const state = await page.evaluate(measure)
      guard += 1
      // 一旦真的溢出（滚动条出现）就停下：`before` 保留上一轮「还没溢出」的那份量数
      if (state.scroll.overflows || guard > 200 || rows > 400) break
      before = state
    }
    await page.waitForTimeout(200)
    const after = await page.evaluate(measure)

    if (before.error !== undefined || after.error !== undefined) {
      throw new Error(`量数失败：${before.error ?? after.error}`)
    }
    if (before.environment.classicScrollbarWidth === 0 && pointer === 'fine') {
      throw new Error(
        '本环境的滚动条宽度是 0（overlay 或已隐藏）：这样量不出「滚动条出现导致横向位移」，'
          + '证据无效。别加 --hide-scrollbars，也别在有覆盖式滚动条的环境里跑这个脚本。'
          + '（触屏上下文量到 0 是正常的：`isMobile` + `hasTouch` 下 Blink 走 overlay 滚动条，'
          + '那正说明叠加式滚动条不吃宽度 —— 这种组合用 --expect=no-shift 作为「零退化」对照。）',
      )
    }

    const delta = (from, to, key) =>
      from === null || to === null ? null : Math.round((to[key] - from[key]) * 100) / 100
    const shift = {
      firstRowLeft: delta(before.firstRow, after.firstRow, 'left'),
      firstRowRight: delta(before.firstRow, after.firstRow, 'right'),
      firstRowWidth: delta(before.firstRow, after.firstRow, 'width'),
      columnLeft: delta(before.column, after.column, 'left'),
      columnRight: delta(before.column, after.column, 'right'),
      columnWidth: delta(before.column, after.column, 'width'),
      firstRowLines: before.firstRowLines !== null && after.firstRowLines !== null
        ? after.firstRowLines - before.firstRowLines
        : null,
      // 已经渲染完（滚动条出现之前就在屏幕上）的行里，有多少行因为宽度少了一个滚动条而重新折行
      rewrappedRows: Object.keys(before.rowLines).filter(
        (key) => after.rowLines[key] !== undefined && after.rowLines[key] !== before.rowLines[key],
      ).length,
      renderedRowsBefore: Object.keys(before.rowLines).length,
      classicScrollbarWidth: after.scroll.scrollbarWidth - before.scroll.scrollbarWidth,
    }
    const magnitude = Math.max(
      Math.abs(shift.firstRowLeft ?? 0),
      Math.abs(shift.firstRowRight ?? 0),
      Math.abs(shift.firstRowWidth ?? 0),
      Math.abs(shift.columnLeft ?? 0),
      Math.abs(shift.columnRight ?? 0),
      Math.abs(shift.columnWidth ?? 0),
    )
    return { width, cssMode, pointer, before, after, shift, magnitude }
  } finally {
    await context.close()
    await server.close()
  }
}

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv)
  const currentCss = (await Promise.all(
    CSS_FILES.map((file) => readFile(path.join(ROOT, file), 'utf8')),
  )).join('\n')

  const cssByMode = {
    current: currentCss,
    legacy83: toLegacy83(currentCss),
  }
  for (const mode of options.cssModes) {
    if (cssByMode[mode] === undefined) throw new Error(`未知 --css=${mode}（只有 current / legacy83）`)
  }

  // headed：headless shell / 新 headless 的滚动条是 0 宽（overlay），量不到 classic 那 15px
  const browser = await chromium.launch({ headless: false })
  const results = []
  try {
    for (const width of options.widths) {
      for (const pointer of options.pointers) {
        for (const cssMode of options.cssModes) {
          const label = `${width}px ${pointer} ${cssMode}`
          process.stdout.write(`· ${label} … `)
          const result = await runOne({ browser, width, cssMode, pointer, css: cssByMode[cssMode] })
          results.push(result)
          console.log(`位移 ${result.magnitude}px（滚动条 ${result.after.scroll.scrollbarWidth}px）`)
        }
      }
    }
  } finally {
    await browser.close()
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log('\n位移明细（追加内容前后，同一个元素的矩形差；0 = 不跳）')
    const head = ['视口', '指针', 'CSS', '.column 宽', '首行右边缘', '首行宽', '滚动条', '重新折行']
    console.log(
      `${head[0].padEnd(6)} ${head[1].padEnd(7)} ${head[2].padEnd(9)} ${head[3].padStart(11)} `
        + `${head[4].padStart(11)} ${head[5].padStart(8)} ${head[6].padStart(7)} ${head[7].padStart(9)}`,
    )
    for (const item of results) {
      console.log(
        `${String(item.width).padEnd(6)} ${item.pointer.padEnd(7)} ${item.cssMode.padEnd(9)} `
          + `${String(item.shift.columnWidth).padStart(11)} ${String(item.shift.firstRowRight).padStart(11)} `
          + `${String(item.shift.firstRowWidth).padStart(8)} ${String(item.shift.classicScrollbarWidth).padStart(7)} `
          + `${`${item.shift.rewrappedRows}/${item.shift.renderedRowsBefore}`.padStart(9)}`,
      )
    }
    console.log('\n计算式状态（窄屏滚动容器的 computed 值）')
    for (const item of results) {
      const state = item.after.scroll
      console.log(
        `  ${String(item.width).padEnd(4)} ${item.pointer.padEnd(7)} ${item.cssMode.padEnd(9)} `
          + `overflow-y=${state.overflowY.padEnd(6)} scrollbar-gutter=${state.scrollbarGutter.padEnd(6)} `
          + `clientWidth ${item.before.scroll.clientWidth}→${item.after.scroll.clientWidth}`,
      )
    }
  }

  const expected = options.expect === 'shift' ? 'nonzero' : 'zero'
  const offenders = options.expect === 'shift'
    ? results.filter((item) => item.magnitude === 0)
    : results.filter((item) => item.magnitude !== 0)
  if (offenders.length > 0) {
    console.error(
      `\n✗ 期望 ${expected} 位移，但这些组合不符：`
        + offenders.map((item) => `${item.width}px/${item.pointer}/${item.cssMode}=${item.magnitude}px`).join('，'),
    )
    return 1
  }
  console.log(`\nOK：全部 ${results.length} 个组合都符合 --expect=${options.expect}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
