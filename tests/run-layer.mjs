#!/usr/bin/env node
// Sequential adapter for legacy self-executing scripts and node:test files.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './helpers/runtime.mjs'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')
const LAYERS = ['unit', 'integration', 'e2e', 'device']
const SELF_SERVED = new Set(['internal-build', 'motion', 'diagnostics', 'diagnostics-contract', 'auto-title'].map((s) => `${s}.test.mjs`))
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
    } else if (['--bail', '--list'].includes(arg)) flags.add(arg)
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
  for (const item of selected) {
    console.log(`\n>> ${rel(item.file)} (timeout ${timeoutMs}ms)`)
    const env = { ...process.env }
    if (SELF_SERVED.has(path.basename(item.file))) env.APP_URL = ''
    const result = await runCase(item.file, { cwd: ROOT, env, timeoutMs })
    results.push({ layer: item.layer, file: rel(item.file), ...result })
    console.log(`<< ${result.ok ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL'} ${rel(item.file)} (${result.ms}ms)`)
    if (result.interrupted) { interrupted = true; break }
    if (!result.ok && flags.has('--bail')) break
  }
  const failedCount = results.filter((r) => !r.ok).length
  const totalMs = Math.round(performance.now() - started)
  const report = { version: 1, totalMs, selected: selected.length, executed: results.length, passed: results.length - failedCount, failed: failedCount, results }
  if (json) await writeFile(path.resolve(json), JSON.stringify(report, null, 2) + '\n')
  if (!selected.length) console.error('No matching cases')
  console.log(`\nTotal ${results.length}: PASS ${report.passed}, FAIL ${failedCount}; elapsed ${totalMs}ms`)
  for (const r of results.filter((r) => !r.ok)) console.log(`Rerun: node tests/run-layer.mjs ${r.layer} --case ${r.file}`)
  return interrupted ? 130 : selected.length && !failedCount ? 0 : 1
}

try { process.exitCode = await main() }
catch (error) { console.error(error.message); process.exitCode = 2 }
