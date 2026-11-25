// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// C2 —— `selectUpdate` 的「变体 × 渠道档位」筛选矩阵（Issue #407 / 防 #377 / #876）
//
// 历史事故 #377：清单里 1.4.1（code 20）只发了 `standard` 变体、1.4.0（code 19）只发了
// `internal` 变体，而 `selectUpdate` 要求 `artifactVariant` 完全相等 → **装 internal 的用户
// 没有任何候选**，界面只能说「已是最新」。那不是「已是最新」，是**这条渠道的包没发**
// （变体维度断链），用户以为自己在最新版，实际被卡在旧包上。
//
// 本契约锁三件事（语义）：
//   M1 六种组合的**候选结论**（有没有 release、是哪条）——断链时不许把 standard 包塞给 internal 用户；
//   M2 断链时必须给出**可解释的 reason**（`no-internal-variant` / `no-standard-variant` /
//      `up-to-date`），而不是笼统的「已是最新」；
//
// #876 变更：用户侧的「更新渠道」已下线，只剩一档（等价于原来的「稳定版」），因此
//   ① 表里不再有 channel 维度，`selectUpdate` 只有三个入参；
//   ② `prerelease-filtered` 这一档被删除 —— 「切渠道就能看到预发布版」不再是一条可行动的出路；
//   ③ 后果：`buildType: 'prerelease'` 的记录（含内测 beta 包）一律不进候选，reason 落 `up-to-date`。
//      这一格由 V6 显式钉住，等 #876 决定「internal 变体要不要不受档位过滤」时一起改。
//   （文案层「内测断链不许说已是最新」的那一句由 PR #418 的 `domain10-variant-matrix.test.mjs`
//    断言，本契约不重复抄一份 —— 重复断言 = 一处零边际，#362 §2 的 D1 教训。）
//
// `reason` 由 PR #418 落地（已合入 main），因此 M2 是**严格**断言：没有候选却没有 reason，
// 就等于退回「断链也说已是最新」那一格；有候选却带 reason 则是两套解释打架，同样判红。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { parseManifest, selectUpdate } = await import('../../src/services/updateManifest.ts')

const APK = (version) => `apk/deepseek-chat-${version}.apk`
const rel = (version, versionCode, artifactVariant, buildType) => ({
  version,
  versionCode,
  artifactVariant,
  buildType,
  size: 5_000_000,
  file: APK(version),
  changes: ['x'],
  sha256: 'a'.repeat(64),
})

/** #377 现场：1.4.1 只有 standard 包、1.4.0 只有 internal 包（变体维度断链） */
const BROKEN = [
  rel('1.4.1', 20, 'standard', 'stable'),
  rel('1.4.0', 19, 'internal', 'prerelease'),
]
/** 对照：两个变体都发齐 */
const COMPLETE = [
  rel('1.4.1', 20, 'standard', 'stable'),
  rel('1.4.1', 20, 'internal', 'stable'),
  rel('1.4.0', 19, 'internal', 'prerelease'),
]
/** 更高版本只有预发布的内测包（渠道维度的断链） */
const BETA_ONLY = [rel('1.4.1-beta.1', 21, 'internal', 'prerelease'), rel('1.4.0', 19, 'internal', 'prerelease')]
/** 预发布与稳定同时存在：档位只收 stable，所以选中的是稳定那条 */
const MIXED = [
  rel('1.4.2-beta.1', 22, 'internal', 'prerelease'),
  rel('1.4.1', 21, 'internal', 'stable'),
]

/**
 * 一行 = 一种「已装版本 × 变体 × 清单」。`reason` 是期望值（undefined = 不许带原因）。
 * #876：没有 channel 列了。
 */
const ROWS = [
  {
    id: 'V1',
    what: '内测包：更高的版本只有 standard 包 → 没有候选，reason=no-internal-variant',
    installed: 19,
    variant: 'internal',
    manifest: BROKEN,
    releaseCode: undefined,
    reason: 'no-internal-variant',
  },
  {
    id: 'V2',
    what: '内测包装的更低（前几版）：同一份清单也是断链 → 原因必须跟着变体走，不跟着已装版本走',
    installed: 17,
    variant: 'internal',
    manifest: BROKEN,
    releaseCode: undefined,
    reason: 'no-internal-variant',
  },
  {
    id: 'V3',
    what: '对称断链：正式包在「只有 internal 包」的清单里 → reason=no-standard-variant（不是「已是最新」）',
    installed: 19,
    variant: 'standard',
    manifest: [rel('1.4.1', 20, 'internal', 'stable'), rel('1.4.0', 19, 'standard', 'stable')],
    releaseCode: undefined,
    reason: 'no-standard-variant',
  },
  {
    id: 'V4',
    what: '对照（严格）：正式包 → 必须选到 1.4.1，且不带 reason',
    installed: 19,
    variant: 'standard',
    manifest: BROKEN,
    releaseCode: 20,
    reason: undefined,
  },
  {
    id: 'V5',
    what: '#876 后果：更高的只有预发布内测包 → 档位只收 stable，所以没有候选，reason=up-to-date',
    installed: 19,
    variant: 'internal',
    manifest: BETA_ONLY,
    releaseCode: undefined,
    reason: 'up-to-date',
  },
  {
    id: 'V6',
    what: '#876：预发布与稳定并存 → 跳过预发布、选中稳定的那条（档位真的在筛）',
    installed: 19,
    variant: 'internal',
    manifest: MIXED,
    releaseCode: 21,
    reason: undefined,
  },
  {
    id: 'V7',
    what: '变体发齐时不许断链：内测包 → 选到 internal 的 1.4.1（这一格坏了就是 #377 复发）',
    installed: 19,
    variant: 'internal',
    manifest: COMPLETE,
    releaseCode: 20,
    reason: undefined,
  },
]

test('C2 变体 × 筛选项矩阵：候选结论 + 断链原因（防 #377）', tableTest('C2', ROWS, (row) => {
  const releases = parseManifest({ latest: row.manifest[0].version, releases: row.manifest })
  const selection = selectUpdate(releases, row.installed, row.variant)

  // M1：候选结论（严格，任何时候都不许变）
  assert.equal(
    selection.release?.versionCode,
    row.releaseCode,
    row.releaseCode === undefined
      ? '没有候选，却选出了一个 release（断链被掩盖 = #377 复发）'
      : '有候选却没选出来 / 选错了一条'
  )

  // M2：没有候选时必须给出**可解释**的原因（#377 → #418）；有候选时不许带原因
  if (selection.release === undefined) {
    assert.equal(typeof selection.reason, 'string', '没有候选却不说原因 = 退回「断链也说已是最新」')
  }
  assert.equal(selection.reason, row.reason, '断链原因被换成了别的解释')
}))

test('C2 表外兜底：真·最新 / 缺校验和不许冒充「最新」/ 重复版本号不许乱选（防 #377 #330）', async (t) => {
  const newest = parseManifest({ latest: '1.4.1', releases: COMPLETE })
  // 真·最新：渠道内确实没有更高版本 → up-to-date（或未实现 reason 时不带原因）
  const upToDate = selectUpdate(newest, 20, 'internal')
  assert.equal(upToDate.release, undefined)
  assert.equal(upToDate.reason, 'up-to-date', '真·最新也必须说 reason（否则界面无法把三种原因分开）')

  // 缺 sha256 的条目可见但不可装：必须记进 incomplete，不许静默当作「已是最新」
  const incomplete = parseManifest({
    latest: '1.4.1',
    releases: [{ ...rel('1.4.1', 21, 'internal', 'stable'), sha256: undefined }],
  })
  const noHash = selectUpdate(incomplete, 19, 'internal')
  assert.equal(noHash.release, undefined, '缺 sha256 的包不许被选为可更新目标')
  assert.equal(noHash.incomplete, 1, '缺校验和必须计入 incomplete（界面要能说「包不完整」而不是「已是最新」）')

  // 同一版本号两条不同文件 = 歧义，宁可报错也不许随便挑一条发给用户
  const ambiguous = parseManifest({
    latest: '1.4.1',
    releases: [rel('1.4.1', 21, 'internal', 'stable'), { ...rel('1.4.1', 21, 'internal', 'stable'), file: APK('1.4.1-hotfix') }],
  })
  assert.throws(() => selectUpdate(ambiguous, 19, 'internal'), /AMBIGUOUS_RELEASE/)

  // 只缺渠道 / 缺 SHA256 的情形不许另给 reason（#418 口径）：由 incomplete 说，两套解释不打架
  const noHashReason = selectUpdate(
    parseManifest({ latest: '1.4.1', releases: [{ ...rel('1.4.1', 21, 'internal', 'stable'), sha256: undefined }] }),
    19,
    'internal')
  assert.equal(noHashReason.reason, undefined, '「有记录但缺校验和」应由 incomplete 说清，不许再给一套 reason')
})
