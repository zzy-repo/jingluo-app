// [layer: e2e | 依赖: E2E_API_KEY + 真上游可达 | 耗时: 1~2 分钟] 说明见 tests/README.md
// legacy 通道（后端实际接口）端到端验收（真实提交 + 裁剪 + 降级重试）：
//
//   cd /root/deepseek-app && node tests/e2e/diagnostics-upload.test.mjs
//
// 被测页面默认是部署在 5181 的 dist（APP_URL 可覆盖），会**真实提交**到后端：
//   POST http://140.210.13.146:60012/feedback  Body: { content, type, contact, version, log }
//
// 断言：
//   [1] 真实提交成功，响应里的 logSize > 0，且等于我们发出的 log 字节数
//   [2] 请求 body 只有五个字段，log 是字符串，content 不含环境与日志
//   [3] 300KB 日志 → 裁剪到 ≤150KB，error 一条不丢，开头有 [truncated]
//   [4] 1MB 日志 → 第一次连接被重置 → 自动降级 50KB 重试 → 最终成功
//   [5] log 里 sk- / Bearer / Signature= / AccessKeyId= 全部为 ***
//   [6] 413 → UI 给出可读的「体积过大」提示（不是未知错误）
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const FEEDBACK_URL = 'http://140.210.13.146:60012/feedback'
const LOG_MAX_BYTES = 150 * 1024
const LOG_RETRY_BYTES = 50 * 1024
const BODY_MAX_BYTES = 180 * 1024

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

const browser = await chromium.launch()

/** 打开反馈页（设置 → 数据管理 → 写反馈），返回可用于操作的 page */
const openFeedbackForm = async (options = {}) => {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const requests = []
  const responses = []
  page.on('request', (request) => {
    if (request.url().startsWith(FEEDBACK_URL) && request.method() === 'POST') {
      requests.push({ url: request.url(), body: request.postData() ?? '' })
    }
  })
  page.on('response', async (response) => {
    if (response.url().startsWith(FEEDBACK_URL)) {
      responses.push({ status: response.status(), text: await response.text().catch(() => '') })
    }
  })
  if (options.route) {
    await page.route(`${FEEDBACK_URL}*`, options.route)
  }
  await page.goto(`${APP_URL}?diag-debug=1`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__diagnostics), null, { timeout: 10000 })
  await page.waitForTimeout(600)
  return { context, page, requests, responses }
}

const openFeedbackDialog = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  await page.waitForTimeout(400)
  return page.getByRole('dialog').last()
}

try {
  // ---------- [1][2] 真实提交到后端 + 请求体结构 ----------
  console.log('\n[1][2] 真实提交到 140.210.13.146:60012/feedback')
  {
    const { context, page, requests, responses } = await openFeedbackForm()
    // 先制造一点真实日志（含一次网络请求），保证 log 不是空的
    await page.evaluate(async () => {
      await fetch('/?diag-e2e=1').catch(() => '')
    })
    const form = await openFeedbackDialog(page)
    await form.locator('textarea').first().fill('端到端测试')
    await form.getByRole('button', { name: /^提交$/ }).first().click()
    await page.waitForTimeout(4000)

    const ticket = await page
      .locator('code')
      .first()
      .innerText()
      .catch(() => '')
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticket.trim())
    check(
      uuidLike,
      `界面显示后端返回的工单 id：${ticket.trim()}`,
      `未显示后端 id：${JSON.stringify(ticket)}`
    )

    check(requests.length === 1, `抓到了 ${requests.length} 次真实 POST`, `请求次数异常：${requests.length}`)
    const body = JSON.parse(requests[0]?.body ?? '{}')
    const keys = Object.keys(body).sort()
    check(
      keys.join(',') === 'contact,content,log,type,version',
      `请求 body 只有五个字段：${keys.join(',')}`,
      `body 字段异常：${keys.join(',')}`
    )
    check(
      typeof body.log === 'string' && body.log.length > 0,
      `log 是字符串（${Buffer.byteLength(body.log)} 字节）`,
      `log 不是字符串：${typeof body.log}`
    )
    check(
      body.content === '端到端测试' &&
        !body.content.includes('=== app') &&
        !body.content.includes('[info]'),
      `content 只含用户描述：${JSON.stringify(body.content)}`,
      `content 混入了环境/日志：${JSON.stringify(body.content)}`
    )

    const response = JSON.parse(responses[0]?.text ?? '{}')
    const sentLogBytes = Buffer.byteLength(body.log, 'utf8')
    check(
      typeof response.logSize === 'number' && response.logSize > 0,
      `服务端回显 logSize=${response.logSize}`,
      `响应里没有 logSize：${JSON.stringify(response)}`
    )
    check(
      response.logSize === sentLogBytes,
      `logSize 与本地发送字节数一致：${response.logSize} = ${sentLogBytes}`,
      `logSize 不一致：服务端 ${response.logSize} vs 本地 ${sentLogBytes}`
    )
    const bodyBytes = Buffer.byteLength(requests[0]?.body ?? '', 'utf8')
    check(
      bodyBytes < BODY_MAX_BYTES,
      `整个 body 序列化后 ${bodyBytes} 字节 < ${BODY_MAX_BYTES}（180KB）`,
      `body 超过 180KB：${bodyBytes}`
    )
    const ticketSize = await page.getByText(/（日志 \d+KB）/).count()
    check(ticketSize > 0, '成功提示里显示了日志大小（已提交，工单号 xxx（日志 xxKB））', '成功提示里没有日志大小')

    note(`content 前 3 行：\n${body.content.split('\n').slice(0, 3).join('\n')}`)
    note(`log 前 10 行（已脱敏）：\n${body.log.split('\n').slice(0, 10).join('\n')}`)
    note(`log 字节数：${sentLogBytes}，服务端 logSize：${response.logSize}`)
    await context.close()
  }

  // ---------- [3] 300KB 日志裁剪到 150KB ----------
  console.log('\n[3] 300KB 日志 → 裁剪到 ≤150KB，error 不丢，带 [truncated]')
  {
    const { context, page } = await openFeedbackForm()
    const trimmed = await page.evaluate(async (limit) => {
      const d = window.__diagnostics
      await d.clearDiagnostics()
      // 每条 2000 个汉字 ≈ 6KB；塞满缓冲（495 条）+ 5 条 error，序列化后 log 会远超 150KB
      for (let i = 0; i < 495; i += 1) {
        d.record('nav', 'info', `old-info-${i} ${'汉'.repeat(2000)}`)
      }
      for (let i = 0; i < 5; i += 1) {
        d.recordError(`boom-${i}`, { stage: 'test', 'http.status': 500 + i })
      }
      const snapshot = d.getDiagnosticsSnapshot()
      const payload = {
        schemaVersion: snapshot.schemaVersion,
        app: snapshot.app,
        device: snapshot.device,
        client: snapshot.client,
        feedback: { description: '裁剪测试', category: 'bug', contact: '' },
        logs: snapshot.logs,
      }
      const before = snapshot.logs.reduce(
        (sum, entry) => sum + new TextEncoder().encode(entry.msg).length,
        0
      )
      const request = d.buildLegacyRequest(payload, limit)
      const lines = request.build.log.split('\n')
      return {
        before,
        bytes: request.build.logBytes,
        bodyBytes: request.bodyBytes,
        omitted: request.build.omitted,
        truncated: request.build.truncated,
        firstLine: lines[0],
        errorLines: lines.filter((line) => line.includes('[error]')).length,
        keepsAllErrors: [0, 1, 2, 3, 4].every((index) => request.build.log.includes(`boom-${index}`)),
        hasHeader: lines.some((line) => line.startsWith('=== app ')),
        contentClean: request.body.content === '裁剪测试',
      }
    }, LOG_MAX_BYTES)
    note(
      `原始日志正文 ${Math.round(trimmed.before / 1024)}KB → log ${Math.round(trimmed.bytes / 1024)}KB（body ${Math.round(trimmed.bodyBytes / 1024)}KB），省略 ${trimmed.omitted} 条`
    )
    check(trimmed.omitted > 0, `确实发生了裁剪：省略 ${trimmed.omitted} 条`, '没有发生裁剪，用例没造出超限日志')
    check(
      trimmed.bodyBytes < BODY_MAX_BYTES,
      `裁剪后 body 序列化 = ${trimmed.bodyBytes} 字节 < ${BODY_MAX_BYTES}（log 原文 ${Math.round(trimmed.bytes / 1024)}KB）`,
      `body 仍超限：${trimmed.bodyBytes}`
    )
    check(trimmed.contentClean, 'content 仍是干净的用户描述（不含日志/环境）', 'content 混入了别的内容')
    check(
      trimmed.truncated && /^\[truncated\] 省略了 \d+ 条较早日志（原始 \d+ KB）$/.test(trimmed.firstLine),
      `开头带裁剪标记：${trimmed.firstLine}`,
      `裁剪标记异常：${trimmed.firstLine}`
    )
    check(trimmed.keepsAllErrors && trimmed.errorLines >= 5, `error 级一条不丢（${trimmed.errorLines} 条 error 行）`, `error 丢了：${trimmed.errorLines} 行`)
    check(trimmed.hasHeader, 'log 头部带环境 header（=== app ...）', 'log 缺少环境 header')
    await context.close()
  }

  // ---------- [4] 超大日志：先失败 → 自动降级 50KB 重试 → 成功 ----------
  console.log('\n[4] 连接重置 → 自动降级 50KB 重试')
  {
    let attempt = 0
    const { context, page, requests, responses } = await openFeedbackForm({
      route: async (route) => {
        attempt += 1
        if (attempt === 1) {
          // 模拟「1MB 日志打崩连接」：第一次直接重置
          await route.abort('connectionreset')
          return
        }
        await route.continue()
      },
    })
    const result = await page.evaluate(async () => {
      const d = window.__diagnostics
      await d.clearDiagnostics()
      // 500 条 × 2000 汉字 ≈ 3MB，远超 150KB
      for (let i = 0; i < 500; i += 1) {
        d.record('nav', 'info', `huge-${i} ${'汉'.repeat(2000)}`)
      }
      d.recordError('huge-boom', { stage: 'retry-test' })
      return d.submitFeedback({ description: '重试测试', category: 'bug' })
    })
    await page.waitForTimeout(1500)
    check(
      result.ok === true && typeof result.id === 'string',
      `降级重试后提交成功：id=${result.id}（第一次被重置，${requests.length} 次请求）`,
      `重试后仍然失败：${JSON.stringify(result)}`
    )
    check(requests.length === 2, `共发出 ${requests.length} 次请求（第一次失败 + 降级重试一次）`, `请求次数异常：${requests.length}`)
    const retryBody = JSON.parse(requests[1]?.body ?? '{}')
    const retryBytes = Buffer.byteLength(retryBody.log ?? '', 'utf8')
    const retryBodyBytes = Buffer.byteLength(requests[1]?.body ?? '', 'utf8')
    check(
      retryBytes <= LOG_RETRY_BYTES && retryBodyBytes < BODY_MAX_BYTES && (retryBody.log ?? '').startsWith('[truncated]'),
      `降级后的 log = ${retryBytes} 字节（body ${retryBodyBytes} 字节）≤ 50KB，且带 [truncated]`,
      `降级后的 log 异常：${retryBytes} 字节 / body ${retryBodyBytes}`
    )
    const response = JSON.parse(responses.at(-1)?.text ?? '{}')
    check(
      response.logSize === retryBytes,
      `服务端 logSize=${response.logSize} = 重试的 log 字节数 ${retryBytes}`,
      `重试 logSize 不一致：${response.logSize} vs ${retryBytes}`
    )
    check(result.retried === true, '返回值标记了 retried（走过降级重试）', `没有 retried 标记：${JSON.stringify(result)}`)
    note(`降级重试：第 1 次 ${Math.round(Buffer.byteLength(JSON.parse(requests[0]?.body ?? '{}').log ?? '', 'utf8') / 1024)}KB（连接重置）→ 第 2 次 ${Math.round(retryBytes / 1024)}KB 成功`)
    await context.close()
  }

  // ---------- [5] 序列化层再脱敏 ----------
  console.log('\n[5] log 里的密钥 / 签名全部为 ***')
  {
    const { context, page } = await openFeedbackForm()
    const out = await page.evaluate(async (limit) => {
      const d = window.__diagnostics
      await d.clearDiagnostics()
      const snapshot = d.getDiagnosticsSnapshot()
      // 故意绕过采集层，直接把原文塞进 payload，验证序列化层也会脱敏
      const payload = {
        schemaVersion: snapshot.schemaVersion,
        app: snapshot.app,
        device: snapshot.device,
        client: snapshot.client,
        feedback: { description: '脱敏测试', category: 'bug', contact: '' },
        logs: [
          {
            t: Date.now(),
            kind: 'error',
            level: 'error',
            msg: 'auth sk-abcdefghijklmnopqrstuvwxyz012345 Bearer abc.def.ghi failed',
            meta: { 'url.path': '/v1/messages?Signature=SECRETSIG&AccessKeyId=AKIA123456&token=TOK' },
          },
        ],
      }
      return d.buildLegacyLog(payload, limit).log
    }, LOG_MAX_BYTES)
    check(
      out.includes('sk-***') && out.includes('Bearer ***') && out.includes('Signature=***') && out.includes('AccessKeyId=***'),
      `序列化层脱敏到位：${out.split('\n').at(-1)?.slice(0, 160)}`,
      `脱敏不完整：${out}`
    )
    check(
      !out.includes('abcdefghijklmnop') && !out.includes('abc.def.ghi') && !out.includes('SECRETSIG') && !out.includes('AKIA123456'),
      '原文（sk- 全量 / Bearer 值 / Signature 值 / AccessKeyId 值）都没有落进 log',
      `log 里仍有原文：${out}`
    )
    await context.close()
  }

  // ---------- [6] 413 → 可读提示 ----------
  console.log('\n[6] 后端 413 → UI 给出可读的「体积过大」提示')
  {
    const { context, page } = await openFeedbackForm({
      route: (route) =>
        route.fulfill({
          status: 413,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'payload too large' }),
        }),
    })
    const form = await openFeedbackDialog(page)
    await form.locator('textarea').first().fill('413 测试')
    await form.getByRole('button', { name: /^提交$/ }).first().click()
    await page.waitForTimeout(2000)
    const alert = await page.getByRole('alert').first().innerText().catch(() => '')
    note(`413 提示：${alert}`)
    check(
      alert.includes('体积上限') || alert.includes('413'),
      'UI 显示可读的「体积过大」提示',
      `提示不是可读文案：${JSON.stringify(alert)}`
    )
    check(!/未知错误|unknown/i.test(alert), '没有退化成「未知错误」', `退化成未知错误：${alert}`)
    await context.close()
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/e2e/diagnostics-upload.test.mjs`)
if (evidence.length > 0) {
  console.log('实测数据：')
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
