// A8 · 畸形归档：manifest 字段类型全错
// 构造方式：把 manifest.json 的 export_format_version 写成对象 / 字符串 / 小数 / 更大版本 / 缺失，
//          以及 0 字节、顶层数组、null、多塞未知字段。
// 期望：每一种都拒绝，且「版本太新」与「版本不对」要区分开（升级提示 vs 文件不对）；
//      JSON 语法错与字段类型错也要区分开。
import {
  archiveFile,
  captureFailure,
  installHooks,
  manifestJson,
  sessionJson,
} from '../lib/harness.mjs'
import { buildZip } from '../lib/zip.mjs'

installHooks()
const { checkArchiveFormat } = await import('../../../src/services/chat/history/importArchive.ts')

console.log('[a8] A. 畸形归档 / manifest 字段类型异常')
console.log('构造方式：manifest.json 里的版本号被换成对象/字符串/小数/更大值/缺失，以及整份 JSON 换类型。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const attempt = async (manifestData) => {
  const bytes = buildZip([
    { name: 'manifest.json', data: manifestData },
    { name: 'chat_sessions/s1.json', data: sessionJson('s1') },
  ])
  try {
    await checkArchiveFormat(archiveFile(bytes))
    return null
  } catch (error) {
    return { key: error.key ?? error.name, params: error.params, message: error.message }
  }
}

const objectVersion = await attempt(JSON.stringify({ export_format_version: { major: 3 } }))
check(
  '1) 版本号是对象 → backupInvalidVersion（不是 backupIncomplete、也不是崩）',
  objectVersion.key === 'backupInvalidVersion',
  `${objectVersion.key} / ${objectVersion.message}`
)

const stringVersion = await attempt(JSON.stringify({ export_format_version: '3' }))
check(
  '2) 版本号是字符串 "3" → backupInvalidVersion',
  stringVersion.key === 'backupInvalidVersion',
  `${stringVersion.key}`
)

const floatVersion = await attempt(JSON.stringify({ export_format_version: 3.5 }))
check(
  '3) 版本号是小数 3.5 → 按「比当前新」处理（backupNewerVersion，提示升级；也可接受为 invalidVersion）',
  floatVersion.key === 'backupNewerVersion' || floatVersion.key === 'backupInvalidVersion',
  `${floatVersion.key}`
)

const newerVersion = await attempt(JSON.stringify({ export_format_version: 4 }))
check(
  '4) 版本号 4 > 当前 3 → backupNewerVersion（提示升级 App，而不是文件坏了）',
  newerVersion.key === 'backupNewerVersion',
  `${newerVersion.key} / ${newerVersion.message}`
)

const olderVersion = await attempt(JSON.stringify({ export_format_version: 2 }))
check('5) 版本号 2 → backupInvalidVersion', olderVersion.key === 'backupInvalidVersion', `${olderVersion.key}`)

const missingVersion = await attempt('{}')
check('6) 缺少版本号 → backupInvalidVersion', missingVersion.key === 'backupInvalidVersion', `${missingVersion.key}`)

const zeroByte = await attempt('')
check('7) 0 字节 manifest → backupInvalidJson', zeroByte.key === 'backupInvalidJson', `${zeroByte.key}`)

const arrayTop = await attempt('[3]')
check(
  '8) 顶层是数组 → backupIncomplete（语义上是「格式不对」，与「内容不完整」不完全一致）',
  arrayTop.key === 'backupIncomplete',
  `${arrayTop.key} / ${arrayTop.message}`
)

const nullTop = await attempt('null')
check('9) 顶层是 null → backupIncomplete', nullTop.key === 'backupIncomplete', `${nullTop.key}`)

const halfJson = await attempt('{"export_format_version":')
check('10) 截断的 JSON → backupInvalidJson', halfJson.key === 'backupInvalidJson', `${halfJson.key}`)

const extraField = await attempt(manifestJson({ future_field: { nested: [1, 2, 3] } }))
check(
  '11) 多出未知字段 → 忽略并放行（向后兼容：旧端不因新字段拒绝）',
  extraField === null,
  extraField ? `${extraField.key} / ${extraField.message}` : '通过'
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a8] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
