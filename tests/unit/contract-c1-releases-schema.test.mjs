// [layer: unit | 纯 Node（子进程跑校验器），无浏览器无网络 | 耗时: <1s]
//
// C1 —— `releases.json` 清单 schema 契约（Issue #407 / 防 #330）
//
// 历史事故 #330（2026-11-19 P0）：清单里 11 条 `buildType:"release"`（Gradle 的构建类型，不是
// 发布渠道）发到线上，客户端 `parseManifest` fail-closed 整份拒收 → **所有客户端**解析失败，
// 界面只剩「检查更新失败」。当时发布脚本 / 校验器 / 复核脚本三处都没拦住，其中两处是因为
// 各自写了一份枚举。
//
// 本契约锁什么（语义，不是实现）：
//   S1 必填字段齐全（version / versionCode / releasedAt / file / size / md5 / changes）
//   S2 渠道枚举闭合：`buildType ∈ {stable, prerelease}`，写别的 = 整份清单不可信
//   S3 版本单调：清单里 `versionCode` 必须严格降序（客户端靠第一条才能选出「最新」）
//   S4 变体合法：`artifactVariant ∈ {internal, standard}` 且与 `artifactVariantSource` 同存同缺
//   S5 顶部一致：`latest` 必须等于 `releases[0].version`
//      （例外：头部是 `artifactVariant: "internal"` 的私有条目时，`latest` 也可以是第一条**公共**记录
//       的 version —— 私有包不改公共 latest，见 Issue #566 问题 1 的 B 方案 / scripts/publish-private-apk.mjs）
//
// 「改实现不改语义不该红」的口径：这里断言的是**校验器的结论**（退出码 + 报错点）与
// **客户端的解析结论**（抛不抛、字段落不落），不针对任何一方的内部函数名 / 文件名。
//
// 反例一律复用 `deploy/dl-release/fixtures/` 下已有的 `invalid-*.json`，不另造夹具。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, readJson, run, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { parseManifest } = await import('../../src/services/updateManifest.ts')
const { BUILD_TYPES } = await import('../../shared/build-types.mjs')

const FIXTURE_DIR = 'deploy/dl-release/fixtures'
const VALIDATOR = 'scripts/validate-releases-manifest.mjs'
const fixture = (file) => `${FIXTURE_DIR}/${file}`
/** 跑一次校验器（`--strict` 不带：历史条目缺 sha256 / artifactVariant 是已知 warning） */
const validate = (file) => run([VALIDATOR, fixture(file)])

/** 行 = 一份清单 + 期望结论。`mustFail` 的 `expect` 是「报错必须点到的那一句话」 */
const SCHEMA_ROWS = [
  {
    id: 'S1',
    what: '线上真实清单不许被误杀（合法清单必须 PASS）',
    file: 'live-2026-11-18.json',
    mustFail: false,
  },
  {
    id: 'S2',
    what: '事故清单：11 条 buildType:"release" 必须逐条报出（防 #330 只报第一条就停）',
    file: 'invalid-buildtype-release.json',
    mustFail: true,
    expect: /buildType 只能是 stable\|prerelease/,
    expectCount: 11,
  },
  {
    id: 'S3',
    what: 'versionCode 必须严格降序（乱序 = 客户端按第一条选「最新」会选错版本）',
    file: 'invalid-unsorted.json',
    mustFail: true,
    expect: /versionCode 必须严格降序/,
  },
  {
    id: 'S4',
    what: 'latest 必须等于 releases[0].version（顶部与首条不一致 = 两个「最新」）',
    file: 'invalid-latest-mismatch.json',
    mustFail: true,
    expect: /必须等于 releases\[0\]\.version/,
  },
  {
    id: 'S4-b',
    what: '私有 internal 条目排在头部、公共 latest 不动 —— 这是合法形状，必须 PASS（Issue #566 B 方案）',
    file: 'proposed-1.4.2-internal-keep-latest.json',
    mustFail: false,
  },
  {
    id: 'S4-c',
    what: '头部是 internal 条目时 latest 只允许等于它自己或第一条公共记录（别的值 = 两个「最新」）',
    file: 'invalid-internal-latest-unrelated.json',
    mustFail: true,
    expect: /也可以等于第一条公共记录的 version/,
  },
  {
    id: 'S5',
    what: '有 artifactVariant 就必须有 artifactVariantSource（变体来源要留痕）',
    file: 'invalid-missing-variant-source.json',
    mustFail: true,
    expect: /有 artifactVariant 就必须有 artifactVariantSource/,
  },
  {
    id: 'S6',
    what: 'artifactVariant 只能是 internal|standard（第三种值 = 该版本谁都装不上）',
    file: 'invalid-variant.json',
    mustFail: true,
    expect: /artifactVariant 只能是 internal\|standard/,
  },
  {
    id: 'S7',
    what: 'sha256 必须是 64 位小写 hex（写坏了等于没有校验和）',
    file: 'invalid-sha256.json',
    mustFail: true,
    expect: /sha256 必须是 64 位小写 hex/,
  },
  {
    id: 'S8',
    what: 'file 必须是 apk/<name>.apk 相对路径 & version 合法（绝对 URL = 清单能把用户导去任何地方）',
    file: 'invalid-file-and-version.json',
    mustFail: true,
    expect: /file 必须是 apk\/<name>\.apk 相对路径/,
  },
]

test('C1 清单 schema：合法必过 / 非法必拦，且报错点到具体字段（防 #330）', tableTest('C1', SCHEMA_ROWS, (row) => {
  const result = validate(row.file)
  if (row.mustFail) {
    assert.notEqual(result.status, 0, `${row.file} 本该被拦下却 exit=0 —— 校验器在放行：\n${result.stdout}`)
    assert.match(result.stdout, row.expect, `${row.file} 的报错没点到「${row.expect}」：\n${result.stdout}`)
    if (row.expectCount) {
      const hits = (result.stdout.match(/✗ [^\n]*buildType/g) || []).length
      assert.equal(hits, row.expectCount, `${row.file}: 期望逐条报出 ${row.expectCount} 条，实际 ${hits} 条`)
    }
  } else {
    assert.equal(result.status, 0, `${row.file} 被误杀了（合法清单必须 PASS）：\n${result.stdout}`)
  }
}))

/** 客户端侧必须一致的两条硬语义：渠道枚举闭合 + 变体不许被默认成 standard */
const CLIENT_ROWS = [
  {
    id: 'C1-a',
    what: '事故清单（buildType:"release"）→ parseManifest 整份拒收 INVALID_RELEASE（fail-closed，不许「跳过坏条目」）',
    file: 'invalid-buildtype-release.json',
    throws: /INVALID_RELEASE/,
  },
  {
    id: 'C1-b',
    what: '合法清单（live）→ 每条的 buildType 都落在 BUILD_TYPES 里',
    file: 'live-2026-11-18.json',
    everyBuildTypeInEnum: true,
  },
  {
    id: 'C1-c',
    what: 'live 清单的 versionCode 严格降序（客户端选版本靠它，不许出现「后一条更大」）',
    file: 'live-2026-11-18.json',
    strictlyDescending: true,
  },
]

test('C1 客户端解析：枚举闭合 / 版本单调 / 变体不默认（防 #330）', tableTest('C1-client', CLIENT_ROWS, (row) => {
  const data = readJson(fixture(row.file))
  if (row.throws) {
    assert.throws(() => parseManifest(data), row.throws, `${row.file} 本该被客户端拒收`)
    return
  }
  const rows = parseManifest(data)
  assert.ok(rows.length > 0, `${row.file}: 解析出 0 条`)
  if (row.everyBuildTypeInEnum) {
    const illegal = rows.filter((item) => item.buildType !== undefined && !BUILD_TYPES.includes(item.buildType))
    assert.deepEqual(illegal, [], `这些条目的 buildType 不在 ${BUILD_TYPES.join('|')} 里`)
  }
  if (row.strictlyDescending) {
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i].versionCode < rows[i - 1].versionCode,
        `releases[${i}](${rows[i].version}) 的 versionCode ${rows[i].versionCode} 不小于上一条 ${rows[i - 1].versionCode}`
      )
    }
  }
}))

test('C1 变体与校验和的取值口径：非法值一律「没有」，绝不默认 internal/standard', async () => {
  const base = {
    version: '1.5.0',
    versionCode: 30,
    size: 1024,
    file: 'apk/deepseek-chat-1.5.0.apk',
    changes: ['x'],
    buildType: 'stable',
  }
  const parsed = parseManifest({
    latest: '1.5.0',
    releases: [
      { ...base, artifactVariant: 'internal', sha256: 'a'.repeat(64) },
      { ...base, versionCode: 29, artifactVariant: 'beta', sha256: 'NOT-A-HASH' },
    ],
  })
  assert.equal(parsed[0].artifactVariant, 'internal')
  assert.equal(parsed[0].sha256, 'a'.repeat(64))
  // #330 的同族病症：解析不了就退回「默认值」= 把 internal 包发给 standard 用户
  assert.equal(parsed[1].artifactVariant, undefined, '非法 artifactVariant 不许被默认成任何值')
  assert.equal(parsed[1].sha256, undefined, '非法 sha256 不许被当作校验和')
})
