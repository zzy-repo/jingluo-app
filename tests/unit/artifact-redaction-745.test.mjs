// [layer: unit | 纯 Node（子进程 + 临时目录），无浏览器无网络 | 耗时: ~1s]
//
// Issue #745：公开发布物里**不得出现内网地址**。
//
// 这个文件钉的是「门禁真的会咬」，不是「脚本能跑」：
//   [1] 只含基线内合法存量 → exit 0（否则存量会逼人往门禁里加 continue-on-error）
//   [2] 产物里**新塞**一条内网地址 → exit 1 且点名（这才是要防的：以后又固化一个）
//   [3] 基线条目消失 → 只 WARN 提醒删基线，**不红**（只减不增，但别让基线腐烂）
//   [4] 判不出来（目录不存在）→ exit 2（fail-closed，别静默通过）
//
// 负向对照（人工各跑一次，结论同 [2]）：把 `RE_BARE_HOST` 里的主机名删掉 → [2] 变绿（说明它靠这条正则）；
// 把 baseline 里 count 调大 → [2] 也变绿（说明次数上限真的在比）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-artifact-redaction.mjs')

/** 跑门禁，返回 { code, out }（**不抛**，退出码是断言对象） */
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const mkArtifact = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-redaction-test-'))
  mkdirSync(path.join(dir, 'static', 'js'), { recursive: true })
  writeFileSync(path.join(dir, 'static', 'js', 'main.js'), body, 'utf8')
  return dir
}

/** 与 checkout 里的基线保持一致的「合法存量」样本 —— 若基线改了，这里要跟着改（故意的：逼同步） */
const BASELINE_SAMPLE = [
  'var a = "http://140.210.13.146:60010";',
  'var b = "http://140.210.13.146:60010";',
  'var c = "http://140.210.13.146:60012";',
  'var d = "http://140.210.13.146:60012";',
  'var e = "http://140.210.13.146:60013";',
  'var f = "http://62.106.70.167:8888";',
  'var g = "http://62.106.70.167:8888";',
  'var h = ["62.106.70.167"];',
  'var i = ["62.106.70.167"];',
].join('\n')

test('[1] 只含基线内的存量 → exit 0（存量不该把 main 打红）', () => {
  const dir = mkArtifact(BASELINE_SAMPLE)
  try {
    const { code, out } = run(['--dir', dir])
    assert.equal(code, 0, `应通过，实际 exit=${code}\n${out}`)
    assert.match(out, /PASS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[2] 产物里新塞一条内网地址 → exit 1 且点名（这是门禁存在的理由）', () => {
  const dir = mkArtifact(`${BASELINE_SAMPLE}\nvar leak = "http://10.9.8.7:60010";\n`)
  try {
    const { code, out } = run(['--dir', dir])
    assert.equal(code, 1, `应判红，实际 exit=${code}\n${out}`)
    assert.match(out, /10\.9\.8\.7:60010/, '必须点名那条新地址')
    assert.match(out, /基线外的新内网地址/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[2b] 基线内条目次数变多 → 也判红（同一个地址被固化更多份也是退化）', () => {
  const dir = mkArtifact(`${BASELINE_SAMPLE}\nvar more = "http://140.210.13.146:60013";\nvar more2 = "http://140.210.13.146:60013";\n`)
  try {
    const { code, out } = run(['--dir', dir])
    assert.equal(code, 1, `应判红，实际 exit=${code}\n${out}`)
    assert.match(out, /基线内条目出现次数变多/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[3] 基线条目在产物里消失 → 只 WARN 不红（只减不增，但提示清理基线）', () => {
  const dir = mkArtifact('var clean = "https://sub2api.rose7.cn";\n')
  try {
    const { code, out } = run(['--dir', dir])
    assert.equal(code, 0, `应通过（只剩 WARN），实际 exit=${code}\n${out}`)
    assert.match(out, /\[WARN\]/)
    assert.match(out, /只减不增/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[4] 判不出来 → exit 2（fail-closed，不许静默通过）', () => {
  const { code, out } = run(['--dir', path.join(tmpdir(), 'artifact-redaction-does-not-exist-745')])
  assert.equal(code, 2, `应 exit 2，实际 exit=${code}\n${out}`)
  assert.match(out, /产物目录不存在/)
})
