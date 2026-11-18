// A5 · 畸形归档：超长文件名 / BOM / UTF-16
// 构造方式：
//   1) 300 字节与 60000 字节的条目名（没有任何长度上限）；
//   2) manifest.json 内容前加 UTF-8 BOM；
//   3) manifest.json 内容用 UTF-16LE + BOM 编码；
//   4) manifest 文件名前加 UTF-8 BOM（肉眼看不见的差别）；
//   5) 文件名写成大写 MANIFEST.JSON（Windows 用户重新打包的典型产物）。
// 期望：非法编码要拒绝；能读的要在提示里让人看懂差在哪；名字长度没有上限这件事要有记录。
import {
  archiveFile,
  captureFailure,
  installHooks,
  manifestJson,
  resetStaging,
  sessionJson,
  staging,
  TIME,
} from '../lib/harness.mjs'
import { buildZip, utf8WithBom } from '../lib/zip.mjs'

installHooks()
const { checkArchiveFormat, importArchive } = await import(
  '../../../src/services/chat/history/importArchive.ts'
)
const { listArchivePaths } = await import('../../../src/services/chat/history/zipReader.ts')

console.log('[a5] A. 畸形归档 / 超长名字、BOM、UTF-16')
console.log('构造方式：超长条目名、UTF-8 BOM、UTF-16LE 内容、BOM 前缀的文件名、大小写变体。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = manifestJson()
const indexOf = (ids) =>
  JSON.stringify(
    ids.map((id) => ({
      id,
      title: 't',
      pinned: false,
      message_count: 1,
      inserted_at: TIME,
      updated_at: TIME,
    }))
  )

// 1) 超长条目名：259 字节（在 1024 字节上限之内，必须照常接受）
const longName = `chat_sessions/${'a'.repeat(240)}.json`
await resetStaging()
const longBytes = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: longName, data: sessionJson('a'.repeat(240)) },
])
const longPaths = await listArchivePaths(archiveFile(longBytes))
check(
  `1) ${longName.length} 字节条目名 → 未超上限，照常接受（不误杀正常附件名）`,
  longPaths.length === 2 && longPaths.includes(longName),
  `目录列出 ${longPaths.length} 个条目，最长 ${Math.max(0, ...longPaths.map((path) => path.length))} 字符`
)

// 2) 超长条目名：60019 字节（ZIP 允许到 65535，但没有上限就能把路径校验和落盘撑爆）
const hugeName = `chat_sessions/${'b'.repeat(60000)}.json`
const hugeBytes = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: hugeName, data: sessionJson('b'.repeat(60000)) },
])
const hugePaths = await listArchivePaths(archiveFile(hugeBytes))
await resetStaging()
const hugeFailure = await captureFailure(() => importArchive(archiveFile(hugeBytes), { totalSessions: 1 }))
check(
  '2) 60019 字节条目名 → 超上限被拒绝，不崩、不写入暂存',
  !hugeFailure.ok && hugePaths.length === 0 && (await staging()).__staging.sessions.length === 0,
  `${hugeFailure.key} / 目录列出 ${hugePaths.length} 个条目 / 暂存 ${(await staging()).__staging.sessions.length}`
)

// 3) manifest 内容带 UTF-8 BOM
const bomContent = buildZip([
  { name: 'manifest.json', data: utf8WithBom(manifest) },
  { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
  { name: 'chat_session_index.json', data: indexOf(['s1']) },
])
await resetStaging()
let bomFailure = null
try {
  await importArchive(archiveFile(bomContent), { totalSessions: 1 })
} catch (error) {
  bomFailure = { key: error.key ?? error.name, message: error.message }
}
check(
  '3) manifest 内容带 UTF-8 BOM → 通过（Blob.text() 按 UTF-8 解码会吞掉 BOM）',
  bomFailure === null && (await staging()).__staging.sessions.length === 1,
  bomFailure ? `${bomFailure.key} / ${bomFailure.message}` : '导入成功'
)

// 4) manifest 内容为 UTF-16LE + BOM
const utf16Body = new TextEncoder().encode(manifest)
const utf16Content = new Uint8Array(2 + utf16Body.length * 2)
utf16Content.set([0xff, 0xfe])
for (let index = 0; index < utf16Body.length; index += 1) {
  utf16Content[2 + index * 2] = utf16Body[index]
  utf16Content[2 + index * 2 + 1] = 0
}
const utf16Json = buildZip([
  { name: 'manifest.json', data: utf16Content },
  { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
])
const utf16Failure = await captureFailure(() => checkArchiveFormat(archiveFile(utf16Json)))
check(
  '4) UTF-16LE 内容 → backupInvalidJson（不是有效 JSON）',
  utf16Failure.key === 'backupInvalidJson',
  `${utf16Failure.key} / ${utf16Failure.message}`
)

// 5) 文件名前有 UTF-8 BOM：名字的第一个字符是 U+FEFF
// TextDecoder 默认 ignoreBOM=false，会把名字开头的 BOM 吞掉，于是这个名字被当成 manifest.json
const bomName = buildZip([
  { name: '\uFEFFmanifest.json', data: manifest },
  { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
  { name: 'chat_session_index.json', data: indexOf(['s1']) },
])
await resetStaging()
let bomNameFailure = null
try {
  await importArchive(archiveFile(bomName), { totalSessions: 1 })
} catch (error) {
  bomNameFailure = { key: error.key ?? error.name, message: error.message }
}
check(
  '5) 名字开头带 BOM 的 manifest → TextDecoder 吞掉 BOM 后按 manifest.json 接受（宽容且一致）',
  bomNameFailure === null && (await staging()).__staging.sessions.length === 1,
  bomNameFailure ? `${bomNameFailure.key} / ${bomNameFailure.message}` : '导入成功'
)

// 6) 大小写变体：MANIFEST.JSON（Windows 上不区分大小写，重新打包很容易变成这样）
const upperName = buildZip([
  { name: 'MANIFEST.JSON', data: manifest },
  { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
])
const upperFailure = await captureFailure(() => checkArchiveFormat(archiveFile(upperName)))
check(
  '6) 大小写不同的 manifest 名 → 拒绝，提示指出实际名字是 MANIFEST.JSON',
  upperFailure.key === 'backupManifestNotFirst' && upperFailure.params?.found === 'MANIFEST.JSON',
  `${upperFailure.key} / found=${upperFailure.params?.found}`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a5] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
