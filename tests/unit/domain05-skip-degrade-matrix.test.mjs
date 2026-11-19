// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <5s]
//
// 域 5 / N5：**跳过与降级矩阵**（docs/testing/coverage/domain-05.md §6.2 N5，7 行）。
//
// 覆盖功能点：
//   F-05-12 损坏条目逐条跳过并给出位置（skipped 带会话标题 / 消息 id / 原因文案）
//   F-05-18 单张图片 / 附件异常降级（缺原件 / MIME 识别不出 / 引用越界 / 单图条目 CRC 坏）
//   F-05-19 索引完整性（放宽成「能导的先导」，但绝不对「缺会话」放水）
//
// 与 N3 的分工（不可合并）：N3 断言「整包被拒」，本文断言「跳过 N 条、其余照常入库」——
// 一个期望抛错、一个期望成功。把两者合并的后果是把「导出写坏了」伪装成「导入变严了」。
//
//   node --test tests/unit/domain05-skip-degrade-matrix.test.mjs
import { test } from 'node:test'
import { installImportEnv } from '../helpers/import-env.mjs'
import {
  imageMessage,
  indexBytes,
  manifestBytes,
  message,
  png,
  sessionJson,
  unknownBytes,
  zipFile,
} from '../fixtures/domain05/archive.mjs'
import { render } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

// 假 db：只替换存储边界。saveStagingFiles / updateStagingFileTypes 都记下来，
// 用来断言「缺原件的图片不写入」「识别不出 MIME 时 type 为空串」。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const storedFiles = []
export const typeUpdates = []
export const addStagingSession = async (session) => { stagingSessions.push(session) }
export const saveStagingFiles = async (files) => { for (const file of files) storedFiles.push({ id: file.id, type: file.blob?.type ?? '' }) }
export const updateStagingFileTypes = async (types) => { typeUpdates.push([...types]) }
export const clearStaging = async () => { stagingSessions.length = 0; storedFiles.length = 0 }
globalThis.__skipDB = { stagingSessions, storedFiles, typeUpdates, clearStaging }
`)}`
// 装配走公共入口（#408 收尾批）：`./errors.js` 等价替身 + 只对 importArchive.ts 换掉 `../db.js`
// + `.js→.ts` 解析，全在 installImportEnv 里；假存储仍由本文件给（各文件的暂存语义不同）。
installImportEnv({ db: fakeDB })

const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const db = globalThis.__skipDB

/** 一条 PR 用的正常会话骨架（带一张图片引用）。 */
const withImage = ({ id, exportPath, fileId = 'f1', fileName = 'a.png', isImage = true }) => ({
  id,
  messages: [
    imageMessage(1, null, { fileId, fileName, exportPath, isImage }),
    message(2, 1, 'ASSISTANT', `${id} 的回答`),
  ],
})

const runArchive = async (entries) => {
  db.stagingSessions.length = 0
  db.storedFiles.length = 0
  db.typeUpdates.length = 0
  const file = zipFile(entries)
  try {
    return { result: await importArchive(file), error: null }
  } catch (error) {
    return { result: null, error }
  }
}

test('N5 跳过与降级矩阵：7 行（F-05-12/18/19）', async () => {
  const rows = [
    {
      name: '一条消息坏掉（父消息缺失）→ 只丢这条，会话其余消息照常入库，skipped 能定位',
      async run() {
        const broken = {
          id: 'sess-broken-msg',
          // 坏的那条排在前面：current_message_id 指向最后一条（2），
          // 这样只触发「单条消息坏」一种降级，不会被「当前分支指针损坏」的第二条 skip 干扰
          messages: [
            message(3, 99, 'USER', '挂在不存在父节点上的一条'),
            message(1, null, 'USER', '你好'),
            message(2, 1, 'ASSISTANT', '你好呀'),
          ],
        }
        const { result, error } = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-broken-msg.json', sessionJson(broken)],
          ['chat_session_index.json', indexBytes(['sess-broken-msg'])],
        ])
        expectEqual(error, null, `坏消息不该让整包失败（实际 ${error?.key}）`)
        expectEqual(db.stagingSessions.length, 1, '会话必须入库')
        expectEqual(result.skipped.length, 1, 'skipped 应记一条')
        const skip = result.skipped[0]
        expectEqual(skip.scope, 'message', 'skip 粒度')
        expectEqual(skip.messageId, '3', '定位到坏消息 id')
        expectEqual(skip.parentId, '99', '定位到缺失的父 id')
        expectEqual(skip.reason, 'backupInvalidBranches', '原因码')
        expectOk(String(render(zh, { key: skip.reason })).length > 0, '原因必须有人话文案')
        const ids = db.stagingSessions[0].messages.map((item) => item.id)
        expectEqual(ids.join(','), '1,2', '正常的两条必须保留')
      },
    },
    {
      name: '整个会话不可构造（根消息是助手）→ 跳过该会话，其余会话照常导入',
      async run() {
        const bad = { id: 'sess-bad', messages: [message(1, null, 'ASSISTANT', '孤儿回答')] }
        const good = { id: 'sess-good' }
        const { result, error } = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-bad.json', sessionJson(bad)],
          ['chat_sessions/sess-good.json', sessionJson(good)],
          ['chat_session_index.json', indexBytes(['sess-bad', 'sess-good'])],
        ])
        expectEqual(error, null, `会话级坏数据不该抛错（实际 ${error?.key}）`)
        expectEqual(
          db.stagingSessions.map((session) => session.id).join(','),
          'sess-good',
          '只有好会话入库'
        )
        const sessionSkip = result.skipped.find((skip) => skip.scope === 'session')
        expectOk(sessionSkip, '必须记一条会话级 skipped')
        expectEqual(sessionSkip.sessionId, 'sess-bad', '定位到被跳过的会话')
        expectEqual(sessionSkip.reason, 'backupInvalidBranches', '原因码')
        expectEqual(sessionSkip.sessionTitle, 'sess-bad', '带会话标题（界面要列出来）')
      },
    },
    {
      name: '图片引用越界（export_path 指向别的会话目录）→ 该会话按 backupInvalidFiles 跳过，其余照常',
      async run() {
        const bad = withImage({ id: 'sess-cross', exportPath: 'chat_sessions/other_files/f1_a.png' })
        const good = { id: 'sess-keep' }
        // 甲：包里没有那张越界的图（原件在别的会话目录里）→ 只跳过这个会话
        const first = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-cross.json', sessionJson(bad)],
          ['chat_sessions/sess-keep.json', sessionJson(good)],
          ['chat_session_index.json', indexBytes(['sess-cross', 'sess-keep'])],
        ])
        expectEqual(first.error, null, `单会话的图片引用越界不该让整包失败（实际 ${first.error?.key}）`)
        expectEqual(
          db.stagingSessions.map((session) => session.id).join(','),
          'sess-keep',
          '越界会话必须被跳过'
        )
        const skip = first.result.skipped.find((item) => item.sessionId === 'sess-cross')
        expectEqual(skip?.reason, 'backupInvalidFiles', '原因码必须是「附件异常」而不是分支损坏')
        expectEqual(db.storedFiles.length, 0, '越界会话的图片不能落到别的会话上')

        // 乙：越界的图**在包里**（排在 index 之后，按真实导出顺序）→ 整包按「无主条目」拒绝，
        //     绝不静默丢弃：入口放宽不等于放任脏数据
        const second = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-cross.json', sessionJson(bad)],
          ['chat_sessions/sess-keep.json', sessionJson(good)],
          ['chat_session_index.json', indexBytes(['sess-cross', 'sess-keep'])],
          ['chat_sessions/other_files/f1_a.png', png(32)],
        ])
        expectEqual(second.error?.key, 'backupEntryUnreferenced', '越界图片必须被点名，而不是悄悄丢掉')
      },
    },
    {
      name: '缺原件的图片 → 保留文件名与大小、不进请求（不写入任何原件）',
      async run() {
        const spec = withImage({ id: 'sess-no-original', exportPath: 'chat_sessions/sess-no-original_files/f1_a.png' })
        const { error } = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-no-original.json', sessionJson(spec)],
          ['chat_session_index.json', indexBytes(['sess-no-original'])],
          // 归档里没有这张图片的条目：导出时本地就没有原件
        ])
        expectEqual(error, null, `缺原件不等于包坏了（实际 ${error?.key}）`)
        expectEqual(db.stagingSessions.length, 1, '会话照常入库')
        expectEqual(db.storedFiles.length, 0, '缺原件时不许凭空造文件')
        const file = db.stagingSessions[0].messages[0].files[0]
        expectEqual(file.name, 'a.png', '文件名必须保留')
        expectEqual(file.size, 128, '大小必须保留')
        expectEqual(file.isImage, true, '图片身份必须保留')
        expectEqual(file.mimeType, '', '没有原件就没有 MIME')
      },
    },
    {
      name: 'MIME 识别不出的图片 → 仍按图片收下（身份靠 is_image，不靠 magic）',
      async run() {
        const spec = withImage({ id: 'sess-unknown-mime', exportPath: 'chat_sessions/sess-unknown-mime_files/f1_a.png' })
        const { error } = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-unknown-mime.json', sessionJson(spec)],
          ['chat_session_index.json', indexBytes(['sess-unknown-mime'])],
          ['chat_sessions/sess-unknown-mime_files/f1_a.png', unknownBytes(48)],
        ])
        expectEqual(error, null, `识别不出 magic 不是错误（实际 ${error?.key}）`)
        expectEqual(db.storedFiles.length, 1, '原件必须存下来')
        expectEqual(db.storedFiles[0].id, 'f1', '按归档里的文件 id 存')
        expectEqual(db.storedFiles[0].type, '', '认不出 MIME 时 type 为空串（不当成损坏）')
        const file = db.stagingSessions[0].messages[0].files[0]
        expectEqual(file.isImage, true, '仍然是图片')
        expectEqual(file.mimeType, '', 'MIME 留给后面回填，不自作主张')
      },
    },
    {
      name: '单张图片条目 CRC 坏 → 不是「跳过这张图」，而是整包拒绝并定位到该条目',
      async run() {
        const spec = withImage({ id: 'sess-bad-image', exportPath: 'chat_sessions/sess-bad-image_files/f1_a.png' })
        const { error } = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-bad-image.json', sessionJson(spec)],
          ['chat_session_index.json', indexBytes(['sess-bad-image'])],
          { name: 'chat_sessions/sess-bad-image_files/f1_a.png', data: png(32), declaredCrc: 1 },
        ])
        expectEqual(error?.key, 'backupArchiveDamaged', '图片条目坏了属于「包坏了」')
        expectEqual(error.params.entry, 'chat_sessions/sess-bad-image_files/f1_a.png', '定位到那张图')
        expectMatch(render(zh, error), /f1_a\.png/, '文案里要有条目名')
      },
    },
    {
      name: '跳过但不放水：坏会话被跳过仍算「读到了」，索引里多出没读到的会话才算备份不完整',
      async run() {
        // 甲：坏会话在索引里，但它确实被读到了（只是内容不可用）→ 导入成功
        const bad = { id: 'sess-skipped', messages: [message(1, null, 'ASSISTANT', '孤儿')] }
        const ok = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-skipped.json', sessionJson(bad)],
          ['chat_sessions/sess-ok.json', sessionJson({ id: 'sess-ok' })],
          ['chat_session_index.json', indexBytes(['sess-skipped', 'sess-ok'])],
        ])
        expectEqual(ok.error, null, `「能导的先导」不等于失败（实际 ${ok.error?.key}）`)
        expectEqual(db.stagingSessions.length, 1, '好会话入库')
        expectOk(
          ok.result.skipped.some((item) => item.scope === 'session' && item.sessionId === 'sess-skipped'),
          '被跳过的会话必须在 skipped 里报出来'
        )

        // 乙：索引列了包里根本没有的会话 → 绝不假成功
        const missing = await runArchive([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/sess-ok.json', sessionJson({ id: 'sess-ok' })],
          ['chat_session_index.json', indexBytes(['sess-ok', 'sess-never-in-zip'])],
        ])
        expectEqual(missing.error?.key, 'backupIncomplete', '缺会话必须整包失败')
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})
