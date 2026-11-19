// [layer: integration | 依赖: playwright + chromium + 标准产物 dist/（缺则 SKIP(env)） | 耗时: ~20s]
//
// 域10 N4 —— **检查更新主路径**（Issue #362 §3.2 N4；功能点 F10-01 07 10 11 13 14，兼 web 侧 F10-02 04）。
//
// 走的是**真产物 + 真浏览器 + 真组件**，只把两台分发机上的 `releases.json` route 掉
// （跨域 GET，自己给 CORS 头）。这条链路的判定（解析 / 整份拒收 / 筛选 / 排序 / 文案）都在
// `src/services/**` 里，L0 已由 N1 的矩阵钉住；这里要钉的是**只有真 DOM 才成立**的部分：
//   · 打开弹窗即自动检查，先「正在检查更新…」再给结论（F10-01）
//   · 结论文案要说清渠道 / 当前版本 / 为什么没有可装的记录（F10-11）
//   · 失败文案按类别给出「要不要重试」，且不泄露 IP / 堆栈（F10-10）
//   · 切渠道后**自动重查**，请求地址不随渠道变化（F10-07）
//   · 网页预览（非 Android）把「确认下载」降级成 `<a href>`，且 href 拼在**真的回了清单**的 base 上（F10-13 / F10-02）
//   · 更新说明很长时内容区独立滚动、最后一条可达、底部按钮不被挤出（F10-14，390 与 360 两档）
//
// 与 N5 的分工：N4 只走 web 通道（原生桥不参与），N5 才打桩原生桥。混在一起会让
// 「网页预览降级成 <a>」这条断言失效 —— 原生通道下那个位置是「确认下载」按钮。
//
// 表驱动：`SCENARIOS` 一行 = 一条主路径（route 剧本 + 驱动 + 断言）。
//
// 跑法（仓库根目录，先构建标准产物）：
//   pnpm run build            # 或 DIST_DIR 指向已有产物
//   DIST_DIR=dist node tests/integration/domain10-update-check-flow.test.mjs

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, skipEnv, ROOT } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(ROOT, process.env.DIST_DIR || 'dist')

/** 两台分发机（与 src/services/updateManifest.ts 的 RELEASE_BASES 同源） */
const PRIMARY = 'http://62.106.70.167:8888'
const FALLBACK = 'https://dl.rose7.cn'

/** 与线上同形状的一条发布记录 */
const release = (over = {}) => ({
  version: '1.4.0-beta.11',
  versionCode: 18,
  size: 5452595,
  file: 'apk/deepseek-chat-1.4.0-beta.11.apk',
  changes: ['修复重试与离线提示', '下载失败不再残留满格进度'],
  buildType: 'prerelease',
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
  ...over,
})

/** CHANGELOG 1.4.0-beta.10 的 23 条真实说明（F10-14 长内容档就用它把内容塞满） */
const CHANGES_LONG = [
  '新增「额度与卡密」：首次进入自动领取额度并绑定本机设备码；设备码可复制备份（丢失等于丢账号，请务必备份）',
  '支持把已在用的 Key 绑定到本机设备码，不必重新领取',
  '支持更换 Key：额度不丢，旧 Key 立即失效',
  '卡密兑换迁到新通道，成功率更稳；返回「处理中」会自动到账，不必反复提交',
  '新增「付款记录」：可查看自己的历史订单（金额、状态、卡密、时间）',
  '购买时自动带上客户身份；重新下单会切到最新一单，不再出现「付款成功却一直等待支付」',
  '额度只显示积分，去掉与服务端口径不一致的「约可消费 ¥X」折算',
  '修复点「1 元新人特惠」提示「请求频繁」但实际已下单的问题（原生下单只请求一次、不跟随跳转）',
  '修复未领取 Key 时仍会下单、导致订单「查不到」的问题：现在会提示先领取',
  '修复部分旧机型（Android 11 出厂 WebView 等）打开即白屏',
  '修复应用被系统回收后直接退出、聊天记录像「丢了」的问题',
  '修复出错时整屏空白无提示：现在显示可读错误页，并可一键复制诊断信息',
  '修复反馈弹窗在手机上无法上下滑动、底部按钮点不到',
  '修复反馈弹窗取消后重新打开、已填内容被清空',
  '修复长对话因上下文预算裁剪而可能丢消息的问题',
  '修复导入误报「文件过大 200MB」、把单张图片异常当成整包失败、以及失败提示笼统的问题',
  '修复窄屏下设置页部分文字被挤压错行',
  '断流 / 网络异常支持自动重试（可配置次数与退避，也可关闭）',
  '等待回复首字过久会分级提示，错误说明改为中文',
  '思考过程默认折叠，可在设置里选择展开或隐藏',
  '通用设置新增阅读设置（字号 / 字重 / 行距）',
  '应用名统一为「鲸落」',
  '内测版本，建议保留重要聊天记录；遇到问题请通过反馈入口提交',
]

const manifestBody = (releases) => JSON.stringify({ releases })

/**
 * 拦发布清单。**两台都要拦**：只拦旧机的话，首选机一旦真的可达，用例会连真服务器
 * （离线环境里表现为 10s 级超时，CI 上表现为「今天红明天绿」）。
 * 跨域 GET 必须自己给 CORS 头，否则浏览器按 CORS 失败处理 —— 那会变成 network 类失败。
 */
const routeManifest = async (context, plan) => {
  // 一行可以给 {status, releases} / {status, body} / 一个返回上面两者的函数
  const resolvePlan = (base) => {
    const spec = (base === PRIMARY ? plan.primary : plan.fallback) ?? { status: 200, releases: [] }
    const value = typeof spec === 'function' ? spec() : spec
    return { status: value.status ?? 200, body: value.releases ? manifestBody(value.releases) : (value.body ?? '') }
  }
  const fulfill = async (route, base) => {
    const { status, body } = resolvePlan(base)
    // 跨域 GET 必须自己给 CORS 头，否则浏览器按 CORS 失败处理（会变成 network 类失败，掩盖真正的断言）
    await route.fulfill({
      status,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body,
    })
  }
  await context.route(`${PRIMARY}/releases.json`, (route) => fulfill(route, PRIMARY))
  await context.route(`${FALLBACK}/releases.json`, (route) => fulfill(route, FALLBACK))
}

/** 打开 设置 → 应用更新 → 检查更新；`waitFor` 决定等到哪种结论出现 */
const openUpdateDialog = async (page, { waitFor }) => {
  const entry = page.getByRole('button', { name: '检查更新', exact: true })
  if (!(await entry.isVisible().catch(() => false))) {
    const menu = page.getByRole('button', { name: '打开边栏' })
    if (await menu.isVisible().catch(() => false)) {
      await menu.tap()
      await page.waitForTimeout(320)
    }
    await page.getByRole('button', { name: '设置', exact: true }).last().tap()
  }
  await entry.waitFor({ state: 'visible', timeout: 15000 })
  await entry.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await entry.tap()
  await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 15000 })
  if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 15000 })
}

/** 页面内取数：弹窗结构、结论行、诊断区、降级链接、内容区滚动能力 */
const probe = () => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
  const round = (value) => Math.round(value * 10) / 10
  const main = dialog?.firstElementChild?.nextElementSibling ?? null
  const footer = main !== null && dialog.lastElementChild !== main ? dialog.lastElementChild : null
  const items = main === null ? [] : [...main.querySelectorAll('li')]
  const last = items.length === 0 ? null : items[items.length - 1]
  const link = [...(dialog?.querySelectorAll('a') ?? [])].find((item) => (item.textContent ?? '').includes('下载 APK'))
  const diagnostics = document.querySelector('[data-testid="update-diagnostics"]')
  const viewportHeight = Math.round(window.innerHeight)
  const mainRect = main === null ? null : main.getBoundingClientRect()
  const lastRect = last === null ? null : last.getBoundingClientRect()
  const buttonsInViewport = [...(footer?.querySelectorAll('button, a') ?? [])].map((item) => {
    const rect = item.getBoundingClientRect()
    return {
      text: (item.textContent ?? '').trim(),
      inViewport: rect.top >= -1 && rect.bottom <= viewportHeight + 1 && rect.height > 0,
    }
  })
  return {
    dialogOpen: dialog !== null,
    status: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
    title: dialog?.querySelector('h3')?.textContent?.trim() ?? null,
    items: items.map((item) => (item.textContent ?? '').trim().slice(0, 20)),
    linkHref: link?.getAttribute('href') ?? null,
    linkText: (link?.textContent ?? '').trim() || null,
    hasConfirmDownloadButton: [...(dialog?.querySelectorAll('button') ?? [])].some(
      (item) => (item.textContent ?? '').trim() === '确认下载'
    ),
    diagnostics: (diagnostics?.textContent ?? '').replace(/\s+/gu, ' ').trim(),
    main: {
      scrollHeight: main === null ? null : Math.round(main.scrollHeight),
      clientHeight: main === null ? null : Math.round(main.clientHeight),
      scrollTop: main === null ? null : round(main.scrollTop),
      overflowY: main === null ? null : getComputedStyle(main).overflowY,
      overflows: main === null ? false : main.scrollHeight > main.clientHeight + 1,
    },
    lastItem: last === null ? null : {
      text: (last.textContent ?? '').slice(0, 24),
      inViewport: lastRect.top >= -1 && lastRect.bottom <= viewportHeight + 1 && lastRect.height > 0,
      inMain: mainRect !== null && lastRect.top >= mainRect.top - 1 && lastRect.bottom <= mainRect.bottom + 1,
    },
    buttonsInViewport,
    dialogBox: dialog === null ? null : (() => {
      const rect = dialog.getBoundingClientRect()
      return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) }
    })(),
  }
}

/** 触摸滚到内容区底部（沿用 #172 的 CDP 合成触摸：能滚起来才说明 touchmove 锁没吃掉内容区） */
const swipeToBottom = async ({ page, cdp, height, limit = 14 }) => {
  const scrolled = () =>
    page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
      const main = dialog?.firstElementChild?.nextElementSibling ?? null
      return main === null ? null : { top: Math.round(main.scrollTop), max: Math.round(main.scrollHeight - main.clientHeight) }
    })
  let count = 0
  for (let index = 0; index < limit; index += 1) {
    const before = await scrolled()
    const rect = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
      const main = dialog?.firstElementChild?.nextElementSibling ?? null
      if (main === null) return null
      const r = main.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    if (rect === null) break
    const x = Math.round(rect.x + rect.width / 2)
    const startY = Math.round(Math.min(rect.y + rect.height, height)) - 8
    const endY = Math.round(Math.max(rect.y, 0)) + 8
    if (Math.abs(endY - startY) < 40) break
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: Math.round(startY + ((endY - startY) * step) / 12) }],
      })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(120)
    count += 1
    const after = await scrolled()
    if (before === null || after === null) break
    if (after.max > 0 && after.top >= after.max - 3) break
    if (after.top === before && after.max <= 0) break
  }
  return count
}

// ---------------------------------------------------------------- 矩阵（主路径 × 视口）

/**
 * 一行 = 一条主路径。字段：
 *   id / f10 / name     标识与覆盖的功能点
 *   plan                route 剧本（primary / fallback 各自的 status + releases）
 *   waitFor             等到哪一句结论出现（不绑死整段文案的措辞）
 *   drive(page)         额外动作（切渠道 / 触摸滚动）
 *   assert(probe)       断言
 *   viewports           在哪些视口跑（默认只有 390）
 */
const SCENARIOS = [
  {
    id: 'C1',
    f10: ['F10-01', 'F10-12', 'F10-13'],
    name: '有新版本：打开即检查 → 版本/大小/说明 + 诊断区 + 网页降级成 <a>',
    plan: { primary: { releases: [release()] }, fallback: { status: 500 } },
    waitFor: '发现新版本，确认后再下载。',
    assert: (p) => {
      // F10-01：自动检查后给出结论（不是「已是最新」）
      assert.match(p.status, /发现新版本/, `结论行应有「发现新版本」：${p.status}`)
      assert.equal(p.title, '1.4.0-beta.11', `弹窗应显示新版本号，实际 ${p.title}`)
      assert.deepEqual(p.items.slice(0, 2), ['修复重试与离线提示', '下载失败不再残留满格进度'], '更新说明应逐条渲染')
      // F10-13：网页预览降级成链接，而不是「确认下载」按钮
      assert.equal(p.hasConfirmDownloadButton, false, 'web 通道不该出现「确认下载」按钮')
      assert.equal(p.linkText, '下载 APK', `web 通道应给「下载 APK」链接，实际 ${JSON.stringify(p.linkText)}`)
      assert.equal(
        p.linkHref,
        `${PRIMARY}/apk/deepseek-chat-1.4.0-beta.11.apk`,
        `链接应拼在真的回了清单的 base（首选机）上，实际 ${p.linkHref}`
      )
      // F10-12：诊断区四个事实（版本 / 渠道 / 更新服务 / 最近检查）都在
      for (const keyword of ['当前版本', '更新渠道', '更新服务', '最近检查']) {
        assert.ok(p.diagnostics.includes(keyword), `诊断区应有「${keyword}」：${p.diagnostics}`)
      }
      assert.ok(p.diagnostics.includes('稳定版与预发布版'), `诊断区要说清当前渠道：${p.diagnostics}`)
      assert.equal(
        p.diagnostics.includes('已回退备用分发机'),
        false,
        `首选机正常时不该出现「已回退」：${p.diagnostics}`
      )
    },
  },
  {
    id: 'C2',
    f10: ['F10-02', 'F10-04', 'F10-13'],
    name: '首选机 503 → 自动回退旧机，下载链接与诊断区都跟着回退走',
    plan: { primary: { status: 503 }, fallback: { releases: [release()] } },
    waitFor: '发现新版本，确认后再下载。',
    assert: (p) => {
      assert.equal(
        p.linkHref,
        `${FALLBACK}/apk/deepseek-chat-1.4.0-beta.11.apk`,
        `回退后链接必须拼在旧机上（拼首选机会 404），实际 ${p.linkHref}`
      )
      assert.ok(
        p.diagnostics.includes('已回退备用分发机'),
        `回退发生时诊断区要写明「本次生效」，否则排查时会误判成首选机在服务：${p.diagnostics}`
      )
      assert.ok(p.diagnostics.includes('dl.rose7.cn'), `诊断区应点出实际生效的 host：${p.diagnostics}`)
    },
  },
  {
    id: 'C3',
    f10: ['F10-11'],
    name: '无新版：说清渠道 / 当前版本 / 「另有 N 条不可用」',
    plan: {
      primary: {
        releases: [
          // 候选（versionCode 更高）但缺 sha256 → 不可作为更新目标
          release({ versionCode: 19, sha256: undefined }),
          // 候选但缺渠道标记 → 同样不可用
          release({ versionCode: 20, artifactVariant: undefined }),
        ],
      },
      fallback: { status: 500 },
    },
    waitFor: /已是最新|没有可直接安装的新版本/,
    assert: (p) => {
      assert.match(p.status, /已是最新|没有可直接安装的新版本/, `应给出「无新版」结论：${p.status}`)
      assert.match(p.status, /当前版本 1\.4\.0-beta\.10/, `文案必须带当前版本（用户报障时唯一能对上的信息）：${p.status}`)
      assert.match(p.status, /稳定版与预发布版/, `文案必须带渠道名：${p.status}`)
      assert.match(p.status, /另有 2 条/, `两条不可用记录要被数出来：${p.status}`)
      assert.equal(p.hasConfirmDownloadButton, false, '没有可装版本时不该出现下载/安装按钮')
      assert.equal(p.linkHref, null, '没有可装版本时不该有下载链接')
    },
  },
  {
    id: 'C4',
    f10: ['F10-10'],
    name: '两台都 503：归类为「服务返回错误」、可重试、不泄露 IP/堆栈',
    plan: { primary: { status: 503 }, fallback: { status: 503 } },
    waitFor: /更新服务返回了 HTTP 503/,
    assert: (p) => {
      assert.match(p.status, /更新服务返回了 HTTP 503/, `应点出状态码：${p.status}`)
      assert.match(p.status, /稳定版与预发布版/, '失败文案也要说清是哪个渠道')
      assert.match(p.status, /重新检查/, '要告诉用户「可以再试一次」')
      // 文案纪律：不带 URL / IP / 堆栈 / Error 前缀
      assert.doesNotMatch(p.status, /\d+\.\d+\.\d+\.\d+/, `文案不许出现 IP：${p.status}`)
      assert.doesNotMatch(p.status, /https?:\/\//, `文案不许出现 URL：${p.status}`)
      assert.doesNotMatch(p.status, /Error:|stack|at\s+\w+\s*\(/i, `文案不许出现堆栈：${p.status}`)
      // 失败时底部仍然给「重新检查」，不给下载入口
      assert.equal(p.hasConfirmDownloadButton, false, '失败时不该出现「确认下载」')
      assert.equal(p.linkHref, null, '失败时不该出现下载链接')
      // 诊断区仍可复制（#310：失败时用户说不出有效信息）
      assert.ok(p.diagnostics.length > 0, '失败时诊断区也要在（复制诊断信息是唯一的求助手段）')
    },
  },
  {
    id: 'C5',
    f10: ['F10-07'],
    name: '切渠道自动重查：stable 无包 → 切回预发布立即出结果，请求地址不变',
    plan: {
      // 只有预发布渠道的记录：切到「稳定版」应当查不到可装版本
      primary: { releases: [release()] },
      fallback: { status: 500 },
    },
    waitFor: '发现新版本，确认后再下载。',
    drive: async (page) => {
      // 默认渠道是预发布（内测版本号带 -beta）→ 先看到新版本
      const select = page.getByRole('combobox')
      await select.selectOption('stable')
      // 切渠道即自动重查（不需要再点「检查更新」）：等 stable 的结论出现
      await page.getByText(/已是最新|没有可直接安装的新版本/).first().waitFor({ timeout: 15000 })
      await page.getByRole('combobox').selectOption('prerelease')
      await page.getByText('发现新版本，确认后再下载。').first().waitFor({ timeout: 15000 })
    },
    assert: (p, extra) => {
      // 两次切换各触发一次请求，且请求的都是同一台机器的同一个 URL（渠道只影响筛选）
      assert.ok(extra.requests.length >= 3, `切渠道应自动重查（应有 ≥3 次清单请求），实际 ${extra.requests.length}`)
      const urls = new Set(extra.requests.map((item) => item.url))
      assert.deepEqual([...urls], [`${PRIMARY}/releases.json`], `渠道不影响请求地址（只影响筛选），实际请求过：${[...urls].join(', ')}`)
      assert.match(p.status, /发现新版本/, '切回预发布后应重新查到新版本')
    },
  },
  {
    id: 'C6',
    f10: ['F10-14'],
    name: '更新说明很长：内容区独立滚动、最后一条可达、底部按钮不被挤出（390 / 360）',
    plan: { primary: { releases: [release({ changes: CHANGES_LONG })] }, fallback: { status: 500 } },
    waitFor: '发现新版本，确认后再下载。',
    viewports: [
      { label: '390x844', width: 390, height: 844 },
      { label: '360x740', width: 360, height: 740 },
    ],
    drive: async (page, { cdp, height }) => {
      await swipeToBottom({ page, cdp, height })
    },
    assert: (p) => {
      assert.equal(p.main.overflowY, 'auto', `内容区必须是滚动容器，实际 overflow-y=${p.main.overflowY}`)
      assert.ok(p.main.overflows, `23 条说明应该装不下（scrollHeight > clientHeight），实际 ${p.main.scrollHeight}/${p.main.clientHeight}`)
      assert.ok(p.main.scrollTop > 0, '触摸必须能滚动内容区（#30 的 touchmove 锁）')
      assert.ok(
        p.main.scrollHeight - p.main.clientHeight - p.main.scrollTop <= 3,
        `滚到底后应该真的到底：${p.main.scrollTop}/${p.main.scrollHeight - p.main.clientHeight}`
      )
      assert.ok(p.lastItem?.inViewport, `滚到底后最后一条必须完整可见：${JSON.stringify(p.lastItem)}`)
      const buttons = p.buttonsInViewport ?? []
      assert.ok(buttons.length > 0, '底部应至少有一个操作按钮')
      for (const button of buttons) {
        assert.ok(button.inViewport, `底部按钮「${button.text}」必须完整落在视口内（${JSON.stringify(button)}）`)
      }
      assert.ok(p.dialogBox.top >= -1 && p.dialogBox.bottom <= 900, `弹窗不许超出视口：${JSON.stringify(p.dialogBox)}`)
    },
  },
]

// ---------------------------------------------------------------- 跑

const VIEWPORT_DEFAULT = [{ label: '390x844', width: 390, height: 844 }]

if (!existsSync(path.join(DIST, 'index.html'))) {
  skipEnv(
    `没有标准产物：${path.relative(ROOT, DIST)}/index.html 不存在`,
    '先构建：pnpm run build（或用 DIST_DIR 指向已构建的目录）'
  )
}

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}

const served = await serveDir(DIST, { port: process.env.PORT, label: 'domain10 标准产物' })
console.log(`静态服务：${path.relative(ROOT, DIST)} → ${served.url}`)

const browser = await chromium.launch({ headless: true })
try {
  for (const scenario of SCENARIOS) {
    for (const viewport of scenario.viewports ?? VIEWPORT_DEFAULT) {
      const context = await browser.newContext({
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
      })
      const requests = []
      context.on('request', (request) => {
        if (request.url().endsWith('/releases.json')) requests.push({ url: request.url() })
      })
      await context.addInitScript(() => {
        try {
          localStorage.setItem('chat-demo:api-key', 'sk-domain10-fixture')
          localStorage.setItem('chat-demo:provider-kind', 'deepseek')
        } catch {
          // 首屏前不可用就跳过（本用例只看设置页）
        }
      })
      await routeManifest(context, scenario.plan)
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      let driveError = null
      try {
        await page.goto(served.url, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(600)
        await openUpdateDialog(page, { waitFor: scenario.waitFor })
        if (scenario.drive) {
          const cdp = await context.newCDPSession(page)
          await scenario.drive(page, { cdp, height: viewport.height })
        }
      } catch (error) {
        driveError = String(error).split('\n')[0]
      }
      const measured = await page.evaluate(probe)
      const tag = `${scenario.id}@${viewport.label}`
      if (driveError !== null) {
        failures.push(`${tag} 驱动失败：${driveError}`)
        console.error(`  ✗  ${tag} ${scenario.name}\n     驱动失败：${driveError}`)
      } else {
        try {
          scenario.assert(measured, { requests })
          ok(`${tag} ${scenario.name}`)
        } catch (error) {
          failures.push(`${tag}：${error.message}`)
          console.error(`  ✗  ${tag} ${scenario.name}\n     ${error.message}`)
        }
      }
      if (pageErrors.length > 0) failures.push(`${tag} 页面抛异常：${pageErrors.join(' | ')}`)
      console.log(`  ·   ${tag} 结论=${JSON.stringify(measured.status)} 链接=${measured.linkHref ?? '无'} 请求=${requests.length}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  served.kill()
}

console.log(`\n共 ${checks} 条断言组通过，${failures.length} 条失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
}
