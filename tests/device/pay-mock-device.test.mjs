// 真机（Android WebView）验证：额度与卡密 UI 全链路 —— **兑换与额度全部走本地 mock 后端**
//
// 为什么不是 page.route：Android WebView 下 Capacitor 把请求交给原生 CapacitorHttp，
// 页面级 fetch 拦截根本看不到这些请求（详见任务背景）。所以这里用「测试专用构建 +
// 构建期 base URL 覆盖」把邀请服务与支付服务指向 http://10.0.2.2:<port>（宿主机上的 mock）。
//
// 前置：
//   1) 一台模拟器（compat31 / Android 12 / WebView 91）已启动；
//   2) 宿主机上跑着 scripts/mock-pay-server.mjs（默认 8099）；
//   3) 被测 APK 是用 TEST_INVITE_API_BASE / TEST_OURS_API_BASE 覆盖后构建的（见 README-mock-device.md）。
//
// 运行：
//   APK=/path/to/app-debug.apk node scripts/device-verify.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const ADB = process.env.ADB || '/root/android-sdk/platform-tools/adb'
const PACKAGE = 'com.example.deepseekchat'
const APK = process.env.APK || ''
const PORT = Number(process.env.MOCK_PORT || 8099)
const CONTROL = `http://127.0.0.1:${PORT}`
const SHOT_DIR = process.env.SHOT_DIR || '/root/pay-mock-device/shots'
const MOCK_DEVICE_URL = `http://10.0.2.2:${PORT}`

const sh = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
const check = (name, ok, detail = '') => {
  const line = `${name}${detail ? ` — ${detail}` : ''}`
  if (ok) {
    console.log(`  ✓ ${line}`)
  } else {
    failures.push(line)
    console.error(`  ✗ ${line}`)
  }
  return ok
}

const ctl = async (path, body) => {
  const response = await fetch(`${CONTROL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.json()
}

// ---------------------------------------------------------------- CDP（WebView）
const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = (event) => reject(new Error(`ws error: ${event?.message ?? 'unknown'}`))
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)))
      } else {
        resolve(message.result)
      }
      return
    }
    for (const listener of listeners) listener(message)
  }
  const send = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }
  return { socket, send, evaluate, listeners }
}

/**
 * 为什么不用 CDP 的 Emulation.setDeviceMetricsOverride：这台 WebView 91 上它会让
 * captureScreenshot 把同一帧平铺 2×2（截图看起来像「两个弹层并排」），不可用。
 * 改用真实显示参数：物理像素 / 密度 = CSS 像素，两次都是 320dpi → 2 倍像素，截图清晰。
 *   390 CSS 宽：wm size 780x1734 + density 320
 *   360 CSS 宽：wm size 720x1600 + density 320
 */
const DISPLAY = {
  390: { size: '780x1734', density: '320' },
  360: { size: '720x1600', density: '320' },
}

const applyWidth = async (width) => {
  const target = DISPLAY[width]
  sh('shell', 'wm', 'size', target.size)
  sh('shell', 'wm', 'density', target.density)
  await sleep(1800) // 等一次配置变更后的重排
}

const resetDisplay = () => {
  sh('shell', 'wm', 'size', 'reset')
  sh('shell', 'wm', 'density', 'reset')
}

/** 当前 CSS 视口宽度（用于断言 390 / 360 真的生效） */
const cssWidth = (cdp) => cdp.evaluate('document.documentElement.clientWidth')

/** 390 / 360 两张关键态截图（CSS 像素宽 390 与 360，同一 DOM 状态） */
const shots = async (cdp, name, selector) => {
  const files = []
  for (const width of [390, 360]) {
    await applyWidth(width)
    // 改显示参数会重排并重置滚动位置：每个宽度都要自己滚到目标区块，否则截到的是弹层顶部
    if (selector !== undefined) await scrollTo(cdp, selector)
    await sleep(600)
    const actual = await cssWidth(cdp)
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = `${SHOT_DIR}/${name}-${width}.png`
    writeFileSync(file, Buffer.from(image.data, 'base64'))
    files.push(file)
    console.log(`     截图 ${file}（CSS 宽 ${actual}px）`)
  }
  return files
}

/** 文案断言：设备 locale 可能是中文或英文，zh/en 两套文案都算通过 */
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)

const textOf = (cdp, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    return el === null ? null : el.innerText.trim()
  })()`)

const waitFor = async (cdp, selector, predicate, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const text = await textOf(cdp, selector)
    last = text
    if (text !== null && predicate(text)) return text
    await sleep(300)
  }
  return last
}

const click = (cdp, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return 'not-found'
    el.click()
    return 'ok'
  })()`)

const clickText = (cdp, names) =>
  cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(Array.isArray(names) ? names : [names])}
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
    const target = nodes.find((el) => wanted.includes(el.textContent.trim()))
    if (!target) return 'not-found: ' + nodes.map((el) => el.textContent.trim()).filter(Boolean).join('|').slice(0, 300)
    target.click()
    return 'ok'
  })()`)

/** React 受控 input：用原生 setter + input 事件，绕开 adb input text 的转义问题 */
const fill = (cdp, selector, value) =>
  cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (input === null) return 'not-found'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)

const scrollTo = (cdp, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return 'not-found'
    el.scrollIntoView({ block: 'center' })
    return 'ok'
  })()`)

// ---------------------------------------------------------------- 主流程
const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true })

  // ── 0. 前置检查 ──────────────────────────────────────────────────
  console.log('\n[0] 前置：mock 后端 + 设备 + APK')
  const health = await ctl('/health')
  check('mock 后端在跑', health.ok === true, `port ${health.port}`)
  await ctl('/__control/reset', {})
  await ctl('/__control/buy-mode', { mode: 'no-location' })
  console.log(`     mock 地址（模拟器侧）：${MOCK_DEVICE_URL}`)

  const avd = sh('shell', 'getprop', 'ro.build.version.sdk')
  const webview = sh('shell', 'dumpsys', 'webviewupdate').match(/versionName: ([\d.]+)/)?.[1] ?? '?'
  console.log(`     设备：Android SDK ${avd} / WebView ${webview}`)
  check('设备是 Android 12（SDK 31）', avd === '31', avd)

  check('传入了 APK', APK !== '', APK)
  if (APK === '') throw new Error('APK 未指定')

  // ── 1. 安装 + 冷启动（清数据 → 走「首次使用自动领取」路径）──────────
  console.log(`\n[1] 安装并冷启动 ${APK}`)
  console.log(`     ${sh('install', '-r', '-t', APK)}`)
  sh('shell', 'pm', 'clear', PACKAGE)
  sh('shell', 'am', 'force-stop', PACKAGE)
  sh('logcat', '-c')
  sh('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`)
  await sleep(7000)
  const pid = sh('shell', 'pidof', PACKAGE)
  check('进程起来了', pid !== '', `pid=${pid}`)
  sh('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`)
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const pageTarget = targets.find((target) => target.type === 'page')
  check('拿到 WebView 调试目标', pageTarget !== undefined, pageTarget?.url ?? '')

  const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl)
  const consoleErrors = []
  cdp.listeners.push((message) => {
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception')
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await applyWidth(390)
  await sleep(1200)

  const env = await cdp.evaluate(
    `({ platform: window.Capacitor?.getPlatform?.(), native: window.Capacitor?.isNativePlatform?.(), href: location.href })`
  )
  check('Capacitor 平台 = android', env.platform === 'android', String(env.platform))
  check('isNativePlatform() = true（请求走 CapacitorHttp）', env.native === true)

  // ── 2. 设置 → 额度与卡密 ─────────────────────────────────────────
  console.log('\n[2] 打开 设置 → 我们的渠道 → 额度与卡密')
  if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`))) {
    check('点「设置」', (await clickText(cdp, ['设置', 'Settings'])) === 'ok')
    await sleep(1200)
  }
  const oursRow = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-testid="ours-services-row"]')
    return row === null ? null : row.innerText.replace(/\\s+/g, ' ').trim()
  })()`)
  check('渠道是「我们的渠道」（设置里有额度与卡密入口）', oursRow !== null, oursRow ?? 'null')
  const opened = await click(cdp, '[data-testid="ours-services-open"]')
  check('点「额度与卡密 → 打开」', opened === 'ok', opened)
  await sleep(800)
  check(
    '弹层出现',
    await cdp.evaluate(`!!document.querySelector('[data-testid="ours-services-dialog"]')`)
  )

  // ── 3. 自动领取额度（首次使用）────────────────────────────────────
  console.log('\n[3] 自动领取：邀请码 / 初始 100 积分 / Key 掩码后 6 位')
  const claimText = await waitFor(
    cdp,
    '[data-testid="ours-claim-status"]',
    (text) => /已领取|Claimed|失败|Failed|超时|timed out/i.test(text),
    30000
  )
  check(
    '自动领取成功（「已领取…」/「Claimed…」）',
    matches(claimText, /已领取|Claimed/i),
    claimText ?? 'null'
  )
  const quota100 = await waitFor(
    cdp,
    '[data-testid="ours-quota-value"]',
    (text) => text.includes('积分'),
    20000
  )
  check('剩余额度 = 100 积分', (quota100 ?? '').includes('100 积分'), quota100 ?? 'null')
  check('约可消费 ¥1.00', (quota100 ?? '').includes('¥1.00'), quota100 ?? 'null')
  const inviteText = await textOf(cdp, '[data-testid="ours-invite-code"]')
  check('显示邀请码（mock: MOCKINV001）', (inviteText ?? '').includes('MOCKINV001'), inviteText ?? 'null')
  const keyTail = await textOf(cdp, '[data-testid="ours-claim-key"]')
  check('Key 只显示掩码后 6 位（••••mock01）', (keyTail ?? '').includes('••••mock01'), keyTail ?? 'null')
  const probe = await waitFor(cdp, '[data-testid="ours-key-probe"]', (text) => text !== '', 15000)
  check('Key 校验（/api/balance 带 Bearer）通过', matches(probe, /Key 已生效|Key active/i), probe ?? 'null')
  await scrollTo(cdp, '[data-testid="ours-quota"]')
  await shots(cdp, '01-claim-quota-100', '[data-testid="ours-quota"]')

  // 手动领取（幂等：同一 device_id 返回同一把 Key）
  check('点「领取 / 重新领取」', (await click(cdp, '[data-testid="ours-claim"]')) === 'ok')
  const manual = await waitFor(
    cdp,
    '[data-testid="ours-claim-status"]',
    (text) => /此前已领取|Already claimed/i.test(text),
    20000
  )
  check('手动领取成功（幂等，不覆盖 Key）', matches(manual, /此前已领取|Already claimed/i), manual ?? 'null')

  // ── 4. 查询额度：URL 无 query、走 Bearer ─────────────────────────
  console.log('\n[4] 查询额度（刷新额度）')
  // 不清日志：核心链路（/apply、/api/balance、/api/plans）的记录要留到 8.5 一起核对，
  // 这里只按「点击前后的新增条目」切片。
  const logBeforeRefresh = (await ctl('/__log')).count
  check('点「刷新额度」/「Refresh」', (await click(cdp, '[data-testid="ours-quota-refresh"]')) === 'ok')
  const quotaAfter = await waitFor(
    cdp,
    '[data-testid="ours-quota-value"]',
    (text) => text.includes('100 积分') && text.includes('¥1.00'),
    20000
  )
  check('显示 100 积分 + 约可消费 ¥1.00', (quotaAfter ?? '').includes('¥1.00'), quotaAfter ?? 'null')
  await sleep(600)
  const logAfterRefresh = await ctl('/__log')
  const newEntries = logAfterRefresh.entries.slice(logBeforeRefresh)
  const meCalls = newEntries.filter((entry) => entry.path === '/me')
  check('「查询额度」打的是邀请服务 /me', meCalls.length > 0, `${meCalls.length} 次`)
  check(
    '/me 只有 device_id 一个 query 参数，不带 Key',
    meCalls.length > 0 &&
      meCalls.every(
        (entry) =>
          /^\?device_id=[^&]*$/.test(entry.query) &&
          entry.urlHasKeyParam === false &&
          entry.urlLeaksMockKey === false
      ),
    JSON.stringify(meCalls.map((entry) => entry.query))
  )
  check(
    '/me 的 URL 里没有 Authorization（凭据只走 header 的接口才带）',
    meCalls.every((entry) => entry.auth.present === false),
    JSON.stringify(meCalls.map((entry) => entry.auth))
  )
  await shots(cdp, '02-quota-refresh', '[data-testid="ours-quota"]')

  // ── 5. 套餐区（来自 mock /api/plans）─────────────────────────────
  console.log('\n[5] 套餐区')
  const p1 = await textOf(cdp, '[data-testid="ours-plan-p1"]')
  const p2 = await textOf(cdp, '[data-testid="ours-plan-p2"]')
  check('p1 显示 ¥3.00 / 300 积分', (p1 ?? '').includes('¥3.00') && (p1 ?? '').includes('300 积分'), p1 ?? 'null')
  check(
    'p2 显示 ¥39.00 / 3900 积分',
    (p2 ?? '').includes('¥39.00') && (p2 ?? '').replace(/[,，]/g, '').includes('3900 积分'),
    p2 ?? 'null'
  )
  await scrollTo(cdp, '[data-testid="ours-plans"]')
  await shots(cdp, '03-plans', '[data-testid="ours-plans"]')

  // ── 6. 兑换 MOCK-OK：到账成功 + 额度自动刷新 400 ─────────────────
  console.log('\n[6] 卡密兑换 MOCK-OK（mock 后端）')
  check('填 MOCK-OK', (await fill(cdp, '[data-testid="ours-redeem-input"]', 'MOCK-OK')) === 'MOCK-OK')
  check('点「兑换」', (await click(cdp, '[data-testid="ours-redeem-submit"]')) === 'ok')
  const redeemOk = await waitFor(
    cdp,
    '[data-testid="ours-redeem-result"]',
    (text) => /兑换成功|Redeemed|处理中|pending|失败|failed/i.test(text),
    30000
  )
  check('显示「兑换成功，+300 积分」', matches(redeemOk, /兑换成功|Redeemed/i), redeemOk ?? 'null')
  check('文案里带「约可消费 ¥3.00」/+300', (redeemOk ?? '').includes('¥3.00') && (redeemOk ?? '').includes('300'), redeemOk ?? 'null')
  const quota400 = await waitFor(
    cdp,
    '[data-testid="ours-quota-value"]',
    (text) => text.includes('400 积分'),
    25000
  )
  check('额度自动刷新为 400 积分（¥4.00）', (quota400 ?? '').includes('400 积分'), quota400 ?? 'null')
  await scrollTo(cdp, '[data-testid="ours-redeem"]')
  await shots(cdp, '04-redeem-ok-400', '[data-testid="ours-redeem"]')

  // ── 7. 重复兑换：409 CARD_ALREADY_USED ──────────────────────────
  console.log('\n[7] 同一张卡再兑换（409）')
  check('再填 MOCK-OK', (await fill(cdp, '[data-testid="ours-redeem-input"]', 'MOCK-OK')) === 'MOCK-OK')
  check('点「兑换」', (await click(cdp, '[data-testid="ours-redeem-submit"]')) === 'ok')
  const usedText = await waitFor(
    cdp,
    '[data-testid="ours-redeem-result"]',
    (text) => /已被使用|already used|失败|failed/i.test(text),
    20000
  )
  check('显示「该卡密已被使用」', matches(usedText, /已被使用|already used/i), usedText ?? 'null')
  await shots(cdp, '05-redeem-409-used', '[data-testid="ours-redeem"]')

  // ── 8. 不存在的卡密：404 CARD_NOT_FOUND ─────────────────────────
  console.log('\n[8] 不存在的卡密 MOCK-BAD（404）')
  check('填 MOCK-BAD', (await fill(cdp, '[data-testid="ours-redeem-input"]', 'MOCK-BAD')) === 'MOCK-BAD')
  check('点「兑换」', (await click(cdp, '[data-testid="ours-redeem-submit"]')) === 'ok')
  const notFound = await waitFor(
    cdp,
    '[data-testid="ours-redeem-result"]',
    (text) => /卡密不存在|not found|失败|failed/i.test(text),
    20000
  )
  check('显示「卡密不存在」', matches(notFound, /卡密不存在|not found/i), notFound ?? 'null')
  await shots(cdp, '06-redeem-404-notfound', '[data-testid="ours-redeem"]')

  // ── 8.5 mock 侧请求日志核对（核心链路，一次性看全程）─────────────
  console.log('\n[8.5] mock 侧请求日志核对（领取 / 查询 / 套餐 / 兑换）')
  const coreLog = await ctl('/__log')
  const core = coreLog.entries
  const byPath = (path) => core.filter((entry) => entry.path === path)
  console.log(`     共 ${core.length} 条请求`)
  for (const entry of core) {
    console.log(
      `     ${entry.method} ${entry.path}${entry.query} → ${entry.status}` +
        `${entry.auth.present ? ' [auth]' : ''}${entry.note ? ` (${entry.note})` : ''}`
    )
  }
  check('POST /apply 拿到 201（首次绑定）', byPath('/apply').some((entry) => entry.status === 201), JSON.stringify(byPath('/apply').map((e) => e.status)))
  const balanceCalls = byPath('/api/balance')
  check('/api/balance 确实被调用（Key 校验）', balanceCalls.length > 0, `${balanceCalls.length} 次`)
  check(
    '/api/balance 每次都带 Authorization: Bearer',
    balanceCalls.length > 0 && balanceCalls.every((entry) => entry.auth.isBearer === true),
    JSON.stringify(balanceCalls.map((entry) => entry.auth))
  )
  check(
    '/api/balance 的 URL 没有 query（Key 只走 header）',
    balanceCalls.every((entry) => entry.query === ''),
    JSON.stringify(balanceCalls.map((entry) => entry.query))
  )
  check('GET /api/plans 被调用（套餐价格来自服务端）', byPath('/api/plans').length > 0, `${byPath('/api/plans').length} 次`)
  const redeemCalls = byPath('/api/redeem')
  check(
    '三次兑换分别是 200 / 409 / 404',
    redeemCalls.map((entry) => entry.status).join(',') === '200,409,404',
    JSON.stringify(redeemCalls.map((entry) => `${entry.status}|${entry.note}`))
  )
  check(
    '/api/redeem 的 URL 没有 query（卡密与 Key 都在 body）',
    redeemCalls.every((entry) => entry.query === ''),
    JSON.stringify(redeemCalls.map((entry) => entry.query))
  )
  check(
    '完整的请求日志里没有任何一条把 Key 放进 URL',
    core.every((entry) => entry.urlHasKeyParam === false && entry.urlLeaksMockKey === false),
    core
      .filter((entry) => entry.urlHasKeyParam || entry.urlLeaksMockKey)
      .map((entry) => `${entry.method} ${entry.path}`)
      .join(' | ')
  )
  // 脱敏格式固定是「•••• + 尾 6 位」（8 个字符）；任何更长的尾巴都说明漏了完整 Key
  const maskedOk = (tail) => tail === '' || /^••••.{1,6}$/.test(tail)
  check(
    '日志里 Key 只留尾 6 位（••••xxxxxx）',
    core.every((entry) => maskedOk(entry.auth.keyTail ?? '')),
    JSON.stringify(core.filter((entry) => !maskedOk(entry.auth.keyTail ?? '')).map((e) => e.path))
  )

  // ── 9. 隐私：DOM 里不出现完整 Key ───────────────────────────────
  console.log('\n[9] 隐私与整洁性')
  const leaked = await cdp.evaluate(`(() => {
    const html = document.documentElement.outerHTML
    const text = document.body.innerText
    return {
      html: /sk-mock-d\\d+mock01/.test(html),
      text: /sk-mock-d\\d+mock01/.test(text),
      headerLike: /sk-[A-Za-z0-9-]{8,}/.test(text),
    }
  })()`)
  check('DOM 文本里没有完整 Key', leaked.text === false && leaked.headerLike === false, JSON.stringify(leaked))
  check('DOM HTML 里没有完整 Key', leaked.html === false, String(leaked.html))

  // ── 10. 购买入口：原生路径 + 拿不到 Location 的可读提示（不付款）──
  console.log('\n[10] 「去支付」原生路径（不真付款）')
  await ctl('/__control/buy-mode', { mode: 'no-location' })
  await ctl('/__control/clear-log', {})
  check('选套餐 p1', (await click(cdp, '[data-testid="ours-plan-p1"]')) === 'ok')
  check('点「去支付」/「Pay」', (await click(cdp, '[data-testid="ours-buy"]')) === 'ok')
  const noticeNoLoc = await waitFor(
    cdp,
    '[data-testid="ours-pay-notice"]',
    (text) => /拿不到收银台地址|cannot read the checkout url|网络|network|超时|timed out/i.test(text),
    30000
  )
  check(
    '拿不到 Location 时给可读提示（不猜单号、不付款）',
    matches(noticeNoLoc, /拿不到收银台地址|cannot read the checkout url/i),
    noticeNoLoc ?? 'null'
  )
  const buyLog = await ctl('/__log')
  const buyCalls = buyLog.entries.filter((entry) => entry.path === '/buy')
  check('确实请求了 /buy?plan=p1（原生读 302）', buyCalls.length > 0, `${buyCalls.length} 次`)
  await scrollTo(cdp, '[data-testid="ours-plans"]')
  await shots(cdp, '07-buy-no-location', '[data-testid="ours-plans"]')

  // 302 带 Location 时：应交给系统浏览器打开（这里 Location 指向 example.com，不会真付款）
  await ctl('/__control/buy-mode', { mode: 'redirect' })
  await ctl('/__control/clear-log', {})
  check('再点「去支付」/「Pay」', (await click(cdp, '[data-testid="ours-buy"]')) === 'ok')
  await sleep(6000)
  const noticeRedirect = await textOf(cdp, '[data-testid="ours-pay-notice"]')
  const resumed = sh('shell', 'dumpsys', 'activity', 'activities').match(/mResumedActivity.*/)?.[0] ?? ''
  const browserOpened = /browser|chrome|CustomTab/i.test(resumed)
  console.log(`     提示文案：${noticeRedirect ?? 'null'}`)
  console.log(`     前台 Activity：${resumed.slice(0, 120)}`)
  const viewIntent = sh('logcat', '-d', '-t', '2000')
    .split('\n')
    .filter((line) => /ACTION_VIEW|android\.intent\.action\.VIEW|START u0.*VIEW/i.test(line))
    .slice(-3)
  for (const line of viewIntent) console.log(`     logcat: ${line.slice(0, 160)}`)
  check(
    '302 带 Location 时交给系统浏览器打开（不内嵌 WebView、不付款）',
    browserOpened,
    resumed.slice(0, 160)
  )
  const buyLog2 = await ctl('/__log')
  const orderCalls = buyLog2.entries.filter((entry) => entry.path === '/api/order')
  console.log(
    `     /api/order 轮询 ${orderCalls.length} 次（mock 没有真实订单，所以订单区显示「订单不存在」）`
  )
  // 回到 App，确认没崩、界面还能用
  sh('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`)
  await sleep(3000)
  check(
    '回到 App 后弹层仍在、无崩溃',
    await cdp.evaluate(`!!document.querySelector('[data-testid="ours-services-dialog"]')`)
  )
  await shots(cdp, '08-after-buy-return', '[data-testid="ours-services-dialog"]')

  // ── 11. 服务端请求日志核对（mock 侧断言）────────────────────────
  console.log('\n[11] mock 侧请求日志核对')
  const fullLog = await ctl('/__log')
  const entries = fullLog.entries
  console.log(`     共 ${entries.length} 条请求`)
  const summary = {}
  for (const entry of entries) {
    const key = `${entry.method} ${entry.path} → ${entry.status}${entry.note ? ` (${entry.note})` : ''}`
    summary[key] = (summary[key] ?? 0) + 1
  }
  for (const [key, count] of Object.entries(summary)) console.log(`     ${key} ×${count}`)
  check(
    '任何请求的 URL 都没有把 Key 放进 query',
    entries.every((entry) => entry.urlHasKeyParam === false && entry.urlLeaksMockKey === false),
    entries
      .filter((entry) => entry.urlHasKeyParam || entry.urlLeaksMockKey)
      .map((entry) => `${entry.method} ${entry.path}`)
      .join(' | ')
  )
  check(
    '没有任何请求带完整 Key 的日志（日志里只有 tail）',
    entries.every((entry) => (entry.auth.keyTail ?? '').length <= 6),
    JSON.stringify(entries.filter((entry) => (entry.auth.keyTail ?? '').length > 6).map((e) => e.path))
  )

  // ── 12. 崩溃 / console error / 截图 ─────────────────────────────
  console.log('\n[12] 运行时整洁性')
  // 基线噪声：Capacitor 自己注入 safe-area CSS 时抛的 TypeError，启动时固定 3 条，
  // 已在 docs/ui/apk-report.md 记录为「非致命」，与本任务改动无关（不属于本次回归）。
  const BASELINE_NOISE = /Error injecting safe area CSS/
  const baselineNoise = consoleErrors.filter((text) => BASELINE_NOISE.test(text))
  const realErrors = consoleErrors.filter((text) => !BASELINE_NOISE.test(text))
  console.log(
    `     console error 共 ${consoleErrors.length} 条：基线噪声（safe-area CSS）${baselineNoise.length} 条，本次新增 ${realErrors.length} 条`
  )
  check(
    '除已记录的基线条目外，WebView console error = 0',
    realErrors.length === 0,
    realErrors.join(' | ').slice(0, 500)
  )
  const logcat = sh('logcat', '-d', '-t', '4000')
  const crashes = logcat
    .split('\n')
    .filter((line) => /FATAL EXCEPTION|ANR in com\.example\.deepseekchat/i.test(line))
  check('无崩溃 / ANR', crashes.length === 0, crashes.join(' | ').slice(0, 300))

  resetDisplay()
  cdp.socket.close()

  console.log(`     截图目录：${SHOT_DIR}`)

  if (failures.length > 0) {
    console.error(`\nFAIL 真机（mock 后端）额度与卡密 UI：${failures.length} 条断言失败`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  console.log('\nPASS 真机（mock 后端）额度与卡密 UI 全链路')
}

await run()
