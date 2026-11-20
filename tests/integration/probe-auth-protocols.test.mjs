// [layer: integration | 依赖: playwright + chromium + 5181 标准构建（APP_URL 可覆盖）| 耗时: ~30s]
// Issue #56 的 focused 用例：只盯「点「测试」后那条探测请求带什么鉴权头」。
//
// 覆盖：
//   1) openai 协议（spec.auth = 'bearer'）→ Authorization: Bearer <key>，且不带 x-api-key / anthropic-version
//   2) anthropic 协议（spec.auth = 'x-api-key'）→ x-api-key: <key>，且不带 Authorization
//   3) 错误 key（上游 401）→ 明确 401 文案，**不能**和网络错误混为一谈
//   4) 服务未启动（端口关闭）→ 网络错误文案，且不出现 HTTP 状态码
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/integration/probe-auth-protocols.test.mjs
// 为什么单独一个文件：full-acceptance 里那条断言曾经把「切渠道之前 anthropic 渠道自己的探测」
// 也算成 openai 的探测（窗口开早了），所以在小文件里逐协议重证一次。
import http from 'node:http'
import { APP_URL, capturePaths, clickTest, finish, openApp, openSettingsDataSection } from '../helpers/helpers.mjs'

const NAME = 'tests/integration/probe-auth-protocols.test.mjs'
const KEY = 'sk-probe-auth-0123456789'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers':
    'content-type,authorization,x-api-key,anthropic-version,anthropic-beta,accept,accept-encoding,x-session-id',
}

/** 极简 mock 上游：/v1/models 按 status 返回（401 时给一段明确的错误文案） */
const startMock = (status) =>
  new Promise((resolve) => {
    const log = []
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://mock')
      log.push({ method: req.method, path: pathname, headers: req.headers })
      for (const [name, value] of Object.entries(CORS)) {
        res.setHeader(name, value)
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (pathname.endsWith('/models')) {
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ data: [{ id: 'probe-model' }] }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: `mock 没有实现 ${pathname}` } }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` }))
  })

/** 一个绑定过一次又被关掉的端口：连上去必然是网络错误，不会打到别人的服务 */
const deadBase = async () => {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}

const mockOk = await startMock(200)
const mock401 = await startMock(401)
const deadPort = await deadBase()

const { browser, page } = await openApp()
const requests = capturePaths(page)

/** 写配置 → 重载，让页面按目标渠道起来（key 已存，设置弹窗不会自动弹出） */
const seed = async ({ kind, baseUrl, model }) => {
  await page.evaluate(
    ({ kind, baseUrl, model, key }) => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:provider-kind', kind)
      window.localStorage.setItem(`chat-demo:base-url:${kind}`, baseUrl)
      window.localStorage.setItem(`chat-demo:model:${kind}`, model)
      window.localStorage.setItem('chat-demo:api-key', key)
    },
    { kind, baseUrl, model, key: KEY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
}

/**
 * 打开设置 → 记录窗口起点 → 点「测试」→ 等探测结论出现。
 * 打开设置时模型下拉会自己刷新一次列表（同一个 probeProvider），所以先用 600ms 等它落地，
 * 再把窗口起点定在「点测试」之前，避免把上一次探测算进本条用例。
 */
const runTest = async () => {
  await openSettingsDataSection(page)
  await page.waitForTimeout(600)
  const start = requests.length
  await clickTest(page)
  const described = page.getByText(
    /连接成功|请求失败|无法连接|连接超时|返回的不是 JSON|请求返回的是网页/
  )
  await described.first().waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(300)
  const dialog = page.getByRole('dialog').first()
  const text = (await dialog.count()) > 0 ? await dialog.innerText() : await page.locator('body').innerText()
  const probes = requests
    .slice(start)
    .filter((entry) => entry.method === 'GET' && entry.path.endsWith('/models'))
  return { probes, text }
}

try {
  // ---------- 1. openai 协议：Authorization: Bearer ----------
  console.log('\n[1] openai 协议探测鉴权头')
  await seed({ kind: 'openai', baseUrl: mockOk.base, model: 'gpt-4o-mini' })
  const openai = await runTest()
  const openaiProbe = openai.probes.at(-1)
  if (!openaiProbe) {
    bad('1) 点「测试」没有打出 GET /v1/models')
  } else if (openaiProbe.headers.authorization !== `Bearer ${KEY}`) {
    bad(`1) openai 探测 Authorization 不对：${openaiProbe.headers.authorization}`)
  } else if (openaiProbe.headers['x-api-key'] || openaiProbe.headers['anthropic-version']) {
    bad(
      `1) openai 探测多带了 anthropic 头：x-api-key=${openaiProbe.headers['x-api-key']} anthropic-version=${openaiProbe.headers['anthropic-version']}`
    )
  } else {
    ok(`1) openai 探测 ${openaiProbe.path} 带 Authorization: Bearer <key>，无 x-api-key / anthropic-version`)
  }
  if (!/连接成功/.test(openai.text)) {
    bad(`1) 探测成功但界面没给成功结论：${openai.text.split('\n').slice(-3).join(' / ')}`)
  }

  // ---------- 2. anthropic 协议：x-api-key ----------
  console.log('\n[2] anthropic 协议探测鉴权头')
  await seed({ kind: 'anthropic', baseUrl: mockOk.base, model: 'deepseek-v4.1-flash' })
  const anthropic = await runTest()
  const anthropicProbe = anthropic.probes.at(-1)
  if (!anthropicProbe) {
    bad('2) 点「测试」没有打出 GET /v1/models')
  } else if (anthropicProbe.headers['x-api-key'] !== KEY) {
    bad(`2) anthropic 探测 x-api-key 不对：${anthropicProbe.headers['x-api-key']}`)
  } else if (anthropicProbe.headers.authorization) {
    bad(`2) anthropic 探测不该带 Authorization：${anthropicProbe.headers.authorization}`)
  } else if (anthropicProbe.headers['anthropic-version']) {
    // 自填中转故意不带 anthropic-version（带上会让预检失败，60010 实测）
    bad(`2) anthropic 自填地址不该带 anthropic-version：${anthropicProbe.headers['anthropic-version']}`)
  } else {
    ok(`2) anthropic 探测 ${anthropicProbe.path} 带 x-api-key，无 Authorization / anthropic-version`)
  }
  if (!/连接成功/.test(anthropic.text)) {
    bad(`2) 探测成功但界面没给成功结论：${anthropic.text.split('\n').slice(-3).join(' / ')}`)
  }

  // ---------- 3. 错误 key：401 必须和网络错误区分 ----------
  console.log('\n[3] 错误 key → 401')
  await seed({ kind: 'openai', baseUrl: mock401.base, model: 'gpt-4o-mini' })
  const unauthorized = await runTest()
  const unauthorizedProbe = unauthorized.probes.at(-1)
  if (!unauthorizedProbe) {
    bad('3) 点「测试」没有打出 GET /v1/models')
  } else if (unauthorizedProbe.headers.authorization !== `Bearer ${KEY}`) {
    // 关键点：401 必须是「带了正确格式的 key 被上游拒」，不是「没带 key」
    bad(`3) 401 场景下探测头也不对：${unauthorizedProbe.headers.authorization}`)
  } else {
    ok('3) 401 场景下探测仍带 Authorization: Bearer <key>（401 来自上游拒 key，不是缺头）')
  }
  if (!/HTTP 401/.test(unauthorized.text)) {
    bad(`3) 界面没有给出 401：${unauthorized.text.split('\n').slice(-3).join(' / ')}`)
  } else if (!/Invalid API Key/.test(unauthorized.text)) {
    bad('3) 界面没有带上游错误正文（Invalid API Key）')
  } else if (/无法连接|连接超时/.test(unauthorized.text)) {
    bad('3) 401 被写成了网络错误')
  } else {
    ok('3) 界面区分了 401（请求失败（HTTP 401）：Invalid API Key）')
  }

  // ---------- 4. 服务未启动：网络错误 ----------
  console.log('\n[4] 端口关闭 → 网络错误')
  await seed({ kind: 'openai', baseUrl: deadPort, model: 'gpt-4o-mini' })
  const offline = await runTest()
  if (!/无法连接|连接超时/.test(offline.text)) {
    bad(`4) 网络错误没有明确提示：${offline.text.split('\n').slice(-3).join(' / ')}`)
  } else if (/HTTP 401/.test(offline.text)) {
    bad('4) 网络错误被写成了 HTTP 401')
  } else {
    ok('4) 界面区分了网络错误（无 HTTP 状态码）')
  }
} finally {
  await new Promise((resolve) => mockOk.server.close(resolve))
  await new Promise((resolve) => mock401.server.close(resolve))
  await finish(browser, NAME, failures)
}
