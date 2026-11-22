// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
//
// Issue #839 问题 1：已登录的账号「退不出去」。
//
// 链路：`signOut()` 先 `await transport.logout()`（`revoke-all-sessions`，再回查一次 `/user/profile`
// 证明会话真的失效），**之后**才 `clearSession`。网络慢 / 服务端挂住时，本地清态要等两次请求各自的
// 超时（write 档 20s）才发生 —— 用户点完「退出」界面纹丝不动，多半会以为「退不出去」。
//
//   T1 退出请求挂住时，本地登录态必须立刻清掉（不等服务端）
//   T2 服务端作废晚到：迟到的成功 / 失败都不许把本地状态改回去
//   T3 退出请求本身抛错 / 网络失败：本地照样清
//   T4 退出后重启（读盘恢复）不会自动登录
//   T5 撤销请求仍然带着退出前的 token（先清本地不能让它变成匿名请求）
//
//   node tests/run-layer.mjs unit --only signout-839
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTokenStorage, resetAuthStore, setupAuthPanels } from '../helpers/auth-panels-env.mjs'

await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const { getAccessToken, handleUnauthorized, restoreAuth, setAuthTokenStorage, setAuthTransport, useAuthStore } =
  await import('../../src/services/auth/store.ts')

const ENDPOINTS = {
  baseUrl: 'https://consume.test.invalid',
  apiV1Prefix: '/api/v1',
  gatewayPrefix: '/v1',
  timeoutMs: { read: 1_000, write: 1_000, redeem: 1_000 },
}
const USER = { id: 1, email: 'a@mock.local', emailVerified: true }
const TOKEN = { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000 }

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const panelOk = (data) => json(200, { code: 0, message: 'success', data })

const storage = createTokenStorage()
setAuthTokenStorage(storage.storage)

/** `revoke` 决定撤销请求怎么回；`profile` 决定回查 `/user/profile` 怎么回 */
const install = ({ revoke, profile }) => {
  storage.reset()
  storage.seed(TOKEN, USER)
  resetAuthStore(useAuthStore)
  useAuthStore.setState({ state: 'authenticated', token: TOKEN, user: USER, restored: true })
  const calls = []
  headers.length = 0
  const transport = async (request) => {
    const { pathname } = new URL(request.url)
    calls.push(pathname)
    headers.push({ pathname, authorization: request.headers.authorization ?? '' })
    if (pathname === '/api/v1/auth/revoke-all-sessions') {
      return revoke()
    }
    if (pathname === '/api/v1/user/profile') {
      return profile()
    }
    return panelOk({})
  }
  setAuthTransport(
    createAuthTransport(createConsumeClient({ transport, endpoints: ENDPOINTS, accessToken: getAccessToken, onUnauthorized: handleUnauthorized }))
  )
  return calls
}

const headers = []
const never = () => new Promise(() => {})
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('T1 退出请求挂住时，本地登录态立刻清掉（不等服务端）', async () => {
  install({ revoke: never, profile: never })
  void useAuthStore.getState().signOut()
  await tick()
  assert.equal(useAuthStore.getState().state, 'unauthenticated', '点退出后界面应立刻回到未登录，而不是等撤销请求超时')
  assert.equal(useAuthStore.getState().token, null)
  assert.equal(storage.value, null, '落盘凭据同时清掉：此刻杀进程重启也不会自动恢复登录')
})

test('T2 服务端作废晚到（成功或失败）都不改本地已清的状态', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const calls = install({ revoke: () => gate.then(() => panelOk({ message: 'ok' })), profile: () => json(401, { code: 'UNAUTHORIZED', message: 'x' }) })
  const pending = useAuthStore.getState().signOut()
  await tick()
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
  release()
  await pending
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
  assert.equal(storage.value, null)
  assert.ok(calls.includes('/api/v1/auth/revoke-all-sessions'), '服务端作废仍然要发（只是不再挡住本地清态）')
})

test('T3 撤销请求网络失败：本地照样清', async () => {
  install({ revoke: () => ({ kind: 'network' }), profile: () => ({ kind: 'network' }) })
  await useAuthStore.getState().signOut()
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
  assert.equal(storage.value, null)
})

test('T4 退出后重启：读盘恢复不会把人自动登回去', async () => {
  install({ revoke: () => panelOk({ message: 'ok' }), profile: () => json(401, { code: 'UNAUTHORIZED', message: 'x' }) })
  await useAuthStore.getState().signOut()
  useAuthStore.setState({ restored: false })
  await restoreAuth()
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
  assert.equal(useAuthStore.getState().token, null)
})

test('T5 撤销请求带的是退出前的 token（先清本地也不能变成匿名请求）', async () => {
  install({ revoke: () => panelOk({ message: 'ok' }), profile: () => json(401, { code: 'UNAUTHORIZED', message: 'x' }) })
  await useAuthStore.getState().signOut()
  await tick()
  const revoke = headers.find((h) => h.pathname === '/api/v1/auth/revoke-all-sessions')
  assert.ok(revoke, '服务端作废仍然要发')
  assert.equal(revoke.authorization, 'Bearer at-1', '必须是退出前的 JWT，否则服务端会话留着没作废')
})

test('T6 后台撤销回 401：不触发刷新、不把「已退出」改写成「登录过期」', async () => {
  const calls = install({ revoke: () => json(401, { code: 'UNAUTHORIZED', message: 'x' }), profile: () => json(401, { code: 'UNAUTHORIZED', message: 'x' }) })
  await useAuthStore.getState().signOut()
  await tick()
  assert.equal(useAuthStore.getState().state, 'unauthenticated', '不能被改成 expired')
  assert.equal(useAuthStore.getState().error, null)
  assert.ok(!calls.includes('/api/v1/auth/refresh'), '没有 token 可刷，更不该发刷新请求')
})
