// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <10s]
//
// 域 5 / N3：**归档结构失败矩阵**（docs/testing/coverage/domain-05.md §6.2 N3，16 行）。
//
// 覆盖功能点：
//   F-05-13 重复条目名 / 重复路径（含目录与同名文件、NFC 归一后重名）
//   F-05-14 条目顺序不是格式的一部分（index 在前照常导入；图片在会话之前要拒绝并定位）
//   F-05-15 解压总量 / 压缩比上限（ZIP 炸弹两把闸）
//   F-05-16 条目名长度上限（1024 字节：259 放行、60019 拒绝）
//   F-05-17 归档结构校验（manifest 首条 / 版本 / 空包 / 截断 / 路径穿越 / 加密 / 非 UTF-8 名 / 非法 JSON）
//   F-05-19 索引完整性（索引缺会话、索引重复 id → 一律不放水）
//
// 为什么最脆弱（#32 → #40 → #49 → #153 一次补四处）：容错规则是**矩阵式**的
// （谁先到 × 谁重复 × 谁超限），组合数远大于用例数；而且导入是单遍流式 + 边写暂存，
// 任何一条分支写错的结果不是「报错」而是「半导入」——用户感知是「我的会话变少了」。
// 所以每行都断言两件事：**错误码可读且能定位**（不是一律折叠成「内容不完整」）与
// **拒绝时不写入任何暂存**（除了索引完整性那几行，它们的清理由 replaceHistory 负责，见 N8）。
//
//   node --test tests/unit/domain05-archive-reject-matrix.test.mjs
import { test } from 'node:test'
import { installImportEnv } from '../helpers/import-env.mjs'
import { strToU8 } from 'fflate'
import {
  indexBytes,
  manifestBytes,
  normalArchive,
  png,
  sessionJson,
  zipBytes,
  zipFile,
} from '../fixtures/domain05/archive.mjs'
import { render } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

// 假 db：IndexedDB 在裸 Node 里不存在，只替换存储边界；importArchive 本身全是真实代码。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const storedTypes = []
export const addStagingSession = async (session) => { stagingSessions.push(session) }
export const saveStagingFiles = async (files) => { for (const file of files) storedTypes.push([file.id, file.blob?.type ?? '']) }
export const updateStagingFileTypes = async (types) => { globalThis.__probeTypes = [...types] }
export const clearStaging = async () => { stagingSessions.length = 0 }
export const reportStorageError = () => () => {}
globalThis.__archiveDB = { stagingSessions, storedTypes, clearStaging }
`)}`
// 装配走公共入口（#408 收尾批）：`./errors.js` 等价替身 + 只对 importArchive.ts 换掉 `../db.js`
// + `.js→.ts` 解析，全在 installImportEnv 里；假存储仍由本文件给（各文件的暂存语义不同）。
installImportEnv({ db: fakeDB })

const { checkArchiveFormat, importArchive } = await import(
  '../../src/services/chat/history/importArchive.ts'
)
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const db = globalThis.__archiveDB

/** 跑一次导入：先过格式校验，再走真正的流式导入（与 backup.ts 的顺序一致）。 */
const apply = async (file) => {
  await db.clearStaging()
  try {
    await checkArchiveFormat(file)
  } catch (error) {
    return { stage: 'check', error, staged: db.stagingSessions.length }
  }
  try {
    await importArchive(file)
  } catch (error) {
    return { stage: 'import', error, staged: db.stagingSessions.length }
  }
  return { stage: 'done', error: null, staged: db.stagingSessions.length }
}

const expectRejected = (result, key, column = '错误码') => {
  expectEqual(result.stage === 'done', false, `${column}：必须被拒绝`)
  expectEqual(result.error?.key, key, column)
  expectEqual(result.error?.name, 'BackupError', `${column}：必须是可读的 BackupError`)
  return result.error
}

const HAN = /[\u4e00-\u9fff]/

test('N3 归档失败矩阵：16 行（F-05-13/14/15/16/17/19）', async () => {
  const rows = [
    {
      name: '非 ZIP（文本 / 空文件）→ backupUnrecognized，且一个暂存都不写',
      async run() {
        for (const file of [
          new File([strToU8('{"not":"a zip"}')], 'deepseek_data.zip'),
          new File([new Uint8Array(0)], 'empty.zip'),
        ]) {
          const result = await apply(file)
          const error = expectRejected(result, 'backupUnrecognized', '非 ZIP')
          expectEqual(result.staged, 0, '非 ZIP 不许写暂存')
          expectMatch(render(zh, error), /无法识别|不是|ZIP/, '中文文案要说明包认不出来')
        }
      },
    },
    {
      name: '空包（只有目录条目）→ backupEmptyArchive（不是 fold 成「结构损坏」）',
      async run() {
        const file = zipFile([{ name: 'chat_sessions/', data: new Uint8Array(0) }])
        const error = expectRejected(await apply(file), 'backupEmptyArchive', '空包')
        expectMatch(render(zh, error), /没有任何文件/, '文案要点明「包里没有文件」')
        expectEqual(HAN.test(en[error.key]), false, '英文文案不得出现中文')
      },
    },
    {
      name: 'manifest 不是第一个条目 → backupManifestNotFirst（点名 found / expected）',
      async run() {
        const file = zipFile([
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['manifest.json', manifestBytes()],
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        const error = expectRejected(await apply(file), 'backupManifestNotFirst', '首条不是 manifest')
        expectEqual(error.params.found, 'chat_sessions/s1.json', '指出实际首条是什么')
        expectEqual(error.params.expected, 'manifest.json', '指出期望是什么')
        const text = render(zh, error)
        expectMatch(text, /manifest\.json/, '文案里要有期望的条目名')
        expectMatch(text, /chat_sessions\/s1\.json/, '文案里要有实际的首条名')
      },
    },
    {
      name: '文件被截断（尾部砍掉 40 字节）→ backupArchiveUnreadable（不给错的条目定位）',
      async run() {
        const bytes = zipBytes([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        const file = new File([bytes.slice(0, bytes.length - 40)], 'deepseek_data.zip')
        const error = expectRejected(await apply(file), 'backupArchiveUnreadable', '截断')
        expectEqual(error.params, undefined, '连目录都读不到时不要编造条目定位')
        expectMatch(render(zh, error), /截断|重新|损坏/, '文案要给可照做的下一步')
      },
    },
    {
      name: '条目损坏两态：CRC 撒谎 → 带条目定位的 damaged；声明尺寸撒谎 → 读之前就拒',
      async run() {
        const crcBad = zipFile([
          { name: 'manifest.json', data: manifestBytes(), declaredCrc: 1 },
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        const damaged = expectRejected(await apply(crcBad), 'backupArchiveDamaged', 'CRC 错')
        expectEqual(damaged.params.entry, 'manifest.json', '定位到出问题的条目')
        expectEqual(damaged.params.index, 1, '定位到序号（1 起）')
        expectMatch(render(zh, damaged), /manifest\.json/, '文案里要有条目名')

        const sizeLie = zipFile([
          ['manifest.json', manifestBytes()],
          { name: 'chat_sessions/s1.json', data: sessionJson({ id: 's1' }), declaredSize: 999_999 },
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        expectRejected(await apply(sizeLie), 'backupArchiveUnreadable', '声明尺寸撒谎')
      },
    },
    {
      name: '路径穿越（../evil.json）→ 拒绝，绝不把它落成本地路径',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['../evil.json', strToU8('x')],
          ['chat_session_index.json', indexBytes([])],
        ])
        expectRejected(await apply(file), 'backupArchiveUnreadable', '路径穿越')
      },
    },
    {
      name: '同名条目（同名文件）→ backupEntryDuplicated，提示点名冲突路径且含「重复」',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        const error = expectRejected(await apply(file), 'backupEntryDuplicated', '同名条目')
        expectEqual(error.params.entry, 'manifest.json', '带出冲突路径')
        const text = render(zh, error)
        expectMatch(text, /重复/, '#153 缺口 2：必须说「重复」，不能说「可能被截断」')
        expectMatch(text, /manifest\.json/, '文案里要有冲突路径')
        expectEqual(HAN.test(en[error.key]), false, '英文文案不得出现中文')
      },
    },
    {
      name: '同名条目（目录 a/ 与文件 a）→ 同样按重复拒绝，不能静默并存',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1_files/', new Uint8Array(0)],
          ['chat_sessions/s1_files', strToU8('x')],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
        ])
        const error = expectRejected(await apply(file), 'backupEntryDuplicated', '目录与文件同名')
        expectEqual(error.params.entry, 'chat_sessions/s1_files', '冲突路径按去掉斜杠后的身份比较')
      },
    },
    {
      name: 'index 排在会话文件之前 → 照常导入（顺序不是格式的一部分）F-05-14',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_session_index.json', indexBytes(['s1', 's2'])],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_sessions/s2.json', sessionJson({ id: 's2' })],
        ])
        const result = await apply(file)
        expectEqual(result.error, null, `index 先到不该被判「内容不完整」（实际 ${result.error?.key}）`)
        expectEqual(result.staged, 2, '两个会话都要进暂存')
        expectEqual(
          db.stagingSessions.map((session) => session.id).sort().join(','),
          's1,s2',
          '暂存的会话 id'
        )
      },
    },
    {
      name: '图片排在会话之前（index 还没读到）→ backupEntryOutOfOrder，带条目与序号定位',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1_files/f1_a.png', png(16)],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1'])],
        ])
        const error = expectRejected(await apply(file), 'backupEntryOutOfOrder', '图片在会话前')
        expectEqual(error.params.entry, 'chat_sessions/s1_files/f1_a.png', '定位到图片条目')
        expectEqual(error.params.index, 2, '定位到序号')
        expectMatch(render(zh, error), /不要解压后重排文件/, '文案要给出可照做的做法')
      },
    },
    {
      name: '多余未引用条目（索引已读、不属于任何已导入会话）→ backupEntryUnreferenced',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1'])],
          ['chat_sessions/ghost_files/x.png', png(8)],
        ])
        const error = expectRejected(await apply(file), 'backupEntryUnreferenced', '无主条目')
        expectEqual(error.params.entry, 'chat_sessions/ghost_files/x.png', '定位到无主条目')
        expectEqual(error.params.index, 4, '定位到序号')
      },
    },
    {
      name: '索引列了会话但包里缺文件 → backupIncomplete（不许「跳过也放行」）',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1', 's2'])],
        ])
        expectRejected(await apply(file), 'backupIncomplete', '索引缺会话')
      },
    },
    {
      name: '索引里同一个 id 出现两次 → backupIncomplete（索引与会话必须一一对应）',
      async run() {
        const file = zipFile([
          ['manifest.json', manifestBytes()],
          ['chat_sessions/s1.json', sessionJson({ id: 's1' })],
          ['chat_session_index.json', indexBytes(['s1', 's1'])],
        ])
        expectRejected(await apply(file), 'backupIncomplete', '索引重复 id')
      },
    },
    {
      name: 'ZIP 炸弹两把闸：声明解压总量超 800MiB / 真实压缩比超 200:1 → 一律拒绝（不按声明预分配）',
      async run() {
        // 只改中央目录的声明尺寸，不分配任何大内存
        const huge = zipFile([
          ['manifest.json', manifestBytes()],
          {
            name: 'chat_sessions/big.json',
            data: sessionJson({ id: 'big' }),
            declaredSize: 900 * 1024 * 1024,
          },
          ['chat_session_index.json', indexBytes(['big'])],
        ])
        expectRejected(await apply(huge), 'backupArchiveUnreadable', '声明解压总量超')

        // 真实 deflate：20MB 全零 → 压缩比 ~1000:1
        const bomb = zipFile(
          [
            ['manifest.json', manifestBytes()],
            ['chat_sessions/bomb.json', strToU8(JSON.stringify({ pad: ' '.repeat(20 * 1024 * 1024) }))],
            ['chat_session_index.json', indexBytes(['bomb'])],
          ],
          { compress: true }
        )
        expectOk(bomb.size < 1024 * 1024, `炸弹包体只有 ${(bomb.size / 1024).toFixed(0)}KB，却要解出 20MB`)
        expectRejected(await apply(bomb), 'backupArchiveUnreadable', '真实压缩比超')
      },
    },
    {
      name: '条目名长度：60019 字节拒绝（读之前就拒）；259 字节正常长名照常接受',
      async run() {
        const tooLong = zipFile([
          ['manifest.json', manifestBytes()],
          [`chat_sessions/${'x'.repeat(60_000)}.json`, strToU8('{}')],
          ['chat_session_index.json', indexBytes([])],
        ])
        expectRejected(await apply(tooLong), 'backupArchiveUnreadable', '超长条目名')

        // 反向：正常上限内的长名不能被误杀（导出里的路径段都很短，但 259 字节是合法长度）
        const longId = 'y'.repeat(240)
        const accepted = zipFile([
          ['manifest.json', manifestBytes()],
          [`chat_sessions/${longId}.json`, sessionJson({ id: longId })],
          ['chat_session_index.json', indexBytes([longId])],
        ])
        const result = await apply(accepted)
        expectEqual(result.error, null, `259 字节的条目名必须放行（实际 ${result.error?.key}）`)
        expectEqual(result.staged, 1, '长名会话照常入库')
      },
    },
    {
      name: '其余结构红线：加密标志 / 非 UTF-8 名 / 版本过新 / 版本非法 / 非法 JSON 各有可读原因',
      async run() {
        const cases = [
          {
            why: '加密（flag bit0）',
            file: zipFile([
              { name: 'manifest.json', data: manifestBytes(), flags: 0x801 },
              ['chat_session_index.json', indexBytes([])],
            ]),
            key: 'backupArchiveUnreadable',
          },
          {
            why: '版本过新',
            file: zipFile([
              ['manifest.json', manifestBytes(99)],
              ['chat_session_index.json', indexBytes([])],
            ]),
            key: 'backupNewerVersion',
          },
          {
            why: '版本非法',
            file: zipFile([
              ['manifest.json', strToU8(JSON.stringify({ export_format_version: 'x' }))],
              ['chat_session_index.json', indexBytes([])],
            ]),
            key: 'backupInvalidVersion',
          },
          {
            why: '非法 JSON',
            file: zipFile([
              ['manifest.json', strToU8('{oops')],
              ['chat_session_index.json', indexBytes([])],
            ]),
            key: 'backupInvalidJson',
          },
        ]
        for (const item of cases) {
          const error = expectRejected(await apply(item.file), item.key, item.why)
          expectOk(String(render(zh, error)).length > 0, `${item.why} 必须有可读文案`)
          expectEqual(HAN.test(en[error.key]), false, `${item.why}：英文文案不得出现中文`)
        }

        // UTF-16LE 文件名（不带 UTF-8 标志、含 >0x7f 字节）：只能拒绝，不能猜
        const utf16Name = new Uint8Array([0x6d, 0x00, 0x61, 0x00, 0x6e, 0x00, 0x69, 0x00, 0x2e, 0x00])
        const utf16File = zipFile([
          { name: utf16Name, utf8: false, data: manifestBytes() },
          ['chat_session_index.json', indexBytes([])],
        ])
        expectRejected(await apply(utf16File), 'backupArchiveUnreadable', '非 UTF-8 文件名')
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})
