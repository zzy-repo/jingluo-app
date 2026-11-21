// [layer: unit | 依赖: 无（纯 Node，读源码） | 耗时: <1s]
//
// #817 —— 「我的钱包」页三处调整的静态契约：
//   1. 余额卡右侧有付款入口，复用同一条付款链路（`usePayCheckout`），不另写付款逻辑；
//   2. 「我的额度」入口与 `quota` 子页一并删除，额度不足的 CTA 改指钱包页（不留死链接）；
//   3. 付款回来仍只走 `backToCards`，#784 自动兑现不新增第二个触发点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const page = read('src/components/consume/AccountConsumePage.tsx')
const buyTab = read('src/components/consume/BuyTab.tsx')
const hook = read('src/components/consume/usePayCheckout.ts')
const message = read('src/components/messages/AssistantMessage.tsx')
const state = read('src/components/settings/settingsDialogState.ts')
const css = read('src/components/consume/AccountConsume.module.css')
const zh = read('src/i18n/zh.ts')
const en = read('src/i18n/en.ts')

test('钱包页：余额卡右侧有付款入口，且与「购买」页共用同一个付款 hook', () => {
  assert.ok(page.includes('data-testid="account-consume-balance"'), '余额卡还在')
  assert.ok(page.includes('testId="account-consume-wallet-pay"'), '付款入口有稳定 testid')
  assert.ok(page.includes("t('accountConsumeWalletTopUp')"), '钱包页按钮文案是「充值」（独立词条，不动「购买」页共用的 oursBuyAction）')
  assert.ok(/accountConsumeWalletTopUp: '充值'/u.test(zh) && /accountConsumeWalletTopUp: 'Top up'/u.test(en), 'zh / en 成对')
  assert.ok(page.includes('usePayCheckout(backToCards)'), '钱包页的付款入口走 usePayCheckout，且回调就是 backToCards')
  assert.ok(buyTab.includes('usePayCheckout(onPurchased)'), '「购买」页走同一个 hook（不是两份实现）')
  assert.ok(hook.includes('fetchPayLink(') && hook.includes('openPayLinkInApp('), '链路只在 hook 里写一份')
  for (const [name, source] of [['页面', page], ['BuyTab', buyTab]]) {
    // 看 import 而不是子串：注释里仍会提到 openPayLinkInApp 这个名字（解释 onClosed 的来历），那不是调用
    assert.ok(!/import[^\n]*\b(openPayLinkInApp|fetchPayLink)\b/u.test(source), `${name}不再 import openPayLinkInApp / fetchPayLink（只在 hook 里）`)
  }
})

test('钱包页：付款失败（Web / 无插件）给可读提示，沿用 oursPayOpenFailed', () => {
  assert.ok(page.includes('account-consume-wallet-pay-status'), '钱包页有付款失败的可读状态行')
  assert.ok(hook.includes("'oursPayOpenFailed'"), 'hook 里 openPayLinkInApp 返回 false → oursPayOpenFailed')
  assert.ok(!/window\.open\(|window\.location/u.test(hook + page), '不 window.open、不整页跳转')
})

test('布局：余额卡是同一行的 flex，余额栏可收缩、按钮不收缩（360 / 390 不挤断数字）', () => {
  const block = css.slice(css.indexOf('.balance {'), css.indexOf('.balanceKey'))
  assert.ok(/display:\s*flex/u.test(block), '余额卡 display:flex（同一行）')
  assert.ok(/\.balanceMain\s*\{[^}]*min-width:\s*0/u.test(css), '余额栏 min-width:0，放不下时它让位')
  assert.ok(/\.balancePay\s*\{[^}]*flex:\s*none/u.test(css), '付款按钮 flex:none，不被挤成一条缝')
})

test('「我的额度」入口与 quota 子页已删除，且没有死链接', () => {
  for (const [name, source] of [['页面', page], ['状态层', state], ['消息流', message]]) {
    assert.ok(!/account-consume-tab-quota/u.test(source), `${name}里没有 account-consume-tab-quota`)
    assert.ok(!/'quota'/u.test(source), `${name}里没有 'quota' 页 / tab 取值`)
  }
  assert.ok(!page.includes('QuotaPanel'), '页面不再挂 QuotaPanel')
  assert.ok(message.includes("openAccountConsume('wallet')"), '额度不足的 CTA 改指钱包页')
  assert.ok(/AccountConsumeTab =[^\n]*'wallet'/u.test(state), 'AccountConsumeTab 含 wallet')
  assert.ok(!zh.includes('accountConsumeTabQuota') && !en.includes('accountConsumeTabQuota'), 'zh / en 孤立词条已删')
})

test('#784：自动兑现仍只有 backToCards 这一个触发点', () => {
  const calls = page.match(/runWalletAutoRedeem\(/g) ?? []
  assert.equal(calls.length, 1, `页面里 runWalletAutoRedeem( 只能出现一次，实际 ${calls.length}`)
  const at = page.indexOf('runWalletAutoRedeem({')
  assert.ok(page.lastIndexOf('const backToCards', at) > -1 && at - page.lastIndexOf('const backToCards', at) < 1500, '这一次调用就在 backToCards 里')
  assert.ok(!hook.includes('runWalletAutoRedeem'), '付款 hook 自己不触发自动兑现，只回调 onPurchased')
})
