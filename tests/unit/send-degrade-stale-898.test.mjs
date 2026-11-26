// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage） | 耗时: <2s]
//
// Issue #898 的最小一条：**控制面失败不阻断数据面**（母单 #894 / 与 #596 的关系见下）。
//
// ## 改前（用户可见的错）
//
// `settingsDialogState.ensureApiKey()` 在 `claim` / `stale` 两档**一律 return false**。
// 于是「自动领 Key 这一次没成、但本地明明有一把能用」的用户，连一条消息都发不出去：
//  #898 正文里的用户实证就是 `sk-3c5…` 已在本地，界面仍提示「这条消息暂时发不出去」。
//
// ## 改后（本单只做这一条）
//
//   本地**有** Key（哪怕归属没确认：手填 / 没标记 / 服务端换过）→ **放行试发一次**，
//   并给一条**保守**提示（「先按本地 Key 试发一次，失败就去重新领取」，不承诺成功）。
//   本地**一把都没有** → 仍阻断（这是 #898 允许保留的两条之一：本地完全没有凭据）。
//   格式明显不对（`format`）→ 仍阻断（本地就能判死的无效凭据，等于「没有可用凭据」）。
//
// ## 与 #596 的关系（不许假装没冲突）
//
// #596 的立单理由之一是「本地旧 Key 一直 401，用户以为服务器繁忙」，它选择的解法是**发车前拦**。
// 本单换了另一个解法：**放行，但让 401 说话**——前提是文案不许掩盖（D5 钉住：「不含服务器繁忙 /
// 未知错误」这类说法），并且诊断里留痕（D6）。两条约束任一失守，就退化成 #596 事故的样子。
//
//   node --test tests/unit/send-degrade-stale-898.test.mjs

import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatBridge, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

installChatBridge()
installEndpointsGlobals()
const dom = setupDom()

globalThis.window.setTimeout = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds)
  timer.unref?.()
  return timer
}
globalThis.window.clearTimeout = (timer) => clearTimeout(timer)

const { useToast } = await import('../../src/components/base/toastState.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')
const { zh } = await import('../../src/i18n/zh.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const dialogState = await import('../../src/components/settings/settingsDialogState.ts')


test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文')

const HAND_KEY = 'sk-hand-filled-0123456789abcdef'
const SERVER_KEY = 'sk-server-issued-0123456789abcdef'

const reset = () => {
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('')
  apiConfig.clearServerKeyMark()
  useToast.setState({ message: null, action: null, visible: false })
  dialogState.useSettingsDialog.setState({ open: false, managedKeyBlocked: null, apiKeyFormatBlocked: false })
}

const toastKey = () => useToast.getState().message?.key ?? null

test('[D1] stale（服务端换过 / 无法确认）但本地有 Key → 放行试发一次', () => {
  reset()
  apiConfig.setApiKey(HAND_KEY)
  // 下发标记指向另一把 Key ⇒ 判成 stale
  apiConfig.markServerKey(SERVER_KEY, 7)
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'stale', '前提：这一格确实是 stale')

  assert.equal(
    dialogState.ensureApiKey(),
    true,
    '改前这里是 false（#898 的用户可见错误：本地有 Key 却发不出去）'
  )
  assert.equal(dialogState.useSettingsDialog.getState().open, false, '放行也不许自己弹设置层')
  assert.equal(
    dialogState.useSettingsDialog.getState().managedKeyBlocked,
    null,
    '没有拦截就不许留「被拦」标记（否则设置页会写着「刚才没发出去」）'
  )
  assert.equal(toastKey(), 'settingsManagedKeyStaleDegraded', '要有一条保守的状态提示')
})

test('[D2] claim（没确认过归属）但本地有 Key → 放行试发一次', () => {
  reset()
  apiConfig.setApiKey(HAND_KEY) // 有 Key、没有下发标记
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'claim', '前提：这一格确实是 claim')

  assert.equal(dialogState.ensureApiKey(), true, '改前这里是 false')
  assert.equal(dialogState.useSettingsDialog.getState().managedKeyBlocked, null)
  assert.equal(toastKey(), 'settingsManagedKeyClaimDegraded')
})

test('[D3] 本地一把 Key 都没有 → 仍然阻断（#898 保留的唯一一条：没有可用凭据）', () => {
  reset()
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'claim')
  assert.equal(dialogState.ensureApiKey(), false, '没有凭据就没有「试发一次」这回事')
  assert.equal(
    dialogState.useSettingsDialog.getState().managedKeyBlocked,
    'unclaimed',
    '设置页要知道这次是「还没领取」'
  )
  assert.equal(toastKey(), 'settingsManagedKeyBlockedClaim', '文案要指向「去领取」')
  assert.equal(dialogState.useSettingsDialog.getState().open, false, '阻断也不弹设置层')
})

test('[D4] 非 ours 渠道与格式错仍按原样挡（本单不许放宽出 ours 之外）', () => {
  reset()
  // 非 ours：有 Key 就放行、空 Key 就 missing（改动前就这样，做对照）
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey(HAND_KEY)
  assert.equal(dialogState.ensureApiKey(), true, 'deepseek 有 Key 一直是放行')
  apiConfig.setApiKey('')
  assert.equal(dialogState.ensureApiKey(), false, '空 Key 仍挡')
  assert.equal(toastKey(), 'sendBlockedNoApiKey')

  // 格式明显不对：本地就能判死，仍挡（本单不放宽格式这一档）
  reset()
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('not-a-key')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'format', '前提：这一格是 format')
  assert.equal(dialogState.ensureApiKey(), false, '格式错仍挡（没有可用凭据）')
  assert.equal(dialogState.useSettingsDialog.getState().apiKeyFormatBlocked, true)
  assert.equal(toastKey(), 'settingsApiKeyFormatBlocked')

  // ours 这一档不走格式判断（下发 Key 由服务端保证形状），别把两条口径混起来
  reset()
  apiConfig.setApiKey('not-a-key')
  apiConfig.markServerKey('not-a-key', 7)
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'ok', 'ours + 指纹一致 = ok（格式口径不适用于下发 Key）')
})

test('[D5] 降级文案保守：不许承诺「一定能发出去」，也不许回到「服务器繁忙 / 未知错误」', () => {
  const zhTexts = [zh.settingsManagedKeyStaleDegraded, zh.settingsManagedKeyClaimDegraded]
  const enTexts = [zh.settingsManagedKeyStaleDegraded]
  for (const text of zhTexts) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0, '文案不许为空')
    for (const forbidden of ['服务器繁忙', '未知错误', '请稍后再试', '已经成功', '发送成功']) {
      assert.equal(text.includes(forbidden), false, `降级文案里不许出现「${forbidden}」`)
    }
    // 必须说清「试一次」与「失败后怎么办」：这是「不承诺成功」的唯一可核验写法
    assert.ok(
      /试发|试一次|先按/u.test(text),
      `降级文案要说清「先试发一次」：${text}`
    )
    assert.ok(
      /失败|领取/u.test(text),
      `降级文案要给出失败后的下一步：${text}`
    )
  }
  assert.equal(enTexts.length, 1, '占位断言，避免变量未用')
})

test('[D6] 降级放行也要留痕：诊断里能查到「这一次是降级发出去的」', async () => {
  const { __log } = globalThis
  reset()
  apiConfig.setApiKey(HAND_KEY)
  apiConfig.markServerKey(SERVER_KEY, 7)
  const before = (__log?.actions ?? []).length
  assert.equal(dialogState.ensureApiKey(), true)
  const actions = (__log?.actions ?? []).slice(before)
  // 记录形状是 `{ kind, action, fields }`（见 `diagnostics/collector.recordAction`）
  const record = actions.find((a) => a?.action === 'degrade-send-managed-key')
  assert.ok(
    record !== undefined,
    `降级放行必须记一条 action（改前这条路径根本不走，因为它直接 return false）：${JSON.stringify(actions)}`
  )
  assert.equal(record.fields?.reason, 'stale', '记下是哪一档降级')
  assert.equal(record.fields?.length, HAND_KEY.length, '只记长度，不记原文')
  assert.equal(
    JSON.stringify(record).includes(HAND_KEY),
    false,
    'Key 原文一个字都不许进日志（与 apiConfig 的存储口径一致）'
  )
})
