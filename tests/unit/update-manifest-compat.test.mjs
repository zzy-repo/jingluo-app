// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// 旧 WebView 兼容回归：`Array.prototype.toSorted` 是 ES2023，ColorOS 13.1 / 旧 Android WebView
// 上会抛「e.messages.toSorted is not a function」。本用例删掉该原型方法后调用检查更新的选择逻辑
// （selectUpdate），断言：1) 不再抛 not a function；2) 仍能选中最高 code 的合规版本；
// 3) 不原地修改入参数组；4) 同 code 歧义仍然报 AMBIGUOUS_RELEASE。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { selectUpdate } = await import('../../src/services/updateManifest.ts')

const sha = 'a'.repeat(64)
const row = (version, versionCode, variant = 'internal', buildType = 'prerelease') => ({
  version,
  versionCode,
  artifactVariant: variant,
  sha256: sha,
  buildType,
  file: `apk/deepseek-chat-${version}.apk`,
  size: 1024,
  md5: 'b'.repeat(32),
})

test('去掉 Array.prototype.toSorted 后 selectUpdate 仍可用（旧 WebView 兼容）', () => {
  const original = Array.prototype.toSorted
  // 模拟旧 WebView：该原型方法根本不存在
  // eslint-disable-next-line no-extend-native
  delete Array.prototype.toSorted
  try {
    assert.equal(typeof [].toSorted, 'undefined', '前置：toSorted 已被删除')
    const releases = [row('1.4.0-beta.5', 12), row('1.4.0-beta.6', 13), row('1.4.0-beta.7', 14, 'standard')]
    const before = releases.map((r) => r.versionCode)
    const picked = selectUpdate(releases, 12, 'internal', 'prerelease')
    assert.equal(picked.release.version, '1.4.0-beta.6', '应选中同 variant 的最高 code')
    assert.equal(picked.incomplete, 0)
    assert.deepEqual(releases.map((r) => r.versionCode), before, '不能原地修改入参数组')
  } finally {
    Array.prototype.toSorted = original
  }
})

test('同 code 歧义仍报 AMBIGUOUS_RELEASE（删除 toSorted 后同样成立）', () => {
  const original = Array.prototype.toSorted
  // eslint-disable-next-line no-extend-native
  delete Array.prototype.toSorted
  try {
    const releases = [row('1.4.0-beta.6', 13), row('1.4.0-beta.6-hotfix', 13)]
    assert.throws(() => selectUpdate(releases, 12, 'internal', 'prerelease'), /AMBIGUOUS_RELEASE/)
  } finally {
    Array.prototype.toSorted = original
  }
})
