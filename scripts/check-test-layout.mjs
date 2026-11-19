#!/usr/bin/env node
/**
 * check-test-layout.mjs —— 测试布局门禁（#362 阶段二 / #366 收口）。
 *
 * 为什么要有它：`tests/` 现在有 6 个「放测试」的位置（unit / integration / regression / e2e / device /
 * deploy/dl-release/test），但**只有一个分层 runner**（`tests/run-layer.mjs`），而它的 `LAYERS` 只有
 * unit / integration / e2e / device。结果是 `tests/regression/` 12 个文件「写了、从来没有任何入口跑」
 * —— 不报错、不变红、也没人发现；#362 这一轮又新增了 61 个 `domain*-*` 文件（6 个域），
 * 下次只会更散。手工点名检查只能查一次，所以做成一条命令：**再写一个跑不到的测试就 exit 1**。
 *
 * 判定口径（每条都对应一个真实的失效模式）：
 *   1. 孤儿（error）—— `tests/**` 下的 `*.test.mjs` 必须能被 `tests/run-layer.mjs` 的某个 LAYERS 枚举到。
 *      枚举**不靠猜**：对 LAYERS 里每一层真跑一遍 `node tests/run-layer.mjs <layer> --list`，
 *      再和文件系统比对。runner 改了枚举规则（比如只认平铺文件、加 `--only` 过滤）这里会同步暴露。
 *   2. 落位（error）—— 只允许 `tests/{unit,integration,regression,device}/` 四个层级目录
 *      （`tests/e2e/` 若已存在则同样允许），且层级目录内**不再建子目录**：
 *      `run-layer.mjs` 用的是 `readdir` 非递归，深层文件 100% 跑不到。
 *   3. 命名（error）—— 同一域的多份文件必须 `domain-NN-*`（两位数，小写短横线）：
 *      · 文件名以 `domain` 开头的（不分大小写）必须匹配 `^domain\d{2}-`
 *      · 头部注释（前 15 行）声明了 `#362` + `域 N` 的批次文件，文件名必须带 `domainNN-` 前缀
 *      发现不合规**只报告、不改文件名**（改名要同步改 docs/测试引用，属后续批次）。#366 第一批不动它。
 *   4. fixture 散放（warning，只有 `--strict` 才阻塞）—— `tests/fixtures/<域>/` 是唯一合法位置，
 *      根目录直接放 `.mjs`/`.json` 属散放。存量里有 5 个跨域共享桩（mock-anthropic / ours-upstream …），
 *      它们不是"域"夹具，先只暴露不阻塞；`--strict` 下红。
 *
 * 基线（`tests/test-layout-baseline.json`，规则**只减不增**）：
 *   存量必然违规（regression 层 12 个文件当前就是孤儿），所以第 1、2、3 类允许登记豁免。
 *   运行时：**基线条目之外的新违规一律 exit 1**；条目失效（已经不违规了）会提示删除，
 *   `--strict` 下也算红。`--update-baseline` 只允许写"当前违规 ⊆ 现有基线"，要新增条目必须显式 `--force`
 *   —— 这就是"只减不增"的机械实现，避免下次谁跑一遍就把新违规生成进基线。
 *
 * 用法：
 *   node scripts/check-test-layout.mjs                 # 门禁模式：基线之外的新违规 exit 1
 *   node scripts/check-test-layout.mjs --warn           # 只报告，永远 exit 0（CI 前三轮用这个）
 *   node scripts/check-test-layout.mjs --strict         # fixture 散放也阻塞
 *   node scripts/check-test-layout.mjs --json r.json    # 机器可读结果
 *   node scripts/check-test-layout.mjs --update-baseline [--force]
 *
 * 退出码：0 通过（或 --warn）/ 1 发现基线外违规 / 2 用法或环境错误
 */

import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = path.join(ROOT, 'tests')
const RUN_LAYER = path.join(TESTS_DIR, 'run-layer.mjs')
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures')
const BASELINE_FILE = path.join(TESTS_DIR, 'test-layout-baseline.json')

/** 允许的层级目录。`e2e` 只在其目录真实存在时才算合法（历史上有过、也可能被并走）。 */
const ALLOWED_LAYERS = ['unit', 'integration', 'regression', 'device']
const OPTIONAL_LAYERS = ['e2e']

/** 域批次文件名的唯一合法形状：domain05-export-contract.test.mjs */
const DOMAIN_NAME_RE = /^domain\d{2}-[a-z0-9][a-z0-9-]*\.test\.mjs$/
/** 头部声明域批次（#362）的识别：前 15 行里同时出现 #362 与「域 3 / 域3」 */
const HEADER_LINES = 15
const HEADER_DOMAIN_RE = /域\s*([0-9]{1,2})/g

/** 硬规则（可基线化）：孤儿 / 落位 / 命名。fixture 散放单独算 warning。 */
const HARD_RULES = new Set(['orphan', 'layer-placement', 'naming', 'naming-declared-domain'])

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

function usage(message) {
  if (message) console.error(`${message}\n`)
  console.error('用法：node scripts/check-test-layout.mjs [--warn] [--strict] [--json <file>] [--update-baseline [--force]]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { warn: false, strict: false, json: '', updateBaseline: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // npm/pnpm 会把 `--` 原样透传
    if (arg === '--warn') opts.warn = true
    else if (arg === '--strict') opts.strict = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--update-baseline') opts.updateBaseline = true
    else if (arg === '--json') {
      opts.json = argv[++i]
      if (!opts.json || opts.json.startsWith('--')) usage('--json 需要一个输出路径')
    } else usage(`未知参数：${arg}`)
  }
  return opts
}

/** 递归收集 `tests/**\/*.test.mjs`（跳过 fixtures/helpers/tools：那里放的是夹具与手工脚本，不是用例） */
async function walkTests(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw new Error(`无法读取测试目录 ${rel(dir)}：${error.message}`)
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const name = entry.name
      if (name === 'fixtures' || name === 'helpers' || name === 'tools' || name === 'node_modules') continue
      await walkTests(full, out)
    } else if (entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

/**
 * 从 runner 源码里静态读出 LAYERS —— 只用来知道「该比哪几层」，
 * 真正枚举到的文件仍以 `--list` 的实跑输出为准（源码与行为不一致时下面会报错）。
 */
async function readLayers() {
  const source = await readFile(RUN_LAYER, 'utf8')
  const match = /const LAYERS = \[([^\]]*)\]/.exec(source)
  if (!match) throw new Error('tests/run-layer.mjs 里找不到 `const LAYERS = [...]`（runner 结构变了，请更新本门禁）')
  const layers = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (!layers.length) throw new Error('tests/run-layer.mjs 的 LAYERS 解析为空')
  return layers
}

/** 真跑 `run-layer.mjs <layer> --list`（不执行用例），拿到该层枚举到的文件清单。 */
function listLayer(layer) {
  const result = spawnSync(process.execPath, [RUN_LAYER, layer, '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const stdout = result.stdout ?? ''
  const stderr = (result.stderr ?? '').trim()
  // --list 在「该层没有文件」时返回 1，这不算失败；参数/环境错误返回 2 才是。
  if (result.status === 2 || result.error) {
    return { ok: false, files: [], error: stderr || result.error?.message || `exit ${result.status}` }
  }
  const files = []
  for (const line of stdout.split('\n')) {
    const m = /^\[([a-z0-9-]+)\]\s+(.+)$/.exec(line.trim())
    if (m) files.push(m[2].split(path.sep).join('/'))
  }
  return { ok: true, files, error: '' }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 头部声明了 #362 域批次的文件 → 返回声明的域号数组（没有则空数组） */
async function declaredDomains(file) {
  const text = await readFile(file, 'utf8')
  const header = text.split('\n').slice(0, HEADER_LINES).join('\n')
  if (!header.includes('#362')) return []
  const numbers = new Set()
  for (const m of header.matchAll(HEADER_DOMAIN_RE)) numbers.add(Number(m[1]))
  return [...numbers]
}

async function collectViolations(testFiles) {
  const violations = []
  const layers = await readLayers()
  const allowed = new Set([...ALLOWED_LAYERS])
  for (const layer of OPTIONAL_LAYERS) if (await exists(path.join(TESTS_DIR, layer))) allowed.add(layer)

  // ---- 规则 1：孤儿（run-layer 枚举不到）----
  const enumerated = new Set()
  const layerErrors = []
  const layerCounts = {}
  for (const layer of layers) {
    const listed = listLayer(layer)
    if (!listed.ok) {
      layerErrors.push({ layer, error: listed.error })
      continue
    }
    layerCounts[layer] = listed.files.length
    for (const file of listed.files) enumerated.add(file)
  }
  for (const error of layerErrors) {
    violations.push({
      rule: 'runner-layer-broken',
      file: `tests/${error.layer}`,
      detail: `run-layer.mjs --list 失败：${error.error}`,
    })
  }

  for (const file of testFiles) {
    const relPath = rel(file)
    const parts = relPath.split('/')
    const layer = parts[1]
    // ---- 规则 2：落位 ----
    if (!allowed.has(layer)) {
      violations.push({
        rule: 'layer-placement',
        file: relPath,
        detail: `目录 ${parts.slice(0, -1).join('/')} 不是合法层级（只允许 ${[...allowed].join(' / ')}）`,
      })
    } else if (parts.length > 3) {
      violations.push({
        rule: 'layer-placement',
        file: relPath,
        detail: `层级目录内不允许建子目录（run-layer 用非递归 readdir，${parts.slice(2, -1).join('/')} 里的用例跑不到）`,
      })
    }
    // ---- 规则 1：孤儿 ----
    if (!enumerated.has(relPath)) {
      const reason = layers.includes(layer)
        ? `所在层 ${layer} 已在 LAYERS 里但 runner 没枚举到它`
        : `所在层 ${layer} 不在 run-layer.mjs 的 LAYERS（${layers.join(' / ')}）里，没有任何入口会跑它`
      violations.push({ rule: 'orphan', file: relPath, detail: reason })
    }
    // ---- 规则 3：命名 ----
    const basename = path.basename(relPath)
    if (/^domain/i.test(basename) && !DOMAIN_NAME_RE.test(basename)) {
      violations.push({
        rule: 'naming',
        file: relPath,
        detail: '域名文件必须是 domain-NN-<描述>.test.mjs（两位数域号 + 小写短横线）',
      })
    } else if (!/^domain\d{2}-/i.test(basename)) {
      const domains = await declaredDomains(file)
      if (domains.length && !domains.some((n) => basename.startsWith(`domain${String(n).padStart(2, '0')}-`))) {
        violations.push({
          rule: 'naming-declared-domain',
          file: relPath,
          detail: `头部声明了 #362 域 ${domains.join('/')}，文件名应按 domain${String(domains[0]).padStart(2, '0')}-* 命名`,
        })
      }
    }
  }

  // ---- 规则 4：fixtures 根目录散放（warning）----
  const fixtureLoose = []
  try {
    for (const entry of await readdir(FIXTURES_DIR, { withFileTypes: true })) {
      if (entry.isFile()) fixtureLoose.push(`tests/fixtures/${entry.name}`)
    }
  } catch {
    // fixtures 目录不存在不算违规
  }
  for (const file of fixtureLoose.sort()) {
    violations.push({
      rule: 'fixtures-root',
      file,
      detail: 'fixture 应放在 tests/fixtures/<域>/ 下，根目录直接放属散放（--strict 才阻塞）',
    })
  }

  return { violations, layers, layerCounts, allowed: [...allowed], layerErrors }
}

async function readBaseline() {
  try {
    const data = JSON.parse(await readFile(BASELINE_FILE, 'utf8'))
    if (!Array.isArray(data.entries)) throw new Error('缺少 entries 数组')
    return data
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [] }
    throw new Error(`基线文件 ${rel(BASELINE_FILE)} 解析失败：${error.message}`)
  }
}

const keyOf = (v) => `${v.rule}\u0000${v.file}`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const testFiles = await walkTests(TESTS_DIR)
  const { violations, layers, layerCounts, allowed, layerErrors } = await collectViolations(testFiles)
  const baseline = await readBaseline()

  const hard = violations.filter((v) => HARD_RULES.has(v.rule))
  const soft = violations.filter((v) => !HARD_RULES.has(v.rule))
  const baselineKeys = new Set(baseline.entries.map(keyOf))
  const known = hard.filter((v) => baselineKeys.has(keyOf(v)))
  const fresh = hard.filter((v) => !baselineKeys.has(keyOf(v)))
  const liveKeys = new Set(hard.map(keyOf))
  const stale = baseline.entries.filter((e) => !liveKeys.has(`${e.rule}\u0000${e.file}`))

  // ---- 报告 ----
  console.log('check:test-layout —— 测试布局门禁（#362 阶段二 / #366）\n')
  console.log(`runner 枚举：tests/run-layer.mjs LAYERS = [${layers.join(', ')}]`)
  const perLayer = layers.map((l) => `${l} ${layerCounts[l] ?? '?'}`).join(' / ')
  console.log(`  ${perLayer}（合计 ${[...new Set(Object.values(layerCounts))].reduce((a, b) => a + b, 0)} 个文件）`)
  console.log(`允许的层级目录：${allowed.map((l) => `tests/${l}`).join(' / ')}`)
  console.log(`文件系统：tests/**/*.test.mjs 共 ${testFiles.length} 个\n`)

  const byRule = (rule) => hard.filter((v) => v.rule === rule)
  if (fresh.length) {
    console.log(`❌ 基线外新违规 ${fresh.length} 条：`)
    for (const v of fresh) console.log(`  [${v.rule}] ${v.file}\n      ↳ ${v.detail}`)
    console.log('')
  }
  if (known.length) {
    const counts = {}
    for (const v of known) counts[v.rule] = (counts[v.rule] ?? 0) + 1
    console.log(
      `⚠ 已基线豁免 ${known.length} 条（${Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(' / ')}）`
        + ` —— 规则：只减不增，见 ${rel(BASELINE_FILE)}`,
    )
    const orphan = byRule('orphan').filter((v) => known.includes(v))
    if (orphan.length) {
      const layersOf = [...new Set(orphan.map((v) => v.file.split('/')[1]))].join('/')
      console.log(`  孤儿豁免集中在 tests/${layersOf}（${orphan.length} 个）：该层尚未进入 LAYERS，转正后再删条目`)
    }
    console.log('')
  }
  if (stale.length) {
    console.log(`⚠ 基线里有 ${stale.length} 条已失效（现在不违规了，请删掉，别让基线腐烂）：`)
    for (const e of stale) console.log(`  [${e.rule}] ${e.file}`)
    console.log('')
  }
  if (soft.length) {
    console.log(`⚠ fixture 散放 ${soft.length} 个（${opts.strict ? '--strict 下阻塞' : '本轮只报告，不加 --strict 不阻塞'}）：`)
    for (const v of soft) console.log(`  ${v.file}`)
    console.log('')
  }
  if (layerErrors.length) {
    console.log(`❌ runner 层枚举失败 ${layerErrors.length} 个：`)
    for (const e of layerErrors) console.log(`  tests/${e.layer}：${e.error}`)
    console.log('')
  }

  const stats = {
    testFiles: testFiles.length,
    layers,
    layerCounts,
    orphans: violations.filter((v) => v.rule === 'orphan').length,
    orphanFresh: fresh.filter((v) => v.rule === 'orphan').length,
    naming: violations.filter((v) => v.rule === 'naming' || v.rule === 'naming-declared-domain').length,
    namingFresh: fresh.filter((v) => v.rule === 'naming' || v.rule === 'naming-declared-domain').length,
    placement: violations.filter((v) => v.rule === 'layer-placement').length,
    fixturesRoot: soft.length,
    baselined: known.length,
    stale: stale.length,
    fresh: fresh.length,
  }

  // ---- 基线更新 ----
  if (opts.updateBaseline) {
    const existing = new Set(baseline.entries.map(keyOf))
    const added = hard.filter((v) => !existing.has(keyOf(v)))
    if (added.length && baseline.entries.length && !opts.force) {
      console.error(`拒绝写基线：会新增 ${added.length} 条（规则只减不增）。逐条给出理由后加 --force：`)
      for (const v of added) console.error(`  [${v.rule}] ${v.file}`)
      process.exitCode = 1
      return
    }
    const entries = hard.map((v) => {
      const previous = baseline.entries.find((e) => keyOf(e) === keyOf(v))
      // 保留人写的额外字段（owner 等），只补规则/文件/理由
      return {
        ...previous,
        rule: v.rule,
        file: v.file,
        reason: previous?.reason ?? '（待补：写清豁免理由与转正条件）',
      }
    })
    const payload = {
      version: 1,
      note: '测试布局门禁的存量豁免清单（scripts/check-test-layout.mjs）。规则**只减不增**：新违规不许进基线，修好后请删条目。',
      updatedAt: new Date().toISOString().slice(0, 10),
      entries,
    }
    await writeFile(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`基线已更新：${rel(BASELINE_FILE)}（${entries.length} 条）`)
  }

  if (opts.json) {
    await writeFile(path.resolve(opts.json), `${JSON.stringify({ ...stats, violations, fresh, stale }, null, 2)}\n`)
    console.log(`JSON 报告：${opts.json}`)
  }

  console.log(
    `\n合计：孤儿 ${stats.orphans}（新 ${stats.orphanFresh}）/ 命名违规 ${stats.naming}（新 ${stats.namingFresh}）`
      + ` / 落位违规 ${stats.placement} / fixture 散放 ${stats.fixturesRoot} / 基线豁免 ${stats.baselined}`
      + ` / 失真条目 ${stats.stale}`,
  )

  const blocking = fresh.length > 0 || (opts.strict && (soft.length > 0 || stale.length > 0))
  if (!blocking) {
    console.log('check:test-layout OK —— 没有基线外的布局违规 ✅')
    return
  }
  if (opts.warn) {
    console.log('check:test-layout WARN —— 发现违规，但 --warn 模式不阻塞（CI 前三轮观测用）')
    return
  }
  console.error(
    '\n修法：新用例放进 tests/{unit,integration,regression,device}/ 且必须能被 run-layer 枚举；'
      + '域名文件用 domain-NN-<描述>.test.mjs；fixture 放 tests/fixtures/<域>/。'
      + '规则与豁免见 scripts/check-test-layout.mjs 文件头（#362/#366）。',
  )
  process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(`check:test-layout 环境错误：${error.message}`)
  process.exitCode = 2
}
