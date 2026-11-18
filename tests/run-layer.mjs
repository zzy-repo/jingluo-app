#!/usr/bin/env node
// Sequential adapter for legacy self-executing scripts and node:test files.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './helpers/runtime.mjs'
import { serveDir } from './helpers/env.mjs'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')
const LAYERS = ['unit', 'integration', 'e2e', 'device']
const SELF_SERVED = new Set([
  'internal-build', 'motion', 'mode-switch', 'diagnostics', 'diagnostics-contract', 'auto-title',
  'provider-channels', 'feedback-export', 'mode-switch-plain',
].map((s) => `${s}.test.mjs`))
/**
 * 这几个用例历史上是「外部先起一个静态服务，再 APP_URL=... 跑」（旧 README 让手起 5181）。
 * 手起服务漏了就是整批假红，所以这里由 runner 统一起一份标准产物服务并把 APP_URL 注入进去；
 * 用例自己已经能自起服务的（SELF_SERVED）不走这条路。
 */
const APP_URL_FILES = new Set([
  'caps', 'paths', 'probe-auth', 'probe-auth-protocols', 'probe-nokey', 'provider-anthropic',
  'request-body', 'upstream-html', 'url-import-native', 'url-import-stages', 'url-import-web',
  'legacy-config', 'full-acceptance',
].map((s) => `${s}.test.mjs`))

/** 用例的环境守卫退出码：端口被占 / 产物种类不对 / 产物陈旧（SKIP(env)，不算失败） */
const SKIP_CODE = 77
/** 集成层基线清单：只判「相对基线没有新增失败」 */
const BASELINE_FILE = path.join(TESTS_DIR, 'integration-baseline.json')
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

async function main() {
  const argv = process.argv.slice(2)
  let layer, only = '', caseName = '', json, failedFrom, timeoutMs = 180000
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--only', '--case', '--json', '--failed-from', '--timeout-ms'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`)
      if (arg === '--only') only = value
      if (arg === '--case') caseName = value
      if (arg === '--json') json = value
      if (arg === '--failed-from') failedFrom = value
      if (arg === '--timeout-ms') timeoutMs = Number(value)
    } else if (['--bail', '--list', '--baseline'].includes(arg)) flags.add(arg)
    else if (!arg.startsWith('-') && !layer) layer = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout-ms must be a positive integer')
  const plan = layer === 'all' ? ['unit', 'integration'] : [layer]
  if (plan.some((name) => !LAYERS.includes(name))) throw new Error('Usage: node tests/run-layer.mjs <unit|integration|e2e|device|all> [--only substring] [--case exact-path] [--timeout-ms 180000] [--json result.json] [--failed-from result.json] [--bail] [--list]')
  let failed
  if (failedFrom) {
    const report = JSON.parse(await readFile(failedFrom, 'utf8'))
    if (!Array.isArray(report.results) || report.results.some((r) => typeof r.file !== 'string' || typeof r.ok !== 'boolean')) throw new Error('Invalid previous report')
    failed = new Set(report.results.filter((r) => !r.ok).map((r) => r.file))
  }
  const selected = []
  for (const name of plan) {
    // Missing/unreadable layer is an infrastructure error, never an empty PASS.
    const names = await readdir(path.join(TESTS_DIR, name))
    for (const basename of names.filter((n) => n.endsWith('.test.mjs')).sort()) {
      const file = path.join(TESTS_DIR, name, basename)
      if (only && !basename.includes(only)) continue
      if (caseName && caseName !== rel(file) && caseName !== basename) continue
      if (failed && !failed.has(rel(file))) continue
      selected.push({ layer: name, file })
    }
  }
  const started = performance.now()
  const results = []
  if (flags.has('--list')) {
    for (const item of selected) console.log(`[${item.layer}] ${rel(item.file)}`)
    return selected.length ? 0 : 1
  }
  let interrupted = false
  // 共享标准产物服务：只在真的有用例需要 APP_URL 时才起，退出即释放（端口 0 = 原子分配，不撞端口）
  let sharedStd = null
  const ensureSharedStd = async () => {
    if (sharedStd) return sharedStd
    const dir = process.env.STANDARD_DIST_DIR || process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
    sharedStd = await serveDir(dir, { port: 0, label: '共享标准产物 dist-standard' })
    console.log(`
共享标准产物服务：${dir} → ${sharedStd.url}`)
    return sharedStd
  }
  for (const item of selected) {
    console.log(`\n>> ${rel(item.file)} (timeout ${timeoutMs}ms)`)
    const env = { ...process.env }
    const base = path.basename(item.file)
    if (SELF_SERVED.has(base)) env.APP_URL = ''
    else if (APP_URL_FILES.has(base) && !process.env.APP_URL) env.APP_URL = (await ensureSharedStd()).url
    const result = await runCase(item.file, { cwd: ROOT, env, timeoutMs })
    const skipped = result.code === SKIP_CODE
    const skipReason = skipped ? (/SKIP\(env\) (.+)/.exec(result.tail.join(''))?.[1] ?? '环境不满足').trim() : ''
    results.push({ layer: item.layer, file: rel(item.file), ...result, skipped, skipReason })
    const status = result.ok ? 'PASS' : skipped ? 'SKIP(env)' : result.timedOut ? 'TIMEOUT' : 'FAIL'
    console.log(`<< ${status} ${rel(item.file)} (${result.ms}ms)`)
    if (skipped) console.log(`   ↳ ${skipReason}`)
    if (result.interrupted) { interrupted = true; break }
    if (!result.ok && flags.has('--bail')) break
  }
  sharedStd?.kill()
  const failures = results.filter((r) => !r.ok && !r.skipped)
  const skips = results.filter((r) => r.skipped)
  const failedCount = failures.length
  const totalMs = Math.round(performance.now() - started)
  const report = {
    version: 1,
    totalMs,
    selected: selected.length,
    executed: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: failedCount,
    skipped: skips.length,
    results,
  }
  if (json) await writeFile(path.resolve(json), JSON.stringify(report, null, 2) + '\n')
  if (!selected.length) console.error('No matching cases')
  console.log(
    `\nTotal ${results.length}: PASS ${report.passed}, FAIL ${failedCount}, SKIP(env) ${skips.length}; elapsed ${totalMs}ms`,
  )
  for (const r of failures) console.log(`Rerun: node tests/run-layer.mjs ${r.layer} --case ${r.file}`)
  for (const r of skips) console.log(`Skipped (environment): ${r.file} — ${r.skipReason}`)
  const verdict = await compareWithBaseline(results)
  if (verdict !== null) return interrupted ? 130 : verdict
  return interrupted ? 130 : selected.length && !failedCount ? 0 : 1

  /** --baseline：与 tests/integration-baseline.json 比对，只判「相对基线没有新增失败」 */
  async function compareWithBaseline(list) {
    if (!flags.has('--baseline')) return null
    let baseline
    try {
      baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'))
    } catch (error) {
      console.error(`\n基线清单读取失败：${BASELINE_FILE}（${error.message}）——按普通模式判定`)
      return null
    }
    const entryOf = (file) => baseline.files?.[path.basename(file)] ?? null
    const newFails = []
    const fixed = []
    const knownRed = []
    const skipped = []
    for (const r of list) {
      const entry = entryOf(r.file)
      const expected = entry?.expected ?? 'pass'
      if (r.skipped) {
        skipped.push(r)
        continue
      }
      if (r.ok && expected === 'known-red') fixed.push(r.file)
      else if (!r.ok && expected === 'known-red') knownRed.push(r.file)
      else if (!r.ok) newFails.push({ file: r.file, reason: entry?.reason ?? '' })
    }
    const failedNow = list.filter((r) => !r.ok && !r.skipped).length
    const registeredRed = Object.values(baseline.files ?? {}).filter((e) => e.expected === 'known-red').length
    console.log(
      `\n${'='.repeat(70)}\n== 基线比对（${path.basename(BASELINE_FILE)}，基线：${baseline.baseline?.ref ?? '未注明'}）\n${'='.repeat(70)}`,
    )
    console.log(
      `本次失败 ${failedNow} / 基线登记红 ${registeredRed} / 新增失败 ${newFails.length} / 已转绿 ${fixed.length} / 跳过(环境) ${skipped.length}（共 ${list.length} 个文件）`,
    )
    for (const file of knownRed) console.log(`  KNOWN-RED  ${file}（基线已登记，不算新增）`)
    for (const r of skipped) console.log(`  SKIP(ENV)  ${r.file}：${r.skipReason}`)
    for (const file of fixed) console.log(`  FIXED?     ${file}（基线记着红但这次通过，请更新基线清单）`)
    for (const item of newFails) console.log(`  NEW FAIL   ${item.file}${item.reason ? `（${item.reason}）` : ''}`)
    const ok = newFails.length === 0 && fixed.length === 0
    console.log(ok ? '\n相对基线没有新增失败 ✅' : '\n相对基线有问题 ❌')
    return ok ? 0 : 1
  }
}

try { process.exitCode = await main() }
catch (error) { console.error(error.message); process.exitCode = 2 }
