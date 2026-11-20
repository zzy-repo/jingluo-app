// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
// GitHub issue #106：移动端标题栏双击回到首条消息。
//
// 修复前（main@cc4fe5a）：src/components/session/MobileHeader.tsx 的标题是一个裸 div
// （第 22 行），全文件 34 行里没有任何 onDoubleClick，也没有滚动到首条消息的入口。
// 这是「从未实现」，不是回归；所以本用例在改动前必须整组红。
//
// 断言方向：
//   A 双击标题 → 找到消息滚动层，逐帧平滑滚到首条（偏移单调递减，最后一帧落在 0）
//   B 不靠「先释放跟随再滚」的时序假设：动画每帧重写位置，跟随逻辑下一帧就被关掉（离底 > 40px）
//   C 流式追加把内容撑高时不会把位置抢回底部
//   D 已经在首条附近：双击无副作用（一次位置都不写）
//   E 短会话（滚动层没溢出）：无副作用
//   F 长会话 / 虚拟化：首条消息不在 DOM 里也能回到首条（只驱动滚动层偏移，不查消息节点）
//   G 找不到滚动层（欢迎页 / 无会话）：返回 false，不抛错
//   H 连续双击：后一次接管前一次，不会两个动画互相拉扯，最后仍停在首条
//   I 接线：MobileHeader 真的绑了这套逻辑，标题区 ≥44px，有可发现性提示，单击行为不变
//   J i18n：zh/en 成对，文案不同
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const read = (relative) => readFileSync(path.join(SRC, relative), 'utf8')

/** 最小假元素：只提供滚动工具与 MessageList 跟随逻辑读的那几个字段 */
class FakeElement {
  constructor({ overflowY = 'visible', scrollHeight = 0, clientHeight = 0, scrollTop = 0 } = {}) {
    this.style = { overflowY }
    this.scrollHeight = scrollHeight
    this.clientHeight = clientHeight
    this.scrollWidth = 0
    this.clientWidth = 0
    this._scrollTop = scrollTop
    this.children = []
    this.parentElement = null
    this.listeners = new Map()
    /** 写位置的流水：浏览器在每帧之后补一次 scroll 事件，这里同步补，等价于最坏情况 */
    this.writes = []
  }

  get scrollTop() {
    return this._scrollTop
  }

  set scrollTop(value) {
    this._scrollTop = value
    this.writes.push(value)
    for (const handler of [...(this.listeners.get('scroll') ?? [])]) handler({ type: 'scroll' })
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event) {
    for (const handler of [...(this.listeners.get(event?.type ?? event) ?? [])]) handler(event)
    return true
  }
}

globalThis.Element = FakeElement
globalThis.getComputedStyle = (element) => element.style

/** 手动驱动 requestAnimationFrame：按固定间隔喂时间戳，动画结果确定可断言 */
const frameQueue = []
globalThis.requestAnimationFrame = (callback) => {
  frameQueue.push(callback)
  return frameQueue.length
}
const stepFrames = (count, stepMs = 20) => {
  for (let index = 1; index <= count; index += 1) {
    const pending = frameQueue.splice(0)
    for (const callback of pending) callback(index * stepMs)
  }
}

const UTIL = '../../src/components/session/scrollToFirstMessage.ts'
let utilModule = null
let utilError = null
try {
  utilModule = await import(UTIL)
} catch (error) {
  // 修复前没有这个文件：不在这里直接抛，让每条用例都各自红一次，红得看得懂
  utilError = error
}
const scrollToFirstMessage = (anchor) => {
  if (utilError) throw new Error(`滚动工具还不存在（Issue #106 未实现）：${utilError.code ?? utilError.message}`)
  return utilModule.scrollToFirstMessage(anchor)
}

/** 会话页结构：view > [header, container > scrollHost > column > messages] */
const buildSession = ({
  messages = 6,
  scrollHeight = 12000,
  clientHeight = 800,
  scrollTop = 11200,
  overflowY = 'auto',
} = {}) => {
  const view = new FakeElement()
  const header = view.append(new FakeElement())
  const container = view.append(new FakeElement())
  const host = container.append(new FakeElement({ overflowY, scrollHeight, clientHeight, scrollTop }))
  const column = host.append(new FakeElement())
  for (let index = 0; index < messages; index += 1) column.append(new FakeElement())
  return { view, header, container, host, column }
}

/**
 * 复刻 MessageList.tsx 的跟随逻辑（scroll 监听 + ResizeObserver 把位置钉在底部）：
 * 贴底 → sticky=true；向上走且离开贴底区 → sticky=false；内容变高时若还在跟随就钉回底部。
 */
const attachFollower = (host) => {
  const state = { sticky: true, top: host.scrollTop }
  host.addEventListener('scroll', () => {
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40
    if (nearBottom) state.sticky = true
    else if (host.scrollTop < state.top) state.sticky = false
    state.top = host.scrollTop
  })
  /** 流式追加：内容变高；仍在跟随时 ResizeObserver 会把位置钉回底部 */
  const grow = (extra) => {
    host.scrollHeight += extra
    if (state.sticky) host.scrollTop = host.scrollHeight
  }
  return { state, grow }
}

test('A 双击标题：逐帧平滑滚到首条（单调递减，最后一帧落在 0）', () => {
  const { header, host } = buildSession()
  const follower = attachFollower(host)
  assert.equal(scrollToFirstMessage(header), true)
  stepFrames(40)
  assert.equal(host.scrollTop, 0, '没有回到首条')
  assert.ok(host.writes.length >= 3, `只有 ${host.writes.length} 帧，不是平滑滚动`)
  for (let index = 1; index < host.writes.length; index += 1) {
    assert.ok(
      host.writes[index] <= host.writes[index - 1],
      `位置不是一路往上（第 ${index} 帧 ${host.writes[index]} > 上一帧 ${host.writes[index - 1]}）`,
    )
  }
  assert.equal(follower.state.sticky, false, '动画结束后仍处于「跟随底部」')
})

test('B 跟随逻辑抢不回位置：动画每帧重写偏移，离底后跟随被关掉', () => {
  const { header, host } = buildSession()
  const follower = attachFollower(host)
  scrollToFirstMessage(header)
  stepFrames(3)
  assert.ok(host.scrollTop < 11200, '动画没有真的往上走')
  assert.equal(follower.state.sticky, false, '离开底部 40px 之后跟随应该被关掉')
})

test('C 流式追加不抢回位置', () => {
  const { header, host } = buildSession()
  const follower = attachFollower(host)
  scrollToFirstMessage(header)
  stepFrames(2)
  follower.grow(5000) // 追加内容，跟随逻辑若还活着会把位置钉到 5000+ 之后
  assert.ok(host.scrollTop < 11200, '内容变高后位置被抢回底部')
  stepFrames(40)
  assert.equal(host.scrollTop, 0, '追加期间动画没走完')
})

test('D 已经贴在首条：无副作用', () => {
  const { header, host } = buildSession({ scrollTop: 0 })
  assert.equal(scrollToFirstMessage(header), false)
  stepFrames(5)
  assert.deepEqual(host.writes, [])
})

test('E 短会话没得滚：无副作用', () => {
  const { header, host } = buildSession({ scrollHeight: 800, clientHeight: 800, scrollTop: 0 })
  assert.equal(scrollToFirstMessage(header), false)
  stepFrames(5)
  assert.deepEqual(host.writes, [])
})

test('F 长会话（虚拟化）：首条消息不在 DOM 里也能回到首条', () => {
  const { header, host } = buildSession({ messages: 0, scrollHeight: 480000, clientHeight: 800, scrollTop: 470000 })
  const follower = attachFollower(host)
  assert.equal(scrollToFirstMessage(header), true)
  stepFrames(40)
  assert.equal(host.scrollTop, 0)
  assert.equal(follower.state.sticky, false)
})

test('G 找不到滚动层（欢迎页 / 无会话）：返回 false 不抛错', () => {
  const view = new FakeElement()
  const header = view.append(new FakeElement())
  assert.equal(scrollToFirstMessage(header), false)
})

test('H 连续双击：后一次接管前一次，仍然停在首条', () => {
  const { header, host } = buildSession()
  attachFollower(host)
  scrollToFirstMessage(header)
  stepFrames(2)
  const midway = host.scrollTop
  scrollToFirstMessage(header) // 第二下：从当前位置重新起动画
  stepFrames(40)
  assert.ok(midway > 0 && midway < 11200)
  assert.equal(host.scrollTop, 0, '两次动画互相拉扯，没有停在首条')
})

const MOBILE_HEADER = read('components/session/MobileHeader.tsx')
const MOBILE_HEADER_CSS = read('components/session/MobileHeader.module.css')

test('I 接线：标题双击 → scrollToFirstMessage，标题区 ≥44px，有提示，单击行为不变', () => {
  assert.match(MOBILE_HEADER, /onDoubleClick=\{onTitleDoubleClick\}/, '标题区没有绑定双击')
  assert.match(MOBILE_HEADER, /from '\.\/scrollToFirstMessage\.js'/, '没有引用滚动工具')
  assert.match(MOBILE_HEADER, /scrollToFirstMessage\(/, '没有真的调用滚动工具')
  assert.match(MOBILE_HEADER, /title === undefined \? null/, '无标题（欢迎页）时不应渲染该手势')
  // 单击保持原行为：文件里只有菜单 / 新对话两个 onClick
  assert.equal((MOBILE_HEADER.match(/onClick=/g) ?? []).length, 2, '标题区被塞进了单击行为')
  // 键盘等价物
  assert.match(MOBILE_HEADER, /onKeyDown=\{onTitleKeyDown\}/, '没有键盘等价入口')
  // 可发现性提示
  assert.match(MOBILE_HEADER, /scrollToFirstMessageHint/, '标题栏没有可发现性提示，用户只能猜')
  // 点击目标 ≥44px（390 / 360 两档都要点得到）+ 双击不被双击缩放吞掉
  const block = /\.titleButton\s*\{([^]*?)\n\}/.exec(MOBILE_HEADER_CSS)?.[1] ?? ''
  assert.match(block, /min-height:\s*44px/, '标题区点击目标不足 44px')
  assert.match(block, /touch-action:\s*manipulation/, '没关掉双击缩放，双击手势会被浏览器吞掉')
})

test('J i18n：新增文案 zh/en 成对且不同', async () => {
  const { zh } = await import('../../src/i18n/zh.ts')
  const { en } = await import('../../src/i18n/en.ts')
  for (const key of ['scrollToFirstMessage', 'scrollToFirstMessageHint']) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.notEqual(zh[key], en[key], `${key} 中英文文案相同`)
  }
})
