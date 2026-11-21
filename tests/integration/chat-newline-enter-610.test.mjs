// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1.5 分钟]
// GitHub issue #610：换行档/编辑框里在段首按回车，不许退出编辑、不许切换会话、不许把屏幕甩走；
// 长会话上滑看历史时，内容/行高变化不许把阅读位置弹回去。
//
//   DIST_DIR=dist-standard node tests/integration/chat-newline-enter-610.test.mjs
//
// 会话数据由 fixture 直接写 IndexedDB（chat-demo v13）后**新建 page** 打开应用，
// 让 store 首次 hydration 就读到库里的会话（与 copy-limit / domain04 同一套做法）。
//
// 覆盖：
//   [1] 回车 = 换行：编辑态仍在、值多一个 \n、光标落在新行首（390 移动端 + 1280 桌面端）
//   [2] 回车事件被输入框吃掉：document 冒泡 / window 都收不到（只剩 capture 能看到）
//   [3] 会话没被切换：挂载窗口里的消息 id 全是本会话的
//   [4] 中文输入法合成期（isComposing）不拦：事件不被 preventDefault，也不插换行
//   [5] 上滑看历史时内容变化（编辑上方已挂载的消息）后，正在读的那一行屏幕位置不变
//   [6] 上滑过程本身不出现反向跳动（rAF 逐帧方向的单调性）
//   [7] 切会话后仍然贴底（不许为了锚定把 #386 的跟随逻辑弄坏）
//
// 负向对照（两条，都必须红）：
//   · 把修复前的产物（origin/main 构建）指向 DIST_DIR → [1][2] 红（桌面端回车直接发送并退出编辑）
//   · 去掉 UserMessage 里的 stopPropagation() / preventDefault() → [2] 红（事件冒到 document 冒泡层）
//
// 未测（本用例不覆盖，需要真机）：
//   · Android WebView 真机软键盘：Enter 键（enterKeyHint=enter）与输入法候选栏的行为
//   · 真机触屏滑动的惯性/回弹手感（本用例用滚轮驱动滚动层，触摸滚动在 Chromium 移动端仿真下驱动不到容器）
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DB_NAME, clearAllStores, ensureChatDb, writeSessions } from '../helpers/chat-db.mjs'
import { serveDir, verifyDist } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')
/** 截图前缀：修前 / 修后各跑一遍，产物按前缀分开（docs/ui/<prefix>-<宽度>.png） */
const SHOT_PREFIX = process.env.SHOT_PREFIX || 'issue610-after'

const now = 1_700_000_000_000
const lines = (tag, count) =>
  Array.from(
    { length: count },
    (_, index) => `${tag} 第 ${index} 行：这是一段用来撑高行的正文，模拟真实回答长度。`
  ).join('\n\n')

/** 长会话：24 条，回答长短不一，足以让虚拟列表在上滑时反复挂载/实测行高 */
const LONG = {
  id: 's-long',
  title: '长会话',
  createdAt: now,
  updatedAt: now,
  messages: Array.from({ length: 24 }, (_, index) =>
    index % 2 === 0
      ? {
          id: `s-long-u${index}`,
          role: 'user',
          content: `第 ${index} 问：短问题`,
          files: [],
          createdAt: now + index,
        }
      : {
          id: `s-long-a${index}`,
          role: 'assistant',
          createdAt: now + index,
          blocks: [{ type: 'text', text: lines(`答 ${index}`, 6 + (index % 4) * 3) }],
          status: 'done',
          model: 'deepseek-chat',
        }
  ),
}
/**
 * 另一个**同样长**的会话：既能判断「有没有被切走」（id 前缀不同），
 * 又能在切过去后检查「是否落在底部」（短会话没有可滚内容，那条断言就变成空断言）。
 */
const OTHER = {
  id: 's-other',
  title: '别的会话',
  createdAt: now + 1,
  updatedAt: now + 1,
  messages: LONG.messages.map((message) => ({
    ...message,
    id: message.id.replace('s-long-', 's-other-'),
  })),
}

const PROBE = () => {
  window.__probe = { keys: [] }
  const log = (phase) => (event) => {
    window.__probe.keys.push({
      phase,
      key: event.key,
      prevented: event.defaultPrevented,
      composing: event.isComposing,
      target: `${event.target?.tagName}[${event.target?.getAttribute?.('aria-label') ?? ''}]`,
    })
  }
  document.addEventListener('keydown', log('capture'), true)
  document.addEventListener('keydown', log('bubble'), false)
  window.addEventListener('keydown', log('window'), false)
  window.__probe.rows = () =>
    [...document.querySelectorAll('[data-row-id]')].map((row) => ({
      id: row.dataset.rowId,
      top: Math.round(row.getBoundingClientRect().top),
      height: Math.round(row.getBoundingClientRect().height),
    }))
  window.__probe.scroller = () =>
    [...document.querySelectorAll('div')].find(
      (element) =>
        /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight - element.clientHeight > 40 &&
        !element.closest('[role="dialog"]')
    ) ?? null
  window.__probe.scrollTop = () => Math.round(window.__probe.scroller()?.scrollTop ?? -1)
  window.__probe.maxScrollTop = () => {
    const scroller = window.__probe.scroller()
    return scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight) : -1
  }
  /** 第一条「还露出视口顶」的行 = 用户正在读的那一行 */
  window.__probe.firstVisible = () => window.__probe.rows().find((row) => row.top + row.height > 0) ?? null
  /** 点某个已挂载行的「编辑消息」按钮：绕开 Playwright 的 scrollIntoView（它自己会滚，污染测量） */
  window.__probe.clickEdit = (id) => {
    const row = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`)
    const button = row?.querySelector('button[aria-label="编辑消息"]')
    if (!button) {
      return false
    }
    button.click()
    return true
  }
  /** 合成一次「输入法选词中」的回车（isComposing=true）：验证我们不去拦它 */
  window.__probe.composingEnter = (textarea) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })
    textarea.dispatchEvent(event)
    return { prevented: event.defaultPrevented }
  }
  /** 逐帧记录 (scrollTop, 首条可见行) 的变化，用来判「上滑时有没有反向跳动」 */
  window.__probe.traceFrames = (frames) =>
    new Promise((resolve) => {
      const samples = []
      let left = frames
      const step = () => {
        samples.push({ top: window.__probe.scrollTop(), first: window.__probe.firstVisible() })
        if (--left > 0) {
          requestAnimationFrame(step)
        } else {
          resolve(samples)
        }
      }
      requestAnimationFrame(step)
    })
}

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  checks += 1
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message, detail) => {
  if (condition) {
    ok(detail ? `${message}（${detail}）` : message)
  } else {
    bad(detail ? `${message}（实际：${detail}）` : message)
  }
}
const note = (message) => console.log(`  ·   ${message}`)

/**
 * 等终态（docs/TESTING-POLICY.md §11.5）：不靠固定 sleep 撑窗口 —— 机器快慢不同，
 * 时间窗会漂；这里轮询到「真的发生了」或超时后报红说清原因。
 */
const until = async (probe, { timeoutMs = 10_000, intervalMs = 80 } = {}) => {
  const startedAt = Date.now()
  for (;;) {
    const result = await probe()
    if (result.ok) {
      return { ...result, elapsed: Date.now() - startedAt }
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { ...result, elapsed: Date.now() - startedAt, timeout: true }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

verifyDist(DIST, { variant: process.env.DIST_VARIANT === 'internal' ? 'internal' : undefined })
mkdirSync(SHOT_DIR, { recursive: true })
const server = await serveDir(DIST, { label: '被测产物' })
/**
 * #686：出站总闸，**必须在每个 page 的 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来）。
 * 本用例只碰 IndexedDB fixture 与被测产物自己的静态服务；白名单只写它的 origin（精确 host:port）。
 */
const gate = (page) => installEgressGate(page, { appUrl: server.url, allowHosts: [new URL(server.url).host] })

const seed = async (context) => {
  const seeder = await context.newPage()
  await gate(seeder)
  await seeder.goto(server.url, { waitUntil: 'domcontentloaded' })
  await ensureChatDb(seeder)
  await seeder.evaluate(clearAllStores, { name: DB_NAME })
  await seeder.evaluate(writeSessions, { name: DB_NAME, items: [LONG, OTHER] })
  await seeder.close()
}

const openLongSession = async (page, isMobile) => {
  await until(() => page.locator('textarea').first().isVisible().then((ok) => ({ ok })), {
    timeoutMs: 20_000,
  })
  if (isMobile) {
    await page.getByRole('button', { name: '打开边栏' }).click()
    await until(() => page.getByText('长会话').first().isVisible().then((ok) => ({ ok })))
  }
  await page.getByText('长会话').first().click()
  // 等到会话真的渲染出挂载行（虚拟列表窗口就绪）
  await until(
    async () => {
      const count = await page.evaluate(() => document.querySelectorAll('[data-row-id]').length)
      return { ok: count > 0, count }
    },
    { timeoutMs: 20_000 }
  )
}

/** 滚轮上滑若干档（触摸滚动在 Chromium 移动端仿真里驱动不到这个容器，见文件头「未测」） */
const scrollUp = async (page, { steps = 12, delta = 150 } = {}) => {
  for (let index = 0; index < steps; index += 1) {
    const before = await page.evaluate(() => window.__probe.scrollTop())
    await page.mouse.wheel(0, -delta)
    // 等这一档真的落定（scrollTop 变了且不再继续变化）
    await until(
      async () => {
        const now = await page.evaluate(() => window.__probe.scrollTop())
        return { ok: now !== before, now }
      },
      { timeoutMs: 3000 }
    )
  }
  // 等惯性结束：连续两次采样一致即为静止
  let last = await page.evaluate(() => window.__probe.scrollTop())
  await until(
    async () => {
      const now = await page.evaluate(() => window.__probe.scrollTop())
      const still = now === last
      last = now
      return { ok: still, now }
    },
    { timeoutMs: 5000 }
  )
}

const startEditing = async (page, rowId) => {
  const clicked = await page.evaluate((id) => window.__probe.clickEdit(id), rowId)
  const textarea = page.locator('textarea[aria-label="编辑消息"]')
  await textarea.waitFor({ timeout: 5000 })
  return { clicked, textarea }
}

/** 等滚动真的停住（滚轮是异步的，惯性/排队的事件可能还在路上） */
const waitScrollStable = (page) => {
  let previous = null
  let stable = 0
  return until(
    async () => {
      const top = await page.evaluate(() => window.__probe.scrollTop())
      stable = previous !== null && top === previous ? stable + 1 : 0
      previous = top
      return { ok: stable >= 2, top }
    },
    { timeoutMs: 5000 }
  )
}

/** 等编辑态消失（Escape / 取消后） */
const waitEditingClosed = (page) =>
  until(
    async () => {
      const count = await page.locator('textarea[aria-label="编辑消息"]').count()
      return { ok: count === 0, count }
    },
    { timeoutMs: 5000 }
  )

const scenario = async ({ label, width, height, isMobile }) => {
  console.log(`\n=== ${label} ===`)
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width, height },
    isMobile,
    hasTouch: isMobile,
    colorScheme: 'light',
  })
  // 预置一把本地假 Key：否则首次打开会弹设置弹窗挡住 UI（本用例不打真上游）
  await context.addInitScript(() => {
    try {
      localStorage.setItem('chat-demo:api-key', 'sk-610-fixture-0123456789')
      localStorage.setItem('chat-demo:provider-kind', 'deepseek')
    } catch {
      // localStorage 不可用时用例会在下面直接失败，不需要单独兜底
    }
  })
  await context.addInitScript(PROBE)
  await seed(context)
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(String(error)))
  await gate(page)
  await page.goto(server.url, { waitUntil: 'domcontentloaded' })
  await openLongSession(page, isMobile)

  await page.mouse.move(Math.round(width / 2), Math.round(height * 0.45))
  await scrollUp(page)
  note(`上滑后 scrollTop=${await page.evaluate(() => window.__probe.scrollTop())}`)

  // ---------- [1][2][3] 段首回车 = 换行，事件不外泄，不切会话 ----------
  await waitScrollStable(page)
  const before = await page.evaluate(() => ({
    first: window.__probe.firstVisible(),
    rows: window.__probe.rows(),
    scrollTop: window.__probe.scrollTop(),
  }))
  const target = before.rows.find((row) => row.id.includes('-u') && row.top >= 0 && row.top + row.height <= height)
  expect(Boolean(target), `[${label}][1a] 上滑后能选中一条完整可见的用户消息`, target?.id)

  const { clicked, textarea } = await startEditing(page, target.id)
  expect(clicked, `[${label}][1b] 点得到「编辑消息」`, target.id)
  const original = await textarea.inputValue()
  await textarea.evaluate((element) => {
    element.focus({ preventScroll: true })
    element.setSelectionRange(0, 0)
  })
  const rowsAfterEdit = await page.evaluate(() => window.__probe.rows())

  // 编辑态一打开，阅读位置就不许跳（#610：autoFocus 的原生 scroll-into-view 会甩走 ~1100px）
  const tracked = before.rows.find((row) => row.top >= 0)
  const trackedAfter = rowsAfterEdit.find((row) => row.id === tracked.id)
  expect(
    Boolean(trackedAfter) && Math.abs(trackedAfter.top - tracked.top) <= 2,
    `[${label}][1c] 进入编辑态不移动阅读位置`,
    `${tracked.id} ${tracked.top} → ${trackedAfter?.top}`
  )

  await page.evaluate(() => {
    window.__probe.keys.length = 0
  })
  await page.keyboard.press('Enter')
  // 等 React 提交完成：编辑框的值真的多了那个换行
  await until(
    async () => {
      const current = await page.locator('textarea[aria-label="编辑消息"]').inputValue().catch(() => null)
      return { ok: current === `\n${original}`, current }
    },
    { timeoutMs: 5000 }
  )
  const keys = await page.evaluate(() => window.__probe.keys)
  const stillEditing = await textarea.count()
  const value = await textarea.inputValue().catch(() => null)
  const caret = await textarea.evaluate((element) => element.selectionStart).catch(() => null)
  const rowsAfterEnter = await page.evaluate(() => window.__probe.rows())

  expect(stillEditing === 1, `[${label}][1d] 段首回车后仍在编辑态`, `textarea=${stillEditing}`)
  expect(value === `\n${original}`, `[${label}][1e] 回车插入的是一个换行`, JSON.stringify(value?.slice(0, 16)))
  expect(caret === 1, `[${label}][1f] 光标落在新换行的行首`, `caret=${caret}`)
  expect(
    keys.some((event) => event.phase === 'capture') &&
      !keys.some((event) => event.phase === 'bubble') &&
      !keys.some((event) => event.phase === 'window'),
    `[${label}][2] 回车被输入框吃掉（document 冒泡层 / window 收不到）`,
    keys.map((event) => `${event.phase}${event.prevented ? '(p)' : ''}`).join(',')
  )
  expect(
    rowsAfterEnter.length > 0 && rowsAfterEnter.every((row) => row.id.startsWith('s-long-')),
    `[${label}][3] 会话没被切走`,
    rowsAfterEnter.map((row) => row.id).slice(0, 2).join(',')
  )

  // ---------- [4] 输入法合成期不拦 ----------
  const composing = await page.evaluate(() => {
    const textarea = document.querySelector('textarea[aria-label="编辑消息"]')
    return { ...window.__probe.composingEnter(textarea), value: textarea.value.slice(0, 4) }
  })
  expect(!composing.prevented, `[${label}][4a] 合成期回车不被 preventDefault`, `prevented=${composing.prevented}`)
  expect(
    (await textarea.inputValue()) === value,
    `[${label}][4b] 合成期回车不额外插入换行`,
    JSON.stringify((await textarea.inputValue())?.slice(0, 16))
  )
  await page.screenshot({ path: path.join(SHOT_DIR, `${SHOT_PREFIX}-${label}.png`) })

  // 退出编辑，避免影响后面的滚动测量
  await page.keyboard.press('Escape')
  await waitEditingClosed(page)

  // ---------- [5] 上滑看历史 + 内容变化：阅读位置不许被弹走 ----------
  // 打视口上方、但仍挂在窗口里的那条用户消息（内容变化发生在阅读位置之上）。
  // 挂载窗口只有视口 ± overscan，窄视口上不一定已经有「上方」的行 —— 必要时再多滑几档把它挂上来。
  let above = null
  for (let attempt = 0; attempt < 6 && !above; attempt += 1) {
    const state = await page.evaluate(() => ({
      rows: window.__probe.rows(),
      scrollTop: window.__probe.scrollTop(),
    }))
    above = state.rows.filter((row) => row.top + row.height <= 0 && row.id.includes('-u')).pop() ?? null
    if (!above && state.scrollTop > 1200) {
      await scrollUp(page, { steps: 2 })
    }
  }
  expect(Boolean(above), `[${label}][5a] 上滑后上方仍挂着可编辑的消息`, above?.id ?? '未找到')

  // 定位到目标之后再取「正在读的那一行」，两次快照之间不再滚动（否则位移是滚出来的，不是弹出来的）
  await waitScrollStable(page)
  const reading = await page.evaluate(() => ({
    first: window.__probe.firstVisible(),
    scrollTop: window.__probe.scrollTop(),
  }))
  const changed = await page.evaluate((id) => window.__probe.clickEdit(id), above.id)
  expect(changed, `[${label}][5b] 内容变化真的发生了（上方那条进入编辑）`, above.id)
  // 等布局与锚定都落定：连续三次采样里被跟踪行的位置不再变化
  let settled = null
  let previousTop = null
  let stable = 0
  await until(
    async () => {
      const current = await page.evaluate((id) => {
        const row = window.__probe.rows().find((item) => item.id === id)
        return { top: row?.top ?? null, height: row?.height ?? null, scrollTop: window.__probe.scrollTop() }
      }, reading.first.id)
      settled = current
      stable = previousTop !== null && current.top === previousTop ? stable + 1 : 0
      previousTop = current.top
      return { ok: stable >= 2, current }
    },
    { timeoutMs: 6000 }
  )
  expect(
    settled?.top !== null && Math.abs(settled.top - reading.first.top) <= 2,
    `[${label}][5c] 内容变化后正在读的那一行位置不变（不回弹）`,
    `${reading.first.id} ${reading.first.top} → ${settled?.top}（scrollTop ${reading.scrollTop} → ${settled?.scrollTop}）`
  )
  // 存档：此刻屏幕上还是不是同一批消息（修前这里整段被甩走 ~1100px）
  await page.screenshot({ path: path.join(SHOT_DIR, `${SHOT_PREFIX}-${label}-scroll.png`) })
  await page.keyboard.press('Escape')
  await waitEditingClosed(page)

  // ---------- [6] 上滑过程本身不反向跳动 ----------
  // 逐帧采样「首条可见行」的屏幕位置：同一行还在视口里时，它的 top 只能随上滑单调递增，
  // 一旦反向（内容自己往下甩）就是用户说的「回弹」。
  const sampling = page.evaluate(() => window.__probe.traceFrames(90))
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -120)
    // 35ms 只是「手指一档一档地滚」的输入节奏（约 30fps），不是等某个状态；判据仍在采样结果里
    await page.waitForTimeout(35)
  }
  const samples = await sampling
  const reversals = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].first
    const current = samples[index].first
    if (!previous || !current || previous.id !== current.id) {
      continue
    }
    // 上滑 = scrollTop 变小 = 内容整体往下走（行顶 rect.top 变大）。
    // 同一行在 scrollTop 没变大时反而往上跳（top 变小 > 2px）= 内容被自己甩回去了。
    if (current.top < previous.top - 2 && samples[index].top <= samples[index - 1].top) {
      reversals.push({ id: current.id, from: previous.top, to: current.top })
    }
  }
  expect(
    reversals.length === 0,
    `[${label}][6] 上滑时内容不反向跳`,
    `${reversals.length} 次 ${JSON.stringify(reversals.slice(0, 2))}`
  )

  // ---------- [7] 切会话仍然贴底（别把 #386 的跟随弄坏） ----------
  if (isMobile) {
    await page.getByRole('button', { name: '打开边栏' }).click()
    await until(() => page.getByText('别的会话').first().isVisible().then((ok) => ({ ok })))
  }
  await page.getByText('别的会话').first().click()
  await until(
    async () => {
      const rows = await page.evaluate(() => window.__probe.rows().map((row) => row.id))
      return { ok: rows.length > 0 && rows.every((id) => id.startsWith('s-other-')), rows }
    },
    { timeoutMs: 10_000 }
  )
  const bottomed = await until(
    async () => {
      const state = await page.evaluate(() => ({
        top: window.__probe.scrollTop(),
        max: window.__probe.maxScrollTop(),
        rows: window.__probe.rows().map((row) => row.id),
      }))
      return { ok: state.max > 0 && Math.abs(state.top - state.max) <= 2, state }
    },
    { timeoutMs: 10_000 }
  )
  const bottom = bottomed.state ?? { top: -1, max: -1, rows: [] }
  expect(
    bottom.rows.every((id) => id.startsWith('s-other-')),
    `[${label}][7a] 已切到另一个会话`,
    bottom.rows.join(',')
  )
  expect(
    bottom.max > 0 && Math.abs(bottom.top - bottom.max) <= 2,
    `[${label}][7b] 切会话后落在底部（#386 跟随没被破坏）`,
    `scrollTop=${bottom.top} max=${bottom.max}`
  )

  expect(errors.length === 0, `[${label}][8] 无 console error`, errors.slice(0, 2).join(' | '))
  await page.close()
  await browser.close()
}

try {
  await scenario({ label: '390', width: 390, height: 844, isMobile: true })
  await scenario({ label: '360', width: 360, height: 640, isMobile: true })
  await scenario({ label: '1280', width: 1280, height: 900, isMobile: false })
} finally {
  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）
  assertNoEgress(failures)
  server.kill()
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.error(failures.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
