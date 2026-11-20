// [layer: unit | 纯 Node（临时副本 + 子进程），无浏览器无网络 | 耗时: ~4s]
//
// Issue #501（P0）**运行器自检**：合并批次的判定不许把断言失败算成 pass。
//
// ## 为什么这条用例必须存在
//
// 合并批次（`tests/helpers/merged-entry.mjs` + `tests/run-layer.mjs` 的 unit 合并路径）曾经只看
// `node:test` 的 `test()` 返回的 promise 是否 reject —— 而断言失败时那个 promise **依然 fulfilled**。
// 于是 `assert.equal(1, 2)` 的用例报 `PASS tests=1 pass=1 fail=0`、退出码 0：
// 整个 unit 层「全绿」的结论建立在一个看不见断言失败的运行器上。这类 bug 不会自己暴露
// （它只会让红变绿），只能靠**负向对照**钉住 —— 所以本文件造的是「必失败用例」而不是普通用例。
//
// ## 三拍（缺一不可）
//
//   ① 正方向：合并批次里 `assert.equal(1, 2)` → run-layer 必须 `FAIL` + exit≠0；
//      同批一条真绿的用例仍报 `PASS`（证明不是「整批恒红」）。
//   ② 复核层：**用例体里看不见的失败**（`t.plan` 数量不符、`before` 钩子抛错）也必须红 ——
//      这条钉的是「判定取 node 的 TAP 报告」这一层：只包用例体是不够的，node 看得见、我们看不见的
//      失败同样不许放过。
//   ③ 负向对照：把判定**改回 #501 之前的旧逻辑**（不看用例体抛错、不读 node 的报告）→ 同一个
//      必失败用例必须重新变成 `PASS`。第 ③ 拍才证明第 ①② 拍不是「恒红」：换个角度说，
//      如果哪天有人把修复删掉，这条自检会红。
//
// 为什么在 `tests/unit/` 而不是 `tests/gates/`：`scripts/check-test-layout.mjs` 只允许
// {unit,integration,regression,device,e2e} 目录放 `*.test.mjs`，且 CI 的单元层只跑
// `node tests/run-layer.mjs unit` —— 放在别处的用例等于「写了没人跑」（#368 的坑）。
// 探针文件与仓库副本都在**临时目录**里造，跑完就删，不往 tests/ 里留东西。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runMergedBatch } from '../helpers/runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** 合并批次真正用到的 helper：runner（tests/run-layer.mjs）与合并入口都从这几个 import */
const HELPERS = [
  'runtime.mjs', 'ports.mjs', 'env.mjs',
  'tap.mjs', 'merge-verdict.mjs',
  'merged-entry.mjs', 'merged-tracker.mjs', 'merged-node-test.mjs',
]

/** 必失败：断言在**用例体里**抛错（promise 仍 fulfilled —— #501 的原始形态） */
const FAIL_PROBE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('明确该红的用例', () => { assert.equal(1, 2, '故意失败') })
`
const PASS_PROBE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('明确该绿的用例', () => { assert.equal(2, 2) })
`

const scratch = async (t, label) => {
  const dir = await mkdtemp(path.join(tmpdir(), `runner-selfcheck-${label}-`))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 起子进程跑命令，收齐 stdout+stderr 与退出码 */
const run = (file, args, { cwd }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, out }))
})

/**
 * 造一份「能跑 unit 层」的仓库副本：runner + 它 import 的 helper + 两个探针用例。
 * 只拷这几份 —— 复制整仓没有意义（这一步要验的是**判定**，不是能不能装依赖）。
 */
const makeSandbox = async (t, { patches = null, overrides = null } = {}) => {
  const dir = await scratch(t, patches ? 'patched' : 'clean')
  await mkdir(path.join(dir, 'tests/helpers'), { recursive: true })
  await mkdir(path.join(dir, 'tests/unit'), { recursive: true })
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  await cp(path.join(ROOT, 'tests/run-layer.mjs'), path.join(dir, 'tests/run-layer.mjs'))
  for (const helper of HELPERS) {
    await cp(path.join(ROOT, 'tests/helpers', helper), path.join(dir, 'tests/helpers', helper))
  }
  // run-layer 顶层就 import 它（失败重跑 → flaky 登记）
  await cp(path.join(ROOT, 'scripts/flaky-registry.mjs'), path.join(dir, 'scripts/flaky-registry.mjs'))
  await writeFile(path.join(dir, 'tests/unit/zz-fail-probe.test.mjs'), FAIL_PROBE)
  await writeFile(path.join(dir, 'tests/unit/zz-pass-probe.test.mjs'), PASS_PROBE)
  // 负向对照：把判定改回旧逻辑。**替换必须真的发生**，否则「对照」是空转的（假绿的老套路）
  for (const [rel, from, to] of patches ?? []) {
    const file = path.join(dir, 'tests/helpers', rel)
    const source = await readFile(file, 'utf8')
    assert.ok(source.includes(from), `负向对照的注入点不在了（${rel}）—— 修改法要同步更新这条对照`)
    await writeFile(file, source.replace(from, to))
  }
  for (const [rel, content] of Object.entries(overrides ?? {})) {
    await writeFile(path.join(dir, 'tests/helpers', rel), content)
  }
  return dir
}

test('#501 ① 合并批次里断言失败必须判 FAIL，同批真绿的仍报 PASS（run-layer 端到端）', async (t) => {
  const dir = await makeSandbox(t)
  const result = await run(path.join(dir, 'tests/run-layer.mjs'), ['unit', '--no-retry', '--no-record'], { cwd: dir })
  // 探针在批次里：一个文件断言必失败、一个必通过，合并成同一批跑
  assert.match(result.out, /合并批次 2 个文件/, `两个探针必须真的进了同一批（否则这条用例没测到合并路径）\n${result.out}`)
  assert.match(result.out, /<< FILE tests\/unit\/zz-fail-probe\.test\.mjs FAIL tests=1 pass=0 fail=1/, `合并批次必须把断言失败判成 FAIL\n${result.out}`)
  assert.match(result.out, /<< FILE tests\/unit\/zz-pass-probe\.test\.mjs PASS tests=1 pass=1 fail=0/, `真绿的文件仍要 PASS（不是整批恒红）\n${result.out}`)
  assert.match(result.out, /Total 2: PASS 1, FAIL 1/, `汇总必须看见 1 红 1 绿\n${result.out}`)
  assert.equal(result.code, 1, `有红就必须 exit=1（#501 的原始形态是 exit=0 + 全 PASS）\n${result.out}`)
  // 不许出现「账本不自洽」的降级噪音：正常批次的逐文件计数必须与 node 的报告完全对齐
  assert.doesNotMatch(result.out, /判定不可信/, `正常批次不该触发「账本不自洽」兜底\n${result.out}`)
})

test('#501 ② 用例体里看不见的失败（t.plan 数量不符 / 钩子抛错）也必须判 FAIL', async (t) => {
  const dir = await scratch(t, 'blindspots')
  const planProbe = path.join(dir, 'plan-mismatch.test.mjs')
  const hookProbe = path.join(dir, 'hook-throw.test.mjs')
  const greenProbe = path.join(dir, 'green.test.mjs')
  await writeFile(planProbe, `import { test } from 'node:test'
import assert from 'node:assert/strict'
// 体里只跑一条断言却声明 plan(3)：node 会判红，但用例体**不抛错**
test('plan 数量不符', (t) => { t.plan(3); assert.equal(1, 1) })
`)
  await writeFile(hookProbe, `import { test } from 'node:test'
import assert from 'node:assert/strict'
// 钩子抛错：用例体本身是绿的，红只出现在 node 的报告里
test.before(() => { throw new Error('钩子故意失败') })
test('体是绿的', () => { assert.equal(1, 1) })
`)
  await writeFile(greenProbe, PASS_PROBE)

  // 一个探针一个批次：根级 `before` 钩子在合并批次里会作用于**同批后续文件**（批次隔离的已知限制，
  // 不属 #501）。混在一批里验「红不红」会把两件事搅在一起，结论就不可信了。
  const outcomeOf = async (file) => {
    const batch = await runMergedBatch([file], { cwd: ROOT, output: false })
    assert.equal(batch.unreliable, undefined, `单文件批次的账本该自洽：${JSON.stringify(batch.unreliable)}\n${batch.output}`)
    return batch.files[0]?.outcome
  }
  assert.equal(await outcomeOf(planProbe), 'FAIL', 't.plan 数量不符 node 会判红，必须采信（只包用例体抓不到这类）')
  assert.equal(await outcomeOf(hookProbe), 'FAIL', '钩子抛错必须判红，不许因为用例体没抛错就放过')
  assert.equal(await outcomeOf(greenProbe), 'PASS', '真绿的文件仍要 PASS（不是恒红）')
})

test('#501 ③ 负向对照：把判定改回旧逻辑（不看用例体抛错、不读 node 报告）→ 自检必须变红', async (t) => {
  const dir = await makeSandbox(t, {
    // #501 之前的两处代码：
    //   · `track()` 只认 promise 兑现 —— 用例体抛错不进 failOf（下面这处补丁把它还原成 `() => null`）；
    //   · 判定只看我们自己的记账，从不读 node 的 TAP 报告（整份换掉 merge-verdict.mjs）。
    patches: [['merged-node-test.mjs', 'failOf: () => failure }', 'failOf: () => null }']],
    overrides: {
      'merge-verdict.mjs': `// 负向对照：这是 #501 之前的判定逻辑，由自检用例临时替换，**不在仓库里**
export const countsOf = ({ tracked }) => ({ tests: tracked.tests, pass: tracked.pass, fail: tracked.fail, skip: tracked.skip })
export const mismatchNotes = () => []
export const verdictOf = ({ tracked, nodeTest, scriptOk = true }) => {
  if (tracked.fail > 0) return 'FAIL'
  if (nodeTest) {
    if (tracked.tests === 0) return tracked.skip > 0 ? 'SKIP' : 'EMPTY'
    return tracked.pass > 0 ? 'PASS' : tracked.skip > 0 ? 'SKIP' : 'PASS'
  }
  return scriptOk ? 'PASS' : 'FAIL'
}
`,
    },
  })
  const failProbe = path.join(dir, 'tests/unit/zz-fail-probe.test.mjs')
  const result = await run(path.join(dir, 'tests/helpers/merged-entry.mjs'), [failProbe], { cwd: dir })
  // 这一拍就是 #501 的复现：旧逻辑下「必失败的断言」被记成 PASS、退出码 0。
  // 它红 = 有人把修复删掉/改软了；它绿 = 现在这套判定确实在起作用。
  assert.match(result.out, /<< FILE .*zz-fail-probe\.test\.mjs PASS tests=1 pass=1 fail=0/, `旧逻辑下必失败的用例应当被吞成 PASS（这条就是 #501 的复现）\n${result.out}`)
  assert.equal(result.code, 0, `旧逻辑下退出码是 0 —— 如果不是 0，说明负向对照没生效（改的那两处不在判定链上）\n${result.out}`)
})
