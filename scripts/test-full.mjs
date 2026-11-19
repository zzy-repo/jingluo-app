#!/usr/bin/env node
/**
 * test-full.mjs —— 全量门：unit + regression + golden + integration（Issue #409）。
 *
 * 与 CI 的关系：这就是 CI 三条 job 在本地的一串（`.github/workflows/ci.yml` 的
 * 「type/lint/unit」「黄金回归」「L1 集成层」），所以它**慢是正常的**（单元 ~100s + 集成 ~20 分钟）。
 * 提交前请用 `pnpm test:fast` / `pnpm test:affected`，别用它。
 *
 * 四拍与各自的判红口径：
 *   1. unit            `node tests/run-layer.mjs unit`（全量，判真红）
 *   2. regression      `node tests/run-layer.mjs regression`（纯 Node，~4s）
 *   3. golden          真标准产物 + 真浏览器，每域 1 条主路径（并行，~4s）
 *   4. integration     `--baseline`：只判「相对 tests/integration-baseline.json 没有新增失败」。
 *                      这条不是偷懒：基线里有 7 条 known-red 带 reason/followUp，全绿才是幻想；
 *                      但「跑绿了却没删条目」会报 FIXED? 并判红，防基线长期腐烂。
 *
 * 产物（三份变体，和 CI 一样；缺了才构建，已存在就复用）：
 *   dist/          internal 变体 —— diagnostics / motion / mode-switch 等
 *   dist-standard/ standard 变体 —— 大多数集成用例 + 黄金套件（用 GOLDEN_DIST_DIR 指过来，不覆盖 dist）
 *   dist-scroll/   standard 变体 —— feedback-scroll 的滚动截图专用
 *
 * 用法：
 *   pnpm test:full
 *   pnpm test:full -- --layers unit,regression,golden   # 只跑几层（本地自检用，生产别这么跑）
 *   pnpm test:full -- --no-build                        # 产物我自己备，别动构建
 *   pnpm test:full -- --timeout-ms 600000
 */
import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT } from './lib/run-selected.mjs'

const LAYERS = ['unit', 'regression', 'golden', 'integration']
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build.mjs')
/** 集成层单文件超时：与 CI 一致（最慢的 feedback-scroll 实测 ≈194s） */
const DEFAULT_TIMEOUT_MS = 420000

const usage = (message) => {
  if (message) console.error(`${message}\n`)
  console.error('用法：node scripts/test-full.mjs [--layers unit,regression,golden,integration] [--no-build] [--timeout-ms 420000]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { layers: [...LAYERS], build: true, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm 会把 `--` 原样传下来（`pnpm test:fast -- --record`），它不是参数
    if (arg === '--') continue
    if (arg === '--no-build') { opts.build = false; continue }
    if (!['--layers', '--timeout-ms'].includes(arg)) usage(`未知参数：${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${arg} 需要一个值`)
    if (arg === '--layers') {
      opts.layers = value.split(',').map((item) => item.trim()).filter(Boolean)
      const bad = opts.layers.filter((layer) => !LAYERS.includes(layer))
      if (bad.length > 0) usage(`未知层：${bad.join(', ')}（可选 ${LAYERS.join(' / ')}）`)
    }
    if (arg === '--timeout-ms') opts.timeoutMs = Number(value)
  }
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1) usage('--timeout-ms 必须是正整数')
  return opts
}

const exists = async (file) => {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** 产物变体（读 build-info.json，不靠目录名猜） */
async function variantOf(dist) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, dist, 'build-info.json'), 'utf8')).variant ?? null
  } catch {
    return null
  }
}

function build({ dist, internal = false }) {
  const env = { ...process.env, DIST_OUT: dist }
  if (internal) env.INTERNAL_BUILD = '1'
  console.log(`   构建 ${dist}/（${internal ? 'internal' : 'standard'} 变体）`)
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit', env })
  if (result.status !== 0) throw new Error(`构建失败：${dist}/`)
}

/** 备齐某一层要的产物；返回是否真的构建了 */
async function ensureArtifacts(layers, allowBuild) {
  const need = []
  if (layers.includes('golden')) need.push({ dist: 'dist-standard', internal: false, why: '黄金套件要标准产物' })
  if (layers.includes('integration')) {
    need.push({ dist: 'dist', internal: true, why: '集成层：diagnostics / motion / mode-switch 要内测包' })
    need.push({ dist: 'dist-standard', internal: false, why: '集成层：大多数用例要标准包' })
    need.push({ dist: 'dist-scroll', internal: false, why: '集成层：feedback-scroll 要滚动专用产物' })
  }
  const built = []
  for (const item of need) {
    const index = path.join(ROOT, item.dist, 'index.html')
    const variant = await variantOf(item.dist)
    const wants = item.internal ? 'internal' : 'standard'
    if ((await exists(index)) && variant === wants) {
      console.log(`   产物 ${item.dist}/ 已在（${variant}），复用`)
      continue
    }
    if (!allowBuild) {
      console.log(`! 产物 ${item.dist}/ 缺失或种类不对（要 ${wants}，实际 ${variant ?? '无'}）：${item.why}。已加 --no-build，请自行构建`)
      continue
    }
    build({ dist: item.dist, internal: item.internal })
    built.push(item.dist)
  }
  return built
}

function step(command, args, env = {}) {
  const started = performance.now()
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, LANG: process.env.LANG || 'zh_CN.UTF-8', LC_ALL: process.env.LC_ALL || 'zh_CN.UTF-8', ...env } })
  return { status: result.status ?? 2, ms: Math.round(performance.now() - started) }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = []
  const startedAll = performance.now()

  console.log(`pnpm test:full：${opts.layers.join(' + ')}（单文件超时 ${opts.timeoutMs}ms）`)
  if (opts.build) await ensureArtifacts(opts.layers, true)
  else await ensureArtifacts(opts.layers, false)

  for (const layer of opts.layers) {
    console.log(`\n${'='.repeat(64)}\n== ${layer}\n`)
    let result
    if (layer === 'unit') result = step(process.execPath, [path.join(ROOT, 'tests', 'run-layer.mjs'), 'unit', '--timeout-ms', String(opts.timeoutMs)])
    else if (layer === 'regression') result = step(process.execPath, [path.join(ROOT, 'tests', 'run-layer.mjs'), 'regression'])
    else if (layer === 'golden') result = step(process.execPath, [path.join(ROOT, 'tests', 'run-golden.mjs')], { GOLDEN_DIST_DIR: path.join(ROOT, 'dist-standard') })
    else result = step(process.execPath, [path.join(ROOT, 'tests', 'run-layer.mjs'), 'integration', '--baseline', '--timeout-ms', String(opts.timeoutMs)])
    results.push({ layer, ...result })
    console.log(`<< ${layer} ${result.status === 0 ? 'PASS' : 'FAIL'} (${(result.ms / 1000).toFixed(1)}s)`)
    if (result.status !== 0) break
  }

  const totalMs = Math.round(performance.now() - startedAll)
  const failed = results.filter((item) => item.status !== 0)
  console.log(`\n${'='.repeat(64)}\npnpm test:full 各层耗时`)
  for (const item of results) console.log(`  ${item.layer.padEnd(12)} ${String(item.status === 0 ? 'PASS' : 'FAIL').padEnd(5)} ${(item.ms / 1000).toFixed(1)}s`)
  console.log(`  合计         ${failed.length === 0 ? 'PASS ' : 'FAIL '} ${(totalMs / 1000).toFixed(1)}s`)
  if (failed.length > 0) console.log(`\n停止于 ${failed[0].layer}：后面的层没跑（全量门不掩盖前面的红）`)
  return failed.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
