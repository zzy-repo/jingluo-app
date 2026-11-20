#!/usr/bin/env node
/**
 * check-test-seam.mjs —— 登录接缝**不许进产物**的门禁（Issue #487 W1-B 后半，#510 的安全底线）。
 *
 * ## 拦的是什么
 *
 * `AuthGate` 的登录接缝是构建期常量 `__TEST_AUTH_STATE__`：正常（生产 / 发版）构建里
 * DefinePlugin 把它内联成 `undefined`，守卫整段被死代码消除；只有 `TEST_AUTH_SEAM=1` 的测试构建
 * （CI 的黄金回归 / L1）才注入假会话。**这个约定没有任何东西能自动保证** —— 有人在发版流水线上
 * 顺手带上那个环境变量、或者哪天 DefinePlugin 的注入被删/改名导致标识符原样落进产物，都不会有编译错误，
 * 只会有「线上多出一条不用登录的路」。所以把它做成一次产物扫描：
 *
 *   `dist/` 里一旦出现 `__TEST_AUTH_STATE__` 或假 token `test-token-not-real` → **exit 1**。
 *
 * 标记清单、假会话与开关的取值都在 `scripts/lib/testAuthSeam.mjs`（同一份来源），这里只负责扫描与退出码。
 *
 * ## 为什么要 `--expect-seam`
 *
 * 和本仓其它门禁同一条教训（#413 / #494）：**能判红的门禁和真的跑了是两件事**，而扫描器最坏的失败
 * 方式是恒绿（路径写错、扩展名过滤写错、产物目录不对）。所以 CI 里同时跑一次**正向对照**：
 * 对**接缝构建**（`TEST_AUTH_SEAM=1`）扫，必须**扫得到**标记；扫不到说明扫描器本身坏了。
 *
 * 用法：
 *   node scripts/check-test-seam.mjs                     # 扫 dist/（缺省；干净才 0）
 *   node scripts/check-test-seam.mjs dist-standard ...    # 扫指定目录
 *   node scripts/check-test-seam.mjs --expect-seam dist-seam   # 正向对照：必须扫到
 *   pnpm run check:test-seam
 *
 * 退出码：
 *   0  干净（或 `--expect-seam` 时确实扫到了）
 *   1  违规（生产产物里有接缝 / `--expect-seam` 时一扫不到）
 *   2  用法 / 环境错误（目录不存在、未知参数）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SEAM_FLAG, SEAM_MARKERS, scanForSeam, seamEnabled } from './lib/testAuthSeam.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const usage = () =>
  [
    '用法：node scripts/check-test-seam.mjs [--expect-seam] [dist 目录…]',
    '',
    `  扫产物里有没有登录接缝标记（${SEAM_MARKERS.join(' / ')}）。`,
    '  --expect-seam  正向对照：要求**必须**扫到（只对接缝构建成立）',
    '',
    `  注意：${SEAM_FLAG}=1 的构建**必然**带着标记，那是测试专用产物，别拿它当发版输入。`,
  ].join('\n')

const argv = process.argv.slice(2)
let expectSeam = false
const targets = []
for (const arg of argv) {
  // `pnpm run <script> -- --expect-seam` 会把那个 `--` 原样透传给脚本（pnpm 9 实测，
  // npm 会吃掉它）—— 两个包管理器都得能用，所以这里直接忽略分隔符本身。
  if (arg === '--') {
    continue
  }
  if (arg === '--expect-seam') {
    expectSeam = true
    continue
  }
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${usage()}\n`)
    process.exit(EXIT_OK)
  }
  if (arg.startsWith('-')) {
    process.stderr.write(`[check:test-seam] 未知参数：${arg}\n\n${usage()}\n`)
    process.exit(EXIT_USAGE)
  }
  targets.push(arg)
}
if (targets.length === 0) {
  targets.push('dist')
}

// 目录必须真的存在：缺产物时说「干净」是最坏的一种绿（和 check:bundle-target 同一条口径）
for (const target of targets) {
  const resolved = path.resolve(ROOT, target)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    process.stderr.write(`[check:test-seam] 产物目录不存在：${target}（先跑 pnpm run build）\n`)
    process.exit(EXIT_USAGE)
  }
}

// 发版 / 本地正常构建时把开关带上，说明「这条命令本身用法就错了」，别让扫描得出结论
if (!expectSeam && seamEnabled()) {
  process.stderr.write(
    `[check:test-seam] ${SEAM_FLAG}=1 还开着：这条门禁是给**生产产物**用的。测试接缝请用 --expect-seam。\n`
  )
  process.exit(EXIT_USAGE)
}

const hits = targets.flatMap((target) => scanForSeam(path.resolve(ROOT, target)))

const rel = (file) => path.relative(ROOT, file)
const groupByMarker = () => {
  const groups = new Map()
  for (const hit of hits) {
    if (!groups.has(hit.marker)) {
      groups.set(hit.marker, [])
    }
    groups.get(hit.marker).push(rel(hit.file))
  }
  return groups
}

if (expectSeam) {
  if (hits.length === 0) {
    process.stderr.write(
      `[check:test-seam] ✗ 正向对照失败：${targets.join(', ')} 里一个接缝标记都没有 —— ` +
        '要么这不是接缝构建（漏了 TEST_AUTH_SEAM=1），要么扫描器坏了。\n'
    )
    process.exit(EXIT_FAIL)
  }
  for (const [marker, files] of groupByMarker()) {
    process.stdout.write(`[check:test-seam] ✓ 正向对照：扫到 ${marker}（${files.length} 个文件，如 ${files[0]}）\n`)
  }
  process.exit(EXIT_OK)
}

if (hits.length > 0) {
  process.stderr.write(`[check:test-seam] ✗ 生产产物里出现了登录接缝标记（${hits.length} 处）：\n`)
  for (const [marker, files] of groupByMarker()) {
    process.stderr.write(`  - ${marker}：${files.join(', ')}\n`)
  }
  process.stderr.write(
    '  接缝只许出现在测试构建里：确认构建命令没有带 ' +
      `${SEAM_FLAG}=1（发版流水线绝不能带），并检查 DefinePlugin 是否还给 __TEST_AUTH_STATE__ 注入 undefined。\n`
  )
  process.exit(EXIT_FAIL)
}

process.stdout.write(`[check:test-seam] ✓ ${targets.join(', ')} 里没有接缝标记（${SEAM_MARKERS.join(' / ')}）\n`)
process.exit(EXIT_OK)
