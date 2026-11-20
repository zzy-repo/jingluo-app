// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #30 回归：反馈弹窗在真机 WebView 上「触摸全到、内容一像素不动」的静默锁死。
//
// 机制（见 docs/repro/g5-issue-30-31-28.md 的 no-bounded-height 工况）：
//   src/app/viewport.ts 里的全局 touchmove 拦截按「祖先里有没有 overflow auto|scroll
//   且 scrollHeight > clientHeight」判断能不能滚。高度链一退化（--modal-viewport-height 缺失 /
//   父弹窗没有有界盒子），滚动容器的 scrollHeight 就等于 clientHeight（820 / 820），
//   扫描认为「这一片没人能滚」，于是把**每一次** touchmove 的默认行为取消 ——
//   176 条触摸全到、scrollTop 恒 0、零报错。
//
// 本用例在无 DOM 的 unit 层复刻这条链：假 Element / 假 getComputedStyle / 假 document，
// 用 react 的 dispatcher 钩子真正跑 usePreventPageScroll() 注册出来的监听器（不是复制它的逻辑），
// 然后派发构造好的 touchmove 事件，数 preventDefault 调了几次。
//
// 断言方向（fail-open 是默认）：
//   A 高度链退化 + 目标是可滚容器内部 → preventDefault 必须 0 次（红：现状 176 次）
//   B 锁生效场景（目标不在任何可滚容器里）→ 仍然要 preventDefault（防「把锁废掉」）
//   C Modal 侧：scale !== 1 时也必须写出 --modal-viewport-height（读 style 断言非空）
//   D 可滚容器滚到顶 / 到底的边界不误锁
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 最小假元素：只提供 viewport.ts 读的那几个字段 */
class FakeElement {
  constructor({
    overflowY = 'visible',
    overflowX = 'visible',
    scrollHeight = 0,
    clientHeight = 0,
    scrollWidth = 0,
    clientWidth = 0,
    scrollTop = 0,
    className = '',
  } = {}) {
    this.style = { overflowY, overflowX }
    this.scrollHeight = scrollHeight
    this.clientHeight = clientHeight
    this.scrollWidth = scrollWidth
    this.clientWidth = clientWidth
    this.scrollTop = scrollTop
    this.className = className
    this.parentElement = null
  }

  /** 沿 parentElement 链判断包含关系（锁范围用的是 contains） */
  contains(other) {
    for (let node = other; node; node = node.parentElement) {
      if (node === this) return true
    }
    return false
  }
}

/** 把 child 挂到 parent 下面（只需要向上找祖先的 parentElement 链） */
const attach = (parent, child) => {
  child.parentElement = parent
  return child
}

globalThis.Element = FakeElement
globalThis.getComputedStyle = (element) => element.style

const touchListeners = new Map()
const body = new FakeElement({ overflowY: 'hidden' })
globalThis.document = {
  body,
  addEventListener: (type, handler) => touchListeners.set(type, handler),
  removeEventListener: (type) => touchListeners.delete(type),
}
// viewport.ts 模块顶层会调 window.matchMedia
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  innerHeight: 640,
}

// react 的官方 dispatcher 钩子：不 mock 模块，就能让 useEffect/useLayoutEffect 在纯 Node 里跑起来。
const reactInternals = (await import('react')).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const effects = []
const runEffects = () => {
  const pending = effects.splice(0, effects.length)
  for (const run of pending) run()
}
reactInternals.ReactCurrentDispatcher.current = {
  useEffect: (run) => effects.push(run),
  useLayoutEffect: (run) => effects.push(run),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'unit-id',
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useDebugValue: () => {},
}

const viewportModule = await import('../../src/app/viewport.ts')
const viewportSource = readFileSync(new URL('../../src/app/viewport.ts', import.meta.url), 'utf8')

// 真的跑一遍 hook，拿它注册到 document 上的 touchmove 监听器
viewportModule.usePreventPageScroll(true)
runEffects()
const onTouchMove = touchListeners.get('touchmove')

/** 派发 n 个单指 touchmove（每次默认都会走 preventDefault 分支），返回被取消的次数 */
const dispatchTouchMoves = (target, times) => {
  let prevented = 0
  for (let i = 0; i < times; i++) {
    onTouchMove({
      type: 'touchmove',
      target,
      touches: [{}],
      preventDefault() {
        prevented += 1
      },
    })
  }
  return prevented
}

test('A 高度链退化：可滚容器内部的触摸不能被静默锁死', () => {
  assert.equal(typeof onTouchMove, 'function', 'usePreventPageScroll 必须真的注册 touchmove 监听器')

  // 复刻 no-bounded-height 工况：弹窗撑破视口、内容区 scrollHeight === clientHeight（820/820），
  // overflowY 仍是 auto（CSS 声明没变，只是没有有界盒子 → 现测「溢出量」为 0）。
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const dialog = attach(overlay, new FakeElement({ scrollHeight: 964, clientHeight: 964, className: 'feedbackDialog' }))
  const scrollArea = attach(
    dialog,
    new FakeElement({ overflowY: 'auto', scrollHeight: 820, clientHeight: 820, className: 'feedbackMain' })
  )
  const hint = attach(scrollArea, new FakeElement({ className: 'feedbackHint' }))

  const prevented = dispatchTouchMoves(hint, 176)
  assert.equal(
    prevented,
    0,
    `高度链退化时可滚容器内部不该被锁：期望 preventDefault 0 次，实际 ${prevented} 次（176 次 touchmove 全被取消 → 内容一像素不动）`
  )
})

test('B 锁生效场景：目标不在任何可滚容器里，仍然 preventDefault', () => {
  // 遮罩里的静态文字：链上没有 auto|scroll（body 是 overflow:hidden），页面不该跟着滚
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const label = attach(overlay, new FakeElement({ className: 'plainLabel' }))

  const prevented = dispatchTouchMoves(label, 3)
  assert.equal(prevented, 3, `非滚动区域的整页滚动仍要拦住：期望 3 次 preventDefault，实际 ${prevented} 次`)
})

test('B2 多指手势放行（双指缩放交给浏览器）', () => {
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const label = attach(overlay, new FakeElement({ className: 'plainLabel' }))
  let prevented = 0
  onTouchMove({
    type: 'touchmove',
    target: label,
    touches: [{}, {}],
    preventDefault() {
      prevented += 1
    },
  })
  assert.equal(prevented, 0, '多指 touchmove 不应 preventDefault')
})

test('C Modal 侧：scale !== 1 时也要写出 --modal-viewport-height', () => {
  assert.equal(
    typeof viewportModule.syncModalViewport,
    'function',
    'viewport.ts 必须导出 syncModalViewport（Modal 用它写 --modal-viewport-height，缺了它高度链塌陷）'
  )

  const makeOverlay = () => {
    const properties = new Map()
    return {
      style: {
        setProperty: (name, value) => properties.set(name, value),
        getPropertyValue: (name) => properties.get(name) ?? '',
        removeProperty: (name) => properties.delete(name),
      },
    }
  }

  // 双指放大：visualViewport.scale = 1.5，真实可视高度 420
  const zoomed = makeOverlay()
  viewportModule.syncModalViewport(zoomed, { scale: 1.5, height: 420, offsetTop: 12 })
  const zoomedHeight = zoomed.style.getPropertyValue('--modal-viewport-height')
  assert.equal(zoomedHeight, '420px', `scale≠1 时变量必须按真实可视高度写出，实际 "${zoomedHeight}"`)

  // 未缩放：同样要写
  const normal = makeOverlay()
  viewportModule.syncModalViewport(normal, { scale: 1, height: 640, offsetTop: 0 })
  assert.equal(normal.style.getPropertyValue('--modal-viewport-height'), '640px')

  // viewport 拿不到（老内核没有 visualViewport）时退回 window.innerHeight，仍然非空
  const legacy = makeOverlay()
  viewportModule.syncModalViewport(legacy, null)
  assert.equal(legacy.style.getPropertyValue('--modal-viewport-height'), '640px')
})

test('C2 Modal.tsx 真的用了 syncModalViewport（静态接线检查）', () => {
  const modalSource = readFileSync(new URL('../../src/components/base/Modal.tsx', import.meta.url), 'utf8')
  assert.match(modalSource, /syncModalViewport\s*\(/, 'Modal.tsx 必须通过 syncModalViewport 写视口高度变量')
  assert.doesNotMatch(
    modalSource,
    /viewport\.scale !== 1\)\s*\{\s*return/,
    'Modal.tsx 不能再用 scale !== 1 的早退跳过变量写入'
  )
})

test('D 可滚容器滚到顶/到底的边界不误锁', () => {
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const dialog = attach(overlay, new FakeElement({ scrollHeight: 608, clientHeight: 608 }))
  const scrollArea = attach(
    dialog,
    new FakeElement({ overflowY: 'auto', scrollHeight: 820, clientHeight: 464, scrollTop: 0 })
  )
  const firstChild = attach(scrollArea, new FakeElement())

  assert.equal(dispatchTouchMoves(firstChild, 2), 0, '滚到顶部时不应 preventDefault')

  scrollArea.scrollTop = 820 - 464 // 滚到底
  assert.equal(dispatchTouchMoves(firstChild, 2), 0, '滚到底部时不应 preventDefault')

  // 没有溢出（内容比盒子矮）时也不该因为「滚不动」就锁住可滚容器里的触摸
  const noOverflowArea = attach(
    dialog,
    new FakeElement({ overflowY: 'auto', scrollHeight: 300, clientHeight: 464 })
  )
  const child = attach(noOverflowArea, new FakeElement())
  assert.equal(dispatchTouchMoves(child, 2), 0, '未溢出的可滚容器内部同样不该锁')
})

test('E 判定不再依赖 scrollHeight/clientHeight 现测（静态反向检查）', () => {
  assert.doesNotMatch(
    viewportSource,
    /scrollHeight\s*>\s*\w+\.clientHeight/,
    'viewport.ts 不能用 scrollHeight > clientHeight 判断可滚性：高度链退化时这两个读数是塌的'
  )
})

test('F Settings.module.css 的滚动容器有不依赖视口变量的兜底上界', () => {
  const css = readFileSync(
    new URL('../../src/components/settings/Settings.module.css', import.meta.url),
    'utf8'
  )
  const block = css.match(/\.feedbackMain\s*\{([\s\S]*?)\n\}/)
  assert.ok(block, '找不到 .feedbackMain 规则')
  const body = block[1]
  assert.match(body, /overflow-y:\s*auto/, '.feedbackMain 必须自己滚')
  assert.match(body, /min-height:\s*0/, '.feedbackMain 必须能 flex 收缩')
  assert.match(
    body,
    /max-height:\s*(min\([^)]*100v[hw])/,
    '.feedbackMain 需要一个不依赖 --modal-viewport-height 的兜底上界（如 min(560px, calc(100vh - 200px))）'
  )
  assert.doesNotMatch(body, /max-height:\s*var\(--modal-viewport-height/, '.feedbackMain 的上界不能再只靠视口变量')
})

// ------------------------------------------------ #218：可滚判定必须带几何回读
//
// #218 和 #173 是同一副面孔：**判定通过、效果为 0、判定过程没有实测回读**。
// 这里把两个方向都钉住 —— 只钉「回读为 0 不算可滚」的话，一律返回 false 也能蒙过关；
// 只钉「真的溢出算可滚」的话，退回旧行为也照样通过。
//
// 同时守住方向：回读为 0 只能说明**没证明**它能滚（内容可能还没填满 / 高度链没生成有界盒子），
// 不能反推「不能滚」再去 preventDefault —— 那条路的代价是 #30 的整页锁死。

test('G 声明 overflowY:auto 但 scrollHeight === clientHeight → 不再判为可滚', () => {
  assert.equal(
    typeof viewportModule.findScrollableAncestor,
    'function',
    `viewport.ts 必须导出带几何回读的可滚判定；当前导出：${Object.keys(viewportModule).join(', ') || '(无)'}`
  )

  // 高度链断开：盒子没有被撑成有界高度，内容把盒子整个撑满 → 声明仍是 auto，可滚距离却是 0。
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const dialog = attach(overlay, new FakeElement({ scrollHeight: 964, clientHeight: 964 }))
  const unbounded = attach(
    dialog,
    new FakeElement({ overflowY: 'auto', scrollHeight: 964, clientHeight: 964 })
  )
  const child = attach(unbounded, new FakeElement())

  const owner = viewportModule.findScrollableAncestor(child)
  assert.equal(owner?.element, unbounded, '祖先链上第一处声明了可滚的容器必须被找到，不能跳过')
  assert.equal(owner?.proven, false, '声明命中但 scrollHeight === clientHeight：不许判为「能滚」')

  // 方向：未证明 ≠ 不可滚 —— 不许因此把整页锁死。
  assert.equal(dispatchTouchMoves(child, 5), 0, '回读为 0 时仍须 fail-open：不许锁整页（#30 的方向）')
})

test('G2 内容确实溢出时判定必须为可滚（否则等于一律返回 false 蒙过关）', () => {
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const dialog = attach(overlay, new FakeElement({ scrollHeight: 608, clientHeight: 608 }))
  const overflowing = attach(
    dialog,
    new FakeElement({ overflowY: 'auto', scrollHeight: 820, clientHeight: 464 })
  )
  const child = attach(overflowing, new FakeElement())

  const owner = viewportModule.findScrollableAncestor?.(child)
  assert.equal(owner?.element, overflowing, '真的溢出的容器必须被判为可滚')
  assert.equal(owner?.proven, true, 'scrollHeight - clientHeight > 0 → proven 必须是 true')
  assert.equal(dispatchTouchMoves(child, 3), 0, '可滚容器内部的触摸由容器接管，不拦')
})

test('G3 横向同理：overflowX:auto 且 scrollWidth - clientWidth > 0 才算可滚', () => {
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const scroller = attach(
    overlay,
    new FakeElement({ overflowX: 'auto', scrollWidth: 900, clientWidth: 360, scrollHeight: 200, clientHeight: 200 })
  )
  const child = attach(scroller, new FakeElement())
  assert.equal(
    viewportModule.findScrollableAncestor?.(child)?.proven,
    true,
    '纵向不溢出但横向溢出：声明的是 overflowX，回读就该用 scrollWidth - clientWidth'
  )

  // 横向也不溢出 → 又回到「未证明」
  const flat = attach(overlay, new FakeElement({ overflowX: 'auto', scrollWidth: 360, clientWidth: 360 }))
  const flatChild = attach(flat, new FakeElement())
  assert.equal(
    viewportModule.findScrollableAncestor?.(flatChild)?.proven,
    false,
    '横向回读为 0 同样只能算「未证明」'
  )
})

test('G4 链上一处都没声明可滚 → 判空（锁生效的前提不能被这条改动带走）', () => {
  const overlay = attach(body, new FakeElement({ className: 'overlay' }))
  const label = attach(overlay, new FakeElement({ className: 'plainLabel' }))
  assert.equal(viewportModule.findScrollableAncestor?.(label), null, '没有任何声明可滚的祖先时应判空')
  assert.equal(dispatchTouchMoves(label, 2), 2, '判空时才轮到锁整页')
})
