// [layer: unit | 依赖: 无（纯 Node，可编程假 transport，零网络） | 耗时: <1s]
//
// #676 §二 —— 「当前用户」**只有 `/api/v1/user/profile` 一条路**。
//
// 契约原文（`#676` 二）：
//   > `/api/v1/auth/me` **不存在**，请用 `/api/v1/user/profile`。
//
// 事实核对（2026-11-21，staging `140.210.13.146:16000`，服务端 `0.2.20`）：
//   · `GET /api/v1/auth/me`（带有效 JWT）→ **200**，字段与 `/user/profile` 同形；
//   · 同一实例的未知路径 → `404 page not found`。
// 也就是说这条不是「线上已经坏了」，而是「客户端还依赖一条契约里没有的路径」：服务端哪天真按契约摘掉它，
// `restoreAuth()` 就变成「一启动就掉线」，而且那时离发版只差一次 rebuild。所以按契约收口到 `/user/profile`。
//
// 本文件钉住的四件事：
//   P1 `getProfile()` 打的是 `GET /api/v1/user/profile`，JWT 只进 `Authorization` 头（不进 query）；
//   P2 身份层的 `me()`（`createAuthTransport`）走的是同一条路 —— 它与 `getProfile()` **是同一个请求**，
//      不存在「两条等价路径」；
//   P3 `consume.auth.me` / `consume.auth.profile` 只剩后者（删掉的东西必须可断言，不是「大概删了」）；
//   P4 负向对照：把路径换回 `/api/v1/auth/me` 时 P1/P2 的断言**一定**会红（用同一份断言跑一次假实现）。
//
//   node --test tests/unit/consume-676-profile-path.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { getProfile } = await import('../../src/services/consume/auth.ts')
const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')

const JWT = 'jwt-676-profile'

/** `/api/v1/user/profile` 的实测形状（staging 0.2.20 原样，只截到界面用到的字段） */
const PROFILE = {
  id: 1,
  email: '2067922098@qq.com',
  username: '',
  role: 'admin',
  balance: 2.02,
  frozen_balance: 0,
  concurrency: 5,
  status: 'active',
  allowed_groups: null,
  total_recharged: 0,
  rpm_limit: 0,
  identities: { email: { provider: 'email', bound: true, bound_count: 1, can_bind: false, can_unbind: false } },
}

/** 一个只会回 `/user/profile` 的场景：别的端点被打到就是失败（防「顺手又加了一条路径」） */
const profileScene = () => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'GET' && path === '/api/v1/user/profile') {return panelOk(PROFILE)}
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => JWT, transport: recorder.transport })
  return { http, ...recorder }
}

test('P1 getProfile() 打 GET /api/v1/user/profile，JWT 只在 Authorization 头', async () => {
  const scene = profileScene()
  const result = await getProfile(scene.http)
  assert.equal(result.ok, true, '面板信封 {code:0,data} 要能解出来')
  assert.deepEqual(scene.sequence(), ['GET /api/v1/user/profile'], '「当前用户」的唯一路径')
  const request = scene.calls[0]
  assert.equal(request.headers.authorization, `Bearer ${JWT}`, 'JWT 只进 header')
  assert.ok(!request.url.includes('token'), 'URL 里不许出现 token')
  assert.equal(request.url, `${scene.http.endpoints.baseUrl}/api/v1/user/profile`, '没有查询串、没有第二个路径段')
  // 余额口径：元（#676 一「balance 就是可用余额，单位是元」）
  assert.equal(result.data.balance, 2.02, 'balance 原样搬出来，客户端不做换算')
  assert.equal(result.data.emailBound, true, 'identities.email.bound 投影到 emailBound')
})

test('P2 身份层 me() 与 getProfile() 是**同一个请求**（没有第二条等价路径）', async () => {
  const scene = profileScene()
  const transport = createAuthTransport(createConsumeClient({ accessToken: () => JWT, transport: scene.transport }))
  const me = await transport.me()
  assert.equal(me.ok, true, '启动恢复要能拿到用户')
  assert.equal(me.data.email, PROFILE.email)
  assert.deepEqual(scene.sequence(), ['GET /api/v1/user/profile'], 'me() 也只能打这一条')
  assert.equal(scene.calls[0].headers.authorization, `Bearer ${JWT}`, '同一条鉴权通道')
})

test('P3 `consume.auth` 只剩 profile()（`me` 已删：契约里没有 `/auth/me`）', () => {
  const consume = createConsumeClient({ accessToken: () => JWT, transport: async () => ({ kind: 'timeout' }) })
  assert.equal(typeof consume.auth.profile, 'function', 'profile() 必须在')
  assert.equal(consume.auth.me, undefined, 'me() 必须真的不存在（删除要可断言，不是留着当第二份真相）')
})

test('P4 负向对照：同样两条断言换回 `/api/v1/auth/me` 必须红（证明 P1/P2 不是空转）', async () => {
  // 假实现：把「当前用户」的路径写成契约里没有的那条（就是本单要修掉的旧写法）
  const legacyMe = async () => {
    const recorder = recordingTransport(() => panelOk(PROFILE))
    const http = createConsumeHttp({ accessToken: () => JWT, transport: recorder.transport })
    // 直接打旧路径（白名单里仍登记着它，这样负向对照不依赖白名单被删）
    await http.request({ method: 'GET', path: '/api/v1/auth/me', timeout: 'read' })
    return recorder
  }
  const recorder = await legacyMe()
  assert.deepEqual(recorder.sequence(), ['GET /api/v1/auth/me'], '负向对照本身先自证：它打的确实是旧路径')
  // 正断言（P1 的那一条）在这里必须不成立 —— 否则说明断言写得太松
  assert.notDeepEqual(
    recorder.sequence(),
    ['GET /api/v1/user/profile'],
    'P1 断言对「还是 /auth/me」的实现在此必然为红'
  )

  // 真实实现同一断言恒为绿：证明二者确实可分
  const scene = profileScene()
  await getProfile(scene.http)
  assert.deepEqual(scene.sequence(), ['GET /api/v1/user/profile'], '修完的实现必须是这条路')
})
