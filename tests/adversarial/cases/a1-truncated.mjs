// A1 · 畸形归档：截断 / 数据区不一致 / CRC 不符 / 不是 ZIP / 小于最小长度
// 构造方式：手工拼字节，逐项破坏 ZIP 尾部中央目录、条目声明尺寸、条目 CRC 与文件头。
// 期望：一律拒绝，并且提示指出「哪一段坏了」（#40 的要求：不再折叠成 backupIncomplete）。
// 实际：见下逐条输出。
import {
  archiveFile,
  captureFailure,
  installHooks,
  manifestJson,
  report,
  sessionJson,
  sessionPathOf,
} from '../lib/harness.mjs'
import { buildZip, flipByte, truncate } from '../lib/zip.mjs'

installHooks()
const { checkArchiveFormat } = await import('../../../src/services/chat/history/importArchive.ts')
const { listArchivePaths } = await import('../../../src/services/chat/history/zipReader.ts')

console.log('[a1] A. 畸形归档 / 截断与损坏')
console.log('构造方式：手工拼 ZIP 字节，破坏尾部目录、条目声明尺寸、CRC 与文件签名。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = manifestJson()
const healthy = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
  { name: sessionPathOf('s1_files/f1_image.png'), data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'chat_session_index.json', data: JSON.stringify([{ id: 's1' }]) },
])

// 0) 基线：健康包必须通过，否则后面的失败无意义。
let baselineOk = true
let baselineDetail = `${healthy.length} 字节`
try {
  await checkArchiveFormat(archiveFile(healthy))
} catch (error) {
  baselineOk = false
  baselineDetail = `意外失败 ${error.key ?? error.message}`
}
check('0) 健康包作为对照，必须通过', baselineOk, baselineDetail)

// 1) 尾部中央目录整段被切掉（下载中断 / 复制未完成）
const noTail = truncate(healthy, 200)
const cut = await captureFailure(() => checkArchiveFormat(archiveFile(noTail)))
check(
  '1) 中央目录被切掉 → 拒绝，且提示说「读不到文件目录」',
  cut.key === 'backupArchiveUnreadable',
  `${cut.key} / ${cut.message}`
)

// 2) 只丢 EOCD 尾部 10 字节（最常见的「差一点没下完」）
const shortTail = truncate(healthy, 10)
const short = await captureFailure(() => checkArchiveFormat(archiveFile(shortTail)))
check(
  '2) 只缺 10 字节尾部 → 拒绝（不能当成可导入）',
  short.key === 'backupArchiveUnreadable',
  `${short.key}`
)

// 3) 数据区被截断但目录仍在：条目声明了比实际更多的压缩字节
const lyingSize = buildZip([
  { name: 'manifest.json', data: manifest, compress: true, declaredPacked: 4096 },
  { name: sessionPathOf('s1'), data: sessionJson('s1') },
])
const lying = await captureFailure(() => checkArchiveFormat(archiveFile(lyingSize)))
check(
  '3) 条目声明尺寸大于实际 → 拒绝（当前落在 backupArchiveUnreadable，提示只说「读不到文件目录」，没指出是哪个条目）',
  lying.key === 'backupArchiveDamaged' || lying.key === 'backupArchiveUnreadable',
  `${lying.key} ${JSON.stringify(lying.params)}`
)

// 4) CRC 被篡改（内容是合法 JSON，只有校验和对不上）
const crcBroken = flipByte(
  buildZip([{ name: 'manifest.json', data: JSON.stringify({ export_format_version: 3, pad: 'aaaaaaaaaa' }) }]),
  // 定位到 payload 里的一个 'a'：跳过本地头 30 字节 + 文件名 13 字节
  30 + 'manifest.json'.length + 40
)
const crc = await captureFailure(() => checkArchiveFormat(archiveFile(crcBroken)))
check(
  '4) CRC 不符 → 拒绝，错误指向具体条目而不是整包',
  crc.key === 'backupArchiveDamaged' && crc.params?.entry === 'manifest.json',
  `${crc.key} ${JSON.stringify(crc.params)}`
)

// 5) 根本不是 ZIP（用户选了个 txt / 图片）
const text = await captureFailure(() => checkArchiveFormat(archiveFile(new TextEncoder().encode('not a zip'))))
check(
  '5) 非 ZIP → backupUnrecognized（提示去选导出包）',
  text.key === 'backupUnrecognized',
  `${text.key} / ${text.message}`
)

// 6) 有 PK 头但短于 ZIP 最小长度（22 字节 EOCD）
const stub = await captureFailure(() =>
  checkArchiveFormat(archiveFile(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0])))
)
check(
  '6) PK 头 + 10 字节 → 拒绝（不能崩、不能当成空包）',
  stub.key === 'backupArchiveUnreadable',
  `${stub.key}`
)

// 7) 附加：读不到目录时不能有任何「列出条目」的残留输出
const listed = await listArchivePaths(archiveFile(noTail))
check('7) 坏包 listArchivePaths 返回空数组而不是抛错', Array.isArray(listed) && listed.length === 0, JSON.stringify(listed))

report('健康包字节数', healthy.length)
report('截断后字节数', noTail.length)
const failed = checks.filter((item) => !item.pass)
console.log(`[a1] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
