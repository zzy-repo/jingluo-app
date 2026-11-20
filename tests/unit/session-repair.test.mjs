// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 存储被写坏时的数据兜底（issue #28）：`messages` / `files` / `blocks` 是 null 时不再抛 TypeError。
//   [1] files=null（#28 实测白屏的那条数据）→ 修成 []，并上报一条 files:reset
//   [2] messages=null → 修成 []，并上报一条 messages:reset
//   [3] 数组里认不出的元素（null / 数字 / 缺 id）丢掉，条数记在 dropped 里
//   [4] blocks=null（回答内容块）同样兜底成 []
//   [5] 健康数据：不动对象引用、不上报（store 靠引用判断要不要回写）
//   [6] 线性会话仍按原逻辑补 parentId / selectedChildId；分支会话保留原选择
//
//   cd /root/worktrees/deepseek-error-boundary && node tests/unit/session-repair.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { normalizeSession } = await import('../../src/services/chat/branches.ts')

const attachment = (id) => ({
  id,
  serverId: null,
  name: `${id}.png`,
  size: 128,
  isImage: true,
  mimeType: 'image/png',
})

const userMessage = (id, files = [attachment('f-' + id)], content = 'hello') => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: 1,
})

const assistantMessage = (id, blocks = [{ type: 'text', text: 'hi' }]) => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: false,
  status: 'done',
  blocks,
})

const session = (messages) => ({ id: 's1', title: 't', createdAt: 1, updatedAt: 2, messages })

const run = (input) => {
  const damage = []
  const out = normalizeSession(input, (items) => damage.push(...items))
  return { out, damage }
}

test('files=null (the exact corruption from #28) is repaired to [] and reported', () => {
  const input = session([userMessage('m1', null), assistantMessage('m2')])
  const { out, damage } = run(input)
  assert.deepEqual(out.messages[0].files, [])
  assert.equal(out.messages[1].role, 'assistant')
  assert.equal(damage.length, 1)
  assert.deepEqual(damage[0], {
    field: 'files',
    action: 'reset',
    messageId: 'm1',
    received: 'null',
  })
  // 修完能正常渲染该会话：消息还在，只是附件为空
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].content, 'hello')
})

test('messages=null is repaired to [] and reported', () => {
  const { out, damage } = run(session(null))
  assert.deepEqual(out.messages, [])
  assert.equal(out.rootMessageId, null)
  assert.deepEqual(damage, [{ field: 'messages', action: 'reset', received: 'null' }])
})

test('unusable entries are dropped, usable ones kept, drops are counted', () => {
  const input = session([userMessage('m1'), null, 42, { role: 'user' }, assistantMessage('m2')])
  const { out, damage } = run(input)
  assert.deepEqual(
    out.messages.map((message) => message.id),
    ['m1', 'm2']
  )
  const drops = damage.filter((item) => item.action === 'drop')
  assert.equal(drops.length, 3)
  for (const drop of drops) {
    assert.equal(drop.field, 'messages')
    assert.equal(drop.dropped, 1)
  }
  assert.deepEqual(
    drops.map((item) => item.received).sort(),
    // null 元素 / 数字 / 没有 id 的对象：三种都认不出，丢弃
    ['null', 'number', 'object']
  )
})

test('files with unusable entries keep the good ones and report the count', () => {
  const input = session([userMessage('m1', [attachment('f1'), null, { name: 'no-id.png' }])])
  const { out, damage } = run(input)
  assert.deepEqual(
    out.messages[0].files.map((file) => file.id),
    ['f1']
  )
  assert.deepEqual(damage, [
    { field: 'files', action: 'drop', messageId: 'm1', received: 'array', dropped: 2 },
  ])
})

test('blocks=null on an assistant message degrades to [] (still renders)', () => {
  const input = session([assistantMessage('m1', null)])
  const { out, damage } = run(input)
  assert.deepEqual(out.messages[0].blocks, [])
  assert.deepEqual(damage, [
    { field: 'blocks', action: 'reset', messageId: 'm1', received: 'null' },
  ])
})

test('healthy session keeps object identity and reports nothing', () => {
  const input = session([userMessage('m1'), assistantMessage('m2')])
  const damage = []
  const out = normalizeSession(input, (items) => damage.push(...items))
  assert.deepEqual(damage, [])
  // 线性会话（rootMessageId 未定义）本来就返回新对象；再跑一次已是规范形态 → 引用不变
  const second = normalizeSession(out, (items) => damage.push(...items))
  assert.equal(second, out)
  assert.deepEqual(damage, [])
})

test('linear sessions still get parentId / selectedChildId after repair', () => {
  const input = session([userMessage('m1', null), assistantMessage('m2')])
  const { out } = run(input)
  assert.equal(out.rootMessageId, 'm1')
  assert.equal(out.messages[0].parentId, null)
  assert.equal(out.messages[0].selectedChildId, 'm2')
  assert.equal(out.messages[1].parentId, 'm1')
})

test('branch sessions keep their own selection while being repaired', () => {
  const input = {
    ...session([
      userMessage('m1', null),
      { ...assistantMessage('m2'), parentId: 'm1', selectedChildId: undefined },
    ]),
    rootMessageId: 'm1',
  }
  const { out, damage } = run(input)
  assert.equal(out.rootMessageId, 'm1')
  assert.deepEqual(out.messages[0].files, [])
  assert.equal(damage.length, 1)
})
