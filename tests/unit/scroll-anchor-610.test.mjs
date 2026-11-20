// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #610（症状二）：长会话上滑后，内容/行高变化不许把阅读位置弹走。
//
// 这里只测纯计算（`src/utils/scrollAnchor.ts`）：拿「上一次提交时第一条可见行」当锚点，
// 看它在最新布局里移动了多少，再把同样的量补进 scrollTop。真实浏览器里的接线
// （layout effect / overflow-anchor / 编辑态聚焦）由 L1 用例
// `tests/integration/chat-newline-enter-610.test.mjs` 覆盖。
//
// 断言方向：
//   A 首条可见行 = 第一条「底部越过视口顶」的行（露出一像素也算）
//   B 列表为空 / 全部滚到视口上方：不取锚点（返回 null）
//   C 内容在锚点上方长高 → 需要向下补（正数）；缩短 → 向上补（负数）
//   D 锚点行自己不动 → 补 0（不许因为别人的变化乱动）
//   E 锚点行已经不在列表里（编辑截断 / 滚出挂载窗口）→ 补 0，宁可不挪
//   F 脏数据（NaN / Infinity / 缺行）→ 补 0，不抛错
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { anchorShift, pickAnchor } = await import('../../src/utils/scrollAnchor.ts')

const row = (id, top, height) => ({ id, top, height })

test('[A] 首条可见行 = 第一条底部越过视口顶的行', () => {
  const rows = [row('a', 0, 100), row('b', 100, 100), row('c', 200, 100)]
  assert.deepEqual(pickAnchor(rows, 0), { id: 'a', top: 0 })
  assert.deepEqual(pickAnchor(rows, 150), { id: 'b', top: 100 })
  // 只剩 1px 露在视口里也算「正在看这一行」
  assert.deepEqual(pickAnchor(rows, 199), { id: 'b', top: 100 })
  // 视口正好落在下一行顶上
  assert.deepEqual(pickAnchor(rows, 200), { id: 'c', top: 200 })
})

test('[B] 空列表 / 全部滚过头 → 不取锚点', () => {
  assert.equal(pickAnchor([], 0), null)
  assert.equal(pickAnchor([row('a', 0, 100)], 100), null)
  assert.equal(pickAnchor([row('a', 0, 100)], 5000), null)
  // scrollTop 是负数（iOS 橡皮筋）时按 0 算
  assert.deepEqual(pickAnchor([row('a', 0, 100)], -40), { id: 'a', top: 0 })
})

test('[C] 锚点上方内容长高 / 缩短 → 给出对应的补偿量', () => {
  const before = [row('a', 0, 100), row('b', 100, 100)]
  const anchor = pickAnchor(before, 100)
  assert.deepEqual(anchor, { id: 'b', top: 100 })
  // a 变成 160（上方长高 60）：b 被顶下去 60 → scrollTop 要 +60
  assert.equal(anchorShift(anchor, [row('a', 0, 160), row('b', 160, 100)]), 60)
  // a 变成 40（上方缩短 60）：b 上移 60 → scrollTop 要 -60
  assert.equal(anchorShift(anchor, [row('a', 0, 40), row('b', 40, 100)]), -60)
})

test('[D] 锚点行自己没动 → 不补偿（别人的变化不许引起跳动）', () => {
  const before = [row('a', 0, 100), row('b', 100, 100), row('c', 200, 300)]
  const anchor = pickAnchor(before, 100)
  // 只有下面的 c 长高：b 的位置没变
  assert.equal(anchorShift(anchor, [row('a', 0, 100), row('b', 100, 100), row('c', 200, 900)]), 0)
})

test('[E] 锚点行不在了（编辑截断 / 滚出挂载窗口）→ 不补偿', () => {
  const anchor = { id: 'gone', top: 100 }
  assert.equal(anchorShift(anchor, [row('a', 0, 100), row('b', 100, 100)]), 0)
  assert.equal(anchorShift(null, [row('a', 0, 100)]), 0)
})

test('[F] 脏数据不抛错也不乱挪', () => {
  assert.equal(anchorShift({ id: 'a', top: 0 }, [row('a', Number.NaN, 100)]), 0)
  assert.equal(anchorShift({ id: 'a', top: 0 }, [row('a', Number.POSITIVE_INFINITY, 100)]), 0)
  assert.equal(pickAnchor([row('a', Number.NaN, 100), row('b', 100, 100)], 0)?.id, 'b')
  assert.equal(pickAnchor([row('a', 0, Number.NaN)], 0), null)
  assert.equal(pickAnchor([row('a', 0, 100)], Number.NaN)?.id, 'a')
})
