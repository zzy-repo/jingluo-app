#!/usr/bin/env node
/**
 * mock-sub2api 自检（零依赖，`node tools/mock-sub2api/smoke.mjs`）。
 *
 * 为什么要有它：mock 的价值是「契约的可执行版本」，那它自己就必须可执行地自证 ——
 * 端点是否都在、五种错误信封是否一字不差。改了 `server.mjs` 之后跑一遍，绿了再提。
 *
 * 端口策略（#406 的教训）：子进程用 `MOCK_SUB2API_PORT=0` 让内核分配，再从启动行里读，
 * **不写死任何端口** —— 写死端口会在「本机正好有别人的服务占着」时对着别人的产物跑绿。
 *
 * 退出码：0 全绿 / 1 有失败。
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const SERVER = new URL('./server.mjs', import.meta.url).pathname

/** 逐条断言的结果收集器 */
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  ← ${detail}` : ''}\n`)
}

/** 起 mock，等到它打印 listening 行后返回 base URL */
const startServer = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, MOCK_SUB2API_PORT: '0', MOCK_SUB2API_ENVELOPE: 'contract' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => reject(new Error(`mock 没起来:\n${output}`)), 10000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      const matched = /listening on (http:\/\/[^\s]+)/.exec(output)
      if (matched) {
        clearTimeout(timer)
        resolve({ child, base: matched[1] })
      }
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock 退出（code=${code}）:\n${output}`))
    })
  })

/** 发一个请求，返回 {status, contentType, text, json} */
const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, json, headers: response.headers }
}

const main = async () => {
  const { child, base } = await startServer()
  try {
    // ---------------------------------------------------------------- 公共
    const settings = await request(base, '/api/v1/settings/public')
    check('GET /api/v1/settings/public 200 + 面板信封', settings.status === 200 && settings.json?.code === 0 && settings.json?.message === 'success')
    check('settings.public 字段数 = 74（真实实例同值）', Object.keys(settings.json?.data ?? {}).length === 74, `实际 ${Object.keys(settings.json?.data ?? {}).length}`)
    check(
      'settings.public 三个联调开关',
      settings.json?.data?.registration_enabled === true &&
        settings.json?.data?.email_verify_enabled === false &&
        settings.json?.data?.invitation_code_enabled === true,
    )

    // ---------------------------------------------------------------- 认证
    const login = await request(base, '/api/v1/auth/login', { method: 'POST', body: { email: 'ui@mock.local', password: '12345678' } })
    const token = login.json?.data?.access_token
    check(
      'POST /api/v1/auth/login 任意邮箱+密码≥8 → token 对 + user',
      login.status === 200 &&
        typeof token === 'string' &&
        typeof login.json?.data?.refresh_token === 'string' &&
        login.json?.data?.token_type === 'Bearer' &&
        login.json?.data?.user?.email === 'ui@mock.local',
      JSON.stringify(login.json).slice(0, 160),
    )
    const shortPassword = await request(base, '/api/v1/auth/login', { method: 'POST', body: { email: 'ui@mock.local', password: 'short' } })
    check('POST /api/v1/auth/login 密码 <8 → 400 面板信封', shortPassword.status === 400 && shortPassword.json?.code === 400)

    const register = await request(base, '/api/v1/auth/register', { method: 'POST', body: { email: 'new@mock.local', password: '12345678' } })
    check('POST /api/v1/auth/register 200 + token', register.status === 200 && typeof register.json?.data?.access_token === 'string')
    const registerAgain = await request(base, '/api/v1/auth/register', { method: 'POST', body: { email: 'new@mock.local', password: '12345678' } })
    check('register 重复邮箱 → 409 + reason EMAIL_EXISTS', registerAgain.status === 409 && registerAgain.json?.reason === 'EMAIL_EXISTS')

    const sendCode = await request(base, '/api/v1/auth/send-verify-code', { method: 'POST', body: { email: 'ui@mock.local' } })
    check('POST /api/v1/auth/send-verify-code 200 + countdown', sendCode.status === 200 && sendCode.json?.data?.countdown === 60)

    const refreshed = await request(base, '/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: login.json?.data?.refresh_token } })
    check('POST /api/v1/auth/refresh 换到新 token 对', refreshed.status === 200 && typeof refreshed.json?.data?.access_token === 'string')
    const refreshAgain = await request(base, '/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: login.json?.data?.refresh_token } })
    check('refresh 用旧 refresh_token 再来一次 → 401', refreshAgain.status === 401)

    // ---------------------------------------------------------------- 账号
    const me = await request(base, '/api/v1/auth/me', { token })
    check('GET /api/v1/auth/me 200 + run_mode', me.status === 200 && me.json?.data?.email === 'ui@mock.local' && me.json?.data?.run_mode === 'standard')
    const profile = await request(base, '/api/v1/user/profile', { token })
    check('GET /api/v1/user/profile 200 + email_bound', profile.status === 200 && profile.json?.data?.email_bound === true)
    const aff = await request(base, '/api/v1/user/aff', { token })
    check('GET /api/v1/user/aff 200 + aff_code/aff_count/aff_quota', aff.status === 200 && typeof aff.json?.data?.aff_code === 'string' && aff.json?.data?.aff_count === 0)

    // ---------------------------------------------------------------- Key
    const emptyList = await request(base, '/api/v1/keys', { token })
    check('GET /api/v1/keys 空列表是正常态（items:[]）', emptyList.status === 200 && Array.isArray(emptyList.json?.data?.items) && emptyList.json?.data?.total === 0)
    const created = await request(base, '/api/v1/keys', { method: 'POST', token, body: { name: 'ui-key', quota: 0 } })
    const keyId = created.json?.data?.id
    const keyValue = created.json?.data?.key
    check('POST /api/v1/keys 200 + quota:0（=不限，不是零额度）', created.status === 200 && typeof keyValue === 'string' && keyValue.startsWith('sk-') && created.json?.data?.quota === 0)
    const got = await request(base, `/api/v1/keys/${keyId}`, { token })
    check('GET /api/v1/keys/:id 200', got.status === 200 && got.json?.data?.id === keyId)
    const patched = await request(base, `/api/v1/keys/${keyId}`, { method: 'PUT', token, body: { name: 'ui-key-renamed', status: 'inactive' } })
    check('PUT /api/v1/keys/:id 改名 + 停用', patched.status === 200 && patched.json?.data?.name === 'ui-key-renamed' && patched.json?.data?.status === 'inactive')
    const searched = await request(base, '/api/v1/keys?search=renamed', { token })
    check('GET /api/v1/keys?search= 命中', searched.json?.data?.total === 1)
    const deleted = await request(base, `/api/v1/keys/${keyId}`, { method: 'DELETE', token })
    check('DELETE /api/v1/keys/:id 200', deleted.status === 200)
    const deletedAgain = await request(base, `/api/v1/keys/${keyId}`, { method: 'DELETE', token })
    check('DELETE 已删除的 Key → 404（不当致命错）', deletedAgain.status === 404)
    const missing = await request(base, '/api/v1/keys/999999', { token })
    check('GET 不存在的 Key → 404', missing.status === 404)

    // ---------------------------------------------------------------- 用量（sk- 通道）
    const usage = await request(base, '/v1/usage', { headers: { authorization: 'Bearer sk-c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff' } })
    check('GET /v1/usage 200 且**不套 data 外壳**', usage.status === 200 && usage.json?.mode === 'quota_limited' && usage.json?.data === undefined)
    check('quota.used 恒 0', usage.json?.quota?.used === 0)
    check('真实花费在 usage.total.actual_cost', usage.json?.usage?.total?.actual_cost > 0)
    check('没有 rate_limits 键（硬 map 会崩）', !('rate_limits' in (usage.json ?? {})))
    const usageNoKey = await request(base, '/v1/usage')
    check('/v1/usage 无 Key → 401 API_KEY_REQUIRED（中间件信封）', usageNoKey.status === 401 && usageNoKey.json?.code === 'API_KEY_REQUIRED')
    const usageBadKey = await request(base, '/v1/usage', { headers: { 'x-api-key': 'sk-deadbeef' } })
    check('/v1/usage 错 Key → 401 INVALID_API_KEY', usageBadKey.status === 401 && usageBadKey.json?.code === 'INVALID_API_KEY')

    // ---------------------------------------------------------------- 卡密
    const redeemOk = await request(base, '/api/v1/redeem', { method: 'POST', token, body: { code: 'MOCK-OK-0001' } })
    check('POST /api/v1/redeem MOCK-OK-0001 成功 + new_balance', redeemOk.status === 200 && redeemOk.json?.data?.type === 'balance' && redeemOk.json?.data?.new_balance > 2)
    const redeemUsed = await request(base, '/api/v1/redeem', { method: 'POST', token, body: { code: 'MOCK-USED-0001' } })
    check('MOCK-USED-0001 → 409 + reason REDEEM_CODE_USED', redeemUsed.status === 409 && redeemUsed.json?.reason === 'REDEEM_CODE_USED')
    const redeem404 = await request(base, '/api/v1/redeem', { method: 'POST', token, body: { code: 'NOPE' } })
    check('其它卡密 → 404 + reason REDEEM_CODE_NOT_FOUND', redeem404.status === 404 && redeem404.json?.reason === 'REDEEM_CODE_NOT_FOUND')
    const history = await request(base, '/api/v1/redeem/history', { token })
    check('GET /api/v1/redeem/history 回数组（旧兼容形态）', history.status === 200 && Array.isArray(history.json?.data) && history.json.data.length === 1)
    const historyPaged = await request(base, '/api/v1/redeem/history?page=1&page_size=20', { token })
    check('history 带 page → 分页信封', historyPaged.json?.data?.total === 1)

    // ---------------------------------------------------------------- 邮箱
    const bindCode = await request(base, '/api/v1/user/account-bindings/email/send-code', { method: 'POST', token, body: { email: 'swap@mock.local' } })
    check('POST …/account-bindings/email/send-code 200', bindCode.status === 200 && bindCode.json?.data?.countdown === 60)
    const bind = await request(base, '/api/v1/user/account-bindings/email', { method: 'POST', token, body: { email: 'swap@mock.local', verify_code: '123456' } })
    check('POST …/account-bindings/email 200 + 换绑后 profile', bind.status === 200 && bind.json?.data?.email === 'swap@mock.local')
    const unbind = await request(base, '/api/v1/user/account-bindings/linuxdo', { method: 'DELETE', token })
    check('DELETE …/account-bindings/:provider 未绑定 → 404 IDENTITY_NOT_BOUND', unbind.status === 404 && unbind.json?.reason === 'IDENTITY_NOT_BOUND')

    // ---------------------------------------------------------------- 支付（apia）
    const plans = await request(base, '/api/plans')
    check('GET /api/plans 平铺 {plans:[...]}', plans.status === 200 && Array.isArray(plans.json?.plans) && plans.json?.data === undefined)
    const payLinkGet = await request(base, '/api/pay-link')
    const payLinkPost = await request(base, '/api/pay-link', { method: 'POST', body: {} })
    check('GET/POST /api/pay-link 都回 {ok,url,note}', payLinkGet.json?.ok === true && payLinkPost.json?.ok === true)
    const orders = await request(base, '/api/orders?limit=20&offset=0')
    check('GET /api/orders 200 + orders[]', orders.status === 200 && Array.isArray(orders.json?.orders) && orders.json?.customer_id === 'mock-cid-0001')
    const trail = await request(base, '/api/card/trail?card_no=MOCKCARD0001')
    check('GET /api/card/trail 200 + purchase/redemption', trail.status === 200 && trail.json?.purchase !== undefined && trail.json?.redemption !== undefined)
    const trailBad = await request(base, '/api/card/trail')
    check('GET /api/card/trail 缺 card_no → 400 BAD_INPUT（apia 信封）', trailBad.status === 400 && trailBad.json?.code === 'BAD_INPUT')

    // ---------------------------------------------------------------- 五种错误信封
    const e1 = await request(base, '/api/v1/auth/me')
    check('信封①用户 401 = {code:40101,message:"Authorization header is required"}', e1.status === 401 && e1.json?.code === 40101 && e1.json?.message === 'Authorization header is required', JSON.stringify(e1.json))
    const e2 = await request(base, '/api/v1/admin/users')
    check('信封②admin 401 = {code:40102,message:"Authorization required"}', e2.status === 401 && e2.json?.code === 40102 && e2.json?.message === 'Authorization required', JSON.stringify(e2.json))
    const e3 = await request(base, '/api/v1/auth/login?mock_error=rateLimit', { method: 'POST', body: { email: 'a@b.com', password: '12345678' } })
    check('信封③429 无 code 字段 + retry-after 头', e3.status === 429 && e3.json?.error === 'rate limit exceeded' && !('code' in (e3.json ?? {})) && e3.headers.get('retry-after') === '59', JSON.stringify(e3.json))
    const e4 = await request(base, '/api/v1/auth/me?mock_error=gateway')
    check('信封④网关 {"error":{message,type}}', e4.status === 502 && typeof e4.json?.error?.message === 'string' && typeof e4.json?.error?.type === 'string', JSON.stringify(e4.json))
    const e5 = await request(base, '/api/v1/nope')
    check('信封⑤未知路径 404 = text/plain 纯文本（不是 JSON）', e5.status === 404 && e5.contentType.startsWith('text/plain') && e5.text === '404 page not found' && e5.json === null, `${e5.contentType} ${e5.text}`)
    const e5b = await request(base, '/api/v1/settings/public?mock_error=text404')
    check('text404 开关对已知路径也生效', e5b.status === 404 && e5b.contentType.startsWith('text/plain'))
    const e6 = await request(base, '/api/v1/keys?mock_error=auth', { token })
    check('auth 开关对带 token 的请求也强制 401（逐个验错误态用）', e6.status === 401 && e6.json?.code === 40101)
    const headerSwitch = await request(base, '/api/v1/settings/public', { headers: { 'x-mock-error': 'auth' } })
    check('x-mock-error 头与 ?mock_error= 等价', headerSwitch.status === 401)
    const adminSwitch = await request(base, '/api/v1/settings/public?mock_error=admin401')
    check('admin401 开关可用', adminSwitch.status === 401 && adminSwitch.json?.code === 40102)

    // ---------------------------------------------------------------- 白名单边界
    const outside = [
      '/api/v1/device/apply',
      '/api/v1/balance',
      '/api/v1/usage',
      '/api/v1/payment/orders',
      '/api/v1/auth/login/2fa',
      '/v1/chat/completions',
    ]
    for (const path of outside) {
      const response = await request(base, path, { token })
      check(`白名单外 ${path} → text/plain 404`, response.status === 404 && response.contentType.startsWith('text/plain') && response.json === null)
    }
    // `:id` 模板会「接住」任何单段路径，所以 /keys/rotate 这种幻觉名不会被 404 ——
    // 真实实例是先按 int64 解析失败再 400，mock 同口径（这也说明白名单边界只能靠模板+类型两道）。
    const rotateLike = await request(base, '/api/v1/keys/rotate', { token })
    check('/api/v1/keys/rotate 被 :id 模板接住 → 400（id 非整数），不是 404 文本', rotateLike.status === 400 && rotateLike.json?.code === 400)
    const wrongMethod = await request(base, '/api/v1/auth/login', { token })
    check('方法不匹配（GET /auth/login）也走 text/plain 404', wrongMethod.status === 404 && wrongMethod.contentType.startsWith('text/plain'))
  } finally {
    child.kill('SIGTERM')
  }

  const failed = results.filter((item) => !item.pass)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过\n`)
  if (failed.length > 0) {
    process.stdout.write(`失败项:\n${failed.map((item) => `  - ${item.name} ${item.detail}`).join('\n')}\n`)
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`smoke 崩了: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
