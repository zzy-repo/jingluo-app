// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <1s] Issue #32
//
// importArchive 的「条目归不了类」兜底不能再只说「文件内容不完整」：要带出条目序号、条目名，
// 以及**为什么**归不了类，用户/日志才能定位到第几个文件出了什么岔子。
//   [1] 索引还没读到、条目又不属于刚读到的会话的图片目录（图片排在会话之前的 #32 原始形态）
//       → backupEntryOutOfOrder，params 带 index / entry / session
//   [2] 索引已读到，但条目所属的会话没被导入（不在索引里）→ backupEntryUnreferenced，带 index / entry
//   [3] 两条新文案 zh / en 成对、占位符对齐、en 下不出现中文；既有 backupIncomplete 未被删改
//
//   node tests/unit/import-archive-unclassified.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installImportEnv } from '../helpers/import-env.mjs'

// 假 db：IndexedDB 在裸 Node 里不存在，只替换存储边界，importArchive 本身全是真实代码。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const clearStaging = async () => {
  stagingSessions.length = 0
}
globalThis.__unclassifiedDB = { stagingSessions, clearStaging }
`)}`

// 装配走公共入口（#408 收尾批）：`./errors.js` 等价替身 + 只对 importArchive.ts 换掉 `../db.js`
// + `.js→.ts` 解析，全在 installImportEnv 里；假存储仍由本文件给（各文件的暂存语义不同）。
installImportEnv({ db: fakeDB })

const { zipSync, strToU8 } = await import('fflate')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const db = globalThis.__unclassifiedDB

const TIME = '2026-11-01T00:00:00.000Z'

const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

const sessionFile = (id, imagePath) => {
  const fragments = [message(1, null, 'USER', `${id} 的问题`), message(2, 1, 'ASSISTANT', `${id} 的回答`)]
  if (imagePath) {
    fragments[0].fragments.push({
      type: 'FILE',
      files: [
        {
          id: imagePath.slice(imagePath.lastIndexOf('/') + 1, imagePath.lastIndexOf('_')),
          file_name: 'image.png',
          file_size: 128,
          token_usage: null,
          inserted_at: TIME,
          export_path: imagePath,
          is_image: true,
          width: 512,
          height: 512,
        },
      ],
    })
  }
  return strToU8(
    JSON.stringify({
      id,
      title: id,
      pinned: false,
      current_message_id: 2,
      inserted_at: TIME,
      updated_at: TIME,
      messages: fragments,
    })
  )
}

const indexOf = (ids) =>
  strToU8(
    JSON.stringify(
      ids.map((id) => ({
        id,
        title: id,
        pinned: false,
        message_count: 2,
        inserted_at: TIME,
        updated_at: TIME,
      }))
    )
  )

/** 128 字节的假 PNG：带 magic bytes，导入端按 magic 认 MIME（本用例走不到这里） */
const pngBytes = () => {
  const bytes = new Uint8Array(128)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

/** entries 是 [名字, 字节] 的有序数组：ZIP 条目顺序就是导入端看到的顺序 */
const archiveOf = (entries) =>
  new File([zipSync(Object.fromEntries(entries), { level: 0 })], 'deepseek_data.zip', {
    type: 'application/zip',
  })

const failure = async (file) => {
  await db.clearStaging()
  try {
    await importArchive(file)
  } catch (error) {
    return error
  }
  return assert.fail('条目顺序非法时必须失败，但导入通过了')
}

test('图片排在它所属会话之前：给出 backupEntryOutOfOrder，带序号 / 条目名 / 当前会话', async () => {
  const imagePath = 'chat_sessions/s2_files/f2_image.png'
  const error = await failure(
    archiveOf([
      ['manifest.json', strToU8(JSON.stringify({ export_format_version: 3 }))],
      ['chat_sessions/s1.json', sessionFile('s1')],
      [imagePath, pngBytes()],
      ['chat_sessions/s2.json', sessionFile('s2', imagePath)],
      ['chat_session_index.json', indexOf(['s1', 's2'])],
    ])
  )

  assert.equal(error?.name, 'BackupError')
  assert.equal(
    error?.key,
    'backupEntryOutOfOrder',
    `归不了类的条目必须给出可定位原因（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(error?.params?.index, 3, '要带出条目序号（1 起，manifest 是第 1 个）')
  assert.equal(error?.params?.entry, imagePath, '要带出条目名')
  assert.equal(error?.params?.session, 's1', '要带出「刚读到的那个会话」，说明它不属于谁')
  assert.match(error.message, /第 3 个文件/, `文案里要有序号：${error.message}`)
  assert.match(error.message, new RegExp(imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '文案里要有条目名')
  assert.notEqual(error.message, zh.backupIncomplete, '不许折叠成笼统的「文件内容不完整」')
  // 失败发生在第 3 个条目：只暂存了第 1 个会话，后面的条目一个都不再处理
  // （暂存由调用方清空，正式数据不动 —— 这里只钉住「没有多写」）。
  assert.equal(db.stagingSessions.length, 1, '第 3 个条目就失败，不该把后面的会话也写进暂存')
})

test('索引已读到但会话没被导入：给出 backupEntryUnreferenced，带序号 / 条目名', async () => {
  const imagePath = 'chat_sessions/s9_files/f9_image.png'
  const error = await failure(
    archiveOf([
      ['manifest.json', strToU8(JSON.stringify({ export_format_version: 3 }))],
      ['chat_sessions/s1.json', sessionFile('s1')],
      ['chat_session_index.json', indexOf(['s1'])],
      [imagePath, pngBytes()],
    ])
  )

  assert.equal(error?.name, 'BackupError')
  assert.equal(
    error?.key,
    'backupEntryUnreferenced',
    `索引外的条目必须给出可定位原因（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(error?.params?.index, 4)
  assert.equal(error?.params?.entry, imagePath)
  assert.match(error.message, /第 4 个文件/)
  assert.notEqual(error.message, zh.backupIncomplete, '不许折叠成笼统的「文件内容不完整」')
})

test('两条新文案 zh/en 成对、占位符对齐、en 下无中文，既有 key 未被删改', async () => {
  const keys = ['backupEntryOutOfOrder', 'backupEntryUnreferenced']
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} 文案不能为空`)
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符必须一一对应`)
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en.${key} 不许出现中文：${en[key]}`)
  }

  // 既有文案一个字都不许动：兜底新文案是为了定位，不是替换原来的那几条
  assert.equal(zh.backupIncomplete, '文件内容不完整，无法导入')
  assert.equal(en.backupIncomplete, 'The file is incomplete and cannot be imported.')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
  assert.ok(!('backupEntryUnclassified' in zh), '兜底 key 按分支拆成两条，不再新增笼统的一条')
})
