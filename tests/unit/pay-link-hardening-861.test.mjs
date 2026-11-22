// [layer: unit | 依赖: 无（纯 Node；HTTP 与 @capacitor/browser 全是替身） | 耗时: <1s]
// Issue #861 跟进：购买链接的 **URL 协议闸与异常响应** 回归用例（补 `pay-link-861.test.mjs` 没钉的部分）。
//
// 为什么要钉：`fetchPayLink` 返回的 url 会交给原生浏览器（`Browser.open`）。服务端或中间人一旦
// 回一个 `javascript:` / `file:` / `intent:` 这类地址，打开它就不是「收款页」而是任意动作。
// 现在只靠 `isOpenableCheckout`（`/^https:\/\//i`）这一道正则，且 `openPayLinkInApp` 还有第二道闸 ——
// 两道闸各自的拒绝面都在这里单独钉住：谁被放宽，对应的用例当场红。
//
//   [A] `isOpenableCheckout`：只收 https，其它 scheme / 协议相对 / 空串一律拒绝
//   [B] `fetchPayLink`：200 + 非 https url → 不返回 url，走「暂不可用」，不触发 openPayLinkInApp
//   [C] `openPayLinkInApp` 第二道闸：直接传非 https → 不碰原生插件（没有 addListener、没有 open）
//   [D] 失败信封：ok:false / 缺 url / body 为数组 / body 非 JSON / url 不是字符串 → 失败，不返回 url
//   [E] 状态码口径：只有 503 + PAY_LINK_NOT_CONFIGURED 才算「未配置」；503 HTML 走通用失败；
//       文案不含 `PAY_LINK_` / `request_id`
//   [F] `payLinkUrl()` 在 `__ENDPOINTS__.consume` 缺失时会抛 TypeError，`BuyTab.openCheckout` 没 catch：
//       这条在发版产物里**不可达**（构建期校验 + DefinePlugin 内联），这里钉住「不可达」的前提
//
// 注意：这里的 HTTP 全是假 transport，不是对任何环境的真实请求。
// 跑法：node tests/run-layer.mjs unit --only pay-link-hardening
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'
import { createSelfCheck } from '../helpers/ours-check.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  browser: { opens: [], listeners: [], rejectOpen: false, removeCount: 0 },
}

const api = await import('../../src/services/ours/api.ts')
const transport = await import('../../src/services/ours/transport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const endpoints = await import('../../scripts/lib/consumeEndpoints.mjs')

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
  return { link, opened, calls: fake.calls, opens: cap().browser.opens.length, listeners: cap().browser.listeners.length }
}
const keyOf = (link) => (link.status === 'error' ? link.messageKey : link.status)

/** 不能被当成收款页打开的地址（任何一条被放行都是缺陷） */
const HOSTILE_URLS = [
  ['javascript:', 'javascript:alert(1)'],
  ['javascript: 大小写混写', 'JaVaScRiPt:alert(1)'],
  ['javascript: 前导空白', '  javascript:alert(1)'],
  ['file:', 'file:///etc/passwd'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['intent:', 'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end'],
  ['ftp:', 'ftp://example.com/pay'],
  ['协议相对 //host/path', '//pay.example.com/checkout'],
  ['http:（非 https）', 'http://pay.example.com/checkout'],
  ['HTTP: 大写', 'HTTP://pay.example.com/checkout'],
  ['https 只有一个斜杠', 'https:/pay.example.com/checkout'],
  ['https 之前夹了别的 scheme', 'javascript:https://pay.example.com'],
  ['无 scheme 的主机名', 'pay.example.com/checkout'],
  ['相对路径', '/shop/DIWOOHLR'],
  ['空串', ''],
  ['只有空白', '   '],
]

console.log('\n[A] isOpenableCheckout：只收 https')
{
  truthy(api.isOpenableCheckout(SHOP_URL), '对照：https 地址被接受（用例不是空转）')
  truthy(api.isOpenableCheckout(`  ${SHOP_URL}  `), '对照：https 地址前后有空白仍被接受（trim 口径不变）')
  for (const [label, url] of HOSTILE_URLS) {
    eq(api.isOpenableCheckout(url), false, `${label}：isOpenableCheckout 拒绝（${JSON.stringify(url)}）`)
  }
}

console.log('\n[B] fetchPayLink：200 + 非 https url → 不返回 url，走「暂不可用」，不打开')
{
  const control = await buyFlow(response(200, { ok: true, url: SHOP_URL }))
  eq(control.link.status, 'ok', '对照：https 地址 → ok')
  eq(control.opens, 1, '对照：https 地址 → 打开一次')
  for (const [label, url] of HOSTILE_URLS) {
    const run = await buyFlow(response(200, { ok: true, url }))
    eq(keyOf(run.link), 'oursPayUnavailable', `${label}：走「收款通道暂不可用」`)
    truthy(!JSON.stringify(run.link).includes(url.trim() === '' ? '\u0000' : url.trim()), `${label}：返回对象里不带这条地址`)
    truthy(!Object.hasOwn(run.link, 'url'), `${label}：返回对象没有 url 键`)
    eq(run.opened, null, `${label}：没有走到 openPayLinkInApp`)
    eq(run.opens, 0, `${label}：Browser.open 调了 0 次`)
    eq(run.listeners, 0, `${label}：没有挂 browserFinished 监听`)
    eq(run.calls.length, 1, `${label}：只发了一次请求（不自动重试）`)
  }
}

console.log('\n[C] openPayLinkInApp 第二道闸：直接传非 https，不碰原生插件')
{
  resetStubs()
  eq(await transport.openPayLinkInApp(SHOP_URL, () => {}), true, '对照：https 地址在原生平台上能打开')
  for (const [label, url] of HOSTILE_URLS) {
    resetStubs()
    let closed = 0
    const opened = await transport.openPayLinkInApp(url, () => {
      closed += 1
    })
    eq(opened, false, `${label}：返回 false`)
    eq(cap().browser.opens.length, 0, `${label}：Browser.open 没被调用`)
    eq(cap().browser.listeners.length, 0, `${label}：没有挂监听（插件没被碰）`)
    eq(closed, 0, `${label}：关页回调没触发`)
  }
  // 非原生平台：即便是 https 也不打开（Web 绝不 window.open 兜底）
  resetStubs()
  cap().native = false
  eq(await transport.openPayLinkInApp(SHOP_URL, () => {}), false, '非原生平台 + https：返回 false')
  eq(cap().browser.opens.length, 0, '非原生平台：Browser.open 没被调用')
  resetStubs()
}

console.log('\n[D] 失败信封：不返回 url，统一「暂不可用」')
{
  const cases = [
    ['ok:false 带合法 url', response(200, { ok: false, url: SHOP_URL })],
    ['ok 是字符串 "true"', response(200, { ok: 'true', url: SHOP_URL })],
    ['ok 是数字 1', response(200, { ok: 1, url: SHOP_URL })],
    ['缺 ok', response(200, { url: SHOP_URL })],
    ['缺 url', response(200, { ok: true })],
    ['url 是 null', response(200, { ok: true, url: null })],
    ['url 是数字', response(200, { ok: true, url: 12345 })],
    ['url 是对象', response(200, { ok: true, url: { href: SHOP_URL } })],
    ['url 是数组', response(200, { ok: true, url: [SHOP_URL] })],
    ['body 是数组（元素合法）', response(200, [{ ok: true, url: SHOP_URL }])],
    ['body 是空数组', response(200, [])],
    ['body 是 JSON 字符串', response(200, JSON.stringify(SHOP_URL))],
    ['body 是 JSON null', response(200, 'null')],
    ['body 是 JSON 数字', response(200, '42')],
    ['body 不是 JSON（文本）', response(200, 'not json')],
    ['body 不是 JSON（HTML）', response(200, '<html><body>ok</body></html>')],
    ['body 为空串', response(200, '')],
    ['body 只有空白', response(200, '   \n')],
    ['body 是被截断的 JSON', response(200, '{"ok":true,"url":"https://wzyp.cn/sh')],
  ]
  for (const [label, result] of cases) {
    const run = await buyFlow(result)
    eq(keyOf(run.link), 'oursPayUnavailable', `${label}：走「收款通道暂不可用」`)
    truthy(!Object.hasOwn(run.link, 'url'), `${label}：返回对象没有 url 键`)
    eq(run.opens, 0, `${label}：没有打开页面`)
    eq(run.listeners, 0, `${label}：没有挂监听`)
  }
}

console.log('\n[E] 状态码口径：只有 503 才算「未配置」；文案不漏内部字段')
{
  const NOT_CONFIGURED = { code: 'PAY_LINK_NOT_CONFIGURED', message: '收款页地址未配置', request_id: 'req-8f3a' }
  const positive = await buyFlow(response(503, NOT_CONFIGURED))
  eq(keyOf(positive.link), 'oursPayNotConfigured', '对照：503 + PAY_LINK_NOT_CONFIGURED → 未配置')
  eq(positive.opens, 0, '对照：未配置也不打开页面')

  const notConfiguredButWrongStatus = [
    ['500', 500],
    ['502', 502],
    ['504', 504],
    ['400', 400],
    ['404', 404],
    ['429', 429],
  ]
  for (const [label, status] of notConfiguredButWrongStatus) {
    const run = await buyFlow(response(status, NOT_CONFIGURED))
    eq(keyOf(run.link), 'oursPayUnavailable', `${label} + PAY_LINK_NOT_CONFIGURED：不算「未配置」，走通用失败`)
    eq(run.opens, 0, `${label}：没有打开页面`)
  }
  // 200 带同名业务码不是失败信封：缺 url → 通用失败，而不是「未配置」
  eq(keyOf((await buyFlow(response(200, NOT_CONFIGURED))).link), 'oursPayUnavailable', '200 + 业务码但无 ok/url：通用失败')

  const unavailableCases = [
    ['503 HTML 维护页', response(503, '<html><body>Service Unavailable</body></html>')],
    ['503 HTML 里提到 PAY_LINK_NOT_CONFIGURED', response(503, '<html>PAY_LINK_NOT_CONFIGURED</html>')],
    ['503 空 body', response(503, '')],
    ['503 JSON 数组', response(503, [NOT_CONFIGURED])],
    ['503 别的业务码', response(503, { code: 'UPSTREAM_DOWN', request_id: 'req-1' })],
    ['503 业务码大小写不同', response(503, { code: 'pay_link_not_configured' })],
    ['503 业务码在 message 里而不是 code', response(503, { message: 'PAY_LINK_NOT_CONFIGURED' })],
    ['503 code 不是字符串', response(503, { code: 503 })],
  ]
  for (const [label, result] of unavailableCases) {
    const run = await buyFlow(result)
    eq(keyOf(run.link), 'oursPayUnavailable', `${label}：通用失败（不是「未配置」）`)
    eq(run.opens, 0, `${label}：没有打开页面`)
  }

  // 文案：所有失败分支的可见文案都不含内部字段名
  const everyFailure = [
    response(503, NOT_CONFIGURED),
    response(500, NOT_CONFIGURED),
    response(503, '<html>PAY_LINK_NOT_CONFIGURED request_id=req-8f3a</html>'),
    response(200, { ok: true, url: 'javascript:alert(1)', request_id: 'req-8f3a' }),
    response(200, { ok: false, code: 'PAY_LINK_NOT_CONFIGURED', request_id: 'req-8f3a' }),
    { kind: 'network' },
    { kind: 'timeout' },
  ]
  for (const result of everyFailure) {
    const { link } = await buyFlow(result)
    const label = `${result.kind === 'response' ? `HTTP ${result.status}` : result.kind} → ${keyOf(link)}`
    eq(link.status, 'error', `${label}：是失败`)
    if (link.status !== 'error') {
      continue
    }
    const visible = [zh[link.messageKey], en[link.messageKey]]
    truthy(visible.every((text) => typeof text === 'string' && text !== ''), `${label}：zh / en 都有可读文案`)
    truthy(
      visible.every((text) => !/PAY_LINK_|request_id|req-8f3a|NOT_CONFIGURED/iu.test(text)),
      `${label}：文案不含 PAY_LINK_ / request_id`
    )
    truthy(!/PAY_LINK_|request_id|req-8f3a/u.test(JSON.stringify(link)), `${label}：返回对象本身也不带服务端的内部字段`)
  }
  truthy(zh.oursPayNotConfigured !== zh.oursPayUnavailable, 'zh：「未配置」与「通道不可用」是两句不同的话')
}

console.log('\n[F] openCheckout 的 TypeError 风险：发版产物里不可达（钉住不可达的前提）')
{
  // 风险本身：`payLinkUrl()` 读 `__ENDPOINTS__.consume.baseUrl`，`consume` 缺失时同步抛 TypeError，
  // 而 `BuyTab.openCheckout` 没有 try/catch，按钮会停在忙碌态。
  // 不可达的依据（三条，缺一条都要重新评估）：
  //   1. 值来自 `rspack.config.ts` 的 DefinePlugin，而它读的是 `loadConsumePay()` 的结果；
  //   2. `loadConsumePay()` 对「consume 缺失 / baseUrl 不是字符串」直接 throw，构建失败、不出产物；
  //   3. 所以产物里的 `__ENDPOINTS__.consume.baseUrl` 一定是通过校验的字符串。
  const real = JSON.parse(readFileSync(path.join(ROOT, 'config/endpoints.json'), 'utf8'))
  const withoutConsume = { ...real }
  delete withoutConsume.consume
  truthy(
    endpoints.validateConsumePay(withoutConsume, '').some((problem) => problem.includes('consume 缺失')),
    'validateConsumePay：consume 整段缺失 → 报「consume 缺失」',
  )
  for (const [label, baseUrl] of [['缺失', undefined], ['null', null], ['数字', 42], ['空串', ''], ['空白', '   ']]) {
    const consume = { ...real.consume }
    if (baseUrl === undefined) {
      delete consume.baseUrl
    } else {
      consume.baseUrl = baseUrl
    }
    truthy(
      endpoints.validateConsumePay({ ...real, consume }, '').length > 0,
      `validateConsumePay：consume.baseUrl ${label} → 有问题清单（构建不会放行）`,
    )
  }
  truthy(endpoints.validateConsumePay(real, '').length === 0, '对照：仓库里真实的 config/endpoints.json 通过校验')

  const dir = mkdtempSync(path.join(tmpdir(), 'pay-link-hardening-'))
  try {
    const file = path.join(dir, 'endpoints.json')
    writeFileSync(file, JSON.stringify(withoutConsume))
    let thrown = ''
    try {
      endpoints.loadConsumePay(file)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    truthy(thrown.includes('consume'), 'loadConsumePay：consume 缺失的配置直接 throw（构建期失败）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 接线：DefinePlugin 的 consume.baseUrl 确实来自 loadConsumePay 的结果，而不是别处
  const rspack = readFileSync(path.join(ROOT, 'rspack.config.ts'), 'utf8')
  truthy(/loadConsumePay\(ENDPOINTS_FILE\)/u.test(rspack), 'rspack.config.ts：用 loadConsumePay(ENDPOINTS_FILE) 读配置')
  truthy(
    /baseUrl:\s*effectiveConsumePay\.config\.consume\.baseUrl/u.test(rspack),
    'rspack.config.ts：__ENDPOINTS__.consume.baseUrl 取自校验后的 effectiveConsumePay',
  )
  // 运行时只有这一处读 consume.baseUrl 来拼收款页地址（再有第二处就要重新评估）
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  const apiSource = stripComments(readFileSync(path.join(ROOT, 'src/services/ours/api.ts'), 'utf8'))
  const readers = apiSource.match(/__ENDPOINTS__\.consume\.baseUrl/gu) ?? []
  eq(readers.length, 1, 'ours/api.ts 里只有 payLinkUrl() 一处读 __ENDPOINTS__.consume.baseUrl')
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
