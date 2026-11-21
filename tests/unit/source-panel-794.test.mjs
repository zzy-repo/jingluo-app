// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + fetch 替身，零浏览器、零真实网络） | 耗时: <1s]
//
// Issue #794：第三方服务**取消** OpenAI / Anthropic 协议二选一，改为按地址与模型自动适配。
//
// 三条验收（与 issue 一一对应）：
//   [1] `baseUrl=https://api.anthropic.com`：什么都不选也能走 anthropic（用户填的地址跟着走，不丢）；
//   [2] `baseUrl=https://api.openai.com/v1` + `gpt-4o`：走 openai（兜底探测那一档，请求形态见下）；
//   [3] 存过协议字段的老配置读取不报错，并作为「自动适配的初始提示」被沿用。
//
// 两个入口，分工就是「不阻塞首条消息」的落点：
//   · `syncThirdPartyProtocol()` —— **发送链路**用的（`client.streamMessage` 第一行）：纯本地同步
//     （主机 → 模型 → 判定缓存 → 既有协议字段），一个网络请求都不发、零等待；
//   · `detectThirdPartyProtocol()` —— 设置页进入「第三方服务」子页时后台调一次：本地判据都说不清时
//     才探 `GET {base}/v1/models`（≤3s），探明白才落缓存并应用，探不出来**什么都不改**。
//
// 另外几条是同一件事的必要部分，一起钉住：
//   [4] 发送链路零网络零等待；探测「只探一次」、失败不改配置、没结论不落缓存；
//   [5] 判定结果**落盘缓存**（按 baseUrl 存），下次本地直接命中、不再打网络；
//   [6] 协议分段与它的三条文案真的消失了，而 #727 的「三行 IA」一点没变。
//
// 真正生效的协议始终写回既有的 `chat-demo:provider-kind`（`ProviderKind` 的 openai / anthropic），
// **没有第二套渠道状态** —— 这是 issue 明写的硬要求。
//
//   node --test tests/unit/source-panel-794.test.mjs
//   node tests/run-layer.mjs unit --only source-panel-794
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'

installChatBridge()
installEndpointsGlobals()
const dom = setupDom()

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const detect = await import('../../src/services/api/protocolDetect.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const realFetch = globalThis.fetch

test.after(() => {
  globalThis.fetch = realFetch
  dom.restore()
})

const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** 一份「刚从别的来源切进来」的第三方配置：kind=openai + 一条地址 + 一个模型 + 一把占位 Key */
const thirdPartyConfig = (baseUrl, model = 'gpt-4o') => {
  apiConfig.setProviderKind('openai')
  assert.equal(apiConfig.setBaseUrl(baseUrl), true, `测试前置：${baseUrl} 必须是合法地址`)
  assert.equal(apiConfig.setModel(model), true, '测试前置：模型要存得进去')
  // 探测要用 Key（两种鉴权各试一次）；Key 本身是四个渠道共用一把，这里的值只是占位
  apiConfig.setApiKey('sk-test-0000')
}

/** 干净的本地配置（同一进程里多行表格之间不许串味；「只探一次」的会话状态也一起重置） */
const reset = () => {
  dom.localStorage.clear()
  detect.resetProtocolProbeState()
}

/**
 * fetch 替身：按「哪种鉴权头」回不同状态码。
 * `anthropic` 一档 = 带 `x-api-key` 的那次；`openai` 一档 = 带 `Authorization: Bearer` 的那次。
 */
const stubFetch = (status) => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {}
    const style = Object.hasOwn(headers, 'x-api-key') ? 'anthropic' : 'openai'
    calls.push({ url, style })
    const code = status[style] ?? 401
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: async () => '{}',
      headers: { get: () => 'application/json' },
    }
  }
  return calls
}

/** 一个「打过去就报错」的 fetch：用来证明某条路径**一次网络请求都没发** */
const failFetch = () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    throw new Error('这条路径不该发网络请求')
  }
  return calls
}

// ------------------------------------------------------------ [1] 地址主机判据

test('[1] baseUrl=https://api.anthropic.com：不选协议也走 anthropic，且用户填的地址没丢', () => {
  reset()
  thirdPartyConfig('https://api.anthropic.com')
  assert.equal(apiConfig.getProviderKind(), 'openai', '进来时还是上一轮那个协议（这就是要修的现状）')
  const calls = failFetch()

  const decision = detect.syncThirdPartyProtocol()

  assert.notEqual(decision, null, '第三方服务必须有判定结果')
  assert.equal(decision.protocol, 'anthropic', `主机含 anthropic 就必须判成 anthropic：${JSON.stringify(decision)}`)
  assert.equal(decision.source, 'host', '判据要落在「地址主机」这一档（不是撞对的）')
  assert.equal(decision.applied, true, 'kind 要跟着换，否则请求还是按 openai 发')
  assert.equal(apiConfig.getProviderKind(), 'anthropic', '生效协议 = 既有的 ProviderKind.anthropic')
  assert.equal(
    apiConfig.getBaseUrl(),
    'https://api.anthropic.com',
    '协议换了，用户填的地址必须跟着搬过去（按渠道分开存的坑，#794 第 2 条验收）'
  )
  assert.equal(calls.length, 0, '本地判据能定的，一个网络请求都不许发（发送链路零等待）')
  // 判定纯函数本身也钉一下：官方域与自建中转都算
  assert.equal(detect.protocolFromHost('https://api.anthropic.com'), 'anthropic')
  assert.equal(detect.protocolFromHost('https://anthropic-proxy.example.com/v1'), 'anthropic')
  assert.equal(detect.protocolFromHost('https://api.openai.com/v1'), null)
})

// --------------------------------------------------- [2] 模型 / 兜底探测判据

test('[2] baseUrl=https://api.openai.com/v1 + gpt-4o：走 openai（兜底探测定案）', async () => {
  reset()
  thirdPartyConfig('https://api.openai.com/v1', 'gpt-4o')
  const calls = stubFetch({ anthropic: 401, openai: 200 })

  const decision = await detect.detectThirdPartyProtocol()

  assert.notEqual(decision, null)
  assert.equal(decision.protocol, 'openai', `必须走 openai：${JSON.stringify(decision)}`)
  assert.equal(decision.source, 'probe', '地址与模型都判不出来时，结论来自兜底探测')
  assert.equal(decision.probed, true)
  assert.equal(apiConfig.getProviderKind(), 'openai', '协议没变时不用白写一次 kind')
  assert.equal(calls.length, 2, '两种鉴权各试一次（Bearer / x-api-key）')
  assert.equal(
    apiConfig.readCachedProtocol('https://api.openai.com/v1'),
    'openai',
    '探测结论要落盘（下次本地直接用）'
  )
  // 模型判据单测：claude 前缀（大小写不敏感）
  assert.equal(detect.protocolFromModel('claude-sonnet-4'), 'anthropic')
  assert.equal(detect.protocolFromModel('Claude-3-opus'), 'anthropic')
  assert.equal(detect.protocolFromModel('gpt-4o'), null)
})

test('[2] 模型是 claude 前缀时不用探测，直接 anthropic', () => {
  reset()
  apiConfig.setProviderKind('openai')
  assert.equal(apiConfig.setBaseUrl('https://relay.example.com'), true)
  assert.equal(apiConfig.setModel('claude-3-7-sonnet'), true)
  const calls = failFetch()

  const decision = detect.syncThirdPartyProtocol()

  assert.equal(decision.protocol, 'anthropic')
  assert.equal(decision.source, 'model', '模型名就是证据，不该多打一次上游')
  assert.equal(calls.length, 0, '纯判定能定的，一次网络请求都不许发')
  assert.equal(apiConfig.getBaseUrl(), 'https://relay.example.com', '地址跟着协议搬过去')
  assert.equal(apiConfig.getModel(), 'claude-3-7-sonnet', '模型当然也还在')
})

// ------------------------------------------------------- [3] 老配置兼容（不报错）

test('[3] 老配置存过协议字段：读取不报错，并作为「自动适配的初始提示」被沿用', async () => {
  reset()
  // 老版本：用户在协议分段里选了 Anthropic，填的是一条不带 anthropic 字样的中转
  apiConfig.setProviderKind('anthropic')
  assert.equal(apiConfig.setBaseUrl('https://gw.example.com'), true)
  assert.equal(apiConfig.setModel('deepseek-v3'), true)
  apiConfig.setApiKey('sk-test-0000')

  // ① 发送链路：本地判据全说不清 → 沿用既有协议字段（不需要任何网络、不需要迁移、不报错）
  const sendPath = detect.syncThirdPartyProtocol()
  assert.equal(sendPath.protocol, 'anthropic', '老配置的选择要被沿用（不是被推翻）')
  assert.equal(sendPath.source, 'legacy-hint', `沿用既有字段这一档：${JSON.stringify(sendPath)}`)
  assert.equal(sendPath.applied, false, '沿用 = 什么都不用改')
  assert.equal(apiConfig.getProviderKind(), 'anthropic', 'kind 原样不动')

  // ② 设置页的后台探测：这条中转对两种鉴权都给不出不同答案 → 仍然不改（沿用老配置）
  const calls = stubFetch({ anthropic: 401, openai: 401 })
  const probed = await detect.detectThirdPartyProtocol()
  assert.equal(probed.protocol, 'anthropic', '探不出结论时，既有协议字段就是答案')
  assert.equal(probed.applied, false, '没有证据就不许改写用户配置')
  assert.equal(apiConfig.getProviderKind(), 'anthropic')
  assert.equal(calls.length, 2, '两种鉴权各试一次（≤3s 的总预算在 `probeProtocol` 里）')
})

test('[3] 坏数据 / 老版本残留：读取一律不抛，回落到默认值', async () => {
  reset()
  // 手工改坏的键（隐私模式、老版本、用户手抖都会留下这种东西）
  dom.localStorage.setItem(apiConfig.CONFIG_KEYS.kind, 'not-a-kind')
  dom.localStorage.setItem(apiConfig.CONFIG_KEYS.protocolCache, '{oops')

  assert.equal(apiConfig.readCachedProtocol('https://x.example.com'), null, '坏缓存当没有')
  assert.notEqual(apiConfig.getProviderKind(), 'not-a-kind', '坏 kind 回落到构建默认值')
  // 不是第三方渠道时，判定直接返回 null（一个请求都不发、也不抛）
  assert.equal(detect.syncThirdPartyProtocol(), null, '非第三方渠道不做任何适配')
  assert.equal(await detect.detectThirdPartyProtocol(), null, '后台探测同样不碰非第三方渠道')
})

// -------------------------------------------- [4] 发送链路零网络 / 只探一次

test('[4] 发送链路（syncThirdPartyProtocol）零网络、零等待', () => {
  reset()
  thirdPartyConfig('https://no-clue.example.com', 'gpt-4o')
  const calls = failFetch()

  const startedAt = Date.now()
  const first = detect.syncThirdPartyProtocol()
  const elapsed = Date.now() - startedAt

  assert.equal(first.protocol, 'openai', '什么线索都没有时按 OpenAI 兼容发（issue 的兜底口径）')
  assert.notEqual(first.source, 'probe', '发送链路上不做探测')
  assert.equal(calls.length, 0, '发送链路一个网络请求都不发')
  assert.ok(elapsed < 50, `同步判定应当是瞬时的，实测 ${elapsed}ms`)
  assert.equal(apiConfig.getProviderKind(), 'openai', '既然是兜底值，就不许拿它改写配置')
})

test('[4] 探测失败：什么都不改、不落缓存、同一条地址只探一次', async () => {
  reset()
  thirdPartyConfig('https://no-clue.example.com', 'gpt-4o')
  const calls = stubFetch({ anthropic: 401, openai: 401 })

  const first = await detect.detectThirdPartyProtocol()
  assert.equal(first.protocol, 'openai', '探不出来就仍在既有协议上')
  assert.equal(first.applied, false)
  assert.equal(calls.length, 2, '一次探测 = 两种鉴权各一次')

  const second = await detect.detectThirdPartyProtocol()
  assert.equal(second.protocol, 'openai')
  assert.equal(calls.length, 2, '「只探一次」：同一条地址不许反复打上游')
  assert.equal(
    apiConfig.readCachedProtocol('https://no-clue.example.com'),
    null,
    '没有结论就不落盘（留着下次再探的机会）'
  )
})

test('[4] 宽松网关（两种鉴权都通）＝ 没有结论：不改协议、不落缓存', async () => {
  reset()
  thirdPartyConfig('https://lenient.example.com', 'gpt-4o')
  const calls = stubFetch({ anthropic: 200, openai: 200 })

  const decision = await detect.detectThirdPartyProtocol()

  assert.equal(calls.length, 2)
  assert.equal(decision.applied, false, '两种头都通说明这个网关不按鉴权分协议，猜不得')
  assert.equal(apiConfig.getProviderKind(), 'openai', '保持既有协议')
  assert.equal(apiConfig.readCachedProtocol('https://lenient.example.com'), null, '没有结论不写缓存')
})

// -------------------------------------------------------- [5] 判定结果落盘缓存

test('[5] 探明白之后缓存下来：之后每次发送本地命中，不再打网络', async () => {
  reset()
  thirdPartyConfig('https://gw.example.com', 'gpt-4o')
  const calls = stubFetch({ anthropic: 200, openai: 401 })

  // 设置页那次后台探测：只有 x-api-key 通 → anthropic
  const detected = await detect.detectThirdPartyProtocol()
  assert.equal(detected.source, 'probe')
  assert.equal(detected.protocol, 'anthropic')
  assert.equal(detected.applied, true, '探明白了就要落回 ProviderKind')
  assert.equal(apiConfig.getProviderKind(), 'anthropic')
  assert.equal(apiConfig.getBaseUrl(), 'https://gw.example.com', '地址跟着协议搬过去')
  assert.equal(calls.length, 2, '两种鉴权各一次')

  // 之后发送：纯本地命中缓存，一个请求都不发
  const after = failFetch()
  const sendPath = detect.syncThirdPartyProtocol()
  assert.equal(sendPath.protocol, 'anthropic')
  assert.equal(sendPath.source, 'cache', `第二次应当直接命中缓存：${JSON.stringify(sendPath)}`)
  assert.equal(after.length, 0, '命缓存就一个请求都不发')
})

// ------------------------------------------- [6] 协议控件与文案真的消失 / 三行 IA 不变

test('[6] 协议分段与其文案消失，而 #727 的三行 IA 一点没变', () => {
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.equal(/settings-protocol-/u.test(page), false, '协议分段的 testid 不许再出现')
  assert.equal(/THIRD_PARTY_PROTOCOLS/u.test(page), false, '协议列表常量要一起删掉')
  assert.equal(/settingsThirdPartyProtocol/u.test(page), false, '分段控件的 aria-label 也要删')
  assert.match(
    page,
    /detectThirdPartyProtocol\(\)/u,
    '进入第三方子页要在后台判一次协议（探测的唯一调用点）'
  )
  for (const key of [
    'settingsThirdPartyProtocol',
    'settingsProtocolOpenai',
    'settingsProtocolAnthropic',
  ]) {
    assert.equal(Object.hasOwn(zh, key), false, `zh 还留着已废弃的词条 ${key}`)
    assert.equal(Object.hasOwn(en, key), false, `en 还留着已废弃的词条 ${key}`)
  }
  /**
   * #727 的三行 IA：第三方服务仍然是一行，只是进去后少了一个控件。
   *
   * #807 起这三行从「一屏列表」变成**单层手风琴**，行清单与行头一起搬到了共享模块
   * （`sourceAccordion.SOURCE_ROWS` / `sourceAccordionView.ts` 的行头 testid）——
   * 断言的口径不变（**三行一条没少、每行仍是一个可点的行**），只是落点跟着代码走。
   * 手风琴本身的八条验收见 `tests/unit/source-accordion-807.test.mjs`。
   */
  const accordionRows = codeOf('src/components/settings/sourceAccordion.ts')
  assert.match(
    accordionRows,
    /export const SOURCE_ROWS: readonly SourceRowKey\[\] = \['builtin', 'third', 'official'\]/u,
    '三行来源（内置 / 第三方 / 官方）不许被改动'
  )
  const accordionView = codeOf('src/components/settings/sourceAccordionView.ts')
  assert.match(accordionView, /settings-source-\$\{row\}/u, '三行仍然是可点的行（每行一个 testid）')
})
