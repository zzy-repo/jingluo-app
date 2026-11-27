// [layer: unit | 依赖: 无（纯 Node；存储层与保护层打桩，零浏览器 / 零网络） | 耗时: <2s]
//
// Issue #937（P1）：**会话没进 `sessionCache` 时，侧边栏「置顶 / 改名」写库失败完全静默**。
//
// 现场（#910 满盘验收，`f_bavail = 0`）：点「More → Pin chat」后
//   E/Capacitor/Console: [storage] pin session failed [object DOMException]
//   E/chromium: IndexedDB Write Error: SET_UP_METADATA
// 而界面照样把会话移进「Pinned chats」、四条横幅全空（`{"bannerLow":false,...,"alerts":[]}`）。
//
// 根因：这两条路径走的是
//   `void withStorage(...).catch(reportStorageError('pin session'))`
// **不经过 `persist()`** —— 既不 `markSaveFailure()`（不进 `sessionSaveErrors`，横幅不出现），
// 也不跑 `protectionCheckFreeSpace()`（`lowSpace` 不更新）。两条保护链同时失效。
//
// 本文件钉住修完之后的行为（断言都打在**真** `src/services/chat/store.ts` 的状态上）：
//   M1 置顶写失败（满盘类）→ 进 `sessionSaveErrors`，kind = quota，诊断留痕，**界面回滚**
//   M2 置顶写失败（非空间类）→ 同样进失败上报（kind = unknown → 可重试档）
//   M3 改名写失败（会话未缓存）→ 标题回滚 + 进失败上报
//   M4 写成功 → 不产生失败态（防「一律报失败」的假修复），重试成功后失败态被清掉
//   M5 横幅「重试」会**重放**这次置顶写入（不是空点击）
//   M6 回滚只回滚「还是本次写的那个值」，用户随后又点了一次时不抹掉新值
//
// 负向对照：把 `pinSession` 改回 `void withStorage(...).catch(reportStorageError(...))` →
// M1/M2/M3/M5 全红（`sessionSaveErrors` 空、界面停在「已置顶」）。
//
//   node tests/run-layer.mjs unit --only storage-metadata-write-937
//   node --test tests/unit/storage-metadata-write-937.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  callsOf,
  fullDiskDomException,
  loadStoreEnv,
  logRecords,
  settle,
  summaryOf,
} from '../helpers/store-storage-env.mjs'

const { chat, reset } = await loadStoreEnv()

const state = () => chat.useChatStore.getState()
const summaryById = (id) => state().sessions.find((item) => item.id === id)

test('M #937 侧边栏置顶 / 改名（会话未缓存）写库失败必须进统一失败上报，且界面不得显示成功', async (t) => {
  await t.test('M1 置顶失败（满盘类 DOMException）→ sessionSaveErrors + 诊断 + 回滚', async () => {
    reset(
      { sessions: [summaryOf('m1', { updatedAt: 5 })] },
      { pinSession: async () => { throw fullDiskDomException() } }
    )
    chat.pinSession('m1')
    // 乐观更新先落到界面（现有模式：先改内存再写库）
    assert.equal(typeof summaryById('m1').pinnedAt, 'number', '点击后应立刻显示「已置顶」')

    await settle()

    assert.equal(summaryById('m1').pinnedAt, undefined, '写库失败必须回滚置顶，界面不许停在「已置顶」')
    const failure = state().sessionSaveErrors.m1
    assert.ok(failure, '失败必须进 sessionSaveErrors（否则横幅不出现，用户零提示）')
    assert.equal(failure.kind, 'quota', '满盘是空间类，必须判 quota（不是可重试）')
    assert.ok(
      logRecords().some((entry) => entry.message === 'storage.saveFailure: quota @ pin session'),
      '失败必须留一条 error 级诊断（重启后还能查）'
    )
  })

  await t.test('M2 置顶失败（非空间类）→ 同样进失败上报（kind = unknown，可重试档）', async () => {
    reset(
      { sessions: [summaryOf('m2', { updatedAt: 5 })] },
      { pinSession: async () => { throw new Error('boom') } }
    )
    chat.pinSession('m2')
    await settle()
    assert.equal(summaryById('m2').pinnedAt, undefined, '非空间类失败同样回滚')
    assert.equal(state().sessionSaveErrors.m2?.kind, 'unknown', '未分类的失败按可重试档上报，不是静默')
  })

  await t.test('M3 改名失败（会话未缓存）→ 标题回滚 + 进失败上报', async () => {
    reset(
      { sessions: [summaryOf('m3')] },
      { renameSession: async () => { throw fullDiskDomException() } }
    )
    chat.renameSession('m3', '新标题')
    assert.equal(summaryById('m3').title, '新标题', '点击后应立刻显示新标题')
    await settle()
    assert.equal(summaryById('m3').title, '标题-m3', '写库失败必须回滚标题')
    assert.equal(state().sessionSaveErrors.m3?.kind, 'quota')
    assert.ok(logRecords().some((entry) => entry.message === 'storage.saveFailure: quota @ rename session'))
  })

  await t.test('M4 写成功：不产生失败态；重试成功后旧的失败态被清掉', async () => {
    reset({ sessions: [summaryOf('m4')] })
    chat.pinSession('m4')
    await settle()
    assert.equal(state().sessionSaveErrors.m4, undefined, '成功不许报失败（否则横幅永远挂着）')
    assert.equal(typeof summaryById('m4').pinnedAt, 'number')

    // 再来一次失败 → 有失败态；腾出空间后点重试 → 失败态消失
    reset(
      { sessions: [summaryOf('m4b')] },
      { pinSession: async () => { throw fullDiskDomException() } }
    )
    chat.pinSession('m4b')
    await settle()
    assert.ok(state().sessionSaveErrors.m4b, '失败态在')
    globalThis.__db.pinSession = async () => {}
    chat.retrySaveSessions()
    await settle()
    assert.equal(state().sessionSaveErrors.m4b, undefined, '重试成功后必须清掉失败态')
    assert.equal(typeof summaryById('m4b').pinnedAt, 'number', '重试成功要把置顶真正写进界面')
  })

  await t.test('M5 横幅「重试」会重放未缓存会话的置顶写入（不是空点击）', async () => {
    reset(
      { sessions: [summaryOf('m5', { updatedAt: 5 })] },
      { pinSession: async () => { throw fullDiskDomException() } }
    )
    chat.pinSession('m5')
    await settle()
    assert.equal(callsOf('pinSession').length, 1)

    // 用户清理空间后点「重试」：这次真的再写一次，而不是把 unsavedSessions 空转一遍
    globalThis.__db.pinSession = async () => {}
    chat.retrySaveSessions()
    await settle()
    const calls = callsOf('pinSession')
    assert.equal(calls.length, 2, '重试必须再发一次置顶写入')
    assert.deepEqual(calls[1].args, ['m5', calls[0].args[1]], '重放的是同一个 pinnedAt（用户意图不许变）')
    assert.equal(typeof summaryById('m5').pinnedAt, 'number', '重试成功后界面重新显示已置顶')
  })

  await t.test('M6 回滚只回滚「还是本次写的那个值」：期间用户又点了一次就不许抹掉', async () => {
    const db = globalThis.__db
    reset({ sessions: [summaryOf('m6', { updatedAt: 5 })] }, {
      pinSession: async () => {
        // 第一次失败期间，用户又点了一次（把 pinnedAt 改成了别的值）
        throw fullDiskDomException()
      },
    })
    chat.pinSession('m6')
    const first = callsOf('pinSession')[0].args[1]
    // 模拟「另一个写入已经把界面改成新值」：直接把状态改掉，再让第一次的失败回滚
    chat.useChatStore.setState((current) => ({
      sessions: current.sessions.map((item) => (item.id === 'm6' ? { ...item, pinnedAt: first + 1 } : item)),
    }))
    await settle()
    assert.equal(summaryById('m6').pinnedAt, first + 1, '别人后来写的值不许被这次失败的回滚抹掉')
    assert.ok(db.errors.some((entry) => entry.action === 'pin session'), '失败仍要上报（回滚与否不是「是否报错」的条件）')
  })
})
