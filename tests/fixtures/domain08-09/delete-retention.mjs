/**
 * N7 「删除所有对话」保留口径表（域 9 · F9-12）的**唯一数据源**。
 *
 * 这条用例是破坏性场景：删错了不可回滚，而其中最贵的一条是 **`ours-device-id` 被清 = 丢账号**
 * （#261），其次是设置被清 = 用户要重配一遍。现状：`deleteAllSessions` 在 `tests/**` 里 0 命中，
 * 也就是说「点了删除之后到底还剩什么」从来没有人断言过。
 *
 * 一行 = 一个存储目标，`expect` 只有两种：
 *   - `cleared`：本该被删（会话、附件）
 *   - `kept`：绝不能被删（设置、设备码、API Key、诊断日志）
 */

export const RETENTION_ROWS = [
  {
    id: 'T1',
    fn: 'F9-12',
    label: '会话摘要（IndexedDB sessionSummaries）',
    probe: 'idb-count',
    db: 'chat-demo',
    store: 'sessionSummaries',
    expect: 'cleared',
  },
  {
    id: 'T2',
    fn: 'F9-12',
    label: '会话正文（IndexedDB sessions）',
    probe: 'idb-count',
    db: 'chat-demo',
    store: 'sessions',
    expect: 'cleared',
  },
  {
    id: 'T3',
    fn: 'F9-12',
    label: '会话附件（IndexedDB files / filesStaging）',
    probe: 'idb-count-multi',
    db: 'chat-demo',
    stores: ['files', 'filesStaging', 'sessionsStaging'],
    expect: 'cleared',
  },
  {
    id: 'T4',
    fn: 'F9-12',
    label: '设备码（chat-demo:ours-device-id，丢了 = 丢账号）',
    probe: 'storage-keep',
    key: 'chat-demo:ours-device-id',
    expect: 'kept',
  },
  {
    id: 'T5',
    fn: 'F9-12',
    label: 'API Key（chat-demo:api-key）',
    probe: 'storage-keep',
    key: 'chat-demo:api-key',
    expect: 'kept',
  },
  {
    id: 'T6',
    fn: 'F9-12',
    label: '设置（主题 / 阅读 / 回车 / 渠道）',
    probe: 'storage-keep-many',
    keys: [
      'chat-demo:theme-preference',
      'chat-demo:reading-font-size',
      'chat-demo:enter-key-mode',
      'chat-demo:provider-kind',
      'chat-demo:config-schema',
    ],
    expect: 'kept',
  },
  {
    id: 'T7',
    fn: 'F9-12',
    label: '诊断日志（chat-diagnostics/logs，含删除前写入的那条哨兵）',
    probe: 'diagnostics-kept',
    expect: 'kept',
  },
  {
    id: 'T8',
    fn: 'F9-12',
    label: '未发送的输入草稿（清会话时一并丢弃）',
    probe: 'composer-cleared',
    expect: 'cleared',
  },
]

/** 删除前要写进 localStorage 的「用户已经配好一切」状态 */
export const SEED_STORAGE = {
  'chat-demo:api-key': 'sk-n7-retention-0123456789abcdef',
  'chat-demo:ours-device-id': 'd-0123456789abcdef0123456789abcdef',
  'chat-demo:theme-preference': 'dark',
  'chat-demo:reading-font-size': 'large',
  'chat-demo:enter-key-mode': 'modifier-send',
  'chat-demo:provider-kind': 'deepseek',
}

/** 删除前写的一条哨兵日志：删除动作之后必须还读得到（诊断日志不受影响） */
export const SENTINEL_LOG = 'n7-retention-sentinel'
