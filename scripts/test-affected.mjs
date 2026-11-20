#!/usr/bin/env node
/**
 * test-affected.mjs —— 「改这几个文件，该跑哪些用例」（Issue #409）。
 *
 *   pnpm test:affected -- src/services/chat/history/urlImport.ts
 *   pnpm test:affected -- $(git diff --name-only origin/main...HEAD)
 *   pnpm test:affected -- --list -- src/services/api/client.ts     # 只挑不跑
 *   pnpm test:affected -- --with-integration -- src/services/api/**  # 连集成用例一起跑（要标准产物）
 *
 * 和已有的 `tests/which.mjs` 什么关系：
 *   which.mjs 是**单测 import 反查 + 人工规则**（改 src 时能自动找回 import 它的单测，适合未知变更）；
 *   这里是**域级 glob 映射**（`tests/domain-map.json`，10 个域，对齐 docs/testing/coverage/domain-*.md），
 *   讲的是「这块代码归哪个域、这个域有哪些用例」，所以能一次挑到 unit + regression + golden + integration。
 *   两者都不改用例内容；挑不出来时两边都回落整层并**把原因打出来**，不静默跳过。
 *
 * 默认只跑 unit / regression / golden（秒级）；集成层单文件 3~120s 且带 7 条 known-red，
 * 会让「快速反馈」变成「等两分钟看一条已知红」，所以默认不跑，需要 `--with-integration` 显式打开。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, printSummary, rel, runSelected } from './lib/run-selected.mjs'
import { expandGlob, matchesGlob, selfTest } from './lib/glob-match.mjs'

const MAP_FILE = path.join(ROOT, 'tests', 'domain-map.json')
const LAYER_DIRS = ['unit', 'regression', 'golden', 'integration']
const LAYER_ORDER = new Map(LAYER_DIRS.map((name, index) => [name, index]))

const usage = (message) => {
  if (message) console.error(`${message}\n`)
  console.error('用法：node scripts/test-affected.mjs [--list] [--with-integration] [--json r.json] [--self-test] -- <改动文件...>')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { list: false, withIntegration: false, json: '', files: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--list') { opts.list = true; continue }
    if (arg === '--with-integration') { opts.withIntegration = true; continue }
    if (arg === '--self-test') { selfTest(); process.exit(0) }
    if (arg === '--json') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) usage('--json 需要一个值')
      opts.json = value
      continue
    }
    if (arg.startsWith('-')) usage(`未知参数：${arg}`)
    opts.files.push(arg)
  }
  return opts
}

/** 仓库内所有候选用例（相对仓库根），供用例 glob 展开 */
async function testPool() {
  const pool = []
  for (const layer of LAYER_DIRS) {
    let names = []
    try {
      names = (await readdir(path.join(ROOT, 'tests', layer))).filter((name) => name.endsWith('.test.mjs'))
    } catch {
      continue
    }
    for (const name of names.sort()) pool.push(`tests/${layer}/${name}`)
  }
  return pool
}

const norm = (file) => file.replace(/\\/g, '/').replace(/^\.\//, '').replace(`${ROOT}/`, '')

function layerOf(file) {
  const [, layer] = /^tests\/([^/]+)\//.exec(file) ?? []
  return layer ?? ''
}

/** 改动文件 → { picked:Set, notes:[{level,text}], domains:Set } */
function select(changed, map, pool) {
  const picked = new Set()
  const notes = []
  const domains = new Set()
  let unmatched = 0

  for (const raw of changed) {
    const file = norm(raw)
    if (!file) continue

    // 1) 改用例本身 → 只跑它自己（用例内容不动，但改了就得验证它）
    if (/^tests\/.+\.test\.mjs$/.test(file)) {
      if (pool.includes(file)) {
        picked.add(file)
        notes.push({ level: 'hit', text: `${file}：改动的是用例本身 → 跑它自己` })
      } else {
        notes.push({ level: 'warn', text: `${file}：tests/ 下找不到这个文件 → 忽略` })
      }
      continue
    }

    // 2) 10 个域（一条路径可以命中多个域，取并集）
    const hits = []
    for (const domain of map.domains) {
      const globs = Object.keys(domain.paths).filter((glob) => matchesGlob(file, glob))
      if (globs.length === 0) continue
      const assigned = globs.flatMap((glob) => domain.paths[glob])
      // 域级的兜底用例：不管命中哪条 glob，这个域的「主用例」都带上（域测试集的收口）
      const always = Object.values(domain.tests ?? {}).flat()
      const files = [...new Set([...new Set([...assigned, ...always])].flatMap((glob) => expandGlob(glob, pool)))]
      for (const filePicked of files) picked.add(filePicked)
      domains.add(domain.id)
      hits.push(`${domain.id} ${domain.name}（${globs.join(' + ')} → ${files.length} 个用例）`)
    }
    if (hits.length > 0) {
      notes.push({ level: 'hit', text: `${file}：命中 ${hits.join('；')}` })
      continue
    }

    // 3) 回落：说清原因，按 fallback 规则决定跑什么，绝不静默跳过
    unmatched += 1
    const rule = (map.fallback?.rules ?? []).find((item) => new RegExp(item.match).test(file))
    if (!rule) {
      notes.push({ level: 'warn', text: `${file}：不在 10 个域里，也没有回落规则 → 建议直接 pnpm test:fast / test:full` })
      continue
    }
    const targets = rule.run ?? []
    if (targets.length === 0) {
      notes.push({ level: 'info', text: `${file}：${rule.why}` })
      continue
    }
    let added = 0
    for (const target of targets) {
      if (target === '$self') continue
      const files = pool.filter((item) => item.startsWith(`${target}/`))
      for (const item of files) picked.add(item)
      added += files.length
    }
    notes.push({ level: 'warn', text: `${file}：${rule.why}（回落 ${added} 个用例）` })
  }
  return { picked: [...picked].sort(byLayerThenName), notes, domains: [...domains], unmatched }
}

const byLayerThenName = (a, b) =>
  (LAYER_ORDER.get(layerOf(a)) ?? 9) - (LAYER_ORDER.get(layerOf(b)) ?? 9) || a.localeCompare(b)

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.files.length === 0) usage('至少给一个改动路径（`pnpm test:affected -- <paths>`）')

  let map
  try {
    map = JSON.parse(await readFile(MAP_FILE, 'utf8'))
  } catch (error) {
    console.error(`读不到 ${rel(MAP_FILE)}：${error.message}`)
    return 2
  }
  if (!Array.isArray(map.domains) || map.domains.length === 0) {
    console.error(`${rel(MAP_FILE)} 里没有 domains —— 映射表坏了，不猜`)
    return 2
  }

  const pool = await testPool()
  const { picked, notes, domains, unmatched } = select(opts.files, map, pool)

  for (const note of notes) console.log(`${note.level === 'hit' ? '!' : note.level === 'warn' ? '⚠' : '·'} ${note.text}`)

  const runLayers = new Set(['unit', 'regression', 'golden', ...(opts.withIntegration ? ['integration'] : [])])
  const runnable = picked.filter((file) => runLayers.has(layerOf(file)))
  const skippedIntegration = picked.filter((file) => layerOf(file) === 'integration' && !opts.withIntegration)

  console.log(`\n命中 ${picked.length} 个文件（${domains.length} 个域：${domains.join(' ') || '—'}；未命中域 ${unmatched} 个路径）`)
  const counts = LAYER_DIRS.map((layer) => `${layer} ${picked.filter((file) => layerOf(file) === layer).length}`).join(' / ')
  console.log(`  分层：${counts}`)
  for (const file of picked) console.log(`  ${layerOf(file).padEnd(11)} ${file}`)
  if (skippedIntegration.length > 0) {
    console.log(`\n· 另有 ${skippedIntegration.length} 个集成用例被选中但未执行（默认不跑集成层）：加 --with-integration 才会跑`)
    for (const file of skippedIntegration) console.log(`  ${file}`)
  }

  if (opts.list) {
    console.log('\n建议命令：')
    if (runnable.length > 0) console.log(`  node scripts/test-affected.mjs -- ${opts.files.join(' ')}`)
    for (const file of skippedIntegration) console.log(`  node tests/run-layer.mjs integration --case ${file}`)
    return 0
  }
  if (runnable.length === 0) {
    console.log('\n没有需要执行的用例（改动的都是文档或不参与分层的路径）')
    return 0
  }

  const started = performance.now()
  let failed = 0
  let totalCases = null

  // 只把 unit / regression 交给批量 runner：集成层要 runner 注入 APP_URL / DIST_DIR，走的是另一条路
  const fastFiles = runnable.filter((file) => layerOf(file) === 'unit' || layerOf(file) === 'regression')
  if (fastFiles.length > 0) {
    const summary = await runSelected(fastFiles)
    printSummary('unit + regression', summary)
    failed += summary.failed
    totalCases = summary.cases
  }

  const goldenFiles = runnable.filter((file) => layerOf(file) === 'golden')
  for (const file of goldenFiles) {
    const stem = path.basename(file, '.test.mjs')
    console.log(`\n>> 黄金套件 ${file}（--only ${stem}）`)
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run-golden.mjs'), '--only', stem], { cwd: ROOT, stdio: 'inherit', env: process.env })
    if (result.status !== 0) failed += 1
  }

  const integrationFiles = runnable.filter((file) => layerOf(file) === 'integration')
  for (const file of integrationFiles) {
    console.log(`\n>> 集成层 ${file}`)
    // `--baseline`：集成层基线里有 7 条 known-red，按第 4 节口径只判「不新增失败」。
    // 不带它的话，改到 log-viewer / diagnostics-contract 这类文件会稳定红一条**已知**的，
    // 而这条命令的用途是「快速反馈」，不是「再发现一次已知红」。
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'tests', 'run-layer.mjs'), 'integration', '--case', file, '--baseline', '--timeout-ms', '420000'],
      { cwd: ROOT, stdio: 'inherit', env: process.env },
    )
    if (result.status !== 0) failed += 1
  }

  const totalMs = Math.round(performance.now() - started)
  console.log(`\n${'='.repeat(64)}\ntest:affected 结果：命中 ${picked.length} 个文件，执行 ${runnable.length} 个；${failed === 0 ? 'PASS' : `FAIL ${failed}`}；耗时 ${(totalMs / 1000).toFixed(1)}s${totalCases === null ? '' : `（单测/回归 ${totalCases} 用例）`}`)
  if (opts.json) {
    await writeFile(path.resolve(opts.json), `${JSON.stringify({ version: 1, changed: opts.files, domains, picked, executed: runnable, skippedIntegration, failed, totalMs }, null, 2)}\n`)
    console.log(`报告：${opts.json}`)
  }
  return failed === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
