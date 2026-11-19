/**
 * Flaky 登记簿（Issue #406）：**纯函数 + 一个 JSON 文件**，不碰浏览器、不 import 测试运行时。
 *
 * 为什么单独成模块：`tests/run-layer.mjs` 里「失败→重跑一次→重跑绿=flaky」只是**一条判据**，
 * 而「连续 3 次 → quarantine」「3 周内复发 ≥2 次 → 当红」是**策略**。策略写进 runner 里就再也
 * 没法单测了（runner 要起 Chromium），所以这里只留纯函数：`recordFlaky` / `recordPass` /
 * `isQuarantined` / `dueReminders` / `isRecurringRed`，由 `tests/unit/flaky-registry.test.mjs` 钉住。
 *
 * 登记簿的形状（`tests/flaky-registry.json`）：
 *
 *   {
 *     "schemaVersion": 1,
 *     "policy": { "quarantineAfter": 3, "recurrenceWindowDays": 21, "remindEveryDays": 7 },
 *     "tests": {
 *       "tests/integration/foo.test.mjs": {
 *         "test": "tests/integration/foo.test.mjs",   // 必填：稳定 id（仓库相对路径）
 *         "firstSeen": "2026-11-20",                  // 必填：第一次被判 flaky 的日期（UTC，YYYY-MM-DD）
 *         "count": 2,                                 // 必填：累计被判 flaky 的次数
 *         "lastSeen": "2026-11-25",                   // 必填：最近一次被判 flaky 的日期
 *         "streak": 2,                                // 连续 flaky 次数（跑绿即清零）
 *         "history": ["2026-11-20T01:02:03.000Z"],    // 每次 flaky 的时刻（ISO），用于 21 天窗口判复发
 *         "quarantinedAt": null,                      // 进隔离区的日期；跑绿自动移除（置 null）
 *         "lastRemindedAt": null,                     // 上一次提醒修复的日期（每周一次）
 *         "lastGreen": null,                          // 最近一次「一次就绿」的时刻（ISO）：复发窗口的起点
 *         "lastRedAt": null                           // 最近一次「复发当红」的日期
 *       }
 *     }
 *   }
 *
 * **禁止用重跑掩盖真红**（写进 docs/TESTING-POLICY.md 第 10 节）：
 * 重跑通过但 21 天内**复发 ≥2 次** → 不再当 flaky，`isRecurringRed()` 返回 true，runner 直接按真红上报。
 * 「复发 ≥2 次」= **最近一次「一次就绿」之后**在窗口内累计 flaky 到第 2 次（含本次）就当红。从没一次就绿过的用例不算复发
 * （它归 quarantine：连续 3 次 flaky 就跳过 + 每周提醒），否则两条规则会互相打架、谁也不生效。
 */

/** 默认策略：与 docs/TESTING-POLICY.md 第 10 节一致 */
export const DEFAULT_POLICY = Object.freeze({
  /** 连续几次 flaky → 进 quarantine（跳过但每周提醒） */
  quarantineAfter: 3,
  /** 复发窗口（天）：窗口内累计 ≥2 次「已登记」后再出现，就当红 */
  recurrenceWindowDays: 21,
  /** quarantine 的提醒间隔（天） */
  remindEveryDays: 7,
})

/** 天数常量单独命名，避免 `21 * 24 * 60 * 60 * 1000` 这种魔法数散在各处 */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 登记簿自带的说明（落盘时保留，避免每次跑测试把文件头注释洗掉） */
export const REGISTRY_NOTE =
  'Flaky 登记簿（Issue #406）。由 tests/run-layer.mjs 在「失败 → 重跑一次 → 重跑通过」时自动登记；quarantine 的用例跑绿即自动解除隔离。形状与判据见 scripts/flaky-registry.mjs 文件头与 docs/TESTING-POLICY.md 第 10 节。'

/** 空登记簿（第一次跑、文件缺失/损坏时的兜底：不因为登记簿坏了而阻断测试） */
export const emptyRegistry = () => ({
  schemaVersion: 1,
  note: REGISTRY_NOTE,
  policy: { ...DEFAULT_POLICY },
  tests: {},
})

/** 日期归一成 `YYYY-MM-DD`（UTC）：登记簿是给人看的，不带时区尾巴 */
export const dayOf = (date = new Date()) => new Date(date).toISOString().slice(0, 10)

/**
 * 事件时刻（完整 ISO）：`history` 与 `lastGreen` 必须带秒。
 * 只用日期的话，「今天修好、今天又坏」这种**同一天内**的复发就永远判不出来（差值是 0），
 * 而本地跑一轮集成只要几分钟 —— 这正是最需要判的场景。
 */
export const stampOf = (date = new Date()) => new Date(date).toISOString()

/** 两个 `YYYY-MM-DD` 之间的天数差（b - a） */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY)

/** 容错读取：字段缺失时补齐默认值，坏条目直接丢掉（登记簿不该让整轮测试起不来） */
export const normalizeRegistry = (raw) => {
  const policy = { ...DEFAULT_POLICY, ...(raw?.policy ?? {}) }
  const tests = {}
  for (const [key, value] of Object.entries(raw?.tests ?? {})) {
    if (!value || typeof value !== 'object') continue
    const test = typeof value.test === 'string' && value.test ? value.test : key
    const firstSeen = typeof value.firstSeen === 'string' ? value.firstSeen : dayOf()
    const lastSeen = typeof value.lastSeen === 'string' ? value.lastSeen : firstSeen
    const count = Number.isFinite(value.count) && value.count > 0 ? Math.floor(value.count) : 1
    const history = Array.isArray(value.history)
      ? value.history.filter((item) => typeof item === 'string').slice(-50)
      : [lastSeen]
    tests[test] = {
      test,
      firstSeen,
      count,
      lastSeen,
      streak: Number.isFinite(value.streak) && value.streak >= 0 ? Math.floor(value.streak) : 1,
      history,
      quarantinedAt: typeof value.quarantinedAt === 'string' ? value.quarantinedAt : null,
      lastRemindedAt: typeof value.lastRemindedAt === 'string' ? value.lastRemindedAt : null,
      lastGreen: typeof value.lastGreen === 'string' ? value.lastGreen : null,
      lastRedAt: typeof value.lastRedAt === 'string' ? value.lastRedAt : null,
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}),
    }
  }
  return {
    schemaVersion: 1,
    note: typeof raw?.note === 'string' && raw.note ? raw.note : REGISTRY_NOTE,
    policy,
    tests,
  }
}

/** 窗口内（含今天）已经登记过几次 flaky —— 「复发」的判据 */
export const flakyCountWithin = (entry, windowDays, today) => {
  if (!entry) return 0
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - windowDays * MS_PER_DAY)
  return (entry.history ?? []).filter((stamp) => {
    const at = Date.parse(stamp.length === 10 ? `${stamp}T00:00:00Z` : stamp)
    return Number.isFinite(at) && at >= from.getTime()
  }).length
}

/**
 * 这次「重跑才通过」该不该当真 red 处理（而不是当 flaky 放过）。
 *
 * 口径：**最近一次「一次就绿」（`lastGreen`）之后**，`recurrenceWindowDays` 窗口内**累计复发 ≥2 次**
 * （本次算一次）→ 说明「修好又坏」反复发生，重跑只是在掩盖一条真实的红。
 * `lastGreen` 为空（从来没一次就绿过）→ 不算复发，交给 quarantine 那条规则。
 * **调用时机**：必须在 `recordFlaky` **之前**判（它内部会把「本次」也算成一次复发）。
 */
export const isRecurringRed = (entry, policy = DEFAULT_POLICY, today = dayOf()) => {
  const green = entry?.lastGreen
  if (!entry || !green) return false
  const greenAt = Date.parse(green)
  if (!Number.isFinite(greenAt)) return false
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - policy.recurrenceWindowDays * MS_PER_DAY).getTime()
  const afterGreen = (entry.history ?? []).filter((stamp) => {
    const at = Date.parse(stamp.length === 10 ? `${stamp}T00:00:00Z` : stamp)
    return Number.isFinite(at) && at >= from && at > greenAt
  })
  // `afterGreen` 是**本次之前**的复发次数：本次是第 2 次复发（1 + 1 ≥ 2）就当红。
  return afterGreen.length + 1 >= 2
}

/**
 * 记一次「复发当红」：这次不算 flaky（不能进隔离区，否则红被藏起来）。
 * 累计与病历照记（排查要看反复史），但连续计数清零、隔离解除。
 */
export const recordRecurringRed = (registry, test, { today = dayOf(), at = stampOf(), reason } = {}) => {
  const entry = recordFlaky(registry, test, { today, at, reason })
  entry.streak = 0
  entry.quarantinedAt = null
  entry.lastRemindedAt = null
  entry.lastRedAt = today
  return entry
}

/**
 * 记一次「重跑才通过」：累计 + 连续 + 复发窗口 + 连续 3 次进 quarantine。
 * 注意它**不**碰 `lastGreen`：`lastGreen` 只由「一次就绿」写（`recordPass`），那才是「已经修好」的证据。
 */
export const recordFlaky = (registry, test, { today = dayOf(), at = stampOf(), reason } = {}) => {
  const policy = { ...DEFAULT_POLICY, ...(registry.policy ?? {}) }
  const entry = registry.tests[test] ?? {
    test,
    firstSeen: today,
    count: 0,
    lastSeen: today,
    streak: 0,
    history: [],
    quarantinedAt: null,
    lastRemindedAt: null,
  }
  entry.count += 1
  entry.streak += 1
  entry.lastSeen = today
  entry.history = [...(entry.history ?? []), at].slice(-50)
  if (reason) entry.reason = reason
  // 连续 N 次 flaky → quarantine（跳过但每周提醒）。日期只记第一次进隔离区的那天。
  if (entry.streak >= policy.quarantineAfter && !entry.quarantinedAt) {
    entry.quarantinedAt = today
    entry.lastRemindedAt = null
  }
  registry.tests[test] = entry
  return entry
}

/**
 * 记一次「真的绿了」：连续计数清零，并**解除 quarantine**（修好后移除，不需要手工编辑 JSON）。
 * 累计次数与历史保留：它们说明这条用例的病历，删了反而看不出反复。
 */
export const recordPass = (registry, test, { today = dayOf(), at = stampOf() } = {}) => {
  const entry = registry.tests[test]
  if (!entry) return null
  entry.streak = 0
  entry.lastSeen = today
  // 「一次就绿」= 已经修好的证据：复发窗口从这里重新起算（记时刻，同一天内的复发也判得出来）
  entry.lastGreen = at
  if (entry.quarantinedAt) {
    entry.quarantinedAt = null
    entry.lastRemindedAt = null
  }
  return entry
}

export const isQuarantined = (registry, test) => Boolean(registry.tests?.[test]?.quarantinedAt)

/**
 * 到期的「quarantine 每周提醒」：隔离区里的用例每 `remindEveryDays` 天提醒一次修复，
 * 提醒后把 `lastRemindedAt` 记成今天（由调用方 saveRegistry 落盘），避免每轮刷屏。
 */
export const dueReminders = (registry, { today = dayOf(), peek = false } = {}) => {
  const policy = { ...DEFAULT_POLICY, ...(registry.policy ?? {}) }
  const due = []
  for (const entry of Object.values(registry.tests ?? {})) {
    if (!entry.quarantinedAt) continue
    const last = entry.lastRemindedAt ?? entry.quarantinedAt
    if (daysBetween(last, today) >= policy.remindEveryDays) {
      due.push(entry)
      if (!peek) entry.lastRemindedAt = today
    }
  }
  return due
}

/** 给 job summary / 终端用的一行摘要 */
export const describeEntry = (entry) =>
  `${entry.test}：累计 ${entry.count} 次，最近 ${entry.lastSeen}，连续 ${entry.streak} 次${entry.quarantinedAt ? `，已隔离（${entry.quarantinedAt} 起）` : ''}`
