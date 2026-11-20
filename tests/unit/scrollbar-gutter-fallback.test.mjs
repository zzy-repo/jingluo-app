// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #216 的防回归：`scrollbar-gutter` 首支持 Chromium 94，运行时下限是 WebView 83（Chromium 83）。
// 低内核上这条声明被整条丢弃 → 槽位退回动态 → 滚动条出现/消失时内容横向跳动。
// 这里把判定口径钉进测试：
//  1. `scrollbar-gutter: stable…` 必须有「槽位恒宽」的等价回退（`overflow-y: scroll`），
//     并且要有 `@supports (scrollbar-gutter: …)` 把常驻滚动条在现代内核上收回 `auto`；
//  2. `padding-right` / `padding-inline-end` 不算回退 —— classic 滚动条仍然从内容框里吃宽度；
//  3. `scrollbar-gutter: auto` 是初始值，但它所在规则必须显式写死 overflow 轴，
//     免得别的规则的常驻滚动条漏进这个布局分支；
//  4. `src/**` 里现有的每一处都真的按上面写好了（这条会在改动归零时变红）；
//  5. #236：媒体查询里换手（`.container` → `.scroll`）的滚动容器自己不带 `scrollbar-gutter`，
//     必须单独盯 —— 它没有「指针作用域内的 `overflow-y: scroll` 常驻槽位 + 同作用域 `@supports` 收回」
//     这一对，classic 滚动条环境下滚动条出现的那一刻整列消息会重新折行。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  auditNarrowScrollContainers,
  auditCssText,
  auditScrollbarGutter,
  parseCssBlocks,
} from '../../scripts/lib/scrollbarGutterAudit.mjs'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

const whyOf = (css) => auditCssText(css).missing.map((item) => item.why).join(' | ')

test('#216 裸写 scrollbar-gutter: stable 而没有兜底会红', () => {
  const result = auditCssText('.list {\n  overflow-y: auto;\n  scrollbar-gutter: stable both-edges;\n}')
  assert.equal(result.occurrences.length, 1)
  assert.equal(result.missing.length, 1)
  assert.equal(result.occurrences[0].shape, 'missing')
  assert.match(result.missing[0].why, /没有等价回退/u)
})

test('#216 padding 预留槽位不算回退', () => {
  const css = [
    '.list {',
    '  overflow-y: auto;',
    '  padding-inline-end: 15px;',
    '  padding-right: 15px;',
    '  scrollbar-gutter: stable;',
    '}',
    '@supports (scrollbar-gutter: stable) {',
    '  .list { overflow-y: auto; }',
    '}',
  ].join('\n')
  assert.equal(whyOf(css).includes('没有等价回退'), true)
})

test('#216 overflow-y: scroll 兜底 + @supports 收回 auto 才算合格', () => {
  const css = [
    '.list {',
    '  overflow-y: scroll;',
    '  scrollbar-gutter: stable both-edges;',
    '}',
    '@supports (scrollbar-gutter: stable both-edges) {',
    '  .list { overflow-y: auto; }',
    '}',
  ].join('\n')
  const result = auditCssText(css)
  assert.deepEqual(result.missing, [])
  assert.equal(result.occurrences[0].shape, 'fallback-plus-supports')
})

test('#216 有 overflow-y: scroll 但没 @supports 收回也会红', () => {
  const css = '.list {\n  overflow-y: scroll;\n  scrollbar-gutter: stable;\n}'
  assert.equal(auditCssText(css).missing.length, 1)
  assert.match(whyOf(css), /收回 `auto`/u)
})

test('#216 @supports 分层写法：块内 gutter + 块外常驻兜底', () => {
  const good = [
    '.list { overflow-y: scroll; }',
    '@supports (scrollbar-gutter: stable both-edges) {',
    '  .list { overflow-y: auto; scrollbar-gutter: stable both-edges; }',
    '}',
  ].join('\n')
  assert.deepEqual(auditCssText(good).missing, [])
  assert.equal(auditCssText(good).occurrences[0].shape, 'supports-layered')

  const bad = [
    '.list { padding-inline-end: 15px; }',
    '@supports (scrollbar-gutter: stable both-edges) {',
    '  .list { scrollbar-gutter: stable both-edges; }',
    '}',
  ].join('\n')
  assert.equal(auditCssText(bad).missing.length, 1)
  assert.match(whyOf(bad), /#173 的错法/u)
})

test('#216 scrollbar-gutter: auto 必须是初始值且同规则写死 overflow 轴', () => {
  const good = '.list { overflow: hidden; scrollbar-gutter: auto; }'
  assert.deepEqual(auditCssText(good).missing, [])
  assert.equal(auditCssText(good).occurrences[0].shape, 'initial-value')

  const bad = '.list { scrollbar-gutter: auto; }'
  assert.equal(auditCssText(bad).missing.length, 1)
  assert.match(whyOf(bad), /漏进这个布局分支/u)
})

test('#216 块解析能带上 at-rule 外层上下文', () => {
  const blocks = parseCssBlocks('@media (min-width: 768px) { .a { color: red; } }')
  const rule = blocks.find((block) => block.prelude === '.a')
  assert.deepEqual(rule.ancestors, ['@media (min-width: 768px)'])
  assert.match(rule.ownText, /color: red/u)
})

// ---------------------------------------------------------------- #236 窄屏换手容器

/** 一个已经处理好槽位的桌面分支，只为了让文件满足「本文件参与槽位决策」这个启用条件 */
const DESKTOP_OK = [
  '.container {',
  '  overflow-y: scroll;',
  '}',
  '@supports (scrollbar-gutter: stable both-edges) {',
  '  .container { overflow-y: auto; scrollbar-gutter: stable both-edges; }',
  '}',
].join('\n')

const NARROW = '@media not all and (min-width: 768px)'
const NARROW_POINTER = `${NARROW} and (hover: hover) and (pointer: fine)`

test('#236 窄屏换手的滚动容器没有指针作用域常驻槽位会红', () => {
  const css = [DESKTOP_OK, `${NARROW} {`, '  .scroll { overflow-y: auto; }', '}'].join('\n')
  const result = auditNarrowScrollContainers(css)
  assert.equal(result.containers.length, 1, '窄屏里的 .scroll 必须被盯上')
  assert.equal(result.uncovered.length, 1)
  assert.equal(result.uncovered[0].selector, '.scroll')
  assert.match(result.uncovered[0].why, /常驻槽位/u)
})

test('#236 有了指针作用域常驻槽位但缺 @supports 收回也会红', () => {
  const css = [
    DESKTOP_OK,
    `${NARROW} {`,
    '  .scroll { overflow-y: auto; }',
    '}',
    `${NARROW_POINTER} {`,
    '  .scroll { overflow-y: scroll; }',
    '}',
  ].join('\n')
  const result = auditNarrowScrollContainers(css)
  assert.equal(result.containers.length, 1)
  assert.equal(result.containers[0].scopedReserve, true)
  assert.equal(result.uncovered.length, 1)
  assert.match(result.uncovered[0].why, /空滚动条/u)
})

test('#236 指针作用域常驻 + 同作用域 @supports 收回才算处置完', () => {
  const css = [
    DESKTOP_OK,
    `${NARROW} {`,
    '  .scroll { overflow-y: auto; }',
    '}',
    `${NARROW_POINTER} {`,
    '  .scroll { overflow-y: scroll; }',
    '}',
    `${NARROW_POINTER} {`,
    '  @supports (scrollbar-gutter: stable) {',
    '    .scroll { overflow-y: auto; scrollbar-gutter: stable; }',
    '  }',
    '}',
  ].join('\n')
  const result = auditNarrowScrollContainers(css)
  assert.equal(result.containers.length, 1)
  assert.equal(result.containers[0].scopedReserve, true)
  assert.equal(result.containers[0].scopedWithdraw, true)
  assert.deepEqual(result.uncovered, [])
})

test('#236 嵌套两层媒体查询的写法也认（`not` 不能和指针特性挤在一条查询里）', () => {
  const css = [
    DESKTOP_OK,
    `${NARROW} {`,
    '  .scroll { overflow-y: auto; }',
    '}',
    `${NARROW} {`,
    '  @media (hover: hover) and (pointer: fine) {',
    '    .scroll { overflow-y: scroll; }',
    '  }',
    '}',
    `${NARROW} {`,
    '  @media (hover: hover) and (pointer: fine) {',
    '    @supports (scrollbar-gutter: stable) {',
    '      .scroll { overflow-y: auto; scrollbar-gutter: stable; }',
    '    }',
    '  }',
    '}',
  ].join('\n')
  const result = auditNarrowScrollContainers(css)
  assert.equal(result.containers[0].scopedReserve, true)
  assert.equal(result.containers[0].scopedWithdraw, true)
  assert.deepEqual(result.uncovered, [])
})

test('#236 只在别的宽度档位上做处置不算过（作用域必须是同一个窄屏档）', () => {
  const css = [
    DESKTOP_OK,
    '@media (max-width: 480px) {',
    '  .scroll { overflow-y: auto; }',
    '}',
    '@media (max-width: 480px) and (hover: hover) and (pointer: fine) {',
    '  .scroll { overflow-y: scroll; }',
    '}',
    '@media (max-width: 480px) and (hover: hover) and (pointer: fine) {',
    '  @supports (scrollbar-gutter: stable) {',
    '    .scroll { overflow-y: auto; scrollbar-gutter: stable; }',
    '  }',
    '}',
  ].join('\n')
  // 480px 这一档自己处置完整 → 不该被报
  assert.deepEqual(auditNarrowScrollContainers(css).uncovered, [])

  const mismatch = [
    DESKTOP_OK,
    '@media not all and (min-width: 768px) {',
    '  .scroll { overflow-y: auto; }',
    '}',
    '@media (max-width: 480px) and (hover: hover) and (pointer: fine) {',
    '  .scroll { overflow-y: scroll; }',
    '}',
  ].join('\n')
  const result = auditNarrowScrollContainers(mismatch)
  assert.equal(result.uncovered.length, 1, '别档位上的兜底不能顶替这一档')
})

test('#236 文件里没有 scrollbar-gutter 时不启用这条规则', () => {
  const css = ['@media not all and (min-width: 768px) {', '  .panel { overflow-y: auto; }', '}'].join('\n')
  const result = auditNarrowScrollContainers(css)
  assert.deepEqual(result.containers, [])
  assert.deepEqual(result.uncovered, [])
})

test('#216 src 里每处 scrollbar-gutter 都有等价回退', async () => {
  const audit = await auditScrollbarGutter(SRC)
  assert.ok(audit.occurrences.length >= 2, `至少应有 2 处 scrollbar-gutter，实际 ${audit.occurrences.length}`)
  assert.deepEqual(
    audit.missing.map((item) => `${item.file}:${item.line} ${item.value} ${item.why}`),
    [],
  )
})

test('#236 src 里每个窄屏换手滚动容器都为 classic 滚动条做过处置', async () => {
  const audit = await auditScrollbarGutter(SRC)
  // 这条不许悄悄退化成空集合：窄屏确实存在一个换手容器（`.container` → `.scroll`），
  // 它自己不带 scrollbar-gutter，只有维度 D 盯得住
  assert.ok(audit.containers.length >= 1, `至少应有 1 个窄屏换手容器，实际 ${audit.containers.length}`)
  assert.deepEqual(
    audit.uncoveredContainers.map((item) => `${item.file}:${item.line} ${item.selector} ${item.why}`),
    [],
  )
})
