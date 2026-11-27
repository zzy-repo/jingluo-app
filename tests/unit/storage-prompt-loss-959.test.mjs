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

/**
 * 版本校验（#959 B）。
 *
 * 判据是「**这次写进去的版本 == 当前内存版本**」才清失败态 —— 也就是「盘上确实等于内存」，
 * 而不是「这次写成功了」。配套两条：
 *  · 每会话一条写链，保证「提交顺序 == 版本顺序」（`withStorage()` 在库没打开时会推迟提交）；
 *  · 轮到自己时快照已被内存超越 → **升级成最新内存**或**跳过**，绝不把旧快照写到盘上。
 */
test('C #959 落盘版本校验：不清新失败、不写旧数据', async (t) => {
  /** 手动放行的存储调用：`hold()` 返回 controller，`release(value)` 才让它完成 */
  const gate = () => {
    let release
    const promise = new Promise((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  await t.test('C1 版本相等才清：一次失败 → 之后一次**写进去的就是当前内存**的成功 → 横幅消失', async () => {
    let writes = 0
    reset(
      { sessions: [summaryOf('c1')], cache: { c1: sessionOf('c1') } },
      {
        loadSession: async (id) => sessionOf(id),
        saveSession: async () => {
          if (writes === 0) {
            writes += 1
            throw fullDiskDomException()
          }
          writes += 1
        },
      }
    )
    assert.equal(await chat.saveSessionPrompt('c1', '第一版'), false)
    assert.ok(state().sessionSaveErrors.c1, '第一次失败，横幅必须在')

    assert.equal(await chat.saveSessionPrompt('c1', '第一版'), true, '同一个值再存一次，这次成功')
    assert.equal(writes, 2, '确实写了第二次')
    assert.equal(state().sessionSaveErrors.c1, undefined, '盘上就是当前内存 → 那条失败已经不成立')
    assert.equal(bannerTier(), null)
  })

  await t.test('C2 旧写入成功不得清掉更新的失败：写进去的版本 < 当前内存版本 → 横幅必须还在', async () => {
    const first = gate()
    const second = gate()
    let calls = 0
    reset(
      { sessions: [summaryOf('c2')], cache: { c2: sessionOf('c2') } },
      {
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          calls += 1
          await (calls === 1 ? first.promise : second.promise)
          return undefined
        },
      }
    )
    // 上一次落盘失败留下的条目（例如置顶 / 改名的失败，或更早一次正文失败）
    chat.useChatStore.setState({ sessionSaveErrors: { c2: { kind: 'quota', stores: 'sessions', at: 1 } } })

    const writingV1 = chat.saveSessionPrompt('c2', '第一版')
    await settle()
    assert.equal(calls, 1, '第一次写已经在飞')
    // 写在飞的时候用户又改了：内存版本被推高，这次写携带的版本开始落后于内存
    const writingV2 = chat.saveSessionPrompt('c2', '第二版')
    await settle()

    first.release(undefined)
    assert.equal(await writingV1, true, '先发起的那次写自己成功了')
    assert.ok(
      state().sessionSaveErrors.c2,
      '但它的版本 < 当前内存版本（盘落后于内存）—— 这时候清掉失败态就是「旧请求成功后错误地清除新状态」'
    )
    assert.equal(bannerTier(), 'quota', '横幅必须还在')

    // 轮到「当前内存版本」的那次写：它成功之后才是内存 == 盘，这时才该清
    second.release(undefined)
    assert.equal(await writingV2, true)
    assert.equal(state().sessionSaveErrors.c2, undefined, '写进去的是当前内存版本 → 可以清')
  })

  await t.test('C3 旧快照不覆盖新数据：排队的旧快照被跳过、落盘顺序与版本顺序一致，盘上最终是最新值', async () => {
    const saves = []
    reset(
      { sessions: [summaryOf('c3')], cache: { c3: sessionOf('c3') } },
      {
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          saves.push(session.customSystemPrompt)
          return undefined
        },
      }
    )

    // ① 旧快照绝不落盘：第一次写在飞时用户连改两次 → 排队的旧快照必须**被跳过**，不许先写后覆盖
    const inFlight = gate()
    reset(
      { sessions: [summaryOf('c3')], cache: { c3: sessionOf('c3') } },
      {
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          saves.push(session.customSystemPrompt)
          if (saves.length === 1) {
            await inFlight.promise
          }
          return undefined
        },
      }
    )
    const writing1 = chat.saveSessionPrompt('c3', 'v1')
    await settle()
    assert.equal(saves.length, 1, '第一次写已经在飞（存储已打开时同一 tick 就发起，这条纪律不变）')
    const writing2 = chat.saveSessionPrompt('c3', 'v2')
    const writing3 = chat.saveSessionPrompt('c3', 'v3')
    await settle()
    assert.equal(saves.length, 1, '后面两次排在写链上，还没开始')
    inFlight.release(undefined)
    await Promise.all([writing1, writing2, writing3])
    await settle()
    assert.deepEqual(
      saves,
      ['v1', 'v3'],
      '落盘序列里**不许出现 v2**：它轮到时内存已是 v3，被升级成最新值；v3 那次再轮到时盘上已是 v3，直接跳过'
    )
    assert.equal(cached('c3').customSystemPrompt, 'v3')

    // ② 已经在飞的那次写（旧版本）与之后的写：完成顺序必须与版本顺序一致，盘上最终是新数据
    const disk = makeDisk()
    const slow = gate()
    saves.length = 0
    reset(
      { sessions: [summaryOf('c3b')], cache: { c3b: sessionOf('c3b') } },
      {
        loadSession: async (id) => sessionOf(id),
        saveSession: async (session) => {
          saves.push(session.customSystemPrompt)
          if (saves.length === 1) {
            await slow.promise
          }
          disk.set(session.id, { ...session })
          return undefined
        },
      }
    )
    const writingOld = chat.saveSessionPrompt('c3b', '旧值')
    await settle()
    const writingNew = chat.saveSessionPrompt('c3b', '新值')
    await settle()
    assert.equal(saves.length, 1, '第二次写被排在写链后面，还没开始')
    slow.release(undefined)
    await Promise.all([writingOld, writingNew])
    await settle()

    assert.deepEqual(saves, ['旧值', '新值'], '落盘顺序与版本顺序一致（旧快照绝不会最后落盘把新数据覆盖）')
    assert.equal(disk.get('c3b')?.customSystemPrompt, '新值', '盘上最终是新值')
  })

  /**
   * C4 —— 这条是「跳过判据」的**另一面**，也是它最容易误伤的一处：
   * 会话从盘上读回、发现损坏（`messages: null` → 归一化成 `[]`）→ 内存**修好了**，但盘上还是坏的。
   * 若读回时把 `persistedVersion` 也抬成「内存修好后的那一版」，紧接着的修复回写就会命中
   * 「盘上已是最新 → 跳过」—— **修复只活在内存里，盘上永远留着损坏数据**，而且用户看不到任何报错。
   * 所以：修好的内容必须算**新版本**（只抬 `sessionVersion`），必须真的回写一次。
   */
  await t.test('C4 读回时修复过的会话必须回写盘（修复不许只活在内存里）', async () => {
    const disk = makeDisk()
    reset(
      // 不进 cache ⇒ 走「冷缓存读回」这条路（C1–C3 全在缓存命中路径上，覆盖不到这里）
      { sessions: [summaryOf('c4')] },
      {
        loadSession: async (id) => sessionOf(id, { messages: null, rootMessageId: undefined }),
        saveSession: async (session) => {
          disk.set(session.id, { ...session })
        },
      }
    )

    chat.selectSession('c4')
    await settle()

    assert.deepEqual(cached('c4').messages, [], '内存里已修复（messages: null → []）')
    assert.equal(
      state().sessionLoadErrors.c4 ?? false,
      false,
      '修好的会话照常可用，不算加载失败'
    )
    assert.equal(
      callsOf('saveSession').length,
      1,
      '修复必须回写盘 —— 吞掉这一次，盘上永远留着损坏数据（每次打开都修一遍内存，永远修不好盘）'
    )
    assert.deepEqual(
      disk.get('c4')?.messages,
      [],
      '盘上拿到的必须是**修复后**的内容 —— 只断言内存不够，这个 bug 的特征正是「内存对、盘上没动」'
    )
  })

  /**
   * C4b —— C4 的加固版：**这条会话的版本号已经存在过**（先编辑落过盘 → 缓存被逐出 → 再冷读回损坏）。
   * 只靠「新 id 惰性分配一个更大的版本号」在 C4 里能侥幸通过；一旦版本号有残留，
   * 「修复后必须算新版本」这件事就只能靠**显式抬版本**保证 —— 少了它，回写会被跳过，修复又只活在内存里。
   */
  await t.test('C4b 版本号有残留时也必须回写（先编辑过 → 缓存被逐出 → 再读回损坏）', async () => {
    const disk = makeDisk()
    let damaged = false
    reset(
      { sessions: [summaryOf('c4b')], cache: { c4b: sessionOf('c4b') } },
      {
        loadSession: async (id) =>
          damaged ? sessionOf(id, { messages: null, rootMessageId: undefined }) : sessionOf(id),
        saveSession: async (session) => {
          disk.set(session.id, { ...session })
        },
      }
    )
    // 先正常编辑一次：这条会话因此有了版本号，也确实落过盘
    assert.equal(await chat.saveSessionPrompt('c4b', '编辑过'), true)
    const writesBefore = callsOf('saveSession').length
    assert.equal(writesBefore, 1, '第一次编辑真的写了盘')

    // 缓存被逐出（`trimSessionCache` / 内存压力等），再打开时走冷读，且盘上这条已经损坏
    chat.useChatStore.setState({ sessionCache: {} })
    damaged = true
    chat.selectSession('c4b')
    await settle()

    assert.deepEqual(cached('c4b')?.messages, [], '内存里已修复')
    assert.equal(
      callsOf('saveSession').length,
      writesBefore + 1,
      '版本号有残留时更不能省这次回写：少了版本提升，它会命中「盘上已最新 → 跳过」'
    )
    assert.deepEqual(disk.get('c4b')?.messages, [], '盘上也是修复后的内容')
  })
})
