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
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 假 db：IndexedDB 在裸 Node 里不存在。这里只替换存储边界，importArchive 本身全是真实代码。
// 记下暂存会话、暂存图片字节与回填的 MIME，用来断言「会话数 / 图片数 / 图片类型」。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const stagingFiles = new Map()
export const stagingFileTypes = new Map()
export const clearStaging = async () => {
  stagingSessions.length = 0
  stagingFiles.clear()
  stagingFileTypes.clear()
}
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async (files) => {
  for (const file of files) {
    stagingFiles.set(file.id, file.blob)
  }
}
export const updateStagingFileTypes = async (types) => {
  for (const [id, type] of types) {
    stagingFileTypes.set(id, type)
  }
}
export const loadFile = async () => undefined
export const loadSession = async () => undefined
export const saveSession = async () => {}
globalThis.__archiveFixtureDB = { stagingSessions, stagingFiles, stagingFileTypes, clearStaging }
`)}`

// 真实 errors.ts 用了 TS 参数属性（node 的 strip-only 模式不支持），用仓库既有的等价替身：
// key / params 原样带出，message 用真实 zh 文案渲染。
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './errors.js') {
      return { url: errorsStub, shortCircuit: true }
    }
    if (specifier === '../db.js' && String(context.parentURL ?? '').endsWith('/history/importArchive.ts')) {
      return { url: fakeDB, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

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
