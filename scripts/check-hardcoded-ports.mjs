#!/usr/bin/env node
/**
 * 硬编码端口静态检查（Issue #406 §3 假绿治理）。
 *
 * 病根：测试里写死 `http://127.0.0.1:5181`（历史 README 让手起静态服务）时，本机只要**有任何一个**
 * 服务占着 5181，用例就会对着**别人的产物**跑绿或跑红 —— 假绿比红更坏（#365 的 domain05 就是这么
 * 被发现对着陌生产物「跑绿」的）。正确做法只有两种：进程内 `serveDist(dir, { port: 0 })` 原子分配，
 * 或从 `process.env` 读（`PORT` / `APP_URL` / `SCROLL_PORT` …）。
 *
 * 本脚本是**静态**检查，只做「警告」不做「阻断」：注释里的跑法示例、`process.env.X || 5181` 的兜底
 * 都还能过（后者算 env 注入，历史兼容），真正要命的是「没有 env 出口的裸端口」。`--strict` 时把
 * 警告升级成退出码 1，留给后续接线 CI 用（接线要改 ci.yml，见 #406 的 PR 描述）。
 *
 *   node scripts/check-hardcoded-ports.mjs            # 警告，退出码 0
 *   node scripts/check-hardcoded-ports.mjs --strict    # 有警告即退出 1
 *   node scripts/check-hardcoded-ports.mjs --json      # 机器可读
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 历史固定端口清单：都是本仓库真实用过、且撞上过遗留服务的端口。
 * 5291~5296 是早期 serveDir 的固定段、5399 是 feedback-draft、5418 是滚动截图、8090 是 pnpm dev、
 * 5181 是「手起静态服务」的招牌端口（旧 README）。
 */
export const HISTORICAL_PORTS = Object.freeze([5181, 5291, 5292, 5293, 5294, 5295, 5296, 5399, 5418, 8090])

/** 只扫这些目录（测试与测试夹具；生产源码的地址走 __ENDPOINTS__，有 check:endpoints 管） */
const SCAN_DIRS = ['tests']
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs'])

/** 一行是不是纯注释（跑法示例里出现端口是文档，不是隐患） */
export const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line)

/** 栈帧 / 源码位置形态：`  at fn (http://host:port/static/main.js:1:2)` */
const STACK_FRAME = /^\s*'?\s+at\s+\S/

/**
 * 单行豁免标记：门禁自测（`tests/unit/check-hardcoded-ports.test.mjs`）要故意写死端口来当负向对照，
 * 那种「故意的坏例子」必须能标出来，否则门禁第一次跑就红在自己身上。
 * 生产/测试代码里**不许**用它绕过检查 —— 它只该出现在本门禁的负向对照里。
 */
export const EXEMPT_MARKER = 'check-hardcoded-ports: allow'

/**
 * 单行分类。返回 `null` 表示这行没有命中端口，否则返回
 * `{ kind: 'warn' | 'env' | 'comment', port }`。
 *
 * 判定顺序：注释 → env 注入 → 其余一律警告（含 `.listen(5181)`、`http://127.0.0.1:5181`、
 * `const PORT = 5294` 这类写法）。
 */
export const classifyLine = (line, ports = HISTORICAL_PORTS) => {
  const hits = ports.filter((port) => new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(line))
  if (hits.length === 0) return null
  const port = hits[0]
  if (line.includes(EXEMPT_MARKER)) return { kind: 'exempt', port }
  if (isCommentLine(line)) return { kind: 'comment', port }
  // 打包产物的**栈帧字符串**（`    at UserMessage (http://127.0.0.1:5293/static/main.js:12:3456)`）
  // 是夹具数据，不是「连哪个端口」—— 静态检查只认「真的会被连的端口」。
  if (STACK_FRAME.test(line)) return { kind: 'fixture', port }
  if (/process\.env/.test(line)) return { kind: 'env', port }
  return { kind: 'warn', port }
}

/** 扫一段源码，返回逐行结论（供单测与 CLI 共用） */
export const scanSource = (source, file, ports = HISTORICAL_PORTS) =>
  source
    .split('\n')
    .map((line, index) => {
      const verdict = classifyLine(line, ports)
      return verdict ? { file, lineNumber: index + 1, code: line.trim(), ...verdict } : null
    })
    .filter(Boolean)

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(mjs|cjs|js|ts)$/.test(entry.name)) continue
    yield full
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const asJson = argv.includes('--json')
  const findings = []
  for (const dir of SCAN_DIRS) {
    for await (const file of walk(path.join(ROOT, dir))) {
      const source = await readFile(file, 'utf8')
      findings.push(...scanSource(source, path.relative(ROOT, file).split(path.sep).join('/')))
    }
  }
  const warns = findings.filter((item) => item.kind === 'warn')
  const envs = findings.filter((item) => item.kind === 'env')
  const fixtures = findings.filter((item) => item.kind === 'fixture')
  void findings.filter((item) => item.kind === 'exempt')
  const comments = findings.filter((item) => item.kind === 'comment')

  if (asJson) {
    console.log(JSON.stringify({ version: 1, ports: HISTORICAL_PORTS, findings, warn: warns.length }, null, 2))
  } else {
    if (warns.length) {
      console.log(`硬编码端口（无 env 出口）：${warns.length} 处 —— 改成 serveDist(dir, { port: 0 }) 或从 process.env 读`)
      for (const item of warns) console.log(`  ✗ ${item.file}:${item.lineNumber}  :${item.port}  ${item.code}`)
    }
    if (envs.length) {
      console.log(`\n有 env 出口（允许，仅提示默认值写死）：${envs.length} 处`)
      for (const item of envs) console.log(`  · ${item.file}:${item.lineNumber}  :${item.port}`)
    }
    if (comments.length) {
      console.log(`\n注释 / 跑法示例（不算隐患）：${comments.length} 处`)
    }
    if (fixtures.length) {
      console.log(`栈帧 / 产物路径夹具（不算隐患）：${fixtures.length} 处`)
    }
    console.log(
      `\n合计 ${findings.length} 处命中：警告 ${warns.length} / env ${envs.length} / 注释 ${comments.length} / 栈帧夹具 ${fixtures.length}（端口表 ${HISTORICAL_PORTS.join(', ')}）`,
    )
    if (!warns.length) console.log('硬编码端口检查：没有需要处理的裸端口 ✅')
  }
  return strict && warns.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
