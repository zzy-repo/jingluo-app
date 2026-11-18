#!/usr/bin/env node
/**
 * 本地 mock 后端 —— 仅用于真机 UI 联调，**不是真实服务**。
 *
 * 用一台进程同时扮演两个后端：
 *   1) 邀请 / 额度服务：原 http://62.106.70.167:60013
 *        POST /apply  POST /redeem  GET /me?device_id=…
 *   2) 卡密 / 支付服务：原 https://apia.ecsafe.cn
 *        GET /api/plans  GET /api/balance  POST /api/redeem  GET /buy?plan=…
 *
 * 零依赖（只用 node:http / node:fs），模拟器通过 http://10.0.2.2:<port> 访问宿主机。
 *
 * 隐私：日志里 **绝不出现完整 Key / 完整卡密**，只记 masked tail 与「有没有带 Bearer」「URL 里有没有 key」。
 *
 * 控制面（只给测试脚本用，真实服务没有）：
 *   GET  /health                  → {ok:true, port}
 *   GET  /__log                   → 到目前为止的全部请求记录（含断言用的标记）
 *   POST /__control/clear-log     → 清空日志
 *   POST /__control/reset         → 重置所有内存状态（设备 / 卡密 / 额度）
 *   POST /__control/buy-mode      → {"mode":"no-location"|"redirect"} 控制 /buy 的 302 行为
 *
 * 环境变量：PORT（默认 8099）、MOCK_LOG_FILE（可选，逐行 JSON 落盘）
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.PORT || 8099)
const LOG_FILE = process.env.MOCK_LOG_FILE || ''
const INITIAL_POINTS = 100

/** 卡密表：MOCK-OK 一次性成功；MOCK-USED 永远已用；其余 404 */
const CARD_SEED = [
  { cardNo: 'MOCK-OK', points: 300, used: false },
  { cardNo: 'MOCK-USED', points: 300, used: true },
]

const maskKey = (key) => (key.length <= 6 ? '••••' : `••••${key.slice(-6)}`)
const maskCard = (card) => (card.length <= 4 ? '••••' : `••••${card.slice(-4)}`)

const freshState = () => ({
  /** device_id → profile（含 key，是 mock 的假 key） */
  devices: new Map(),
  /** api_key → device_id */
  keyToDevice: new Map(),
  cards: new Map(CARD_SEED.map((card) => [card.cardNo, { ...card }])),
  /** /buy 的行为：no-location = 302 但不带 Location；redirect = 302 带 https Location */
  buyMode: 'no-location',
  /** 自增序号：假 key 的尾号（保持可读、可断言 tail=mock01） */
  seq: 0,
})

let state = freshState()
const entries = []

const newKey = () => {
  state.seq += 1
  // 尾部固定 mock01：界面上掩码后 6 位应当显示 ••••mock01
  return `sk-mock-d${state.seq}mock01`
}

const profileOf = (device) => ({
  invite_code: device.inviteCode,
  invited_count: device.invitedCount,
  max_invites: device.maxInvites,
  bonus_points: device.bonusPoints,
  redeemed: device.redeemed,
  quota_points: device.quotaPoints,
  used_points: device.usedPoints,
  remaining_points: device.remainingPoints,
  key_status: device.keyStatus,
})

const withKey = (device) => ({ key: device.key, ...profileOf(device) })

const newDevice = (deviceId) => {
  const seq = state.devices.size + 1
  const device = {
    deviceId,
    key: newKey(),
    inviteCode: `MOCKINV${String(seq).padStart(3, '0')}`,
    invitedCount: 0,
    maxInvites: 5,
    bonusPoints: 0,
    redeemed: false,
    quotaPoints: INITIAL_POINTS,
    usedPoints: 0,
    remainingPoints: INITIAL_POINTS,
    keyStatus: 'active',
  }
  state.devices.set(deviceId, device)
  state.keyToDevice.set(device.key, deviceId)
  return device
}

/** 极简 JSON 响应 */
const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(text)
}

const err = (res, status, code, message) =>
  json(res, status, { code, message, error: { code, message } })

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })

/** 记录一条请求（脱敏）：供断言「URL 无 query 带 key」「Authorization: Bearer 存在」 */
const record = (req, url, extra) => {
  const auth = req.headers.authorization ?? ''
  const keyLike = [...state.keyToDevice.keys()]
  const rawUrl = req.url ?? ''
  const lower = rawUrl.toLowerCase()
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search === '' ? '' : url.search,
    status: extra.status,
    auth: {
      present: auth !== '',
      isBearer: /^bearer\s+\S+/i.test(auth),
      // 只留尾部 6 位，绝不记完整 Key
      keyTail: auth === '' ? '' : maskKey(auth.replace(/^bearer\s+/i, '')),
    },
    /** 断言用：URL 的 query 里是否出现了 key / key= 这类东西 */
    urlHasKeyParam: /(^|[?&])(api_?key|key|token)=/i.test(lower),
    /** 断言用：URL 里是否原样出现了任何一把 mock key */
    urlLeaksMockKey: keyLike.some((key) => rawUrl.includes(key)),
    note: extra.note ?? '',
  }
  entries.push(entry)
  if (LOG_FILE !== '') {
    try {
      appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`)
    } catch {
      /* 写日志失败不影响被测流程 */
    }
  }
  return entry
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'
  /** 每条路由都要在最前面决定 status，最后统一记录 */
  let recordedStatus = 0
  const mark = (status) => {
    recordedStatus = status
  }
  // 统一在响应结束时记录（note 由各路由填充）
  let note = ''
  res.on('finish', () => {
    if (pathname.startsWith('/__')) return // 控制面不进日志，免得污染断言
    record(req, url, { status: recordedStatus || res.statusCode, note })
  })

  // ---------------------------------------------------------------- 控制面
  if (pathname === '/health') {
    mark(200)
    return json(res, 200, { ok: true, port: PORT, devices: state.devices.size })
  }
  if (pathname === '/__log') {
    mark(200)
    return json(res, 200, { count: entries.length, entries })
  }
  if (pathname === '/__control/clear-log' && method === 'POST') {
    entries.length = 0
    mark(200)
    return json(res, 200, { ok: true, cleared: true })
  }
  if (pathname === '/__control/reset' && method === 'POST') {
    state = freshState()
    entries.length = 0
    mark(200)
    return json(res, 200, { ok: true, reset: true })
  }
  if (pathname === '/__control/buy-mode' && method === 'POST') {
    const body = await readBody(req)
    const mode = body?.mode
    if (mode !== 'no-location' && mode !== 'redirect') {
      mark(400)
      return err(res, 400, 'BAD_MODE', 'mode must be no-location | redirect')
    }
    state.buyMode = mode
    mark(200)
    return json(res, 200, { ok: true, mode })
  }

  // ------------------------------------------------- 邀请 / 额度服务（60013）
  if (pathname === '/apply' && method === 'POST') {
    const body = await readBody(req)
    if (body === null || typeof body.device_id !== 'string' || body.device_id.trim() === '') {
      mark(400)
      return err(res, 400, 'bad_request', 'device_id required')
    }
    const deviceId = body.device_id.trim()
    const existing = state.devices.get(deviceId)
    const device = existing ?? newDevice(deviceId)
    note = existing ? 'apply:existing(200)' : 'apply:first(201)'
    mark(existing ? 200 : 201)
    return json(res, existing ? 200 : 201, withKey(device))
  }

  if (pathname === '/me' && method === 'GET') {
    const deviceId = (url.searchParams.get('device_id') ?? '').trim()
    const device = state.devices.get(deviceId)
    if (deviceId === '' || device === undefined) {
      mark(404)
      return err(res, 404, 'device_not_found', 'device not found')
    }
    note = `me:remaining=${device.remainingPoints}`
    mark(200)
    return json(res, 200, profileOf(device))
  }

  if (pathname === '/redeem' && method === 'POST') {
    // 邀请码兑换（本任务不测，但保持契约形状：不制造假的成功）
    const body = await readBody(req)
    const deviceId = String(body?.device_id ?? '').trim()
    const device = state.devices.get(deviceId)
    if (device === undefined) {
      mark(404)
      return err(res, 404, 'device_not_found', 'device not found')
    }
    const code = String(body?.invite_code ?? '').trim().toUpperCase()
    if (code === '' || !state.devices.size) {
      mark(404)
      return err(res, 404, 'invalid_code', 'invalid code')
    }
    if (code === device.inviteCode) {
      mark(400)
      return err(res, 400, 'own_code', 'cannot use your own code')
    }
    const inviter = [...state.devices.values()].find((item) => item.inviteCode === code)
    if (inviter === undefined) {
      mark(404)
      return err(res, 404, 'invalid_code', 'invalid code')
    }
    if (device.redeemed) {
      mark(409)
      return err(res, 409, 'already_redeemed', 'already redeemed')
    }
    device.redeemed = true
    device.bonusPoints += 100
    device.quotaPoints += 100
    device.remainingPoints += 100
    note = 'invite-redeem:ok'
    mark(200)
    return json(res, 200, { ...profileOf(device), reward_points: 100, synced: true })
  }

  // ------------------------------------------------- 卡密 / 支付服务（apia）
  if (pathname === '/api/plans' && method === 'GET') {
    note = 'plans'
    mark(200)
    return json(res, 200, {
      plans: [
        { id: 'p1', name: '体验包', price: 3.0, points: 300, currency: 'CNY', enabled: true },
        { id: 'p2', name: '标准包', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
      ],
    })
  }

  if (pathname === '/api/balance' && method === 'GET') {
    const auth = req.headers.authorization ?? ''
    if (!/^bearer\s+\S+/i.test(auth)) {
      note = 'balance:no-bearer'
      mark(401)
      return err(res, 401, 'API_KEY_MISSING', 'Authorization: Bearer <key> required')
    }
    const key = auth.replace(/^bearer\s+/i, '').trim()
    const known = state.keyToDevice.has(key)
    note = `balance:bearer=${known ? 'known' : 'unknown'}`
    mark(200)
    // 只回答「Key 认不认」，不返回额度（真实服务同样如此）
    return json(res, 200, { api_key: maskKey(key), valid: true })
  }

  if (pathname === '/api/redeem' && method === 'POST') {
    const body = await readBody(req)
    if (body === null) {
      mark(400)
      return err(res, 400, 'BAD_JSON', 'invalid json')
    }
    const cardNo = String(body.card_no ?? '').trim()
    const apiKey = String(body.api_key ?? '').trim()
    const requestId = String(body.request_id ?? '').trim()
    const card = state.cards.get(cardNo)
    if (cardNo === '') {
      mark(400)
      return err(res, 400, 'CARD_MISSING', 'card_no required')
    }
    if (apiKey === '') {
      mark(400)
      return err(res, 400, 'API_KEY_MISSING', 'api_key required')
    }
    if (card === undefined) {
      note = `redeem:404 card=${maskCard(cardNo)}`
      mark(404)
      return err(res, 404, 'CARD_NOT_FOUND', 'card not found')
    }
    if (card.used) {
      note = `redeem:409 card=${maskCard(cardNo)} used`
      mark(409)
      // request_id 回显是契约的一部分（真实服务也回）
      return json(res, 409, {
        code: 'CARD_ALREADY_USED',
        message: 'card already used',
        request_id: requestId,
      })
    }
    card.used = true
    const deviceId = state.keyToDevice.get(apiKey)
    const device = deviceId === undefined ? undefined : state.devices.get(deviceId)
    if (device !== undefined) {
      device.quotaPoints += card.points
      device.remainingPoints += card.points
    }
    note = `redeem:200 card=${maskCard(cardNo)} +${card.points} remaining=${
      device === undefined ? 'n/a' : device.remainingPoints
    }`
    mark(200)
    return json(res, 200, {
      ok: true,
      card_no: maskCard(cardNo),
      points: card.points,
      api_key: maskKey(apiKey),
      sync: 'credited',
      request_id: requestId,
    })
  }

  if (pathname === '/buy' && method === 'GET') {
    const plan = (url.searchParams.get('plan') ?? '').trim()
    if (plan === '') {
      mark(400)
      return err(res, 400, 'PLAN_MISSING', 'plan required')
    }
    if (state.buyMode === 'redirect') {
      note = `buy:302 redirect plan=${plan}`
      mark(302)
      // 契约形状照线上抄：收银台地址自带 out_trade_no，return_url 的 query 里带 order_token
      const returnUrl = encodeURIComponent(
        `https://example.com/mock-return?no=CP2026MOCK0001&order_token=MOCKTOKEN123`
      )
      res.writeHead(302, {
        Location:
          `https://example.com/mock-checkout?pid=1&out_trade_no=CP2026MOCK0001&money=3.00` +
          `&plan=${encodeURIComponent(plan)}&return_url=${returnUrl}`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }
    // no-location：302 但**不带** Location（模拟「拿不到收银台地址」）
    note = `buy:302 no-location plan=${plan}`
    mark(302)
    res.writeHead(302, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end('302 moved, no location header (mock)')
  }

  if (pathname === '/api/order' && method === 'GET') {
    mark(404)
    return err(res, 404, 'ORDER_NOT_FOUND', 'order not found (mock has no orders)')
  }

  if (pathname === '/' && method === 'GET') {
    mark(200)
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('mock pay/invite backend (test only). See /health, /__log\n')
  }

  mark(404)
  return err(res, 404, 'NOT_FOUND', `no route: ${method} ${pathname}`)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] listening on http://0.0.0.0:${PORT}  (emulator: http://10.0.2.2:${PORT})`)
  console.log('[mock] 仅测试用：/apply /me /api/plans /api/balance /api/redeem /buy')
  if (LOG_FILE !== '') {
    console.log(`[mock] request log -> ${LOG_FILE}`)
  }
})
