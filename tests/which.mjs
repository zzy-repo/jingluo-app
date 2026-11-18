#!/usr/bin/env node
// 测试选择器：给定改动文件，输出「该跑哪些测试」。
//
//   node tests/which.mjs src/services/diagnostics/export.ts
//   git diff --name-only origin/main...HEAD | node tests/which.mjs --stdin
//   node tests/which.mjs --git                 # 用 git diff --name-only HEAD 的改动
//   node tests/which.mjs --self-test           # 自证：内置 5 个例子，断言输出符合预期
//   node tests/which.mjs --layer unit ...      # 只输出某一层（unit / integration / both，默认 both）
//
// 设计目标（见 docs/TESTING-POLICY.md 的 L0/L1 分级门禁）：
//   1. 纯逻辑改动 → 只跑对应的单测文件，秒级，不碰浏览器。
//   2. 浏览器/网络相关的改动 → 输出该域 1~2 个集成用例，而不是整个 integration 层。
//   3. 映射不出来时**回落同层全量**，并把回落原因打印出来（不静默跳过任何东西）。
//
// 映射来源有两个，优先级从高到低：
//   A. RULES：人工维护的目录/模块规则（覆盖「用例不 import 源码」的浏览器用例）。
//   B. 自动反查：扫描 tests/unit 里 `from '../../src/...'` 的 import，建立 源码 → 单测 的反向索引。
//      单测都直接 import 源码 .ts，所以这条能覆盖绝大多数逻辑改动，且新增用例自动生效。
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')

const LAYER_DIR = { unit: 'tests/unit', integration: 'tests/integration' }

/**
 * 人工规则：src 侧路径前缀 → 应跑的用例（相对仓库根）。
 * 只写「浏览器用例不 import 源码、自动反查查不到」的那部分；其余交给自动反查。
 */
const RULES = [
  // 渠道 spec / 协议适配：设置页四渠道 + 请求体 + 能力入口
  {
    match: /^src\/services\/api\/(providers|internalBuild)\.ts$/,
    tests: [
      'tests/integration/provider-channels',
      'tests/integration/internal-build',
      'tests/integration/paths',
      'tests/integration/caps',
    ],
  },
  { match: /^src\/services\/api\/openaiAdapter\.ts$/, tests: ['tests/unit/openai-adapter', 'tests/integration/provider-channels'] },
  { match: /^src\/services\/api\//, tests: ['tests/integration/paths', 'tests/integration/provider-anthropic', 'tests/integration/request-body'] },
  // 设置页 / 反馈 / 导入：都是「只有浏览器能验证」的交互
  { match: /^src\/components\/settings\//, tests: ['tests/integration/provider-channels', 'tests/integration/internal-build', 'tests/integration/feedback-export'] },
  { match: /^src\/services\/chat\/history\//, tests: ['tests/unit/archive-import', 'tests/integration/url-import-web', 'tests/integration/url-import-native'] },
  { match: /^src\/services\/chat\/(backup|store)\.ts$/, tests: ['tests/integration/url-import-web', 'tests/integration/mode-switch'] },
  { match: /^src\/services\/diagnostics\//, tests: ['tests/unit/feedback-export', 'tests/unit/diagnostics-system-info', 'tests/integration/diagnostics-contract', 'tests/integration/feedback-export'] },
  { match: /^src\/components\/sider\/|^src\/components\/session\//, tests: ['tests/integration/motion', 'tests/integration/mode-switch', 'tests/integration/mode-switch-plain'] },
  { match: /^src\/components\/base\//, tests: ['tests/integration/motion'] },
  // 剪贴板 / 超长文本保存（#2）：单测 + 浏览器回归
  { match: /^src\/utils\/clipboard\.ts$|^src\/components\/messages\/CopyButton/, tests: ['tests/unit/copy-limit', 'tests/integration/copy-limit'] },
  // 我们的渠道额度/卡密（#7）
  { match: /^src\/services\/ours\//, tests: ['tests/unit/ours-api', 'tests/integration/ours-services'] },
  // 链接导入分阶段进度（#25）
  { match: /^src\/services\/chat\/history\/urlImport\.ts$/, tests: ['tests/unit/url-import-stall', 'tests/integration/url-import-stages', 'tests/integration/url-import-native'] },
  // 构建脚本 / 注入常量本身：产物形状变了，跑构建类用例
  { match: /^(rspack\.config\.ts|src\/index\.html)$/, tests: ['tests/integration/internal-build', 'tests/integration/auto-title'] },
  // Android 原生侧：node 层只能跑单测，其余归 device 层（本门禁不跑）
  { match: /^android\//, tests: ['tests/unit'], note: '原生改动：node 层只跑 unit，真机用例属 device 层（门禁不跑）' },
]

/** 目录层面的兜底规则（命中即回落，但说清原因） */
const LAYER_FALLBACK = [
  { match: /^src\//, layers: ['unit', 'integration'], why: 'src/ 下未命中任何映射规则 → 回落 unit + integration 全量' },
  { match: /^(scripts|deploy|build-apk\.sh|release-apk\.sh|preflight\.sh)/, layers: ['unit'], why: '构建/发布脚本改动 → 回落 unit 全量（集成层与产物无关）' },
]

const isTestFile = (file) => /^tests\/(unit|integration)\/[^/]+\.test\.mjs$/.test(file)

/** 规范化路径：去掉 ./、反斜杠、绝对路径前缀 */
const norm = (file) => {
  const posix = file.replace(/\\/g, '/').replace(/^\.\//, '')
  const index = posix.indexOf('tests/')
  if (posix.startsWith(ROOT.replace(/\\/g, '/') + '/')) {
    return posix.slice(ROOT.length + 1)
  }
  if (posix.startsWith('src/') || posix.startsWith('tests/') || posix.startsWith('android/')) {
    return posix
  }
  return index >= 0 ? posix.slice(index) : posix
}

/** 把规则里的短名（tests/unit/foo）或整层名（tests/unit）展开成真实存在的文件 */
const expand = (entry, pool) => {
  if (entry.endsWith('.test.mjs')) {
    return pool.has(entry) ? [entry] : []
  }
  const byName = [...pool].filter((file) => file.replace(/\.test\.mjs$/, '') === entry)
  if (byName.length > 0) {
    return byName
  }
  // 「整层」写法：tests/unit / tests/integration
  return [...pool].filter((file) => file.startsWith(`${entry}/`))
}

/** 自动反查：tests/unit 的 import 语句建 源码 → 单测 索引 */
const buildImportIndex = async () => {
  const index = new Map()
  const dir = path.join(ROOT, LAYER_DIR.unit)
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.test.mjs'))
  } catch {
    return index
  }
  for (const name of names) {
    const source = await readFile(path.join(dir, name), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.\.\/\.\.\/src\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(LAYER_DIR.unit, match[1]))
      const candidates = [target, `${target}.ts`, `${target}.tsx`]
      for (const candidate of candidates) {
        const key = candidate.replace(/\.tsx?$/, '').replace(/\.js$/, '')
        if (!index.has(key)) {
          index.set(key, new Set())
        }
        index.get(key).add(`${LAYER_DIR.unit}/${name}`)
      }
    }
  }
  return index
}

const allTests = async () => {
  const pool = new Set()
  for (const dir of Object.values(LAYER_DIR)) {
    let names = []
    try {
      names = (await readdir(path.join(ROOT, dir))).filter((name) => name.endsWith('.test.mjs'))
    } catch {
      continue
    }
    for (const name of names) {
      pool.add(`${dir}/${name}`)
    }
  }
  return pool
}

/**
 * 主逻辑：改动文件 → { tests: [], notes: [] }
 * @param {string[]} changed
 */
export const selectTests = async (changed) => {
  const pool = await allTests()
  const importIndex = await buildImportIndex()
  const picked = new Set()
  const notes = []

  for (const raw of changed) {
    const file = norm(raw)
    if (!file) {
      continue
    }
    if (isTestFile(file)) {
      if (pool.has(file)) {
        picked.add(file)
        notes.push(`${file}：改动的是用例本身 → 跑它自己`)
      }
      continue
    }
    if (/^docs\//.test(file) || /^CHANGELOG\.md$/.test(file) || /\.md$/.test(file)) {
      notes.push(`${file}：文档改动 → 不需要跑测试（L0 只跑 tsc + lint）`)
      continue
    }
    let matched = false
    for (const rule of RULES) {
      if (!rule.match.test(file)) {
        continue
      }
      const files = rule.tests.flatMap((entry) => expand(entry, pool))
      for (const hit of files) {
        picked.add(hit)
      }
      notes.push(`${file}：命中规则 ${rule.match} → ${files.length} 个用例${rule.note ? `（${rule.note}）` : ''}`)
      matched = true
      break
    }
    if (matched) {
      continue
    }
    // 自动反查（覆盖 test 直接 import 源码的单测）
    const key = file.replace(/\.(ts|tsx|js|mjs)$/, '')
    const hits = importIndex.get(key)
    if (hits?.size) {
      for (const hit of hits) {
        picked.add(hit)
      }
      notes.push(`${file}：自动反查 import → ${[...hits].length} 个单测`)
      continue
    }
    // 同目录兄弟文件的 import：改 a.ts 时，import 了同目录 b.ts 的单测也要跑
    const dirPrefix = key.slice(0, key.lastIndexOf('/') + 1)
    const siblings = [...importIndex.entries()].filter(([src]) => src.startsWith(dirPrefix))
    if (siblings.length > 0) {
      for (const [, files] of siblings) {
        for (const hit of files) {
          picked.add(hit)
        }
      }
      notes.push(`${file}：目录 ${dirPrefix} 有 ${siblings.length} 个被单测 import 的模块 → 一并跑`)
      continue
    }
    const fallback = LAYER_FALLBACK.find((rule) => rule.match.test(file))
    if (fallback) {
      const files = [...pool].filter((hit) => fallback.layers.some((layer) => hit.startsWith(`${LAYER_DIR[layer]}/`)))
      for (const hit of files) {
        picked.add(hit)
      }
      notes.push(`${file}：${fallback.why}（回落 ${files.length} 个用例）`)
      continue
    }
    notes.push(`${file}：不在已知范围（既不是 src/ 也不是 tests/）→ 忽略`)
  }

  const tests = [...picked].sort()
  return { tests, notes }
}

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const layerIndex = argv.indexOf('--layer')
const layer = layerIndex >= 0 ? argv[layerIndex + 1] : 'both'
const layerValueIndex = layerIndex >= 0 ? layerIndex + 1 : -1
const files = argv.filter((arg, index) => !arg.startsWith('--') && index !== layerValueIndex)

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const changedFromGit = () => {
  const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

const filterLayer = (tests, want) =>
  tests.filter((file) => want === 'both' || file.startsWith(`${LAYER_DIR[want]}/`))

const print = ({ tests, notes }) => {
  for (const note of notes) {
    console.log(`! ${note}`)
  }
  const filtered = filterLayer(tests, layer)
  if (filtered.length === 0) {
    console.log('（没有需要跑的测试）')
    return 0
  }
  console.log(`\n将执行 ${filtered.length} 个用例：`)
  for (const file of filtered) {
    console.log(`  ${file}`)
  }
  // 给 CI 直接用：打印一条可直接粘贴的命令
  const unitFiles = filtered.filter((file) => file.startsWith(`${LAYER_DIR.unit}/`))
  const integrationFiles = filtered.filter((file) => file.startsWith(`${LAYER_DIR.integration}/`))
  console.log('\n建议命令（串行执行，集成层一次只跑一个文件）：')
  if (unitFiles.length > 0) {
    console.log(`  node --test ${unitFiles.join(' ')}`)
  }
  for (const file of integrationFiles) {
    console.log(`  node ${file}`)
  }
  return 0
}

const SELF_TEST_CASES = [
  {
    // L0 用法：--layer unit 只看逻辑门禁的集合
    name: '纯逻辑改动 + --layer unit → 只跑该域单测，不碰集成层',
    changed: ['src/services/diagnostics/export.ts'],
    layer: 'unit',
    expect: ['tests/unit/feedback-export'],
    forbid: ['tests/integration/'],
  },
  {
    // L1 用法：默认 both，同一个改动给出「单测 + 该域集成用例」，但不是整层
    name: '同一改动在 L1（both）下 → 加上该域集成用例，仍不跑无关用例',
    changed: ['src/services/diagnostics/export.ts'],
    expect: ['tests/unit/feedback-export', 'tests/integration/feedback-export'],
    forbid: ['tests/integration/motion', 'tests/integration/mode-switch', 'tests/integration/provider-channels'],
  },
  {
    name: '渠道 spec → 4 个集成用例，且不跑全量集成',
    changed: ['src/services/api/providers.ts'],
    expect: ['tests/integration/provider-channels', 'tests/integration/internal-build'],
    forbid: ['tests/integration/motion'],
  },
  {
    name: '改用例本身 → 只跑它自己',
    changed: ['tests/integration/paths.test.mjs'],
    expect: ['tests/integration/paths.test.mjs'],
    forbid: ['tests/unit/'],
  },
  {
    name: '文档改动 → 不跑任何测试',
    changed: ['docs/ISSUE-STANDARD.md'],
    expect: [],
    forbid: ['tests/'],
  },
  {
    name: '无法映射的新文件 → 回落 unit + integration 全量并说明原因',
    changed: ['src/data/unknown-module.ts'],
    expect: ['tests/unit/', 'tests/integration/'],
    forbid: [],
  },
]

const selfTest = async () => {
  let failed = 0
  for (const item of SELF_TEST_CASES) {
    const result = await selectTests(item.changed)
    const scoped = filterLayer(result.tests, item.layer || 'both')
    const problems = []
    for (const want of item.expect) {
      if (!scoped.some((file) => file.startsWith(want))) {
        problems.push(`缺少 ${want}`)
      }
    }
    for (const never of item.forbid) {
      if (scoped.some((file) => file.startsWith(never))) {
        problems.push(`不该包含 ${never}`)
      }
    }
    const status = problems.length === 0 ? 'ok' : 'FAIL'
    if (problems.length > 0) {
      failed += 1
    }
    console.log(`${status}  ${item.name}（${item.changed.join(', ')} → ${scoped.length} 个用例）`)
    for (const problem of problems) {
      console.log(`        ✗ ${problem}（实际：${scoped.join(', ') || '空'}）`)
    }
  }
  console.log(failed === 0 ? '\n自证全部通过 ✅' : `\n自证失败 ${failed} 条 ❌`)
  return failed === 0 ? 0 : 1
}

const main = async () => {
  if (flags.has('--self-test')) {
    return selfTest()
  }
  let input = files.map((file) => file.trim()).filter(Boolean)
  if (flags.has('--git')) {
    input = changedFromGit()
  } else if (flags.has('--stdin') || (input.length === 0 && !process.stdin.isTTY)) {
    const text = await readStdin()
    input = input.concat(text.split('\n').map((line) => line.trim())).filter(Boolean)
  }
  if (input.length === 0) {
    console.error('用法：node tests/which.mjs <改动文件...> [--stdin|--git] [--layer unit|integration|both]')
    console.error('      node tests/which.mjs --self-test')
    return 2
  }
  return print(await selectTests(input))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
