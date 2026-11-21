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
 *     const { page, close, guard } = await openGoldenPage(app.url, { backends: { stubs, allowHosts } })
 *     ctx.begin('会话列表渲染')
 *     ctx.expect('侧栏出现 3 条会话', titles.length === 3, { expected: '3 条', actual: `${titles.length} 条` })
 *     guard.assertNoLeak(ctx)                                // 出站总闸（#667）：请求一条都没漏出去
 *   })
 *
 * 出站总闸是**硬要求**：桩一律通过 `openGoldenPage({ backends })` 注册（host + path），
 * 禁止在用例里另起 `page.route`/`context.route` —— 那些 glob 只看 path、不看 host，
 * 正是「流量改道到生产了用例还是绿的」的来源（#667）。
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 出站总闸（#667 跟进）：任何 golden 都不许把请求漏到「登记过的桩」之外。
 *
 * 为什么必须有它：`page.route` 的 glob **只看 path、不看 host**。`**\/v1\/messages` 这种桩对
 * 「请求发到哪台机器」完全无感 —— 代码一旦把地址改道（忽略用户填的地址、回落到内置生产域名），
 * 桩照样应答、用例照样绿。#667 的 B4 负向对照就是这么漏的（`apiConfig.ts` 忽略用户配置，
 * g14 原本全绿）。所以「没连真实服务」必须是**断言**，不能靠自觉。
 *
 * 出口只有一个：`withStubbedBackends`（`openGoldenPage` 会自动装上，见它的 `backends` 参数）
 *   · `page.route` 的全量通配（`**` 前缀）兜住**全部**出站请求，一条都不放过；
 *   · 按 **host + path** 匹配桩：host 必须**精确等于**桩登记的 `host`（`URL.host`，含端口），
 *     path 是精确字符串或 RegExp —— 不再有「只看 path」的缺口；
 *   · 命中 → fulfill（默认带 CORS 头，OPTIONS 预检自动 204）；未命中 → **记录 + abort**（不出网）；
 *   · 用例收尾断言「未命中 = 0」且「出现过的 host ⊆ 白名单」，失败行直接打出漏出的 `method host+path`。
 *
 * 白名单是**精确 host 集合** = 被测产物自己的 host ∪ 每条桩登记的 host ∪ `allowHosts`（本机真服务，
 * 如 mock 上游 / mock sub2api）。不接受 `*`、不接受包含/前缀匹配 —— 写 `127.0.0.1` 只能匹配
 * 默认端口的 `https://127.0.0.1/…`，写不出「本机随便哪个端口都放行」。
 *
 * 用例忘了断言也不会漏：`runGolden` 收尾会把**所有**装配过的总闸再断言一遍（`asserted` 过的跳过）。
 */
export const EGRESS_STEP = '不连真实服务'

/** 本次进程里装配过的出站总闸（runGolden 收尾统一兜一遍，防止用例忘写） */
const egressGuards = []

/** host 只接受精确写法：host 或 host:port。星号/空白/逗号一律当场报错，避免白名单被放宽。 */
const checkHost = (host, where) => {
  if (typeof host !== 'string' || host === '' || /[\s*,]/u.test(host)) {
    throw new Error(`${where} 的 host 必须是精确的 host[:port]（不许写 *、不许逗号列举）：${String(host)}`)
  }
  return host
}

/** stub 的 path 匹配：精确字符串（不含 query）或 RegExp（不留状态，避免 /g 抖动） */
const matchesPath = (spec, pathname) => {
  if (typeof spec === 'string') {
    return spec === pathname
  }
  if (spec instanceof RegExp) {
    spec.lastIndex = 0
    return spec.test(pathname)
  }
  return false
}

/** 桩默认带的 CORS 头：浏览器里跨 origin 的桩不给它就不会被读到（预检/头都要放行） */
const corsHeadersFor = (request) => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers':
    request.headers()['access-control-request-headers'] ??
    'authorization,content-type,x-api-key,anthropic-version,x-session-id',
  'access-control-max-age': '600',
})

/**
 * 出站记账本（浏览器侧与纯 Node 侧共用的那一半）。
 *
 * `escaped` = 未命中任何桩、也不在 allowHosts 里的请求；`hosts` = 见过的全部出站 host。
 * 断言口径只有一句：**escaped 为空，且 hosts ⊆ 白名单**。
 */
const createEgressLedger = ({ allowHosts }) => {
  const ledger = {
    /** 允许的 host（精确集合） */
    allowedHosts: allowHosts,
    /** 见过的全部出站 host（含被放行的） */
    hosts: new Set(),
    /** 命中桩的次数（放行的另一类） */
    hits: 0,
    /** 漏出去的请求：{ method, host, path } */
    escaped: [],
    /** 已经断言过（runGolden 收尾不再重复） */
    asserted: false,
    /** 放行一次（桩命中 / 本机真服务 / 被测产物自身） */
    pass(host) {
      ledger.hosts.add(host)
      ledger.hits += 1
    },
    /** 漏出去一次：记账（abort 由调用方做，这里只管证据） */
    escape(method, url) {
      const target = new URL(String(url))
      ledger.hosts.add(target.host)
      ledger.escaped.push({ method: String(method).toUpperCase(), host: target.host, path: `${target.pathname}${target.search}` })
      // 当场打到 stderr：万一后面那句断言因为别的原因提前红了，漏出的 host 也已经留在日志里
      console.error(`[golden-egress] ${String(method).toUpperCase()} ${target.host}${target.pathname}${target.search}（未登记，已拦下）`)
    },
    /** 一句话的漏出清单：`POST api.deepseek.com/v1/messages`（同一 host+path 只留一条） */
    leakList() {
      return [...new Set(ledger.escaped.map((item) => `${item.method} ${item.host}${item.path}`))]
    },
    /** 收尾断言：未命中 = 0，且出站 host ⊆ 白名单 */
    assertNoLeak(ctx, step = EGRESS_STEP) {
      ledger.asserted = true
      const allowed = ledger.allowedHosts()
      const leaked = ledger.leakList()
      const outside = [...ledger.hosts].filter((host) => !allowed.includes(host))
      const parts = []
      if (leaked.length > 0) {
        parts.push(`${ledger.escaped.length} 次未登记请求：${leaked.slice(0, 3).join('、')}${leaked.length > 3 ? ` 等 ${leaked.length} 条` : ''}`)
      }
      if (outside.length > 0) {
        parts.push(`白名单外的 host：${outside.join('、')}`)
      }
      return ctx.expect(step, parts.length === 0, {
        expected: `0 次未登记请求；允许的 host = {${allowed.length === 0 ? '（空——任何出站都算漏）' : allowed.join('、')}}`,
        actual: parts.length === 0 ? `干净：${ledger.hits} 次出站全在白名单内` : parts.join('；'),
      })
    },
  }
  return ledger
}

/**
 * 所有 golden 的唯一出口（#667 跟进）：注册桩路由 + 记所有出站请求的 host。
 *
 *   const { page, guard } = await openGoldenPage(app.url, {
 *     backends: {
 *       stubs: [{ name: 'chat-anthropic', host: '127.0.0.1:18414', path: /^\/v1\/messages$/, respond: () => ({ body: sse }) }],
 *       allowHosts: [new URL(mock.url).host],   // 本机真起的 mock 上游：放行到真服务
 *     },
 *   })
 *   …用例…
 *   guard.assertNoLeak(ctx)                     // runGolden 收尾也会兜一次，忘了写照样红
 *
 * `respond(call)` 的 `call` = `{ stub, method, url, host, path, headers, body }`，返回
 * `{ status?, headers?, body? }`（body 可以是 string 或 Buffer）。
 */
export const withStubbedBackends = async (page, { appUrl = '', stubs = [], allowHosts = [] } = {}) => {
  const appHost = appUrl === '' ? '' : new URL(appUrl).host
  const guard = {
    appHost,
    stubs: [],
    allowHosts: allowHosts.map((host) => checkHost(host, 'allowHosts')),
    /** 命中桩的请求（顺序 = 发生顺序；OPTIONS 预检单独留在 preflights） */
    calls: [],
    preflights: [],
    /** 未命中 → 被 abort 的请求（= 漏网证据） */
    escaped: [],
    /** 见过的全部出站 host */
    hosts: new Set(),
    /** 加一条桩（可以在页面已经跑起来之后再补，规则不变） */
    stub(spec) {
      if (!(typeof spec?.path === 'string' || spec?.path instanceof RegExp)) {
        throw new Error(`桩 ${String(spec?.name)} 的 path 必须是精确字符串或 RegExp（不接受 glob，glob 正是本单的缺陷来源）`)
      }
      if (typeof spec?.respond !== 'function') {
        throw new Error(`桩 ${String(spec?.name)} 必须有 respond(call)`)
      }
      const entry = {
        name: spec.name ?? `${checkHost(spec.host, 'stub')}${String(spec.path)}`,
        host: checkHost(spec.host, 'stub'),
        path: spec.path,
        method: spec.method ?? null,
        respond: spec.respond,
      }
      guard.stubs.push(entry)
      return entry
    },
    /** 白名单：被测产物自身 + 每条桩的 host + 本机真服务（精确 host，去重） */
    allowedHosts: () =>
      [...new Set([appHost, ...guard.stubs.map((stub) => stub.host), ...guard.allowHosts].filter((host) => host !== ''))],
    assertNoLeak(ctx, step = EGRESS_STEP) {
      guard.asserted = true
      return guard._ledger.assertNoLeak(ctx, step)
    },
    /** runGolden 收尾用的兜底断言 */
    asserted: false,
  }
  const ledger = createEgressLedger({ allowHosts: guard.allowedHosts })
  guard._ledger = ledger
  // 桩必须在装上路由**之前**全部登记好：先命中再放行的顺序里没有「临时补一条」的余地
  for (const spec of stubs) {
    guard.stub(spec)
  }

  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    let target
    try {
      target = new URL(request.url())
    } catch {
      await route.abort()
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      await route.continue()
      return
    }
    // 被测产物自己的静态服务：必须放行，否则页面根本打不开
    if (appHost !== '' && target.host === appHost) {
      ledger.pass(target.host)
      await route.continue()
      return
    }
    const stub = guard.stubs.find(
      (item) => item.host === target.host && matchesPath(item.path, target.pathname) && (item.method === null || item.method === method)
    )
    if (stub) {
      if (method === 'OPTIONS') {
        guard.preflights.push({ stub: stub.name, url: request.url() })
        ledger.pass(target.host)
        await route.fulfill({ status: 204, headers: corsHeadersFor(request), body: '' })
        return
      }
      const call = {
        stub: stub.name,
        method,
        url: request.url(),
        host: target.host,
        path: target.pathname,
        headers: request.headers(),
        body: request.postData() ?? '',
      }
      const response = (await stub.respond(call)) ?? {}
      guard.calls.push(call)
      ledger.pass(target.host)
      await route.fulfill({
        status: response.status ?? 200,
        headers: { ...corsHeadersFor(request), ...(response.headers ?? {}) },
        body: response.body ?? '',
      })
      return
    }
    // 本机真起的服务（mock 上游 / mock sub2api）：放行到真服务，host 仍进白名单
    if (guard.allowHosts.includes(target.host)) {
      ledger.pass(target.host)
      await route.continue()
      return
    }
    // 只记一处：`ledger.escape` 就是 guard.escaped 的写入口（重复 push 会把一次漏网记成两次）
    ledger.escape(method, request.url())
    await route.abort()
  })

  guard.hosts = ledger.hosts
  guard.escaped = ledger.escaped
  egressGuards.push(guard)
  return guard
}

/**
 * 纯 Node 用例（没有浏览器、没有 `page.route`）用的同一个口径：g12 走真 HTTP transport +
 * 本机 mock sub2api，请求不经过 Chromium，但「host 必须在白名单里」这件事一样要机械判。
 *
 *   const egress = createEgressGuard({ allowHosts: [new URL(mock.base).host] })
 *   … transport 里每发一次 egress.note(method, url) …
 *   egress.assertNoLeak(ctx)
 */
export const createEgressGuard = ({ allowHosts = [], label = '出站' } = {}) => {
  const allowed = (typeof allowHosts === 'function' ? allowHosts() : allowHosts).map((host) => checkHost(host, `${label} allowHosts`))
  const ledger = createEgressLedger({ allowHosts: () => allowed })
  return {
    hosts: ledger.hosts,
    escaped: ledger.escaped,
    /** 记一次出站；host 不在白名单 = 漏网（返回 false，便于调用方再抬成断言） */
    note(method, url) {
      const target = new URL(String(url))
      if (allowed.includes(target.host)) {
        ledger.pass(target.host)
        return true
      }
      ledger.escape(method, url)
      return false
    },
    assertNoLeak: (ctx, step = EGRESS_STEP) => ledger.assertNoLeak(ctx, step),
  }
}
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
 *   storage      预置 localStorage，如 `{ 'chat-demo:api-key': 'sk-test' }`；
 *   backends     出站总闸的装配（`{ stubs, allowHosts }`，见 `withStubbedBackends`）。
 *                **不传 = 只装一个「一条都不许漏出去」的空闸**，这在 g01/g04/g05/g06/g15 里正是要的断言。
 */
export const openGoldenPage = async (url, { initScripts = [], storage = {}, viewport, backends } = {}) => {
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
  // 总闸必须**先**装上：`page.goto` 一落地页面就开始发请求，晚一步装就等于漏记首屏那几枪
  const guard = await withStubbedBackends(page, { appUrl: url, ...(backends ?? {}) })
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
    /** 出站总闸（`withStubbedBackends` 的返回值）：用例可以在收尾显式断言，也可以交给 runGolden 兜 */
    guard,
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

  // 出站总闸兜底（#667 跟进）：用例漏写 `guard.assertNoLeak(ctx)` 也照样红 ——
  // 「没连真实服务」是这套件的硬判据，不能因为某个用例忘了写就静默失守。
  for (const guard of egressGuards) {
    if (!guard.asserted) {
      guard.assertNoLeak(ctx, EGRESS_STEP)
    }
  }

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
