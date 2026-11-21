// [layer: unit | 依赖: 无（纯 Node，不发网络请求） | 耗时: <1s]
//
// Issue #727 阶段 1（P0 最小可发布集）：「账户与消费」整页上**三个纯投影**的分支。
//
// 为什么只测这三个函数：这一页的其余部分是外壳（选哪块、挂哪个既有面板），
// 真正会算错的只有三件事 ——
//
//   [1] 连通性三态：复用 `probeProvider` 的既有结果，只做归档。必须证明
//       401/403 → Key 无效（换 Key），其它失败（超时 / 断网 / 非 JSON）→ 网络或配置错，
//       而且「测试中」「没测过」不会被误报成成功或失败。
//   [2] 钱包大数字取哪个字段：照抄 `quotaSummary.showRemaining` 的口径（钱包模式取 balance，
//       限额模式取 remaining），并证明 `spent` 走的是 `actual_cost`（`quota.used` 恒 0 的那个坑）。
//   [3] 模型来源选项 = 既有 `PROVIDER_SPECS` 原样（**不许**出现第二套渠道枚举 / 第二套渠道名）。
//
// 断言对象都是 `src/` 里的真代码（`consumeHomeModel.ts` / `quotaPanelModel.ts`），
// 不是测试自己复刻的一份分支。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import test from 'node:test'

import { installTsResolve } from '../helpers/dom-env.mjs'

// `.js → .ts` 解析 hook 必须在 `import` 被测源码**之前**装好（静态 import 会被提升），
// 所以下面一律用 `await import(...)` —— 与 `helpers/auth-panels-env.mjs` 同一条约定。
installTsResolve()

const { connectivityLabelOf, connectivityOf, modelSourceLabel, modelSourceOptions, walletRemainingOf } =
  await import('../../src/components/consume/consumeHomeModel.ts')
const { quotaSummaryOf } = await import('../../src/components/consume/quotaPanelModel.ts')
const { PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')

test('[1] 连通性三态：401 / 403 归「Key 无效」，其余失败归「网络或配置错」', () => {
  // 过程态：还没测 / 正在测，都不许被误报成通或失败
  assert.equal(connectivityOf(null, false), 'idle', '没测过就是 idle')
  assert.equal(connectivityOf(null, true), 'testing', '正在测就是 testing')
  // 通：HTTP 2xx 且拿到了模型列表（或空列表）
  assert.equal(connectivityOf({ ok: true, status: 200, models: ['deepseek-chat'] }, false), 'ok')
  assert.equal(connectivityOf({ ok: true, status: 200, models: [] }, false), 'ok', '接口通但没给列表也算通')
  // Key 无效：401 / 403（换 Key 才是下一步）
  assert.equal(connectivityOf({ ok: false, status: 401, models: [], reason: 'http' }, false), 'keyInvalid')
  assert.equal(connectivityOf({ ok: false, status: 403, models: [], reason: 'http' }, false), 'keyInvalid')
  // 其余失败：地址错 / 超时 / 断网 / 返回网页 / 非 JSON / 5xx —— 都是「网络或配置错」
  for (const probe of [
    { ok: false, models: [], reason: 'invalid' },
    { ok: false, models: [], reason: 'timeout' },
    { ok: false, models: [], reason: 'network' },
    { ok: false, status: 200, models: [], reason: 'html' },
    { ok: false, status: 200, models: [], reason: 'json' },
    { ok: false, status: 500, models: [], reason: 'http' },
  ]) {
    assert.equal(connectivityOf(probe, false), 'error', `reason=${String(probe.reason)} 应归「网络或配置错」`)
  }
})

test('[1b] 三态文案：正常带毫秒数、测试中复用设置页那一句、失败两种各一句', () => {
  assert.deepEqual(connectivityLabelOf('ok', 42), { key: 'accountConsumeConnOk', params: { ms: 42 } })
  assert.equal(connectivityLabelOf('testing').key, 'settingsTesting')
  assert.equal(connectivityLabelOf('keyInvalid').key, 'accountConsumeConnKeyInvalid')
  assert.equal(connectivityLabelOf('error').key, 'accountConsumeConnError')
  assert.equal(connectivityLabelOf('idle').key, 'accountConsumeConnIdle')
})

test('[2] 钱包大数字：钱包模式取 balance，限额模式取 remaining（口径与 quotaSummaryOf 一致）', () => {
  // 钱包模式（unrestricted）：服务端已扣过消费，remaining 就是余额 → 显示 balance
  const wallet = quotaSummaryOf({
    mode: 'unrestricted',
    isValid: true,
    balance: 128.5,
    remaining: 128.5,
    unit: 'CNY',
    spent: 12.34,
    usageTotal: { actualCost: 12.34 },
  })
  assert.equal(wallet.showRemaining, false, '钱包模式下不额外显示「剩余」')
  assert.equal(walletRemainingOf(wallet), 128.5)
  // **已用只认 actual_cost**：`quota.used` 恒 0，取它会把「花了 12.34」显示成 0
  assert.equal(wallet.spent, 12.34)

  // 限额模式（quota_limited）：这一档才有「剩余」这一行
  const limited = quotaSummaryOf({
    mode: 'quota_limited',
    isValid: true,
    quota: { limit: 100, remaining: 87.66 },
    remaining: 87.66,
    unit: 'CNY',
    spent: 12.34,
  })
  assert.equal(limited.showRemaining, true)
  assert.equal(walletRemainingOf(limited), 87.66)

  // 读不到额度（未登录 / 没有 Key）：不编一个 0，界面显示「—」
  assert.equal(walletRemainingOf(null), undefined)
  assert.equal(walletRemainingOf(undefined), undefined)
})

test('[3] 模型来源 = 既有 ProviderKind 换皮：选项与标签都来自 PROVIDER_SPECS', () => {
  const options = modelSourceOptions()
  assert.equal(options.length, PROVIDER_SPECS.length, '选项数必须等于既有 spec 数（没有第二条渠道表）')
  assert.deepEqual(
    options.map((option) => option.kind),
    PROVIDER_SPECS.map((spec) => spec.kind),
    '顺序与设置页下拉一致'
  )
  for (const spec of PROVIDER_SPECS) {
    assert.equal(modelSourceLabel(spec.kind, 'zh'), spec.label.zh)
    assert.equal(modelSourceLabel(spec.kind, 'en'), spec.label.en)
    assert.notEqual(spec.label.zh, '', '每个渠道都有中文名')
    assert.notEqual(spec.label.en, '', '每个渠道都有英文名')
  }
  // 四个既有渠道一个不少（deepseek / anthropic / openai / ours）
  assert.deepEqual(
    options.map((option) => option.kind).sort(),
    ['anthropic', 'deepseek', 'openai', 'ours']
  )
})
