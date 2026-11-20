// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <2s] Issue #390
//
// 选择性导出（#390 第一半）：**只导出勾选的会话**，且产物必须还是同一种包（能被自己导入）。
//
// 钉住的四件事：
//   [1] 全量导出：不传 sessionIds → 全部会话都在包里（原有行为不回退）
//   [2] 选择导出：只写勾中的会话 —— manifest / index / 会话 JSON / 图片条目都只属于它们
//   [3] 空选择：`sessionIds: []` 与「一个 id 都对不上」都要明确报错（historyExportEmptySelection），
//       不能产出一个「看着像备份、其实一条会话都没有」的包
//   [4] 往返：选中导出的包喂给**真实 importArchive** 能完整导入，且只导入勾中的那几条
//
// 这里刻意不重写 ZIP 解析：导出侧用真实 zipWriter，导入侧用真实 importArchive + 真实 schema，
// 只把 IndexedDB（`../db.js`）换成内存假存储 —— 与 tests/unit/archive-fixture-roundtrip 同一套口径。
//
//   node --test tests/unit/export-selection-390.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strFromU8, unzipSync } from 'fflate'
import { installBuildDefines, installHooks } from '../fixtures/domain05/hooks.mjs'

/** 导出侧存储：原件按附件 id 取；没有原件的附件返回 undefined（与真实 db 一致） */
const exportDb = `data:text/javascript,${encodeURIComponent(`
export const originals = new Map()
export const loadFile = async (id) => originals.get(id)
export const loadSession = async () => undefined
export const clearStaging = async () => {}
export const saveSession = async () => {}
export const reportStorageError = () => () => {}
globalThis.__selectionExportDB = { originals }
`)}`

/** 导入侧暂存：会话数组 + 图片字节 + MIME 回填，全部只存在内存里 */
const stagingDb = `data:text/javascript,${encodeURIComponent(`
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
globalThis.__selectionImportDB = { stagingSessions, stagingFiles, stagingFileTypes, clearStaging }
`)}`

/** 真实 errors.ts 用了 TS 参数属性（node strip-only 跑不了）：换等价替身，文案仍取自真实 zh.ts */
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href
/** diagnostics 采集层依赖 DOM / 原生桥：本层只关心「写了什么」，换成内存替身 */
const collectorStub = new URL('../fixtures/url-import-stubs/collector.mjs', import.meta.url).href

installHooks((specifier, parent) => {
  if (specifier === './errors.js' || specifier === './history/errors.js') {
    return errorsStub
  }
  if (specifier === '../../diagnostics/collector.js') {
    return collectorStub
  }
  // IndexedDB 在裸 Node 里不存在：只替换两个被测模块的存储边界，其余链路保持真实源码
  if (specifier === '../db.js' && parent.endsWith('/history/exportArchive.ts')) {
    return exportDb
  }
  if (specifier === '../db.js' && parent.endsWith('/history/importArchive.ts')) {
    return stagingDb
  }
  return null
})
await installBuildDefines()

const { exportArchive } = await import('../../src/services/chat/history/exportArchive.ts')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const exportDB = globalThis.__selectionExportDB
const importDB = globalThis.__selectionImportDB

const TIME = '2026-11-01T00:00:00.000Z'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/** 本地会话（Session 形状，与 domain05-export-contract 的构造一致）：一条问答 + 可选一张图片 */
const session = ({ id, title, imageId }) => ({
  id,
  title,
  createdAt: Date.parse(TIME),
  updatedAt: Date.parse(TIME),
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: Date.parse(TIME),
      content: `问题 ${title}`,
      files: imageId
        ? [
            {
              id: imageId,
              serverId: null,
              name: 'image.png',
              size: PNG.byteLength,
              isImage: true,
              mimeType: 'image/png',
            },
          ]
        : [],
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: Date.parse(TIME) + 1,
      model: null,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: `回答 ${title}` }],
    },
  ],
})

const SESSIONS = [
  session({ id: 's-1', title: '勾中甲', imageId: 'file-1' }),
  session({ id: 's-2', title: '不勾乙', imageId: 'file-2' }),
  session({ id: 's-3', title: '勾中丙', imageId: 'file-3' }),
]

for (const item of SESSIONS) {
  for (const message of item.messages) {
    for (const file of message.files ?? []) {
      exportDB.originals.set(file.id, new Blob([PNG]))
    }
  }
}
// 图片条目名由 exportArchive 按 `${fileId}_${name}` 生成
const imageEntry = (sessionId, fileId) => `chat_sessions/${sessionId}_files/${fileId}_image.png`

/** 解开导出产物：条目名、manifest、index、会话 JSON、图片条目 */
const unpack = async (blob) => {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  const names = Object.keys(entries)
  const read = (name) => JSON.parse(strFromU8(entries[name]))
  return {
    names,
    manifest: read('manifest.json'),
    index: read('chat_session_index.json'),
    sessions: names
      .filter((name) => /^chat_sessions\/[^/]+\.json$/.test(name))
      .map((name) => read(name)),
    images: names.filter((name) => /_files\//.test(name)),
  }
}

test('全量导出：不传 sessionIds 时全部会话都在包里（原有行为不回退）', async () => {
  const archive = await unpack(await exportArchive(SESSIONS))
  assert.equal(archive.names[0], 'manifest.json', 'manifest 必须仍是第一条')
  assert.deepEqual(
    archive.sessions.map((item) => item.id).sort(),
    ['s-1', 's-2', 's-3'],
    '全量导出必须包含全部会话'
  )
  assert.equal(archive.index.length, 3, 'index 必须与会话一一对应')
})

test('选择导出：只写勾中的会话，图片条目也只属于勾中的会话', async () => {
  const archive = await unpack(await exportArchive(SESSIONS, { sessionIds: ['s-1', 's-3'] }))
  assert.equal(archive.names[0], 'manifest.json', '选择导出仍是同一种包结构')
  assert.deepEqual(
    archive.sessions.map((item) => item.id).sort(),
    ['s-1', 's-3'],
    '未勾选的 s-2 不能出现在包里'
  )
  assert.deepEqual(
    archive.index.map((entry) => entry.id).sort(),
    ['s-1', 's-3'],
    'index 只能列出勾中的会话'
  )
  assert.deepEqual(
    archive.images.sort(),
    [imageEntry('s-1', 'file-1'), imageEntry('s-3', 'file-3')].sort(),
    '图片条目只写勾中会话的图片，未勾选会话的图片不能被带上'
  )
  assert.ok(
    !archive.names.includes('chat_sessions/s-2.json'),
    `未勾选的会话文件必须在包里缺席：${archive.names.join(', ')}`
  )
})

test('空选择必须明确报错，不能产出一个空包', async () => {
  await assert.rejects(
    () => exportArchive(SESSIONS, { sessionIds: [] }),
    (error) => error.key === 'historyExportEmptySelection',
    'sessionIds 为空数组时必须抛 historyExportEmptySelection'
  )
  await assert.rejects(
    () => exportArchive(SESSIONS, { sessionIds: ['not-exist'] }),
    (error) => error.key === 'historyExportEmptySelection',
    '勾选的 id 一个都对不上时同样要报错（不能静默产出空包）'
  )
})

test('全量导出空历史：仍然产出合法包（「空选择报错」不能误伤这一条）', async () => {
  const archive = await unpack(await exportArchive([]))
  assert.deepEqual(archive.names, ['manifest.json', 'chat_session_index.json'], '空历史也必须是合法 ZIP')
  assert.deepEqual(archive.index, [], 'index 为空数组')
})

test('往返：选中导出的包能被真实 importArchive 完整导入，且只导入勾中的会话', async () => {
  const blob = await exportArchive(SESSIONS, { sessionIds: ['s-1', 's-3'] })
  await importDB.clearStaging()
  await importArchive(new File([blob], 'selected.zip', { type: 'application/zip' }))
  assert.deepEqual(
    importDB.stagingSessions.map((item) => item.id).sort(),
    ['s-1', 's-3'],
    '导入暂存里必须正好是勾中的两条会话'
  )
  assert.deepEqual(
    [...importDB.stagingFiles.keys()].sort(),
    ['file-1', 'file-3'],
    '勾中会话的图片原件必须跟着进暂存，未勾选的不能带进来'
  )
  const kept = importDB.stagingSessions.find((item) => item.id === 's-1')
  assert.equal(kept.messages.length, 2, '会话消息必须完整恢复（问答各一条）')
  assert.equal(
    importDB.stagingFileTypes.get('file-1'),
    'image/png',
    '图片 MIME 仍按魔数识别，选择导出不改变附件策略'
  )
})
