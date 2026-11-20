// [layer: unit | 依赖: 无（纯 Node，零浏览器；只替换 IndexedDB 边界与原生桥） | 耗时: <5s]
//
// 域 5 / N6：**导出 → 再导入 往返表**（docs/testing/coverage/domain-05.md §6.2 N6，3 行）。
//
// 覆盖功能点：
//   F-05-23 导出全部历史为 ZIP（exportArchive 真实代码，不再只有夹具）
//   F-05-28 导出后立即导入（往返一致性：会话数 / 标题 / 消息树 / 图片一一对上）
//
// 与 N3 的分工（不可合并）：N3 是「坏包必须被拒」，本文是「自产包必须被接受」——
// 反向契约。合并会把「导出写坏了」伪装成「导入变严了」，而这两件事的处置完全不同。
//
// 为什么必须真跑：本域 10 个「完全零测试」的聚集区里，exportArchive / zipWriter / exportHistory
// 三个都在这一侧。导入侧被 14 个修复单打成了筛子，导出侧此前一行测试都没有 ——
// 「自己导出的包自己导不回来」是唯一会让用户当场丢数据的一类缺陷。
//
//   node --test tests/unit/domain05-export-roundtrip.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { indexBytes, manifestBytes, png, sessionJson, zipFile } from '../fixtures/domain05/archive.mjs'
import { installBuildDefines, installHooks, stubOf } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectOk, runTable } from '../fixtures/domain05/table.mjs'

// 导出侧读原件（db.loadFile）、导入侧写暂存（addStagingSession / saveStagingFiles）：只替换这一层。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const originals = new Map()
export const stagingSessions = []
export const storedFiles = []
export const addStagingSession = async (session) => { stagingSessions.push(session) }
export const saveStagingFiles = async (files) => { for (const file of files) storedFiles.push({ id: file.id, type: file.blob?.type ?? '', size: file.blob?.size ?? 0 }) }
// 与真实 db.updateStagingFileTypes 同语义：按 id 回填暂存会话里附件的 MIME
export const updateStagingFileTypes = async (types) => {
  for (const session of stagingSessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      for (const file of message.files) {
        file.mimeType = types.get(file.id) ?? ''
      }
    }
  }
  globalThis.__roundtripTypes = [...types]
}
export const clearStaging = async () => { stagingSessions.length = 0; storedFiles.length = 0 }
export const loadFile = async (id) => originals.get(id)
export const reportStorageError = () => () => {}
globalThis.__roundtripDB = { originals, stagingSessions, storedFiles, clearStaging }
`)}`
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

installHooks((specifier, parent) => {
  if (specifier === './errors.js') {
    return errorsStub
  }
  if (specifier === '../db.js') {
    // exportArchive.ts 与 importArchive.ts 的存储边界是同一个替身
    if (parent.endsWith('/history/exportArchive.ts') || parent.endsWith('/history/importArchive.ts')) {
      return fakeDB
    }
  }
  if (specifier === '@capacitor/core') {
    return stubOf('../url-import-stubs/capacitor.mjs')
  }
  return null
})

// 打包期常量（toArchive → describe → diagnostics 会读到）
await installBuildDefines()

const { exportArchive } = await import('../../src/services/chat/history/exportArchive.ts')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { listArchivePaths } = await import('../../src/services/chat/history/zipReader.ts')
const db = globalThis.__roundtripDB

const T = 1_760_000_000_000

/** 一份「本地会话」：messages 不带 rootMessageId 时由 normalizeSession 线性化。 */
const session = ({ id, title = id, content = `${id} 的问题`, files = [] }) => ({
  id,
  title,
  createdAt: T,
  updatedAt: T,
  messages: [
    { id: 'u1', role: 'user', content, files, createdAt: T },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: T + 1,
      model: null,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: `${content} 的回答` }],
    },
  ],
})

const toFile = async (blob) =>
  new File([await blob.arrayBuffer()], 'deepseek_data.zip', { type: 'application/zip' })

const resetDB = () => {
  db.stagingSessions.length = 0
  db.storedFiles.length = 0
  db.originals.clear()
}

test('N6 导出→导入往返表：3 行（F-05-23/28）', async () => {
  const rows = [
    {
      name: '纯文本 3 会话：导出产物能被自己导入，会话数 / 标题 / 消息树一一对上',
      async run() {
        resetDB()
        const origin = [session({ id: 'sess-a' }), session({ id: 'sess-b' }), session({ id: 'sess-c' })]
        const blob = await exportArchive(origin)
        expectOk(blob.size > 0, `导出产物不能为空（实际 ${blob.size} 字节）`)
        expectEqual(blob.type, 'application/zip', '产物 MIME')
        const file = await toFile(blob)
        expectEqual(
          (await listArchivePaths(file))[0],
          'manifest.json',
          '第一个条目必须是 manifest（导入端按它判格式）'
        )
        await importArchive(file)
        expectEqual(db.stagingSessions.length, 3, '三个会话都要能导回来')
        expectEqual(
          db.stagingSessions.map((item) => item.title).join(','),
          'sess-a,sess-b,sess-c',
          '标题与顺序'
        )
        for (const imported of db.stagingSessions) {
          expectEqual(imported.messages.length, 2, `${imported.id} 的消息条数`)
          expectEqual(imported.messages[0].role, 'user', '第一条是提问')
          expectEqual(imported.messages[0].content, `${imported.id} 的问题`, '提问正文')
          expectEqual(imported.messages[1].role, 'assistant', '第二条是回答')
          expectEqual(
            imported.messages[1].blocks.map((block) => block.text).join(''),
            `${imported.id} 的问题 的回答`,
            '回答正文'
          )
        }
      },
    },
    {
      name: '含图片：原件随包导出，导回来 MIME 与文件元数据都对得上',
      async run() {
        resetDB()
        const bytes = png(256)
        db.originals.set('file-1', new Blob([bytes], { type: 'image/png' }))
        const origin = [
          session({
            id: 'sess-img',
            files: [
              {
                id: 'file-1',
                serverId: null,
                name: 'shot.png',
                size: bytes.length,
                isImage: true,
                mimeType: 'image/png',
              },
            ],
          }),
        ]
        const file = await toFile(await exportArchive(origin))
        const paths = await listArchivePaths(file)
        expectEqual(
          paths.some((path) => path === 'chat_sessions/sess-img_files/file-1_shot.png'),
          true,
          `图片条目名必须与导入端规则一致：${JSON.stringify(paths)}`
        )
        await importArchive(file)
        expectEqual(db.stagingSessions.length, 1, '会话要导回来')
        const imported = db.stagingSessions[0].messages[0].files[0]
        expectEqual(imported.name, 'shot.png', '文件名')
        expectEqual(imported.size, bytes.length, '大小')
        expectEqual(imported.isImage, true, '图片身份')
        expectEqual(imported.mimeType, 'image/png', 'MIME 由原件 magic 回填')
        expectEqual(db.storedFiles.length, 1, '原件必须落库')
        expectEqual(db.storedFiles[0].id, 'file-1', '原件 id')
        expectEqual(db.storedFiles[0].size, bytes.length, '原件字节数')
      },
    },
    {
      name: '空历史：导出产物只有 manifest + index，且能被导入（0 会话，不是坏包）',
      async run() {
        resetDB()
        const blob = await exportArchive([])
        const file = await toFile(blob)
        expectEqual(
          (await listArchivePaths(file)).join(','),
          'manifest.json,chat_session_index.json',
          '空历史的包结构'
        )
        // 不是 importArchive 自己判空包，而是「索引为空、没有任何会话」这种合法形态
        const result = await importArchive(file)
        expectEqual(db.stagingSessions.length, 0, '0 个会话')
        expectEqual(result.skipped.length, 0, '空历史不该产生跳过条目')
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})
