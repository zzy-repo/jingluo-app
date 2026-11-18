// [layer: e2e | 依赖: E2E_API_KEY + 真上游可达 | 耗时: 1~2 分钟] 说明见 tests/README.md
// 真上游 + 真前端 的端到端冒烟测试（**不用任何 mock**）。
//
//   cd /root/deepseek-app && E2E_API_KEY=sk-xxx node tests/e2e/real-upstream.test.mjs
//
// 为什么需要它：此前 UI 用例全部用 page.route / mock 上游打桩，上游能力全部用 curl 验证，
// 两条线从未交叉——「真实 SSE 能不能被前端解析并渲染成文字」这件事一直没有自动化覆盖。
//
// 配置（全部走环境变量，API Key 绝不写进文件）：
//   E2E_UPSTREAM_URL  默认 http://140.210.13.146:60010
//   E2E_API_KEY       必填
//   E2E_MODEL         默认 deepseek-v4.1-flash
//   E2E_APP_URL       默认 http://100.113.135.55:5181
//   E2E_ROUNDS        默认 2（首轮冷启动 + 次轮热路径，作为 TTFT 基线）
//
// 覆盖：
//   [1] 设置页真实键盘输入 API Key → 保存
//   [2] 前置探针 GET {upstream}/v1/models（Node 侧直连，避免 CORS 干扰）→ 非 200 直接判「上游不可用」
//   [3] 发「你好」，记录：请求发出 / 首个字节(TTFB) / 界面首次出现助手文字 / 流结束
//   [4] 断言：助手气泡出现且文字长度 > 0、用户消息内容正确、流结束后 loading 消失、console error = 0
//   [5] 失败时按「上游不可用 / 上游格式不兼容 / 前端解析渲染」三层给出可诊断证据（含原始 SSE 前 20 行）
import { chromium } from 'playwright'
import { networkInterfaces } from 'node:os'

const UPSTREAM_URL = (process.env.E2E_UPSTREAM_URL || 'http://140.210.13.146:60010').replace(/\/+$/, '')
const API_KEY = process.env.E2E_API_KEY || ''
const MODEL = process.env.E2E_MODEL || 'deepseek-v4.1-flash'
const APP_URL = process.env.E2E_APP_URL || 'http://100.113.135.55:5181'
const ROUNDS = Math.max(1, Number(process.env.E2E_ROUNDS || 2))
const USER_TEXT = '你好'
const FIRST_TEXT_TIMEOUT = 30000
const VIEWPORT = { width: 402, height: 874 }

const mask = (key) => (key ? `${key.slice(0, 5)}…${key.slice(-4)}(${key.length})` : '（空）')
const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => console.log(`  ·   ${message}`)
const ms = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value)}ms`)

/** 上游 IP 若被绑到本机回环（tests/README.md 里内测构建验收用的 `ip addr add ... dev lo`），
 *  请求根本不会离开本机、必然是 mock 在应答——这种情况必须直接判失败，否则会假 PASS。 */
const loopbackHijack = () => {
  let host = ''
  try {
    host = new URL(UPSTREAM_URL).hostname
  } catch {
    return null
  }
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.address === host) {
        return `${host} 出现在本机网卡 ${name} 上（回环 alias），流量不会出网`
      }
    }
  }
  return null
}

// ---------- [2] 前置探针：上游到底活着没有 ----------
const probeUpstream = async () => {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${UPSTREAM_URL}/v1/models`, {
      headers: { 'x-api-key': API_KEY, Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(15000),
    })
    const body = await response.text()
    let modelIds = []
    try {
      modelIds = (JSON.parse(body).data || []).map((item) => item?.id).filter(Boolean)
    } catch {
      // 非 JSON 就只留原文摘要
    }
    return {
      status: response.status,
      elapsed: Date.now() - startedAt,
      contentType: response.headers.get('content-type') || '',
      modelIds,
      bodyHead: body.slice(0, 300),
    }
  } catch (error) {
    return {
      status: 0,
      elapsed: Date.now() - startedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

const reportUpstreamUnavailable = (probe, reason) => {
  console.error('\n========== 结论：上游不可用（FAIL，不是前端问题）==========')
  console.error(`  probe      : GET ${UPSTREAM_URL}/v1/models`)
  console.error(`  状态码     : ${probe.status}${probe.status === 0 ? '（连接未建立）' : ''}`)
  console.error(`  耗时       : ${ms(probe.elapsed)}`)
  if (probe.error) console.error(`  网络错误   : ${probe.error}`)
  if (probe.contentType) console.error(`  Content-Type: ${probe.contentType}`)
  if (probe.bodyHead) console.error(`  响应前 300 字: ${probe.bodyHead.replace(/\s+/g, ' ')}`)
  if (probe.modelIds?.length) console.error(`  模型列表   : ${probe.modelIds.join(', ')}`)
  console.error(`  判定理由   : ${reason}`)
  console.error('================================================================\n')
}

// ---------- 页面内 fetch 观测（只观测、不拦截不改写）----------
const INSTRUMENT = () => {
  const state = { requests: [], firstTextAt: null }
  window.__E2E__ = state
  const original = window.fetch
  const describe = (error) => (error && error.message ? String(error.message) : String(error))
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const record = {
      url,
      method: (init && init.method) || (typeof input === 'object' && input.method) || 'GET',
      sentAt: Date.now(),
      answeredAt: null,
      firstChunkAt: null,
      firstTextDeltaAt: null,
      endedAt: null,
      status: null,
      headers: {},
      error: null,
      stream: false,
      chunks: [],
      sseText: '',
    }
    state.requests.push(record)
    let response
    try {
      response = await original(input, init)
    } catch (error) {
      record.error = describe(error)
      record.answeredAt = Date.now()
      throw error
    }
    record.answeredAt = Date.now()
    record.status = response.status
    response.headers.forEach((value, key) => {
      record.headers[key] = value
    })
    const type = (record.headers['content-type'] || '').toLowerCase()
    if (!type.includes('text/event-stream') || !response.body) return response

    record.stream = true
    const [appStream, watchStream] = response.body.tee()
    const reader = watchStream.getReader()
    const decoder = new TextDecoder()
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const at = Date.now()
          if (record.firstChunkAt === null) record.firstChunkAt = at
          const text = decoder.decode(value, { stream: true })
          record.chunks.push({ at, bytes: value.length })
          record.sseText += text
          if (record.firstTextDeltaAt === null && /"text_delta"[^}]*"text"\s*:\s*"([^"\\]|\\.)+"/.test(record.sseText)) {
            record.firstTextDeltaAt = at
          }
        }
      } catch (error) {
        record.error = describe(error)
      } finally {
        record.endedAt = Date.now()
      }
    }
    pump()
    return new Response(appStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

const rawSseLines = (record, count = 20) =>
  (record?.sseText || '')
    .split(/\r\n|\r|\n/)
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .slice(0, count)

// ---------- 三层定位 ----------
const classifyFailure = ({ probe, record, assistantText, sawDelta }) => {
  if (probe.status !== 200) return '上游不可用（/v1/models 非 200）'
  if (!record) return '前端没发出请求（UI/配置层问题，不是上游）'
  if (record.error) return `请求本身失败：${record.error}`
  if (record.status && record.status >= 400) return `上游不可用（/v1/messages 返回 ${record.status}）`
  if (!record.firstChunkAt) return '上游不可用/上游没 flush：30s 内没收到任何字节'
  if (!sawDelta) return '上游格式不兼容：有字节但没有非空 text_delta'
  if (!assistantText) return '前端解析/渲染问题：上游已下发文字但界面仍是 0 字'
  return '未知'
}

const formatEvidence = (record) => {
  if (!record) {
    console.error('  证据：页面没有捕获到任何 fetch 请求')
    return
  }
  console.error(`  请求 URL      : ${record.method} ${record.url}`)
  console.error(`  请求状态码    : ${record.status ?? '（未收到响应）'}`)
  if (record.error) console.error(`  网络错误      : ${record.error}`)
  console.error(`  Content-Type  : ${record.headers['content-type'] ?? '（无）'}`)
  console.error(`  Transfer-Enc  : ${record.headers['transfer-encoding'] ?? '（无，可能未开启分块）'}`)
  console.error(`  Content-Length: ${record.headers['content-length'] ?? '（无）'}`)
  console.error(`  首字节        : ${record.firstChunkAt ? `已收到（${record.chunks.length} 个分块）` : '30s 内 0 字节'}`)
  console.error('  原始 SSE 前 20 行：')
  const lines = rawSseLines(record)
  if (lines.length === 0) {
    console.error('    （空）')
  } else {
    for (const line of lines) console.error(`    | ${line}`)
  }
}

// ---------- 主流程 ----------
if (!API_KEY) {
  console.error('缺少 E2E_API_KEY：E2E_API_KEY=sk-xxx node tests/e2e/real-upstream.test.mjs')
  process.exit(2)
}

console.log('真上游 + 真前端 端到端冒烟测试')
console.log(`  上游       : ${UPSTREAM_URL}`)
console.log(`  模型       : ${MODEL}`)
console.log(`  被测页面   : ${APP_URL}`)
console.log(`  API Key    : ${mask(API_KEY)}`)

const hijack = loopbackHijack()
if (hijack) {
  console.error(`\n✗ 前置检查失败：${hijack}`)
  console.error('  这说明「上游」其实是本机 mock（tests/README.md 里内测构建验收留下的 ip addr add）。')
  console.error(`  先执行：ip addr del ${new URL(UPSTREAM_URL).hostname}/32 dev lo  再重跑。`)
  process.exit(1)
}

console.log('\n[2] 前置探针 GET /v1/models')
const probe = await probeUpstream()
note(`状态码 ${probe.status}，耗时 ${ms(probe.elapsed)}${probe.modelIds?.length ? `，模型 ${probe.modelIds.slice(0, 5).join(', ')}` : ''}`)
if (probe.status !== 200) {
  reportUpstreamUnavailable(probe, '探针不是 200，后续 UI 用例没有意义，直接判上游不可用')
  process.exit(1)
}
ok('上游可用（/v1/models = 200）')

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: VIEWPORT })
const page = await context.newPage()
await page.addInitScript(INSTRUMENT)

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

const isResourceNoise = (text) => /Failed to load resource|net::ERR_|favicon/i.test(text)

try {
  // ---------- [1] 打开 App → 设置 → 真实键盘输入 API Key → 保存 ----------
  console.log('\n[1] 打开 App，设置页填写 API Key')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(400)

  const dialog = page.getByRole('dialog').first()
  const serviceUrlInput = dialog.getByLabel(/服务地址|Service URL/)
  const modelInput = dialog.getByLabel(/^模型$|^Model$/)
  if ((await serviceUrlInput.count()) > 0) {
    await serviceUrlInput.first().fill('')
    await serviceUrlInput.first().type(UPSTREAM_URL, { delay: 8 })
    note(`标准构建：服务地址填空为 ${UPSTREAM_URL}`)
  } else {
    note('内测构建：服务地址由构建常量钉死，改为在发请求时校验实际 URL')
  }
  if ((await modelInput.count()) > 0) {
    await modelInput.first().fill('')
    await modelInput.first().type(MODEL, { delay: 8 })
    note(`标准构建：模型填空为 ${MODEL}`)
  }

  const keyInput = dialog.locator('input[type="password"]').first()
  await keyInput.click()
  await page.keyboard.type(API_KEY, { delay: 10 })
  const typedLength = await keyInput.inputValue()
  if (typedLength !== API_KEY) bad(`API Key 键盘输入长度不符：${typedLength.length} vs ${API_KEY.length}`)
  else ok('API Key 已通过真实键盘输入填入')

  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(1200)
  const storedKey = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
  if (storedKey !== API_KEY) bad('API Key 没有写入 localStorage（保存失败）')
  else ok('API Key 已保存')

  if ((await page.getByRole('dialog').count()) > 0) {
    const close = dialog.getByRole('button', { name: /^关闭$|^Close$/ })
    if ((await close.count()) > 0) await close.first().click()
    await page.waitForTimeout(400)
  }

  // ---------- [3][4] 发消息，记录四个时间点 ----------
  const rounds = []
  for (let round = 1; round <= ROUNDS; round += 1) {
    console.log(`\n[3] 第 ${round} 轮：发送「${USER_TEXT}」`)
    const offset = await page.evaluate(() => {
      window.__E2E__.firstTextAt = null
      return window.__E2E__.requests.length
    })

    const textarea = page.locator('textarea').last()
    await textarea.click()
    await textarea.fill(USER_TEXT)

    // 上一轮的助手气泡已经有文字，必须按「新出现的助手文本节点」取样，
    // 否则第二轮会立刻命中旧节点、把出字时间测成几十毫秒（假快）。
    const baselineNodes = await page.evaluate(
      () => document.querySelectorAll('.ds-assistant-message-main-content').length
    )

    const sentAt = Date.now()
    await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()

    let firstTextAt = null
    let timedOut = false
    try {
      await page.waitForFunction(
        (base) => {
          const nodes = document.querySelectorAll('.ds-assistant-message-main-content')
          if (nodes.length <= base) return false
          const text = nodes[nodes.length - 1].innerText.trim()
          if (text.length > 0) {
            if (window.__E2E__ && window.__E2E__.firstTextAt === null) {
              window.__E2E__.firstTextAt = Date.now()
            }
            return true
          }
          return false
        },
        baselineNodes,
        { polling: 20, timeout: FIRST_TEXT_TIMEOUT }
      )
      firstTextAt = await page.evaluate(() => window.__E2E__.firstTextAt)
    } catch {
      timedOut = true
    }

    // 等到流真的结束（SSE 读取完成），再判断 loading 是否消失
    const record = await page
      .waitForFunction(
        (start) => {
          const list = window.__E2E__.requests.slice(start)
          const stream = list.find((item) => item.stream)
          if (stream && stream.endedAt) return { done: true, index: window.__E2E__.requests.indexOf(stream) }
          if (list.length > 0 && list.every((item) => item.error || (!item.stream && item.answeredAt))) {
            return { done: true, index: window.__E2E__.requests.indexOf(list.at(-1)) }
          }
          return false
        },
        offset,
        { polling: 50, timeout: timedOut ? 5000 : 90000 }
      )
      .then((handle) => handle.jsonValue())
      .then((value) => page.evaluate((index) => window.__E2E__.requests[index], value.index))
      .catch(() => null)

    if (!record) bad(`第 ${round} 轮没有捕获到任何上游请求`)
    if (record && record.url !== undefined) {
      const expected = `${UPSTREAM_URL}/v1/messages`
      if (!record.url.startsWith(expected.split('/v1/')[0])) {
        bad(`实际请求地址 ${record.url} 不是配置的上游 ${UPSTREAM_URL}`)
      } else {
        ok(`请求打到配置的上游：${record.method} ${record.url}`)
      }
      if (record.status >= 400) bad(`上游返回 ${record.status}`)
    }

    const sawDelta = Boolean(record?.firstTextDeltaAt)
    if (!sawDelta && record) note('上游没有下发非空 text_delta')

    // 等 loading 消失（发送按钮从「停止生成」变回「发送」）
    let loadingCleared = false
    if (!timedOut) {
      try {
        await page.waitForFunction(
          () => {
            const stop = document.querySelector('button[aria-label="停止生成"], button[aria-label="Stop generating"]')
            return !stop
          },
          null,
          { polling: 50, timeout: 10000 }
        )
        loadingCleared = true
      } catch {
        loadingCleared = false
      }
    }

    const assistantText = await page
      .evaluate((base) => {
        const nodes = document.querySelectorAll('.ds-assistant-message-main-content')
        return nodes.length <= base ? '' : nodes[nodes.length - 1].innerText || ''
      }, baselineNodes)
      .catch(() => '')
    const userOk = await page.evaluate((expected) => {
      const insideAssistant = (node) => {
        for (let el = node; el; el = el.parentElement) {
          if (el.classList && el.classList.contains('ds-assistant-message-main-content')) return true
        }
        return false
      }
      const all = Array.from(document.querySelectorAll('body *'))
      const hits = all.filter(
        (el) =>
          el.children.length === 0 &&
          el.tagName !== 'TEXTAREA' &&
          (el.innerText || '').trim() === expected &&
          !insideAssistant(el)
      )
      return hits.length
    }, USER_TEXT)

    const metrics = {
      round,
      sentAt,
      ttfb: record?.firstChunkAt ? record.firstChunkAt - sentAt : null,
      firstDelta: record?.firstTextDeltaAt ? record.firstTextDeltaAt - sentAt : null,
      firstText: firstTextAt ? firstTextAt - sentAt : null,
      total: record?.endedAt ? record.endedAt - sentAt : null,
      textLength: assistantText.trim().length,
      chunks: record?.chunks?.length ?? 0,
      assistantText,
      timedOut,
      loadingCleared,
      userOk,
    }
    rounds.push(metrics)

    note(
      `TTFB ${ms(metrics.ttfb)} · 首个 text_delta ${ms(metrics.firstDelta)} · 界面出字 ${ms(metrics.firstText)} · 总耗时 ${ms(metrics.total)} · 分块 ${metrics.chunks}`
    )
    note(`助手文字长度 ${metrics.textLength}：${JSON.stringify(assistantText.trim().slice(0, 60))}`)

    // ---------- [4] 断言 ----------
    if (metrics.textLength > 0) ok('助手气泡出现且文字长度 > 0')
    else bad(`第 ${round} 轮助手文字长度为 0`)

    if (metrics.userOk > 0) ok('用户消息内容正确（界面能找到「你好」）')
    else bad('界面上找不到用户消息「你好」')

    if (metrics.loadingCleared) ok('流结束后 loading 已消失（未卡在生成中）')
    else if (!timedOut) bad('流结束后仍停留在 loading 状态')

    if (metrics.textLength === 0) {
      console.error(`\n---------- 第 ${round} 轮诊断 ----------`)
      const judged = classifyFailure({ probe, record, assistantText, sawDelta })
      console.error(`  判定：${judged}`)
      formatEvidence(record)
      console.error('-------------------------------------\n')
    }

    // 第二轮先等 UI 完全静下来再发，避免上一轮流尾巴干扰取样
    if (round < ROUNDS) await page.waitForTimeout(1500)
  }

  // ---------- [4] console error ----------
  console.log('\n[4] console error')
  const realErrors = consoleErrors.filter((text) => !isResourceNoise(text))
  if (realErrors.length === 0) ok(`console error = 0（已忽略 ${consoleErrors.length - realErrors.length} 条资源加载日志）`)
  else bad(`console error = ${realErrors.length}：${JSON.stringify(realErrors.slice(0, 3))}`)

  // ---------- [6] 性能基线 ----------
  console.log('\n[6] 性能基线（发版前对比）')
  for (const metrics of rounds) {
    console.log(
      `  第 ${metrics.round} 轮${metrics.round === 1 ? '（冷启动）' : '（二次）'}: TTFB ${ms(metrics.ttfb)} · 界面出字 ${ms(metrics.firstText)} · 总耗时 ${ms(metrics.total)} · 文字 ${metrics.textLength} 字`
    )
  }

  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape').catch(() => {})
  }
} catch (error) {
  bad(`测试执行异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close().catch(() => {})
}

console.log('\n================================================')
if (failures.length === 0) {
  console.log('PASS：真上游 SSE 已能被真前端解析并渲染成文字')
  process.exit(0)
}
console.error(`FAIL：${failures.length} 项断言失败`)
for (const message of failures) console.error(`  - ${message}`)
process.exit(1)
