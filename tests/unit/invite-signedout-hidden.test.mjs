// [layer: unit | 依赖: 无（纯 Node 读源码，零网络） | 耗时: <1s]
//
// 未登录的账号页（登录页）不渲染「我的邀请」面板，登录后才渲染。
//
// 背景：#819 恢复挂载时，`AccountConsumePage.tsx` 账号分支无条件挂了
// `<div data-testid="account-consume-invite"><InvitePanel/></div>`，未登录的登录卡下面也出现了
// 「我的邀请 / 登录后可查看邀请 / 去登录」。维护者明确要求：登录页不显示「我的邀请」。
//
// 为什么读源码：`.tsx` 在裸 Node 里 import 不了（本仓库 L1 口径）。账号分支是
// `signedIn === true ? 已登录内容 : 登录卡` 的三元结构，所以按「已登录分支 / 未登录分支」切源码再断言。
// 产物级（真浏览器）验证见 PR 描述里的 Playwright 实测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/components/consume/AccountConsumePage.tsx', import.meta.url), 'utf8')

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

const start = source.indexOf("if (page === 'account')")
assert.ok(start > 0, '账号分支必须在')
const branch = stripComments(source.slice(start, source.indexOf('L1：列表页', start)))

const TESTID = 'data-testid="account-consume-invite"'
const GUARD = /\{signedIn === true \? \(\s*<div className=\{styles\.viewBody\} data-testid="account-consume-invite">/u

test('账号分支里 account-consume-invite 只出现一次，且直接位于 signedIn === true 守卫的「已登录」一侧', () => {
  assert.equal(branch.split(TESTID).length - 1, 1, '只有一处挂载')
  assert.match(branch, GUARD, '挂载点必须是 `{signedIn === true ? (<div … account-consume-invite>`')
})

test('未登录分支不渲染 account-consume-invite / InvitePanel：守卫的 else 是 null', () => {
  const guardAt = branch.search(GUARD)
  assert.ok(guardAt >= 0, '先有守卫')
  const afterGuard = branch.slice(guardAt)
  const closeAt = afterGuard.search(/<\/div>\s*\) : null\}/u)
  assert.ok(closeAt > 0, '已登录一侧收尾后紧跟 `) : null}`（未登录什么都不渲染）')
  const signedInSide = afterGuard.slice(0, closeAt)
  assert.ok(signedInSide.includes('<InvitePanel'), '已登录一侧渲染 <InvitePanel>')
  // 守卫之外（整个账号分支去掉守卫块后）不许再有邀请面板
  const outside = branch.slice(0, guardAt) + afterGuard.slice(closeAt)
  assert.ok(!outside.includes('<InvitePanel'), '守卫之外不许有 <InvitePanel>')
  assert.ok(!outside.includes('account-consume-invite'), '守卫之外不许有 account-consume-invite')
})

test('未登录的登录卡分支（account-consume-tab-account）里没有邀请面板', () => {
  const cardAt = branch.indexOf('data-testid="account-consume-tab-account"')
  assert.ok(cardAt > 0, '登录卡分支在')
  const cardEnd = branch.indexOf('<SettingsAuthCard', cardAt)
  const loginSide = branch.slice(cardAt, branch.indexOf('</div>', cardEnd))
  assert.ok(!loginSide.includes('InvitePanel') && !loginSide.includes('account-consume-invite'), '登录卡内没有邀请面板')
})

test('已登录一侧仍把 consume / signedIn / needLogin 递给 InvitePanel（可见性判据不动）', () => {
  assert.match(
    branch,
    /<InvitePanel\b[^>]*\bconsume=\{consume\}[^>]*\bsignedIn=\{signedIn === true\}[^>]*\bonSignIn=\{needLogin\}/su
  )
})
