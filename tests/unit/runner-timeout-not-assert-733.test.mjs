// [layer: unit | 纯 Node（子进程 + 临时仓库副本 + 合成探针），无浏览器无网络 | 耗时: ~6s]
//
// Issue #733 **运行器自检：超时不等于断言失败**。
//
// ## 为什么这条用例必须存在
//
// `tests/unit/gate-negative-controls.test.mjs` 空载 ~15s（`tests/timing-baseline.json` 的 `layers.gates`），
// 负载下实测 157–340s，撞穿 runner 的批内默认超时 180s。超时后进程被停掉、没有 TAP 收尾行，
// 报告里与「断言真红」长得一模一样（`FAIL 1` + `Rerun: …`）—— 单跑 15/15 全绿，却骗着人去改断言。
// 这与 #611（INFRA）同一个病根：**「进程怎么死的」和「断言怎么红的」是两件事**。
//
// 这种 bug 不会自己暴露（它只会让报告说错话），只能靠负向对照钉住，所以本文件造的是三类探针：
//
//   ① 慢但会过（超过主预算、落在复核预算内）→ 必须报 `<< TIMEOUT` + `TIMEOUT-PASSED-ON-RERUN`，
//      汇总里 **FAIL 0**、exit 0：超时独立可见，而且「自动单跑复核」真的跑了；
//   ② 永远不结束 → 必须报 `TIMEOUT 1` 且 **exit 1**：没定性就不许当绿（超时也不是 PASS 的别名）；
//   ③ 负向对照：`assert.equal(1, 2)` → 必须仍是 `<< FAIL` + `FAIL 1`，**不许**被这套超时分类吃掉。
//      第 ③ 拍就是 #501 那条 P0（断言失败被算成 PASS）的守门人，超时改造不许把它碰软。
//
// 为什么在 `tests/unit/`：`scripts/check-test-layout.mjs` 只允许 {unit,integration,regression,device,e2e}
// 放 `*.test.mjs`，而 CI 的单元层只跑 `node tests/run-layer.mjs unit` —— 放在别处的用例等于「写了没人跑」。
// 探针与仓库副本都在**临时目录**里造，跑完就删，不往仓库里留东西。
//
// 关于「探针里为什么有定时器」：#456 禁止的是**用 sleep 顶替终态断言**；这里的定时器是**被测对象的负载**，
// 探针的全部目的就是「比主预算慢、比复核预算快」。它不进 `tests/`（临时目录里生成），也不会被门禁收编。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** run-layer 顶层 import 的这些文件必须一起拷进沙盒，否则副本起不来 */
const RUNTIME_FILES = [
  'runtime.mjs', 'ports.mjs', 'env.mjs', 'tap.mjs', 'merge-verdict.mjs',
  'merged-entry.mjs', 'merged-tracker.mjs', 'merged-node-test.mjs',
]

/** 慢但会过：450ms 断言 + 1.2s 负载 —— 主预算 300ms 必然超时，复核预算 10s 必然通过 */
const SLOW_PROBE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('慢，但终态是绿的', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(1, 1)
})
`
/** 永远不结束：复核也超时 → 只能判红（不许当绿） */
const HANG_PROBE = `import { test } from 'node:test'
test('永远不结束', () => new Promise(() => {}))
`
/** 负向对照：真断言失败，超时分类不许把它吞掉 */
const RED_PROBE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('故意失败的断言', () => { assert.equal(1, 2, '故意失败') })
`

/** 起子进程收齐输出（沙盒里的 run-layer 自己不会再被 run-layer 包一层，避免递归放大的耗时） */
const execute = (script, args, { cwd, env }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, out }))
})

/**
 * 造一份最小仓库副本：runner + 它 import 的 helper + 一条探针。
 * 副本里**没有** `tests/timing-baseline.json`，于是超时档退回内置默认档 —— 主预算靠 `--timeout-ms` 给，
 * 复核预算靠 `TEST_TIMEOUT_CONFIRM_MS` 给（两者都是显式参数，跑多快可复现）。
 */
async function sandbox(t, { probe, source }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'runner-733-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'tests/helpers'), { recursive: true })
  await mkdir(path.join(dir, 'tests/unit'), { recursive: true })
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  await cp(path.join(REPO, 'tests/run-layer.mjs'), path.join(dir, 'tests/run-layer.mjs'))
  for (const name of RUNTIME_FILES) await cp(path.join(REPO, 'tests/helpers', name), path.join(dir, 'tests/helpers', name))
  await cp(path.join(REPO, 'scripts/flaky-registry.mjs'), path.join(dir, 'scripts/flaky-registry.mjs'))
  await writeFile(path.join(dir, 'tests/unit', probe), source)
  return dir
}

const runProbe = async (dir, probe, { timeoutMs, confirmMs }) => execute(
  path.join(dir, 'tests/run-layer.mjs'),
  ['unit', '--case', `tests/unit/${probe}`, '--timeout-ms', String(timeoutMs), '--no-record'],
  { cwd: dir, env: { ...process.env, TEST_TIMEOUT_CONFIRM_MS: String(confirmMs), GITHUB_STEP_SUMMARY: '' } },
)

test('#733 ① 超时 → 独立类别 TIMEOUT + 自动单跑复核通过 ⇒ TIMEOUT-PASSED-ON-RERUN（不进 FAIL）', async (t) => {
  const dir = await sandbox(t, { probe: 'zz-slow-probe.test.mjs', source: SLOW_PROBE })
  const run = await runProbe(dir, 'zz-slow-probe.test.mjs', { timeoutMs: 300, confirmMs: 10000 })
  assert.match(run.out, /<< TIMEOUT tests\/unit\/zz-slow-probe\.test\.mjs/, `撞到超时必须先打 << TIMEOUT\n${run.out}`)
  assert.match(run.out, /不是断言失败/, `超时的结论必须写明「不是断言失败」\n${run.out}`)
  assert.match(run.out, /单跑复核命令：node tests\/run-layer\.mjs unit --case tests\/unit\/zz-slow-probe\.test\.mjs/, `必须给出可直接复跑的命令\n${run.out}`)
  assert.match(run.out, /#733 超时复核/, `必须自动进入单跑复核阶段（不是只打一行字）\n${run.out}`)
  assert.match(run.out, /TIMEOUT-PASSED-ON-RERUN/, `复核通过必须记成 TIMEOUT-PASSED-ON-RERUN\n${run.out}`)
  assert.match(run.out, /Total 1: PASS 0, FAIL 0, TIMEOUT 0, TIMEOUT-PASSED-ON-RERUN 1/, `汇总口径：超时救回来的不进 FAIL，也不混进 PASS\n${run.out}`)
  assert.equal(run.code, 0, `单跑复核通过 ⇒ 本轮不判红（否则又回到「假红」）\n${run.out}`)
})

test('#733 ② 复核也超时 ⇒ TIMEOUT 计数且判红（超时不是 PASS 的别名）', async (t) => {
  const dir = await sandbox(t, { probe: 'zz-hang-probe.test.mjs', source: HANG_PROBE })
  const run = await runProbe(dir, 'zz-hang-probe.test.mjs', { timeoutMs: 300, confirmMs: 1200 })
  assert.match(run.out, /<< TIMEOUT tests\/unit\/zz-hang-probe\.test\.mjs/, `必须先是 TIMEOUT\n${run.out}`)
  assert.match(run.out, /Total 1: PASS 0, FAIL 0, TIMEOUT 1/, `复核仍超时：TIMEOUT 计数 1、FAIL 仍是 0（类别不混）\n${run.out}`)
  assert.match(run.out, /判红合计 1 = 断言真红 0 \+ 超时 1/, `判红要能拆成两部分\n${run.out}`)
  assert.equal(run.code, 1, `没定性就不许当绿：复核仍超时必须 exit=1\n${run.out}`)
})

test('#733 ③ 负向对照：真断言失败仍是 FAIL（超时改造不许把 #501 的 P0 碰回去）', async (t) => {
  const dir = await sandbox(t, { probe: 'zz-red-probe.test.mjs', source: RED_PROBE })
  const run = await runProbe(dir, 'zz-red-probe.test.mjs', { timeoutMs: 60000, confirmMs: 10000 })
  assert.match(run.out, /<< FAIL tests\/unit\/zz-red-probe\.test\.mjs/, `断言红必须打 << FAIL（不是 TIMEOUT）\n${run.out}`)
  assert.match(run.out, /Total 1: PASS 0, FAIL 1, TIMEOUT 0, TIMEOUT-PASSED-ON-RERUN 0/, `汇总必须看见 1 条断言真红、0 条超时\n${run.out}`)
  assert.doesNotMatch(run.out, /#733 超时复核/, `没有超时就不许触发超时复核（否则等于给真红留了一条洗白通道）\n${run.out}`)
  assert.equal(run.code, 1, `断言红必须 exit=1\n${run.out}`)
  // 断言原文要留在输出里：证明判红理由仍是那条断言，不是「进程怎么死了」
  assert.match(run.out, /故意失败/, `失败原因必须还是那条断言\n${run.out}`)
})
