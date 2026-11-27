// [layer: unit | dependencies: none | no build, browser, network or Android]
/**
 * 「数据备份与恢复」视图层（#993 任务 3）。
 *
 * 全部是**行为级**断言：喂状态 / 异常进去，看「该说哪句话」「按钮能不能点」。
 * 不 grep 源码、不看类名，这样文案改词、实现换人都不影响用例成立。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// src 内部用打包器口径的 `./x.js` 引 `.ts`，单跑本文件时补一个解析 hook（与 run-layer 同口径）
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

const {
  canRestoreBackup,
  canRunBackup,
  failureOf,
  failureText,
  formatSize,
  itemLine,
  progressPercent,
  spaceValue,
  spaceView,
  statusView,
  SPACE_WARN_BYTES,
} = await import('../../src/services/backup/backupView.ts')

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

const item = (patch = {}) => ({
  id: 'a',
  createdAtUtc: '2026-11-27T06:05:00.000Z',
  sizeBytes: 1024 * 1024,
  checksumOk: true,
  sessionCount: 12,
  ...patch,
})

const view = (patch = {}) =>
  statusView({ status: status(), phase: 'idle', done: 0, total: 0, failure: null, ...patch })

test('从没备份过时提示去备份一次，成功过就显示一切正常', () => {
  assert.equal(view().key, 'backupStatusNever')
  assert.equal(view({ status: status({ lastSuccessAtUtc: '2026-11-27T06:05:00.000Z' }) }).key,
    'backupStatusIdle')
})

test('备份进行中显示百分比进度，进度还没定下来时不留假 0%', () => {
  const running = view({ phase: 'backup', done: 3, total: 4 })
  assert.equal(running.key, 'backupStatusRunning')
  assert.equal(running.params.percent, 75)
  assert.equal(running.percent, 75)
  assert.equal(view({ phase: 'backup', done: 0, total: 0 }).key, 'backupStatusRunningNoPercent')
  assert.equal(progressPercent(1, 0), null)
})

test('上次失败按分类说人话：空间不足 / 没做完 / 读不到，都不是「失败」两个字', () => {
  assert.equal(view({ status: status({ lastError: 'space' }) }).key, 'backupStatusSpace')
  assert.equal(
    view({ status: status({ lastError: 'interrupted' }) }).key,
    'backupStatusInterrupted'
  )
  assert.equal(view({ status: status({ lastError: 'whatever' }) }).key, 'backupStatusUnavailable')
})

test('没有记录可备份 / 环境不支持备份：不标红，也不当成失败', () => {
  const empty = failureText({ kind: 'empty', currentDataIntact: true }, 'backup')
  assert.equal(empty.key, 'backupStatusEmpty')
  assert.equal(empty.error, undefined)
  const unsupported = failureText({ kind: 'unsupported', currentDataIntact: true }, 'backup')
  assert.equal(unsupported.key, 'backupStatusUnsupported')
  assert.equal(unsupported.error, undefined)
})

test('空间不足时把「立即备份」置灰（不留一个点了会报错的按钮）', () => {
  assert.equal(canRunBackup(status(), 'idle'), true)
  assert.equal(canRunBackup(status({ lastError: 'unsupported' }), 'idle'), false)
  assert.equal(canRunBackup(status({ enoughForNext: false }), 'idle'), false)
})

test('正在跑的时候按钮必须点不动（防重复点击）', () => {
  assert.equal(canRunBackup(status(), 'backup'), false)
  assert.equal(canRunBackup(status({ running: true }), 'idle'), false)
  assert.equal(canRunBackup(null, 'idle'), false)
  assert.equal(canRestoreBackup(status(), 'restore', [item()]), false)
})

test('恢复失败按 currentDataIntact 分档：只有明确完好才敢说「数据还在」', () => {
  const intact = failureText({ kind: 'interrupted', currentDataIntact: true }, 'restore')
  assert.equal(intact.key, 'backupStatusRestoreFailedIntact')

  // 拿不准（false）绝不能承诺安全，也不许复用「数据还在」那句话
  const unsure = failureText({ kind: 'interrupted', currentDataIntact: false }, 'restore')
  assert.equal(unsure.key, 'backupStatusRestoreFailedUnknown')
  assert.notEqual(unsure.key, intact.key)

  // 异常对象里没有明确 true 时，一律按「不确定」处理
  assert.equal(failureOf(new Error('boom')).currentDataIntact, false)
  assert.equal(failureOf({ code: 'corrupt' }).currentDataIntact, false)
})

test('安全备份没做成是「本次恢复没有开始」，不是失败', () => {
  const aborted = failureText({ kind: 'safety-backup-failed', currentDataIntact: true }, 'restore')
  assert.equal(aborted.key, 'backupStatusAborted')
})

test('备份包损坏时不给恢复，直接说无法用于恢复', () => {
  assert.equal(
    failureText({ kind: 'corrupt', currentDataIntact: true }, 'restore').key,
    'backupStatusCorrupt'
  )
  assert.equal(canRestoreBackup(status({ count: 1 }), 'idle', [item({ checksumOk: false })]), false)
  assert.equal(canRestoreBackup(status({ count: 1 }), 'idle', null), true)
})

test('占满 500 MB 才提醒，剩余空间不够的提醒优先', () => {
  assert.equal(SPACE_WARN_BYTES, 500 * 1024 * 1024)
  assert.equal(spaceView(status({ totalBytes: SPACE_WARN_BYTES - 1, count: 3 })), null)
  const nudge = spaceView(status({ totalBytes: SPACE_WARN_BYTES, count: 3 }))
  assert.equal(nudge.key, 'backupSpaceNudge')
  assert.equal(nudge.level, 'nudge')
  assert.equal(nudge.params.size, '500 MB')

  const blocked = spaceView(status({ totalBytes: 1024, count: 2, enoughForNext: false }))
  assert.equal(blocked.key, 'backupSpaceBlocked')
  assert.equal(blocked.level, 'blocked')
})

test('占用空间与体积换算说人话', () => {
  assert.equal(spaceValue(status()).key, 'backupSpaceNone')
  const used = spaceValue(status({ totalBytes: 2 * 1024 * 1024, count: 2 }))
  assert.equal(used.params.size, '2 MB')
  assert.equal(used.params.count, 2)
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(1536), '2 KB')
  assert.equal(formatSize(1024 * 1024 * 1024), '1 GB')
})

test('恢复列表一行有时间和大小，核心侧给不出条数就不显示条数', () => {
  assert.equal(itemLine(item()).key, 'backupRestoreItemLine')
  assert.equal(itemLine(item()).params.count, 12)
  assert.equal(itemLine(item({ sessionCount: 0 })).key, 'backupRestoreItemLineNoCount')
})

test('用户可见文案里不出现存储实现名、表结构、路径、校验算法与异常栈', () => {
  const zhFile = readFileSync(path.join(process.cwd(), 'src/i18n/zh.ts'), 'utf8')
  // 只看「数据备份与恢复」这一段文案（本文件负责的那几条 key）
  const start = zhFile.indexOf('backupSectionTitle')
  const zh = zhFile.slice(start, zhFile.indexOf('historyDeleting', start))
  assert.ok(zh.length > 500, '备份文案段落没找到，扫描范围失效')
  const banned = [
    'IndexedDB',
    'indexeddb',
    'SQLite',
    'sqlite',
    '数据库',
    'schema',
    '校验和',
    '哈希',
    '哈希值',
    'db.ts',
    'localStorage',
    'Error:',
    'stack',
  ]
  for (const word of banned) {
    assert.equal(zh.includes(word), false, `文案里不该出现「${word}」`)
  }
})
