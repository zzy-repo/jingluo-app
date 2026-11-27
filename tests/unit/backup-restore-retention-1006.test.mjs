// [layer: unit | 恢复路径的保留清理（#1006）：恢复成功后**两组都清**，「恢复完立刻看设置页」必须回到 3+2=5 份]
//
// 背景（设备实测，emulator-5554）：备份目录的上限是 3 常规 + 2 安全 = 5 份，但**连续做恢复**时实测
// 走到 5 → 6 → 7 份然后稳在 7。原因不是「上限没写」，而是**清理的触发点**：
//   ① 恢复流程只在**前半段**调 `applyRetention('safety')`（只清安全组）；
//   ② 常规组**只有「常规备份成功」时**才清（`runBackup` → `prune: true`）；
//   ③ 盘上老版本写的清单**没有 `origin` 字段**，按约定一律算常规备份。
// 于是老用户升级后只要不点「立即备份」，连着恢复几次就多出几份「永远不清的常规备份」，
// 而设置页显示的是真实份数 —— 用户看到的就是「清理没生效」。
//
// 修法（本文件的断言对象）：恢复 ②③④ 全部成功之后，对**两组**各清一次（等价 `applyRetention('all')`）。
//
// 这一层钉的是**行为**，不读源码做断言：
//   [1] 3 常规 + 2 安全 → 恢复后 +1 安全，清理后总数**仍是 5**，删的是最老的那份安全备份，最新份在；
//   [2] 老清单（无 `origin`）混新清单（设备现场 7 份）→ 恢复一次就收敛到 5；
//   [3] 只剩 1 份可恢复备份（其余校验不过）→ **一份都不删**（底线优先于上限）；
//   [4] 清理抛错（`remove` 抛错）→ 恢复**仍然成功**，删不掉的留着，常规组的清理确实跑过；
//   [5] 恢复**失败**时不许清理 → 常规备份一份都不能少（「不能先删后恢复」）。
//
// 替身与 `backup-core-993` / `backup-safety-retention-1005` 共用 `helpers/backup-bridge.mjs`（进程内
// 唯一的那一份）：`removeCalls` / `removeFails` 就是这里观测「清理到底动了谁」的两个窗口。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { backupBridge } from '../helpers/backup-bridge.mjs'
import { installTsResolve, inlineModule, loadTsModule } from '../helpers/dom-env.mjs'

const native = backupBridge
const { committed, removeCalls, removeFails } = native
native.install()

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const diagCalls = []
globalThis.__diag = diagCalls
const importCalls = []
globalThis.__importCalls = importCalls
globalThis.__nextSessions = 3
globalThis.__exportFails = false
globalThis.__importFails = false

const chatStub = inlineModule(
  [
    'export const exportHistory = async () => {',
    "  if (globalThis.__exportFails) { throw new Error('export boom') }",
    '  const sessions = globalThis.__nextSessions',
    "  const blob = new Blob([Buffer.from('archive:' + sessions + ':' + 'x'.repeat(48))])",
    "  return { name: 'deepseek_data-test.zip', blob, sessions }",
    '}',
    'export const importHistory = async (file, options) => {',
    '  globalThis.__importCalls.push({ size: file.size, mode: options && options.mode })',
    "  if (globalThis.__importFails) { throw new Error('import boom') }",
    "  return { count: 1, mode: 'overwrite', added: 1, overwritten: 0, skipped: 0 }",
    '}',
  ].join('\n')
)

const diagStub = inlineModule(
  [
    'export const record = (kind, level, message, meta) => { globalThis.__diag.push({ level, message, meta }) }',
    'export const recordError = (message, meta) => { globalThis.__diag.push({ level: "error", message, meta }) }',
    'export const recordAction = () => ({})',
  ].join('\n')
)

const attachmentStub = inlineModule(
  [
    'export const listAttachments = async () => []',
    'export const readAttachmentBlob = async () => undefined',
    'export const putAttachment = async () => {}',
  ].join('\n')
)

const archiveStub = inlineModule(
  [
    'export const writeArchive = async () => new Blob([])',
    'export const readArchive = async function* () {}',
    'export const readEntry = async () => new Blob([])',
    'export const saveFiles = async () => {}',
  ].join('\n')
)

/** 裸模块名之外的替身：按说明符直查（第一条命中即用，顺序即优先级） */
const SPECIFIER_STUBS = new Map([
  ['../chat/backup.js', chatStub],
  ['../diagnostics/collector.js', diagStub],
  ['../attachments/store.js', attachmentStub],
])

installTsResolve({
  stubs: {
    '@capacitor/core': inlineModule(
      [
        'export const Capacitor = { isNativePlatform: () => globalThis.__native === true }',
        'export const registerPlugin = () => globalThis.__bridge',
      ].join('\n')
    ),
  },
  onResolve: (specifier, context) => {
    const direct = SPECIFIER_STUBS.get(specifier)
    if (direct) {
      return direct
    }
    // 备份服务自己的归档读写（`../chat/history/*`）：恢复需要 `writeArchive` / 读归档分块
    if (context?.parentURL?.includes('/services/backup/') && specifier.startsWith('../chat/')) {
      return archiveStub
    }
    return undefined
  },
})

const core = await loadTsModule('src/services/backup/backupCore.ts')
const api = await loadTsModule('src/services/backup/backupApi.ts')
const limits = await loadTsModule('src/services/backup/limits.ts')

/** 每条用例开头：盘清空、注入开关归位、观测容器清空（容器本身是共享的，只清不换） */
const reset = () => {
  native.reset()
  diagCalls.length = 0
  importCalls.length = 0
  globalThis.__nextSessions = 3
  globalThis.__exportFails = false
  globalThis.__importFails = false
}

/** 盘上还在的备份 id（有清单 = 一份可恢复的备份），按 id 排序便于直接比数组 */
const idsOnDisk = () =>
  [...committed.keys()]
    .map((name) => core.parseManifestFileName(name))
    .filter((id) => id !== null)
    .sort()

/**
 * 往内存盘上播种一份「看起来像真备份」的文件。
 *
 * 与 `backup-safety-retention-1005` 那份的区别：这里**算真 sha256**（归档字节的摘要），
 * 所以这份备份能被 `restoreBackup` 当恢复目标整档校验通过 —— 本文件的用例要真的走一遍恢复。
 *
 * `corrupt: true` 时故意让清单声明的 `size_bytes` 比落盘字节多 1：`scanBackups` 会判
 * `checksumOk: false`（「看着像备份，其实不可恢复」），用来造「只剩 1 份可恢复备份」的场景。
 */
const seed = ({ id, isoTime, origin, sessions = 2, bytes = 32, corrupt = false }) => {
  const content = Buffer.alloc(bytes, 0x41)
  const manifest = {
    backup_format_version: core.BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: isoTime,
    archive: { name: core.archiveFileName(id), size_bytes: corrupt ? bytes + 1 : bytes, sha256: sha256(content) },
    attachments: null,
    data_summary: { sessions, attachments: 0 },
    verified: true,
    // 老清单（#1005 之前写的）没有这个字段 —— 传 undefined 时**不能**凭空补一个 `origin`
    ...(origin === undefined ? {} : { origin }),
  }
  committed.set(core.archiveFileName(id), content)
  committed.set(core.manifestFileName(id), Buffer.from(JSON.stringify(manifest), 'utf8'))
  return id
}

/**
 * 等一个**终态**而不是固定 sleep（`docs/TESTING-POLICY.md` §11.5）：诊断日志是 fire-and-forget 的
 * 动态 import，落地时刻不确定 —— 固定 sleep 在快慢不同的 runner 上结论会漂（批内绿、单跑红）。
 */
const until = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      return false
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return true
}

/** 同一天的整点（UTC），`hour` 越大越新；年份用 2026-01，保证比「现在」老（新安全备份永远是最新的） */
const at = (hour) => new Date(Date.UTC(2026, 0, 1, hour, 0, 0)).toISOString()

/** 设备现场的「稳定态」：3 常规 + 2 安全 = 5 份（全部带 `origin`，是新版本写的清单） */
const seedSteadyState = () => {
  seed({ id: 'b-reg-09', isoTime: at(9), origin: 'manual' })
  seed({ id: 'b-reg-10', isoTime: at(10), origin: 'auto' })
  seed({ id: 'b-reg-11', isoTime: at(11), origin: 'manual' })
  seed({ id: 'b-saf-12', isoTime: at(12), origin: 'safety' })
  seed({ id: 'b-saf-13', isoTime: at(13), origin: 'safety' })
}

/** 设备现场的**缺陷态**：5 份老清单（无 `origin` → 一律算常规）+ 2 份新安全备份 = 7 份 */
const seedLegacyState = () => {
  for (const hour of [9, 10, 11, 12, 13]) {
    seed({ id: `b-old-${hour < 10 ? `0${hour}` : hour}`, isoTime: at(hour) })
  }
  seed({ id: 'b-saf-14', isoTime: at(14), origin: 'safety' })
  seed({ id: 'b-saf-15', isoTime: at(15), origin: 'safety' })
  return 'b-old-13'
}

/* ------------------------------------------------------------------ [1] 5 份 → 恢复 → 仍是 5 份 */

test('[1] 3 常规 + 2 安全：恢复后再落 1 份安全备份，清理后总数仍是 5，删的是最老那份', async () => {
  reset()
  seedSteadyState()
  assert.equal(idsOnDisk().length, 5, '初始 3 常规 + 2 安全')

  await api.restoreBackup('b-reg-11')

  const ids = idsOnDisk()
  assert.equal(ids.length, 5, '恢复完必须仍是 5 份（上限 3 常规 + 2 安全），不是 6')
  // 删的是最老的那份**安全**备份（12 点）；常规组 3 份 ≤ 3，一份都不许动
  assert.ok(!ids.includes('b-saf-12'), '超出安全上限的最老一份必须被清掉')
  assert.ok(ids.includes('b-saf-13'), '次新的安全备份留着')
  for (const id of ['b-reg-09', 'b-reg-10', 'b-reg-11']) {
    assert.ok(ids.includes(id), `常规备份 ${id} 不许被恢复路径删掉`)
  }
  // 刚写的那份安全备份（= 这次恢复的退路）必须还在，而且是最新的
  const newest = (await api.listBackups())[0]
  assert.ok(ids.includes(newest.id), '最新的一份备份永不删')
  assert.equal((await api.listBackups()).filter((entry) => /^b-20\d{6}/.test(entry.id)).length, 1)
  // 清理只碰了那份安全备份的两个文件：常规备份一个字节都没动
  assert.deepEqual(
    [...removeCalls.keys()].sort(),
    [core.archiveFileName('b-saf-12'), core.manifestFileName('b-saf-12')].sort(),
    '清理只动了超上限的那一份'
  )
  // 设置页「共 N 份」读的就是这个数：恢复完立刻看，必须是 5
  const status = await api.getStatus()
  assert.equal(status.count, 5)
  assert.equal(status.lastError, null)
})

/* ------------------------------------------------------------------ [2] 老清单混合 → 收敛到 5（本次缺陷） */

test('[2] 老清单（无 origin）混新清单：设备现场 7 份，恢复一次就收敛到 5', async () => {
  reset()
  const target = seedLegacyState()
  assert.equal(idsOnDisk().length, 7, '设备实测的稳定态：5 份老清单 + 2 份安全备份')

  await api.restoreBackup(target)

  const ids = idsOnDisk()
  assert.equal(ids.length, 5, '两组都清之后总量必须回到 3 + 2 = 5（未修前这里是 7、甚至 8）')
  // 老清单按常规处理（语义不变）：常规组 5 份 > 3 → 清掉最老的两份
  assert.deepEqual(
    ids.filter((id) => id.startsWith('b-old-')),
    ['b-old-11', 'b-old-12', 'b-old-13'],
    '常规组只留最近 3 份，且不是「假装老清单是安全份」'
  )
  // 安全组照旧按 K=2：最老的那份 14 点被清掉，15 点与新写的那份留下
  assert.ok(!ids.includes('b-saf-14'), '安全组超出上限的最老一份被清掉')
  assert.ok(ids.includes('b-saf-15'))
  const newest = (await api.listBackups())[0]
  assert.ok(ids.includes(newest.id), '最新一份（本次恢复写下的安全备份）不许删')

  // 盘上真的少了三份，不是只在列表里藏起来
  for (const gone of ['b-old-09', 'b-old-10', 'b-saf-14']) {
    assert.equal(committed.get(core.archiveFileName(gone)), undefined, `${gone} 的归档必须从盘上消失`)
    assert.equal(committed.get(core.manifestFileName(gone)), undefined, `${gone} 的清单必须从盘上消失`)
  }
  const status = await api.getStatus()
  assert.equal(status.count, 5, '设置页显示的份数必须跟着收敛')
  assert.equal(status.lastError, null)
})

/* ------------------------------------------------------------------ [3] 只剩 1 份可恢复：一份都不删 */

test('[3] 只剩 1 份可恢复备份（其余校验不过）：底线优先于上限，一份都不删', async () => {
  reset()
  // 唯一可恢复的那份是**最老**的：按常规组上限（3 份）它正好排在「该删」的位置
  seed({ id: 'b-only-09', isoTime: at(9), origin: 'manual' })
  // 三份看着像备份、其实校验不过（清单声明的字节数与落盘不一致）→ checksumOk: false
  seed({ id: 'b-bad-10', isoTime: at(10), origin: 'manual', corrupt: true })
  seed({ id: 'b-bad-11', isoTime: at(11), origin: 'manual', corrupt: true })
  seed({ id: 'b-bad-12', isoTime: at(12), origin: 'manual', corrupt: true })
  const usable = await api.listBackups()
  assert.equal(usable.filter((entry) => entry.checksumOk).length, 1, '盘上只有一份可恢复的备份')

  await api.restoreBackup('b-only-09')

  // 「删完就一份可恢复的都不剩」是任何清理都不许越过的底线：这里一份都不该动
  assert.equal(removeCalls.size, 0, '不该尝试删除任何文件（底线优先于上限）')
  const ids = idsOnDisk()
  assert.ok(ids.includes('b-only-09'), '唯一可恢复的那份绝对不许删')
  for (const id of ['b-bad-10', 'b-bad-11', 'b-bad-12']) {
    assert.ok(ids.includes(id), `${id} 不在清理候选里（安全组只动 origin === 'safety'）`)
  }
  assert.equal(ids.length, 5, '4 份播种 + 这次恢复写下的 1 份安全备份')
  assert.equal((await api.getStatus()).lastError, null)
})

/* ------------------------------------------------------------------ [4] 清理抛错 → 恢复仍成功 */

test('[4] 清理抛错（remove 失败）：恢复仍然成功，删不掉的留着，常规组确实清理过', async () => {
  reset()
  const target = seedLegacyState()
  // 该清的最老一份常规备份删不掉（原生侧各种「删不动」都走这条）
  removeFails.add(core.archiveFileName('b-old-09'))
  removeFails.add(core.manifestFileName('b-old-09'))

  const result = await api.restoreBackup(target)

  // ① 恢复本身成功：清理失败不许把已经成功的恢复改判成失败
  assert.deepEqual(result, { attachmentsRestored: true, attachmentCount: 0 })
  const status = await api.getStatus()
  assert.equal(status.lastError, null, '清理失败不该写进用户可见的失败状态')
  // ② 删不掉的留着（宁多留），另一份照样被清掉 —— 证明常规组的清理确实跑了
  const ids = idsOnDisk()
  assert.ok(ids.includes('b-old-09'), '删不掉就留着，不许谎报已清理')
  assert.ok(!ids.includes('b-old-10'), '同一轮里删得掉的那份照清（常规组清理确实执行）')
  assert.equal(removeCalls.get(core.archiveFileName('b-old-09')), 1, '同一个文件只尝试一次')
  // ③ 一次清理最多一条失败记录
  const pruneErrors = () => diagCalls.filter((call) => call.message === 'backup: prune failed')
  assert.equal(await until(() => pruneErrors().length >= 1), true, '清理失败必须留下一条错误日志')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pruneErrors().length, 1, '一份备份只留一条失败记录（不是按文件刷两条）')
})

/* ------------------------------------------------------------------ [5] 恢复失败 → 不做清理 */

test('[5] 恢复失败（导入抛错）：常规备份一份都不许被清掉（不能先删后恢复）', async () => {
  reset()
  const target = seedLegacyState()
  globalThis.__importFails = true

  await assert.rejects(api.restoreBackup(target), (error) => {
    assert.equal(typeof error.code, 'string', '失败要以 BackupError 分类报出来')
    return true
  })

  const ids = idsOnDisk()
  // 恢复没成功 → 总量收口那一步一分钟都不许跑：常规组原封不动
  for (const id of ['b-old-09', 'b-old-10', 'b-old-11', 'b-old-12', 'b-old-13']) {
    assert.ok(ids.includes(id), `恢复失败时 ${id} 必须先留着（下次还可能是恢复目标）`)
    assert.equal(removeCalls.get(core.archiveFileName(id)), undefined, `${id} 不该被尝试删除`)
  }
  // 失败路径也不把这次写下的安全备份删掉（它是下一次的退路）
  assert.equal(ids.filter((id) => !id.startsWith('b-old-') && !id.startsWith('b-saf-1')).length, 1)
})
