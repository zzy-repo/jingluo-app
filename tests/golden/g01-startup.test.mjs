// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 1「启动」（Issue #404）。**只跑 1 条主路径**：
//   冷启动 → 会话列表渲染 → 打开最近会话
//
// 为什么这条进第一批：启动链路是「改一行样式/一个 hook 顺序就白屏」的地方，而 L1 的域 1 用例
// （tests/integration/domain01-session-load.test.mjs）有 5 行，包含列表读失败、详情丢失、重试…
// 那些是分支细节，黄金套件不重复 —— 这里只回答一个问题：**老用户带着历史记录再打开 App，
// 还能不能看见自己的会话并点进去。**
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g01-startup.test.mjs
import { sessionEntry, seedSessions } from '../fixtures/domain01-02/idb-fault.mjs'
import { bodyText, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g01'
/** 三条历史：标题与「最近」顺序一一对应，点第一条就等于「打开最近会话」 */
const NOW = Date.now()
const ENTRIES = [
  sessionEntry({ id: 'g1-jia', title: '会话甲', question: '甲的问题', answer: '甲的回答', at: NOW - 300_000 }),
  sessionEntry({ id: 'g1-yi', title: '会话乙', question: '乙的问题', answer: '乙的回答', at: NOW - 120_000 }),
  sessionEntry({ id: 'g1-bing', title: '会话丙', question: '丙的问题', answer: '丙的回答', at: NOW - 10_000 }),
]
const TITLES = ['会话丙', '会话乙', '会话甲']

const result = await runGolden(
  { id: 'G1', domain: '启动', title: '冷启动 → 会话列表渲染 → 打开最近会话' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, close } = await openGoldenPage(app.url, { storage: { 'chat-demo:api-key': KEY } })
    try {
      // ── 1. 冷启动：首屏可用，不是白屏 / 永久 loading ────────────────────────────
      ctx.begin('冷启动')
      const booted = await waitForBoot(page)
      ctx.expect('首屏渲染出欢迎页或会话列表', booted, {
        expected: '出现「今天有什么可以帮到你」或侧栏会话项',
        actual: `body=${await bodyText(page)}`,
      })

      // ── 2. 会话列表渲染：历史读出来并按最近排序 ────────────────────────────────
      ctx.begin('会话列表渲染')
      await seedSessions(page, ENTRIES)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const listed = await waitFor(
        page,
        async () => (await page.locator('[class*="item-"] [class*="title-"]').count()) === 3
      )
      const titles = (await page.locator('[class*="item-"] [class*="title-"]').allInnerTexts()).map((text) =>
        text.trim()
      )
      if (!listed) {
        ctx.abort('侧栏列出 3 条历史会话', '3 条', `${titles.length} 条 ${JSON.stringify(titles)}`)
      }
      ctx.expect('列表按最近更新排序（最新在最上）', titles.join(',') === TITLES.join(','), {
        expected: TITLES.join(','),
        actual: titles.join(','),
      })

      // ── 3. 打开最近会话：主区真的渲染出这段对话 ────────────────────────────────
      ctx.begin('打开最近会话')
      await page.getByText('会话丙', { exact: true }).first().click()
      const opened = await waitFor(page, async () => (await bodyText(page)).includes('丙的回答'))
      const text = await bodyText(page)
      ctx.expect('主区显示「丙的问题 + 丙的回答」', text.includes('丙的问题') && text.includes('丙的回答'), {
        expected: 'body 同时含「丙的问题」「丙的回答」',
        actual: `body=${text}`,
      })
      ctx.expect('打开后输入框可继续提问（没有卡在加载态）', (await page.locator('textarea').count()) > 0, {
        expected: '存在 textarea',
        actual: '页面没有输入框',
      })
      ctx.expect('打开会话不是「什么都没发生」', opened, { expected: '主区出现「丙的回答」', actual: `body=${text}` })
    } finally {
      await close()
      await app.close()
    }
  }
)

// 单文件直接跑时把结果转成退出码（被 run-golden / node --test 拉起时同样生效）
export default result
