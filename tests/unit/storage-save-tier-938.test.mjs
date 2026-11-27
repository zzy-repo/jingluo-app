// [layer: unit | 依赖: 无（纯 Node；存储层与保护层打桩，零浏览器 / 零网络） | 耗时: <2s]
//
// Issue #938（P2）：**满盘保存失败被判成「可重试」档**，`quota` 档从未出现。
//
// 现场（#910 满盘验收）：满盘时对已缓存会话改名（走 `persist()`），横幅是
//   ["This chat didn't save to this device. Tap retry.Retry"]
// 而底层是空间类错误：
//   IndexedDB Write Error: SET_UP_METADATA
//   DOMException: Encountered full disk while opening backing store for indexedDB.open.
// 用户被引导去点一个必然再失败的「Retry」。
//
// 两条根因（都在「错误 → 档位」这段路上）：
//   ① `classifyStorageFailure()` **只看 `error.name`**：磁盘写满时 Chromium 报的是
//      `UnknownError`（它的文案才是「full disk」），于是落到 `unavailable`/`unknown`；
//   ② `chat/store.ts` 的 `failureOfThrown()` 把 kind **写死成 `'unknown'`** —— 满盘时最常走的
//      正是「库都打不开」这条抛出路径（`withStorage()` 之前就抛），写死 = 永远「可重试」。
//
// 本文件钉住：
//   T1 满盘的各种真实形态 → `quota`（名字 / 文案两条线索都要认）
//   T2 回归：与空间无关的 `UnknownError` 仍然是 `unavailable`（别把 WebKit 那条老口径带坏）
//   T3 档位与文案：`quota` 档必须给「清理空间 / 导出备份」那句话，且仍给重试按钮
//   T4 store：满盘 `persist()` 失败 → `sessionSaveErrors.kind = quota`，横幅档位是 `quota`
//   T5 store：失败后**立刻**重读空间（`protectionRefreshFreeSpace`），`lowSpace` 跟着更新
//   T6 非空间类失败：不把 `lowSpace` 抬起来（刷新值说了算）
//   T7 原生桥已判成 `quota` 的错误（`InfraError.kind`，#949 之后才透传上来）→ `quota`，不靠文案猜
//
// 负向对照：把 `classifyStorageFailure()` 的文案兜底删掉 → T1 红；把 `failureOfThrown()`
// 的 kind 改回写死 `'unknown'` → T4 红；删掉 `refreshLowSpace()` → T5 红。
//
//   node tests/run-layer.mjs unit --only storage-save-tier-938
//   node --test tests/unit/storage-save-tier-938.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTsModule } from '../helpers/dom-env.mjs'
import {
  fullDiskDomException,
  loadStoreEnv,
  noSpaceLeftError,
  protectionCalls,
  settle,
  sessionOf,
  summaryOf,
} from '../helpers/store-storage-env.mjs'

const { chat, db, reset } = await loadStoreEnv()
const state = () => chat.useChatStore.getState()

const namedError = (name, message) => Object.assign(new Error(message), { name })

test('T #938 满盘写失败必须落到 quota 档（不是「可重试」），且失败后立刻刷新空间读数', async (t) => {
  await t.test('T1 满盘的真实形态 → quota（Chromium 的 UnknownError 也认）', () => {
    assert.equal(
      db.classifyStorageFailure(fullDiskDomException()),
      'quota',
      'Chromium 把「磁盘写满」报成 UnknownError，名字不可信，文案才是证据'
    )
    assert.equal(db.classifyStorageFailure(noSpaceLeftError()), 'quota', 'errno 原样带出的 ENOSPC 也是空间类')
    assert.equal(db.classifyStorageFailure(namedError('Error', 'database or disk is full')), 'quota')
    assert.equal(db.classifyStorageFailure(namedError('Error', 'SQLITE_FULL: no space left')), 'quota')
    assert.equal(db.classifyStorageFailure(namedError('Error', 'There is not enough space on the disk')), 'quota')
    // 名字里带 QuotaExceededError 但 name 不是它 → 仍不许当配额（原有口径不许被文案兜底带坏）
    assert.equal(db.classifyStorageFailure(new Error('QuotaExceededError')), 'unknown')
  })

  await t.test('T2 回归：与空间无关的 UnknownError 仍是 unavailable（WebKit 写 blob 那条老口径）', () => {
    assert.equal(db.classifyStorageFailure(namedError('UnknownError', 'An unknown error occurred')), 'unavailable')
    assert.equal(db.classifyStorageFailure(namedError('NotSupportedError', 'nope')), 'unavailable')
    assert.equal(db.classifyStorageFailure(namedError('DataCloneError', 'could not be cloned')), 'clone')
    assert.equal(db.classifyStorageFailure(namedError('QuotaExceededError', 'x')), 'quota')
  })

  await t.test('T3 档位与文案：quota 档说「清理空间 / 导出备份」，不是「点重试」', async () => {
    const errors = { a: { kind: 'quota' } }
    assert.equal(db.selectSaveBannerTier(errors), 'quota')
    assert.equal(db.selectSaveBannerDisplay(errors, true), 'quota', '真实失败优先于空间预警')
    assert.equal(db.bannerMessageKey('quota'), 'sessionSaveFailedQuota')
    assert.equal(db.bannerRetryable('quota'), true, '腾出空间后重试是有意义的，quota 档保留重试按钮')
    const { zh } = await loadTsModule('src/i18n/zh.ts')
    assert.match(zh.sessionSaveFailedQuota, /空间不足/u)
    assert.doesNotMatch(zh.sessionSaveFailedQuota, /^这段对话没存到本机/u, '不许复用「可重试」那句话')
  })

  await t.test('T4 store：满盘时 persist() 失败 → kind = quota，横幅档位 quota（不是 retry）', async () => {
    reset(
      { sessions: [summaryOf('t4')], cache: { t4: sessionOf('t4') } },
      { saveSession: async () => { throw fullDiskDomException() } }
    )
    const ok = await chat.saveSessionPrompt('t4', '新的系统提示')
    assert.equal(ok, false, '保存失败必须返回 false（上层据此回滚）')
    const failure = state().sessionSaveErrors.t4
    assert.ok(failure, '失败必须进 sessionSaveErrors')
    assert.equal(failure.kind, 'quota', '满盘走过的抛出路径不许再写死成 unknown')
    const tier = db.selectSaveBannerDisplay(state().sessionSaveErrors, state().lowSpace)
    assert.equal(tier, 'quota', '横幅必须是空间档；判成 retry 就是在骗用户点一个必然失败的按钮')
  })

  await t.test('T5 store：失败后立刻刷新空间读数（绕开 10s 缓存），lowSpace 跟着更新', async () => {
    reset(
      { sessions: [summaryOf('t5')], cache: { t5: sessionOf('t5') } },
      { saveSession: async () => { throw fullDiskDomException() } }
    )
    // 保存前那次读（缓存档）说「还够」，失败之后重读才发现「已经满了」
    globalThis.__protection.free = { status: 'ok', freeBytes: 512 * 1024 * 1024 }
    globalThis.__protection.refresh = { status: 'low', freeBytes: 0 }

    await chat.saveSessionPrompt('t5', '改个系统提示')
    await settle()

    assert.ok(
      protectionCalls().includes('refreshFreeSpace'),
      '失败后必须立刻重读空间，不能等 10s 缓存过期（那 10s 里横幅还停在 ok）'
    )
    assert.equal(state().lowSpace, true, 'lowSpace 必须跟着刷新值更新')
  })

  await t.test('T6 非空间类失败：不把 lowSpace 抬起来（刷新值说了算）', async () => {
    reset(
      { sessions: [summaryOf('t6')], cache: { t6: sessionOf('t6') } },
      { saveSession: async () => { throw namedError('DataCloneError', 'could not be cloned') } }
    )
    globalThis.__protection.refresh = { status: 'ok', freeBytes: 900 * 1024 * 1024 }
    await chat.saveSessionPrompt('t6', 'x')
    await settle()
    assert.equal(state().sessionSaveErrors.t6?.kind, 'clone')
    assert.equal(state().lowSpace, false, '空间够的时候不许凭空挂空间横幅')
  })

  await t.test('T7 原生桥已判成 quota 的错误（#949 之后能透传）→ quota，不靠文案猜', async () => {
    const { InfraError } = await loadTsModule('src/services/capability/errors.ts')
    // 文案里一个「满盘」字样都没有：唯一的证据是基础设施层判好的 kind
    assert.equal(db.classifyStorageFailure(new InfraError('quota', '打不开本机数据库')), 'quota')
    // 只认 quota：unavailable 仍旧走 name 分支（那一档不给重试按钮，不许在这里顺手放宽）
    assert.equal(db.classifyStorageFailure(new InfraError('unavailable', '宿主不支持')), 'unknown')

    reset(
      { sessions: [summaryOf('t7')], cache: { t7: sessionOf('t7') } },
      { saveSession: async () => { throw new InfraError('quota', '写不进去') } }
    )
    globalThis.__protection.refresh = { status: 'ok', freeBytes: 900 * 1024 * 1024 }
    await chat.saveSessionPrompt('t7', 'x')
    await settle()
    assert.equal(state().sessionSaveErrors.t7?.kind, 'quota', 'store 的抛出路径也要认 kind')
    assert.equal(db.selectSaveBannerDisplay(state().sessionSaveErrors, state().lowSpace), 'quota')
  })
})
