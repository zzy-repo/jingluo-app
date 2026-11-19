// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #108 回归：回车键行为可配（发送 / 换行 / 只换行）。
//
// 现状（修复前）：ChatInput.tsx 里 `event.key === 'Enter' && !event.shiftKey && !isComposing`
// 直接发送，写死在组件里；settings.ts 没有 enterKeyMode 字段，没有 chat-demo:enter-key-mode 键；
// 全仓没有 enterKeyHint（软键盘回车键文案不随行为变）；设置面板没有这一项。
//
// 断言方向：
//   A 设置项存在，默认档 = 现状（回车发送）
//   B 三档可切换、立即生效、跨重启持久化（chat-demo:enter-key-mode），脏值回落默认
//   C 三档各自的回车语义（发送 / 换行 / 只换行）
//   D 输入法合成期任何档位都不发送（独立用例）
//   E enterKeyHint 随档位变 + ChatInput 真的接线（不再写死）
//   F i18n：新键 zh/en 成对；设置面板末尾追加（不重排 #102 的阅读设置）
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

const srcPath = (relative) => fileURLToPath(new URL(`../../src/${relative}`, import.meta.url))
const readSource = (relative) => readFileSync(srcPath(relative), 'utf8')

const settingsUrl = new URL('../../src/services/settings.ts', import.meta.url).href
/** 冷启动：同一个模块以不同 URL 再导入一次，等价于应用重启后重新初始化 store */
const coldStart = (tag) => import(`${settingsUrl}?cold=${tag}`)

const settings = await import(settingsUrl)
const enterKeyUrl = new URL('../../src/components/chatInput/enterKey.ts', import.meta.url).href
const { resolveEnterKeyAction, enterKeyHintFor } = await import(enterKeyUrl)

const MODES = ['enter-send', 'modifier-send', 'button-only']

/** 构造一个 keyboard 事件快照（只看这几个字段，纯函数不吃真 DOM） */
const key = (fields) => ({ key: 'Enter', ...fields })

test('A 设置项存在：默认档是「回车发送」= 修复前写死的行为', () => {
  const state = settings.useSettings.getState()
  assert.equal(
    state.enterKeyMode,
    'enter-send',
    '默认档必须是现状（修复前 enterKeyMode 字段不存在，行为就是回车即发送）'
  )
  assert.equal(typeof settings.setEnterKeyMode, 'function', '必须有唯一的写入口 setEnterKeyMode')
})

test('B 三档可切换、立即生效、跨重启持久化，脏值回落默认', async () => {
  for (const mode of MODES) {
    settings.setEnterKeyMode(mode)
    assert.equal(settings.useSettings.getState().enterKeyMode, mode, `${mode} 状态立即生效`)
    assert.equal(storage.get('chat-demo:enter-key-mode'), mode, `${mode} 沿用 chat-demo:* 存储方式`)
  }

  // 冷启动后保持
  settings.setEnterKeyMode('button-only')
  const cold = await coldStart('enter-keep')
  assert.equal(cold.useSettings.getState().enterKeyMode, 'button-only', '重启后保持所选档')

  // 脏值不落到界面上，回落到现状档
  storage.set('chat-demo:enter-key-mode', 'shift-send')
  const dirty = await coldStart('enter-dirty')
  assert.equal(dirty.useSettings.getState().enterKeyMode, 'enter-send', '脏值回落默认「回车发送」')

  storage.set('chat-demo:enter-key-mode', '')
  const blank = await coldStart('enter-blank')
  assert.equal(blank.useSettings.getState().enterKeyMode, 'enter-send', '空串回落默认')

  settings.setEnterKeyMode('enter-send')
})

test('C 三档语义：回车发送 / Ctrl+Cmd 回车发送 / 只换行必须点按钮', () => {
  // 档 1「回车发送」= 现状：回车发送，Shift+回车换行，修饰键回车也发送（回车本来就发送）
  assert.equal(resolveEnterKeyAction(key({}), 'enter-send'), 'send', '回车发送')
  assert.equal(resolveEnterKeyAction(key({ shiftKey: true }), 'enter-send'), 'newline', 'Shift+回车换行')
  assert.equal(resolveEnterKeyAction(key({ ctrlKey: true }), 'enter-send'), 'send', 'Ctrl+回车仍发送')
  assert.equal(resolveEnterKeyAction(key({ metaKey: true }), 'enter-send'), 'send', 'Cmd+回车仍发送')

  // 档 2「Ctrl/Cmd+回车发送」：裸回车换行，修饰键回车发送
  assert.equal(resolveEnterKeyAction(key({}), 'modifier-send'), 'newline', '回车换行不发送')
  assert.equal(
    resolveEnterKeyAction(key({ shiftKey: true }), 'modifier-send'),
    'newline',
    'Shift+回车换行'
  )
  assert.equal(resolveEnterKeyAction(key({ ctrlKey: true }), 'modifier-send'), 'send', 'Ctrl+回车发送')
  assert.equal(resolveEnterKeyAction(key({ metaKey: true }), 'modifier-send'), 'send', 'Cmd+回车发送')
  assert.equal(
    resolveEnterKeyAction(key({ ctrlKey: true, shiftKey: true }), 'modifier-send'),
    'newline',
    'Ctrl+Shift+回车换行（带 Shift 一律换行，和系统习惯一致）'
  )

  // 档 3「只换行」：回车、修饰键回车都只换行，必须点发送按钮
  for (const extra of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(
      resolveEnterKeyAction(key(extra), 'button-only'),
      'newline',
      `只换行档下 ${JSON.stringify(extra)} 不能发送`
    )
  }

  // 非回车键一律不归这里管
  assert.equal(resolveEnterKeyAction({ key: 'a' }, 'enter-send'), null, '普通字符不拦截')
  assert.equal(resolveEnterKeyAction({ key: 'Escape' }, 'button-only'), null, '其他功能键不拦截')
})

test('D 输入法合成期：三档任何组合都不发送（独立用例）', () => {
  for (const mode of MODES) {
    for (const extra of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      assert.equal(
        resolveEnterKeyAction(key({ ...extra, isComposing: true }), mode),
        'newline',
        `${mode} 档 + isComposing=true 时回车必须是换行（上屏），不能发送`
      )
    }
    // Safari / 旧 WebKit 在 compositionend 前后 isComposing 可能为 false，但 keyCode 是 229
    assert.equal(
      resolveEnterKeyAction(key({ keyCode: 229 }), mode),
      'newline',
      `${mode} 档 keyCode 229（输入法处理中）不能发送`
    )
  }

  // 组件里必须真的把 isComposing 传进来（别把现有保护删掉）
  const chatInput = readSource('components/chatInput/ChatInput.tsx')
  assert.match(
    chatInput,
    /isComposing/,
    'ChatInput 必须继续判断 isComposing（issue #108 分诊：现有保护不能删）'
  )
  assert.match(
    chatInput,
    /nativeEvent\.isComposing/,
    'ChatInput 必须读 nativeEvent.isComposing（React 合成事件的真实来源）'
  )
})

test('E 软键盘回车键文案随档位 + ChatInput 真的接线（不再写死）', () => {
  // 回车即发送的档位，键盘回车键语义是「发送」；换行档位语义是「换行」
  assert.equal(enterKeyHintFor('enter-send'), 'send', '回车发送档：enterKeyHint=send')
  assert.equal(enterKeyHintFor('modifier-send'), 'enter', 'Ctrl/Cmd 发送档：回车键是换行')
  assert.equal(enterKeyHintFor('button-only'), 'enter', '只换行档：回车键是换行')
  for (const mode of MODES) {
    const hint = enterKeyHintFor(mode)
    const action = resolveEnterKeyAction(key({}), mode)
    assert.equal(
      hint === 'send',
      action === 'send',
      `${mode} 档的键盘文案（${hint}）必须和裸回车实际行为（${action}）一致`
    )
  }

  const chatInput = readSource('components/chatInput/ChatInput.tsx')
  assert.match(chatInput, /enterKeyMode/, 'ChatInput 必须读设置里的 enterKeyMode')
  assert.match(chatInput, /resolveEnterKeyAction/, 'ChatInput 的回车分支必须走 resolveEnterKeyAction')
  assert.match(chatInput, /enterKeyHint=\{enterKeyHintFor/, 'ChatInput 的 textarea 必须设 enterKeyHint')
  assert.doesNotMatch(
    chatInput,
    /if \(event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing\)/,
    '写死的「回车即发送」条件必须被替换掉'
  )
})

test('F i18n 键成对、设置面板末尾追加且不动阅读设置', async () => {
  const { zh } = await import(new URL('../../src/i18n/zh.ts', import.meta.url).href)
  const { en } = await import(new URL('../../src/i18n/en.ts', import.meta.url).href)
  const keys = [
    'settingDialogEnterKeyMode',
    'settingDialogEnterKeyModeDescription',
    'settingDialogEnterKeySend',
    'settingDialogEnterKeyModifierSend',
    'settingDialogEnterKeyButtonOnly',
  ]
  for (const key of keys) {
    assert.ok(zh[key], `zh 缺 ${key}`)
    assert.ok(en[key], `en 缺 ${key}`)
    assert.notEqual(zh[key], en[key], `${key} 的中英文案不能一样`)
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 键集合必须完全一致')

  const dialog = readSource('components/settings/SettingsDialog.tsx')
  assert.match(dialog, /<EnterKeySettings \/>/, '通用设置里必须渲染回车键行为这一项')
  // 追加在 #102 的阅读设置之后（末尾追加式，其他 lane 顺序 rebase 才不撞车）
  assert.match(
    dialog,
    /<ReadingSettings \/>\s*<EnterKeySettings \/>/,
    '回车键行为必须追加在阅读设置之后，不重排既有条目'
  )
})
