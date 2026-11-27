// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #936（P0 数据安全）：满盘写入失败 → 冷启动 Chromium 判 LevelDB 损坏并整库删除 → 历史全丢且零提示。
//
// 设备实测（#910 评价里的原始证据）说明真正的断点在**检测层**：
//   `highwater.json` 被写成 `{"v":1,"sessions":0,...}`（满盘期间这个标记自己也坏掉 / 被覆盖），
//   于是 `store.init` 里的 `summaries.length === 0 ? protectionCheckAtStartup()` 拿到
//   `detectDataLoss(0, {sessions:0})` / `detectDataLoss(0, null)` → **判不出「库从有到无」**
//   → `DataLostBanner` 不弹 → 快照恢复入口不可达。而**数据其实还在盘上**：
//   `files/app-fs/snapshots/<ts>.json` 里仍有 `"sessions":5` + 全量消息。
//
// 判定纪律（本文件钉住的四类，缺一类就是回归）：
//   [L1] 有数据 → 库变空（满盘后损坏重建），**标记也随满盘一起坏掉** → 必须判定丢失 + 恢复入口可用
//   [L2] 同上，但标记被写成 `sessions:0`（设备实测形态）→ 仍然必须判定丢失
//   [L3] 全新用户（从来没数据）→ 库空 → **必须不**误报（不许把「新装」判成「丢失」）
//   [L4] 用户自己删光（显式路径）→ 库空但旧快照还在 → 不得误报（显式意图优先于快照证据）
//   [L5] 标记说有过数据、但快照全部损坏 → 判定丢失，但**不给**恢复入口（`valid=false` 不放松）
//   [L6] 从快照恢复之后 → 高水位按恢复后的实际数重写、丢失状态清掉、下次启动不再报
//   [N6] 空库 + 标记读不出来时的保存路径 → 不许把 `sessions:0` 写进标记（自己抹掉唯一证据）
//
// 红线：恢复入口只由 `snapshot.valid`（逐份 checksum 校验）决定，本文件不解锁任何「放松校验」的路径。
//
//   node --test tests/unit/protection-dataloss-936.test.mjs
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadProtection,
  makeCommit,
  makeSession,
  memoryStorage,
  resetRecords,
  setupProtection,
} from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { HIGHWATER_PATH, SNAPSHOT_DIR, resetProtectionDiagnosticsForTests } = P

const fill = (n) => Array.from({ length: n }, (_, index) => makeSession(`s${index}`))
const setup = ({ sessions = 0, native = true } = {}) => {
  resetProtectionDiagnosticsForTests()
  resetRecords()
  return setupProtection(P, { native, sessions: fill(sessions) })
}

/** 正常使用中「保存成功」后的状态：抬高水位 + 写一份快照。返回标记原文 */
const seedHistory = async (env) => {
  await env.protection.afterSave()
  return new TextDecoder().decode(await env.fs.read(HIGHWATER_PATH))
}

/** 满盘：标记文件只落进去半截（ENOSPC 之后盘上留下的残骸），读侧按「校验和不过」处理 */
const truncateMarker = async (env, text) => {
  await env.fs.writeAtomic(HIGHWATER_PATH, text.slice(0, Math.floor(text.length / 2)))
}

/** 冷启动：库被 Chromium 删除重建（两个 store 都归零） */
const wipeDb = (env) => {
  env.state.sessions = []
  env.state.summaries = undefined
}

/**
 * 冷启动 = 新进程：只保留磁盘上的东西（标记文件 / 快照），内存里的一切（含高水位缓存）重新开始。
 * 不新建保护层就是复用旧实例 —— 那会把进程内缓存当成现实，测不出「冷启动」的行为。
 */
const coldStart = (env) =>
  P.createProtection({
    fs: env.fs,
    storage: memoryStorage(env.state),
    now: () => env.now.value,
    local: env.local,
  })

/** 设备上观测到的形态：`{"v":1,"sessions":0,"at":...,"schema":15,"checksum":"..."}`（合法标记，只是 0 条） */
const writeZeroMark = async (env, at) => {
  const body = JSON.stringify({ v: P.HIGHWATER_FORMAT_VERSION, sessions: 0, at, schema: 15 })
  const text = JSON.stringify({ ...JSON.parse(body), checksum: createHash('sha256').update(body).digest('hex') })
  await env.fs.writeAtomic(HIGHWATER_PATH, text)
}

const validSnapshots = async (protection) =>
  (await protection.listRestorable()).filter((item) => item.valid).map((item) => item.sessions)

test('L1 库从有到无（满盘后整库重建、标记也写坏了）：必须判定丢失，并给出可恢复的快照', async () => {
  const env = setup({ sessions: 5 })
  const mark = await seedHistory(env)
  await truncateMarker(env, mark) // 满盘：标记只写了半截
  wipeDb(env) // 冷启动：Chromium 判损坏并删库重建
  const cold = coldStart(env)

  const lost = await cold.checkAtStartup()
  assert.equal(lost?.expectedSessions, 5, '盘上有 5 条会话的快照，必须判出「库从有到无」')
  assert.deepEqual(await validSnapshots(cold), [5], '恢复入口必须可用（快照逐份校验通过）')
})

test('L2 标记被写成 sessions:0（设备实测形态）：库空 + 有效快照 → 仍然必须判定丢失', async () => {
  const env = setup({ sessions: 5 })
  await seedHistory(env)
  await writeZeroMark(env, env.now.value + 60_000)
  wipeDb(env)
  const cold = coldStart(env)

  const lost = await cold.checkAtStartup()
  assert.equal(lost?.expectedSessions, 5, '标记是 0 不代表本机没数据 —— 有效快照说有过 5 条')
  assert.deepEqual(await validSnapshots(cold), [5])
})

test('L3 全新用户（从来没数据）：库空、无标记、无快照 → 不报，也不留下标记文件', async () => {
  const env = setup({ sessions: 0 })
  assert.equal(await env.protection.checkAtStartup(), null, '新装不许被判成丢失')
  assert.equal(await env.fs.read(HIGHWATER_PATH), undefined, '新装不该留下标记文件')
  assert.deepEqual(await validSnapshots(env.protection), [])
})

test('L4 用户自己删光（显式路径）：库空但旧快照还在 → 不得误报', async () => {
  const env = setup({ sessions: 3 })
  await seedHistory(env)
  env.now.value += 60_000 // 标记时间要晚于快照，才表示「清空发生在快照之后」
  wipeDb(env) // 用户逐条删光（模拟删完的库）
  await env.protection.afterExplicitChange() // store 的显式路径（removeSessionData / 整包替换）
  const cold = coldStart(env)

  assert.equal(await cold.checkAtStartup(), null, '用户自己删光，不许弹「被系统清除」')
})

test('L5 标记说有过数据、快照全部损坏：判定丢失，但恢复入口不可用', async () => {
  const env = setup({ sessions: 4 })
  await seedHistory(env)
  const [entry] = await env.fs.list(SNAPSHOT_DIR)
  const bytes = await env.fs.read(`${SNAPSHOT_DIR}/${entry.name}`)
  bytes[bytes.length - 3] ^= 0x1 // 改一个字节：校验和不过
  await env.fs.writeAtomic(`${SNAPSHOT_DIR}/${entry.name}`, bytes)
  wipeDb(env)
  const cold = coldStart(env)

  const lost = await cold.checkAtStartup()
  assert.equal(lost?.expectedSessions, 4, '标记还在 → 仍然报（既有行为不变）')
  const restorable = await cold.listRestorable()
  assert.equal(restorable.length, 1)
  assert.equal(restorable[0].valid, false, '损坏的快照只展示、不给恢复入口')
  assert.deepEqual(await validSnapshots(cold), [], '没有任何可恢复条目时，恢复入口必须为空')
})

test('L6 从快照恢复之后：高水位按恢复后的实际数重写，丢失状态清除，下次启动不再报', async () => {
  const env = setup({ sessions: 5 })
  const mark = await seedHistory(env)
  await truncateMarker(env, mark)
  wipeDb(env)
  const cold = coldStart(env)
  assert.equal((await cold.checkAtStartup())?.expectedSessions, 5)

  const [entry] = await env.fs.list(SNAPSHOT_DIR)
  const result = await cold.restore(entry.name, { commit: makeCommit(env.state) })
  assert.deepEqual(result, { status: 'restored', sessions: 5, backup: null }, '库本来就是空的，没有可备份的现状')

  env.now.value += 1_000
  await cold.afterExplicitChange() // store 在整包替换提交后做这一步（importHistoryInto）
  const { mark: after } = await cold.highwater.read()
  assert.deepEqual(
    { sessions: after?.sessions, lost: after?.lost, cleared: after?.cleared },
    { sessions: 5, lost: undefined, cleared: undefined },
    '恢复后标记按实际数写、丢失状态清掉'
  )
  assert.equal(await coldStart(env).checkAtStartup(), null, '恢复完再冷启动不许再报')
})

test('N6 空库 + 标记读不出来时的保存路径：不许把 sessions:0 写进标记', async () => {
  const env = setup({ sessions: 5 })
  const mark = await seedHistory(env)
  await truncateMarker(env, mark)
  wipeDb(env)
  const cold = coldStart(env)

  const before = await env.fs.read(HIGHWATER_PATH)
  await cold.afterSave() // 保存路径也会抬水位（fire-and-forget）
  assert.deepEqual(
    await env.fs.read(HIGHWATER_PATH),
    before,
    '「0 条」没有信息量，却会抹掉「本机曾经有数据」的唯一证据 —— 读不出来就不许写'
  )
  assert.equal((await cold.highwater.read()).mark, null, '写坏的标记不许被「0 条」洗成一份看起来合法的标记')
})
