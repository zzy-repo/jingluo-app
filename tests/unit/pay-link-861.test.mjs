// [layer: unit | 依赖: 无（纯 Node；HTTP 与 @capacitor/browser 全是替身） | 耗时: <1s]
// Issue #861（购买入口改走新网关 /api/v1/pay-link，503 给友好提示）的 **mock 测试**。
//
// 注意：这里的 HTTP 全是假 transport，**不是**对测试 / 生产环境的真实请求；
// 真实只读验证（curl 测试环境）与模拟器截图在 PR 正文里单独给，不由本文件冒充。
//
// 目标：
//   [A] 请求路径与基地址：`${__ENDPOINTS__.consume.baseUrl}/api/v1/pay-link`，基地址换了请求跟着换，不是 pay.baseUrl
//   [B] 200 取 url → 在 App 内打开
//   [C] 503 PAY_LINK_NOT_CONFIGURED → 友好提示（oursPayNotConfigured），不打开
//   [D] 502 / 其它 5xx / 网络 / 超时 / 缺 url / 非 https url → 各有可见提示，不打开、不当成功
//   [E] 文案：zh / en 成对，且「未配置」与「通道不可用」两句不同
//   [F] 静态断言：src 里不再出现 /api/plans、/api/buy；BuyTab 把失败文案渲染出来（不静默吞掉）
//
// 跑法：node tests/run-layer.mjs unit --only 861
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'
import { createSelfCheck } from '../helpers/ours-check.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

installTsResolve({
  stubs: {
    '@capacitor/core': fixtureUrl('domain03-04/checkout-plugins.mjs'),
    '@capacitor/browser': fixtureUrl('domain03-04/checkout-browser.mjs'),
  },
})

globalThis.__cap = {
  native: true,
  browser: {
    opens: [],
    listeners: [],
    rejectOpen: false,
    removeCount: 0,
    finish() {
      for (const item of [...this.listeners]) {
        item.handler()
      }
    },
  },
}

const api = await import('../../src/services/ours/api.ts')
const transport = await import('../../src/services/ours/transport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const { failures, checks, eq, truthy } = createSelfCheck({ countBad: true })

const cap = () => globalThis.__cap
const resetStubs = () => {
  cap().native = true
  cap().browser.opens.length = 0
  cap().browser.listeners.length = 0
  cap().browser.rejectOpen = false
  cap().browser.removeCount = 0
}
const SHOP_URL = 'https://wzyp.cn/shop/DIWOOHLR'
const response = (status, body) => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})
const fakeTransport = (result) => {
  const calls = []
  return {
    calls,
    transport: async (request) => {
      calls.push(request)
      return result
    },
  }
}
/** 与 BuyTab.openCheckout 同一条编排：取地址 → 成功才打开；失败只给文案 */
const buyFlow = async (result) => {
  resetStubs()
  const fake = fakeTransport(result)
  const link = await api.fetchPayLink(fake.transport)
  let opened = null
  if (link.status === 'ok') {
    opened = await transport.openPayLinkInApp(link.url, () => {})
  }
  return { link, opened, calls: fake.calls, opens: cap().browser.opens.length }
}

console.log('\n[A] mock 测试：请求路径与基地址取自 consume 配置')
{
  const original = globalThis.__ENDPOINTS__
  truthy(typeof original.consume?.baseUrl === 'string' && original.consume.baseUrl !== '', '测试注入里有 consume.baseUrl')
  eq(api.payLinkUrl(), `${original.consume.baseUrl}/api/v1/pay-link`, '默认：consume.baseUrl + /api/v1/pay-link')
  // #869 之后 consume 与 pay 是同一个统一 BASE，字符串前缀已无法区分「来自哪个字段」。
  // 所以改成注入一个**不同的** pay.baseUrl（旧 cardpay 域），证明链接只跟 consume 走、完全不读 pay.baseUrl。
  {
    const legacyPay = 'https://legacy-cardpay.example.test'
    globalThis.__ENDPOINTS__ = { ...original, pay: { ...original.pay, baseUrl: legacyPay } }
    truthy(!api.payLinkUrl().startsWith(`${legacyPay}/`), '不再拼 pay.baseUrl（旧 cardpay 域，502）')
    eq(api.payLinkUrl(), `${original.consume.baseUrl}/api/v1/pay-link`, 'pay.baseUrl 变了，链接不变：只取 consume')
    globalThis.__ENDPOINTS__ = original
  }

  globalThis.__ENDPOINTS__ = {
    ...original,
    consume: { ...original.consume, baseUrl: 'https://gateway.example.test/some-env/' },
  }
  try {
    eq(api.payLinkUrl(), 'https://gateway.example.test/some-env/api/v1/pay-link', '换 consume.baseUrl，请求地址跟着换（尾斜杠已处理）')
    const fake = fakeTransport(response(200, { ok: true, url: SHOP_URL }))
    await api.fetchPayLink(fake.transport)
    eq(fake.calls[0]?.url, 'https://gateway.example.test/some-env/api/v1/pay-link', 'fetchPayLink 实际发出的 URL 取自配置')
    eq(fake.calls[0]?.method, 'GET', '只读 GET')
    eq(fake.calls[0]?.followRedirects, false, '不跟随重定向')
    const headerNames = Object.keys(fake.calls[0]?.headers ?? {}).map((name) => name.toLowerCase())
    truthy(!headerNames.includes('authorization'), '无需登录：不带 Authorization')
  } finally {
    globalThis.__ENDPOINTS__ = original
  }
}

console.log('\n[B] mock 测试：200 取 url 并在 App 内打开')
{
  const run = await buyFlow(response(200, { ok: true, url: SHOP_URL, note: '外部收款页' }))
  eq(run.link.status, 'ok', '200 → ok')
  eq(run.link.status === 'ok' ? run.link.url : '', SHOP_URL, '读 url（形状与旧 cardpay 一致）')
  eq(run.opened, true, 'openPayLinkInApp 返回 true')
  eq(run.opens, 1, 'Browser.open 调了一次')
  eq(cap().browser.opens[0]?.url, SHOP_URL, '打开的是接口给的地址')
  eq(cap().browser.opens[0]?.presentationStyle, 'popover', 'App 内 popover，不整页跳走')
}

console.log('\n[C] mock 测试：503 PAY_LINK_NOT_CONFIGURED → 友好提示，不打开')
{
  const run = await buyFlow(
    response(503, { code: 'PAY_LINK_NOT_CONFIGURED', message: '收款页地址未配置', request_id: 'r-1' })
  )
  eq(run.link.status, 'error', '503 不是成功')
  eq(run.link.status === 'error' ? run.link.messageKey : '', 'oursPayNotConfigured', '给「未配置」专属提示')
  eq(run.opens, 0, '没有打开任何页面')
  eq(run.opened, null, '没走到打开这一步')
  // 业务码对但状态码不是 503 → 仍按通道不可用（不把别的失败误报成「未配置」）
  const wrongStatus = await buyFlow(response(500, { code: 'PAY_LINK_NOT_CONFIGURED' }))
  eq(wrongStatus.link.status === 'error' ? wrongStatus.link.messageKey : '', 'oursPayUnavailable', '500 + 同名业务码 → 通道不可用')
}

console.log('\n[D] mock 测试：502 / 5xx / 网络 / 超时 / 缺 url / 非 https → 可见提示，不打开')
{
  const cases = [
    ['502 Bad Gateway', response(502, '<html>502 Bad Gateway</html>'), 'oursPayUnavailable'],
    ['500', response(500, { message: 'boom' }), 'oursPayUnavailable'],
    ['503 无业务码', response(503, '<html>maintenance</html>'), 'oursPayUnavailable'],
    ['404（路径不存在）', response(404, { code: 'NOT_FOUND' }), 'oursPayUnavailable'],
    ['200 + 缺 url', response(200, { ok: true }), 'oursPayUnavailable'],
    ['200 + ok:false', response(200, { ok: false, url: SHOP_URL }), 'oursPayUnavailable'],
    ['200 + 非法 JSON', response(200, 'not json'), 'oursPayUnavailable'],
    ['200 + 明文 http url', response(200, { ok: true, url: 'http://wzyp.cn/x' }), 'oursPayUnavailable'],
    ['网络错误', { kind: 'network' }, 'oursErrNetwork'],
    ['超时', { kind: 'timeout' }, 'oursErrTimeout'],
  ]
  for (const [label, result, key] of cases) {
    const run = await buyFlow(result)
    eq(run.link.status === 'error' ? run.link.messageKey : run.link.status, key, `${label} → ${key}`)
    eq(run.opens, 0, `${label}：没有打开页面`)
    truthy(run.link.status !== 'ok', `${label}：不当成功`)
    truthy(typeof zh[key] === 'string' && zh[key] !== '', `${label}：zh 有可读文案`)
  }
}

console.log('\n[E] i18n：zh / en 成对，未配置与不可用两句不同')
{
  truthy(typeof zh.oursPayNotConfigured === 'string' && zh.oursPayNotConfigured !== '', 'zh.oursPayNotConfigured')
  truthy(typeof en.oursPayNotConfigured === 'string' && en.oursPayNotConfigured !== '', 'en.oursPayNotConfigured')
  truthy(zh.oursPayNotConfigured !== zh.oursPayUnavailable, 'zh 两句不同')
  truthy(en.oursPayNotConfigured !== en.oursPayUnavailable, 'en 两句不同')
}

console.log('\n[F] 静态断言：不再有 /api/plans、/api/buy 调用；失败提示会上屏')
{
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : /\.(ts|tsx|js|mjs)$/u.test(entry.name) ? [full] : []
    })
  // 只看代码：去掉块注释与整行 // 注释（注释里允许写「#861 起不再请求 /api/plans」这类说明）
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  const codeOf = (file) => stripComments(readFileSync(file, 'utf8'))
  const files = walk(path.join(ROOT, 'src'))
  for (const needle of ['/api/plans', '/api/buy']) {
    const hits = files.filter((file) => codeOf(file).includes(needle)).map((file) => path.relative(ROOT, file))
    eq(hits, [], `src 代码（不含注释）里没有任何文件含 ${needle}`)
  }
  const apiSource = codeOf(path.join(ROOT, 'src/services/ours/api.ts'))
  truthy(!/\/api\/pay-link/u.test(apiSource.replace(/\/api\/v1\/pay-link/gu, '')), 'api.ts 里没有旧的 /api/pay-link（无 v1）路径')
  truthy(!/apia\.ecsafe\.cn/u.test(apiSource), 'api.ts 没有写死域名')
  truthy(!/\/staging/u.test(apiSource), 'api.ts 没有写死 /staging')
  const buyTab = readFileSync(path.join(ROOT, 'src/components/consume/BuyTab.tsx'), 'utf8')
  truthy(/setPay\(\{ status: 'error', messageKey: link\.messageKey \}\)/u.test(buyTab), 'BuyTab：失败把 messageKey 写进状态')
  truthy(/t\(pay\.messageKey\)/u.test(buyTab) && buyTab.includes('role="alert"'), 'BuyTab：状态以 role=alert 渲染 t(messageKey)，不静默')
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（共 ${checks.n} 项检查）`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.n} 项检查）`)
