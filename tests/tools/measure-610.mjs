// 手工量测工具（不属于任何层）：把 #610 两个症状量成数字，用于修复前后对照。
//   APP_URL=http://127.0.0.1:8137 node tests/tools/measure-610.mjs   # 修后（dev）
//   node tests/tools/measure-610.mjs                                # 修前（仓库根 dist）
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_NAME, ensureChatDb, clearAllStores, writeSessions } from '../helpers/chat-db.mjs'
import { serveDir } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const server = process.env.APP_URL ? null : await serveDir(DIST, { label: 'dist' })
const APP_URL = process.env.APP_URL || server.url

const now = 1_700_000_000_000
const lines = (tag, count) =>
  Array.from({ length: count }, (_, i) => `${tag} 第 ${i} 行：这是一段用来撑高行的正文，模拟真实回答。`).join('\n\n')

const session = {
  id: 's-long',
  title: '长会话',
  createdAt: now,
  updatedAt: now,
  messages: Array.from({ length: 24 }, (_, index) =>
    index % 2 === 0
      ? { id: `s-long-u${index}`, role: 'user', content: `第 ${index} 问`, files: [], createdAt: now + index }
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

const PROBE = () => {
  window.__keys = []
  const log = (phase) => (event) => {
    window.__keys.push({
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
  window.__rows = () =>
    [...document.querySelectorAll('[data-row-id]')].map((row) => ({
      id: row.dataset.rowId,
      top: Math.round(row.getBoundingClientRect().top),
      height: Math.round(row.getBoundingClientRect().height),
    }))
  window.__scrollTop = () => {
    const host = [...document.querySelectorAll('div')].find(
      (element) =>
        /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight - element.clientHeight > 40
    )
    return host ? Math.round(host.scrollTop) : null
  }
}

const measure = async ({ label, width, height, isMobile }) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width, height },
    isMobile,
    hasTouch: isMobile,
  })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('chat-demo:api-key', 'sk-probe-0123456789abcdef')
      localStorage.setItem('chat-demo:provider-kind', 'deepseek')
    } catch {}
  })
  await context.addInitScript(PROBE)
  const seeder = await context.newPage()
  await seeder.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await ensureChatDb(seeder)
  await seeder.evaluate(clearAllStores, { name: DB_NAME })
  await seeder.evaluate(writeSessions, { name: DB_NAME, items: [session] })
  await seeder.close()

  const page = await context.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  if (isMobile) {
    await page.getByRole('button', { name: '打开边栏' }).click()
    await page.waitForTimeout(400)
  }
  await page.getByText('长会话').first().click()
  await page.waitForTimeout(900)

  // --- A. 上滑：逐步记录 scrollTop 与「第一条可见行」的屏幕位置（80ms 档）
  await page.mouse.move(Math.round(width / 2), Math.round(height * 0.45))
  const steps = []
  for (let i = 0; i < 14; i += 1) {
    await page.mouse.wheel(0, -180)
    await page.waitForTimeout(80)
    const snapshot = await page.evaluate(() => {
      const rows = window.__rows().filter((row) => row.top + row.height > 0)
      return { top: window.__scrollTop(), first: rows[0] ?? null }
    })
    steps.push({ top: snapshot.top, firstId: snapshot.first?.id ?? null, firstTop: snapshot.first?.top ?? null })
  }
  await page.waitForTimeout(600)
  const settled = await page.evaluate(() => window.__scrollTop())

  const backward = []
  const anchorJumps = []
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].top - steps[i - 1].top > 4) {
      backward.push({ step: i, from: steps[i - 1].top, to: steps[i].top })
    }
    if (steps[i].firstId && steps[i].firstId === steps[i - 1].firstId && steps[i].firstTop !== null && steps[i - 1].firstTop !== null) {
      const delta = Math.abs(steps[i].firstTop - steps[i - 1].firstTop)
      // 用户一档滚轮是 180px，超过这个量说明内容在手指外自己跳了
      if (delta > 220) anchorJumps.push({ step: i, id: steps[i].firstId, delta })
    }
  }

  // --- B. 编辑历史消息：进入编辑态时阅读位置是否被顶飞
  const before = await page.evaluate(() => {
    const rows = window.__rows().filter((row) => row.top + row.height > 0)
    return { top: window.__scrollTop(), first: rows[0] }
  })
  await page.locator('[data-row-id] button[aria-label="编辑消息"]').first().click()
  await page.waitForTimeout(700)
  const afterEdit = await page.evaluate((firstId) => {
    const row = window.__rows().find((item) => item.id === firstId)
    return { top: window.__scrollTop(), sameRowTop: row?.top ?? null }
  }, before.first.id)

  // --- C. 段首回车
  const textarea = page.locator('textarea[aria-label="编辑消息"]')
  await textarea.waitFor({ timeout: 5000 })
  if (isMobile) await textarea.tap()
  await textarea.evaluate((el) => {
    el.focus()
    el.setSelectionRange(0, 0)
  })
  await page.waitForTimeout(300)
  const titleBefore = await page.evaluate(
    () => document.querySelector('button[aria-label="回到首条消息"] span')?.textContent ?? null
  )
  await page.evaluate(() => {
    window.__keys.length = 0
  })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  const enter = {
    editing: await textarea.count(),
    value: (await textarea.inputValue().catch(() => null))?.slice(0, 12) ?? null,
    caret: await textarea.evaluate((el) => el.selectionStart).catch(() => null),
    keys: await page.evaluate(() => window.__keys),
    titleBefore,
    titleAfter: await page.evaluate(
      () => document.querySelector('button[aria-label="回到首条消息"] span')?.textContent ?? null
    ),
    firstRowIds: await page.evaluate(() => window.__rows().map((row) => row.id).slice(0, 3)),
  }

  await page.screenshot({ path: `/tmp/measure-610-${label}.png` })
  await browser.close()
  return { label, steps, settled, backward, anchorJumps, editJump: { before: before.top, after: afterEdit.top, rowShift: afterEdit.sameRowTop === null ? null : afterEdit.sameRowTop - before.first.top }, enter }
}

try {
  const result = []
  result.push(await measure({ label: 'mobile390', width: 390, height: 844, isMobile: true }))
  result.push(await measure({ label: 'desktop1280', width: 1280, height: 900, isMobile: false }))
  console.log(JSON.stringify(result, null, 1))
} finally {
  server?.kill()
}
