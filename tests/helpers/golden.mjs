/**
 * 黄金回归套件（Issue #404）的**公共装配**。
 *
 * 为什么单独一层：L0 只测纯逻辑、L1 要 8~15 分钟，中间缺一层「用户真实路径还在不在」的快速哨兵。
 * 黄金套件 = **真实 dist 产物 + 真浏览器 + stub 后端**，每个域**只跑 1 条主路径**，
 * 单条 ≤60s、整层 ≤5 分钟（见 tests/run-golden.mjs）。
 *
 * 分工铁律：这里只断言「主路径没断」。同一个域的分支细节（首字未到就停止、重试第二次、
 * 置灰态、文案措辞…）归 L1（tests/integration）与 L0（tests/unit），**不要在黄金套件里重复**。
 * 判据：一条断言如果删掉它，L1 里还有别的用例会因为同一处坏掉而变红 → 它不该出现在这里。
 *
 * 复用而非另造：静态服务用 `helpers/runtime.mjs` 的 `serveDist`，进程/超时用 `runCase`，
 * 浏览器与夹具沿用 L1 已有的（`fixtures/domain01-02/*`、`fixtures/domain05/archive-fixture.mjs`）。
 *
 * 约定（每个 test 文件）：
 *
 *   import { runGolden, serveGoldenApp, openGoldenPage, ... } from '../helpers/golden.mjs'
 *   await runGolden({ id: 'G1', domain: '启动', title: '冷启动 → 会话列表渲染 → 打开最近会话' }, async (ctx) => {
 *     const app = await serveGoldenApp({ root: ctx.root })   // 缺产物 = 直接红，不 SKIP
 *     const { page, close } = await openGoldenPage(app.url)
 *     ctx.begin('会话列表渲染')
 *     ctx.expect('侧栏出现 3 条会话', titles.length === 3, { expected: '3 条', actual: `${titles.length} 条` })
 *   })
 *
 * 失败必须能**一句话定位**（Issue #404 硬要求 5）：
 *   `✗ G1 启动 · 会话列表渲染 · 期望=3 条 · 实际=2 条（会话二|会话一）`
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { requireDist, serveDist } from './runtime.mjs'
import { ROOT, readBuildInfo } from './env.mjs'

/** 单个域的预算（Issue #404 硬要求 4：单条 ≤60s） */
export const PATH_BUDGET_MS = 60_000
/** 单个步骤的默认等待上限：比整条预算小得多，挂住时先在这一步报错 */
export const STEP_TIMEOUT_MS = 20_000

/**
 * 被测产物目录：GOLDEN_DIST_DIR > DIST_DIR > <repo>/dist。
 * 黄金套件要的是**标准变体**（`pnpm run build`），内测变体的差异不属于主路径。
 */
export const goldenDist = () => process.env.GOLDEN_DIST_DIR || process.env.DIST_DIR || path.join(ROOT, 'dist')

/**
 * 起被测产物服务。
 *
 * 与 L1 的区别：L1 缺产物时 `SKIP(env)`（不产生假红，因为它是「细节回归」）；
 * 黄金套件是**阻塞门禁**，缺产物/产物种类不对必须当场红 —— 否则「CI 绿了但一条没跑」。
 */
export const serveGoldenApp = async (dist = goldenDist()) => {
  await requireDist(dist).catch((error) => {
    throw new Error(`黄金套件需要标准产物：${dist}（${error.message}）；先跑 pnpm run build`)
  })
  const info = readBuildInfo(dist)
  if (info && info.variant && info.variant !== 'standard') {
    throw new Error(`黄金套件要 standard 产物，${dist} 里是 ${info.variant} 包；先跑 pnpm run build（不是 build:internal）`)
  }
  // 陈旧产物守卫：**必须红，不能绿**。改了 src 不重建，用例对着旧 bundle「跑绿」是最坏的一种假绿
  // （#404 负向验证时亲历：改坏 loadSessionSummaries 仍全绿，因为 dist 还是旧的）。
  const newestSource = newestSourceMtime()
  const builtAt = info?.builtAt ? Date.parse(info.builtAt) : 0
  if (builtAt > 0 && newestSource.mtime > builtAt + 1000) {
    throw new Error(
      `产物陈旧：${path.relative(ROOT, newestSource.path)}（${new Date(newestSource.mtime).toISOString()}）比 ${path.relative(ROOT, dist)} 的产物（${new Date(builtAt).toISOString()}）新；先跑 pnpm run build`
    )
  }
  const server = await serveDist(dist, { port: 0 })
  return { url: server.url, dist, variant: info?.variant ?? null, close: () => server.close() }
}

/** src/ 下最新被改动的源码（.ts/.tsx/.css）：用来判断产物是不是比源码旧 */
const newestSourceMtime = (dir = path.join(ROOT, 'src')) => {
  let newest = { mtime: 0, path: '' }
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          walk(full)
        }
        continue
      }
      if (!/\.(tsx?|css)$/.test(entry.name)) {
        continue
      }
      const { mtimeMs } = statSync(full)
      if (mtimeMs > newest.mtime) {
        newest = { mtime: mtimeMs, path: full }
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * 开一个干净上下文：清 localStorage → 写预置键 → reload（避免首启时设置弹层盖住被测界面）。
 *
 *   initScripts  `page.addInitScript` 的入参（原生桥桩 / IDB 故障补丁），在文档脚本之前注入；
 *   storage      预置 localStorage，如 `{ 'chat-demo:api-key': 'sk-test' }`。
 */
export const openGoldenPage = async (url, { initScripts = [], storage = {}, viewport } = {}) => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: viewport ?? { width: 1280, height: 800 },
  })
  for (const script of initScripts) {
    if (typeof script === 'function') {
      await context.addInitScript(script)
    } else {
      await context.addInitScript(script.fn, script.arg)
    }
  }
  // 元素等不到的默认上限收到 15s：主路径断了要**快红**（黄金套件的价值是「1 分钟内告诉人哪一步断」），
  // Playwright 默认 30s 会让一次断链把整条路径的 60s 预算吃掉一半。
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate((entries) => {
    window.localStorage.clear()
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value)
    }
  }, storage)
  await page.reload({ waitUntil: 'domcontentloaded' })
  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}

/** body 文本（压成单行，断言里不用关心换行） */
export const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/gu, ' ').trim()

/** 轮询等到条件成立（固定 sleep 会飘）；超时返回 false，由调用方给出「期望 vs 实际」 */
export const waitFor = async (page, predicate, timeout = STEP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}

export const waitForText = async (page, part, timeout = STEP_TIMEOUT_MS) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)

/** 截断取证文本：失败信息要一句话，不能把整页 DOM 灌进日志 */
export const brief = (value, limit = 120) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 跑一条黄金路径。
 *
 * 成功：`[golden-result] {...}` + 一行人类可读结果（带耗时），退出码 0。
 * 失败：逐条打印 `✗ G1 启动 · 步骤 · 期望=… · 实际=…`，退出码 1。
 * 抛出异常（选择器等不到、bridge 桩没接上）：归到「当前步骤」，同样一句话。
 */
export const runGolden = async ({ id, domain, title, budgetMs = PATH_BUDGET_MS }, body) => {
  const started = performance.now()
  const failures = []
  const steps = []
  const state = { at: '准备', stepStarted: performance.now() }

  const totalMs = () => Math.round(performance.now() - started)

  const record = (step, expected, actual) => {
    const line = `✗ ${id} ${domain} · ${step} · 期望=${brief(expected)} · 实际=${brief(actual)}`
    failures.push(line)
    console.error(line)
  }

  const ctx = {
    /** 标记当前步骤（后续异常与耗时都挂在这一步上） */
    begin(step) {
      const now = performance.now()
      if (state.at !== '准备') {
        steps.push({ step: state.at, ms: Math.round(now - state.stepStarted) })
      }
      state.at = step
      state.stepStarted = now
      return step
    },
    /** 记一条断言；`actual` 允许是函数（只在需要取证时求值） */
    expect(step, pass, { expected = '', actual = '' } = {}) {
      if (pass) {
        return true
      }
      record(step, expected, typeof actual === 'function' ? actual() : actual)
      return false
    },
    /** 前置条件不成立（后面必然连带失败）时立即中止：只留一条定位信息 */
    abort(step, expected, actual) {
      record(step, expected, actual)
      throw new GoldenAbort()
    },
    failures,
    steps,
    totalMs,
  }

  try {
    await body(ctx)
  } catch (error) {
    if (!(error instanceof GoldenAbort)) {
      record(state.at, '不抛异常地跑完这一步', `${error?.name ?? 'Error'}: ${brief(error?.message) || '无消息'}`)
    }
  }
  steps.push({ step: state.at, ms: Math.round(performance.now() - state.stepStarted) })

  const elapsed = totalMs()
  if (failures.length === 0 && elapsed > budgetMs) {
    record(failures.length === 0 ? state.at : state.at, `整条路径 ≤${budgetMs}ms`, `${elapsed}ms`)
  }
  const result = {
    id,
    domain,
    title,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    ms: elapsed,
    budgetMs,
    steps,
    failures,
  }
  // 机器可读：run-golden.mjs 解析这一行，人只看下一行
  console.log(`[golden-result] ${JSON.stringify(result)}`)
  if (failures.length === 0) {
    console.log(`✅ ${id} ${domain} · ${title} · ${elapsed}ms（${steps.length} 步）`)
    return result
  }
  console.error(`❌ ${id} ${domain} · ${title} · ${elapsed}ms · 首个失败：${failures[0]}`)
  process.exitCode = 1
  return result
}

/** 只用于「后面必然连带失败」的提前收尾，避免一次改动刷出十条红字 */
class GoldenAbort extends Error {}

/** 读 IndexedDB 里的会话条数（主路径断言要落到库，不能只看界面） */
export const sessionCount = (page) =>
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

/** 首屏就绪的判据：欢迎页文案（全新会话）或侧栏会话项（已有历史） */
export const waitForBoot = (page, timeout = STEP_TIMEOUT_MS) =>
  waitFor(
    page,
    async () =>
      (await page.getByText('今天有什么可以帮到你').count()) > 0 ||
      (await page.locator('[class*="item-"] [class*="title-"]').count()) > 0,
    timeout
  )
