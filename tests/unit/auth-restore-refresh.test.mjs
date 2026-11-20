// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 transport + 内存凭据存储） | Issue #487 阶段③]
//
// **冷启动恢复主路径**（L1-1 的后半）：`restoreAuth()` 读盘 → 过期就先续 → `me()` 验一次。
//
// 四行表格就是「token 过期」这一栏的完整两行（续得上 / 续不上）加两条边界：
//   · 续期成功 → 新 token 落盘、**放行**、me() 校验一次；
//   · 续期失败 → 清态回登录页（`expired`），不静默重试、不写回旧 token；
//   · `me()` 说「JWT 不认」（`kind==='auth'`）→ 清态（**只有这一种**会清）；
//   · `me()` 是网络错误（`kind==='network'`）→ 保留会话（离线启动不该被当成「密码错了」）。
//
// 口径：`store.ts` 的 `restoreAuth` / `refreshSession` 注释（#484 §二「刷新失败就清态回登录」）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createFakeTransport,
  createTokenStorage,
  resetAuthStore,
  setupAuthPanels,
} from '../helpers/auth-panels-env.mjs'

const { translate, zh } = await setupAuthPanels()

const { setAuthTokenStorage, setAuthTransport, useAuthStore, getAuthSnapshot } = await import(
  '../../src/services/auth/store.ts'
)

const USER = { id: 2, email: 'ui@mock.local', emailVerified: true }

/** 落盘的 token：`expired` = 已经过期（还会触发续期），否则 1 小时后到期 */
const persistedToken = ({ expired, refreshToken = 'rt-old' }) => ({
  accessToken: 'at-old',
  refreshToken,
  tokenType: 'Bearer',
  expiresAt: expired ? Date.now() - 60_000 : Date.now() + 3600_000,
})

const freshToken = {
  accessToken: 'at-new',
  refreshToken: 'rt-new',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000,
}

const ROWS = [
  {
    label: 'token 过期 + 续期成功：新 token 落盘、me() 校验一次、放行',
    seed: persistedToken({ expired: true }),
    reply: {
      refreshToken: { ok: true, data: freshToken },
      me: { ok: true, data: USER },
    },
    verify: ({ snapshot, storage, calls }) => {
      assert.equal(calls.refreshToken.length, 1, '过期就该续一次')
      assert.deepEqual(calls.refreshToken[0], { refreshToken: 'rt-old' })
      assert.equal(storage.parsed.token.accessToken, 'at-new', '续期后的 token 必须落盘（下次启动直接用）')
      assert.equal(calls.me, 1, '续期成功后要用 me() 认一次人')
      assert.equal(snapshot.state, 'authenticated')
      assert.equal(snapshot.restored, true)
      assert.equal(snapshot.user.email, 'ui@mock.local')
      assert.equal(storage.parsed.user.email, 'ui@mock.local', 'me() 回来的画像也要落盘（离线启动能显示邮箱）')
    },
  },
  {
    label: 'token 过期 + 续期失败 401：清态回登录页（expired），不重试、不调 me()',
    seed: persistedToken({ expired: true }),
    reply: {
      refreshToken: {
        ok: false,
        error: {
          kind: 'auth',
          code: 'REFRESH_TOKEN_INVALID',
          message: 'invalid refresh token',
          status: 401,
          retryable: false,
          messageKey: 'sub2authCredentialInvalid',
        },
      },
    },
    verify: ({ snapshot, storage, calls }) => {
      assert.equal(calls.refreshToken.length, 1, '续期失败不许自动重试（一次就够）')
      assert.equal(calls.me, 0, '已经没有可用 token，不该再打 me()')
      // 清态：存储清空（最后一条写入是 null），快照回到「过期」
      assert.equal(storage.value, null)
      assert.equal(storage.writes.at(-1), null, '清态必须真的落盘清掉（否则下次启动又「登录着」）')
      assert.equal(snapshot.state, 'expired')
      assert.equal(snapshot.token, null)
      assert.equal(snapshot.user, null)
      assert.ok(snapshot.error !== null && snapshot.error.messageKey in zh, '失败要带一条能上屏的文案 key')
      assert.equal(translate(snapshot.error.messageKey).length > 0, true)
    },
  },
  {
    label: '未过期 + me() 说 JWT 不认（kind=auth）：清态回登录页',
    seed: persistedToken({ expired: false }),
    reply: {
      me: {
        ok: false,
        error: {
          kind: 'auth',
          code: 'TOKEN_REVOKED',
          message: 'token revoked',
          status: 401,
          retryable: false,
          messageKey: 'sub2authCredentialInvalid',
        },
      },
    },
    verify: ({ snapshot, storage, calls }) => {
      assert.equal(calls.refreshToken.length, 0, '没到点就不该续期')
      assert.equal(calls.me, 1)
      assert.equal(snapshot.state, 'expired', '只有 kind===\'auth\' 才清态')
      assert.equal(storage.value, null)
    },
  },
  {
    label: '未过期 + me() 网络错误：保留会话（离线启动不误踢）',
    seed: persistedToken({ expired: false }),
    reply: {
      me: {
        ok: false,
        error: {
          kind: 'network',
          code: 'NETWORK',
          message: 'connect ECONNREFUSED',
          status: 0,
          retryable: true,
          messageKey: 'sub2authNetworkError',
        },
      },
    },
    verify: ({ snapshot, storage }) => {
      assert.equal(snapshot.state, 'authenticated', '网络错误不等于「登录失效」')
      assert.equal(snapshot.token.accessToken, 'at-old')
      assert.equal(storage.parsed.token.accessToken, 'at-old', '凭据不许被一次网络抖动清掉')
      assert.equal(snapshot.error.messageKey, 'sub2authNetworkError')
    },
  },
]

test('L1 冷启动恢复：续期成功 / 续期失败 / me 判 auth / me 网络错（表驱动）', async (t) => {
  const storage = createTokenStorage()
  setAuthTokenStorage(storage.storage)

  for (const row of ROWS) {
    await t.test(row.label, async () => {
      storage.reset()
      storage.seed(row.seed, USER)
      resetAuthStore(useAuthStore)
      const { transport, calls } = createFakeTransport(row.reply)
      setAuthTransport(transport)

      await useAuthStore.getState().restore()

      row.verify({ snapshot: getAuthSnapshot(), storage, calls })
    })
  }
})

test('恢复是幂等的：restored 之后重复调用不再打接口', async () => {
  const storage = createTokenStorage()
  setAuthTokenStorage(storage.storage)
  storage.seed(persistedToken({ expired: false }), USER)
  resetAuthStore(useAuthStore)
  const { transport, calls } = createFakeTransport({ me: { ok: true, data: USER } })
  setAuthTransport(transport)

  await useAuthStore.getState().restore()
  await useAuthStore.getState().restore()
  await useAuthStore.getState().restore()

  assert.equal(calls.me, 1, '三个调用方（启动接线 / AuthGate / 页面）只该产生一次 me()')
})
