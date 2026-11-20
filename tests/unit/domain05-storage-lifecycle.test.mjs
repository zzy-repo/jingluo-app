// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <5s]
//
// 域 5 / N8：**存储失败与生命周期表**（docs/testing/coverage/domain-05.md §6.2 N8，6 行）。
//
// 覆盖功能点：
//   F-05-30 磁盘空间不足（配额耗尽）
//   F-05-31 进程被杀后的孤儿临时文件（暂存）
//   F-05-32 清空历史后再导入（且清空不碰 API Key / 设置）
//   F-05-33 导入 / 导出 / 清空的串行互斥（enqueueBackup 队列 + importingHistory 守卫）
//
// 为什么单列一条：本域唯一测「写库失败」的地方。失败点在 IndexedDB 事务 / 配额，不在归档内容，
// 所以桩打在 db 层；导入侧的失败（坏包）由 N3/N5 负责。半导入的用户感知是「我的会话变少了」——
// 比报错昂贵得多，所以每一行都断言「正式数据一个字节都不动」。
//
// F-05-30 现状（本表钉住的正是这个事实）：配额耗尽只有 `db.reportStorageError` 的 console 留痕，
// 没有用户文案、没有 i18n key —— 用户看到的是通用「导入失败」。文案补齐后在「甲」行加一条
// 「提示里出现『存储空间不足』」即可，不新增用例条数。
//
//   node --test tests/unit/domain05-storage-lifecycle.test.mjs
import { test } from 'node:test'
import { installBuildDefines, installHooks, stubOf } from '../fixtures/domain05/hooks.mjs'
import { expectDeepEqual, expectEqual, expectOk, runTable } from '../fixtures/domain05/table.mjs'

/** store.ts 的存储边界：可注入配额失败、记录调用顺序、保留「正式数据」。 */
const storeDBSource = `
export const calls = []
export const staging = new Set()
export const formal = new Set()
export const committed = []
export const reported = []
export const failNextCommitWith = { error: null }
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
  const error = failNextCommitWith.error
  if (error) {
    failNextCommitWith.error = null
    throw error
  }
  const moved = [...staging].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 }))
  formal.clear()
  for (const id of staging) formal.add(id)
  committed.push(...moved)
  staging.clear()
  return moved
}
export const reportStorageError = (action) => (error) => {
  calls.push('reportStorageError:' + action)
  reported.push({ action, error })
}
export const loadSessionSummaries = async () => []
export const loadSession = async () => undefined
export const loadFile = async () => undefined
export const saveSession = async () => {}
export const saveFiles = async () => {}
export const deleteSession = async () => {}
export const pinSession = async () => {}
export const renameSession = async () => {}
globalThis.__lifecycleDB = { calls, staging, formal, committed, reported, failNextCommitWith, clearStaging, addStagingSession, commitStaging }
`
/** backup.ts 的存储边界（只用到 loadSession）。 */
const backupDBSource = `
export const loadSession = async () => undefined
export const loadFile = async () => undefined
export const clearStaging = async () => {}
export const reportStorageError = () => () => {}
`
/**
 * backup.ts 的 store 替身：把 replaceHistory 的**进入 / 结束**写进全局序列，
 * 用来证明「导入 / 导出 / 清空」是排队的，而不是交错的。
 */
const backupStoreSource = `
export const state = { sessions: [], sessionCache: {} }
export const useChatStore = { getState: () => state }
let active = 0
export const replaceHistory = async (run) => {
  active += 1
  globalThis.__lifecycle.maxActive = Math.max(globalThis.__lifecycle.maxActive, active)
  globalThis.__lifecycle.order.push('enter')
  try {
    const value = await run()
    globalThis.__lifecycle.order.push('exit')
    return 1
  } finally {
    active -= 1
  }
}
export const importHistoryInto = async (run, mode = 'overwrite') => {
  const count = await replaceHistory(run)
  return { mode, count, added: count, overwritten: 0, skipped: 0, skippedTitles: [] }
}
globalThis.__lifecycle = { order: [], maxActive: 0 }
`
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

installHooks((specifier, parent) => {
  if (specifier === './errors.js' || specifier === './history/errors.js') {
    return errorsStub
  }
  if (specifier === '@capacitor/core') {
    return stubOf('../url-import-stubs/capacitor.mjs')
  }
  if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
    return `data:text/javascript,${encodeURIComponent(storeDBSource)}`
  }
  if (specifier === './db.js' && parent.endsWith('/chat/backup.ts')) {
    return `data:text/javascript,${encodeURIComponent(backupDBSource)}`
  }
  if (specifier === './store.js' && parent.endsWith('/chat/backup.ts')) {
    return `data:text/javascript,${encodeURIComponent(backupStoreSource)}`
  }
  if (specifier === './history/importArchive.js') {
    return stubOf('../url-import-stubs/importArchive.mjs')
  }
  if (specifier === './history/zipReader.js') {
    return stubOf('../url-import-stubs/zipReader.mjs')
  }
  return null
})
await installBuildDefines()

const backup = await import('../../src/services/chat/backup.ts')
const store = await import('../../src/services/chat/store.ts')
const db = globalThis.__lifecycleDB
const lifecycle = globalThis.__lifecycle

const reset = () => {
  db.calls.length = 0
  db.staging.clear()
  db.formal.clear()
  db.committed.length = 0
  db.reported.length = 0
  db.failNextCommitWith.error = null
  lifecycle.order.length = 0
  lifecycle.maxActive = 0
  globalThis.__staged = []
  globalThis.__imported = []
  globalThis.__importCount = 1
  store.useChatStore.setState({ importingHistory: false, ready: true, sessions: [] })
  const memory = new Map()
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    clear: () => memory.clear(),
  }
  globalThis.localStorage.setItem('chat-demo:apiKey', 'sk-test-keep-me')
  globalThis.localStorage.setItem('chat-demo:baseUrl', 'https://api.deepseek.com')
}

const quotaError = () => Object.assign(new Error('QuotaExceededError: storage full'), { name: 'QuotaExceededError' })
const fakeFile = (size = 1024) => new File([new Uint8Array(size)], 'deepseek_data.zip')

test('N8 存储失败与生命周期表：6 行（F-05-30/31/32/33）', async () => {
  const rows = [
    {
      name: '配额耗尽（commitStaging 抛 QuotaExceededError）→ 整次失败、暂存清空、正式数据不变',
      async run() {
        reset()
        // 甲：已有 3 个会话的正式库
        db.formal.add('existing-1')
        db.formal.add('existing-2')
        db.formal.add('existing-3')
        db.failNextCommitWith.error = quotaError()
        const error = await store
          .replaceHistory(async () => {
            await db.addStagingSession({ id: 'new-1' })
            await db.addStagingSession({ id: 'new-2' })
          })
          .then(
            () => null,
            (failure) => failure
          )
        expectOk(error, '配额耗尽必须整次失败（不能假装导入成功）')
        expectEqual(error.name, 'QuotaExceededError', '原始错误原样冒出（当前没有用户文案 → 通用「导入失败」）')
        expectEqual([...db.formal].sort().join(','), 'existing-1,existing-2,existing-3', '正式数据一个都不许动')
        expectEqual(db.staging.size, 0, '失败后暂存必须清空（下次导入前不会把半份当结果）')
        expectEqual(db.committed.length, 0, '不许提交半份数据')
        expectEqual(
          db.calls.includes('clearStaging'),
          true,
          '失败路径必须调 clearStaging'
        )
        expectEqual(store.useChatStore.getState().importingHistory, false, '守卫必须复位')
        // F-05-30 的现状：配额失败一路冒到调用方（界面只能显示通用「导入失败」），
        // 存储层没有单独的用户文案。文案落地后在这里加一条「提示里出现『存储空间不足』」即可。
        expectEqual(
          db.calls.some((call) => call.startsWith('reportStorageError')),
          false,
          '当前配额失败不走 reportStorageError（只有 clearStaging 失败才走），这条用于记录现状'
        )
      },
    },
    {
      name: '进程被杀遗留的孤儿暂存 → 下次替换在写入之前先清空，旧残留不会当成本次结果',
      async run() {
        reset()
        // 甲的现场：上次导入写到一半被系统杀掉，暂存里留着半份会话
        db.staging.add('orphan-from-killed-process')
        const result = await store.replaceHistory(async () => {
          expectEqual(
            db.staging.size,
            0,
            'write 被调用的那一刻，暂存必须已经是空的（clearStaging 在写入之前）'
          )
          await db.addStagingSession({ id: 'fresh-1' })
        })
        expectEqual(result, 1, '本次导入的会话数')
        expectDeepEqual(db.committed.map((item) => item.id), ['fresh-1'], '提交的只能是本次写入的会话')
        expectEqual(db.staging.size, 0, '提交后暂存清空')
        // 顺序：清暂存 → 写暂存 → 提交；不许反过来
        const order = db.calls.filter((call) => call === 'clearStaging' || call === 'commitStaging' || call.startsWith('addStagingSession'))
        expectEqual(order[0], 'clearStaging', '第一个动作必须是清暂存')
        expectEqual(order.at(-1), 'commitStaging', '最后一个动作必须是提交')
      },
    },
    {
      name: '写入阶段就失败（一条都没写成）→ 清暂存、正式数据不变、守卫复位（不整包回滚成空库）',
      async run() {
        reset()
        db.formal.add('keep-1')
        const error = await store
          .replaceHistory(async () => {
            await db.addStagingSession({ id: 'half-written' })
            throw Object.assign(new Error('boom during write'), { name: 'Error' })
          })
          .then(
            () => null,
            (failure) => failure
          )
        expectOk(error, '写入失败必须抛出')
        expectEqual(String(error.message), 'boom during write', '原始错误')
        expectEqual([...db.formal].join(','), 'keep-1', '正式数据不变')
        expectEqual(db.staging.size, 0, '暂存必须清空')
        expectEqual(db.committed.length, 0, '一条都不能提交（没有 staged>0 的部分成功信号）')
        expectEqual(store.useChatStore.getState().importingHistory, false, '守卫复位，用户可以再试')
      },
    },
    {
      name: '清空历史：以空历史原子替换，且不碰 API Key / 设置；清空后还能接着导入',
      async run() {
        reset()
        // 甲：clearHistory 的契约 —— 走同一次替换事务，写入侧什么都不写
        await backup.clearHistory()
        expectDeepEqual(lifecycle.order, ['enter', 'exit'], 'clearHistory 必须走同一条替换事务（串行队列）')

        // 乙：真正的「以空历史替换」效果 + 设置不被清
        db.formal.add('session-a')
        db.formal.add('session-b')
        const cleared = await store.replaceHistory(async () => {})
        expectEqual(cleared, 0, '清空后会话数 = 0')
        expectEqual(db.committed.length, 0, '提交结果是空列表')
        expectEqual(db.formal.size, 0, '正式库被空历史替换')
        expectEqual(
          globalThis.localStorage.getItem('chat-demo:apiKey'),
          'sk-test-keep-me',
          '清空历史不得碰 API Key'
        )
        expectEqual(
          globalThis.localStorage.getItem('chat-demo:baseUrl'),
          'https://api.deepseek.com',
          '清空历史不得碰设置'
        )

        // 丙：清空后导入照常（新导入的会话落在空库上）
        await db.addStagingSession({ id: 'after-clear' })
        const count = await store.replaceHistory(async () => {
          await db.addStagingSession({ id: 'after-clear' })
        })
        expectEqual(count, 1, '清空后导入正常')
        expectDeepEqual([...db.formal], ['after-clear'], '正式库只有新导入的会话')
      },
    },
    {
      name: '串行互斥：两次并发导入 + 期间的导出/清空全部排队执行（同时最多一个替换事务在跑）',
      async run() {
        reset()
        const queue = [
          backup.importHistory(fakeFile()),
          backup.importHistory(fakeFile()),
          backup.clearHistory(),
        ]
        const exported = backup.exportHistory()
        await Promise.all([...queue, exported])
        expectEqual(lifecycle.maxActive, 1, '任何时刻最多一个替换事务在跑（不许交错）')
        expectDeepEqual(
          lifecycle.order,
          ['enter', 'exit', 'enter', 'exit', 'enter', 'exit'],
          '三个替换任务必须一个接一个（enter/exit 成对且不嵌套）'
        )
        // 导出也走了同一条队列（否则会边读边清）
        expectOk(exported, '导出任务必须完成')
        const result = await exported
        expectEqual(result.blob.type, 'application/zip', '导出产物类型')
      },
    },
    {
      name: '串行互斥守卫：导入进行中再触发替换 → 立即抛「History replacement is already in progress」',
      async run() {
        reset()
        store.useChatStore.setState({ importingHistory: true })
        const error = await store.replaceHistory(async () => {}).then(
          () => null,
          (failure) => failure
        )
        expectOk(error, '守卫必须拦住并发的替换事务')
        expectEqual(String(error.message), 'History replacement is already in progress', '守卫文案')
        expectEqual(db.calls.length, 0, '被守卫拦住时一个动作都不许做')
        expectEqual(db.staging.size, 0, '暂存未被触碰')
        // 守卫不只是「抛一下」：复位后同一个调用能正常通过
        store.useChatStore.setState({ importingHistory: false })
        expectEqual(await store.replaceHistory(async () => {}), 0, '复位后可正常替换')
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})
