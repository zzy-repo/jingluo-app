// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 transport + 内存凭据存储） | Issue #487 阶段③]
//
// **登录主路径**（L1-1 的前半）：`signIn()` 一次点击到底发生了什么 —— token 落到哪儿、
// 失败时文案从哪儿来、会不会自动重试、什么条件下放行主界面。
//
// 被测的是真代码：`src/services/auth/store.ts`（身份层唯一的副作用点）。`.tsx` 的
// `AuthGate` / `LoginPage` 裸 Node import 不了（JSX 不在类型擦除范围内），所以「放行主界面」
// 这条用**两层**钉住：
//   ① 行为层：登录成功后快照必须是 `state==='authenticated'` + `restored===true`（这是 gate 的判据）；
//   ② 接线层：`AuthGate.tsx` 里放行分支必须只认 `authState === 'authenticated'`（源码断言，
//      见本文件最后一条用例）—— 有人把判据改成「有 token 就放行」或者写死 `true`，这里当场红。
//
// 口径来源：#484 §二（刷新失败清态、不静默重试）、#484 §四（按 code 分派文案，服务端 message 不上屏）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

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

const ROOT = path.resolve(import.meta.dirname, '../..')

/** 一次成功登录的服务端回包（形状照抄 `AuthTransport.login` 的契约，`expires_in` 已换算成 `expiresAt`） */
const session = (over = {}) => ({
  token: {
    accessToken: 'at-9f2c',
    refreshToken: 'rt-1111',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600_000,
  },
  user: { id: 2, email: 'ui@mock.local', emailVerified: true },
  ...over,
})

/** 一次归一化失败（`AuthError` 的形状：界面只读 `messageKey`） */
const authError = ({ kind = 'auth', code = 'UNAUTHORIZED', status = 401, retryable = false, messageKey }) => ({
  kind,
  code,
  message: 'Authorization header is required',
  status,
  retryable,
  messageKey,
})

/**
 * 表驱动的三行：登录成功 / 401 凭据错 / 500 服务端错。
 *
 * 每行只写「假后端怎么答」+「断言什么」，装配与重置在下面统一做 —— 这样新增一行
 * （比如「账号被停用」）只加一条数据，不动样板。
 */
const ROWS = [
  {
    label: '登录成功：token 进凭据存储 + 放行主界面（不额外触发续期）',
    reply: { ok: true, data: session() },
    verify: ({ snapshot, storage, calls, input }) => {
      // ① 凭据真的落盘了（`v:1` 载荷，与 API Key 同级的安全存储口子）
      assert.equal(storage.value !== null, true, '登录成功必须把凭据写进存储')
      assert.equal(storage.parsed.v, 1)
      assert.equal(storage.parsed.token.accessToken, 'at-9f2c')
      assert.equal(storage.parsed.user.email, 'ui@mock.local')
      // ② 放行主界面（`AuthGate` 的判据就是这两个字段）
      assert.equal(snapshot.state, 'authenticated')
      assert.equal(snapshot.restored, true, '登录成功后 gate 不该停在「加载中」')
      assert.equal(snapshot.user.email, 'ui@mock.local')
      assert.equal(snapshot.error, null)
      // ③ 登录**不**顺手触发续期 / 二次校验：一条登录就是一次请求
      assert.equal(calls.login.length, 1)
      assert.equal(calls.refreshToken.length, 0, '登录成功不该触发 refresh（那是 token 过期路径的事）')
      assert.equal(calls.me, 0)
      // ④ 用户填的东西原样送到服务端（没被清洗成空）
      assert.deepEqual(input, { email: 'ui@mock.local', password: 'abcd1234' })
    },
  },
  {
    label: '登录失败 401：文案来自 messageKey、不自动重试、不落凭据、输入内容不清空',
    reply: {
      ok: false,
      error: authError({ messageKey: 'sub2authCredentialInvalid' }),
    },
    verify: ({ snapshot, storage, calls, input }) => {
      assert.equal(snapshot.state, 'unauthenticated', '失败要停在登录页')
      assert.equal(snapshot.user, null)
      // ① 上屏文案 = i18n key 对应的中文，**不是**服务端的英文 message
      assert.equal(snapshot.error.messageKey, 'sub2authCredentialInvalid')
      assert.equal(translate(snapshot.error.messageKey), zh.sub2authCredentialInvalid)
      assert.equal(translate(snapshot.error.messageKey).includes('Authorization header'), false)
      // ② 401 不可重试（重试只会更糟），且**没有**自动重发
      assert.equal(snapshot.error.retryable, false)
      assert.equal(calls.login.length, 1, '401 之后不许自动重试')
      assert.equal(calls.refreshToken.length + calls.me, 0, '登录失败不该触发续期 / me')
      // ③ 失败不写凭据（否则下次启动会「看起来登录着」）
      assert.equal(storage.value, null)
      // ④ 已输入内容不清空：入参对象原封不动（表单由页面持有，store 不许改写它）
      assert.deepEqual(input, { email: 'ui@mock.local', password: 'abcd1234' })
    },
  },
  {
    label: '登录失败 500：可重试的服务端错，文案退到「登录失败，请重试」而不是凭据错',
    reply: {
      ok: false,
      error: authError({
        kind: 'server',
        code: 'INTERNAL_ERROR',
        status: 500,
        retryable: true,
        messageKey: 'sub2authLoginFailed',
      }),
    },
    verify: ({ snapshot, calls }) => {
      assert.equal(snapshot.error.messageKey, 'sub2authLoginFailed')
      assert.equal(snapshot.error.messageKey === 'sub2authCredentialInvalid', false, '5xx 不许说「账号或密码错误」')
      assert.equal(snapshot.error.retryable, true)
      // 「可重试」= 允许用户再点一次，**不等于**客户端自己重发
      assert.equal(calls.login.length, 1)
    },
  },
]

test('L1 登录：成功 / 401 / 500 三行（表驱动）', async (t) => {
  const storage = createTokenStorage()
  setAuthTokenStorage(storage.storage)

  for (const row of ROWS) {
    await t.test(row.label, async () => {
      storage.reset()
      resetAuthStore(useAuthStore)
      const { transport, calls } = createFakeTransport({ login: row.reply })
      setAuthTransport(transport)

      const input = { email: 'ui@mock.local', password: 'abcd1234' }
      const result = await useAuthStore.getState().signIn(input)

      row.verify({ snapshot: getAuthSnapshot(), storage, calls, input, result })
    })
  }
})

test('接线：AuthGate 只在 state===\'authenticated\' 时放行主界面（不认「有 token」）', () => {
  const source = readFileSync(path.join(ROOT, 'src/components/auth/AuthGate.tsx'), 'utf8')
  // 放行分支：`if (authState === 'authenticated') { return <>{children}</> }`
  assert.match(source, /authState === 'authenticated'/, 'AuthGate 的放行判据必须是登录态本身')
  assert.equal(
    /authState !== 'unauthenticated'[\s\S]{0,80}children/.test(source),
    false,
    '不许用「不是未登录」这种更宽的判据放行主界面'
  )
  // 恢复没跑完只转圈（不闪登录页、也不提前放行）
  assert.match(source, /if \(!restored\)/, 'AuthGate 必须先等 restoreAuth 跑完')
})
