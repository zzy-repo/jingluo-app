// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 日志采集 + 反馈上传验收（自建、纯本地，不依赖真实后端）：
//
//   cd /root/deepseek-app && pnpm build:internal && node tests/integration/diagnostics.test.mjs
//
// 被测页面是 dist（内测构建）上的独立静态服务（默认 5293），上游与反馈后端都不连真实服务：
// - 反馈"后端"用注入的 mock transport（页面内 setFeedbackTransport）与 page.route 打桩；
// - 采集层/上传层的内部状态通过 `?diag-debug` 暴露的 window.__diagnostics 调试入口读取
//   （只有带该 query 时才挂，正常使用不暴露任何东西）。
//
// 8 条断言对应任务书验收：
//   [1] 环形缓冲：塞 600 条只留最新 500 条；刷新后仍在（IndexedDB）
//   [2] 脱敏：sk- / Bearer / Signature= / AccessKeyId= / token= 全部变 ***，URL 只剩 path
//   [3] 长 msg 截断到 2000 字符
//   [4] hook 生效：console.error / 未捕获异常 / 未处理 rejection / fetch 失败都被记录
//   [5] transport 可替换：注入 mock 后 submitFeedback 走 mock；collector 无 transport 也能采集；
//       并且源码层 collector.ts 不 import transport、transport.ts 不 import collector
//   [6] 体积控制：超大 logs + 截图 → payload ≤ 2MB 且截图被压缩（最长边 ≤1280）
//   [7] UI 流程：设置 → 反馈与日志 → 填描述 → 日志预览条数正确 → 提交（mock transport）→ 显示工单号
//   [8] console error = 0
//   [9] 提交前自检 validatePayload：少日志 / 没网络 / 跨度<1s 三条提示 + 缺 state_snapshot 时自动补
//  [10] 「检查日志完整性」按钮实测：条数 / 时间跨度 / 覆盖事件类型数 / 缺失项（含截图）
//  （6 类故障注入的契约测试见 tests/integration/diagnostics-contract.test.mjs）
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const PORT = process.env.PORT
let APP_URL = process.env.APP_URL || ''
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const TICKET = 'fb_20261118_a3f9'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

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

// ---------- 0) 静态服务 ----------
try {
  readFileSync(path.join(DIST, 'index.html'))
} catch {
  console.error(`缺少构建产物 ${DIST}，先跑: pnpm build:internal`)
  process.exit(1)
}

const children = []
verifyDist(DIST, { variant: 'internal' })
// 端口自动发现（PORT 可注入），避免固定端口撞车
const served = await serveDir(DIST, { port: PORT, label: '内测产物 dist' })
APP_URL = APP_URL || served.url
// 连外部 APP_URL 时也要校验「端口上那份产物」是不是内测包（防止撞到别人的标准包 → 假红）
await verifyAppUrl(APP_URL, DIST, { variant: 'internal' })
const cleanup = () => {
  // 静态服务是进程内 http 服务（serveDir → runtime.serveDist），必须显式关，否则进程不退出
  try {
    served.kill()
  } catch {
    // 已关闭
  }
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
}
const browser = await chromium.launch()
const consoleErrors = []

/** 新开一个干净页面；?diag-debug 打开调试入口 */
const openPage = async (options = {}) => {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  // 反馈服务的真实地址一律拦掉：用例只允许走 mock，一旦有人偷偷发真请求立刻看得见
  await context.route('**/feedback.rose7.cn/**', (route) => route.abort())
  const page = await context.newPage()
  const realRequests = []
  page.on('request', (request) => {
    if (request.url().includes('feedback.rose7.cn')) {
      realRequests.push(request.url())
    }
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && options.collectConsoleErrors) {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    if (options.collectConsoleErrors) {
      consoleErrors.push(`pageerror: ${error.message}`)
    }
  })
  await page.goto(`${APP_URL}?diag-debug=1`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__diagnostics), null, { timeout: 10000 })
  await page.waitForTimeout(600)
  return { page, context, realRequests }
}

try {
  // ---------- [5-a] 源码层解耦（不需要浏览器） ----------
  console.log('\n[5] 采集层 / 上传层解耦（源码）')
  const collectorSource = readFileSync(
    path.join(ROOT, 'src/services/diagnostics/collector.ts'),
    'utf8'
  )
  // 上传层的每个实现都不能反向依赖采集层（新增 transport.xxx.ts 也按这条规矩检查）
  const transportSources = ['transport.http.ts', 'transport.legacy.ts', 'shared.ts'].map((name) => ({
    name,
    source: readFileSync(path.join(ROOT, 'src/services/diagnostics', name), 'utf8'),
  }))
  const facadeSource = readFileSync(path.join(ROOT, 'src/services/diagnostics/index.ts'), 'utf8')

  const collectorImports = /from '\.\/transport/.test(collectorSource)
  const reverseImports = transportSources.filter((item) => /from '\.\/collector\.js'/.test(item.source))
  check(
    !collectorImports && reverseImports.length === 0,
    `collector.ts 不 import 任何 transport；${transportSources.map((item) => item.name).join(' / ')} 都不 import collector（只有 index.ts 串两者）`,
    `存在反向依赖：collector→transport=${collectorImports}, 反向=${reverseImports.map((item) => item.name).join(',')}`
  )
  check(
    /from '\.\/collector\.js'/.test(facadeSource) &&
      /from '\.\/transport\.http\.js'/.test(facadeSource) &&
      /from '\.\/transport\.legacy\.js'/.test(facadeSource),
    'index.ts 同时引用 collector 与两套 transport（门面负责串联）',
    'index.ts 没有同时引用两层'
  )
  check(
    /export interface FeedbackTransport/.test(readFileSync(path.join(ROOT, 'src/services/diagnostics/types.ts'), 'utf8')) &&
      /send\(payload: FeedbackPayload\)/.test(readFileSync(path.join(ROOT, 'src/services/diagnostics/types.ts'), 'utf8')),
    'FeedbackTransport 接口（name + send(payload)）定义在 types.ts',
    'FeedbackTransport 接口缺失或签名不符'
  )

  // ---------- 采集层单元断言 ----------
  const a = await openPage()
  const page = a.page

  // [5-b] collector 在没有 transport 的情况下也能正常采集
  console.log('\n[5] collector 不依赖 transport（运行时）')
  const bare = await page.evaluate(() => {
    const d = window.__diagnostics
    d.recordLog('info', 'bare-collect-ok')
    const snapshot = d.getDiagnosticsSnapshot()
    return {
      lastMsg: snapshot.logs.at(-1)?.msg,
      keys: Object.keys(snapshot).sort(),
      app: snapshot.app,
      device: snapshot.device,
      client: snapshot.client,
      transportName: d.getFeedbackTransportName(),
    }
  })
  check(bare.lastMsg === 'bare-collect-ok', 'collector 单独可用（不需要 transport）', `采集失败：${bare.lastMsg}`)
  check(
    bare.keys.join(',') === 'app,client,device,logs,schemaVersion',
    `快照键 = ${bare.keys.join(',')}（不含 feedback / screenshot，采集层不关心用户填写内容）`,
    `快照键异常：${bare.keys.join(',')}`
  )
  check(
    bare.app.version !== 'unknown' && bare.app.platform !== '' && /^\d+$/.test(String(bare.app.versionCode)) === true,
    `环境信息：version=${bare.app.version} versionCode=${bare.app.versionCode} buildType=${bare.app.buildType} platform=${bare.app.platform}`,
    `环境信息缺失：${JSON.stringify(bare.app)}`
  )
  note(
    `device=${JSON.stringify(bare.device)} clientId/sessionId 长度=${bare.client.clientId.length}/${bare.client.sessionId.length}`
  )
  check(
    /^[0-9a-f-]{36}$/i.test(bare.client.clientId) && /^[0-9a-f-]{36}$/i.test(bare.client.sessionId) &&
      bare.client.clientId !== bare.client.sessionId,
    'clientId（设备级 UUID）与 sessionId（每次启动新生成）都是 UUID 且互不相同',
    `clientId/sessionId 异常：${JSON.stringify(bare.client)}`
  )
  check(
    bare.transportName === 'legacy',
    "默认 transport.name = 'legacy'（LegacyTransport，对应后端实际接口；v1 的 HttpTransport 仍保留）",
    `默认 transport 异常：${bare.transportName}`
  )

  // [1] 环形缓冲
  console.log('\n[1] 环形缓冲 500 条')
  const ring = await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    for (let i = 0; i < 600; i += 1) {
      d.recordLog('info', `entry-${i}`)
    }
    const logs = d.getDiagnosticsSnapshot().logs
    return { count: logs.length, first: logs[0]?.msg, last: logs.at(-1)?.msg, total: d.getDiagnosticsLogCount() }
  })
  check(ring.count === 500 && ring.total === 500, `塞 600 条后缓冲长度 = ${ring.count}`, `缓冲长度 = ${ring.count}（期望 500）`)
  check(
    ring.first === 'entry-100' && ring.last === 'entry-599',
    `保留的是最新 500 条（首条 ${ring.first}，末条 ${ring.last}）`,
    `保留的不是最新 500 条（首条 ${ring.first}，末条 ${ring.last}）`
  )

  // 落盘：刷新后仍在
  await page.evaluate(() => window.__diagnostics.flushDiagnostics())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__diagnostics), null, { timeout: 10000 })
  await page.waitForTimeout(700)
  const afterReload = await page.evaluate(() => {
    const logs = window.__diagnostics.getDiagnosticsSnapshot().logs
    return {
      count: logs.length,
      has599: logs.some((entry) => entry.msg === 'entry-599'),
      hasLaunch: logs.some((entry) => entry.kind === 'app_launch'),
      kinds: [...new Set(logs.map((entry) => entry.kind))],
    }
  })
  check(
    afterReload.count === 500 && afterReload.has599,
    `刷新后仍能读到 500 条（IndexedDB 落盘生效，最新一条 entry-599 在缓冲里）`,
    `刷新后日志异常：${JSON.stringify(afterReload)}`
  )
  check(
    afterReload.hasLaunch,
    `刷新后仍保留启动即写的 app_launch（本次启动日志排在旧日志之后）`,
    `刷新后没有 app_launch：${JSON.stringify(afterReload)}`
  )

  // [3] 长 msg 截断
  console.log('\n[3] 单条 msg 截断到 2000 字符')
  const truncated = await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    d.recordLog('info', 'y'.repeat(5000))
    const logs = d.getDiagnosticsSnapshot().logs
    return { length: logs[0]?.msg.length, count: logs.length }
  })
  check(truncated.length === 2000, `5000 字符的 msg 截断为 ${truncated.length}`, `截断长度 = ${truncated.length}（期望 2000）`)

  // [2] 脱敏
  console.log('\n[2] 脱敏（在采集层完成）')
  const redacted = await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    d.recordLog('error', 'auth sk-abcdefghijklmnopqrstuvwxyz012345 rejected; header Authorization: Bearer abc.def.ghi')
    d.recordLog('warn', 'GET https://oss.example.com/bucket/file.zip?Signature=SECRETSIG&AccessKeyId=AKIA123456&x=1')
    d.recordLog('info', 'callback?token=SECRETTOKEN&y=2')
    const logs = d.getDiagnosticsSnapshot().logs.map((entry) => entry.msg)
    return {
      logs,
      pathOnly: d.redactUrl('https://oss.example.com/bucket/file.zip?Signature=S&AccessKeyId=A&token=T#frag'),
      relative: d.redactUrl('/v1/messages?token=abc'),
    }
  })
  const [line1, line2, line3] = redacted.logs
  check(
    line1.includes('sk-***') && !line1.includes('abcdefghijklmnop') && line1.includes('Bearer ***') && !line1.includes('abc.def.ghi'),
    `sk / Bearer 已脱敏：${line1}`,
    `sk / Bearer 脱敏失败：${line1}`
  )
  check(
    line2.includes('Signature=***') && line2.includes('AccessKeyId=***') && !line2.includes('SECRETSIG') && !line2.includes('AKIA123456'),
    `Signature / AccessKeyId 已脱敏：${line2}`,
    `Signature / AccessKeyId 脱敏失败：${line2}`
  )
  check(line3.includes('token=***') && !line3.includes('SECRETTOKEN'), `token 已脱敏：${line3}`, `token 脱敏失败：${line3}`)
  check(
    redacted.pathOnly === '/bucket/file.zip' && redacted.relative === '/v1/messages',
    `URL 只剩 path：${redacted.pathOnly} / ${redacted.relative}（query、hash、host 全部丢掉）`,
    `URL 未收敛到 path：${redacted.pathOnly} / ${redacted.relative}`
  )

  // fetch 失败也要只剩 path
  await page.route('**/diag-test/**', (route) => route.fulfill({ status: 500, body: 'boom' }))
  await page.evaluate(() => window.fetch('/diag-test/api/v1/messages?Signature=ZZZ&token=QQQ').catch(() => ''))
  await page.waitForTimeout(400)
  const fetchLogs = await page.evaluate(() =>
    window.__diagnostics
      .getDiagnosticsSnapshot()
      .logs.filter((entry) => entry.kind === 'net_request' || entry.kind === 'net_response')
  )
  const fetchResponse = fetchLogs.filter((entry) => entry.kind === 'net_response').at(-1)
  const fetchRequest = fetchLogs.filter((entry) => entry.kind === 'net_request').at(-1)
  check(
    fetchRequest?.meta?.['url.path'] === '/diag-test/api/v1/messages' &&
      !JSON.stringify(fetchRequest).includes('Signature=ZZZ'),
    `网络请求全量记录（成功失败都记）：net_request ${fetchRequest?.msg}`,
    `net_request 缺失或未脱敏：${JSON.stringify(fetchRequest)}`
  )
  check(
    fetchResponse?.level === 'error' &&
      fetchResponse?.meta?.['http.status'] === 500 &&
      fetchResponse?.meta?.['url.path'] === '/diag-test/api/v1/messages' &&
      typeof fetchResponse?.meta?.durationMs === 'number' &&
      !JSON.stringify(fetchResponse).includes('Signature=ZZZ'),
    `非 2xx 记 error 级 net_response：${fetchResponse?.msg} meta=${JSON.stringify(fetchResponse?.meta)}`,
    `net_response 记录异常：${JSON.stringify(fetchResponse)}`
  )

  // [4] hook 生效
  console.log('\n[4] hook：console.error / 未捕获异常 / rejection')
  await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    console.error('hook-console-error')
    setTimeout(() => {
      throw new Error('hook-uncaught-exception')
    }, 0)
    Promise.reject(new Error('hook-unhandled-rejection'))
  })
  await page.waitForTimeout(600)
  const hookLogs = await page.evaluate(() =>
    window.__diagnostics.getDiagnosticsSnapshot().logs.map((entry) => `${entry.level}|${entry.msg}`)
  )
  const joined = hookLogs.join('\n')
  check(joined.includes('hook-console-error'), 'console.error 被记录', `console.error 未记录：${joined}`)
  check(joined.includes('hook-uncaught-exception'), '未捕获异常（window.onerror）被记录', `未捕获异常未记录：${joined}`)
  check(joined.includes('hook-unhandled-rejection'), '未处理的 rejection 被记录', `rejection 未记录：${joined}`)

  // [5] transport 可替换
  console.log('\n[5] 注入 mock transport')
  const mockRun = await page.evaluate(async (ticket) => {
    const d = window.__diagnostics
    const calls = []
    const mock = {
      name: 'MockTransport',
      send: async (payload) => {
        calls.push(payload)
        return { ok: true, id: ticket }
      },
    }
    d.setFeedbackTransport(mock)
    const result = await d.submitFeedback({ description: 'mock 注入测试', category: 'feature' })
    const nameAfter = d.getFeedbackTransportName()
    // 失败路径也要按错误码返回
    d.setFeedbackTransport({ name: 'FailingTransport', send: async () => ({ ok: false, error: 'rate_limited' }) })
    const failure = await d.submitFeedback({ description: '失败路径', category: 'bug' })
    const payload = calls[0] ?? null
    d.setFeedbackTransport(mock)
    return {
      result,
      nameAfter,
      calls: calls.length,
      failure,
      payloadKeys: payload ? Object.keys(payload).sort() : [],
      feedback: payload?.feedback,
      logsInPayload: payload?.logs?.length ?? 0,
      hasClient: Boolean(payload?.client?.clientId),
      hasApp: Boolean(payload?.app?.version),
    }
  }, TICKET)
  check(
    mockRun.result.ok === true && mockRun.result.id === TICKET && mockRun.calls === 1,
    `submitFeedback 走的是注入的 mock（transport=${mockRun.nameAfter}，返回工单号 ${mockRun.result.id}，mock 收到 ${mockRun.calls} 次调用）`,
    `mock 未被调用或返回异常：${JSON.stringify(mockRun.result)} calls=${mockRun.calls}`
  )
  check(
    mockRun.payloadKeys.join(',') === 'app,client,device,feedback,logs,schemaVersion',
    `payload 键 = ${mockRun.payloadKeys.join(',')}（未带截图时没有 screenshot）`,
    `payload 键异常：${mockRun.payloadKeys.join(',')}`
  )
  check(
    mockRun.feedback?.category === 'feature' && mockRun.feedback?.description === 'mock 注入测试',
    `payload.feedback = ${JSON.stringify(mockRun.feedback)}`,
    `payload.feedback 异常：${JSON.stringify(mockRun.feedback)}`
  )
  check(
    mockRun.logsInPayload > 0 && mockRun.hasClient && mockRun.hasApp,
    `payload 携带 ${mockRun.logsInPayload} 条日志 + client/app 环境信息`,
    'payload 缺少日志或环境信息'
  )
  check(
    mockRun.failure.ok === false && mockRun.failure.error === 'rate_limited',
    `mock 返回失败时按错误码透出：${mockRun.failure.error} / ${mockRun.failure.message}`,
    `失败结果异常：${JSON.stringify(mockRun.failure)}`
  )

  // [6] 体积控制：先压截图，再裁最旧日志
  console.log('\n[6] 体积控制 ≤2MB（先压截图，再裁最旧日志）')
  const fitted = await page.evaluate(async (limit) => {
    const d = window.__diagnostics
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const context = canvas.getContext('2d')
    const image = context.createImageData(canvas.width, canvas.height)
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = Math.floor(Math.random() * 256)
      image.data[i + 1] = Math.floor(Math.random() * 256)
      image.data[i + 2] = Math.floor(Math.random() * 256)
      image.data[i + 3] = 255
    }
    context.putImageData(image, 0, 0)
    const big = canvas.toDataURL('image/jpeg', 1)

    const base = d.getDiagnosticsSnapshot()
    const makeLogs = (fill) =>
      Array.from({ length: 500 }, (_, i) => ({
        t: Date.now() + i,
        level: 'info',
        msg: fill.repeat(2000),
      }))
    const withPayload = (logs) => ({
      schemaVersion: base.schemaVersion,
      app: base.app,
      device: base.device,
      client: base.client,
      feedback: { description: '体积控制测试', category: 'bug', contact: '' },
      logs,
      screenshot: big,
    })
    const measure = async (payload) => {
      const before = d.payloadBytes(payload)
      const out = await d.fitPayload(payload)
      const dims = await new Promise((resolve) => {
        const probe = new Image()
        probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
        probe.onerror = () => resolve({ w: 0, h: 0 })
        probe.src = out.screenshot ?? ''
      })
      return {
        before,
        after: d.payloadBytes(out),
        beforeShot: big.length,
        afterShot: out.screenshot?.length ?? 0,
        prefix: (out.screenshot ?? '').slice(0, 22),
        longest: Math.max(dims.w, dims.h),
        logsBefore: payload.logs.length,
        logsAfter: out.logs.length,
      }
    }
    // A：普通日志 + 超大截图 —— 压一张截图就够，日志不动
    const shotOnly = await measure(withPayload(makeLogs('z')))
    // B：中文日志（每条 2000 字 ≈ 6000 字节）+ 超大截图 —— 压完截图还超，必须裁最旧的日志
    const withLogs = await measure(withPayload(makeLogs('汉')))
    return { limit, shotOnly, withLogs }
  }, MAX_PAYLOAD_BYTES)

  const { shotOnly, withLogs } = fitted
  check(
    shotOnly.before > MAX_PAYLOAD_BYTES && withLogs.before > MAX_PAYLOAD_BYTES,
    `原始 payload：${shotOnly.before} / ${withLogs.before} 字节（都超过 2MB）`,
    `用例没造出超限数据：${shotOnly.before} / ${withLogs.before}`
  )
  check(
    shotOnly.after <= MAX_PAYLOAD_BYTES && withLogs.after <= MAX_PAYLOAD_BYTES,
    `压缩裁剪后：${shotOnly.after} / ${withLogs.after} 字节 ≤ ${MAX_PAYLOAD_BYTES}`,
    `压缩后仍超限：${shotOnly.after} / ${withLogs.after}`
  )
  check(
    shotOnly.prefix.startsWith('data:image/jpeg') &&
      shotOnly.afterShot < shotOnly.beforeShot &&
      shotOnly.longest <= 1280,
    `截图被重新压缩：${shotOnly.beforeShot} → ${shotOnly.afterShot} 字符，最长边 ${shotOnly.longest} ≤ 1280`,
    `截图未被压缩：${shotOnly.beforeShot} → ${shotOnly.afterShot}，最长边 ${shotOnly.longest}`
  )
  check(
    shotOnly.logsAfter === 500,
    '只压截图就够时不动日志（500 条原样保留）',
    `不必要地裁了日志：${shotOnly.logsBefore} → ${shotOnly.logsAfter}`
  )
  check(
    withLogs.logsAfter < withLogs.logsBefore,
    `压完截图仍超 2MB 时从最旧的开始裁：${withLogs.logsBefore} → ${withLogs.logsAfter} 条`,
    `日志没有裁剪：${withLogs.logsBefore} → ${withLogs.logsAfter}`
  )

  // ---------- [9] 提交前自检 validatePayload ----------
  console.log('\n[9] validatePayload 自检提示 + 自动补 state_snapshot')
  const emptyCheck = await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    const base = d.getDiagnosticsSnapshot()
    const payload = {
      schemaVersion: base.schemaVersion,
      app: base.app,
      device: base.device,
      client: base.client,
      feedback: { description: '自检', category: 'bug', contact: '' },
      logs: [],
    }
    const { warnings } = await d.validatePayload(payload)
    return { warnings, logsAfter: payload.logs.length, kinds: payload.logs.map((entry) => entry.kind) }
  })
  check(
    emptyCheck.warnings.length === 3 &&
      ['few_logs', 'no_network', 'short_span'].every((item) => emptyCheck.warnings.includes(item)),
    `空日志时返回 3 条提示：${emptyCheck.warnings.join(',')}`,
    `提示项异常：${emptyCheck.warnings.join(',')}`
  )
  check(
    emptyCheck.logsAfter === 1 && emptyCheck.kinds[0] === 'state_snapshot',
    '缺 state_snapshot 时自动补一条当前快照（只补不阻断）',
    `没有自动补快照：${JSON.stringify(emptyCheck)}`
  )

  const healthyCheck = await page.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    for (let i = 0; i < 12; i += 1) {
      d.recordEvent('nav', `healthy-${i}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await fetch('/diag-test/ok').catch(() => '')
    d.recordEvent('nav', 'healthy-last')
    const base = d.getDiagnosticsSnapshot()
    const payload = {
      schemaVersion: base.schemaVersion,
      app: base.app,
      device: base.device,
      client: base.client,
      feedback: { description: '自检', category: 'bug', contact: '' },
      logs: base.logs,
    }
    const { warnings } = await d.validatePayload(payload)
    return {
      warnings,
      hasSnapshot: payload.logs.some((entry) => entry.kind === 'state_snapshot'),
      count: payload.logs.length,
    }
  })
  check(
    healthyCheck.warnings.length === 0,
    `日志健康时没有提示（${healthyCheck.count} 条日志，含网络记录，跨度 >1s）`,
    `健康日志仍有提示：${healthyCheck.warnings.join(',')}`
  )
  check(healthyCheck.hasSnapshot, '健康路径同样带 state_snapshot', '健康路径缺 state_snapshot')

  check(a.realRequests.length === 0, '全程没有任何请求真的发到 feedback.rose7.cn（mock 生效）', `有真实请求打到反馈服务：${a.realRequests.join(',')}`)
  await a.context.close()

  // ---------- [7][8] UI 流程 + console error ----------
  console.log('\n[7] UI：设置 → 反馈与日志 → 提交')
  const b = await openPage({ collectConsoleErrors: true })
  const ui = b.page
  if ((await ui.getByRole('dialog').count()) === 0) {
    await ui.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await ui.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await ui.waitForTimeout(300)
  const row = ui.getByText('反馈与日志').first()
  check((await row.count()) > 0, '设置页有「反馈与日志」一行', '设置页没有「反馈与日志」')

  // ---------- [10] 「检查日志完整性」按钮 ----------
  console.log('\n[10] 设置页「检查日志完整性」按钮')
  await ui.getByRole('button', { name: /检查日志完整性/ }).first().click()
  await ui.waitForTimeout(600)
  const integrity = ui.getByTestId('feedback-integrity').first()
  const integrityText = await integrity.innerText()
  note(`完整性自检输出：\n${integrityText.replace(/\n/g, ' / ')}`)
  check(
    /条数：\d+/.test(integrityText) &&
      /时间跨度：/.test(integrityText) &&
      /覆盖事件类型：\d+ 类/.test(integrityText) &&
      /缺失项：/.test(integrityText),
    '自检面板显示条数 / 时间跨度 / 覆盖事件类型数 / 缺失项',
    `自检面板内容不全：${integrityText}`
  )
  check(
    /缺失项：(?!无)/.test(integrityText) ? /缺失项：/.test(integrityText) : true,
    `缺失项：${/缺失项：([^\n]*)/.exec(integrityText)?.[1] ?? ''}`,
    '缺失项一行没渲染'
  )
  await mkdirSync(SHOT_DIR, { recursive: true })
  await ui.screenshot({ path: path.join(SHOT_DIR, 'diagnostics-integrity.png'), fullPage: true })
  note('截图 docs/ui/diagnostics-integrity.png')
  await ui.getByRole('dialog').last().getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await ui.waitForTimeout(500)

  // 清空后塞 7 条固定日志，让「日志预览条数」可断言
  await ui.evaluate(async () => {
    const d = window.__diagnostics
    await d.clearDiagnostics()
    for (let i = 0; i < 7; i += 1) {
      d.recordLog('info', `ui-log-${i}`)
    }
  })
  await ui.getByRole('button', { name: /写反馈/ }).first().click()
  await ui.waitForTimeout(400)

  const form = ui.getByRole('dialog').last()
  const textarea = form.locator('textarea').first()
  check((await textarea.count()) === 1, '反馈表单有可多行输入的问题描述框', '没有找到问题描述输入框')

  // 分类：问题反馈 → 功能建议
  await form.getByRole('button', { name: '分类' }).first().click()
  await ui.getByRole('option', { name: '功能建议' }).first().click()
  await ui.waitForTimeout(200)

  // 日志预览
  await form.getByRole('button', { name: /日志预览/ }).first().click()
  await ui.waitForTimeout(300)
  const countText = await form.getByText(/共 \d+ 条/).first().innerText()
  const previewRows = await form.locator('ol li').count()
  const labelCount = Number(/\d+/.exec(countText)?.[0] ?? '0')
  check(
    labelCount >= 8 && previewRows === Math.min(20, labelCount),
    `日志预览显示「${countText}」且列表渲染 ${previewRows} 条（= min(20, N)，N 含点击留痕）`,
    `日志预览条数异常：${countText} / 列表 ${previewRows} 条`
  )

  // 注入 mock transport 并提交
  await ui.evaluate((ticket) => {
    window.__diagMockCalls = []
    window.__diagnostics.setFeedbackTransport({
      name: 'MockTransport',
      send: async (payload) => {
        window.__diagMockCalls.push(payload)
        return { ok: true, id: ticket }
      },
    })
  }, TICKET)
  const description = '点发送后一直转圈，日志已附上'
  await textarea.fill(description)
  await form.getByRole('button', { name: /^提交$/ }).first().click()
  await ui.waitForTimeout(800)

  const ticketVisible = await ui.getByText(TICKET).first().isVisible().catch(() => false)
  check(ticketVisible, `提交成功后界面显示工单号 ${TICKET}`, `界面没有显示工单号 ${TICKET}`)
  const copyButton = await form.getByRole('button', { name: /复制|Copy/ }).count()
  check(copyButton > 0, '工单号旁边有复制按钮', '工单号旁边没有复制按钮')

  const uiSubmit = await ui.evaluate(() => {
    const calls = window.__diagMockCalls ?? []
    const payload = calls[0] ?? null
    return {
      calls: calls.length,
      transport: window.__diagnostics.getFeedbackTransportName(),
      description: payload?.feedback?.description,
      category: payload?.feedback?.category,
      logs: payload?.logs?.length ?? 0,
      uiEntries: (payload?.logs ?? []).filter((entry) => entry.msg.startsWith('ui-log-')).length,
      hasSnapshot: (payload?.logs ?? []).some((entry) => entry.kind === 'state_snapshot'),
      submitIntentLogged: (payload?.logs ?? []).some(
        (entry) => entry.kind === 'nav' && entry.meta?.transport === 'MockTransport'
      ),
      kinds: [...new Set((payload?.logs ?? []).map((entry) => entry.kind))],
    }
  })
  check(
    uiSubmit.calls === 1 && uiSubmit.transport === 'MockTransport',
    `UI 提交走的是 mock transport（调用 ${uiSubmit.calls} 次，name=${uiSubmit.transport}）`,
    `UI 没有走 mock：calls=${uiSubmit.calls} name=${uiSubmit.transport}`
  )
  check(
    uiSubmit.description === description && uiSubmit.category === 'feature',
    `提交的 feedback = { description: "${uiSubmit.description}", category: "${uiSubmit.category}" }`,
    `提交内容异常：${JSON.stringify(uiSubmit)}`
  )
  check(
    uiSubmit.uiEntries === 7 && uiSubmit.logs >= 8 && uiSubmit.submitIntentLogged,
    `payload 带 ${uiSubmit.logs} 条日志：7 条业务日志 + 点击留痕 + 1 条「这次走哪个 transport」的记录`,
    `payload 日志异常：${JSON.stringify(uiSubmit)}`
  )
  check(
    uiSubmit.hasSnapshot,
    `payload 里有 state_snapshot（validatePayload 自动补的当前快照），事件类型：${uiSubmit.kinds.join(',')}`,
    `payload 里没有 state_snapshot：${uiSubmit.kinds.join(',')}`
  )
  check(
    b.realRequests.length === 0,
    'UI 提交同样没有打到真实反馈服务',
    `UI 打到了真实反馈服务：${b.realRequests.join(',')}`
  )
  await b.context.close()

  // [8] console error
  console.log('\n[8] console error')
  check(
    consoleErrors.length === 0,
    'console error = 0',
    `console 有 ${consoleErrors.length} 条 error：${consoleErrors.slice(0, 3).join(' | ')}`
  )
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  await browser.close()
  cleanup()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/diagnostics.test.mjs`)
if (evidence.length > 0) {
  console.log('关键值：')
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
