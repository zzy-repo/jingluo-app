// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <3s]
//
// Issue #895：网络失败要能说出**发生在哪一段**（`NetFailurePhase`），并且这个结论
// 必须进错误对象、进「复制诊断信息」，`api/errors.ts` 的重试判定改为读它。
//
// 改前的事实（本单的立项理由）：
//   · `ApiError` 只有 `kind`（http/network/timeout/idle/…）+ `status` + 上游 code，
//     **没有 phase**：DNS 解析失败、TCP 拒绝、TLS 握手失败最后都只剩一句 `network`；
//   · 原生栈其实**给了** DNS/TCP/TLS 的原话（`UnknownHostException` /
//     `ConnectException` / `SSLHandshakeException`），而 `consume/http.ts` 的 `failureOf()`
//     把它们全折成 `'network'` —— 信息是在这一层被扔掉的，不是拿不到；
//   · 「复制诊断信息」（`chat/replyErrorReport.ts`）只写 status / code / 环节 / 渠道 / 模型 / 接口，
//     没有分段，也没有分段耗时。
//
// 本用例的判据（逐条对应 #895 的必做项）：
//   [1] 断网 / DNS 失败 / TLS 失败 / 首字节超时 四种场景 phase **互不相同**（验收原文）
//   [2] 用户取消 → phase=abort 且**不可重试**（不许退化既有第 4 条纪律）
//   [3] phase=http 时可重试性由状态码唯一决定（401/400 不重试，429/5xx 重试）
//   [4] 判不出就写「判不出」，**不许**硬塞一个 tcp 冒充知道
//   [5] web 侧有 `PerformanceResourceTiming` 证据时，按「已经走到哪一段」归因
//   [6] 与既有三段超时矩阵（`chat/timeoutPolicy.ts`）**逐条一致**（不许出现第二套口径）
//   [7] `isRetryableApiError` 读 phase；phase 缺失时**回落**到改前的判定（不许凭空扩权）
//   [8] 「复制诊断信息」输出 phase + 各段耗时，且不夹带 Key
//
//   node --test tests/unit/net-failure-phase-895.test.mjs
//   node tests/run-layer.mjs unit --only net-failure-phase-895
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve } from '../helpers/dom-env.mjs'

installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { classifyNetFailure, NET_FAILURE_PHASES } = await import(
  '../../src/services/net/networkPhase.ts'
)
const { ApiError } = await import('../../src/services/api/client.ts')
const { isRetryableApiError } = await import('../../src/services/api/errors.ts')
const { shouldRetryStreamTimeout } = await import('../../src/services/chat/timeoutPolicy.ts')
const { buildReplyErrorReport } = await import('../../src/services/chat/replyErrorReport.ts')

/**
 * 原生栈真实的异常文本（Android `HttpURLConnection` / OkHttp 经 Capacitor 抛上来的形态）。
 * 全部来自线上形态，不是编的：`UnknownHostException` = 域名解析不出来，
 * `ConnectException` = 端口不通，`SSLHandshakeException` = 证书 / 握手。
 */
const NATIVE_DNS =
  'java.net.UnknownHostException: Unable to resolve host "gw.example.com": No address associated with hostname'
const NATIVE_TCP = 'java.net.ConnectException: Failed to connect to gw.example.com/10.0.0.1:443'
const NATIVE_TLS =
  'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.'

/** 造一个带 net meta 的 ApiError（构造器第 7 个参数就是它） */
const apiErrorWithNet = (kind, net, status, code) =>
  new ApiError(kind, 'boom', status, code, undefined, undefined, net)

test('[1] 断网 / DNS / TLS / 首字节超时：四种场景的 phase 互不相同', () => {
  const offline = classifyNetFailure({ offline: true })
  const dns = classifyNetFailure({ nativeMessage: NATIVE_DNS })
  const tls = classifyNetFailure({ nativeMessage: NATIVE_TLS })
  const firstByte = classifyNetFailure({ code: 'first_token_timeout' })

  assert.equal(offline.phase, 'offline', '断网 = 系统层没网，与 dns 不是同一件事')
  assert.equal(dns.phase, 'dns')
  assert.equal(tls.phase, 'tls')
  assert.equal(firstByte.phase, 'first_byte')

  const phases = [offline.phase, dns.phase, tls.phase, firstByte.phase]
  assert.equal(new Set(phases).size, 4, `四种场景必须各自可分辨，实际：${phases.join(' / ')}`)
})

test('[2] 用户取消：phase=abort 且不可重试（既有第 4 条纪律不许退化）', () => {
  const meta = classifyNetFailure({ aborted: true, nativeMessage: NATIVE_TLS })
  assert.equal(meta.phase, 'abort', '取消优先于任何传输归因：它不是失败')
  assert.equal(meta.retryable, false, '用户点了停止就绝不再自动发一次')
  assert.equal(meta.userAction, 'none')
})

test('[3] phase=http：可重试性由状态码唯一决定', () => {
  const table = [
    [400, false],
    [401, false],
    [402, false],
    [403, false],
    [404, false],
    [413, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ]
  for (const [status, expected] of table) {
    const meta = classifyNetFailure({ status })
    assert.equal(meta.phase, 'http', `${status} 拿到了 HTTP 响应 → phase 应为 http`)
    assert.equal(meta.retryable, expected, `HTTP ${status} 的 retryable 应为 ${expected}`)
  }
})

test('[4] 判不出就写判不出：connect_timeout 在 web 侧没有 timing 证据时 phase 为 undefined', () => {
  const meta = classifyNetFailure({ code: 'connect_timeout' })
  assert.equal(
    meta.phase,
    undefined,
    'connect_timeout 可能是 DNS、TCP 也可能是 TLS；没有证据就只能是「不知道」'
  )
  assert.equal(meta.evidence, 'timeout-code')
  assert.equal(meta.retryable, true, '判不出归因不影响「重发是安全的」这一结论')
})

test('[5] web 侧有 resource timing 时按「已经走到哪一段」归因', () => {
  // 域名没解析出来
  assert.equal(classifyNetFailure({ timing: { domainLookupStart: 3, domainLookupEnd: 0 } }).phase, 'dns')
  // 解析出来了，连接没建起来（无 TLS 段 = 明文 http 或还没进 TLS）
  assert.equal(
    classifyNetFailure({
      timing: { domainLookupStart: 3, domainLookupEnd: 12, connectStart: 12, connectEnd: 0 },
    }).phase,
    'tcp'
  )
  // 握手开始了，没握完
  assert.equal(
    classifyNetFailure({
      timing: {
        domainLookupStart: 3,
        domainLookupEnd: 12,
        connectStart: 12,
        secureConnectionStart: 20,
        connectEnd: 0,
      },
    }).phase,
    'tls'
  )
  // 连上了、请求发了、响应头没来
  assert.equal(
    classifyNetFailure({
      timing: {
        domainLookupStart: 3,
        domainLookupEnd: 12,
        connectStart: 12,
        secureConnectionStart: 20,
        connectEnd: 40,
        requestStart: 41,
        responseStart: 0,
      },
    }).phase,
    'first_byte'
  )
})

test('[6] 与既有三段超时矩阵逐条一致（不许出现第二套重试口径）', () => {
  for (const code of ['connect_timeout', 'first_token_timeout', 'idle_timeout']) {
    const meta = classifyNetFailure({ code })
    const fromMatrix = shouldRetryStreamTimeout(code, false)
    assert.equal(
      meta.retryable,
      fromMatrix,
      `${code}：net 归因(${meta.retryable}) 必须与 timeoutPolicy(${fromMatrix}) 一致`
    )
  }
  assert.equal(classifyNetFailure({ code: 'idle_timeout' }).phase, 'idle')
})

test('[7] isRetryableApiError 读 phase；phase 缺失时回落改前判定', () => {
  // 传输档：phase 说的就是结论
  assert.equal(isRetryableApiError(apiErrorWithNet('network', classifyNetFailure({ offline: true }))), true)
  assert.equal(isRetryableApiError(apiErrorWithNet('network', classifyNetFailure({ nativeMessage: NATIVE_DNS }))), true)
  assert.equal(
    isRetryableApiError(apiErrorWithNet('network', classifyNetFailure({ aborted: true }))),
    false,
    'abort 档不许因为「它是网络类」就被重试'
  )
  // http 档：跟状态码走
  assert.equal(isRetryableApiError(apiErrorWithNet('http', classifyNetFailure({ status: 400 }), 400)), false)
  assert.equal(isRetryableApiError(apiErrorWithNet('http', classifyNetFailure({ status: 429 }), 429)), true)
  // phase 判不出（upstream_returned_html 没有状态码）→ 必须回落改前口径：不能重试
  const htmlNoStatus = new ApiError(
    'protocol',
    'upstream returned html',
    undefined,
    'upstream_returned_html'
  )
  assert.equal(isRetryableApiError(htmlNoStatus), false, '缺 phase 时回落到 classifyApiError 的既有结论')
})

test('[8] 「复制诊断信息」输出 phase + 各段耗时，且不夹带 Key', () => {
  const text = buildReplyErrorReport({
    status: undefined,
    kind: 'network',
    phase: 'tls',
    evidence: 'native-message',
    userAction: 'check-endpoint',
    timings: { dnsMs: 12, tcpMs: 30, tlsMs: 780, waitMs: null, firstByteMs: null, totalMs: 2500 },
    at: 0,
  })
  assert.match(text, /^失败分段: tls/m, `要写出 phase，实际：\n${text}`)
  assert.match(text, /依据 native-message/, '要写出凭什么判成这一段')
  assert.match(text, /建议 check-endpoint/, '要给下一步')
  assert.match(text, /^分段耗时: .*dns=12ms.*tcp=30ms.*tls=780ms/m, `要写出分段耗时：\n${text}`)
  assert.match(text, /首字节=—/, '取不到的段写「—」，不写假的 0')
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]/, '诊断文本绝不许夹带 Key')
})

test('[4b] 枚举取值与 #895 约定一致（前后端同名同值）', () => {
  assert.deepEqual(
    [...NET_FAILURE_PHASES],
    ['offline', 'dns', 'tcp', 'tls', 'http', 'first_byte', 'idle', 'abort']
  )
})
