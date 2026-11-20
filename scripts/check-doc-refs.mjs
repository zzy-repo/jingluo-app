#!/usr/bin/env node
/**
 * 文档引用门禁（GitHub issue #290）。
 *
 *   node scripts/check-doc-refs.mjs           # 或 pnpm check:docs
 *   node scripts/check-doc-refs.mjs --json
 *
 * 回答一个问题：**文档里那些 `文件:行号`，还指得着吗？**
 *
 * 背景：#240 手修过一轮「docs 行号漂移」，因为没有门禁，又漂了一遍 —— 至少 33 处指到空行
 * 或孤立的 `}`，10 处指向仓库里根本不存在的文件（`tests/run-acceptance.mjs`、
 * `src/services/diagnostics/updateManifest.ts`）。靠手修治不了，只能让漂移变成红灯。
 *
 * ## 判定口径
 *
 * 一处引用 = 一个 token `路径[:起行[-止行]]`。
 *
 * 1 **带行号的引用**（`文件:行`）要过四关：
 *    - 文件要存在：有 `/` 的按仓库根相对路径解析；裸名先按**文档所在目录**解析，再按全仓
 *      basename 唯一匹配，同名多于一个就 FAIL（补成仓库相对路径）；
 *    - 起行要在文件行数内 —— 越界 = FAIL；
 *    - 起行不许是空行 —— 空行 = FAIL（这正是本单的根因）；
 *    - 起行不许是孤立的 `}`、注释结束符、`);` 这类结构行 —— WARN。**止行不受这条约束**：
 *      区间本来就常常收在函数体最后一个 `}` 上，那不是漂移。
 * 2 **只给路径的引用**（`src/services/chat/store.ts`）：存在即合格，只检查「带 `/` 且首段
 *    是仓库根下真实目录」的那种；裸文件名（`releases.json`、`metrics.json` 这类远端清单 /
 *    采集产物）不判定 —— 它们不是仓库里的文件，硬判只会逼人写假路径。
 *
 * ## 不算引用的东西
 *
 * - 绝对路径与 URL（`/data/user_de/...`、`//localhost/static/...`）；
 * - 通配 / 模板（`*.module.css`、`scripts/lib/*AssumptionAudit.mjs`、`xxxAssumptionAudit.mjs`）——
 *   它们是「命名约定」，不是「某个文件」；
 * - 依赖与产物目录（`node_modules/**` 等）；
 * - `fenced code block` 里的命令与输出。
 *
 * ## 豁免
 *
 * 历史取证目录 `docs/repro/**`、`docs/redteam/**`、`docs/compat/compat-old/**` **只读不改**：
 * 里面的 `文件:行号` 记的是当次取证那一刻的仓库状态，事后「修」它等于篡改证据。
 * 这些引用只计数、不判定、不影响退出码。
 *
 * 退出码：0 合格 / 1 有 FAIL / 2 环境不具备（找不到 docs 目录）。
 *
 * 维护提示：这个门禁验的是「引用还指得着」，**不验**「文档描述的行为是否还对」。后者只能读代码
 * 复核；别把这里变绿当成文档正确。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录 */
export const ROOT = path.resolve(HERE, '..')

/** 扫这些路径（目录递归 .md，文件按原样） */
export const SCAN_TARGETS = ['docs', 'CHANGELOG.md']

/** 历史取证归档：只读，不做判定 */
export const EXEMPT_PREFIXES = ['docs/repro/', 'docs/redteam/', 'docs/compat/compat-old/']

/** 索引 / 解析时跳过的目录**名**（依赖、产物、缓存 —— 都不算「仓库里的文件」） */
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.gradle',
  '.work-compat',
  'coverage',
  '__pycache__',
])

/**
 * 只是**名字撞上**产物目录的文档目录（假红修复；根因见 #461 的实测与 PR 说明）
 *
 * `docs/testing/coverage/` 存的是测试覆盖状态的**文档**，不是 jest / vitest 吐出来的
 * `coverage/` 产物。旧实现只看目录**名**就跳过，于是这批 md 连索引都进不去 —— 后果是
 * `docs/testing/report.md` / `docs/TESTING-POLICY.md` 里 15 处指向它们的引用全被判
 * 「文件不存在」，门禁自己制造了 15 条噪音红（#461 实测：main 上 23 FAIL，其中 15 条是这个）。
 *
 * 现在把两件事分开：
 *   - **索引**（别的文档引用它时能不能判定「文件存在」）：照常走进去 → 15 条噪音消失；
 *   - **扫正文**（校验这些 md 自己写的引用）：仍然不扫。实测把它们放进扫描范围会多出 28 条红
 *     —— 21 条 `missing-file`（指向 `update-matrix` / `release-gate-matrix` / `email-421-*` /
 *     `server-contract` / `release-mirror.mjs` 这些已改名或已删除的东西，另有 1 条是
 *     `android/…/MainActivity.java` 这种省略写法）+ 6 条 `out-of-range` + 1 条 `blank-line`。
 *     这些是**真的**文档腐烂，但那是另一件事 —— 混进这一单只会把「15 条噪音」换成「28 条真红」，
 *     谁也说不清哪条是哪个病。拆开做：先让门禁对它们的**引用方**不作假，再单开一单修它们自己的正文。
 */
const INDEX_ALWAYS_DIRS = new Set(['docs/testing/coverage'])

/** 建索引时是否跳过该目录：名字是产物名、且不是上面那个「撞名文档目录」 */
const skipForIndex = (rel, name) => SKIP_DIR_NAMES.has(name) && !INDEX_ALWAYS_DIRS.has(rel)

/** 扫正文时是否跳过该目录：只看名字（撞名文档目录的正文这一单不扫，见 INDEX_ALWAYS_DIRS） */
const skipForScan = (_rel, name) => SKIP_DIR_NAMES.has(name)

/** 认作「文件引用」的扩展名（长的排前面，别让 `ts` 吃掉 `tsx`） */
const REF_EXT =
  'tsx|jsx|mts|cts|ts|mjs|cjs|json|js|css|scss|md|html|py|gradle|java|kt|yaml|yml|sh|txt|xml|toml'

const REF_RE = new RegExp(
  `([A-Za-z0-9_@][\\w.@/+-]*\\.(?:${REF_EXT}))(?::(\\d+)(?:[-–](\\d+))?)?(?![\\w.-])`,
  'g',
)

/** 构建产物的哈希文件名（`main.030dd2a6.js`）从来不是仓库路径 */
const ARTIFACT_RE = /(?:^|\/)[\w-]+\.[0-9a-f]{8}\.(?:js|css)$/

/** 模板占位符（`xxxAssumptionAudit.mjs`、`docs/capabilities/xxx.md`）不是具体文件 */
const PLACEHOLDER_RE = /(?:^|[/.])x{3,}|x{3,}[A-Za-z]/i

/** 起行指向「结构行」：孤立的闭括号 / 注释结束符 / 单行闭合 JSX 标签 */
const structuralLine = (text) => {
  const t = text.trim()
  if (!t) return false
  return (
    /^[}\])\];,]+;?$/.test(t) ||
    t === '})' ||
    t === '});' ||
    /^<\/?[A-Za-z][\w.:-]*>$/.test(t)
  )
}

const toPosix = (p) => p.split(path.sep).join('/')

/** 递归收集 .md */
const collectDocs = (dir, out) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipForScan(toPosix(path.relative(ROOT, full)), entry.name)) continue
      collectDocs(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/** 全仓索引：仓库相对路径集合 + basename → 路径列表 */
const buildIndex = () => {
  const paths = new Set()
  const byBasename = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = toPosix(path.relative(ROOT, full))
      if (entry.isDirectory()) {
        if (skipForIndex(rel, entry.name)) continue
        paths.add(`${rel}/`)
        walk(full)
      } else if (entry.isFile()) {
        paths.add(rel)
        const list = byBasename.get(entry.name)
        if (list) list.push(rel)
        else byBasename.set(entry.name, [rel])
      }
    }
  }
  walk(ROOT)
  return { paths, byBasename }
}

const linesCache = new Map()
const linesOf = (rel) => {
  const cached = linesCache.get(rel)
  if (cached) return cached
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/)
  linesCache.set(rel, lines)
  return lines
}

const isExempt = (rel) => EXEMPT_PREFIXES.some((p) => rel.startsWith(p))

/**
 * 判定一处引用：
 * { verdict: 'ok' | 'warn' | 'fail', kind, target?, message? }
 */
const judgeRef = (index, ref, docDir) => {
  const { file, start, end } = ref
  const hasLine = start !== null

  // ---- 解析目标文件 ----
  let target = null
  if (file.includes('/')) {
    if (index.paths.has(file)) target = file
    else if (index.paths.has(`${file}/`)) target = `${file}/`
  } else {
    // 裸名：先看文档自己所在目录（`cdp.mjs` 这类和 README 放一起的采集脚本）
    const local = docDir === '.' ? file : `${docDir}/${file}`
    if (index.paths.has(local)) target = local
    else {
      const hits = index.byBasename.get(file) ?? []
      if (hits.length === 1) target = hits[0]
      else if (hits.length > 1) {
        // 只有「要拿它定位某一行」时，唯一性才是必须的
        if (hasLine) {
          return {
            verdict: 'fail',
            kind: 'ambiguous',
            message: `裸文件名在仓库里有 ${hits.length} 个同名文件，无法定位（补成仓库相对路径）：${hits
              .slice(0, 3)
              .join(' / ')}`,
          }
        }
        return { verdict: 'ok', kind: 'ambiguous-bare' }
      }
    }
  }

  if (target === null) {
    // 只给路径的裸名（`releases.json`、`metrics.json`）：不是仓库文件，不判定
    if (!hasLine && !file.includes('/')) return { verdict: 'ok', kind: 'bare-artifact' }
    return { verdict: 'fail', kind: 'missing-file', message: `文件不存在：${file}` }
  }
  if (target.endsWith('/')) return { verdict: 'ok', kind: 'dir', target }
  if (!hasLine) return { verdict: 'ok', kind: 'path', target }

  // ---- 行号 ----
  const lines = linesOf(target)
  const last = end === null ? start : Math.max(start, end)
  if (start < 1 || last > lines.length) {
    return {
      verdict: 'fail',
      kind: 'out-of-range',
      target,
      message: `行号越界：${start}${end === null ? '' : `-${end}`} > 文件行数 ${lines.length}`,
    }
  }
  if ((lines[start - 1] ?? '').trim() === '') {
    return {
      verdict: 'fail',
      kind: 'blank-line',
      target,
      message: `起行 ${start} 是空行（文件 ${lines.length} 行）`,
    }
  }
  if (end !== null && (lines[last - 1] ?? '').trim() === '') {
    return {
      verdict: 'warn',
      kind: 'blank-end',
      target,
      message: `止行 ${last} 是空行，区间收在空行上没有意义`,
    }
  }
  if (structuralLine(lines[start - 1] ?? '')) {
    return {
      verdict: 'warn',
      kind: 'structural-line',
      target,
      message: `起行 ${start} 是结构行（${JSON.stringify(
        (lines[start - 1] ?? '').trim(),
      )}），改用函数名/常量名定位更稳`,
    }
  }
  return { verdict: 'ok', kind: 'line', target }
}

/** 从 md 文本抽引用（fenced code block 里的命令/输出不算） */
const extractRefs = (text) => {
  const refs = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    REF_RE.lastIndex = 0
    let m
    while ((m = REF_RE.exec(line)) !== null) {
      const file = m[1]
      const before = m.index === 0 ? '' : line[m.index - 1]
      // 绝对路径 / URL / 通配 / 名字的一部分，都不是独立引用
      if (before === '/' || before === '~' || before === '*' || before === '.') continue
      if (ARTIFACT_RE.test(file)) continue
      if (PLACEHOLDER_RE.test(file)) continue
      const segs = file.split('/')
      if (segs.length > 1) {
        // 首段必须是仓库根下真实存在的目录/文件；依赖与产物目录直接跳过
        if (SKIP_DIR_NAMES.has(segs[0])) continue
        if (!existsSync(path.join(ROOT, segs[0]))) continue
      }
      refs.push({
        file,
        start: m[2] === undefined ? null : Number(m[2]),
        end: m[3] === undefined ? null : Number(m[3]),
        line: i + 1,
        raw: m[0],
      })
    }
  })
  return refs
}

const main = () => {
  const json = process.argv.includes('--json')
  const docsDir = path.join(ROOT, 'docs')
  if (!existsSync(docsDir)) {
    console.error(`找不到 docs 目录：${docsDir}`)
    process.exit(2)
  }

  const index = buildIndex()
  const files = []
  for (const target of SCAN_TARGETS) {
    const full = path.join(ROOT, target)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) collectDocs(full, files)
    else files.push(full)
  }

  const withLine = []
  const pathOnly = []
  const exempt = []
  const findings = []

  for (const full of files) {
    const rel = toPosix(path.relative(ROOT, full))
    const docDir = toPosix(path.relative(ROOT, path.dirname(full))) || '.'
    for (const ref of extractRefs(readFileSync(full, 'utf8'))) {
      const result = judgeRef(index, ref, docDir)
      const record = { doc: rel, docLine: ref.line, raw: ref.raw, ...result }
      if (isExempt(rel)) {
        exempt.push(record)
        continue
      }
      if (ref.start === null) pathOnly.push(record)
      else withLine.push(record)
      if (result.verdict !== 'ok') findings.push(record)
    }
  }

  const fails = findings.filter((f) => f.verdict === 'fail')
  const warns = findings.filter((f) => f.verdict === 'warn')

  if (json) {
    console.log(
      JSON.stringify(
        {
          docsScanned: files.length,
          withLine: withLine.length,
          pathOnly: pathOnly.length,
          exempt: exempt.length,
          fails,
          warns,
        },
        null,
        2,
      ),
    )
    process.exit(fails.length > 0 ? 1 : 0)
  }

  console.log('文档引用门禁（GitHub issue #290）')
  console.log(
    `  扫描 ${files.length} 个文档：带行号引用 ${withLine.length} 处 / 纯路径引用 ${pathOnly.length} 处`,
  )
  console.log(`  豁免（历史取证只读）${exempt.length} 处，不判定、不影响退出码`)
  console.log('')

  const printGroup = (title, list) => {
    if (list.length === 0) return
    console.log(`${title} ${list.length}`)
    for (const f of list) {
      console.log(`  ${f.doc}:${f.docLine}  ${f.raw}`)
      console.log(`      ${f.message}`)
    }
    console.log('')
  }
  printGroup('FAIL', fails)
  printGroup('WARN', warns)

  if (fails.length === 0 && warns.length === 0) {
    console.log('合格：所有引用都指得着（文件存在、行号在文件内、不落在空行）。')
    process.exit(0)
  }
  if (fails.length === 0) {
    console.log('合格（有 WARN）：没有硬错误；WARN 项建议改用函数名/常量名定位。')
    process.exit(0)
  }
  console.log('不合格：先修 FAIL 项。别用「换成章节标题」绕过 —— 那样可核对性就没了。')
  process.exit(1)
}

main()
