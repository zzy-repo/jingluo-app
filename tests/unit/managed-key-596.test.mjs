// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + renderToStaticMarkup，零浏览器、零真实网络） | 耗时: <2s]
//
// Issue #596：「我们的渠道」选中时**禁止手填 API Key** —— Key 只能由服务端下发（设备领取）。
//
// 为什么要有它：手填入口放开的这段时间里出过三类真事故（#596 正文）——
//   ① 用户换过 Key 后本机还留着旧的一把：界面显示 `···e8494c` 而服务端早换了，一直 401，
//      用户以为「服务器繁忙」；
//   ② 用户把 Key 复制给别的客户端：实测一个账号 7 台手机 / 8 个 IP / 跨 4 省同时在用；
//   ③ 手填的 Key 可能属于别的账号：扣费不知道扣谁，出问题无法追溯。
//
// 五条验收（与 issue 的验收表一一对应）：
//   [1] ours 的 Key 行**只读**（结构上没有 input）；另外三个渠道仍可编辑（对照）
//   [2] deepseek / anthropic / openai 仍可手填（#608「只拿 Key 也能用」的硬验收不被破坏）
//   [3] ours + 没有服务端那把 Key → 发送被拦，文案说「领取」，且**不含**「服务器繁忙 / 未知错误」
//   [4] ours + 旧 Key（与服务端不一致）→ 判成 stale、提示重新领取，不是发出去后 401 静默失败
//   [5] 领取成功 → 本地存值 + 下发标记一起更新，界面尾号 = 实际请求用的那把
//
// 判据不自己编：拦截口径 = `apiConfig.checkApiKeyBeforeSend()`，关系判定 = `managedKey.managedKeyVerdict()`，
// 视图 = `managedKeyView.ManagedKeyView`（真 zh 文案渲染）。`ours` 的 Key 名/落盘顺序在
// `managedKey.ts` + `apiConfig.applyManagedKey()`，两侧都钉住。
//
//   node --test tests/unit/managed-key-596.test.mjs
//   node tests/run-layer.mjs unit --only managed-key-596
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'

// 原生桥 + 诊断写入口替身：apiConfig / settingsDialogState 会调 recordAction
installChatBridge()
// 构建期注入值（`__API_ORIGIN__` / `__ENDPOINTS__`）：apiConfig 顶层就要读
installEndpointsGlobals()
const dom = setupDom()

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')
const managed = await import('../../src/services/api/managedKey.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const dialogState = await import('../../src/components/settings/settingsDialogState.ts')
const view = await import('../../src/components/settings/managedKeyView.ts')
const { keyFingerprint } = await import('../../src/services/invite/keyIdentity.ts')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/**
 * 去掉注释再扫代码。
 *
 * 为什么必须去：这几处的注释里**故意**写着「结构上没有 `<input>`」「不许出现 `<input`」，
 * 直接对源码字符串匹配会把这些说明文字本身判成违规（假红），而假红比漏测更浪费后来人的时间。
 */
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** 服务端下发的那把（尾号 e849） */
const SERVER_KEY = 'sk-live-0123456789e849'
/** 用户手里的另一把（尾号 abcd）：手填 / 旧版本留下的 / 别的账号的，都长这样 */
const HAND_KEY = 'sk-live-0123456789abcd'

/** 设计系统 Button 的替身（`testId` → `data-testid`，其余透传） */
const ButtonStub = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

/** CSS Module 类名表替身：取什么给什么（断言不依赖类名，只为让真视图能渲染） */
const classNames = new Proxy({}, { get: (_target, name) => String(name) })

/** `data-testid` 是否存在（视图层的「这个块渲染没渲染」判据） */
const hasTestId = (markup, testId) => markup.includes(`data-testid="${testId}"`)

/** 取某个 `data-testid` 块的纯文本（失败信息里给一句话，不灌整页 DOM） */
const textOf = (markup, testId) => {
  const marker = `data-testid="${testId}"`
  const at = markup.indexOf(marker)
  if (at < 0) {
    return ''
  }
  const rest = markup.slice(at + marker.length)
  const next = rest.indexOf('data-testid=')
  const chunk = next >= 0 ? rest.slice(0, next) : rest.slice(0, 400)
  return chunk.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

// renderToStaticMarkup：纯 Node 下可用，不需要 DOM
const { renderToStaticMarkup } = await import('react-dom/server')
const staticMarkup = (element) => renderToStaticMarkup(element)

/** 视图的统一入口：真组件 + 真 zh 文案 + 注入的按钮替身 */
const viewMarkup = (over = {}) =>
  staticMarkup(
    createElement(view.ManagedKeyView, {
      t: translate,
      verdict: 'ok',
      tail: 'e849',
      blocked: null,
      claiming: false,
      error: null,
      notice: null,
      onClaim() {},
      Button: ButtonStub,
      styles: classNames,
      ...over,
    })
  )

/** 每个用例从干净的本地配置开始（同一进程里多行表格之间不许串味） */
const reset = () => {
  dom.localStorage.clear()
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('')
  dialogState.useSettingsDialog.setState({
    open: false,
    section: 'general',
    apiKeyFormatBlocked: false,
    managedKeyBlocked: null,
  })
}

// ---------------------------------------------------------------- [1] 只读形态

test('[1] Key 行形态：ours = 只读，deepseek / anthropic / openai = 可编辑', () => {
  assert.equal(view.apiKeyFieldMode('ours'), 'managed', 'ours 必须走只读那一支（#596 的核心）')
  for (const kind of ['deepseek', 'anthropic', 'openai']) {
    assert.equal(
      view.apiKeyFieldMode(kind),
      'editable',
      `${kind} 必须保持可手填（#608 的硬验收：只拿 Key 也要能用）`
    )
  }
})

test('[1] 设置页按渠道分支渲染，可编辑那一支的输入框还在（对照）', () => {
  /**
   * #800 改了什么：这一块**不再渲染只读 Key 行**（连掩码展示区与「重新领取」一起从 DOM 里拿掉），
   * 于是这里的断言从「按 apiKeyFieldMode 分支」改成「行清单由 sourceFieldPlan 决定、且没有
   * ManagedKeyField 这条路」。`ours` 仍然一个 input 都没有 —— #596 的核心结论没变，只是更彻底。
   * 面板级的 DOM 断言见 `tests/unit/source-panel-800.test.mjs`。
   */
  const fields = sourceOf('src/components/settings/ApiConfigFields.tsx')
  assert.match(
    fields,
    /sourceFieldRows\(kind\)\.map\(/u,
    '行清单必须来自 sourceFieldPlan（#800 之后这里是唯一的判定处）'
  )
  assert.equal(
    /ManagedKeyField/u.test(fields),
    false,
    '#800：内置服务的只读 Key 行不再由设置页渲染'
  )
  assert.match(fields, /<ApiKeyField editor=\{editor\} \/>/u, '另外三个渠道仍然渲染可编辑的 Key 行')
  assert.match(fields, /type="password"/u, '可编辑那一支的密码输入框不许被一起删掉')
  // 只读那一块里**结构上**没有 input：不是 disabled，而是根本没有那个节点（disable 能被改回来）
  for (const file of [
    'src/components/settings/managedKeyView.ts',
    'src/components/settings/ManagedKeyField.tsx',
  ]) {
    const source = codeOf(file)
    assert.equal(
      /createElement\(\s*'input'/u.test(source) || /<input[\s/>]/u.test(source),
      false,
      `${file} 里不许出现输入框：ours 的 Key 只能由服务端下发`
    )
  }
})

test('[1] 只读行渲染：尾号 + 说明 + 「重新领取」，整块没有 input', () => {
  const markup = viewMarkup()
  assert.equal(markup.includes('<input'), false, 'ours 的 Key 行不许渲染任何输入框')
  assert.equal(hasTestId(markup, 'settings-managed-key'), true)
  const value = textOf(markup, 'settings-managed-key-value')
  assert.match(value, /当前 Key ···e849/u, `只读行要显示「当前 Key ···尾号4位」，实际：${value}`)
  const hint = textOf(markup, 'settings-managed-key-hint')
  assert.match(hint, /无需填写/u, '必须说清「不用填」')
  assert.match(hint, /重新领取/u, '必须说清「要换就重新领取」')
  assert.match(textOf(markup, 'settings-managed-key-claim'), /重新领取/u, '按钮文案 = 重新领取')
})

test('[1] 没有 Key 时只读行说「尚未领取」，不是空白也不是 0 长度掩码', () => {
  const markup = viewMarkup({ verdict: 'unclaimed', tail: '' })
  const value = textOf(markup, 'settings-managed-key-value')
  assert.match(value, /尚未领取/u, `实际：${value}`)
  assert.equal(markup.includes('<input'), false)
})

// ---------------------------------------------------------------- [3] ours + 无 Key

test('[3] ours + 没有 Key：发送被拦，设置页说「请先领取 Key」', () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('')

  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'claim', 'ours 没 Key 必须是 claim 档（不是 missing）')
  assert.equal(dialogState.ensureApiKey(), false, '必须拦下，不许带着空 Key 发请求')
  const state = dialogState.useSettingsDialog.getState()
  assert.equal(state.open, true, '拦截要打开设置')
  // #727 阶段 1：Key 那一行搬到了第三个 tab（账户与消费）。断言口径不变（「落在 Key 所在的那个
  // 分组」），只是分组值从旧 IA 的 `data` 换成新 IA 的 `account` —— 落在 `data` 会让用户看到
  // 一个没有 Key 输入框的面板（SettingsDialog 的 data tab 已明确不留渠道 / Key / 模型）。
  assert.equal(state.section, 'account', '落在「账户与消费」')
  assert.equal(state.managedKeyBlocked, 'unclaimed', '设置页要知道这次是「还没领取」')
})

test('[3] 启动那一次不弹窗（手上已经有一把时），发送那一次一定拦', () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey(HAND_KEY) // 有一把、但没有下发标记（老版本残留 / 手填）

  // 启动：不打扰用户（只有「一个都没有」才弹设置，与 #451 之前的既有路径一致）
  assert.equal(dialogState.ensureApiKey({ fromBoot: true }), false)
  assert.equal(
    dialogState.useSettingsDialog.getState().open,
    false,
    '启动时手上有 Key 就不该弹设置：用户还没做任何事，弹窗只会打断他'
  )

  // 发送：拦下并把原因写进设置（这才是有用的一刻）
  assert.equal(dialogState.ensureApiKey(), false)
  assert.equal(dialogState.useSettingsDialog.getState().open, true)
  assert.equal(dialogState.useSettingsDialog.getState().managedKeyBlocked, 'unclaimed')

  // 启动 + 一个 Key 都没有：仍然弹设置（既有行为不变）
  reset()
  apiConfig.setProviderKind('ours')
  dialogState.useSettingsDialog.setState({ open: false })
  assert.equal(dialogState.ensureApiKey({ fromBoot: true }), false)
  assert.equal(dialogState.useSettingsDialog.getState().open, true, '没有 Key 时启动就该打开设置')
})

test('[3] 拦截文案含「领取」，且不含「服务器繁忙 / 未知错误」这类掩盖性说法', () => {
  const blocked = viewMarkup({ verdict: 'unclaimed', tail: '', blocked: 'unclaimed' })
  const text = textOf(blocked, 'settings-managed-key-blocked')
  assert.match(text, /领取/u, `拦截文案必须说「领取」，实际：${text}`)
  assert.match(text, /没有发出去/u, '必须写明这条消息没有发出去（#451 的同一纪律）')
  for (const word of ['服务器繁忙', '未知错误']) {
    assert.equal(text.includes(word), false, `拦截文案不许出现「${word}」：用户会被引到「等一等」上`)
  }
  // 英文侧同一口径（同一批界面里切换语言不许换出一句掩盖性说法）
  for (const key of [
    'settingsManagedKeyBlockedClaim',
    'settingsManagedKeyBlockedStale',
    'settingsManagedKeyStale',
  ]) {
    assert.match(zh[key], /领取/u, `zh.${key} 必须说「领取」`)
    assert.equal(/服务器繁忙|未知错误/u.test(zh[key]), false, `zh.${key} 不许有掩盖性说法`)
    assert.equal(typeof en[key], 'string')
    assert.match(en[key], /re-claim|Claim/u, `en.${key} 必须说 re-claim`)
  }
})

// ---------------------------------------------------------------- [4] ours + 旧 Key

test('[4] ours + 本地这把与服务端不一致：判成 stale，提示重新领取（不是发出去后 401）', () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.applyManagedKey(SERVER_KEY, 7) // 上一次领取：Key + 下发标记一起写
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'ok', '刚领取完应当是放行的')

  // 之后本机这把被换掉了（手填 / 别的渠道串过来 / 老版本残留）——服务端那把没有变
  apiConfig.setApiKey(HAND_KEY)
  assert.equal(
    apiConfig.getManagedKeyVerdict(),
    'stale',
    '与本机记录的服务端那把不一致 → stale（否则就是「用旧 Key 发出去换 401」）'
  )
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'stale')
  assert.equal(dialogState.ensureApiKey(), false, 'stale 必须拦下')
  assert.equal(
    dialogState.useSettingsDialog.getState().managedKeyBlocked,
    'stale',
    '设置页要知道这次是「Key 已更新」'
  )

  const markup = viewMarkup({ verdict: 'stale', tail: 'abcd', blocked: 'stale' })
  const blocked = textOf(markup, 'settings-managed-key-blocked')
  assert.match(blocked, /Key 已更新/u, `实际：${blocked}`)
  assert.match(blocked, /重新领取/u)
  assert.equal(blocked.includes('服务器繁忙'), false)
})

test('[4] 手填一把「格式完美」的 Key 也过不去：没有下发标记就算未领取（fail-closed）', () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey(HAND_KEY) // 用户手动塞进来的，格式完全合法
  assert.equal(
    apiConfig.getServerKeyMark(),
    null,
    '手填绝不许顺手写「服务端下发标记」——否则手填就能混过校验'
  )
  assert.equal(apiConfig.getManagedKeyVerdict(), 'unclaimed')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'claim')
})

test('[4] ours 的 401 文案另说一句（没有「重新填写」这条不存在的路）', async () => {
  /**
   * #800：内置服务不再渲染「重新领取」按钮，所以这句话不能再指路到那个按钮 ——
   * 恢复改成后台自动对齐（启动 / 登录后 / 发送被拦时各一次），文案说的就是「会自己重新对齐」。
   */
  assert.match(zh.apiKeyRejectedOurs, /自动/u, 'ours 401 的出路是「自动重新对齐」（按钮已随 #800 删除）')
  assert.equal(/重新领取|重新填写/u.test(zh.apiKeyRejectedOurs), false, '不许指路到已删除的按钮')
  assert.equal(/未知错误|服务器繁忙/u.test(zh.apiKeyRejectedOurs), false)
  // 接线（#771 之后）：401 该说哪句由 `chat/errorNotice.ts` 的报错矩阵按渠道选 —— 原来那段
  // `store.ts` 里的 `getProviderKind() === 'ours' ? … : …` 三元已经收进表里（表驱动 = 唯一判定处）。
  // 所以断言从「读 store.ts 源码正则」改成**直接调那张表**：行为不变，判据更强（源码换个写法也拦得住）。
  const notices = await import('../../src/services/chat/errorNotice.ts')
  assert.equal(
    notices.errorNoticeKey({ status: 401, providerKind: 'ours' }),
    'apiKeyRejectedOurs',
    'chat 401 必须按渠道选文案：ours 用 apiKeyRejectedOurs'
  )
  assert.equal(
    notices.errorNoticeKey({ status: 401, providerKind: 'deepseek' }),
    'apiKeyRejected',
    '其它渠道的 401 仍是「重新填写」那句（对照：不是一律换成 ours 的文案）'
  )
  // 并钉住「store 真的走这张表」：401 的文案在 store 里只能经由 errorNotice 取，不许再长回一段三元
  const store = codeOf('src/services/chat/store.ts')
  assert.match(store, /errorNoticeKey|pickErrorNotice/u, 'store 的报错文案必须来自 errorNotice 表（#771）')
  assert.equal(
    /getProviderKind\(\) === 'ours'[\s\S]{0,120}apiKeyRejectedOurs/u.test(store),
    false,
    'store 里不该再有「按渠道挑 401 文案」的本地三元：那是 errorNotice 表的事'
  )
})

// ---------------------------------------------------------------- [5] 领取成功

/** 假领取源：记下发出去的请求，按给定应答返回 */
const fakeSource = ({ key = SERVER_KEY, id = 7, name = 'app-test', fail = null } = {}) => {
  const calls = { create: [], update: [], list: [] }
  const source = {
    keys: {
      list: async (query) => {
        calls.list.push(query)
        return { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20, pages: 0 }, status: 200, raw: {} }
      },
      create: async (input) => {
        calls.create.push(input)
        return fail === null
          ? { ok: true, data: { id, key, name: input.name, status: 'active', quota: 0, quotaUsed: 0 }, status: 201, raw: {} }
          : { ok: false, error: fail, raw: {} }
      },
      update: async (keyId, input) => {
        calls.update.push({ id: keyId, input })
        return { ok: true, data: { id: keyId, key, name, status: input.status, quota: 0, quotaUsed: 0 }, status: 200, raw: {} }
      },
    },
  }
  return { source, calls }
}

test('[5] 领取成功：本地存值 + 下发标记一起更新，界面尾号 = 实际请求用的那把', async () => {
  reset()
  apiConfig.setProviderKind('ours')

  const { source } = fakeSource()
  const claimed = await managed.claimManagedKey(source, { deviceId: 'd-0123456789abcdef0123456789abcdef', rotate: false })
  assert.equal(claimed.ok, true, '领取应当成功')
  assert.equal(apiConfig.applyManagedKey(claimed.data.key, claimed.data.id), true)

  // 存储：Key 与标记同源
  assert.equal(apiConfig.getApiKey(), SERVER_KEY, '本地存的那把必须是服务端刚下发的那把')
  const mark = apiConfig.getServerKeyMark()
  assert.equal(mark.fingerprint, keyFingerprint(SERVER_KEY), '标记必须指向这一把')
  assert.equal(mark.tail, 'e849')
  assert.equal(mark.id, 7, '旧 Key 的 id 要记住（重新领取时停用旧那把）')
  assert.equal(JSON.stringify(mark).includes(SERVER_KEY), false, '标记里不许出现 Key 原文')

  // 判定与界面：尾号取的就是**实际会用于请求的那一把**
  assert.equal(apiConfig.getManagedKeyVerdict(), 'ok')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'ok', '领取成功后必须能发')
  const tail = managed.managedKeyTail(apiConfig.getApiKey())
  assert.equal(tail, 'e849', '尾号取 getApiKey()（请求用的那把），不是另一个来源')
  const markup = viewMarkup({ tail })
  assert.match(textOf(markup, 'settings-managed-key-value'), /···e849/u)
})

test('[5] 重新领取：用新名字换一把新 Key，旧那把置为 inactive', async () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.applyManagedKey(SERVER_KEY, 7)

  const { source, calls } = fakeSource({ key: 'sk-live-0123456789wxyz', id: 9 })
  const rotated = await managed.claimManagedKey(source, {
    deviceId: 'd-0123456789abcdef0123456789abcdef',
    rotate: true,
    now: Date.UTC(2026, 10, 21, 1, 0, 0),
  })
  assert.equal(rotated.ok, true)
  assert.equal(rotated.data.rotated, true)
  assert.notEqual(
    calls.create[0].name,
    managed.managedKeyName('d-0123456789abcdef0123456789abcdef'),
    '重新领取必须用一个新名字（同名会被服务端去重成同一把，等于没换）'
  )

  apiConfig.applyManagedKey(rotated.data.key, rotated.data.id)
  assert.equal(
    await managed.retireManagedKey(source, 7),
    true,
    '换完要把旧那把停用（服务端没有 /rotate，用 PUT 状态位等价表达）'
  )
  assert.deepEqual(calls.update[0], { id: 7, input: { status: 'inactive' } })
  assert.equal(apiConfig.getApiKey(), 'sk-live-0123456789wxyz')
  assert.equal(managed.managedKeyTail(apiConfig.getApiKey()), 'wxyz', '界面尾号立刻跟着新 Key')
})

test('[5] 设备名唯一：同一设备幂等、不同设备不同名（防「所有设备共用一把」）', () => {
  const deviceA = 'd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const deviceB = 'd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert.equal(managed.managedKeyName(deviceA), managed.managedKeyName(deviceA), '同一设备重复领取要幂等')
  assert.notEqual(
    managed.managedKeyName(deviceA),
    managed.managedKeyName(deviceB),
    '不同设备必须不同名：同名会被服务端去重成一把 → 就是 #596 里 7 台手机共用一把的事故'
  )
  assert.notEqual(
    managed.rotatedKeyName(deviceA, 1_700_000_000_000),
    managed.rotatedKeyName(deviceA, 1_700_000_001_000),
    '两次「重新领取」不能同名'
  )
})

test('[5] 启动对齐：服务端那把与本机不一样就覆盖本地（不许静默继续用旧的）', async () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.applyManagedKey(HAND_KEY, 3) // 本机手上是旧的 / 手填的

  const { source } = fakeSource({ key: SERVER_KEY, id: 7 })
  const synced = await managed.syncManagedKey(source, {
    deviceId: 'd-0123456789abcdef0123456789abcdef',
  })
  assert.equal(synced.ok, true)
  assert.notEqual(synced.data.key, apiConfig.getApiKey(), '两者不一致正是要对齐的场景')
  apiConfig.applyManagedKey(synced.data.key, synced.data.id)
  assert.equal(apiConfig.getApiKey(), SERVER_KEY, '以服务端为准')
  assert.equal(apiConfig.getManagedKeyVerdict(), 'ok')
  assert.equal(apiConfig.getServerKeyMark().id, 7)
})

test('[5] 领取失败：原样返回错误，本地一个字都不动', async () => {
  reset()
  apiConfig.setProviderKind('ours')
  apiConfig.applyManagedKey(SERVER_KEY, 7)
  const { source } = fakeSource({
    fail: { kind: 'auth', code: '40101', message: 'unauthorized', status: 401, retryable: false, envelope: 'middleware', i18nKey: 'consumeErrUnauthorized' },
  })
  const result = await managed.claimManagedKey(source, {
    deviceId: 'd-0123456789abcdef0123456789abcdef',
    rotate: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 401)
  assert.equal(apiConfig.getApiKey(), SERVER_KEY, '领取失败不许把本地那把清掉/换掉')
  assert.equal(apiConfig.getManagedKeyVerdict(), 'ok')
})

// ---------------------------------------------------------------- [2] 其它渠道不受影响

test('[2] 另外三个渠道照旧可手填（#608 硬验收）：缺 Key 提示填 Key，有 Key 就放行', () => {
  for (const kind of ['deepseek', 'anthropic', 'openai']) {
    reset()
    apiConfig.setProviderKind(kind)
    apiConfig.setApiKey('')
    assert.equal(
      apiConfig.checkApiKeyBeforeSend(),
      'missing',
      `${kind} 没 Key 时仍然是「没填」（既有路径一个字不改）`
    )
    apiConfig.setApiKey(HAND_KEY)
    assert.equal(
      apiConfig.checkApiKeyBeforeSend(),
      'ok',
      `${kind} 手填一把合法 Key 必须能发（#608：只拿 Key 也要能用）`
    )
    // ours 的下发标记在别的渠道不参与判定
    apiConfig.markServerKey(SERVER_KEY, 7)
    apiConfig.setApiKey(HAND_KEY)
    assert.equal(
      apiConfig.getManagedKeyVerdict(),
      'ok',
      `${kind} 不该受「我们的渠道」下发标记影响`
    )
  }
})
