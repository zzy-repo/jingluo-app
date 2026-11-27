// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `scripts/lib/inlineDocRefs.mjs` 的单测 —— 对应 #946。
//
// 为什么需要：`gen-capabilities-docs.mjs --check` 原来只比对**它自己生成**的明细表，
// 正文里人写的 `路径:行 ⇒ 片段` 断言它看不见。2026-11-27 #944 往 `collector.ts` 插 10 行，
// 12 处正文引用集体 +10：`--check` 打印「✔ 一致」，`check:doc-refs` 红 12 条，
// 把 CI 焊死在第一个失败步骤（后面 i18n / 类型 / lint / 单测全 skipped）。
//
// 这条测试钉的是「第二关」的两个纯函数：**从门禁的 JSON 里挑哪些算自己的**、
// **哪些能唯一定位就自动重锚**。判定本身不在这层（判据只有 check-doc-refs 一份）。

import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyInlineRefEdit,
  applyInlineRefEdits,
  CAPABILITY_DOC_PREFIX,
  filterCapabilityDocFails,
  lineOf,
  planInlineRefFixes,
  PLAUSIBLE_DRIFT_LINES,
} from '../../scripts/lib/inlineDocRefs.mjs'

const fail = (over = {}) => ({
  doc: 'docs/capabilities/host.md',
  docLine: 224,
  raw: 'src/a.ts:10',
  target: 'src/a.ts',
  expect: 'const x = 1',
  kind: 'content-mismatch',
  verdict: 'fail',
  ...over,
})

/** 目标文件替身：按行数组给出内容。 */
const reader = (lines) => (target) => (target === 'src/a.ts' ? lines.join('\n') : null)

test('只看 docs/capabilities/ 下的失败项 —— 别的文档归别人', () => {
  const fails = [
    fail(),
    fail({ doc: 'docs/ui/README.md' }),
    fail({ doc: 'docs/capabilities/sub/x.md' }),
    fail({ doc: undefined }),
    null,
  ]
  const picked = filterCapabilityDocFails(fails)
  assert.equal(picked.length, 2)
  assert.deepEqual(
    picked.map((f) => f.doc),
    ['docs/capabilities/host.md', 'docs/capabilities/sub/x.md'],
  )
  assert.equal(CAPABILITY_DOC_PREFIX, 'docs/capabilities/')
})

test('行号能从 `路径:916` 里取出来，取不到就是 null（交给门禁其它判据）', () => {
  assert.equal(lineOf('src/a.ts:916'), 916)
  assert.equal(lineOf('collector.ts:1'), 1)
  assert.equal(lineOf('src/a.ts'), null)
  assert.equal(lineOf(undefined), null)
})

test('同一段代码被挤走 10 行 → 按原文唯一定位，自动重锚', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `// filler ${i + 1}`)
  lines[9] = '// 原来在第 10 行的那句已经搬走了'
  lines[19] = 'const x = 1' // 现在在第 20 行
  const edits = planInlineRefFixes([fail()], reader(lines))
  assert.equal(edits.length, 1)
  assert.deepEqual(edits[0], {
    doc: 'docs/capabilities/host.md',
    docLine: 224,
    from: 'src/a.ts:10',
    to: 'src/a.ts:20',
    targetLine: 20,
  })
})

test('找不到原文 / 原文在窗口内不唯一 → 不猜，交给人工', () => {
  const missing = Array.from({ length: 30 }, (_, i) => `// filler ${i + 1}`)
  assert.equal(planInlineRefFixes([fail()], reader(missing)).length, 0, '原文没了不该动行号')

  const twice = Array.from({ length: 30 }, (_, i) => `// filler ${i + 1}`)
  twice[9] = 'const x = 1'
  twice[12] = 'const x = 1'
  assert.equal(planInlineRefFixes([fail()], reader(twice)).length, 0, '同一行文本出现两次，改哪个都是猜')
})

test('原文搬到了窗口外（代码搬家 / 符号重名）→ 不自动改', () => {
  const far = Array.from({ length: PLAUSIBLE_DRIFT_LINES * 3 }, (_, i) => `// filler ${i + 1}`)
  far[PLAUSIBLE_DRIFT_LINES * 2] = 'const x = 1' // 远在窗口之外
  assert.equal(planInlineRefFixes([fail()], reader(far)).length, 0)
})

test('空断言 / 指到空行的漂移（没有原文可对）→ 不自动改', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `// filler ${i + 1}`)
  lines[19] = 'const x = 1'
  assert.equal(planInlineRefFixes([fail({ expect: '' })], reader(lines)).length, 0)
  assert.equal(planInlineRefFixes([fail({ kind: 'drift' })], reader(lines)).length, 0)
  assert.equal(planInlineRefFixes([fail({ raw: 'src/a.ts' })], reader(lines)).length, 0, '没有行号的引用不归这一关')
})

test('同一行里的两处引用各自重锚，互不串台', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `// filler ${i + 1}`)
  lines[19] = 'const x = 1'
  lines[29] = 'const y = 2'
  const fails = [
    fail({ raw: 'src/a.ts:10', expect: 'const x = 1', target: 'src/a.ts' }),
    fail({ raw: 'src/a.ts:20', expect: 'const y = 2', target: 'src/a.ts' }),
  ]
  const edits = planInlineRefFixes(fails, reader(lines))
  assert.deepEqual(
    edits.map((e) => e.to),
    ['src/a.ts:20', 'src/a.ts:30'],
  )

  const docLine = '见 `src/a.ts:10 ⇒ const x = 1` 与 `src/a.ts:20 ⇒ const y = 2`，另见 `src/a.ts:99`'
  // 同一行必须**一次算完**：先改的会造出后改的 `from`（把 10 改成 20 之后，
  // 第二处编辑的 `src/a.ts:20` 就同时命中两处，顺手把另一条引用改错）——`applied` 也得是 2 而不是 3
  const result = applyInlineRefEdits(docLine, edits)
  assert.equal(result.applied, 2)
  assert.equal(
    result.text,
    '见 `src/a.ts:20 ⇒ const x = 1` 与 `src/a.ts:30 ⇒ const y = 2`，另见 `src/a.ts:99`',
  )
})

test('单处包装只改那一条引用（同一行还有别的 `路径:行` 时不动它）', () => {
  const line = '见 `src/a.ts:10 ⇒ const x = 1`，另见 `src/a.ts:10` 的邻居 `src/b.ts:10`'
  assert.equal(
    applyInlineRefEdit(line, { from: 'src/b.ts:10', to: 'src/b.ts:20' }),
    '见 `src/a.ts:10 ⇒ const x = 1`，另见 `src/a.ts:10` 的邻居 `src/b.ts:20`',
  )
})

test('文档已被别人改过（原文不在这一行了）→ 返回 null，调用方跳过', () => {
  assert.equal(applyInlineRefEdit('见 `src/a.ts:12`', { from: 'src/a.ts:10', to: 'src/a.ts:20' }), null)
  assert.equal(applyInlineRefEdit(undefined, { from: 'src/a.ts:10', to: 'src/a.ts:20' }), null)
})
