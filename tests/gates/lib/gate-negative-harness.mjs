// 门禁负向对照的统一骨架（Issue #369）。
//
// ## 为什么需要这一层
//
// 门禁「绿」有两种坏的成因，症状完全一样，所以必须分别钉住：
//
//   A 门禁脚本自己坏了 —— 规则被删 / 被改宽 / 只对眼熟写法生效；
//     表现：真违规也判合格，CI 依旧绿。
//   B 门禁还在跑，但**命令行**被换成不检查任何东西（`"lint": "echo ok"`、
//     `"check:x": "node scripts/check-x.mjs --warn"` 悄悄加了 --warn、少传一个目录）。
//     表现：脚本是好的，但没人真的检查，CI 依旧绿。
//
// 只断言「注入缺陷 → exit≠0」只能钉住 A：如果 script 已经被改成 `true`，注入进去也照样绿？
// 不，会红 —— 但反过来，如果 script 被改成 `node -e 0`，注入缺陷仍然 exit 0，所以 A 的断言会红。
// 真正的盲区是 B 的另一半：**命令行指向了别的地方**（少传目录、加了豁免开关、只查 1 个文件），
// 此时注入的缺陷恰好落在「不检查」的那部分，A 的断言也会红 —— 除非注入点刚好在检查范围内。
//
// 所以模板固定成四拍，并且**命令行从 package.json 的 script 字符串解析**（而不是测试里再写一份）：
//
//     ① 正例：干净仓库 → exit=0
//     ② 注入：把 fixture 拷成「真文件」（或往临时副本里注入）
//     ③ 红：exit≠0，且报错**点出注入的那一处**（红在别的原因上不算数）
//     ④ 还原 → exit=0（证明「红」不是恒红）
//
// ②③ 之间顺带覆盖 B：`scriptExpect` 断言 script 字符串没被换成别的东西（换成 `true` /
// 换来 `--warn` / 少传目录都会在这里先红），因为「门禁被改软」比「门禁坏掉」更隐蔽。
//
// ## 为什么不放在 tests/gates/*.test.mjs 里直接跑
//
// `tests/gates/` 只放 fixture 与这份骨架，可执行用例在 `tests/unit/gate-negative-controls.test.mjs`：
//   · `scripts/check-test-layout.mjs` 只允许 `tests/{unit,integration,regression,device,e2e}/` 放
//     `*.test.mjs`，且层级目录内不许建子目录 —— 新建 `tests/gates/*.test.mjs` 会立刻被它判成
//     `layer-placement` + `orphan`（exit 1，而且是**硬规则**、不可基线化）。给门禁加一个它自己也
//     拦不住的新目录，等于先用特例开个口子，后面每个人都能照着开。
//   · 更关键的是「谁跑它」：CI 的单元层只跑 `pnpm test`（= `node tests/run-layer.mjs unit`）。
//     任何不在 LAYERS 里的目录，写多少用例都是 #368 那个坑：**写了、没人跑、不会红**。
//     这条 issue 本身治的就是这个病，不能一边治一边再犯一次。
//   因此：用例放 `tests/unit/`（`run-layer` 枚举得到、CI 每次跑），注入物与 fixture 放 `tests/gates/`。
//   单独跑：`node --test tests/unit/gate-negative-controls.test.mjs`
//          `node tests/run-layer.mjs unit --only gate-negative-controls`
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（tests/gates/lib → ../../..） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
/** 负向对照的 fixture 根目录 */
export const FIXTURES = path.join(ROOT, 'tests/gates/fixtures')
/** 门禁的 npm script 表（package.json 是唯一来源，测试里不再抄一份命令） */
export const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 一次性临时目录；调用方负责 rmSync（用 t.after 或 try/finally，别留给下一个人） */
export const scratch = (label) => mkdtempSync(path.join(tmpdir(), `gate-neg-${label}-`))

/**
 * `package.json` 的 script 字符串 → 可直接 spawn 的命令。
 * 首 token 是 `node` 就走当前 node（`scripts/build.mjs` 这类包装脚本），否则走 `node_modules/.bin/`。
 * 不经 shell、不经包管理器：和 `pnpm run <script>` 同一份可执行文件，但不用解析 pnpm 的输出前缀。
 */
export function commandOf(scriptName, extraArgs = []) {
  const raw = PKG.scripts?.[scriptName]
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`package.json 的 scripts.${scriptName} 不见了 —— 门禁被删掉或改名了（#369）`)
  }
  const tokens = raw.trim().split(/\s+/)
  const head = tokens[0]
  const bin =
    head === 'node'
      ? process.execPath
      : path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${head}.cmd` : head)
  return { raw: raw.trim(), bin, args: [...tokens.slice(1), ...extraArgs] }
}

/** 跑一条命令，返回 { status, out, timedOut }。`out` 已把 stderr 并进 stdout，断言只看一处。 */
export function run(command, { cwd = ROOT, timeoutMs = 240_000, env = {} } = {}) {
  const result = spawnSync(command.bin, command.args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    // 与 unit 层同一套 locale（#179 的中文文案断言历史）
    env: { ...process.env, LANG: process.env.LANG ?? 'zh_CN.UTF-8', ...env },
  })
  return {
    status: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    spawnError: result.error ?? null,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** 把 fixture 拷成仓库里的「真文件」——门禁只认真实路径，所以必须落在它扫的位置 */
export function copyFixture(relFixture, relTarget) {
  const from = path.join(FIXTURES, relFixture)
  const to = path.join(ROOT, relTarget)
  if (!existsSync(from)) throw new Error(`fixture 不存在：tests/gates/fixtures/${relFixture}`)
  mkdirSync(path.dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from))
  return to
}

/** 删掉注入物（还原）。目录与文件都收，`force` 保证重复调用不炸。 */
export function removePath(relTarget) {
  rmSync(path.join(ROOT, relTarget), { recursive: true, force: true })
}

/** 断言输出里不该出现「门禁命令自己坏了」的痕迹（缺依赖 / 参数被拒 / tsconfig 没加载） */
const BROKEN_GATE_OUT = /Cannot find (?:module|type definition)|MODULE_NOT_FOUND|未知参数|用法：|TS5112/

/**
 * 四拍模板本体：正例 → 注入 → 红（且红对地方）→ 还原 → 绿。
 *
 * @param {object} row 表里的一行，见 tests/unit/gate-negative-controls.test.mjs 的 ROWS
 * @param {object} hooks { positiveArgs?, negativeArgs?, positiveOut?, negativeOut?, cwd? }
 */
export function assertNegativeControl(row, hooks = {}) {
  const positiveArgs = hooks.positiveArgs ?? []
  const negativeArgs = hooks.negativeArgs ?? []
  const cwd = hooks.cwd ?? ROOT
  const positive = () => run(commandOf(row.script, positiveArgs), { cwd })

  // ① 正例：干净仓库必过。没有这一拍，「注入→红」可能只是因为门禁恒红。
  const clean = positive()
  if (clean.spawnError) throw new Error(`${row.gate} 正例没跑起来（缺依赖？先 pnpm install）：${clean.spawnError.message}`)
  if (clean.status !== 0) {
    throw new Error(`${row.gate} 正例必须 exit=0（干净仓库不该红）\n--- 输出 ---\n${clean.out}`)
  }
  if (hooks.positiveOut) {
    if (!hooks.positiveOut.test(clean.out)) {
      throw new Error(`${row.gate} 正例输出里应能看出「它真的检查了」（${hooks.positiveOut}）\n--- 输出 ---\n${clean.out}`)
    }
  }
  if (BROKEN_GATE_OUT.test(clean.out)) {
    throw new Error(`${row.gate} 正例的输出里有「门禁命令本身坏了」的痕迹（缺依赖 / 用法错误）\n--- 输出 ---\n${clean.out}`)
  }

  // ②③ 注入 → 必须红，且红在注入的那一处上。
  let undo = () => {}
  try {
    undo = row.inject() ?? undo
    const red = run(commandOf(row.script, negativeArgs), { cwd })
    if (red.status === 0) {
      throw new Error(
        `${row.gate}：${row.what} → 必须 exit≠0（负向对照失效 = 门禁空跑，注入物：${row.artifact}）\n--- 输出 ---\n${red.out}`
      )
    }
    // 允许一行给多条「都必须命中」的判据（`red` 可以是单个 RegExp 或数组）。
    // 为什么要数组：有些门禁在 GitHub Actions 上会换成**注解格式**输出（oxlint 认 GITHUB_ACTIONS），
    // 诊断头里的文件名会被 runner 吞掉 —— 只认「文件路径」的断言在本地绿、在 CI 红。
    // 那种情况改成「规则族 + 错误条数」两条稳定判据，断言的仍是「红在注入的那一处」。
    for (const pattern of Array.isArray(row.red) ? row.red : [row.red]) {
      if (!pattern.test(red.out)) {
        throw new Error(
          `${row.gate}：exit≠0 了，但报错没点出注入的那一处（期望 ${pattern}）—— 很可能红在别的原因上\n--- 输出 ---\n${red.out}`
        )
      }
    }
    if (BROKEN_GATE_OUT.test(red.out)) {
      throw new Error(`${row.gate}：红的原因是「门禁命令本身坏了」，不是「检测到缺陷」\n--- 输出 ---\n${red.out}`)
    }
    if (hooks.negativeOut) hooks.negativeOut(red)
    // 注入物还在场时的额外断言（例如「同一份注入只该被这一道门禁拦下」）
    if (row.alsoWhileInjected) row.alsoWhileInjected()
  } finally {
    // ④ 还原必须发生在断言失败时也一样：用例红了不能把仓库留在「有违规文件」的状态，
    //    否则下一个人跑 check:hygiene / check:test-layout 会看到一条与他不相干的红。
    undo()
  }

  // ⑤ 还原后重新绿：这一步才证明「红」是注入引起的，不是恒红。
  const again = positive()
  if (again.status !== 0) {
    throw new Error(
      `${row.gate}：还原后必须 exit=0（残留了 ${row.artifact}？）\n--- 输出 ---\n${again.out}`
    )
  }
}
