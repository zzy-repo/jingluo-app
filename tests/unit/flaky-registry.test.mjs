// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Flaky 登记簿的判据（Issue #406）—— 三条规则各自钉死，防止「重跑通过」变成「红被抹掉」：
//   [1] 记一次 flaky：累计 + 连续 + firstSeen/lastSeen 语义
//   [2] 连续 3 次 → quarantine（跳过但每周提醒）；一次就绿 → 连续清零 + 自动解除隔离
//   [3] 复发 ≥2 次（修好又坏两次，21 天窗口内）→ 当红处理；从没一次就绿过的不算复发
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_POLICY,
  dayOf,
  describeEntry,
  dueReminders,
  emptyRegistry,
  isQuarantined,
  isRecurringRed,
  normalizeRegistry,
  recordFlaky,
  recordPass,
  recordRecurringRed,
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
