// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 settings 读取口 + renderToStaticMarkup） | Issue #487 阶段③]
//
// **设置开关 → 入口显隐**（L1-1 里「按 `settings/public` 决定入口」那一条，#484 §3.1d）。
//
// 三张嘴要的开关各测一次，且每条都落到「用户看不看得见」，不是只断言一个布尔值：
//   · `registration_enabled=false` → 注册入口整块隐藏（**不是置灰**）；
//   · `invitation_code_enabled=false` → 邀请面板整块 `null`（不是「功能未开放」的占位）；
//   · `email_verify_enabled=false` → 邮箱面板不再强调「必须先验证邮箱」。
//
// 为什么注册/邀请码两条要**两层**断言：`LoginPage` / `RegisterPage` 是 `.tsx`，裸 Node 无法
// import（JSX 不在类型擦除范围内），所以动态那层测到 `flags` 与面板视图为止，`.tsx` 那一层
// 用**源码接线断言**补齐（`showRegisterEntry={flags.registrationEnabled}` 之类）。
// 两层缺一不可：只测 flags 挡不住「页面写死 true」，只测源码挡不住「解析把开关读反」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId } = await setupAuthPanels()

const { CONSERVATIVE_AUTH_FLAGS, loadAuthFlags, parseAuthFlags, setPublicSettingsReader, useAuthFlags } =
  await import('../../src/services/auth/flags.ts')
const { loadInvite, InvitePanelView } = await import('../../src/components/consume/invitePanel.ts')
const { EmailBindPanelView, initialEmailBindState, reduceEmailBind } = await import(
  '../../src/components/consume/emailBindPanel.ts'
)

const ROOT = path.resolve(import.meta.dirname, '../..')
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/** `GET /api/v1/settings/public` 的真实形状：开关在 `data` 下面（面板信封） */
const settings = ({ registration = false, invitation = false, verify = false } = {}) => ({
  code: 0,
  message: 'success',
  data: {
    registration_enabled: registration,
    invitation_code_enabled: invitation,
    email_verify_enabled: verify,
  },
})

const ROWS = [
  {
    label: '全开：三个开关都读到 true，loaded=true',
    reader: async () => settings({ registration: true, invitation: true, verify: true }),
    expect: { registrationEnabled: true, invitationCodeEnabled: true, emailVerifyEnabled: true, loaded: true },
  },
  {
    label: '全关：读到的是 false（不是「没读到」），loaded 仍为 true',
    reader: async () => settings({}),
    expect: { registrationEnabled: false, invitationCodeEnabled: false, emailVerifyEnabled: false, loaded: true },
  },
  {
    label: '裸对象也认（其他实现/测试会给不带 data 的体）',
    reader: async () => ({ registration_enabled: true, invitation_code_enabled: false, email_verify_enabled: false }),
    expect: { registrationEnabled: true, invitationCodeEnabled: false, loaded: true },
  },
  {
    label: '只认严格 true："true" / 1 / 缺失 一律当关闭',
    reader: async () => ({ registration_enabled: 'true', invitation_code_enabled: 1, email_verify_enabled: undefined }),
    expect: { registrationEnabled: false, invitationCodeEnabled: false, emailVerifyEnabled: false },
  },
  {
    label: '读取失败（抛错）：落保守默认，loaded 保持 false（界面只显示登录）',
    reader: async () => {
      throw new Error('settings/public unreachable')
    },
    expect: { ...CONSERVATIVE_AUTH_FLAGS, loaded: false },
  },
  {
    label: '还没接线（reader 未注入）：同样落保守默认',
    reader: null,
    expect: { ...CONSERVATIVE_AUTH_FLAGS, loaded: false },
  },
]

test('L1 开关：settings/public → flags 六行（含失败与未接线）', async (t) => {
  for (const row of ROWS) {
    await t.test(row.label, async () => {
      setPublicSettingsReader(row.reader)
      await loadAuthFlags()
      const state = useAuthFlags.getState()
      for (const [key, value] of Object.entries(row.expect)) {
        assert.equal(state[key], value, `${key} 期望 ${value}，实际 ${state[key]}`)
      }
    })
  }
  setPublicSettingsReader(null)
})

test('invitation_code_enabled=false → 邀请面板整块不渲染（不是占位、不是报错）', async () => {
  const source = {
    settings: {
      get: async () => ({
        ok: true,
        status: 200,
        raw: {},
        data: { invitationCodeEnabled: false },
      }),
    },
    // 返利数据**拿得到**也要隐藏：开关是总闸，不是「有数据就显示」的提示位。
    // （`loadInvite` 刻意并行读开关与返利，所以这里不假设「关着就不发第二个请求」。）
    aff: {
      detail: async () => ({
        ok: true,
        status: 200,
        raw: {},
        data: { affCode: 'MOCK-CODE', affCount: 3, affQuota: 2.5, affFrozenQuota: 0 },
      }),
    },
  }
  const state = await loadInvite(source)
  assert.deepEqual(state, { phase: 'hidden' })
  const markup = markupOf(
    InvitePanelView({ t: translate, c: classNames, Button: ButtonStub, state, copied: false, onCopy() {}, onRetry() {} })
  )
  assert.equal(markup, '', 'hidden 必须是 null（整块不渲染），而不是一行「功能未开放」')
})

test('email_verify_enabled=false → 不强调「必须先验证邮箱」（=true 时才出现那一行）', () => {
  const render = (emailVerifyEnabled) => {
    const state = reduceEmailBind(initialEmailBindState(), {
      type: 'info',
      state: {
        phase: 'ready',
        data: { email: '', bound: false, canUnbind: true, emailVerifyEnabled },
      },
    })
    return markupOf(
      EmailBindPanelView({
        t: translate,
        c: classNames,
        Button: ButtonStub,
        state,
        remaining: 0,
        onStartBind() {},
        onCancelForm() {},
        onDraftEmail() {},
        onDraftCode() {},
        onSendCode() {},
        onSubmit() {},
        onAskUnbind() {},
        onCancelUnbind() {},
        onUnbind() {},
        onRetry() {},
      })
    )
  }
  const off = render(false)
  const on = render(true)
  assert.equal(hasTestId(off, 'email-bind-verify-hint'), false, '开关关着就不该给一条做不到的指令')
  assert.equal(hasTestId(on, 'email-bind-verify-hint'), true, '开关开着时必须有这句提示（否则这条断言没有对照）')
  assert.equal(off.includes(translate('sub2authEmailVerifyRequired')), false)
})

test('接线：注册入口 / 邀请码行 / 验证码行只受 flags 控制（页面里没有第二份写死的开关）', () => {
  const gate = sourceOf('src/components/auth/AuthGate.tsx')
  const login = sourceOf('src/components/auth/LoginPage.tsx')
  const register = sourceOf('src/components/auth/RegisterPage.tsx')

  // ① 登录页的注册入口由 `showRegisterEntry` 控制，gate 传的是开关本身
  assert.match(gate, /showRegisterEntry=\{flags\.registrationEnabled\}/)
  assert.match(login, /showRegisterEntry \?/)
  // ② 注册页的验证码行 / 邀请码行由 flags 控制
  assert.match(register, /flags\.emailVerifyEnabled \?/)
  assert.match(register, /flags\.invitationCodeEnabled \?/)
  // ③ 不许有人把它们写死成 true（这条是「改坏 → 变红」的落点）
  for (const [file, source] of [
    ['AuthGate.tsx', gate],
    ['LoginPage.tsx', login],
    ['RegisterPage.tsx', register],
  ]) {
    assert.equal(/showRegisterEntry=\{true\}|registrationEnabled = true/.test(source), false, `${file} 里不许写死注册开关`)
  }
  // ④ 开关一关，停在注册页的人要被送回登录页（隐藏入口 ≠ 拦住已经在页面上的人）
  assert.match(gate, /if \(!flags\.registrationEnabled && mode === 'register'\)/)
})

test('parseAuthFlags 对非对象输入不炸（null / 数组 / 字符串一律保守）', () => {
  for (const raw of [null, undefined, [], 'registration_enabled=true', 42]) {
    assert.deepEqual(parseAuthFlags(raw), CONSERVATIVE_AUTH_FLAGS, `输入 ${String(raw)} 应落保守默认`)
  }
})
