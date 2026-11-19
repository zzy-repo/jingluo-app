// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
//
// Issue #339 的第三次修复：`modelInvalid` 文案必须**可诊断**。
//
// 原来的文案只说「请在设置里换一个模型」——而官方渠道的模型是内置的，设置页连模型行都没有
// （fields: ['apiKey']，setModel 拒写）。于是用户看到一句让他去做做不到的事的话，唯一出路
// 是手工改 localStorage。现在文案里带上：
//   ① 实际发出的模型名（reply.model 快照，正是诊断里一直记着、但界面没摆出来的那个值）
//   ② 上游自己给的可用模型列表（parseSupportedModels 从原文解析，不硬编码白名单）
//   ③ 内置渠道「设置里没有这一行，升级到已修复版本即可」的出路说明
//
//   node tests/run-layer.mjs unit --only model-invalid-copy
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口两个替身 + `.js→.ts` 解析。
// 以前每个 chat-stubs 文件各抄一份 registerHooks + 本地 `.js→.ts` 兜底（#408 已把同族 5 个文件迁走，
// 这几个文件是同族剩下的手抄件，一起收掉）。
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { ApiError } = await import('../../src/services/api/client.ts')
const { parseSupportedModels, isRetryableApiError } =
  await import('../../src/services/api/errors.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言才不受 shell 的 LANG 影响')

/** 官方端点 400 原文（只截掉 request_id） */
const UPSTREAM_TEXT =
  'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.'

const replyOf = ({
  model,
  message = UPSTREAM_TEXT,
  status = 400,
  upstreamCode = 'invalid_request_error',
}) => ({
  id: 'reply-339',
  role: 'assistant',
  createdAt: 0,
  model,
  prefix: false,
  status: 'error',
  blocks: [],
  error: { kind: 'http', message, status, upstreamCode },
})

test('parseSupportedModels：从上游原文里取出可用模型列表', () => {
  assert.deepEqual(parseSupportedModels(UPSTREAM_TEXT), ['deepseek-flash', 'deepseek-v4-pro'])
  // 结尾没有句号 / 没有「but you passed」那半句
  assert.deepEqual(
    parseSupportedModels('The supported API model names are deepseek-flash, deepseek-v4-pro'),
    ['deepseek-flash', 'deepseek-v4-pro']
  )
  // 模型名本身带点（deepseek-v4.1-flash）：句子里的句点不能把名字切坏
  assert.deepEqual(
    parseSupportedModels('supported API model names are deepseek-v4.1-flash, deepseek-flash.'),
    ['deepseek-v4.1-flash', 'deepseek-flash']
  )
  // 用 and 连接的写法
  assert.deepEqual(parseSupportedModels('The supported API model names are a-model and b-model.'), [
    'a-model',
    'b-model',
  ])
  // 脏文本 / 没有这句话 / 空值：返回空数组，界面退回「上游未提供列表」
  for (const dirty of [
    '',
    undefined,
    'model not found',
    '当前模型在上游不可用（模型名可能已下线）',
    'supported API model names are',
  ]) {
    assert.deepEqual(parseSupportedModels(dirty), [], `脏文本要返回空数组：${String(dirty)}`)
  }
})

test('modelInvalid 文案：带实际模型名 + 上游可用列表 + 内置渠道的出路', () => {
  const notice = describeReply(replyOf({ model: 'deepseek-v4.1-flash' }))
  assert.ok(notice, 'modelInvalid 必须给出一条提示')
  assert.match(notice.text, /deepseek-v4\.1-flash/, '文案里要出现**实际发出的**模型名')
  assert.match(notice.text, /deepseek-flash/, '文案里要出现上游可用模型之一')
  assert.match(notice.text, /deepseek-v4-pro/, '文案里要出现上游可用模型之二')
  assert.match(notice.text, /内置模型/, '要说清官方渠道用的是内置模型')
  assert.match(notice.text, /不要重试/, '模型不存在是终态：文案要说清不要重试')
  assert.doesNotMatch(notice.text, /\{model\}|\{models\}/, '占位符必须都被替换掉')
  assert.equal(notice.diagnostics, undefined, '已识别的场景不需要额外诊断文本')
})

test('modelInvalid 文案：回复里没记录模型名时退回「未记录」而不是留空', () => {
  const notice = describeReply(replyOf({ model: null }))
  assert.match(notice.text, /未记录/, '导入的历史回复可能没有模型快照')
  assert.match(notice.text, /deepseek-v4-pro/, '可用列表仍然要带上')
  assert.doesNotMatch(notice.text, /null|undefined/)
})

test('modelInvalid 文案：上游没给列表时明说「上游未提供列表」', () => {
  const notice = describeReply(
    replyOf({
      model: 'no-such-model',
      message: 'unknown model: no-such-model',
      upstreamCode: undefined,
    })
  )
  assert.match(notice.text, /no-such-model/, '仍然要带出实际发出的模型名')
  assert.match(notice.text, /上游未提供列表/)
})

test('模型不存在仍然不可重试（自动重试不会白等几轮）', () => {
  const error = new ApiError(
    'http',
    UPSTREAM_TEXT,
    400,
    undefined,
    undefined,
    'invalid_request_error'
  )
  assert.equal(isRetryableApiError(error), false)
})

test('zh / en 两份文案成对：占位符一一对应，且真的翻译了', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  assert.deepEqual(placeholders(zh.replyModelInvalid), ['model', 'models'])
  assert.deepEqual(placeholders(en.replyModelInvalid), ['model', 'models'])
  assert.notEqual(zh.replyModelInvalid, en.replyModelInvalid, '英文必须是另一份文案')
  for (const key of ['replyModelInvalidNoModels', 'replyModelUnknownName']) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
  // 渲染路径用真实 translate()，不是手写字符串
  assert.match(
    translate('replyModelInvalid', { model: 'm-1', models: 'm-2' }),
    /m-1[\s\S]*m-2/,
    '参数要按顺序进到句子里'
  )
})
