// [layer: unit | 纯 Node，无浏览器无网络（faux ssh 不打）| 耗时: <1s]
// 私有（internal）包发布管线的**纯函数**契约。
//
// #609 / 裁决 #614 决定 3 之后这条管线换了目标：私有包**不进公网清单**，改走 webroot 之外的
// 私有清单（`releases.internal.json`）。所以下面三处的口径都跟着变了，钉得更紧：
//   1) 不可猜测文件名：随机段必须来自 crypto.randomBytes（8 个 base32 字符、不重复），
//      不许出现时间戳/进程号那种可枚举的东西；
//   2) 清单合并：**两种目标的 latest 语义相反**（public 一个字节不许动 / private 必须跟着走）、
//      既有条目原样保留、新条目按 versionCode 降序插入、同 version+同变体是替换（重发幂等）；
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
/** 私有清单的形状（#609：webroot 之外的那份） */
const privateFixture = path.join(ROOT, 'deploy/dl-release/fixtures/private-valid-internal.json')
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

test('合并（公网目标）：latest 一个字节不动、既有条目原样、新条目按 versionCode 降序插入', () => {
  const before = JSON.parse(fs.readFileSync(liveFixture, 'utf8'))
  const entry = entryFor({ versionCode: 12, variant: 'standard' })
  const after = mergeEntry(before, entry)

  assert.equal(after.latest, before.latest, '公网清单的 latest 被改了（dl 不再是正式渠道，见裁决 #614 决定 2）')
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
  const before = JSON.parse(fs.readFileSync(privateFixture, 'utf8'))
  const once = mergeEntry(before, entryFor({ versionCode: 30 }), { updateLatest: true })
  const twice = mergeEntry(once, entryFor({ versionCode: 30, sha256: sha('c') }), { updateLatest: true })
  assert.equal(twice.releases.length, once.releases.length)
  assert.equal(twice.releases.filter((r) => r.version === '1.4.2').length, 1)
  assert.equal(twice.releases.find((r) => r.version === '1.4.2').sha256, sha('c'))
})

test('合并（私有目标）：latest **必须**跟着走 —— 私有清单的「最新内测版」就是刚发的那条', () => {
  const before = JSON.parse(fs.readFileSync(privateFixture, 'utf8'))
  assert.equal(before.latest, '1.4.3', 'fixture 变了？私有清单的 latest 应该等于头部那条')
  const entry = entryFor({ version: '1.4.4', versionCode: 30 })
  const after = mergeEntry(before, entry, { updateLatest: true })
  assert.equal(after.latest, '1.4.4', '私有清单的 latest 必须指向新条目（客户端靠它取更新）')
  assert.equal(after.releases[0].version, '1.4.4')
  // 不带 updateLatest 时保持原值（公网目标的语义），两种目标共用同一个合并函数
  assert.equal(mergeEntry(before, entry).latest, before.latest)
})

test('写回前自检（私有目标）：latest 没跟上 / 丢了既有条目 / 非法 buildType / sha256 不一致 —— 全部拦下', () => {
  const before = JSON.parse(fs.readFileSync(privateFixture, 'utf8'))
  const entry = entryFor({ version: '1.4.4', versionCode: 30 })
  const good = mergeEntry(before, entry, { updateLatest: true })
  assert.deepEqual(verifyMerge({ before, after: good, entry, target: 'private' }).errors, [], '合法合并不该报错')

  // 1) latest 没跟上（私有清单里「最新」与头部不一致 = 两个最新）
  const badLatest = { ...good, latest: before.latest }
  assert.match(
    verifyMerge({ before, after: badLatest, entry, target: 'private' }).errors.join('\n'),
    /latest\(.*\) 必须等于 releases\[0\]\.version/,
  )

  // 2) 既有条目被删
  const lost = { ...good, releases: good.releases.filter((r) => r.version !== '1.4.2') }
  assert.match(verifyMerge({ before, after: lost, entry, target: 'private' }).errors.join('\n'), /既有条目丢了/)

  // 3) buildType 写成了 Gradle 的 release（#330 事故形态）→ 复用校验器枚举，必须拦
  const badType = { ...good, releases: good.releases.map((r) => (r.version === '1.4.4' ? { ...r, buildType: 'release' } : r)) }
  assert.match(
    verifyMerge({ before, after: badType, entry, target: 'private' }).errors.join('\n'),
    /buildType 只能是 stable\|prerelease/,
  )

  // 4) artifactVariant 第三种值 → 拦
  const badVariant = { ...good, releases: good.releases.map((r) => (r.version === '1.4.4' ? { ...r, artifactVariant: 'debug' } : r)) }
  assert.match(
    verifyMerge({ before, after: badVariant, entry, target: 'private' }).errors.join('\n'),
    /artifactVariant 只能是 internal\|standard/,
  )

  // 5) 条目 sha256 与产物不一致 → 拦
  const badSha = { ...good, releases: good.releases.map((r) => (r.version === '1.4.4' ? { ...r, sha256: sha('d') } : r)) }
  assert.match(verifyMerge({ before, after: badSha, entry, target: 'private' }).errors.join('\n'), /sha256 与产物不一致/)

  // 6) #609：私有清单里混进 standard 条目 → 拦（口径互斥的另一半）
  const withStandard = {
    ...good,
    releases: good.releases.map((r) => (r.version === '1.4.4' ? { ...r, artifactVariant: 'standard' } : r)),
  }
  assert.match(
    verifyMerge({ before, after: withStandard, entry, target: 'private' }).errors.join('\n'),
    /私有清单只收 artifactVariant="internal"/,
  )
})

test('写回前自检（公网目标）：只允许「补登记历史条目」；latest 动了 / 混进 internal —— 拦（#609 的核心）', () => {
  // 公网 `releases.json` 在裁决 #614 决定 2 之后是**冻结**的（dl 不再是正式渠道）：
  // 唯一还合法的写入是「补登记一条历史上漏掉的标准包」—— 它必须排在头部之下，
  // 这样 latest 才不用动。这里就用这个形状做正例。
  const full = JSON.parse(fs.readFileSync(liveFixture, 'utf8'))
  const before = { ...full, releases: full.releases.filter((r) => r.version !== '1.3.0') };
  const backfill = entryFor({ version: '1.3.0', versionCode: 7, variant: 'standard' })
  const good = mergeEntry(before, backfill)
  assert.deepEqual(verifyMerge({ before, after: good, entry: backfill, target: 'public' }).errors, [], '补登记历史条目不该报错')
  assert.equal(good.latest, full.latest, '补登记不许动 latest')

  // 公网 latest 一个字节都不许动
  const moved = { ...good, latest: '1.3.0' }
  assert.match(verifyMerge({ before, after: moved, entry: backfill, target: 'public' }).errors.join('\n'), /latest 被改了/)

  // 公网清单里出现 internal 条目 → schema 层就红（口径互斥），这是 #601 的事故形状
  const internal = entryFor({ version: '1.3.0', versionCode: 7, variant: 'internal' })
  const withInternal = mergeEntry(before, internal)
  assert.match(
    verifyMerge({ before, after: withInternal, entry: internal, target: 'public' }).errors.join('\n'),
    /公网清单不得出现 internal 条目/,
  )

  // 反过来：#609 之后「往公网清单追加一条**新的**标准包」也不再合法 —— 新条目会顶到头部，
  // latest 必须跟着动，而 latest 不许动 → 两条路都堵死 = dl 的清单被冻结（这正是决定 2 要的）。
  const fresh = entryFor({ version: '1.4.1', versionCode: 12, variant: 'standard' })
  const appended = mergeEntry(full, fresh)
  assert.match(
    verifyMerge({ before: full, after: appended, entry: fresh, target: 'public' }).errors.join('\n'),
    /latest\s*\(.*\) 必须等于 releases\[0\]\.version/,
  )
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
