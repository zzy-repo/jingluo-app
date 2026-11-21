// [layer: L1（零 Android SDK 可跑：假 aapt2 + 真 ZIP/AXML + 真 HTTP 服务） | 耗时: ~2s]
//
// 闸 2 —— **回环 consume 包传不上去**（Issue #601）。
//
// 事故背景（#601）：1.4.2 的 internal 包带着 `consume.baseUrl = http://127.0.0.1:18000`
// 进了公网分发清单，靠人工隔离才收住。闸 1（`android/app/build.gradle`）保证这种包**出不来**
// （除非显式 `-PallowLoopbackConsume=true`，那时会在 AndroidManifest 里埋
// `<meta-data …LOOPBACK_CONSUME="true">`）；本文件覆盖闸 2：**带这个标记的包进不了库**。
//
// 为什么必须起真服务端：这道闸在 `POST /api/v1/release` 的校验链里，它的价值等于
// 「拒收之后 releases.json / apk 目录**一个字节都没变**」—— 打桩只能证明函数返回了什么，
// 证明不了没落盘。所以这里沿用 `domain10-server-contract.test.mjs` 的做法：
//   · **真** server.mjs 进程 + 真临时 releases.json / apk 目录；
//   · **真** ZIP + **真** 二进制 AXML（`tests/fixtures/domain10/apk-fixture.mjs` 现支持 meta-data）；
//   · 只有 aapt2 是假的（本机没有这个二进制）—— 它只回放 badging 文本。
// 关键点：标记是**真的从 AXML 字节里读出来的**（`apk-manifest.mjs` 零依赖解析），
// 不是 mock 一个「解析结果」—— 被 mock 掉的校验分支证明不了线上那道闸会咬。
//
// 覆盖的分支：
//   L1 标记 = true            → 400 LOOPBACK_BUILD_REJECTED，零副作用（不落盘、清单字节不变）
//   L2 回环标记缺失（老包）    → 200 放行（**不能误伤历史包**；包本身是 standard 变体，见上）
//   L3 标记 = false           → 200 放行（普通 https 构建）
//   L4 标记 = true + 版本号更小 → 仍是 400 LOOPBACK（闸 2 排在防降级之前，先报更准确的原因）
//   L5 解析层（不起服务）      → 认不出 / 空值 / 坏字节 一律 loopback:false，且 reason 说清为什么
//
// 运行：
//   node --test deploy/dl-release/test/loopback-consume-601.test.mjs   # 或 npm run test:dl-release

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApk } from '../../../tests/fixtures/domain10/apk-fixture.mjs'
import { loopbackFromManifest, metaDataFromManifest, readZipEntry } from '../apk-manifest.mjs'
import { DEFAULT_LOOPBACK_MARKER } from '../variant.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')
const MARKER = DEFAULT_LOOPBACK_MARKER
const VARIANT_MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT'

/** 三种包：回环标记 true / 老包（无标记）/ 普通包（显式 false） */
const LOOPBACK_APK = buildApk({
  metaData: { [MARKER]: 'true', [VARIANT_MARKER]: 'internal' },
  versionName: '1.4.2',
  versionCode: 21,
})
// 同一个标记、但按「布尔」编码：真实 aapt2 把 android:value="true" 编成 TYPE_INT_BOOLEAN 时就是
// 这个样子（没有 rawValue，只有 data≠0）。少认这一种，线上闸 2 会静默失效。
const LOOPBACK_APK_BOOL = buildApk({
  metaData: { [MARKER]: true, [VARIANT_MARKER]: 'internal' },
  versionName: '1.4.3',
  versionCode: 22,
})
// 包 2/3 都是 **standard** 变体：本文件验的是「回环标记」这一道闸，#620 起公网端点还要求
// artifactVariant === "standard"，两者不能混在一起 —— 否则 L2/L3 会被变体闸拒而看不出回环闸的行为。
const LEGACY_APK = buildApk({ metaData: { [VARIANT_MARKER]: 'standard' }, versionName: '1.4.2', versionCode: 21 })
const CLEAN_APK = buildApk({ metaData: { [MARKER]: 'false', [VARIANT_MARKER]: 'standard' }, versionName: '1.4.2', versionCode: 21 })

/**
 * 假 aapt2 回放的 xmltree 文本（变体标记）。#620 起公网端点要求 artifactVariant === "standard"，
 * 本文件不测变体，所以默认回放 standard；回环标记仍由 apk-manifest.mjs 从**真 AXML 字节**里读。
 */
const xmltreeOf = (variant) =>
  [
    'E: manifest (line=2)',
    'E: application (line=6)',
    '  E: meta-data (line=7)',
    `    A: http://schemas.android.com/apk/res/android:name(0x01010003)="${VARIANT_MARKER}"`,
    `    A: http://schemas.android.com/apk/res/android:value(0x01010024)="${variant}"`,
    '',
  ].join('\n')

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const sha256File = (file) => sha256Of(fs.readFileSync(file))

const badgingOf = (versionName, versionCode, packageName = 'com.example.deepseekchat') =>
  `package: name='${packageName}' versionCode='${versionCode}' versionName='${versionName}'\n`

const record = (over = {}) => ({
  version: '1.4.1',
  versionCode: 20,
  releasedAt: '2026-11-20T10:00:00+08:00',
  file: 'apk/deepseek-chat-1.4.1.apk',
  size: 4096,
  md5: '0'.repeat(32),
  sha256: 'a'.repeat(64),
  changes: ['既有版本'],
  buildType: 'stable',
  breaking: false,
  // #620：种子的公网清单必须是干净的（只含 standard）—— 公网清单里出现 internal 条目时，
  // 服务端会在写盘前整单拒收（MANIFEST_INTERNAL_ENTRY），L2/L3 的「放行」就无从验证了。
  artifactVariant: 'standard',
  artifactVariantSource: 'apk-manifest',
  ...over,
})

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

/** 起一台真服务端（独立临时目录 / 独立端口），只把 aapt2 换成回放 badging 的假货 */
const startServer = async ({ seed = { latest: '1.4.1', releases: [record()] }, badging = badgingOf('1.4.2', 21) } = {}) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-601-'))
  const apkDir = path.join(work, 'apk')
  fs.mkdirSync(apkDir)
  const token = `loopback-601-${process.pid}-${Date.now()}`
  // #641：读/写两枚令牌（写端点只认 publish-token）
  const tokenFile = path.join(work, 'token')
  fs.writeFileSync(tokenFile, `${token}-read\n`, { mode: 0o600 })
  const publishTokenFile = path.join(work, 'publish-token')
  fs.writeFileSync(publishTokenFile, `${token}\n`, { mode: 0o600 })
  const releasesFile = path.join(work, 'releases.json')
  fs.writeFileSync(releasesFile, `${JSON.stringify(seed, null, 2)}\n`)
  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, `${JSON.stringify({ apks: {} }, null, 2)}\n`)

  const badgingFile = path.join(work, 'badging.txt')
  const xmltreeFile = path.join(work, 'xmltree.txt')
  fs.writeFileSync(badgingFile, badging)
  // 变体标记回放 standard：本文件不测变体；#620 的公网端点要求 standard 才收（见 xmltreeOf）
  fs.writeFileSync(xmltreeFile, xmltreeOf('standard'))
  const stub = path.join(work, 'aapt2')
  fs.writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "dump" ] && [ "$2" = "badging" ]; then cat "${badgingFile}"; fi
if [ "$1" = "dump" ] && [ "$2" = "xmltree" ]; then cat "${xmltreeFile}"; fi
exit 0
`,
    { mode: 0o755 },
  )

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_PUBLISH_TOKEN_FILE: publishTokenFile,
      DL_APK_DIR: apkDir,
      DL_RELEASES_JSON: releasesFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_AAPT2: stub,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: '1000',
      DL_PUBLIC_BASE: 'https://dl.example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) break
    } catch {
      // 还没起来
    }
    if (child.exitCode !== null) throw new Error(`服务退出 code=${child.exitCode}:\n${logs.join('')}`)
    if (attempt > 100) throw new Error(`服务 10s 内没起来:\n${logs.join('')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return {
    port,
    token,
    apkDir,
    releasesFile,
    logs,
    post: async (meta = { changes: ['回环包'] }, { apk = CLEAN_APK } = {}) => {
      const form = new FormData()
      form.set('apk', new Blob([apk]), 'app-release.apk')
      form.set('meta', JSON.stringify(meta))
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: res.status, json, text }
    },
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill('SIGTERM')
      }),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

const withServer = async (body, setup) => {
  const ctx = await startServer(setup)
  const before = { apk: fs.readdirSync(ctx.apkDir), releases: sha256File(ctx.releasesFile) }
  try {
    await body(ctx, before)
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
}

/** 拒收之后必须「什么都没变」：apk 目录、releases.json 字节、临时文件残留三件一起看 */
const assertNothingWritten = (ctx, before, label) => {
  assert.deepEqual(fs.readdirSync(ctx.apkDir), before.apk, `${label}：apk 目录不许有落盘或 .upload-* 残留`)
  assert.equal(sha256File(ctx.releasesFile), before.releases, `${label}：releases.json 必须字节不变`)
}

test('L1 回环标记的包 → 400 LOOPBACK_BUILD_REJECTED，且一个字节都不落盘（#601 闸 2）', async () => {
  await withServer(async (ctx, before) => {
    const result = await ctx.post({ buildType: 'prerelease', changes: ['回环包'] }, { apk: LOOPBACK_APK })
    assert.equal(result.status, 400, `应 400 拒收，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.ok, false, '失败回包必须 ok:false')
    // 短码：与 #330 的新错误码同口径，顶层 code 与 error.code 同值
    assert.equal(result.json?.error?.code, 'LOOPBACK_BUILD_REJECTED')
    assert.equal(result.json?.code, 'LOOPBACK_BUILD_REJECTED')
    // 文案要说清「该包仅用于本地联调」，并给出怎么办
    assert.match(result.json?.message ?? '', /仅用于本地联调/)
    assert.match(result.json?.message ?? '', /127\.0\.0\.1/)
    assert.match(result.json?.message ?? '', /consume\.baseUrl/)
    assertNothingWritten(ctx, before, '400 回环包')
    // 拒绝理由要能被运维 grep 到（journalctl 只有这一处能看到「为什么没收」）
    assert.match(ctx.logs.join(''), /reject_loopback_build/, '拒收必须留日志事件 reject_loopback_build')
  })
})

test('L1b 标记按「布尔」编码（aapt2 真实形态之一）→ 同样 400 LOOPBACK_BUILD_REJECTED', async () => {
  await withServer(async (ctx, before) => {
    const result = await ctx.post({ buildType: 'prerelease', changes: ['回环布尔编码包'] }, { apk: LOOPBACK_APK_BOOL })
    assert.equal(result.status, 400, `应 400 拒收，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.error?.code, 'LOOPBACK_BUILD_REJECTED')
    assertNothingWritten(ctx, before, '400 回环布尔编码包')
  })
})

test('L2 回环标记缺失（历史包）→ 200 放行：不因读不到标记而误伤（#601 闸 2）', async () => {
  await withServer(async (ctx, before) => {
    // #620：公网端点只收 buildType="stable"（pre 版本走 GitHub Release），所以这里用 stable
    const result = await ctx.post({ buildType: 'stable', changes: ['老包'] }, { apk: LEGACY_APK })
    assert.equal(result.status, 200, `历史包必须放行，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.ok, true)
    assert.equal(result.json?.sha256, sha256Of(LEGACY_APK), '回包 sha256 必须是服务端自己算的字节摘要')
    const manifest = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
    assert.equal(manifest.latest, '1.4.2', '放行的包必须真的入库')
    assert.ok(
      fs.readdirSync(ctx.apkDir).includes('deepseek-chat-1.4.2.apk'),
      `放行的包必须真的落盘，实际 ${fs.readdirSync(ctx.apkDir).join(',')}`,
    )
    assert.notDeepEqual(fs.readdirSync(ctx.apkDir), before.apk, '200 时 apk 目录应有新文件（对照组）')
    assert.match(ctx.logs.join(''), /loopback_marker.*reason="marker_absent"/, '放行也要留证据：读不到标记')
  })
})

test('L3 标记 = false（普通 https 构建）→ 200 放行', async () => {
  await withServer(async (ctx) => {
    const result = await ctx.post({ buildType: 'stable', changes: ['普通包'] }, { apk: CLEAN_APK })
    assert.equal(result.status, 200, `标记 false 必须放行，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.sha256, sha256Of(CLEAN_APK))
    assert.match(ctx.logs.join(''), /loopback_marker.*reason="marker_false"/)
  })
})

test('L4 闸 2 排在防降级之前：回环包即使版本号也更小，仍先报 400 LOOPBACK（不是 409）', async () => {
  // 版本号 19（< latest 20）：若顺序反了会先 409 VERSION_CONFLICT，掩盖真正的原因
  await withServer(async (ctx, before) => {
    const result = await ctx.post({ buildType: 'prerelease', changes: ['回环降级包'] }, { apk: LOOPBACK_APK })
    assert.equal(result.status, 400, `应 400，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.error?.code, 'LOOPBACK_BUILD_REJECTED')
    assertNothingWritten(ctx, before, '400 回环包（顺序用例）')
  }, {
    seed: { latest: '1.4.1', releases: [record({ version: '1.4.1', versionCode: 22 })] },
    badging: badgingOf('1.4.2', 21),
  })
})

// ------------------------------------------------------------------ L5 解析层（不起服务）

test('L5 解析层：只有显式 true 才算回环包；读不到 / 认不出 → false 且 reason 说清原因', () => {
  const axmlOf = (metaData) => readZipEntry(buildApk({ metaData }), 'AndroidManifest.xml')

  // 真正从 AXML 字节里读出来（不是 mock 的解析结果）
  const map = metaDataFromManifest(axmlOf({ [MARKER]: 'true', [VARIANT_MARKER]: 'internal' }))
  assert.equal(map.get(MARKER), 'true')
  assert.equal(map.get(VARIANT_MARKER), 'internal')

  assert.deepEqual(
    (({ loopback, reason }) => ({ loopback, reason }))(loopbackFromManifest(axmlOf({ [MARKER]: 'true' }), MARKER)),
    { loopback: true, reason: 'marker_true' },
  )
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: 'TRUE' }), MARKER).loopback, true, '取值大写也算（构建期可能改成 TRUE）')
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: 'false' }), MARKER).loopback, false)
  // 布尔 / 整数编码（aapt2 的真实形态之一）：漏了这一种，真实回环包会被判成「认不出」而放行
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: true }), MARKER).loopback, true, '布尔编码的 true 也是回环包')
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: 1 }), MARKER).loopback, true, '整数编码的 1 也是回环包')
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: false }), MARKER).loopback, false)
  assert.equal(loopbackFromManifest(axmlOf({}), MARKER).reason, 'marker_absent', '老包没有这一条')
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: 'yes' }), MARKER).reason, 'marker_undecodable', '认不出就明说')
  assert.equal(loopbackFromManifest(Buffer.from('not axml'), MARKER).reason, 'axml_parse_failed')
  // 空值的 meta-data（占位符没被替换时就是这样）不能当成 true
  assert.equal(loopbackFromManifest(axmlOf({ [MARKER]: '' }), MARKER).loopback, false)
})

test('本文件钉住的两个常量与构建侧同源（改了 build.gradle / variant.mjs 必须同步）', () => {
  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8')
  const appManifest = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
  // 闸 1 的逃生舱 + 标记写入点存在（闸 2 读的就是它）
  assert.match(gradle, /allowLoopbackConsume/, 'build.gradle 必须有 -PallowLoopbackConsume 逃生舱')
  assert.match(gradle, /LOOPBACK_CONSUME/, 'build.gradle 必须把回环标记写进产物')
  assert.match(
    appManifest,
    /<meta-data android:name="\$\{applicationId\}\.LOOPBACK_CONSUME" android:value="\$\{loopbackConsume\}" \/>/,
    'AndroidManifest 必须有 LOOPBACK_CONSUME 的 meta-data（闸 2 的唯一读取点）',
  )
  // 两侧的标记名必须是同一个（服务端默认值 = variant.mjs 的常量）
  const server = fs.readFileSync(path.join(ROOT, 'deploy/dl-release/server.mjs'), 'utf8')
  assert.match(server, /DEFAULT_LOOPBACK_MARKER/, 'server.mjs 必须用 variant.mjs 的标记常量，不许另写一份字面量')
  assert.equal(MARKER, 'com.example.deepseekchat.LOOPBACK_CONSUME')
})
