// [layer: unit | 纯 Node，无网络、不构建、不解密、不碰真 keystore（只用临时目录）| 耗时: <2s]
// scripts/release-howto.mjs 的「前置检查」逻辑。每条正向用例都带一条负向对照：
// 检查要是永远返回 ok，正向用例照样绿，所以必须有「该红的真红」。
//
// 覆盖：参数解析 / node 与 JDK 版本 / SDK 目录 / versionCode 严格递增 / CHANGELOG 版本段 /
//       keystore.properties 形状 / 证书指纹比对 / 构建锁 / --dry-run 不写任何文件。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  certsEqual,
  checkAndroidSdk,
  checkJava,
  checkNode,
  checkSigningProps,
  checkVersionFields,
  hasChangelogSection,
  lockState,
  parseArgs,
  parseProperties,
  resolveStoreFile,
} from '../../scripts/release-howto.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/release-howto.mjs')
const CERT = 'e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1'
const CHANGELOG = '# 变更记录\n\n## 1.4.19 (2026-11-23) — x\n- a\n\n## 1.4.18 (2026-11-22)\n- b\n'

test('parseArgs：正常参数、缺值、未知参数、skip-build 缺 apk', () => {
  const a = parseArgs(['--dry-run', '--last-code', '37', '--root', '/x'])
  assert.deepEqual([a.dryRun, a.lastCode, a.root, a.errors], [true, 37, '/x', []])
  assert.ok(parseArgs(['--last-code']).errors.length, '--last-code 缺值要报错')
  assert.ok(parseArgs(['--last-code', 'abc']).errors.length, '--last-code 非数字要报错')
  assert.ok(parseArgs(['--last-code', '0']).errors.length, '--last-code 0 要报错')
  assert.ok(parseArgs(['--nope']).errors.length, '未知参数要报错')
  assert.ok(parseArgs(['--skip-build']).errors.length, '--skip-build 不带 --apk 要报错')
  assert.equal(parseArgs(['--skip-build', '--apk', '/a.apk']).errors.length, 0)
})

test('checkNode：22 过，20 红，乱码红', () => {
  assert.equal(checkNode('v22.23.4').ok, true)
  assert.equal(checkNode('v24.16.0').ok, true)
  const low = checkNode('v20.11.0')
  assert.equal(low.ok, false)
  assert.match(low.msg, /20/)
  assert.equal(checkNode('not-a-version').ok, false)
})

test('checkJava：21 过，17 红，没装红', () => {
  assert.equal(checkJava('openjdk version "21.0.13.1" 2026-11-17').ok, true)
  const old = checkJava('openjdk version "17.0.9" 2023-10-17')
  assert.equal(old.ok, false)
  assert.match(old.msg, /17/)
  assert.equal(checkJava('').ok, false)
})

test('checkAndroidSdk：有 apksigner 的档位才过', () => {
  const fake = (tree) => ({ exists: (p) => p in tree, list: (d) => tree[d] ?? [] })
  const good = fake({
    '/sdk': [], '/sdk/build-tools': ['35.0.0'], '/sdk/build-tools/35.0.0/apksigner': [],
  })
  assert.equal(checkAndroidSdk('/sdk', good).ok, true)
  const noSigner = fake({ '/sdk': [], '/sdk/build-tools': ['35.0.0'] })
  assert.equal(checkAndroidSdk('/sdk', noSigner).ok, false)
  assert.equal(checkAndroidSdk('/nope', fake({})).ok, false)
  assert.equal(checkAndroidSdk('', fake({})).ok, false)
})

test('versionCode 必须严格递增：大于过；等于、小于、没给最大值都红（2.0.0 同码事故）', () => {
  const pkg = (code) => ({ version: '1.4.19', androidVersionCode: code })
  const opts = (lastCode) => ({ lastCode, changelogText: CHANGELOG })
  assert.equal(checkVersionFields(pkg(38), opts(37)).ok, true)
  const same = checkVersionFields(pkg(37), opts(37))
  assert.equal(same.ok, false, 'versionCode 与已发布相同必须红')
  assert.match(same.msg, /37/)
  assert.equal(checkVersionFields(pkg(33), opts(37)).ok, false, '回退必须红')
  assert.equal(checkVersionFields(pkg(38), opts(null)).ok, false, '没给 --last-code 必须红')
})

test('版本号格式与 CHANGELOG 版本段：缺了就红', () => {
  const opts = { lastCode: 37, changelogText: CHANGELOG }
  assert.equal(checkVersionFields({ version: '1.4.19', androidVersionCode: 38 }, opts).ok, true)
  assert.equal(checkVersionFields({ version: '1.4.19', androidVersionCode: 38 }, { ...opts, changelogText: '## 1.4.18\n' }).ok, false, '无 1.4.19 段')
  assert.equal(checkVersionFields({ version: 'v1.4.19', androidVersionCode: 38 }, opts).ok, false, '带 v 前缀非法')
  assert.equal(checkVersionFields({ version: '1.4.19', androidVersionCode: '38' }, opts).ok, false, '字符串 versionCode 非法')
  assert.equal(hasChangelogSection(CHANGELOG, '1.4.1'), false, '1.4.1 不能误命中 1.4.18 / 1.4.19 的段')
  assert.equal(hasChangelogSection(CHANGELOG, '1.4.18'), true)
})

test('keystore.properties 形状：四个 Release 键齐全且 keystore 存在才过', () => {
  const appDir = '/repo/android/app'
  const full = (extra = '') => [
    'storeFileRelease=/ks/pub.keystore', 'storePasswordRelease=p', 'keyAliasRelease=a', 'keyPasswordRelease=p', extra,
  ].join('\n')
  const exists = (set) => (p) => set.includes(p)
  assert.equal(checkSigningProps(full(), { appDir, exists: exists(['/ks/pub.keystore']) }).ok, true)

  const noFile = checkSigningProps(full(), { appDir, exists: exists([]) })
  assert.equal(noFile.ok, false, 'keystore 文件不存在必须红')
  assert.match(noFile.msg, /\/ks\/pub\.keystore/)

  const unsuffixed = checkSigningProps('storeFile=/ks/pub.keystore\nstorePassword=p\nkeyAlias=a\nkeyPassword=p\n', { appDir, exists: exists(['/ks/pub.keystore']) })
  assert.equal(unsuffixed.ok, false, '不带 Release 后缀的键 Gradle 不认，必须红')
  assert.match(unsuffixed.msg, /storePasswordRelease/)
  assert.match(unsuffixed.msg, /Release 后缀/)

  const blank = checkSigningProps(full().replace('keyAliasRelease=a', 'keyAliasRelease='), { appDir, exists: exists(['/ks/pub.keystore']) })
  assert.equal(blank.ok, false, '空值等于缺键')
})

test('keystore 相对路径按 android/app 解析，绝对路径原样', () => {
  assert.equal(resolveStoreFile('../keystore/release.keystore', '/repo/android/app'), '/repo/android/keystore/release.keystore')
  assert.equal(resolveStoreFile('/abs/x.keystore', '/repo/android/app'), '/abs/x.keystore')
  assert.deepEqual(parseProperties('# c\na=1\n\nb=x=y\n'), { a: '1', b: 'x=y' })
})

test('证书指纹：忽略冒号与大小写；不一致必须红（Android 不允许覆盖升级）', () => {
  const colon = CERT.toUpperCase().match(/../g).join(':')
  assert.equal(certsEqual(colon, CERT).ok, true)
  const other = certsEqual('0'.repeat(64), CERT)
  assert.equal(other.ok, false)
  assert.match(other.hint, /覆盖升级/)
  assert.equal(certsEqual(CERT, 'xyz').ok, false, '期望值格式非法也要红，不能当通过')
  assert.equal(certsEqual('', CERT).ok, false)
})

test('构建锁：进程活着=忙，死了=陈旧锁可忽略，没锁=空闲', () => {
  assert.deepEqual(lockState(() => null, () => true), { busy: false })
  assert.deepEqual(lockState(() => 123, () => true), { busy: true, pid: 123 })
  assert.deepEqual(lockState(() => 123, () => false), { busy: false, stale: 123 })
})

test('--dry-run 端到端：缺 package.json 的目录 exit 1；真仓库不写任何文件、不改 git 状态', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'howto-empty-'))
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', empty], { encoding: 'utf8' })
    assert.equal(r.status, 1, '不是仓库根必须 exit 1')
    assert.match(r.stderr + r.stdout, /不是仓库根/)
  } finally { fs.rmSync(empty, { recursive: true, force: true }) }

  const usage = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' })
  assert.equal(usage.status, 2, '未知参数 exit 2')

  const before = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout
  const ls = () => fs.readdirSync(path.join(ROOT, 'android'))
  const androidBefore = ls().join()
  const dry = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', ROOT], { encoding: 'utf8', cwd: os.tmpdir() })
  assert.doesNotMatch(dry.stdout, /\.\.\/\S*--(apk|tag)/, '打印的命令里 --apk/--tag 不许被当成路径相对化')
  const after = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout
  assert.equal(after, before, 'dry-run 不许改变工作区')
  assert.equal(ls().join(), androidBefore, 'dry-run 不许往 android/ 写东西')
  assert.equal(fs.existsSync(path.join(ROOT, 'build/release-secrets')), false, 'dry-run 不许解密出凭据')
})
