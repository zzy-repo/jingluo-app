// [layer: unit | 依赖: 无（纯 Node） | 耗时: <1s] 说明见 tests/README.md
// issue #557：仓库里不允许出现「仅大小写不同」的文件名。
//
//   cd /root/deepseek-app && node tests/unit/no-case-collision.test.mjs
//
// 背景：`src/components/consume/` 曾经同时有 `AccountPanel.tsx` 与小写的 `accountPanel.ts`。
// 在大小写不敏感的文件系统（macOS 默认）上，`./AccountPanel.js` 会被解析到小写文件：
// rspack 报 `ESModulesLinkingError`、tsc 报 `TS1261`，本地完全构建不出来，而 Linux CI 看不出来。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN_DIRS = ['src', 'scripts', 'android/app/src/main/java']

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
const byLower = new Map()
for (const file of files) {
  const key = file.toLowerCase()
  const bucket = byLower.get(key) ?? []
  bucket.push(file)
  byLower.set(key, bucket)
}
const collisions = [...byLower.values()].filter((bucket) => bucket.length > 1)

assert.deepEqual(
  collisions,
  [],
  `以下文件仅大小写不同，会导致 macOS 上构建/类型检查失败：\n${collisions.map((bucket) => bucket.join('  |  ')).join('\n')}`
)
console.log(`  ok 扫描 ${files.length} 个文件，无「仅大小写不同」的文件名`)
console.log('\n1 项通过')
