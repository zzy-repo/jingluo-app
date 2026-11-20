// [layer: unit | 依赖: 无（纯 Node + zustand 内存 store，零浏览器零网络） | 耗时: <1s]
//
// #562 —— 旧 `OursServicesDialog` 退役后，「账户与消费」页成为**唯一**的钱入口。
// 三处调用点（设置里那一格 / 消息流两个 CTA / 付款回跳）现在走的是同一个出口
// `settingsDialogState.openAccountConsume(tab)`，本文件把这条出口的契约钉住：
//
//   1. 打开设置并选中「数据管理」（面包屑仍是 设置 → 数据管理 → 账户与消费）；
//   2. 落哪个 tab 由调用方指定，**缺省是 `cards`（我的卡密）** —— 付款回跳就是为了让用户看到卡密；
//   3. 消息流两个 CTA 的目标 tab 固定：额度不足 → `quota`（我的额度），Key 失效 → `account`（账号）；
//   4. 关掉只改开合、不清 tab（页面自己管 tab 切换）；`setAccountConsumeOpen(false)` 之后
//      再打开仍能落在上一次指定的 tab 上，不会「偷偷跳回卡密」；
//   5. 旧出口（`oursOpen` / `openOursServices`）必须真的不存在 —— 删除要可断言，不是「大概删了」。
//
// 为什么不测组件：`AccountConsumePage` 的四个面板由 `consume-panels-*` 覆盖，页面外壳只做
// 「选 tab + 递 props」；这里测的是**所有入口共用的那一份状态契约**，比逐个渲染组件更抗漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 构建期注入值（`__ENDPOINTS__` / `__API_ORIGIN__`）与 `.js → .ts` 解析钩子：共享装配，
// 不各抄一份（#407 / #362 §2 D7）。`settingsDialogState` 会连带加载 `apiConfig`，
// 那个模块顶层就读 `__API_ORIGIN__`，所以两个全局都要在。
import { installResolveHooks } from '../helpers/contract.mjs'
import { installEndpointsGlobals } from '../helpers/dom-env.mjs'

installEndpointsGlobals()
installResolveHooks()

const state = await import('../../src/components/settings/settingsDialogState.ts')

const reset = () => {
  state.useSettingsDialog.setState({
    open: false,
    section: 'general',
    accountConsumeOpen: false,
    accountConsumeTab: 'cards',
    apiKeyFormatBlocked: false,
  })
}

test('openAccountConsume() 缺省落「我的卡密」（付款回跳：让用户看到卡密）', () => {
  reset()
  state.openAccountConsume()
  const now = state.useSettingsDialog.getState()
  assert.equal(now.open, true, '要打开设置（入口挂在设置里）')
  assert.equal(now.section, 'data', '面包屑：设置 → 数据管理 → 账户与消费')
  assert.equal(now.accountConsumeOpen, true, '页面要打开')
  assert.equal(now.accountConsumeTab, 'cards', '缺省 tab 必须是我的卡密')
})

test('消息流两个 CTA 的 tab：额度不足 → quota，Key 失效 → account', () => {
  reset()
  state.openAccountConsume('quota')
  assert.equal(state.useSettingsDialog.getState().accountConsumeTab, 'quota', '额度不足要落在「我的额度」')
  reset()
  state.openAccountConsume('account')
  assert.equal(state.useSettingsDialog.getState().accountConsumeTab, 'account', 'Key 失效要落在「账号」')
  reset()
  state.openAccountConsume('buy')
  assert.equal(state.useSettingsDialog.getState().accountConsumeTab, 'buy', '购买 tab 也能直接指过去')
})

test('关掉只改开合，不清 tab；再次打开还落在同一个 tab', () => {
  reset()
  state.openAccountConsume('account')
  state.setAccountConsumeOpen(false)
  const closed = state.useSettingsDialog.getState()
  assert.equal(closed.accountConsumeOpen, false, '关掉后不再渲染页面')
  assert.equal(closed.accountConsumeTab, 'account', '关掉不该把 tab 悄悄重置')
  state.setAccountConsumeOpen(true)
  assert.equal(state.useSettingsDialog.getState().accountConsumeTab, 'account', '再打开仍在上一次那个 tab')
})

test('旧出口已删除：oursOpen / openOursServices / setOursServicesOpen 一个都不剩', () => {
  for (const name of ['openOursServices', 'setOursServicesOpen']) {
    assert.equal(name in state, false, `settingsDialogState 不该再导出 ${name}`)
  }
  assert.equal('oursOpen' in state.useSettingsDialog.getState(), false, '旧 oursOpen 字段已随弹层删除')
  assert.equal(
    'oursReplacedUnpaid' in state.useSettingsDialog.getState(),
    false,
    '旧 oursReplacedUnpaid 字段（只被旧弹层读过）也已删除'
  )
})

test('closeSettings 只关设置；「账户与消费」的归位在设置内容卸载时（SettingsContent 的 cleanup）', () => {
  reset()
  state.openAccountConsume('quota')
  state.closeSettings()
  const now = state.useSettingsDialog.getState()
  assert.equal(now.open, false, '设置关掉')
  // 这里**故意**不断言 accountConsumeOpen 被清掉：`closeSettings` 只管导航层，
  // 页面开合的归位挂在 `SettingsContent` 卸载时的 cleanup（见 SettingsDialog 里那条 useEffect）。
  // 断言行为见下一行：清掉之后确实不再渲染，且 tab 不被顺手重置。
  state.setAccountConsumeOpen(false)
  const closed = state.useSettingsDialog.getState()
  assert.equal(closed.accountConsumeOpen, false, '卸载归位后不会再渲染')
  assert.equal(closed.accountConsumeTab, 'quota', '归位只改开合，不重置 tab')
})
