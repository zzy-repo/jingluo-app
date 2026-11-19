// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
//
// 域10 L0 —— **变体 × 渠道矩阵**（Issue #377，父单 #373 / #362 域10「更新链路」）。
//
// 要回答的问题：`selectUpdate()` 在「已装变体 × 更新渠道」的每一格里，给出的
// 是**能行动**的结论，还是笼统的「已是最新」。
//
// #377 的现场：线上清单里 `1.4.1`（code 20）只有 `standard` 变体，`1.4.0`（code 19）只有
// `internal` 变体。`selectUpdate` 又要求 `artifactVariant` 完全相等 —— 于是装了 internal 的
// 用户「没有任何候选」，界面只能说「已是最新」，而真正的原因是**这条渠道的包没发**。
//
// 本单只做「不构建 APK」的部分：把原因返回给界面（`reason`），让它说清「当前为内测渠道，
// 请手动下载正式版」。**没有**放开跨变体候选（原生 `verify()` 的 `VARIANT_MISMATCH` 仍拦截，
// 发一个 internal 变体的 1.4.1 属于构建任务，见 issue 正文）。
//
// 一张表（`ROWS`）覆盖 2 变体 × 2 渠道，外加三条真实断链/过滤场景；`test()` 只负责把行注册出去，
// 断言集中在 `verify(row)`：加一行 = 加一行数据，不新写一套判定逻辑（#369 的模板）。

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

const { parseManifest, selectUpdate } = await import('../../src/services/updateManifest.ts')
const { describeUpToDate } = await import('../../src/services/updateFailure.ts')

const sha = 'a'.repeat(64)
/** 一条清单记录（与线上 releases.json 同形状；`over` 用来造缺字段的反例） */
const row = (version, versionCode, variant, buildType, over = {}) => ({
  version,
  versionCode,
  size: 5452595,
  file: `apk/deepseek-chat-${version}.apk`,
  changes: ['修复'],
  buildType,
  artifactVariant: variant,
  sha256: sha,
  ...over,
})

/** 线上现状（#377 正文的那张表）：1.4.1 只有 standard，1.4.0 只有 internal */
const LIVE = [
  row('1.4.1', 20, 'standard', 'stable'),
  row('1.4.0', 19, 'internal', 'prerelease'),
  row('1.4.0-beta.10', 17, 'internal', 'prerelease'),
]
/** 同一条内测线，但更高版本只有预发布（用来证明「仅稳定版」渠道过滤的是预发布，不是缺包） */
const INTERNAL_PRERELEASE_ONLY = [
  row('1.4.0', 19, 'internal', 'prerelease'),
  row('1.4.1-beta.1', 21, 'internal', 'prerelease'),
]

/**
 * 一张表：`installed` = 本机已装（versionCode 已含在内），`expect` 是这一格该给出的结论。
 * `reason: undefined` 表示「这一格有 release，不需要解释」。
 */
const ROWS = [
  {
    id: 'V1',
    name: 'internal × 预发布渠道：清单只有 standard 的 1.4.1 → 说清「内测包没发」',
    installed: { code: 19, variant: 'internal', channel: 'prerelease' },
    releases: LIVE,
    expect: { version: undefined, reason: 'no-internal-variant', incomplete: 0 },
    // 界面必须给出「手动下载正式版」这个动作，而不是「已是最新」
    message: /内测/,
    messageNot: /已是最新/,
  },
  {
    id: 'V2',
    name: 'internal × 仅稳定版：同上（1.4.1 是 stable/standard）',
    installed: { code: 19, variant: 'internal', channel: 'stable' },
    releases: LIVE,
    expect: { version: undefined, reason: 'no-internal-variant', incomplete: 0 },
    message: /手动下载正式版/,
    messageNot: /已是最新/,
  },
  {
    id: 'V3',
    name: 'internal（beta.10）× 仅稳定版：这一格先被渠道过滤（1.4.0 是预发布）→ 提示切渠道',
    installed: { code: 17, variant: 'internal', channel: 'stable' },
    releases: LIVE,
    expect: { version: undefined, reason: 'prerelease-filtered', incomplete: 0 },
    message: /稳定版与预发布版/,
    messageNot: /手动下载正式版/,
  },
  {
    id: 'V4',
    name: 'standard × 仅稳定版：能看到 1.4.1（对照：正式包用户没有断链）',
    installed: { code: 19, variant: 'standard', channel: 'stable' },
    releases: LIVE,
    expect: { version: '1.4.1', reason: undefined, incomplete: 0 },
  },
  {
    id: 'V5',
    name: 'standard × 预发布渠道：稳定版候选照旧可见（预发布渠道包含稳定版）',
    installed: { code: 19, variant: 'standard', channel: 'prerelease' },
    releases: LIVE,
    expect: { version: '1.4.1', reason: undefined, incomplete: 0 },
  },
  {
    id: 'V6',
    name: 'internal × 仅稳定版：更高的 internal 包只有预发布 → 说清「切渠道就能看到」',
    installed: { code: 19, variant: 'internal', channel: 'stable' },
    releases: INTERNAL_PRERELEASE_ONLY,
    expect: { version: undefined, reason: 'prerelease-filtered', incomplete: 0 },
    message: /已是最新/,
    messageNot: /手动下载正式版/,
  },
]

const ZH = { zh: '稳定版与预发布版', en: 'Stable + pre-release' }

const verify = (row) => {
  const rows = parseManifest({ releases: row.releases })
  const picked = selectUpdate(rows, row.installed.code, row.installed.variant, row.installed.channel)
  assert.equal(picked.release?.version, row.expect.version, `${row.id} release`)
  assert.equal(picked.reason, row.expect.reason, `${row.id} reason`)
  assert.equal(picked.incomplete, row.expect.incomplete, `${row.id} incomplete`)
  // 有 release 时不许带 reason：界面只在「没有可装版本」时才需要解释
  if (row.expect.version !== undefined) {
    assert.equal(Object.hasOwn(picked, 'reason'), false, `${row.id} 有候选时不应带 reason 字段`)
  }
  // 文案层必须真的换了说法（#377 的验收：不是笼统的「已是最新」）
  if (row.message !== undefined) {
    const view = describeUpToDate({
      channel: ZH,
      version: '1.4.0',
      locale: 'zh',
      incomplete: picked.incomplete,
      reason: picked.reason,
    })
    assert.match(view.text, row.message, `${row.id} 文案应说清原因：${view.text}`)
    if (row.messageNot) {
      assert.doesNotMatch(view.text, row.messageNot, `${row.id} 文案不该是这句：${view.text}`)
    }
  }
}

for (const row of ROWS) {
  test(`${row.id} ${row.name}`, () => verify(row))
}

test('表外补充：真正的最新 / 只有内测包 / 缺字段，三种兜底各说各的', () => {
  // 1) 渠道内确实没有更高的版本
  assert.deepEqual(selectUpdate(parseManifest({ releases: LIVE }), 20, 'standard', 'stable'), {
    release: undefined,
    incomplete: 0,
    reason: 'up-to-date',
  })
  // 2) 对称情形：正式包用户遇到「只有内测包」的版本
  const internalOnly = [row('1.4.1', 21, 'internal', 'stable')]
  assert.equal(
    selectUpdate(parseManifest({ releases: internalOnly }), 19, 'standard', 'stable').reason,
    'no-standard-variant'
  )
  // 3) 缺渠道 / 缺 SHA256 的记录仍由 incomplete 说清，不另给 reason（避免两套解释打架）
  const legacy = [row('1.5.0', 21, 'internal', 'stable', { sha256: undefined })]
  assert.deepEqual(selectUpdate(parseManifest({ releases: legacy }), 19, 'internal', 'stable'), {
    release: undefined,
    incomplete: 1,
  })
})
