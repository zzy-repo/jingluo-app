// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + 可编程假 transport，零浏览器、零真实网络） | 耗时: <2s]
//
// Issue #803：**登录 / 注册成功后自动拿到自己的 Key** —— 拿不到就自动再试一次，两次都不成才让用户看见。
//
// 票面上的现象（staging）：
//   · `POST /auth/register 200` → 只有两次 `GET /user/profile 200` → **一次 `/api/v1/keys` 都没有**；
//     成因：真正在跑的对齐挂在「启动 + ours + 已登录」那个 effect 上，而「先未登录进 App 再注册」时
//     `signedIn` 这个布尔**全程没变过**，effect 不会重跑；
//   · 另有一轮 `GET /keys` / `profile` / `auth/refresh` / `POST /keys` **全 401**：用的是上一个账号
//     已经作废的 token，建 Key 失败之后注册完成时没有再走一遍。
//
// 本文件钉住票面「要做的流程」的 1–9 条（括号里是用例编号）：
//   [①] 登录 / 注册成功 → 立刻触发一次「确保有 Key」；已有同名 Key → **不 POST**（走查重）
//   [②] 没有 Key → POST 一次成功 → 本机可用（Key + 下发标记；body 里**没有** group_id）
//   [③] 第一次失败（超时 / 500 / 2xx 但无 Key 值，三种各一条）→ **自动重试一次**
//   [④] 两次都失败 → 可见提示 +「重试」按钮 + 日志带状态码（不许静默）
//   [⑤] 401 → 先 refresh 再用**新 token** 重试（断言重试那次带的是新 token）；
//       换不到新凭据 → 不拿旧 token 再打一次
//   [⑥] 并发：profile 与建 Key 同时触发 → 只建出 1 把 Key
//   [⑦] 退出登录 → 本机 Key + 下发标记 + token 被清（换号不会用旧 Key）；别的渠道不误清
//
// #812（同一份流程的补丁，用例加在本文件里而不是另起一套）：
//   [①-b] 服务端已有同名 Key → 一次 `POST /keys` 都没有，且**列表里那把的明文**被写进本地并成为当前 Key
//   [②-b] 用这把 Key 真发一次 `chat/completions` → 请求头里的 Key **等于**列表明文
//   [③-b] 多把同名 → 取 `status=active` 且最新的那一把（不能拿列表第一条）
//   [④-b] 环境一致性：推理地址必须与登录环境（`consume.baseUrl`）同源 —— 两份地址不同环境时用例必须红
//
// 判据不自己编：流程在 `services/api/managedKey.ts` 的 `ensureManagedKey()`（纯逻辑，`ManagedKeySource`
// 由用例注入），接线在 `components/settings/managedKeyRuntime.ts`（单飞 + 落盘 + 日志），
// 触发时机在 `services/auth/store.ts` 的**会话建立钩子**（`setSessionEstablishedHook`）里。
//
//   node --test tests/unit/managed-key-autoauth-803.test.mjs
//   node tests/run-layer.mjs unit --only managed-key-autoauth-803
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'
import { jsonReply, panelOk, recordingTransport } from '../helpers/consume-fixtures.mjs'

// 原生桥 + 诊断写入口替身：apiConfig / collector 会调 recordAction
installChatBridge()
// 构建期注入值（`__ENDPOINTS__`）：apiConfig / providers 顶层就要读
installEndpointsGlobals()
const dom = setupDom()
// 诊断写入口的替身缓冲（`installChatBridge()` 把 `diagnostics/collector.js` 换成了内存桩，
// 见 tests/fixtures/chat-stubs/collector.mjs）：失败日志的断言读它
globalThis.__log = { records: [], events: [], actions: [] }

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')
const managed = await import('../../src/services/api/managedKey.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const view = await import('../../src/components/settings/managedKeyView.ts')
const ensureState = await import('../../src/components/settings/managedKeyEnsureState.ts')
const runtime = await import('../../src/components/settings/managedKeyRuntime.ts')
const { setConsumeClient } = await import('../../src/services/consumeClient.ts')
const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const auth = await import('../../src/services/auth/store.ts')
const providers = await import('../../src/services/api/providers.ts')
const environment = await import('../../src/services/api/environment.ts')
const { streamMessage } = await import('../../src/services/api/client.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const endpointScript = await import('../../scripts/lib/endpoints.mjs')

const { renderToStaticMarkup } = await import('react-dom/server')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/** 设备码（`createDeviceId()` 的真实形状：`d-` + 32 位十六进制） */
const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
/** 这台设备固定的 Key 名（`managedKeyName(DEVICE_ID)`：去掉 `d-` 后前 16 位） */
const KEY_NAME = 'app-0123456789abcdef'
/** 两把服务端 Key（尾号不同即可；Key 原文绝不进日志） */
const SERVER_KEY = 'sk-live-0123456789e849'
const FRESH_KEY = 'sk-live-0123456789b7c1'
const OLD_TOKEN = 'at-previous-user'
const NEW_TOKEN = 'at-new-user'

/** 设计系统 Button 的替身（`testId` → `data-testid`，其余透传） */
const ButtonStub = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

/** CSS Module 类名表替身：取什么给什么（断言不依赖类名，只为让真视图能渲染） */
const classNames = new Proxy({}, { get: (_target, name) => String(name) })

/** 一条服务端 Key 实体（字段名与真实 `APIKey` 一致，snake_case 由消费层转） */
const keyRow = (over = {}) => ({
  id: 42,
  name: KEY_NAME,
  key: SERVER_KEY,
  status: 'active',
  quota: 0,
  quota_used: 0,
  ...over,
})

/** 面板分页信封（`GET /api/v1/keys`） */
const keysPage = (items) =>
  panelOk({ items, total: items.length, page: 1, page_size: 20, pages: 1 })

/** 授权头取值（http 层统一写小写 `authorization`） */
const authOf = (request) => request.headers.authorization ?? request.headers.Authorization ?? ''

/** 请求序列（端点 + 方法，不含 query / host），断言「按什么顺序打了哪些端点」 */
const endpointsOf = (recorder) => recorder.sequence()

/**
 * 用**真**消费层客户端 + 假 transport 拼一个客户端：这样断言的是「到底打了哪些端点、
 * 带的哪个 token、body 里有什么」，而不是对着一个自己编的假 source 自说自话。
 */
const clientFrom = (handler, options = {}) => {
  const recorder = recordingTransport(handler)
  return {
    recorder,
    // 与 `services/consumeClient.ts` 的真实接线同形：凭据**每次请求现取**
    // （所以「刷新之后下一条请求就是新 token」这件事在用例里也是真的）
    client: createConsumeClient({
      transport: recorder.transport,
      accessToken: () => auth.getAccessToken(),
      apiKey: () => apiConfig.getApiKey(),
      ...options,
    }),
  }
}

/** 把客户端收窄成领取链路要的那一小撮能力（与 `managedKeyRuntime.managedKeySource()` 同形） */
const sourceOfClient = (client) => ({
  keys: { list: client.keys.list, create: client.keys.create, update: client.keys.update },
})

/** 失败结果工厂（`ConsumeCallResult` 的 `ok: false` 形态，字段与 `Sub2ApiError` 对齐） */
const callFailure = (status, code) => ({
  ok: false,
  raw: { status, ok: false, text: '', json: null, headers: {}, contentType: '' },
  error: {
    kind: status === 0 ? 'network' : 'server',
    code,
    message: code,
    status,
    retryable: status === 0 || status >= 500,
    envelope: 'unknown',
    i18nKey: 'consumeErrNetwork',
  },
})

/** 一次性假 source：每次调用按顺序吐出预置结果（只剩一个时重复使用），同时记录调用序列 */
const scripted = (results) => {
  const calls = []
  const take = (kind, payload) => {
    calls.push(payload === undefined ? { kind } : { kind, payload })
    const list = results[kind]
    return list.length > 1 ? list.shift() : list[0]
  }
  return {
    calls,
    kinds: () => calls.map((call) => call.kind),
    source: {
      keys: {
        list: async () => take('list'),
        create: async (input) => take('create', input),
        update: async () => callFailure(0, 'TIMEOUT'),
      },
    },
  }
}

/** 每个用例从干净的本地配置 + 干净的单飞槽开始 */
const reset = () => {
  dom.localStorage.clear()
  // 设备码播种：领取链路按「设备固定名 app-<前 16 位>」查重，随机设备码会让预期名对不上
  dom.localStorage.setItem('chat-demo:ours-device-id', DEVICE_ID)
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('')
  apiConfig.clearServerKeyMark()
  ensureState.resetManagedKeyEnsure()
  globalThis.__log = { records: [], events: [], actions: [] }
  setConsumeClient(null)
  auth.setSessionEstablishedHook(null)
  auth.setAuthTransport(null)
  auth.useAuthStore.setState({ state: 'unauthenticated', token: null, user: null, restored: true })
}

/** 假的身份传输层：login / register 都回同一个新会话（注册即登录，成功体同形） */
const fakeAuthTransport = () => {
  const session = () => ({
    ok: true,
    data: {
      token: {
        accessToken: NEW_TOKEN,
        refreshToken: 'rt-new',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3_600_000,
      },
      user: { id: 9, email: 'user-b@example.com', emailVerified: true },
    },
  })
  return {
    login: async () => session(),
    register: async () => session(),
    sendCode: async () => ({ ok: true, data: undefined }),
    refresh: async () => ({
      ok: true,
      data: { accessToken: NEW_TOKEN, tokenType: 'Bearer', expiresAt: null },
    }),
    refreshToken: async () => ({
      ok: true,
      data: { accessToken: NEW_TOKEN, tokenType: 'Bearer', expiresAt: null },
    }),
    me: async () => ({ ok: true, data: { id: 9, email: 'user-b@example.com', emailVerified: true } }),
    logout: async () => ({ ok: true, data: undefined }),
  }
}

/** 「服务端已经有这台设备的 Key」的场景：GET 回同名那把，任何 POST 都算错（票面 ①） */
const existingKeyScene = () =>
  clientFrom((request) =>
    request.method === 'GET'
      ? keysPage([keyRow(), keyRow({ id: 43, name: `${KEY_NAME}-other`, key: 'sk-other-0000' })])
      : jsonReply(500, { code: 500, message: 'should not POST', reason: 'BOOM' })
  )

/** 把「上一个账号还登着」的现场摆好（线上那条「布尔没变过」的病根） */
const pretendPreviousUserSignedIn = () => {
  auth.useAuthStore.setState({
    state: 'authenticated',
    token: { accessToken: OLD_TOKEN, refreshToken: 'rt-old', tokenType: 'Bearer', expiresAt: null },
    user: { id: 1, email: 'user-a@example.com', emailVerified: true },
    restored: true,
  })
}

// ---------------------------------------------------------------- [①] 登录 / 注册即触发 + 查重

test('[①] 注册成功 → 立刻触发一次「确保有 Key」，且第一次请求就带**新** token', async () => {
  reset()
  const { client, recorder } = existingKeyScene()
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  const triggers = []
  auth.setSessionEstablishedHook((reason) => {
    triggers.push(reason)
    void runtime.ensureManagedKeyAfterAuth(reason)
  })
  auth.setAuthTransport(fakeAuthTransport())

  const result = await auth.useAuthStore.getState().signUp({ email: 'user-b@example.com', password: 'pw' })
  assert.equal(result.ok, true, '注册成功（成功体与 login 同形）')
  assert.deepEqual(triggers, ['register'], '注册成功必须通知会话钩子（#803 第 1 条）')

  // 钩子那条已经在飞（单飞）：这里拿到的是它的结局；`updated` = 本机被写成服务端那把，
  // `unchanged` = 之前就已经是那一把 —— 两种都算「拿到了」，关键是**都没有 POST**
  const outcome = await runtime.ensureManagedKeyForDevice()
  assert.ok(['updated', 'unchanged'].includes(outcome), `查重命中 → 本机是服务端那把：${outcome}`)

  assert.deepEqual(
    [...new Set(endpointsOf(recorder))],
    ['GET /api/v1/keys'],
    `只查重、不 POST：${endpointsOf(recorder)}`
  )
  assert.equal(recorder.countOf('POST'), 0, '已有同名 Key 就**不许**再建一把（不重复创建）')
  const first = recorder.calls[0]
  assert.equal(authOf(first), `Bearer ${NEW_TOKEN}`, '第一次请求就必须用**注册拿到的新 token**，不是上一个账号的')
  assert.match(first.url, /page=1/u, '查重分页：page=1')
  assert.match(first.url, /page_size=20/u, '查重分页：page_size=20')
  assert.match(first.url, new RegExp(`search=${KEY_NAME}`, 'u'), '查重条件：search=app-<设备前缀>')
  assert.equal(apiConfig.getApiKey(), SERVER_KEY, '命中的那把要落到本机（界面尾号 = 实际请求那把）')
  assert.notEqual(apiConfig.getServerKeyMark(), null, '下发标记同时写上（否则发送前那道闸判 unclaimed）')
})

test('[①] 登录（不是注册）也走同一条触发路径', async () => {
  reset()
  const { client, recorder } = existingKeyScene()
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  const triggers = []
  auth.setSessionEstablishedHook((reason) => {
    triggers.push(reason)
    void runtime.ensureManagedKeyAfterAuth(reason)
  })
  auth.setAuthTransport(fakeAuthTransport())

  const result = await auth.useAuthStore.getState().signIn({ email: 'user-b@example.com', password: 'pw' })
  assert.equal(result.ok, true)
  assert.deepEqual(triggers, ['login'], '登录成功也要触发（两条路径都要，不能只在启动时跑）')
  assert.ok(['updated', 'unchanged'].includes(await runtime.ensureManagedKeyForDevice()))
  assert.equal(recorder.countOf('POST'), 0)
})

test('[①] 别的渠道不自动领：不许覆盖用户自己的 Key', async () => {
  reset()
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('sk-own-deepseek-9999')
  const { client, recorder } = existingKeyScene()
  setConsumeClient(client)

  const outcome = await runtime.ensureManagedKeyAfterAuth('register')
  assert.equal(outcome, 'unchanged', '非内置渠道 = 这条流程不适用（不是失败）')
  assert.equal(recorder.calls.length, 0, '一个请求都不该发')
  assert.equal(apiConfig.getApiKey(), 'sk-own-deepseek-9999', '用户手填的 Key 不许被覆盖（#608 的硬验收）')
})

// ---------------------------------------------------------------- [②] 没有 Key → 建一次

test('[②] 没有同名 Key → POST 一次成功 → 本机可用（body 里没有 group_id）', async () => {
  reset()
  const { client, recorder } = clientFrom((request) =>
    request.method === 'GET' ? keysPage([]) : panelOk(keyRow({ id: 77, key: FRESH_KEY }))
  )
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  const outcome = await runtime.ensureManagedKeyForDevice()
  assert.equal(outcome, 'updated', '本机从「没有」变成「服务端那把」')
  // 一次 GET（本层查重，参数就是 #803 第 2 条那组）+ 一次 POST —— 查重只做一次、只打一次
  assert.deepEqual(
    endpointsOf(recorder),
    ['GET /api/v1/keys', 'POST /api/v1/keys'],
    '先查重、再建，各一次'
  )
  assert.equal(recorder.countOf('POST'), 1, '只建一把')

  const body = JSON.parse(recorder.calls[1].body)
  assert.deepEqual(Object.keys(body), ['name'], `创建 body 只许有 name：${JSON.stringify(body)}`)
  assert.equal(body.name, KEY_NAME, '沿用既有的 app-<设备前缀> 命名')
  assert.equal('group_id' in body, false, '不许传 group_id（#803 第 3 条）')

  assert.equal(apiConfig.getApiKey(), FRESH_KEY, '界面与请求用的是同一把')
  assert.equal(apiConfig.getManagedKeyVerdict(), 'ok', '发送前那道闸应该放行')
  assert.equal(ensureState.useManagedKeyEnsure.getState().status, 'idle', '成功之后没有留下的失败提示')
})

// ---------------------------------------------------------------- [③] 三种「没拿到」都自动重试一次

test('[③] 第一次超时（status 0）→ 自动重试一次 → 第二次成功', async () => {
  const fixture = scripted({
    list: [
      callFailure(0, 'TIMEOUT'),
      { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20, pages: 1 }, status: 200, raw: {} },
    ],
    create: [{ ok: true, data: keyRow({ key: FRESH_KEY }), status: 201, raw: {} }],
  })
  const result = await managed.ensureManagedKey(fixture.source, { deviceId: DEVICE_ID })
  assert.equal(result.ok, true, '第二次拿到就算成功')
  assert.equal(result.attempts, 2, '一共尝试两次（首次 + 重试一次）')
  assert.equal(result.created, true)
  assert.deepEqual(fixture.kinds(), ['list', 'list', 'create'], '重试是「再查一次再建」')
  assert.deepEqual(fixture.calls[2].payload, { name: KEY_NAME }, '建的时候只带 name')
})

test('[③] 第一次 500 → 自动重试一次 → 第二次成功', async () => {
  const fixture = scripted({
    list: [{ ok: true, data: { items: [], total: 0, page: 1, pageSize: 20, pages: 1 }, status: 200, raw: {} }],
    create: [callFailure(500, 'HTTP_500'), { ok: true, data: keyRow({ key: FRESH_KEY }), status: 201, raw: {} }],
  })
  const result = await managed.ensureManagedKey(fixture.source, { deviceId: DEVICE_ID })
  assert.equal(result.ok, true, '500 也要自动重试一次')
  assert.equal(result.attempts, 2)
})

test('[③] 第一次 2xx 但响应里没有 Key 值 → 也算没拿到 → 自动重试一次', async () => {
  const fixture = scripted({
    list: [{ ok: true, data: { items: [], total: 0, page: 1, pageSize: 20, pages: 1 }, status: 200, raw: {} }],
    create: [
      { ok: true, data: keyRow({ id: 78, key: '' }), status: 201, raw: {} },
      { ok: true, data: keyRow({ key: FRESH_KEY }), status: 201, raw: {} },
    ],
  })
  const result = await managed.ensureManagedKey(fixture.source, { deviceId: DEVICE_ID })
  assert.equal(result.ok, true, '2xx 但没有 Key 值 = 没拿到，不许当成功')
  assert.equal(result.attempts, 2)
  assert.equal(fixture.kinds().filter((kind) => kind === 'create').length, 2, '建了两次（第二次才拿到 Key 值）')
})

test('[③] 重试上限就是 2 次尝试（不许无限循环）', () => {
  assert.equal(managed.MANAGED_KEY_MAX_ATTEMPTS, 2, '「只自动重试一次」= 常量 2 次尝试')
})

// ---------------------------------------------------------------- [④] 两次都失败：可见 + 有日志

test('[④] 两次都失败 → 状态里留下原因（带状态码），界面出提示 +「重试」', async () => {
  reset()
  const { client, recorder } = clientFrom((request) =>
    request.method === 'GET' ? keysPage([]) : jsonReply(500, { code: 500, message: 'db down', reason: 'INTERNAL' })
  )
  setConsumeClient(client)
  pretendPreviousUserSignedIn()
  // 从**注册成功**那一刻进来（这条流程真实的入口就是它）
  auth.setSessionEstablishedHook((reason) => {
    void runtime.ensureManagedKeyAfterAuth(reason)
  })
  auth.setAuthTransport(fakeAuthTransport())
  await auth.useAuthStore.getState().signUp({ email: 'user-b@example.com', password: 'pw' })

  const outcome = await runtime.ensureManagedKeyForDevice()
  assert.equal(outcome, 'failed', '两次都没拿到 → failed（不是静默）')
  assert.equal(recorder.countOf('POST'), 2, '建了两次（首次 + 重试一次），不多不少')
  assert.equal(recorder.countOf('GET'), 2, '每次尝试都先查重（重试也不许跳过查重）')

  const state = ensureState.useManagedKeyEnsure.getState()
  assert.equal(state.status, 'failed')
  assert.equal(state.failure.kind, 'http')
  assert.equal(state.failure.status, 500, '失败原因里必须有**状态码**')
  assert.equal(state.failure.code, 'INTERNAL', '服务端给的码也要留下')
  assert.equal(state.attempts, 2)

  // 日志：失败必须留痕，且带状态码（#803 第 5 条原文要求）
  const ensureActions = globalThis.__log.actions.filter(
    (item) => item.action === 'ours-managed-key-ensure'
  )
  assert.ok(ensureActions.length >= 1, `诊断里要有一条 ours-managed-key-ensure：${JSON.stringify(globalThis.__log.actions)}`)
  assert.equal(ensureActions[0].fields.trigger, 'auth-register', '触发时机要记下来')

  const failed = ensureActions.filter((item) => item.fields.result === 'failed')
  assert.ok(failed.length >= 1, '失败日志必须真的写下来（不许静默失败）')
  const last = failed[failed.length - 1]
  assert.equal(last.fields.status, 500, '日志里要有状态码')
  assert.equal(last.fields.attempts, 2, '日志里要有尝试次数')
  assert.equal(last.fields.kind, 'http', '日志里要有失败性质')
  assert.equal(last.fields.stop, 'attempts-exhausted', '日志里要说清为什么停手')

  // 界面：可见提示 +「重试」按钮，文案里带状态码
  const markup = renderToStaticMarkup(
    createElement(view.ManagedKeyEnsureBanner, {
      t: translate,
      status: state.status,
      failure: state.failure,
      attempts: state.attempts,
      onRetry() {},
      Button: ButtonStub,
      styles: classNames,
    })
  )
  assert.match(markup, /自动获取 Key 失败/u, `必须说清发生了什么：${markup}`)
  assert.match(markup, /500/u, '提示里要有状态码（只说「失败了」等于没说）')
  assert.match(markup, /data-testid="settings-managed-key-ensure-retry"/u, '必须带一个「重试」按钮')
  assert.match(markup, />重试</u, '按钮文案 = 重试')
})

test('[④] 「重试」按钮真的再跑一轮完整流程（查重 → 建），不是只清提示', async () => {
  reset()
  const { client, recorder } = clientFrom((request) =>
    request.method === 'GET' ? keysPage([]) : panelOk(keyRow({ id: 91, key: FRESH_KEY }))
  )
  setConsumeClient(client)
  pretendPreviousUserSignedIn()
  // 先摆一个「上一轮两次都失败」的状态
  ensureState.markManagedKeyEnsureFailed(
    { kind: 'http', status: 500, code: 'INTERNAL', step: 'create', detail: 'POST /api/v1/keys 失败' },
    2
  )

  // 从视图树里把那个按钮找出来点一下（等价于点「重试」）
  let clicks = 0
  const tree = view.ManagedKeyEnsureBanner({
    t: translate,
    status: 'failed',
    failure: ensureState.useManagedKeyEnsure.getState().failure,
    attempts: 2,
    onRetry: () => {
      clicks += 1
      void runtime.ensureManagedKeyForDevice()
    },
    Button: ButtonStub,
    styles: classNames,
  })
  const findButton = (node) => {
    if (node === null || typeof node !== 'object') {
      return null
    }
    if (node.props?.testId === 'settings-managed-key-ensure-retry') {
      return node
    }
    const children = node.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      const found = findButton(child)
      if (found !== null) {
        return found
      }
    }
    return null
  }
  const button = findButton(tree)
  assert.notEqual(button, null, '视图里必须有「重试」按钮')
  button.props.onClick()
  assert.equal(clicks, 1, '点一下 = 一次重试')
  assert.equal(await runtime.ensureManagedKeyForDevice(), 'updated')
  assert.deepEqual(endpointsOf(recorder), ['GET /api/v1/keys', 'POST /api/v1/keys'], '重试走同一条流程')
  assert.equal(ensureState.useManagedKeyEnsure.getState().status, 'idle', '成功之后提示才收掉')
})

test('[④] 两条文案中文与英文都成对（界面不许出现空块）', () => {
  for (const key of [
    'settingsManagedKeyEnsureFailed',
    'settingsManagedKeyEnsureFailedHint',
    'settingsManagedKeyFailNetwork',
    'settingsManagedKeyFailHttp',
    'settingsManagedKeyFailEmpty',
  ]) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.ok(zh[key].trim().length > 0 && en[key].trim().length > 0, `${key} 不许是空串`)
  }
  assert.match(zh.settingsManagedKeyEnsureFailed, /\{reason\}/u, '中文占位符')
  assert.match(en.settingsManagedKeyEnsureFailed, /\{reason\}/u, '英文占位符（R2 占位符对齐）')
})

// ---------------------------------------------------------------- [⑤] 401 先换凭据

test('[⑤] 第一次 401 → 先 refresh，再用**新 token** 重试（断言重试那次带的是新 token）', async () => {
  let token = OLD_TOKEN
  let refreshed = 0
  const recorder = recordingTransport((request) => {
    if (authOf(request) === `Bearer ${NEW_TOKEN}`) {
      return request.method === 'GET' ? keysPage([]) : panelOk(keyRow({ id: 55, key: FRESH_KEY }))
    }
    return jsonReply(401, { code: 401, message: 'invalid token', reason: 'UNAUTHORIZED' })
  })
  const client = createConsumeClient({ transport: recorder.transport, accessToken: () => token })

  const result = await managed.ensureManagedKey(sourceOfClient(client), {
    deviceId: DEVICE_ID,
    refresh: async () => {
      refreshed += 1
      token = NEW_TOKEN
      return 'refreshed'
    },
  })

  assert.equal(result.ok, true, '换了凭据之后重试成功')
  assert.equal(result.attempts, 2)
  assert.equal(refreshed, 1, '重试前**先**刷新凭据，且只刷一次')
  const tokens = recorder.calls.map(authOf)
  assert.equal(tokens[0], `Bearer ${OLD_TOKEN}`, '第一次用的还是手上那颗（已经废了的）token')
  assert.equal(tokens[1], `Bearer ${NEW_TOKEN}`, '重试那次必须用**新** token（不许拿旧 token 重试）')
})

test('[⑤] 401 且换不到新凭据 → 停手，不拿旧 token 再打一次', async () => {
  const recorder = recordingTransport(() =>
    jsonReply(401, { code: 401, message: 'invalid', reason: 'UNAUTHORIZED' })
  )
  const client = createConsumeClient({ transport: recorder.transport, accessToken: () => OLD_TOKEN })

  const result = await managed.ensureManagedKey(sourceOfClient(client), {
    deviceId: DEVICE_ID,
    refresh: async () => 'expired',
  })
  assert.equal(result.ok, false)
  assert.equal(result.stop, 'refresh-failed', '换不到凭据就以 refresh-failed 收场')
  assert.equal(result.refreshed, false)
  assert.equal(recorder.calls.length, 1, '**只打了一次**：不拿旧 token 重试（#803 第 6 条）')
  assert.equal(result.failures[0].status, 401)
})

// ---------------------------------------------------------------- [⑥] 并发只建一把

test('[⑥] 并发：profile 与建 Key 同时触发 → 只建出 1 把 Key', async () => {
  reset()
  let created = 0
  const { client, recorder } = clientFrom((request) => {
    if (request.method === 'GET') {
      return keysPage([])
    }
    created += 1
    return panelOk(keyRow({ id: 100 + created, key: FRESH_KEY }))
  })
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  // 两条触发路径同时进来（登录钩子那条 + 页面 effect 那条）
  const [a, b] = await Promise.all([
    runtime.ensureManagedKeyForDevice(),
    runtime.ensureManagedKeyForDevice(),
  ])
  assert.equal(a, b, '等的是同一个 promise（单飞）')
  assert.equal(recorder.countOf('POST'), 1, '服务端只该看到一次 POST /api/v1/keys')
  assert.equal(created, 1, '只建出一把 Key')
})

// ---------------------------------------------------------------- [⑦] 退出登录清态

test('[⑦] 退出登录 → 本机 Key + 下发标记 + token 全清（换号不会用旧 Key）', async () => {
  reset()
  // 上一个账号（A）领到的那把 Key 还留在本机
  assert.equal(apiConfig.applyManagedKey(SERVER_KEY, 42), true)
  pretendPreviousUserSignedIn()
  ensureState.markManagedKeyEnsureFailed(
    { kind: 'http', status: 401, code: 'UNAUTHORIZED', step: 'create', detail: 'x' },
    2
  )
  assert.equal(apiConfig.getApiKey(), SERVER_KEY)

  auth.setAuthTransport(fakeAuthTransport())
  await auth.useAuthStore.getState().signOut()

  assert.equal(apiConfig.getApiKey(), '', 'A 的 Key 必须被清掉（B 登录后不许拿 A 的 Key 发消息）')
  assert.equal(apiConfig.getServerKeyMark(), null, '下发标记一起清（只清 Key 会判出假的 stale）')
  assert.equal(auth.getAccessToken(), undefined, 'token 也一起清')
  assert.equal(ensureState.useManagedKeyEnsure.getState().failure, null, '失败提示是账号维度的，切号要清')
  assert.equal(auth.useAuthStore.getState().state, 'unauthenticated')
})

test('[⑦] 别的渠道退出登录时不动用户自己的 Key（对照，不许误清）', async () => {
  reset()
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('sk-own-deepseek-9999')
  pretendPreviousUserSignedIn()
  auth.setAuthTransport(fakeAuthTransport())

  await auth.useAuthStore.getState().signOut()
  assert.equal(apiConfig.getApiKey(), 'sk-own-deepseek-9999', '用户手填的 Key 不属于账号，退出登录不该抹掉它')
})

// ---------------------------------------------------------------- 接线（源码断言）

test('[接线] 会话钩子在 main.tsx 挂上、领取链路只此一份', () => {
  const main = sourceOf('src/main.tsx')
  assert.match(main, /setSessionEstablishedHook\(/u, 'main.tsx 必须把会话建立钩子挂上（否则等于没做 #803）')
  assert.match(main, /ensureManagedKeyAfterAuth/u, '钩子里调的是领取链路（不是另写一套）')

  const store = sourceOf('src/services/auth/store.ts')
  assert.match(store, /applySession\(result\.data, 'login'\)/u, '登录成功要带 reason=login')
  assert.match(store, /applySession\(result\.data, 'register'\)/u, '注册成功要带 reason=register')

  const page = sourceOf('src/components/consume/AccountConsumePage.tsx')
  assert.match(page, /ManagedKeyEnsureBanner/u, '账号页 / 内置服务子页要渲染失败提示 +「重试」')
  assert.match(page, /ensureManagedKeyForDevice/u, '「重试」按钮走的是同一条领取链路')

  // 复用既有实现，不另写一套 client：领取链路仍然只经 getConsumeClient() 的 keys 三件套
  const runtimeSource = sourceOf('src/components/settings/managedKeyRuntime.ts')
  assert.match(runtimeSource, /getConsumeClient\(\)/u, '复用既有消费层客户端')
  assert.match(
    runtimeSource,
    /syncManagedKey\(/u,
    '流程来自 services/api/managedKey.ts（复用 #596/#717 那套，`syncManagedKey` → `ensureManagedKey`）'
  )
  assert.equal(
    /fetch\(|CapacitorHttp|new URL\(/u.test(runtimeSource),
    false,
    '接线层不许自己拼请求（路径白名单在 services/consume/**）'
  )
})

// ------------------------------------------------ #812：查到的 Key 必须**取回并生效**

/**
 * #812 的现场（staging）：
 *   `POST /auth/register 200` → `GET /user/profile 200` → `GET /keys?...&search=app-…` **200（查到了那把 Key）**
 *   → 之后**没有任何 `POST /keys`，也没有推理请求**，客户端却提示「Key 无效」。
 * 服务端拿同一把 Key 直连网关 200、计费正常 —— Key 是好的，是客户端「查到了但没用上」。
 *
 * 所以下面三条打在「取回 → 写盘 → 生效 → 真的发出去」这条链上，而不是「名字存在就 return」。
 */

/** 上一把（旧）Key：本机本来就有，且带着自己的下发标记 —— 新账号那把必须把它换掉 */
const STALE_KEY = 'sk-live-stale-00000000'
/** 明文必须**逐字**进本地存储：这是「取回」与「只是比了一下」的分界 */
const LOCAL_KEY_SLOT = 'chat-demo:api-key'

test('[①-b] 服务端已有同名 Key → 不 POST，且把列表那把的**明文**写进本地并成为当前 Key', async () => {
  reset()
  // 本机先留着上一把（旧 Key + 旧标记）：只有真的「取回并落盘」才会变成本机正在用的这把
  assert.equal(apiConfig.applyManagedKey(STALE_KEY, 41), true)
  const { client, recorder } = existingKeyScene()
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  const outcome = await runtime.ensureManagedKeyForDevice()

  assert.deepEqual(endpointsOf(recorder), ['GET /api/v1/keys'], '只查重：查到了就**不许**再建一把')
  assert.equal(recorder.countOf('POST'), 0, '一次 POST /keys 都不许有')
  assert.equal(outcome, 'updated', '本机被写成服务端那把（不是「名字存在所以什么都不用做」）')

  // ① 明文取回来了，而且真的落到了本地存储（不是只在内存里比了一下）
  assert.equal(apiConfig.getApiKey(), SERVER_KEY, '当前推理用的 Key = 列表里那把的明文')
  assert.equal(dom.localStorage.getItem(LOCAL_KEY_SLOT), SERVER_KEY, '明文必须写进本地存储（重启后仍然是这把）')

  // ② 下发标记跟着这一把（否则发送前那道闸判 unclaimed / stale）
  const mark = apiConfig.getServerKeyMark()
  assert.notEqual(mark, null, '下发标记必须写上')
  assert.equal(mark.fingerprint, managed.serverKeyMark(SERVER_KEY).fingerprint, '标记的指纹必须属于**这一把**')
  assert.equal(mark.id, 42, '标记里记的是列表里那把的 id（换 Key 之后要靠它停用旧的）')
  assert.equal(apiConfig.getManagedKeyVerdict(), 'ok', '发送前那道闸放行')

  // ③ 日志说得清这次是「沿用（adopted）」而不是「新建」
  const ensureActions = globalThis.__log.actions.filter(
    (item) => item.action === 'ours-managed-key-ensure' && item.fields.result === 'updated'
  )
  assert.ok(ensureActions.length >= 1, '成功也要留痕')
  assert.equal(ensureActions[ensureActions.length - 1].fields.created, false, '这次没有新建 Key')
  assert.equal(ensureActions[ensureActions.length - 1].fields.adopted, true, '日志里要能分出「沿用服务端那把」这条路')
})

test('[②-b] 用这把 Key 真发一次 chat/completions → 请求头里的 Key 等于列表那把明文', async () => {
  reset()
  apiConfig.applyManagedKey(STALE_KEY, 41)
  const { client } = existingKeyScene()
  setConsumeClient(client)
  pretendPreviousUserSignedIn()
  assert.equal(await runtime.ensureManagedKeyForDevice(), 'updated')

  // 真链路：`streamMessage` 会自己拼地址与鉴权头（不是用例里另拼一份）
  const requests = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
      ),
    })
    const chunk = (delta) => `data: ${JSON.stringify({ id: 'chatcmpl-812', choices: [{ index: 0, delta }] })}\n\n`
    const payload = `${chunk({ role: 'assistant', content: '' })}${chunk({ content: '收到' })}${chunk({})}data: [DONE]\n\n`
    return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  try {
    const body = buildMessageBody(apiConfig.getCurrentSpec(), {
      model: apiConfig.getModel(),
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }],
      thinking: false,
      search: false,
      title: false,
    })
    for await (const event of streamMessage(apiConfig.getApiKey(), body, new AbortController().signal)) {
      assert.ok(typeof event?.type === 'string', '流里应当只有可识别的事件')
    }
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(requests.length, 1, '一次调用只发一个请求')
  const sent = requests[0]
  assert.equal(sent.headers.authorization, `Bearer ${SERVER_KEY}`, '请求头里必须是**列表那把的明文**，不是本机残留的旧 Key')
  // 地址与登录同环境（#812 第 3 条）：推理打的不是另一份「旧池域」
  assert.equal(sent.url, apiConfig.getMessagesUrl(), '推理地址取当前生效的 baseUrl + paths.messages')
})

test('[③-b] 多把同名 → 取 status=active 且**最新**的那一把（不是列表第一条）', async () => {
  // 纯判据：先按名字精确过滤 → active 优先 → 同状态取最新（createdAt，缺失时退回 id）
  const rows = [
    { id: 11, name: KEY_NAME, key: 'sk-old-inactive-1111', status: 'inactive', quota: 0, quotaUsed: 0, createdAt: '2026-03-09T00:00:00Z' },
    { id: 12, name: KEY_NAME, key: 'sk-active-older-2222', status: 'active', quota: 0, quotaUsed: 0, createdAt: '2026-03-01T00:00:00Z' },
    { id: 13, name: KEY_NAME, key: 'sk-active-newest-33', status: 'active', quota: 0, quotaUsed: 0, createdAt: '2026-03-08T00:00:00Z' },
    { id: 14, name: `${KEY_NAME}-other`, key: 'sk-other-4444', status: 'active', quota: 0, quotaUsed: 0, createdAt: '2026-03-10T00:00:00Z' },
  ]
  const picked = managed.pickManagedKey(rows, KEY_NAME)
  assert.equal(picked.id, 13, '同名里取 active + 最新那一把')
  assert.equal(picked.key, 'sk-active-newest-33')

  // 没有 active 时退到「最新那把」（总比一条都不用强：至少本机有一把，界面能说清是哪把）
  const noActive = managed.pickManagedKey(
    [
      { id: 21, name: KEY_NAME, key: 'sk-inactive-older-21', status: 'inactive', quota: 0, quotaUsed: 0 },
      { id: 22, name: KEY_NAME, key: 'sk-inactive-newest-2', status: 'inactive', quota: 0, quotaUsed: 0 },
    ],
    KEY_NAME
  )
  assert.equal(noActive.id, 22, '没有 active 时取最新（时间戳缺失按 id 判新旧）')

  // 明文为空的不算命中（`key` 取不到 = 没拿到，不许当成功）
  assert.equal(
    managed.pickManagedKey([{ id: 90, name: KEY_NAME, key: '   ', status: 'active', quota: 0, quotaUsed: 0 }], KEY_NAME),
    undefined,
    '`key` 是空串 / 空白的条目不算命中'
  )

  // 端到端：列表第一条是被停用的那把（且最新），本机不许采用它
  reset()
  const { client, recorder } = clientFrom((request) =>
    request.method === 'GET'
      ? keysPage([
          keyRow({ id: 11, status: 'inactive', key: 'sk-old-inactive-1111', created_at: '2026-03-09T00:00:00Z' }),
          keyRow({ id: 12, status: 'active', key: 'sk-active-older-2222', created_at: '2026-03-01T00:00:00Z' }),
          keyRow({ id: 13, status: 'active', key: 'sk-active-newest-33', created_at: '2026-03-08T00:00:00Z' }),
        ])
      : jsonReply(500, { code: 500, message: 'should not POST', reason: 'BOOM' })
  )
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  assert.equal(await runtime.ensureManagedKeyForDevice(), 'updated')
  assert.equal(recorder.countOf('POST'), 0, '同名多把也**不许**再建一把')
  assert.equal(apiConfig.getApiKey(), 'sk-active-newest-33', '本机用的必须是 active 且最新的那把，不是列表第一条（被停用的）')
  assert.equal(apiConfig.getServerKeyMark().id, 13, '标记跟着选中的那一把')
})

test('[④-b] 环境一致性：推理地址必须与登录环境同源（两份地址不同环境时用例必须红）', () => {
  // ① 真注入表：推理地址就是「登录环境」，不是另一个开关配出来的值
  const oursSpec = providers.PROVIDER_SPECS.find((spec) => spec.kind === 'ours')
  assert.equal(
    oursSpec.defaults.baseUrl,
    environment.inferenceBaseUrl(globalThis.__ENDPOINTS__),
    '推理地址只能从注入表按 inferenceBaseUrl() 派生（不许各写一份）'
  )
  assert.equal(
    environment.inferenceMatchesLoginEnvironment(globalThis.__ENDPOINTS__),
    true,
    '真注入表里推理与登录必须同环境'
  )
  // 脚本侧（用例 / 截图 / e2e 用它取同一个值）与源码侧同源
  assert.equal(endpointScript.inferenceBaseUrl, endpointScript.consumeBaseUrl, '脚本侧同样以 consume.baseUrl 作为推理地址')

  // ② 负向：一份「登录在子路径、推理在另一台机器」的表 —— 这正是 #812 的现场（staging vs 生产池）
  //    地址全部是合成域名：用例不认产品域名，只认「环境」这件事本身。
  const login = 'https://login.test.invalid/staging'
  const pool = 'https://pool.test.invalid:60010'
  const stagingTable = { chatBaseUrl: pool, consume: { baseUrl: login } }
  assert.equal(environment.inferenceBaseUrl(stagingTable), login, '推理必须跟着登录环境走')
  assert.equal(environment.inferenceMatchesLoginEnvironment(stagingTable), true)
  // 老实现（推理取 chatBaseUrl）在这张表上就是**不同环境** —— 这条断言红，说明用例真能暴露它
  assert.equal(
    environment.sameEndpointEnvironment(pool, login),
    false,
    '取 chatBaseUrl 当推理地址时与登录环境不一致：这就是「Key 有效却提示 Key 无效」的根因'
  )

  // ③ 没有登录环境时不算「一致」：fail-closed，宁可报警也不要静默打到别处
  assert.equal(environment.inferenceMatchesLoginEnvironment({ chatBaseUrl: pool }), false, '缺 consume.baseUrl 时不许判一致')

  // ④ 环境 = origin + 路径第一段：同 host 的 /staging 与 /prod 是两个环境；更深的路径段不是
  assert.equal(environment.sameEndpointEnvironment('https://h.test.invalid/staging', 'https://h.test.invalid/prod'), false)
  assert.equal(environment.sameEndpointEnvironment('https://h.test.invalid/staging', 'https://h.test.invalid/staging/v1'), true)
  assert.equal(environment.sameEndpointEnvironment('', 'https://h.test.invalid'), false, '空地址判不出来 → 不算一致')
})

test('[④-b] 自动领取失败时，banner 里带「Key 前 6 位」与「请求地址」（#803 那条提示的增强）', async () => {
  reset()
  // 本机有一把（前 6 位 = `sk-liv`），这次领取两次都失败
  apiConfig.setApiKey(SERVER_KEY)
  const { client } = clientFrom(() => jsonReply(500, { code: 500, message: 'db down', reason: 'INTERNAL' }))
  setConsumeClient(client)
  pretendPreviousUserSignedIn()

  assert.equal(await runtime.ensureManagedKeyForDevice(), 'failed')

  const state = ensureState.useManagedKeyEnsure.getState()
  assert.notEqual(state.context, null, '失败必须留下现场（Key 前 6 位 + 请求地址）')
  assert.equal(state.context.keyPrefix, SERVER_KEY.slice(0, 6), '取当前 Key 的前 6 位，够定位即可（不是钥匙本体）')
  assert.equal(state.context.requestUrl, apiConfig.getMessagesUrl(), '带上这把 Key 真正会被打到的地址')

  const markup = renderToStaticMarkup(
    createElement(view.ManagedKeyEnsureBanner, {
      t: translate,
      status: state.status,
      failure: state.failure,
      attempts: state.attempts,
      context: state.context,
      onRetry() {},
      Button: ButtonStub,
      styles: classNames,
    })
  )
  assert.match(markup, /500/u, '状态码照旧要在')
  assert.match(markup, new RegExp(SERVER_KEY.slice(0, 6), 'u'), `提示里要有 Key 前 6 位：${markup}`)
  assert.match(markup, /data-testid="settings-managed-key-ensure-context"/u, '现场那一行要可被断言')
  assert.equal(markup.includes(SERVER_KEY), false, '完整 Key 绝不许上屏（只能是前 6 位）')

  // 失败日志里也要有（下次翻日志能直接对上一个地址）
  const failed = globalThis.__log.actions.filter(
    (item) => item.action === 'ours-managed-key-ensure' && item.fields.result === 'failed'
  )
  assert.equal(failed[failed.length - 1].fields.keyPrefix, SERVER_KEY.slice(0, 6), '日志带 Key 前 6 位')
  assert.equal(failed[failed.length - 1].fields.requestUrl, apiConfig.getMessagesUrl(), '日志带请求地址')
})

test('[④-b] 中英文案成对：现场那一行 + 两个占位词', () => {
  for (const key of ['settingsManagedKeyEnsureContext', 'settingsManagedKeyNoKeyYet', 'settingsManagedKeyNoAddress']) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.ok(zh[key].trim().length > 0 && en[key].trim().length > 0, `${key} 不许是空串`)
  }
  assert.match(zh.settingsManagedKeyEnsureContext, /\{keyPrefix\}/u, '中文占位符：Key 前缀')
  assert.match(zh.settingsManagedKeyEnsureContext, /\{address\}/u, '中文占位符：请求地址')
  assert.match(en.settingsManagedKeyEnsureContext, /\{keyPrefix\}/u, '英文占位符（R2 占位符对齐）')
  assert.match(en.settingsManagedKeyEnsureContext, /\{address\}/u, '英文占位符：请求地址')
})
