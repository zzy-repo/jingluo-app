// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假后端 + 内存凭据存储） | Issue #740 第一步（行为层）]
//
// **401 → 单飞刷新 → 重放**，以及 token 清理 / 切号规则。**不碰存储介质**（还是 `AuthTokenStorage`
// seam + 默认 localStorage）：安全存储等 #740-②（要新增原生依赖，维护者未放行），刻意不测。
//
// 被测的是**真接缝**，不是自造的假实现：
//   `createConsumeClient({ transport: 假后端, accessToken: getAccessToken, onUnauthorized: handleUnauthorized })`
//     → `createAuthTransport(...)` → `setAuthTransport(...)`（与 `src/consumeClient.ts` / `main.tsx` 同一条接线）
// 假后端只回**实测过的响应形状**（面板信封 `{code,message,data}`、中间件 `{code:"UNAUTHORIZED"}`、
// 面板业务码 `{code:401,reason:"REFRESH_TOKEN_EXPIRED"}`），用例断言的因此是「真代码跑出来的行为」。
//
// 覆盖（任务书那 8 行，逐行对应）：
//   [1] 业务请求 401 → 刷新成功 → 重放成功：最终 200，刷新**只 1 次**
//   [2] **5 个并发请求同时 401**：刷新**只 1 次**，5 个都重放成功（单飞）
//   [3] 刷新返回 401：清态、**不重放**、回登录态
//   [4] 刷新返回 `REFRESH_TOKEN_EXPIRED`：清态
//   [5] 刷新返回 500 / 网络错：**不清态**、可重试
//   [6] 重放后仍 401：不再刷新（不死循环），返回 401
//   [7] `/auth/login` 本身 401：**不触发刷新**（登录失败不该清本地会话）
//   [8] 切号：A 退出 → 登 B：A 的缓存键全部被清
// 另加两条静态自查（#740 硬约束）：token 零日志命中、token 不进 URL query。
//
// 负向对照（见 PR）：把单飞改成「每次 401 都刷新」→ 第 [2] 行必须红（刷新次数 >1）；还原 → 绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  createTokenStorage,
  resetAuthStore,
  setupAuthPanels,
} from '../helpers/auth-panels-env.mjs'

await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const {
  getAccessToken,
  getAuthSnapshot,
  handleUnauthorized,
  refreshSessionOnce,
  setAuthTokenStorage,
  setAuthTransport,
  useAuthStore,
} = await import('../../src/services/auth/store.ts')
const { readCachedCustomerId, cacheCustomerId } = await import('../../src/services/ours/customerId.ts')
const { registerSessionCache, sessionCacheNames, unregisterSessionCache } = await import(
  '../../src/services/auth/sessionCache.ts'
)

const ROOT = path.resolve(import.meta.dirname, '../..')

/** 端点覆盖：单测不发真请求，只借 `http.ts` 的前缀校验（base 必须是合法绝对地址） */
const ENDPOINTS = {
  baseUrl: 'https://consume.test.invalid',
  apiV1Prefix: '/api/v1',
  gatewayPrefix: '/v1',
  timeoutMs: { read: 1_000, write: 1_000, redeem: 1_000 },
}

const USER_A = { id: 1, email: 'a@mock.local', emailVerified: true }
const USER_B = { id: 2, email: 'b@mock.local', emailVerified: true }

const OLD_TOKEN = { accessToken: 'at-old', refreshToken: 'rt-old', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000 }
const NEW_TOKEN = { accessToken: 'at-new', refreshToken: 'rt-new', tokenType: 'Bearer', expiresAt: Date.now() + 7200_000 }

// ------------------------------------------------------------------ 假后端（只回实测形状）

const json = (status, body) => ({
  kind: 'response',
  status,
  text: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})
/** 面板成功信封（实测：`{code:0,message:"success",data:{…}}`） */
const panelOk = (data) => json(200, { code: 0, message: 'success', data })
/** 中间件 401（实测：`{code:"UNAUTHORIZED",message:"…"}`，**不是**面板整数 code） */
const unauthorized = () => json(401, { code: 'UNAUTHORIZED', message: 'invalid or expired token' })
const serverError = () => json(500, { code: 'INTERNAL_ERROR', message: 'database is down' })
const networkFailure = () => ({ kind: 'network' })

/** 刷新成功体：**完整一对 token**（可能轮换 refresh_token，#740 ③） */
const refreshOk = () =>
  panelOk({ access_token: NEW_TOKEN.accessToken, refresh_token: NEW_TOKEN.refreshToken, expires_in: 7200, token_type: 'Bearer' })

/** 刷新被服务端拒（面板业务码：实测 `{code:401,message,reason:"REFRESH_TOKEN_INVALID"}` 同形） */
const refreshExpired = () => json(401, { code: 401, message: 'refresh token expired', reason: 'REFRESH_TOKEN_EXPIRED' })

/**
 * 假后端：按路径分派 + **记下每一次请求**（`calls.refresh` 的条数就是「刷新打了几次」）。
 *
 * 业务路径（`/api/v1/keys`，卡密列表）默认行为：拿 `at-old` 回 401、拿 `at-new` 回 200 ——
 * 这样「重放是否真的带了新 token」也被顺带钉住了。
 * `login` 默认成功（回 B 的会话），[7] 那行要「登录自己 401」时显式覆盖。
 */
const createBackend = ({ refresh = refreshOk, business, login } = {}) => {
  const calls = { refresh: [], business: [], all: [] }
  const businessReply =
    business ??
    ((authorization) =>
      authorization === `Bearer ${NEW_TOKEN.accessToken}` ? panelOk({ items: [], total: 0, page: 1 }) : unauthorized())
  const loginReply =
    login ??
    (() =>
      panelOk({
        access_token: 'at-b',
        refresh_token: 'rt-b',
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: USER_B.id, email: USER_B.email },
      }))
  const transport = async (request) => {
    const { pathname, search } = new URL(request.url)
    const authorization = request.headers.authorization ?? ''
    calls.all.push({ method: request.method, path: pathname, search, authorization, body: request.body })
    if (pathname === '/api/v1/auth/refresh') {
      calls.refresh.push({ authorization, search, body: request.body })
      return refresh()
    }
    if (pathname === '/api/v1/auth/login') {
      return loginReply()
    }
    if (pathname === '/api/v1/auth/revoke-all-sessions') {
      return panelOk({ message: 'ok' })
    }
    calls.business.push({ path: pathname, authorization })
    return businessReply(authorization, calls.business.length)
  }
  return { transport, calls }
}

const storage = createTokenStorage()
setAuthTokenStorage(storage.storage)

/** 装一个「已经登录」的现场 + 与 `src/consumeClient.ts` 相同的一条接线 */
const installSession = (backend, { token = OLD_TOKEN, user = USER_A } = {}) => {
  storage.reset()
  storage.seed(token, user)
  resetAuthStore(useAuthStore)
  useAuthStore.setState({ state: 'authenticated', token, user, restored: true })
  const consume = createConsumeClient({
    transport: backend.transport,
    endpoints: ENDPOINTS,
    accessToken: getAccessToken,
    onUnauthorized: handleUnauthorized,
  })
  setAuthTransport(createAuthTransport(consume))
  return consume
}

// ------------------------------------------------------------------ [1][3][4][5][6] 表驱动

const ROWS = [
  {
    label: '[1] 业务请求 401 → 刷新成功 → 重放成功：最终 200，刷新只 1 次',
    refresh: refreshOk,
    entry: (consume) => consume.keys.list({ page: 1 }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, true, '重放应该拿到 200')
      assert.deepEqual(result.data.items, [])
      assert.equal(backend.calls.refresh.length, 1, '刷新只该发生 1 次')
      assert.equal(backend.calls.business.length, 2, '原请求 + 重放 = 2 次（不是 3 次，不许循环）')
      assert.equal(backend.calls.business[0].authorization, 'Bearer at-old', '第一次用的是旧 token')
      assert.equal(backend.calls.business[1].authorization, 'Bearer at-new', '重放必须用刷新后的 token')
      assert.equal(snapshot.state, 'authenticated')
      assert.equal(snapshot.token.accessToken, 'at-new')
    },
  },
  {
    label: '[3] 刷新返回 401：清态、不重放、回登录态',
    refresh: () => json(401, { code: 'UNAUTHORIZED', message: 'refresh token is not valid' }),
    entry: (consume) => consume.keys.list({ page: 1 }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.status, 401, '交上去的仍是原 401')
      assert.equal(result.error.retryable, false, '凭据没了就不该提示“重试”')
      assert.equal(backend.calls.refresh.length, 1)
      assert.equal(backend.calls.business.length, 1, '刷新失败不许重放')
      assert.equal(snapshot.state, 'expired', '刷新被拒 = 会话失效 → 回登录态')
      assert.equal(snapshot.token, null)
      assert.equal(storage.value, null, '落盘凭据必须一起清')
    },
  },
  {
    label: '[4] 刷新返回 REFRESH_TOKEN_EXPIRED：清态',
    refresh: refreshExpired,
    entry: (consume) => consume.keys.list({ page: 1 }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.status, 401, '交上去的仍是原 401（业务请求没有别的错）')
      assert.equal(
        snapshot.error?.code,
        'REFRESH_TOKEN_EXPIRED',
        '刷新被拒的**具体原因**要留在快照里（排查是“过期”还是“被吊销”，但不上屏）'
      )
      assert.equal(backend.calls.refresh.length, 1)
      assert.equal(backend.calls.business.length, 1, '刷新失败不许重放')
      assert.equal(snapshot.state, 'expired')
      assert.equal(storage.writes.at(-1), null, '清态必须真的落盘清掉')
    },
  },
  {
    label: '[5a] 刷新返回 500：不清态、可重试',
    refresh: serverError,
    entry: (consume) => consume.keys.list({ page: 1 }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.status, 401, '对外仍是原 401')
      assert.equal(result.error.retryable, true, '刷新是服务端故障 → 这次 401 可重试（唯一的例外）')
      assert.equal(backend.calls.refresh.length, 1)
      assert.equal(backend.calls.business.length, 1, '刷新没成功就没什么可重放的')
      assert.equal(snapshot.state, 'authenticated', '服务端 5xx 不许把人踢下线')
      assert.equal(snapshot.token.accessToken, 'at-old', 'token 必须保留')
      assert.equal(storage.parsed.token.accessToken, 'at-old', '落盘凭据也不许被清')
    },
  },
  {
    label: '[5b] 刷新遇到网络错误：不清态、可重试',
    refresh: networkFailure,
    entry: (consume) => consume.keys.list({ page: 1 }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.retryable, true)
      assert.equal(backend.calls.refresh.length, 1)
      assert.equal(snapshot.state, 'authenticated')
      assert.equal(storage.parsed.token.accessToken, 'at-old')
    },
  },
  {
    label: '[6] 重放后仍 401：不再刷新（不死循环），返回 401',
    refresh: refreshOk,
    entry: (consume) => consume.keys.list({ page: 1 }),
    business: () => unauthorized(),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.status, 401)
      assert.equal(result.error.retryable, false, '重放也 401 = 凭据真的不认，不是“稍后重试”')
      assert.equal(backend.calls.refresh.length, 1, '重放后的 401 不许再触发刷新')
      assert.equal(backend.calls.business.length, 2, '只重放一次')
      assert.equal(snapshot.state, 'authenticated', 'token 本身是新的（刷新成功过），不该在这里清态')
    },
  },
  {
    label: '[7] /auth/login 本身 401：不触发刷新',
    refresh: refreshOk,
    login: () => json(401, { code: 'INVALID_CREDENTIALS', message: 'email or password is wrong' }),
    entry: (consume) => consume.auth.login({ email: 'a@mock.local', password: 'wrong-password' }),
    verify: ({ result, backend, snapshot }) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.status, 401)
      assert.equal(backend.calls.refresh.length, 0, '登录失败不是会话过期：一次刷新都不许发')
      assert.equal(backend.calls.business.length, 0, '也没有业务请求可重放')
      assert.equal(snapshot.state, 'unauthenticated', '登录失败停在未登录，不许把它当“token 过期”')
      assert.equal(snapshot.token, null)
    },
  },
]

test('L1 #740 ①：401 换凭据 / 重放 / 清理（表驱动）', async (t) => {
  for (const row of ROWS) {
    await t.test(row.label, async () => {
      const backend = createBackend({ refresh: row.refresh, business: row.business, login: row.login })
      // [7] 是「还没登录就点登录」：不预置会话
      const consume = row.label.startsWith('[7]') ? installAnonymous(backend) : installSession(backend)

      const result = await row.entry(consume)

      row.verify({ result, backend, snapshot: getAuthSnapshot() })
    })
  }
})

/** [7] 用的现场：没有本地会话，只有一条接线（登录页的真实状态） */
const installAnonymous = (backend) => {
  storage.reset()
  resetAuthStore(useAuthStore)
  const consume = createConsumeClient({
    transport: backend.transport,
    endpoints: ENDPOINTS,
    accessToken: getAccessToken,
    onUnauthorized: handleUnauthorized,
  })
  setAuthTransport(createAuthTransport(consume))
  return consume
}

// ------------------------------------------------------------------ [2] 单飞（并发 401）

test('L1 #740 ②：5 个并发请求同时 401 → 只发 1 次 /auth/refresh，5 个都重放成功', async () => {
  const backend = createBackend({ refresh: refreshOk })
  const consume = installSession(backend)

  const results = await Promise.all([
    consume.keys.list({ page: 1 }),
    consume.keys.list({ page: 2 }),
    consume.keys.list({ page: 3 }),
    consume.keys.list({ page: 4 }),
    consume.keys.list({ page: 5 }),
  ])

  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, true, true, true],
    '5 个请求都必须重放成功'
  )
  assert.equal(backend.calls.refresh.length, 1, '并发 401 必须合并成一次刷新（单飞）')
  assert.equal(backend.calls.business.length, 10, '5 个原请求 + 5 个重放')
  const replays = backend.calls.business.filter((call) => call.authorization === 'Bearer at-new')
  assert.equal(replays.length, 5, '5 个重放都该用同一份新 token')
})

// ------------------------------------------------- 退出时刷新恰好在飞（#740 ④ 的边界）

test('L1 #740 ④：刷新在飞时用户点了退出 → 迟到的刷新不许把人登回去', async () => {
  /** 一个可以「晚点再回」的刷新：模拟「token 过期请求刚发出刷新，用户立刻点退出」 */
  let releaseRefresh
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  const backend = createBackend({
    refresh: async () => {
      await refreshGate
      return refreshOk()
    },
    // 退出时的 `revoke-all-sessions` 会回查一次 `/user/profile` 来确认撤销：这里让它回 200
    // （「未确认」分支），避免这条回查自己再引发一次刷新 —— 本行只验「迟到的刷新不许复活会话」。
    business: () => panelOk({ items: [], total: 0 }),
  })
  installSession(backend)

  const pending = refreshSessionOnce()
  // 刷新还在路上（后端卡在 gate 上）时退出：清态 + 清缓存
  await useAuthStore.getState().signOut()
  assert.equal(storage.value, null, '前提：退出确实清了落盘凭据')

  // 现在放行那次迟到的刷新
  releaseRefresh()

  assert.equal(await pending, 'expired', '迟到的刷新按「会话已经没了」返回，不重放')
  assert.equal(storage.value, null, '退出之后，迟到的刷新**不许**把凭据写回去')
  assert.equal(useAuthStore.getState().token, null, '内存里也不许复活')
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
})

// ------------------------------------------------------------------ [8] 切号

test('L1 #740 ④：A 退出 → 登 B，A 的缓存键全部被清', async () => {
  // 一个「余额 / 卡密 / 消费记录」形状的账号级缓存（真缓存没有持久层，这里用登记表验证清空链路）
  let fakeBalance = 'A 的余额：99 元'
  registerSessionCache({
    name: 'fake-account-balance',
    purge: () => {
      fakeBalance = ''
    },
  })
  try {
    const backend = createBackend({ refresh: refreshOk })
    installSession(backend)

    // A 的设备上真实存在的那份账号级缓存：cid（`chat-demo:ours-customer-id`）
    cacheCustomerId(42)
    assert.equal(readCachedCustomerId(), 42, '前提：A 的 cid 已经缓存住了')
    assert.ok(sessionCacheNames().includes('ours-customer-id'), '真实的 cid 缓存必须登记在册')
    assert.equal(fakeBalance, 'A 的余额：99 元', '前提：账号级缓存里有 A 的数据')

    // A 点退出：先调服务端作废会话，再清本地
    await useAuthStore.getState().signOut()

    assert.equal(
      backend.calls.all.filter((call) => call.path === '/api/v1/auth/revoke-all-sessions').length,
      1,
      '退出要先让服务端作废会话（revoke-all-sessions；实测 /auth/logout 是 502，见 #676 D-676-2）'
    )
    assert.equal(storage.value, null, 'access + refresh 一起清（同一个落盘键）')
    assert.equal(useAuthStore.getState().user, null, 'A 的用户信息不许留在内存快照里')
    assert.equal(useAuthStore.getState().state, 'unauthenticated')
    assert.equal(readCachedCustomerId(), null, 'A 的 cid 缓存必须清掉')
    assert.equal(fakeBalance, '', '账号级缓存里的余额必须清掉')

    // B 登录（同一个后端，login 回 B 的会话）
    const signedIn = await useAuthStore.getState().signIn({ email: 'b@mock.local', password: 'ok' })
    assert.equal(signedIn.ok, true, 'B 能正常登录')
    assert.equal(getAuthSnapshot().user.email, 'b@mock.local', '界面看到的是 B')
    assert.equal(storage.parsed.user.email, 'b@mock.local', '落盘的用户信息是 B')
    assert.equal(storage.parsed.token.accessToken, 'at-b', '落盘凭据是 B 的')
    assert.equal(readCachedCustomerId(), null, 'B 看不到 A 的 cid')
    assert.equal(fakeBalance, '', 'B 看不到 A 的余额缓存')
  } finally {
    unregisterSessionCache('fake-account-balance')
  }
})

// ------------------------------------------------------------------ 硬约束静态自查

/** 本次改动涉及的源文件（token 只该在这几个文件里流动） */
const TOUCHED = [
  'src/services/auth/store.ts',
  'src/services/auth/sessionCache.ts',
  'src/services/auth/accountCaches.ts',
  'src/services/auth/transport.ts',
  'src/services/consume/http.ts',
  'src/services/consume/index.ts',
  'src/services/consumeClient.ts',
]

test('L1 #740 红线：token 零日志命中（#387 脱敏口径）', () => {
  // 同一行里既有「写日志 / 埋点」的调用、又有 token 类标识符 → 红。
  const LOGGING = /\b(console\.\w+|record|recordAction|recordError|__log)\s*\(/u
  const TOKENISH = /\b(accessToken|refreshToken|access_token|refresh_token|token|jwt|bearer)\b/iu
  const offenders = []
  for (const relative of TOUCHED) {
    const lines = readFileSync(path.join(ROOT, relative), 'utf8').split(/\r?\n/u)
    lines.forEach((line, index) => {
      if (LOGGING.test(line) && TOKENISH.test(line)) {
        offenders.push(`${relative}:${index + 1}  ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(offenders, [], 'token 不许进日志 / 诊断 / 埋点')
})

test('L1 #740 红线：token 不进 URL query（只走 Authorization 头 / 请求体）', async () => {
  const backend = createBackend({ refresh: refreshOk })
  const consume = installSession(backend)

  await consume.keys.list({ page: 1 })

  const refreshCall = backend.calls.refresh[0]
  assert.ok(refreshCall, '前提：这次确实刷新了')
  assert.equal(refreshCall.search, '', '刷新请求不许带 query string')
  assert.deepEqual(JSON.parse(refreshCall.body), { refresh_token: 'rt-old' }, 'refresh_token 只进请求体')
  assert.equal(refreshCall.authorization, '', 'refresh 是公共接口，不带 Authorization')
  // 业务 query（`?page=1` 这类）是正常的；**鉴权参数**一个都不许出现（sub2api 会回 400）
  const FORBIDDEN_IN_QUERY = /(?:^|[?&])(?:key|api_key|apikey|token|access_token|refresh_token)=/iu
  for (const call of backend.calls.all) {
    assert.equal(FORBIDDEN_IN_QUERY.test(call.search), false, `${call.path} 的 URL 里不许出现鉴权参数`)
  }
})
