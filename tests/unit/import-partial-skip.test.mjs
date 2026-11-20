// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <1s] 说明见 tests/README.md
// #49 导入容错：单条数据写入失败不得让整次导入失败 / 整包回滚，失败条目要收进 skipped[]
//   [1] 一条消息分支坏掉（父消息缺失）→ 只丢这条消息，会话其余消息照常导入，skipped 里能定位到消息 id
//   [2] 整个会话的消息都坏 → 该会话进 skipped，不抛错（旧行为：抛 backupInvalidBranches）
//   [3] replaceHistory 正常返回 skipped → 已写入的会话照常提交，skipped 记进 state.importSkipped
//   [4] replaceHistory 写入中途失败（已写入 2 条）→ 这 2 条仍在库里，不整包回滚，失败条目进 skipped
//
//   node tests/unit/import-partial-skip.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 假 db：IndexedDB 在裸 Node 里不存在，这里只替换存储边界，store.ts 的提交 / 回滚逻辑仍是真实代码。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const staging = new Set()
export const committed = []
export const calls = []
const summary = (id) => ({ id, title: '', createdAt: 1, updatedAt: 1 })
export const clearStaging = async () => {
  calls.push('clearStaging')
  staging.clear()
}
export const addStagingSession = async (session) => {
  calls.push('addStagingSession:' + session.id)
  staging.add(session.id)
}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => {
  calls.push('commitStaging')
  const moved = [...staging].map(summary)
  committed.push(...moved)
  staging.clear()
  return moved
}
export const reportStorageError = () => (error) => {
  void error
}
export const loadSessionSummaries = async () => []
export const loadSession = async () => undefined
export const loadFile = async () => undefined
export const saveSession = async () => {}
export const saveFiles = async () => {}
export const clearFiles = async () => {}
export const deleteSession = async () => {}
export const pinSession = async () => {}
export const renameSession = async () => {}
globalThis.__fakeDB = { staging, committed, calls, addStagingSession, commitStaging, clearStaging }
`)}`

// 只用 i18n 文案包装错误，不改变「硬失败」语义：旧代码正是靠它把整次导入打断的。
const failModule = `data:text/javascript,${encodeURIComponent(`
export class BackupError extends Error {
  constructor(key, params) {
    super(key)
    this.key = key
    this.params = params
    this.name = 'BackupError'
  }
}
export const fail = (key, params) => {
  throw new BackupError(key, params)
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const parent = String(context.parentURL ?? '')
      if (specifier === './errors.js' && parent.includes('/history/')) {
        return { url: failModule, shortCircuit: true }
      }
      if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
        return { url: fakeDB, shortCircuit: true }
      }
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

// 打包期 DefinePlugin 常量，裸 Node 里没有；store 模块顶层会用到
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= true

const toLocal = await import('../../src/services/chat/history/toLocal.ts')
const store = await import('../../src/services/chat/store.ts')
const db = globalThis.__fakeDB

const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: '2026-11-18T00:00:00Z',
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

/** 合法的两轮会话：1 ← 2 */
const sessionFile = (overrides = {}) => ({
  id: 'chat/ok',
  title: '正常会话',
  pinned: false,
  current_message_id: 2,
  inserted_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  messages: [message(1, null, 'USER', '你好'), message(2, 1, 'ASSISTANT', '你好呀')],
  ...overrides,
})

const resetDB = () => {
  db.staging.clear()
  db.committed.length = 0
  db.calls.length = 0
  store.useChatStore.setState({ importingHistory: false, ready: true, sessions: [] })
}

/** 一条坏消息的定位信息，三个用例共用 */
const brokenMessage = {
  scope: 'message',
  sessionId: 'chat/broken',
  sessionTitle: '坏会话',
  messageId: '3',
  parentId: '99',
  reason: 'backupInvalidBranches',
}

test('一条消息分支坏掉时，只丢这条消息，其余消息照常导入', () => {
  const file = sessionFile({
    id: 'chat/broken',
    title: '坏会话',
    current_message_id: 2,
    // 第 3 条挂在根本不存在的父消息 99 上
    messages: [
      message(1, null, 'USER', '你好'),
      message(2, 1, 'ASSISTANT', '你好呀'),
      message(3, 99, 'USER', '坏掉的一条'),
    ],
  })

  const result = toLocal.toLocalSessionResult
    ? toLocal.toLocalSessionResult(file)
    : { ok: true, session: toLocal.toLocalSession(file), skipped: [] }

  assert.equal(result.ok, true, '一条坏消息不应让整个会话导入失败')
  assert.deepEqual(
    result.session.session.messages.map((item) => item.id),
    ['1', '2'],
    '正常的两条消息必须保留'
  )
  assert.equal(result.session.session.rootMessageId, '1', '当前分支仍要回溯到根')
  assert.equal(result.skipped.length, 1, `skipped 应记录 1 条，实际：${JSON.stringify(result.skipped)}`)
  assert.equal(result.skipped[0].messageId, '3')
  assert.equal(result.skipped[0].parentId, '99')
  assert.equal(result.skipped[0].reason, 'backupInvalidBranches')
  assert.equal(result.skipped[0].sessionId, 'chat/broken')
})

test('整个会话都坏时，该会话进 skipped 而不是抛错', () => {
  const file = sessionFile({
    id: 'chat/broken',
    title: '坏会话',
    current_message_id: 1,
    // 根消息必须是用户提问；这里给的是助手消息，旧代码直接 fail
    messages: [message(1, null, 'ASSISTANT', '孤儿回答')],
  })

  let thrown
  let result
  try {
    result = toLocal.toLocalSessionResult
      ? toLocal.toLocalSessionResult(file)
      : { ok: true, session: toLocal.toLocalSession(file), skipped: [] }
  } catch (error) {
    thrown = error
  }

  assert.equal(thrown, undefined, `会话级坏数据不应抛错（应进 skipped）：${thrown?.message}`)
  assert.equal(result.ok, false, '整会话不可用时 ok 应为 false')
  assert.equal(result.skipped.at(-1).scope, 'session', `skipped 末尾应是会话级条目：${JSON.stringify(result.skipped)}`)
  assert.equal(result.skipped.at(-1).sessionId, 'chat/broken')
  assert.equal(result.skipped.at(-1).reason, 'backupInvalidBranches')
})

test('replaceHistory：写入返回 skipped 时照常提交，并把 skipped 记进 state', async () => {
  resetDB()
  const count = await store.replaceHistory(async () => {
    await db.addStagingSession({ id: 'chat/ok' })
    await db.addStagingSession({ id: 'chat/ok2' })
    return { skipped: [brokenMessage] }
  })

  assert.equal(count, 2, '两条写成功的会话都要提交')
  assert.deepEqual(
    db.committed.map((item) => item.id),
    ['chat/ok', 'chat/ok2'],
    '两条会话必须真的落库'
  )
  assert.equal(
    (store.useChatStore.getState().importSkipped ?? []).length,
    1,
    '失败条目要被 recorded 进 importSkipped 上报'
  )
})

test('replaceHistory：写入中途失败时，已写入的会话不整包回滚', async () => {
  resetDB()
  const PartialFailure =
    typeof store.PartialHistoryImportError === 'function'
      ? store.PartialHistoryImportError
      : // 旧代码没有这个类型：用同样的载荷让它走「整包回滚」，把旧行为暴露成断言失败
        class extends Error {
          constructor(skipped, staged) {
            super(`partial import: ${staged} staged, ${skipped.length} skipped`)
            this.skipped = skipped
            this.staged = staged
          }
        }
  const failure = new PartialFailure([brokenMessage], 2)

  let thrown
  let count
  try {
    count = await store.replaceHistory(async () => {
      await db.addStagingSession({ id: 'chat/ok' })
      await db.addStagingSession({ id: 'chat/ok2' })
      // 第三条写不进去
      throw failure
    })
  } catch (error) {
    thrown = error
  }

  assert.deepEqual(
    db.committed.map((item) => item.id),
    ['chat/ok', 'chat/ok2'],
    '已写入的两条会话必须留在库里（不整包回滚）'
  )
  assert.equal(
    thrown,
    undefined,
    `一条写失败不应让整次导入失败，实际抛出：${thrown?.message}`
  )
  assert.equal(count, 2, '已写入的两条会话要照常提交')
  assert.ok(
    !db.calls.includes('clearStaging') || db.calls.indexOf('clearStaging') < db.calls.indexOf('commitStaging'),
    `失败后不应再清掉暂存：${db.calls.join(' → ')}`
  )
  assert.equal(
    (store.useChatStore.getState().importSkipped ?? []).length,
    1,
    '失败条目要进 skipped 上报'
  )
})
