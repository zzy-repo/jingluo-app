// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <2s] Issue #32
//
// 夹具（tests/fixtures/domain05/archive-fixture.mjs）必须按真实导出顺序写条目，否则拿它做的
// 回归/设备用例会误报成「导入端 bug」。这里用**真实** checkArchiveFormat + importArchive
// 跑一遍 buildArchive 产物，把夹具顺序钉死：
//   [1] 8 会话 / 每会话 1 张 512KB 图片 → sessions === 8、files === 8、MIME 全是 image/png
//   [2] 40 会话同规模（设备用例的规模）→ 同上
//   [3] 反向：同一份 20MB 夹具 + **空间不可测** → 必须在写第一条之前被拒，文案是
//       「暂时无法确认本机剩余空间」（#1002 的 P0 语义）
// 未修夹具时这两条都会红在 backupIncomplete（第 2 个条目就死在 importArchive.ts:178）。
//
// 为什么 [2] 要装「空间可测」的探针（#1002 之后）：裸 Node 里既没有 `navigator.storage.estimate()`
// 也没有原生 `freeBytes()` → 空间一律「未知」；而 40 会话夹具解压后约 20MB，超过
// `SMALL_IMPORT_PAYLOAD_BYTES`(16MiB) 那档 → 按分级口径必然 `unverifiable` 拒绝。也就是说
// 不装探针的话，这条用例根本没跑到「往返」就红在闸门上了 —— 红的是夹具的环境，不是夹具的顺序。
// 探针注入点与装配方式照抄 `tests/unit/import-space-native-gate.test.mjs`（`setNativeFreeBytesReader`）。
// 反过来，[3] 就是这条「装探针」的反向对照：**不许**把夹具改成「默认够用」，闸门必须还在。
// 注：注入点是模块级单例，两个用例各自 `try/finally` 装卸，避免污染同批次的其它文件。
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
const quota = await import('../../src/services/chat/history/quotaPrecheck.ts')
const { buildArchive } = await import('../fixtures/domain05/archive-fixture.mjs')
const db = globalThis.__archiveFixtureDB

/** 「可信且够用」的原生可用字节：8GiB，远大于 20MB 夹具那点 need（含写放大与安全系数）。 */
const FREE_BYTES_ENOUGH = 8 * 1024 * 1024 * 1024

/**
 * 装 / 卸「原生可用字节」读物（`#1002` 空间闸门的注入点，见文件头）。
 * `reader` 返回 `null` = **读不到**（按「未知」分级），返回数字 = 可信测量。
 */
const withNativeFreeBytes = (reader) => {
  quota.setNativeFreeBytesReader(reader)
  return () => quota.setNativeFreeBytesReader(undefined)
}

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
  // 空间改成**可信且够用**的测量，闸门才不会把这条用例挡在门外（见文件头 [2] 的说明）。
  const restore = withNativeFreeBytes(async () => FREE_BYTES_ENOUGH)
  try {
    const result = await roundtrip({ sessionCount: 40, imageBytes: 512 * 1024 })
    assertImported(result, 40)
  } finally {
    restore()
  }
})

test('空间不可测 + 20MB 夹具：写第一条之前就被拒，文案是「无法确认剩余空间」而不是「空间不足」', async () => {
  // 反向对照：与 [2] 同一份夹具，只把「空间」从可信改成读不到。
  const restore = withNativeFreeBytes(async () => null)
  try {
    await db.clearStaging()
    const { zip } = buildArchive({ sessionCount: 40, imageBytes: 512 * 1024 })
    const file = new File([zip], 'deepseek_data.zip', { type: 'application/zip' })
    await checkArchiveFormat(file)
    const error = await importArchive(file).then(
      () => null,
      (reason) => reason
    )
    assert.ok(
      error,
      '空间读不到 + 20MB 负载必须拒绝（#1002 的 P0 语义：大负载不能拿试错换，一次写坏是整库重建）'
    )
    assert.equal(
      error.key,
      'historyImportSpaceUnverifiable',
      `拒绝理由必须是「空间不可测」那一档，实际 key=${String(error.key)}`
    )
    assert.match(
      String(error.message),
      /暂时无法确认本机剩余空间/,
      `文案必须说「无法确认剩余空间」，不许说成「空间不足」（那是在撒谎，用户会去清无用空间）：${error.message}`
    )
    assert.doesNotMatch(String(error.message), /剩余空间不足/, `「不可测」档不许复用「空间不足」的文案：${error.message}`)
    // 「这次没有写入任何数据」这句文案必须是真的：暂存一条都没有。
    assert.equal(db.stagingSessions.length, 0, `被拒时暂存必须为空，实际 ${db.stagingSessions.length} 条会话`)
    assert.equal(db.stagingFiles.size, 0, `被拒时暂存必须为空，实际 ${db.stagingFiles.size} 张图片`)
  } finally {
    restore()
  }
})
