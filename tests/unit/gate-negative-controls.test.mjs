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
// #453 的审计把这 33 道门禁判成四态，其中**三道零负向对照**（「判得动但没人知道它判不判得动」）。
// 本节末尾的 N8/N9/N10 就是给它们各配的一组「破坏 → 必红 → 还原」证明（详见那一段的注释）：
//
//   N8  `check:keystore`           —— 键名错 / 路径错 / 口令错 / 别名错 → exit 1 且点名；缺文件 exit 2
//   N9  `check:limits`             —— 注入裸阈值 → exit 1 且点名 文件:行:值；镜像常量漂移 → 点名两个不同值
//   N10 `check:capabilities`       —— `--strict` 注入低内核用法 → exit 1 且点名 文件:行（warn 档同一份注入仍 exit 0）
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
//     `check:capabilities` 的 warn 档没有红可打（#453 之后它有了 `--strict` 档的对照，见 N10；
//     剩下的缺口只是 ci.yml 还没改 --strict），那部分写在 KNOWN_GAPS。
//     同一形状后来还有 `check:doc-refs`（#463）与本轮的 `check:consume-api`（#487 接线）：
//     都是「往 src/ 或 docs/ 塞一条脚本自己会扫的坏输入 → 必红 → 还原」，一律 `kind: 'ci'`。
//   · 不验 `check:log-coverage` 的 `--selftest`：脚本自带反例，但 CI 调用没带这个 flag
//     （补 flag 要改 ci.yml，不在本单范围）—— 这一条登记在 N6 的「缺口」里，别当成已覆盖。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // #104 新门禁：把「声明的最低内核」和「入口产物真实最低内核」放一起比。
  // 对照落在 L0（legacy-syntax-floor-gate.test.mjs）：入口塞 ||= → 真实下限 85 > 声明 80 → 必 exit 1；
  // 另一拍把声明值调到 79（产物仍 80）→ 同样必红 —— 两个方向都钉住，避免「判据反了也全绿」。
  'check:syntax-floor': {
    where: 'tests/unit/legacy-syntax-floor-gate.test.mjs',
    kind: 'inject',
    what: '入口产物塞 ||= → 真实下限 85 高于声明 80 必 exit 1；声明值调到 79 → 同样必红',
  },
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
  // 签名凭据形状门禁（#272 的脚本，#453 补的对照）：对照落在本文件 N8 —— 四键 properties 的
  // 键名错（`storeFileRelease` → `storeFile`）/ `storeFile` 指向不存在的路径 / 口令错 / 别名错
  // 各自 exit 1 且**点名具体键名与路径**；缺文件 exit 2（与「配错」的 1 区分开，硬要求）。
  // `unwired: true`：这道门禁至今零 CI 入口 —— 它要本机 `android/keystore/keystore.properties`
  // （不入库），CI 里必然 exit 2；`tests/unit/domain10-gate-wiring.test.mjs` 的 KNOWN_UNWIRED 有同一份交代。
  // 也就是说：**判据现在有证明了，但还是没人跑它** —— 这个区别正是 #453 要暴露的东西。
  'check:keystore': {
    where: 'tests/unit/gate-negative-controls.test.mjs',
    kind: 'inject',
    what:
      '键名错（storeFileRelease→storeFile）/ storeFile 指向不存在的路径 / 口令错 / 别名错 → 各自 exit 1 且点名键名与路径；' +
      '缺文件 → exit 2 且给出「cp example + 补四键」的修法（N8）',
    unwired: true,
    mention: /check-keystore-config\.mjs/,
  },
  // 运行期阈值单一来源门禁（#275 的脚本，#453 补的对照）：对照落在本文件 N9 —— 往受保护文件
  // 注入裸阈值 `45000` 必 exit 1 且点名 `文件:行: 值`；再把镜像常量（src/index.html 的
  // BOOT_DEADLINE_MS 12000）改成 13000 → 报错里必须**同时**出现登记值与实际值两个不同数字。
  // 与 N8 一样：`unwired: true`（零 CI 入口），对照是真的，跑它的人还没有。
  'check:limits': {
    where: 'tests/unit/gate-negative-controls.test.mjs',
    kind: 'inject',
    what:
      '临时副本里往 src/services/attachments/limits.ts 注入裸阈值 45000 → exit 1 且点名 文件:行:值；' +
      '改掉 src/index.html 的镜像常量 12000→13000 → 同时点名两个不同值（N9）',
    unwired: true,
    mention: /check-limits\.mjs/,
  },
  'check:capabilities': {
    // #453 之前这里登记成 `scripts/check-capabilities.mjs` + `kind: 'builtin'`（「自带 --strict 档」），
    // 那其实**不是负向对照**：没人注入过东西，没人见过它红。现在换成真对照（本文件 N10）——
    // 干净 fixture → `--strict` exit 0；注入 `Promise.withResolvers`（首支持 Chromium 119）→
    // exit 1 且点名 `文件:行`；同一份注入下 **warn 档仍 exit 0**（= CI 现在这步恒绿，#413）。
    where: 'tests/unit/gate-negative-controls.test.mjs',
    kind: 'inject',
    what:
      '干净 fixture root 上 --strict exit 0 → 注入 Promise.withResolvers → --strict exit 1 且点名 文件:行、' +
      'warn 档同一份注入仍 exit 0（N10）；另在真仓库上钉住「warn 恒 0 / strict 与缺陷数一致」',
  },
  // 文档引用门禁（#290 的脚本，本轮才接线）：对照写在 ci.yml 里现场注入 ——
  // 往 docs/ 丢一份写着不存在路径的 md → 必须 exit 1，删掉 → exit 0。
  // 为什么不做成 L0 注入：它要在**真仓库**的 docs/ 下建文件（正文扫描对象），
  // 和 check:i18n / check:endpoints 一样是「现场塞坏输入再跑脚本」，放进 ci.yml 成本 < 1s。
  'check:doc-refs': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what:
      'CI 往 docs/ 塞一份写着不存在路径的 md → 必 exit 1，删掉后 exit 0；' +
      '另有 #678 那一拍的对照组：**省略前缀**的 `i18n/index.ts:9999`（越界）与 ' +
      '`i18n/index.ts:5`（空行）→ 两条都必须 exit 1，后缀多匹配的 `390/metrics.json` ' +
      '必须 WARN 点名（不许静默跳过），删掉后 exit 0',
    mention: /check-doc-refs\.mjs/,
  },
  // 截图引用门禁（#661：`docs/ui` 553 张里 155 张零引用）：双向都现场注入 ——
  // ① 删一张被 README 引用的截图（悬空引用）② 塞一张无人引用的截图（孤儿），两者都必须 exit 1，还原后 exit 0。
  // 和 check:doc-refs / check:i18n 同款：注入的正是它自己扫的东西，放进 ci.yml 成本 ≈2s。
  'check:ui-shots': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 删一张被 README 引用的截图（悬空）与塞一张无人引用的截图（孤儿）→ 两条都必须 exit 1，还原后 exit 0',
    mention: /check-ui-shots\.mjs/,
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
  // 行尾门禁（#533 最后一块）：对照写在 ci.yml 里现场注入 —— 造一个 CRLF 的 .mjs
  // （`git add -N` 进索引，因为门禁只认 `git ls-files`）→ 必须 exit 1 且点到「文件:首处行号」，
  // 删掉 → exit 0。和 check:case-collision 同款：塞的正是脚本自己扫的文件清单，放 ci.yml 里 ≈0.3s。
  // 为什么不做成 L0 注入：CRLF 是**工作区内容的属性**，要在真仓库里造一份 CRLF 文件再让脚本去扫，
  // 和 check:doc-refs / check:db-version 一样属于「现场塞坏输入」；脚本另有 `--selftest`
  // （临时仓库里 CRLF 文本必红、`*.bat` 与二进制必豁免、`--fix` 归一且保留 BOM）。
  'check:eol': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI 造一个 CRLF 的 src/__gateEolProbe.mjs（git add -N 进索引）→ 必 exit 1 且点到 probe:1，删掉后 exit 0',
    mention: /check-eol\.mjs/,
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
  // 默认根守卫（#601 的结构根因）：对照写在 ci.yml 里现场注入 —— ① 默认参数（**一个根参数都不带**，
  // 就是事故那晚的命令形态）必须落在私有根 `/opt/dl-private`；② 脚本自带 `--selftest`（5 种改坏
  // 方式全判红、正本判绿）；③ **真**把默认根 sed 回 `/var/www/dl` → 门禁必须 exit 1 且点到 R2
  // （只证明 exit≠0 不够：判据被改窄、脚本恒红都会让 exit≠0 成立）；④ 同一个改坏的默认根下
  // 发布脚本自己也要 exit 非 0 并点到 #601；⑤ 还原 → 绿。`trap` 保证任何失败路径都还原。
  'check:private-publish-root': {
    where: '.github/workflows/ci.yml',
    kind: 'ci',
    what: 'CI：默认参数必落私有根（exit 0）；默认根改回 /var/www/dl → 门禁 exit 1 且报 R2 + 脚本拒并点到 #601；还原 → exit 0（另有 --selftest 5 种改坏方式）',
    mention: /check-private-publish-root\.mjs/,
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
      '硬拦截会互相卡死）。所以 CI 现在这一步只证明「扫描器每次都被跑、口径不被悄悄改宽」，没有红可打。' +
      '#453 之后**检测能力本身已有对照**（本文件 N10：注入低内核用法 → `--strict` exit 1 且点名 文件:行；' +
      '同一份注入下 warn 档仍 exit 0），剩下的缺口**只剩接线**：ci.yml 还没把这条命令换成 --strict',
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

// ================================================================ #453 补的三道（N8 / N9 / N10）
//
// #453 的审计把 33 道 `scripts/check-*.mjs` 判成四态，其中三道**零负向对照**（「判得动，但没人
// 知道它判不判得动」）。本节给这三道各配一组「破坏 → 必红 → 还原」的可复现证明：
//
//   N8  `check:keystore`（P0 发布链：签名凭据形状错 → 新机器出不了包 / 悄悄换证书）
//   N9  `check:limits`（阈值单一来源：改一处不改另一处 = 第二份真相源回来了）
//   N10 `check:capabilities --strict`（低内核白屏的历史事故；warn 档结构上永不 exit 1）
//
// 硬约束：**没有一道门禁被删、没有一条判据被放宽**，`scripts/**` 一个字节都不动 ——
// 注入物全部落在 `mkdtemp` 的临时目录 / 临时副本里，跑完仓库原样（下面的「收尾体检」再兜一遍）。
//
// 三道都不走 `assertNegativeControl`（原因各写在各段开头）：keystore 的「正例」需要一把真
// keystore，limits 的注入点是被别的用例读盘的源码（单元层并行），capabilities 的 `--strict`
// 在真仓库本来就红（基线 10 处缺陷）—— 三者的「① 正例 exit 0」都不在真仓库上成立，
// 硬套模板只能靠删掉 ① 拍，而 ① 拍正是「证明它不是恒红」的那一捶。所以这三段各自把四拍的
// 语义写全（正例 → 注入 → 必红且点名 → 还原 → 再正例），只是正例跑在临时树 / `--root` 上。

// ---------------------------------------------------------------- N8 check:keystore（#453 第 1 优先）

/**
 * 为什么 N8 不用统一骨架：这道门禁的最后一拍要 `keytool` 打开 keystore（`--quiet` 之外没有开关能绕），
 * 而 ci.yml 的 `setup-java` 排在 `pnpm test` **之后**（checks job 里 `pnpm test` 在 305 行、
 * setup-java 在 336 行）。所以分成两张表：
 *
 *   · 「不需要 keystore」的三拍 —— 缺文件 / 缺键（键名错） / 路径错。任何环境都必须跑，
 *     而且正是 #272 事故里最难定位的那几种（gradle 报起来长得一模一样）。
 *   · 「需要 keystore」的四拍 —— 真 keystore 正例 / 口令错 / 别名错 / 指纹不符。没有 keytool 时
 *     **照样跑**，但断言换成「门禁 fail-closed」（exit 2 且点名找不到 keytool），并打一条 diagnostic
 *     说明本机限制。不许静默 skip：跳过的对照在 CI 上等于不存在，正是本单要消灭的形态。
 */
const KS_STORE_PASS = 'gateNegStorePass'
const KS_ALIAS = 'gate-neg-release'
/** 四键 properties 文本；`overrides` 里给 `undefined` 表示把这个键**删掉**（造「键名写错」用） */
const ksProps = (storeFile, overrides = {}) => {
  const values = {
    storeFileRelease: storeFile,
    storePasswordRelease: KS_STORE_PASS,
    keyAliasRelease: KS_ALIAS,
    keyPasswordRelease: KS_STORE_PASS,
    ...overrides,
  }
  return `${Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
}

/** 找 keytool（与 check-keystore-config.mjs 的 findKeytool 同一套候选：先 JAVA_HOME，再 PATH） */
const findKeytool = () => {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool'
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe))
  candidates.push(exe)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-help'], { stdio: 'ignore', timeout: 30_000 })
      return candidate
    } catch {
      // 换下一个候选（keytool 的 -help 退出码各家不同，能起来就算找到）
    }
  }
  return null
}

test('N8 check:keystore：缺键 / 路径错 / 口令错 / 别名错 → exit 1 且点名；缺文件 → exit 2（明确要人配）', (t) => {
  const gate = commandOf('check:keystore')
  // 命令行不许被改软：加 `--quiet` 会把「读了哪个文件 / 哪个别名」藏掉，加固定 `--file` 会把
  // 被测对象钉死在某个文件上（那样它就不再检查『本机到底配了没有』）。
  assert.match(
    gate.raw,
    /^node scripts\/check-keystore-config\.mjs$/,
    `check:keystore 的命令行变了（现在是 \`${gate.raw}\`）——负向对照要跟着重新确认`
  )
  assert.doesNotMatch(gate.raw, /--quiet|--file/, `check:keystore 不许默认带 ${gate.raw.includes('--quiet') ? '--quiet' : '--file'}：那会把被测对象藏起来`)

  const dir = scratch('keystore')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const propsPath = path.join(dir, 'keystore.properties')
  const storeFile = path.join(dir, `${KS_ALIAS}.p12`)
  const runProps = () => run(commandOf('check:keystore', ['--file', propsPath]))
  const writeProps = (text) => writeFileSync(propsPath, text)

  // ---- ① 缺文件：exit **2**（环境不合格），且必须明确告诉人「这份文件要你自己放」----
  // （这是本单硬要求里点名的那条区分：缺文件 = 2 / 配错 = 1。混成一个码，新机器就只知道「签名不行」）
  rmSync(propsPath, { force: true })
  const missing = runProps()
  assert.equal(missing.status, 2, `缺 properties 文件必须 exit 2（环境不合格），实际 ${missing.status}\n${missing.out}`)
  assert.match(missing.out, /\[FAIL\] 找不到签名属性文件/, `缺文件时必须点名「缺哪个文件」\n${missing.out}`)
  assert.match(
    missing.out,
    /keystore\.properties\.example/,
    `缺文件时不能只说「没有」——要给出「cp 哪份 example + 填哪四个键」的修法\n${missing.out}`
  )

  // ---- ② 缺键（#272 事故本体：`storeFileRelease` 写成 `storeFile`）→ exit 1，且必须点出错的那个键名 ----
  writeProps(ksProps(storeFile, { storeFileRelease: undefined, storeFile: storeFile }))
  const typo = runProps()
  assert.equal(typo.status, 1, `键名错必须 exit 1（配置不合格），实际 ${typo.status}\n${typo.out}`)
  assert.match(typo.out, /缺少 1 个必填键/, `必须报「缺几个键」\n${typo.out}`)
  assert.match(typo.out, /- storeFileRelease/, `必须点名缺的那个键 storeFileRelease\n${typo.out}`)
  assert.match(typo.out, /写的是 `storeFile`，键名错了/, `必须点出「文件里写的是哪个错键名」（否则人还在原地猜）\n${typo.out}`)

  // ---- ③ storeFileRelease 指向不存在的路径 → exit 1，且必须把「解析后的绝对路径」打印出来 ----
  // （相对路径按 android/app/ 解析、不是仓库根 —— 这就是 gradle 里那句 file() 的坑，报错必须带走这一点）
  const ghost = path.join(dir, 'nope.keystore')
  writeProps(ksProps(ghost))
  const badPath = runProps()
  assert.equal(badPath.status, 1, `路径错必须 exit 1，实际 ${badPath.status}\n${badPath.out}`)
  assert.match(badPath.out, /storeFileRelease 指向的文件不存在/, `必须点名是 storeFileRelease 这个键\n${badPath.out}`)
  assert.ok(
    badPath.out.includes(ghost),
    `必须把解析后的绝对路径原样打出来（${ghost}）——只说「文件不存在」等于让人全盘搜\n${badPath.out}`
  )
  assert.match(badPath.out, /相对 android\/app\/ 解析/, `必须带上「相对 android/app/ 解析」这条修法（#272 的坑）\n${badPath.out}`)

  // ---- ④ 需要真 keystore 的几拍 ----
  const keytool = findKeytool()
  if (!keytool) {
    // 没有 JDK：门禁自己的行为是 fail-closed（exit 2 且点名 keytool）。这不是「跳过」——
    // 断言它确实 fail-closed，并明确登记「本机跑不了这一步」。
    writeProps(ksProps(storeFile))
    const noKeytool = runProps()
    assert.equal(noKeytool.status, 2, `没有 keytool 时必须 fail-closed exit 2（不许静默放行），实际 ${noKeytool.status}\n${noKeytool.out}`)
    assert.match(noKeytool.out, /找不到 keytool/, `没有 keytool 时必须点名它\n${noKeytool.out}`)
    assert.match(noKeytool.out, /不跳过/, `必须说清「不跳过」（否则下一个人会以为是环境提示）\n${noKeytool.out}`)
    t.diagnostic('N8：本机没有 keytool（JDK），口令错 / 别名错 / 指纹这三拍只验了门禁 fail-closed；装了 JDK 的机器会跑全四拍')
    return
  }

  // 造一把**只在本次用例里存在**的 keystore（每次新生成 → 指纹必然与已发布证书不同）
  execFileSync(
    keytool,
    [
      '-genkeypair', '-keystore', storeFile, '-storetype', 'PKCS12',
      '-alias', KS_ALIAS, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650',
      '-dname', 'CN=Gate Neg Probe, O=dsh',
      '-storepass', KS_STORE_PASS, '-keypass', KS_STORE_PASS,
    ],
    { stdio: 'ignore', timeout: 120_000 }
  )

  // ④a 正例：四键齐全 + 真 keystore → exit 0（这一拍才证明后面几个 exit 1 不是恒红）
  writeProps(ksProps(storeFile))
  const good = runProps()
  assert.equal(good.status, 0, `四键齐全 + 真 keystore 必须 exit 0\n${good.out}`)
  assert.match(good.out, /通过: 四个 release 键齐全/, `正例输出要说清「过了什么」\n${good.out}`)
  const probeSha = (/证书 SHA-256\s*=\s*([0-9a-f]{64})/.exec(good.out) ?? [])[1]
  assert.ok(probeSha, `正例里应能读出这张证书的 SHA-256（后面的指纹拍要用）\n${good.out}`)

  // ④b 口令错 → exit 1，且点名「口令打不开」（而不是含糊地说「签名不行」）
  writeProps(ksProps(storeFile, { storePasswordRelease: 'gateNegWrongPass' }))
  const badPass = runProps()
  assert.equal(badPass.status, 1, `口令错必须 exit 1，实际 ${badPass.status}\n${badPass.out}`)
  assert.match(badPass.out, /口令打不开 keystore/, `必须点明是口令问题\n${badPass.out}`)

  // ④c 别名错 → exit 1，且点名那个不存在的别名
  writeProps(ksProps(storeFile, { keyAliasRelease: 'no-such-alias' }))
  const badAlias = runProps()
  assert.equal(badAlias.status, 1, `别名错必须 exit 1，实际 ${badAlias.status}\n${badAlias.out}`)
  assert.match(badAlias.out, /别名 `no-such-alias` 在 keystore 里不存在/, `必须点名那个别名\n${badAlias.out}`)

  // ④d 指纹不符：**门禁刻意不判红**（形状门禁 ≠ 签名身份门禁，换证书归 #271 / gradle 的
  //     `releaseSigningApproved` 管），所以这里如实钉住「它现在的真实行为」，不伪造一条红：
  //     期望是「exit 0 + ⚠ 点名『这不是已发布证书』并给出期望值」。
  //     ⚠ 本单发现这条 ⚠ 支路**当前是空转**：expectedCertSha256() 用正则去 build.gradle 里找
  //     `EXPECTED_CERT_SHA256 = '<64 hex>'` 字面量，而 #271 之后该值已经从 build.gradle 挪到
  //     `config/appIdentity.json`（build.gradle 只写 `def EXPECTED_CERT_SHA256 = expectedCertSha256Raw`），
  //     于是 expected 恒为 null、比较分支永不进入 —— 实测下面这把它们自己生成的证书**一句警告都没有**。
  //     这条断言是**绊线**：修好支路（改成读 config/appIdentity.json）之后它会红，提示把这里换成
  //     「不符必须点名期望值」的真断言；修之前它也钉住了「现在到底有没有在警告」这个事实。
  writeProps(ksProps(storeFile))
  const mismatch = runProps()
  assert.equal(mismatch.status, 0, `指纹不符**不是**这道门禁的判据（换证书归 #271），不该 exit≠0\n${mismatch.out}`)
  assert.match(mismatch.out, new RegExp(`证书 SHA-256\\s*=\\s*${probeSha}`), `必须打出实际指纹\n${mismatch.out}`)
  assert.doesNotMatch(
    mismatch.out,
    /这不是已发布证书/,
    '指纹告警支路看起来已经修好了（现在会点名「这不是已发布证书」）—— 请把这条断言换成真正向对照：' +
      '另造一把 key 的 keystore → 必须点名 build.gradle 期望值与实际值两个不同指纹（#453 N8）'
  )
  // 顺带把「它靠什么判期望值」的事实也钉住：值不在 build.gradle 的字面量里了
  const appIdentity = JSON.parse(readFileSync(path.join(ROOT, 'config/appIdentity.json'), 'utf8'))
  assert.equal(typeof appIdentity.expectedCertSha256, 'string', 'config/appIdentity.json 里应有 expectedCertSha256')
  assert.notEqual(
    appIdentity.expectedCertSha256.toLowerCase(),
    probeSha,
    '这把临时 keystore 的指纹不该等于已发布证书（否则④d 这一拍什么都没证明）'
  )
})

// ---------------------------------------------------------------- N9 check:limits（#453 第 3 优先）

test('N9 check:limits：注入裸阈值 → exit 1 且点名 文件:行:值；改掉镜像常量（第二份真相源）→ 点名两个不同值；还原 → exit 0', (t) => {
  const gate = commandOf('check:limits')
  assert.match(
    gate.raw,
    /^node scripts\/check-limits\.mjs$/,
    `check:limits 的命令行变了（现在是 \`${gate.raw}\`）——负向对照要跟着重新确认`
  )

  // 为什么在**临时副本**里注入，而不是像 N1/N2 那样往真仓库的 src/ 塞文件：
  //   ① check-limits 的扫描对象是固定的 10 个「持有运行期阈值」的文件（WATCHED），
  //      所以注入只能**改这些文件**（新塞一个文件它根本不看）。而 src/index.html 与
  //      src/services/attachments/limits.ts 同时被 tests/unit/limits-config.test.mjs 读盘断言 ——
  //      单元层是多文件并行跑的，在真仓库里改它们几百毫秒 = 给隔壁用例埋一颗随机红（#456 那个坑）。
  //   ② 脚本的 ROOT 由自身路径推出（`scripts/check-limits.mjs` → 上一级），所以把
  //      `scripts/check-limits.mjs` + `src/` 一起复制到 mkdtemp 目录，扫的就是副本；
  //      命令行仍然是 commandOf() 从 package.json 读出来的**同一条**（不另写一份命令）。
  const dir = scratch('limits')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  cpSync(path.join(ROOT, 'scripts/check-limits.mjs'), path.join(dir, 'scripts/check-limits.mjs'))
  cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true })

  /** 注入点：`limits.ts` 的 WATCHED 登记是 `allow: []`（一处裸数字都不许有），最干净 */
  const PROBE_REL = 'src/services/attachments/limits.ts'
  /** 镜像点：`src/index.html` 的 BOOT_DEADLINE_MS = 12000（与 LIMITS.bootDeadlineMs 同值，单测守） */
  const MIRROR_REL = 'src/index.html'
  const probeFile = path.join(dir, PROBE_REL)
  const mirrorFile = path.join(dir, MIRROR_REL)
  const originalProbe = readFileSync(probeFile, 'utf8')
  const originalMirror = readFileSync(mirrorFile, 'utf8')
  assert.match(
    originalMirror,
    /BOOT_DEADLINE_MS = 12000/,
    `镜像常量换写法了（${MIRROR_REL} 里找不到 BOOT_DEADLINE_MS = 12000）——第二拍要跟着改`
  )

  // 第一拍：裸阈值（#275 的回归形态 —— 有人顺手又写一个 45000）
  assertNegativeControl(
    {
      id: 'N9',
      gate: 'check:limits',
      script: 'check:limits',
      scriptExpect: /^node scripts\/check-limits\.mjs$/,
      what: `往受保护文件 ${PROBE_REL} 尾部追加 \`export const __GATE_NEG_BARE_TIMEOUT = 45000\``,
      artifact: `（临时副本里的）${PROBE_REL}`,
      inject: () => {
        writeFileSync(probeFile, `${originalProbe}\nexport const __GATE_NEG_BARE_TIMEOUT = 45000\n`)
        return () => writeFileSync(probeFile, originalProbe)
      },
      // 红必须点到「哪个文件、哪一行、哪个值」——只说「有未收敛阈值」等于让人全仓 grep（#275 的原病）
      // 行号必须点到注入的那一行（文件路径里的 . 要转义，其余字符对 RegExp 字面量无害）
      red: new RegExp(`${PROBE_REL.replace(/\./g, '\\.')}:\\d+: 45000（换算值 45000）`),
    },
    { cwd: dir, positiveOut: /阈值收敛检查通过/ }
  )

  // 第二拍：「把某个上限常量改一处而不改另一处」= 制造第二份真相源。
  // 这里改的是**镜像那份**（src/index.html 的 12000 → 13000）：WATCHED 里登记的是 12000，
  // 实际代码里出现的是 13000 —— 报错必须**同时**点出这两个不同的值，人才知道该看哪一处。
  assertNegativeControl(
    {
      id: 'N9',
      gate: 'check:limits',
      script: 'check:limits',
      scriptExpect: /^node scripts\/check-limits\.mjs$/,
      what: `把 ${MIRROR_REL} 的镜像常量 12000 改成 13000（登记的是 12000，代码里是 13000）`,
      artifact: `（临时副本里的）${MIRROR_REL}`,
      inject: () => {
        writeFileSync(mirrorFile, originalMirror.replace('BOOT_DEADLINE_MS = 12000', 'BOOT_DEADLINE_MS = 13000'))
        return () => writeFileSync(mirrorFile, originalMirror)
      },
      red: [
        // 登记值（12000）与实际值（13000）两个不同值都要出现在报错里
        /豁免登记 12000 × 1，实际 0 次/,
        new RegExp(`${MIRROR_REL.replace(/\./g, '\\.')}:\\d+: 13000（换算值 13000）`),
      ],
    },
    { cwd: dir, positiveOut: /阈值收敛检查通过/ }
  )
})

// ---------------------------------------------------------------- N10 check:capabilities --strict（#453 第 2 优先）

test('N10 check:capabilities：--strict 咬得住（注入低内核用法 → exit 1 且点名 文件:行），warn 档同一份注入仍 exit 0', (t) => {
  const gate = commandOf('check:capabilities')
  // CI 现在跑的就是这条**不带参数的** warn 档 —— 它必须恒 exit 0（这正是 #413 记的缺口），
  // 一旦有人把它改成 `--strict`，这条断言会红，提示回来删掉 KNOWN_GAPS 里那条。
  assert.match(
    gate.raw,
    /^node scripts\/check-capabilities\.mjs$/,
    `check:capabilities 的命令行变了（现在是 \`${gate.raw}\`）——如果 CI 已经改 --strict，请把 KNOWN_GAPS 那条删掉并更新本用例`
  )

  // 为什么用 `--root <fixture>`：真仓库现在**本来就是 --strict exit 1**（基线 10 处缺陷，见下面第 ⑤ 拍），
  // 所以「注入 → 红」在真仓库上证明不了任何事（红在存量上）。脚本自带 `--root`（就是给测试留的口子），
  // 于是四拍可以完全脱离真仓库：干净 fixture → exit 0；注入 → exit 1 且点名注入的那一行；删掉 → exit 0。
  const dir = scratch('capabilities')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const srcDir = path.join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'ok.ts'), 'export const probeAnswer = 42\n')
  const probeRel = 'src/__gate-neg-capabilities-probe.ts'
  const probeFile = path.join(dir, probeRel)
  const runGate = (extra) => run(commandOf('check:capabilities', ['--root', dir, ...extra]))

  // ① 正例：干净 fixture root → --strict exit 0（没有这一拍，后面的 exit 1 可能只是「恒红」）
  const clean = runGate(['--strict'])
  assert.equal(clean.status, 0, `干净 fixture 上 --strict 必须 exit 0\n${clean.out}`)
  assert.match(clean.out, /✅ 四类盘点都没有缺陷/, `正例要能看出「真的扫了且没缺陷」\n${clean.out}`)

  // ② 注入「低内核不支持」的能力用法（#453 点名的形态之一：Promise.withResolvers 首支持 Chromium 119）。
  //    同时钉住「判据不是见 at 就报」：Array.prototype.at 也是 92，但入口 polyfill 装了它 → 不算缺陷。
  try {
    writeFileSync(
      probeFile,
      [
        '// 低内核（Android WebView 83）不支持：Promise.withResolvers 首支持 Chromium 119，入口 polyfill 没补',
        'export const deferred = Promise.withResolvers()',
        '',
        '// Array.prototype.at 也是 92，但 polyfill 装了它 —— 这一行不该被算成缺陷',
        'export const legacyFirst = [1, 2, 3].at(-1)',
        '',
      ].join('\n')
    )

    // ③a --strict：必须 exit 1，且**点名注入的文件:行 + 那条判据**
    const strict = runGate(['--strict'])
    assert.notEqual(strict.status, 0, `--strict 在注入低内核用法后必须 exit≠0（负向对照失效 = 恒绿）\n${strict.out}`)
    assert.match(
      strict.out,
      /\[api\] src\/__gate-neg-capabilities-probe\.ts:2  Promise\.withResolvers 存在（首支持 Chromium 119，无兜底）/,
      `--strict 的红必须点到「注入的文件:行」与「哪一条能力」\n${strict.out}`
    )
    assert.match(strict.out, /各类缺陷数：api 1 /, `缺陷数必须正好 1（.at 被 polyfill 覆盖了，不该算缺陷）\n${strict.out}`)

    // ③b 同一份注入下的 warn 档（= CI 现在跑的那条命令）：**exit 0，但缺陷清单照旧列出来**
    //     —— 这就是 KNOWN_GAPS #413 说的「结构上恒绿」：扫描器在工作，CI 那道门却咬不住。
    const warn = runGate([])
    assert.equal(warn.status, 0, `warn 档必须恒 exit 0（这就是 #413 的缺口；它一旦变红，请回来更新 KNOWN_GAPS）\n${warn.out}`)
    assert.match(warn.out, /⚠ 1 处能力假设缺陷/, `warn 档必须把缺陷列出来（只是不拦截）\n${warn.out}`)
    assert.match(
      warn.out,
      /\[api\] src\/__gate-neg-capabilities-probe\.ts:2/,
      `warn 档必须点名同一处缺陷 —— 否则「恒绿」的原因是「它根本没扫到」，性质完全不同\n${warn.out}`
    )
  } finally {
    // ④ 还原（探针在临时目录里，仍然显式删除，后面的 ⑤ 拍就是「还原后必须绿」的证明）
    rmSync(probeFile, { force: true })
  }

  // ⑤ 还原后重新 exit 0（证明 ③ 的红是注入引起的）
  const again = runGate(['--strict'])
  assert.equal(again.status, 0, `还原后 --strict 必须回到 exit 0\n${again.out}`)

  // ⑥ 真仓库口径：两档互不矛盾 —— warn 恒 0；--strict 在「有缺陷」时必须 1、在「没缺陷」时必须 0。
  //    这一拍不写死「现在有 10 处缺陷」（那是 #413 各 lane 的进度），而是从输出里**读出**缺陷数再判，
  //    所以 lane 全部落地后它照样绿；反过来若 --strict 判据被改软（缺陷 >0 却不红），它立刻红。
  const realWarn = run(commandOf('check:capabilities'))
  assert.equal(realWarn.status, 0, `真仓库 warn 档必须 exit 0（CI 跑的就是这一档）\n${realWarn.out}`)
  const scanned = /扫描范围：src\/\*\* 共 (\d+) 个文件/.exec(realWarn.out)
  assert.ok(Number(scanned?.[1] ?? 0) >= 100, `真仓库应扫到 ≥100 个 src 文件（实测 ${scanned?.[1]}）—— 扫不动就是口径坏了\n${realWarn.out}`)
  const defects = Number(/合计 (\d+)/.exec(realWarn.out)?.[1] ?? 0)
  const realStrict = run(commandOf('check:capabilities', ['--strict']))
  assert.equal(
    realStrict.status,
    defects > 0 ? 1 : 0,
    `真仓库有 ${defects} 处缺陷，--strict 却 exit ${realStrict.status} —— 两档口径不一致（warn 恒 0 是设计，strict 恒 0 是坏了）\n${realStrict.out}`
  )
  if (defects > 0) {
    assert.match(realStrict.out, /\[(?:api|css|host|behavior)\] src\/[^\s:]+:\d+/, `--strict 必须逐条点名 文件:行\n${realStrict.out}`)
  }
  t.diagnostic(`N10：真仓库 warn 档 exit 0 / --strict exit ${realStrict.status}（存量缺陷 ${defects} 处，不写死）`)
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
