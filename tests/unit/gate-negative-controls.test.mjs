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
//   N4 `check:test-layout`                   —— 造跑不到的用例（层级目录里的子目录 + #415 白名单目录里同样建子目录）→ 必红
//   N5 `check:test-duplication`              —— 复制整份用例文件 → 必报「逐字重复」
//   N7 `test:dl-release`（#415 接线的那一步）—— 往 deploy/dl-release/test 塞一条必红用例 → 入口必须 exit≠0，删掉后 exit 0
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
//     例外（#413 接线批次）：`check:i18n` / `check:endpoints` 的对照是「现场往仓库里塞一份坏输入
//     再跑脚本」，塞的正是脚本自己扫的那份源码，放在 ci.yml 里成本 ≈1s 且与被测命令同环境，
//     所以这两条登记成 `kind: 'ci'`（和 `check:legacy` / `check:redact` 同款）；
//     `check:capabilities` 的 warn 档没有红可打，缺口写在 KNOWN_GAPS。
//     同一形状后来还有 `check:doc-refs`（#463）与本轮的 `check:consume-api`（#487 接线）：
//     都是「往 src/ 或 docs/ 塞一条脚本自己会扫的坏输入 → 必红 → 还原」，一律 `kind: 'ci'`。
//   · 不验 `check:log-coverage` 的 `--selftest`：脚本自带反例，但 CI 调用没带这个 flag
//     （补 flag 要改 ci.yml，不在本单范围）—— 这一条登记在 N6 的「缺口」里，别当成已覆盖。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
/** #415：白名单目录（不在 tests/ 下）里的注入点 —— 白名单不等于免检，所以它也要有对照 */
const PROBE_LAYOUT_WHITELIST_DIR = 'deploy/dl-release/test/__gate-neg-layout-probe'
const PROBE_DUP_COPY = 'tests/unit/__gate-neg-dup-copy.test.mjs'
/** 「复制整份用例」的源文件：110 行、无 #362 域声明、改它的人会顺手看到这里 */
const DUP_SOURCE = 'tests/unit/check-ip-version.test.mjs'
/** `check:test-duplication` 的默认窗口是 20 行；存量有 21 组 ≥20 行的重复（#408 已进基线，
 *  见 tests/test-duplication-baseline.json），所以「窗口 80」仍然是这个仓库里最干净的
 *  「把注入引起的那一组单独拎出来」的口径：实测窗口 80 下存量 0 组、注入后正好 1 组。
 *  （基线自带 window=20，换窗口时门禁不套基线，所以窗口 80 的正例仍然 exit 0。） */
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
    what:
      '造两个跑不到的用例：tests/unit/__gate-neg-layout-probe/probe.test.mjs（层级目录里的子目录）+ '
      + 'deploy/dl-release/test/__gate-neg-layout-probe/probe.test.mjs（#415 的白名单目录里建子目录）',
    artifact: `${PROBE_LAYOUT_DIR}/probe.test.mjs + ${PROBE_LAYOUT_WHITELIST_DIR}/probe.test.mjs`,
    inject: () => {
      const dir = path.join(ROOT, PROBE_LAYOUT_DIR)
      cpSync(path.join(FIXTURES, 'layout/unreachable-probe'), dir, { recursive: true })
      // #415：白名单目录（deploy/dl-release/test，由 run-layer 的 server 层枚举）**也不是免检区**：
      // 里面建子目录同样跑不到（run-layer 用非递归 readdir），必须照样报落位 + 孤儿。
      const whitelistDir = path.join(ROOT, PROBE_LAYOUT_WHITELIST_DIR)
      cpSync(path.join(FIXTURES, 'layout/unreachable-probe'), whitelistDir, { recursive: true })
      return () => {
        rmSync(dir, { recursive: true, force: true })
        rmSync(whitelistDir, { recursive: true, force: true })
      }
    },
    // #393 是手工验的这条（造未登记测试文件 → exit 1），这里把它固化：
    // 两条硬规则都要报出来（落位 + 孤儿），只报一条说明另一条规则死了。
    // #415 起再加一处白名单目录的注入 —— 白名单（EXTRA_TEST_DIRS）是「允许目录存在」，
    // 不是「这个目录里不检查」，所以它的违规也必须在这条对照里露头。
    red: new RegExp(
      `\\[layer-placement\\] ${PROBE_LAYOUT_DIR}/probe\\.test\\.mjs[\\s\\S]*\\[orphan\\] ${PROBE_LAYOUT_DIR}/probe\\.test\\.mjs`
      + `[\\s\\S]*\\[layer-placement\\] ${PROBE_LAYOUT_WHITELIST_DIR}/probe\\.test\\.mjs`
      + `[\\s\\S]*\\[orphan\\] ${PROBE_LAYOUT_WHITELIST_DIR}/probe\\.test\\.mjs`
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

  // 整仓复制、只排除重型/无关目录（node_modules 349MB 软链过去；docs/ 78MB 是验收文档，构建不读）。
  //
  // 以前是**逐个列文件**（'src','shared','config','scripts','LICENSE','package.json','rspack.config.ts',
  // 'tsconfig.json'）—— 那份清单每加一个构建期输入就漏一次，而漏掉的后果不是「提示缺文件」，
  // 是构建在副本里直接失败：`[rspack] CLI failed: Error: ENOENT: no such file or directory, open
  // '<copy>/config/pdfjs.json'`（rspack.config.ts:106 readFileSync + config/pdfjs.json 是 #480 新增的
  // 构建期输入）。红在「正例」上，看起来像门禁坏了，其实是清单没跟上。
  // 现在改成「按目录整体复制」：新增顶层目录、新配置文件（config/*.json）自动带上，不用再改这份清单。
  const dir = scratch('build')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const SKIP = new Set(['node_modules', 'docs', '.git', 'android'])
  for (const entry of readdirSync(ROOT)) {
    if (SKIP.has(entry) || entry === 'dist' || entry.startsWith('dist-')) continue
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
  // #415：CI 新增的 `pnpm run test:dl-release` 是「跑用例」而不是扫描器，但它同样是「被换成软命令就永远绿」
  // 的位置（`|| true` / 加 continue-on-error / glob 改窄到只剩一个文件）。所以按同一套四拍：
  // 塞一条必红用例 → 入口必须 exit≠0 → 删掉 → exit 0（N7）。
  'test:dl-release': {
    where: 'tests/unit/gate-negative-controls.test.mjs',
    kind: 'inject',
    what: '往 deploy/dl-release/test 拷一条必红用例（fixture: dl-release/failing-probe）→ 入口必须 exit≠0，删掉后 exit 0',
  },
  type: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: 'fixture 里的 TS2322 拷进 src/' },
  lint: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: 'fixture 里的 debugger 拷进 src/' },
  'build:internal': { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '临时副本里注入语法错模块并真的 import（N3）' },
  // ci.yml 的黄金 job 另跑 `pnpm run build`（标准包）：与 build:internal 共用 scripts/build.mjs，
  // N3 对**两条命令**都做了注入 → 必红，所以登记到同一条用例。
  build: { where: 'tests/unit/gate-negative-controls.test.mjs', kind: 'inject', what: '同 build:internal（共用 scripts/build.mjs），N3 两条命令都断言注入后必红' },
  'check:log-coverage': { where: 'scripts/check-log-coverage.mjs', kind: 'builtin', what: '自带 --selftest 三个反例（**CI 调用没带 flag**）' },
  'test:golden': { where: 'tests/run-golden.mjs', kind: 'builtin', what: '自带硬门：缺产物 / 产物种类不对 → 直接红（不 SKIP）；端到端负向对照见 KNOWN_GAPS', mention: /run-golden/ },
  // #413 接线的三道：容器外的对照都放在 ci.yml 里现场注入（三步各 ~1s，已有 check:legacy / check:redact 同款）
  'check:i18n': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 删掉 zh 的一条真实文案（compatBootTitle）→ R1「只在 en 里」必 exit 1，还原后 exit 0',
    mention: /check-i18n\.mjs/,
  },
  'check:endpoints': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往 src/ 塞一份端点地址字面量（从 config/endpoints.json 读，不在 YAML 里抄）→ 必 exit 1，删掉后 exit 0',
    mention: /check-endpoints\.mjs/,
  },
  // 方向验收门禁（#484 §九 的 #487 阶段②脚本，#590 把它降到全绿之后才接线）：
  // 对照写在 ci.yml 里现场注入 —— 往 `android/app/src/main/assets/**`（cap sync 产物）塞一条旧池域地址
  // 必须**仍然 exit 0**（#590 ① 的扫描口径），再往 src/ 塞同一条必须 exit 1，删掉后 exit 0。
  // 为什么不做成 L0 注入：它要同时写「生成目录」与 src/ 两处（一个在 android/ 下、一个在 src/），
  // 与 check:doc-refs / check:endpoints 一样属于「现场往仓库里塞坏输入」，放进 ci.yml 成本 < 1s。
  'check:refactor-direction': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往生成目录（assets/**）塞旧池域地址 → 必须仍 exit 0；再塞进 src/ → 必 exit 1；删掉 → exit 0',
    mention: /check-refactor-direction\.mjs/,
  },
  'check:capabilities': {
    where: 'scripts/check-capabilities.mjs',
    kind: 'builtin',
    what: '自带 --strict 档（有缺陷 exit 1）；CI 目前只跑默认 warn 档 → 缺口登记在 KNOWN_GAPS',
  },
  // 文档引用门禁（#290 的脚本，本轮才接线）：对照写在 ci.yml 里现场注入 ——
  // 往 docs/ 丢一份写着不存在路径的 md → 必须 exit 1，删掉 → exit 0。
  // 为什么不做成 L0 注入：它要在**真仓库**的 docs/ 下建文件（正文扫描对象），
  // 和 check:i18n / check:endpoints 一样是「现场塞坏输入再跑脚本」，放进 ci.yml 成本 < 1s。
  'check:doc-refs': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往 docs/ 塞一份写着不存在路径的 md → 必 exit 1，删掉后 exit 0',
    mention: /check-doc-refs\.mjs/,
  },
  // 消费侧调用门禁（#484 §6.5 的脚本，随 #494 落地时没接线，本轮接的线）：对照写在 ci.yml 里现场注入 ——
  // 往 src/ 塞一条**白名单外**的路径字面量（`/api/v1/__gate_neg_not_whitelisted`）→ R3 必 exit 1，
  // 删掉 → exit 0。和 check:doc-refs / check:i18n / check:endpoints 同款：塞的正是脚本自己扫的源码，
  // 放在 ci.yml 里成本 ≈1s 且与被测命令同环境。
  // 为什么不用脚本自带的 `--selftest`：那条只证明 R2（base 零字面量），而白名单（R3）才是这道门禁的主判据。
  'check:consume-api': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往 src/ 塞一条白名单外的 `/api/v1/**` 路径 → R3 必 exit 1（且指到注入文件），删掉后 exit 0',
    mention: /check-consume-api\.mjs/,
  },
  // 登录接缝门禁（#510 的产物扫描守卫）：对照写在 ci.yml 里现场注入 —— 往 dist/ 丢一份写着假 token
  // 的 .js → 必 exit 1，删掉 → exit 0。和 check:consume-api / check:doc-refs 同款：塞的正是脚本自己
  // 扫的产物，放在 ci.yml 里成本 ≈1s 且与被测命令同环境。
  // 另有一条**正向对照**跑在 golden job（`check:test-seam --expect-seam dist`）：接缝构建的产物里
  // 必须扫得到标记 —— 扫不到说明扫描器恒绿（那样 G1~G11 会以「被登录页挡住」的形式假红）。
  // L0 侧另有 `tests/unit/auth-seam.test.mjs` 钉「扫描器对脏目录必红、对干净目录必绿」。
  'check:test-seam': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往 dist/ 塞一份写着假 token 的 js → 必 exit 1，删掉后 exit 0（golden job 另有 --expect-seam 正向对照）',
  },
  // DB 版本硬编码门禁（#547 新建）：对照写在 ci.yml 里现场注入 —— 往一份**真实用例**末尾追加
  // `indexedDB.open('chat-demo', 99)`（门禁扫的就是 tests/**，注入点必须是它真会扫到的位置）
  // → 必须 exit 1，且报出「文件:行 硬编码版本 99」+ 指到注入的那个文件 → 还原 → exit 0。
  // 为什么不做成 L0 注入（像 N1/N2 那样往 src/ 塞探针）：塞的正是脚本自己扫的源码/用例，
  // 放在 ci.yml 里成本 ≈1s 且与被测命令同环境（与 check:consume-api / check:doc-refs 同款）。
  // 两条「红必须点到」的断言写在 ci.yml 那一步里（`grep -q "硬编码版本 99"` / `grep -q "$probe:"`）：
  // 只证明「exit≠0」不够 —— 扫描目录被改窄、脚本恒红，都会让 exit≠0 成立。
  'check:db-version': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 往 tests/unit/check-ip-version.test.mjs 追加一行 indexedDB.open(…, 99) → 必 exit 1 且指到注入文件与版本号，还原后 exit 0',
    mention: /check-db-version\.mjs/,
  },
  // 大小写撞车门禁（#557 新建）：对照写在 ci.yml 里现场注入 —— 造一对仅大小写不同的模块
  // （`src/__GateCaseProbe.ts` / `src/__gatecaseprobe.ts`）→ 必 exit 1，删掉 → exit 0。
  // 和 check:consume-api / check:doc-refs 同款：塞的正是脚本自己扫的文件清单，放 ci.yml 里 ≈1s。
  // 另有脚本自带的 `--selftest`（4 条反例 + 2 条正例，见 scripts/check-case-collision.mjs），
  // 钉的是判据本身：R1 路径 / R2 目录 / R3 模块 stem（#557 命中的是 R3 —— `.tsx` 与 `.ts` 全名不同，
  // 只有 stem 撞车，所以只用「整条路径小写后相同」去判会漏）。
  'check:case-collision': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 造一对仅大小写不同的模块（src/__GateCaseProbe.ts / src/__gatecaseprobe.ts）→ 必 exit 1，删掉后 exit 0',
    mention: /check-case-collision\.mjs/,
  },
  // webroot 卫生门禁（#609 新建，裁决 #614 决定 3 的 P0 项）：对照写在 ci.yml 里现场注入 ——
  // 在 $RUNNER_TEMP 造一个干净 webroot（exit 0），再按 R1/R2/R3 各注入一类脏东西
  // （取证残留 `releases.json.LEAKED-*` / webroot 内的 `private/` / `apk/` 下的 internal 包）→
  // 必须 exit 1 **且报出对应规则与那个文件** → 还原 → exit 0。
  // 为什么不做成 L0 注入：被测对象是**一个目录的形状**（webroot），最自然的造法就是临时目录；
  // 而且 #609 明确要求「不许拿生产机当试验田」，只有 $RUNNER_TEMP 这一条路是干净的。
  // 另外脚本自带 `--selftest`（8 类脏东西 × 注入→必红→还原），裸跑时没有 webroot 会自动走它，
  // 所以 runner 上那一步也永远不是「什么都没检查还全绿」。
  'check:webroot-hygiene': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 在 $RUNNER_TEMP 造干净 webroot → exit 0；R1 取证残留 / R2 private 目录 / R3 internal 包各自注入 → 必 exit 1 且点到注入物；还原 → exit 0',
    mention: /check-webroot-hygiene\.mjs/,
  },
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
  'check:capabilities': {
    reason:
      '默认档是 warn 级：无论有几处缺陷都 exit 0（当前 10 处能力假设缺陷在案、6 条修复 lane 在飞，' +
      '硬拦截会互相卡死）。所以 CI 现在这一步只证明「扫描器每次都被跑、口径不被悄悄改宽」，没有红可打；' +
      '真正的检测能力在 `--strict` 档（有缺陷即 exit 1）',
    issue: '#413',
    fix: '缺陷清零后把 ci.yml 的调用改成 `node scripts/check-capabilities.mjs --strict`（届时缺陷即 exit 1，本身就是对照）',
    // 缺口还开着 = ci.yml 里仍然没有带 --strict 的那一步
    stillOpen: (ci) => !/check-capabilities\.mjs\s+--strict/.test(ci),
  },
}

/** ci.yml 里真实执行的门禁（`run: pnpm run <script>`），从文件里读，不在测试里抄一份 */
const ciGates = () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  return [...new Set([...ci.matchAll(/run:\s*pnpm run ([a-z0-9:.-]+)/gi)].map((m) => m[1]))]
}

/**
 * N7（#415）：`test:dl-release` —— CI 里那一步真的会红吗？
 *
 * 四拍与 N1/N2/N4/N5 同模板，只是注入物是「一条必然失败的用例」：入口是
 * `node --test deploy/dl-release/test/*.test.mjs`，多一份必红文件退出码就必须非 0。
 * 这条对照同时钉住三件容易悄悄发生的事：入口被加 `|| true`、被塞 `continue-on-error`、
 * 被改窄成只跑某一个文件（那样注入的探针根本不会被跑到 → 正例红）。
 */
test('N7 test:dl-release：塞一条必红用例 → 34 条那个入口必须 exit≠0，删掉后必须 exit 0', () => {
  const PROBE = 'deploy/dl-release/test/__gate-neg-dl-release-probe.test.mjs'
  /**
   * 这一步的特殊之处：被测命令**自己就是 `node --test`**。父 runner 会在环境里留下
   * `NODE_TEST_CONTEXT`，子进程看到它就以为「我在测试运行器里被递归调用」，直接
   * `skipping running files` 并 exit 0 —— 四拍会全部失真（正例绿、注入也绿 = 对照失效）。
   * 所以在 spawn 之前把它摘掉，本拍结束后原样还回去（只影响本进程的这几百毫秒）。
   */
  const saved = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  try {
    assertNegativeControl({
      id: 'N7',
      gate: 'test:dl-release',
      script: 'test:dl-release',
      scriptExpect: /^node --test deploy\/dl-release\/test\/\*\.test\.mjs$/,
      what: `把 tests/gates/fixtures/dl-release/failing-probe.test.mjs 拷成 ${PROBE}`,
      artifact: PROBE,
      inject: () => {
        copyFixture('dl-release/failing-probe.test.mjs', PROBE)
        return () => rmSync(path.join(ROOT, PROBE), { force: true })
      },
      // node --test 的 spec reporter 打「ℹ fail 1」、tap reporter 打「# fail 1」，两种都认
      red: /(?:#|ℹ) fail [1-9]/,
    })
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = saved
  }
})

test('N6 每道 CI 门禁都登记了负向对照（新增门禁不登记就会红）', () => {
  const gates = ciGates()
  // 2026-11-20：ci.yml 里 22 条 `run: pnpm run <gate>`（#404 的 golden job 加了 build / test:golden，
  // #413 又接进 check:i18n / check:endpoints / check:capabilities，本轮接进 check:consume-api）
  assert.ok(gates.length >= 22, `ci.yml 里应有 ≥22 道门禁，只解析到 ${gates.length} 条：${gates.join(', ')}`)

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

/**
 * #603：上面那一条只防「跑完还留在工作区」。人手动单跑本文件 / 中途 Ctrl-C 之后，
 * 注入物会留在工作区，下一次 `git add -A` 就把它扫进提交 —— main 上
 * `src/__gate-neg-type-probe.ts`（@ f911ede7，与 `tests/gates/fixtures/type/type-error.ts`
 * 字节相同）就是这么进去的，结果 `check:dup-impl` 判红、整条 main 红。
 * 所以这里再体检一遍「**提交里**没有注入物」：工作区干净不等于仓库干净。
 */
test('注入物没有被提交进仓库（工作区干净 ≠ 仓库干净）', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'src', 'tests/unit', 'deploy/dl-release/test'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.includes('__gate-neg'))
  assert.deepEqual(
    tracked,
    [],
    `注入物被提交进仓库了：${tracked.join(', ')} —— \`git rm --cached\` 删掉，`
      + '别用 .gitignore 挡（oxlint 会跟着忽略它，N2 的负向对照会失效）'
  )
})
