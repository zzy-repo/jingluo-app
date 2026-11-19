// Issue #172：更新说明弹窗内容区可独立滚动（真实 Chromium 触摸回归；CSS 能力模拟不等于旧内核）
//
// 为什么要单开一个集成测试：这条 Issue 的症状（十几条更新说明的后半段看不到）
// 只有「把真实的 releases.json 形状喂进界面、再把内容真的塞满」才量得出来。
// 这里 route 掉 https://dl.rose7.cn/releases.json，返回与线上同形状的一条发布记录
// （changes 用 CHANGELOG 里 1.4.0-beta.10 的真实 23 条），然后打开 设置 → 应用更新 → 检查更新，
// 在两档验收视口（390×844 / 360×740）里量：
//   · 弹窗高度 / 内容区 scrollHeight 与 clientHeight / computed overflow-y
//   · 最后一条 li 在不在可视区、滚到底之后在不在
//   · 底部按钮在滚动前后是否都还完整落在视口里
//   · 内容很短时（3 条）不该出现滚动条，高度要自适应
//
// 两种跑法：
//   UPDATE_DIST_DIR=dist-172-before BASELINE=1 node tests/integration/update-dialog-scroll.test.mjs
//       —— 修复前取证，只量不断言，截图落 before-*.png
//   UPDATE_DIST_DIR=dist-172-after node tests/integration/update-dialog-scroll.test.mjs
//       —— 修复后回归，断言上面那几条，截图落 after-*.png
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
// 截图落点：docs/ui/172-update-dialog/（两档宽度、修复前后、短文本各一组）
const OUT = fileURLToPath(new URL('../../docs/ui/172-update-dialog/', import.meta.url))
await mkdir(OUT, { recursive: true })
const DIST_DIR = path.resolve(ROOT, process.env.UPDATE_DIST_DIR || 'dist-172')
const PREFERRED_PORT = Number(process.env.UPDATE_PORT || 5419)
const BASELINE = process.env.BASELINE === '1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}
const staticServer = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://127.0.0.1')
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const file = path.resolve(DIST_DIR, '.' + relative)
    if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
      response.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(file).catch(() => null)
    if (!info || !info.isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
    })
    createReadStream(file).pipe(response)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})
const listening = (server, port) =>
  new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
if (!(await stat(DIST_DIR).catch(() => null))) {
  throw new Error(
    `静态产物目录不存在：${DIST_DIR}\n先构建：DIST_OUT=${path.basename(DIST_DIR)} NODE_ENV=production node node_modules/@rspack/cli/bin/rspack.js build -c rspack.config.ts\n或用 UPDATE_DIST_DIR 指向已构建的目录。`
  )
}
let port
try {
  port = await listening(staticServer, PREFERRED_PORT)
} catch (error) {
  if (error.code !== 'EADDRINUSE') throw error
  port = await listening(staticServer, 0)
  console.log(`端口 ${PREFERRED_PORT} 已被占用，自动改用空闲端口 ${port}`)
}
const BASE_URL = `http://127.0.0.1:${port}`
console.log(`静态服务：${DIST_DIR} → ${BASE_URL}`)

// ---------------------------------------------------------------- 假发布记录（与线上 releases.json 同形状）

/** CHANGELOG 1.4.0-beta.10 的真实 23 条，Issue #172 截图里那一次弹窗就是这一版的说明 */
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
/** 短文本档：内容装得下时不该出现滚动条，弹窗高度要跟着内容自适应 */
const CHANGES_SHORT = [
  '修复窄屏下设置页部分文字被挤压错行',
  '应用名统一为「鲸落」',
  '内测版本，建议保留重要聊天记录',
]

const manifestBody = (changes) =>
  JSON.stringify({
    releases: [
      {
        version: '1.4.0-beta.11',
        versionCode: 18,
        size: 41943040,
        file: 'apk/jingluo-1.4.0-beta.11-standard-release.apk',
        sha256: 'c0ffee'.repeat(10) + 'c0ff',
        artifactVariant: 'standard',
        buildType: 'stable',
        changes,
      },
    ],
  })

/** 拦发布清单：跨域 GET，必须自己给 Access-Control-Allow-Origin，否则浏览器按 CORS 失败处理 */
const routeManifest = async (context, changes) => {
  await context.route('https://dl.rose7.cn/releases.json', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: manifestBody(changes),
    })
  )
}

// ---------------------------------------------------------------- 取数（在页面里跑，必须自成一体）

/** 量更新说明弹窗：高度链、内容区滚动能力、最后一条与底部按钮的可达性 */
const measure = () => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
  const dialog = dialogs.pop() ?? null
  if (dialog === null) {
    return { found: false }
  }
  const round = (value) => Math.round(value * 10) / 10
  const box = (element) => {
    if (element === null || element === undefined) return null
    const rect = element.getBoundingClientRect()
    return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height), width: round(rect.width) }
  }
  // Modal 的结构：.content > (.header, .main, .footer?)，只按子节点顺序取，不依赖 hash 后的类名
  const header = dialog.firstElementChild
  const main = header === null ? null : header.nextElementSibling
  const footer = main !== null && dialog.lastElementChild !== main ? dialog.lastElementChild : null
  const mainStyle = main === null ? null : getComputedStyle(main)
  const items = main === null ? [] : [...main.querySelectorAll('li')]
  const last = items.length === 0 ? null : items[items.length - 1]
  const viewportHeight = Math.round(window.innerHeight)
  const viewportWidth = Math.round(window.innerWidth)
  // 从内容区往上找「最近的可滚动祖先」：修复前整条链上一个都没有，这才是内容出不来的直接原因
  const scrollable = /(auto|scroll|overlay)/
  let host = main
  let scrollHost = null
  while (host !== null && host !== undefined) {
    if (scrollable.test(getComputedStyle(host).overflowY)) {
      scrollHost = host
      break
    }
    host = host.parentElement
  }
  const mainRect = main === null ? null : main.getBoundingClientRect()
  const lastRect = last === null ? null : last.getBoundingClientRect()
  return {
    found: true,
    viewport: { width: viewportWidth, height: viewportHeight },
    dialog: box(dialog),
    dialogStyle: { maxHeight: getComputedStyle(dialog).maxHeight, padding: getComputedStyle(dialog).padding },
    header: box(header),
    main:
      main === null
        ? null
        : {
            rect: box(main),
            overflowY: mainStyle.overflowY,
            minHeight: mainStyle.minHeight,
            flex: mainStyle.flex,
            touchAction: mainStyle.touchAction,
            overscrollBehaviorY: mainStyle.overscrollBehaviorY,
            // WebView 83 上这个属性仍会被解析；拿不到时是空串，不当作 0
            webkitOverflowScrolling: mainStyle.getPropertyValue('-webkit-overflow-scrolling').trim() || null,
            scrollHeight: Math.round(main.scrollHeight),
            clientHeight: Math.round(main.clientHeight),
            scrollTop: round(main.scrollTop),
            overflows: main.scrollHeight > main.clientHeight + 1,
          },
    scrollHost:
      scrollHost === null
        ? null
        : { className: String(scrollHost.className), overflowY: getComputedStyle(scrollHost).overflowY },
    items: items.length,
    firstItem: items.length === 0 ? null : (items[0].textContent ?? '').slice(0, 24),
    lastItem:
      last === null
        ? null
        : {
            text: (last.textContent ?? '').slice(0, 24),
            rect: box(last),
            // 最后一条要「完整」落在视口里，才证明滚到底看得到
            inViewport:
              lastRect.top >= 0 && lastRect.bottom <= viewportHeight + 1 && lastRect.height > 0,
            // 也必须在内容区自己的可视范围里（修复后考验的是这一条）
            inMain:
              mainRect !== null &&
              lastRect.top >= mainRect.top - 1 &&
              lastRect.bottom <= mainRect.bottom + 1,
          },
    footer: box(footer),
    actions: [...dialog.querySelectorAll('button, a')].map((element) => ({
      text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim() || element.getAttribute('aria-label'),
      rect: box(element),
      inViewport:
        element.getBoundingClientRect().top >= 0 &&
        element.getBoundingClientRect().bottom <= viewportHeight + 1,
    })),
    page: {
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      documentScrollHeight: Math.round(document.documentElement.scrollHeight),
      documentClientHeight: Math.round(document.documentElement.clientHeight),
    },
    // 硬判据：内容比「视口里真正留给它看的高度」高，而整条链上一个可滚动容器都没有
    // ⇒ 后半段永远看不到（Issue #172 的判定条件：scrollHeight > clientHeight 且 overflow-y 不是 auto/scroll）
    reproduced: (() => {
      if (main === null || mainRect === null) return false
      const visibleHeight = Math.max(0, Math.min(mainRect.bottom, viewportHeight) - Math.max(mainRect.top, 0))
      return main.scrollHeight > visibleHeight + 1 && scrollHost === null
    })(),
  }
}

// ---------------------------------------------------------------- UI 动作

/** 侧边栏 → 设置 → 通用设置里的「应用更新」→ 检查更新，等更新说明真的渲染出来 */
const openUpdateDialog = async (page) => {
  const entry = page.getByRole('button', { name: '检查更新', exact: true })
  if (!(await entry.isVisible().catch(() => false))) {
    const menu = page.getByRole('button', { name: '打开边栏' })
    if (await menu.isVisible().catch(() => false)) {
      await menu.tap()
      await page.waitForTimeout(320)
    }
    await page.getByRole('button', { name: '设置', exact: true }).last().tap()
  }
  await entry.waitFor({ state: 'visible', timeout: 10000 })
  await entry.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await entry.tap()
  await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 10000 })
  // 清单是拦下来的本地响应，但还是要等 React 把 changes 渲染完：li 出现才算数
  await page.waitForFunction(
    () => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const dialog = dialogs.pop()
      return (dialog?.querySelectorAll('li').length ?? 0) > 0
    },
    undefined,
    { timeout: 10000 }
  )
  await page.waitForTimeout(300)
}

/**
 * 真实触摸滑动（CDP 合成 touch 事件）：能滚起来才说明 #30 的 touchmove 锁没把内容区吃掉。
 * 起点必须落在内容区（.main）里 —— 落在底部按钮栏上，触摸手势本来就该被拦下来。
 */
const swipe = async ({ page, cdp, height, up = true }) => {
  const rect = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const dialog = dialogs.pop() ?? null
    const main = dialog?.firstElementChild?.nextElementSibling ?? null
    if (main === null || main === undefined) return null
    const r = main.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  if (rect === null) return
  const x = Math.round(rect.x + rect.width / 2)
  const top = Math.round(Math.max(rect.y, 0)) + 8
  const bottom = Math.round(Math.min(rect.y + rect.height, height)) - 8
  const startY = up ? bottom : top
  const endY = up ? top : bottom
  if (Math.abs(endY - startY) < 40) return
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
  for (let step = 1; step <= 12; step += 1) {
    const y = Math.round(startY + ((endY - startY) * step) / 12)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(120)
}

/** 一直滑到内容区到底（或确认滑不动了），返回滑了几次 */
const swipeToBottom = async ({ page, cdp, height, limit = 14 }) => {
  let count = 0
  for (let index = 0; index < limit; index += 1) {
    const before = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const dialog = dialogs.pop()
      const main = dialog?.firstElementChild?.nextElementSibling ?? null
      return main === null ? null : Math.round(main.scrollTop)
    })
    await swipe({ page, cdp, height })
    count += 1
    const after = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const dialog = dialogs.pop()
      const main = dialog?.firstElementChild?.nextElementSibling ?? null
      return main === null
        ? null
        : { top: Math.round(main.scrollTop), max: Math.round(main.scrollHeight - main.clientHeight) }
    })
    if (before === null || after === null) break
    if (after.max > 0 && after.top >= after.max - 3) break
    if (after.top === before && after.max <= 0) break
  }
  return count
}

// ---------------------------------------------------------------- 主流程

const VIEWPORTS = [
  { label: '390x844', width: 390, height: 844 },
  { label: '360x740', width: 360, height: 740 },
]

const browser = await chromium.launch({ headless: true })
const report = []
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      reducedMotion: 'reduce',
    })
    await context.addInitScript(() => {
      try {
        localStorage.setItem('chat-demo:api-key', 'sk-update-dialog-fixture')
        localStorage.setItem('chat-demo:provider-kind', 'deepseek')
      } catch {
        // 首屏前 localStorage 不可用就跳过：不影响本用例（只看设置页）
      }
    })
    await routeManifest(context, CHANGES_LONG)
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)

    const prefix = BASELINE ? 'before' : 'after'
    await openUpdateDialog(page)
    const initial = await page.evaluate(measure)
    await page.screenshot({ path: path.join(OUT, `${prefix}-${viewport.label}-long-top.png`) })

    const cdp = await context.newCDPSession(page)
    const swipes = await swipeToBottom({ page, cdp, height: viewport.height })
    const scrolled = await page.evaluate(measure)
    await page.screenshot({ path: path.join(OUT, `${prefix}-${viewport.label}-long-bottom.png`) })

    report.push({ viewport: viewport.label, mode: prefix, swipes, initial, scrolled, consoleErrors })
    const dump = async () => {
      await writeFile(
        path.join(OUT, `metrics-${prefix}.json`),
        JSON.stringify(report, null, 2) + '\n'
      )
    }
    await dump()
    console.log(
      `[${prefix}] ${viewport.label}: 弹窗高 ${initial.dialog.height}（视口 ${viewport.height}），内容 ${initial.main.clientHeight}/${initial.main.scrollHeight}，overflow-y ${initial.main.overflowY}，滑动 ${swipes} 次后 scrollTop ${scrolled.main.scrollTop}`
    )

    if (!BASELINE) {
      // 1. 内容区真的是滚动容器：overflow-y: auto + min-height: 0（flex 滚动容器的必备项）
      assert.equal(initial.main.overflowY, 'auto', `${viewport.label} 内容区 overflow-y 必须 auto`)
      assert.equal(initial.main.minHeight, '0px', `${viewport.label} 内容区必须 min-height: 0`)
      // 2. 内容真的溢出：23 条说明装不下
      assert.ok(initial.main.overflows, `${viewport.label} 内容区应可滚动（scrollHeight > clientHeight）`)
      // 3. 弹窗自身不能超出视口（max-height 生效）
      assert.ok(
        initial.dialog.top >= -1 && initial.dialog.bottom <= viewport.height + 1,
        `${viewport.label} 弹窗必须完整落在视口内，实测 ${JSON.stringify(initial.dialog)}`
      )
      // 4. 初始状态：最后一条看不到（证明这是真的长内容），但标题与底部按钮必须在
      assert.equal(initial.lastItem.inViewport, false, `${viewport.label} 初始状态最后一条不该已经在视口里`)
      const entryButton = initial.actions.find((action) => action.text === '重新检查')
      assert.ok(entryButton !== undefined, `${viewport.label} 底部应有「重新检查」`)
      assert.ok(entryButton.inViewport, `${viewport.label} 初始状态底部按钮必须在视口内`)
      // 5. 触摸能滚到底，滚到底之后最后一条完整可见、底部按钮仍在视口内
      assert.ok(scrolled.main.scrollTop > 0, `${viewport.label} 触摸必须能滚动内容区（#30 的 touchmove 锁）`)
      assert.ok(
        scrolled.main.scrollHeight - scrolled.main.clientHeight - scrolled.main.scrollTop <= 3,
        `${viewport.label} 触摸必须能滚到底，实测 scrollTop=${scrolled.main.scrollTop}/${scrolled.main.scrollHeight - scrolled.main.clientHeight}`
      )
      assert.ok(scrolled.lastItem.inViewport, `${viewport.label} 滚到底后最后一条必须完整可见`)
      const lastButton = scrolled.actions.find((action) => action.text === '重新检查')
      assert.ok(lastButton.inViewport, `${viewport.label} 滚到底后底部按钮仍必须在视口内`)
    }

    // 6. 短内容档：装得下就不该出现滚动条，弹窗高度跟着内容走（这条最容易漏测）
    await routeManifest(context, CHANGES_SHORT)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await openUpdateDialog(page)
    const short = await page.evaluate(measure)
    await page.screenshot({ path: path.join(OUT, `${prefix}-${viewport.label}-short.png`) })
    report[report.length - 1].short = short
    await dump()
    console.log(
      `[${prefix}] ${viewport.label} 短内容档：弹窗高 ${short.dialog.height}，内容 ${short.main.clientHeight}/${short.main.scrollHeight}，overflow-y ${short.main.overflowY}`
    )
    if (!BASELINE) {
      assert.equal(short.items, 3, `${viewport.label} 短内容档应有 3 条`)
      assert.equal(short.main.overflows, false, `${viewport.label} 短内容档不该出现滚动条`)
      assert.ok(
        short.dialog.height < initial.dialog.height,
        `${viewport.label} 短内容档弹窗应比长内容档矮（实测 ${short.dialog.height} vs ${initial.dialog.height}）`
      )
      assert.ok(
        short.dialog.top >= -1 && short.dialog.bottom <= viewport.height + 1,
        `${viewport.label} 短内容档弹窗也必须完整落在视口内`
      )
    }
    await context.close()
  }
} finally {
  await browser.close()
  await staticServer.close()
}

await writeFile(path.join(OUT, `metrics-${BASELINE ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2) + '\n')

for (const row of report) {
  console.log(`\n=== ${row.mode} / ${row.viewport}（触摸滑动 ${row.swipes} 次）===`)
  console.log(JSON.stringify(row, null, 2))
}
console.log(`\n截图与量数见 docs/ui/172-update-dialog/（${BASELINE ? '修复前' : '修复后'}）`)
