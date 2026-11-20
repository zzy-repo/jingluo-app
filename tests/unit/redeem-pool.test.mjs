// [layer: unit | 依赖: 无（纯 Node，零浏览器；一个 127.0.0.1 本地 stub 服务器） | 耗时: <2s]
// Issue #72：兑换迁到 62.106 本机池 / device 自愈 / 202 处理中 / 设备码可备份 / 不暴露图片入口。
//
// 运行：node tests/unit/redeem-pool.test.mjs
//
// 覆盖（逐条对应 issue 的 5 条关闭条件）：
//   [1] 兑换改地址：POST http://140.210.13.146:60013/redeem-card，body 只有 {card_no, api_key}
//   [2] 200 {ok,points,quota_points,remaining_points,duplicate}：duplicate:true 按成功处理
//   [3] 404 card_not_found / 409 card_used / 400 api_key_invalid：四条中文文案各就各位
//   [4] 保留旧 /api/redeem 兜底；409 CARD_LEASED 的文案必须与 card_used 区分开
//   [5] 202 CREDIT_PENDING / VERIFY_PENDING 一律 pending：不出现错误态、不提示换卡
//   [6] device_not_found 自愈：/apply → 存 key → 重试一次（只一次，防死循环）
//   [7] invalid_device 重新生成 device_id 再试；429 / 409 不重试且文案正确
//   [8] 设备码备份提示只提示一次（持久化标记）
//   [9] 价格取 /api/plans，不硬编码；客户端不暴露图片 / 文件输入入口
//  [10] 协议层：本地 stub 服务器收请求，验证真实发出的 method / path / content-type / body
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { FETCH_REFUSED_PORTS, listenFetchablePort, listenFreePort } from '../helpers/ports.mjs'

// 端点地址唯一来源：config/endpoints.json（#274）
import { inviteBaseUrl } from '../../scripts/lib/endpoints.mjs'

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

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const invite = await import('../../src/services/invite/api.ts')
const ours = await import('../../src/services/ours/api.ts')
const device = await import('../../src/services/invite/device.ts')

const translate = (key, params) =>
  String(zh[key] ?? `<missing:${key}>`).replace(/\{(\w+)\}/g, (placeholder, name) =>
    params?.[name] === undefined ? placeholder : String(params[name])
  )

const KEY = 'sk-ours-unit-test-654321'
const CARD = 'MUSE-8f3a-9b7c-2d44-71bb'
const CARD_TAIL = CARD.slice(-4)

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  a === b ? ok(`${label} = ${a}`) : bad(`${label}：期望 ${b}，实际 ${a}`)
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}
const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

// ---------------------------------------------------------------- [1][2][3][4] 兑换协议

console.log('\n[1] 兑换改地址：POST 62.106:60013/redeem-card，body 只有 {card_no, api_key}')
{
  truthy(typeof invite.redeemCardAtPool === 'function', 'redeemCardAtPool 已导出')
  truthy(typeof invite.redeemCardMigrated === 'function', 'redeemCardMigrated（池 + 旧接口兜底）已导出')
  eq(invite.REDEEM_POOL_URL, inviteBaseUrl + '/redeem-card', 'REDEEM_POOL_URL')

  const { transport, calls } = fakeTransport([
    json(200, { ok: true, points: 300, quota_points: 300, remaining_points: 620, duplicate: false }),
  ])
  const result = await invite.redeemCardMigrated({ cardNo: ` ${CARD} `, apiKey: ` ${KEY} ` }, transport)
  eq(calls.length, 1, '只发一次请求')
  eq(calls[0].method, 'POST', 'method')
  eq(calls[0].url, inviteBaseUrl + '/redeem-card', 'url 打本机池')
  eq(calls[0].headers['Content-Type'], 'application/json', 'content-type')
  eq(calls[0].followRedirects, false, 'followRedirects=false')
  eq(JSON.parse(calls[0].body), { card_no: CARD, api_key: KEY }, 'body 只有 card_no + api_key（无 request_id）')
  eq(result.kind, 'success', '200 → success')
  eq(result.points, 300, 'points 取服务端')
  eq(result.remainingPoints, 620, 'remaining_points 取服务端')
  eq(result.via, 'pool', 'via=pool')
  eq(result.cardTail, CARD_TAIL, '卡密只露尾 4 位')
}

console.log('\n[2] 200 duplicate:true 按成功处理')
{
  const { transport } = fakeTransport([
    json(200, { ok: true, points: 300, quota_points: 300, remaining_points: 620, duplicate: true }),
  ])
  const result = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, transport)
  eq(result.kind, 'success', 'duplicate:true 不是错误')
  eq(result.duplicate, true, 'duplicate 标记透传')
  eq(result.messageKey, 'oursRedeemDuplicate', '重复提交给「已到账」文案')
  truthy(
    !translate('oursRedeemDuplicate', { points: '300 积分', yuan: '¥3.00' }).includes('失败'),
    '重复提交的文案不含「失败」'
  )
}

console.log('\n[3] 四个返回码的中文文案')
{
  const cases = [
    [404, { error: { code: 'card_not_found' } }, 'card_not_found', 'oursErrCardNotFoundOrExpired', '卡密不存在或已失效'],
    [409, { error: { code: 'card_used' } }, 'card_used', 'oursErrCardUsed', '该卡密已被使用'],
    [400, { error: { code: 'api_key_invalid' } }, 'api_key_invalid', 'oursErrApiKeyNotIssued', '请先在 App 内领取 Key'],
  ]
  for (const [status, body, code, key, text] of cases) {
    const { transport } = fakeTransport([json(status, body)])
    const result = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, transport)
    eq(result.kind, 'error', `${code} → error`)
    eq(result.code, code, `${code} code 透传`)
    eq(result.messageKey, key, `${code} messageKey`)
    truthy(translate(key).includes(text), `${code} 文案含「${text}」：${translate(key)}`)
  }
}

console.log('\n[4] 旧 /api/redeem 兜底 + CARD_LEASED 文案与 card_used 区分开')
{
  // 池不可达（网络层失败）→ 兜底打旧接口，request_id 固定用卡密
  const { transport, calls } = fakeTransport([
    { kind: 'network' },
    json(200, { ok: true, points: 300, card_no: CARD, api_key: KEY, sync: true }),
  ])
  const result = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, transport)
  eq(calls.length, 2, '池失败后恰好兜底一次')
  eq(calls[1].url, `${ours.OURS_API_BASE}/api/redeem`, '兜底打旧 /api/redeem')
  eq(JSON.parse(calls[1].body).request_id, CARD, '兜底 request_id 固定用卡密')
  eq(result.kind, 'success', '兜底成功')
  eq(result.via, 'legacy', 'via=legacy')

  // 池路由不存在（404 但没有 card_not_found 语义体）→ 也兜底
  const routed = fakeTransport([
    { kind: 'response', status: 404, text: '404 page not found' },
    json(200, { ok: true, points: 300 }),
  ])
  const fallback = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, routed.transport)
  eq(routed.calls.length, 2, '池 404 无语义体 → 兜底一次')
  eq(fallback.via, 'legacy', '兜底命中旧接口')

  // 409 CARD_LEASED：文案必须叫「已转入 App 兑换通道」，不能是「已被使用」
  const leased = fakeTransport([
    { kind: 'response', status: 404, text: '' },
    json(409, { error: { code: 'CARD_LEASED' } }),
  ])
  const leasedResult = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, leased.transport)
  eq(leasedResult.kind, 'error', 'CARD_LEASED → error')
  eq(leasedResult.messageKey, 'oursErrCardLeased', 'CARD_LEASED messageKey')
  const leasedText = translate('oursErrCardLeased')
  truthy(leasedText.includes('该卡密已转入 App 兑换通道'), `CARD_LEASED 文案：${leasedText}`)
  truthy(!leasedText.includes('已被使用'), 'CARD_LEASED 文案不含「已被使用」')
  truthy(
    translate('oursErrCardUsed') !== leasedText,
    'CARD_LEASED 与 card_used 文案确实不同'
  )
}

console.log('\n[5] 202 CREDIT_PENDING / VERIFY_PENDING 一律「处理中」')
{
  for (const code of ['CREDIT_PENDING', 'VERIFY_PENDING']) {
    const { transport } = fakeTransport([json(202, { code })])
    const result = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, transport)
    eq(result.kind, code === 'CREDIT_PENDING' ? 'pending' : 'pending', `${code} → pending`)
    eq(result.code, code, `${code} code 透传`)
    truthy(result.messageKey === undefined || result.messageKey === 'oursRedeemProcessing', `${code} 不带错误文案`)
    const text = translate('oursRedeemProcessing')
    truthy(text.includes('兑换处理中，稍后自动到账'), `${code} 文案：${text}`)
    truthy(!/失败|换卡|无效/.test(text), `${code} 文案不出现失败 / 换卡`)
  }
  // 202 但响应体里 code 在小写/嵌套位置时也不能翻成错误
  const { transport } = fakeTransport([{ kind: 'response', status: 202, text: '' }])
  const bare = await invite.redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, transport)
  eq(bare.kind, 'pending', '202 空响应体也是处理中')
}

// ---------------------------------------------------------------- [6][7] device 自愈

console.log('\n[6] device_not_found 自愈：/apply → 存 key → 重试一次')
{
  truthy(typeof invite.runWithDeviceSelfHeal === 'function', 'runWithDeviceSelfHeal 已导出')
  const saved = []
  const { transport, calls } = fakeTransport([
    // run #1 → device_not_found
    (request) =>
      request.url.endsWith('/me?device_id=d-old')
        ? json(404, { error: { code: 'device_not_found' } })
        : json(200, { ok: true }),
    // /apply
    json(201, {
      key: 'sk-healed-000111',
      invite_code: 'ABC12345',
      invited_count: 0,
      max_invites: 5,
      bonus_points: 0,
      redeemed: false,
      quota_points: 0,
      used_points: 0,
      remaining_points: 0,
      key_status: 'active',
    }),
    // 重试 → 成功
    json(200, {
      invite_code: 'ABC12345',
      invited_count: 0,
      max_invites: 5,
      bonus_points: 0,
      redeemed: false,
      quota_points: 320,
      used_points: 0,
      remaining_points: 320,
      key_status: 'active',
    }),
  ])
  const outcome = await invite.runWithDeviceSelfHeal(
    { deviceId: 'd-old', transport, saveKey: (key) => saved.push(key) },
    (deviceId) => invite.fetchInviteProfile(deviceId, transport)
  )
  eq(outcome.kind, 'ok', '自愈后拿到结果')
  eq(outcome.healed, true, 'healed=true')
  eq(calls.length, 3, '原请求 + /apply + 重试一次 = 3 条请求')
  eq(calls[1].method, 'POST', '/apply 是 POST')
  eq(calls[1].url, inviteBaseUrl + '/apply', '/apply 地址')
  eq(JSON.parse(calls[1].body), { device_id: 'd-old' }, '/apply body 带 device_id')
  eq(calls[2].url, calls[0].url, '重试的是原请求')
  eq(saved, ['sk-healed-000111'], '自愈后把 key 存下来')
  eq(outcome.value.profile.remainingPoints, 320, '重试结果返回给界面')
}

console.log('\n[7] 只重试一次；invalid_device 重生成；429 / 409 不重试')
{
  // 重试后仍是 device_not_found → 不再重试（防死循环）
  const loop = fakeTransport([
    json(404, { error: { code: 'device_not_found' } }),
    json(201, { key: 'sk-healed', invite_code: 'A1', remaining_points: 0 }),
    json(404, { error: { code: 'device_not_found' } }),
  ])
  const outcome = await invite.runWithDeviceSelfHeal(
    { deviceId: 'd-old', transport: loop.transport, saveKey: () => {} },
    (deviceId) => invite.fetchInviteProfile(deviceId, loop.transport)
  )
  eq(outcome.kind, 'error', '两次 device_not_found → 报错')
  eq(loop.calls.length, 3, '总请求数 3（原请求 + apply + 重试 1 次），没有死循环')

  // invalid_device → 重新生成 device_id 再试一次
  const invalid = fakeTransport([
    json(400, { error: { code: 'invalid_device' } }),
    json(200, {
      invite_code: 'A1',
      invited_count: 0,
      max_invites: 5,
      bonus_points: 0,
      redeemed: false,
      quota_points: 0,
      used_points: 0,
      remaining_points: 0,
      key_status: 'active',
    }),
  ])
  const regenerated = []
  const invalidOutcome = await invite.runWithDeviceSelfHeal(
    {
      deviceId: 'd-broken',
      transport: invalid.transport,
      regenerate: (current) => {
        regenerated.push(current)
        return 'd-regenerated-0001'
      },
    },
    (deviceId) => invite.fetchInviteProfile(deviceId, invalid.transport)
  )
  eq(regenerated, ['d-broken'], 'invalid_device 触发了重新生成')
  eq(invalidOutcome.kind, 'ok', '重新生成后成功')
  eq(invalidOutcome.deviceId, 'd-regenerated-0001', '后续用新 device_id')
  truthy(invalid.calls[1].url.includes('d-regenerated-0001'), '重试用的是新 device_id')

  // 429 rate_limited：不重试，文案「今天领取次数过多，请明天再试」
  const limited = fakeTransport([
    json(429, { error: { code: 'rate_limited' } }),
    json(201, { key: 'sk-never', invite_code: 'A1', remaining_points: 0 }),
  ])
  const limitedOutcome = await invite.runWithDeviceSelfHeal(
    { deviceId: 'd-old', transport: limited.transport, saveKey: () => {} },
    (deviceId) => invite.fetchInviteProfile(deviceId, limited.transport)
  )
  eq(limited.calls.length, 1, '429 不重试')
  eq(limitedOutcome.kind, 'error', '429 → error')
  eq(limitedOutcome.messageKey, 'oursInviteErrApplyRateLimited', '429 messageKey')
  truthy(
    translate('oursInviteErrApplyRateLimited').includes('今天领取次数过多，请明天再试'),
    `429 文案：${translate('oursInviteErrApplyRateLimited')}`
  )

  // 409 already_redeemed：不重试
  const redeemed = fakeTransport([
    json(409, { error: { code: 'already_redeemed' } }),
    json(201, { key: 'sk-never', invite_code: 'A1', remaining_points: 0 }),
  ])
  const redeemedOutcome = await invite.runWithDeviceSelfHeal(
    { deviceId: 'd-old', transport: redeemed.transport, saveKey: () => {} },
    (deviceId) => invite.fetchInviteProfile(deviceId, redeemed.transport)
  )
  eq(redeemed.calls.length, 1, '409 already_redeemed 不重试')
  eq(redeemedOutcome.kind, 'error', '409 → error')
  eq(redeemedOutcome.messageKey, 'oursInviteErrAlreadyClaimed', '409 messageKey')

  // 界面层不再出现「请先领取」这类泄漏：device_not_found 的自愈路径上没有任何提示文案
  truthy(
    invite.runWithDeviceSelfHeal !== undefined && !('DEVICE_NOT_FOUND_HINT' in invite),
    'device_not_found 不作为用户可见错误暴露'
  )
}

// ---------------------------------------------------------------- [8] 设备码备份提示

console.log('\n[8] 设备码可见可备份 + 只提示一次')
{
  const memory = () => {
    const store = new Map()
    return {
      read: () => store.get('device') ?? null,
      write: (value) => store.set('device', value),
      readFlag: () => store.get('hint') ?? null,
      writeFlag: (value) => store.set('hint', value),
    }
  }
  const store = memory()
  truthy(typeof device.shouldShowDeviceBackupHint === 'function', 'shouldShowDeviceBackupHint 已导出')
  eq(device.shouldShowDeviceBackupHint(store), true, '首次打开要提示')
  device.markDeviceBackupHintSeen(store)
  eq(device.shouldShowDeviceBackupHint(store), false, '标记后不再提示')
  // W1-B 后半（#487）：旧引导文案（「设备码就是你的账号凭据，请复制备份」）已删除。
  // 设备相关函数本体仍在（归 W1-D 删），但 i18n 里不该再留着这句会误导人的话。
  truthy(
    zh.oursDeviceBackupHint === undefined && en.oursDeviceBackupHint === undefined,
    '旧的「设备码=账号，请复制备份」文案已删除'
  )
}

// ---------------------------------------------------------------- [9] 价格 / 无图片入口

console.log('\n[9] 价格取 /api/plans；客户端不暴露图片 / 文件输入入口')
{
  const dialogSource = await readFile(
    path.join(ROOT, 'src/components/settings/OursServicesDialog.tsx'),
    'utf8'
  )
  truthy(!/type="file"/.test(dialogSource), '设置/兑换弹层没有 file 输入')
  truthy(!/\baccept=/.test(dialogSource), '设置/兑换弹层没有 accept= 选择器')
  truthy(!/<img\b/.test(dialogSource), '兑换弹层没有图片预览')
  truthy(
    !/fetchPlans/.test(dialogSource),
    '弹层不再取 /api/plans（#331：套餐全线下架，购买入口改成 App 内打开收款页）'
  )
  // 硬编码价格：不允许出现 ¥+数字 的写死价，或 price: <数字>
  const hardcoded = [...dialogSource.matchAll(/[¥￥]\s?\d|\bprice:\s*\d/g)].map((m) => m[0])
  eq(hardcoded, [], '弹层里没有硬编码价格')

  const plansSource = await readFile(path.join(ROOT, 'src/services/ours/api.ts'), 'utf8')
  truthy(/\/api\/plans/.test(plansSource), '套餐请求打 /api/plans')
  truthy(!/points:\s*3900|price:\s*39\b/.test(plansSource), '服务层没有写死 p1/p2 价格与积分')

  // 实测口径对照（2026-11-18 curl /api/plans）：p1 ¥0.10/300、p2 ¥39/3900
  const { transport, calls } = fakeTransport([
    json(200, {
      plans: [
        { id: 'p1', name: '入门包', price: 0.1, points: 300, currency: 'CNY', enabled: true },
        { id: 'p2', name: '标准包', price: 39, points: 3900, currency: 'CNY', enabled: true },
      ],
    }),
  ])
  const state = await ours.fetchPlans(transport)
  eq(calls[0].url, `${ours.OURS_API_BASE}/api/plans`, '取套餐打 /api/plans')
  eq(state.status, 'success', '套餐解析成功')
  // #487：单位统一为元（100 积分 = 1 元），断言强度不变，期望值跟着单位改
  eq(ours.formatPlanMeta(state.plans[0], zh.oursPointsUnit), '¥0.10 · 3.00 元', 'p1 价格来自服务端')
  eq(ours.formatPlanMeta(state.plans[1], zh.oursPointsUnit), '¥39.00 · 39.00 元', 'p2 价格来自服务端')
}

// Windows 的 TCP 动态端口范围从 1024 起（netsh int ipv4 show dynamicport tcp → start=1024 num=64511），
// 所以 listen(0) 会把 WHATWG/undici 的 bad-port（6566 / 6665-6669 / 6679 / 6697 / 6000 / 5060 / 1719 …）
// 当空闲端口发出来；而 node 的 fetch（undici）对这批端口直接抛 TypeError: fetch failed
// （cause: bad port），一个 TCP 连接都不发。单跑不会撞上，六条 lane 并发才偶发 —— 假红的根。

const realFetchTransport = (request) =>
  fetch(request.url, { method: request.method, headers: request.headers, body: request.body }).then(
    async (response) => ({ kind: 'response', status: response.status, text: await response.text() })
  )

const startStub = async ({ port = 0 } = {}) => {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on(
      'data',
      (chunk) => {
        body += chunk
      }
    )
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body })
      if (request.url === '/redeem-card') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ ok: true, points: 300, quota_points: 300, remaining_points: 900, duplicate: false })
        )
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'card_not_found', message: 'card not found' } }))
    })
  })
  const actualPort = port === 0 ? await listenFreePort(server) : await listenFetchablePort(server, port)
  return {
    seen,
    base: 'http://127.0.0.1:' + actualPort,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ---------------------------------------------------------------- [10] 协议层 stub 服务器

console.log('\n[10] 本地 stub 服务器：验证真实发出的报文（不是打真机/真服务）')
{
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body })
      if (request.url === '/redeem-card') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ ok: true, points: 300, quota_points: 300, remaining_points: 900, duplicate: false })
        )
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'card_not_found', message: 'card not found' } }))
    })
  })
  const port = await listenFreePort(server)
  const base = `http://127.0.0.1:${port}`

  try {
    const realFetchTransport = (request) =>
      fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }).then(async (response) => ({
        kind: 'response',
        status: response.status,
        text: await response.text(),
      }))

    const success = await invite.redeemCardAtPool(
      { cardNo: CARD, apiKey: KEY, baseUrl: base },
      realFetchTransport
    )
    eq(success.kind, 'success', 'stub 200 → success')
    eq(success.remainingPoints, 900, 'stub remaining_points')
    eq(seen[0].method, 'POST', 'stub 收到 POST')
    eq(seen[0].url, '/redeem-card', 'stub 收到 /redeem-card')
    eq(JSON.parse(seen[0].body), { card_no: CARD, api_key: KEY }, 'stub 收到的 body')
    eq(seen[0].headers['content-type'], 'application/json', 'stub 收到 json content-type')

    const missing = await invite.redeemCardAtPool(
      { cardNo: 'MUSE-0000-0000-0000-0000', apiKey: KEY, baseUrl: `${base}/nope` },
      realFetchTransport
    )
    eq(missing.kind, 'error', 'stub 404 → error')
    eq(missing.code, 'card_not_found', 'stub 404 card_not_found')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}


// ---------------------------------------------------------------- [10b] 端口卫生

console.log('\n[10b] stub 端口必须能被 fetch 使用；并发两份实例互不踩')
{
  // 1) 原始假红形态（修复前就这样红）：stub 落在 bad-port 6566 上，fetch 一个连接都不发就失败
  let failure = null
  try {
    const stub = await startStub({ port: 6566 })
    try {
      await realFetchTransport({ url: stub.base + '/redeem-card', method: 'POST', headers: {}, body: '{}' })
    } finally {
      await stub.close()
    }
  } catch (error) {
    failure = String(error.cause?.code ?? error.cause?.message ?? error.message)
  }
  truthy(failure !== null, '6566 在 bad-port 名单上，fetch 连不上（实测 ' + failure + '）')

  // 2) startStub 不能把 fetch 永远连不上的地址交出去：显式要拒连端口必须当场拒绝
  let rejected = null
  try {
    const stub = await startStub({ port: 6566 })
    await stub.close()
  } catch (error) {
    rejected = String(error.message)
  }
  truthy(rejected !== null, '显式要拒连端口 6566 时直接拒绝，不发坏地址（' + rejected + '）')

  // 3) 并发两份 stub：端口不同，同一时刻都能收发，互不踩
  const [first, second] = await Promise.all([startStub(), startStub()])
  try {
    eq(first.base === second.base, false, '两份并发 stub 端口不同')
    eq(FETCH_REFUSED_PORTS.has(Number(new URL(first.base).port)), false, 'stub 端口不在 fetch 拒连名单')
    const [r1, r2] = await Promise.all([
      invite.redeemCardAtPool({ cardNo: CARD, apiKey: KEY, baseUrl: first.base }, realFetchTransport),
      invite.redeemCardAtPool({ cardNo: CARD, apiKey: KEY, baseUrl: second.base }, realFetchTransport),
    ])
    eq(r1.kind, 'success', '并发第一份 stub 跑通')
    eq(r2.kind, 'success', '并发第二份 stub 跑通')
    eq(first.seen.length, 1, '第一份 stub 只收到自己那一个请求')
    eq(second.seen.length, 1, '第二份 stub 只收到自己那一个请求')
  } finally {
    await first.close()
    await second.close()
  }
}
// ---------------------------------------------------------------- i18n 完整性

console.log('\n[11] i18n：新 key 中英齐全，既有 key 未被改写')
{
  const newKeys = [
    'oursErrCardLeased',
    'oursErrCardNotFoundOrExpired',
    'oursErrApiKeyNotIssued',
    'oursRedeemProcessing',
    'oursRedeemDuplicate',
    'oursRedeemRefreshBalance',
    'oursInviteErrApplyRateLimited',
    'oursInviteErrAlreadyClaimed',
  ]
  for (const key of newKeys) {
    truthy(typeof zh[key] === 'string' && zh[key] !== '', `zh.${key} 存在`)
    truthy(typeof en[key] === 'string' && en[key] !== '', `en.${key} 存在`)
  }
  eq(zh.appName, '鲸落', 'appName 仍是「鲸落」（既有行未被改）')
  eq(zh.oursRedeemPending, '兑换处理中，请稍后刷新额度查看', '既有 oursRedeemPending 未被改写')
  eq(zh.oursErrCardUsed, '该卡密已被使用，不要重复提交', '既有 oursErrCardUsed 未被改写')
  eq(zh.oursInviteErrRateLimited, '操作太频繁，请稍后再试', '既有 oursInviteErrRateLimited 未被改写')
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
