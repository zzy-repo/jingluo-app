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
 *      发现不合规**只报告、不改文件名**（改名要同步改 docs/测试引用）。#408 已把域 3/4 的 6 个批次
 *      文件改成 `domain03-*` / `domain04-*`，这条现在真的为 0 —— 谁再加一个不带域前缀的批次文件就红。
 *   4. fixture 散放（warning；`--strict` 下阻塞，CI 就是 `--strict`）—— `tests/fixtures/<域>/` 是唯一
 *      合法位置，根目录直接放 `.mjs`/`.json` 属散放。#408 已把最后 5 个散放桩归位
 *      （archive-fixture / ours-upstream / mock-anthropic / ours-trail / input-row-baseline），
 *      根目录现在只剩目录；以后往根目录扔夹具，`--strict` 直接红。
 *
 * #415 白名单（`EXTRA_TEST_DIRS`，**带理由、且不免检**）：
 *   `deploy/dl-release/test/` 是唯一一个不在 `tests/` 下的用例目录（34 条：变体解析 / APK
 *   debuggable / 服务端 buildType / 上传契约矩阵）。它此前属于「写了没人跑」——`run-layer` 的
 *   LAYERS 不含它、CI 无步骤。两条路（搬家 vs 留原地开白名单），#415 选后者，理由写在
 *   `EXTRA_TEST_DIRS` 的 `reason` 里。关键是**白名单不等于免检**：该目录现在也被扫进来，
 *   里面的 `*.test.mjs` 必须被 `run-layer` 的 `server` 层枚举到，否则照样判 `orphan` 红；
 *   LAYERS 里把 `server` 删掉则会命中硬规则 `layer-unwired`（不是 warning）。CI 步骤见 `.github/workflows/ci.yml`。
 *
 * 基线（`tests/test-layout-baseline.json`，规则**只减不增**）：
 *   #408 之后基线已清空（孤儿 0 / 命名 0 / 落位 0，regression 层已由 #391 进 LAYERS），
 *   所以现在的口径是「违规一律红」；机制保留，是为了下次真有大面积存量时还能登记而不是关掉门禁。
 *   运行时：**基线条目之外的新违规一律 exit 1**；条目失效（已经不违规了）会提示删除，
 *   `--strict` 下也算红。`--update-baseline` 只允许写"当前违规 ⊆ 现有基线"，要新增条目必须显式 `--force`
 *   —— 这就是"只减不增"的机械实现，避免下次谁跑一遍就把新违规生成进基线。
 *
 * 用法：
 *   node scripts/check-test-layout.mjs                 # 门禁模式：基线之外的新违规 exit 1
 *   node scripts/check-test-layout.mjs --warn           # 只报告，永远 exit 0（应急用；CI 不用它）
 *   node scripts/check-test-layout.mjs --strict         # + fixture 散放 / 基线失真也阻塞（**CI 用这个**）
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

/**
 * 允许的层级目录。`e2e` 只在其目录真实存在时才算合法（历史上有过、也可能被并走）。
 * `golden`（Issue #404 的黄金回归套件）由自己的并行 runner 跑，见下面的 EXTRA_RUNNERS。
 */
const ALLOWED_LAYERS = ['unit', 'integration', 'regression', 'device', 'golden']
const OPTIONAL_LAYERS = ['e2e']

/**
 * #415：**唯一**一个不在 `tests/` 下的用例目录（白名单条目，必须带 `reason`）。
 *
 * 为什么不是「搬进 tests/」：这 34 条用例与被测实现同目录 —— `import ... from '../apk-manifest.mjs'`、
 * `path.resolve(HERE, '..', 'server.mjs')` 起真服务、读同目录 `xmltree-fixtures/` 的真 aapt2 输出。
 * 搬家要同时改断这些相对引用、`deploy/README.md` 与 `docs/testing/coverage/domain-10.md` 的路径，
 * 而收益只是目录好看；代价是又制造一批「改了就跑不动」的路径。
 *
 * 但白名单**不是免检**：本目录被 `walkTests` 一起扫（孤儿 / 落位 / 命名三条硬规则照判），
 * 且必须由一个真的 `LAYERS` 层枚举到（`layer` 字段）。所以「新增一个用例却没入口」照样红：
 *   · 目录里多一个 `*.test.mjs` 但 `run-layer` 枚举不到 → `orphan`；
 *   · 把 `server` 从 `run-layer.mjs` 的 LAYERS 里删掉 → `layer-unwired`（硬红）。
 * 加第二个目录请先读 `docs/TESTING-POLICY.md` 第 12 节：默认答案是搬到 `tests/<层>/`。
 */
const EXTRA_TEST_DIRS = [
  {
    dir: 'deploy/dl-release/test',
    layer: 'server',
    reason:
      '用例与被测实现 deploy/dl-release/*.mjs 同目录（相对 import / 同目录 xmltree-fixtures / 起真 server 进程），搬迁只会改断一批相对路径；'
      + '入口由 run-layer 的 server 层提供（LAYERS += server，LAYER_DIRS 指向本目录），CI 步骤 pnpm run test:dl-release（#415）',
  },
]

/** 域批次文件名的唯一合法形状：domain05-export-contract.test.mjs */
const DOMAIN_NAME_RE = /^domain\d{2}-[a-z0-9][a-z0-9-]*\.test\.mjs$/
/** 头部声明域批次（#362）的识别：前 15 行里同时出现 #362 与「域 3 / 域3」 */
const HEADER_LINES = 15
const HEADER_DOMAIN_RE = /域\s*([0-9]{1,2})/g

/** 硬规则（可基线化）：孤儿 / 落位 / 命名。fixture 散放单独算 warning。 */
// `layer-unwired`（#415）：白名单目录名下的 LAYERS 层被删掉 —— 和孤儿同级的硬红：
// 「用例在这、层没了」和「层在这、用例没人枚举」是同一种失效（写了没人跑），不许降级成 warning。
const HARD_RULES = new Set(['orphan', 'layer-placement', 'naming', 'naming-declared-domain', 'layer-unwired'])

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

/** 真跑 `<runner> <args> --list`（不执行用例），拿到该入口枚举到的文件清单。 */
function listFromScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
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

/** 真跑 `run-layer.mjs <layer> --list`：LAYERS 里每一层的枚举口径 */
const listLayer = (layer) => listFromScript(RUN_LAYER, [layer, '--list'])

/**
 * 第二个合法入口：黄金回归套件（Issue #404）。
 *
 * 它不能挂在 run-layer 上 —— run-layer 是**串行**适配器（历史用例在同进程里 `process.exit`），
 * 而黄金套件要「4~8 条并行、整层 ≤5 分钟」，于是有自己的 runner（`tests/run-golden.mjs`）。
 * 有第二个 runner 就多一个「写了没人跑」的口子，所以孤儿判定必须同样实跑它的 `--list`。
 */
const EXTRA_RUNNERS = [{ layer: 'golden', script: path.join(TESTS_DIR, 'run-golden.mjs') }]

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
  // 独立 runner 同样要「能被枚举到」：枚举不到就是孤儿，不能因为换了入口就免检。
  for (const runner of EXTRA_RUNNERS) {
    const listed = listFromScript(runner.script, ['--list'])
    if (!listed.ok) {
      violations.push({
        rule: 'runner-layer-broken',
        file: `tests/${runner.layer}`,
        detail: `${path.basename(runner.script)} --list 失败：${listed.error}`,
      })
      continue
    }
    layerCounts[runner.layer] = listed.files.length
    for (const file of listed.files) enumerated.add(file)
  }

  // #415：白名单目录必须真的被某个 LAYERS 层枚举到。少了这一条，白名单就成了「免检区」：
  // 目录扫进来、文件被判 orphan（因为没人枚举），但没人会注意到「层被删了」。
  for (const extra of EXTRA_TEST_DIRS) {
    if (!layers.includes(extra.layer)) {
      violations.push({
        rule: 'layer-unwired',
        file: extra.dir,
        detail:
          `白名单目录 ${extra.dir} 名下的层 ${extra.layer} 不在 run-layer.mjs 的 LAYERS（${layers.join(' / ')}）里`
          + ` —— 该目录的用例又变成「写了没人跑」。修法：把 ${extra.layer} 加回 LAYERS（并有 LAYER_DIRS 指向该目录）`,
      })
    }
  }

  for (const file of testFiles) {
    const relPath = rel(file)
    const parts = relPath.split('/')
    // #415：白名单目录按自己的前缀判定落位；其余文件仍按 tests/<层>/ 判定。
    const extra = EXTRA_TEST_DIRS.find((entry) => relPath.startsWith(`${entry.dir}/`))
    const layer = extra ? extra.layer : parts[1]
    // 层级目录下的最大段数：tests/<层>/a.test.mjs = 3；deploy/dl-release/test/a.test.mjs = 4
    const maxParts = extra ? extra.dir.split('/').length + 1 : 3
    // ---- 规则 2：落位 ----
    if (!extra && !allowed.has(layer)) {
      violations.push({
        rule: 'layer-placement',
        file: relPath,
        detail: `目录 ${parts.slice(0, -1).join('/')} 不是合法层级（只允许 ${[...allowed].join(' / ')}`
          + `${EXTRA_TEST_DIRS.length ? ` / 白名单 ${EXTRA_TEST_DIRS.map((entry) => entry.dir).join(' / ')}` : ''}）`,
      })
    } else if (parts.length > maxParts) {
      violations.push({
        rule: 'layer-placement',
        file: relPath,
        detail: `层级目录内不允许建子目录（run-layer 用非递归 readdir，${parts.slice(maxParts - 1, -1).join('/')} 里的用例跑不到）`,
      })
    }
    // ---- 规则 1：孤儿 ----
    if (!enumerated.has(relPath)) {
      const known = layers.includes(layer) || EXTRA_RUNNERS.some((runner) => runner.layer === layer)
      const reason = known
        ? `所在层 ${layer} 有入口但 runner 没枚举到它`
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
  // #415：白名单目录一起扫 —— 不扫就等于免检。扫进来的文件同样走孤儿 / 落位 / 命名三条硬规则。
  for (const extra of EXTRA_TEST_DIRS) await walkTests(path.join(ROOT, extra.dir), testFiles)
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
  const perLayer = [...layers, ...EXTRA_RUNNERS.map((runner) => runner.layer)]
    .map((l) => `${l} ${layerCounts[l] ?? '?'}`)
    .join(' / ')
  console.log(`  ${perLayer}（合计 ${[...new Set(Object.values(layerCounts))].reduce((a, b) => a + b, 0)} 个文件）`)
  console.log(`允许的层级目录：${allowed.map((l) => `tests/${l}`).join(' / ')}`)
  // #415：白名单目录要显式打印（谁在 `tests/` 之外还有用例，一眼能看到，不用翻源码）
  for (const extra of EXTRA_TEST_DIRS) {
    console.log(`白名单用例目录：${extra.dir}（入口 = run-layer 的 ${extra.layer} 层；理由见 EXTRA_TEST_DIRS）`)
  }
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
