// B3 · 巨大输入：10 万 emoji / 10 万组合字符
// 构造方式：内容里塞 10 万个 emoji（代理对）与 10 万个「e + 组合重音符」，
//          检查字符计数、token 估算、裁剪边界，以及代码里有没有按「用户感知字符」处理的能力。
// 期望：「按码元计数、偏保守多裁」是可接受方向；但代理对不能被切一半，
//      并且要明确记录「没有 Intl.Segmenter / grapheme 处理」这件事（弱 WebView 上的差异因此为 0）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
const { CHARS_PER_TOKEN, estimateChars, estimateTokens } = await import(
  '../../../src/services/chat/contextBudget.ts'
)

console.log('[b3] B. 巨大输入 / 10 万 emoji 与组合字符')
console.log('构造方式：10 万 emoji（20 万码元）与 10 万组合字符（20 万码元）各走一遍导入与预算。')

const checks = []
const check = (label, pass, detail) => {
  checks.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const emoji = '😀'.repeat(100_000)
const combining = 'e\u0301'.repeat(100_000)

// 1) 计数口径：按 UTF-16 码元
check(
  '1) 10 万 emoji 按码元计为 20 万（用户感知是 10 万字，估算偏大 → 多裁，安全方向）',
  estimateChars(emoji) === 200_000 && estimateChars(combining) === 200_000,
  `emoji ${estimateChars(emoji)} 码元 / 组合字符 ${estimateChars(combining)} 码元`
)

// 2) token 估算同步偏大
check(
  `2) token 估算 = ceil(码元 / ${CHARS_PER_TOKEN})，emoji 内容因此被估成 2 倍 token`,
  estimateTokens(estimateChars(emoji)) === Math.ceil(200_000 / CHARS_PER_TOKEN),
  `${estimateTokens(estimateChars(emoji))} token`
)

// 3) 不切断代理对：按 UTF-16 下标切片会切出孤立代理
const half = emoji.slice(0, 3)
check(
  '3) 若按码元下标截断会产生孤立代理（此处确认风险来源，裁剪本身按轮进行、不切字符串）',
  /[\uD800-\uDBFF]$/.test(half),
  `emoji.slice(0,3) 末字符是 ${JSON.stringify(half.at(-1))}`
)

// 4) 10 万 emoji 会话真跑一次导入
// 合法会话骨架 + 把两轮内容换成 emoji / 组合字符
const session = JSON.parse(sessionJson('emoji', { title: 'emoji 压力', rounds: 1 }))
session.messages[0].fragments[0].content = emoji
session.messages[1].fragments[0].content = combining
const bytes = buildZip([
  { name: 'manifest.json', data: manifestJson(), compress: true },
  { name: 'chat_sessions/emoji.json', data: JSON.stringify(session), compress: true },
  {
    name: 'chat_session_index.json',
    data: JSON.stringify([
      { id: 'emoji', title: 'emoji 压力', pinned: false, message_count: 2, inserted_at: TIME, updated_at: TIME },
    ]),
    compress: true,
  },
])
await resetStaging()
const failure = await attempt(() => importArchive(archiveFile(bytes), { totalSessions: 1 }))
const stored = (await staging()).__staging.sessions[0]
const textOf = (message) =>
  message?.content ??
  (message?.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const storedEmoji = textOf(stored?.messages?.[0])
const storedCombining = textOf(stored?.messages?.[1])
check(
  '4) 10 万 emoji / 10 万组合字符都能原样存进暂存（长度与码点都不变）',
  failure.ok &&
    storedEmoji === emoji &&
    storedCombining === combining &&
    [...storedEmoji].length === 100_000,
  failure.ok ? `emoji ${storedEmoji.length} 码元 / ${[...storedEmoji].length} 码点` : `${failure.key} / ${failure.message}`
)

// 5) 静态审计：代码里有没有按「用户感知字符」处理的能力
const roots = ['src']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path)
    } else if (/\.(ts|tsx|mjs|js|jsx)$/.test(name)) {
      files.push(path)
    }
  }
}
for (const root of roots) {
  walk(root)
}
const segmenterHits = files.filter((path) => /Intl\.Segmenter|grapheme/i.test(readFileSync(path, 'utf8')))
console.log(`  静态审计：${files.length} 个源文件，命中 Intl.Segmenter / grapheme 的文件 ${segmenterHits.length} 个：${segmenterHits.join(', ') || '无'}`)
check(
  '5) 记录现状：没有任何 Intl.Segmenter / grapheme 处理（因此弱 WebView 上不会出现「降级差异」，只会统一偏保守）',
  segmenterHits.length === 0,
  segmenterHits.length === 0 ? '无命中（不存在按字素切分的能力）' : `命中：${segmenterHits.join(', ')}`
)

const failed = checks.filter((item) => !item.pass)
console.log(`[b3] ${checks.length - failed.length}/${checks.length} 项符合期望`)
process.exit(failed.length === 0 ? 0 : 1)
