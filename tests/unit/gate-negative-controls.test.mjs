// [layer: unit | 纯 Node（子进程 + 临时副本），无浏览器无网络 | 耗时: ~25s]
//
// Issue #369 剩余部分 —— **给还没有负向对照的 CI 门禁补上**，让「门禁挂了也会绿」消失。
//
// #369 的立项理由写在它自己身上：#362 盘点 12 道 CI 门禁，6 道没有任何负向对照，
// 而 `check:legacy` 的历史教训（beta.8 漏 polyfill → WebView ≤92 整包白屏、门禁全绿）说明
// 「门禁绿」不等于「门禁在工作」。这个文件补齐剩下 5 道：
//
//   N1 `type`（tsc -p tsconfig.json）       —— fixture 里放必错 .ts → 拷进 src/ → tsc 必红
//   N2 `lint`（oxlint src rspack.config.ts）—— fixture 里放已知 lint 违规 → 拷进 src/ → oxlint 必红
//   N3 `build`（node scripts/build.mjs）     —— 往**仓库临时副本**注入语法错模块并让 entry 真的 import
//   N4 `check:test-layout`                   —— 造一个跑不到的用例（层级目录里的子目录）→ 必红
//   N5 `check:test-duplication`              —— 复制整份用例文件 → 必报「逐字重复」
//
// 统一模板（#369 第 4 条要求，四拍，全文件只用这一套；实现在 tests/gates/lib/gate-negative-harness.mjs）：
//
//     ① 正例（干净仓库 exit=0） → ② 注入缺陷 → ③ exit≠0 且报错点出注入物 → ④ 还原 → ⑤ 再 exit=0
//
// 第 ① 拍和第 ⑤ 拍缺一不可：没有 ①，「注入→红」可能只是门禁恒红；没有 ⑤，「红」可能是
// 注入物没删干净（留下一条与后来人无关的假红，比不测更糟）。
//
// 为什么用例在 `tests/unit/` 而 fixture 在 `tests/gates/`（#369 的目录约定，别搬回去）：
//   · `scripts/check-test-layout.mjs` 只允许 `tests/{unit,integration,regression,device,e2e}/`
//     放 `*.test.mjs`、且层级目录内不许建子目录 —— `tests/gates/*.test.mjs` 会被它判成
//     `layer-placement` + `orphan`（硬规则、不可基线化）。给门禁开一个它自己拦不住的新目录，
//     等于以后人人都能照着开。
//   · 更重要的是「谁跑它」：CI 单元层只跑 `pnpm test`（`node tests/run-layer.mjs unit`）。
//     不在 LAYERS 里的目录写多少用例都是 #368 那个坑 —— 写了、没人跑、不会红。
//     这条 issue 治的就是这个病，不能边治边犯。
//   单独跑：`node --test tests/unit/gate-negative-controls.test.mjs`
//           `node tests/run-layer.mjs unit --only gate-negative-controls`
//
// 本文件**不做**的事（写给后来者，别当成已验）：
//   · 不验「CI 里这些门禁步骤还在」—— 那是 `tests/unit/domain10-gate-wiring.test.mjs`（N6）。
//     这里的最后一条用例只验「每道 CI 门禁都登记了负向对照在哪」，不验 YAML 结构。
//   · 不改 `.github/workflows/ci.yml`：负向对照先作为 L0 用例常驻单元层（CI 的 `pnpm test`
//     每次都会跑到），不是往流水线里再塞 5 个 step。
//   · 不验 `check:log-coverage` 的 `--selftest`：脚本自带反例，但 CI 调用没带这个 flag
//     （补 flag 要改 ci.yml，不在本单范围）—— 这一条登记在 N6 的「缺口」里，别当成已覆盖。

import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import {
  FIXTURES,
  ROOT,
  assertNegativeControl,
  commandOf,
  copyFixture,
  run,
  scratch,
} from '../gates/lib/gate-negative-harness.mjs'

const PROBE_TYPE = 'src/__gate-neg-type-probe.ts'
const PROBE_LINT = 'src/__gate-neg-lint-probe.ts'
const PROBE_LAYOUT_DIR = 'tests/unit/__gate-neg-layout-probe'
const PROBE_DUP_COPY = 'tests/unit/__gate-neg-dup-copy.test.mjs'
/** 「复制整份用例」的源文件：110 行、无 #362 域声明、改它的人会顺手看到这里 */
const DUP_SOURCE = 'tests/unit/check-ip-version.test.mjs'
/** `check:test-duplication` 的默认窗口是 20 行；存量有 33 组 ≥20 行的重复（见 ci.yml 注释），
 *  所以「窗口 80」是这个仓库里唯一能把「注入引起的那一组」和存量分开的口径：
 *  实测窗口 80 下存量 0 组、注入后正好 1 组。 */
const DUP_WINDOW = 80

/** 一行 = 一道门禁 = 一组正反例。加门禁 = 加一行（+ 在 REGISTRY 登记）。 */
const ROWS = [
  {
    id: 'N1',
    gate: 'type',
    script: 'type',
    scriptExpect: /^tsc -p tsconfig\.json$/,
    what: 'fixture 里的 TS2322（number 变量赋 string）拷成 src/__gate-neg-type-probe.ts',
    artifact: PROBE_TYPE,
    inject: () => {
      copyFixture('type/type-error.ts', PROBE_TYPE)
      return () => rmSync(path.join(ROOT, PROBE_TYPE), { force: true })
    },
    // 红必须点到「我们注入的那个文件 + 那条规则」，否则可能红在别处（比如 tsconfig 改坏了）
    red: /src\/__gate-neg-type-probe\.ts\(\d+,\d+\): error TS2322: Type 'string' is not assignable to type 'number'/,
  },
  {
    id: 'N2',
    gate: 'lint',
    script: 'lint',
    scriptExpect: /^oxlint src rspack\.config\.ts$/,
    what: 'fixture 里的 `debugger`（no-debugger: error）拷成 src/__gate-neg-lint-probe.ts',
    artifact: PROBE_LINT,
    inject: () => {
      copyFixture('lint/lint-violation.ts', PROBE_LINT)
      return () => rmSync(path.join(ROOT, PROBE_LINT), { force: true })
    },
    // 两条判据（都必须命中）：
    //   · 规则族：`debugger` 的提示文案（本地形态是 `x eslint(no-debugger): ...`）
    //   · 增量：正例是 `0 errors`，注入后必须正好 `1 error` —— 这比文件名更稳：
    //     oxlint 在 GitHub Actions 上会输出注解格式，CI 日志里诊断头的文件名会被 runner 吞掉
    //     （实测 #419 第一轮 CI：本地红在 `/no-debugger.*__gate-neg-lint-probe\.ts/`，CI 只有
    //     `##[error]\`debugger\` statement is not allowed` + `Found 0 warnings and 1 error.`）。
    red: [/debugger/, /Found 0 warnings and 1 error/],
    // 同一份注入只该被 lint 拦下：tsc 对 debugger 语句不报错。这条断言把「归因」钉死，
    // 免得哪天 fixture 变成「语法错 / 类型错」，lint 的红被 tsc 顶掉还看不出来。
    alsoWhileInjected: () => {
      const tsc = run(commandOf('type'))
      assert.equal(tsc.status, 0, `lint 的注入物不该让 type 也红（fixture 必须是纯 lint 违规）\n${tsc.out}`)
    },
  },
  {
    id: 'N4',
    gate: 'check:test-layout',
    script: 'check:test-layout',
    scriptExpect: /^node scripts\/check-test-layout\.mjs$/,
    what: '造一个跑不到的用例：tests/unit/__gate-neg-layout-probe/probe.test.mjs（层级目录里的子目录）',
    artifact: `${PROBE_LAYOUT_DIR}/probe.test.mjs`,
    inject: () => {
      const dir = path.join(ROOT, PROBE_LAYOUT_DIR)
      cpSync(path.join(FIXTURES, 'layout/unreachable-probe'), dir, { recursive: true })
      return () => rmSync(dir, { recursive: true, force: true })
    },
    // #393 是手工验的这条（造未登记测试文件 → exit 1），这里把它固化：
    // 两条硬规则都要报出来（落位 + 孤儿），只报一条说明另一条规则死了。
    red: new RegExp(
      `\\[layer-placement\\] ${PROBE_LAYOUT_DIR}/probe\\.test\\.mjs[\\s\\S]*\\[orphan\\] ${PROBE_LAYOUT_DIR}/probe\\.test\\.mjs`
    ),
  },
  {
    id: 'N5',
    gate: 'check:test-duplication',
    script: 'check:test-duplication',
    scriptExpect: /^node scripts\/check-test-duplication\.mjs$/,
    what: `把 ${DUP_SOURCE} 原样复制成 ${PROBE_DUP_COPY}（整文件逐字重复）`,
    artifact: PROBE_DUP_COPY,
    inject: () => {
      const lines = readFileSync(path.join(ROOT, DUP_SOURCE), 'utf8').split('\n').filter((line) => line.trim()).length
      assert.ok(
        lines >= DUP_WINDOW + 10,
        `${DUP_SOURCE} 只有 ${lines} 行非空内容，撑不起 ${DUP_WINDOW} 行的逐字重复窗口 —— ` +
          '换一份更长的用例当复制源（或调小 DUP_WINDOW，但要重新确认存量在该窗口下是 0 组）'
      )
      cpSync(path.join(ROOT, DUP_SOURCE), path.join(ROOT, PROBE_DUP_COPY))
      return () => rmSync(path.join(ROOT, PROBE_DUP_COPY), { force: true })
    },
    // R1 那一段的组行在前、合计行在后，所以按「组名 → 合计 1 组」的顺序断言：
    // 既证明认出了这份复制，也证明它是**唯一**一组（否则 exit≠0 可能红在存量那 33 组上）
    red: /__gate-neg-dup-copy\.test\.mjs[\s\S]*逐字重复 1 组/,
  },
]

// ---------------------------------------------------------------- 表结构与使用

test('门禁负向对照的表结构自洽（id 唯一 / 门禁都在 package.json 里 / 命令行没被改软）', () => {
  const ids = new Set()
  for (const row of ROWS) {
    assert.equal(ids.has(row.id), false, `行 id 重复：${row.id}`)
    ids.add(row.id)
    assert.match(row.id, /^N\d+$/, `行 id 必须是 N<数字>：${row.id}`)
    // 门禁的 npm script 必须还在（commandOf 找不到会抛，消息里点明被删/改名）
    commandOf(row.script)
    // 门禁命令行不许被「改软」：换成 true / echo / 加 --warn / 少传目录，这里先红
    assert.match(
      commandOf(row.script).raw,
      row.scriptExpect,
      `${row.gate} 的命令行变了（现在是 \`${commandOf(row.script).raw}\`）—— ` +
        '负向对照要跟着重新确认：门禁被换成不检查东西的命令时，注入缺陷也不会红'
    )
    assert.ok(row.what && row.artifact, `${row.id} 要写清楚「注入什么」和「注入物在哪」`)
  }
  assert.equal(ROWS.length, 4, '四道「同仓库内注入即可」的门禁各一行（build 走临时副本，单独一条用例）')
})

for (const row of ROWS) {
  test(`${row.id} ${row.gate}：注入违规必须红，还原后必须绿`, (t) => {
    const hooks = {}
    if (row.gate === 'check:test-duplication') {
      // 存量有 33 组 ≥20 行重复，默认窗口下门禁**本来就是红**（ci.yml 因此带 --warn）；
      // 所以正例/还原用「窗口 80」（存量 0 组）拿干净的 exit 码，
      // 再用一次默认窗口的注入跑证明 CI 那个口径也认得这份重复。
      hooks.positiveArgs = ['--window', String(DUP_WINDOW)]
      hooks.negativeArgs = ['--window', String(DUP_WINDOW)]
      hooks.positiveOut = /逐字重复 0 组/
      const jsonPath = path.join(scratch('dup'), 'dup-report.json')
      t.after(() => rmSync(path.dirname(jsonPath), { recursive: true, force: true }))
      hooks.negativeOut = (red) => {
        assert.match(red.out, /JSON 报告/, '拿不到 JSON 报告，没法断言「报的是哪一组」')
        const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
        const pairs = report.groups?.verbatim ?? []
        assert.equal(pairs.length, 1, `窗口 ${DUP_WINDOW} 下应只剩注入的这一组，实际 ${pairs.length} 组`)
        assert.deepEqual(
          [...pairs[0].files].sort(),
          [PROBE_DUP_COPY, DUP_SOURCE].sort(),
          '报出来的组必须正好是「原文件 + 复制件」这一对'
        )
        assert.ok(pairs[0].lines >= DUP_WINDOW, `重复块应有 ≥${DUP_WINDOW} 行，实际 ${pairs[0].lines} 行`)
        // CI 用的是默认窗口 20（带 --warn）：同一份注入在真实口径下也必须被认出来，
        // 否则「窗口 80 能抓」只是个测试专属的假象。
        const ciWindow = run(commandOf('check:test-duplication', ['--warn', '--json', jsonPath]))
        assert.equal(ciWindow.status, 0, `--warn 模式永远 exit 0，这里只是要它的报告：\n${ciWindow.out}`)
        const defaultReport = JSON.parse(readFileSync(jsonPath, 'utf8'))
        const hit = (defaultReport.groups?.verbatim ?? []).filter((group) => group.files.includes(PROBE_DUP_COPY))
        assert.equal(hit.length, 1, `默认窗口（${defaultReport.window} 行）下必须也报出这份复制（CI 用的就是这个口径）`)
      }
      // --json 输出路径要跟着「红」那次跑
      hooks.negativeArgs = [...hooks.negativeArgs, '--json', jsonPath]
    }
    assertNegativeControl(row, hooks)
  })
}

// ---------------------------------------------------------------- N3 build（临时副本）

test('N3 build（rspack）：往仓库临时副本注入语法错模块 → 构建必须失败；还原 → 构建通过', (t) => {
  // ci.yml 里有两个构建步骤：`build:internal`（内测包）与 `build`（黄金 job 的标准包）。
  // 两者共用同一个包装脚本 scripts/build.mjs，差别只有 variant 环境变量 —— 所以这一条对照
  // 对**两条命令**都做，避免出现「`build:internal` 有对照、`build` 没有」的半覆盖。
  const internal = commandOf('build:internal')
  const standard = commandOf('build')
  assert.match(
    internal.raw,
    /^node scripts\/build\.mjs --internal$/,
    `build:internal 的命令行变了（现在是 \`${internal.raw}\`）：负向对照要跟着重新确认`
  )
  assert.match(
    standard.raw,
    /^node scripts\/build\.mjs$/,
    `build 的命令行变了（现在是 \`${standard.raw}\`）：负向对照要跟着重新确认`
  )

  // 只拷构建真正要用的几棵子树（docs/ 62MB、node_modules 305MB 不拷），node_modules 软链过去：
  // node_modules 是只读依赖，不该被复制一份 300MB 出来，也不该被写坏。
  const dir = scratch('build')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const entry of ['src', 'shared', 'config', 'scripts', 'LICENSE', 'package.json', 'rspack.config.ts', 'tsconfig.json']) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true })
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

  const entryFile = path.join(dir, 'src/main.tsx')
  const originalEntry = readFileSync(entryFile, 'utf8')
  const probeName = '__gate-neg-build-probe'
  const buildGreen = (cmd, label) => {
    const result = run(cmd, { cwd: dir, timeoutMs: 600_000 })
    assert.equal(result.status, 0, `${label}：临时副本里的构建必须 exit=0\n--- 输出 ---\n${result.out}`)
    assert.match(result.out, /\[build\] OK/, `${label}：成功时应有 [build] OK\n--- 输出 ---\n${result.out}`)
  }

  // ① 正例：干净副本能构建（同时也证明「临时副本 + 软链 node_modules」这套假设成立）
  buildGreen(internal, '正例 build:internal')
  buildGreen(standard, '正例 build（标准包）')

  // ② 注入：语法错模块 + 让 entry 真的 import 它。
  //    只丢文件到 src/ 是不够的 —— rspack 只编译进图的模块，孤立文件连解析都不会做。
  try {
    cpSync(path.join(FIXTURES, 'rspack/syntax-error.ts.txt'), path.join(dir, `src/${probeName}.ts`))
    writeFileSync(entryFile, `${originalEntry}\nimport './${probeName}'\n`)
    for (const [cmd, label] of [[internal, 'build:internal'], [standard, 'build（标准包）']]) {
      const red = run(cmd, { cwd: dir, timeoutMs: 600_000 })
      assert.notEqual(
        red.status,
        0,
        `${label}：注入语法错模块后构建必须失败（负向对照失效 = 构建门禁空跑）\n--- 输出 ---\n${red.out}`
      )
      assert.match(red.out, new RegExp(`${probeName}\\.ts`), `${label}：报错要点出注入的那个模块\n--- 输出 ---\n${red.out}`)
      assert.match(red.out, /Syntax Error|Module build failed/, `${label}：红的原因要是解析/构建失败\n--- 输出 ---\n${red.out}`)
      assert.doesNotMatch(
        red.out,
        /本地找不到 @rspack\/cli/,
        `${label}：不能红在「缺依赖」上：那是环境问题，不是门禁在工作`
      )
    }
  } finally {
    // ④ 还原（临时副本反正要删，但还原后再构建一次才是「红不是恒红」的证明）
    writeFileSync(entryFile, originalEntry)
    rmSync(path.join(dir, `src/${probeName}.ts`), { force: true })
  }

  // ⑤ 还原 → 重新绿
  buildGreen(internal, '还原后')
})

// ---------------------------------------------------------------- N6 规矩：每道 CI 门禁都得有对照

/**
 * 「12 道门禁全部有负向对照，或明确记录为什么不需要」（#369 验收第 1 条）的机械版本。
 *
 * 这张表是**门禁 × 负向对照落在哪**的唯一登记处：
 *   · ci.yml 里每出现一条 `run: pnpm run <gate>`，这里就必须有一条，否则用例红 ——
 *     「新增门禁时必须同时提交负向对照」（docs/TESTING-POLICY.md 第 9 节）从此不靠人记；
 *   · 每条登记的文件必须存在、且里面真的提到这道门禁（防止文件被搬走/改名后登记变成空指针）。
 *
 * `kind` 只说清楚「这条对抗是怎么打的」，方便复核时知道去哪看：
 *   inject   —— 往真仓库里注入违规物（本文件 N1/N2/N4/N5、domain10 的 G1~G3）
 *   builtin  —— 门禁自带反例（invalid fixture / selftest）
 *   ci       —— 负向对照写在 ci.yml 的步骤里（现场注入产物）
 *
 * `unwired: true` 表示「门禁本身还没接线」（对照做了，但目前没人跑它）—— 这类条目在
 * `tests/unit/domain10-gate-wiring.test.mjs` 的 KNOWN_UNWIRED 里有同一份交代，两边一起改。
 */
const REGISTRY = {
  'check:hygiene': { where: 'tests/unit/domain10-release-gate-matrix.test.mjs', kind: 'inject', what: '注入本机绝对路径 C:\\Users\\…' },
  'check:dup-impl': { where: 'tests/unit/domain10-release-gate-matrix.test.mjs', kind: 'inject', what: '整份复制已有实现' },
  'check:bundle-target': { where: 'tests/unit/domain10-release-gate-matrix.test.mjs', kind: 'inject', what: '产物里追加 ?. / ??=' },
  'check:manifest': { where: 'tests/unit/domain10-release-gate-matrix.test.mjs', kind: 'builtin', what: '自带 invalid-*.json 反例 + 11 条事故逐条报出' },
  'check:matrix': { where: 'tests/unit/matrix-config.test.mjs', kind: 'builtin', what: '截断档位 / AVD 版本不符 / 路径缺失三条负向' },
  'check:ip': { where: 'tests/unit/check-ip-version.test.mjs', kind: 'builtin', what: '版本号不报 vs 真写死地址照报（两头都钉）' },
  'check:guard': { where: 'tests/unit/guard-es5-gate.test.mjs', kind: 'inject', what: '内联守卫注入 ?. / ?? / 箭头函数', unwired: true, mention: /check-guard-es5\.mjs/ },
  'check:legacy': { where: '.github/workflows/ci.yml', kind: 'ci', what: 'CI 往产物副本追加 ?. / ??= 后必须红' },
  'check:redact': { where: '.github/workflows/ci.yml', kind: 'ci', what: 'CI 跑 `check-redact.mjs --selftest`（脱敏器换成恒等函数必须红）' },
  'check:test-layout': { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '造一个跑不到的用例（孤立子目录）' },
  'check:test-duplication': { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '整份复制一份用例文件' },
  type: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: 'fixture 里的 TS2322 拷进 src/' },
  lint: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: 'fixture 里的 debugger 拷进 src/' },
  'build:internal': { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '临时副本里注入语法错模块并真的 import（N3）' },
  // ci.yml 的黄金 job 另跑 `pnpm run build`（标准包）：与 build:internal 共用 scripts/build.mjs，
  // N3 对**两条命令**都做了注入 → 必红，所以登记到同一条用例。
  build: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '同 build:internal（共用 scripts/build.mjs），N3 两条命令都断言注入后必红' },
  'check:log-coverage': { where: 'scripts/check-log-coverage.mjs', kind: 'builtin', what: '自带 --selftest 三个反例（**CI 调用没带 flag**）' },
  'test:golden': { where: 'tests/run-golden.mjs', kind: 'builtin', what: '自带硬门：缺产物 / 产物种类不对 → 直接红（不 SKIP）；端到端负向对照见 KNOWN_GAPS', mention: /run-golden/ },
}

/**
 * 已确认的缺口：登记了、但负向对照**当前没有生效**。不许静默 —— 每条都要写原因与关联单。
 * 与 `tests/unit/domain10-gate-wiring.test.mjs` 的 KNOWN_UNWIRED 同一个思路：
 * 缺口是被**记录**的，不是被假装覆盖的。
 */
const KNOWN_GAPS = {
  'check:log-coverage': {
    reason: '脚本自带 --selftest（3 个反例），但 ci.yml 的调用是 `pnpm run check:log-coverage`，没带 --selftest',
    issue: '#369',
    fix: 'ci.yml 补一步 `node scripts/check-log-coverage.mjs --selftest`（本单不动 ci.yml，留给接线批次）',
    // 缺口还开着 = ci.yml 里仍然没有带 --selftest 的那一步
    stillOpen: (ci) => !/check-log-coverage\.mjs\s+--selftest/.test(ci),
  },
  'test:golden': {
    reason:
      '黄金套件要**标准产物 + 真浏览器**才能跑一条主路径（checks job 不装 Chromium），四拍对照 ≈ 每条 30~60s，' +
      '超出 L0 预算；它现有的自保只是「缺产物 / 产物种类不对 → 直接红，不 SKIP」（本文件实测 DIST_DIR=/tmp/不存在 → ' +
      'exit 1，0.5s），那是「不许什么都没跑还全绿」，不是「检测能力有对照」',
    issue: '#404',
    fix: '在 ci.yml 的 golden job 里加一步负向对照：拿一份**故意坏掉**的产物（例如把 index.html 换成空壳）跑 1 条主路径 → 断言红',
    // 缺口还开着 = ci.yml 的 golden job 里仍然没有负向对照步骤
    stillOpen: (ci) => !/负向对照[^\n]*golden|golden[^\n]*负向对照/i.test(ci),
  },
}

/** ci.yml 里真实执行的门禁（`run: pnpm run <script>`），从文件里读，不在测试里抄一份 */
const ciGates = () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  return [...new Set([...ci.matchAll(/run:\s*pnpm run ([a-z0-9:.-]+)/gi)].map((m) => m[1]))]
}

test('N6 每道 CI 门禁都登记了负向对照（新增门禁不登记就会红）', () => {
  const gates = ciGates()
  // 2026-11-20：ci.yml 里 16 条 `run: pnpm run <gate>`（#404 的 golden job 又加了 build / test:golden）
  assert.ok(gates.length >= 16, `ci.yml 里应有 ≥16 道门禁，只解析到 ${gates.length} 条：${gates.join(', ')}`)

  const unregistered = gates.filter((gate) => !Object.hasOwn(REGISTRY, gate))
  assert.deepEqual(
    unregistered,
    [],
    `这些 CI 门禁没有登记负向对照：${unregistered.join(', ')}\n` +
      '新增门禁必须同时提交负向对照（docs/TESTING-POLICY.md 第 9 节）：造一份违规输入 → 断言 exit≠0 → 还原，' +
      '然后在 REGISTRY 里登记「对照落在哪个文件」。只想先接线、暂不做对照的，写进 KNOWN_GAPS 并给原因与关联 Issue。'
  )

  const stale = Object.keys(REGISTRY).filter((gate) => !gates.includes(gate) && !REGISTRY[gate].unwired)
  assert.deepEqual(stale, [], `REGISTRY 里这些门禁已经不在 ci.yml 里跑了（接线被摘掉？）：${stale.join(', ')}`)

  // 反向：登记成「未接线」的门禁，一旦接进 ci.yml 就必须把 unwired 摘掉（否则登记与事实脱节）
  const wiredButMarkedUnwired = Object.entries(REGISTRY)
    .filter(([gate, entry]) => entry.unwired && gates.includes(gate))
    .map(([gate]) => gate)
  assert.deepEqual(
    wiredButMarkedUnwired,
    [],
    `这些门禁已经接进 ci.yml 了，REGISTRY 里却还标着 unwired：${wiredButMarkedUnwired.join(', ')}`
  )

  for (const [gate, entry] of Object.entries(REGISTRY)) {
    const where = path.join(ROOT, entry.where)
    assert.ok(existsSync(where), `${gate} 的负向对照登记在 ${entry.where}，但该文件不存在`)
    assert.ok(entry.what, `${gate} 没写清「注入什么」—— 复核时没法知道该看什么`)
    // 登记文件里必须真的提到这道门禁（防「文件还在，但内容早被删了」）。
    // 默认按 gate 名匹配；个别门禁的用例里写的是脚本名而不是 npm script 名，用 mention 指定。
    const mention = entry.mention ?? new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    assert.match(
      readFileSync(where, 'utf8'),
      mention,
      `${entry.where} 里没有提到 ${mention} —— 登记可能已经失效（对照被删/被搬走了）`
    )
  }
})

test('N6 已确认的缺口仍然如实登记（缺口消失时要回来删条目）', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  for (const [gate, gap] of Object.entries(KNOWN_GAPS)) {
    assert.ok(Object.hasOwn(REGISTRY, gate), `${gate} 在 KNOWN_GAPS 里但不在 REGISTRY 里`)
    assert.ok(gap.reason && gap.issue && gap.fix, `${gate} 的缺口必须写清 reason / issue / fix`)
    // 缺口一旦补上，这条断言就红，提醒把条目删掉（别让缺口腐烂成「永久豁免」）
    assert.equal(
      gap.stillOpen(ci),
      true,
      `${gate} 的缺口看起来已经补上了 —— 请从 KNOWN_GAPS 删掉这条，并在 REGISTRY 里改成真实对照`
    )
  }
})

// ---------------------------------------------------------------- 收尾体检

test('负向对照没有在仓库里留下注入物（跑完自己体检一遍）', () => {
  for (const probe of [PROBE_TYPE, PROBE_LINT, PROBE_LAYOUT_DIR, PROBE_DUP_COPY]) {
    assert.equal(
      existsSync(path.join(ROOT, probe)),
      false,
      `残留注入物：${probe} —— 负向对照的 finally 没还原干净（会让后来人看到一条不相干的红）`
    )
  }
})
