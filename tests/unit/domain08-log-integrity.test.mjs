// [layer: unit | 纯 Node，零浏览器，不发网络请求 | 耗时: <1s]
//
// N4 日志自检表（域 8 · F8-06）—— #362 / #367
//
// 「检查日志完整性」给出的四个数字（条数 / 跨度 / 覆盖类型数 / 缺失项）与三条提示
// （`few_logs` / `no_network` / `short_span`）只在 L1（真产物 + 真实 DOM）里被断言过：
// 阈值本体（<10 条、<1s、有没有网络记录）没有任何纯函数级用例，改坏了只有集成层才看得出。
//
// 本用例把同一张表（`tests/fixtures/domain08-09/log-integrity-cases.mjs`）喂给两个入口：
//   ① `inspectLogCoverage()`：只读当前缓冲区，不改任何东西（按钮点开时的自检）
//   ② `validatePayload()`：提交前自检，缺 `state_snapshot` 时**自动补一条**，只提示不阻断
//
//   node --test tests/unit/domain08-log-integrity.test.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

const collectorStub = new URL('../fixtures/domain08-09/collector-stub.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (
      /(?:^|\/)collector\.js$/.test(specifier) &&
      context.parentURL?.includes('/src/services/diagnostics/')
    ) {
      return { url: collectorStub, shortCircuit: true }
    }
    // 上传通道（legacy / http）依赖 Capacitor 原生桥：这里不需要它，给个空实现
    if (specifier === '@capacitor/core') {
      return {
        url: 'data:text/javascript,export const Capacitor = {}; export const CapacitorHttp = {};',
        shortCircuit: true,
      }
    }
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl: 'https://invite.test.invalid',
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([]),
})
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false
globalThis.__log ??= { records: [], events: [], actions: [] }
globalThis.__actions ??= [
  { t: 1, kind: 'nav', action: 'open-settings', fields: {} },
  { t: 2, kind: 'nav', action: 'feedback-integrity', fields: {} },
]

const diagnostics = await import('../../src/services/diagnostics/index.ts')
const { COVERAGE_CASES, EXPECTED_KINDS, VALIDATE_CASES } = await import(
  '../fixtures/domain08-09/log-integrity-cases.mjs'
)

const withSnapshot = (logs) => {
  globalThis.__snapshot = {
    schemaVersion: 1,
    app: { version: '1.4.0-beta.10', versionCode: 17, platform: 'android', buildType: 'standard' },
    device: {},
    client: { clientId: 'stub-client', sessionId: 'stub-session' },
    logs,
  }
}

const payloadWith = (logs) => ({
  schemaVersion: 1,
  app: { version: '1.4.0-beta.10', versionCode: 17, platform: 'android', buildType: 'standard' },
  device: {},
  client: { clientId: 'stub-client', sessionId: 'stub-session' },
  feedback: { description: '日志自检', category: 'bug', contact: '' },
  logs,
})

test('N4-a 自检表：缓冲区形态 → 四个数字 + 三条提示 + 缺失类型', () => {
  const failures = []
  for (const row of COVERAGE_CASES) {
    withSnapshot(row.logs)
    const coverage = diagnostics.inspectLogCoverage()
    const record = (message) => failures.push(`${row.id} ${row.label}：${message}`)
    if (coverage.count !== row.expect.count) record(`条数 ${coverage.count} ≠ ${row.expect.count}`)
    if (coverage.spanMs !== row.expect.spanMs) record(`跨度 ${coverage.spanMs} ≠ ${row.expect.spanMs}`)
    if (JSON.stringify(coverage.warnings) !== JSON.stringify(row.expect.warnings)) {
      record(`提示 ${JSON.stringify(coverage.warnings)} ≠ ${JSON.stringify(row.expect.warnings)}`)
    }
    if (JSON.stringify(coverage.missing) !== JSON.stringify(row.expect.missing)) {
      record(`缺失类型 ${JSON.stringify(coverage.missing)} ≠ ${JSON.stringify(row.expect.missing)}`)
    }
    // 覆盖类型 = 缓冲区里真出现过的类型（去重）
    const kinds = [...new Set(row.logs.map((entry) => entry.kind))]
    if (JSON.stringify(coverage.kinds) !== JSON.stringify(kinds)) {
      record(`覆盖类型 ${JSON.stringify(coverage.kinds)} ≠ ${JSON.stringify(kinds)}`)
    }
    // 自检是只读的：不许动缓冲区
    if (globalThis.__snapshot.logs.length !== row.logs.length) record('自检改了缓冲区')
    // 最近动作链随自检一起返回（界面「最近动作」区块的数据源）
    if (coverage.actions.length !== globalThis.__actions.length) record('没带上最近动作链')
  }
  console.log(`  ·  自检表：${COVERAGE_CASES.length} 种缓冲区形态 ×（条数 / 跨度 / 提示 / 缺失 / 只读）`)
  assert.deepEqual(failures, [])
})

test('N4-b 期望类型集合与源码同源（表被剪了要在这里同步）', () => {
  // EXPECTED_KINDS 决定「缺失项」这一列；把它写死在用例里等于让测试自己发明契约，
  // 所以这里反向核对：表里的集合必须是这五个，任何增减都要改这张表。
  assert.deepEqual(EXPECTED_KINDS, ['app_launch', 'state_snapshot', 'nav', 'net_request', 'net_response'])
  // 全覆盖那一行的 missing 必须为空（证明五条都能被认出来）
  const full = COVERAGE_CASES.find((row) => row.expect.missing.length === 0 && row.expect.count >= 10)
  assert.ok(full, '表里应有一行「五个类型齐全」的基线')
  withSnapshot(full.logs)
  assert.deepEqual(diagnostics.inspectLogCoverage().missing, [])
})

test('N4-c validatePayload：缺 state_snapshot 时自动补一条，只提示不阻断', async () => {
  const failures = []
  for (const row of VALIDATE_CASES) {
    const payload = payloadWith(row.logs)
    const before = [...row.logs]
    const { warnings } = await diagnostics.validatePayload(payload)
    const record = (message) => failures.push(`${row.id} ${row.label}：${message}`)
    const appended = payload.logs.length === row.logs.length + 1
    if (appended !== row.expect.appended) {
      record(`补快照行为 ${appended} ≠ ${row.expect.appended}（${row.logs.length} → ${payload.logs.length}）`)
    }
    if (row.expect.appended) {
      const last = payload.logs.at(-1)
      if (last.kind !== 'state_snapshot') record(`补进来的不是 state_snapshot，而是 ${last.kind}`)
    }
    // 原有日志必须原样保留（顺序与内容都不许动）
    const kept = payload.logs.slice(0, before.length)
    if (JSON.stringify(kept) !== JSON.stringify(before)) record('原有日志被改动')
    if (JSON.stringify(warnings) !== JSON.stringify(row.expect.warnings)) {
      record(`提示 ${JSON.stringify(warnings)} ≠ ${JSON.stringify(row.expect.warnings)}`)
    }
  }
  console.log(`  ·  提交前自检：${VALIDATE_CASES.length} 行（补快照 / 不补 / 不阻断）`)
  assert.deepEqual(failures, [])
})
