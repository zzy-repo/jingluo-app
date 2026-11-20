// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发真实网络请求） | 耗时: <2s]
//
// Issue #374：Key 失效时只有一句「API Key 无效或已被删除」，用户看不出是哪把 Key、
// 也看不出到底是「格式粘贴错了 / Key 被删了 / 换过 Key 旧的不认了」——
// 而这三件事的下一步完全不同。
//
// 本用例是**表驱动**的：一行 = 一种 Key 失效场景 → 期望
//   ① 细分（classifyKeyFailure 的 kind）
//   ② 文案 i18n key（用真实 translate() 拼期望值，不手写字符串）
//   ③ 界面有没有 Key 尾号（#374 第 2 点：让用户知道是哪一把）
//   ④ 有没有「先看额度」的跳转（#374 第 3 点：换 Key 会影响额度归属）
//
//   node --test tests/unit/api-key-failure-374.test.mjs
//   node tests/run-layer.mjs unit --only api-key-failure-374
//
// 覆盖（≥ 三类差异）：格式错（本地可判）/ 不存在或被删除 / 被轮换（旧 Key 失效）/
// 上游没说清（兜底）+ 只有状态码的 401 + 官方端点真实原文 + 中文原文。
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  installChatBridge,
  installEndpointsGlobals,
  setupDom,
} from '../helpers/dom-env.mjs'

installChatBridge()
installEndpointsGlobals()
const dom = setupDom()

const { classifyKeyFailure, isKeyFormatInvalid, keyTail } = await import(
  '../../src/services/api/keyFailure.ts'
)
const { classifyErrorSignature } = await import('../../src/services/api/errors.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

/** 一把完整的 Key（尾号 abcd）：用来验证「界面只回显尾 4 位」 */
const GOOD_KEY = 'sk-live-0123456789abcd'

const emptyReply = () => ({
  id: 'reply-374',
  role: 'assistant',
  createdAt: 0,
  status: 'error',
  blocks: [],
  prefix: false,
})

/**
 * 按 store.ts 的存法把一条失败落成回复，再问界面显示什么。
 * `keyFailure` 由 store 在失败**当次**算好并落盘（#374），这里如实照做。
 */
const noticeOf = ({ status, code, message, apiKey, localMessage }) => {
  const keyFailure = classifyKeyFailure({ status, code, message, apiKey })
  return describeReply({
    ...emptyReply(),
    error: {
      kind: 'http',
      message,
      status,
      ...(code ? { upstreamCode: code } : {}),
      ...(localMessage ? { localMessage } : {}),
      keyFailure,
    },
  })
}

/**
 * 表：场景 → 期望细分 / 文案 key / 有没有尾号 / 有没有额度跳转。
 *   copy: { key, params } —— 用真实 translate() 拼期望值
 */
const ROWS = [
  {
    label: '[格式错] Key 里混进了空格 / 换行（粘贴时就坏了，本地可判）',
    // 真实形态：本地没拦住、请求真的发出去了，上游回 401 —— 但**原因**是格式，
    // 不是「Key 被删了」，所以文案必须说「重新完整粘贴一次」。
    status: 401,
    message: 'Invalid authorization header',
    apiKey: 'sk-live-0123\n456789abcd',
    failKind: 'format',
    copy: { key: 'replyApiKeyFormatWrong' },
    showsTail: false,
    quota: true,
    why: '格式错是本地能判的：文案要让人重新粘贴，而不是说「上游删了你的 Key」',
  },
  {
    label: '[不存在/已删除] 上游 code 明说 api_key_not_found',
    status: 401,
    code: 'api_key_not_found',
    message: 'No such API key',
    apiKey: GOOD_KEY,
    failKind: 'notFound',
    copy: { key: 'replyApiKeyNotFound' },
    showsTail: true,
    quota: true,
    why: '属于 /bind 之前的情况：Key 不存在或已被删除',
  },
  {
    label: '[被轮换] 上游 code 明说 api_key_rotated（旧 Key 立即失效）',
    status: 401,
    code: 'api_key_rotated',
    message: 'This API key has been rotated',
    apiKey: GOOD_KEY,
    failKind: 'rotated',
    copy: { key: 'replyApiKeyRotated' },
    showsTail: true,
    quota: true,
    why: '轮换 ≠ 删除：#90 的 /rotate 语义是旧 Key 立即作废、额度不丢，文案必须分开',
  },
  {
    label: '[被轮换] 只有中文原文：Key 已被轮换',
    status: 401,
    message: '该 Key 已被轮换，请使用新的 Key',
    apiKey: GOOD_KEY,
    failKind: 'rotated',
    copy: { key: 'replyApiKeyRotated' },
    showsTail: true,
    quota: true,
    why: '上游写中文时同样要认出来（不能只认英文 code）',
  },
  {
    label: '[不存在/已删除] 官方端点原文：api key: ****2305 is invalid',
    status: 401,
    code: 'authentication_error',
    message: 'Authentication Fails, Your api key: ****2305 is invalid',
    apiKey: GOOD_KEY,
    failKind: 'notFound',
    copy: { key: 'replyApiKeyNotFound' },
    showsTail: true,
    quota: true,
    why: '官方端点 code 分不开，只能按原文认（主谓倒装也要认得出）',
  },
  {
    label: '[上游没说清] 只有 401，没有任何 code / 可辨识原文',
    status: 401,
    message: 'unauthorized',
    apiKey: GOOD_KEY,
    failKind: 'rejected',
    copy: { key: 'replyInvalidApiKey' },
    showsTail: true,
    quota: true,
    why: '确定不了就不编原因：文案说「上游没说明」，尾号照给',
  },
  {
    label: '[回看历史] 没有 Key 字符串时不做本地格式判定',
    status: 401,
    code: 'invalid_api_key',
    message: 'invalid api key provided',
    failKind: 'notFound',
    copy: { key: 'replyApiKeyNotFound' },
    showsTail: false,
    quota: true,
    why: '导入的旧记录拿不到当时那把 Key：不许把「没有字符串」误判成格式错，也不许编尾号',
  },
]

test('[1] 表驱动：三类 Key 失效 → 细分 / 文案 key / 是否显示尾号 / 是否带额度跳转', () => {
  assert.ok(ROWS.length >= 3, `至少覆盖三类，实际 ${ROWS.length} 行`)
  const kinds = new Set(ROWS.map((row) => row.failKind))
  for (const required of ['format', 'notFound', 'rotated']) {
    assert.ok(kinds.has(required), `三类必须都覆盖到，缺 ${required}`)
  }

  for (const row of ROWS) {
    const tag = `[${row.label}]`
    const notice = noticeOf(row)
    assert.ok(notice, `${tag} 必须给出一条提示`)

    // ① 细分
    const failure = classifyKeyFailure({
      status: row.status,
      code: row.code,
      message: row.message,
      apiKey: row.apiKey,
    })
    assert.equal(failure.kind, row.failKind, `${tag} ${row.why}`)

    // ② 文案（真实 translate()，不手写字符串）+ 额度归属提醒
    const expected = `${translate(row.copy.key, row.copy.params)}${failure.tail ? translate('replyApiKeyTailNote', { tail: failure.tail }) : ''}；${translate('replyApiKeyQuotaNote')}`
    assert.equal(notice.text, expected, `${tag} 文案不对（实际：${notice.text}）`)
    assert.match(notice.text, /额度归属/, `${tag} 必须提醒「换 Key 会影响额度归属」`)

    // ③ Key 尾号
    assert.equal(
      notice.text.includes(translate('replyApiKeyTailNote', { tail: keyTail(row.apiKey) })),
      row.showsTail && !!keyTail(row.apiKey),
      `${tag} 尾号显示与否不对（实际：${notice.text}）`
    )
    if (row.showsTail) {
      assert.match(notice.text, /当前 Key 尾号 abcd/, `${tag} 尾号要是那把 Key 的后 4 位`)
      assert.ok(!notice.text.includes(GOOD_KEY), `${tag} 整把 Key 绝不能上界面`)
    }

    // ④ 出口：换 Key + 不动 Key 的「先看额度」
    assert.equal(notice.action, 'apiKey', `${tag} 要有「更换 API Key」的出口`)
    assert.equal(notice.quotaAction, row.quota, `${tag} 要有「先看额度」的跳转（换 Key 前先确认账号）`)
  }
})

test('[2] keyTail / isKeyFormatInvalid：只回显尾部、太短的 Key 一个字符都不回显', () => {
  assert.equal(keyTail(GOOD_KEY), 'abcd')
  assert.equal(keyTail('  sk-live-0123456789abcd  '), 'abcd', '两侧空白不影响尾号')
  assert.equal(keyTail('sk-short'), '', '太短的 Key 不回显（否则等于把它整个贴出来）')
  assert.equal(keyTail(''), '')
  assert.equal(keyTail(undefined), '')

  assert.equal(isKeyFormatInvalid(''), true, '空 Key')
  assert.equal(isKeyFormatInvalid('sk-live 0123456789abcd'), true, '中间有空格')
  assert.equal(isKeyFormatInvalid('sk-live-0123456789abcd\n'), true, '尾部有换行')
  assert.equal(isKeyFormatInvalid('sk-123'), true, '长度明显不像一把 Key')
  assert.equal(isKeyFormatInvalid(GOOD_KEY), false, '正常 Key 不该被判成格式错')
})

test('[3] 分类与鉴权档一致：Key 不行的三种上游写法仍归 unauthorized（#303 / #347 不回退）', () => {
  for (const row of [
    { status: 401, message: 'unauthorized' },
    { status: 403, code: 'invalid_api_key', message: 'invalid api key provided' },
    { status: 400, code: 'api_key_not_found', message: 'no such api key' },
  ]) {
    assert.equal(classifyErrorSignature(row), 'unauthorized', `${JSON.stringify(row)} 仍是鉴权档`)
  }
})

test('[4] 中英文案成对：新 key 两边都有、真的翻译了、占位符对齐', () => {
  const keys = [
    'replyInvalidApiKey',
    'replyApiKeyFormatWrong',
    'replyApiKeyNotFound',
    'replyApiKeyRotated',
    'replyApiKeyTailNote',
    'replyApiKeyQuotaNote',
    'openQuotaPanel',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
  // 占位符对齐：尾号那句两种语言都必须是 {tail}
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((item) => item[1]).sort()
  assert.deepEqual(placeholders(zh.replyApiKeyTailNote), ['tail'])
  assert.deepEqual(placeholders(en.replyApiKeyTailNote), ['tail'])
  assert.equal(
    translate('replyApiKeyTailNote', { tail: 'abcd' }),
    zh.replyApiKeyTailNote.replace('{tail}', 'abcd')
  )
})
