// [layer: regression | 依赖: 无（纯函数，无网络/无 IndexedDB） | Issue #49（关联 #32 / #50）]
//
// 回归对象：单会话转换的**降级粒度**——src/services/chat/history/toLocal.ts 的 toLocalSessionResult。
//
// 修复前症状（#49）：一个会话里只要有一条消息的 parent_id 断了、或者 current_message_id 指向
//   不存在的消息，整包导入就抛错，用户丢掉全部会话（"整包失败"）。
// 修复后预期：坏数据按粒度降级并**记录下来**，不抛错——
//   - 单条消息坏了 → 只丢这一条（scope: 'message'），会话照样导入；
//   - 当前分支指针坏了 → 回退到最深的一条链（scope: 'branch'），会话照样导入；
//   - 整个会话构造不出来 → 该会话标记 ok:false（scope: 'session'），由调用方跳过它继续导别的；
//   - 图片引用越界 / 同一路径指向不同文件 → ok:false backupInvalidFiles。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './errors.js') return { url: errorsStub, shortCircuit: true }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { toLocalSessionResult } = await import('../../src/services/chat/history/toLocal.ts')

const TIME = '2026-11-01T00:00:00.000Z'

const message = (id, parentId, role, extraFragments = []) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content: `内容 ${id}` }, ...extraFragments],
})

const imageFragment = (exportPath, id = 'file-1') => ({
  type: 'FILE',
  files: [
    {
      id,
      file_name: 'image.png',
      file_size: 10,
      token_usage: null,
      inserted_at: TIME,
      export_path: exportPath,
      is_image: true,
      width: 8,
      height: 8,
    },
  ],
})

const sessionFile = (overrides = {}) => ({
  id: 'session-1',
  title: '会话 1',
  pinned: false,
  current_message_id: 2,
  inserted_at: TIME,
  updated_at: TIME,
  messages: [message(1, null, 'USER'), message(2, 1, 'ASSISTANT')],
  ...overrides,
})

test('#49 正常会话照旧整条导入，没有跳过项', () => {
  const result = toLocalSessionResult(sessionFile())
  assert.equal(result.ok, true)
  assert.deepEqual(result.skipped, [])
  assert.equal(result.session.session.messages.length, 2)
})

test('#49 单条消息父链断裂时只丢这一条，会话仍然导入', () => {
  const result = toLocalSessionResult(
    sessionFile({ messages: [message(1, null, 'USER'), message(2, 1, 'ASSISTANT'), message(3, 99, 'USER')] })
  )
  assert.equal(result.ok, true, '一条坏消息不该让整个会话消失')
  assert.equal(result.session.session.messages.length, 2)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].scope, 'message')
  assert.equal(result.skipped[0].messageId, '3')
  assert.equal(result.skipped[0].parentId, '99')
  assert.equal(result.skipped[0].reason, 'backupInvalidBranches')
})

test('#49 重复 id 的第二条也按单条消息跳过（不是整会话失败）', () => {
  const result = toLocalSessionResult(
    sessionFile({ messages: [message(1, null, 'USER'), message(1, null, 'USER'), message(2, 1, 'ASSISTANT')] })
  )
  assert.equal(result.ok, true)
  assert.equal(result.session.session.messages.length, 2)
  assert.deepEqual(
    result.skipped.map((skip) => [skip.scope, skip.messageId]),
    [['message', '1']]
  )
})

test('#49 current_message_id 指向不存在的消息时回退到最深的链，会话不丢', () => {
  const result = toLocalSessionResult(sessionFile({ current_message_id: 99 }))
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.skipped.map((skip) => [skip.scope, skip.messageId, skip.reason]),
    [['branch', '99', 'backupInvalidBranches']]
  )
  assert.equal(result.session.session.rootMessageId, '1', '根节点要回到提问那条（本地消息 id 是字符串）')
})

test('#49 整个会话都构造不出来时返回 ok:false 并标明备份分支损坏', () => {
  const result = toLocalSessionResult(
    sessionFile({ messages: [message(1, null, 'ASSISTANT')], current_message_id: 1 })
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'backupInvalidBranches')
  assert.ok(
    result.skipped.some((skip) => skip.scope === 'session' && skip.reason === 'backupInvalidBranches'),
    '整会话级失败也要留下可定位的记录'
  )
})

test('#49 图片引用跑到别的会话目录时整会话标记 backupInvalidFiles', () => {
  const result = toLocalSessionResult(
    sessionFile({
      messages: [
        message(1, null, 'USER', [imageFragment('chat_sessions/other-session_files/file-1_image.png')]),
        message(2, 1, 'ASSISTANT'),
      ],
    })
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'backupInvalidFiles')
  assert.ok(result.skipped.some((skip) => skip.scope === 'session' && skip.reason === 'backupInvalidFiles'))
})

test('#49 合法图片引用被收集成 路径 → 文件 id 的映射', () => {
  const result = toLocalSessionResult(
    sessionFile({
      messages: [
        message(1, null, 'USER', [imageFragment('chat_sessions/session-1_files/file-1_image.png')]),
        message(2, 1, 'ASSISTANT'),
      ],
    })
  )
  assert.equal(result.ok, true)
  assert.deepEqual([...result.session.images.entries()], [
    ['chat_sessions/session-1_files/file-1_image.png', 'file-1'],
  ])
})
