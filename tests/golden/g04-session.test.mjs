// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 4「会话」（Issue #404 第二批）。**只跑 1 条主路径**：
//   新建 → 重命名 → 置顶 → 删除 → 回空态
//
// 为什么这条值钱：侧栏的「更多」菜单是四条写操作（改标题 / 置顶 / 删除 / 删除当前）的唯一入口，
// 而它的失败都是**静默的**——点了没反应、删完刷新又回来、置顶后不重排、删掉当前会话停在已删会话上。
// 这些都不报错，只在用户那里表现为「数据不对」。这里一路点到 **IndexedDB 真的空了**，
// 不只断言界面文案。
//
// 与 L1 的分工（tests/integration/domain04-session-list-flow.test.mjs 已覆盖 11 行细节表：Escape 取消、
// 纯空格不提交、取消置顶、删非当前会话后刷新不回来、移动端双击回顶…）：这里不重复这些分支，
// 只回答一个问题：**新用户从空库开始，把一条会话走完「建 → 改 → 钉 → 删」还通不通。**
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g04-session.test.mjs
import { seedSessions, sessionEntry } from '../fixtures/domain01-02/idb-fault.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, sessionCount, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g04'
const NOW = Date.now()
/** 两条历史：先打开的在前，删除后要能回空态 */
const ENTRIES = [
  sessionEntry({ id: 'g4-jia', title: '会话甲', question: '甲的问题', answer: '甲的回答', at: NOW - 200_000 }),
  sessionEntry({ id: 'g4-yi', title: '会话乙', question: '乙的问题', answer: '乙的回答', at: NOW - 60_000 }),
]
const RENAMED = '黄金改名'

const titles = async (page) =>
  (await page.locator('[class*="item-"] [class*="title-"]').allInnerTexts()).map((text) => text.trim())

/** 「更多」按钮在桌面端只在 hover 时 display:flex（与 L1 同一套交互） */
const openMenu = async (page, title) => {
  const item = page.locator('[class*="item-"]').filter({ hasText: new RegExp(`^${title}$`) }).first()
  await item.hover()
  await item.getByRole('button', { name: '更多' }).click()
  await page.getByRole('menu').waitFor({ timeout: 5000 })
}

const menuPick = async (page, label) => {
  await page.getByRole('menuitem', { name: label }).first().click()
  await page.waitForTimeout(400)
}

/** 删除当前会话：确认弹窗里点最后一个「删除」（第一个是菜单项） */
const confirmDelete = async (page) => {
  await page.getByRole('dialog').first().waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: /^删除$/ }).last().click()
  await page.waitForTimeout(600)
}

const result = await runGolden(
  { id: 'G4', domain: '会话', title: '新建 → 重命名 → 置顶 → 删除 → 回空态' },
  async (ctx) => {
    const app = await serveGoldenApp()
    // 会话 CRUD 全程只碰 IndexedDB：总闸是空的（任何出站请求都算漏）
    const { page, close, guard } = await openGoldenPage(app.url, { storage: { 'chat-demo:api-key': KEY } })
    try {
      await waitForBoot(page)
      await seedSessions(page, ENTRIES)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const listed = await waitFor(page, async () => (await titles(page)).length === 2)
      if (!listed) {
        ctx.abort('侧栏列出 2 条历史会话', '2 条', `${(await titles(page)).length} 条 ${JSON.stringify(await titles(page))}`)
      }

      // ── 1. 新建：回空态首页，旧会话一条都不丢 ──────────────────────────────────
      ctx.begin('新建会话')
      await page.getByText('会话乙', { exact: true }).first().click()
      await waitFor(page, async () => (await bodyText(page)).includes('乙的问题'))
      await page.getByRole('button', { name: /开启新对话/ }).first().click()
      const emptyState = await waitFor(page, async () => (await page.getByText('今天有什么可以帮到你？').count()) > 0)
      const afterNew = await titles(page)
      ctx.expect('新建后回空态首页', emptyState, {
        expected: '出现「今天有什么可以帮到你？」',
        actual: `body=${brief(await bodyText(page))}`,
      })
      ctx.expect('新建不覆盖旧会话', afterNew.length === 2, {
        expected: '侧栏仍是 2 条',
        actual: `${afterNew.length} 条 ${JSON.stringify(afterNew)}`,
      })

      // ── 2. 重命名：菜单 → 重命名 → Enter 提交，标题写回 ────────────────────────
      ctx.begin('重命名')
      await openMenu(page, '会话甲')
      await menuPick(page, /重命名/)
      const renameInput = page.locator('input[class*="rename"]').first()
      await renameInput.waitFor({ timeout: 5000 })
      await renameInput.fill(RENAMED)
      await renameInput.press('Enter')
      const renamed = await waitFor(page, async () => (await titles(page)).includes(RENAMED))
      ctx.expect('重命名后标题被写回', renamed, {
        expected: `侧栏含「${RENAMED}」`,
        actual: JSON.stringify(await titles(page)),
      })

      // ── 3. 置顶：排到最前 + 「已置顶」标记 ────────────────────────────────────
      ctx.begin('置顶')
      await openMenu(page, RENAMED)
      await menuPick(page, /置顶会话/)
      const pinnedFirst = await waitFor(page, async () => (await titles(page))[0] === RENAMED)
      const pinnedMarks = await page.getByLabel('已置顶').count()
      ctx.expect('置顶后排到最前', pinnedFirst, {
        expected: `${RENAMED} 在最上`,
        actual: JSON.stringify(await titles(page)),
      })
      ctx.expect('置顶后渲染「已置顶」标记', pinnedMarks === 1, {
        expected: '1 个',
        actual: `${pinnedMarks} 个`,
      })

      // ── 4. 删除（非当前）：列表少一条，库也少一条 ─────────────────────────────
      ctx.begin('删除会话')
      await openMenu(page, '会话乙')
      await menuPick(page, /^删除$/)
      await confirmDelete(page)
      const goneFromList = await waitFor(page, async () => !(await titles(page)).includes('会话乙'))
      const afterDelete = await sessionCount(page)
      ctx.expect('删除后侧栏不再有这条会话', goneFromList, {
        expected: '侧栏不含「会话乙」',
        actual: JSON.stringify(await titles(page)),
      })
      ctx.expect('删除真的落到 IndexedDB（不是只清界面）', afterDelete === 1, {
        expected: 'sessions = 1',
        actual: `sessions = ${afterDelete}`,
      })

      // ── 5. 删掉当前会话 → 回空态，库清空 ─────────────────────────────────────
      ctx.begin('回空态')
      await page.getByText(RENAMED, { exact: true }).first().click()
      await waitFor(page, async () => (await bodyText(page)).includes('甲的问题'))
      await openMenu(page, RENAMED)
      await menuPick(page, /^删除$/)
      await confirmDelete(page)
      const backToEmpty = await waitFor(page, async () => (await page.getByText('今天有什么可以帮到你？').count()) > 0)
      const remaining = await sessionCount(page)
      ctx.expect('删掉当前会话后回到空态首页（不是停在已删会话上）', backToEmpty, {
        expected: '出现「今天有什么可以帮到你？」',
        actual: `body=${brief(await bodyText(page))}`,
      })
      ctx.expect('删除当前会话后库里没有残留', remaining === 0, {
        expected: 'sessions = 0',
        actual: `sessions = ${remaining}`,
      })

      // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ──────────────
      ctx.begin('不连真实服务')
      guard.assertNoLeak(ctx)
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
