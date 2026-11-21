// B2 · 巨大输入：2000 轮历史 / 500 会话索引
// 构造方式：2000 轮的会话喂给 selectRoundWindow；4000 行喂给虚拟列表布局与窗口计算；
//          500 个会话 + 500 条索引走真实 importArchive；索引里塞重复 id。
// 期望：都是多项式以内的耗时可接受；窗口连续、不越界；重复 id 不能静默丢会话。
import {
  archiveFile,
  attempt,
  installHooks,
  manifestJson,
  resetStaging,
  sessionJson,
  sessionPathOf,
  staging,
  TIME,
} from '../lib/harness.mjs'
import { buildZip } from '../lib/zip.mjs'

installHooks()
const { importArchive } = await import('../../../src/services/chat/history/importArchive.ts')
const { DEFAULT_CONTEXT_BUDGET, selectRoundWindow } = await import(
  '../../../src/services/chat/contextBudget.ts'
)
const { buildLayout, findWindow } = await import('../../../src/components/messages/virtualRows.ts')

console.log('[b2] B. 巨大输入 / 2000 轮历史与 500 会话索引')
console.log('构造方式：2000 轮预算窗口、4000 行虚拟列表、500 会话归档、索引重复 id。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 1) 2000 轮预算窗口
const rounds = Array.from({ length: 2000 }, (_, index) => 200 + (index % 7) * 10)
const started = Date.now()
const window2000 = selectRoundWindow(rounds, DEFAULT_CONTEXT_BUDGET)
const windowMs = Date.now() - started
check(
  '1) 2000 轮预算窗口：1 秒内算出，且窗口是「最新的连续若干轮」',
  windowMs < 1000 && window2000.kept === 200 && window2000.reason === 'rounds',
  `kept=${window2000.kept} reason=${window2000.reason} 耗时 ${windowMs}ms`
)

// 2) 虚拟列表：4000 行（2000 轮 × 2 条）
const heights = Array.from({ length: 4000 }, (_, index) => (index % 97 === 0 ? 900 : 120))
const layoutStart = Date.now()
const layout = buildLayout(heights)
const layoutMs = Date.now() - layoutStart
check(
  '2) 4000 行布局 100ms 内建好，总高度等于各行之和',
  layoutMs < 100 &&
    layout.total === heights.reduce((sum, value) => sum + value, 0) &&
    layout.offsets.length === 4000,
  `total=${layout.total}px 耗时 ${layoutMs}ms`
)

const windowAtTop = findWindow({ layout, scrollTop: 0, viewport: 700 })
const windowAtBottom = findWindow({ layout, scrollTop: layout.total - 700, viewport: 700, anchorEnd: true })
check(
  '3) 贴底窗口挂的是最后几条、贴顶窗口挂的是最开始几条',
  windowAtTop.start === 0 && windowAtBottom.end === 4000 && windowAtBottom.start > 3000,
  `top=[${windowAtTop.start},${windowAtTop.end}) bottom=[${windowAtBottom.start},${windowAtBottom.end})`
)
check(
  '4) 窗口高度 + 上下留白 = 总高度（不出现错位/抖动）',
  windowAtTop.topPad === 0 &&
    windowAtTop.topPad + (layout.offsets[windowAtTop.end] ?? layout.total) - layout.offsets[windowAtTop.start] + windowAtTop.bottomPad ===
      layout.total,
  `topPad=${windowAtTop.topPad} bottomPad=${windowAtTop.bottomPad}`
)

// 5) 500 会话归档
const SESSIONS = 500
const entries = [{ name: 'manifest.json', data: manifestJson() }]
const index = []
for (let index_ = 1; index_ <= SESSIONS; index_ += 1) {
  const id = `bulk-${index_}`
  entries.push({ name: sessionPathOf(id), data: sessionJson(id) })
  index.push({
    id,
    title: `会话 ${index_}`,
    pinned: false,
    message_count: 2,
    inserted_at: TIME,
    updated_at: TIME,
  })
}
entries.push({ name: 'chat_session_index.json', data: JSON.stringify(index) })

await resetStaging()
const importStart = Date.now()
const bulkFailure = await attempt(() =>
  importArchive(archiveFile(buildZip(entries)), { totalSessions: SESSIONS })
)
const importMs = Date.now() - importStart
const bulkStaging = (await staging()).__staging
check(
  `5) ${SESSIONS} 个会话来一次导入：${SESSIONS} 条全部进暂存，耗时可接受`,
  bulkFailure.ok && bulkStaging.sessions.length === SESSIONS && importMs < 60_000,
  bulkFailure ? `${bulkFailure.key}` : `${bulkStaging.sessions.length} 条 / ${importMs}ms`
)

// 6) 索引 500 条但只有 499 个会话文件（重复 id 混在里面）
const dupIndex = index.slice(0, SESSIONS - 1).concat([index[0]])
const dupEntries = entries.slice(0, SESSIONS).concat([
  { name: 'chat_session_index.json', data: JSON.stringify(dupIndex) },
])
await resetStaging()
let dupFailure = null
try {
  await importArchive(archiveFile(buildZip(dupEntries)), { totalSessions: SESSIONS })
} catch (error) {
  dupFailure = { key: error.key ?? error.name, message: error.message }
}
const dupStaging = (await staging()).__staging
check(
  `6) 索引 ${dupIndex.length} 条（含重复 id）但只有 ${SESSIONS - 1} 个会话文件 → 拒绝（id 集合不等），提示只说「内容不完整」不点出重复 id`,
  dupFailure !== null && dupFailure.key === 'backupIncomplete' && dupStaging.sessions.length <= SESSIONS,
  dupFailure ? `${dupFailure.key} / 暂存 ${dupStaging.sessions.length} 条` : '导入成功（未按重复 id 拒绝）'
)

const failed = checks.filter((item) => !item.pass)
console.log(`[b2] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
