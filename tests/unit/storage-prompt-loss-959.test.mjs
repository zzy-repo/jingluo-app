// [layer: unit | 依赖: 无（纯 Node；存储层与保护层打桩，零浏览器 / 零网络） | 耗时: <2s]
//
// Issue #959（上游 Refs #951）A 项 + B 项。
//
// A：**提示词 / 会话背景落盘失败后回滚内存 → 用户输入直接消失，且「重试」把旧值写回去。**
//    现场链路：`saveSessionPrompt()` 先改内存 → `persist()` 失败（同时把这条会话留在 `unsavedSessions`）
//    → 函数把内存回滚成旧值 → 用户点横幅「重试」→ `retrySaveSessions()` 跑 `persist(id)`
//    → 写的是**内存里的旧值** → 重试"成功"、横幅消失，**盘上从来没有过新提示词**。
//    提示词只有内存与盘两份副本，回滚 = 两份都成旧值；`PersonaDrawer` 的草稿只在抽屉打开期间存在。
//
// B：**`sessionSaveErrors[id]` 的语义应收紧成「内存与盘不一致」**，而不是「曾经失败过」。
//    A 项的回滚会让内存回到与盘相同却仍留着条目（横幅成为假话）；「成功从盘重读收敛」这条
//    也从不清条目。**明确不做「打开会话就清」**：`ensureSessionLoaded()` 缓存命中时根本不读盘
//    （第一行 `if (getSession(id)) return`），那时内存里还有未落盘正文，清了等于把唯一的重试入口藏起来。
//
// 本文件钉住：
//   A1 保存失败：内存里必须留着用户打的新提示词（不许回滚），失败态必须出现
//   A2 失败 → 改提示词 → 再失败 → 点重试 → **盘上是新提示词**（不是旧值），失败态被清
//   A3 会话背景：同一缺陷的第二处，独立用例（失败不回滚 + 重试后盘上是新背景）
//   B1 失败后只是「打开会话」（缓存命中、不读盘）→ 横幅与重试按钮必须还在，且确实没读盘
//   B2 成功从盘重读收敛（冷缓存打开会话）→ 之前那条旧失败必须被清掉
//
// 负向对照：把 `saveSessionPrompt()` 的 `updateSession(...回滚...)` 加回去 → A1/A2 红。
//
//   node --test tests/unit/storage-prompt-loss-959.test.mjs
//   node tests/run-layer.mjs unit --only storage-prompt-loss-959
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  callsOf,
  fullDiskDomException,
  loadStoreEnv,
  sessionOf,
  settle,
  summaryOf,
} from '../helpers/store-storage-env.mjs'

const { chat, db, reset } = await loadStoreEnv()

const state = () => chat.useChatStore.getState()
const cached = (id) => state().sessionCache[id]
// 纯 IndexedDB 基线上没有「空间不足预警」档（`selectSaveBannerDisplay(errors, lowSpace)` 与
// `lowSpace` 状态属 #931 配套），横幅档位直接取三档写失败的那一档 —— 断言意图不变。
const bannerTier = () => db.selectSaveBannerTier(state().sessionSaveErrors)

/** 假「盘」：只在用例装配的 `saveSession` 里写，用来断言**真的**写了什么 */
const makeDisk = () => new Map()

test('A #959 提示词 / 背景保存失败不得丢弃用户输入（回滚 = 两份副本都成旧值）', async (t) => {
  await t.test('A1 保存失败：内存里必须留着用户打的新提示词，且失败态必须出现', async () => {
    const disk = makeDisk()
    reset(
      { sessions: [summaryOf('a1')], cache: { a1: sessionOf('a1', { customSystemPrompt: '旧提示词' }) } },
      { saveSession: async () => { throw fullDiskDomException() } }
    )
    assert.equal(await chat.saveSessionPrompt('a1', '新提示词'), false, '没落盘就是 false')
    assert.equal(disk.get('a1'), undefined, '这次写确实失败了（盘上什么都没写）')
    assert.equal(
      cached('a1').customSystemPrompt,
      '新提示词',
      '落盘失败不许把用户刚打的字从内存里抹掉 —— 抹掉等于两份副本都成旧值'
    )
    assert.ok(state().sessionSaveErrors.a1, '失败必须让横幅出现，用户才知道没存上')
    // 档位的**精确值**（满盘 → `quota`）由 `tests/unit/storage-save-tier-938.test.mjs` 钉，那是 #938 的分类职责；
    // 本单（#959）只关心这两件事：横幅**真的出现**、并且**是可重试档**（有重试入口，用户能把内容补存上去）。
    // 这是有意的分工，不是这里漏钉档位。
    assert.notEqual(bannerTier(), null, '横幅必须出现（不是「没报错就算过」）')
    assert.equal(
      db.bannerRetryable(db.selectSaveBannerTier(state().sessionSaveErrors)),
      true,
      '而且必须是可重试档 —— 不可重试的话用户没有任何补存入口'
    )
  })

  await t.test('A2 失败 → 改提示词 → 再失败 → 点重试 → 盘上是**新**提示词（不是旧值）', async () => {
    const disk = makeDisk()
    let writes = 0
    reset(
      { sessions: [summaryOf('a2')], cache: { a2: sessionOf('a2', { customSystemPrompt: '旧提示词' }) } },
      {
        // 上一个子用例失败后会把它的 id 留在模块私有的「待落盘」集合里（`reset()` 只重置 store 状态，
        // 碰不到模块级集合）——那是用例隔离的产物，不是被测行为。所以这里只对 a2 计数、只对 a2 注入失败。
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          if (session.id !== 'a2') {
            return
          }
          writes += 1
          // 前两次（用户的两轮编辑）都失败，重试那一次成功
          if (writes <= 2) {
            throw fullDiskDomException()
          }
          disk.set(session.id, { ...session })
        },
      }
    )

    assert.equal(await chat.saveSessionPrompt('a2', '第一次改'), false)
    assert.equal(await chat.saveSessionPrompt('a2', '最后改的'), false)
    assert.ok(state().sessionSaveErrors.a2, '两轮都失败，横幅必须在')

    chat.retrySaveSessions()
    await settle()

    assert.equal(writes, 3, '「重试」必须真的再写一次（不许是空点击）')
    assert.equal(
      disk.get('a2')?.customSystemPrompt,
      '最后改的',
      '重试写的是内存里的值 —— 内存若被回滚过，这里写回去的就是旧提示词，用户输入永久丢失'
    )
    assert.equal(state().sessionSaveErrors.a2, undefined, '成功了就该把失败态清掉')
    assert.equal(bannerTier(), null)
  })

  await t.test('A3 会话背景：同一缺陷的第二处，失败不回滚、重试后盘上是新背景', async () => {
    const disk = makeDisk()
    const oldBackground = { style: 'default', opacity: 20, blur: 0 }
    const newBackground = { style: 'custom', opacity: 40, blur: 6 }
    let writes = 0
    reset(
      { sessions: [summaryOf('a3')], cache: { a3: sessionOf('a3', { background: oldBackground }) } },
      {
        // 同上：只对 a3 计数与注入失败，忽略上一个子用例遗留的待落盘 id
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          if (session.id !== 'a3') {
            return
          }
          writes += 1
          if (writes === 1) {
            throw fullDiskDomException()
          }
          disk.set(session.id, { ...session })
        },
      }
    )

    assert.equal(await chat.saveSessionBackground('a3', newBackground), false)
    assert.deepEqual(
      cached('a3').background,
      newBackground,
      '背景选择同样不许在落盘失败时被丢弃（用户选的图 / 淡化 / 模糊都是用户输入）'
    )

    chat.retrySaveSessions()
    await settle()
    assert.equal(writes, 2, '重试必须再写一次')
    assert.deepEqual(disk.get('a3')?.background, newBackground, '重试必须把用户选的背景写上去')
    assert.equal(state().sessionSaveErrors.a3, undefined)
  })
})

test('B #959 失败态只在「内存与盘重新一致」时清，不在「打开会话」时清', async (t) => {
  await t.test('B1 失败后只是打开会话（缓存命中、不读盘）→ 横幅与重试按钮必须还在', async () => {
    reset(
      { sessions: [summaryOf('b1')], cache: { b1: sessionOf('b1') } },
      { saveSession: async () => { throw new Error('boom') } }
    )
    assert.equal(await chat.saveSessionPrompt('b1', '改一下'), false)
    assert.equal(bannerTier(), 'retry')

    chat.selectSession('b1')
    await settle()

    assert.equal(callsOf('loadSession').length, 0, '缓存命中时这一步根本不读盘（存档里就是这条纪律）')
    assert.equal(
      bannerTier(),
      'retry',
      '内存里还有未落盘正文、盘上还没有 —— 这时候清掉横幅 = 把唯一的重试入口藏起来，比不清更糟'
    )
    assert.equal(db.bannerRetryable(db.selectSaveBannerTier(state().sessionSaveErrors)), true, '重试按钮必须还在')
  })

  await t.test('B2 成功从盘重读收敛 → 之前那条旧失败必须被清掉（内存 == 盘，断言变假）', async () => {
    const stored = sessionOf('b2')
    reset(
      { sessions: [summaryOf('b2')] },
      {
        loadSession: async () => stored,
        saveSession: async () => {},
      }
    )
    // 上一条失败条目还在（例如上一次落盘失败后会话被逐出缓存），随后这条会话从盘重读成功
    chat.useChatStore.setState({
      sessionSaveErrors: { b2: { kind: 'quota', stores: 'sessions', at: 1_000 } },
    })
    assert.equal(bannerTier(), 'quota')

    chat.selectSession('b2')
    await settle()

    assert.equal(callsOf('loadSession').length, 1, '冷缓存打开会话会真读盘（与 B1 的形态正好相反）')
    assert.ok(cached('b2'), '正文按预期落到内存')
    assert.equal(state().sessionSaveErrors.b2, undefined, '内存 := 盘，那句「没存到本机」已经不成立了')
    assert.equal(bannerTier(), null)
  })
})
