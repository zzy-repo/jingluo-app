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
 *         "kind": "cross-runner",                     // #456：同一台机器怎么跑都绿、换台机器才红的那类
 *         "runners": ["ci:GitHub Actions 3", "local:build-box#busy"],  // #456：见过这条 flake 的执行环境
 *         "evidence": [{ "at": "…", "commit": "0ee2b2c", "runner": "…", "ok": false, "ms": 2412 }],
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
 * **禁止用重跑掩盖真红**（写进 docs/TESTING-POLICY.md 第 11 节）：
 * 重跑通过但 21 天内**复发 ≥2 次** → 不再当 flaky，`isRecurringRed()` 返回 true，runner 直接按真红上报。
 * 「复发 ≥2 次」= **最近一次「一次就绿」之后**在窗口内累计 flaky 到第 2 次（含本次）就当红。从没一次就绿过的用例不算复发
 * （它归 quarantine：连续 3 次 flaky 就跳过 + 每周提醒），否则两条规则会互相打架、谁也不生效。
 *
 * ---- Issue #456：判据曾经看不见「runner 快慢」----
 *
 * `#406` 的判据只有一条：「同 runner 上失败 → 重跑一次 → 绿 = flaky」。它的盲区是结构性的：
 * 机器相关的时序 flake（#406 的 url-import-stages case 10：窗口 ~2.4s）在**同一台机器上必然复现**
 * —— 慢机连跑 10/10 绿，快机必红，重跑永远发生在同一台机器上，所以这类**永远不会被登记**
 * （`tests/flaky-registry.json` 长期为空不是「没有 flake」，是「判据看不见这个变量」）。
 *
 * #456 补的第二条判据：**同 commit + 同用例 + 结果不同 + runner 不同 → `kind: "cross-runner"`**。
 * 输入不再是「本进程里的两次 attempt」，而是**跨 runner 的运行记录**（`buildRunRecord` /
 * `scanCrossRunner`）：每个 runner 各写一份带身份与负载快照的记录，聚合后比对。
 *
 * 「runner 不同」怎么判（`resolveRunnerIdentity`）：
 *   · CI：`ci:<runner.name>` —— GitHub 每个 job 一台新 VM，名字不同就是不同机器；
 *   · 本地：`local:<hostname>#<负载档>` —— 同一台机器也可能处在「空载 / 正常 / 满载」三种**执行环境**里，
 *     判据要看见的正是这个差异（也可用 `TEST_RUNNER_LOAD` 显式注入，自证用）。
 *
 * 处置不同（**红线**）：`same-runner` → 自动重跑 + 登记（本条模块的策略照旧）；
 * `cross-runner` → **必须改成等终态（until 轮询），不允许加 sleep 把窗口撑开**。所以 cross-runner
 * 条目**不进 quarantine**（隔离=跳过=不再产生证据，等于把这条 flake 从视野里删掉），
 * 也不会被「跑绿」自动销账（红的那台机器这轮可能根本没跑）。
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

/**
 * #456：两类 flaky —— 判据、处置、代价都不同，登记簿里必须分开写，否则会拿同一条策略套两种病。
 *   · `same-runner`：同一台机器上第一次红、重跑绿（时序/首帧/端口竞态）。
 *     处置：自动重跑 + 登记；连续 3 次进 quarantine（每周提醒）。
 *   · `cross-runner`：同一份代码在某台机器上怎么跑都绿、换台机器（或换负载档）就红。
 *     处置：**必须改成等终态（until 轮询）**，禁止加 sleep/提高超时把窗口撑开；不进 quarantine。
 */
export const KINDS = Object.freeze({ sameRunner: 'same-runner', crossRunner: 'cross-runner' })

/** 两个 kind 的定义 + 处置（跟着登记簿落盘：读文件的人不用跳回代码才知道该修什么） */
export const KIND_TEXT = Object.freeze({
  'same-runner':
    '同一台 runner 上第一次红、重跑绿（时序/首帧/端口竞态）。处置：自动重跑 + 登记；连续 3 次进 quarantine（每周提醒）。',
  'cross-runner':
    '同 commit + 同用例 + 结果不同 + runner 不同（机器快慢/负载差异）。处置：必须改成等终态（until 轮询），禁止加 sleep / 提高超时；不进 quarantine。',
})

/** 登记簿自带的说明（落盘时保留，避免每次跑测试把文件头注释洗掉） */
export const REGISTRY_NOTE =
  'Flaky 登记簿（Issue #406 / #456）。两类条目：kind="same-runner"（同 runner 上「失败→重跑通过」）由 tests/run-layer.mjs 自动登记；kind="cross-runner"（同 commit + 同用例 + 结果不同 + runner 不同）由跨 runner 运行记录聚合后登记，处置红线是「改成等终态，禁止加 sleep」。形状与判据见 scripts/flaky-registry.mjs 文件头与 docs/TESTING-POLICY.md 第 11 节。'

/** 空登记簿（第一次跑、文件缺失/损坏时的兜底：不因为登记簿坏了而阻断测试） */
export const emptyRegistry = () => ({
  schemaVersion: 1,
  note: REGISTRY_NOTE,
  policy: { ...DEFAULT_POLICY },
  kinds: { ...KIND_TEXT },
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
      // #456：老条目（#406 时代只有「重跑才绿」一条判据）一律归一成 same-runner，
      // 不因为升级登记簿形状就把历史条目判成别的类型。
      kind: value.kind === KINDS.crossRunner ? KINDS.crossRunner : KINDS.sameRunner,
      firstSeen,
      count,
      lastSeen,
      streak: Number.isFinite(value.streak) && value.streak >= 0 ? Math.floor(value.streak) : 1,
      history,
      runners: Array.isArray(value.runners) ? value.runners.filter((item) => typeof item === 'string').slice(-20) : [],
      evidence: Array.isArray(value.evidence) ? value.evidence.filter((item) => item && typeof item === 'object').slice(-12) : [],
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
    // #456：kinds 是**说明**字段，人读登记簿时不用跳代码；丢了就补默认，不因为缺它而红。
    kinds: { ...KIND_TEXT, ...(raw?.kinds && typeof raw.kinds === 'object' ? raw.kinds : {}) },
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
export const recordRecurringRed = (registry, test, { today = dayOf(), at = stampOf(), reason, runner } = {}) => {
  const entry = recordFlaky(registry, test, { today, at, reason, runner })
  entry.streak = 0
  entry.quarantinedAt = null
  entry.lastRemindedAt = null
  entry.lastRedAt = today
  return entry
}

/**
 * 记一次「重跑才通过」：累计 + 连续 + 复发窗口 + 连续 3 次进 quarantine。
 * 注意它**不**碰 `lastGreen`：`lastGreen` 只由「一次就绿」写（`recordPass`），那才是「已经修好」的证据。
 *
 * #456：额外的 `runner`（`resolveRunnerIdentity()` 的返回值，或用 `id` 字符串）会写进 `runners[]`，
 * 并进 `evidence`（带上当时的结果）。判据本身没变 —— 这条路径记的是 `kind: "same-runner"`。
 */
export const recordFlaky = (registry, test, { today = dayOf(), at = stampOf(), reason, runner, evidence } = {}) => {
  const policy = { ...DEFAULT_POLICY, ...(registry.policy ?? {}) }
  const entry = registry.tests[test] ?? {
    test,
    kind: KINDS.sameRunner,
    firstSeen: today,
    count: 0,
    lastSeen: today,
    streak: 0,
    history: [],
    runners: [],
    evidence: [],
    quarantinedAt: null,
    lastRemindedAt: null,
    lastGreen: null,
    lastRedAt: null,
  }
  entry.count += 1
  entry.streak += 1
  entry.lastSeen = today
  entry.history = [...(entry.history ?? []), at].slice(-50)
  // 已经判成 cross-runner 的条目不被这条路径「降级」：跨 runner 的证据不会因为一次同机重跑绿而失效。
  if (entry.kind !== KINDS.crossRunner) entry.kind = KINDS.sameRunner
  const runnerId = typeof runner === 'string' ? runner : runner?.id
  if (runnerId && !(entry.runners ?? []).includes(runnerId)) entry.runners = [...(entry.runners ?? []), runnerId].slice(-20)
  if (evidence) entry.evidence = [...(entry.evidence ?? []), evidence].slice(-12)
  if (reason) entry.reason = reason
  // 连续 N 次 flaky → quarantine（跳过但每周提醒）。日期只记第一次进隔离区的那天。
  // #456：cross-runner 条目**不**进隔离区 —— 隔离＝跳过＝不再产生证据，等于把这条 flake 从视野里删掉。
  if (entry.kind !== KINDS.crossRunner && entry.streak >= policy.quarantineAfter && !entry.quarantinedAt) {
    entry.quarantinedAt = today
    entry.lastRemindedAt = null
  }
  registry.tests[test] = entry
  return entry
}

/**
 * #456：记一次 `cross-runner`（同 commit + 同用例 + 结果不同 + runner 不同）。
 *
 * 与 `recordFlaky` 的差别是**故意**的：
 *   · 不进 quarantine —— 跨 runner 的问题靠「改成等终态」修，跳过它只会让证据消失；
 *   · 连续计数清零 —— `streak` 是 same-runner 的 quarantine 计数器，两个判据不能共用；
 *   · 也不写 `lastGreen`：红的那台机器这轮可能根本没跑，「跑绿」不等于修好。
 */
export const recordCrossRunner = (registry, test, {
  today = dayOf(),
  at = stampOf(),
  runners = [],
  evidence = [],
  commit,
  reason,
} = {}) => {
  const entry = registry.tests[test] ?? {
    test,
    kind: KINDS.crossRunner,
    firstSeen: today,
    count: 0,
    lastSeen: today,
    streak: 0,
    history: [],
    runners: [],
    evidence: [],
    quarantinedAt: null,
    lastRemindedAt: null,
    lastGreen: null,
    lastRedAt: null,
  }
  entry.kind = KINDS.crossRunner
  entry.count += 1
  entry.streak = 0
  entry.lastSeen = today
  entry.history = [...(entry.history ?? []), at].slice(-50)
  entry.runners = [...new Set([...(entry.runners ?? []), ...runners.filter((id) => typeof id === 'string')])].slice(-20)
  entry.evidence = [...(entry.evidence ?? []), ...evidence.filter((item) => item && typeof item === 'object')].slice(-12)
  entry.quarantinedAt = null
  if (commit) entry.lastCrossRunnerCommit = commit
  if (reason) entry.reason = reason
  registry.tests[test] = entry
  return entry
}

/**
 * 记一次「真的绿了」：连续计数清零，并**解除 quarantine**（修好后移除，不需要手工编辑 JSON）。
 * 累计次数与历史保留：它们说明这条用例的病历，删了反而看不出反复。
 *
 * #456：`cross-runner` 条目**不**写 `lastGreen`。它的红只在别的 runner 上出现，本地这轮跑绿
 * 完全可能是「这台机器本来就绿」——把 `lastGreen` 写上去等于宣布「已修好」，而证据相反。
 * 销账唯一的口径是人工把处置做完（改成等终态）并删条目前后跑过的两份记录都不再分叉。
 */
export const recordPass = (registry, test, { today = dayOf(), at = stampOf() } = {}) => {
  const entry = registry.tests[test]
  if (!entry) return null
  entry.streak = 0
  entry.lastSeen = today
  if (entry.kind !== KINDS.crossRunner) {
    // 「一次就绿」= 已经修好的证据：复发窗口从这里重新起算（记时刻，同一天内的复发也判得出来）
    entry.lastGreen = at
  }
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
export const describeEntry = (entry) => {
  const kind = entry.kind === KINDS.crossRunner ? 'cross-runner' : 'same-runner'
  const runners = (entry.runners ?? []).length ? `，runner：${entry.runners.slice(-3).join(' / ')}` : ''
  return `${entry.test}：${kind}，累计 ${entry.count} 次，最近 ${entry.lastSeen}，连续 ${entry.streak} 次${runners}${entry.quarantinedAt ? `，已隔离（${entry.quarantinedAt} 起）` : ''}`
}

// ───────────────────────────── Issue #456：跨 runner 判据 ─────────────────────────────

/**
 * 负载档：同一台机器在「空载 / 正常 / 满载」下就是三种不同的执行环境。
 * 阈值按 `load1 / cpus` 取（load1 是 1 分钟平均负载）：< 0.5 空载、< 1.5 正常、否则满载。
 * 为什么要分档而不记原始数字：原始 load 每次都不同，用它当 runner 身份会让「同一环境」被判成
 * 「两个 runner」；分档才既保留机器快慢信息、又可比较（这条是自证用例能落地的前提）。
 */
export const classifyLoad = (load1, cpus = 1) => {
  const cores = Number(cpus)
  const load = Number(load1)
  if (!Number.isFinite(load) || !Number.isFinite(cores) || cores <= 0) return 'normal'
  const perCore = load / cores
  if (perCore < 0.5) return 'idle'
  if (perCore < 1.5) return 'normal'
  return 'busy'
}

/** 合法的显式负载档（`TEST_RUNNER_LOAD`）；自证用例靠它把「两台机器」压到一台机器上跑 */
export const LOAD_CLASSES = Object.freeze(['idle', 'normal', 'busy'])

/**
 * 这次 run 的 runner 身份（#456 的「记录 runner 标识」）。
 *
 * 返回 `{ id, kind, name, runId, attempt, job, os, loadClass, load, at }`：
 *   · `id` 是**判据用的身份** —— 判「runner 不同」只看它；
 *       - CI：`ci:<runner.name>`（GitHub 每个 job 一台新 VM；`runner.name` 由 ci.yml 用
 *         `${{ runner.name }}` 注入成 `RUNNER_NAME`）；
 *       - 本地：`local:<hostname>#<负载档>`（同一台机器换负载档 = 换执行环境，这正是要看见的变量）。
 *   · `runId` 是**这一次 run 的实例**（CI 是 `run_id#attempt`，本地是 `hostname@ISO`），只用于溯源。
 *   · `load` 是负载快照（本地才有意义）：`{ load1, cpus, freeMemMb }`。
 *
 * 纯函数：环境与机器事实都由调用方传进来（runner 里传 `process.env` + `os` 的取值），
 * 所以判据可以在 `tests/unit/flaky-registry.test.mjs` 里钉死，不用真的起两台机器。
 */
export const resolveRunnerIdentity = ({
  env = {},
  hostname = '',
  loadavg = [],
  cpus = 1,
  freeMemMb = null,
  now = new Date(),
} = {}) => {
  const at = stampOf(now)
  const ci = String(env.GITHUB_ACTIONS ?? '') === 'true' || Boolean(env.RUNNER_NAME)
  const explicitLoad = LOAD_CLASSES.includes(String(env.TEST_RUNNER_LOAD ?? '')) ? String(env.TEST_RUNNER_LOAD) : null
  const loadClass = explicitLoad ?? classifyLoad(loadavg[0], cpus)
  const load = {
    load1: Number.isFinite(Number(loadavg[0])) ? Math.round(Number(loadavg[0]) * 100) / 100 : null,
    cpus: Number(cpus) || null,
    freeMemMb: freeMemMb === null || freeMemMb === undefined ? null : (Number.isFinite(Number(freeMemMb)) ? Number(freeMemMb) : null),
    ...(explicitLoad ? { injected: explicitLoad } : {}),
  }
  if (ci) {
    const name = String(env.RUNNER_NAME || env.RUNNER_NAME_FALLBACK || 'ci-unnamed')
    const runId = `${env.GITHUB_RUN_ID ?? 'run-?'}#${env.GITHUB_RUN_ATTEMPT ?? '1'}`
    return {
      id: `ci:${name}`,
      kind: 'ci',
      name,
      runId,
      attempt: String(env.GITHUB_RUN_ATTEMPT ?? '1'),
      job: String(env.JOB_NAME ?? env.GITHUB_JOB ?? ''),
      os: String(env.RUNNER_OS ?? ''),
      loadClass,
      load,
      at,
    }
  }
  const host = String(hostname || env.HOSTNAME || 'localhost')
  return {
    id: `local:${host}#${loadClass}`,
    kind: 'local',
    name: host,
    runId: `${host}@${at}`,
    attempt: '1',
    job: '',
    os: String(env.OS ?? ''),
    loadClass,
    load,
    at,
  }
}

/** 运行记录的 schema 版本（聚合端据此判断能不能读；不认识的版本直接跳过） */
export const RUN_RECORD_VERSION = 1

/**
 * 一次 run 的记录（每个 runner 各写一份，跨 runner 判据的输入）。
 *
 * 为什么要落盘成记录而不是直接读登记簿：判据需要的是「同一份代码在别处是怎么跑的」这个**原始事实**，
 * 而登记簿是它的结论。原始事实要能重放、能比对、能作为证据贴进 issue。
 */
export const buildRunRecord = ({
  commit,
  layer,
  shard = null,
  runner,
  results = [],
  startedAt = stampOf(),
  totalMs = 0,
}) => ({
  schemaVersion: RUN_RECORD_VERSION,
  object: 'flaky-run-record',
  commit: String(commit ?? 'unknown'),
  layer: String(layer ?? ''),
  shard,
  runner,
  startedAt,
  totalMs,
  results: results.map((item) => ({
    file: String(item.file ?? ''),
    ok: Boolean(item.ok),
    skipped: Boolean(item.skipped),
    flaky: Boolean(item.flaky),
    ms: Number(item.ms) || 0,
    attempts: Number(item.attempts) || 1,
  })),
})

/**
 * #456 的核心判据：**同 commit + 同用例 + 结果不同 + runner 不同 → cross-runner**。
 *
 * 输入是若干运行记录（可以是同一个 workflow 的不同分片、不同 attempt、不同机器、本机两次不同负载的
 * run）。口径逐条写清，避免「看起来像 flake」的都被算进来：
 *   · **同 commit**：不同 commit 的记录不互相比（上一版红、这一版绿是「修好了」，不是 flake）；
 *   · **同用例**：按仓库相对路径；
 *   · **结果不同**：一个 runner 报 ok、另一个报 not ok。`SKIP(env)` 不作为「绿」——
 *     产物缺失造成的跳过既不是绿也不是红，拿它当绿会把环境问题说成 flake；
 *   · **runner 不同**：按 `runner.id`（见 `resolveRunnerIdentity`）。同一 runner 上的红→绿是
 *     `same-runner` 那条判据的事，这里不算。
 *
 * 同一 (commit, 用例, runner) 有多条记录时取**最新**那条（按 `startedAt`）：同一台机器重跑绿说明
 * 这台机器上它是 flaky，用它跟别的 runner 比才有意义。
 *
 * 返回 `[{ test, commit, runners[], redRunners[], greenRunners[], evidence[] }]`。
 */
export const scanCrossRunner = (records = []) => {
  /** commit → test → runnerId → 观测（最新的赢） */
  const byCommit = new Map()
  for (const record of records) {
    if (!record || record.schemaVersion !== RUN_RECORD_VERSION) continue
    const commit = String(record.commit ?? 'unknown')
    const runnerId = record.runner?.id
    if (!runnerId) continue
    if (!byCommit.has(commit)) byCommit.set(commit, new Map())
    const perTest = byCommit.get(commit)
    for (const item of record.results ?? []) {
      if (!item?.file || item.skipped) continue
      if (!perTest.has(item.file)) perTest.set(item.file, new Map())
      const perRunner = perTest.get(item.file)
      const previous = perRunner.get(runnerId)
      const at = String(record.startedAt ?? '')
      if (previous && String(previous.at) > at) continue
      perRunner.set(runnerId, {
        runner: runnerId,
        ok: Boolean(item.ok),
        flaky: Boolean(item.flaky),
        ms: Number(item.ms) || 0,
        attempts: Number(item.attempts) || 1,
        runId: String(record.runner?.runId ?? ''),
        loadClass: record.runner?.loadClass ?? null,
        at,
      })
    }
  }
  const found = []
  for (const [commit, perTest] of byCommit) {
    for (const [test, perRunner] of perTest) {
      const observations = [...perRunner.values()]
      const green = observations.filter((item) => item.ok)
      const red = observations.filter((item) => !item.ok)
      if (!green.length || !red.length) continue
      found.push({
        test,
        commit,
        runners: observations.map((item) => item.runner),
        redRunners: red.map((item) => item.runner),
        greenRunners: green.map((item) => item.runner),
        evidence: observations
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
          .map((item) => ({ ...item, commit })),
      })
    }
  }
  // 输出顺序稳定（CI 里两份日志/摘要要能逐行对比）
  return found.sort((a, b) => a.commit.localeCompare(b.commit) || a.test.localeCompare(b.test))
}

/** 三态（#456 §2）：失败必须被明确归到其中一种，不许含糊成「红了」 */
export const TRI_STATES = Object.freeze(['green', 'flaky', 'runner-dependent', 'true-red'])

export const TRI_STATE_TEXT = Object.freeze({
  green: '绿',
  flaky: 'flaky（同 runner 重跑绿）',
  'runner-dependent': 'runner-dependent（跨 runner 结论不一致）',
  'true-red': '真红（同 runner 重跑仍红）',
})

/**
 * 一次结果的三态判定。`runnerDependent` 来自 `scanCrossRunner`（跨 runner 比对），
 * 传进来时**优先级最高**：一台机器上怎么重跑都绿，也不能说明它没病。
 */
export const triStateOf = ({ ok, flaky = false, skipped = false, runnerDependent = false }) => {
  if (skipped) return 'green'
  if (runnerDependent) return 'runner-dependent'
  if (ok) return flaky ? 'flaky' : 'green'
  return 'true-red'
}

/** 三态 → 处置：写进 job summary 的「怎么办」那一列（红线见 docs/TESTING-POLICY.md §11.5） */
export const TRI_STATE_ACTION = Object.freeze({
  green: '无需处理',
  flaky: '自动重跑 + 登记；连续 3 次进隔离区',
  'runner-dependent': '必须改成等终态（until 轮询）；**禁止加 sleep / 提高超时**',
  'true-red': '修产品或修断言（不是 flake，别重跑）',
})

/** 把三态汇总成一行（终端 / job summary / --json 都从这里取，口径只有一份） */
export const summarizeTriState = (results = [], crossRunnerFiles = new Set()) => {
  const summary = { green: 0, flaky: 0, 'runner-dependent': 0, 'true-red': 0 }
  const files = { green: [], flaky: [], 'runner-dependent': [], 'true-red': [] }
  for (const item of results) {
    const state = triStateOf({
      ok: Boolean(item.ok),
      flaky: Boolean(item.flaky),
      skipped: Boolean(item.skipped),
      runnerDependent: crossRunnerFiles.has(item.file),
    })
    summary[state] += 1
    if (state !== 'green') files[state].push(item.file)
  }
  return { summary, files }
}

// ───────────────────────────── Issue #456 §3：时序窗口的静态提示（警告级） ─────────────────────────────

/**
 * 测试源码里的「靠时间而不是靠终态」的写法。判定为**警告**（不阻塞）：这些写法不是错，
 * 但它们的正确性依赖机器快慢 —— 正是「换 runner 才绿」这类 flake 的温床。
 *
 * 三条规则（都对应一种真实失效模式）：
 *   · `waitForTimeout` —— 固定等待，慢机不够、快机浪费；用例里的出现频率最高（48 个文件）。
 *   · 固定 `sleep(...)` / `setTimeout(resolve, N)` —— 同上，只是自己包的 sleep 函数（参数是变量也算：
 *     变量最后也是某个常数毫秒，`sleep(WINDOW_MS)` 并不比 `sleep(300)` 更安全）。
 *   · 依赖动画时长（`animationend` / `transitionDuration` / `animation-duration` 等）——
 *     动画时长在低端机/高负载下会变，断言窗口随之漂移。
 *
 * 注释里的写法不算（本仓大量注释在解释「为什么删掉了 waitForTimeout」，误报会把警告变成噪音）。
 * 返回 `[{ line, kind, text }]`，`line` 是**原文件行号**（1-based）。
 */
const TIMING_RULES = [
  { kind: 'waitForTimeout', pattern: /\bwaitForTimeout\s*\(/ },
  { kind: 'fixed-sleep', pattern: /\bsleep\s*\(|setTimeout\s*\(\s*[^,)]*,\s*\d+\s*\)/ },
  {
    kind: 'animation-duration',
    pattern: /\b(animationend|transitionend|animationDuration|transitionDuration|animation-duration|transition-duration|ANIMATION_MS|ANIM_MS)\b/,
  },
]

/**
 * 把注释替换成等长空白（保留行号与列位置），这样「注释里的 waitForTimeout」不会被算成写法。
 * `blankStrings` 连字符串内容一起抹掉：`'waitForTimeout(1)'` 是**文本**不是**调用**；
 * 但「动画事件名 / 选择器」本来就活在字符串里（`waitForEvent('animationend')`），
 * 所以动画那条规则要读不抹字符串的版本 —— 由 `scanTimingWindows` 分别取。
 */
export const stripComments = (source = '', { blankStrings = true } = {}) => {
  const text = String(source)
  let out = ''
  let index = 0
  let state = 'code'
  while (index < text.length) {
    const two = text.slice(index, index + 2)
    if (state === 'code') {
      if (two === '//') { state = 'line'; out += '  '; index += 2; continue }
      if (two === '/*') { state = 'block'; out += '  '; index += 2; continue }
      if (text[index] === '"' || text[index] === "'" || text[index] === '`') { state = text[index]; out += text[index]; index += 1; continue }
      out += text[index]
      index += 1
      continue
    }
    if (state === 'line') {
      if (text[index] === '\n') { state = 'code'; out += '\n' } else out += ' '
      index += 1
      continue
    }
    if (state === 'block') {
      if (two === '*/') { state = 'code'; out += '  '; index += 2; continue }
      out += text[index] === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    // 字符串字面量：`blankStrings` 时内容抹成空白 —— `const s = 'waitForTimeout(1)'` 不是「用了固定等待」，
    // 而本仓确实有用例在扫源码文本，放过这些假阳性才知道警告在说什么。
    if (text[index] === '\\') { out += blankStrings ? '  ' : text.slice(index, index + 2); index += 2; continue }
    if (text[index] === state) state = 'code'
    out += blankStrings ? (text[index] === '\n' ? '\n' : ' ') : text[index]
    index += 1
  }
  return out
}

export const scanTimingWindows = (source = '') => {
  // 两版源码各管一类规则：调用类（waitForTimeout / sleep）要抹掉字符串才不误报，
  // 动画类必须保留字符串（事件名与选择器本来就是字符串）。
  const codeOnly = stripComments(source, { blankStrings: true }).split('\n')
  const withStrings = stripComments(source, { blankStrings: false }).split('\n')
  const found = []
  codeOnly.forEach((line, index) => {
    for (const rule of TIMING_RULES) {
      const target = rule.kind === 'animation-duration' ? withStrings[index] : line
      if (!target || !rule.pattern.test(target)) continue
      found.push({ line: index + 1, kind: rule.kind, text: target.trim().slice(0, 160) })
      break
    }
  })
  return found
}
