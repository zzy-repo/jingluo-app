// [layer: unit | dependencies: none | no build, browser, network or Android]
/**
 * 「数据备份与恢复」视图层的两条设备实测缺陷（#1007）。
 *
 * 两条都不是"页面崩了"，而是**界面在说与盘上事实不一致的话**，用户据此误判数据安全：
 *
 *  [1] 恢复列表被 `slice(0, 5)` 静默截断，而设置页「备份占用空间」一格显示的是**盘上真实份数**。
 *      盘上有 6–7 份时列表只列 5 条 —— 那两份"就是这么看起来消失的"。对备份功能来说，
 *      "看起来丢了"比"多显示一行"糟得多，所以：**露几条可以截，有没有不许截**。
 *      判据：列表能拿到全部 N 份（或有"还有 N 份"入口把差额说出来），且「共 N 份」这个
 *      真实数字**不被迁就**（迁就它就等于承认列表才是权威）。
 *
 *  [2] 低空间下「立即备份」失败 → 状态行「存储空间不足」；随后**恢复成功** → 两条并存
 *      「存储空间不足，暂时无法备份 已恢复完成」；直到下一次成功备份才消失。此时盘上
 *      `status.json` 的 `last_error` 已经是 null —— **盘上事实是好的，UI 在说旧话**。
 *      判据：后续成功过就不再播（失败发生在成功之后时必须照报，不许拿"以前成功过"来掩盖）。
 *
 * 分层边界：这里只钉**视图层的入参 → 出参**（该说哪句话 / 列表露几条），不渲染 React、
 * 不碰存储；真机与浏览器取证在 `docs/ui/1007-backup-ui/`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()
const {
  BACKUP_LIST_PREVIEW,
  failureIsStale,
  restoreListWindow,
  spaceValue,
  spaceView,
  statusView,
} = await loadTsModule('src/services/backup/backupView.ts')

/** 核心侧 `getStatus()` 的形状（只有本层关心的字段） */
const status = (patch = {}) => ({
  enabled: true,
  running: false,
  lastSuccessAtUtc: null,
  lastError: null,
  totalBytes: 0,
  count: 0,
  freeBytes: 10 * 1024 * 1024 * 1024,
  enoughForNext: true,
  ...patch,
})

/** 盘上第 n 份备份 */
const backupAt = (n) => ({
  id: `backup-${n}`,
  createdAtUtc: new Date(Date.UTC(2026, 10, 27, 6, 5, n)).toISOString(),
  sizeBytes: 43 * 1024 * 1024,
  checksumOk: true,
  sessionCount: 8 + n,
})

const sevenBackups = () => Array.from({ length: 7 }, (_, index) => backupAt(index + 1))

/** 一次交互的失败记录：记得它发生在哪一段、什么时候 */
const failedBackupAt = (atUtc) => ({
  kind: 'space',
  currentDataIntact: true,
  action: 'backup',
  atUtc,
})

const view = (patch = {}) =>
  statusView({ status: status(), phase: 'idle', done: 0, total: 0, failure: null, ...patch })

/* ------------------------------------------------------------------ [1] 列表不许把存在的备份藏起来 */

test('盘上 7 份时列表能拿到全部 7 份，且「共 7 份」这个真实数字不被迁就', () => {
  const items = sevenBackups()

  // 默认只露 5 条（列表不是管理页，一屏铺满不是它的职责）——但**差额必须说出来**
  const collapsed = restoreListWindow(items, false)
  assert.equal(collapsed.shown.length, BACKUP_LIST_PREVIEW)
  assert.equal(collapsed.hiddenCount, 2, '还有 2 份必须能算出来，界面才有地方给出入口')

  // 核心不变量：露出来的 + 没露出来的 = 盘上真实份数。少一条就是"看起来消失"
  assert.equal(collapsed.shown.length + collapsed.hiddenCount, items.length)

  // 展开后 7 份一条不少、顺序不变（用户点开就能看见那两份）
  const expanded = restoreListWindow(items, true)
  assert.equal(expanded.shown.length, 7)
  assert.equal(expanded.hiddenCount, 0)
  assert.deepEqual(
    expanded.shown.map((item) => item.id),
    items.map((item) => item.id)
  )

  // 「共 N 份」取自核心侧扫描结果，**不跟着列表截断**：7 就是 7
  const used = spaceValue(status({ count: items.length, totalBytes: items.length * 43 * 1024 * 1024 }))
  assert.equal(used.params.count, 7)
  assert.equal(used.params.size, '301 MB')
})

test('份数不足一屏时不留一个空的「还有 0 份」入口', () => {
  const items = [backupAt(1), backupAt(2)]
  const window = restoreListWindow(items, false)
  assert.equal(window.shown.length, 2)
  assert.equal(window.hiddenCount, 0)
  const single = restoreListWindow([], false)
  assert.equal(single.shown.length, 0)
  assert.equal(single.hiddenCount, 0)
})

test('刚好一屏（5 份）时也不多给一个入口', () => {
  const window = restoreListWindow(
    Array.from({ length: BACKUP_LIST_PREVIEW }, (_, index) => backupAt(index + 1)),
    false
  )
  assert.equal(window.shown.length, 5)
  assert.equal(window.hiddenCount, 0)
})

/* ------------------------------------------------------------------ [2] 成功之后不许继续说旧话 */

test('低空间备份失败之后恢复成功：不再渲染「存储空间不足」', () => {
  const failed = failedBackupAt('2026-11-27T10:00:00.000Z')

  // 失败当时：必须照报（这是盘上真发生过的失败）
  assert.equal(
    view({ status: status({ lastError: 'space', enoughForNext: false }), failure: failed }).key,
    'backupStatusSpace'
  )

  // 恢复成功之后：`status.json` 的 `last_error` 仍是 `space`（恢复不负责改写它），
  // 空间也已经被复核为够用 → 播报层不再说这句；界面记着的那次备份失败同样成了旧话
  const afterRestore = view({
    status: status({ lastError: null, lastSuccessAtUtc: '2026-11-27T09:30:00.000Z' }),
    failure: failed,
    succeededAtUtc: '2026-11-27T10:05:00.000Z',
  })
  assert.notEqual(afterRestore.key, 'backupStatusSpace')
  assert.equal(afterRestore.key, 'backupStatusIdle')
  assert.equal(afterRestore.error, undefined, '清掉之后不许还挂着红')
})

test('后续成功过也会清掉恢复失败的记录（备份成功同样算一次成功操作）', () => {
  const failedRestore = {
    kind: 'interrupted',
    currentDataIntact: true,
    action: 'restore',
    atUtc: '2026-11-27T10:00:00.000Z',
  }
  const afterBackup = view({
    status: status({ lastSuccessAtUtc: '2026-11-27T10:20:00.000Z' }),
    failure: failedRestore,
    succeededAtUtc: '2026-11-27T10:20:00.000Z',
  })
  assert.equal(afterBackup.key, 'backupStatusIdle')
})

test('没有任何后续成功操作时，那条失败必须继续报（不许把自愈逻辑改坏）', () => {
  const failed = failedBackupAt('2026-11-27T10:00:00.000Z')
  const stillBroken = status({ lastError: 'space', enoughForNext: false })

  // 没成功过
  assert.equal(view({ status: stillBroken, failure: failed }).key, 'backupStatusSpace')
  assert.equal(view({ status: stillBroken, failure: failed, succeededAtUtc: null }).key, 'backupStatusSpace')

  // 成功发生在失败**之前**：不算数（拿"很久以前成功过"来掩盖后来的失败就是粉饰）
  assert.equal(
    view({ status: stillBroken, failure: failed, succeededAtUtc: '2026-11-27T09:00:00.000Z' }).key,
    'backupStatusSpace'
  )

  // 界面没记交互失败、盘上仍是 space 时，也从盘上事实播报（这条与 #1002 的自愈同源，别改窄）
  assert.equal(view({ status: stillBroken }).key, 'backupStatusSpace')
})

test('时间戳坏掉时按「还该报」处理，宁可多说一句也不静默吞掉失败', () => {
  const broken = { ...failedBackupAt('not-a-date') }
  assert.equal(failureIsStale(broken, '2026-11-27T10:05:00.000Z'), false)
  assert.equal(failureIsStale(failedBackupAt('2026-11-27T10:00:00.000Z'), 'not-a-date'), false)
  assert.equal(failureIsStale(null, '2026-11-27T10:05:00.000Z'), false)
  assert.equal(failureIsStale(failedBackupAt('2026-11-27T10:00:00.000Z'), null), false)
})

/* ------------------------------------------------------------------ 两条修法都不许粉饰当前事实 */

test('失败播报可以收声，但「现在空间不够」这条真话一个字都不许少', () => {
  // 恢复成功只说明那一次操作成了；此刻盘上确实放不下下一份备份 → 空间提醒必须照旧出现
  const notice = spaceView(status({ count: 7, totalBytes: 7 * 43 * 1024 * 1024, enoughForNext: false }))
  assert.equal(notice.key, 'backupSpaceBlocked')
  assert.equal(notice.level, 'blocked')
  // 列表入口与空间提醒互不影响：占满 500 MB 该提醒就提醒，份数照实报
  const nudge = spaceView(status({ count: 7, totalBytes: 520 * 1024 * 1024, enoughForNext: true }))
  assert.equal(nudge.level, 'nudge')
  assert.equal(spaceValue(status({ count: 7, totalBytes: 520 * 1024 * 1024 })).params.count, 7)
})
