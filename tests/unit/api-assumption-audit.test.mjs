// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `scripts/lib/apiAssumptionAudit.mjs` 的判定规则自测（GitHub issue #209，类别 1：
// JS 内置 API / 语言特性假设）。
//
// 这个模块的价值全在「三个判定桶不能串味」上，所以三个桶各钉一个真例子 + 一组反例：
//   baseline        首次支持 <= WebView 83 的内核版本 → 不需要兜底；
//   entry-polyfill  > 83 但 src/polyfills/legacy.ts 会补 → 依赖入口 import 顺序；
//   uncovered       > 83 且没人补 → 真漏洞，必须拆单。
//
// 另外单独钉「注释与字符串里的 API 名不算命中」—— 仓库里全是解释性注释（legacy.ts 通篇
// 都在写 `Object.hasOwn` / `structuredClone`），状态机一松就会把盘点结果灌成假红。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  API_RULES,
  BASELINE_CHROME,
  ENTRY_POLYFILL_KEYS,
  auditApiAssumptions,
  maskLiteralsAndComments,
  summarize,
} from '../../scripts/lib/apiAssumptionAudit.mjs'

const audit = (path, text) => auditApiAssumptions([{ path, text }]).hits

test('基线是 WebView 83（Chromium 83），不是 83 之后任何版本', () => {
  assert.equal(BASELINE_CHROME, 83)
  // 入口 polyfill 的 13 条键必须一条不少，否则 covered 会被算弱
  assert.equal(ENTRY_POLYFILL_KEYS.length, 13)
  for (const key of ['Object.hasOwn', 'structuredClone', 'crypto.randomUUID', 'Intl.Segmenter']) {
    assert.ok(ENTRY_POLYFILL_KEYS.includes(key), `入口 polyfill 必须覆盖 ${key}`)
  }
})

test('verdict = baseline：内核 83 就自带的能力不算风险', () => {
  // Intl.DisplayNames 是 Chromium 81（issue #155），比 83 早，WebView 83 原生就有
  const hits = audit('src/services/location.ts', 'const names = new Intl.DisplayNames([locale], { type: "region" })')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].api, 'Intl.DisplayNames')
  assert.equal(hits[0].firstSupported, 81)
  assert.equal(hits[0].covered, false, '81 不需要兜底，covered 必须是 false')
  assert.equal(hits[0].verdict, 'baseline')

  // trimEnd 是 Chromium 66，同上
  assert.equal(audit('src/services/chat/view.ts', 'const body = text.trimEnd()')[0].verdict, 'baseline')
})

test('verdict = entry-polyfill：> 83 但入口 polyfill 会补，算中风险', () => {
  const hits = audit('src/services/chat/store.ts', 'if (Object.hasOwn(record, key)) { return record.at(-1) }')
  assert.equal(hits.length, 2)
  const byApi = new Map(hits.map((hit) => [hit.api, hit]))
  assert.equal(byApi.get('Object.hasOwn').firstSupported, 93)
  assert.equal(byApi.get('Object.hasOwn').covered, true)
  assert.equal(byApi.get('Object.hasOwn').verdict, 'entry-polyfill')
  assert.equal(byApi.get('Array.prototype.at / String.prototype.at').firstSupported, 92)
  assert.equal(byApi.get('Array.prototype.at / String.prototype.at').verdict, 'entry-polyfill')
})

test('verdict = uncovered：> 83 且没人补，这才是真漏洞', () => {
  const hits = audit('src/app/App.tsx', 'const groups = Object.groupBy(items, (item) => item.kind)')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].api, 'Object.groupBy')
  assert.equal(hits[0].firstSupported, 117)
  assert.equal(hits[0].covered, false)
  assert.equal(hits[0].verdict, 'uncovered')

  // 语法类也一样：私有方法（84）比私有字段（74）晚，且不可 polyfill
  const syntax = audit('src/app/App.tsx', 'class A {\n  #secret() { return 1 }\n}')
  assert.equal(syntax.length, 1)
  assert.equal(syntax[0].api, '类私有方法 / 私有访问器')
  assert.equal(syntax[0].verdict, 'uncovered')

  // 而私有字段是 74 <= 83，同样的文件里必须落回 baseline
  const field = audit('src/app/App.tsx', 'class B {\n  #count = 0\n}')
  assert.equal(field.length, 1)
  assert.equal(field[0].verdict, 'baseline')
})

test('注释与字符串里的 API 名不算命中（否则盘点结果会被解释性注释灌满假红）', () => {
  const text = [
    '// 这里故意提 Object.hasOwn( 和 structuredClone( 与 Object.groupBy(，但都是注释',
    "const label = 'Object.groupBy(items)' // 字符串里的也不算",
    'const hint = `调用 Object.groupBy(x) 会炸`',
    'const real = Object.hasOwn(value, "k")',
  ].join('\n')
  const hits = audit('src/app/App.tsx', text)
  assert.equal(hits.length, 1, `只应剩下第 4 行的真调用，实际：${JSON.stringify(hits)}`)
  assert.equal(hits[0].api, 'Object.hasOwn')
  assert.equal(hits[0].line, 4, '行号必须按原文算，不能因为遮蔽而错位')
})

test('遮蔽器保持等长：换行与列位置不动，行号才可信', () => {
  const text = 'const a = "x" // c\nconst b = `y${1 + 2}z`\nconst c = Object.groupBy(q, f)\n'
  const masked = maskLiteralsAndComments(text)
  assert.equal(masked.length, text.length, '遮蔽必须等长')
  assert.equal(masked.split('\n').length, text.split('\n').length, '行数必须一致')
  assert.ok(masked.includes('Object.groupBy(q, f)'), '模板字符串结束后的代码不能被吃掉')
  assert.ok(!masked.includes('"x"') && !masked.includes('`y'), '字面量本身要遮掉')
})

test('模板字符串 ${} 里的表达式仍按代码审计（不遮）', () => {
  const hits = audit('src/app/App.tsx', 'const s = `v=${Object.hasOwn(o, k)}`')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].api, 'Object.hasOwn')
})

test('polyfill 实现文件里的同类写法算已兜底，不当成「假设」', () => {
  const hits = audit('src/polyfills/legacy.ts', "define(Array.prototype, 'at', function at() {})")
  // 定义处不是假设处；即便命中（Intl.Segmenter 这类被显式提及的规则），也必须落 entry-polyfill
  for (const hit of hits) {
    assert.equal(hit.verdict, 'entry-polyfill', `${hit.api} 在 polyfill 文件里不该判成未兜底`)
  }
})

test('summarize 只做汇总，不重新判定：合计必须等于三个桶之和', () => {
  const files = [
    { path: 'src/app/App.tsx', text: 'Object.hasOwn(a, b)\nObject.groupBy(c, d)' },
    { path: 'src/services/chat/view.ts', text: 'text.trimEnd()' },
  ]
  const result = auditApiAssumptions(files)
  const summary = summarize(result)
  assert.equal(summary.filesScanned, 2)
  assert.equal(summary.total, result.hits.length)
  const { baseline, 'entry-polyfill': polyfilled, uncovered } = summary.byVerdict
  assert.equal(baseline + polyfilled + uncovered, summary.total, '三个桶必须覆盖全部命中')
  assert.equal(baseline, 1)
  assert.equal(polyfilled, 1)
  assert.equal(uncovered, 1)
  assert.equal(summary.byApi[0].count >= 1, true)
  // 文档表格靠它出数：每个 API 桶必须带首次支持版本与命中文件清单
  for (const bucket of summary.byApi) {
    assert.equal(typeof bucket.firstSupported, 'number')
    assert.ok(Array.isArray(bucket.files) && bucket.files.length >= 1)
  }
})

test('版本表自身不许出现「猜的数字」：每条规则都得有出处且在基线两侧都有样例', () => {
  for (const rule of API_RULES) {
    assert.equal(typeof rule.firstSupported, 'number', `${rule.id} 缺首次支持版本`)
    assert.ok(rule.firstSupported > 0)
    assert.ok(['check-bundle-syntax', 'matrix-scan', 'mdn'].includes(rule.source), `${rule.id} 来源不明`)
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} 缺匹配规则`)
    assert.ok(rule.pattern.flags.includes('g'), `${rule.id} 的正则必须带 g，否则只会命中第一处`)
  }
  const ids = API_RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不许重复')
})
