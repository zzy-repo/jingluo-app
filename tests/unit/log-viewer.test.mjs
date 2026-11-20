// [layer: unit | 依赖: 无（纯 Node） | Issue #305]
//
// 回归对象：日志展示层 `src/components/settings/logView.ts`（过滤 / 搜索 / 分组 / 单条复制文本）。
//
// 为什么是 `.ts` 而不是 `.tsx`：#189 的教训 —— 展示逻辑写死在组件 JSX 里就只能开浏览器肉眼验，
// 「过滤后到底是几条」永远没有断言。这里测的是**生产同一份代码**，UI 只负责把结果画出来。
//
// 覆盖：#305 验收里的「每条交互都有断言」在纯逻辑侧的对应部分 + 三条负向用例
// （零条 / 超长 meta / 需脱敏 URL 由采集层负责，这里断言展示层不重复脱敏也不崩）。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_FILTER,
  GROUP_GAP_MS,
  buildLogView,
  entryMatchesQuery,
  familyOf,
  filterLogs,
  formatEntryForCopy,
  formatLogTimePrecise,
  groupByOperation,
  isFilterActive,
  kindsPresent,
  matchesFilter,
  toggleSelection,
} from '../../src/components/settings/logView.ts'

/** 造一条日志：`t` 用基准时间 + 偏移，避免依赖真实时钟 */
const BASE = 1_700_000_000_000
const entry = (t, kind, level, msg, meta) => ({
  t: BASE + t,
  kind,
  level,
  msg,
  ...(meta ? { meta } : {}),
})

test('关键字搜索：命中 msg 与 meta 值，不命中 meta 键名，大小写不敏感', () => {
  const target = entry(0, 'net_error', 'error', 'request error: GET api/v1/chat', {
    'url.path': '/v1/chat',
    'http.status': 502,
    reason: 'timeout',
  })
  assert.equal(entryMatchesQuery(target, 'request error'), true, 'msg 命中')
  assert.equal(entryMatchesQuery(target, '/V1/CHAT'), true, 'meta 值命中且大小写不敏感')
  assert.equal(entryMatchesQuery(target, '502'), true, '数字型 meta 值也要能搜到')
  assert.equal(entryMatchesQuery(target, 'url.path'), false, '只搜值，不搜键名（否则搜 stage 会命中所有条目）')
  assert.equal(entryMatchesQuery(target, 'timeout'), true, '字符串 meta 命中')
  assert.equal(entryMatchesQuery(target, 'nope'), false)
  assert.equal(entryMatchesQuery(target, ''), true, '空查询不过滤')
  assert.equal(entryMatchesQuery(target, '   '), true, '纯空白不过滤')
})

test('关键字搜索：正则元字符与超长查询串按字面量处理，不抛异常', () => {
  const target = entry(0, 'error', 'error', 'boom .*[unclosed(')
  assert.equal(entryMatchesQuery(target, '.*[unclosed('), true, '正则元字符按字面量匹配')
  assert.equal(entryMatchesQuery(target, '.*[a-c]+'), false, '不会被当成正则去匹配')
  assert.equal(entryMatchesQuery(target, 'x'.repeat(5000)), false, '5000 字符查询不崩')
  assert.equal(entryMatchesQuery(target, '💥'), false, 'emoji 查询不崩')
})

test('筛选：kind / level / 关键字取交集，空数组表示不限', () => {
  const logs = [
    entry(0, 'net_error', 'error', 'net fail', { 'http.status': 500 }),
    entry(1, 'net_response', 'info', 'net ok', { 'http.status': 200 }),
    entry(2, 'chat_send', 'info', 'send'),
    entry(3, 'warning', 'warn', 'slow net'),
  ]
  const onlyNetError = filterLogs(logs, { kinds: ['net_error'], levels: [], query: '' })
  assert.equal(onlyNetError.length, 1)
  const onlyErrorLevel = filterLogs(logs, { kinds: [], levels: ['error'], query: '' })
  assert.equal(onlyErrorLevel.length, 1, 'error 级只有一条')
  const netKeyword = filterLogs(logs, { kinds: [], levels: [], query: 'net' })
  assert.equal(netKeyword.length, 3, 'msg 里带 net 的三条')
  const combined = filterLogs(logs, { kinds: ['net_response'], levels: ['info'], query: '200' })
  assert.equal(combined.length, 1, '三条条件同时收窄')
  const contradiction = filterLogs(logs, { kinds: ['net_error'], levels: ['info'], query: '' })
  assert.equal(contradiction.length, 0, '矛盾条件返回空集而不是报错')
  assert.equal(matchesFilter(logs[0], EMPTY_FILTER), true, '空筛选全通过')
  assert.equal(filterLogs([], EMPTY_FILTER).length, 0, '零条输入返回零条')
})

test('筛选状态：任一条件收敛才算 active（决定是否给「清除筛选」入口）', () => {
  assert.equal(isFilterActive(EMPTY_FILTER), false)
  assert.equal(isFilterActive({ kinds: [], levels: [], query: '   ' }), false, '纯空白不算收敛')
  assert.equal(isFilterActive({ kinds: ['nav'], levels: [], query: '' }), true)
  assert.equal(isFilterActive({ kinds: [], levels: ['error'], query: '' }), true)
  assert.equal(isFilterActive({ kinds: [], levels: [], query: 'x' }), true)
})

test('kind 选项：只列出现过的类型，按出现次数降序、同次数按首次出现顺序', () => {
  const logs = [
    entry(0, 'nav', 'info', 'a'),
    entry(1, 'net_request', 'info', 'b'),
    entry(2, 'net_request', 'info', 'c'),
    entry(3, 'error', 'error', 'd'),
    entry(4, 'net_request', 'info', 'e'),
    entry(5, 'nav', 'info', 'f'),
  ]
  assert.deepEqual(kindsPresent(logs), ['net_request', 'nav', 'error'])
  assert.deepEqual(kindsPresent([]), [], '零条时没有可选项')
})

test('chip 多选开关：已选则移除，未选则追加，且不改原数组', () => {
  const selected = ['error']
  const added = toggleSelection(selected, 'warn')
  assert.deepEqual(added, ['error', 'warn'])
  assert.deepEqual(selected, ['error'], '原数组不被修改')
  assert.deepEqual(toggleSelection(added, 'error'), ['warn'])
})

test('分组：同族连续条目并成一组，跨族/超过间隔/同族第二个起点都切新组', () => {
  const logs = [
    // 一次对话：send → first_token → done（同族，间隔 800ms）
    entry(0, 'chat_send', 'info', 'send', { action: 'chat-send' }),
    entry(800, 'chat_first_token', 'info', 'first token'),
    entry(1500, 'chat_done', 'info', 'done'),
    // 一次网络请求：request → response
    entry(2000, 'net_request', 'info', 'request: POST'),
    entry(2400, 'net_response', 'info', 'response: 200'),
    // 权威证据：间隔超过窗口就切新组
    entry(2400 + GROUP_GAP_MS + 1, 'nav', 'info', 'action: click:设置'),
    // 同族第二次起点：又一次请求，哪怕紧接着也切新组
    entry(5000, 'net_request', 'info', 'request: GET'),
    entry(5100, 'warning', 'warn', 'slow', { stage: 'fetch-hook' }),
  ]
  const groups = groupByOperation(logs)
  assert.deepEqual(
    groups.map((group) => ({ family: group.family, count: group.items.length })),
    [
      { family: 'chat', count: 3 },
      { family: 'net', count: 2 },
      { family: 'misc', count: 1 },
      { family: 'net', count: 2 },
    ]
  )
  assert.equal(groups[3].items[1].kind, 'warning', 'misc 条目并入当前组，不另起一组')
  assert.equal(groups[0].items[0].msg, 'send', '组内保持时间正序')
})

test('分组：时间倒退也切新组（时钟回拨不许把两组混成一组）', () => {
  const logs = [
    entry(10000, 'chat_send', 'info', 'send'),
    entry(9000, 'chat_done', 'info', 'done'),
  ]
  assert.equal(groupByOperation(logs).length, 2)
})

test('分组：空数组不产生空组', () => {
  assert.deepEqual(groupByOperation([]), [])
})

test('familyOf：chat_/net_/import_ 三族，其余归 misc', () => {
  assert.equal(familyOf('chat_first_token'), 'chat')
  assert.equal(familyOf('net_error'), 'net')
  assert.equal(familyOf('import_stage'), 'import')
  assert.equal(familyOf('state_snapshot'), 'misc')
  assert.equal(familyOf('app_launch'), 'misc')
})

test('单条复制：含时间到毫秒、level、kind、正文与**完整** meta', () => {
  const target = entry(1234, 'net_error', 'error', 'request error: GET api/v1/chat', {
    'url.path': '/v1/chat',
    'http.status': 502,
    requestId: 'req-abc-123',
    durationMs: 5230,
    aborted: false,
  })
  const text = formatEntryForCopy(target)
  const lines = text.split('\n')
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\.\d{3} \[error\] net_error {2}request error: GET api\/v1\/chat$/)
  assert.equal(lines[1], 'meta:')
  assert.deepEqual(lines.slice(2), [
    '  url.path = /v1/chat',
    '  http.status = 502',
    '  requestId = req-abc-123',
    '  durationMs = 5230',
    '  aborted = false',
  ])
  for (const key of Object.keys(target.meta)) {
    assert.ok(text.includes(key), `复制文本必须包含 meta 键 ${key}`)
  }
  assert.ok(text.includes('req-abc-123'), '复制文本必须包含 requestId 的值')
})

test('单条复制：没有 meta 时不写空的 meta 段', () => {
  const text = formatEntryForCopy(entry(0, 'nav', 'info', 'action: click'))
  assert.equal(text.split('\n').length, 1)
  assert.equal(text.includes('meta:'), false)
  assert.equal(formatEntryForCopy(entry(0, 'nav', 'info', 'x', {})).includes('meta:'), false, '空 meta 也不写段')
})

test('单条复制（负向）：meta 值里的换行折成 \\n 字面量，一个键仍占一行', () => {
  const text = formatEntryForCopy(entry(0, 'error', 'error', 'boom', { 'error.stack': 'line1\nline2\r\nline3' }))
  const lines = text.split('\n')
  assert.equal(lines.length, 3, '换行不许把一条 meta 拆成多行')
  assert.equal(lines[2], '  error.stack = line1\\nline2\\nline3')
})

test('单条复制（负向）：超长 meta 值与异常类型都不崩', () => {
  const huge = 'x'.repeat(5000)
  const text = formatEntryForCopy(entry(0, 'nav', 'info', 'long', { big: huge }))
  assert.ok(text.includes(huge), '展示层不二次截断（截断是采集层的职责），值原样复制')
  // 采集层理论上只写 string|number|boolean，但历史落盘数据/后端回灌可能有别的形状：
  // 这里只要求不抛异常，且值退化成可读文本。
  const weird = formatEntryForCopy({
    t: BASE,
    kind: 'nav',
    level: 'info',
    msg: 'weird',
    meta: { obj: { a: 1 }, nil: null, arr: [1, 2] },
  })
  assert.ok(weird.includes('meta:'))
  assert.ok(weird.includes('obj = {"a":1}'), `对象值要能序列化：${weird}`)
  assert.ok(weird.includes('nil = '), 'null 退化成空串而不是 "null"')
})

test('单条复制：非法时间戳不抛异常', () => {
  assert.equal(formatLogTimePrecise(Number.NaN), '--:--:--.---')
})

test('预览视图：口径文案的三个数字与真实渲染行数一致', () => {
  const logs = Array.from({ length: 120 }, (_, index) =>
    entry(index * 10, index % 2 === 0 ? 'net_request' : 'net_response', 'info', `entry ${index}`)
  )
  const view = buildLogView(logs, EMPTY_FILTER, 50)
  assert.equal(view.total, 120, 'total = 缓冲区总条数')
  assert.equal(view.matchedCount, 120, '没筛选时匹配数 = 总数')
  assert.equal(view.shownCount, 50, 'shownCount 就是实际渲染行数')
  assert.equal(view.entries.length, 50)
  assert.equal(view.truncated, true)
  assert.equal(view.entries.at(-1).msg, 'entry 119', '截断取**末尾**（最近）的那批')
  assert.equal(view.entries[0].msg, 'entry 70')
})

test('预览视图：筛选后不足上限时不标截断，匹配数单独计数', () => {
  const logs = Array.from({ length: 60 }, (_, index) =>
    entry(index * 10, index < 3 ? 'import_error' : 'nav', index < 3 ? 'error' : 'info', `e${index}`)
  )
  const view = buildLogView(logs, { kinds: ['import_error'], levels: [], query: '' }, 50)
  assert.equal(view.total, 60)
  assert.equal(view.matchedCount, 3)
  assert.equal(view.shownCount, 3)
  assert.equal(view.truncated, false)
})

test('预览视图：分组基于截断后的条目（界面上的组必须能对上可见行）', () => {
  const logs = Array.from({ length: 60 }, (_, index) =>
    entry(index * 500, 'chat_send', 'info', `send ${index}`)
  )
  const view = buildLogView(logs, EMPTY_FILTER, 10)
  const inGroups = view.groups.reduce((sum, group) => sum + group.items.length, 0)
  assert.equal(inGroups, view.shownCount, '分组里条数之和 = 渲染行数')
})

test('预览视图（负向）：零条日志给出全零视图，不产生空组也不崩', () => {
  const view = buildLogView([], EMPTY_FILTER, 50)
  assert.deepEqual(
    { total: view.total, matched: view.matchedCount, shown: view.shownCount, truncated: view.truncated },
    { total: 0, matched: 0, shown: 0, truncated: false }
  )
  assert.deepEqual(view.groups, [])
  assert.deepEqual(view.entries, [])
})

test('预览视图：limit 非法时退化成「不截断」而不是渲染 0 条', () => {
  const logs = [entry(0, 'nav', 'info', 'a'), entry(10, 'nav', 'info', 'b')]
  assert.equal(buildLogView(logs, EMPTY_FILTER, 0).shownCount, 2)
  assert.equal(buildLogView(logs, EMPTY_FILTER, Number.NaN).shownCount, 2)
  assert.equal(buildLogView(logs, EMPTY_FILTER, -5).shownCount, 2)
})
