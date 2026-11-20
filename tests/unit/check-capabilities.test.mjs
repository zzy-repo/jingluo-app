// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `scripts/check-capabilities.mjs`（#209 收尾件）的口径测试。
//
// 这个 CLI 是三层结构的第三层：判定逻辑全在 `scripts/lib/*Audit.mjs`（纯函数，各自有单测），
// CLI 只做「遍历 → 依次调三个静态判定 → 汇总输出」。所以本文件不重复测判定规则，
// 只钉住「CLI 这一层」的四件事：
//
//   1. 三个静态 audit 真的都被调用了（少调一个，整套盘点就有一条腿是瞎的）；
//   2. 扫描范围包含**普通 .css**（不是只有 `*.module.css`）—— #217 把 `check:gap` 扩到全部
//      `.css` 之后，两个门禁的口径必须一致，否则同一份源码会被两套范围判成两个结论；
//   3. 退出码语义：warn 级有缺陷 **exit 0**（6 条修复 lane 在飞，拦截会互相卡死），
//      `--strict` 才 exit 1（留给将来接 CI，本次不接）；
//   4. 类别 4 的测量 JSON 缺失时报「未采集」而**不是**失败 —— 采集需要模拟器，缺文件是环境
//      状态，不是代码问题。
//
// 用例一律用临时目录造 fixture 当输入（`--root <tmp>`），不依赖 `src/**` 当前的缺陷数量：
// 那 6 条 lane 会陆续把缺陷修掉，若把「今天有 37 处」写进断言，本文件会替别人红。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CLI = path.join(ROOT, 'scripts', 'check-capabilities.mjs')

/**
 * 跑一次 CLI，返回 { status, stdout, stderr }。
 *
 * 同一组参数在**一个进程里只真跑一次**（#366）：CLI 是纯只读扫描，一次 L0 运行期间仓库不会变，
 * 而本文件有 3 条用例各自对真实仓库跑了一遍全量扫描（每次约 0.9s，3 次里有 2 次是同一组参数）。
 * 缓存只影响「重复调用」，每组参数仍然真的起了一次子进程 —— 退出码、stdout、stderr 都是真进程给的。
 */
const RUN_CACHE = new Map()
const run = (args = [], options = {}) => {
  const key = JSON.stringify([args, options])
  const cached = RUN_CACHE.get(key)
  if (cached !== undefined) {
    return cached
  }
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, ...options })
  RUN_CACHE.set(key, result)
  return result
}

/** 同内容 = 同一份 fixture（同一个进程里没必要为相同内容再造一个临时目录，#366） */
const FIXTURE_CACHE = new Map()

/** 造一个临时仓库：只放 `src/**` 与（可选的）测量 JSON */
const fixture = (files) => {
  const key = JSON.stringify(files)
  const cached = FIXTURE_CACHE.get(key)
  if (cached !== undefined) {
    return cached
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check209-capabilities-'))
  FIXTURE_CACHE.set(key, dir)
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

/** 三类静态缺陷各一处：api 无兜底（Object.groupBy，Chromium 117）、
 *  css flex gap 无兜底（WebView 83 上间距为 0）、host 裸调 Web Share（宿主不实现）。 */
const DIRTY = {
  'src/services/groupBy.ts': 'export const group = (list, pick) => Object.groupBy(list, pick)\n',
  'src/services/share.ts': 'export const shareLink = (data) => navigator.share(data)\n',
  'src/styles/plain.css': '.row {\n  display: flex;\n  gap: 8px;\n}\n',
}

/** 干净 fixture：三个静态判定都不该报缺陷，行为测量缺失也只算「未采集」 */
const CLEAN = {
  'src/services/sum.ts': 'export const sum = (a, b) => a + b\n',
  'src/styles/plain.css': '.row {\n  color: red;\n}\n',
}

/** `--json` 的输出：报告结构本身也要能被机器读（PR 里的数字全部从这里抄） */
const readJson = (result) => {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(`--json 输出不是合法 JSON：${error.message}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  }
}

test('check-capabilities.mjs 存在且能跑（warn 级跑真实仓库 exit 0）', () => {
  assert.ok(fs.existsSync(CLI), `缺 scripts/check-capabilities.mjs`)
  const result = run()
  assert.equal(result.status, 0, `默认（warn 级）应 exit 0\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  assert.match(result.stdout, /#209/, '输出要标明这是 #209 的盘点闸门')
})

test('三个静态 audit 各被调用一次：api / css / host 都报出命中', () => {
  const result = run(['--root', fixture(DIRTY), '--json'])
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const report = readJson(result)
  assert.equal(report.categories.api.hits, 1, '类别 1 判定没跑到（Object.groupBy 应命中 1 处）')
  assert.equal(report.categories.css.hits, 1, '类别 2 判定没跑到（flex gap 应命中 1 处）')
  assert.equal(report.categories.host.hits, 1, '类别 3 判定没跑到（navigator.share 应命中 1 处）')
  assert.equal(report.categories.api.defects, 1)
  assert.equal(report.categories.css.defects, 1)
  assert.equal(report.categories.host.defects, 1)
})

test('普通 .css（非 CSS Module）也在扫描范围内（与 #217 的 check:gap 口径一致）', () => {
  const report = readJson(run(['--root', fixture(DIRTY), '--json']))
  assert.deepEqual(report.scanned.files.css, ['src/styles/plain.css'], '普通 .css 没进扫描范围')
  assert.equal(report.categories.css.hits, 1)
  assert.deepEqual(report.categories.css.hitFiles, ['src/styles/plain.css'])
})

test('warn 级：有缺陷也 exit 0，只在输出里标 ⚠', () => {
  const result = run(['--root', fixture(DIRTY)])
  assert.equal(result.status, 0, 'warn 级不许拦截（6 条修复 lane 在飞）')
  assert.match(result.stdout, /⚠/)
  assert.match(result.stdout, /warn 级/)
})

test('--strict：有缺陷时 exit 1', () => {
  const result = run(['--root', fixture(DIRTY), '--strict'])
  assert.equal(result.status, 1, 'strict 模式必须拦截')
  assert.match(`${result.stdout}${result.stderr}`, /⚠|缺陷/)
})

test('无缺陷时 exit 0（warn 与 strict 都是 0）', () => {
  const dir = fixture(CLEAN)
  for (const args of [[], ['--strict']]) {
    const result = run(['--root', dir, ...args])
    assert.equal(result.status, 0, `${args.join(' ') || '(warn)'} 下干净仓库应 exit 0\n${result.stdout}${result.stderr}`)
    assert.doesNotMatch(result.stdout, /⚠/)
  }
  const report = readJson(run(['--root', dir, '--json']))
  assert.equal(report.totals.defects, 0)
})

test('行为 JSON 缺失时报「未采集」，不算失败', () => {
  const dir = fixture(CLEAN)
  const result = run(['--root', dir])
  assert.equal(result.status, 0, '缺测量数据不是失败，是环境状态')
  assert.match(result.stdout, /未采集/)
  const report = readJson(run(['--root', dir, '--json']))
  assert.equal(report.categories.behavior.status, 'not-collected')
  assert.equal(report.categories.behavior.defects, 0)
})

test('行为 JSON 存在时读 docs/ui/209-behavior/*.json 并给出四条假设结论', () => {
  const report = readJson(run(['--json']))
  assert.equal(report.categories.behavior.status, 'collected', '仓库里已有 docs/ui/209-behavior/*.json，不该报未采集')
  assert.equal(report.categories.behavior.hits, 4, '四条假设各一条结论')
  // 现状四条全部「成立」（详见 docs/capabilities/behavior.md）；这里只钉「读到了并给出了结论」，
  // 不钉具体文字，免得别人补测后改动结论就替他们红。
  assert.deepEqual(
    report.categories.behavior.findings.map((finding) => finding.verdict).filter((verdict) => verdict === '未测'),
    [],
    '三档宽度都有读数，不该出现「未测」',
  )
  assert.deepEqual(report.categories.behavior.widths, ['360', '390', '412'])
})

test('总命中与缺陷合计能对上（各类之和 = total）', () => {
  const report = readJson(run(['--json']))
  const { api, css, host, behavior } = report.categories
  assert.equal(report.totals.staticHits, api.hits + css.hits + host.hits)
  assert.equal(report.totals.behaviorFindings, behavior.hits)
  assert.equal(report.totals.defects, api.defects + css.defects + host.defects + behavior.defects)
  assert.equal(report.totals.hits, report.totals.staticHits + report.totals.behaviorFindings)
})

test('扫描不到任何文件（--root 指向空目录）时 exit 2，不谎报「通过」', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'check209-empty-'))
  const result = run(['--root', empty])
  assert.equal(result.status, 2)
  assert.match(`${result.stdout}${result.stderr}`, /没扫到|扫不到|SCAN/)
})

test('未知参数 exit 2（不静默忽略 --stric 这类拼写错误）', () => {
  const result = run(['--stric'])
  assert.equal(result.status, 2)
  assert.match(`${result.stdout}${result.stderr}`, /参数|未知|Usage/)
})
