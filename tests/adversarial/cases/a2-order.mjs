// A2 · 畸形归档：条目顺序异常
// 构造方式：
//   a) 物理顺序正常、中央目录顺序整个反过来（有些工具会这么重打包）；
//   b) index 提前到会话之前（导出端本来就是「manifest → 会话 → index → 图片」，这里把 index 抽到前面）；
//   c) index 抢在 manifest 前面；
//   d) manifest 落在最后。
// 期望：a/b 必须照常导入（顺序不是格式的一部分）；c/d 必须拒绝并指出「第一个文件是 X，不是 manifest」。
import {
  archiveFile,
  captureFailure,
  indexJson,
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

console.log('[a2] A. 畸形归档 / 条目顺序异常')
console.log('构造方式：同一份内容用三种条目顺序重打包，另有两份把 manifest 挪走。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const safe = async (run) => {
  try {
    await run()
    return null
  } catch (error) {
    return { key: error.key ?? error.name, params: error.params, message: error.message }
  }
}

const manifest = manifestJson()
const s1 = sessionJson('s1', { title: '顺序一' })
const s2 = sessionJson('s2', { title: '顺序二' })
const index = indexJson(['s1', 's2'])

// a) 中央目录倒序
const reversed = buildZip(
  [
    { name: 'manifest.json', data: manifest, centralOrder: 3 },
    { name: sessionPathOf('s1'), data: s1, centralOrder: 2 },
    { name: sessionPathOf('s2'), data: s2, centralOrder: 1 },
    { name: 'chat_session_index.json', data: index, centralOrder: 0 },
  ]
)
const a = await safe(() => checkArchiveFormat(archiveFile(reversed)))
check('a) 中央目录顺序与物理顺序相反 → 仍然通过（按物理顺序读）', a === null, a ? a.key : '')

// b) index 提前，且 importArchive 要能真的导入
await resetStaging()
const earlyIndex = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'chat_session_index.json', data: index },
  { name: sessionPathOf('s1'), data: s1 },
  { name: sessionPathOf('s2'), data: s2 },
])
const b = await safe(() => importArchive(archiveFile(earlyIndex), { totalSessions: 2 }))
const stagingAfter = (await staging()).__staging
check(
  'b) index 排在会话之前 → 期望导入成功（顺序不是格式的一部分）；实际报了「内容不完整」',
  b === null && stagingAfter.sessions.length === 2,
  b ? `${b.key} ${b.message}` : `暂存 ${stagingAfter.sessions.length} 个会话`
)

// c) index 抢在 manifest 之前
const indexFirst = buildZip([
  { name: 'chat_session_index.json', data: index },
  { name: 'manifest.json', data: manifest },
  { name: sessionPathOf('s1'), data: s1 },
])
const c = await safe(() => checkArchiveFormat(archiveFile(indexFirst)))
check(
  'c) 第一个条目是 index → backupManifestNotFirst，且带出 found / expected',
  c?.key === 'backupManifestNotFirst' &&
    c?.params?.found === 'chat_session_index.json' &&
    c?.params?.expected === 'manifest.json',
  c ? `${c.key} ${JSON.stringify(c.params)}` : '通过了（不符合期望）'
)

// d) manifest 在最后
const manifestLast = buildZip([
  { name: sessionPathOf('s1'), data: s1 },
  { name: 'manifest.json', data: manifest },
])
const d = await safe(() => checkArchiveFormat(archiveFile(manifestLast)))
check(
  'd) manifest 在最后 → 同样按 backupManifestNotFirst 报出实际的首个文件名',
  d?.key === 'backupManifestNotFirst' && d?.params?.found === 'chat_sessions/s1.json',
  d ? `${d.key} ${JSON.stringify(d.params)}` : '通过了（不符合期望）'
)

// e) 图片夹在两个会话之间（交错顺序），必须照样导入
await resetStaging()
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const interleaved = buildZip([
  { name: 'manifest.json', data: manifest },
  {
    name: sessionPathOf('s1'),
    data: sessionJson('s1', {
      extra: {},
    }),
  },
  { name: 'chat_sessions/s1_files/f1_image.png', data: image },
  { name: sessionPathOf('s2'), data: s2 },
  { name: 'chat_session_index.json', data: index },
])
const e = await safe(() => importArchive(archiveFile(interleaved), { totalSessions: 2 }))
check(
  'e) 会话与图片交错、index 在末尾 → 导入成功',
  e === null,
  e ? `${e.key} ${e.message}` : `暂存 ${(await staging()).__staging.sessions.length} 个会话`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a2] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
