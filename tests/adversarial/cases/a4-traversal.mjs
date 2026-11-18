// A4 · 畸形归档：路径穿越 / 绝对路径 / 盘符 / 反斜杠 / NUL / 非 UTF-8 文件名
// 构造方式：把恶意路径直接写进 ZIP 条目名，文件名可以是任意字节。
// 期望：目录解析阶段就全部拒绝，并且**一个字节都不写**（暂存里不能出现任何会话）；
//      同时不能用「URL 编码绕过」把会话 id 变成路径。
import {
  archiveFile,
  captureFailure,
  installHooks,
  manifestJson,
  resetStaging,
  sessionJson,
  staging,
} from '../lib/harness.mjs'
import { buildZip, utf16le } from '../lib/zip.mjs'

installHooks()
const { importArchive } = await import('../../../src/services/chat/history/importArchive.ts')
const { listArchivePaths } = await import('../../../src/services/chat/history/zipReader.ts')

console.log('[a4] A. 畸形归档 / 路径穿越与非法文件名')
console.log('构造方式：把 ../../etc/passwd、绝对路径、盘符、反斜杠、NUL 字节直接写进条目名。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = manifestJson()
const attack = async (name, extra = {}) => {
  await resetStaging()
  const bytes = buildZip([
    { name: 'manifest.json', data: manifest },
    { name, data: sessionJson('s1'), ...extra },
  ])
  let failure = null
  try {
    await importArchive(archiveFile(bytes), { totalSessions: 1 })
  } catch (error) {
    failure = { key: error.key ?? error.name, params: error.params, message: error.message }
  }
  const record = (await staging()).__staging
  return { failure, sessions: record.sessions.length, files: record.files.length }
}

const cases = [
  ['../../etc/passwd', '相对穿越'],
  ['/etc/passwd', '绝对路径'],
  ['C:/Users/x/evil.json', 'Windows 盘符'],
  ['..\\..\\windows\\system32\\evil.json', '反斜杠穿越'],
  ['chat_sessions/../../evil.json', '合法前缀 + 穿越'],
  ['chat_sessions//evil.json', '空段'],
  ['chat_sessions/./evil.json', '当前目录段'],
  ['chat_sessions/evil.json/..', '尾部 ..'],
]

for (const [name, label] of cases) {
  const result = await attack(name)
  check(
    `${label} 「${name}」 → 拒绝且不写入任何字节`,
    result.failure !== null && result.sessions === 0 && result.files === 0,
    `${result.failure?.key ?? '通过'} / 会话 ${result.sessions} / 文件 ${result.files}`
  )
}

// NUL 字节（C 层截断的经典手法）：条目名里塞 0x00
const nulName = new Uint8Array([...new TextEncoder().encode('chat_sessions/evil.json'), 0x00, 0x2e, 0x2e])
await resetStaging()
const nulBytes = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: nulName, data: sessionJson('s1') },
])
let nulFailure = null
try {
  await importArchive(archiveFile(nulBytes), { totalSessions: 1 })
} catch (error) {
  nulFailure = { key: error.key ?? error.name, message: error.message }
}
check(
  'NUL 字节文件名 → 拒绝',
  nulFailure !== null && (await staging()).__staging.sessions.length === 0,
  nulFailure?.key ?? '通过'
)

// UTF-16LE 编码的文件名字节（不带 UTF-8 标志位）：高位有 0x00 与 ASCII 的间隔
await resetStaging()
const utf16Bytes = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: utf16le('chat_sessions/x.json'), data: sessionJson('x'), utf8: false },
])
let utf16Failure = null
try {
  await importArchive(archiveFile(utf16Bytes), { totalSessions: 1 })
} catch (error) {
  utf16Failure = { key: error.key ?? error.name, message: error.message }
}
check(
  'UTF-16LE 文件名（无 UTF-8 标志）→ 拒绝',
  utf16Failure !== null && (await staging()).__staging.sessions.length === 0,
  utf16Failure?.key ?? '通过'
)

// 非 UTF-8 标志 + 高位字节（0xe9 = latin1 的 é）
const latin1 = new Uint8Array([...new TextEncoder().encode('chat_sessions/caf'), 0xe9, 0x2e, ...new TextEncoder().encode('json')])
const latin1Archive = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: latin1, data: sessionJson('x'), utf8: false },
])
const latin1Paths = await listArchivePaths(archiveFile(latin1Archive))
check('latin1 文件名（无 UTF-8 标志）→ 目录不可读（路径列表为空）', latin1Paths.length === 0, JSON.stringify(latin1Paths))

// 边界：URL 编码的 '..' 不会被当成路径，只会当成会话 id；它落不到文件系统上（IndexedDB 键）。
const encodedId = 'chat_sessions/..%2f..%2fevil.json'
await resetStaging()
const encodedArchive = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: encodedId, data: sessionJson('..%2f..%2fevil') },
  { name: 'chat_session_index.json', data: JSON.stringify([{ id: '..%2f..%2fevil', title: null, pinned: false, message_count: 2, inserted_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' }]) },
])
let encodedFailure = null
try {
  await importArchive(archiveFile(encodedArchive), { totalSessions: 1 })
} catch (error) {
  encodedFailure = { key: error.key ?? error.name, message: error.message }
}
const encodedRecord = (await staging()).__staging
check(
  'URL 编码的 .. 只当普通会话 id，不落文件系统（无穿越面）',
  encodedFailure === null ? encodedRecord.sessions.length === 1 : true,
  encodedFailure?.key ?? `导入 1 个会话 id=${encodedRecord.sessions[0]?.id ?? '-'}`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a4] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
