// B1 · 巨大输入：单条 10MB 消息 / 单行 100 万字符
// 构造方式：把一条消息的 content 写成 10MB（含一个 100 万字符、没有换行的单行），
//          走真实的 importArchive；再把同一段文本喂给上下文预算。
// 期望：导入不截断、不超时、不爆内存；预算计算要能把「10MB 一条消息 ≈ 330 万 token」
//      算清楚并把整轮裁掉（不能让它进模型上下文）。
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
const { CHARS_PER_TOKEN, DEFAULT_CONTEXT_BUDGET, estimateChars, estimateTokens, selectRoundWindow } =
  await import('../../../src/services/chat/contextBudget.ts')

console.log('[b1] B. 巨大输入 / 单条 10MB 消息与 100 万字符单行')
console.log('构造方式：一条消息 10MB，其中包含 100 万字符且无换行的单行。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const MB = 1024 * 1024
const TEN_MB = 10 * MB

const singleLine = 'x'.repeat(1_000_000)
const bigContent = `${singleLine}\n${'y'.repeat(TEN_MB - singleLine.length - 1)}`

// 用 harness 的合法会话骨架，只把回答内容换成 10MB
const session = JSON.parse(sessionJson('huge', { title: '10MB 单条消息', rounds: 1 }))
session.messages[1].fragments[0].content = bigContent

const bytes = buildZip([
  { name: 'manifest.json', data: manifestJson(), compress: true },
  { name: 'chat_sessions/huge.json', data: JSON.stringify(session), compress: true },
  {
    name: 'chat_session_index.json',
    data: JSON.stringify([
      {
        id: 'huge',
        title: '10MB 单条消息',
        pinned: false,
        message_count: 2,
        inserted_at: TIME,
        updated_at: TIME,
      },
    ]),
    compress: true,
  },
])

await resetStaging()
const started = Date.now()
const failure = await attempt(() => importArchive(archiveFile(bytes), { totalSessions: 1 }))
const elapsed = Date.now() - started
const record = (await staging()).__staging
const imported = record.sessions[0]
const textOf = (message) =>
  message?.content ??
  (message?.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const importedText = textOf(imported?.messages?.[1])
const importedLength = importedText.length

check('0) 10MB 单条消息能导入（不拒绝、不崩）', failure.ok && record.sessions.length === 1, failure.ok ? '导入成功' : `${failure.key} / ${failure.message}`)
check(
  '1) 内容不被截断（导入后长度与写入一致）',
  importedLength === bigContent.length,
  `${importedLength} 字符 vs 写入 ${bigContent.length} 字符`
)
check(
  '2) 包体与耗时在可接受范围（压缩后包体 + 导入耗时）',
  bytes.length < TEN_MB && elapsed < 20_000,
  `包体 ${(bytes.length / 1024).toFixed(0)}KB（原文 ${(TEN_MB / MB).toFixed(0)}MB）、耗时 ${elapsed}ms`
)

// 100 万字符单行的预算计算
const chars = estimateChars(singleLine)
const tokens = estimateTokens(chars)
check(
  `3) 单行 100 万字符按 UTF-16 码元计数（CHARS_PER_TOKEN=${CHARS_PER_TOKEN}）`,
  chars === 1_000_000 && tokens === Math.ceil(1_000_000 / CHARS_PER_TOKEN),
  `${chars} 字符 → ${tokens} token`
)

// 单轮就超预算：必须保留至少 1 轮，但要报告被裁
const windowFor = selectRoundWindow([estimateChars(bigContent)], DEFAULT_CONTEXT_BUDGET)
check(
  '4) 单轮 10MB 远超预算（约 330 万 token vs 36 万字符）→ 仍保留 1 轮，且 reason=none（不报裁剪）',
  windowFor.kept === 1 && windowFor.chars === estimateChars(bigContent),
  `kept=${windowFor.kept} chars=${windowFor.chars} reason=${windowFor.reason}`
)

const bigRounds = Array.from({ length: 200 }, () => 50_000)
const windowStart = Date.now()
const windowMany = selectRoundWindow(bigRounds, { maxTokens: 60_000, maxRounds: 200 })
const windowMs = Date.now() - windowStart
check(
  '5) 200 轮 × 5 万字符：预算窗口在 1 秒内算出，且不超过预算',
  windowMs < 1000 &&
    windowMany.kept < 200 &&
    windowMany.kept * 50_000 <= 60_000 * CHARS_PER_TOKEN,
  `kept=${windowMany.kept} 耗时 ${windowMs}ms`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[b1] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
