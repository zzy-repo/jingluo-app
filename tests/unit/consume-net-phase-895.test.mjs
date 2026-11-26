// [layer: unit | 依赖: 无（纯 Node：`@capacitor/core` 用替身，零网络） | 耗时: <3s]
//
// Issue #895 的 follow-up：**消费链路也要能说出「卡在哪一段」**。
//
// 改前的事实（这是本用例立项的理由，不是猜测）：
//   `src/services/consume/http.ts` 的 `failureOf()` 只回答一个问题 ——「超时还是连不上」，
//   于是 `CapacitorHttp` 抛上来的 `java.net.UnknownHostException` / `SSLHandshakeException` /
//   `ConnectException` 全部被折成 `'network'`。**原生栈明明把 DNS / TCP / TLS 的原话给了**，
//   信息是在这一层被扔掉的：登录、额度、卡密三条链路因此都只能说「连不上服务端」，
//   而这三条路正是用户最没法自助排查的地方（要改 DNS？换网络？还是服务器挂了？）。
//
// 本用例钉两件事，顺序不能颠倒：
//   1. **对外契约一个字不变**（`kind` / `code` / `i18nKey` / `retryable` / `status` / `message`）——
//      `phase` 是**新增的可选字段**，老调用点与老落盘数据都当它不存在也能跑；
//   2. **新增的 `phase` 必须真的分得开** DNS / TCP / TLS，而不是把它们塞进同一档。
//
// 红→绿的口径：本文件先于实现写就。改前跑它，`result.net` / `error.phase` 全是 `undefined`
// （信息在 `failureOf()` 就被折掉了），断言会红在「phase 应为 dns，实际 undefined」；
// 实现之后同一批断言转绿。
//
//   node --test tests/unit/consume-net-phase-895.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inlineModule, installTsResolve } from '../helpers/dom-env.mjs'

/**
 * `@capacitor/core` 替身：`isNativePlatform()` 读 `globalThis.__native`，
 * `CapacitorHttp.request()` 转给 `globalThis.__capacitorHttpRequest`（用例逐条塞行为）。
 * 与 `tests/unit/export-selected-native-536.test.mjs` 同一套写法，不另造风格。
 */
installTsResolve({
  stubs: [
    [
      /^@capacitor\/core$/,
      inlineModule(`
export const Capacitor = { isNativePlatform: () => globalThis.__native === true }
export const CapacitorHttp = {
  request: (options) => globalThis.__capacitorHttpRequest(options),
}
`),
    ],
  ],
})

const { capacitorTransport, createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { parseSub2ApiError } = await import('../../src/services/consume/errors.ts')

/**
 * 原生栈**真实形态**的异常文本（Android `HttpURLConnection` / OkHttp 经 Capacitor 抛上来）。
 * 这三条就是 #895 立项时点名的那三个类，不是编出来的字符串。
 */
const NATIVE_DNS =
  'java.net.UnknownHostException: Unable to resolve host "gw.example.com": No address associated with hostname'
const NATIVE_TCP = 'java.net.ConnectException: Failed to connect to gw.example.com/10.0.0.1:443'
const NATIVE_TLS =
  'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.'

/** 一次典型的面板请求（形状与 `createConsumeHttp` 拼出来的一致） */
const request = (overrides = {}) => ({
  method: 'GET',
  url: 'https://consume.test/api/v1/payment/orders/my',
  headers: { accept: 'application/json', authorization: 'Bearer jwt-abc' },
  timeoutMs: 5000,
  ...overrides,
})

/** 让原生分支抛指定异常跑一次（跑完一定还原，不留脏全局） */
const withNativeThrow = async (message, run) => {
  globalThis.__native = true
  globalThis.__capacitorHttpRequest = async () => {
    const error = new Error(message)
    error.name = message.split(':')[0]
    throw error
  }
  try {
    return await run()
  } finally {
    globalThis.__native = false
    delete globalThis.__capacitorHttpRequest
  }
}

/** 传输层结果 → 归一化错误（走的正是 `call()` 里那条真实路径） */
const errorOf = (result) =>
  parseSub2ApiError({
    status: 0,
    ok: false,
    text: '',
    json: null,
    headers: {},
    contentType: '',
    failure: result.kind,
    ...(result.net === undefined ? {} : { net: result.net }),
  })

/**
 * **对外契约的基线**（改前改后必须逐字相同）。
 *
 * 为什么写成常量而不是「看着差不多」：这一层被登录 / 额度 / 卡密 / 订单四条业务链路共用，
 * `code` 与 `i18nKey` 是它们分支的依据 —— 为了多一个 `phase` 而改掉 `code`，
 * 界面文案就会跟着换档，那不是本单该做的事。
 */
const CONTRACT = {
  network: { kind: 'network', code: 'NETWORK', i18nKey: 'consumeErrNetwork', retryable: true },
}

test('[C1] 改前 → 改后：对外契约一个字不变（只多一个可选 phase）', async () => {
  await withNativeThrow(NATIVE_DNS, async () => {
    const result = await capacitorTransport(request())
    assert.equal(result.kind, 'network', '「连不上」仍然是 network（不新造 kind）')
    const error = errorOf(result)
    for (const [field, expected] of Object.entries(CONTRACT.network)) {
      assert.equal(error[field], expected, `对外的 ${field} 不许变（业务链路按它分支）`)
    }
    assert.equal(error.status, 0, '没拿到响应 → status 0')
    assert.equal(error.envelope, 'none', '没有响应体 → envelope none')
  })
})

test('[C2] java.net.UnknownHostException → phase=dns', async () => {
  await withNativeThrow(NATIVE_DNS, async () => {
    const result = await capacitorTransport(request())
    assert.equal(
      result.net?.phase,
      'dns',
      '原生栈说「域名解析不出来」，这一档必须在传输层就留下来（改前这里是 undefined）'
    )
    const error = errorOf(result)
    assert.equal(error.phase, 'dns', 'Sub2ApiError 也要带上，界面 / 日志才说得清')
    assert.equal(error.code, 'NETWORK', 'code 不变：dns 不新造错误码')
    assert.equal(error.i18nKey, 'consumeErrNetwork', '文案不变：界面仍说「连不上」，细分只进 phase')
  })
})

test('[C3] javax.net.ssl.SSLHandshakeException → phase=tls', async () => {
  await withNativeThrow(NATIVE_TLS, async () => {
    const result = await capacitorTransport(request())
    assert.equal(
      result.net?.phase,
      'tls',
      '证书 / 握手失败与「连不上」是两件不同的事：修法不同（换地址 / 查证书 / 换网络）'
    )
    assert.equal(errorOf(result).phase, 'tls')
  })
})

test('[C4] java.net.ConnectException → phase=tcp', async () => {
  await withNativeThrow(NATIVE_TCP, async () => {
    const result = await capacitorTransport(request())
    assert.equal(result.net?.phase, 'tcp', '端口不通是 TCP 段，不是 DNS、也不是 TLS')
    assert.equal(errorOf(result).phase, 'tcp')
  })
})

test('[C5] 三种原生异常彼此可分辨（不许全折成同一档）', async () => {
  const phases = []
  for (const text of [NATIVE_DNS, NATIVE_TCP, NATIVE_TLS]) {
    await withNativeThrow(text, async () => {
      phases.push((await capacitorTransport(request())).net?.phase)
    })
  }
  assert.deepEqual(phases, ['dns', 'tcp', 'tls'], `三条链路必须各自可分辨，实际：${phases.join(' / ')}`)
  assert.equal(new Set(phases).size, 3, '不许有两档撞成同一个值')
})

test('[C6] 超时仍然叫 timeout，且不硬塞一个传输 phase 冒充知道', async () => {
  globalThis.__native = true
  globalThis.__capacitorHttpRequest = async () => {
    throw new Error('timeout')
  }
  try {
    const result = await capacitorTransport(request())
    assert.equal(result.kind, 'timeout', '超时仍然是自己的 kind（改前口径不变）')
    const error = errorOf(result)
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.i18nKey, 'consumeErrTimeout')
    // 「超时」说明的是「多久没回」，它可能是 DNS、TCP 也可能是 TLS —— 没有原生原话就只能说不知道
    assert.equal(error.phase, undefined, '没有证据就不给结论：#895 第 4 条纪律')
  } finally {
    globalThis.__native = false
    delete globalThis.__capacitorHttpRequest
  }
})

test('[C7] 端到端：call() 抛出来的 Sub2ApiError 带着 phase，老字段照旧', async () => {
  const endpoints = {
    baseUrl: 'https://consume.test',
    apiV1Prefix: '/api/v1',
    gatewayPrefix: '/v1',
    timeoutMs: { read: 5000, write: 5000, redeem: 5000 },
  }
  await withNativeThrow(NATIVE_DNS, async () => {
    const http = createConsumeHttp({ endpoints, accessToken: () => 'jwt-abc' })
    const result = await http.call({ method: 'GET', path: '/api/v1/payment/orders/my' })
    assert.equal(result.ok, false, '没拿到响应 → 业务调用失败')
    if (result.ok) {
      return
    }
    assert.equal(result.error.kind, 'network')
    assert.equal(result.error.code, 'NETWORK')
    assert.equal(result.error.phase, 'dns', 'phase 要一路透到业务层（登录 / 额度 / 卡密都读它）')
  })
})
