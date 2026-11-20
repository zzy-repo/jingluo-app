// [layer: regression | 依赖: 真实 dist 产物（`node scripts/build.mjs`）+ acorn（@rspack 传递依赖） | 预算: ≤5s]
//
// #528 硬要求：**至少一条断言产物语法不含低内核解析不了的东西**（`||=` / `static {}` /
// `Promise.withResolvers`），口径复用 `check:legacy`（`scripts/check-bundle-syntax.mjs`）。
//
// 与 `issue-480-legacy-gate-covers-vendored.test.mjs` 的分工（不重复）：
//  - 那边用**合成的最小 dist** 测「门禁的覆盖范围与判定语义」（vendored 是否被扫、`?.` 是否放行）；
//  - 这里对**真实构建产物**下结论：「这份 dist 本身是干净的」，并补一条门禁**自己没覆盖**的规则
//    ——`Promise.withResolvers`（Chrome 119，`LEGACY_RUNTIME_APIS` 表里没有它）。
//
// 为什么放 regression 层而不是 L0：它读的是**构建产物**（需要先 `pnpm build`），
// 既不是纯函数，也不该挤进 L0 的 ≤3s 增量预算；#480 的产物级老内核断言本来就在这一层
// （同目录的 `issue-480-legacy-*`）。
//
// 缺产物时 SKIP(env)（退出码 77）而不是红：不是产品缺陷。CI 里 run-layer 会把 SKIP 单列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const GATE = path.join(ROOT, 'scripts', 'check-bundle-syntax.mjs')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')

const gate = await import('../../scripts/check-bundle-syntax.mjs')

const hasDist = (() => {
  try {
    return statSync(path.join(DIST, 'static/js')).isDirectory()
  } catch {
    return false
  }
})()

const requireDist = () => {
  if (!hasDist) {
    console.error(`SKIP(env) 没有已构建的产物：${DIST}`)
    console.error('  → 先跑 `node scripts/build.mjs`（或 pnpm build），再跑本用例')
    process.exit(77)
  }
}

/** dist 下全部 .js（递归；与门禁的扫描口径一致：`dist/**\/*.js`） */
const jsFilesOf = (dir) => {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.js')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** 跑真 CLI（与 `pnpm check:legacy` 同一条命令），返回 {code, output} */
const runGate = (dir) => {
  try {
    const output = execFileSync(process.execPath, [GATE, dir], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('[L0/产物] 真实 dist 过 check:legacy：无 `||=` / `static {}` / 私有成员 / 未兜底的运行时 API', () => {
  requireDist()
  const { code, output } = runGate(DIST)
  assert.equal(code, 0, `check:legacy 判红：\n${output}`)
  // 证明它真的扫了 vendored 经典脚本（旧门禁只扫 static/js，pdfjs 曾是免检区）
  assert.match(output, /vendored/, `输出里应报出 vendored 的扫描份数：\n${output}`)
  assert.match(output, /结论：合格/, `门禁的结论行没了：\n${output}`)
})

test('[L0/产物] 产物里没有 `Promise.withResolvers`（check:legacy 未覆盖，本用例补齐）', () => {
  requireDist()
  const files = jsFilesOf(DIST)
  assert.ok(files.length > 10, `产物 js 数量异常：${files.length}`)
  const pattern = /Promise\s*\.\s*withResolvers\s*\(/
  const hits = []
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
    if (!pattern.test(code)) {
      continue
    }
    // 命中了才做一次字面量剥离（文案/正则里出现这个名字不算调用）；正常产物不会走到这里
    const stripped = gate.stripLiterals(code)
    if (pattern.test(stripped)) {
      const { line, column } = gate.positionOf(stripped, stripped.search(pattern))
      hits.push(`${path.relative(DIST, file)}:${line}:${column}`)
    }
  }
  assert.deepEqual(
    hits,
    [],
    `产物里出现了 Promise.withResolvers（Chrome 119，WebView 83 上是 TypeError）：\n${hits.join('\n')}`
  )
})

test('[L0/产物] 负向对照：注入 ||= / static {} / withResolvers → 各自的规则必须变红', () => {
  requireDist()
  const cases = [
    {
      name: '逻辑赋值 ||=',
      code: 'const __neg = __negShape ||= {};\n',
      detect: (source) => gate.findForbiddenSyntax(source).some((item) => item.kind === 'logical-assignment'),
    },
    {
      name: '类静态块 static {}',
      code: 'class __Neg { static { this.x = 1 } }\n',
      detect: (source) => gate.findForbiddenSyntax(source).some((item) => item.kind === 'class-static-block'),
    },
    {
      name: 'Promise.withResolvers',
      code: 'const __p = Promise.withResolvers();\n',
      detect: (source) => /Promise\s*\.\s*withResolvers\s*\(/.test(gate.stripLiterals(source)),
    },
  ]
  for (const item of cases) {
    assert.equal(item.detect(item.code), true, `${item.name} 的规则没检出（负向验证失效）`)
  }
  // 反向：同样三个记号放进字符串 / 注释里**不该**报（否则门禁是误报机，真红会被噪音淹没）
  const benign = 'const __s = "a ||= b; static { } Promise.withResolvers()"; // ||= static { }\n'
  assert.deepEqual(gate.findForbiddenSyntax(benign), [], '字符串/注释里的记号被误报了')
  assert.equal(/Promise\s*\.\s*withResolvers\s*\(/.test(gate.stripLiterals(benign)), false, 'withResolvers 误报')
})

test('[L0/产物] 负向对照：往真实产物的副本里塞 `||=`，CLI 必须 exit≠0 并点名文件', () => {
  requireDist()
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-480-gate-'))
  try {
    const target = path.join(temp, 'static', 'pdfjs')
    // 只造 vendored 一份 + 入口 chunk 的壳：形状与真产物一致，但跑得非常快
    mkdirSync(target, { recursive: true })
    mkdirSync(path.join(temp, 'static', 'js'), { recursive: true })
    writeFileSync(path.join(temp, 'index.html'), '<script defer src="static/js/main.js"></script>\n')
    writeFileSync(path.join(temp, 'static', 'js', 'main.js'), 'var a = 1\n__DEEPSEEK_LEGACY_POLYFILL__\n')
    writeFileSync(path.join(target, 'pdf.min.js'), 'const bad = x ||= {}\n')
    const { code, output } = runGate(temp)
    assert.notEqual(code, 0, `塞进 ||= 后门禁仍 exit 0：\n${output}`)
    assert.match(output, /pdfjs[/\\]pdf\.min\.js/, `失败信息要点名那个文件：\n${output}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
