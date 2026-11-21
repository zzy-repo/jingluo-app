// [layer: unit | L1 服务层 + 面板 | 依赖: 无（纯 Node + 真 createConsumeHttp + 假 transport） | Issue #679]
//
// **consume 层 6 处「只看 2xx 就算成功」→ 效果确认判据**（#660 修复 `bindEmail` 时排查出来的同类点）。
//
// 病灶一句话：判据只看 HTTP 状态，不看**效果是否可确认**。后果按严重度排：
//   · `revokeAllSessions`：告诉用户「已退出所有设备」而实际没撤销 —— **安全语义**（本单第一优先）；
//   · `deleteKey`：列表里消失了、服务端那把 Key 还活着 → 继续烧额度（**计费含义**）；
//   · `updateKey`：界面显示新值、服务端仍旧值（改额度改错 = 错算钱）；
//   · `unbindProvider`：显示已解绑、账号上仍挂着那个第三方登录入口；
//   · `sendBindEmailCode` / `sendVerifyCode` / `forgotPassword` / `resetPassword`：发码类（**例外**，
//     无可回查实体，理由登记在 `CONSUME_EFFECT_POLICIES` 里，见下面 E 组）。
//
// 五张表（全部走真 `createConsumeHttp` + 假 transport，**按 URL + method 数请求**）：
//   R 组 `revokeAllSessions`：回查 `GET /user/profile` 401 = 撤销生效；200 = 反证；回查失败 = 未知。
//   U 组 `unbindProvider`：`identities[provider].bound === false` 才算解绑成功（字段缺失 = 不知道）。
//   K 组 `updateKey`：回查 `GET /keys/:id` 的可验证字段全一致才算改动生效。
//   D 组 `deleteKey`：回查 `GET /keys/:id` 404 才算真删；200 = 还在（继续计费）。
//   E 组 发码类**例外**：2xx + 空体 → ok（**且不回查**），但例外必须在表里挂了理由。
//
// 两条元用例（本文件的价值一半在这里）：
//   · **负向对照**（`旧判据副本`）：把任一处判据改回「只看 2xx」，对应行必红 —— 这里用一份
//     「旧写法的可执行副本」当场复算同一份输入，断言它给出与期望相反的结论；
//   · **表 drift 守卫**：读源码断言「标了例外的点真的没调 `confirmEffect`」、其余点都调了。
// 断言只增不减（不改动任何既有用例）。

import { readFileSync } from 'node:fs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, zh, ButtonStub, classNames, markupOf, hasTestId, textOf } =
  await setupAuthPanels()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { revokeAllSessions, toConsumeUser } = await import('../../src/services/consume/auth.ts')
const { unbindProvider } = await import('../../src/services/consume/email.ts')
const { deleteKey, toConsumeApiKey, updateKey } = await import('../../src/services/consume/keys.ts')
const {
  confirmEffect,
  probeOnce,
  CONSUME_EFFECT_POLICIES,
  effectPolicyOf,
  unconfirmedEffectError,
} = await import('../../src/services/consume/confirmEffect.ts')
const { AccountPanelView, initialAccountState, loggedOut, reduceAccount, runLogout } =
  await import('../../src/components/consume/accountPanelModel.ts')

// ------------------------------------------------------------------ 装配

const REPLY_JSON = 'application/json'

/** 面板信封的成功体（`{code:0,message,data}`；`data` 缺省 = 200 + 空体的等价形态） */
const panelOk = (data) =>
  JSON.stringify(
    data === undefined ? { code: 0, message: 'success' } : { code: 0, message: 'success', data }
  )

const jsonReply = (status, body) => ({
  kind: 'response',
  status,
  text: body,
  headers: { 'content-type': REPLY_JSON },
})

/** 2xx + **空响应体**：本单所有病灶的共同输入 */
const emptyReply = (status) => ({ kind: 'response', status, text: '', headers: {} })

/** 中间件 401（实测形状：字符串 code，没有面板信封） */
const unauthorizedReply = () =>
  jsonReply(
    401,
    JSON.stringify({ code: 'UNAUTHORIZED', message: 'Authorization header is required' })
  )

const serverErrorReply = () =>
  jsonReply(500, JSON.stringify({ code: 500, message: 'internal error' }))

const timeoutReply = () => ({ kind: 'timeout' })

/**
 * 一条「写 + 回查」链：按 `method + URL` 分派假响应，并**数**每一次请求。
 *
 * 计数口径是本单的硬要求（回查最多一次）：`count('GET', '/user/profile')` 必须恰好 1。
 */
const chainOf = (route) => {
  const calls = []
  const http = createConsumeHttp({
    accessToken: () => 'jwt-679-test',
    transport: async (request) => {
      calls.push({ method: request.method, url: request.url, body: request.body })
      return route(request)
    },
  })
  const count = (method, needle) =>
    calls.filter((item) => item.method === method && item.url.includes(needle)).length
  return { http, calls, count }
}

// ====================================================================== R 组
// `revokeAllSessions`（安全语义，本单第一优先）
//
// 判据：服务端不给实体，所以只能「拿旧凭据去打一下」——
//   · `GET /user/profile` 401 → 凭据确实失效 → 撤销生效（唯一能自证的证据）；
//   · `GET /user/profile` 200 → **反证**：会话还在 → 未确认；
//   · 回查本身失败（500 / 超时）→ 结论未知 → 未确认（可以重试）。
// 「未确认」一律 `ok: false` + `consumeErrRevokeUnconfirmed`，界面**不许**说「已退出所有设备」。

const REVOKE_ROWS = [
  {
    what: '2xx + 空体 + 回查 profile 401 → 撤销**已确认**（凭据真的失效了）',
    revoke: emptyReply(200),
    probe: unauthorizedReply(),
    expect: { ok: true, profileCalls: 1 },
  },
  {
    what: '2xx + 空体 + 回查 profile 200 → **反证**：会话还在，判未确认（不许说「已退出所有设备」）',
    revoke: emptyReply(200),
    probe: jsonReply(200, panelOk({ id: 1, email: 'me@example.com' })),
    expect: {
      ok: false,
      i18nKey: 'consumeErrRevokeUnconfirmed',
      profileCalls: 1,
      unconfirmed: true,
    },
  },
  {
    what: '2xx + 空体 + 回查 profile 500 → 结论未知（不是成功），仍判未确认',
    revoke: emptyReply(200),
    probe: serverErrorReply(),
    expect: {
      ok: false,
      i18nKey: 'consumeErrRevokeUnconfirmed',
      profileCalls: 1,
      unconfirmed: true,
    },
  },
  {
    what: '2xx + 空体 + 回查超时（status 0）→ 结论未知，仍判未确认且标可重试',
    revoke: emptyReply(200),
    probe: timeoutReply(),
    expect: {
      ok: false,
      i18nKey: 'consumeErrRevokeUnconfirmed',
      profileCalls: 1,
      retryable: true,
      unconfirmed: true,
    },
  },
  {
    what: '撤销请求本身 401（首次就失败）→ 走既有文案，**不回查**（非 2xx 不需要确认）',
    revoke: unauthorizedReply(),
    probe: jsonReply(200, panelOk({ id: 1 })),
    expect: { ok: false, i18nKey: 'consumeErrUnauthorized', profileCalls: 0 },
  },
]

test('R 组 revokeAllSessions：2xx 之后必须回查一次 profile 才能说「撤销生效」', async (t) => {
  for (const row of REVOKE_ROWS) {
    await t.test(row.what, async () => {
      const { http, count } = chainOf((request) =>
        request.url.includes('/api/v1/user/profile') ? row.probe : row.revoke
      )
      const result = await revokeAllSessions(http)

      assert.equal(result.ok, row.expect.ok, `ok 必须是 ${row.expect.ok}`)
      if (row.expect.ok) {
        assert.equal(result.status, 200)
      } else {
        assert.equal(result.error.i18nKey, row.expect.i18nKey)
        if (row.expect.retryable !== undefined) {
          assert.equal(result.error.retryable, true, '结果未知可以重试')
        }
        if (row.expect.unconfirmed === true) {
          assert.equal(result.error.retryable, true, '结果未知可以重试')
        }
      }
      // 安全语义：**未确认**时不许出现「已退出所有设备」，文案必须给下一步
      if (row.expect.unconfirmed === true) {
        const copy = translate(result.error.i18nKey)
        assert.equal(copy.includes('未确认'), true, `文案要说清「未确认」，实际「${copy}」`)
        assert.equal(copy.includes('重新登录'), true, '文案必须给下一步：重新登录验证')
        assert.equal(copy.includes('已退出所有设备'), false, '文案不许出现「已退出所有设备」')
        assert.equal(copy.includes('已退出登录'), false, '文案不许出现「已退出登录」')
      }

      // 计数：撤销请求恰好 1 次；回查**恰好** row.profileCalls 次（一次失败不许放大成多次）
      assert.equal(
        count('POST', '/api/v1/auth/revoke-all-sessions'),
        1,
        '撤销请求只发一次（不做重试）'
      )
      assert.equal(
        count('GET', '/api/v1/user/profile'),
        row.expect.profileCalls,
        '回查 /user/profile 的次数'
      )
    })
  }
})

// ====================================================================== U 组
// `unbindProvider`
//
// 判据：`identities[provider].bound === false` 才算解绑成功。`bound` 字段**整个缺失 = 不知道**
// （#660 记下的那类错：把「不知道」当证据）。

const UNBIND_PATH = '/api/v1/user/account-bindings/email'

const UNBIND_ROWS = [
  {
    what: '2xx + 空体 + 回查 profile bound=false → 解绑已确认',
    del: emptyReply(200),
    probe: jsonReply(
      200,
      panelOk({
        id: 2,
        email: 'a@b.co',
        identities: { email: { provider: 'email', bound: false } },
      })
    ),
    expect: { ok: true, profileCalls: 1 },
  },
  {
    what: '2xx + 空体 + 回查 profile bound=true → 反证：仍是绑定的，判未确认',
    del: emptyReply(200),
    probe: jsonReply(
      200,
      panelOk({ id: 2, email: 'a@b.co', identities: { email: { provider: 'email', bound: true } } })
    ),
    expect: { ok: false, i18nKey: 'consumeErrUnbindUnconfirmed', profileCalls: 1 },
  },
  {
    what: '2xx + 空体 + 回查 profile 没有 identities → 「不知道」不算证据，判未确认',
    del: emptyReply(200),
    probe: jsonReply(200, panelOk({ id: 2, email: 'a@b.co' })),
    expect: { ok: false, i18nKey: 'consumeErrUnbindUnconfirmed', profileCalls: 1 },
  },
  {
    what: '2xx + 响应体自己带回 bound=false → 已确认，省掉回查（profile 计数 0）',
    del: jsonReply(
      200,
      panelOk({
        id: 2,
        email: 'a@b.co',
        identities: { email: { provider: 'email', bound: false } },
      })
    ),
    probe: jsonReply(
      200,
      panelOk({ id: 2, identities: { email: { provider: 'email', bound: true } } })
    ),
    expect: { ok: true, profileCalls: 0 },
  },
  {
    what: '2xx + 空体 + 回查 profile 500 → 结论未知，判未确认',
    del: emptyReply(200),
    probe: serverErrorReply(),
    expect: { ok: false, i18nKey: 'consumeErrUnbindUnconfirmed', profileCalls: 1 },
  },
]

test('U 组 unbindProvider：identities[provider].bound 没变成 false 就不算解绑成功', async (t) => {
  for (const row of UNBIND_ROWS) {
    await t.test(row.what, async () => {
      const { http, count } = chainOf((request) =>
        request.url.includes('/api/v1/user/profile') ? row.probe : row.del
      )
      const result = await unbindProvider(http, 'email')

      assert.equal(result.ok, row.expect.ok, `ok 必须是 ${row.expect.ok}`)
      if (row.expect.ok) {
        assert.equal(
          result.data.identities.email.bound,
          false,
          '成功时回调的账号主体必须是「已解绑」的'
        )
      } else {
        assert.equal(result.error.i18nKey, row.expect.i18nKey)
        const copy = translate(result.error.i18nKey)
        assert.equal(copy.includes('未确认'), true, `文案要说清「未确认」，实际「${copy}」`)
      }
      assert.equal(count('DELETE', UNBIND_PATH), 1, '解绑请求只发一次')
      assert.equal(count('GET', '/api/v1/user/profile'), row.expect.profileCalls, '回查次数')
    })
  }
})

// ====================================================================== K 组
// `updateKey`
//
// 判据：请求里带的每个**可验证**字段都要在实体上一致（name / group_id / status / quota / ip_* /
// expires_at）。`reset_quota` 是命令不是状态，回查证明不了 —— 只带它的请求按「有实体就认」处理。

const KEY_PATH = '/api/v1/keys/7'

const keyRow = (over) => ({
  id: 7,
  name: '我的第一把',
  key: 'sk-live-0123456789abcdef9f2c',
  status: 'active',
  quota: 0,
  quota_used: 0,
  ...over,
})

const UPDATE_ROWS = [
  {
    what: '改额度 2xx + 空体 + 回查 quota 已是新值 → 改动已确认',
    put: emptyReply(200),
    probe: jsonReply(200, panelOk(keyRow({ quota: 5 }))),
    input: { quota: 5 },
    expect: { ok: true, keyCalls: 1 },
  },
  {
    what: '改额度 2xx + 空体 + 回查 quota 仍是旧值 → 反证：没生效，判未确认',
    put: emptyReply(200),
    probe: jsonReply(200, panelOk(keyRow({ quota: 0 }))),
    input: { quota: 5 },
    expect: { ok: false, i18nKey: 'consumeErrUpdateUnconfirmed', keyCalls: 1 },
  },
  {
    what: '改名 2xx + 响应体自己带回新名字 → 已确认，省掉回查（GET 计数 0）',
    put: jsonReply(200, panelOk(keyRow({ name: '新名字' }))),
    probe: jsonReply(200, panelOk(keyRow({ name: '旧名字' }))),
    input: { name: '新名字' },
    expect: { ok: true, keyCalls: 0 },
  },
  {
    what: '停用 2xx + 空体 + 回查 status 仍是 active → 判未确认',
    put: emptyReply(200),
    probe: jsonReply(200, panelOk(keyRow({ status: 'active' }))),
    input: { status: 'inactive' },
    expect: { ok: false, i18nKey: 'consumeErrUpdateUnconfirmed', keyCalls: 1 },
  },
  {
    what: '改额度 2xx + 空体 + 回查 500 → 结论未知，判未确认',
    put: emptyReply(200),
    probe: serverErrorReply(),
    input: { quota: 5 },
    expect: { ok: false, i18nKey: 'consumeErrUpdateUnconfirmed', keyCalls: 1 },
  },
]

test('K 组 updateKey：回查的实体字段与请求不一致就不算改动成功', async (t) => {
  for (const row of UPDATE_ROWS) {
    await t.test(row.what, async () => {
      const { http, count } = chainOf((request) => (request.method === 'GET' ? row.probe : row.put))
      const result = await updateKey(http, 7, row.input)

      assert.equal(result.ok, row.expect.ok, `ok 必须是 ${row.expect.ok}`)
      if (row.expect.ok) {
        assert.equal(result.data.id, 7)
      } else {
        assert.equal(result.error.i18nKey, row.expect.i18nKey)
        const copy = translate(result.error.i18nKey)
        assert.equal(copy.includes('未确认'), true, `文案要说清「未确认」，实际「${copy}」`)
      }
      assert.equal(count('PUT', KEY_PATH), 1, '更新请求只发一次')
      assert.equal(count('GET', KEY_PATH), row.expect.keyCalls, '回查 GET /keys/:id 的次数')
    })
  }
})

// ====================================================================== D 组
// `deleteKey`（**有额度 / 计费含义**）
//
// 判据：`GET /keys/:id` 回 404 = 真的删了；回 200 = 还在（继续计费）→ 判未确认。
// 老的「DELETE 回 404 当已完成」规则**不变**：那是服务端明确说「目标不存在」，是证据不是猜。

const DELETE_ROWS = [
  {
    what: '删除 2xx（实测体 `{code:0,data:{message}}`）+ 回查 404 → 真删了',
    del: jsonReply(200, panelOk({ message: 'deleted' })),
    probe: jsonReply(404, JSON.stringify({ code: 404, message: 'api key not found' })),
    expect: { ok: true, keyCalls: 1 },
  },
  {
    what: '删除 2xx + 回查 200（Key 还在）→ 反证：可能继续计费，判未确认',
    del: jsonReply(200, panelOk({ message: 'deleted' })),
    probe: jsonReply(200, panelOk(keyRow({}))),
    expect: { ok: false, i18nKey: 'consumeErrDeleteUnconfirmed', keyCalls: 1 },
  },
  {
    what: '删除 2xx + 回查 500 → 结论未知，判未确认',
    del: emptyReply(200),
    probe: serverErrorReply(),
    expect: { ok: false, i18nKey: 'consumeErrDeleteUnconfirmed', keyCalls: 1 },
  },
  {
    what: '删除回 404 → 既有幂等规则不变：当「已完成」，**不回查**',
    del: jsonReply(404, JSON.stringify({ code: 404, message: 'api key not found' })),
    probe: jsonReply(200, panelOk(keyRow({}))),
    expect: { ok: true, keyCalls: 0, status: 404 },
  },
]

test('D 组 deleteKey：回查不到 404 就不算真删（额度含义）', async (t) => {
  for (const row of DELETE_ROWS) {
    await t.test(row.what, async () => {
      const { http, count } = chainOf((request) => (request.method === 'GET' ? row.probe : row.del))
      const result = await deleteKey(http, 7)

      assert.equal(result.ok, row.expect.ok, `ok 必须是 ${row.expect.ok}`)
      if (row.expect.ok) {
        if (row.expect.status !== undefined) {
          assert.equal(result.status, row.expect.status, '404 的原始状态码要留着')
        }
      } else {
        assert.equal(result.error.i18nKey, row.expect.i18nKey)
        const copy = translate(result.error.i18nKey)
        assert.equal(copy.includes('未确认'), true, `文案要说清「未确认」，实际「${copy}」`)
        assert.equal(copy.includes('费用'), true, '文案要说清「可能继续产生费用」（额度含义）')
      }
      assert.equal(count('DELETE', KEY_PATH), 1, '删除请求只发一次')
      assert.equal(count('GET', KEY_PATH), row.expect.keyCalls, '回查 GET /keys/:id 的次数')
    })
  }
})

// ====================================================================== E 组
// 发码 / 密码类**例外**（4 点）：允许只信 2xx，但必须挂理由、且**不许发明假回查**。
//
// 判据不变的部分：2xx + 空体仍然 `ok: true`（服务端确实受理了，重发无副作用）；
// 变的是**不许**让界面把它说成比事实更硬的话（文案规矩写在 `CONSUME_EFFECT_POLICIES` 的 why 里）。

test('E 组 发码类例外：2xx + 空体判成功，但**一次回查都不发**（不发明假证据）', async (t) => {
  const cases = [
    {
      what: 'sendBindEmailCode：只发 1 个请求就结束',
      call: async (http) =>
        (await import('../../src/services/consume/email.ts')).sendBindEmailCode(http, 'a@b.co'),
      method: 'POST',
      path: '/api/v1/user/account-bindings/email/send-code',
    },
    {
      what: 'sendVerifyCode：只发 1 个请求就结束',
      call: async (http) =>
        (await import('../../src/services/consume/auth.ts')).sendVerifyCode(http, {
          email: 'a@b.co',
        }),
      method: 'POST',
      path: '/api/v1/auth/send-verify-code',
    },
    {
      what: 'forgotPassword：只发 1 个请求就结束',
      call: async (http) =>
        (await import('../../src/services/consume/auth.ts')).forgotPassword(http, {
          email: 'a@b.co',
        }),
      method: 'POST',
      path: '/api/v1/auth/forgot-password',
    },
    {
      what: 'resetPassword：只发 1 个请求就结束',
      call: async (http) =>
        (await import('../../src/services/consume/auth.ts')).resetPassword(http, {
          password: 'new-pass-679',
          code: '123456',
        }),
      method: 'POST',
      path: '/api/v1/auth/reset-password',
    },
  ]
  for (const item of cases) {
    await t.test(item.what, async () => {
      const { http, calls, count } = chainOf(() => emptyReply(200))
      const result = await item.call(http)
      assert.equal(result.ok, true, '例外点：2xx + 空体仍是成功（重发无副作用）')
      assert.equal(calls.length, 1, `这一层不许额外发回查请求，实际发了 ${calls.length} 个`)
      assert.equal(count(item.method, item.path), 1)
      assert.equal(calls.filter((request) => request.method === 'GET').length, 0, '例外点没有回查')
    })
  }
})

// ====================================================================== 判据表
// 表驱动（#679 第 3 条）：每个调用点的判据 / 理由 / 例外都在 `CONSUME_EFFECT_POLICIES` 里。

const SOURCES = {
  auth: readFileSync(new URL('../../src/services/consume/auth.ts', import.meta.url), 'utf8'),
  email: readFileSync(new URL('../../src/services/consume/email.ts', import.meta.url), 'utf8'),
  keys: readFileSync(new URL('../../src/services/consume/keys.ts', import.meta.url), 'utf8'),
}

/**
 * 取某个导出符号的源码段（含它**上面那段文档注释**，到下一个顶层 `export` 为止），
 * 用来断言「这个点到底调没调 confirmEffect」。
 */
const sectionOf = (source, symbol) => {
  const at = source.indexOf(`export const ${symbol}`)
  assert.notEqual(at, -1, `源码里找不到 ${symbol}`)
  // 段的起点是**紧贴在它上面那段文档注释**（`\n/**`），不是上一个 export ——
  // 否则上一个函数的函数体会把 `confirmEffect` 之类的字样带进来，守卫就失真了。
  const comment = source.lastIndexOf('\n/**', at - 1)
  const start = comment < 0 ? at : comment + 1
  const rest = source.slice(at + 1)
  const next = rest.indexOf('\nexport ')
  const end = next >= 0 ? at + 1 + next : source.length
  return source.slice(start, end)
}

const POINT_SOURCES = {
  revokeAllSessions: ['auth', 'auth.ts'],
  sendVerifyCode: ['auth', 'auth.ts'],
  forgotPassword: ['auth', 'auth.ts'],
  resetPassword: ['auth', 'auth.ts'],
  sendBindEmailCode: ['email', 'email.ts'],
  unbindProvider: ['email', 'email.ts'],
  updateKey: ['keys', 'keys.ts'],
  deleteKey: ['keys', 'keys.ts'],
}

test('判据表：6 处的每个符号都有一条策略，且例外必须有理由、不许有回查', () => {
  assert.equal(
    CONSUME_EFFECT_POLICIES.length,
    8,
    '6 处拆成 8 个符号（#6 是 resetPassword / forgotPassword / sendVerifyCode）'
  )
  for (const point of Object.keys(POINT_SOURCES)) {
    const policy = effectPolicyOf(point)
    assert.ok(policy, `判据表里缺 ${point}`)
    assert.ok(policy.criterion.length > 10, `${point} 的判据要写清「什么叫已确认」`)
    assert.ok(policy.why.length > 40, `${point} 必须写清「为什么必须确认 / 为什么可以只信 2xx」`)
    if (policy.exception === true) {
      assert.equal(policy.probe, undefined, `${point} 标了例外就不该有回查手段`)
    } else {
      assert.ok(
        policy.probe !== undefined && policy.probe !== '',
        `${point} 是可确认点，必须写明回查手段`
      )
    }
  }
  const exceptions = CONSUME_EFFECT_POLICIES.filter((item) => item.exception === true).map(
    (item) => item.point
  )
  assert.deepEqual(
    exceptions.sort(),
    ['forgotPassword', 'resetPassword', 'sendBindEmailCode', 'sendVerifyCode'],
    '例外只允许这 4 个发码 / 密码类（其余点一律必须确认）'
  )
})

test('判据表 drift 守卫：真代码与表一致（例外点不调 confirmEffect，其余点都调）', () => {
  for (const [point, [fileKey]] of Object.entries(POINT_SOURCES)) {
    const policy = effectPolicyOf(point)
    const section = sectionOf(SOURCES[fileKey], point)
    if (policy.exception === true) {
      assert.equal(
        /confirmEffect\s*[<(]/.test(section),
        false,
        `${point} 标了例外，实现里却调了 confirmEffect（表与代码不一致）`
      )
      assert.equal(
        section.includes('CONSUME_EFFECT_POLICIES'),
        true,
        `${point} 是例外点，必须在注释里指向表里的理由（否则例外就没有依据了）`
      )
    } else {
      assert.equal(
        /confirmEffect\s*[<(]/.test(section),
        true,
        `${point} 必须走 confirmEffect（不许各写一遍）`
      )
    }
  }
})

// ====================================================================== 工具单测
// `confirmEffect` 本身的三段判定顺序 + 「回查最多一次」。

test('confirmEffect：判定顺序 accept → probe → 失败，且 probe 最多被调一次', async () => {
  // ① accept 命中 → 不回查
  let probeCalls = 0
  const acceptHit = await confirmEffect({
    response: { data: { ok: 1 }, raw: { status: 200 } },
    accept: (data) => (data && data.ok === 1 ? 'entity' : undefined),
    probe: probeOnce(
      async () => ({ ok: true, data: {}, status: 200, raw: {} }),
      () => undefined
    ),
  })
  assert.deepEqual(acceptHit, { confirmed: true, value: 'entity', via: 'response' })
  assert.equal(probeCalls, 0)

  // ② accept 不命中 → **恰好一次**回查确认
  const acceptMiss = await confirmEffect({
    response: { data: null, raw: { status: 200 } },
    accept: () => undefined,
    probe: async () => {
      probeCalls += 1
      if (probeCalls > 1) {
        throw new Error('probe 被调了第二次（写后查询放大）')
      }
      return { verdict: 'confirmed', value: 'from-probe' }
    },
  })
  assert.deepEqual(acceptMiss, { confirmed: true, value: 'from-probe', via: 'probe' })
  assert.equal(probeCalls, 1)

  // ③ 无 accept 无 probe → 未确认，且**不编造**成功
  const nothing = await confirmEffect({ response: { data: undefined, raw: { status: 200 } } })
  assert.equal(nothing.confirmed, false)
  assert.equal(nothing.reason, 'no-evidence')

  // ④ 回查给反证 → probe-negative
  const negative = await confirmEffect({
    response: { data: null, raw: { status: 200 } },
    accept: () => undefined,
    probe: async () => ({ verdict: 'negative' }),
  })
  assert.equal(negative.confirmed, false)
  assert.equal(negative.reason, 'probe-negative')

  // ⑤ 回查自己失败 → probe-failed，并把上游错误带出去（文案能给「登录已过期」）
  const failed = await confirmEffect({
    response: { data: null, raw: { status: 200 } },
    accept: () => undefined,
    probe: async () => ({
      verdict: 'unknown',
      error: {
        kind: 'auth',
        code: 'UNAUTHORIZED',
        message: 'x',
        status: 401,
        retryable: false,
        envelope: 'middleware',
        i18nKey: 'consumeErrUnauthorized',
      },
    }),
  })
  assert.equal(failed.reason, 'probe-failed')
  assert.equal(failed.probeError.kind, 'auth')
})

test('unconfirmedEffectError：恒为「未确认」（retryable + 本点文案），绝不返回成功形状', () => {
  const error = unconfirmedEffectError({
    i18nKey: 'consumeErrDeleteUnconfirmed',
    code: 'DELETE_UNCONFIRMED',
    message: 'x',
    status: 200,
    outcome: { confirmed: false, reason: 'probe-negative' },
  })
  assert.equal(error.i18nKey, 'consumeErrDeleteUnconfirmed')
  assert.equal(error.code, 'DELETE_UNCONFIRMED')
  assert.equal(error.retryable, true, '结果未知 → 用户可以重试')
  assert.equal(error.status, 200, '原始 2xx 状态码留着（排查用：别让人以为是网络错）')
  assert.equal(typeof translate(error.i18nKey), 'string')
})

// ====================================================================== 面板层
// 退出登录的**安全语义**：未确认时界面不许出现「已退出登录 / 已退出所有设备」。

const logoutSource = (reply) => ({
  auth: {
    profile: async () => ({
      ok: true,
      status: 200,
      raw: {},
      data: { id: 1, email: 'me@example.com' },
    }),
    revokeAllSessions: async () => reply,
  },
  keys: {
    list: async () => ({
      ok: true,
      status: 200,
      raw: {},
      data: { items: [], total: 0, page: 1, pageSize: 20, pages: 1 },
    }),
    create: async () => ({ ok: true, status: 200, raw: {}, data: {} }),
    update: async () => ({ ok: true, status: 200, raw: {}, data: {} }),
    remove: async () => ({ ok: true, status: 200, raw: {}, data: undefined }),
  },
})

const revokeUnconfirmedReply = {
  ok: false,
  status: 200,
  raw: { status: 200 },
  error: {
    kind: 'unknown',
    code: 'REVOKE_UNCONFIRMED',
    message: 'revoked but unconfirmed',
    status: 200,
    retryable: true,
    envelope: 'none',
    i18nKey: 'consumeErrRevokeUnconfirmed',
  },
}

const accountHtml = (state) =>
  markupOf(
    AccountPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      copied: false,
      onCopyKey() {},
      onDraft() {},
      onCreate() {},
      onToggleKey() {},
      onAskDelete() {},
      onCancelDelete() {},
      onConfirmDelete() {},
      onDismissCreated() {},
      onAskLogout() {},
      onCancelLogout() {},
      onLogout() {},
      onRetry() {},
    })
  )

test('面板：退出**未确认**时显示「未确认 + 下一步」，绝不显示「已退出登录」', async () => {
  const events = await runLogout(logoutSource(revokeUnconfirmedReply))
  let state = initialAccountState({ id: 1, email: 'me@example.com' })
  for (const event of events) {
    state = reduceAccount(state, event)
  }
  assert.equal(state.notice, 'logoutUnconfirmed', '未确认走独立提示，不是普通错误也不是「已退出」')
  assert.equal(
    state.actionError,
    null,
    '安全语义的提示不该被当成一次普通失败（那会让人以为只是没点成功）'
  )
  assert.equal(loggedOut(events), true, '本地会话同样要停用：容器据此让用户重新登录')

  const markup = accountHtml(state)
  assert.equal(hasTestId(markup, 'account-notice'), true)
  const notice = textOf(markup, 'account-notice')
  assert.equal(
    notice.includes(translate('consumeErrRevokeUnconfirmed')),
    true,
    `提示应为「未确认」那句，实际「${notice}」`
  )
  assert.equal(notice.includes(translate('consumeLogoutSuccess')), false, '不许显示「已退出登录」')
  assert.equal(notice.includes('已退出所有设备'), false)
  assert.equal(notice.includes('重新登录'), true, '必须给下一步')
})

test('面板：退出**已确认**时仍是既有的「已退出登录」（不回归）', async () => {
  const events = await runLogout(logoutSource({ ok: true, status: 200, raw: {}, data: undefined }))
  let state = initialAccountState({ id: 1, email: 'me@example.com' })
  for (const event of events) {
    state = reduceAccount(state, event)
  }
  assert.equal(state.notice, 'loggedOut')
  assert.equal(loggedOut(events), true)
  assert.equal(
    textOf(accountHtml(state), 'account-notice').includes(translate('consumeLogoutSuccess')),
    true
  )
})

test('面板：退出成为普通失败（非安全语义）时仍是 actionError（不回归）', async () => {
  const events = await runLogout(
    logoutSource({
      ok: false,
      status: 500,
      raw: {},
      error: {
        kind: 'server',
        code: 'INTERNAL_ERROR',
        message: 'boom',
        status: 500,
        retryable: true,
        envelope: 'panel',
        i18nKey: 'consumeErrServerUnavailable',
      },
    })
  )
  assert.equal(loggedOut(events), false)
  assert.ok(
    events.some(
      (event) =>
        event.type === 'actionError' && event.error.i18nKey === 'consumeErrServerUnavailable'
    )
  )
})

// ====================================================================== 负向对照
// 把任一处判据改回「只看 2xx」→ 对应行必红。
//
// 做法：把**旧写法**（#679 之前那段代码）作为可执行副本放在这里，喂同一份输入，断言它给出与上表
// **相反**的结论。这样「判据退回只看 2xx」不是一句声明，而是当场跑出来的事实。

test('负向对照：旧判据（只看 2xx）在同样输入下会判成功 —— 上表四组必红', async (t) => {
  // ── R：旧 revokeAllSessions 就是「call 完直接返回」
  await t.test('revokeAllSessions 旧判据：2xx + 空体 → ok:true（应当判未确认）', async () => {
    const { http, count } = chainOf((request) =>
      request.url.includes('/api/v1/user/profile')
        ? jsonReply(200, panelOk({ id: 1 }))
        : emptyReply(200)
    )
    const legacy = await http.call({
      method: 'POST',
      path: '/api/v1/auth/revoke-all-sessions',
      timeout: 'write',
    })
    assert.equal(legacy.ok, true, '旧判据会在这里给出成功 —— 这正是 #679 要修掉的谎')
    assert.equal(
      count('GET', '/api/v1/user/profile'),
      0,
      '旧判据从不回查：没有证据也能说「已撤销」'
    )
    // 与真实现对照
    const real = await revokeAllSessions(http)
    assert.equal(real.ok, false, '真实现必须判未确认 → 上表 R 组第二行必红')
  })

  // ── U：旧 unbindProvider 就是「2xx → toConsumeUser(data)」
  await t.test('unbindProvider 旧判据：2xx + 空体 → ok:true（应当判未确认）', async () => {
    const { http } = chainOf(() => emptyReply(200))
    const legacy = await http.call({ method: 'DELETE', path: UNBIND_PATH, timeout: 'write' })
    const legacyVerdict = legacy.ok ? toConsumeUser(legacy.data) : legacy
    assert.equal(legacy.ok, true, '旧判据：解绑 2xx 就算成功')
    assert.equal(legacyVerdict.emailBound, undefined, '而账号主体里根本没有「已解绑」的证据')
    const real = await unbindProvider(http, 'email')
    assert.equal(real.ok, false, '真实现必须判未确认 → 上表 U 组必红')
  })

  // ── K：旧 updateKey 就是「2xx → toConsumeApiKey(data)」
  await t.test('updateKey 旧判据：2xx + 空体 → ok:true（应当判未确认）', async () => {
    const { http } = chainOf(() => emptyReply(200))
    const legacy = await http.call({
      method: 'PUT',
      path: KEY_PATH,
      body: { quota: 5 },
      timeout: 'write',
    })
    assert.equal(legacy.ok, true)
    assert.equal(
      toConsumeApiKey(legacy.data).quota,
      0,
      '旧判据下 quota 是个 0 的空壳，界面却已经显示 5'
    )
    const real = await updateKey(http, 7, { quota: 5 })
    assert.equal(real.ok, false, '真实现必须判未确认 → 上表 K 组必红')
  })

  // ── D：旧 deleteKey 就是「2xx（或 404）都算成功」
  await t.test('deleteKey 旧判据：2xx 就算成功（Key 其实还在）（应当判未确认）', async () => {
    const { http, count } = chainOf((request) =>
      request.method === 'GET' ? jsonReply(200, panelOk(keyRow({}))) : emptyReply(200)
    )
    const legacy = await http.call({ method: 'DELETE', path: KEY_PATH, timeout: 'write' })
    assert.equal(legacy.ok, true, '旧判据：删除 2xx 就算删掉了')
    assert.equal(count('GET', KEY_PATH), 0, '旧判据不回查：列表消失了，服务端那把 Key 还在计费')
    const real = await deleteKey(http, 7)
    assert.equal(real.ok, false, '真实现必须判未确认 → 上表 D 组必红')
  })
})

// 让「例外文案」这一条也有断言：例外点的 4 条 why 必须写明「为什么可以只信 2xx」
test('例外点的理由必须点出「没有可回查实体」这层（否则例外就只是偷懒）', () => {
  for (const point of ['sendBindEmailCode', 'sendVerifyCode', 'forgotPassword', 'resetPassword']) {
    const policy = effectPolicyOf(point)
    assert.equal(policy.exception, true)
    assert.equal(
      /没有|无从|无实体|没有会话|匿名/.test(policy.why),
      true,
      `${point} 的 why 必须说清「为什么没有可回查的证据」，实际「${policy.why}」`
    )
    assert.equal(
      zh[`consumeErr${point[0].toUpperCase()}${point.slice(1)}Unconfirmed`] === undefined,
      true
    )
  }
})
