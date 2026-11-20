// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #46 回归：思考过程默认折叠 + 可完全隐藏。
//
// 现状（修复前）：ReplyArea.tsx 里 `open` 初始值硬编码为 true，思考正文整段挂到 DOM；
// settings.ts 没有显示模式字段，也没有 localStorage 键；i18n 无相关文案。
//
// 断言方向：
//   A 设置：默认 collapsed；可写入 hidden / expanded；键沿用 chat-demo:* 前缀；冷启动读回
//   B 折叠态：长历史里思考正文**不挂 DOM**（showSteps === false），标题仍可点开
//   C 流式：思考进行中自动展开，结束（有正文）后按设置收敛
//   D 隐藏档：无标题、无正文、不占位；思考 step 从时间线剔除，工具行保留
//   E 老数据：message.thinking 缺失但 steps 里有 thinking，照样识别为有思考、可展开
//   F i18n：新键 zh/en 成对存在且文案不同
//   G 接线：ReplyArea 真的用这套逻辑（不是只加了个没人调的函数）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installTsResolve } from '../helpers/dom-env.mjs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// 装配走公共入口（#408 收尾批）：`.js→.ts` 解析由 installTsResolve 统一装，不再手抄 registerHooks。
installTsResolve()

/** 最小 localStorage：settings.ts 只在读不到时回落默认值 */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

const settingsUrl = new URL('../../src/services/settings.ts', import.meta.url).href
/** 冷启动：同一个模块以不同 URL 再导入一次，等价于应用重启后重新初始化 store */
const coldStart = (tag) => import(`${settingsUrl}?cold=${tag}`)

const settings = await import(settingsUrl)

test('A 思考过程显示方式：默认折叠，可切换并可持久化', async () => {
  assert.equal(
    settings.useSettings.getState().thinkingDisplay,
    'collapsed',
    '默认必须是折叠（修复前该字段不存在，读到 undefined）'
  )
  settings.setThinkingDisplay('hidden')
  assert.equal(settings.useSettings.getState().thinkingDisplay, 'hidden', '状态立即生效')
  assert.equal(
    storage.get('chat-demo:thinking-display'),
    'hidden',
    '沿用现有 chat-demo:* 的 localStorage 存法'
  )
  // 冷启动：偏好跨重启保持
  storage.set('chat-demo:thinking-display', 'expanded')
  const cold = await coldStart('one')
  assert.equal(cold.useSettings.getState().thinkingDisplay, 'expanded', '冷启动读回偏好')
  // 脏值回落默认，不把非法值写进 UI
  storage.set('chat-demo:thinking-display', 'nonsense')
  const dirty = await coldStart('two')
  assert.equal(dirty.useSettings.getState().thinkingDisplay, 'collapsed', '非法值回落折叠')
})

const layoutUrl = new URL('../../src/components/messages/thinkingDisplay.ts', import.meta.url).href

test('B 折叠态：思考正文不挂 DOM，标题仍显示', async () => {
  const { resolveThinkingLayout } = await import(layoutUrl)
  const collapsed = resolveThinkingLayout({
    mode: 'collapsed',
    hasThinking: true,
    streaming: false,
    hasResponse: true,
    open: false,
  })
  assert.equal(collapsed.showTitle, true, '折叠时保留一行标题（已思考 / 用时 N 秒）')
  assert.equal(collapsed.showSteps, false, '折叠时思考正文不进 DOM（长历史性能）')
  // 点开标题后正文才进 DOM，且展开状态不被写回默认
  const before = storage.get('chat-demo:thinking-display')
  const opened = resolveThinkingLayout({
    mode: 'collapsed',
    hasThinking: true,
    streaming: false,
    hasResponse: true,
    open: true,
  })
  assert.equal(opened.showSteps, true, '点开后正文可见')
  assert.equal(storage.get('chat-demo:thinking-display'), before, '展开不改变持久化偏好')
})

test('C 流式：思考进行中自动展开，结束后按设置收敛', async () => {
  const { resolveThinkingLayout } = await import(layoutUrl)
  const thinking = resolveThinkingLayout({
    mode: 'collapsed',
    hasThinking: true,
    streaming: true,
    hasResponse: false,
    open: false,
  })
  assert.equal(thinking.showSteps, true, '思考进行中要能看见「正在思考」，不能是一片空白')
  const settled = resolveThinkingLayout({
    mode: 'collapsed',
    hasThinking: true,
    streaming: true,
    hasResponse: true,
    open: false,
  })
  assert.equal(settled.showSteps, false, '正文开始输出后收敛回折叠')
  const expandedMode = resolveThinkingLayout({
    mode: 'expanded',
    hasThinking: true,
    streaming: false,
    hasResponse: true,
    open: null,
  })
  assert.equal(
    expandedMode.showSteps,
    true,
    'expanded 档保留旧的默认展开行为（用户没点过时按档位默认）'
  )
})

test('D 隐藏档：不渲染思考文本也不占位，工具行仍保留', async () => {
  const { resolveThinkingLayout, selectVisibleSteps } = await import(layoutUrl)
  const hidden = resolveThinkingLayout({
    mode: 'hidden',
    hasThinking: true,
    streaming: true,
    hasResponse: false,
    open: true,
  })
  assert.equal(hidden.showTitle, false, '隐藏档不显示思考标题（不占位）')
  assert.equal(hidden.showSteps, false, '隐藏档不渲染思考正文')
  assert.equal(hidden.dropThinkingSteps, true, '隐藏档把 thinking step 从时间线剔除')
  const steps = [
    { type: 'thinking', key: 't1' },
    { type: 'search', key: 's1' },
    { type: 'thinking', key: 't2' },
    { type: 'text', key: 'x1' },
  ]
  assert.deepEqual(
    selectVisibleSteps(steps, hidden).map((step) => step.key),
    ['s1', 'x1'],
    '只去掉思考，工具与正文步骤照旧'
  )
  assert.equal(selectVisibleSteps(steps, { dropThinkingSteps: false }).length, 4, '其他档不过滤')
})

test('E 老数据：没有 thinking 标记的历史消息也能识别出思考内容', async () => {
  const { hasThinkingContent } = await import(layoutUrl)
  assert.equal(hasThinkingContent(undefined, [{ type: 'thinking' }]), true, '按步骤推断')
  assert.equal(hasThinkingContent(false, [{ type: 'thinking' }]), true, '显式 false 但确有思考步骤')
  assert.equal(hasThinkingContent(true, []), true, '有标记无步骤也算')
  assert.equal(hasThinkingContent(undefined, [{ type: 'search' }]), false, '普通搜索不是思考')
})

test('F i18n：新键 zh/en 成对存在且文案不同', async () => {
  const { zh } = await import('../../src/i18n/zh.ts')
  const { en } = await import('../../src/i18n/en.ts')
  const keys = [
    'settingDialogThinkingDisplayLabel',
    'settingDialogThinkingDisplayCollapsed',
    'settingDialogThinkingDisplayExpanded',
    'settingDialogThinkingDisplayHidden',
  ]
  for (const key of keys) {
    assert.ok(key in zh, `zh 缺少 ${key}`)
    assert.ok(key in en, `en 缺少 ${key}`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了，不是同一串`)
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
})

test('G 接线：ReplyArea 用这套逻辑并订阅设置', async () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/components/messages/ReplyArea.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(source, /resolveThinkingLayout|selectVisibleSteps/, 'ReplyArea 必须调用折叠判定')
  assert.match(source, /thinkingDisplay/, 'ReplyArea 必须读设置里的显示方式')
  assert.doesNotMatch(source, /useState\(true\)/, '折叠态不能靠「先渲染再隐藏」的硬编码 useState(true)')
})
