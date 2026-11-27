// [layer: unit | 安全备份的容量上限（#1005）：K 份上限 / 最后一份可用备份不许删 / 清理失败不阻断备份]
//
// 背景（设备实测）：每执行一次**恢复**，系统会先为「当前数据」做一份**安全备份**，而安全备份走
// `prune: false`、**永不参与保留策略清理**。两次恢复就把备份目录从 3 份涨到 5 份 zip / 约 226MB
// （单份 43MB），而**磁盘被写满**正是本版整库丢失事故的根因。用户完全看不到这个增长
// （设置页只显示「共 N 份」）。
//
// 这一层钉**行为**，不读源码做断言：
//   [A] 纯逻辑：安全备份按清单时间留最近 K 份；只有 1 份常规 + 1 份安全时一份都不删；
//       最新一份成功备份本身是安全备份时不许删；时间不可信的项不参与清理；
//   [B] 3 份安全 + 1 份常规 → 新备份成功后安全只剩最近 2 份，常规备份一份不少；
//   [C] 恢复路径：安全备份 1 份 → 2 份（K 之内不删）→ 3 份（超出才删最老那份）；
//   [D] 清理失败（`remove` 抛错）→ 备份仍然成功，且每个文件只尝试一次、每份只留一条错误日志。
//
// 替身范围与 `backup-core-993.test.mjs` 同一套：`@capacitor/core`、`BackupFile` 桥（内存文件系统）、
// `chat/backup.js`（`exportHistory` / `importHistory`）、`diagnostics/collector.js`（这里额外记录调用，
// 用来数清理失败到底刷了几条日志）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backupBridge } from '../helpers/backup-bridge.mjs'
import { installTsResolve, inlineModule, loadTsModule } from '../helpers/dom-env.mjs'

/* ------------------------------------------------------------------ 原生桥替身（内存文件系统） */

/**
 * 与 `backup-core-993.test.mjs` 共用 `helpers/backup-bridge.mjs` 那一份（语义、白名单、
 * 失败注入都在里面）。两份逐字副本同时踩 `check:test-duplication` R1 与合并批次的
 * `globalThis.__bridge` 抢占（后装的生效 → 假红）。
 *
 * 本文件多用的两个观测点也在同一份里：`removeCalls`（同一文件被尝试删几次）、
 * `removeFails`（删这些名字就抛错）。
 */
const native = backupBridge
const { bridge, committed, removeCalls, removeFails } = native

native.install()

/* ------------------------------------------------------------------ 诊断调用记录 */

const diagCalls = []
globalThis.__diag = diagCalls

/* ------------------------------------------------------------------ chat 侧替身（导出 / 导入） */

const importCalls = []
let exportFails = false
let importFails = false
let nextSessions = 3

globalThis.__nextSessions = nextSessions
globalThis.__archiveBytes = (sessions) => Buffer.from(`archive:${sessions}:${'x'.repeat(64)}`)
globalThis.__importCalls = importCalls
globalThis.__exportFails = false
globalThis.__importFails = false

const chatStub = inlineModule(`
export const exportHistory = async () => {
  if (globalThis.__exportFails) { throw Object.assign(new Error('export boom'), { code: 'X' }) }
  const sessions = globalThis.__nextSessions
  return { name: 'deepseek_data-test.zip', blob: new Blob([globalThis.__archiveBytes(sessions)]), sessions }
}
export const importHistory = async (file, options) => {
  globalThis.__importCalls.push({ size: file.size, mode: options && options.mode })
  if (globalThis.__importFails) { throw new Error('import boom') }
  return { count: 1, mode: 'overwrite', added: 1, overwritten: 0, skipped: 0 }
}
`)

const diagStub = inlineModule(`
export const record = (kind, level, message, meta) => { globalThis.__diag.push({ level, message, meta }) }
export const recordError = (message, meta) => { globalThis.__diag.push({ level: 'error', message, meta }) }
export const recordAction = () => ({})
`)

installTsResolve({
  stubs: [
    [
      /^@capacitor\/core$/,
      inlineModule(
        'export const Capacitor = { isNativePlatform: () => globalThis.__native === true }; export const registerPlugin = () => globalThis.__bridge;'
      ),
    ],
  ],
  onResolve: (specifier, context) => {
    if (specifier === '../chat/backup.js') {
      return chatStub
    }
    if (specifier === '../diagnostics/collector.js') {
      return diagStub
    }
    if (specifier === '../attachments/store.js') {
      return inlineModule(
        'export const listAttachments = async () => []; export const readAttachmentBlob = async () => undefined; export const putAttachment = async () => {};'
      )
    }
    if (context?.parentURL?.includes('/services/backup/') && /^\.\.\/(chat|chat\/history)\//.test(specifier)) {
      return inlineModule(
        'export const writeArchive = async () => new Blob([]); export const readArchive = async function* () {}; export const readEntry = async () => new Blob([]); export const saveFiles = async () => {};'
      )
    }
    return undefined
  },
})

const core = await loadTsModule('src/services/backup/backupCore.ts')
const api = await loadTsModule('src/services/backup/backupApi.ts')
const limits = await loadTsModule('src/services/backup/limits.ts')

const reset = () => {
  native.reset()
  diagCalls.length = 0
  importCalls.length = 0
  globalThis.__nextSessions = 3
  globalThis.__exportFails = false
  globalThis.__importFails = false
}

/** 盘上还在的备份 id（按清单文件判断：没有清单 = 不是可恢复的备份） */
const backupIdsOnDisk = () =>
  [...committed.keys()]
    .map((name) => core.parseManifestFileName(name))
    .filter((id) => id !== null)
    .sort()

/**
 * 直接把一份「看着像成功备份」的文件塞进内存盘：归档字节数 = 清单声明的大小、`verified: true`、
 * 清单 id 与文件名一致 —— 这样 `scanBackups` 会判它 `checksumOk: true`。
 *
 * 为什么要播种而不是全靠 `runBackup`：真实缺陷的场景是「设备上已经积了 3 份安全备份」，
 * 而打了补丁之后每做一次恢复就会清一次，靠 API 一路跑是**造不出**这个初始状态的。
 */
const seedBackup = ({ id, origin, isoTime, sessions = 2, sizeBytes = 16 }) => {
  const manifest = {
    backup_format_version: core.BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: isoTime,
    // 盘上的清单是 `snake_case`（与归档格式一致），这里必须照抄那个形状 ——
    // 写成 camelCase 的话 `parseManifest` 会整份判成读不懂，于是这份「备份」既不 checksumOk、
    // 也分不出是不是安全备份，测试就会假绿。
    archive: { name: core.archiveFileName(id), size_bytes: sizeBytes, sha256: 'a'.repeat(64) },
    attachments: null,
    data_summary: { sessions, attachments: 0 },
    verified: true,
    ...(origin === undefined ? {} : { origin }),
  }
  committed.set(core.archiveFileName(id), Buffer.alloc(sizeBytes, 0x41))
  committed.set(core.manifestFileName(id), Buffer.from(JSON.stringify(manifest), 'utf8'))
  return id
}

/** 让事件循环把诊断的动态 import 跑完（`logDiagnostic` 是 fire-and-forget） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/* ------------------------------------------------------------------ [A] 纯逻辑 */

/** hour 越大越新（UTC 同一天的整点） */
const item = (id, hour, origin, checksumOk = true) => ({
  id,
  createdAtUtc: new Date(Date.UTC(2026, 10, 27, hour, 0, 0)).toISOString(),
  sizeBytes: 10,
  checksumOk,
  ...(origin === undefined ? {} : { origin }),
})

test('[A] K 是常量且只有一处：安全备份保留 2 份', async () => {
  assert.equal(limits.SAFETY_RETENTION_KEEP, 2)
  // 安全备份的 K 必须**小于**常规保留份数：否则「只留 2 份安全备份」就等于把退路压到比常规还低
  assert.ok(limits.SAFETY_RETENTION_KEEP < core.RETENTION_KEEP)
})

test('[A1] 安全备份按清单时间留最近 K 份，且不占常规备份的名额', async () => {
  const items = [
    item('b-reg-1', 9, 'manual'),
    item('b-safe-10', 10, 'safety'),
    item('b-safe-11', 11, 'safety'),
    item('b-safe-12', 12, 'safety'),
  ]
  // 只给出最老的那份安全备份（10 点）；11 / 12 点两份留下
  assert.deepEqual(core.selectPrunableSafety(items, 2), ['b-safe-10'])
  // 常规组一份都不动（只有 1 份常规，远不足 3）
  assert.deepEqual(core.selectPrunable(items, core.RETENTION_KEEP), [])
  const plan = core.planRetention(items, { regularKeep: core.RETENTION_KEEP, safetyKeep: 2 })
  assert.deepEqual(plan.regular, [])
  assert.deepEqual(plan.safety, ['b-safe-10'])
  // 反过来：安全备份多得离谱时，常规组也不会因此被牵连（两组各按各的上限）
  const regularHeavy = [item('b-reg-1', 9, 'manual'), ...items.slice(1)]
  assert.deepEqual(
    core.planRetention(regularHeavy, { regularKeep: core.RETENTION_KEEP, safetyKeep: 2 }).regular,
    []
  )
})

test('[A2] 只有「1 份常规 + 1 份安全」：一份都不许删（哪怕超出 K）', async () => {
  const items = [item('b-reg-1', 9, 'manual'), item('b-safe-10', 10, 'safety')]
  // 真实 K=2 时当然不删；这里把上限压到 1 来验证「底线优先于上限」——
  // 上限只是「想留几份」，底线是「一份可用的都不许变没有」。
  assert.deepEqual(core.selectPrunableSafety(items, 1), [])
  assert.deepEqual(core.planRetention(items, { regularKeep: 1, safetyKeep: 1 }), {
    regular: [],
    safety: [],
  })
  // 更极端：上限 1 份、手上有 2 份安全备份，但**唯一校验通过的是更老那一份** ——
  // 按上限该删它，按底线不许删（删完就一份可恢复的都不剩）。这里选择「一份都不删」。
  const fragile = [item('b-safe-9', 9, 'safety'), item('b-safe-10', 10, 'safety', false)]
  assert.deepEqual(core.selectPrunableSafety(fragile, 1), [])
})

test('[A3] 最新一份成功备份本身是安全备份时：绝对不删它', async () => {
  // 最新那份「成功」的安全备份被排到了超出上限的位置（时钟倒退时真的会出现）
  const items = [
    item('b-safe-9', 9, 'safety'),
    item('b-safe-10', 10, 'safety'),
    item('b-safe-11', 11, 'safety', false),
  ]
  const doomed = core.selectPrunableSafety(items, 1)
  assert.deepEqual(doomed, ['b-safe-9'], '只删更老的那一份')
  assert.ok(!doomed.includes('b-safe-10'), '最新一份校验通过的备份永不删')
  assert.ok(!doomed.includes('b-safe-11'), '它同样不该被删（不在候选里）')
})

test('[A4] 时间不可信（清单时间读不出来）的安全备份不参与清理', async () => {
  const items = [
    { id: 'b-safe-9', createdAtUtc: 'not-a-date', sizeBytes: 10, checksumOk: true, origin: 'safety' },
    item('b-safe-10', 10, 'safety'),
    item('b-safe-11', 11, 'safety'),
    item('b-safe-12', 12, 'safety'),
  ]
  // 三份时间可信的按 K=2 清掉 10 点那份；时间坏掉的那份判不出新旧 → 留着
  assert.deepEqual(core.selectPrunableSafety(items, 2), ['b-safe-10'])
})

test('[A5] 清单来源标记往返：老清单没有 `origin`，新清单带上', async () => {
  const base = {
    backup_format_version: core.BACKUP_FORMAT_VERSION,
    id: 'b-20261127T100500123Z',
    created_at_utc: '2026-11-27T10:05:00.123Z',
    archive: { name: 'b-20261127T100500123Z.zip', sizeBytes: 10, sha256: 'a'.repeat(64) },
    attachments: null,
    data_summary: { sessions: 4, attachments: 0 },
    verified: true,
  }
  // 老清单（#1005 之前写的）：解析回来不许凭空多出一个 origin
  const onDisk = JSON.parse(core.manifestToJson(base))
  assert.deepEqual(core.parseManifest(onDisk), base)
  // 新清单：origin 落盘、能读回来
  const safety = { ...base, origin: 'safety' }
  const roundTrip = core.parseManifest(JSON.parse(core.manifestToJson(safety)))
  assert.equal(roundTrip.origin, 'safety')
  // 读不懂的来源标记一律按常规备份对待（不因此判成 corrupt）
  assert.equal(core.parseManifest({ ...onDisk, origin: 'weird' }).origin, undefined)
})

test('[A6] 时间读不出来的可用备份不许占「最新」保护位（可信时间最新的那份必须留下）', async () => {
  // 回归（穷举查出来的真缺陷）：`createdDesc` 曾经返回 `NaN`（`Date.parse` 读不出来），
  // 而 `Array#sort` 遇到 `NaN` 比较器**顺序不作保证**（V8 里原地不动）——
  // 于是「时间读不出来」的那份**稳坐 sorted[0] 的『最新』保护位**，真正最新的那份
  // 被排到上限之外删掉。这条用例就是钉住那一类：**不许删掉可信时间里最新的那份**。
  const undated = {
    id: 'b-undated',
    createdAtUtc: 'not-a-date',
    sizeBytes: 10,
    checksumOk: true,
    origin: 'manual',
  }
  const items = [undated, item('b-reg-9', 9, 'manual'), item('b-reg-10', 10, 'manual'), item('b-reg-11', 11, 'manual')]
  const doomed = core.selectPrunable(items, 2)
  assert.ok(!doomed.includes('b-reg-11'), '可信时间最新（11 点）的那份不许被删')
  assert.ok(!doomed.includes('b-reg-10'), '次新的那份也不在候选里')
  assert.deepEqual(doomed, ['b-reg-9', 'b-undated'], '只清最老的 9 点那份与「判不出时间」的那份')

  // 同一类问题的另一面：不可信时间排在最后，**任何**上限下都不会抢走保护位
  for (let keep = 1; keep <= 3; keep += 1) {
    assert.ok(!core.selectPrunable(items, keep).includes('b-reg-11'), `keep=${keep} 时最新一份都不许被删`)
  }
  // 安全组同理（`newestFirst` 早就是这个语义，这里一并钉住）
  const safetyItems = [{ ...undated, id: 'b-s-undated', origin: 'safety' }, item('b-safe-9', 9, 'safety')]
  assert.ok(!core.selectPrunableSafety(safetyItems, 1).includes('b-safe-9'))
})

/* ------------------------------------------------------------------ [B] 3 安全 + 1 常规 */

test('[B] 3 份安全 + 1 份常规：新备份成功后安全只剩最近 2 份，常规一份不少', async () => {
  reset()
  seedBackup({ id: 'b-reg-1', origin: 'manual', isoTime: '2026-11-27T09:00:00.000Z' })
  seedBackup({ id: 'b-safe-10', origin: 'safety', isoTime: '2026-11-27T10:00:00.000Z' })
  seedBackup({ id: 'b-safe-11', origin: 'safety', isoTime: '2026-11-27T11:00:00.000Z' })
  seedBackup({ id: 'b-safe-12', origin: 'safety', isoTime: '2026-11-27T12:00:00.000Z' })
  assert.equal(backupIdsOnDisk().length, 4)

  const fresh = await api.runBackup('manual')

  const ids = backupIdsOnDisk()
  // 安全备份：最老的 10 点那份被清掉，11 / 12 点两份留下
  assert.ok(!ids.includes('b-safe-10'), '超出 K 的安全备份必须被清掉')
  assert.ok(ids.includes('b-safe-11'))
  assert.ok(ids.includes('b-safe-12'))
  // 常规备份：老的那份与刚写的这份都在（2 份 ≤ 3，一份都不该少）
  assert.ok(ids.includes('b-reg-1'), '常规备份不许被安全备份挤掉')
  assert.ok(ids.includes(fresh.id), '刚写成功的备份必须还在')
  // 文件真的从盘上消失，不是只从列表里藏起来
  assert.equal(committed.get(core.archiveFileName('b-safe-10')), undefined)
  assert.equal(committed.get(core.manifestFileName('b-safe-10')), undefined)

  const listed = await api.listBackups()
  assert.deepEqual(
    listed.map((entry) => entry.id).sort(),
    ['b-reg-1', 'b-safe-11', 'b-safe-12', fresh.id].sort()
  )
  // 设置页的「共 N 份」读的就是这个数：清理之后它必须跟着变小（否则用户看到的占地是假的）
  const status = await api.getStatus()
  assert.equal(status.count, 4)
  assert.equal(status.lastError, null)
})

/* ------------------------------------------------------------------ [C] 恢复路径 */

test('[C] 恢复路径：安全备份 1 份 → 2 份（K 之内不删）→ 3 份（超出才删最老）', async () => {
  reset()
  const regular = await api.runBackup('manual')
  seedBackup({ id: 'b-safe-9', origin: 'safety', isoTime: '2026-11-27T09:00:00.000Z' })

  // 第一次恢复：写完新的安全备份后安全备份共 2 份 = K，一份都不该删
  await api.restoreBackup(regular.id)
  const safeties = async () =>
    (await api.listBackups()).filter((entry) => entry.id !== regular.id).map((entry) => entry.id)
  assert.ok(backupIdsOnDisk().includes('b-safe-9'), 'K 之内不许删安全备份')
  assert.equal((await safeties()).length, 2, '第一次恢复后：1 份常规 + 2 份安全')

  // 第二次恢复：安全备份 3 份 > K → 只清最老的那份（播种的那份）
  await api.restoreBackup(regular.id)
  const ids = backupIdsOnDisk()
  assert.ok(!ids.includes('b-safe-9'), '超出 K 之后才清最老的一份安全备份')
  assert.ok(ids.includes(regular.id), '常规备份全程不许被恢复路径删掉')
  assert.equal((await safeties()).length, 2, '安全备份稳定在 K 份，不再无上限增长')

  // 最新的一份成功备份（这次恢复写的那份）必须还在
  const newest = (await api.listBackups())[0]
  assert.ok(ids.includes(newest.id))
  assert.equal((await api.getStatus()).lastError, null)
})

/* ------------------------------------------------------------------ [D] 清理失败 */

test('[D] 清理失败（remove 抛错）：备份仍然成功，每个文件只试一次、只留一条错误日志', async () => {
  reset()
  seedBackup({ id: 'b-reg-1', origin: 'manual', isoTime: '2026-11-27T09:00:00.000Z' })
  seedBackup({ id: 'b-safe-10', origin: 'safety', isoTime: '2026-11-27T10:00:00.000Z' })
  seedBackup({ id: 'b-safe-11', origin: 'safety', isoTime: '2026-11-27T11:00:00.000Z' })
  seedBackup({ id: 'b-safe-12', origin: 'safety', isoTime: '2026-11-27T12:00:00.000Z' })
  // 该清的这份安全备份删不掉（原生侧各种「删不动」都走这条）
  removeFails.add(core.archiveFileName('b-safe-10'))
  removeFails.add(core.manifestFileName('b-safe-10'))

  const fresh = await api.runBackup('manual')

  // ① 备份本身是成功的：清理失败不许把「已经写好的备份」改判成失败
  assert.ok(backupIdsOnDisk().includes(fresh.id), '清理失败后新备份必须还在')
  const status = await api.getStatus()
  assert.equal(status.lastError, null, '清理失败不该写进用户可见的失败状态')
  assert.equal(status.count, 5, '删不掉就留着（宁多留），列表如实反映盘上有什么')
  // ② 每个文件名只尝试删一次（删不掉的东西不该在一次清理里被反复砸）
  assert.equal(removeCalls.get(core.archiveFileName('b-safe-10')), 1)
  assert.equal(removeCalls.get(core.manifestFileName('b-safe-10')), 1)
  // ③ 一份备份只留一条失败记录（旧实现是按文件刷日志 —— 两份文件就是两条同样的异常）
  await settle()
  const pruneErrors = diagCalls.filter((call) => call.message === 'backup: prune failed')
  assert.equal(pruneErrors.length, 1, '一次清理最多一条失败记录')
  assert.equal(pruneErrors[0].level, 'error')
})
