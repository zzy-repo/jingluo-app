// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <2s]
//
// Issue #347 / #353：上游 4xx 的**界面文案**（同一条链路的两个表现）。
//   现状 1（#347）：4xx 只显示「回答没有完成，出现了未知错误」，HTTP 码与上游原文都进不了界面。
//   现状 2（#353）：参数错误档只会说「请求被上游判定为参数错误」，不可操作 ——
//                   说不出哪个字段、看不到上游原文、也没有跳转设置的入口。
//
// 本用例是**表驱动**的：一行 = 一条真实上游响应（status + code + message）→ 期望
//   ① 分类（classifyErrorSignature）
//   ② 文案 key（用真实 translate() 拼期望值，不手写字符串）
//   ③ 有没有操作入口（action）
//   ④ 主文案里有没有 HTTP 状态码
//   ⑤ 有没有折叠区里的上游原文 / 可复制诊断
// 覆盖 400 / 401 / 403 / 404 / 422 / 429 / 500 / 418 未知 / 真未知 / 模型不可用 / 中文原文，
// 共 12 行（要求 ≥8）。上游原文全部来自 #324 / #347 / #353 的真实抓取（只截掉 request_id）。
//
//   node --test tests/unit/upstream-error-copy-347.test.mjs
//   node tests/run-layer.mjs unit --only upstream-error-copy-347
import '../helpers/injected.mjs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: stub('collector.mjs'), shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { classifyErrorSignature, parseErrorField } = await import(
  '../../src/services/api/errors.ts'
)
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { buildUpstreamSnippet } = await import('../../src/services/chat/replyErrorReport.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言才不受 shell 的 LANG 影响')

/**
 * 把「上游回了什么」按 store 的存法落成一条 error 回复，再问界面会显示什么。
 * `localMessage` 一律不给：这里测的正是「上游报错 + 没有本地文案」那条路径（#347 原文）。
 */
const noticeOf = ({ status, code, message, model = null }) =>
  describeReply({
    id: 'reply-347',
    role: 'assistant',
    createdAt: 0,
    model,
    prefix: false,
    status: 'error',
    blocks: [],
    error: {
      kind: 'http',
      message,
      status,
      ...(code ? { upstreamCode: code } : {}),
    },
  })

const UPSTREAM_400_REMINDER =
  "Invalid 'messages.0.content': latest_reminder must have at least 5 comma-separated fields, got 4."
const UPSTREAM_MODEL_LIST =
  'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed no-such-model.'

/**
 * 表：上游响应 → 期望界面。
 * - `key`：主文案该用的 i18n key（`''` 表示「上游原话直接展示」，见最后一行）
 * - `action`：提示条上该出现的操作（undefined = 不该有按钮）
 * - `status`：主文案里是否要出现 HTTP 状态码
 * - `fold`：是否要有折叠区（上游原文）
 * - `copy`：是否要有「复制诊断信息」
 */
const ROWS = [
  {
    label: '400 + invalid_request_error + 上游点名字段',
    status: 400,
    code: 'invalid_request_error',
    message: UPSTREAM_400_REMINDER,
    condition: 'badRequest',
    key: 'replyParamInvalid',
    params: { status: 'HTTP 400', field: 'messages.0.content' },
    action: 'settings',
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '422 + invalid_request_error + 字段没好',
    status: 422,
    code: 'invalid_request_error',
    message:
      'Failed to deserialize the JSON body into the target type: max_tokens: invalid value: integer `-1`, expected u32',
    condition: 'badRequest',
    key: 'replyParamInvalid',
    params: { status: 'HTTP 422', field: 'max_tokens' },
    action: 'settings',
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '400 参数错但上游没说清字段',
    status: 400,
    message: 'invalid request: unsupported file type',
    condition: 'badRequest',
    key: 'replyBadRequest',
    params: { status: 'HTTP 400' },
    action: 'settings',
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '400 + 模型不存在（官方端点原文）',
    status: 400,
    code: 'invalid_request_error',
    message: UPSTREAM_MODEL_LIST,
    model: 'no-such-model',
    condition: 'modelInvalid',
    key: 'replyModelInvalid',
    params: { model: 'no-such-model', models: 'deepseek-flash, deepseek-v4-pro' },
    action: 'settings',
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '401 Key 无效',
    status: 401,
    code: 'authentication_error',
    message: 'Authentication Fails, Your api key: ****2305 is invalid',
    condition: 'unauthorized',
    key: 'replyInvalidApiKey',
    params: {},
    action: 'apiKey',
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '403 + invalid_api_key（网关常用写法，以前落到「未知错误」）',
    status: 403,
    code: 'invalid_api_key',
    message: 'invalid api key provided',
    condition: 'unauthorized',
    key: 'replyInvalidApiKey',
    params: {},
    action: 'apiKey',
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '403 权限不足（不是参数问题，也不该说成未知错误）',
    status: 403,
    message: 'Forbidden: this key has no access to the model',
    condition: 'upstreamRejected',
    key: 'replyUpstreamRejected',
    params: { status: 'HTTP 403' },
    action: undefined,
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '404 路径不存在（#303 里刷屏的那类）',
    status: 404,
    message: 'Not Found: /v1/chat/completions/files',
    condition: 'upstreamRejected',
    key: 'replyUpstreamRejected',
    params: { status: 'HTTP 404' },
    action: undefined,
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '429 限流（临时故障，文案说可以重试）',
    status: 429,
    message: 'rate limit reached for requests',
    condition: 'rateLimited',
    key: 'replyRateLimited',
    params: {},
    action: undefined,
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '500 服务端故障（临时故障，文案说可以重试）',
    status: 500,
    message: 'internal server error',
    condition: 'serverBusy',
    key: 'replyServerBusy',
    params: {},
    action: undefined,
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '418 未识别但有据可查（状态码 + 上游短码 + 复制诊断）',
    status: 418,
    code: 'weird_upstream_code',
    message: 'totally new upstream failure shape',
    condition: 'other',
    key: 'replyUnclassifiedFatal',
    params: { detail: 'HTTP 418，code=weird_upstream_code' },
    action: undefined,
    showsStatus: true,
    fold: true,
    copy: true,
  },
  {
    label: '真未知（无状态码、无上游 code、无中文原文）',
    status: undefined,
    message: 'upstream exploded at /v1/messages',
    condition: 'other',
    key: 'replyUnknownError',
    params: {},
    action: undefined,
    showsStatus: false,
    fold: false,
    copy: false,
  },
  {
    label: '上游写了中文：原话比固定文案具体，照旧直接展示',
    status: 400,
    message: '请求参数错误：模型名不合法',
    condition: 'badRequest',
    key: '',
    params: {},
    action: 'settings',
    showsStatus: false,
    fold: false,
    copy: true,
  },
]

test('表驱动：上游响应 → 分类 / 文案 key / 操作入口 / 状态码可见', () => {
  assert.ok(ROWS.length >= 8, `用例行数要 ≥8，实际 ${ROWS.length}`)
  for (const row of ROWS) {
    const tag = `[${row.label}]`
    // ① 分类
    assert.equal(
      classifyErrorSignature({ status: row.status, code: row.code, message: row.message }),
      row.condition,
      `${tag} 分类不对`
    )
    const notice = noticeOf(row)
    assert.ok(notice, `${tag} 必须给出一条提示`)
    // ② 文案（真实 translate()，不是手写字符串）
    const expected = row.key ? translate(row.key, row.params) : row.message
    assert.equal(notice.text, expected, `${tag} 文案不对（实际：${notice.text}）`)
    // ③ 操作入口
    assert.equal(notice.action, row.action, `${tag} 操作入口不对`)
    // ④ 状态码可见
    const showsStatus = /HTTP \d{3}/.test(notice.text)
    assert.equal(showsStatus, row.showsStatus, `${tag} 状态码可见性不对（实际：${notice.text}）`)
    // ⑤ 折叠区（上游原文）与复制诊断
    assert.equal(!!notice.upstream, row.fold, `${tag} 折叠区有无不对`)
    assert.equal(!!notice.diagnostics, row.copy, `${tag} 「复制诊断信息」有无不对`)
    // 英文原文一律不进主文案（#324 的 isReadableForUser 口径）：
    // 只有「上游写的就是中文」那一行允许原话直接展示
    if (row.key) {
      assert.ok(!notice.text.includes(row.message), `${tag} 英文原文不许进主文案`)
    }
  }
})

test('4xx 文案：请求参数 / 上游拒绝这两档都写明「不要重试」', () => {
  for (const key of ['replyParamInvalid', 'replyBadRequest', 'replyUpstreamRejected']) {
    assert.match(translate(key, { status: 'HTTP 400', field: 'max_tokens' }), /不要重试/, key)
  }
  // 临时故障那两档反过来要写「可以重试」，不能混
  assert.match(translate('replyRateLimited'), /可以重试/)
  assert.match(translate('replyServerBusy'), /可以重试/)
})

test('折叠区（上游原文）：脱敏 + 截断，Key / 卡密 / 手机号不原文出现', () => {
  const snippet = buildUpstreamSnippet({
    status: 400,
    upstreamCode: 'invalid_request_error',
    message:
      'bad request for key sk-live-0123456789abcdef card GOLD-1234-5678-9012-ABCD phone 13800138000 request_id=req-1',
  })
  assert.ok(snippet, '有原文就该有折叠内容')
  assert.match(snippet, /HTTP 400/, '折叠区第一行带状态码')
  assert.match(snippet, /code=invalid_request_error/, '折叠区第一行带上游短码')
  assert.doesNotMatch(snippet, /sk-live-0123456789abcdef/, 'API Key 必须被抹掉')
  assert.doesNotMatch(snippet, /GOLD-1234-5678-9012-ABCD/, '卡密必须被抹掉')
  assert.doesNotMatch(snippet, /13800138000/, '手机号必须被抹掉')
  // 长原文截断（不贴整段），空原文不给折叠区
  const long = buildUpstreamSnippet({ status: 400, message: 'x'.repeat(2000) })
  assert.ok(long && long.length < 400, `要截断，实际 ${long?.length} 字`)
  assert.equal(buildUpstreamSnippet({ status: 400, message: '   ' }), undefined, '空原文没有折叠区')
  assert.equal(buildUpstreamSnippet({}), undefined, '什么都不知道时不给折叠区')
})

test('parseErrorField：三种上游写法各取出字段，脏文本一律返回空串', () => {
  assert.equal(parseErrorField(UPSTREAM_400_REMINDER), 'messages.0.content', '引号里的字段')
  assert.equal(
    parseErrorField('messages: at least one message is required'),
    'messages',
    '行首 字段: 写法'
  )
  assert.equal(
    parseErrorField(
      'Failed to deserialize the JSON body into the target type: max_tokens: invalid value: integer `-1`'
    ),
    'max_tokens',
    '长前缀之后的字段'
  )
  assert.equal(
    parseErrorField('invalid request: max_tokens must be a positive integer'),
    'max_tokens',
    '没有冒号的「字段 + must be」写法'
  )
  for (const dirty of ['', undefined, 'unsupported file type: .exe', 'system error occurred', '请求参数错误']) {
    assert.equal(parseErrorField(dirty), '', `脏文本不该取出字段：${String(dirty)}`)
  }
})

test('zh / en 成对：新 key 两边都有、真的翻译了、占位符一一对应', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of [
    'replyParamInvalid',
    'replyBadRequest',
    'replyUpstreamRejected',
    'replyUpstreamStatusUnknown',
    'upstreamDetailToggle',
    'openSettingsEntry',
  ]) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 占位符要一一对应`)
  }
  // 英文文案里不许夹中文（否则 en 用户会看到中英混排）
  for (const key of ['replyParamInvalid', 'replyBadRequest', 'replyUpstreamRejected']) {
    assert.doesNotMatch(en[key], /[\u4e00-\u9fa5]/, `${key} 的英文版不许夹中文`)
  }
})

test('英文界面：同样给出状态码与设置入口，且不显示中文', () => {
  try {
    useSettings.setState({ locale: 'en-US' })
    const notice = noticeOf({
      status: 400,
      code: 'invalid_request_error',
      message: UPSTREAM_400_REMINDER,
    })
    assert.equal(
      notice.text,
      translate('replyParamInvalid', { status: 'HTTP 400', field: 'messages.0.content' })
    )
    assert.doesNotMatch(notice.text, /[\u4e00-\u9fa5]/, '英文界面不显示中文')
    assert.equal(notice.action, 'settings')
  } finally {
    useSettings.setState({ locale: 'zh-CN' })
  }
})

test('流内错误帧（没有 HTTP 状态码）不硬编「HTTP undefined」', () => {
  const notice = describeReply({
    id: 'reply-347-stream',
    role: 'assistant',
    createdAt: 0,
    prefix: false,
    status: 'error',
    blocks: [],
    error: { kind: 'stream', message: 'invalid parameters', upstreamCode: 'invalid_parameter' },
  })
  assert.ok(notice)
  assert.doesNotMatch(notice.text, /undefined|NaN/, '没有状态码时不许出现 undefined / NaN')
  assert.match(notice.text, /上游未给出状态码/, '改说「上游未给出状态码」')
  assert.equal(notice.action, 'settings', '流内参数错误同样要给设置入口')
})

test('复制诊断：含 status / code / request_id / 时间，且不含 Key 与正文（#347 关闭条件）', async () => {
  const { buildReplyErrorReport } = await import('../../src/services/chat/replyErrorReport.ts')
  const text = buildReplyErrorReport({
    status: 400,
    upstreamCode: 'invalid_request_error',
    kind: 'http',
    message: `bad request for key sk-live-0123456789abcdef "request_id": "req-9f3a71c2d8"`,
    at: 0,
  })
  assert.match(text, /^DeepSeek 回答失败诊断/, '第一行是标题')
  assert.match(text, /时间: 1970-01-01T00:00:00\.000Z/, '有出错时间')
  assert.match(text, /环节: http（流开始前）/, '有失败环节')
  assert.match(text, /HTTP 状态: 400/, '有状态码')
  assert.match(text, /上游 code: invalid_request_error/, '有上游短码')
  assert.match(text, /上游 request_id: req-9f3a71c2d8/, 'request_id 单列一行')
  assert.doesNotMatch(text, /sk-live-0123456789abcdef/, 'API Key 必须被抹掉')
  assert.doesNotMatch(text, /你好|聊天正文/, '不含用户正文')
})
