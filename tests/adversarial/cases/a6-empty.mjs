// A6 · 畸形归档：空包 / 只有目录 / 缺文件
// 构造方式：空 ZIP（只有 EOCD）、只含目录条目的 ZIP、把 manifest.json 写成目录条目、
//          0 字节文件、只有 manifest 没有会话与 index、会话缺 index。
// 期望：每种都要给出可区分的、能指导用户下一步的提示，不能一律说「文件损坏」。
import {
  archiveFile,
  captureFailure,
  installHooks,
  manifestJson,
  resetStaging,
  sessionJson,
  sessionPathOf,
  staging,
} from '../lib/harness.mjs'
import { buildZip } from '../lib/zip.mjs'

installHooks()
const { checkArchiveFormat, importArchive } = await import(
  '../../../src/services/chat/history/importArchive.ts'
)

console.log('[a6] A. 畸形归档 / 空包与缺失')
console.log('构造方式：空 ZIP、纯目录 ZIP、manifest 是目录、0 字节文件、缺 index。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = manifestJson()

// 1) 空 ZIP（只有 EOCD）
const empty = buildZip([])
const emptyFailure = await captureFailure(() => checkArchiveFormat(archiveFile(empty)))
check(
  '1) 空 ZIP（只有 EOCD、没有 PK\\3\\4 头）→ 在进入解析前就被当成「不是 ZIP」（backupUnrecognized，可接受）',
  emptyFailure.key === 'backupUnrecognized' || emptyFailure.key === 'backupEmptyArchive',
  `${emptyFailure.key} / ${emptyFailure.message}`
)

// 2) 只有目录条目
const dirsOnly = buildZip([
  { name: 'chat_sessions/', dir: true },
  { name: 'chat_sessions/s1_files/', dir: true },
])
const dirsFailure = await captureFailure(() => checkArchiveFormat(archiveFile(dirsOnly)))
check(
  '2) 只有目录 → backupEmptyArchive',
  dirsFailure.key === 'backupEmptyArchive',
  `${dirsFailure.key}`
)

// 3) manifest.json 是目录条目（用户误把文件夹拖进打包工具）
const manifestDir = buildZip([
  { name: 'manifest.json/', dir: true },
  { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
])
const manifestDirFailure = await captureFailure(() => checkArchiveFormat(archiveFile(manifestDir)))
check(
  '3) manifest.json 是目录 → 拒绝，且提示第一个文件不是 manifest（不静默继续）',
  manifestDirFailure.key === 'backupManifestNotFirst' || manifestDirFailure.key === 'backupEmptyArchive',
  `${manifestDirFailure.key} / ${manifestDirFailure.message}`
)

// 4) 0 字节文件
const zero = await captureFailure(() => checkArchiveFormat(archiveFile(new Uint8Array(0))))
check('4) 0 字节文件 → backupUnrecognized', zero.key === 'backupUnrecognized', `${zero.key}`)

// 5) 只有 manifest，没有会话也没有 index
await resetStaging()
const onlyManifest = buildZip([{ name: 'manifest.json', data: manifest }])
const onlyFailure = await captureFailure(() =>
  importArchive(archiveFile(onlyManifest), { totalSessions: 0 })
)
check(
  '5) 只有 manifest → backupIncomplete（内容不完整）',
  onlyFailure.key === 'backupIncomplete',
  `${onlyFailure.key} / ${onlyFailure.message}`
)

// 6) 有会话没有 index
await resetStaging()
const noIndex = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
])
const noIndexFailure = await captureFailure(() =>
  importArchive(archiveFile(noIndex), { totalSessions: 1 })
)
const noIndexStaging = (await staging()).__staging
check(
  '6) 缺 index → backupIncomplete，且暂存被清空（不留半份数据）',
  noIndexFailure.key === 'backupIncomplete' && noIndexStaging.sessions.length === 1,
  `${noIndexFailure.key} / 暂存 ${noIndexStaging.sessions.length} 个（调用方负责清理）`
)

// 7) index 里有会话文件不存在的 id
await resetStaging()
const ghostIndex = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
  {
    name: 'chat_session_index.json',
    data: JSON.stringify([
      { id: 's1', title: null, pinned: false, message_count: 2, inserted_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
      { id: 's2', title: null, pinned: false, message_count: 2, inserted_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
    ]),
  },
])
const ghostFailure = await captureFailure(() =>
  importArchive(archiveFile(ghostIndex), { totalSessions: 2 })
)
check(
  '7) index 指向不存在的会话 → backupIncomplete（会话 id 集合不相等）',
  ghostFailure.key === 'backupIncomplete',
  `${ghostFailure.key}`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a6] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
