// [layer: L1（零 Android SDK：假 aapt2 只把**真 AXML 字节**里的事实转述成 aapt2 文本 + 真 HTTP 服务）| 耗时: ~5s]
//
// #620 —— **发布接口层的变体闸**：`POST /api/v1/release` 仍能把 internal 包写进公网清单。
//
// 事故形状（#601 的复刻）：#609 / PR #619 的四条硬闸只守住**脚本路径**
// （`scripts/publish-private-apk.mjs`）。服务端接口这条路当时只校验 buildType，
// **根本不看 artifactVariant** —— 于是脚本层的闸可以被一次 HTTP 上传绕过。
// 「能不能发」必须由接口拒绝，而不是靠调用方自觉。
//
// 本文件钉住的行为（全部走**真的 HTTP handler**，不是打桩函数）：
//   V1 公网端点 + internal 包（APK 内标记 = internal） → 400 VARIANT_NOT_PUBLIC，公网清单 **字节不变**
//   V2 公网端点 + 变体判不出来（无标记/无白名单）      → 400 VARIANT_NOT_PUBLIC（不默认 standard）
//   V3 公网端点 + standard 包但渠道是 prerelease（显式 / 按版本号推导）→ 400 BUILD_TYPE_NOT_PUBLIC
//   V4 **负向对照**：干净(200) → 注入 internal POST(4xx + sha256 不变) → 还原(200)
//   V5 私网端点 + internal 包 → 200 写私有清单（线上实况 /var/www/dl-private/releases.internal.json），公网清单**一字未动**
//   V6 私网端点 + standard 包 → 400 VARIANT_NOT_PRIVATE（standard 走 GitHub Release）
//   V10 私网端点 + 显式 buildType=prerelease → 200 原样写入（私有清单不限渠道，#330 的语义保留）
//   V7 公网清单历史上已有 internal 条目 → 合并后整份校验 409 MANIFEST_INTERNAL_ENTRY（写盘前 fail-closed）
//   V8 启动期硬门禁：私有根落在 webroot 内 → 进程拒绝启动（exit 1）
//   V9 /api/v1/version 自证两个目标（部署验收能核对「闸在不在」）
//
// 为什么 aapt2 是假的、而其它都是真的：本机/CI 没有 aapt2 二进制（真机在线上
// /opt/dl-release/bin/aapt2）。这里让假 aapt2 **从真 ZIP 里读真 AXML 字节再转述**成 aapt2 的
// 文本输出 —— 变体标记、包名、版本号都不是「测试写好的字符串」。否则被 mock 掉的校验分支
// 证明不了线上那道闸会咬。
//
// 运行：node --test deploy/dl-release/test/server-variant-gate-620.test.mjs（或 npm run test:dl-release）

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
import { validate as validateManifest } from '../../../scripts/validate-releases-manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')
const APK_MANIFEST = path.join(ROOT, 'deploy/dl-release/apk-manifest.mjs')
const VARIANT_MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT'

/** 四类包：公网合法的 standard / 必须被拒的 internal / 判不出变体的老包 / 预发布版本号 */
const APK_STANDARD = buildApk({ metaData: { [VARIANT_MARKER]: 'standard' }, versionName: '1.4.3', versionCode: 22 })
const APK_STANDARD_V2 = buildApk({ metaData: { [VARIANT_MARKER]: 'standard' }, versionName: '1.4.4', versionCode: 23 })
const APK_INTERNAL = buildApk({ metaData: { [VARIANT_MARKER]: 'internal' }, versionName: '1.4.3', versionCode: 22 })
const APK_UNKNOWN = buildApk({ versionName: '1.4.3', versionCode: 22 })
const APK_PRERELEASE = buildApk({ metaData: { [VARIANT_MARKER]: 'standard' }, versionName: '1.4.4-beta.1', versionCode: 23 })

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const sha256File = (file) => sha256Of(fs.readFileSync(file))

/** 公网清单里的一条标准的（standard + stable）历史记录 */
const record = (over = {}) => ({
  version: '1.4.2',
  versionCode: 21,
  releasedAt: '2026-11-20T10:00:00+08:00',
  file: 'apk/deepseek-chat-1.4.2.apk',
  size: 4096,
  md5: '0'.repeat(32),
  sha256: 'a'.repeat(64),
  changes: ['历史标准包'],
  buildType: 'stable',
  breaking: false,
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

/**
 * 假 aapt2：**从真 ZIP 里的真 AXML 字节**转述 aapt2 的两种输出。
 *   dump badging  → 包名 / versionCode / versionName（解自 AXML 属性）
 *   dump xmltree  → manifest 下每个 meta-data 的 name / value（变体标记、回环标记都从这里读）
 */
const STUB_SOURCE = (manifestModule) => `#!/usr/bin/env node
import fs from 'node:fs';
import { parseBinaryXml, readZipEntry } from ${JSON.stringify(manifestModule)};

const argv = process.argv.slice(2);
if (argv[0] !== 'dump') process.exit(2);
const mode = argv[1];
const file = argv[2];
let doc;
try {
  doc = parseBinaryXml(readZipEntry(fs.readFileSync(file), 'AndroidManifest.xml'));
} catch {
  process.exit(3); // 读不出 AndroidManifest → 让服务端判 INVALID_APK
}
const decode = (attr) => {
  if (!attr) return '';
  if (typeof attr.rawValue === 'string') return attr.rawValue;
  if (attr.dataType === 0x03) return doc.strings[attr.data] ?? '';
  if (attr.dataType === 0x12) return attr.data !== 0 ? 'true' : 'false';
  if (attr.dataType === 0x10 || attr.dataType === 0x11) return String(attr.data);
  return '';
};
const pick = (attrs, name) => attrs.find((a) => a.name === name);
const manifest = doc.elements.find((el) => el.name === 'manifest') ?? { attrs: [] };
if (mode === 'badging') {
  const versionCode = pick(manifest.attrs, 'versionCode');
  process.stdout.write(
    "package: name='" + decode(pick(manifest.attrs, 'package')) +
    "' versionCode='" + (versionCode ? versionCode.data : 0) +
    "' versionName='" + decode(pick(manifest.attrs, 'versionName')) + "'\\n",
  );
  process.exit(0);
}
if (mode === 'xmltree') {
  const lines = ['E: manifest (line=2)'];
  for (const el of doc.elements.filter((e) => e.name === 'meta-data')) {
    lines.push(
      'E: application (line=6)',
      '  E: meta-data (line=7)',
      '    A: http://schemas.android.com/apk/res/android:name(0x01010003)="' +
        decode(pick(el.attrs, 'name')) + '"',
      '    A: http://schemas.android.com/apk/res/android:value(0x01010024)="' +
        decode(pick(el.attrs, 'value')) + '"',
    );
  }
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
}
process.exit(2);
`

/**
 * 起一台真服务端。目录形状就是线上的形状：
 *   webroot/            ← 公网站点根（Caddy file_server 直接服）
 *     releases.json
 *     apk/
 *   private/            ← 私有根：**webroot 之外**（#609 的核心）
 *     releases.internal.json（第一次发布时才出现）
 *     apk/
 */
const startServer = async ({ seed = { latest: '1.4.2', releases: [record()] }, privateRootInsideWebroot = false } = {}) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-gate-620-'))
  const webroot = path.join(work, 'webroot')
  const apkDir = path.join(webroot, 'apk')
  fs.mkdirSync(apkDir, { recursive: true })
  const releasesFile = path.join(webroot, 'releases.json')
  fs.writeFileSync(releasesFile, `${JSON.stringify(seed, null, 2)}\n`)

  const privateRoot = privateRootInsideWebroot ? path.join(webroot, 'private') : path.join(work, 'private')

  const token = `variant-gate-620-${process.pid}-${Date.now()}`
  const tokenFile = path.join(work, 'token')
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, '{"apks":{}}\n')

  const stubMjs = path.join(work, 'aapt2-stub.mjs')
  fs.writeFileSync(stubMjs, STUB_SOURCE(APK_MANIFEST), { mode: 0o755 })
  const stub = path.join(work, 'aapt2')
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${stubMjs}" "$@"\n`, { mode: 0o755 })

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DL_TOKEN_FILE: tokenFile,
      DL_WEBROOT: webroot,
      DL_APK_DIR: apkDir,
      DL_RELEASES_JSON: releasesFile,
      DL_PRIVATE_ROOT: privateRoot,
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

  const exited = () => child.exitCode !== null
  if (!privateRootInsideWebroot) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (res.ok) break
      } catch {
        /* 还没起来 */
      }
      if (exited()) throw new Error(`服务退出 code=${child.exitCode}:\n${logs.join('')}`)
      if (attempt > 100) throw new Error(`服务 10s 内没起来:\n${logs.join('')}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } else {
    // 期望它**拒绝启动**：等进程自己退出（最多 10s），把退出码与日志交给调用方断言
    for (let attempt = 0; attempt <= 100 && !exited(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const post = async (endpoint, meta, { apk = APK_STANDARD } = {}) => {
    const form = new FormData()
    form.set('apk', new Blob([apk]), 'app-release.apk')
    form.set('meta', JSON.stringify(meta))
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
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
  }

  return {
    work,
    webroot,
    apkDir,
    privateRoot,
    releasesFile,
    privateManifestFile: path.join(privateRoot, 'releases.internal.json'),
    privateApkDir: path.join(privateRoot, 'apk'),
    token,
    port,
    logs,
    child,
    exitCode: () => child.exitCode,
    snapshot: () => ({
      publicBytes: fs.readFileSync(releasesFile),
      publicSha: sha256File(releasesFile),
      publicApk: fs.readdirSync(apkDir).sort(),
    }),
    post,
    postPublic: (meta, opts) => post('/api/v1/release', meta, opts),
    postPrivate: (meta, opts) => post('/api/v1/release/private', meta, opts),
    stop: async () => {
      if (child.exitCode !== null) return
      await new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill('SIGTERM')
      })
    },
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

const withServer = async (setup, body) => {
  const ctx = await startServer(setup)
  try {
    await body(ctx)
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
}

/** 拒收之后必须「一个字节都没变」：公网清单 bytes + sha256、apk 目录、临时文件残留 一起看 */
const assertPublicUntouched = (ctx, before, label) => {
  const after = fs.readFileSync(ctx.releasesFile)
  assert.deepEqual([...after], [...before.publicBytes], `${label}：公网清单必须**字节级**不变（不是"看起来没变"）`)
  assert.equal(sha256File(ctx.releasesFile), before.publicSha, `${label}：公网清单 sha256 必须不变`)
  assert.deepEqual(fs.readdirSync(ctx.apkDir).sort(), before.publicApk, `${label}：公网 apk 目录不许有落盘或 .upload-* 残留`)
}

// ------------------------------------------------------------------ V1 / V2：接口拒绝 internal

test('V1 公网端点收到 internal 包 → 400 VARIANT_NOT_PUBLIC，公网清单 sha256 不变', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const result = await ctx.postPublic({ buildType: 'stable', changes: ['internal 不该进公网'] }, { apk: APK_INTERNAL })

    assert.equal(result.status, 400, `internal 包必须 4xx 拒收，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.ok, false)
    // 顶层 code 与 error.code 同值（与 #330 的 BAD_BUILD_TYPE 同一契约）
    assert.equal(result.json?.code, 'VARIANT_NOT_PUBLIC')
    assert.equal(result.json?.error?.code, 'VARIANT_NOT_PUBLIC')
    assert.match(result.json?.message ?? '', /公网清单只收 artifactVariant="standard"/)
    assert.match(result.json?.message ?? '', /internal/)
    assert.match(result.json?.message ?? '', /\/api\/v1\/release\/private/, '要给出内部包该走的端点')
    assert.match(result.json?.message ?? '', /未落盘/)

    assertPublicUntouched(ctx, before, '400 internal')
    assert.match(ctx.logs.join(''), /reject_variant_target.*target="public".*variant="internal"/, '拒收必须留日志 reject_variant_target')
    assert.ok(!ctx.logs.join('').includes('release_ok'), 'internal 包不许出现 release_ok')
  })
})

test('V2 变体判不出来（无标记、无白名单）→ 也不默认 standard：400 VARIANT_NOT_PUBLIC', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const result = await ctx.postPublic({ buildType: 'stable', changes: ['未知变体'] }, { apk: APK_UNKNOWN })
    assert.equal(result.status, 400, `判不出变体必须拒，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.code, 'VARIANT_NOT_PUBLIC')
    assert.match(result.json?.message ?? '', /unknown/, '文案要说清是"判不出变体"而不是"internal"')
    assertPublicUntouched(ctx, before, '400 unknown')
  })
})

// ------------------------------------------------------------------ V3：渠道闸

test('V3 standard 包但渠道不是 stable（显式 prerelease / 版本号推导出 prerelease）→ 400 BUILD_TYPE_NOT_PUBLIC', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()

    const explicit = await ctx.postPublic({ buildType: 'prerelease', changes: ['显式预发布'] }, { apk: APK_STANDARD })
    assert.equal(explicit.status, 400, `显式 prerelease 必须拒，实际 ${explicit.status}\n${explicit.text}`)
    assert.equal(explicit.json?.code, 'BUILD_TYPE_NOT_PUBLIC')
    assert.equal(explicit.json?.error?.code, 'BUILD_TYPE_NOT_PUBLIC')
    assert.match(explicit.json?.message ?? '', /GitHub Release/, '要指出预发布该走哪里')
    assertPublicUntouched(ctx, before, '400 显式 prerelease')

    // 不显式给 buildType：按版本号推导也得是 stable 才让进公网清单
    const derived = await ctx.postPublic({ changes: ['按版本号推导'] }, { apk: APK_PRERELEASE })
    assert.equal(derived.status, 400, `推导出 prerelease 也必须拒，实际 ${derived.status}\n${derived.text}`)
    assert.equal(derived.json?.code, 'BUILD_TYPE_NOT_PUBLIC')
    assertPublicUntouched(ctx, before, '400 推导 prerelease')
    assert.match(ctx.logs.join(''), /reject_build_type_target/)
  })
})

// ------------------------------------------------------------------ V4：负向对照（本单的硬要求）

test('V4 负向对照：干净(200) → 注入 internal POST(4xx 且 sha256 不变) → 还原(200)', async () => {
  await withServer({}, async (ctx) => {
    // ① 干净：一个标准的正式包必须能发（否则闸是一刀切的红，没人敢开）
    const clean = await ctx.postPublic({ buildType: 'stable', changes: ['还原用'] }, { apk: APK_STANDARD })
    assert.equal(clean.status, 200, `干净输入必须成功，实际 ${clean.status}\n${clean.text}`)
    const baseline = ctx.snapshot()
    const manifest = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
    assert.equal(manifest.latest, '1.4.3')
    assert.deepEqual(manifest.releases.map((r) => r.artifactVariant), ['standard', 'standard'])
    assert.equal(manifest.releases[0].buildType, 'stable')

    // ② 注入：internal 包 → 必须 4xx，且公网清单**字节级**不动
    const inject = await ctx.postPublic({ buildType: 'stable', changes: ['注入物'] }, { apk: APK_INTERNAL })
    assert.equal(inject.status, 400, `注入的 internal 包必须被拒，实际 ${inject.status}\n${inject.text}`)
    assert.equal(inject.json?.code, 'VARIANT_NOT_PUBLIC')
    assertPublicUntouched(ctx, baseline, '负向对照：注入 internal 后')
    // 再确认一次「没写进去」：清单里没有 1.4.3 的 internal 记录、latest 还是刚才那个正式版本
    const afterInject = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
    assert.equal(afterInject.latest, '1.4.3')
    assert.equal(
      afterInject.releases.filter((r) => r.artifactVariant !== 'standard').length,
      0,
      '公网清单里 internal 条目数必须为 0（#620 常驻断言）',
    )

    // ③ 还原：注入物从来没落地，所以「还原」= 清单与注入前一模一样（已经由 ② 断言），
    //    这里再发一个合法新版本，证明闸没有把正常发布路径一起关死。
    const restore = await ctx.postPublic({ buildType: 'stable', changes: ['还原后继续发布'] }, { apk: APK_STANDARD_V2 })
    assert.equal(restore.status, 200, `还原后必须能继续发，实际 ${restore.status}\n${restore.text}`)
    const restored = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
    assert.equal(restored.latest, '1.4.4')
    assert.deepEqual(restored.releases.map((r) => r.artifactVariant), ['standard', 'standard', 'standard'])
    assert.equal(restored.releases.filter((r) => r.artifactVariant !== 'standard').length, 0)
  })
})

// ------------------------------------------------------------------ V5 / V6：私有清单端点

test('V5 私网端点收 internal 包 → 200 写私有清单，公网清单 sha256 一字未动', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const result = await ctx.postPrivate({ changes: ['内部包走私有清单'] }, { apk: APK_INTERNAL })

    assert.equal(result.status, 200, `internal 包应写私有清单，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.ok, true)
    assert.equal(result.json?.target, 'private')
    assert.equal(result.json?.url, undefined, '私有包没有公网直链，回包不许给 url')
    assert.equal(result.json?.artifactVariant, 'internal')
    assert.equal(result.json?.artifactVariantSource, 'apk-manifest')

    // 公网零影响：清单字节与 apk 目录都没动
    assertPublicUntouched(ctx, before, '私有发布')

    // 私有清单真的写成功了，而且过**私有口径**校验器（与 #619 的双口径同一份实现）
    const privateManifest = JSON.parse(fs.readFileSync(ctx.privateManifestFile, 'utf8'))
    assert.equal(privateManifest.latest, '1.4.3')
    assert.equal(privateManifest.releases.length, 1)
    assert.equal(privateManifest.releases[0].artifactVariant, 'internal')
    assert.equal(privateManifest.releases[0].buildType, 'stable')
    const report = validateManifest(privateManifest, { mode: 'private' })
    assert.deepEqual(report.errors, [], `私有清单必须过 --private 口径：${report.errors.join('；')}`)
    // 私有清单的形状也不能是公网口径（反过来同样互斥）
    assert.ok(
      validateManifest(privateManifest, { mode: 'public' }).errors.length > 0,
      '同一份私有清单在公网口径下必须判红（两种口径确实互斥）',
    )
    // 私有包落在 webroot 之外的私有目录
    assert.ok(fs.existsSync(path.join(ctx.privateApkDir, 'deepseek-chat-1.4.3.apk')), '私有包应落在私有 apk 目录')
    assert.ok(
      !fs.existsSync(path.join(ctx.apkDir, 'deepseek-chat-1.4.3.apk')),
      '私有包绝不许落在 webroot 的 apk/ 下',
    )
    assert.match(ctx.logs.join(''), /release_private_ok/)
  })
})

test('V6 私网端点收 standard 包 → 400 VARIANT_NOT_PRIVATE，两份清单都不动', async () => {
  await withServer({}, async (ctx) => {
    const before = ctx.snapshot()
    const result = await ctx.postPrivate({ changes: ['standard 不该进私有清单'] }, { apk: APK_STANDARD })
    assert.equal(result.status, 400, `standard 包必须被私有端点拒收，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.code, 'VARIANT_NOT_PRIVATE')
    assert.match(result.json?.message ?? '', /GitHub Release/)
    assertPublicUntouched(ctx, before, '私有端点拒 standard')
    assert.equal(fs.existsSync(ctx.privateManifestFile), false, '被拒时不许创建私有清单')
  })
})

test('V10 私网端点：显式 buildType=prerelease 原样写入私有清单（推导会得 stable）', async () => {
  // 私有清单不限渠道（只有公网限 stable）：这条保住 #330 的「显式值不被版本号推导覆盖」语义，
  // 而公网端点的那一半已按 #620 收紧为「只收 stable」。
  await withServer({}, async (ctx) => {
    const result = await ctx.postPrivate({ buildType: 'prerelease', changes: ['内部预发布'] }, { apk: APK_INTERNAL })
    assert.equal(result.status, 200, `私有清单应接受 internal + prerelease，实际 ${result.status}\n${result.text}`)
    const privateManifest = JSON.parse(fs.readFileSync(ctx.privateManifestFile, 'utf8'))
    assert.equal(privateManifest.releases[0].version, '1.4.3')
    assert.equal(privateManifest.releases[0].buildType, 'prerelease', '显式值必须原样写入（1.4.3 推导只会得 stable）')
    assert.deepEqual(validateManifest(privateManifest, { mode: 'private' }).errors, [])
  })
})

// ------------------------------------------------------------------ V7：整份清单 fail-closed

test('V7 公网清单里已有 internal 条目 → 合并后 409 MANIFEST_INTERNAL_ENTRY，一个字节都不写', async () => {
  // #601 的现场形状：历史清单里躺着一条 internal（file 字段把内部包直链广播出去）
  const dirtySeed = {
    latest: '1.4.2',
    releases: [record({ version: '1.4.2', versionCode: 21, artifactVariant: 'internal' })],
  }
  await withServer({ seed: dirtySeed }, async (ctx) => {
    const before = ctx.snapshot()
    const result = await ctx.postPublic({ buildType: 'stable', changes: ['新条目本身合法'] }, { apk: APK_STANDARD })
    assert.equal(result.status, 409, `脏公网清单必须整单拒收，实际 ${result.status}\n${result.text}`)
    assert.equal(result.json?.code, 'MANIFEST_INTERNAL_ENTRY')
    assert.equal(result.json?.error?.code, 'MANIFEST_INTERNAL_ENTRY')
    assert.match(result.json?.message ?? '', /1 条/, '要报出脏条目数')
    assert.match(result.json?.message ?? '', /1\.4\.2/, '要指出是哪个版本脏')
    assertPublicUntouched(ctx, before, '409 公网清单含 internal')
    assert.match(ctx.logs.join(''), /reject_manifest_variant/)
  })
})

// ------------------------------------------------------------------ V8：启动期硬门禁

test('V8 私有根落在 webroot 内 → 服务拒绝启动（exit 1 + fatal_private_root_in_webroot）', async () => {
  const ctx = await startServer({ privateRootInsideWebroot: true })
  try {
    assert.notEqual(ctx.exitCode(), null, '私有根在 webroot 内时进程必须退出（不许带着这个配置跑起来）')
    assert.equal(ctx.exitCode(), 1, `退出码应为 1，实际 ${ctx.exitCode()}；日志：\n${ctx.logs.join('')}`)
    assert.match(ctx.logs.join(''), /fatal_private_root_in_webroot/)
    assert.match(ctx.logs.join(''), /private/, '日志要说清是哪个目录越界')
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
})

// ------------------------------------------------------------------ V9：版本自证

test('V9 /api/v1/version 自证两个目标（公网 / 私有），部署验收能核对闸在不在', async () => {
  await withServer({}, async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/version`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(body.targets, ['public', 'private'])
  })
})
