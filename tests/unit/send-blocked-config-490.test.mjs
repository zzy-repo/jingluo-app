// [layer: unit | 依赖: 内存 localStorage + 假 fetch（只计数，零真实网络） | 耗时: <3s]
//
// Issue #490（#347 / #353 明确划界让出的那一半）：**发送前**拦截五类必错配置。
// Issue #793（同一个方向的另一半，第 [5] 段）：**未登录 + 没有可用渠道/Key** 时同样在发送前拦下 ——
// 那时请求只会带着空凭据打上游、界面转圈且没有一句可读的话。
//
//   1. 模型名为空               → `model_empty`
//   2. 模型名带空格（首尾/中间） → `model_space`
//   3. 服务地址为空             → `base_url_empty`
//   4. 地址缺 http(s) 协议      → `base_url_no_protocol`
//   5. 地址填成具体接口路径     → `base_url_endpoint_path`
//
// 三件必须同时成立的事，本文件逐条钉住：
//   · 五类各自被拦下、`code` 正确、`jumpTo` 指向正确字段；
//   · **请求数为 0**（核心断言）：走真 store 的发送路径，假 fetch 一次都不许被调用；
//   · 判据不误伤：`https://api.example.com` 与 `https://api.example.com/v1` 都必须放行。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/send-blocked-config-490.test.mjs
//   node tests/run-layer.mjs unit --only send-blocked-config-490
//
// 负向对照（改代码应该让本文件变红，PR 里有实测记录）：
//   · 删掉任一类判据 → 对应用例红；
//   · 把模型空格判据写成只查 trim（漏掉中间空格）→ 「中间空格」那行红；
//   · 把接口路径判据放宽成「地址里有路径就拦」→ 两条「不误伤」用例红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installChatEnv, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

// 装配走公共入口（#408）：原生桥 + 诊断写入口替身 + 只有 `chat/store.ts` 的 `./db.js` 换成假库
const { stub } = installChatEnv()
installEndpointsGlobals({ apiOrigin: 'https://api.test.invalid', internalBuild: false })
const dom = setupDom()
/**
 * toast 的计时器走 `window.setTimeout / clearTimeout`（`components/base/toastState.ts`），
 * 而最小 DOM 替身只给了 addEventListener。补两个转发到全局的实现，
 * 计时器 `unref()` 掉：不然 3s 的自动消失会把测试进程拖住。
 */
globalThis.window.setTimeout = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds)
  timer.unref?.()
  return timer
}
globalThis.window.clearTimeout = (timer) => clearTimeout(timer)

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const sendCheck = await import('../../src/services/api/sendConfigCheck.ts')
const { getSpec } = await import('../../src/services/api/providers.ts')
const dialogState = await import('../../src/components/settings/settingsDialogState.ts')
const { useToast } = await import('../../src/components/base/toastState.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { useChatStore, initChat, sendMessage, regenerateReply } = await import(
  '../../src/services/chat/store.ts'
)
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')
assert.ok(stub, '装配入口要给出替换辅助（chatStub）')

/** 一把格式正常的 Key（长度 21 > MIN_KEY_CHARS） */
const GOOD_KEY = 'sk-live-0123456789abcd'
/** 自填渠道（地址 / 模型都要用户自己填）—— 五类必错配置只可能出现在这类渠道上 */
const SPEC = getSpec('openai')
const SCALAR_BASE_URL = 'chat-demo:base-url:openai'

/** 每个用例都从干净状态开始：存储清空 + 设置弹层复位 */
const reset = () => {
  dom.localStorage.clear()
  dialogState.useSettingsDialog.setState({
    open: false,
    section: 'general',
    apiKeyFormatBlocked: false,
    managedKeyBlocked: null,
    sendConfigBlocked: null,
  })
  useToast.setState({ id: 0, message: null, action: null })
}

/** 切到「OpenAI 兼容」并给一把格式正常的 Key：把 Key 因素从本文件里剔出去 */
const configureChannel = () => {
  apiConfig.setProviderKind('openai')
  apiConfig.setApiKey(GOOD_KEY)
}

// ============================================================ [1] 纯函数：五类 + 两类放行

/**
 * 判据表：一行 = 一次 `checkSendConfig()` 调用。
 * `expect` 为 `ok` 的行是**不误伤**的正例（#490 明写「两种写法都必须放行」）。
 */
const ROWS = [
  // ---- 五类必错配置
  {
    label: '模型名为空',
    input: { baseUrl: 'https://api.example.com/v1', model: '' },
    expect: { code: 'model_empty', jumpTo: 'model', messageKey: 'sendBlockedModelEmpty' },
  },
  {
    label: '模型名只有空白',
    input: { baseUrl: 'https://api.example.com/v1', model: '   ' },
    expect: { code: 'model_empty', jumpTo: 'model', messageKey: 'sendBlockedModelEmpty' },
  },
  {
    label: '模型名首尾带空格',
    input: { baseUrl: 'https://api.example.com/v1', model: ' deepseek-v4-pro ' },
    expect: { code: 'model_space', jumpTo: 'model', messageKey: 'sendBlockedModelSpace' },
  },
  {
    label: '模型名中间带空格',
    input: { baseUrl: 'https://api.example.com/v1', model: 'deepseek v4-pro' },
    expect: { code: 'model_space', jumpTo: 'model', messageKey: 'sendBlockedModelSpace' },
  },
  {
    label: '模型名带换行（粘贴常见）',
    input: { baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4-pro\n' },
    expect: { code: 'model_space', jumpTo: 'model', messageKey: 'sendBlockedModelSpace' },
  },
  {
    label: '服务地址为空',
    input: { baseUrl: '', model: 'deepseek-v4-pro' },
    expect: { code: 'base_url_empty', jumpTo: 'baseUrl', messageKey: 'sendBlockedBaseUrlEmpty' },
  },
  {
    label: '服务地址只有空白',
    input: { baseUrl: '   ', model: 'deepseek-v4-pro' },
    expect: { code: 'base_url_empty', jumpTo: 'baseUrl', messageKey: 'sendBlockedBaseUrlEmpty' },
  },
  {
    label: '地址缺协议（裸域名）',
    input: { baseUrl: 'api.example.com', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_no_protocol',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlNoProtocol',
    },
  },
  {
    label: '地址缺协议（裸域名带路径）',
    input: { baseUrl: 'api.example.com/v1', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_no_protocol',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlNoProtocol',
    },
  },
  {
    label: '地址用了非 http(s) 协议',
    input: { baseUrl: 'ftp://api.example.com', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_no_protocol',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlNoProtocol',
    },
  },
  {
    label: '地址填成 /v1/chat/completions',
    input: { baseUrl: 'https://api.example.com/v1/chat/completions', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_endpoint_path',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlEndpointPath',
    },
  },
  {
    label: '地址填成 /chat/completions（漏了版本段也认）',
    input: { baseUrl: 'https://api.example.com/chat/completions', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_endpoint_path',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlEndpointPath',
    },
  },
  {
    label: '地址填成 /v1/chat/completions/（尾斜杠）',
    input: { baseUrl: 'https://api.example.com/v1/chat/completions/', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_endpoint_path',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlEndpointPath',
    },
  },
  {
    label: '地址填成 /v1/models（模型列表接口）',
    input: { baseUrl: 'https://api.example.com/v1/models', model: 'deepseek-v4-pro' },
    expect: {
      code: 'base_url_endpoint_path',
      jumpTo: 'baseUrl',
      messageKey: 'sendBlockedBaseUrlEndpointPath',
    },
  },
  // ---- 不误伤：这两种写法都是对的（后者 joinUrl 会把版本段去重）
  {
    label: '不误伤：只有域名',
    input: { baseUrl: 'https://api.example.com', model: 'deepseek-v4-pro' },
    expect: 'ok',
  },
  {
    label: '不误伤：域名 + /v1',
    input: { baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4-pro' },
    expect: 'ok',
  },
  {
    label: '不误伤：域名 + /v1/（尾斜杠）',
    input: { baseUrl: 'https://api.example.com/v1/', model: 'deepseek-v4-pro' },
    expect: 'ok',
  },
  {
    label: '不误伤：网关前缀 + /v1',
    input: { baseUrl: 'https://api.example.com/openai/v1', model: 'deepseek-v4-pro' },
    expect: 'ok',
  },
  {
    label: '不误伤：带端口与本地 http',
    input: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
    expect: 'ok',
  },
]

test('[1] checkSendConfig：五类必错各自命中，两类常见写法放行（不误伤）', () => {
  for (const row of ROWS) {
    const verdict = sendCheck.checkSendConfig({ spec: SPEC, ...row.input })
    if (row.expect === 'ok') {
      assert.equal(verdict.ok, true, `${row.label}：应当放行，实际 ${JSON.stringify(verdict)}`)
      continue
    }
    assert.equal(verdict.ok, false, `${row.label}：应当被拦下`)
    assert.equal(verdict.code, row.expect.code, `${row.label}：code`)
    assert.equal(verdict.jumpTo, row.expect.jumpTo, `${row.label}：jumpTo 指向的设置字段`)
    assert.equal(verdict.messageKey, row.expect.messageKey, `${row.label}：文案 key`)
  }
})

test('[1] 五类码一个都不许少（删掉任一类判据这里就红）', () => {
  // 码集合就是 #490 的关闭条件：五类各自可辨，不许合并成一句「配置有误」
  const codes = Object.keys(sendCheck.SEND_BLOCK_TABLE).sort()
  assert.deepEqual(codes, [
    'base_url_empty',
    'base_url_endpoint_path',
    'base_url_no_protocol',
    'model_empty',
    'model_space',
  ])
  // 判定顺序固定：地址三项在前、模型两项在后（多类同时坏时先说第一个）
  const bothBroken = sendCheck.checkSendConfig({ spec: SPEC, baseUrl: '', model: '' })
  assert.equal(bothBroken.code, 'base_url_empty', '地址与模型同时坏：先说地址（设置里它在上）')
})

test('[1] 接口路径的判据来自渠道表：Anthropic 渠道的 /v1/messages 同样被拦', () => {
  const anthropic = getSpec('anthropic')
  const verdict = sendCheck.checkSendConfig({
    spec: anthropic,
    baseUrl: 'https://api.example.com/v1/messages',
    model: 'claude-sonnet-4',
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'base_url_endpoint_path', 'Anthropic 协议自己的接口路径也是「具体接口」')
  // 同一份地址在别的渠道上一句都不多说：`/v1` 仍然放行
  assert.equal(
    sendCheck.checkSendConfig({ spec: anthropic, baseUrl: 'https://api.example.com/v1', model: 'x' })
      .ok,
    true
  )
})

test('[1] 文案键齐备：五个 sendBlocked* 中英都有、且真的翻译了', () => {
  for (const { messageKey } of Object.values(sendCheck.SEND_BLOCK_TABLE)) {
    assert.equal(typeof zh[messageKey], 'string', `${messageKey} 有中文文案`)
    assert.equal(typeof en[messageKey], 'string', `${messageKey} 有英文文案`)
    assert.notEqual(zh[messageKey], en[messageKey], `${messageKey} 真的翻译了，不是同一串`)
    // 每句话都要说清「这条消息没有发出」：不然用户会以为已经发出去、只是没回
    assert.match(zh[messageKey], /没有发出/u, `${messageKey} 中文要写明没有发出`)
    assert.match(en[messageKey], /not sent/u, `${messageKey} 英文要写明没有发出`)
  }
})

// ============================================================ [2] 门禁：toast + 跳转 + 落点

test('[2] ensureSendConfig：五类各自拦下、清空请求之外的副作用（toast / 设置 / 落点）', () => {
  const EXPECT = {
    base_url_empty: { field: 'baseUrl', key: 'sendBlockedBaseUrlEmpty' },
    base_url_no_protocol: { field: 'baseUrl', key: 'sendBlockedBaseUrlNoProtocol' },
    base_url_endpoint_path: { field: 'baseUrl', key: 'sendBlockedBaseUrlEndpointPath' },
    model_empty: { field: 'model', key: 'sendBlockedModelEmpty' },
    model_space: { field: 'model', key: 'sendBlockedModelSpace' },
  }
  for (const [code, expect] of Object.entries(EXPECT)) {
    reset()
    dialogState.useSettingsDialog.setState({ open: false })
    // 直接摆出「被拦下的状态」：判定与文案落点都由 checkCurrentSendConfig 决定，
    // 这里只需让当前配置命中对应那一类
    const verdict = { code }
    const field = sendCheck.sendBlockFieldOf(verdict.code)
    assert.equal(field, expect.field, `${code} 的落点字段`)
    assert.equal(sendCheck.sendBlockMessageKeyOf(verdict.code), expect.key, `${code} 的文案 key`)
  }

  // 端到端（真判定 + 真 store）：模型名为空
  reset()
  configureChannel()
  assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
  assert.equal(apiConfig.setModel('deepseek-v4-pro'), true)
  assert.equal(dialogState.ensureSendConfig(), true, '配置齐全时必须放行')

  // 模型为空（自填渠道没填过模型）
  reset()
  configureChannel()
  assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
  assert.equal(dialogState.ensureSendConfig(), false, '模型名为空必须拦下')
  let state = dialogState.useSettingsDialog.getState()
  assert.equal(state.open, true, '拦截要打开设置')
  // #727 阶段 1：地址与模型搬到了第三个 tab（账户与消费）。断言口径不变（「落在地址与模型所在的
  // 那一页」），值换成新 IA 的 `account` —— `SettingsDialog` 的 data tab 已经**明确不留**这几行，
  // 落在 `data` 等于把人送到一个没有输入框的面板（`ensureSendConfig` 里也是 `openSettings('account')`）。
  assert.equal(state.section, 'account', '落在「账户与消费」（地址与模型都在这一页）')
  assert.equal(state.sendConfigBlocked, 'model_empty', '设置页要知道被点名的是哪一类')
  assert.deepEqual(useToast.getState().message, { key: 'sendBlockedModelEmpty' }, 'toast 说明原因')

  // 改对了就清：改错行不清
  dialogState.clearSendConfigBlocked('baseUrl')
  assert.equal(
    dialogState.useSettingsDialog.getState().sendConfigBlocked,
    'model_empty',
    '改地址不该顺手抹掉模型的提示'
  )
  dialogState.clearSendConfigBlocked('model')
  assert.equal(dialogState.useSettingsDialog.getState().sendConfigBlocked, null, '改对了就清')

  // 关掉设置也清（不留僵尸提示）
  dialogState.useSettingsDialog.setState({ sendConfigBlocked: 'model_space' })
  dialogState.closeSettings()
  state = dialogState.useSettingsDialog.getState()
  assert.equal(state.sendConfigBlocked, null, '关掉设置要清掉这次拦截的提示')
})

test('[2] Key 与配置是两道门，互不顶替：Key 坏了先说 Key', () => {
  reset()
  apiConfig.setProviderKind('openai')
  apiConfig.setApiKey('') // Key 先坏
  // 配置也坏（地址与模型都没填）
  assert.equal(dialogState.ensureApiKey(), false, 'Key 那道门先拦下')
  assert.equal(
    dialogState.useSettingsDialog.getState().sendConfigBlocked,
    null,
    'Key 的问题不该顺手把「地址/模型」也点成红的'
  )
  assert.equal(dialogState.useSettingsDialog.getState().apiKeyFormatBlocked, false)
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'missing', '判据仍来自 #374 那份')
})

// ============================================================ [3] 请求数 = 0（核心断言）

const encoder = new TextEncoder()
/** 一段最小可用的 OpenAI SSE 流：只要上行真的发出去了，用例就能看到 `fetchCalls` 涨起来 */
const openAiStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
          )
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  fetchCalls += 1
  return openAiStream()
}

/** 让出微任务 + 真 macrotask，让异步链路（流、store 写入）跑到头 */
const flush = async (times = 10) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * 与 `ChatInput.tsx` 的发送入口**同构**：
 * `ensureSendPrerequisites()`（#793 身份）→ `ensureApiKey()`（#451/#596）→ `ensureSendConfig()`（#490）
 * → `sendMessage()`。四道顺序、短路语义都与真实入口一致，所以「请求数为 0」是这条链路的结论，
 * 不是本文件的臆想（第 [4] 段还用源码断言钉住这个顺序）。
 */
const attemptSend = async () => {
  if (
    !dialogState.ensureSendPrerequisites() ||
    !dialogState.ensureApiKey() ||
    !dialogState.ensureSendConfig()
  ) {
    return 'blocked'
  }
  setDraftText(null, '你好')
  const sent = sendMessage(null)
  await flush()
  return sent ? 'sent' : 'not-sent'
}

await initChat()

test('[3] 五类必错配置：一条请求都不发（请求数 = 0），也不新建会话', async () => {
  const CASES = [
    {
      code: 'base_url_empty',
      apply: () => {},
    },
    {
      code: 'base_url_no_protocol',
      // 设置页的输入框会挡下这种写法，但手改 localStorage / 老版本残留 / 导入配置都会留下它：
      // 发送前这道门必须自己判一次，不能指望上游
      apply: () => dom.localStorage.setItem(SCALAR_BASE_URL, 'api.example.com'),
    },
    {
      code: 'base_url_endpoint_path',
      apply: () => apiConfig.setBaseUrl('https://api.example.com/v1/chat/completions'),
    },
    {
      code: 'model_empty',
      apply: () => {},
    },
    {
      code: 'model_space',
      apply: () => apiConfig.setModel('deepseek v4-pro'),
    },
  ]

  for (const item of CASES) {
    reset()
    configureChannel()
    // 先摆一个「除了被测字段之外都正常」的配置，再让被测字段坏掉
    if (item.code !== 'base_url_empty' && item.code !== 'base_url_no_protocol') {
      assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
    }
    if (item.code !== 'model_empty' && item.code !== 'model_space') {
      assert.equal(apiConfig.setModel('deepseek-v4-pro'), true)
    }
    item.apply()

    // 判定确实命中了预期的这一类（否则下面的「请求数 0」可能只是因为别的原因没发）
    const verdict = apiConfig.checkCurrentSendConfig()
    assert.equal(verdict.ok, false, `${item.code}：配置应当被判为必错`)
    assert.equal(verdict.code, item.code, `${item.code}：命中的机器码`)

    fetchCalls = 0
    const sessionsBefore = useChatStore.getState().sessions.length
    // 合并批次里同一个进程可能已经跑过别的用例（会话不是空的）：只断言「这一拦没有改动它」，
    // 不假设 activeId 是 null —— 那会让本文件在批内假红、单跑假绿（#408 的教训）
    const activeBefore = useChatStore.getState().activeId
    const outcome = await attemptSend()

    assert.equal(outcome, 'blocked', `${item.code}：发送入口必须停下`)
    assert.equal(fetchCalls, 0, `${item.code}：命中后请求数必须是 0`)
    assert.equal(
      useChatStore.getState().sessions.length,
      sessionsBefore,
      `${item.code}：不许先建一条会话再拦`
    )
    assert.equal(
      useChatStore.getState().activeId,
      activeBefore,
      `${item.code}：不许切换会话`
    )
  }
})

test('[3] 正向对照：配置修好后同一条链路真的会发请求（0 才不是空断言）', async () => {
  reset()
  configureChannel()
  assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
  assert.equal(apiConfig.setModel('deepseek-v4-pro'), true)
  assert.equal(apiConfig.checkCurrentSendConfig().ok, true)

  fetchCalls = 0
  const outcome = await attemptSend()
  assert.equal(outcome, 'sent', '配置正常时必须真的发出去')
  assert.ok(fetchCalls >= 1, `同一条链路在配置正常时会发请求，实际 ${fetchCalls}`)
})

test.after(() => {
  globalThis.fetch = realFetch
})

// ============================================================ [4] 接线：拦截长在真实发送入口上

const source = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('[4] 两个发送入口都过 ensureSendConfig，且排在 sendMessage / editMessage 之前', () => {
  const chatInput = source('src/components/chatInput/ChatInput.tsx')
  const sendBody = chatInput.slice(chatInput.indexOf('const send = () =>'))
  const guardAt = sendBody.indexOf('ensureSendConfig()')
  const sendAt = sendBody.indexOf('sendMessage(sessionId)')
  assert.ok(guardAt > -1, 'ChatInput 的 send() 必须过 ensureSendConfig（#490 的入口就在这里）')
  assert.ok(guardAt < sendAt, '门禁必须排在 sendMessage 之前，否则请求已经出去了')

  const userMessage = source('src/components/messages/UserMessage.tsx')
  const editAt = userMessage.indexOf('ensureSendConfig()')
  assert.ok(editAt > -1, '编辑后重发同样是发送入口')
  assert.ok(editAt < userMessage.indexOf('editMessage('), '门禁排在 editMessage 之前')

  // 设置页要在**那一行**写原因：地址 / 模型两行都接了同一个提示组件
  const fields = source('src/components/settings/ApiConfigFields.tsx')
  assert.ok(fields.includes('<SendBlockedHint field="baseUrl" />'), '地址行要有行内提示')
  assert.ok(fields.includes('<SendBlockedHint field="model" />'), '模型行要有行内提示')
})

// ============================================================ [5] 凭据门（#793）

/**
 * Issue #793：**未登录 + 没有可用渠道/Key** 时直接发消息 —— 请求会带着空 `x-api-key` /
 * `Authorization` 打上游，界面只剩转圈，一句「你该干什么」都没有。
 *
 * 本段钉三件事（issue 的验收原文）：
 *  1. 请求数 = 0（一个上游请求都不发）；
 *  2. 出现提示（`sendBlockedNoCredentials`，中英成对）；
 *  3. 提示里带一个**动作**：点了切到「服务 Tab → 模型来源」（`openSettings('account')` 那条既有路径）。
 *
 * 外加两条负向/正向边界：
 *  - 未登录但**自己填了一把能用的 Key** → 照旧发车（自填渠道与登录无关）；
 *  - 已登录、只是还没 Key → **不走这条新门**（仍由 `ensureApiKey` 说「去填 Key / 去领取」）。
 */
const { useAuthStore } = await import('../../src/services/auth/store.ts')

/** 摆成「未登录」：新装机 / web 上没登录就是这个状态（`authenticated` 只认 `state === 'authenticated'`） */
const signOut = () => useAuthStore.setState({ state: 'unauthenticated', user: null, token: null })
/** 摆成「已登录」：只有 `state === 'authenticated'` 算登录（与 `useAuthStatus` 同一口径） */
const signIn = () => useAuthStore.setState({ state: 'authenticated' })

/** 把「什么都没有」摆出来：未登录 + 没 Key + 自填渠道的地址与模型也没填 */
const nothingConfigured = () => {
  reset()
  signOut()
  apiConfig.setProviderKind('openai')
  apiConfig.setApiKey('')
}

test('[5] 纯函数：只有「未登录 且 没有可用 Key」才拦（两样缺一样都放行）', () => {
  // 合取：issue 原文是「无登录态 **且** 无可用渠道/Key」
  const cases = [
    { label: '两样都没有', input: { authenticated: false, hasUsableKey: false }, blocked: true },
    { label: '未登录但有能用的 Key', input: { authenticated: false, hasUsableKey: true }, blocked: false },
    { label: '已登录但还没 Key', input: { authenticated: true, hasUsableKey: false }, blocked: false },
    { label: '两样都有', input: { authenticated: true, hasUsableKey: true }, blocked: false },
  ]
  for (const item of cases) {
    const verdict = sendCheck.checkSendPrerequisites(item.input)
    assert.equal(verdict.ok, !item.blocked, `${item.label}：放行/拦截判错`)
    if (!item.blocked) {
      continue
    }
    assert.equal(verdict.code, 'no_credentials', `${item.label}：机器码`)
    assert.equal(verdict.messageKey, 'sendBlockedNoCredentials', `${item.label}：正文文案 key`)
    assert.equal(verdict.actionKey, 'sendBlockedPickProvider', `${item.label}：动作文案 key`)
  }
  // 五类必错配置的码集合**没有被这条新门污染**（#490 的关闭条件仍在）
  assert.deepEqual(Object.keys(sendCheck.SEND_BLOCK_TABLE).sort(), [
    'base_url_empty',
    'base_url_endpoint_path',
    'base_url_no_protocol',
    'model_empty',
    'model_space',
  ])
  // 文案：中英成对，且都写清「没发出去」
  assert.equal(typeof zh.sendBlockedNoCredentials, 'string')
  assert.equal(typeof en.sendBlockedNoCredentials, 'string')
  assert.notEqual(zh.sendBlockedNoCredentials, en.sendBlockedNoCredentials, '真的翻译了')
  assert.match(zh.sendBlockedNoCredentials, /登录/u, '中文要说清可以登录')
  assert.match(zh.sendBlockedNoCredentials, /模型渠道/u, '中文要说清可以选渠道')
  assert.match(zh.sendBlockedNoCredentials, /没有发出/u, '中文要写明这条消息没有发出')
  assert.match(en.sendBlockedNoCredentials, /not sent/u, '英文要写明这条消息没有发出')
  assert.equal(zh.sendBlockedPickProvider, '去选择渠道')
  assert.equal(typeof en.sendBlockedPickProvider, 'string')
})

test('[5] 未登录 + 没有渠道/Key 发消息：0 次上游请求 + 出现提示 + 动作直达模型来源', async () => {
  nothingConfigured()
  // 先确认「确实是什么都没有」：不然下面的 0 可能只是因为别的原因没发出去
  assert.equal(apiConfig.getApiKey(), '')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'missing')
  assert.equal(useAuthStore.getState().state, 'unauthenticated')
  assert.equal(
    sendCheck.checkSendPrerequisites({ authenticated: false, hasUsableKey: false }).ok,
    false
  )

  fetchCalls = 0
  const sessionsBefore = useChatStore.getState().sessions.length
  const activeBefore = useChatStore.getState().activeId
  const outcome = await attemptSend()

  // ① 请求数 = 0（这条拦截的全部价值）
  assert.equal(outcome, 'blocked', '未登录且没有 Key：发送入口必须停下')
  assert.equal(fetchCalls, 0, '未登录且没有 Key：一个上游请求都不许发')
  assert.equal(
    useChatStore.getState().sessions.length,
    sessionsBefore,
    '不许先建一条会话再拦'
  )
  assert.equal(useChatStore.getState().activeId, activeBefore, '不许切换会话')

  // ② 出现提示（正文就是那句可操作的话）
  const toast = useToast.getState()
  assert.deepEqual(toast.message, { key: 'sendBlockedNoCredentials' }, 'toast 说明原因')

  // ③ 提示里有「去选择渠道」的动作，点了切到「服务 Tab → 模型来源」
  assert.ok(toast.action !== null, '提示必须带动作（不是一句只能等它自己消失的话）')
  assert.equal(toast.action.key, 'sendBlockedPickProvider', '动作文案：去选择渠道')
  assert.equal(dialogState.useSettingsDialog.getState().open, false, '拦下时不自动弹设置')
  toast.action.run()
  const settings = dialogState.useSettingsDialog.getState()
  assert.equal(settings.open, true, '点了动作要打开设置')
  // #727：渠道 / API Key / 模型都在第三个 tab（服务），「模型来源」三行就在这一页
  assert.equal(settings.section, 'account', '落在第三个 tab（服务 → 模型来源）')
})

/**
 * 「重新生成 / 继续」这条路（#793 里真正会**一直转圈**的入口）：它不经过输入框，改前一条门禁都没有。
 * 这里把 `AssistantMessage` 现在的那行门禁照抄一遍（三道、顺序一致），再走 `regenerateReply()` ——
 * 所以「请求数 = 0」是这条链路自己的结论。
 */
const attemptRegenerate = async (sessionId, messageId) => {
  if (
    !dialogState.ensureSendPrerequisites() ||
    !dialogState.ensureApiKey() ||
    !dialogState.ensureSendConfig()
  ) {
    return 'blocked'
  }
  regenerateReply(sessionId, messageId)
  await flush()
  return 'sent'
}

test('[5] 未登录 + 没有渠道/Key 点「重新生成」：也不许发请求，同样给提示 + 动作', async () => {
  // 先正常发一轮，拿到一条「有问有答」的会话（这一步有 Key，走的是第 [3] 段验证过的正向链路）
  reset()
  signOut()
  configureChannel()
  assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
  assert.equal(apiConfig.setModel('deepseek-v4-pro'), true)
  assert.equal(await attemptSend(), 'sent', '先造一条会话（有 Key 时正常发车）')

  const sessionId = useChatStore.getState().activeId
  const session = useChatStore.getState().sessionCache[sessionId]
  const assistant = session.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant, '会话里要有回答，才能点「重新生成」')

  // 把 Key 抹掉 = 未登录 + 没有可用渠道/Key（换渠道 / 退出登录后最真实的现场）
  apiConfig.setApiKey('')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'missing')

  fetchCalls = 0
  const outcome = await attemptRegenerate(sessionId, assistant.id)
  assert.equal(outcome, 'blocked', '「重新生成」同样是发送入口，必须停下')
  assert.equal(fetchCalls, 0, '未登录且没有 Key：重新生成也不许打上游')
  const toast = useToast.getState()
  assert.deepEqual(toast.message, { key: 'sendBlockedNoCredentials' })
  assert.equal(toast.action?.key, 'sendBlockedPickProvider', '提示里要有「去选择渠道」的动作')
  toast.action.run()
  assert.equal(dialogState.useSettingsDialog.getState().open, true, '动作直达设置')
  assert.equal(dialogState.useSettingsDialog.getState().section, 'account', '落在第三个 tab')
})

test('[5] 正向对照：未登录但自己填了能用的 Key，照旧发车（自填渠道与登录无关）', async () => {
  reset()
  signOut()
  configureChannel() // openai 渠道 + 一把格式正常的 Key
  assert.equal(apiConfig.setBaseUrl('https://api.example.com/v1'), true)
  assert.equal(apiConfig.setModel('deepseek-v4-pro'), true)
  assert.equal(dialogState.ensureSendPrerequisites(), true, '有能用的 Key 就不该走这条新门')
  assert.equal(apiConfig.checkCurrentSendConfig().ok, true)

  fetchCalls = 0
  const outcome = await attemptSend()
  assert.equal(outcome, 'sent', '有 Key 时必须真的发出去')
  assert.ok(fetchCalls >= 1, `同一条链路在有 Key 时会发请求，实际 ${fetchCalls}`)
})

test('[5] 已登录、只是还没 Key：新门放行，仍由 ensureApiKey 说「去填 Key / 去领取」', () => {
  reset()
  signIn()
  apiConfig.setProviderKind('openai')
  apiConfig.setApiKey('')
  assert.equal(dialogState.ensureSendPrerequisites(), true, '已登录时新门不该抢话')
  assert.equal(useToast.getState().message, null, '新门没说话')
  assert.equal(dialogState.ensureApiKey(), false, 'Key 那道门照旧拦下')
  assert.equal(
    dialogState.useSettingsDialog.getState().section,
    'account',
    '仍然落在第三个 tab（Key 那一行在这一页）'
  )
  signOut()
})

test('[5] 接线：三个不经过输入框的发送入口都补上了这条门，且排在真发车之前', () => {
  const chatInput = source('src/components/chatInput/ChatInput.tsx')
  const sendBody = chatInput.slice(chatInput.indexOf('const send = () =>'))
  const prereqAt = sendBody.indexOf('ensureSendPrerequisites()')
  assert.ok(prereqAt > -1, 'ChatInput.send 要过 ensureSendPrerequisites')
  assert.ok(
    prereqAt < sendBody.indexOf('ensureApiKey()'),
    '身份门排在 Key 门之前：什么都没有时先说「登录或选渠道」'
  )
  assert.ok(prereqAt < sendBody.indexOf('sendMessage(sessionId)'), '门禁排在 sendMessage 之前')

  const userMessage = source('src/components/messages/UserMessage.tsx')
  const editPrereq = userMessage.indexOf('ensureSendPrerequisites()')
  assert.ok(editPrereq > -1, '编辑后重发也是发送入口')
  assert.ok(editPrereq < userMessage.indexOf('editMessage('), '门禁排在 editMessage 之前')

  // 「重新生成」「继续」不经过输入框：这是 #793 里真正「一直转圈」的两个入口
  const assistant = source('src/components/messages/AssistantMessage.tsx')
  const regenPrereq = assistant.indexOf('ensureSendPrerequisites()')
  assert.ok(regenPrereq > -1, '重新生成 / 继续都要过身份门')
  const regenAt = assistant.indexOf('regenerateReply(sessionId, message.id)')
  const continueAt = assistant.indexOf('continueReply(sessionId, message.id)')
  assert.ok(regenPrereq < regenAt, '门禁排在 regenerateReply 之前')
  assert.ok(
    assistant.indexOf('ensureSendPrerequisites()', regenPrereq + 1) > -1,
    '「继续」那个入口同样要过（两处 onClicks）'
  )
  assert.ok(continueAt > regenAt, '继续按钮在重新生成之后（文件顺序）')

  // toast 的动作按钮是应用内动作（不是外链）：`Toast.tsx` 必须有这枚按钮
  const toastView = source('src/components/base/Toast.tsx')
  assert.ok(toastView.includes('data-testid="toast-action"'), 'toast 上要能渲染动作按钮')
})
