// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <2s] Issue #390
//
// 增量导入（#390 第二半）：三种模式都复现「同一套解析 + 暂存」，只有**提交**这一步分叉。
//
//   [1] 冲突口径（纯函数表）：同一 sessionId 才视为同一会话；不同 id 即使标题相同也是两条；
//       merge 按 updated_at 取舍，skip 一律保留本地
//   [2] store.importHistoryInto(merge/skip)：调 mergeStaging（不是 commitStaging）、本地会话不清空、
//       当前会话不被踢走、结果摘要（新增 / 覆盖 / 跳过 + 被跳过的标题）带回调用方与 state
//   [3] store.importHistoryInto(overwrite)：仍然走整包替换（原有行为不回退）
//   [4] 向后兼容：旧版导出包（缺可选字段、没有 user.json、没有图片）走**真实 importArchive** 仍能导入，
//       且导入出来的会话能被合并口径正常判定
//
//   node tests/unit/import-merge-390.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

/** 假 db：只实现 store 提交路径需要的那几个函数；索引层（IndexedDB）在裸 Node 里不存在。 */
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const calls = []
export const stagingSessions = []
export const stagingFiles = new Map()
export const liveSummaries = []
export let mergeResult = { added: 0, overwritten: 0, skipped: 0, skippedTitles: [], written: [] }
export const setMergeResult = (next) => {
  mergeResult = next
}
export const clearStaging = async () => {
  calls.push('clearStaging')
  stagingSessions.length = 0
  stagingFiles.clear()
}
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async (files) => {
  for (const file of files) stagingFiles.set(file.id, file.blob)
}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => {
  calls.push('commitStaging')
  return liveSummaries.slice()
}
export const mergeStaging = async (policy) => {
  calls.push('mergeStaging:' + policy)
  return mergeResult
}
export const loadSessionSummaries = async () => liveSummaries.slice()
export const loadSession = async () => undefined
export const loadFile = async () => undefined
export const saveSession = async () => {}
export const saveFiles = async () => {}
export const deleteSession = async () => {}
export const pinSession = async () => {}
export const renameSession = async () => {}
export const reportStorageError = () => () => {}
globalThis.__mergeDB = { calls, stagingSessions, stagingFiles, liveSummaries, setMergeResult }
`)}`

/** importArchive 的暂存边界（#4 用真实解析链路，只换掉存储） */
const archiveStagingDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const stagingFiles = new Map()
export const stagingFileTypes = new Map()
export const clearStaging = async () => {
  stagingSessions.length = 0
  stagingFiles.clear()
  stagingFileTypes.clear()
}
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async (files) => {
  for (const file of files) stagingFiles.set(file.id, file.blob)
}
export const updateStagingFileTypes = async (types) => {
  for (const [id, type] of types) stagingFileTypes.set(id, type)
}
export const loadFile = async () => undefined
export const loadSession = async () => undefined
export const saveSession = async () => {}
globalThis.__archiveStaging = { stagingSessions, stagingFiles, stagingFileTypes, clearStaging }
`)}`

const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

const { installBuildDefines } = await import('../fixtures/domain05/hooks.mjs')
const { installTsResolve } = await import('../helpers/dom-env.mjs')
installTsResolve({
  stubs: [
    ['./errors.js', errorsStub],
    ['./history/errors.js', errorsStub],
  ],
  onResolve: (specifier, context) => {
    const parent = String(context.parentURL ?? '')
    // store.ts 写的是 `./db.js`，history 层写的是 `../db.js`：两边换成不同的假存储
    if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
      return fakeDB
    }
    if (specifier === '../db.js' && parent.endsWith('/history/importArchive.ts')) {
      return archiveStagingDB
    }
    return undefined
  },
})
// store / 诊断链路顶层会读打包期常量（DefinePlugin 在裸 Node 里没有）：
// `__ENDPOINTS__` 走公共兜底（与 tests/helpers/injected.mjs 同一份来源），另两个按用例自己设。
await installBuildDefines()
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= true

const { planMerge, resolveConflict } = await import('../../src/services/chat/history/mergeSessions.ts')
const { importHistoryInto, useChatStore } = await import('../../src/services/chat/store.ts')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const db = globalThis.__mergeDB
const archiveStaging = globalThis.__archiveStaging

const ref = (id, title, updatedAt) => ({ id, title, updatedAt })
const lookup = (entries) => {
  const map = new Map(entries.map((entry) => [entry.id, entry.updatedAt]))
  return (id) => map.get(id)
}

// ───────────────────────── [1] 冲突口径 ─────────────────────────

test('冲突口径：同一 sessionId 才是同一会话，merge 按更新时间取舍', () => {
  const incomingNewer = ref('s-1', '甲', 200)
  const incomingOlder = ref('s-1', '甲', 100)
  assert.equal(resolveConflict(undefined, incomingNewer, 'merge'), 'added', '本地没有 → 新增')
  assert.equal(resolveConflict(100, incomingNewer, 'merge'), 'overwritten', '包内更新 → 覆盖')
  assert.equal(resolveConflict(300, incomingOlder, 'merge'), 'skipped', '本地更新 → 保留本地（跳过）')
  assert.equal(
    resolveConflict(100, ref('s-1', '甲', 100), 'merge'),
    'overwritten',
    '时间戳相同按包内版本写入：刚导出就导回来不会因为毫秒相同被丢掉'
  )
  assert.equal(resolveConflict(100, incomingNewer, 'skip'), 'skipped', 'skip 模式不比较时间，本地有就跳过')
})

test('冲突口径：不同 id 即使标题相同也是两条会话（不按标题合并）', () => {
  const plan = planMerge(
    [ref('a-1', '同名会话', 200), ref('a-2', '同名会话', 200)],
    lookup([ref('a-1', '同名会话', 100)]),
    'merge'
  )
  assert.deepEqual(
    { added: plan.added, overwritten: plan.overwritten, skipped: plan.skipped },
    { added: 1, overwritten: 1, skipped: 0 },
    'a-1 命中同 id（覆盖），a-2 只是标题相同 → 必须当成新会话新增'
  )
  assert.deepEqual(plan.written.sort(), ['a-1', 'a-2'])
  assert.deepEqual(plan.skippedTitles, [])
})

test('冲突口径：skip 模式与「本地更新」都只跳过、不进 written，跳过的标题带进明细', () => {
  const incoming = [ref('s-1', '本地更新', 100), ref('s-2', '本地也有', 100), ref('s-3', '本地没有', 100)]
  const skipPlan = planMerge(incoming, lookup([ref('s-1', '本地更新', 300), ref('s-2', '本地也有', 50)]), 'skip')
  assert.deepEqual(
    { added: skipPlan.added, overwritten: skipPlan.overwritten, skipped: skipPlan.skipped },
    { added: 1, overwritten: 0, skipped: 2 },
    'skip 模式：本地已有的一律跳过，只新增本地没有的'
  )
  assert.deepEqual(skipPlan.written, ['s-3'])
  const mergePlan = planMerge(incoming, lookup([ref('s-1', '本地更新', 300), ref('s-2', '本地也有', 50)]), 'merge')
  assert.deepEqual(
    { added: mergePlan.added, overwritten: mergePlan.overwritten, skipped: mergePlan.skipped },
    { added: 1, overwritten: 1, skipped: 1 },
    'merge 模式：s-1 本地更新被跳过，s-2 包内更新被覆盖，s-3 新增'
  )
  assert.deepEqual(mergePlan.skippedTitles, ['本地更新'], '被跳过的会话标题要能列给用户看')
})

// ───────────────────────── [2]/[3] store 接线 ─────────────────────────

/** 每次用例前把 store 与假 db 复位 */
const reset = () => {
  db.calls.length = 0
  db.stagingSessions.length = 0
  db.liveSummaries.length = 0
  db.setMergeResult({ added: 0, overwritten: 0, skipped: 0, skippedTitles: [], written: [] })
  useChatStore.setState({
    ready: true,
    sessions: [],
    sessionCache: {},
    activeId: null,
    importSkipped: [],
    importSummary: null,
  })
}

test('merge 模式：调 mergeStaging（不清空本地），摘要与 state 都带上新增/覆盖/跳过', async () => {
  reset()
  useChatStore.setState({
    sessions: [{ id: 'local-1', title: '本地原有', createdAt: 1, updatedAt: 1 }],
    activeId: 'local-1',
  })
  const live = [
    { id: 'local-1', title: '本地原有', createdAt: 1, updatedAt: 1 },
    { id: 'new-1', title: '新增的', createdAt: 2, updatedAt: 2 },
  ]
  db.liveSummaries.push(...live)
  db.setMergeResult({
    added: 1,
    overwritten: 1,
    skipped: 1,
    skippedTitles: ['本地更新'],
    written: ['new-1', 'local-1'],
  })

  const summary = await importHistoryInto(async () => ({ skipped: [] }), 'merge')

  assert.ok(db.calls.includes('mergeStaging:merge'), `增量导入必须走 mergeStaging：${db.calls.join(' → ')}`)
  assert.ok(!db.calls.includes('commitStaging'), '增量导入不能用整包替换的 commitStaging')
  assert.deepEqual(
    db.calls,
    ['clearStaging', 'mergeStaging:merge'],
    '增量导入的顺序：清暂存 → 合并（本地数据不在这个序列里被清空）'
  )
  assert.equal(summary.mode, 'merge')
  assert.equal(summary.count, 2, 'count = 新增 + 覆盖（跳过的不算进去）')
  assert.deepEqual(
    { added: summary.added, overwritten: summary.overwritten, skipped: summary.skipped },
    { added: 1, overwritten: 1, skipped: 1 }
  )
  assert.deepEqual(summary.skippedTitles, ['本地更新'], '跳过明细要带回调用方')
  assert.deepEqual(
    useChatStore.getState().sessions.map((item) => item.id).sort(),
    ['local-1', 'new-1'],
    '合并后的列表 = 本地原有 + 新增，一条都不能少（列表按更新时间排序，这里只比集合）'
  )
  assert.equal(useChatStore.getState().activeId, 'local-1', '当前打开的会话本地还在，不能被踢走')
  assert.deepEqual(useChatStore.getState().importSummary, summary, '摘要要进 state，供「导入详情」展示')
})

test('skip 模式：透传 skip 策略，全部冲突时 count 为 0 但本地会话原样保留', async () => {
  reset()
  useChatStore.setState({
    sessions: [{ id: 'local-1', title: '本地原有', createdAt: 1, updatedAt: 1 }],
    activeId: 'local-1',
  })
  db.liveSummaries.push({ id: 'local-1', title: '本地原有', createdAt: 1, updatedAt: 1 })
  db.setMergeResult({ added: 0, overwritten: 0, skipped: 1, skippedTitles: ['本地原有'], written: [] })

  const summary = await importHistoryInto(async () => ({}), 'skip')

  assert.ok(db.calls.includes('mergeStaging:skip'), `skip 模式必须把策略透传给 db：${db.calls.join(' → ')}`)
  assert.equal(summary.count, 0, '全部被跳过时写入条数为 0')
  assert.equal(summary.skipped, 1)
  assert.deepEqual(
    useChatStore.getState().sessions.map((item) => item.id),
    ['local-1'],
    '跳过不能把本地会话弄丢'
  )
})

test('overwrite 模式：仍然走整包替换，行为与改动前一致', async () => {
  reset()
  db.liveSummaries.push({ id: 'from-archive', title: '包里的', createdAt: 3, updatedAt: 3 })

  const summary = await importHistoryInto(async () => ({}), 'overwrite')

  assert.ok(db.calls.includes('commitStaging'), `整包覆盖必须仍走 commitStaging：${db.calls.join(' → ')}`)
  assert.ok(!db.calls.some((call) => call.startsWith('mergeStaging')), '整包覆盖不经过冲突判定')
  assert.equal(summary.mode, 'overwrite')
  assert.equal(summary.count, 1, '整包覆盖的 count 就是包内会话数')
  assert.equal(summary.skipped, 0, '整包覆盖没有冲突跳过')
  assert.equal(useChatStore.getState().activeId, null, '整包替换后回到新对话（原有行为）')
})

// ───────────────────────── [4] 旧版包向后兼容 ─────────────────────────

const TIME = '2026-11-01T00:00:00.000Z'

const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

/**
 * 旧版导出包：**没有** `pinned` 字段、`title` 为 null、没有 `user.json`、没有任何图片条目，
 * index 里的条目也不带 `pinned` —— 模拟「没有 sessionId 之外那些新字段」的包。
 * 路径与顺序仍按 format.ts（manifest → 会话 → index），这是导出格式里唯一没有版本化的部分。
 */
const legacyArchive = ({ id = 'legacy-1', title = null } = {}) => {
  const entries = {
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    [`chat_sessions/${id}.json`]: strToU8(
      JSON.stringify({
        id,
        title,
        current_message_id: 2,
        inserted_at: TIME,
        updated_at: TIME,
        messages: [message(1, null, 'USER', '旧包的问题'), message(2, 1, 'ASSISTANT', '旧包的回答')],
      })
    ),
    'chat_session_index.json': strToU8(
      JSON.stringify([
        { id, title, message_count: 2, inserted_at: TIME, updated_at: TIME },
      ])
    ),
  }
  return new File([zipSync(entries)], 'legacy.zip', { type: 'application/zip' })
}

test('向后兼容：缺可选字段的旧版包仍能导入，导入结果能被合并口径正常判定', async () => {
  await archiveStaging.clearStaging()
  await importArchive(legacyArchive())
  const staged = archiveStaging.stagingSessions
  assert.equal(staged.length, 1, `旧版包必须仍能导入 1 条会话，实际 ${staged.length} 条`)
  assert.equal(staged[0].id, 'legacy-1', '会话 id 来自会话文件本身（旧包也是唯一可靠的身份来源）')
  assert.equal(staged[0].title, '', 'title 为 null 时按空标题落地，不抛错')
  assert.equal(staged[0].updatedAt, Date.parse(TIME), 'updated_at 可用于合并取舍')

  // 本地已有同 id、且比包内更新 → 旧包里的这条被跳过（不是覆盖掉本地的新内容）
  const incoming = [{ id: staged[0].id, title: staged[0].title, updatedAt: staged[0].updatedAt }]
  const skipped = planMerge(incoming, () => Date.parse(TIME) + 60_000, 'merge')
  assert.deepEqual({ added: skipped.added, overwritten: skipped.overwritten, skipped: skipped.skipped }, {
    added: 0,
    overwritten: 0,
    skipped: 1,
  })
  // 本地没有这条 → 正常新增
  const added = planMerge(incoming, () => undefined, 'merge')
  assert.deepEqual({ added: added.added, overwritten: added.overwritten, skipped: added.skipped }, {
    added: 1,
    overwritten: 0,
    skipped: 0,
  })
})
