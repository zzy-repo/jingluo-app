// A3 · 畸形归档：重复条目 / 同名冲突 / 归一化冲突 / 符号链接 / 加密标志
// 构造方式：同一份归档里塞两个同名条目、目录与文件同名、NFC 与 NFD 归一化后同名，
//          以及带 unix 符号链接属性、带加密标志位的条目。
// 期望：全部拒绝（不能「后一个覆盖前一个」静默导入），且不崩成普通 Error；
//      提示应能指出是「条目重复 / 条目非法」，而不是笼统说「文件被截断」。
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
const { importArchive } = await import('../../../src/services/chat/history/importArchive.ts')

console.log('[a3] A. 畸形归档 / 重复条目与同名冲突')
console.log('构造方式：同名条目、目录与文件同名、NFC/NFD 同名、符号链接属性、加密标志位。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = manifestJson()
const run = async (bytes) => {
  await resetStaging()
  const failure = await captureFailure(() => importArchive(archiveFile(bytes), { totalSessions: 1 }))
  return { failure, staging: (await staging()).__staging }
}

// 1) manifest 出现两次，内容不同（后一个是合法版本号 3，前者故意写坏）
const duplicateManifest = buildZip([
  { name: 'manifest.json', data: manifestJson({ export_format_version: 3, extra: 1 }) },
  { name: 'manifest.json', data: manifest },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
])
const dup = await run(duplicateManifest)
check(
  '1) 同名条目重复 → 拒绝，错误码点名重复并带出冲突路径，且不写入任何暂存',
  dup.failure.key === 'backupEntryDuplicated' &&
    dup.failure.params?.entry === 'manifest.json' &&
    dup.staging.sessions.length === 0,
  `${dup.failure.key} / entry=${dup.failure.params?.entry} / 暂存 ${dup.staging.sessions.length}`
)

// 2) 诊断质量：重复条目应该能被用户看懂（「文件被截断 / 被重新打包」会把人带偏）
check(
  '2) 重复条目的提示应点出「重复」，而不是说「被截断」',
  /重复/.test(dup.failure.message),
  dup.failure.message
)

// 3) 目录条目与文件条目同名（a/ 与 a）
const dirFile = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'chat_sessions/s1_files/', data: undefined, dir: true },
  { name: 'chat_sessions/s1_files', data: 'x' },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
])
const collide = await run(dirFile)
check(
  '3) 目录与文件同名 → 拒绝（或明确只认一个），不出现双份暂存',
  collide.staging.sessions.length <= 1,
  `${collide.failure?.key ?? '通过'} / 暂存 ${collide.staging.sessions.length}`
)

// 4) NFC 与 NFD 归一化后同名（用户从 macOS 打包的典型产物）
const nfc = 'chat_sessions/caf\u00e9.json'
const nfd = 'chat_sessions/cafe\u0301.json'
const normalize = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: nfc, data: sessionJson('caf\u00e9') },
  { name: nfd, data: sessionJson('cafe\u0301') },
])
const normalized = await run(normalize)
check(
  '4) NFC/NFD 同名 → 拒绝，不静默丢掉一份',
  normalized.failure !== null && normalized.staging.sessions.length === 0,
  `${normalized.failure?.key ?? '通过'} / 暂存 ${normalized.staging.sessions.length}`
)

// 5) 符号链接属性（unix mode 0xa000 落在外部位高 16 位）
const symlink = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'chat_sessions/evil.json', data: '/etc/passwd', external: 0xa1ff0000 },
])
const link = await run(symlink)
check(
  '5) 符号链接条目 → 拒绝（不能按「文件」去读目标）',
  link.failure.key === 'backupArchiveUnreadable' || link.failure.key === 'backupArchiveDamaged',
  link.failure.key
)

// 6) 加密标志位（bit0）
const encrypted = buildZip([
  { name: 'manifest.json', data: manifest, flags: 0x801 },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
])
const crypt = await run(encrypted)
check(
  '6) 加密条目 → 拒绝（不是我们支持的导出格式）',
  crypt.failure.key === 'backupArchiveUnreadable',
  crypt.failure.key
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a3] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
