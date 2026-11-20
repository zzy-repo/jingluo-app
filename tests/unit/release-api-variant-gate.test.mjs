// [layer: unit | 纯 Node，无网络无子进程 | 耗时: <1s]
//
// #620 —— **发布目标 × 变体 × 渠道** 的纯函数口径（接口层的闸，与脚本层同口径）。
//
// 这里验三件事：
//   1) 判定本身（`deploy/dl-release/release-target.mjs`）：公网只收 standard+stable、
//      私有只收 internal、unknown 不默认 standard、整份清单互斥、私有根不许在 webroot 内；
//   2) **三处枚举必须同值**（这就是「与 #619 已有的 public/private 双口径接上」的可执行断言）：
//      接口层 `release-target.mjs` 的 TARGET_VARIANT
//      = 校验器 `scripts/validate-releases-manifest.mjs` 的 MODE_VARIANT
//      = 发布脚本 `scripts/publish-private-apk.mjs` 的 TARGET_VARIANT；
//   3) 端点路由（一条路径 = 一个目标）：不存在「靠参数切换口径」的模糊地带。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  BUILD_TYPE_GATE_CODE,
  MANIFEST_GATE_CODE,
  PUBLIC_ALLOWED_BUILD_TYPES,
  TARGETS,
  TARGET_PATHS,
  TARGET_VARIANT,
  VARIANT_GATE_CODE,
  findMismatchedVariants,
  isInsideDir,
  judgeBuildType,
  judgeMergedManifest,
  judgeVariant,
  resolveTarget,
} = await import('../../deploy/dl-release/release-target.mjs')
const { MODE_VARIANT } = await import('../../scripts/validate-releases-manifest.mjs')
// buildType 枚举也只有一处定义（#330）：这里 import 它，不写字面量数组
const { BUILD_TYPES } = await import('../../shared/build-types.mjs')
const { TARGET_VARIANT: PUBLISH_TARGET_VARIANT, PUBLIC_ALLOWED_BUILD_TYPES: PUBLISH_ALLOWED } =
  await import('../../scripts/publish-private-apk.mjs')

test('#620 端点路由：一条路径 = 一个目标，未知路径不接（没有靠参数切换口径的口子）', () => {
  assert.equal(resolveTarget('/api/v1/release'), 'public')
  assert.equal(resolveTarget('/api/v1/release/private'), 'private')
  assert.equal(resolveTarget('/api/v1/release/'), 'public', '尾部斜杠不该改变口径')
  assert.equal(resolveTarget('/api/v1/release/private/'), 'private')
  assert.equal(resolveTarget('/api/v1/release/internal'), null, '不认识的路径必须不接（不能"宽容匹配"到公网）')
  assert.equal(resolveTarget('/api/v1/version'), null)
  assert.deepEqual(Object.keys(TARGET_PATHS).sort(), ['/api/v1/release', '/api/v1/release/private'])
  assert.deepEqual([...TARGETS], ['public', 'private'])
})

test('#620 变体闸：公网只收 standard，私有只收 internal；unknown 不默认 standard', () => {
  // 公网
  assert.equal(judgeVariant({ target: 'public', variant: 'standard' }).ok, true)
  for (const variant of ['internal', null, undefined]) {
    const verdict = judgeVariant({ target: 'public', variant, source: variant ? 'apk-manifest' : null })
    assert.equal(verdict.ok, false, `公网端点必须拒 ${String(variant)}`)
    assert.equal(verdict.code, VARIANT_GATE_CODE.public)
    assert.equal(verdict.code, 'VARIANT_NOT_PUBLIC')
    assert.match(verdict.message, /release\/private/, '文案必须给出内部包该走的端点')
    assert.match(verdict.message, /未落盘/, '文案必须说清"没写进去"')
  }
  // 私有
  assert.equal(judgeVariant({ target: 'private', variant: 'internal' }).ok, true)
  for (const variant of ['standard', null]) {
    const verdict = judgeVariant({ target: 'private', variant })
    assert.equal(verdict.ok, false, `私有端点必须拒 ${String(variant)}`)
    assert.equal(verdict.code, VARIANT_GATE_CODE.private)
    assert.equal(verdict.code, 'VARIANT_NOT_PRIVATE')
    assert.match(verdict.message, /GitHub Release/)
  }
  assert.throws(() => judgeVariant({ target: 'staging', variant: 'standard' }), /未知的发布目标/)
})

test('#620 渠道闸：公网只收 stable（prerelease 走 GitHub Release），私有不限渠道', () => {
  assert.equal(judgeBuildType({ target: 'public', buildType: 'stable' }).ok, true)
  for (const buildType of ['prerelease', 'release', undefined, null]) {
    const verdict = judgeBuildType({ target: 'public', buildType })
    assert.equal(verdict.ok, false, `公网端点必须拒 buildType=${JSON.stringify(buildType ?? null)}`)
    assert.equal(verdict.code, BUILD_TYPE_GATE_CODE)
    assert.equal(verdict.code, 'BUILD_TYPE_NOT_PUBLIC')
    assert.match(verdict.message, /GitHub Release/)
  }
  // 私有清单不限渠道：枚举合法性在 server.mjs 的 (4b) 先判过了
  for (const buildType of BUILD_TYPES) {
    assert.equal(judgeBuildType({ target: 'private', buildType }).ok, true, `私有清单应放行 ${buildType}`)
  }
  assert.deepEqual([...PUBLIC_ALLOWED_BUILD_TYPES], ['stable'])
})

test('#620 整份清单互斥：公网清单里 internal 条目 → 拒（#601 形状）；私有清单里 standard 条目 → 拒', () => {
  const manifest = {
    latest: '1.4.2',
    releases: [
      { version: '1.4.2', versionCode: 21, artifactVariant: 'internal' },
      { version: '1.4.1', versionCode: 20, artifactVariant: 'standard' },
      { version: '1.4.0', versionCode: 18 }, // 历史条目没写变体：允许（进不了自动更新，校验器只给 warning）
    ],
  }
  assert.deepEqual(findMismatchedVariants(manifest, 'public').map((d) => d.version), ['1.4.2'])
  assert.deepEqual(findMismatchedVariants(manifest, 'private').map((d) => d.version), ['1.4.1'])

  const publicVerdict = judgeMergedManifest({ target: 'public', manifest })
  assert.equal(publicVerdict.ok, false)
  assert.equal(publicVerdict.code, MANIFEST_GATE_CODE.public)
  assert.equal(publicVerdict.code, 'MANIFEST_INTERNAL_ENTRY')
  assert.equal(publicVerdict.count, 1)
  assert.match(publicVerdict.message, /1 条/)
  assert.match(publicVerdict.message, /1\.4\.2/, '要指出是哪一条脏了')

  const privateVerdict = judgeMergedManifest({ target: 'private', manifest })
  assert.equal(privateVerdict.code, MANIFEST_GATE_CODE.private)
  assert.equal(privateVerdict.code, 'MANIFEST_STANDARD_ENTRY')

  // 干净的清单必须过（否则闸是恒红）
  assert.equal(judgeMergedManifest({ target: 'public', manifest: { latest: '1.4.1', releases: [{ version: '1.4.1', artifactVariant: 'standard' }] } }).ok, true)
  assert.equal(judgeMergedManifest({ target: 'private', manifest: { latest: '1.4.1', releases: [{ version: '1.4.1', artifactVariant: 'internal' }] } }).ok, true)
  // 空清单（私有清单第一次发布时的形状）
  assert.equal(judgeMergedManifest({ target: 'private', manifest: { latest: null, releases: [] } }).ok, true)
})

test('#620 私有根不许在 webroot 内（#609 G1 的接口层复刻）', () => {
  assert.equal(isInsideDir('/var/lib/dl-private', '/var/www/dl'), false)
  assert.equal(isInsideDir('/var/www/dl/private', '/var/www/dl'), true)
  assert.equal(isInsideDir('/var/www/dl', '/var/www/dl'), true, '相等也算在内')
  assert.equal(isInsideDir('/var/www/dl2/x', '/var/www/dl'), false, '词缀相同的兄弟目录不算在内')
  assert.equal(isInsideDir('/var/www', '/var/www/dl'), false, '父目录不算在内')
})

test('#620 三处枚举同值：接口层 / 校验器 / 发布脚本（改歪一处就红）', () => {
  assert.deepEqual(TARGET_VARIANT, { public: 'standard', private: 'internal' })
  assert.deepEqual(MODE_VARIANT, TARGET_VARIANT, '校验器的 MODE_VARIANT 必须与接口层同值')
  assert.deepEqual(PUBLISH_TARGET_VARIANT, TARGET_VARIANT, '发布脚本的 TARGET_VARIANT 必须与接口层同值')
  assert.deepEqual([...PUBLISH_ALLOWED], [...PUBLIC_ALLOWED_BUILD_TYPES], '公网允许的渠道也必须同一份')
})
