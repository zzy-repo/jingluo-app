#!/usr/bin/env node
/**
 * 黄金回归套件 runner（Issue #404）。
 *
 * 与 `tests/run-layer.mjs` 的分工：run-layer 是**串行**适配器（历史用例在同进程里 `process.exit`，
 * 一个红会带走后面全部）；黄金套件正好相反 —— 每条主路径 ≤60s、彼此完全独立（各起自己的
 * 静态服务 + 浏览器），所以这里**并行**跑，整层墙钟才可能压进 5 分钟。
 *
 *   node tests/run-golden.mjs                    # 并行跑 tests/golden/*.test.mjs
 *   node tests/run-golden.mjs --only g05          # 只跑文件名含 g05 的
 *   node tests/run-golden.mjs --list              # 只列出会跑哪些（还被 check:test-layout 用来查孤儿）
 *   node tests/run-golden.mjs --json r.json       # 落一份机器可读报告（含每条路径的耗时）
 *
 * 三道硬约束（Issue #404 的验收口径，机械执行，不靠人记）：
 *   1. 单条 ≤60s：`runCase` 到点即杀（TIMEOUT 判红）；
 *   2. 整层 ≤5 分钟：墙钟超预算直接 exit 1（不是警告）；
 *   3. 退出码：任一条红 → 1；参数/环境错误 → 2。
 *
 * 失败可见性：每条路径的失败行由用例自己打成一句话
 * （`✗ G1 启动 · 会话列表渲染 · 期望=3 条 · 实际=2 条`），这里原样抬到报告与 job summary。
 */
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GOLDEN_DIR = path.join(HERE, 'golden')
/** 单条预算（硬要求 4） */
const DEFAULT_PATH_TIMEOUT_MS = 60_000
/** 整层预算：5 分钟（并行墙钟） */
const DEFAULT_TOTAL_BUDGET_MS = 300_000
/** 默认并发：黄金套件是 6~8 条，机器（CI 2 核）能同时开 4 个 chromium 而不抖 */
const DEFAULT_CONCURRENCY = 4

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

function usage(message) {
  if (message) console.error(`${message}\n`)
  console.error(
    '用法：node tests/run-golden.mjs [--only 子串] [--list] [--json <file>] [--concurrency n] [--timeout-ms 60000] [--budget-ms 300000]'
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    only: '',
    list: false,
    json: '',
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_PATH_TIMEOUT_MS,
    budgetMs: DEFAULT_TOTAL_BUDGET_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--list') {
      opts.list = true
      continue
    }
    if (!['--only', '--json', '--concurrency', '--timeout-ms', '--budget-ms'].includes(arg)) {
      usage(`未知参数：${arg}`)
    }
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${arg} 需要一个值`)
    if (arg === '--only') opts.only = value
    if (arg === '--json') opts.json = value
    if (arg === '--concurrency') opts.concurrency = Number(value)
    if (arg === '--timeout-ms') opts.timeoutMs = Number(value)
    if (arg === '--budget-ms') opts.budgetMs = Number(value)
  }
  for (const key of ['concurrency', 'timeoutMs', 'budgetMs']) {
    if (!Number.isSafeInteger(opts[key]) || opts[key] < 1) usage(`--${key} 必须是正整数`)
  }
  return opts
}

/** 用例自己打的那行机器可读结果（见 helpers/golden.mjs runGolden） */
const RESULT_PREFIX = '[golden-result] '
const parseResult = (tail) => {
  const joined = tail.join('')
  const line = joined
    .split('\n')
    .reverse()
    .find((item) => item.startsWith(RESULT_PREFIX))
  if (!line) return null
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length))
  } catch {
    return null
  }
}

/** 从输出尾巴里捞失败行（用例的一句话定位），没有就退回最后几行原文 */
const failureLines = (tail) => {
  const lines = tail
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('✗'))
  return lines.length > 0 ? lines.slice(0, 5) : tail.join('').trim().split('\n').slice(-6)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let names
  try {
    names = await readdir(GOLDEN_DIR)
  } catch (error) {
    throw new Error(`读不到黄金用例目录 ${rel(GOLDEN_DIR)}：${error.message}`)
  }
  const files = names
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .filter((name) => !opts.only || name.includes(opts.only))
    .map((name) => path.join(GOLDEN_DIR, name))

  if (opts.list) {
    for (const file of files) console.log(`[golden] ${rel(file)}`)
    return files.length > 0 ? 0 : 1
  }
  if (files.length === 0) {
    console.error(`没有匹配的黄金用例（--only ${opts.only || '空'}）`)
    return 1
  }

  console.log(`黄金回归套件：${files.length} 条路径，并发 ${opts.concurrency}，单条上限 ${opts.timeoutMs}ms，整层预算 ${opts.budgetMs}ms`)
  const started = performance.now()
  const queue = [...files]
  const results = []

  const runOne = async (file) => {
    console.log(`\n>> ${rel(file)}`)
    const result = await runCase(file, { cwd: ROOT, timeoutMs: opts.timeoutMs })
    const reported = parseResult(result.tail)
    const status = result.timedOut ? 'TIMEOUT' : result.ok ? 'PASS' : 'FAIL'
    const item = {
      file: rel(file),
      id: reported?.id ?? path.basename(rel(file)),
      domain: reported?.domain ?? '',
      title: reported?.title ?? '',
      status,
      ms: result.ms,
      steps: reported?.steps ?? [],
      failures: status === 'PASS' ? [] : failureLines(result.tail),
    }
    results.push(item)
    console.log(`<< ${status} ${item.id} ${item.domain} (${item.ms}ms)` + (status === 'PASS' ? '' : `\n   ↳ ${item.failures[0] ?? '见上方输出'}`))
    return item
  }

  const worker = async () => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      await runOne(file)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker))

  const totalMs = Math.round(performance.now() - started)
  results.sort((a, b) => a.id.localeCompare(b.id))
  const failed = results.filter((item) => item.status !== 'PASS')
  const overBudget = totalMs > opts.budgetMs

  // 每条路径一行：耗时是这条套件存在的理由（快），所以必须每次都看得见
  const rows = results.map((item) => ({
    路径: item.id,
    域: item.domain,
    主路径: item.title,
    结果: item.status,
    耗时ms: item.ms,
    最慢一步: [...item.steps].sort((a, b) => b.ms - a.ms)[0]?.step ?? '',
  }))
  console.log('\n路径耗时')
  for (const row of rows) {
    console.log(`  ${String(row.路径).padEnd(4)} ${String(row.域).padEnd(4)} ${String(row.耗时ms).padStart(6)}ms  ${row.结果.padEnd(7)} ${row.主路径}`)
  }
  console.log(
    `\n总计 ${results.length} 条：PASS ${results.length - failed.length} / FAIL ${failed.length}；墙钟 ${totalMs}ms（预算 ${opts.budgetMs}ms${overBudget ? '，已超预算' : ''}）`
  )
  for (const item of failed) {
    console.log(`  ❌ ${item.id} ${item.domain}`)
    for (const line of item.failures) console.log(`     ${line}`)
    console.log(`     复跑：node ${item.file}`)
  }
  if (overBudget) {
    console.error(`整层墙钟 ${totalMs}ms 超出 5 分钟预算 ${opts.budgetMs}ms：黄金套件本身变慢了（或并发太低），本轮判红`)
  }

  if (opts.json) {
    await writeFile(
      path.resolve(opts.json),
      `${JSON.stringify({ version: 1, totalMs, budgetMs: opts.budgetMs, overBudget, results }, null, 2)}\n`
    )
  }
  return failed.length === 0 && !overBudget ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
