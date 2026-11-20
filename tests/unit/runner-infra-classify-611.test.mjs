// [layer: unit | 纯 Node（子进程 + 临时仓库副本 + 合成日志），无浏览器无网络 | 耗时: ~10s]
//
// Issue #611（与 #614 的裁决）**运行器自检：基础设施崩 ≠ 用例失败**，而且不许反过来把真红洗白。
//
// ## 为什么这个文件必须存在
//
// 2026-11 CI 上出现过这种红（同一份代码本地三种跑法全绿）：
//
//     >> tests/unit/domain05-download-state-machine.test.mjs
//     #   ✓ 206 连续分块…                       ← 用例已经跑出 ✓
//     failureType: 'uncaughtException'
//     error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
//     stack: … node:internal/test_runner/runner:354 → FileTest.parseMessage
//
// 红的是 `node --test` **父进程反序列化子进程 IPC 消息失败**，不是任何一条断言。CI 把它当
// 「真红（重跑仍红）」上报，读报告的人就只能去找一个不存在的产品 bug。
//
// 判定侧（`tests/helpers/merge-verdict.mjs` 的 `classifyInfraIpc` / `withInfraRetry`）现在做两件事：
//   ① 三条判据**同时**命中 → 判 `INFRA` + 该文件单独重跑一次（重跑绿 → `INFRA-RETRIED`；重跑仍同一签名 → `INFRA-FAIL`）；
//   ② 只要有一条不命中 → 老老实实按 `TEST_FAIL` 走，**一步都不省**。
//
// ## 这个文件的拍子（缺一拍都算没测）
//
//   ① 合成 IPC 签名（假日志）→ 判 INFRA + 单跑重试一次；重跑绿 → `INFRA-RETRIED`（不进 flaky 登记簿）；
//   ② 重跑仍是同一签名 → `INFRA-FAIL`：**红保留**，措辞写「不是用例失败」+ 指向 #611；
//   ③ **负向对照（本单核心）**：真断言失败（`assert.equal(1, 2)`）→ 判定必须仍是 TEST_FAIL，**不许**被 INFRA 吞掉；
//   ④ 负向对照：把 IPC 文案**抄进**断言失败信息里 → 仍 TEST_FAIL（缺 `failureType` 判据）；
//   ⑤ 负向对照：INFRA 之后重跑出断言红（签名消失）→ 按 TEST_FAIL 上报，不许盖章成基础设施问题；
//   ⑥ run-layer **端到端**：断言红打 `<< FAIL`、签名红打 `<< FAIL(INFRA)`、重试绿打 `<< PASS(INFRA-RETRIED)`，
//      并核对 INFRA 没有被登记成 flaky。
//
// 为什么放在 `tests/unit/`：`scripts/check-test-layout.mjs` 只允许 {unit,integration,regression,device,e2e}
// 放 `*.test.mjs`，而 CI 的单元层只跑 `node tests/run-layer.mjs unit` —— 放在别处的用例等于「写了没人跑」（#368）。
// 探针与仓库副本都在**临时目录**里造，跑完就删，不往仓库里留东西。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { INFRA_IPC_SIGNATURE, classifyInfraIpc, withInfraRetry } from '../helpers/merge-verdict.mjs'
import { runCase } from '../helpers/runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 合成日志：一次「runner 自己崩了」的完整证据块（三条判据都在里面） */
const IPC_FAKE_LOG = [
  'not ok 1 - tests/unit/domain05-download-state-machine.test.mjs',
  '  ---',
  "  failureType: 'uncaughtException'",
  "  error: 'Unable to deserialize cloned data due to invalid or unsupported version.'",
  "  code: 'ERR_TEST_FAILURE'",
  '  stack: |-',
  '    Error: Unable to deserialize cloned data due to invalid or unsupported version.',
  '        at FileTest.parseMessage (node:internal/test_runner/runner:354:18)',
  '        at node:internal/test_runner/runner:512:12',
].join('\n')

const scratch = async (t, label) => {
  const dir = await mkdtemp(path.join(tmpdir(), `runner-infra611-${label}-`))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 起子进程跑命令，收齐 stdout+stderr 与退出码 */
const run = (file, args, { cwd, env }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, out }))
})

// ───────────────────────────────── 判定层（合成日志，纯函数） ─────────────────────────────────

test('#611 ① 合成 IPC 签名 → 判 INFRA 并单跑重试一次；重跑绿 → INFRA-RETRIED', async () => {
  let reruns = 0
  const says = []
  const outcome = await withInfraRetry({
    result: { ok: false, tail: [IPC_FAKE_LOG] },
    say: (line) => says.push(line),
    rerun: async () => { reruns += 1; return { ok: true, ms: 11, tail: ['# 全绿'] } },
  })
  assert.equal(outcome.infra, 'retried', '命中签名 + 重跑绿 → 必须判 INFRA-RETRIED')
  assert.equal(reruns, 1, 'INFRA 必须**单独重跑一次**（不是只打一行警告就放绿）')
  assert.equal(outcome.result.ok, true)
  assert.equal(outcome.result.infraRetried, true, '结果里要能筛出「绿在重跑上」这一条（留痕，别混进一次就绿）')
  assert.ok(says.some((line) => line.includes('#611')), `打点里必须指到 #611\n${says.join('\n')}`)
  assert.ok(says.some((line) => line.includes('不是用例失败')), `打点必须写清「不是用例失败」\n${says.join('\n')}`)
})

test('#611 ② 重跑仍是同一签名 → INFRA-FAIL：红保留，但结论是「不是用例失败」+ 指向 #611', async () => {
  let reruns = 0
  const outcome = await withInfraRetry({
    result: { ok: false, tail: [IPC_FAKE_LOG] },
    rerun: async () => { reruns += 1; return { ok: false, tail: [IPC_FAKE_LOG] } },
  })
  assert.equal(outcome.infra, 'fail', '重跑仍同一签名 → INFRA-FAIL')
  assert.equal(reruns, 1)
  assert.equal(outcome.result.ok, false, '裁决 #614：基础设施崩仍然 CI 红 —— 不许自己变绿')
  assert.equal(outcome.result.infraFail, true)
  assert.match(outcome.result.error, /不是用例失败/, '措辞必须排除「用例失败」的读法')
  assert.match(outcome.result.error, /#611/, '必须指向 #611，否则下一个人还是去改断言')
  assert.match(outcome.result.error, new RegExp(INFRA_IPC_SIGNATURE.stackIncludes.replace(/[/.]/g, '\\$&')))
})

test('#611 ③ 负向对照（本单核心）：真断言失败 1 === 2 → 仍是 TEST_FAIL，不许被 INFRA 吞掉', async (t) => {
  const dir = await scratch(t, 'assert-neg')
  const probe = path.join(dir, 'assert-probe.test.mjs')
  await writeFile(probe, `import { test } from 'node:test'
import assert from 'node:assert/strict'
// 负向对照用的探针：把 1 === 1 改成 1 === 2（就是 Issue 里点名的那种造法）
test('故意失败的断言', () => { assert.equal(1, 2, '故意失败') })
`)
  const result = await runCase(probe, { cwd: ROOT, output: false })
  assert.equal(result.ok, false, '探针必须真的红')
  assert.match(result.output, /故意失败/, `红的原因必须是断言（不是启动/环境问题）\n${result.output}`)
  const judged = classifyInfraIpc(result)
  assert.equal(judged.infra, false, `断言失败被判成 INFRA 了 —— 这就是「用基础设施掩码吞真红」\n${JSON.stringify(judged.checks)}\n${result.output}`)

  let reruns = 0
  const outcome = await withInfraRetry({
    result,
    rerun: async () => { reruns += 1; return { ok: true } },
  })
  assert.equal(outcome.infra, 'none', '没命中签名就不该走 INFRA 路径')
  assert.equal(reruns, 0, '断言失败不许触发「INFRA 单跑重试」这一套（那是给 runner 崩溃用的）')
  assert.equal(outcome.result.ok, false, '结局仍是 TEST_FAIL（红）')
})

test('#611 ④ 负向对照：把 IPC 文案抄进断言失败信息里 → 仍 TEST_FAIL（缺 failureType 判据）', async (t) => {
  const dir = await scratch(t, 'copied-text-neg')
  const probe = path.join(dir, 'copied-text-probe.test.mjs')
  await writeFile(probe, `import { test } from 'node:test'
import assert from 'node:assert/strict'
// 断言失败信息里**故意**夹带 IPC 那句文案：只靠「文案命中」判 INFRA 的话，这条真红会被吞掉
test('文案一样，但这是断言失败', () => {
  assert.equal(1, 2, 'Unable to deserialize cloned data due to invalid or unsupported version')
})
`)
  const result = await runCase(probe, { cwd: ROOT, output: false })
  assert.equal(result.ok, false)
  const judged = classifyInfraIpc(result)
  assert.equal(judged.infra, false, `光有文案不构成 INFRA（还要求 failureType=uncaughtException 且 stack 在 runner 内部）\n${JSON.stringify(judged.checks)}`)
  assert.equal(judged.checks.find((check) => check.key === 'failureType').ok, false, '断言失败的 failureType 是 testCodeFailure')
  const outcome = await withInfraRetry({ result, rerun: async () => assert.fail('不许重跑') })
  assert.equal(outcome.infra, 'none')
})

test('#611 ⑤ 负向对照：INFRA 之后重跑出断言红（签名消失）→ 按 TEST_FAIL 上报，不许盖章成基础设施问题', async () => {
  const outcome = await withInfraRetry({
    result: { ok: false, tail: [IPC_FAKE_LOG] },
    rerun: async () => ({ ok: false, tail: ['not ok 1 - 真断言失败', '  error: |', '    1 !== 2'] }),
  })
  assert.equal(outcome.infra, 'red-after-infra')
  assert.equal(outcome.result.ok, false, '重跑是断言红 → 依旧红')
  assert.equal(Boolean(outcome.result.infraFail), false, '签名不在重跑里了，就不许打 INFRA-FAIL 的标')
})

// ───────────────────────────── run-layer 端到端（临时仓库副本 + 探针） ─────────────────────────────

/** run-layer 与它 import 的 helper / 登记簿脚本（复制整仓没有意义：这一步验的是判定接线） */
// 注意：**不拷 `injected.mjs`**。它 import 仓库的 `scripts/lib/…`（.__ENDPOINTS__ 兜底），
// 在这里没有意义；runtime.mjs 的预加载是「有就带、没有就不带」，探针也用不到那些全局。
const HELPERS = [
  'runtime.mjs', 'ports.mjs', 'env.mjs',
  'tap.mjs', 'merge-verdict.mjs',
  'merged-entry.mjs', 'merged-tracker.mjs', 'merged-node-test.mjs',
]

const makeSandbox = async (t, probes) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'runner-infra611-sandbox-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'tests/helpers'), { recursive: true })
  await mkdir(path.join(dir, 'tests/unit'), { recursive: true })
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  await cp(path.join(ROOT, 'tests/run-layer.mjs'), path.join(dir, 'tests/run-layer.mjs'))
  for (const helper of HELPERS) await cp(path.join(ROOT, 'tests/helpers', helper), path.join(dir, 'tests/helpers', helper))
  await cp(path.join(ROOT, 'scripts/flaky-registry.mjs'), path.join(dir, 'scripts/flaky-registry.mjs'))
  // 登记簿一起拷：INFRA 签名条目在里面（#611 的登记是**签名**，不是文件放行）
  await cp(path.join(ROOT, 'tests/flaky-registry.json'), path.join(dir, 'tests/flaky-registry.json'))
  for (const [name, content] of Object.entries(probes)) await writeFile(path.join(dir, 'tests/unit', name), content)
  return dir
}

/** 造一个「第一次跑崩成 IPC 签名、第二次跑绿」的探针（状态存在 marker 文件里） */
const IPC_ONCE_PROBE = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const state = process.env.INFRA611_STATE
const seen = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0
writeFileSync(state, String(seen + 1))
if (seen === 0) {
  // 人为构造 IPC 签名（Issue #611 允许的造法：真实那次的日志是这个形状）
  console.error("failureType: 'uncaughtException'")
  console.error("error: 'Unable to deserialize cloned data due to invalid or unsupported version.'")
  console.error("code: 'ERR_TEST_FAILURE'")
  console.error('    at FileTest.parseMessage (node:internal/test_runner/runner:354:18)')
  process.exit(1)
}
console.log('第二次跑：绿')
`

/** 每次都崩成 IPC 签名（重跑仍红 → INFRA-FAIL）：与 IPC_ONCE_PROBE 只差「不读状态、永远第一拍」 */
const IPC_ALWAYS_PROBE = `console.error("failureType: 'uncaughtException'")
console.error("error: 'Unable to deserialize cloned data due to invalid or unsupported version.'")
console.error("code: 'ERR_TEST_FAILURE'")
console.error('    at FileTest.parseMessage (node:internal/test_runner/runner:354:18)')
process.exit(1)
`

test('#611 ⑥ run-layer 端到端：断言红仍是 FAIL（不是 FAIL(INFRA)）—— 负向对照', async (t) => {
  const dir = await makeSandbox(t, {
    'zz-assert-probe.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('故意失败的断言', () => { assert.equal(1, 2, '故意失败') })
`,
  })
  const result = await run(path.join(dir, 'tests/run-layer.mjs'), ['unit', '--case', 'zz-assert-probe.test.mjs', '--jobs', '1', '--no-record'], { cwd: dir })
  assert.equal(result.code, 1, `断言红必须 exit=1\n${result.out}`)
  assert.match(result.out, /<< FAIL tests\/unit\/zz-assert-probe\.test\.mjs/, `断言红必须打 << FAIL\n${result.out}`)
  assert.doesNotMatch(result.out, /FAIL\(INFRA\)/, `断言红不许被打成 FAIL(INFRA)\n${result.out}`)
  assert.doesNotMatch(result.out, /命中 runner IPC 签名/, `断言红不该触发 INFRA 判定（三条判据第一步就不命中）\n${result.out}`)
  assert.match(result.out, /INFRA-RETRIED 0, INFRA-FAIL 0/, `汇总里 INFRA 两份名单都必须是 0\n${result.out}`)
  assert.match(result.out, /故意失败/, `失败原因必须还是那条断言\n${result.out}`)
})

test('#611 ⑦ run-layer 端到端：IPC 签名 → 单跑重试通过 → PASS(INFRA-RETRIED)，且不登记 flaky', async (t) => {
  const dir = await makeSandbox(t, { 'zz-infra-once-probe.test.mjs': IPC_ONCE_PROBE })
  const result = await run(
    path.join(dir, 'tests/run-layer.mjs'),
    ['unit', '--case', 'zz-infra-once-probe.test.mjs', '--jobs', '1', '--no-record'],
    { cwd: dir, env: { ...process.env, INFRA611_STATE: path.join(dir, 'state.txt') } },
  )
  assert.equal(result.code, 0, `重跑通过就该是绿的\n${result.out}`)
  assert.match(result.out, /命中 runner IPC 签名（#611）/, `必须先认出来是 runner 崩了\n${result.out}`)
  assert.match(result.out, /<< PASS\(INFRA-RETRIED\) tests\/unit\/zz-infra-once-probe\.test\.mjs/, `状态必须是 PASS(INFRA-RETRIED)\n${result.out}`)
  assert.match(result.out, /INFRA-RETRIED 1/, `汇总里要有 INFRA-RETRIED 计数\n${result.out}`)
  // 「绿在重跑上」不能被记成 flaky（那会把 runner 的崩溃记到一个没问题的文件头上）
  const registry = JSON.parse(await readFile(path.join(dir, 'tests/flaky-registry.json'), 'utf8'))
  assert.equal(registry.tests['tests/unit/zz-infra-once-probe.test.mjs'], undefined, `INFRA-RETRIED 不许进 flaky 登记簿\n${JSON.stringify(registry.tests)}`)
  assert.ok(registry.infraSignatures?.length, '登记簿里要有按**签名**登记的 INFRA 条目（不是文件放行）')
  assert.equal(registry.infraSignatures[0].match.message, INFRA_IPC_SIGNATURE.message, '登记簿里的签名与判定层用的是同一份定义')
  assert.deepEqual(registry.infraSignatures[0].tests, [], 'INFRA 登记是签名，不放行任何文件')
})

test('#611 ⑧ run-layer 端到端：IPC 签名 + 重跑仍同一签名 → FAIL(INFRA)（红保留，措辞指向 #611）', async (t) => {
  const dir = await makeSandbox(t, { 'zz-infra-always-probe.test.mjs': IPC_ALWAYS_PROBE })
  const result = await run(path.join(dir, 'tests/run-layer.mjs'), ['unit', '--case', 'zz-infra-always-probe.test.mjs', '--jobs', '1', '--no-record'], { cwd: dir })
  assert.equal(result.code, 1, `裁决 #614：重跑仍崩 → CI 红\n${result.out}`)
  assert.match(result.out, /<< FAIL\(INFRA\) tests\/unit\/zz-infra-always-probe\.test\.mjs/, `状态必须是 FAIL(INFRA)，不能是普通的 FAIL\n${result.out}`)
  assert.match(result.out, /不是用例失败/, `结论必须写清「不是用例失败」\n${result.out}`)
  assert.match(result.out, /#611/, `结论必须指向 #611\n${result.out}`)
  assert.match(result.out, /INFRA-FAIL 1/, `汇总里要有 INFRA-FAIL 计数\n${result.out}`)
  const registry = JSON.parse(await readFile(path.join(dir, 'tests/flaky-registry.json'), 'utf8'))
  assert.equal(registry.tests['tests/unit/zz-infra-always-probe.test.mjs'], undefined, `INFRA-FAIL 也不许把自己写成 flaky（那是另一套账）\n${JSON.stringify(registry.tests)}`)
})
