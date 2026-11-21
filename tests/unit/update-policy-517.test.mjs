// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// 更新策略（Issue #517）：服务端下发「强制 / 软性 / 普通」+ 客户端容错判定 + snooze 存储。
//
// 为什么这些断言全在 L0：整条链路是**纯判定** —— 「这次该不该强制」「snooze 期内还弹不弹」
// 都能用一次函数调用问清楚，不需要真弹窗、真清单、真等待。真浏览器的部分（返回键 / Esc / 点遮罩
// 到底关不关得掉）在 `tests/integration/update-dialog-517.test.mjs`，两层不重叠。
//
// 表驱动：一行 = #517 验收表的一格。红了一行就看得到是哪一格，不用翻断言编号。
//
// 负向对照（验收时会真的做一遍，见 PR 说明）：把 `resolveUpdatePolicy` 里「最低支持版本优先于 mode」
// 那段删掉 → `below-minimum-*` 三行必红；把 `expiresAt` 那段删掉 → `expired-*` 两行必红。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule, setupDom } from '../helpers/dom-env.mjs'

installTsResolve()

/** settings.ts 的读写走 localStorage：先给它一个最小替身，再加载模块 */
const dom = setupDom()

const {
  DEFAULT_SNOOZE_HOURS,
  DEFAULT_UPDATE_POLICY,
  MAX_SNOOZE_HOURS,
  MIN_SNOOZE_HOURS,
  isSnoozed,
  parseUpdatePolicy,
  resolveUpdatePolicy,
  resolveUpdatePrompt,
  snoozeDeadline,
} = await loadTsModule('src/services/updatePolicy.ts')
const { parseManifest } = await loadTsModule('src/services/updateManifest.ts')
const { setUpdateSnoozeUntil, useSettings } = await loadTsModule('src/services/settings.ts')

/** 固定的「现在」：所有时间断言都用它，不靠真实时钟 */
const NOW = Date.parse('2026-11-21T10:00:00+08:00')
const HOUR = 60 * 60 * 1000

/** 表驱动执行的公共外壳：行 id 进断言信息，红了直接看到是哪一格 */
const table = (rows) => (name, run) =>
  test(name, () => {
    for (const row of rows) {
      run(row)
    }
  })

// ---------------------------------------------------------------- 1) 判定顺序

const RESOLVE_CASES = [
  {
    id: 'below-minimum-wins-over-normal',
    why: 'versionCode < minSupportedVersionCode 时，即使 mode:"normal" 也必须判 forced（下限优先于 mode）',
    policy: { mode: 'normal', minSupportedVersionCode: 14020 },
    current: 14010,
    expect: { mode: 'forced', basis: 'below-minimum' },
  },
  {
    id: 'below-minimum-wins-over-soft',
    why: '同上，下限也优先于 soft',
    policy: { mode: 'soft', minSupportedVersionCode: 14020 },
    current: 14010,
    expect: { mode: 'forced', basis: 'below-minimum' },
  },
  {
    id: 'mode-forced',
    why: '服务端显式表态 mode:"forced" → 强制',
    policy: { mode: 'forced' },
    current: 14010,
    expect: { mode: 'forced', basis: 'mode' },
  },
  {
    id: 'mode-soft',
    why: 'mode:"soft" → 软性（可稍后提醒）',
    policy: { mode: 'soft' },
    current: 14010,
    expect: { mode: 'soft', basis: 'mode' },
  },
  {
    id: 'mode-normal',
    why: 'mode:"normal" → 普通（可随时关闭）',
    policy: { mode: 'normal' },
    current: 14010,
    expect: { mode: 'normal', basis: 'mode' },
  },
  {
    id: 'reaches-floor-exactly',
    why: 'versionCode 正好等于下限不算「低于」，按 mode 走（边界只认严格小于）',
    policy: { mode: 'normal', minSupportedVersionCode: 14010 },
    current: 14010,
    expect: { mode: 'normal', basis: 'mode' },
  },
  {
    id: 'above-floor',
    why: '高于下限 → 按 mode',
    policy: { mode: 'soft', minSupportedVersionCode: 14000 },
    current: 14010,
    expect: { mode: 'soft', basis: 'mode' },
  },
  {
    id: 'missing-mode',
    why: '策略里没有 mode（只下发下限）→ 没触发下限时回落 normal，不锁用户',
    policy: { minSupportedVersionCode: 14000 },
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'invalid-mode-word',
    why: 'mode 写了不存在的词 → normal（绝不允许脏数据把用户锁死在强制弹窗里）',
    policy: { mode: 'HARD!' },
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'invalid-mode-type',
    why: 'mode 不是字符串（数字 / 布尔 / 对象）→ normal',
    policy: { mode: 1 },
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'policy-is-garbage-string',
    why: '整份策略不是对象（清单被写脏）→ normal',
    policy: 'forced',
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'policy-is-array',
    why: '整份策略是数组 → normal',
    policy: [{ mode: 'forced' }],
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'policy-absent',
    why: '清单条目根本没带策略 → normal',
    policy: undefined,
    current: 14010,
    expect: { mode: 'normal', basis: 'default' },
  },
  {
    id: 'unknown-current-version',
    why: '本机版本号读不出来（0）时不做下限判断：读不出自己的版本不是「你必须升级」的证据',
    policy: { mode: 'normal', minSupportedVersionCode: 14020 },
    current: 0,
    expect: { mode: 'normal', basis: 'mode' },
  },
  {
    id: 'expired-forced',
    why: '策略过期后一律按 normal（#517 §四.3：陈旧缓存 / 误配不许把用户永久锁死）',
    policy: { mode: 'forced', expiresAt: '2026-11-20T10:00:00+08:00' },
    current: 14010,
    expect: { mode: 'normal', basis: 'expired' },
  },
  {
    id: 'expired-below-minimum',
    why: '过期连「最低支持版本」一起失效 —— 想继续强制就重新下发一条未过期的策略',
    policy: {
      mode: 'normal',
      minSupportedVersionCode: 14020,
      expiresAt: '2026-11-20T10:00:00+08:00',
    },
    current: 14010,
    expect: { mode: 'normal', basis: 'expired' },
  },
  {
    id: 'not-expired-forced',
    why: '未过期 → 照旧强制',
    policy: { mode: 'forced', expiresAt: '2027-01-01T00:00:00+08:00' },
    current: 14010,
    expect: { mode: 'forced', basis: 'mode' },
  },
  {
    id: 'alias-hard',
    why: '服务端契约草稿写的是 mode:"hard" —— 别名也认（不认就等于静默退化成普通更新）',
    policy: { mode: 'hard' },
    current: 14010,
    expect: { mode: 'forced', basis: 'mode' },
  },
  {
    id: 'alias-none',
    why: 'mode:"none" 是草稿里的「普通」，等价 normal',
    policy: { mode: 'none' },
    current: 14010,
    expect: { mode: 'normal', basis: 'mode' },
  },
  {
    id: 'alias-min-version-code',
    why: '下限的别名 minVersionCode 也认（草稿写法）',
    policy: { mode: 'soft', minVersionCode: 14020 },
    current: 14010,
    expect: { mode: 'forced', basis: 'below-minimum' },
  },
  {
    id: 'wrapped-in-record',
    why: '传入整条清单记录（带 updatePolicy）也认 —— 调用点不必先自己拆一层',
    policy: { updatePolicy: { mode: 'soft' } },
    current: 14010,
    expect: { mode: 'soft', basis: 'mode' },
  },
  {
    id: 'wrapped-with-policy-key',
    why: '整条记录用草稿的 policy 字段也认',
    policy: { policy: { mode: 'hard', minVersionCode: 14020 } },
    current: 14010,
    expect: { mode: 'forced', basis: 'below-minimum' },
  },
  {
    id: 'invalid-floor-type',
    why: '下限不是正整数（字符串 "abc" / 负数 / 小数）→ 当作没设下限，不因此强制',
    policy: { mode: 'normal', minSupportedVersionCode: 'abc' },
    current: 14010,
    expect: { mode: 'normal', basis: 'mode' },
  },
]

test('resolveUpdatePolicy：判定顺序（下限 > mode > 过期 > 默认）', () => {
  for (const row of RESOLVE_CASES) {
    const result = resolveUpdatePolicy(row.policy, row.current, NOW)
    assert.equal(
      result.mode,
      row.expect.mode,
      `[${row.id}] ${row.why} —— mode 应为 ${row.expect.mode}，实际 ${result.mode}`
    )
    assert.equal(
      result.basis,
      row.expect.basis,
      `[${row.id}] ${row.why} —— 判定依据应为 ${row.expect.basis}，实际 ${result.basis}`
    )
  }
})

test('parseUpdatePolicy：缺省与脏字段都有安全默认', () => {
  // 缺省值就是「普通更新 + 24h + 无下限」：这是所有异常路径的落点，单独钉一次
  assert.deepEqual(
    { ...DEFAULT_UPDATE_POLICY },
    { mode: 'normal', minSupportedVersionCode: 0, snoozeHours: DEFAULT_SNOOZE_HOURS },
    '缺省策略必须是 normal / 无下限 / 24h'
  )
  assert.equal(parseUpdatePolicy(undefined).mode, 'normal', '没下发 → normal')
  assert.equal(parseUpdatePolicy({}).mode, 'normal', '空对象 → normal')
  // 暂缓时长夹取：0 会让「稍后提醒」形同虚设，过大又是永久静默
  assert.equal(
    parseUpdatePolicy({ snoozeHours: 0 }).snoozeHours,
    MIN_SNOOZE_HOURS,
    '0 小时应夹到下限'
  )
  assert.equal(
    parseUpdatePolicy({ snoozeHours: -5 }).snoozeHours,
    MIN_SNOOZE_HOURS,
    '负数应夹到下限'
  )
  assert.equal(
    parseUpdatePolicy({ snoozeHours: 99999 }).snoozeHours,
    MAX_SNOOZE_HOURS,
    '过大应夹到上限'
  )
  assert.equal(
    parseUpdatePolicy({ snoozeHours: 'abc' }).snoozeHours,
    DEFAULT_SNOOZE_HOURS,
    '非数字 → 默认 24h'
  )
  assert.equal(parseUpdatePolicy({ snoozeHours: '6' }).snoozeHours, 6, '数字字符串照数字处理')
  // 原因文案：超长直接丢弃（不让服务端一句话把弹窗撑爆）
  assert.equal(
    parseUpdatePolicy({ reason: 'x'.repeat(501) }).reason,
    undefined,
    '超长 reason 应丢弃'
  )
  assert.equal(
    parseUpdatePolicy({ reason: '当前版本存在严重缺陷' }).reason,
    '当前版本存在严重缺陷',
    '正常 reason 保留'
  )
  // 非法过期时间当作没下发（不因此强制，也不因此过期）
  assert.equal(
    parseUpdatePolicy({ expiresAt: 'not-a-date' }).expiresAt,
    undefined,
    '非法 expiresAt 应丢弃'
  )
})

// ---------------------------------------------------------------- 2) snooze

test('snooze：到期时刻与「是否仍在期内」的边界', () => {
  assert.equal(snoozeDeadline(NOW, 24), NOW + 24 * HOUR, '到期时刻 = now + snoozeHours 小时')
  assert.equal(snoozeDeadline(NOW, 0), NOW + MIN_SNOOZE_HOURS * HOUR, '0 小时同样夹到下限')
  assert.equal(isSnoozed(NOW + 1, NOW), true, '未来时刻 = 仍在 snooze 期内')
  assert.equal(isSnoozed(NOW, NOW), false, '刚好到点 = 已过期（可以弹）')
  assert.equal(isSnoozed(NOW - 1, NOW), false, '过去时刻 = 已过期')
  // 脏值一律按「没暂缓」：宁可多弹一次，也不要因为一个坏时间戳永远不弹
  for (const bad of [0, -1, Number.NaN, undefined, null]) {
    assert.equal(isSnoozed(bad, NOW), false, `脏 snooze 值 ${String(bad)} 应按「没暂缓」处理`)
  }
})

const PROMPT_CASES = [
  {
    id: 'soft-in-snooze',
    why: 'soft 弹过之后、snooze 期内不再弹',
    policy: { mode: 'soft', snoozeHours: 24 },
    snoozedUntil: NOW + 2 * HOUR,
    expect: { show: false, mode: 'soft' },
  },
  {
    id: 'soft-snooze-over',
    why: 'snooze 到期后重新弹（手动检查也能看到）',
    policy: { mode: 'soft', snoozeHours: 24 },
    snoozedUntil: NOW - 1,
    expect: { show: true, mode: 'soft' },
  },
  {
    id: 'soft-never-snoozed',
    why: '没暂缓过 → 弹',
    policy: { mode: 'soft' },
    snoozedUntil: 0,
    expect: { show: true, mode: 'soft' },
  },
  {
    id: 'forced-ignores-snooze',
    why: 'forced 不许「稍后」：写在存储里的 snooze 对强制更新无效',
    policy: { mode: 'forced' },
    snoozedUntil: NOW + 48 * HOUR,
    expect: { show: true, mode: 'forced' },
  },
  {
    id: 'normal-ignores-snooze',
    why: 'normal 本来就随时可关，snooze 不参与（下次检查照常提示）',
    policy: { mode: 'normal' },
    snoozedUntil: NOW + 48 * HOUR,
    expect: { show: true, mode: 'normal' },
  },
  {
    id: 'dirty-policy-with-snooze',
    why: '策略脏 → normal，且不会被一条脏 snooze 变成「永远不弹」',
    policy: 'garbage',
    snoozedUntil: NOW + 48 * HOUR,
    expect: { show: true, mode: 'normal' },
  },
]

test('resolveUpdatePrompt：snooze 只挡 soft', () => {
  for (const row of PROMPT_CASES) {
    const decision = resolveUpdatePrompt({
      policy: row.policy,
      currentVersionCode: 14010,
      snoozedUntil: row.snoozedUntil,
      now: NOW,
    })
    assert.equal(
      decision.mode,
      row.expect.mode,
      `[${row.id}] ${row.why} —— 档位应为 ${row.expect.mode}`
    )
    assert.equal(
      decision.show,
      row.expect.show,
      `[${row.id}] ${row.why} —— show 应为 ${row.expect.show}`
    )
  }
})

// ---------------------------------------------------------------- 3) 清单解析（两条取数路径共用）

const ROW = {
  version: '1.4.4',
  versionCode: 14040,
  size: 5_452_595,
  file: 'apk/deepseek-chat-1.4.4.apk',
  changes: ['修复旧机型白屏'],
  buildType: 'stable',
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
}

test('parseManifest：策略与发布时间都能从条目上读出来（原生 manifest() 与 fetchManifest 同一条解析）', () => {
  // 原生 `AppUpdatePlugin.manifest()` 回的是**原始 body 字符串**，JS 侧同样走 parseManifest；
  // 所以这里用「原生会拿到的 body」形状断言一次就覆盖了两条取数路径。
  const nativeBody = JSON.stringify({
    releases: [
      {
        ...ROW,
        releasedAt: '2026-11-20T10:00:00+08:00',
        updatePolicy: {
          mode: 'forced',
          minSupportedVersionCode: 14020,
          snoozeHours: 12,
          reason: '当前版本存在严重缺陷',
        },
      },
    ],
  })
  const [row] = parseManifest(JSON.parse(nativeBody))
  assert.equal(row.updatePolicy.mode, 'forced', '解析后应带上策略（原生 / 公网 / 私有同一份解析）')
  assert.equal(row.updatePolicy.minSupportedVersionCode, 14020, '下限要原样带出来')
  assert.equal(row.updatePolicy.snoozeHours, 12, '暂缓时长要原样带出来')
  assert.equal(row.updatePolicy.reason, '当前版本存在严重缺陷', '原因文案要带出来')
  assert.equal(row.releasedAt, '2026-11-20T10:00:00+08:00', 'releasedAt（线上真字段名）要带出来')

  // 没下发策略 → 不带 updatePolicy（界面据此判断「弹不弹策略弹窗」，见 AppUpdateField 的 prompt）
  const [plain] = parseManifest({ releases: [ROW] })
  assert.equal(
    plain.updatePolicy,
    undefined,
    '没下发策略时 updatePolicy 必须是 undefined（不能凭空造一个默认对象）'
  )
  assert.equal(plain.releasedAt, undefined, '没有发布时间就不带这个字段，界面显示「未提供」')

  // 脏策略 / 脏时间**不许整条拒收**（那会让用户连更新都检查不出来），只丢脏字段
  const [dirty] = parseManifest({
    releases: [{ ...ROW, updatePolicy: 'forced', publishedAt: '昨天' }],
  })
  assert.equal(dirty.updatePolicy.mode, 'normal', '脏策略 → 解析出 normal（不是抛错）')
  assert.equal(dirty.releasedAt, undefined, '解析不出日期的时间戳应丢弃')
  assert.equal(dirty.versionCode, 14040, '策略脏不影响这条记录本身可安装')

  // publishedAt 是契约草稿里的别名，也认
  const [aliased] = parseManifest({
    releases: [{ ...ROW, publishedAt: '2026-11-19T09:00:00+08:00', policy: { mode: 'soft' } }],
  })
  assert.equal(aliased.releasedAt, '2026-11-19T09:00:00+08:00', 'publishedAt 别名应被接受')
  assert.equal(aliased.updatePolicy.mode, 'soft', 'policy 别名应被接受')
})

// ---------------------------------------------------------------- 4) snooze 存储（沿用设置存储，不新开 store）

test('snooze 存储：沿用 chat-demo: 设置前缀，写进去的必须是毫秒时间戳', () => {
  const key = 'chat-demo:update-snooze-until'
  const until = snoozeDeadline(NOW, 24)

  setUpdateSnoozeUntil(until)
  assert.equal(dom.localStorage.getItem(key), String(until), `到期时刻应写进 ${key}`)
  assert.equal(
    useSettings.getState().updateSnoozeUntil,
    until,
    'store 里也同步（界面不用重新读存储）'
  )

  // 脏值不许写进去：归零并清键 —— 下次检查照常弹，而不是「永远静音」
  for (const bad of [Number.NaN, -1, 1.5]) {
    setUpdateSnoozeUntil(bad)
    assert.equal(useSettings.getState().updateSnoozeUntil, 0, `脏值 ${String(bad)} 应归零`)
    assert.equal(dom.localStorage.getItem(key), null, `脏值 ${String(bad)} 应把键清掉`)
  }

  // forced 不写 snooze 是调用方的纪律（弹窗那一层不提供这个出口），这里只钉「写这个动作本身」：
  // 写进去的就是调用方给的值，没有额外副作用
  setUpdateSnoozeUntil(until + HOUR)
  assert.equal(dom.localStorage.getItem(key), String(until + HOUR), '再次写入应覆盖上一次的值')
})

test('负面清点：判定函数不许抛', () => {
  // 清单被写脏 / 服务端把字段塞成奇怪形状时，界面最不该看到的是异常
  const hostile = [
    undefined,
    null,
    0,
    '',
    'forced',
    [],
    [{}],
    { mode: () => 'forced' },
    { mode: { mode: 'forced' } },
    { minSupportedVersionCode: Number.POSITIVE_INFINITY },
    { snoozeHours: Number.NEGATIVE_INFINITY },
    { expiresAt: {} },
    { reason: 42 },
  ]
  for (const value of hostile) {
    assert.doesNotThrow(
      () => parseUpdatePolicy(value),
      `parseUpdatePolicy 不许抛：${String(value)}`
    )
    assert.doesNotThrow(
      () => resolveUpdatePolicy(value, 14010, NOW),
      `resolveUpdatePolicy 不许抛：${String(value)}`
    )
    assert.doesNotThrow(
      () => resolveUpdatePrompt({ policy: value, currentVersionCode: 14010, now: NOW }),
      `resolveUpdatePrompt 不许抛：${String(value)}`
    )
  }
})
