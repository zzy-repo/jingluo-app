// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage，零浏览器、零真实网络） | 耗时: <1s]
//
// Issue #800：设置 → 账户与消费 → 模型来源 → **选中「内置服务」时不渲染 Key 相关控件**。
//
// 现状（改之前）：点「内置服务」进来，下面还摆着 API Key 的掩码展示区 +「重新领取」——
// 内置服务的 Key 由服务端下发（#596），本机既不能填也不能换，那一行只会让人以为这里有东西可操作。
//
// 四条验收（与 issue 一一对应）：
//   [1] 内置服务（kind=ours）→ 行清单里**没有 apiKey**：输入框 / 掩码展示区 /「重新领取」都不渲染
//       （不是 CSS 隐藏、不是 disabled —— 结构上就没有那一段 DOM）；
//   [2] 第三方服务（openai / anthropic）与官方渠道（deepseek）→ Key 行照旧渲染（#608 的反向对照）；
//   [3] 在来源之间来回切**不丢数据**：第三方填过的 baseUrl / model 切走再切回必须还在
//       （存储本来就是按渠道分开的，`chat-demo:base-url:<kind>` / `chat-demo:model:<kind>`）；
//   [4] 「重新领取」删掉之后**仍然有恢复入口**：它不是纯展示件（`claimManagedKeyForDevice({rotate:true})`
//       = 真的换一把 Key + 清掉发送前的拦截提示），所以恢复改成后台自动对齐
//       （启动 / 登录后 / 发送被拦且打开设置时各一次幂等对齐），这里把这条接线钉住。
//
// 为什么用「行清单 + 源码断言」而不是渲染真实 DOM：`.tsx` 在裸 Node 里 import 不了
// （JSX 不在类型擦除范围内，见 `managedKeyView.ts` 的文件头）。所以判定被抽成纯函数
// `sourceFieldPlan.sourceFieldRows()` —— 界面渲染与断言**共用同一份**，不是一份平行真理。
//
//   node --test tests/unit/source-panel-800.test.mjs
//   node tests/run-layer.mjs unit --only source-panel-800
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'

// 原生桥 + 诊断写入口替身：apiConfig / managedKeyRuntime 会调 recordAction
installChatBridge()
// 构建期注入值（`__ENDPOINTS__` / `__API_ORIGIN__`）：apiConfig 顶层就要读
installEndpointsGlobals()
const dom = setupDom()

const plan = await import('../../src/components/settings/sourceFieldPlan.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

test.after(() => dom.restore())

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/** 去掉注释再扫代码：这几处的注释里**故意**写着「不许渲染」之类的说明，直接匹配会假红 */
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** 每个用例从干净的本地配置开始（同一进程里多行表格之间不许串味） */
const reset = () => {
  dom.localStorage.clear()
}

/** 让「来源」切换走到用户真正会走的那个入口（`AccountConsumePage.chooseSource` 用的就是它） */
const enterThirdParty = () => apiConfig.setProviderKind(apiConfig.thirdPartyEntryKind())

// ------------------------------------------------------- [1] 内置服务：Key 控件整段不渲染

test('[1] 内置服务（ours）的行清单里没有 Key：输入框 / 掩码展示区 /「重新领取」都不会进 DOM', () => {
  assert.deepEqual(
    plan.sourceFieldRows('ours'),
    [],
    '内置服务既不该有 Key 行（apiKey），也不该有地址/模型行（锁定在 spec.defaults）'
  )
  assert.equal(
    plan.rendersKeyControls('ours'),
    false,
    '这一页不许出现任何 Key 相关控件（#800 第 1 条）'
  )
})

test('[1] 界面按这张表渲染：ApiConfigFields 不再渲染 ManagedKeyField，只渲染可编辑的 Key 行', () => {
  const fields = codeOf('src/components/settings/ApiConfigFields.tsx')
  assert.match(
    fields,
    /sourceFieldRows\(kind\)\.map\(/u,
    '行清单必须来自 sourceFieldPlan（界面与单测共用同一份判定）'
  )
  assert.equal(
    /ManagedKeyField/u.test(fields),
    false,
    '#800：内置服务那一块（只读 Key 行 +「重新领取」）不许再被设置页渲染'
  )
  assert.match(fields, /<ApiKeyField editor=\{editor\} \/>/u, '可编辑的 Key 行照旧渲染')
  assert.match(fields, /type="password"/u, '第三方 / 官方的密码输入框不许被一起删掉')
  assert.equal(
    /settings-managed-key/u.test(fields),
    false,
    'no Key 展示区：`settings-managed-key*` 这些 testid 不该出现在字段区'
  )
})

test('[1] 面板里没有「重新领取」的接线，恢复改走后台自动对齐', () => {
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.equal(
    /ManagedKeyField|claimManagedKeyForDevice/u.test(page),
    false,
    '面板不许再挂领取按钮（「重新领取」= `claimManagedKeyForDevice({rotate:true})`）'
  )
  assert.match(
    page,
    /syncManagedKeyFromServer/u,
    '必须有后台对齐：发送被拦（`managedKeyBlocked`）时自动跟服务端核对一次'
  )
  assert.match(
    page,
    /clearManagedKeyBlocked/u,
    '对齐成功要把那条「请先领取 Key」的提示清掉，否则用户永远看到一句已经解决的话'
  )
  const app = codeOf('src/app/App.tsx')
  assert.match(
    app,
    /\}, \[oursChannel, signedIn\]\)/u,
    '启动对齐还必须跟着登录态重跑（#800：按钮没了，登录后那一次对齐是唯一入口）'
  )
})

// --------------------------------------------------- [2] 第三方 / 官方仍然渲染 Key（对照）

test('[2] 第三方服务仍是「服务地址 + Key + 模型」三行，官方渠道仍是 Key 一行', () => {
  for (const kind of ['openai', 'anthropic']) {
    assert.deepEqual(
      plan.sourceFieldRows(kind),
      ['baseUrl', 'apiKey', 'model'],
      `${kind}：第三方服务的三件套一行都不许少（#608 / #727 的行 IA 不变）`
    )
    assert.equal(plan.rendersKeyControls(kind), true, `${kind} 必须保留 Key 行`)
  }
  assert.deepEqual(
    plan.sourceFieldRows('deepseek'),
    ['apiKey'],
    '官方渠道只有 Key 一行（地址 / 模型内置，由 spec.defaults 决定）'
  )
  assert.equal(plan.rendersKeyControls('deepseek'), true, '官方渠道必须保留 Key 行')
})

// ------------------------------------------------------- [3] 来源之间来回切不丢数据

test('[3] 第三方填过的 baseUrl / model：切到官方再切回第三方仍然在', () => {
  reset()
  // 用户在第三方服务里填了三件套（Key 是四个渠道共用一把，本轮不动它的存储）
  apiConfig.setProviderKind('openai')
  assert.equal(apiConfig.setBaseUrl('https://proxy.example.com/v1'), true)
  assert.equal(apiConfig.setModel('gpt-4o'), true)
  assert.equal(apiConfig.getBaseUrl(), 'https://proxy.example.com/v1')

  // 切到 DeepSeek 官方服务：这一行有自己的内置地址/模型，第三方那份不该被串过来
  apiConfig.setProviderKind('deepseek')
  assert.equal(apiConfig.getBaseUrl(), 'https://api.deepseek.com', '官方渠道用内置地址')
  assert.equal(apiConfig.getModel(), 'deepseek-flash', '官方渠道用内置模型')

  // 切回第三方服务：用户填过的值必须原样回来
  enterThirdParty()
  assert.equal(apiConfig.getProviderKind(), 'openai', '第三方槽位记住了刚才用的那一种协议')
  assert.equal(apiConfig.getBaseUrl(), 'https://proxy.example.com/v1', '切回来地址还在')
  assert.equal(apiConfig.getModel(), 'gpt-4o', '切回来模型还在')

  // 再来一轮，换成另一条协议槽：值同样跟着走（#794 之后这两种协议是一个槽位）
  apiConfig.setProviderKind('anthropic')
  assert.equal(apiConfig.setBaseUrl('https://claude-proxy.example.com'), true)
  assert.equal(apiConfig.setModel('claude-sonnet-4'), true)
  apiConfig.setProviderKind('ours')
  enterThirdParty()
  assert.equal(apiConfig.getProviderKind(), 'anthropic', '有数据的那个第三方槽位优先')
  assert.equal(apiConfig.getBaseUrl(), 'https://claude-proxy.example.com')
  assert.equal(apiConfig.getModel(), 'claude-sonnet-4')
})

// ------------------------------------------------ [4] 「重新领取」删了，恢复入口仍在

test('[4] 内置服务不再有「重新领取」：401 / 未领取的出路是后台自动对齐（不是死路）', () => {
  // 1) 401 文案不许再指路到一个已经被删掉的按钮
  assert.equal(
    /重新领取/u.test(zh.apiKeyRejectedOurs),
    false,
    `ours 的 401 文案还在指「重新领取」，但那个按钮已经不渲染了：${zh.apiKeyRejectedOurs}`
  )
  assert.match(zh.apiKeyRejectedOurs, /自动/u, '必须说清恢复是自动的（否则用户没有下一步可做）')
  assert.match(en.apiKeyRejectedOurs, /automatic/iu, 'en 同步改成自动恢复的口径')

  // 2) 这一页要自己说明「Key 从哪来」—— 否则用户只会觉得那一行不见了
  for (const key of ['settingsBuiltinKeyAuto', 'settingsBuiltinKeySyncing', 'settingsBuiltinKeySynced']) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}（zh/en 必须成对）`)
  }
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.match(page, /settingsBuiltinKeyAuto/u, '内置服务子页要渲染「Key 由服务端下发」这一句')
  assert.match(page, /account-consume-builtin-key-note/u, '这句要可被断言（testid 钉住）')

  // 3) 自动对齐是幂等的「按设备固定名领取」：不 rotate，不会把用户手上那把作废
  const runtime = codeOf('src/components/settings/managedKeyRuntime.ts')
  assert.match(runtime, /syncManagedKey\(/u, '后台对齐走幂等领取（`syncManagedKey`）')
  assert.equal(/rotate: true/u.test(runtime), false, '后台对齐不许 rotate（那会把用户手上那把作废）')
  // #803 起「对齐」与「确保有一把」是同一个实现（`syncManagedKey` → `ensureManagedKey`：
  // 查重 → 建 → 失败重试一次）。判据从「必须是 rotate=false 的领取」改成下面两条**更强**的：
  // 对齐这一段根本不该出现 rotate（对齐≠换一把），且名字与实现之间只隔一层转发。
  const managedSource = codeOf('src/services/api/managedKey.ts')
  assert.match(
    managedSource,
    /export const syncManagedKey = [\s\S]*?ensureManagedKey\(source, options\)/u,
    '`syncManagedKey` 只是 `ensureManagedKey` 的幂等别名（不允许再长出一条领取链路）'
  )
  const alignBody = managedSource.slice(managedSource.indexOf('export const ensureManagedKey ='))
  assert.equal(/rotate/u.test(alignBody), false, '对齐那一段里不许出现 rotate（对齐≠换一把）')
  assert.match(
    runtime,
    /getServerKeyMark\(\) === null/u,
    '「Key 对得上但没有下发标记」也必须算一次对齐，否则发送前永远判 unclaimed（#800 之后没有按钮可点）'
  )
})
