// [layer: unit | 纯 Node，无浏览器无网络（faux ssh 不打）| 耗时: <1s]
// Issue #566 问题 1（B 方案）：私有（internal）包发布管线的**纯函数**契约。
//
// 这条管线最容易「看起来对」的三处，全部钉成断言：
//   1) 不可猜测文件名：随机段必须来自 crypto.randomBytes（8 个 base32 字符、不重复），
//      不许出现时间戳/进程号那种可枚举的东西；
//   2) 清单合并：**公共 latest 一个字节都不许动**、既有条目原样保留、新条目按 versionCode 降序插入、
//      同 version+同变体是替换（重发幂等）；
//   3) 写回前的 schema 校验：复用 scripts/validate-releases-manifest.mjs（buildType 只能是
//      stable|prerelease、artifactVariant 只能是 internal|standard），非法值一个都不许放过去。
//
// 真正的「上传 + 清单改动 + 回滚」由 `--exercise` 在 DL 主机上跑（PR 里贴现场输出），
// 这里只测不联网的那一半，保证红线逻辑本身没写歪。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const {
  buildEntry,
  buildFileName,
  fileField,
  mergeEntry,
  parseBadging,
  randomSuffix,
  shanghaiTimestamp,
  verifyMerge,
  VARIANTS,
  FILE_PREFIX,
} = await import('../../scripts/publish-private-apk.mjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const liveFixture = path.join(ROOT, 'deploy/dl-release/fixtures/live-2026-11-18.json')
const sha = (c) => c.repeat(64)

/** 造一条能过 schema 的条目 */
const entryFor = (over = {}) =>
  buildEntry({
    version: '1.4.2',
    versionCode: 12,
    variant: 'internal',
    fileName: 'deepseek-chat-1.4.2-internal-7QF2ZK3M.apk',
    size: 6870715,
    md5: 'a'.repeat(32),
    sha256: sha('b'),
    changes: ['私有构建'],
    releasedAt: '2026-11-20T23:10:00+08:00',
    ...over,
  })

test('随机段：8 个 base32 字符，来自 crypto.randomBytes，且不重复（时间戳做不到这一点）', () => {
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const s = randomSuffix()
    assert.equal(s.length, 8, `长度不对：${s}`)
    assert.match(s, /^[A-Z2-7]{8}$/, `字符集不对（只允许 A-Z2-7，避免 0/1 与 I/O 混淆）：${s}`)
    assert.ok(!seen.has(s), `500 次里出现重复：${s}（随机源退化成常量/时间戳？）`)
    seen.add(s)
  }
  // 同毫秒内两次调用也必须不同（用时间戳做种子就会在这里撞）
  assert.notEqual(randomSuffix(), randomSuffix())
})

test('文件名：deepseek-chat-<version>-<variant>-<8位随机>.apk，且拒绝非法入参', () => {
  const name = buildFileName({ version: '1.4.2', variant: 'internal', suffix: 'ABCDEFGH' })
  assert.equal(name, `${FILE_PREFIX}-1.4.2-internal-ABCDEFGH.apk`)
  assert.equal(fileField(name), `apk/${name}`)
  // 清单契约要求 file 是 apk/<name>.apk
  assert.match(fileField(name), /^apk\/[A-Za-z0-9._-]+\.apk$/)

  assert.throws(() => buildFileName({ version: 'v1.4.2', variant: 'internal', suffix: 'ABCDEFGH' }), /version 格式非法/)
  assert.throws(() => buildFileName({ version: '1.4.2', variant: 'debug', suffix: 'ABCDEFGH' }), /variant 只能是/)
  assert.throws(() => buildFileName({ version: '1.4.2', variant: 'internal', suffix: 'abc' }), /随机段必须正好 8 个/)
  assert.throws(() => buildFileName({ version: '1.4.2', variant: 'internal', suffix: 'ABCDEFG0' }), /随机段必须正好 8 个/)
})

test('条目：buildType 由版本号判定（内测包也可以是 stable），变体来源留痕，releasedAt 合契约', () => {
  const stable = entryFor()
  assert.equal(stable.buildType, 'stable')
  assert.equal(stable.artifactVariant, 'internal')
  assert.equal(stable.artifactVariantSource, 'apk-manifest')
  assert.equal(stable.versionCode, 12)
  assert.match(stable.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  assert.equal(entryFor({ version: '1.4.2-beta.1' }).buildType, 'prerelease')
  // 变体与 buildType 是两个维度：internal + prerelease / internal + stable 都合法
  assert.ok(VARIANTS.includes(stable.artifactVariant))
  assert.match(shanghaiTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
})

test('合并：latest 一个字节不动、既有条目原样、新条目按 versionCode 降序插入', () => {
  const before = JSON.parse(fs.readFileSync(liveFixture, 'utf8'))
  const entry = entryFor({ versionCode: 12 })
  const after = mergeEntry(before, entry)

  assert.equal(after.latest, before.latest, 'latest 被改了')
  assert.equal(after.releases.length, before.releases.length + 1)
  // versionCode 严格降序（校验器的硬规则）
  const codes = after.releases.map((r) => r.versionCode)
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i - 1] > codes[i], `第 ${i} 条不严格降序：${codes.join(',')}`)
  // 既有条目逐条 JSON 相同（连字段顺序都不许动）
  for (const old of before.releases) {
    const still = after.releases.find((r) => r.version === old.version)
    assert.equal(JSON.stringify(still), JSON.stringify(old))
  }
  // 不可变：不修改入参
  assert.equal(before.releases.length, JSON.parse(fs.readFileSync(liveFixture, 'utf8')).releases.length)
})

test('合并：同 version + 同变体是替换（重发幂等），不会变成两条', () => {
  const before = JSON.parse(fs.readFileSync(liveFixture, 'utf8'))
  const once = mergeEntry(before, entryFor({ versionCode: 12 }))
  const twice = mergeEntry(once, entryFor({ versionCode: 12, sha256: sha('c') }))
  assert.equal(twice.releases.length, once.releases.length)
  assert.equal(twice.releases.filter((r) => r.version === '1.4.2').length, 1)
  assert.equal(twice.releases.find((r) => r.version === '1.4.2').sha256, sha('c'))
  assert.equal(twice.latest, before.latest)
})

test('写回前自检：latest 变了 / 丢了既有条目 / 非法 buildType / sha256 不一致 —— 全部拦下', () => {
  const before = JSON.parse(fs.readFileSync(liveFixture, 'utf8'))
  const entry = entryFor({ versionCode: 12 })
  const good = mergeEntry(before, entry)
  assert.deepEqual(verifyMerge({ before, after: good, entry }).errors, [], '合法合并不该报错')

  // 1) latest 被改
  const badLatest = { ...good, latest: '1.4.2' }
  assert.match(verifyMerge({ before, after: badLatest, entry }).errors.join('\n'), /latest 被改了/)

  // 2) 既有条目被删
  const lost = { ...good, releases: good.releases.filter((r) => r.version !== '1.3.0') }
  assert.match(verifyMerge({ before, after: lost, entry }).errors.join('\n'), /既有条目丢了/)

  // 3) buildType 写成了 Gradle 的 release（#330 事故形态）→ 复用校验器枚举，必须拦
  const badType = { ...good, releases: good.releases.map((r) => (r.version === '1.4.2' ? { ...r, buildType: 'release' } : r)) }
  assert.match(verifyMerge({ before, after: badType, entry }).errors.join('\n'), /buildType 只能是 stable\|prerelease/)

  // 4) artifactVariant 第三种值 → 拦
  const badVariant = { ...good, releases: good.releases.map((r) => (r.version === '1.4.2' ? { ...r, artifactVariant: 'debug' } : r)) }
  assert.match(verifyMerge({ before, after: badVariant, entry }).errors.join('\n'), /artifactVariant 只能是 internal\|standard/)

  // 5) 条目 sha256 与产物不一致 → 拦
  const badSha = { ...good, releases: good.releases.map((r) => (r.version === '1.4.2' ? { ...r, sha256: sha('d') } : r)) }
  assert.match(verifyMerge({ before, after: badSha, entry }).errors.join('\n'), /sha256 与产物不一致/)
})

test('aapt2 dump badging 解析：package / versionCode / versionName / debuggable 计数', () => {
  const ok = parseBadging(
    [
      "package: name='com.example.deepseekchat' versionCode='21' versionName='1.4.2' compileSdkVersion='35'",
      "sdkVersion:'24'",
      "launchable-activity: name='com.example.MainActivity'  label='' icon=''",
      '',
    ].join('\n'),
  )
  assert.equal(ok.packageName, 'com.example.deepseekchat')
  assert.equal(ok.versionCode, 21)
  assert.equal(ok.versionName, '1.4.2')
  assert.equal(ok.debuggableLines, 0, '干净包不该出现 application-debuggable')

  const dirty = parseBadging(
    "package: name='com.example.deepseekchat' versionCode='21' versionName='1.4.2'\napplication-debuggable\n",
  )
  assert.equal(dirty.debuggableLines, 1, 'debuggable 包必须被数出来（哪怕是个无值属性行）')
  // 完全没有 package 行 = 不是 APK，解析不出任何东西（调用方必须当失败）
  const junk = parseBadging('not a badging dump')
  assert.equal(junk.packageName, null)
  assert.equal(junk.versionCode, null, '解析不出版本号时必须是 null，不是 0')
})
