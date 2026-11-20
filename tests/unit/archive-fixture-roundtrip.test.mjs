// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <2s] Issue #32
//
// 夹具（tests/fixtures/domain05/archive-fixture.mjs）必须按真实导出顺序写条目，否则拿它做的
// 回归/设备用例会误报成「导入端 bug」。这里用**真实** checkArchiveFormat + importArchive
// 跑一遍 buildArchive 产物，把夹具顺序钉死：
//   [1] 8 会话 / 每会话 1 张 512KB 图片 → sessions === 8、files === 8、MIME 全是 image/png
//   [2] 40 会话同规模（设备用例的规模）→ 同上
// 未修夹具时这两条都会红在 backupIncomplete（第 2 个条目就死在 importArchive.ts:178）。
//
//   node tests/unit/archive-fixture-roundtrip.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importStagingDb, installImportEnv } from '../helpers/import-env.mjs'

// 装配走公共入口（#408 收尾批）：`./errors.js` 等价替身 + 只对 importArchive.ts 换掉 `../db.js`
// + `.js→.ts` 解析，全在 installImportEnv 里；假存储仍由本文件给（各文件的暂存语义不同）。
installImportEnv({ db: importStagingDb({ expose: '__archiveFixtureDB' }) })

const { checkArchiveFormat, importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { buildArchive } = await import('../fixtures/domain05/archive-fixture.mjs')
const db = globalThis.__archiveFixtureDB

/** 跑一遍「真实 check + 真实 import」，返回写进暂存的结果 */
const roundtrip = async (options) => {
  await db.clearStaging()
  const { zip, sessions } = buildArchive(options)
  const file = new File([zip], 'deepseek_data.zip', { type: 'application/zip' })
  await checkArchiveFormat(file)
  await importArchive(file)
  return {
    expectedSessions: sessions,
    sessions: db.stagingSessions.length,
    files: db.stagingFiles.size,
    types: [...db.stagingFileTypes.values()],
  }
}

const assertImported = (result, expected) => {
  assert.equal(
    result.sessions,
    expected,
    `必须有 ${expected} 个会话进暂存，实际 ${result.sessions}（夹具条目顺序与真实导出不一致时导入会中途失败）`
  )
  assert.equal(result.files, expected, `必须有 ${expected} 张图片进暂存，实际 ${result.files}`)
  assert.equal(result.types.length, expected, `必须有 ${expected} 条图片 MIME 回填，实际 ${result.types.length}`)
  assert.deepEqual(
    [...new Set(result.types)],
    ['image/png'],
    `图片 MIME 必须按 PNG magic bytes 认成 image/png，实际：${JSON.stringify([...new Set(result.types)])}`
  )
}

test('夹具 8 会话 / 每会话 512KB 图片：真实导入跑通，会话与图片一一对上', async () => {
  const result = await roundtrip({ sessionCount: 8, imageBytes: 512 * 1024 })
  assertImported(result, 8)
})

test('夹具 40 会话同规模（设备用例规模）：真实导入跑通', async () => {
  const result = await roundtrip({ sessionCount: 40, imageBytes: 512 * 1024 })
  assertImported(result, 40)
})
