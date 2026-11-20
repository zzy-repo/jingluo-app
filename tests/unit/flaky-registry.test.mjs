// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Flaky 登记簿的判据（Issue #406 / #456）—— 每条规则各自钉死，防止「重跑通过」变成「红被抹掉」，
// 以及「看不见的 flake」被当成「没有 flake」：
//   [1] 记一次 flaky：累计 + 连续 + firstSeen/lastSeen 语义
//   [2] 连续 3 次 → quarantine（跳过但每周提醒）；一次就绿 → 连续清零 + 自动解除隔离
//   [3] 复发 ≥2 次（修好又坏两次，21 天窗口内）→ 当红处理；从没一次就绿过的不算复发
//   [4] #456 跨 runner：同 commit + 同用例 + 结果不同 + runner 不同 → kind: cross-runner（+ 4 条负向对照）
//   [5] #456 三态：真红 / flaky / runner-dependent 各有唯一判定，runner-dependent 优先级最高
//   [6] #456 静态提示：waitForTimeout / sleep / 依赖动画时长 → 警告（注释与字符串里的不算）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_POLICY,
  KINDS,
  buildRunRecord,
  classifyLoad,
  dayOf,
  describeEntry,
  dueReminders,
  emptyRegistry,
  isQuarantined,
  isRecurringRed,
  normalizeRegistry,
  recordCrossRunner,
  recordFlaky,
  recordPass,
  recordRecurringRed,
  resolveRunnerIdentity,
  scanCrossRunner,
  scanTimingWindows,
  summarizeTriState,
  triStateOf,
} from '../../scripts/flaky-registry.mjs'

const T = 'tests/integration/example.test.mjs'

test('记一次 flaky：累计 / 连续 / 首末时间', () => {
  const registry = emptyRegistry()
  const day1 = '2026-11-01'
  const day2 = '2026-11-02'
  const first = recordFlaky(registry, T, { today: day1 })
  assert.equal(first.count, 1)
  assert.equal(first.streak, 1)
  assert.equal(first.firstSeen, day1)
  assert.equal(first.lastSeen, day1)
  assert.equal(first.quarantinedAt, null)
  const second = recordFlaky(registry, T, { today: day2 })
  assert.equal(second.count, 2)
  assert.equal(second.streak, 2)
  assert.equal(second.firstSeen, day1, 'firstSeen 不许被覆盖')
  assert.equal(second.lastSeen, day2)
})

test('连续 3 次 flaky → quarantine；一次就绿 → 解除隔离且连续清零', () => {
  const registry = emptyRegistry()
  for (const day of ['2026-11-01', '2026-11-02']) recordFlaky(registry, T, { today: day })
  assert.equal(isQuarantined(registry, T), false, '两次还不该进隔离区')
  recordFlaky(registry, T, { today: '2026-11-03' })
  assert.equal(isQuarantined(registry, T), true, '连续 3 次必须进隔离区')
  assert.equal(registry.tests[T].quarantinedAt, '2026-11-03')

  const entry = recordPass(registry, T, { today: '2026-11-04' })
  assert.equal(isQuarantined(registry, T), false, '跑绿要能自动解除隔离（修好即移除）')
  assert.equal(entry.streak, 0)
  assert.ok(entry.lastGreen, '一次就绿要记下 lastGreen，复发窗口从这里起算')
  assert.equal(entry.count, 3, '累计病历保留，别把历史删掉')
})

test('从没一次就绿过的不算「复发」（那条归 quarantine）', () => {
  const registry = emptyRegistry()
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) recordFlaky(registry, T, { today: day })
  assert.equal(isRecurringRed(registry.tests[T], DEFAULT_POLICY, '2026-11-03'), false)
})

test('复发 ≥2 次（21 天窗口内）→ 当红处理', () => {
  // 调用顺序与 run-layer 一致：先判 isRecurringRed（拿「本次之前」的病历），再 recordFlaky。
  const registry = emptyRegistry()
  recordFlaky(registry, T, { today: '2026-11-01', at: '2026-11-01T01:00:00.000Z' })
  recordPass(registry, T, { today: '2026-11-02', at: '2026-11-02T01:00:00.000Z' })
  // 第 1 次复发：窗口内没有先例 → 还不当红
  assert.equal(isRecurringRed(registry.tests[T], DEFAULT_POLICY, '2026-11-03'), false)
  recordFlaky(registry, T, { today: '2026-11-03', at: '2026-11-03T01:00:00.000Z' })
  // 第 2 次复发：修好之后累计 2 次 → 当红
  assert.equal(isRecurringRed(registry.tests[T], DEFAULT_POLICY, '2026-11-04'), true)
  recordFlaky(registry, T, { today: '2026-11-04', at: '2026-11-04T01:00:00.000Z' })
  // 窗口滑过去（21 天后）就重新开始计数
  assert.equal(isRecurringRed(registry.tests[T], DEFAULT_POLICY, '2026-12-30'), false)
})

test('复发当红不把用例塞进隔离区（红不能被藏起来）', () => {
  const registry = emptyRegistry()
  recordFlaky(registry, T, { today: '2026-11-01', at: '2026-11-01T01:00:00.000Z' })
  recordPass(registry, T, { today: '2026-11-02', at: '2026-11-02T01:00:00.000Z' })
  recordFlaky(registry, T, { today: '2026-11-03', at: '2026-11-03T01:00:00.000Z' })
  for (let index = 0; index < 5; index += 1) {
    recordRecurringRed(registry, T, { today: '2026-11-04', at: '2026-11-04T01:00:00.000Z' })
  }
  const entry = registry.tests[T]
  assert.equal(entry.streak, 0)
  assert.equal(entry.quarantinedAt, null)
  assert.equal(entry.lastRedAt, '2026-11-04')
  assert.equal(isQuarantined(registry, T), false)
})

test('quarantine 每周提醒一次，且提醒后不会每轮刷屏', () => {
  const registry = emptyRegistry()
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) recordFlaky(registry, T, { today: day })
  assert.equal(dueReminders(registry, { today: '2026-11-05' }).length, 0, '刚隔离不该立刻提醒')
  assert.equal(dueReminders(registry, { today: '2026-11-10' }).length, 1, '满 7 天提醒一次')
  assert.equal(registry.tests[T].lastRemindedAt, '2026-11-10')
  assert.equal(dueReminders(registry, { today: '2026-11-12' }).length, 0, '提醒过就不再刷')
  assert.equal(dueReminders(registry, { today: '2026-11-18' }).length, 1, '再过 7 天再提醒')
})

test('登记簿坏了不让整层跑不起来：坏条目丢掉、缺字段补默认', () => {
  const normalized = normalizeRegistry({
    policy: { quarantineAfter: 2 },
    tests: {
      [T]: { test: T, count: 4 },
      'tests/integration/broken.test.mjs': null,
    },
  })
  assert.equal(normalized.policy.quarantineAfter, 2)
  assert.equal(normalized.tests[T].count, 4)
  assert.equal(normalized.tests[T].firstSeen, dayOf())
  assert.equal(normalized.tests['tests/integration/broken.test.mjs'], undefined)
  assert.deepEqual(Object.keys(normalizeRegistry(null).tests), [], 'null 也要能兜住')
  assert.ok(normalizeRegistry(null).note, '登记簿要保留说明，别每次跑测试都洗掉文件头')
  assert.ok(normalizeRegistry(emptyRegistry()).note)
})

test('describeEntry 把关键字段说清楚（job summary 用）', () => {
  const registry = emptyRegistry()
  recordFlaky(registry, T, { today: '2026-11-01' })
  const text = describeEntry(registry.tests[T])
  assert.match(text, /累计 1 次/)
  assert.match(text, /连续 1 次/)
  assert.ok(!text.includes('已隔离'))
})

// ───────────────────── Issue #456：跨 runner 判据（每条都配一条「不该命中」的对照） ─────────────────────

/** 造一份运行记录：`{ commit, runner, results }`，字段与 run-layer 落盘的一致 */
const record = (commit, runnerId, results, extra = {}) =>
  buildRunRecord({
    commit,
    layer: 'integration',
    runner: { id: runnerId, runId: `${runnerId}@1`, loadClass: extra.loadClass ?? null, at: '2026-11-20T00:00:00.000Z' },
    results,
    startedAt: extra.startedAt ?? '2026-11-20T00:00:00.000Z',
    totalMs: 1000,
  })

test('跨 runner 判据：同 commit + 同用例 + 结果不同 + runner 不同 → 命中', () => {
  const found = scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: false, ms: 2400 }]),
    record('abc123', 'ci:B', [{ file: T, ok: true, ms: 1800 }]),
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].test, T)
  assert.deepEqual(found[0].redRunners, ['ci:A'])
  assert.deepEqual(found[0].greenRunners, ['ci:B'])
  assert.equal(found[0].evidence.length, 2, '两边的观测都要留证')
})

test('负向对照：四条边界各自不命中（同 commit 缺一条都不能算 cross-runner）', () => {
  // ① 同 runner 红→绿：那是 same-runner flaky
  assert.equal(scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: false }], { startedAt: '2026-11-20T00:00:00.000Z' }),
    record('abc123', 'ci:A', [{ file: T, ok: true }], { startedAt: '2026-11-20T00:10:00.000Z' }),
  ]).length, 0)
  // ② 换 commit（上一版红、这一版绿 = 修好了）
  assert.equal(scanCrossRunner([
    record('old111', 'ci:A', [{ file: T, ok: false }]),
    record('abc123', 'ci:B', [{ file: T, ok: true }]),
  ]).length, 0)
  // ③ 结论一致（都红 / 都绿）
  assert.equal(scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: true }]),
    record('abc123', 'ci:B', [{ file: T, ok: true }]),
  ]).length, 0)
  assert.equal(scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: false }]),
    record('abc123', 'ci:B', [{ file: T, ok: false }]),
  ]).length, 0, '都红是「两个 runner 都红」，不是 flake')
  // ④ SKIP(env) 不是绿：拿它当绿会把「产物没构建」说成 flake
  assert.equal(scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: false }]),
    record('abc123', 'ci:B', [{ file: T, ok: false, skipped: true }]),
  ]).length, 0)
})

test('同一 runner 有多条记录时取最新那条（重跑绿说明这台机器上是 flaky）', () => {
  const found = scanCrossRunner([
    record('abc123', 'ci:A', [{ file: T, ok: false }], { startedAt: '2026-11-20T00:00:00.000Z' }),
    record('abc123', 'ci:A', [{ file: T, ok: true }], { startedAt: '2026-11-20T00:20:00.000Z' }),
    record('abc123', 'ci:B', [{ file: T, ok: true }], { startedAt: '2026-11-20T00:10:00.000Z' }),
  ])
  assert.equal(found.length, 0, 'A 最新是绿、B 也绿 → 结论一致')
})

test('runner 身份：CI 看 runner.name，本地看 hostname + 负载档（同机换负载 = 换 runner）', () => {
  const ci = resolveRunnerIdentity({ env: { GITHUB_ACTIONS: 'true', RUNNER_NAME: 'GitHub Actions 7', GITHUB_RUN_ID: '9001', GITHUB_RUN_ATTEMPT: '2' } })
  assert.equal(ci.id, 'ci:GitHub Actions 7')
  assert.equal(ci.runId, '9001#2')
  const idle = resolveRunnerIdentity({ hostname: 'box', loadavg: [0.3], cpus: 4 })
  const busy = resolveRunnerIdentity({ hostname: 'box', loadavg: [9.1], cpus: 4 })
  assert.equal(idle.id, 'local:box#idle')
  assert.equal(busy.id, 'local:box#busy')
  assert.notEqual(idle.id, busy.id, '同一台机器满载与空载必须是两个「runner」，否则本地永远看不见这条 flake')
  assert.match(idle.runId, /^box@/, 'runId 只用于溯源（哪一次 run），不参与「runner 不同」的判定')
  assert.equal(classifyLoad(0.2, 4), 'idle')
  assert.equal(classifyLoad(2, 4), 'normal')
  assert.equal(classifyLoad(9, 4), 'busy')
  // 显式注入优先（自证用例靠它在一台机器上模拟两台）
  assert.equal(resolveRunnerIdentity({ env: { TEST_RUNNER_LOAD: 'busy' }, hostname: 'box', loadavg: [0.1], cpus: 4 }).id, 'local:box#busy')
})

test('记录 cross-runner：不隔离、不写 lastGreen（跨 runner 的病跑绿不等于修好）', () => {
  const registry = emptyRegistry()
  recordCrossRunner(registry, T, {
    today: '2026-11-20',
    runners: ['ci:A', 'ci:B'],
    evidence: [{ runner: 'ci:A', ok: false }, { runner: 'ci:B', ok: true }],
    commit: 'abc123',
  })
  const entry = registry.tests[T]
  assert.equal(entry.kind, KINDS.crossRunner)
  assert.equal(entry.count, 1)
  assert.deepEqual(entry.runners, ['ci:A', 'ci:B'])
  assert.equal(entry.evidence.length, 2)
  // 连续 3 次也不进隔离区：隔离＝跳过＝不再产生证据
  recordCrossRunner(registry, T, { today: '2026-11-21' })
  recordCrossRunner(registry, T, { today: '2026-11-22' })
  assert.equal(isQuarantined(registry, T), false, 'cross-runner 不许进 quarantine')
  assert.equal(registry.tests[T].count, 3)
  assert.equal(recordPass(registry, T, { today: '2026-11-23' }).lastGreen, null, '跑绿不销账')
})

test('三态：runner-dependent 优先于「重跑仍红」；真红与 flaky 不混', () => {
  assert.equal(triStateOf({ ok: false, flaky: false }), 'true-red')
  assert.equal(triStateOf({ ok: true, flaky: true }), 'flaky')
  assert.equal(triStateOf({ ok: true, flaky: false }), 'green')
  assert.equal(triStateOf({ ok: false, flaky: false, runnerDependent: true }), 'runner-dependent', '别的 runner 绿 → 不是真红')
  assert.equal(triStateOf({ ok: true, flaky: true, runnerDependent: true }), 'runner-dependent')
  const { summary, files } = summarizeTriState(
    [{ file: 'a', ok: false }, { file: 'b', ok: true, flaky: true }, { file: 'c', ok: true }, { file: 'd', ok: false }],
    new Set(['d']),
  )
  assert.deepEqual(summary, { green: 1, flaky: 1, 'runner-dependent': 1, 'true-red': 1 })
  assert.deepEqual(files['runner-dependent'], ['d'])
  assert.deepEqual(files['true-red'], ['a'])
})

test('时序窗口静态提示：注释与字符串里的写法不算，真写法逐条报行号', () => {
  const source = [
    '// 这里解释为什么删掉了 waitForTimeout(3000)',
    'const a = await page.waitForTimeout(700)',
    'const b = await sleep(350)',
    "  const c = await sleep(WINDOW_MS)",
    "  await page.waitForSelector('.animationend')",
    "  const s = 'waitForTimeout(1)'",
    '  /* sleep(10) 在块注释里 */',
    '  await until(() => page.isVisible(".done"))',
  ].join('\n')
  const found = scanTimingWindows(source)
  assert.deepEqual(found.map((item) => item.line), [2, 3, 4, 5], '注释(1/7)与字符串(6)必须被排除')
  assert.deepEqual(found.map((item) => item.kind), ['waitForTimeout', 'fixed-sleep', 'fixed-sleep', 'animation-duration'])
  assert.equal(scanTimingWindows('await until(() => page.isEnabled(".x"))').length, 0, '等终态不报警')
})

test('登记簿形状升级：#406 老条目（无 kind）归一成 same-runner，不许被升级判成 cross-runner', () => {
  const normalized = normalizeRegistry({
    tests: {
      [T]: { test: T, firstSeen: '2026-11-01', count: 2, lastSeen: '2026-11-02' },
      'tests/integration/other.test.mjs': {
        test: 'tests/integration/other.test.mjs',
        kind: 'cross-runner',
        count: 1,
        runners: ['ci:A', 'ci:B'],
        evidence: [{ runner: 'ci:A', ok: false }],
      },
    },
  })
  assert.equal(normalized.tests[T].kind, KINDS.sameRunner, '老条目默认 same-runner')
  assert.deepEqual(normalized.tests[T].runners, [])
  const cross = normalized.tests['tests/integration/other.test.mjs']
  assert.equal(cross.kind, KINDS.crossRunner)
  assert.deepEqual(cross.runners, ['ci:A', 'ci:B'], 'runners / evidence 这些 #456 字段必须能存下来')
  assert.deepEqual(cross.evidence, [{ runner: 'ci:A', ok: false }])
})
