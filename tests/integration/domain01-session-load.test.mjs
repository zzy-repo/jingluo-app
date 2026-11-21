// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 20~40 秒] 说明见 tests/README.md
// Issue #362（域 1「启动与可用性」）/ #367：最小充分集第 1/5 条。
//
// 这一条把「启动阶段本机数据读不动」的三件事一次跑完（表驱动，5 行共用同一套夹具与断言函数）：
//   F1-01 首屏可用          —— 正常启动：侧栏会话列表 + 欢迎页 + 可输入的输入框，没有永久 loading
//   F1-03 会话列表加载失败  —— 列表读抛错：「对话列表加载失败，请重试」+ 重试按钮；点重试真的重读
//   F1-04 单条会话打不开    —— 详情读抛错 / 详情已丢失：「对话加载失败，请重试」+ 重试；其余会话照常可用
//
// 为什么以前一条都没覆盖：`grep -rn "sessionListLoadFailed" tests/` 与 `sessionLoadFailed` 都是 0 命中
// ——文案写好了、重试接线也写好了，但没有任何用例证明它真的会在界面上出现，也没证明点了会重读。
//
// 故障注入走 `tests/fixtures/domain01-02/idb-fault.mjs`（在浏览器里改写 IDBDatabase.prototype.transaction），
// 不改 src、不改产物；只按 store 名区分「列表读」与「详情读」，两档互不影响。
//
// 行（表驱动，一行一个分支）：
//   行 1 正常首屏                     → F1-01
//   行 2 会话列表读抛错               → F1-03（失败分支：文案 + 重试入口）
//   行 3 单条会话详情读抛错           → F1-04（失败分支 + 重试后恢复）
//   行 4 会话详情已丢失（只有摘要）   → F1-04（缺失分支：仍是可读错误，不是永久 loading）
//   行 5 列表读失败后点重试           → F1-03（重试分支：重读成功，列表回来）
//
// 跑法（先 pnpm build 生成标准包；本脚本自起临时端口服务）：
//   node tests/integration/domain01-session-load.test.mjs
//   DIST_DIR=/private/artifacts/<commit>/standard node tests/integration/domain01-session-load.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import {
  installFaultPatch,
  orphanSummary,
  seedSessions,
  sessionEntry,
  setFault,
} from '../fixtures/domain01-02/idb-fault.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain01-session-load.test.mjs'
const KEY = 'sk-testkey-domain01'

const failures = []
const checks = { current: 0 }
const ok = (message) => {
  checks.current += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message) => (condition ? ok(message) : bad(message))

const server = await serveDist(DIST, { port: process.env.PORT || 0 })
const APP_URL = server.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
const browser = await chromium.launch()

/** 会话夹具：两条完整历史 + 一条只有摘要的「孤儿」（行 4 用） */
const NOW = Date.now()
const ENTRIES = [
  sessionEntry({
    id: 'sess-jia',
    title: '会话甲',
    question: '旧问题甲',
    answer: '旧回答甲',
    at: NOW - 60_000,
  }),
  sessionEntry({
    id: 'sess-yi',
    title: '会话乙',
    question: '旧问题乙',
    answer: '旧回答乙',
    at: NOW - 30_000,
  }),
]

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

/** 轮询等条件成立（文案是异步渲染的，固定 sleep 会飘） */
const waitFor = async (page, predicate, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(120)
  }
  return false
}

const waitForText = (page, part, timeout = 15_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

const waitForGone = (page, part, timeout = 15_000) =>
  waitFor(page, async () => !(await bodyText(page)).includes(part), timeout)

/** 首启：干净 localStorage（+ 预置 Key，避免 F1-09 的设置弹层盖住首屏），并等 App 建好库 */
const boot = async ({ entries, fault }) => {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   * 本用例只读本机 IndexedDB、只跟被测产物自己的 origin 打交道，白名单里只需要它。
   */
  await installEgressGate(page, { appUrl: APP_URL })
  // 故障补丁必须在应用脚本之前注入；此时策略为空，不影响建库
  await page.addInitScript(installFaultPatch)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate((apiKey) => {
    window.localStorage.clear()
    window.localStorage.setItem('chat-demo:api-key', apiKey)
  }, KEY)
  // 等 App 把 chat-demo 库建出来（首屏出现即 initChat 完成）
  const ready = await waitForText(page, '今天有什么可以帮到你')
  if (!ready) {
    bad(`启动后首屏没有出现欢迎页文案，body = ${JSON.stringify((await bodyText(page)).slice(0, 200))}`)
  }
  await seedSessions(page, entries)
  await setFault(page, fault)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  return { context, page }
}

/** 点侧栏里的会话 */
const clickSession = async (page, title) => {
  await page.getByText(title, { exact: true }).first().click()
  await page.waitForTimeout(300)
}

/** 重试按钮（加载失败时的唯一出口） */
const clickRetry = async (page) => {
  await page.getByRole('button', { name: /^重试$/ }).first().click()
  await page.waitForTimeout(400)
}

const LIST_FAILED = '对话列表加载失败，请重试'
const DETAIL_FAILED = '对话加载失败，请重试'
const LOADING = '正在加载对话'

/**
 * 表驱动的 5 行。每行只声明「注入什么故障 + 点什么 + 断言什么」，
 * 浏览器起停、造数据、注入补丁、清理都在上面的 harness 里统一做。
 * `covers` 字段就是回填 #362 用的功能点 ID，标题行里也会原样打出来。
 */
const ROWS = [
  {
    id: '行 1 正常首屏',
    covers: ['F1-01'],
    fault: null,
    async run(page) {
      // F1-01：首屏可用 = 侧栏有历史会话 + 主区是欢迎页 + 输入框能用，且没有卡在 loading
      const text = await bodyText(page)
      expect(text.includes('今天有什么可以帮到你'), 'F1-01 主区显示欢迎页文案')
      expect(text.includes('会话甲') && text.includes('会话乙'), 'F1-01 侧栏渲染出两条历史会话')
      expect(!text.includes(LOADING), 'F1-01 不残留「正在加载对话...」')
      expect(await page.locator('textarea').first().isVisible(), 'F1-01 输入框可交互（首屏不是白屏/骨架）')
      // 点开任一会话，历史消息能真的读出来（首屏不只渲染壳）
      await clickSession(page, '会话甲')
      expect(await waitForText(page, '旧回答甲'), 'F1-01 点开会话能读到历史消息')
    },
  },
  {
    id: '行 2 会话列表读抛错',
    covers: ['F1-03'],
    fault: { store: 'sessionSummaries', times: 1 },
    async run(page) {
      expect(await waitForText(page, LIST_FAILED), `F1-03 列表读失败给出可读文案「${LIST_FAILED}」`)
      expect(
        (await page.getByRole('button', { name: /^重试$/ }).count()) > 0,
        'F1-03 失败态带「重试」按钮（不是只能干等）'
      )
      const text = await bodyText(page)
      expect(!text.includes(LOADING), 'F1-03 失败后不再假装还在加载')
      expect(!text.includes('会话甲'), 'F1-03 列表读失败时侧栏没有渲染出（不存在的）会话')
      expect(text.trim().length > 20, 'F1-03 界面不是纯白屏（有文案 + 有出口）')
    },
  },
  {
    id: '行 3 单条会话详情读抛错',
    covers: ['F1-04'],
    fault: { store: 'sessions', times: 1 },
    async run(page) {
      // 列表读得到（store 名区分，不会连带失败）
      expect(await waitForText(page, '会话甲'), 'F1-04 前置：列表正常渲染')
      await clickSession(page, '会话甲')
      expect(await waitForText(page, DETAIL_FAILED), `F1-04 详情读失败给出可读文案「${DETAIL_FAILED}」`)
      expect(
        (await page.getByRole('button', { name: /^重试$/ }).count()) > 0,
        'F1-04 失败态带「重试」按钮'
      )
      expect(!(await bodyText(page)).includes(LOADING), 'F1-04 不是永远停在「正在加载对话...」')
      // 重试 = 真的重读（故障只注入一次，第二次读就会成功）
      await clickRetry(page)
      expect(await waitForText(page, '旧回答甲'), 'F1-04 点重试后真的重读，会话内容出来了')
      // 其余会话仍然可用
      await clickSession(page, '会话乙')
      expect(await waitForText(page, '旧回答乙'), 'F1-04 单个会话读失败不影响其它会话')
    },
  },
  {
    id: '行 4 会话详情已丢失',
    covers: ['F1-04'],
    fault: null,
    extraEntries: [orphanSummary({ id: 'sess-bing', title: '会话丙', at: NOW - 10_000 })],
    async run(page) {
      expect(await waitForText(page, '会话丙'), 'F1-04 前置：孤儿摘要出现在列表里')
      await clickSession(page, '会话丙')
      expect(
        await waitForText(page, DETAIL_FAILED),
        `F1-04 详情已丢失时给同一句可读文案（不是空主区）`
      )
      // 重试仍然读不到 —— 但必须停在「可读错误 + 出口」，不能变成永久 loading / 白屏
      await clickRetry(page)
      await page.waitForTimeout(800)
      const text = await bodyText(page)
      expect(text.includes(DETAIL_FAILED), 'F1-04 读不到时重试后仍是可读错误')
      expect(!text.includes(LOADING), 'F1-04 读不到时不会退化成永久「正在加载对话...」')
      expect(
        (await page.getByRole('button', { name: /^重试$/ }).count()) > 0,
        'F1-04 读不到时重试入口还在（用户还能再试一次）'
      )
      await clickSession(page, '会话甲')
      expect(await waitForText(page, '旧回答甲'), 'F1-04 一条会话丢了，其它会话照常打开')
    },
  },
  {
    id: '行 5 列表读失败后点重试',
    covers: ['F1-03'],
    fault: { store: 'sessionSummaries', times: 1 },
    async run(page) {
      expect(await waitForText(page, LIST_FAILED), 'F1-03 前置：列表读失败')
      await clickRetry(page)
      // 「点了真重读」：故障只注入一次，重试后列表必须回来，而不是把同一句错误再显示一遍
      expect(await waitForText(page, '会话乙'), 'F1-03 重试后列表重新读出来')
      expect(await waitForGone(page, LIST_FAILED), 'F1-03 重试成功后错误文案撤下')
      await clickSession(page, '会话乙')
      expect(await waitForText(page, '旧回答乙'), 'F1-03 重试之后的会话能正常打开')
    },
  },
]

try {
  for (const row of ROWS) {
    checks.current = 0
    console.log(`\n-- ${row.id}（覆盖 ${row.covers.join(' / ')}）`)
    let context
    try {
      const booted = await boot({ entries: [...ENTRIES, ...(row.extraEntries ?? [])], fault: row.fault })
      context = booted.context
      await row.run(booted.page)
      console.log(`   ${row.id}：${checks.current} 条断言通过（覆盖 ${row.covers.join(' / ')}）`)
    } catch (error) {
      bad(`${row.id} 用例异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await context?.close()
    }
  }
} finally {
  // #686：收尾断言「漏出 = 0」（未登记的出站请求一条都不许有）—— 先断言再关浏览器
  assertNoEgress(failures)
  await browser.close()
  await server.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}（5 行：F1-01 / F1-03 ×2 / F1-04 ×2）`)
}
