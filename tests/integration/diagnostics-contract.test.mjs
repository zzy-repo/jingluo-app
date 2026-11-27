// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 诊断日志「有效性」契约测试（自建、纯本地、不依赖真实后端）：
//
//   cd /root/deepseek-app && pnpm build:internal && node tests/integration/diagnostics-contract.test.mjs
//
// 目的：光有环形缓冲不算「有效覆盖」。这里对 6 类真实故障各注入一次，断言上传的 payload 里
// **必须出现指定字段** —— 少一个字段，事后就拿不到定位问题的证据。
//
//   [A] 导入 403        → import_error + meta['http.status']=403 + stage + url.path + error.msg
//   [B] 发消息 502      → net_response(status 502, error 级) + chat_send
//   [C] 请求超时/中断   → net_error + durationMs（+ net_request 说明请求确实发出去了）
//   [D] 未捕获异常      → error + error.stack 非空
//   [E] 配置保存失败    → config_change + result 字段（用标准构建，服务地址可编辑）
//   [F] 长任务          → longtask + durationMs
//
// 被测页面：DIST_DIR 内测产物与 STANDARD_DIST_DIR 标准产物；只读复用，默认随机 loopback 端口。
import { serveDist, requireDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { fillApiKey, fillBaseUrl, openApiConfigSection, selectProviderKind } from '../helpers/helpers.mjs'
import { OURS_CHAT_PATH } from '../fixtures/domain03-04/ours-upstream.mjs'
// #596：内测构建默认渠道是 ours，Key 只能由服务端下发 —— 种「已领取」形态（Key + 下发标记）
import { oursServerKeyMark } from '../helpers/ours-claim.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { installBuiltinKeyClaimStub } from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const INTERNAL_DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const STANDARD_DIST = await requireDist(process.env.STANDARD_DIST_DIR || path.join(ROOT, 'dist-standard'))
let INTERNAL_URL, STANDARD_URL
const API_KEY = 'sk-contract-test-key-0123456789'
const ZIP_URL = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

const failures = []
const evidence = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => {
  evidence.push(message)
  console.log(`  ·   ${message}`)
}
const check = (condition, passMessage, failMessage) => {
  if (condition) {
    ok(passMessage)
  } else {
    bad(failMessage)
  }
}

// ---------- 0) No implicit builds, no fixed shared ports ----------
const internalServer = await serveDist(INTERNAL_DIST, { port: process.env.PORT || 0 })
let standardServer, browser
try {
  standardServer = await serveDist(STANDARD_DIST, { port: process.env.STANDARD_PORT || 0 })
  browser = await chromium.launch()
} catch (error) {
  try { await standardServer?.close() } finally { await internalServer.close() }
  throw error
}
INTERNAL_URL = internalServer.url
STANDARD_URL = standardServer.url
// 产物守卫：两套产物的种类/新旧都校验（内测包 + 标准包），不对就 SKIP(env)
await verifyAppUrl(INTERNAL_URL, INTERNAL_DIST, { variant: 'internal' })
await verifyAppUrl(STANDARD_URL, STANDARD_DIST, { variant: 'standard' })
const cleanup = () => Promise.all([internalServer.close(), standardServer.close()])

/** 打开应用（?diag-debug 打开调试入口），可选：原生桥 mock、网络打桩 */
const openApp = async ({ appUrl = INTERNAL_URL, native, routes, apiKey = true } = {}) => {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  await context.route('**/feedback.rose7.cn/**', (route) => route.abort())
  // #803 + 测试接缝：未配置首屏会真的去领内置 Key（GET apia.ecsafe.cn/api/v1/keys → 401），
  // 那条 401 会作为一条 net_response 落进诊断日志，把下面「本用例注入的那条故障」挤出断言窗口。
  // 就地按「这台设备还没有服务端下发的 Key」应答（见 tests/fixtures/consume-gateway-stubs/builtin-key-claim.mjs）。
  await installBuiltinKeyClaimStub(context)
  if (native) {
    await context.addInitScript((response) => {
      window.androidBridge = { postMessage: () => {} }
      window.Capacitor = {
        PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] }],
        nativePromise: () =>
          Promise.resolve({
            status: response.status,
            headers: response.headers ?? {},
            url: response.url ?? '',
            data: response.data ?? '',
          }),
      }
    }, native)
  }
  const page = await context.newPage()
  for (const [pattern, handler] of routes ?? []) {
    await page.route(pattern, handler)
  }
  await page.goto(`${appUrl}?diag-debug=1`, { waitUntil: 'domcontentloaded' })
  const mark = JSON.stringify(await oursServerKeyMark(API_KEY))
  await page.evaluate(
    ([key, markValue]) => {
      window.localStorage.clear()
      if (key) {
        window.localStorage.setItem('chat-demo:api-key', key)
        // #596：ours 的 Key 行只能由服务端下发；发送前守卫会拿这把 Key 与「下发标记」比对，
        // 只写 Key 会被判成「未领取」并拦下（那是产品行为，不是本用例要测的诊断链路）
        window.localStorage.setItem('chat-demo:ours-server-key', markValue)
      }
    },
    [apiKey ? API_KEY : '', mark]
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__diagnostics), null, { timeout: 10000 })
  await page.waitForTimeout(600)
  return { context, page }
}

const readLogs = (page) =>
  page.evaluate(() => window.__diagnostics.getDiagnosticsSnapshot().logs)

const openDataSection = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByTestId('settings-row-data').first().click()
  await page.waitForTimeout(300)
}

try {
  // ---------- [A] 导入 403 ----------
  console.log('\n[A] 导入 403 → import_error + http.status + stage + reason + 已下载字节（msg 里带原因）')
  {
    const { context, page } = await openApp({
      native: { status: 403, headers: {}, url: ZIP_URL, data: '' },
    })
    await openDataSection(page)
    const urlInput = page.getByLabel('从链接导入').first()
    await urlInput.fill(ZIP_URL)
    await page.getByRole('button', { name: /^导入$/ }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^确认导入$/ }).first().click()
    await page.waitForTimeout(1500)

    const logs = await readLogs(page)
    const entry = logs.filter((item) => item.kind === 'import_error').at(-1)
    note(`import_error: ${JSON.stringify(entry)}`)
    check(
      Boolean(entry) &&
        entry.level === 'error' &&
        entry.meta?.['http.status'] === 403 &&
        // stage 口径（#313 起统一成 `<flow>.<stage>`）：导入链路的下载阶段是 `import.download`，
        // 老断言写的是裸 `download`，与当前采集层不符（#406 复核）。
        entry.meta?.stage === 'import.download' &&
        // 契约变更（src/services/chat/history/urlImport.ts 的 recordDownloadFailure）：
        // 下载失败改为记 reason + durationMs + download.bytes，不再记 url.path
        // （URL 可能带凭证/私有路径，只保留判定结论）。这里改为断言实际字段。
        typeof entry.meta?.reason === 'string' &&
        entry.meta.reason.length > 0 &&
        typeof entry.meta?.['download.bytes'] === 'number' &&
        // 失败原因同时体现在 msg 里（老版本还额外记 error.msg；这里兼容两种）
        String(entry.msg ?? '').includes(String(entry.meta?.reason ?? '\u0000')) ,
      `断言到位：kind=import_error level=${entry?.level} http.status=${entry?.meta?.['http.status']} stage=${entry?.meta?.stage} reason=${entry?.meta?.reason} download.bytes=${entry?.meta?.['download.bytes']} msg="${entry?.msg}"`,
      `字段不全：${JSON.stringify(entry)}`
    )
    const start = logs.filter((item) => item.kind === 'import_start').at(-1)
    check(
      start?.meta?.source === 'url',
      `同一链路还留了 import_start（source=${start?.meta?.source}，说明导入确实开始了）`,
      `缺少 import_start：${JSON.stringify(start)}`
    )
    await context.close()
  }

  // ---------- [B] 发消息 502 ----------
  console.log('\n[B] 发消息 502 → net_response(status 502, error 级) + chat_send')
  {
    const { context, page } = await openApp({
      routes: [
        [
          `**${OURS_CHAT_PATH}`,
          (route) =>
            route.fulfill({
              status: 502,
              contentType: 'application/json',
              body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'bad gateway' } }),
            }),
        ],
      ],
    })
    const textarea = page.locator('textarea').last()
    await textarea.click()
    await textarea.fill('契约测试：发消息 502')
    await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
    await page.waitForTimeout(2000)

    const logs = await readLogs(page)
    const response = logs.filter((item) => item.kind === 'net_response').at(-1)
    note(`net_response: ${JSON.stringify(response)}`)
    check(
      response?.meta?.['http.status'] === 502 &&
        response.level === 'error' &&
        typeof response.meta?.durationMs === 'number' &&
        String(response.meta?.['url.path'] ?? '').endsWith(OURS_CHAT_PATH),
      `net_response 到位：status=${response?.meta?.['http.status']} level=${response?.level} durationMs=${response?.meta?.durationMs} url.path=${response?.meta?.['url.path']}`,
      `net_response 字段不全：${JSON.stringify(response)}`
    )
    check(
      logs.some((item) => item.kind === 'chat_send'),
      'chat_send 也在（能把「用户点了发送」和「上游 502」对上）',
      '缺少 chat_send'
    )
    await context.close()
  }

  // ---------- [C] 请求超时 ----------
  console.log('\n[C] 请求超时 → net_error + durationMs')
  {
    const { context, page } = await openApp({
      routes: [['**/diag-timeout/**', (route) => route.abort('timedout')]],
    })
    await page.evaluate(() => window.fetch('/diag-timeout/v1/slow?token=SECRET').catch(() => ''))
    await page.waitForTimeout(600)

    const logs = await readLogs(page)
    const error = logs.filter((item) => item.kind === 'net_error').at(-1)
    const request = logs.filter((item) => item.kind === 'net_request').at(-1)
    note(`net_error: ${JSON.stringify(error)}`)
    check(
      Boolean(error) &&
        typeof error.meta?.durationMs === 'number' &&
        ['network', 'timeout'].includes(String(error.meta?.reason)) &&
        error.meta?.['url.path'] === '/diag-timeout/v1/slow',
      `net_error 到位：reason=${error?.meta?.reason} durationMs=${error?.meta?.durationMs} url.path=${error?.meta?.['url.path']}`,
      `net_error 字段不全：${JSON.stringify(error)}`
    )
    check(
      request?.meta?.['url.path'] === '/diag-timeout/v1/slow' &&
        !JSON.stringify(request).includes('SECRET'),
      'net_request 在超时前已记录（能区分「没发出」与「发出没回」），且 query 已脱敏',
      `net_request 缺失或未脱敏：${JSON.stringify(request)}`
    )
    await context.close()
  }

  // ---------- [D] 未捕获异常 ----------
  console.log('\n[D] 未捕获异常 → error + error.stack 非空')
  {
    const { context, page } = await openApp()
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('contract-uncaught-boom')
      }, 0)
    })
    await page.waitForTimeout(600)

    const logs = await readLogs(page)
    const entry = logs
      .filter((item) => item.kind === 'error' && item.msg.includes('contract-uncaught-boom'))
      .at(-1)
    note(`error: ${JSON.stringify(entry)}`)
    check(
      Boolean(entry) &&
        typeof entry.meta?.['error.stack'] === 'string' &&
        entry.meta['error.stack'].length > 0 &&
        entry.meta?.['error.msg']?.includes('contract-uncaught-boom'),
      `error 到位：stack ${entry?.meta?.['error.stack']?.length ?? 0} 字符，error.msg="${entry?.meta?.['error.msg']}"`,
      `error 字段不全：${JSON.stringify(entry)}`
    )
    await context.close()
  }

  // ---------- [E] 配置保存失败（标准构建：服务地址可编辑） ----------
  console.log('\n[E] 配置保存失败 → config_change + result 字段')
  {
    const { context, page } = await openApp({ appUrl: STANDARD_URL, apiKey: false })
    /**
     * 落点按 #807 的新 IA 取：设置 → 账户与消费 → 模型来源 → 展开「第三方服务」那一行。
     *
     * 改前面的写法（`providerKindTrigger` + `getByRole('option')`）在改版后**点不到任何东西**：
     * 全仓已经没有「渠道」下拉（来源页 `hideProviderKind`），3 个选项变成一个三行手风琴，
     * 于是这条 walk 到 `locator.click` 30s 超时 —— 红在「点不到」，不是「配置保存没留痕」。
     *
     * 标准构建的默认生效来源是 DeepSeek 官方（只需 Key，地址是内置只读行），要**可编辑的服务地址**
     * 必须切到第三方那一行；地址 / 模型 / Key 是草稿，点行底「确认使用」才落盘（#807）。
     */
    await openApiConfigSection(page, { row: 'third' })
    await fillApiKey(page, API_KEY)
    // 注入点不变：把服务地址填成非法值，点「确认使用」→ 产品校验不过 = 一次真实的「配置保存失败」
    await fillBaseUrl(page, 'not-a-valid-url')
    // 这里不走 helpers 的 `clickApiKeyConfirm`：它检测到行内红字会主动抛错（那是给「应该成功」的用例用的），
    // 而本用例要的正是那次失败。所以按产品身份直接点行底的确认按钮。
    await page.getByTestId('settings-source-third-confirm').click()
    await page.waitForTimeout(600)

    const logs = await readLogs(page)
    const entry = logs.filter((item) => item.kind === 'config_change').at(-1)
    note(`config_change: ${JSON.stringify(entry)}`)
    check(
      Boolean(entry) &&
        entry.meta?.result === 'rejected' &&
        entry.meta?.action === 'provider-baseUrl' &&
        entry.meta?.reason === 'invalid',
      `config_change 到位：action=${entry?.meta?.action} result=${entry?.meta?.result} reason=${entry?.meta?.reason}`,
      `config_change 字段不全：${JSON.stringify(entry)}`
    )
    await context.close()
  }

  // ---------- [F] 长任务 ----------
  console.log('\n[F] 长任务 → longtask + durationMs')
  {
    const { context, page } = await openApp()
    await page.evaluate(() => {
      const start = performance.now()
      while (performance.now() - start < 250) {
        // 故意阻塞主线程 250ms
      }
    })
    await page.waitForTimeout(800)

    const logs = await readLogs(page)
    const entry = logs.filter((item) => item.kind === 'longtask').at(-1)
    note(`longtask: ${JSON.stringify(entry)}`)
    check(
      Boolean(entry) && typeof entry.meta?.durationMs === 'number' && entry.meta.durationMs >= 50,
      `longtask 到位：durationMs=${entry?.meta?.durationMs}（level=${entry?.level}）`,
      `longtask 字段不全：${JSON.stringify(entry)}`
    )
    await context.close()
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  try { await browser.close() } finally { await cleanup() }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/diagnostics-contract.test.mjs`)
if (evidence.length > 0) {
  console.log('实际断言到的字段：')
  for (const item of evidence) {
    console.log(`  · ${item}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
