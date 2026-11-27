// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #955
//
// ⚠️ 本文件是**源码契约**，不是渲染证据。仓库的测试层没有 JSX/TSX 转译（`UserMessage.tsx` 无法被
// Node 直接 import：`src/components/**` 里可测的组件都写成 `.ts` + `createElement`，见
// `tests/unit/import-skipped-ui.test.mjs` 用 `react-dom/server` 渲染 `importSkipped.ts`）。
// 因此本用例只能钉住「源码里怎么渲染」＋「文案逐字是什么」，**不能证明屏幕上长对了**。
// 画面证据（390/360 截图或 DOM 断言）在 #955 证据矩阵里仍记作「缺」—— 别把本文件当成立项。
//
// 钉住四件事（任何一条被改掉，用户要么看不到提示、要么又被「两种原因」混成一句）：
//   [1] 提示块只在有跳过项时出现，且仍是同一条可折叠的 `role="note"`（不新增红色失败条）
//   [2] 「缺少原件」与「本机读取失败」**分成两组**，用各自主文案渲染，组内逐个列出文件名
//   [3] 旧文案 `attachMissingList` 一字未改（既有消息的渲染结果不变）
//   [4] 新文案 zh / en 成对、占位符对齐、en 无中文；`attachUnreadableHint` 不带占位符
//
//   node tests/unit/user-message-unreadable-notice-955.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

const USER_MESSAGE = 'src/components/messages/UserMessage.tsx'
const source = sourceOf(USER_MESSAGE)
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 取一段源码里从 `from` 起、到 `to` 止的片段（找不到就把原文报出来，避免「断言悄悄跳过」） */
const slice = (from, to, label) => {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `${label}：源码里找不到起点 ${JSON.stringify(from)}`)
  const end = source.indexOf(to, start + from.length)
  assert.ok(end > start, `${label}：源码里找不到终点 ${JSON.stringify(to)}`)
  return source.slice(start, end + to.length)
}

test('[1] 提示块仍挂在同一条 role="note" 折叠区里，且只在有跳过项时出现', () => {
  const block = slice('{unavailable.length > 0 ? (', '</div>', '提示块')
  assert.match(block, /role="note"/, '提示区必须仍是 role="note"（读屏可见、不是视觉隐藏）')
  assert.match(block, /attachUnavailableSent/, '标题仍用「附件详情 · 已跳过 N 个」')
  assert.match(block, /<details/, '仍是可折叠的 details，不占满屏幕')
})

test('[2] 两种原因分成两组，各用各的文案，组内逐个列出文件名', () => {
  const missing = slice('{missingSources.length > 0 && (', '</>', '「缺少原件」组')
  assert.match(missing, /attachMissingList/, '缺少原件组必须用 attachMissingList')
  assert.match(missing, /missingSources\.map\(/, '缺少原件组必须逐个列出（不是只给个数）')
  assert.match(missing, /file\.name/, '每个条目要显示文件名（用户要认得出是哪份）')

  const unreadable = slice('{unreadableSources.length > 0 && (', '</>', '「本机读取失败」组')
  assert.match(unreadable, /attachUnreadableList/, '本机读取失败组必须用 attachUnreadableList')
  assert.match(unreadable, /unreadableSources\.map\(/, '本机读取失败组必须逐个列出')
  assert.match(unreadable, /file\.name/, '每个条目要显示文件名')
  assert.match(unreadable, /attachUnreadableHint/, '本机读取失败组必须带一句解释（告诉用户原件还在）')

  // 两个分组由不同的 reason 计算得来：读不出来的不许计入「缺少原件」
  assert.match(source, /reason !== 'source-unreadable'/, 'missingSources 必须排除 source-unreadable')
  assert.match(source, /reason === 'source-unreadable'/, 'unreadableSources 必须只取 source-unreadable')
})

test('[3] 旧文案一字未改（既有消息的渲染结果不变）', () => {
  // 这两句是 #379 定下的原话：#955 只新增一组，不改旧的一字。
  assert.equal(zh.attachMissingList, '缺少原件，已跳过（{count}）')
  assert.equal(en.attachMissingList, 'Missing file, skipped ({count})')
  assert.equal(zh.attachUnavailableSent, '附件详情 · 已跳过 {count} 个')
})

test('[4] 新文案 zh / en 成对、占位符对齐、en 无中文', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const hasCjk = (text) => /[\u4e00-\u9fff]/.test(text)

  assert.equal(typeof zh.attachUnreadableList, 'string')
  assert.equal(typeof en.attachUnreadableList, 'string')
  assert.deepEqual(placeholders(zh.attachUnreadableList), placeholders(en.attachUnreadableList))
  assert.deepEqual(placeholders(zh.attachUnreadableList), ['count'], '列表主文案只要 count')
  assert.ok(!hasCjk(en.attachUnreadableList), 'en 文案里不许出现中文')

  assert.equal(typeof zh.attachUnreadableHint, 'string')
  assert.equal(typeof en.attachUnreadableHint, 'string')
  assert.deepEqual(placeholders(zh.attachUnreadableHint), [], '解释句不带占位符（它不依赖数量）')
  assert.deepEqual(placeholders(en.attachUnreadableHint), [])
  assert.ok(!hasCjk(en.attachUnreadableHint), 'en 文案里不许出现中文')

  // 用户真正读到的那两句的关键语义：原件还在 + 消息已发出（不是「失败」）
  assert.match(zh.attachUnreadableHint, /原件还在本机/)
  assert.match(zh.attachUnreadableHint, /消息已照常发出/)
  assert.ok(!/上传失败/.test(zh.attachUnreadableHint), '新文案不许出现「上传失败」（那正是本单要消掉的错误归因）')
})
