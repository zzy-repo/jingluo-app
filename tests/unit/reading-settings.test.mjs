// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #102 回归：消息区阅读设置（字号 / 字重 / 行高）。
//
// 现状（修复前）：settings.ts 没有这三项字段，localStorage 没有对应键，
// src/styles/ 目录不存在（没有 token 层），markdown 字号字重行高散在
// theme.css / markdown.css / UserMessage.module.css 里写死。
//
// 断言方向：
//   A 默认值 = 改造前的现状（standard / regular / standard），不是 undefined
//   B 改动后生效 + 持久化：沿用 chat-demo:* 键，冷启动读回，脏值回落默认
//   C token 层：reading.css 的默认档逐值等于改造前的字号/字重/行高（不许悄悄改默认外观）
//   D 只作用于消息区：设置面板与输入框的样式不引用阅读 token；消息区（正文 / 用户气泡）引用
//   E 接线：main.tsx 调 setupReading；reading.ts 把三档写到根元素 data-*；设置面板真的渲染三项
//   F i18n：新键 zh/en 成对存在且文案不同
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

/** 最小 localStorage：settings.ts 只在读不到时回落默认值 */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

/** 最小 document：reading.ts 只往根元素写 data-* 属性 */
const rootAttributes = new Map()
globalThis.document = {
  documentElement: {
    setAttribute: (name, value) => rootAttributes.set(name, String(value)),
    getAttribute: (name) => (rootAttributes.has(name) ? rootAttributes.get(name) : null),
    removeAttribute: (name) => rootAttributes.delete(name),
  },
}

const srcPath = (relative) => fileURLToPath(new URL(`../../src/${relative}`, import.meta.url))
const readSource = (relative) => readFileSync(srcPath(relative), 'utf8')

const settingsUrl = new URL('../../src/services/settings.ts', import.meta.url).href
/** 冷启动：同一个模块以不同 URL 再导入一次，等价于应用重启后重新初始化 store */
const coldStart = (tag) => import(`${settingsUrl}?cold=${tag}`)

const settings = await import(settingsUrl)

/** 从 CSS 里抠出某个选择器的声明块（只用于断言，不追求通用） */
const cssBlock = (css, selector) => {
  const index = css.indexOf(selector)
  assert.notEqual(index, -1, `CSS 里找不到选择器 ${selector}`)
  const start = css.indexOf('{', index)
  const end = css.indexOf('}', start)
  return css.slice(start + 1, end)
}

const SIZES = ['small', 'standard', 'large', 'xlarge']
const WEIGHTS = ['regular', 'medium', 'bold']
const LINES = ['compact', 'standard', 'relaxed']

test('A 阅读设置三项的默认值等于改造前的现状', () => {
  const state = settings.useSettings.getState()
  assert.equal(state.readingFontSize, 'standard', '字号默认必须是现状档（修复前该字段不存在）')
  assert.equal(state.readingFontWeight, 'regular', '字重默认必须是现状档（修复前该字段不存在）')
  assert.equal(state.readingLineHeight, 'standard', '行高默认必须是现状档（修复前该字段不存在）')
})

test('B 三项可改动、立即生效、跨重启持久化，脏值回落默认', async () => {
  settings.setReadingFontSize('large')
  assert.equal(settings.useSettings.getState().readingFontSize, 'large', '字号状态立即生效')
  assert.equal(storage.get('chat-demo:reading-font-size'), 'large', '沿用 chat-demo:* 的存储方式')

  settings.setReadingFontWeight('bold')
  assert.equal(settings.useSettings.getState().readingFontWeight, 'bold', '字重状态立即生效')
  assert.equal(storage.get('chat-demo:reading-font-weight'), 'bold', '字重沿用 chat-demo:* 的存储方式')

  settings.setReadingLineHeight('relaxed')
  assert.equal(settings.useSettings.getState().readingLineHeight, 'relaxed', '行高状态立即生效')
  assert.equal(storage.get('chat-demo:reading-line-height'), 'relaxed', '行高沿用 chat-demo:* 的存储方式')

  // 冷启动：三项选择跨重启保持
  const cold = await coldStart('reading-keep')
  assert.equal(cold.useSettings.getState().readingFontSize, 'large', '字号重启后保持')
  assert.equal(cold.useSettings.getState().readingFontWeight, 'bold', '字重重启后保持')
  assert.equal(cold.useSettings.getState().readingLineHeight, 'relaxed', '行高重启后保持')

  // 脏值不落到界面上
  storage.set('chat-demo:reading-font-size', 'huge')
  storage.set('chat-demo:reading-font-weight', '900')
  storage.set('chat-demo:reading-line-height', '')
  const dirty = await coldStart('reading-dirty')
  assert.equal(dirty.useSettings.getState().readingFontSize, 'standard', '脏字号回落默认')
  assert.equal(dirty.useSettings.getState().readingFontWeight, 'regular', '脏字重回落默认')
  assert.equal(dirty.useSettings.getState().readingLineHeight, 'standard', '脏行高回落默认')

  // 复位，避免影响后面的断言
  settings.setReadingFontSize('standard')
  settings.setReadingFontWeight('regular')
  settings.setReadingLineHeight('standard')
})

test('C token 层：默认档逐值等于改造前的字号 / 字重 / 行高', () => {
  const css = readSource('styles/reading.css')
  const base = cssBlock(css, ':root {')
  // 改造前：正文 16px/28px/400、次级 14px/24px、表格 15px/25px、标题 24/22/20/16、标题字重 700
  const expected = [
    ['--ds-reading-size-body', '16px'],
    ['--ds-reading-line-body', '28px'],
    ['--ds-reading-weight-body', '400'],
    ['--ds-reading-weight-strong', '600'],
    ['--ds-reading-weight-heading', '700'],
    ['--ds-reading-weight-table-head', '500'],
    ['--ds-reading-size-secondary', '14px'],
    ['--ds-reading-line-secondary', '24px'],
    ['--ds-reading-size-table', '15px'],
    ['--ds-reading-line-table', '25px'],
    ['--ds-reading-size-h1', '24px'],
    ['--ds-reading-line-h1', '34px'],
    ['--ds-reading-size-h2', '22px'],
    ['--ds-reading-line-h2', '32px'],
    ['--ds-reading-size-h3', '20px'],
    ['--ds-reading-line-h3', '30px'],
    ['--ds-reading-size-h4', '16px'],
    ['--ds-reading-line-h4', '28px'],
  ]
  for (const [token, value] of expected) {
    assert.match(
      base,
      new RegExp(`${token}:\\s*${value.replace('.', '\\.')};`),
      `默认档 ${token} 必须是 ${value}（等于改造前的现状）`
    )
  }
  // 行高倍率的默认值必须让「行高 = 原行高」，否则默认外观被悄悄改了
  assert.match(base, /--ds-reading-line-scale:\s*1;/, '行高倍率默认必须是 1')

  // 每个非默认档都要有对应的根属性块，否则界面上选了什么都不会变
  for (const value of SIZES) {
    assert.match(css, new RegExp(`:root\\[data-ds-reading-size='${value}'\\]`), `缺少字号档 ${value}`)
  }
  for (const value of WEIGHTS) {
    assert.match(
      css,
      new RegExp(`:root\\[data-ds-reading-weight='${value}'\\]`),
      `缺少字重档 ${value}`
    )
  }
  for (const value of LINES) {
    assert.match(css, new RegExp(`:root\\[data-ds-reading-line='${value}'\\]`), `缺少行高档 ${value}`)
  }

  // 字号真的往上走：small < standard < large < xlarge
  const sizeOf = (value) => {
    const block =
      value === 'standard' ? base : cssBlock(css, `:root[data-ds-reading-size='${value}'] {`)
    const match = block.match(/--ds-reading-size-body:\s*(\d+)px/)
    assert.notEqual(match, null, `档 ${value} 没有定义 --ds-reading-size-body`)
    return Number(match[1])
  }
  const ascending = SIZES.map(sizeOf)
  assert.deepEqual(
    ascending,
    [...ascending].sort((a, b) => a - b),
    `字号档必须递增，实际 ${ascending.join(' / ')}`
  )
})

test('C2 字体 token 由阅读 token 驱动，不再散落魔法数', () => {
  const theme = readSource('app/theme.css')
  // 正文 / 粗体 / 次级 / 表格 / 标题的字体简写都必须读 token
  assert.match(
    theme,
    /--dsw-font-markdown-base:\s*var\(--ds-reading-weight-body\)\s+var\(--ds-reading-size-body\)\s*\/\s*var\(--ds-reading-line-body\)/,
    '正文 token 必须由阅读 token 拼出来（字号 / 字重 / 行高）'
  )
  assert.match(
    theme,
    /--dsw-font-markdown-base-strong:\s*var\(--ds-reading-weight-strong\)\s+var\(--ds-reading-size-body\)\s*\/\s*var\(--ds-reading-line-body\)/,
    '正文粗体 token 必须由阅读 token 拼出来'
  )
  assert.match(
    theme,
    /--dsw-font-markdown-small:\s*var\(--ds-reading-weight-body\)\s+var\(--ds-reading-size-secondary\)\s*\/\s*var\(--ds-reading-line-secondary\)/,
    '次级字号 token 必须由阅读 token 拼出来'
  )
  assert.match(
    theme,
    /--dsw-font-markdown-table:\s*var\(--ds-reading-weight-body\)\s+var\(--ds-reading-size-table\)\s*\/\s*var\(--ds-reading-line-table\)/,
    '表格 token 必须由阅读 token 拼出来'
  )
  assert.match(
    theme,
    /--dsw-font-markdown-h1:\s*var\(--ds-reading-weight-heading\)\s+var\(--ds-reading-size-h1\)\s*\/\s*var\(--ds-reading-line-h1\)/,
    '标题 token 必须由阅读 token 拼出来'
  )
})

test('D 只作用于消息区：设置面板与输入框不引用阅读 token', () => {
  const collect = (dir) =>
    readdirSync(srcPath(dir))
      .filter((name) => name.endsWith('.css'))
      .map((name) => ({ name: `${dir}/${name}`, css: readSource(`${dir}/${name}`) }))

  for (const file of [...collect('components/settings'), ...collect('components/chatInput')]) {
    assert.doesNotMatch(
      file.css,
      /--ds-reading-/,
      `${file.name} 不该吃阅读 token：这两处不能跟着消息区的字号变`
    )
  }

  // 消息区正文：markdown 根字号 / 行高走 token（markdown.css 被消息区的 Markdown 组件引用）
  const markdownCss = readSource('components/markdown/markdown.css')
  assert.match(
    markdownCss,
    /\.ds-markdown\s*\{[^}]*font:\s*var\(--dsw-font-markdown-base\)/,
    '消息正文必须继续用 base token（现在它由阅读 token 驱动）'
  )

  // 用户气泡：原来写死 16px/24px，现在读 token（气泡行高比正文紧一档，单独一个 token）
  const userCss = readSource('components/messages/UserMessage.module.css')
  assert.match(userCss, /font-size:\s*var\(--ds-reading-size-body\)/, '用户气泡字号必须走 token')
  assert.match(
    userCss,
    /line-height:\s*calc\(var\(--ds-reading-line-bubble\) \* var\(--ds-reading-line-scale\)\)/,
    '用户气泡行高必须走 token（并跟着行高档缩放）'
  )

  // 行高档位只在消息区作用域内生效
  const reading = readSource('styles/reading.css')
  assert.match(
    reading,
    /main \.ds-markdown\s*\{[^}]*line-height:\s*calc\(var\(--ds-reading-line-body\) \* var\(--ds-reading-line-scale\)\)/,
    '行高倍率必须在消息区作用域内应用'
  )
  assert.match(
    reading,
    /var\(--ds-reading-line-body\)\s*\*\s*var\(--ds-reading-line-scale\)/,
    '行高档位必须真的乘到行高上'
  )
})

test('E 接线：设置写入根元素 data-*，main 起步时应用，设置面板渲染三项', async () => {
  const reading = await import(new URL('../../src/app/reading.ts', import.meta.url).href)
  reading.setupReading()
  assert.equal(rootAttributes.get('data-ds-reading-size'), 'standard', '起步就把字号档写到根元素')
  assert.equal(rootAttributes.get('data-ds-reading-weight'), 'regular', '起步就把字重档写到根元素')
  assert.equal(rootAttributes.get('data-ds-reading-line'), 'standard', '起步就把行高档写到根元素')

  settings.setReadingFontSize('xlarge')
  settings.setReadingFontWeight('medium')
  settings.setReadingLineHeight('compact')
  assert.equal(rootAttributes.get('data-ds-reading-size'), 'xlarge', '改动字号后根属性同步（生效链路）')
  assert.equal(rootAttributes.get('data-ds-reading-weight'), 'medium', '改动字重后根属性同步（生效链路）')
  assert.equal(rootAttributes.get('data-ds-reading-line'), 'compact', '改动行高后根属性同步（生效链路）')

  settings.setReadingFontSize('standard')
  settings.setReadingFontWeight('regular')
  settings.setReadingLineHeight('standard')

  assert.match(
    readSource('main.tsx'),
    /setupReading\(\)/,
    'main.tsx 必须在首屏渲染前应用一次阅读设置'
  )

  const dialog = readSource('components/settings/SettingsDialog.tsx')
  for (const marker of ['readingFontSize', 'readingFontWeight', 'readingLineHeight']) {
    assert.match(dialog, new RegExp(marker), `设置面板必须真的读写 ${marker}`)
  }
  assert.match(dialog, /<ReadingSettings \/>/, '通用设置里必须渲染阅读设置这一组')
  // 只加在通用设置的末尾，序号/顺序不动（其他 issue 的分支要能顺序 rebase）
  assert.match(
    dialog,
    /<ThinkingDisplaySetting \/>\s*<AppUpdateField \/>\s*<ReadingSettings \/>/,
    '阅读设置必须追加在通用设置末尾'
  )
})

test('F i18n：阅读设置的键 zh/en 成对且文案不同', async () => {
  const { zh } = await import(new URL('../../src/i18n/zh.ts', import.meta.url).href)
  const { en } = await import(new URL('../../src/i18n/en.ts', import.meta.url).href)
  const keys = [
    'settingDialogReadingGroupLabel',
    'settingDialogReadingFontSize',
    'settingDialogReadingFontWeight',
    'settingDialogReadingLineHeight',
    'settingDialogReadingSizeSmall',
    'settingDialogReadingSizeStandard',
    'settingDialogReadingSizeLarge',
    'settingDialogReadingSizeXLarge',
    'settingDialogReadingWeightRegular',
    'settingDialogReadingWeightMedium',
    'settingDialogReadingWeightBold',
    'settingDialogReadingLineCompact',
    'settingDialogReadingLineStandard',
    'settingDialogReadingLineRelaxed',
  ]
  for (const key of keys) {
    assert.ok(zh[key], `zh 缺 ${key}`)
    assert.ok(en[key], `en 缺 ${key}`)
    assert.notEqual(zh[key], en[key], `${key} 的中英文案不能一样`)
  }
  assert.deepEqual(
    Object.keys(en).sort(),
    Object.keys(zh).sort(),
    'zh/en 键集合必须完全一致'
  )
})
