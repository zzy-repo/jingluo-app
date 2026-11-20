/**
 * N4 日志自检表（域 8 · F8-06）的**唯一数据源**。
 *
 * 「检查日志完整性」按钮背后是 `services/diagnostics/index.ts` 的 `analyze()`：
 * 条数 / 时间跨度 / 事件类型覆盖 / 缺失项 → 三条提示（`few_logs` / `no_network` / `short_span`）。
 * 现有断言只在 L1（真产物 + DOM）里跑，阈值本体没有 L0 覆盖；本表把
 * **缓冲区形态 → 提示集合 + 缺失 kind + 是否自动补快照** 写成数据。
 *
 * 判据口径（源码 `analyze()`，改动它会立刻被这张表拦下）：
 *   - `count < 10`               → `few_logs`
 *   - 没有任何 `net_request` / `net_response` / `net_error` → `no_network`
 *   - `spanMs = 末条 t − 首条 t < 1000` → `short_span`（首条/末条按数组顺序，不排序）
 *   - `missing` = EXPECTED_KINDS 里这次没出现过的类型
 */

/** 建议每条反馈里都能看到的类型（与源码 EXPECTED_KINDS 同源，改动要同步这张表） */
export const EXPECTED_KINDS = ['app_launch', 'state_snapshot', 'nav', 'net_request', 'net_response']

const entry = (t, kind) => ({ t, kind, level: 'info', msg: `${kind}@${t}` })

/** 按 kind 序列铺时间线：`stepMs` 为相邻两条的间隔（第一条 t0） */
const timeline = (kinds, { t0 = 1_700_000_000_000, stepMs = 500 } = {}) =>
  kinds.map((kind, index) => entry(t0 + index * stepMs, kind))

const FULL = ['app_launch', 'state_snapshot', 'nav', 'net_request', 'net_response']
/** 重复铺满：把 kinds 循环铺到 n 条 */
const fill = (kinds, n, options) => timeline(Array.from({ length: n }, (_, index) => kinds[index % kinds.length]), options)

export const COVERAGE_CASES = [
  {
    id: 'B1',
    label: '空缓冲区（刚装完就点自检）',
    logs: [],
    expect: { count: 0, spanMs: 0, warnings: ['few_logs', 'no_network', 'short_span'], missing: EXPECTED_KINDS },
  },
  {
    id: 'B2',
    label: '只有 1 条 app_launch',
    logs: timeline(['app_launch']),
    expect: { count: 1, spanMs: 0, warnings: ['few_logs', 'no_network', 'short_span'], missing: EXPECTED_KINDS.slice(1) },
  },
  {
    id: 'B3',
    label: '条数够、有网络、跨度够，但缺 net_response',
    logs: fill(['app_launch', 'state_snapshot', 'nav', 'net_request'], 12, { stepMs: 400 }),
    expect: { count: 12, spanMs: 4400, warnings: [], missing: ['net_response'] },
  },
  {
    id: 'B4',
    label: '网络失败（net_error）也算有网络记录；缺 state_snapshot',
    logs: fill(['app_launch', 'nav', 'net_error', 'net_response'], 12, { stepMs: 300 }),
    expect: { count: 12, spanMs: 3300, warnings: [], missing: ['state_snapshot', 'net_request'] },
  },
  {
    id: 'B5',
    label: '五个建议类型齐全 + 跨度够 → 一条提示都没有',
    logs: fill(FULL, 10, { stepMs: 500 }),
    expect: { count: 10, spanMs: 4500, warnings: [], missing: [] },
  },
  {
    id: 'B6',
    label: '条数边界：9 条（差一条就提示 few_logs）',
    logs: fill(FULL, 9, { stepMs: 500 }),
    expect: { count: 9, spanMs: 4000, warnings: ['few_logs'], missing: [] },
  },
  {
    id: 'B7',
    label: '跨度边界：999ms（差 1ms 就提示 short_span）',
    logs: fill(FULL, 10, { stepMs: 111 }),
    expect: { count: 10, spanMs: 999, warnings: ['short_span'], missing: [] },
  },
  {
    id: 'B8',
    label: '跨度边界：刚好过 1000ms（不提示）',
    logs: fill(FULL, 10, { stepMs: 112 }),
    expect: { count: 10, spanMs: 1008, warnings: [], missing: [] },
  },
  {
    id: 'B9',
    label: '没有任何网络记录（纯 UI 会话）',
    logs: fill(['app_launch', 'state_snapshot', 'nav'], 20, { stepMs: 600 }),
    expect: { count: 20, spanMs: 11400, warnings: ['no_network'], missing: ['net_request', 'net_response'] },
  },
  {
    id: 'B10',
    label: '时钟倒退（末条比首条早）→ 跨度算出来是负数，按 short_span 提示',
    logs: [
      ...fill(FULL, 11, { stepMs: 500 }),
      entry(1_700_000_000_000 - 500, 'net_response'),
    ],
    expect: { count: 12, spanMs: -500, warnings: ['short_span'], missing: [] },
  },
]

/** `validatePayload` 的两行：缺 state_snapshot 时自动补一条（只补快照，不阻断提交） */
export const VALIDATE_CASES = [
  {
    id: 'P1',
    label: '缺 state_snapshot → 自动补一条，payload 被动过',
    logs: fill(['app_launch', 'nav', 'net_request', 'net_response'], 12, { stepMs: 400 }),
    expect: { appended: true, warnings: [], prefixPreserved: true },
  },
  {
    id: 'P2',
    label: '已有 state_snapshot → 一条都不补',
    logs: fill(FULL, 12, { stepMs: 400 }),
    expect: { appended: false, warnings: [], prefixPreserved: true },
  },
  {
    id: 'P3',
    label: '提示项不阻断：日志再少也照样返回 warnings 而不是抛错',
    logs: [],
    expect: { appended: true, warnings: ['few_logs', 'no_network', 'short_span'], prefixPreserved: true },
  },
]
