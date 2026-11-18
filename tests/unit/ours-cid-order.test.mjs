// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Issue #135（新人特惠 ¥1 单不带 cid：60/63 单查不到、可无限次 ¥1）的单测。
// 线上数据：63 单里 60 单 cid 为空，随后端「一个客户只能买一次」，空 cid 等于不限次数。
//
//   node tests/unit/ours-cid-order.test.mjs
//
// 覆盖：
//   [1] 空 / NaN / 0 / 负数 cid 一律按「没有 cid」处理，绝不拼出 `&cid=`（需求 4）
//   [2] 真实调用序列（真 fetch 打本地假 /me + 假 /buy）：网页版「去支付」的最终地址必须带 cid；
//       连点两次也要带同一个 cid；拿不到 cid 时一次都不许跳，并提示先领 Key
//   [3] 时序：解析失败一次不许把整个会话钉死（下一次点「去支付」要重新解析）
//   [4] 换 Key 不串单：换号后旧 cid 必须丢掉（否则新单挂在上一个客户名下，/api/orders 还是查不到）
//   [5] 回归：正常路径（有 cid）依然带 cid，文案 zh/en 成对
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'

const api = await import('../../src/services/ours/api.ts')
const cidModule = await import('../../src/services/ours/customerId.ts')
const transport = await import('../../src/services/ours/transport.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  checks.n += 1
  failures.push(message)
  console.log(`  FAIL ${message}`)
}
const eq = (actual, expected, message) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${message} = ${a}`)
  } else {
    bad(`${message}: 期望 ${b}，实际 ${a}`)
  }
}
const truthy = (value, message) => (value ? ok(message) : bad(message))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const BASE = 'https://apia.ecsafe.cn'
const NEWBIE = `${BASE}/buy?plan=newbie`

const fakeStorage = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  }
}

const makeTransport = (script) => {
  const calls = []
  const fn = async (request) => {
    calls.push(request)
    const next = script[calls.length - 1]
    return next ?? { kind: 'network' }
  }
  return { calls, transport: fn }
}

// 真 fetch（不带任何桩）：用来证明「真的发出去了什么」
const realFetchTransport = async (request) => {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
    })
    return { kind: 'response', status: response.status, text: await response.text() }
  } catch {
    return { kind: 'network' }
  }
}

console.log('')
console.log('[1] 空 / 非法 cid 不许进 URL（需求 4：禁止拼出 &cid=）')
{
  eq(api.buyUrl('newbie', ''), NEWBIE, '1.1 空串 cid 不拼（不能出现 &cid=）')
  eq(api.buyUrl('newbie', NaN), NEWBIE, '1.2 NaN cid 不拼（不能出现 &cid=NaN）')
  eq(api.buyUrl('newbie', 0), NEWBIE, '1.3 0 不能当成客户编号')
  eq(api.buyUrl('newbie', -3), NEWBIE, '1.4 负数不能当成客户编号')
  eq(api.buyUrl('newbie', Number.NaN, null), NEWBIE, '1.5 显式传入的非法值同样不拼')

  eq(
    transport.withBuyCustomerId(`${BASE}/buy?plan=newbie&cid=NaN`, 7),
    `${BASE}/buy?plan=newbie&cid=7`,
    '1.6 地址里已有的 cid=NaN 要被补正成真的 cid'
  )
  eq(
    transport.withBuyCustomerId(`${BASE}/buy?plan=newbie&cid=0`, 7),
    `${BASE}/buy?plan=newbie&cid=7`,
    '1.7 地址里已有的 cid=0 要被补正'
  )
  eq(
    transport.withBuyCustomerId(`${BASE}/buy?plan=newbie&cid=NaN`, null),
    null,
    '1.8 已有的 cid 非法、又拿不到真 cid 时：不跳（不能把 NaN 发给后端）'
  )

  // 原生路径：调用方传了非法 cid 也要当场拦住，一次请求都不发
  const blank = makeTransport([{ kind: 'response', status: 302, text: '', location: '' }])
  const blankResult = await api.startCheckout('newbie', blank.transport, {
    customerId: '',
    storage: fakeStorage(),
  })
  eq(
    blankResult.kind === 'error' ? blankResult.code : blankResult.kind,
    'CUSTOMER_ID_MISSING',
    '1.9 startCheckout 收到空串 cid 时报 CUSTOMER_ID_MISSING'
  )
  eq(blank.calls.length, 0, '1.10 空串 cid 时一个 /buy 请求都不发')
}

console.log('')
console.log('[2] 真实调用序列：去支付的最终地址必须带 cid（本地假 /me + 假 /buy，真 fetch）')
{
  const hits = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if ((request.url ?? '').startsWith('/me')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"customer_id":7}')
      return
    }
    response.writeHead(302, { location: 'https://pay.example.invalid/submit?no=CP1&order_token=T1' })
    response.end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  globalThis.localStorage = fakeStorage()
  const nav = []
  globalThis.window = { location: { assign: (url) => nav.push(url) } }
  const notices = []
  transport.setCustomerMissingNotice((message) => notices.push(message))
  cidModule.setCustomerIdProvider(() =>
    cidModule.fetchCustomerIdFromProfile({ base, deviceId: 'dev-abc123', transport: realFetchTransport })
  )
  cidModule.resetCustomerIdCache()

  // 新人首购：没有 Key、本地没有 cid → 先 /me 拿 cid，再跳 /buy
  transport.navigateTopLevel(api.buyUrl('newbie'))
  await sleep(300)
  eq(nav.length, 1, '2.1 跳了一次')
  truthy(
    (nav[0] ?? '').includes('cid=7'),
    `2.2 最终地址带 cid=7：${nav[0] ?? '(没跳)'}`
  )
  truthy(
    hits.some((url) => url.startsWith('/me?device_id=dev-abc123')),
    `2.3 先问了 /me（服务端真实收到）：${hits.join(' , ')}`
  )

  // 重复购买：第二个 ¥1 单同样要带 cid（后端 409 NEWBIE_USED 靠它认人；真机未验）
  transport.navigateTopLevel(api.buyUrl('newbie'))
  await sleep(300)
  eq(nav.length, 2, '2.4 第二次点「去支付」也跳了')
  truthy(
    (nav[1] ?? '').includes('cid=7'),
    `2.5 第二次地址同样带 cid=7：${nav[1] ?? '(没跳)'}`
  )

  // 拿不到 cid（无 Key、设备未绑定）：一次都不许跳，并提示先领 Key
  nav.length = 0
  notices.length = 0
  globalThis.localStorage = fakeStorage()
  cidModule.resetCustomerIdCache()
  cidModule.setCustomerIdProvider(() =>
    cidModule.fetchCustomerIdFromProfile({ base, deviceId: 'dev-unbound', transport: realFetchTransport })
  )
  const failHits = createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"detail":"no customer"}')
  })
  await new Promise((resolve) => failHits.listen(0, '127.0.0.1', resolve))
  cidModule.setCustomerIdProvider(() =>
    cidModule.fetchCustomerIdFromProfile({
      base: `http://127.0.0.1:${failHits.address().port}`,
      deviceId: 'dev-unbound',
      transport: realFetchTransport,
    })
  )
  transport.navigateTopLevel(api.buyUrl('newbie'))
  await sleep(300)
  eq(nav.length, 0, '2.6 拿不到 cid：一次都不跳（绝不发不带 cid 的 /buy）')
  eq(notices.length, 1, '2.7 给了用户一句提示')
  eq(notices[0]?.key ?? '', 'oursErrCustomerNeedsKey', '2.8 提示文案是「请先在 App 内领取 Key」')
  await new Promise((resolve) => failHits.close(resolve))
  await new Promise((resolve) => server.close(resolve))
  transport.setCustomerMissingNotice(null)
}

console.log('')
console.log('[3] 时序：一次解析失败不许把整个会话钉死')
{
  globalThis.localStorage = fakeStorage()
  let rounds = 0
  cidModule.setCustomerIdProvider(async () => {
    rounds += 1
    return rounds === 1 ? null : 11
  })
  cidModule.resetCustomerIdCache()
  const first = await cidModule.ensureCustomerId()
  eq(first, null, '3.1 第一次拿不到（启动时还没网 / 还没绑设备）')
  const second = await cidModule.ensureCustomerId()
  eq(second, 11, '3.2 第二次点「去支付」要重新解析，能拿到 cid')
  eq(rounds, 2, '3.3 provider 真的被问了第二次')

  // 失败一次之后的真实下单：必须带 cid，而不是继续报 CUSTOMER_ID_MISSING
  const order = makeTransport([
    { kind: 'response', status: 302, text: '', location: 'https://pay.example.invalid/submit?no=CP9&order_token=T9' },
  ])
  cidModule.resetCustomerIdCache()
  rounds = 1 // provider 下一次就返回 11（模拟「用户领了 Key / 网络恢复了」）
  const checkout = await api.startCheckout('newbie', order.transport, { storage: fakeStorage() })
  eq(checkout.kind, 'ok', '3.4 解析过一次失败后，再下单能成功')
  truthy(
    (order.calls[0]?.url ?? '').includes('cid=11'),
    `3.5 这一单带 cid=11：${order.calls[0]?.url ?? '(没请求)'}`
  )
}

console.log('')
console.log('[4] 换 Key 不串单：旧 cid 必须丢掉')
{
  globalThis.localStorage = fakeStorage()
  cidModule.resetCustomerIdCache()
  apiConfig.setApiKey('sk-live-account-a')
  cidModule.cacheCustomerId(7)
  eq(cidModule.readCachedCustomerId(), 7, '4.1 A 账号：缓存 cid=7')

  apiConfig.setApiKey('sk-live-account-b')
  eq(cidModule.readCachedCustomerId(), null, '4.2 换成 B 账号后，A 的 cid 必须消失')

  cidModule.cacheCustomerId(11)
  apiConfig.setApiKey('sk-live-account-b')
  eq(cidModule.readCachedCustomerId(), 11, '4.3 同一把 Key 再保存一次不清缓存')

  apiConfig.setApiKey('')
  eq(cidModule.readCachedCustomerId(), null, '4.4 清除 Key 也要清 cid')
}

console.log('')
console.log('[5] 回归：有 cid 时照旧，文案 zh/en 成对')
{
  globalThis.localStorage = fakeStorage()
  cidModule.resetCustomerIdCache()
  eq(api.buyUrl('newbie', 7), `${NEWBIE}&cid=7`, '5.1 数字 cid 照旧拼进地址')
  eq(api.buyUrl('newbie', '7'), `${NEWBIE}&cid=7`, '5.2 数字串 cid 归一化后拼进地址')
  cidModule.cacheCustomerId(7)
  eq(api.buyUrl('newbie', undefined), `${NEWBIE}&cid=7`, '5.3 缓存里的 cid 自动补上')

  const order = makeTransport([
    { kind: 'response', status: 302, text: '', location: 'https://pay.example.invalid/submit?no=CP1&order_token=T1' },
  ])
  const result = await api.startCheckout('newbie', order.transport, { customerId: 7, storage: fakeStorage() })
  eq(result.kind, 'ok', '5.4 startCheckout 正常返回')
  truthy(
    (order.calls[0]?.url ?? '').includes('cid=7'),
    `5.5 原生路径的 /buy 带 cid=7：${order.calls[0]?.url ?? ''}`
  )

  truthy(
    typeof zh.oursErrCustomerNeedsKey === 'string' && zh.oursErrCustomerNeedsKey.includes('请先在 App 内领取 Key'),
    '5.6 zh 有「请先在 App 内领取 Key」'
  )
  truthy(
    typeof en.oursErrCustomerNeedsKey === 'string' && /Key/i.test(en.oursErrCustomerNeedsKey),
    '5.7 en 文案成对'
  )
}

console.log('')
if (failures.length === 0) {
  console.log(`ours-cid-order: 全部通过（${checks.n} 项）`)
  process.exit(0)
}
console.log(`ours-cid-order: ${failures.length}/${checks.n} 项失败`)
for (const item of failures) {
  console.log(`  - ${item}`)
}
process.exit(1)
