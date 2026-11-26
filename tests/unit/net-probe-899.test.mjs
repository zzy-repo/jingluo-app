// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发真实网络请求；探测传输是注入的桩） | 耗时: <3s]
//
// Issue #899（母单 #894）：**web 侧 dns / tcp / tls 判不出来**的缺口。
//
// 改前的事实（#895 取证时实测，见 docs/ui/README.md「网络失败分阶段归因」）：
//   · 浏览器 `fetch` 失败只给一句 `TypeError: Failed to fetch`；
//   · Chromium 把 `net::ERR_NAME_NOT_RESOLVED` / 证书错误**只打印到 console**，不给页面 JS；
//   · 失败请求的 `PerformanceResourceTiming` 分段**全是 0**（#899 复测：真 DNS 失败、真
//     connection refused、真自签证书握手失败三种，Chromium 与 Firefox 实测均为 0，
//     见 docs/ui/net-probe-* 的取证说明）—— 所以「走到了哪一段」在 web 上确实拿不到；
//   · 于是诊断只能写「失败分段: 判不出（依据 none）」，读的人分不清这是「没试过」还是
//     「试过了、平台给不出」。
//
// 本单补的是**一次只判路的后台探测**：失败且 `phase === undefined` 时，用一次极小的
// 请求重走同一段路（单次 ≤2s、失败后最多一次、不阻塞用户动作），把探测结论补进诊断。
//
// 本用例的判据（逐条对应 #899 的必做项）：
//   [1] 探测显示 TLS 握手失败 → `phase='tls'`（依据 `probe`）
//   [2] 探测显示 DNS 解不开 → `phase='dns'`（依据 `probe`）
//   [3] 探测也超时 → **保持判不出**，不许瞎猜成 `tcp`
//   [4] 探测「已通」→ 不细分（瞬时抖动，不是某一段坏了）
//   [5] 归因优先级：探测**只能**细分 dns/tcp/tls，既有 offline/abort/http/first_byte/idle/
//       native-message/resource-timing 一律压过它
//   [6] 探测与原始证据冲突 → 以原始证据为准，并在 meta 上记「两者不一致」
//   [7] 「复制诊断信息」能区分「判不出（平台限制）」与「探测后判定为 tls/dns」，两者文案不同
//   [8] 探测的代价：单次、默认上限 ≤2s、失败后不再重试、不阻塞调用方（`startNetProbe` 立即返回）
//   [9] 端到端：真实 `request()` 失败 + 注入探测桩 → `ApiError.net.phase` 由后台补成 `tls`
//
//   node --test tests/unit/net-probe-899.test.mjs
//   node tests/run-layer.mjs unit --only net-probe-899
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

const { classifyNetFailure } = await import('../../src/services/net/networkPhase.ts')
const { NET_PROBE_TIMEOUT_MS, runNetProbe, setNetProbeTransport, probeUrlOf, startNetProbe } =
  await import('../../src/services/net/phaseProbe.ts')
const { buildReplyErrorReport } = await import('../../src/services/chat/replyErrorReport.ts')
const { ApiError, request } = await import('../../src/services/api/client.ts')

const ENDPOINT = 'https://gw.example.test/v1/messages'

/** 探测桩：**永远不发真网络请求**（本层是纯 Node，零网络） */
const probe = {
  reached: () => ({ outcome: 'reached', elapsedMs: 3 }),
  timeout: () => ({ outcome: 'timeout', elapsedMs: NET_PROBE_TIMEOUT_MS }),
  unsupported: () => ({ outcome: 'unsupported' }),
  /** 失败但平台没给分段：web 的真实形态（实测分段全 0 → 取不到即 undefined） */
  failedNoEvidence: () => ({ outcome: 'failed', elapsedMs: 4, message: 'TypeError: Failed to fetch' }),
  dns: () => ({
    outcome: 'failed',
    elapsedMs: 18,
    // 平台给了分段才算数：解析开始了、没结束
    timing: { domainLookupStart: 2, domainLookupEnd: 0 },
  }),
  tls: () => ({
    outcome: 'failed',
    elapsedMs: 26,
    // 解析完了、建连完成（connectEnd 停在 secureConnectionStart）、握手没过
    timing: { domainLookupStart: 2, domainLookupEnd: 9, connectStart: 9, connectEnd: 21, secureConnectionStart: 21 },
  }),
  tcp: () => ({
    outcome: 'failed',
    elapsedMs: 11,
    timing: { domainLookupStart: 2, domainLookupEnd: 9, connectStart: 9, connectEnd: 0 },
  }),
}

/** 原生栈原文（APK / CapacitorHttp 的形态，与 #895 用例同一批） */
const NATIVE_DNS =
  'java.net.UnknownHostException: Unable to resolve host "gw.example.com": No address associated with hostname'
const NATIVE_TLS =
  'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.'

/**
 * 让出一次宏任务：探测结论是**异步**落定的，用例等的是「那个 promise 收尾」这件事，
 * 不是「等 N 毫秒」—— 所以这里不给延迟数字（`flaky-registry` 的时序窗口规则也守这条）。
 */
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve))

test('[1] 探测显示 TLS 握手失败 → phase=tls（依据 probe）', () => {
  const meta = classifyNetFailure({
    nativeMessage: 'TypeError: Failed to fetch',
    probe: probe.tls(),
  })
  assert.equal(meta.phase, 'tls', '探测给出的分段证据必须能把「判不出」细分成 tls')
  assert.equal(meta.evidence, 'probe', '依据必须写 probe：读的人要知道这是探测结论，不是原始异常原文')
  assert.equal(meta.userAction, 'check-endpoint')
  assert.equal(meta.retryable, true)
  assert.deepEqual(meta.probe, { outcome: 'failed', elapsedMs: 26 })
})

test('[2] 探测显示 DNS 解不开 → phase=dns（依据 probe）', () => {
  const meta = classifyNetFailure({
    nativeMessage: 'TypeError: Failed to fetch',
    probe: probe.dns(),
  })
  assert.equal(meta.phase, 'dns')
  assert.equal(meta.evidence, 'probe')
  assert.equal(meta.userAction, 'check-network')
})

test('[3] 探测也超时 → 保持判不出，不许瞎猜成 tcp', () => {
  for (const input of [
    // 普通 fetch 失败（不是超时）
    { nativeMessage: 'TypeError: Failed to fetch', probe: probe.timeout() },
    // 连接段超时，本来就没有 timing 证据
    { code: 'connect_timeout', probe: probe.timeout() },
  ]) {
    const meta = classifyNetFailure(input)
    assert.equal(
      meta.phase,
      undefined,
      '探测自己都超时了 = 没有任何「走到哪」的证据；写 tcp 就是编（#899 必做 4）'
    )
    assert.equal(meta.probe.outcome, 'timeout', '探测试过了这件事必须留下痕迹，不能和「没试过」一样')
  }
  // 平台失败但没给分段（web 真实形态）同样是判不出，不是猜某一段
  const noEvidence = classifyNetFailure({ nativeMessage: 'TypeError: Failed to fetch', probe: probe.failedNoEvidence() })
  assert.equal(noEvidence.phase, undefined)
  assert.equal(noEvidence.probe.outcome, 'failed')
})

test('[4] 探测已通 → 不细分（这次是瞬时抖动），也不改变既有结论', () => {
  const meta = classifyNetFailure({ nativeMessage: 'TypeError: Failed to fetch', probe: probe.reached() })
  assert.equal(meta.phase, undefined, '探测通了说明刚才那一下是抖动，不是「卡在某一段」')
  assert.equal(meta.probe.outcome, 'reached')
  assert.equal(meta.retryable, true, '瞬时抖动本来就该允许再发一次')
})

test('[5] 归因优先级：既有结论一律压过探测（探测只能细分 dns/tcp/tls）', () => {
  const cases = [
    ['abort', classifyNetFailure({ aborted: true, probe: probe.tls() }), 'abort'],
    ['offline', classifyNetFailure({ offline: true, probe: probe.tls() }), 'offline'],
    ['http', classifyNetFailure({ status: 429, probe: probe.dns() }), 'http'],
    ['first_byte', classifyNetFailure({ code: 'first_token_timeout', probe: probe.tls() }), 'first_byte'],
    ['idle', classifyNetFailure({ code: 'idle_timeout', probe: probe.dns() }), 'idle'],
    ['native-message', classifyNetFailure({ nativeMessage: NATIVE_DNS, probe: probe.tls() }), 'dns'],
    [
      'resource-timing',
      classifyNetFailure({ timing: { domainLookupStart: 1, domainLookupEnd: 5, connectStart: 5, secureConnectionStart: 9, connectEnd: 9 }, probe: probe.dns() }),
      'tls',
    ],
  ]
  for (const [label, meta, expected] of cases) {
    assert.equal(meta.phase, expected, `${label} 的既有判定不许被探测推翻`)
    assert.notEqual(meta.evidence, 'probe', `${label} 的依据必须是它自己的，不能写成 probe`)
  }
  // 原生原文说 tls、探测说 tls：一致，不算冲突
  assert.equal(classifyNetFailure({ nativeMessage: NATIVE_TLS, probe: probe.tls() }).probe.conflict, undefined)
})

test('[6] 探测与原始证据冲突 → 以原始证据为准，并在 meta 上写「两者不一致」', () => {
  // 原始 timing 说「连都没连上」（tcp），探测说「连上了、TLS 没过」→ 冲突
  const meta = classifyNetFailure({
    timing: { domainLookupStart: 2, domainLookupEnd: 9, connectStart: 9, connectEnd: 0 },
    probe: probe.tls(),
  })
  assert.equal(meta.phase, 'tcp', '冲突时以原始证据为准（探测只是旁证）')
  assert.equal(meta.evidence, 'resource-timing')
  assert.equal(meta.probe.conflict, true, '不一致这件事必须写下来，不许静默丢掉')

  // 原始证据说卡在 tls，探测却通了 → 也是不一致
  const reached = classifyNetFailure({
    timing: { domainLookupStart: 2, domainLookupEnd: 9, connectStart: 9, secureConnectionStart: 12, connectEnd: 12 },
    probe: probe.reached(),
  })
  assert.equal(reached.phase, 'tls')
  assert.equal(reached.probe.conflict, true)
})

test('[7] 「复制诊断信息」能区分「判不出（平台限制）」与「探测后判定为 tls/dns」', () => {
  /** 与 `chat/describe.ts` 同一条口径：把 net meta 的四项喂进「复制诊断信息」 */
  const report = (failureInput) => {
    const meta = classifyNetFailure(failureInput)
    return buildReplyErrorReport({
      kind: 'network',
      status: undefined,
      phase: meta.phase,
      evidence: meta.evidence,
      userAction: meta.userAction,
      probe: meta.probe,
    })
  }
  const unknown = report({ nativeMessage: 'TypeError: Failed to fetch', probe: probe.failedNoEvidence() })
  const tls = report({ nativeMessage: 'TypeError: Failed to fetch', probe: probe.tls() })
  const dns = report({ nativeMessage: 'TypeError: Failed to fetch', probe: probe.dns() })
  const timedOut = report({ code: 'connect_timeout', probe: probe.timeout() })

  assert.match(unknown, /失败分段: 判不出/u)
  assert.match(unknown, /平台限制/u, '判不出必须写明「这是平台限制」，不是「没试过」')
  assert.match(tls, /失败分段: tls（依据 probe/u)
  assert.match(tls, /探测: .*TLS/u, '判出 tls 时要写出探测到底看到了什么')
  assert.match(dns, /失败分段: dns（依据 probe/u)
  assert.match(dns, /探测: .*名字|探测: .*域名/u)
  assert.match(timedOut, /失败分段: 判不出/u)
  assert.match(timedOut, /探测: 也超时/u)

  // 四段文本必须互不相同（不许把「判不出」和「判出 tls」混成一句）
  const lines = [unknown, tls, dns, timedOut].map((text) =>
    text.split('\n').find((line) => line.startsWith('失败分段') || line.startsWith('探测'))
  )
  assert.equal(new Set([unknown, tls, dns, timedOut]).size, 4, `四份诊断必须互不相同：${lines.join(' / ')}`)
  assert.notEqual(
    unknown.split('\n').find((line) => line.startsWith('失败分段')),
    timedOut.split('\n').find((line) => line.startsWith('失败分段'))
  )
})

test('[8] 探测的代价：单次、默认上限 ≤2s、失败后不再重试、不阻塞调用方', async () => {
  assert.ok(
    NET_PROBE_TIMEOUT_MS <= 2000,
    `探测上限必须 ≤2000ms（#899 必做 1），实际 ${NET_PROBE_TIMEOUT_MS}`
  )

  // 一次失败只发一次：桩自己数调用次数
  let calls = 0
  const seen = []
  setNetProbeTransport(async (url) => {
    calls += 1
    seen.push(url)
    return { kind: 'failed', message: 'TypeError: Failed to fetch' }
  })
  try {
    const first = await runNetProbe(ENDPOINT)
    assert.equal(calls, 1, '一次失败只许探测一次')
    assert.equal(first.outcome, 'failed')
    assert.equal(seen[0], probeUrlOf(ENDPOINT), '探测只打「同源最小路径」，不重发业务请求')
    assert.equal(probeUrlOf(ENDPOINT), 'https://gw.example.test/', '探测目标是 origin + /')

    // 桩不认 signal 也照样按时收口：runNetProbe 自己带盖子（≤2s，用例用 40ms 的短盖子）
    setNetProbeTransport(() => new Promise(() => {}))
    const started = Date.now()
    const hung = await runNetProbe(ENDPOINT, { timeoutMs: 40 })
    const elapsed = Date.now() - started
    assert.equal(hung.outcome, 'timeout', '探测超时必须落成「没有结论」，不许挂住调用方')
    assert.ok(elapsed < 1000, `探测必须按时收口，实际 ${elapsed}ms`)
  } finally {
    setNetProbeTransport(null)
  }

  // 地址解析不出来（相对路径 / 空串）→ unsupported，不抛
  assert.equal((await runNetProbe('/v1/messages')).outcome, 'unsupported')

  // 后台入口**不许返回 promise**：返回值就是 `undefined`，调用方拿不到可 await 的东西
  // —— 这是「不阻塞用户主要动作」的结构性保证（想等结果的人只能用 `runNetProbe`）。
  setNetProbeTransport(async () => ({ kind: 'reached' }))
  try {
    let settled = null
    const returned = startNetProbe(ENDPOINT, (result) => {
      settled = result
    })
    assert.equal(returned, undefined, 'startNetProbe 必须立即返回 undefined（不是 promise）')
    assert.equal(settled, null, '返回那一刻探测必定还没结论 —— 它不参与主流程')
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && settled === null) {
      await nextMacrotask()
    }
    assert.equal(settled?.outcome, 'reached', '结论晚到，通过回调补进诊断')
  } finally {
    setNetProbeTransport(null)
  }
})

test('[9] 端到端：request() 失败后由后台探测把 phase 补成 tls（不阻塞抛出）', async () => {
  const realFetch = globalThis.fetch
  // 真实形态：fetch 只给一句 Failed to fetch（#899 的原缺口）
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))
  // 探测桩：模拟「平台给了分段」的宿主（web 上实测拿不到，见文件头）
  setNetProbeTransport(async () => ({
    kind: 'failed',
    timing: { domainLookupStart: 2, domainLookupEnd: 9, connectStart: 9, connectEnd: 21, secureConnectionStart: 21 },
    message: 'TypeError: Failed to fetch',
  }))
  try {
    let caught
    try {
      await request(ENDPOINT, { method: 'POST' }, { timeoutMs: 500 })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof ApiError, '失败必须是 ApiError')
    assert.equal(caught.kind, 'network')
    // 抛出时**不等**探测：这是「不阻塞用户主要动作」的那一条
    // 探测结论随后补进**同一个** net 对象（诊断读的就是它）
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && caught.net?.phase === undefined) {
      await nextMacrotask()
    }
    assert.equal(caught.net?.phase, 'tls', '后台探测结论必须补进 ApiError.net')
    assert.equal(caught.net?.evidence, 'probe')
    assert.equal(caught.net?.probe?.outcome, 'failed')
  } finally {
    globalThis.fetch = realFetch
    setNetProbeTransport(null)
  }
})
