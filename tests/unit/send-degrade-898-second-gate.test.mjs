// [layer: unit | 纯 Node，只读源码文本（不跑浏览器、不连网） | 耗时: <1s]
//
// #898 第二步（母单 #894）的两条**接线不变量** —— 「控制面抖一下 ≠ 发不出消息」。
//
// 为什么是源码断言而不是行为断言：
//   · 这两条判据落在**冷启动时序**上（`restoreAuth()` 在 App 挂载前跑完，`purgeSessionCaches()`
//     在那一支里同步执行），L0 里没有 localStorage / 真实启动顺序可依赖；
//   · 而它们的失效方式是「某次重构顺手把那个参数/那半条件删掉」，没有编译错误、没有别的用例变红。
//     这种回归**只能在文本层面钉住**（同 `tests/unit/account-optional-608.test.mjs` 的先例）。
//   · 真行为的证据不在这里，在 `scripts/shot-send-degrade-898.mjs` 的 390/360 真图（改前红 / 改后绿）。
//
// 三条断言对应三个各自会独立退化的点：
//   T1 冷启动「盘上没有会话」**不许**清账号级缓存（否则 `ours` 用户的本地 Key 每次开机被删）
//   T2 真的退出登录 / 续期失败**必须**清（A 退出、B 登录不许带着 A 的 Key —— #596 第 3 条事故）
//   T3 发送前「有身份」的口径 = **本地有一把 Key**，且 Key 的判定仍然只有 `checkApiKeyBeforeSend()` 一份

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

const authStore = read('src/services/auth/store.ts')
const dialogState = read('src/components/settings/settingsDialogState.ts')

test('T1 冷启动「盘上没有会话」不清账号级缓存（否则 ours 用户的本地 Key 被删）', () => {
  // 事故形状（2026-11-26 实测）：`ours + 未登录` 打开页面，domcontentloaded 时
  // `localStorage['chat-demo:api-key']` 已经是 null，而 `chat-demo:provider-kind` 还在 ——
  // 这不是用户删的，是 `restoreAuth()` 的 `!persisted` 分支经 `clearSession` → `purgeSessionCaches()`
  // → `ours-managed-key.purge()` 抹掉的。抹掉之后再谈「有 Key 就试发」已经没有意义。
  assert.match(
    authStore,
    /if \(!persisted\) \{[\s\S]{0,800}?clearSession\('unauthenticated', null, \{ purgeAccountCaches: false \}\)/,
    'restoreAuth 的「盘上没有会话」分支必须传 { purgeAccountCaches: false }：' +
      '那一支不是退出，是「这台机器还没有过账号」，没有跨账号残留可清，而它会顺手删掉 ours 的本地 Key（#898 第二步）',
  )
})

test('T2 真的退出 / 续期失败仍然清账号级缓存（切号不许带着上一个账号的 Key）', () => {
  // #596 第 3 条事故：A 退出、B 登录后还用 A 的 Key 发消息 → 扣费扣到 A 头上、失败只看到 401。
  // 所以「退出」这条路径上的清除**一个参数都不许加**。
  assert.match(
    authStore,
    /const signOut = async \(\): Promise<void> => \{[\s\S]*?clearSession\('unauthenticated'\)/,
    'signOut 必须仍然调用不带第三参的 clearSession（默认清账号级缓存）—— 去掉它，切号就会带着上一个账号的 Key',
  )
  assert.match(
    authStore,
    /if \(options\.purgeAccountCaches !== false\) \{\s*purgeSessionCaches\(\)/,
    'clearSession 里清缓存的守卫必须是「显式传 false 才跳过」（默认清）：写成默认不清，切号残留就再没人清',
  )
  // 续期失败那条（`clearSession('expired')`）不许被顺手改成跳过清除
  assert.match(
    authStore,
    /clearSession\('expired'/,
    '续期失败仍然要清态 —— 那是「凭据不认」，与「从来没有会话」不是一回事',
  )
})

test('T3 「有身份」= 本地有一把 Key，且 Key 的判定仍然只有一份来源', () => {
  assert.match(
    dialogState,
    /hasUsableKey: checkApiKeyBeforeSend\(\) === 'ok' \|\| getApiKey\(\)\.trim\(\) !== '',/,
    'ensureSendPrerequisites 的入参必须把「本地有一把 Key」算作有身份：' +
      '只认 `=== ok` 时，`ensureApiKey` 已经放行的 claim/stale 会被这道闸门二次拦住，' +
      '用户看到的是「I don\'t know you yet — Choose provider」（#898 实测的那条提示）',
  )
  // 不许在这里另写一套「Key 格式好不好」：那会让发送时的判定与失败文案各说各话（#374/#451 的口径）
  assert.doesNotMatch(
    dialogState,
    /ensureSendPrerequisites[\s\S]{0,400}?isKeyFormatInvalid/,
    'ensureSendPrerequisites 不许自己判 Key 格式 —— 格式只有 ensureApiKey（checkApiKeyBeforeSend）一份口径',
  )
})
