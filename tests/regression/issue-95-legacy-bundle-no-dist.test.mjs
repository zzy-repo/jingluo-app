// [layer: regression | 依赖: 无（子进程 + 临时目录） | Issue #95（关联 #73）]
//
// 回归对象：门禁脚本自身的退出码 —— `node scripts/check-bundle-syntax.mjs <dir>`。
//
// 修复前症状（#95）：dist 不存在 / 里面没有 JS 时，脚本 `return` 掉，退出码 0。
//   发布流水线读到 0 就当门禁过了，等于「没扫产物 = 通过」（E-1 / E-2 两条路径都是静默）。
// 修复后预期：没有产物是一个**明确失败**——stderr 说清原因，退出码非 0（实现用 2），
//   绝不能让流水线把"没东西可扫"当成"扫过且干净"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/check-bundle-syntax.mjs', import.meta.url))

const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })

const emptyDir = () => mkdtempSync(join(tmpdir(), 'regress95-'))

test('#95 目录里没有 JS 产物时退出码必须是失败（0 会让发布流水线静默放行）', () => {
  const dir = emptyDir()
  try {
    const result = run(dir)
    assert.notEqual(result.status, 0, `空产物目录必须失败，实际退出码 ${result.status}`)
    assert.equal(result.status, 2, '约定：没有产物用 2（与"发现违规"的 1 区分）')
    assert.match(result.stderr, /没有找到产物/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#95 目录不存在时同样失败，而不是当成"干净的产物"', () => {
  const missing = join(tmpdir(), 'regress95-does-not-exist')
  const result = run(missing)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /没有找到产物/)
})
