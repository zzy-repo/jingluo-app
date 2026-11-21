// A7 · 畸形归档：ZIP 炸弹 / 声明尺寸撒谎
// 构造方式：
//   1) 32MB 全零数据压成 deflate（压缩比 ~1000:1），看导入端有没有解压上限；
//   2) 中央目录与局部头把「解压后尺寸」写成 4GB，实际压缩数据只有几十 KB；
//   3) 静态审计 zipReader 里有没有解压闸（压缩比 + 解压后总量）。
// 期望：解压闸要拦住炸弹并给出拒绝提示（不能靠内存兜底），声明尺寸撒谎要拒绝而不是按声明预分配。
import { readFileSync } from 'node:fs'
import {
  archiveFile,
  attempt,
  installHooks,
  manifestJson,
  resetStaging,
  sessionJson,
  staging,
  TIME,
} from '../lib/harness.mjs'
import { buildZip } from '../lib/zip.mjs'

installHooks()
const { importArchive } = await import('../../../src/services/chat/history/importArchive.ts')

console.log('[a7] A. 畸形归档 / ZIP 炸弹与撒谎尺寸')
console.log('构造方式：32MB 全零高度可压缩条目、解压尺寸写成 4GB 的条目。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const rss = () => Math.round(process.memoryUsage().rss / (1024 * 1024))

const MB = 1024 * 1024
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

// 1) 32MB 全零会话文件（压缩比极高）
// 合法会话骨架 + 32MB 的 padding 字段（内容是合法 JSON，只是大）
const bombSessionObj = JSON.parse(sessionJson('bomb', { title: 'bomb', rounds: 1 }))
bombSessionObj.padding = ' '.repeat(32 * MB)
const bombSession = JSON.stringify(bombSessionObj)
const bytes = buildZip([
  { name: 'manifest.json', data: manifestJson(), compress: true },
  { name: 'chat_sessions/bomb.json', data: bombSession, compress: true },
  { name: 'chat_session_index.json', data: indexOf(['bomb']), compress: true },
])
const ratio = bombSession.length / bytes.length

await resetStaging()
const rssBefore = rss()
const started = Date.now()
const failure = await attempt(() => importArchive(archiveFile(bytes), { totalSessions: 1 }))
const elapsed = Date.now() - started
const rssAfter = rss()
const staged = (await staging()).__staging
console.log(
  `  压缩比 ${ratio.toFixed(0)}:1（原文 ${(bombSession.length / MB).toFixed(1)}MB → 包体 ${(bytes.length / 1024).toFixed(0)}KB），耗时 ${elapsed}ms，RSS ${rssBefore}MB → ${rssAfter}MB`
)
check(
  `1) 压缩比 ${ratio.toFixed(0)}:1 的 32MB 条目 → 被解压闸（压缩比 + 解压后总量）拒绝，且不爆内存`,
  !failure.ok && staged.sessions.length === 0 && elapsed < 30_000 && rssAfter - rssBefore < 256,
  failure.ok
    ? `仍按原样导入（解压闸没生效）/ ${elapsed}ms / ΔRSS ${rssAfter - rssBefore}MB`
    : `${failure.key} / ${elapsed}ms / ΔRSS ${rssAfter - rssBefore}MB`
)

// 2) 声明解压尺寸撒谎：写 4GB，实际只有几十 KB
const liar = buildZip([
  { name: 'manifest.json', data: manifestJson(), compress: true, declaredSize: 4 * 1024 * MB },
  { name: 'chat_sessions/s1.json', data: '{}' },
  { name: 'chat_session_index.json', data: indexOf(['s1']) },
])
await resetStaging()
const rssBeforeLiar = rss()
const liarFailure = await attempt(() => importArchive(archiveFile(liar), { totalSessions: 1 }))
const rssAfterLiar = rss()
check(
  '2) 解压尺寸写成 4GB（撒谎）→ 拒绝，且不按声明预分配内存（ΔRSS 很小）',
  !liarFailure.ok && rssAfterLiar - rssBeforeLiar < 256,
  `${liarFailure.key} / ΔRSS ${rssAfterLiar - rssBeforeLiar}MB`
)

// 3) 静态审计：解压上限（压缩比 + 解压后总量）与条目名长度上限都在
const reader = readFileSync(new URL('../../../src/services/chat/history/zipReader.ts', import.meta.url), 'utf8')
const caps = ['MAX_INFLATE_RATIO', 'RATIO_MIN_OUTPUT_BYTES', 'MAX_INFLATE_TOTAL_BYTES', 'MAX_PATH_BYTES']
const missing = caps.filter((name) => !reader.includes(name))
check(
  '3) zipReader 里有解压闸（压缩比 + 解压后总量）与条目名长度上限常量',
  missing.length === 0,
  missing.length === 0 ? `齐备：${caps.join(', ')}` : `缺：${missing.join(', ')}`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[a7] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
