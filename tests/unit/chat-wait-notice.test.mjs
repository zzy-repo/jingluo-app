// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #41 首字等待的分级提示：纯函数 + 文案表 + 挂载点契约，不需要 DOM / 构建 / 真网络。
//
//   node tests/unit/chat-wait-notice.test.mjs
//
// 覆盖（对应任务书第 1 条）：
//   [1] 5s 之前不打扰用户
//   [2] 5s / 30s / 60s 三档逐级升级，边界精确
//   [3] 60s 档带「停止 / 重试」入口标记
//   [4] 三档文案在 zh / en 都存在且真的翻译了，中文措辞按任务书
//   [5] 定时器清单与分档一一对应（store 挂载用）
//   [6] 挂载点契约：store 按档写入提示、AssistantMessage 渲染提示并给出停止/重试按钮
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const { STREAM_NOTICE_TIERS, STREAM_NOTICE_DELAYS, streamNoticeTier } =
  await import('../../src/services/chat/streamNotice.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

test('首字等待提示：5s 之前不打扰', () => {
  assert.equal(streamNoticeTier(0), null, '刚发出请求不提示')
  assert.equal(streamNoticeTier(4_999), null, '4.9s 仍不提示')
})

test('首字等待提示：5s / 30s / 60s 逐级升级', () => {
  assert.equal(streamNoticeTier(5_000).key, 'replyWaitingFirstToken', '5s 提示正在等待响应')
  assert.equal(streamNoticeTier(29_999).key, 'replyWaitingFirstToken', '30s 之前保持第一档')
  assert.equal(streamNoticeTier(30_000).key, 'replyWaitingSlow', '30s 提示服务响应较慢')
  assert.equal(streamNoticeTier(59_999).key, 'replyWaitingSlow', '60s 之前保持第二档')
  assert.equal(streamNoticeTier(60_000).key, 'replyWaitingStalled', '60s 提示等待过久')
  assert.equal(streamNoticeTier(95_000).key, 'replyWaitingStalled', '更久仍是最高档')
})

test('首字等待提示：只有 60s 档给停止/重试入口', () => {
  const tiers = [5_000, 30_000, 60_000].map((elapsed) => streamNoticeTier(elapsed))
  assert.deepEqual(
    tiers.map((tier) => tier.actions),
    [false, false, true],
    '前两档只提示，60s 档才给可点的出口'
  )
})

test('首字等待提示：文案中英齐备并按任务书措辞', () => {
  for (const tier of STREAM_NOTICE_TIERS) {
    assert.equal(typeof zh[tier.key], 'string', `${tier.key} 有中文文案`)
    assert.equal(typeof en[tier.key], 'string', `${tier.key} 有英文文案`)
    assert.notEqual(zh[tier.key], en[tier.key], `${tier.key} 真的翻译了，不是同一串`)
  }
  assert.equal(zh.replyWaitingFirstToken, '正在等待响应')
  assert.equal(zh.replyWaitingSlow, '服务响应较慢，仍在等待')
  assert.match(zh.replyWaitingStalled, /停止/, '60s 档文案要提到停止')
  assert.match(zh.replyWaitingStalled, /重试|重新生成/, '60s 档文案要提到重试')
  assert.doesNotMatch(zh.replyWaitingStalled, /[\d.]+ ?s/i, '文案里不要写死秒数')
})

test('首字等待提示：定时器清单与分档一一对应', () => {
  assert.deepEqual(STREAM_NOTICE_DELAYS, [5_000, 30_000, 60_000], '三档三个定时器')
  assert.deepEqual(
    STREAM_NOTICE_TIERS.map((tier) => tier.afterMs),
    STREAM_NOTICE_DELAYS,
    '分档阈值与定时器不能对不上'
  )
})

test('挂载点契约：store 写提示、消息组件渲染并给出口', () => {
  const store = read('../../src/services/chat/store.ts')
  assert.match(store, /waitHint/i, 'store 要有首字等待提示状态')
  assert.match(store, /streamNotice/, 'store 要按分档规则写入提示')
  assert.match(store, /clearTimeout/, '首字或收尾后必须清掉升级定时器')

  const component = read('../../src/components/messages/AssistantMessage.tsx')
  assert.match(component, /waitHint/i, '等待占位要显示分级提示文案')
  assert.match(component, /stopReply/, '最高档要能停止')
  assert.match(component, /regenerateReply/, '最高档要能重新生成')
})
