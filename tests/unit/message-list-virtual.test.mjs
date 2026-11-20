// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #45（虚拟列表）：长会话「消息节点数随历史总条数线性增长」的回归。
// 只 import 真实源码 src/components/messages/virtualRows.ts + react-dom/server，
// 用 renderToStaticMarkup 真渲染一次组件树，数 data-row-id 节点个数——不是读源码正则。
//
//   node tests/unit/message-list-virtual.test.mjs
//
// 覆盖：
//   [1] N=500：挂载节点数是个小常数，不是 500
//   [2] N=5000：挂载节点数与 N=500 同量级（不随总数线性增长）
//   [3] 滚到中段：窗口跟着 viewport 走，命中视口附近的消息
//   [4] 贴底（sticky）：最后一条必须挂载，否则自动滚到底 / 流式跟随看不到新内容
//   [5] 高度未知（未实测）：按估值占位，滚动高度不塌，挂载数仍有限
//   [6] 高度实测后覆盖估值：后续偏移跟着实测值走，不按固定高度错位
//   [7] 流式增长：最后一条变大后总高度跟着变大，且前后不重叠
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { DEFAULT_ESTIMATE, OVERSCAN_PX, VirtualRows, buildLayout, findWindow } = await import(
  '../../src/components/messages/virtualRows.ts'
)

const makeMessages = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
  }))

const render = ({ count = 500, measured = [], scrollTop = 0, viewport = 800, anchorEnd = false } = {}) => {
  const items = makeMessages(count)
  // 实测高度表与 items 对齐，没实测的位置留 undefined
  const aligned = items.map((_, index) => measured[index])
  const html = renderToStaticMarkup(
    createElement(VirtualRows, {
      items,
      measured: aligned,
      scrollTop,
      viewport,
      anchorEnd,
      getId: (message) => message.id,
      renderItem: (message, index) =>
        createElement('div', { 'data-message-id': message.id }, `#${index}`),
    })
  )
  const ids = [...html.matchAll(/data-row-id="([^"]+)"/g)].map((match) => match[1])
  return { html, ids, mounted: ids.length }
}

test('N=500：只挂载视口附近的节点，不是 500 条全渲染', () => {
  const { mounted, ids } = render({ count: 500 })
  assert.ok(mounted > 0, '至少要有内容，不能空列表')
  assert.ok(
    mounted < 40,
    `500 条消息最多挂载 40 个节点，实际 ${mounted}（改动前是 500 条全渲染）`
  )
  assert.equal(new Set(ids).size, ids.length, '挂载的节点不能有重复 id')
})

test('N=5000：挂载节点数与 N=500 同量级，不随总条数线性增长', () => {
  const small = render({ count: 500 })
  const large = render({ count: 5000 })
  assert.ok(large.mounted < 40, `5000 条消息挂载 ${large.mounted} 个节点，必须仍是小常数`)
  assert.ok(
    Math.abs(large.mounted - small.mounted) <= 4,
    `500 → 5000 条，挂载数不应变化：500 条 ${small.mounted} vs 5000 条 ${large.mounted}`
  )
})

test('滚到中段：窗口跟着视口走，命中中间的消息', () => {
  const heights = Array.from({ length: 500 }, () => 100)
  const { ids, mounted } = render({ count: 500, measured: heights, scrollTop: 25000 })
  assert.ok(mounted < 40, `中段也最多挂载 40 个节点，实际 ${mounted}`)
  assert.ok(ids.includes('m250'), 'scrollTop=25000 / 每条 100px 时第 250 条必须在视口里')
  assert.ok(!ids.includes('m0'), '首批消息已经滚出窗口，不该再挂载')
  assert.ok(!ids.includes('m499'), '末尾消息还没到，不该提前挂载')
})

test('贴底（sticky）：最后一条必须挂载，自动滚到底与流式跟随才有内容', () => {
  const heights = Array.from({ length: 500 }, () => 100)
  const { ids, mounted } = render({ count: 500, measured: heights, anchorEnd: true })
  assert.ok(ids.includes('m499'), '贴底时最后一条必须在挂载窗口里')
  assert.ok(mounted < 40, `贴底也最多挂载 40 个节点，实际 ${mounted}`)
  const { topPad } = findWindow({
    layout: buildLayout(heights),
    scrollTop: 0,
    viewport: 800,
    anchorEnd: true,
  })
  assert.ok(topPad > 0, '贴底时上方必须有占位，否则滚动高度塌掉、滚不回去')
})

test('高度未知：按估值占位，滚动高度不塌且挂载数仍有限', () => {
  const { mounted } = render({ count: 500, measured: [] })
  assert.ok(mounted > 0 && mounted < 40, `未实测时也最多挂载 40 个节点，实际 ${mounted}`)
  const layout = buildLayout(Array.from({ length: 500 }, () => undefined))
  assert.equal(layout.total, 500 * DEFAULT_ESTIMATE, '未实测的行按默认估值占位')
  assert.ok(OVERSCAN_PX > 0, '视口外要留出生区，滚动时不白屏')
})

test('高度实测后覆盖估值：后续偏移跟着实测值走，不按固定高度错位', () => {
  const layout = buildLayout([50, 50, 900, undefined])
  assert.equal(layout.heights[2], 900, '第 3 条用实测高度 900，不退回估值')
  assert.equal(layout.offsets[3], 1000, '第 4 条的 top 是前三条实测高度之和（50+50+900）')
  assert.equal(layout.total, 1000 + DEFAULT_ESTIMATE, '总高度 = 实测和 + 未实测估值')
  for (let index = 1; index < layout.heights.length; index += 1) {
    assert.equal(
      layout.offsets[index],
      layout.offsets[index - 1] + layout.heights[index - 1],
      '偏移必须首尾相接，不能重叠也不能留缝'
    )
  }
})

test('流式增长：最后一条变大后总高度跟着变大，前后不重叠', () => {
  const before = Array.from({ length: 500 }, () => 100)
  const after = [...before.slice(0, 499), 1200]
  const layoutBefore = buildLayout(before)
  const layoutAfter = buildLayout(after)
  assert.ok(
    layoutAfter.total > layoutBefore.total,
    `流式回复撑开后总高度必须变大：${layoutBefore.total} → ${layoutAfter.total}`
  )
  assert.equal(layoutAfter.offsets[499], layoutBefore.offsets[499], '最后一条之前的偏移不受它自身高度影响')
  const { bottomPad, end } = findWindow({
    layout: layoutAfter,
    scrollTop: layoutAfter.total - 800,
    viewport: 800,
  })
  assert.equal(end, 500, '贴底时窗口要到最后一条')
  assert.equal(bottomPad, 0, '撑开后的最后一条下方不能留占位，否则贴底会有一段空白')
})
