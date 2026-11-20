// [layer: unit | 依赖: 无（纯 Node，临时目录造合成仓库，零网络） | 耗时: <3s]
//
// `pnpm run check:refactor-direction` 的**扫描口径**自测（#590）。
//
// 为什么要单钉这三条：A1/A4/A6 是「文本出现 = 违规」的判据，口径一歪，门禁就变成噪音 ——
// 而噪音最贵的两种形态刚好是相反的：
//
//   1. **漏**：被 gitignore 的构建产物（`android/app/src/main/assets/**`，`cap sync` 复制过去的
//      web 产物、`git ls-files` 为 0）被算进源码命中 → 同一份代码**本地红、CI 绿**，
//      「收口」永远说不清。跳过它是对的，但**跳过只认路径、不认内容**：同样的地址写在
//      `src/` 或 android 真源码里必须照红，否则「跳过生成目录」就成了「跳过一切」。
//   2. **宽**：白名单（`A1_ALLOW` / `A4_ALLOW`）要是能按目录整片放行，下次有人往老模块里
//      加第 21 处也没人知道。所以白名单是「文件 + 行内文本 + 计数锁」三件套，脚本里的
//      `--selftest` 与合成仓库会分别把两头都验一遍（见下）。
//
// 本文件只测**口径**（跳过谁、放行谁、跳过的证据怎么写），不测「今天仓库里还剩几处命中」——
// 剩余命中数会随清理进度变，把它写进断言等于替下一个改动的人红。
//
//   node --test tests/unit/check-refactor-direction.test.mjs
//
// 关联：#590（口径修正）、#484 §九（A1–A7 判据出处）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLI = path.join(ROOT, 'scripts', 'check-refactor-direction.mjs')

/** 跑一次 CLI：`--report` 恒 exit 0，判定结果从 `--json` 读 */
const runCli = (args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, FORCE_COLOR: '0', LANG: 'zh_CN.UTF-8' },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** 合成仓库：`src/` 干净 + 一份合法的 `config/endpoints.json`（只够 A1/A6 判） */
const makeRepo = (extra) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-590-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const ok = 1\n')
  fs.writeFileSync(
    path.join(dir, 'config', 'endpoints.json'),
    JSON.stringify(
      {
        chatBaseUrl: 'https://chat.example.com',
        inviteBaseUrl: 'https://chat.example.com',
        feedbackUrl: 'https://chat.example.com/feedback',
        legacyHosts: [],
        allowedHosts: ['chat.example.com'],
        allowedPorts: [443],
        download: { primaryBase: 'https://dl.example.com', fallbackBase: 'https://dl2.example.com' },
        consume: {
          baseUrl: 'https://consume.example.com',
          apiV1Prefix: '/api/v1',
          gatewayPrefix: '/v1',
          timeoutMs: { read: 10000, write: 20000, redeem: 30000 },
        },
        pay: { baseUrl: 'https://pay.example.com', timeoutMs: { read: 10000, write: 20000 } },
      },
      null,
      2,
    ),
  )
  extra(dir)
  return dir
}

/** 一份同时命中三条 A1 规则的内容（IP / 端口 / device_id 作 query 参数） */
// check-ip-allow check-endpoints-allow: 口径自测的靶子地址，只作字符串比对，不发任何请求（#590）
const TAINTED = ["const base = 'http://140.210.13.146:60013'", 'const u = `${base}/me?device_id=` + id'].join('\n')

const writeInto = (dir, relPath) => {
  const file = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${TAINTED}\n`)
}

const a1Of = (dir) => {
  const { stdout, stderr } = runCli(['--root', dir, '--report', '--json'])
  const report = JSON.parse(stdout)
  return { report, a1: report.items.find((item) => item.id === 'A1'), stderr }
}

test('口径① 生成目录跳过：产物目录里的旧池域地址不计入，且证据里写明跳过了什么', () => {
  const dir = makeRepo((root) =>
    writeInto(root, 'android/app/src/main/assets/public/static/js/main.deadbee.js'),
  )
  try {
    const { a1 } = a1Of(dir)
    assert.ok(a1, '报告里必须有 A1')
    assert.equal(a1.status, 'PASS', `生成目录里的地址不该计入 A1：${a1?.evidence?.join(' / ')}`)
    assert.equal(a1.stats.total ?? a1.stats.hits, 0, 'A1 命中数必须是 0')
    assert.ok(
      a1.evidence.some((line) => line.includes('已跳过生成目录')),
      '跳过哪些生成目录必须写在证据里（本地红 / CI 绿 的根因就在这条不写明上）',
    )
    assert.ok(
      a1.evidence.some((line) => line.includes('android/app/src/main/assets/**（本机存在，已跳过）')),
      '本机存在时要说清"存在且已跳过"，而不是含糊地一句"已跳过"',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('口径② 跳过只认路径：同样的地址写在 android 真源码里，A1 必须照红', () => {
  const dir = makeRepo((root) =>
    writeInto(root, 'android/app/src/main/java/com/example/deepseekchat/Legacy.java'),
  )
  try {
    const { a1 } = a1Of(dir)
    assert.ok(a1, '报告里必须有 A1')
    assert.equal(a1.status, 'FAIL', '真源码里的旧池域地址必须判红（否则"跳过生成目录"就成了"跳过一切"）')
    const hits = a1.stats.total ?? a1.stats.hits
    assert.ok(hits >= 3, `三条 A1 规则都该命中，实际 ${hits}`)
    assert.ok(
      !a1.evidence.some((line) => line.includes('（本机存在，已跳过）')),
      '仓库里没有生成目录时不许声称跳过',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('口径③ --selftest 两组对照都过：A6 的回环例外不放水 + 生成目录正反双向', () => {
  const { status, stdout, stderr } = runCli(['--selftest'])
  const output = `${stdout}${stderr}`
  assert.equal(status, 0, `--selftest 必须 exit 0，实际 ${status}：\n${output}`)
  assert.match(output, /A6 负向对照通过/u, 'A6 例外组要打出通过行')
  assert.match(output, /生成目录对照通过/u, '生成目录组要打出通过行')
})
