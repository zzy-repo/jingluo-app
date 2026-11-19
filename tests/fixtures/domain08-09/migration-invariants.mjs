/**
 * N3 迁移不变量表（域 9 · F9-11）的**唯一数据源**。
 *
 * 迁移是**唯一会删用户数据的动作**，而且不可回滚。`config-migration.test.mjs` 已经把 #339
 * 那一次（schema 1→2 清共享 model 残留）钉得很细，但它是**单场景回归**，不是迁移机制的不变量：
 * 一旦 schema 升到 3，没有任何断言保证「只删已知废弃键、表外键一个都不动」。
 *
 * 这张表把契约写成数据：**`schema 版本 → 允许删除的键集合`**（`allowedDeletions`）。
 * 断言在 `tests/unit/domain09-config-migration-invariants.test.mjs`：迁移后
 *   ① 删掉的键 ⊆ allowedDeletions（多删一个即失败）
 *   ② 表外键不但还在、**值也逐字节不变**
 *   ③ 新增的键只能是版本号本身（`chat-demo:config-schema`）
 *
 * 新增 schema 版本时必须在这里补一行，否则 N3-c 的「版本覆盖门禁」直接失败。
 */

export const SCHEMA_KEY = 'chat-demo:config-schema'

/** 一个「1.2.x 老用户」的完整本地状态摸板：迁移只许动 model 这一个键，其余一个都不许碰 */
export const BASELINE = {
  'chat-demo:provider-kind': 'deepseek',
  'chat-demo:api-key': 'sk-test-key-0123456789abcdef',
  'chat-demo:ours-device-id': 'd-0123456789abcdef0123456789abcdef',
  'chat-demo:locale': 'zh-CN',
  'chat-demo:theme-preference': 'dark',
  'chat-demo:reading-font-size': 'large',
  'chat-demo:enter-key-mode': 'modifier-send',
  'chat-demo:thinking-display': 'expanded',
}

export const RESIDUE = 'deepseek-v4.1-flash'
export const RELAY = 'https://legacy-relay.example.com'

/**
 * 一行 = 一种升级前的状态。
 *   - `from`：存储里的版本号（`null` = 没有这个键，按最老的 1 算）
 *   - `seed`：除 BASELINE 之外要额外塞进去的键（覆盖 / 新增）
 *   - `allowedDeletions`：这次迁移**允许**删掉的键
 *   - `allowedAdditions`：这次迁移**允许**新增的**业务**键（版本号 `chat-demo:config-schema`
 *     单独判：它的语义就是「从 N 变成 N+1」，见 N3-a 的 schemaBefore / schemaAfter）
 *   - `expect`：返回值与迁移后的读取结果
 */
export const MIGRATION_CASES = [
  {
    id: 'M1',
    label: '1→2：共享 model 是别的渠道串来的残留 → 清掉它，其余一个都不动',
    from: null,
    seed: { 'chat-demo:model': RESIDUE },
    allowedDeletions: ['chat-demo:model'],
    allowedAdditions: [],
    expect: { clearedModel: RESIDUE, from: 1, to: 2, schema: '2', model: 'deepseek-flash' },
  },
  {
    id: 'M2',
    label: '1→2：老中转仍在用（地址还是用户自填的）→ 模型必须留着',
    from: '1',
    seed: { 'chat-demo:model': 'legacy-relay-model', 'chat-demo:base-url': RELAY },
    allowedDeletions: [],
    allowedAdditions: [],
    expect: { clearedModel: null, from: 1, to: 2, schema: '2', model: 'legacy-relay-model' },
  },
  {
    id: 'M3',
    label: '1→2：本来就没有残留 → 只落版本号',
    from: '1',
    seed: {},
    allowedDeletions: [],
    allowedAdditions: [],
    expect: { clearedModel: null, from: 1, to: 2, schema: '2', model: 'deepseek-flash' },
  },
  {
    id: 'M4',
    label: '1→2：「我们的渠道」下同一份残留也要清（渠道与键无关）',
    from: '1',
    seed: { 'chat-demo:provider-kind': 'ours', 'chat-demo:model': RESIDUE },
    allowedDeletions: ['chat-demo:model'],
    allowedAdditions: [],
    expect: { clearedModel: RESIDUE, from: 1, to: 2, schema: '2', model: 'deepseek-v4.1-flash' },
  },
  {
    id: 'M5',
    label: '2→2：版本号已到顶 → 一个键都不许动（幂等的外层）',
    from: '2',
    seed: { 'chat-demo:model': 'another-old-model' },
    allowedDeletions: [],
    allowedAdditions: [],
    expect: { clearedModel: null, from: 2, to: 2, schema: '2', model: 'deepseek-flash' },
  },
  {
    id: 'M6',
    label: '3→3：未来版本（降级安装 / 手工改过）→ 不动，也不把版本号写回低值',
    from: '3',
    seed: { 'chat-demo:model': 'future-model' },
    allowedDeletions: [],
    allowedAdditions: [],
    expect: { clearedModel: null, from: 3, to: 3, schema: '3', model: 'deepseek-flash' },
  },
]

/** 迁移**永远不许删**的键（从 BASELINE 里挑出来的高价值项：丢账号 / 丢配置） */
export const PROTECTED_KEYS = [
  'chat-demo:provider-kind',
  'chat-demo:api-key',
  'chat-demo:ours-device-id',
  'chat-demo:locale',
  'chat-demo:theme-preference',
  'chat-demo:reading-font-size',
  'chat-demo:enter-key-mode',
  'chat-demo:thinking-display',
]
