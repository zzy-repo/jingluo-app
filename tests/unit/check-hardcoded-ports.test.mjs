// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 硬编码端口静态检查（Issue #406 §3）—— 门禁自身必须有**负向对照**（#369 的规矩）：
//   [1] 裸端口 → warn（这是要治的）
//   [2] `process.env.X || 5181` → env（历史兼容，放行）
//   [3] 跑法注释里的端口 → comment（文档，不是隐患）
//   [4] 栈帧 / 产物路径夹具里的端口 → fixture（不是「连哪个端口」）
//   [5] 仓库现有 tests/ 扫描必须**零警告**（回归锁：再有人写死端口就红在这条上）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXEMPT_MARKER, HISTORICAL_PORTS, classifyLine, scanSource } from '../../scripts/check-hardcoded-ports.mjs'

/**
 * 本文件**故意**写死端口来当负向对照：下面这些物理行末尾都挂了豁免标记 `check-hardcoded-ports: allow`
 * （常量 EXEMPT_MARKER），否则「回归锁」那条会红在自己身上。标记只该出现在门禁的负向对照里。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('裸端口 → warn', () => {
  assert.deepEqual(classifyLine("const APP_URL = 'http://127.0.0.1:5181'"), { kind: 'warn', port: 5181 })  // check-hardcoded-ports: allow
  assert.deepEqual(classifyLine('server.listen(5294)'), { kind: 'warn', port: 5294 })  // check-hardcoded-ports: allow
  assert.deepEqual(classifyLine('const PREFERRED_PORT = 5418'), { kind: 'warn', port: 5418 })  // check-hardcoded-ports: allow
})

test('有 env 出口 → 放行（env）', () => {
  assert.deepEqual(classifyLine("const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'"), {  // check-hardcoded-ports: allow
    kind: 'env',
    port: 5181,  // check-hardcoded-ports: allow
  })
  assert.deepEqual(classifyLine('const PORT = Number(process.env.SCROLL_PORT || 5418)'), {  // check-hardcoded-ports: allow
    kind: 'env',
    port: 5418,  // check-hardcoded-ports: allow
  })
})

test('注释 / 跑法示例 → comment（不出警告）', () => {
  assert.deepEqual(classifyLine('//   APP_URL=http://127.0.0.1:5181 node tests/x.test.mjs'), {  // check-hardcoded-ports: allow
    kind: 'comment',
    port: 5181,  // check-hardcoded-ports: allow
  })
  assert.deepEqual(classifyLine(' * 以前固定连 127.0.0.1:8090 的 pnpm dev'), { kind: 'comment', port: 8090 })  // check-hardcoded-ports: allow
})

test('栈帧夹具 → fixture（不是被连的端口）', () => {
  assert.deepEqual(
    classifyLine("    '    at UserMessage (http://127.0.0.1:5293/static/main.js:12:3456)',"),  // check-hardcoded-ports: allow
    { kind: 'fixture', port: 5293 },  // check-hardcoded-ports: allow
  )
})

test('没有端口 / 不在端口表里的端口 → null', () => {
  assert.equal(classifyLine('const url = serve.url'), null)
  assert.equal(classifyLine('const url = "http://127.0.0.1:3000"'), null)  // check-hardcoded-ports: allow
  // 端口表里的数字出现在别的数字串里也不算（位数边界）
  assert.equal(classifyLine('const n = 1518100'), null)  // check-hardcoded-ports: allow
})

test('scanSource 带行号与原文，供人直接去改', () => {
  const findings = scanSource("const a = 1\nserver.listen(5292)\n", 'demo.mjs')  // check-hardcoded-ports: allow
  assert.equal(findings.length, 1)
  assert.equal(findings[0].lineNumber, 2)
  assert.equal(findings[0].kind, 'warn')
  assert.equal(findings[0].file, 'demo.mjs')
})

test('回归锁：仓库 tests/ 下当前没有「裸端口」', async () => {
  const findings = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(mjs|cjs|js|ts)$/.test(entry.name)) continue
      findings.push(...scanSource(await readFile(full, 'utf8'), path.relative(ROOT, full)))
    }
  }
  await walk(path.join(ROOT, 'tests'))
  const warns = findings.filter((item) => item.kind === 'warn')
  assert.deepEqual(
    warns.map((item) => `${item.file}:${item.lineNumber} :${item.port}`),
    [],
    `新增硬编码端口请改成 serveDist(dir, { port: 0 }) 或从 process.env 读（端口表 ${HISTORICAL_PORTS.join(', ')}）`,
  )
})
