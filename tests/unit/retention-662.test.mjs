// [layer: unit | 依赖: 无（纯 Node，临时目录造盘） | 耗时: <2s]
//
// #662 —— 分发机保留策略的到期检查（`scripts/check-retention.mjs`）。
//
// 这个脚本是「过期了就一定有人被告知」的唯一机制：它跑在**分发机**上，读
// `<目录>/.retention.json` 的账本。所以本文件不测「账本写得漂不漂亮」，只钉
// **每种状态到底判红还是判绿** —— 因为判错方向的代价不对称：
//
//   · 该红没红（过期条目被放过）→ 孤儿包与取证物永远不清，回到 #662 之前的原点；
//   · 该绿判红（未过期条目判红）→ 运维每天看到一条假红，然后学会忽略它，
//     门禁等于没有（这是本项目里反复出现的失效模式）。
//
// 关键的一条是**负向对照**（第 2 条用例）：把某一行的 `deleteAfter` 改成昨天，
// CLI 必须 exit 1。没有这条，「脚本存在」和「脚本生效」没有区别。
//
// 断言口径与 `scripts/check-retention.mjs` 文件头的「判据」一节逐条对应：
//   EXPIRED / REVIEW-DUE / BAD-LEDGER / DRIFT → 需要处理（exit 1）
//   MISSING（文件已不在）/ SKIP（目录不在本机）→ 不判红（exit 0）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_TARGETS, evaluateTarget, parseDay } from '../../scripts/check-retention.mjs'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-retention.mjs')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 造一个「目录 + 账本」的临时现场；`files` 是 {相对路径: 内容}。 */
async function fixture(files, entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'retention-662-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  const ledger = path.join(dir, '.retention.json')
  await writeFile(ledger, JSON.stringify({ _meta: { version: 1, title: 't' }, ...entries }, null, 2))
  return { dir, ledger }
}

const entry = (content, extra = {}) => ({ sha256: sha256(content), size: Buffer.byteLength(content), addedAt: '2026-11-21', ...extra })

/** 跑 CLI，返回 {code, stdout, stderr}（不抛，方便直接断言退出码）。 */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: ROOT })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('默认账本对就是分发机上那两个目录（/opt/dl-private/private、/opt/dl-leak-evidence）', () => {
  assert.deepEqual(
    DEFAULT_TARGETS.map((t) => t.dir),
    ['/opt/dl-private/private', '/opt/dl-leak-evidence'],
  )
  for (const t of DEFAULT_TARGETS) {
    assert.equal(t.ledger, path.join(t.dir, '.retention.json'), '账本固定落在目录内（跟着文件一起搬）')
  }
})

test('负向对照：把一条 deleteAfter 改成昨天 → 必须 EXPIRED 且 CLI exit 1', async () => {
  const f = await fixture(
    { 'a.apk': 'A', 'b.apk': 'B' },
    {
      'a.apk': entry('A', { deleteAfter: '2026-12-21' }),
      'b.apk': entry('B', { deleteAfter: '2026-11-20' }),
    },
  )
  try {
    const today = parseDay('2026-11-21')
    const res = await evaluateTarget({
      dir: f.dir,
      ledger: f.ledger,
      doc: JSON.parse(await readFile(f.ledger, 'utf8')),
      today,
      // 注入「文件都还在且内容相符」，让这一条只测过期判定，不被 DRIFT 干扰
      inspect: async (abs) => {
        const content = path.basename(abs) === 'a.apk' ? 'A' : 'B'
        return { size: Buffer.byteLength(content), sha256: sha256(content) }
      },
    })
    // 直接判定层：两条都要在，只有 b 是 EXPIRED
    assert.deepEqual(res.problems.map((p) => p.file), ['b.apk'])
    const expired = res.problems[0]
    assert.equal(expired.status, 'EXPIRED')
    assert.match(expired.detail, /已过期 1 天/)

    // CLI 层（真正被运维敲的那条命令）：exit 1，并且点名那个文件
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(out.code, 1, '过期条目必须让 exit code 变 1 —— 否则「到期检查」等于没有')
    assert.match(out.stderr, /EXPIRED/)
    assert.match(out.stderr, /b\.apk/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('未过期 → exit 0，并打印剩余天数（不是「什么都没说」）', async () => {
  const f = await fixture({ 'a.apk': 'A' }, { 'a.apk': entry('A', { deleteAfter: '2026-12-21' }) })
  try {
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21', '--verbose'])
    assert.equal(out.code, 0)
    assert.match(out.stdout, /还剩 30 天/)
    assert.match(out.stdout, /check:retention OK/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('deleteAfter 恰好是今天 → 仍算未到期（当天到期当天处理，不能提前一天红）', async () => {
  const f = await fixture({ 'a.apk': 'A' }, { 'a.apk': entry('A', { deleteAfter: '2026-11-21' }) })
  try {
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(out.code, 0)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('条件到期（#601 取证物）：有 deleteAfterRule + 未到 reviewAfter → 绿；过了 → REVIEW-DUE 红', async () => {
  const entries = {
    'LEAKED.json': {
      ...entry('L'),
      deleteAfter: null,
      deleteAfterRule: '事故复盘关闭后 30 天',
      reviewAfter: '2026-12-21',
    },
  }
  const f = await fixture({ 'LEAKED.json': 'L' }, entries)
  try {
    const before = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(before.code, 0, '复核日未到：取证物不该被判红')

    const after = await cli(['--dir', f.dir, '--now', '2026-12-22'])
    assert.equal(after.code, 1, '复核日过了还没人确认 → 必须红（逼人做判断，而不是静默无限期保留）')
    assert.match(after.stderr, /REVIEW-DUE/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('deleteAfter 为 null 又没有 reviewAfter → BAD-LEDGER 红（「无限期保留」正是 #662 要消灭的东西）', async () => {
  const f = await fixture(
    { 'x.bin': 'X' },
    { 'x.bin': { ...entry('X'), deleteAfter: null, deleteAfterRule: '有一天吧' } },
  )
  try {
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(out.code, 1)
    assert.match(out.stderr, /BAD-LEDGER/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('sha256 与账本不符 → DRIFT 红（账本对不上就不再是可追溯凭据）', async () => {
  const f = await fixture(
    { 'a.apk': 'A' },
    { 'a.apk': { ...entry('A'), deleteAfter: '2026-12-21', sha256: sha256('A') } },
  )
  try {
    // 文件在账本之后被替换
    await writeFile(path.join(f.dir, 'a.apk'), 'TAMPERED')
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(out.code, 1)
    assert.match(out.stderr, /DRIFT/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('文件已不在（按账删掉了）→ MISSING 但 exit 0，提醒把条目划掉', async () => {
  const f = await fixture({}, { 'gone.apk': entry('G', { deleteAfter: '2026-12-21' }) })
  try {
    const out = await cli(['--dir', f.dir, '--now', '2026-11-21'])
    assert.equal(out.code, 0, '已经照账删掉的文件不该让运维持续看到红')
    assert.match(out.stdout, /MISSING/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('目录不在本机（开发机 / CI）→ 全部 SKIP 且 exit 0，不是失败', async () => {
  const missing = path.join(tmpdir(), 'retention-662-absent-does-not-exist')
  const out = await cli(['--dir', missing])
  assert.equal(out.code, 0)
  assert.match(out.stdout, /SKIP/)
})

test('账本不是合法 JSON → exit 2（用法/环境错误，与「有过期条目」区分开）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'retention-662-'))
  try {
    await writeFile(path.join(dir, '.retention.json'), '{ not json')
    const out = await cli(['--dir', dir])
    assert.equal(out.code, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
