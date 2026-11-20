// [layer: L1（零 Android SDK 可跑：假 aapt2 + 真 ZIP/AXML + 真 HTTP 服务） | 耗时: ~3s]
//
// 域10 N3 —— **服务端上传契约矩阵**（Issue #362 §3.2 N3 / 功能点 F10-17 18 19 20）。
//
// 为什么必须是「起真服务端」而不是打桩：`deploy/dl-release/server.mjs` 是发布链路上唯一
// 会把字节写进线上 releases.json 的地方，它的门禁**顺序**本身就是契约
// （鉴权 → content-type → 体积 → 字段 → 包名 → debuggable → 回环 consume → 变体 → 防降级 →
//  整份清单 → 落盘；回环这一道见 `loopback-consume-601.test.mjs`，#601）。
// 顺序错了的后果不是「报错不好看」，而是「非法包落了一半盘」「清单被写脏」这类不可逆事故。
//
// 所以本文件复用 #330 的思路（`deploy/dl-release/test/server-buildtype.test.mjs`）：
//   · **真** server.mjs 进程 + **真** 临时 releases.json / apk 目录；
//   · **真** ZIP + **真** 二进制 AXML 的 APK（`tests/fixtures/domain10/apk-fixture.mjs`）；
//   · 只有 `aapt2` 是假的（本机/CI 都没有 aapt2 二进制）—— 它只回放 badging / xmltree 文本，
//     所以 debuggable、sha256、落盘、清单合并这些「真的部分」都不打折。
//
// 覆盖的功能点（#362 域10 表）：
//   F10-17 上传接口契约：multipart / 鉴权 / 体积 / 限流（200 + 回包 sha256 一致；401/400/409/413/405/429 各有短码）
//   F10-18 防降级：versionCode 必须超过线上 latest（409 VERSION_CONFLICT）
//   F10-19 debuggable 包四道门都拦（本文件管「服务端」这一道，400 APK_DEBUGGABLE）
//   F10-20 变体由 APK 真相决定，meta 说了不算（标记 vs 白名单冲突 → 409 VARIANT_CONFLICT）
//
// 已知缺口（本文件不掩盖，链到 #362 域10 §3.1）：
//   `deploy/dl-release/test` 这批用例长期**没有任何执行入口**（不在 run-layer 的 LAYERS、
//   不是 npm script、CI 无步骤）。本次在 package.json 加了 `test:dl-release`
//   （`node --test deploy/dl-release/test/*.test.mjs`），文件末尾有一条断言钉住它 ——
//   入口再被删掉，这条断言会红。
//
// 运行：
//   node --test deploy/dl-release/test/domain10-server-contract.test.mjs   # 或 npm run test:dl-release

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApk } from '../../../tests/fixtures/domain10/apk-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER = path.join(ROOT, 'deploy/dl-release/server.mjs')
const MARKER = 'com.example.deepseekchat.ARTIFACT_VARIANT'
const MAX_BODY_MB = 56

/** 一份「干净」的 release 包（无 debuggable 属性、包名合法） */
const CLEAN_APK = buildApk({ versionName: '1.4.0', versionCode: 18 })
const DEBUG_APK = buildApk({ debuggable: true, versionName: '1.4.0', versionCode: 18 })
const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const sha256File = (file) => sha256Of(fs.readFileSync(file))

/** aapt2 dump badging 的一行（服务端只读第一行） */
const badgingOf = (versionName, versionCode, packageName = 'com.example.deepseekchat') =>
  `package: name='${packageName}' versionCode='${versionCode}' versionName='${versionName}'\n`

/** aapt2 dump xmltree 的输出：带（或不带）变体标记的 meta-data 节点 */
const xmltreeOf = (variant) =>
  [
    'E: manifest (line=2)',
    '  A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=18',
    '  A: http://schemas.android.com/apk/res/android:versionName(0x0101021c)="1.4.0"',
    '  E: application (line=6)',
    '    E: meta-data (line=7)',
    `      A: http://schemas.android.com/apk/res/android:name(0x01010003)="${MARKER}"`,
    `      A: http://schemas.android.com/apk/res/android:value(0x01010024)="${variant}"`,
    '',
  ].join('\n')

const record = (over = {}) => ({
  version: '1.4.0',
  versionCode: 18,
  releasedAt: '2026-11-19T10:00:00+08:00',
  file: 'apk/deepseek-chat-1.4.0.apk',
  size: CLEAN_APK.length,
  md5: '0'.repeat(32),
  sha256: 'a'.repeat(64),
  changes: ['既有版本'],
  buildType: 'stable',
  breaking: false,
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
 * 起一台真服务端。每行一个实例（独立临时目录 + 独立端口），跑完就停、就删：
 * 行与行之间不共享 releases.json，避免「上一行的脏状态」把下一行的断言污染成假绿。
 */
const startServer = async ({
  rateLimitMax = 1000,
  seed = null,
  allowlist = {},
  badging = badgingOf('1.4.0', 18),
  xmltree = '',
} = {}) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'domain10-contract-'))
  const apkDir = path.join(work, 'apk')
  fs.mkdirSync(apkDir)
  const token = `domain10-token-${process.pid}-${Date.now()}`
  const tokenFile = path.join(work, 'token')
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  const releasesFile = path.join(work, 'releases.json')
  if (seed) fs.writeFileSync(releasesFile, `${JSON.stringify(seed, null, 2)}\n`)
  const variantsFile = path.join(work, 'artifact-variants.json')
  fs.writeFileSync(variantsFile, `${JSON.stringify({ apks: allowlist }, null, 2)}\n`)

  // 假 aapt2：badging / xmltree 从文本回放；每次调用记一行（用来断言「不该解析的时候没解析」）
  const stubLog = path.join(work, 'aapt2-calls.log')
  const badgingFile = path.join(work, 'badging.txt')
  const xmltreeFile = path.join(work, 'xmltree.txt')
  fs.writeFileSync(badgingFile, badging)
  fs.writeFileSync(xmltreeFile, xmltree)
  const stub = path.join(work, 'aapt2')
  fs.writeFileSync(
    stub,
    `#!/bin/sh
echo "$*" >> "${stubLog}"
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
      DL_APK_DIR: apkDir,
      DL_RELEASES_JSON: releasesFile,
      DL_VARIANTS_FILE: variantsFile,
      DL_AAPT2: stub,
      DL_LISTEN_HOST: '127.0.0.1',
      DL_LISTEN_PORT: String(port),
      DL_RATE_LIMIT_MAX: String(rateLimitMax),
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
    work,
    apkDir,
    releasesFile,
    stubLog,
    logs,
    /** 用当前 badging 回放内容改一次上传的版本号（每行自己决定要不要改） */
    setBadging: (text) => fs.writeFileSync(badgingFile, text),
    post: async (meta, { apk = CLEAN_APK, token: useToken = token, rawMeta } = {}) => {
      const form = new FormData()
      form.set('apk', new Blob([apk]), 'app-release.apk')
      form.set('meta', rawMeta !== undefined ? rawMeta : JSON.stringify(meta))
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/release`, {
        method: 'POST',
        headers: useToken === null ? {} : { Authorization: `Bearer ${useToken}` },
        body: form,
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: res.status, json, text, headers: res.headers }
    },
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill('SIGTERM')
      }),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

/** 一行的公共骨架：起服务 → 发请求 → 断言状态码/短码 → 关服务 */
const withServer = async (setup, body) => {
  const ctx = await startServer(setup)
  try {
    await body(ctx)
  } finally {
    await ctx.stop()
    ctx.cleanup()
  }
}

/** 断言「拒收之后什么都没变」（落盘 / 清单 / 临时文件三件事一起看） */
const assertNothingWritten = (ctx, before, label) => {
  assert.deepEqual(fs.readdirSync(ctx.apkDir), before.apk, `${label}：apk 目录不许有落盘或 .upload-* 残留`)
  if (before.releases !== null) {
    assert.equal(sha256File(ctx.releasesFile), before.releases, `${label}：releases.json 必须字节不变`)
  }
}

/**
 * 读假 aapt2 的调用记录。**没被调用过时文件根本不存在** —— 那正是「零 I/O」要断言的事实，
 * 所以这里返回空串而不是抛 ENOENT。
 */
const stubCalls = (ctx) => (fs.existsSync(ctx.stubLog) ? fs.readFileSync(ctx.stubLog, 'utf8') : '')

/** 解析一段裸 HTTP 响应（状态码 / 头 / body），用于发 fetch 发不出来的请求（如声明超限长度） */
const parseRawResponse = (raw) => {
  const text = String(raw)
  const [head, ...rest] = text.split('\r\n\r\n')
  const lines = head.split('\r\n')
  const status = Number((lines[0] ?? '').split(' ')[1])
  const headers = new Map()
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
  }
  const body = rest.join('\r\n\r\n')
  let json = null
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  return { status, json, text: body, headers }
}

const snapshot = (ctx) => ({
  apk: fs.readdirSync(ctx.apkDir),
  releases: fs.existsSync(ctx.releasesFile) ? sha256File(ctx.releasesFile) : null,
})

// ---------------------------------------------------------------- 矩阵（8 行）

/**
 * 一行 = 一条上传契约。字段：
 *   id / f10 / name      标识与覆盖的功能点
 *   setup                这一行的服务端初始状态（限流、种子清单、白名单、aapt2 回放）
 *   send(ctx)            发请求；返回 { status, json, text, headers }
 *   expect               { status, code?, header?, messageAll?, sideEffect? }
 *   after(ctx, result)   额外断言（落盘 / 幂等 / 清单内容）
 */
const CONTRACT = [
  {
    id: 'U1',
    f10: ['F10-17'],
    name: '鉴权：令牌缺失 / 令牌错误 → 401 UNAUTHORIZED，且零副作用',
    setup: { seed: { latest: '1.4.0', releases: [record()] } },
    send: async (ctx) => ({ missing: await ctx.post({}, { token: null }), wrong: await ctx.post({}, { token: 'not-the-token' }) }),
    expect: { status: 401, code: 'UNAUTHORIZED', messageAll: [/令牌/] },
    after: (ctx, result, before) => {
      assert.equal(result.missing.status, 401, '缺 Authorization 头必须 401')
      assert.equal(result.wrong.status, 401, '错令牌必须 401')
      assertNothingWritten(ctx, before, '401')
      assert.equal(stubCalls(ctx), '', '鉴权失败时不许解析 APK（aapt2 未调用）')
    },
  },
  {
    id: 'U2',
    f10: ['F10-17', 'F10-19'],
    name: '不是 APK（aapt2 读不出元信息）→ 400 INVALID_APK，临时文件被清掉',
    setup: {
      seed: { latest: '1.4.0', releases: [record()] },
      // 回放一段不可解析的 badging（真实场景 = 传了个改了后缀的 zip/文本）
      badging: 'this is not an apk\n',
    },
    send: (ctx) => ctx.post({ changes: ['非 APK'] }),
    expect: { status: 400, code: 'INVALID_APK', messageAll: [/APK/] },
    after: (ctx, result, before) => {
      assertNothingWritten(ctx, before, '400 非 APK')
      assert.equal(
        fs.readdirSync(ctx.apkDir).some((name) => name.startsWith('.upload-')),
        false,
        '临时文件必须被删掉（否则 apk 目录会慢慢堆满半成品）'
      )
    },
  },
  {
    id: 'U3',
    f10: ['F10-17'],
    name: '体积：声明长度超过 56MB 总上限 → 413 PAYLOAD_TOO_LARGE（读体之前就拒）',
    setup: { seed: { latest: '1.4.0', releases: [record()] } },
    send: (ctx) =>
      // 用裸 socket 声明一个超限的 content-length：服务端按「声明的长度」先拒，
      // 不必真送 56MB（真实客户端就是被 Content-Length 挡住的）。
      // 不用 fetch/http.request 是因为它们会在客户端就先校验「声明长度 vs 实际字节」。
      new Promise((resolve, reject) => {
        const socket = net.connect(ctx.port, '127.0.0.1', () => {
          socket.write(
            'POST /api/v1/release HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              `Authorization: Bearer ${ctx.token}\r\n` +
              'Content-Type: multipart/form-data; boundary=----domain10\r\n' +
              `Content-Length: ${(MAX_BODY_MB + 1) * 1024 * 1024}\r\n` +
              'Connection: close\r\n\r\n'
          )
        })
        let raw = ''
        socket.setTimeout(5000, () => {
          socket.destroy()
          reject(new Error('服务端 5s 内没回 413'))
        })
        socket.on('data', (chunk) => {
          raw += String(chunk)
        })
        socket.on('error', reject)
        socket.on('close', () => resolve(parseRawResponse(raw)))
      }),
    expect: { status: 413, code: 'PAYLOAD_TOO_LARGE', messageAll: [/上限/] },
    after: (ctx, result, before) => {
      assertNothingWritten(ctx, before, '413')
      assert.equal(stubCalls(ctx), '', '超限时不许解析 APK')
    },
  },
  {
    id: 'U4',
    f10: ['F10-17'],
    name: '方法：GET /api/v1/release → 405 METHOD_NOT_ALLOWED 且带 Allow: POST',
    setup: { seed: { latest: '1.4.0', releases: [record()] } },
    send: async (ctx) => {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/release`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${ctx.token}` },
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: res.status, json, text, headers: res.headers }
    },
    expect: { status: 405, code: 'METHOD_NOT_ALLOWED', header: { name: 'allow', match: /POST/i } },
  },
  {
    id: 'U5',
    f10: ['F10-17'],
    name: '限流：每分钟 1 次额度用完后 → 429 RATE_LIMITED 且带 Retry-After',
    setup: { seed: { latest: '1.4.0', releases: [record()] }, rateLimitMax: 1 },
    send: async (ctx) => {
      // 第 1 次把额度用掉（拿健康检查探针不算：/healthz 在限流之前就返回）
      const first = await ctx.post({ changes: ['额度 1'] })
      assert.equal(first.status, 200, `第 1 次上传应成功：${first.text}`)
      return ctx.post({ changes: ['额度 2'] })
    },
    expect: { status: 429, code: 'RATE_LIMITED', header: { name: 'retry-after', match: /^\d+$/ }, messageAll: [/频繁/] },
  },
  {
    id: 'U6',
    f10: ['F10-18'],
    name: '防降级：versionCode 不大于线上 latest → 409 VERSION_CONFLICT，一个字节都不落盘',
    setup: {
      seed: { latest: '1.4.0', releases: [record({ version: '1.4.0', versionCode: 18 })] },
      // 新版本号 1.4.1，但 versionCode 还是 18（<= 18）→ 必须拒
      badging: badgingOf('1.4.1', 18),
      xmltree: xmltreeOf('standard'),
    },
    send: (ctx) => ctx.post({ buildType: 'stable', changes: ['降级包'] }, { apk: CLEAN_APK }),
    expect: { status: 409, code: 'VERSION_CONFLICT', messageAll: [/versionCode/, /必须大于/] },
    after: (ctx, result, before) => {
      assertNothingWritten(ctx, before, '409 降级')
      assert.equal(
        fs.readdirSync(ctx.apkDir).some((name) => name.includes('1.4.1')),
        false,
        '被拒的新版本不许落盘'
      )
    },
  },
  {
    id: 'U7',
    f10: ['F10-20'],
    name: '变体冲突：APK 内标记 internal vs 服务器白名单 standard → 409 VARIANT_CONFLICT',
    setup: {
      seed: { latest: '1.4.0', releases: [record({ versionCode: 18 })] },
      badging: badgingOf('1.4.2', 19),
      // APK 真相（标记）说 internal，白名单说 standard —— 两边打架时服务端必须拒绝，不能二选一
      xmltree: xmltreeOf('internal'),
      allowlist: { [sha256Of(CLEAN_APK)]: { variant: 'standard', note: '域10 契约用例' } },
    },
    send: (ctx) => ctx.post({ buildType: 'stable', artifactVariant: 'internal', changes: ['冲突包'] }),
    expect: { status: 409, code: 'VARIANT_CONFLICT', messageAll: [/白名单/, /不一致/] },
    after: (ctx, result, before) => {
      assertNothingWritten(ctx, before, '409 变体冲突')
      // meta 说了不算：即使 meta 写 internal，判定依据也只能是 APK 真相/白名单
      assert.match(stubCalls(ctx), /dump xmltree/, '变体判定必须真的读了 APK 内的标记（xmltree）')
    },
  },
  {
    id: 'U8',
    f10: ['F10-17', 'F10-20'],
    name: '同版本重传幂等：两次 200、回包 sha256 与字节一致、清单里只留一条',
    setup: {
      seed: { latest: '1.4.0', releases: [record({ version: '1.4.0', versionCode: 18, sha256: 'a'.repeat(64) })] },
      badging: badgingOf('1.4.0', 18),
      xmltree: xmltreeOf('standard'),
    },
    send: async (ctx) => {
      const first = await ctx.post({ buildType: 'stable', changes: ['重传一'] })
      const second = await ctx.post({ buildType: 'stable', changes: ['重传二'] })
      return { first, second }
    },
    expect: { status: 200 },
    after: (ctx, result) => {
      assert.equal(result.first.status, 200, `同版本重传第一次应 200：${result.first.text}`)
      assert.equal(result.second.status, 200, `同版本重传第二次应 200（幂等）：${result.second.text}`)
      const expected = sha256Of(CLEAN_APK)
      // F10-17 的「回包 sha256 一致」：服务端自己算，不信客户端
      assert.equal(result.first.json.sha256, expected, '回包 sha256 必须等于服务端自己算的字节摘要')
      assert.equal(result.second.json.sha256, expected, '第二次重传的 sha256 也必须一致')
      assert.equal(result.first.json.md5.length, 32, '回包应带 md5（运维比对用）')

      const manifest = JSON.parse(fs.readFileSync(ctx.releasesFile, 'utf8'))
      const same = manifest.releases.filter((item) => item.version === '1.4.0')
      assert.equal(same.length, 1, `同版本重传不许在清单里留两条（实际 ${same.length} 条）`)
      assert.equal(same[0].sha256, expected, '清单里的 sha256 必须是最新一次上传的字节')
      assert.equal(manifest.latest, '1.4.0', 'latest 指向重传的版本')
      assert.deepEqual(manifest.releases.map((item) => item.versionCode), [18], '清单里只该剩下这一条记录')
      // 落盘的 APK 文件名由服务端解析出的 versionName 决定（不采信客户端文件名）
      assert.ok(
        fs.readdirSync(ctx.apkDir).includes('deepseek-chat-1.4.0.apk'),
        `APK 应落成 deepseek-chat-1.4.0.apk，实际 ${fs.readdirSync(ctx.apkDir).join(',')}`
      )
    },
  },
]

test('域10 上传契约矩阵的表结构自洽（8 行 / id 唯一 / 功能点 ID 合法）', () => {
  const ids = new Set()
  for (const row of CONTRACT) {
    assert.equal(ids.has(row.id), false, `行 id 重复：${row.id}`)
    ids.add(row.id)
    for (const id of row.f10) {
      assert.match(id, /^F10-(0[1-9]|1[0-9]|2[0-2])$/, `${row.id} 的功能点 ID 不合法：${id}`)
    }
  }
  assert.equal(CONTRACT.length, 8, 'N3 应正好 8 行（401/400/413/405/429/409 降级/409 变体/200 幂等）')
})

for (const row of CONTRACT) {
  test(`${row.id} ${row.name}`, async () => {
    await withServer(row.setup, async (ctx) => {
      const before = snapshot(ctx)
      const result = await row.send(ctx)
      // 行的主体可以是「一个响应」也可以是「一组响应」（U1/U8 各发两次）
      const primary =
        result && typeof result.status === 'number'
          ? result
          : (result.first ?? result.wrong ?? result.missing)
      if (row.expect.status !== 200 || (result && typeof result.status === 'number')) {
        assert.equal(
          primary.status,
          row.expect.status,
          `${row.id} 期望 ${row.expect.status}，实际 ${primary.status}\n${primary.text ?? ''}`
        )
      }
      if (row.expect.code) {
        // 短码契约（`docs/dl-release-api.md`）：
        //   · 老错误码只写 `error.code`（fail()）；
        //   · #330 起的新错误码（BAD_BUILD_TYPE / MANIFEST_DIRTY）同时写顶层 `code`，
        //     老调用方读 error.code 不受影响。
        // 所以这里至少要求 error.code 对得上；顶层 code 出现时必须同值（不许两套短码打架）。
        assert.equal(primary.json?.error?.code, row.expect.code, `${row.id} error.code 应为 ${row.expect.code}`)
        if (primary.json?.code !== undefined) {
          assert.equal(primary.json.code, row.expect.code, `${row.id} 顶层 code 与 error.code 必须同值`)
        }
        assert.equal(primary.json?.ok, false, `${row.id} 失败回包必须 ok:false`)
      }
      for (const pattern of row.expect.messageAll ?? []) {
        assert.match(primary.json?.message ?? primary.text ?? '', pattern, `${row.id} 的提示要说清原因（${pattern}）`)
      }
      if (row.expect.header) {
        const value = primary.headers?.get?.(row.expect.header.name) ?? primary.headers?.[row.expect.header.name]
        assert.match(String(value ?? ''), row.expect.header.match, `${row.id} 应带 ${row.expect.header.name} 响应头`)
      }
      row.after?.(ctx, result, before)
    })
  })
}

// ---------------------------------------------------------------- 执行入口（#362 域10 §3.2 缺口 1）

test('本目录的用例有执行入口：package.json 里必须有一条 npm script 能跑到它们', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entries = Object.entries(pkg.scripts ?? {}).filter(([, command]) => command.includes('deploy/dl-release/test'))
  assert.ok(
    entries.length >= 1,
    'deploy/dl-release/test 下的用例没有任何 npm script 入口 —— ' +
      '这就是 #362 说的「24 条全绿但今天谁删了都不会有人发现」。修法：package.json 加 ' +
      '"test:dl-release": "node --test deploy/dl-release/test/*.test.mjs"'
  )
  // 入口必须是「跑测试」而不是「列一下」：--test 与 *.test.mjs 两样都要在
  assert.match(entries[0][1], /--test/, `入口 ${entries[0][0]} 应使用 node --test：${entries[0][1]}`)
  assert.match(entries[0][1], /\.test\.mjs/, `入口 ${entries[0][0]} 应覆盖 .test.mjs：${entries[0][1]}`)
})
