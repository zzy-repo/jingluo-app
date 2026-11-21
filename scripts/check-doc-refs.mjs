#!/usr/bin/env node
/**
 * 文档引用门禁（GitHub issue #290）。
 *
 *   node scripts/check-doc-refs.mjs           # 或 pnpm check:doc-refs
 *   node scripts/check-doc-refs.mjs --json
 *   node scripts/check-doc-refs.mjs --audit-skipped   # 把「被跳过的引用」按原因分组摊开（#678）
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
 * 3 **省略前缀的引用**（`components/settings/Settings.module.css:804`、裸 `collector.ts:723`，
 *    即首段不是仓库根下的真实条目）：**#678 之前这一类根本进不了判定** —— 提取阶段
 *    `if (!existsSync(ROOT/segs[0])) continue` 一句话就把它丢了，不判存在性、不判行号。
 *    后果是 `docs/capabilities/css.md` §2 整张表（全是 `components/…` 写法）连「文件还在不在」
 *    都没人验过，行号漂到 `}` 上也永远绿（实测这类引用全仓 189 处，css.md 独占 13 处）。
 *    现在按三段解析：
 *      a. 相对**文档自己所在目录**（`docs/ui/x/README.md` 里的 `390/metrics.json`）；
 *      b. 全仓**路径后缀唯一匹配**（`components/a/b.css` → `src/components/a/b.css`）；
 *      c. 唯一匹配就按它判存在性与行号（行号错照样红）；**多匹配 / 零匹配 → WARN 点名**
 *         （绝不静默放过 —— 这正是本单要堵的那个洞）。
 *
 * ## 跳过必须记账（#678）
 *
 * 「不判定」和「没看见」是两件事。所有被跳过的引用都按原因记账，`--audit-skipped` 打印
 * 分组计数与逐条清单：`not-standalone` / `artifact-hash` / `placeholder` / `skip-dir` /
 * `first-segment-not-root` / `other-ext` / `bare-artifact` / `ambiguous-bare`。
 * 加这个开关的理由和 #661 一样：门禁「看起来在守」，底下却有一整类引用从没被看过，
 * 而没人能从输出里看出来 —— 那就只能让它自己把账本摊开。
 * 顺带量了第二类：`REF_EXT` 白名单之外的扩展名（`--audit-skipped` 里的 `other-ext`）也按同样口径
 * 量了一遍；图片类归 `check:ui-shots`（#661）管，本门禁不重复判。
 *
 * ## 不算引用的东西
 *
 * - 绝对路径与 URL（`/data/user_de/...`、`//localhost/static/...`）；
 * - 通配 / 模板（`*.module.css`、`scripts/lib/*AssumptionAudit.mjs`、`xxxAssumptionAudit.mjs`）——
 *   它们是「命名约定」，不是「某个文件」；
 * - 依赖与产物目录（`node_modules/**` 等）；
 * - `fenced code block` 里的命令与输出；
 * - **删除线里的路径**（`~~tests/golden/g07-xxx.test.mjs~~`）：这是「曾有、现已删除」的记录，
 *   迁移 / 删除清单必须写得清删了什么，硬判「文件不存在」会逼人把删除记录也删掉。
 *   这类引用**单独计数并打印**（`已删除（删除线…）N 处`），不是静默放行 ——
 *   此前它被「`~` 开头的路径是家目录」那条规则顺手丢掉，等于一个谁都能用、且谁也看不见的后门。
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

/**
 * 索引 / 解析时跳过的目录**名**（依赖、产物、缓存 —— 都不算「仓库里的文件」）
 *
 * `capacitor-cordova-android-plugins`（#563）：cap 的生成物，android/.gitignore 里明确忽略，
 * 干净 checkout 上没有。但只要本机按 docs/TESTING-POLICY.md 第 8/9.6 节跑过一次
 * `pnpm exec cap sync android`（gradle 配置校验的前置），它就会出现在盘上，于是
 * `docs/capabilities/behavior.md` 里那句裸文件名引用 `AndroidManifest.xml:19` 立刻变成
 * 「2 个同名文件，无法定位」的假红 —— 门禁自己制造的噪音，和 #461 是同一类病。
 */
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.gradle',
  '.work-compat',
  'coverage',
  '__pycache__',
  'capacitor-cordova-android-plugins',
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

/**
 * 「前缀式」产物目录名（`dist-standard/`、`dist-baseline/`、`.gitignore` 里的 `dist-` + 通配 —— 第 6/49 行）。
 * 它们和 `dist/` 是一回事：本机构建产物，干净 checkout 上没有，不是仓库文件（#678 记账时归 skip-dir）。
 */
const ARTIFACT_DIR_PREFIX_RE = /^(?:dist|build|coverage)-/

/** 建索引时是否跳过该目录：名字是产物名、且不是上面那个「撞名文档目录」 */
const skipForIndex = (rel, name) => SKIP_DIR_NAMES.has(name) && !INDEX_ALWAYS_DIRS.has(rel)

/** 扫正文时是否跳过该目录：只看名字（撞名文档目录的正文这一单不扫，见 INDEX_ALWAYS_DIRS） */
const skipForScan = (_rel, name) => SKIP_DIR_NAMES.has(name)

/** 认作「文件引用」的扩展名（长的排前面，别让 `ts` 吃掉 `tsx`） */
const REF_EXT =
  'tsx|jsx|mts|cts|ts|mjs|cjs|json|js|css|scss|md|html|py|gradle|java|kt|yaml|yml|sh|txt|xml|toml|service|conf'

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
 * 「省略前缀」类引用的解析：把引用当**路径后缀**在仓库里找（段边界对齐，`/` 前必须是分隔符）。
 * 返回匹配到的仓库相对路径列表（0 / 1 / n）。结果按查询缓存，`index.paths` 有上万条。
 */
const suffixCache = new Map()
const suffixHits = (index, file) => {
  const cached = suffixCache.get(file)
  if (cached) return cached
  const needle = `/${file}`
  const out = []
  for (const p of index.paths) {
    if (p.length > needle.length && p.endsWith(needle) && !p.endsWith('/')) out.push(p)
  }
  suffixCache.set(file, out)
  return out
}

/**
 * 判定一处引用：
 * { verdict: 'ok' | 'warn' | 'fail', kind, target?, message? }
 */
const judgeRef = (index, ref, docDir) => {
  const { file, start, end } = ref
  const hasLine = start !== null
  /** 是否靠「后缀唯一匹配」才定位到的目标（#678：这类引用以前根本不进判定） */
  let suffixResolved = false

  // 删除线里的引用：文档明说「这个对象已经删了」，不该再要求它指得着（但会计数打印）
  if (ref.deleted) return { verdict: 'ok', kind: 'deleted-marker' }

  // ---- 解析目标文件 ----
  let target = null
  if (file.includes('/')) {
    if (index.paths.has(file)) target = file
    else if (index.paths.has(`${file}/`)) target = `${file}/`
    else if (!existsSync(path.join(ROOT, file.split('/')[0]))) {
      // #678：首段不是仓库根下的真实条目 —— 典型是省略了 `src/` 的写法
      // （`components/chatInput/ChatInput.module.tsx`、`components/markdown/markdown.css:67`）。
      // 以前这类引用在 extractRefs 里被 `continue` 静默丢掉：不判存在性、不判行号，
      // 于是 `docs/capabilities/css.md` 的整张 §2 表连「文件还在不在」都没人验过。
      // 现在按**路径后缀在仓库里找唯一匹配**：唯一 → 就按它判存在性与行号（该文件的
      // 行号错了照样红）；多匹配 / 零匹配 → WARN 点名（要人补全路径或改成函数名定位），
      // 绝不静默放行。
      // 先看「相对于引用它的那份文档」能不能解析（`docs/ui/xxx/README.md` 里的
      // `390/metrics.json` 就是这种写法：路径是相对文档自己的）。这一档比全仓后缀匹配更具体。
      const local = docDir === '.' ? file : `${docDir}/${file}`
      const hits = index.paths.has(local) ? [local] : suffixHits(index, file)
      if (hits.length === 1) {
        target = hits[0]
        suffixResolved = true
      } else {
        return {
          verdict: 'warn',
          kind: hits.length === 0 ? 'suffix-unmatched' : 'suffix-ambiguous',
          message:
            hits.length === 0
              ? `省略了前缀，且按「文档所在目录」「全仓后缀」都找不到：${file}` +
                '（缩写记法，或文件已删除/改名 —— 补全路径、改函数名定位，或用删除线标注「曾存在」）'
              : `省略了前缀，后缀匹配到 ${hits.length} 个文件，无法定位（补成仓库相对路径）：${hits
                  .slice(0, 3)
                  .join(' / ')}`,
        }
      }
    }
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
  if (target.endsWith('/'))
    return { verdict: 'ok', kind: 'dir', target, suffix: suffixResolved }
  if (!hasLine) return { verdict: 'ok', kind: 'path', target, suffix: suffixResolved }

  // ---- 行号 ----
  const lines = linesOf(target)
  const last = end === null ? start : Math.max(start, end)
  if (start < 1 || last > lines.length) {
    return {
      verdict: 'fail',
      kind: 'out-of-range',
      target,
      suffix: suffixResolved,
      message: `行号越界：${start}${end === null ? '' : `-${end}`} > 文件行数 ${lines.length}`,
    }
  }
  if ((lines[start - 1] ?? '').trim() === '') {
    return {
      verdict: 'fail',
      kind: 'blank-line',
      target,
      suffix: suffixResolved,
      message: `起行 ${start} 是空行（文件 ${lines.length} 行）`,
    }
  }
  if (end !== null && (lines[last - 1] ?? '').trim() === '') {
    return {
      verdict: 'warn',
      kind: 'blank-end',
      target,
      suffix: suffixResolved,
      message: `止行 ${last} 是空行，区间收在空行上没有意义`,
    }
  }
  if (structuralLine(lines[start - 1] ?? '')) {
    return {
      verdict: 'warn',
      kind: 'structural-line',
      target,
      suffix: suffixResolved,
      message: `起行 ${start} 是结构行（${JSON.stringify(
        (lines[start - 1] ?? '').trim(),
      )}），改用函数名/常量名定位更稳`,
    }
  }
  return { verdict: 'ok', kind: 'line', target, suffix: suffixResolved }
}

/** 从 md 文本抽引用（fenced code block 里的命令/输出不算） */
/** `~~…~~` 删除线区间（`~~` 与 `**` 一样是「这里的东西已经不在了」的通用标记） */
const STRIKE_RE = /~~.+?~~/g

const strikeSpans = (line) => {
  const spans = []
  STRIKE_RE.lastIndex = 0
  let s
  while ((s = STRIKE_RE.exec(line)) !== null) spans.push([s.index, s.index + s[0].length])
  return spans
}

/**
 * 被跳过（不判定）的引用，按原因归档的名字 + 人话说明。
 *
 * 为什么要能把它们**数出来**（#678）：`check-doc-refs` 曾有整整一类引用被 `continue`
 * 静默丢掉 —— 判不了就直接不看，于是 `docs/capabilities/css.md` 里 `components/…:228`
 * 这种省略了 `src/` 前缀的写法全部不受门禁管辖，行号漂到别处也没人知道。
 * 这和 #661「`REF_EXT` 不含 png → 删掉被引用的截图零覆盖」是同一种病：
 * **门禁看起来在守，实际有一整类引用被静默跳过**。规矩改成：跳过可以，但必须**记账**，
 * 且 `--audit-skipped` 能把账本打出来。
 */
const SKIP_REASONS = {
  'not-standalone': '不是独立引用（前面紧贴 `/` `~` `*` `.`：URL / 绝对路径 / 通配符 / 名字的一部分）',
  'artifact-hash': '构建产物哈希名（`main.030dd2a6.js`），不是仓库路径',
  placeholder: '模板占位符（`xxx.md`）',
  'skip-dir': '依赖 / 产物目录（`node_modules/**` 等）',
  'first-segment-not-root':
    '首段不是仓库根下的真实条目（省略了 `src/` 之类的写法）—— #678 起这类**不再跳过**，' +
    '改由「文档所在目录 / 全仓后缀唯一匹配」判定；这里记的是「曾经整类被静默丢掉」的规模',
  'other-ext': `扩展名不在 REF_EXT 白名单（图片类由 check:ui-shots 管，不在此列）`,
  'bare-artifact': '裸文件名且无行号，仓库里找不到（远端清单 / 采集产物，不是仓库文件）',
  'ambiguous-bare': '裸文件名无行号，仓库里同名多个（不定位行号，只放行）',
}

const extractRefs = (text, skipped) => {
  const refs = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  const skip = (reason, m, i, file, detail) => {
    if (skipped) skipped.push({ raw: m[0], file, line: i + 1, reason, detail })
  }
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const strikes = strikeSpans(line)
    REF_RE.lastIndex = 0
    let m
    while ((m = REF_RE.exec(line)) !== null) {
      const file = m[1]
      const before = m.index === 0 ? '' : line[m.index - 1]
      // 删除线里的路径 = 「曾有、现已删除」的记录（迁移/删除清单要写清删了什么）。
      // 以前这类引用被下面 `before === '~'` 那条规则**静默丢掉**（一个看不见的后门：
      // 任何文档只要给死引用套一层 `~~` 就能过门禁，且没人知道发生过）。
      // 现在单独计数并打印 —— 放行是**显式**的，能数出来，也能被 review 看到。
      if (strikes.some(([start, end]) => m.index >= start && m.index + m[0].length <= end)) {
        refs.push({
          file,
          start: m[2] === undefined ? null : Number(m[2]),
          end: m[3] === undefined ? null : Number(m[3]),
          line: i + 1,
          raw: m[0],
          deleted: true,
        })
        continue
      }
      // 绝对路径 / URL / 通配 / 名字的一部分，都不是独立引用
      if (before === '/' || before === '~' || before === '*' || before === '.') {
        skip('not-standalone', m, i, file)
        continue
      }
      if (ARTIFACT_RE.test(file)) {
        skip('artifact-hash', m, i, file)
        continue
      }
      if (PLACEHOLDER_RE.test(file)) {
        skip('placeholder', m, i, file)
        continue
      }
      const segs = file.split('/')
      if (segs.length > 1) {
        if (SKIP_DIR_NAMES.has(segs[0]) || ARTIFACT_DIR_PREFIX_RE.test(segs[0])) {
          skip('skip-dir', m, i, file)
          continue
        }
        // 首段必须是仓库根下真实存在的条目。#678 之前这里直接 `continue` —— 静默跳过，
        // 于是 `components/…`（省略 `src/`）整类引用不受管辖。现在交给 judgeRef 里的
        // 后缀唯一匹配去判；判不了的会报 WARN 点名，而不是无声放行。
        if (!existsSync(path.join(ROOT, segs[0]))) {
          skip('first-segment-not-root', m, i, file)
          // 仍然入列：judgeRef 会尝试后缀唯一匹配
        }
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

const REF_EXT_SET = new Set(REF_EXT.split('|'))

/** 图片类扩展名：由 `check:ui-shots`（#661）管，**不**在本门禁里重复判定（#678 不重叠要求） */
const SHOT_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

/** 比 REF_RE 更宽：任何 `名字.扩展名` 的候选（用来量出「扩展名不在白名单」那一类） */
const ANY_EXT_RE = /([A-Za-z0-9_@][\w.@/+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![ \w.-])/g

/**
 * 量「扩展名不在 REF_EXT 白名单」这一类引用（#678 第 ② 类）。
 *
 * REF_RE 根本不匹配它们，所以它们连 skip 记录都不会产生 —— 是比「首段不是仓库根」更彻底的
 * 隐身。这里用更宽的 `ANY_EXT_RE` 重扫一遍，只保留**真能落到仓库某个文件上**的候选
 * （有 `/` 的按仓库路径 / 后缀匹配，裸名按 basename 索引），这样统计的是「引用了一个真实文件、
 * 但门禁从没看过它」，而不是文档里随手写的 `1.4.0` / `e.g.` 之类噪音。
 *
 * 图片类（png/jpg/… ）由 check:ui-shots 管，单独标注、不计入「本门禁该管」的统计。
 */
const auditOtherExt = (text, index, docRel, out) => {
  const lines = text.split(/\r?\n/)
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const strikes = strikeSpans(line)
    ANY_EXT_RE.lastIndex = 0
    let m
    while ((m = ANY_EXT_RE.exec(line)) !== null) {
      const file = m[1]
      const ext = (file.match(/\.([A-Za-z][A-Za-z0-9]{0,7})$/) ?? [, ''])[1].toLowerCase()
      if (REF_EXT_SET.has(ext)) continue // 白名单内：REF_RE 已管
      const before = m.index === 0 ? '' : line[m.index - 1]
      if (before === '/' || before === '~' || before === '*' || before === '.') continue
      if (strikes.some(([a, b]) => m.index >= a && m.index + m[0].length <= b)) continue
      if (PLACEHOLDER_RE.test(file)) continue
      const segs = file.split('/')
      let hits = []
      if (segs.length > 1) {
        if (SKIP_DIR_NAMES.has(segs[0])) continue
        if (index.paths.has(file)) hits = [file]
        else hits = suffixHits(index, file)
      } else {
        hits = index.byBasename.get(file) ?? []
      }
      if (hits.length === 0) continue // 落不到仓库文件上：不是「被跳过的仓库引用」
      out.push({
        doc: docRel,
        docLine: i + 1,
        raw: m[0],
        file,
        ext,
        shots: SHOT_EXT_SET.has(ext),
        hits,
      })
    }
  })
}

const main = () => {
  const json = process.argv.includes('--json')
  const audit = process.argv.includes('--audit-skipped')
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
  const deleted = []
  const findings = []
  /** 被跳过的引用（只做记账，`--audit-skipped` 时打印；不影响退出码） */
  const skipped = []
  /** 扩展名不在白名单、但确实落到了仓库某个文件上的引用 */
  const otherExt = []
  /** 靠后缀唯一匹配才定位到的引用（#678 新纳入判定） */
  const suffixJudged = []

  for (const full of files) {
    const rel = toPosix(path.relative(ROOT, full))
    const docDir = toPosix(path.relative(ROOT, path.dirname(full))) || '.'
    const text = readFileSync(full, 'utf8')
    const localSkips = []
    for (const ref of extractRefs(text, localSkips)) {
      const result = judgeRef(index, ref, docDir)
      const record = { doc: rel, docLine: ref.line, raw: ref.raw, ...result }
      if (isExempt(rel)) {
        exempt.push(record)
        continue
      }
      if (result.suffix) suffixJudged.push(record)
      if (result.kind === 'deleted-marker') deleted.push(record)
      // judgeRef 层面的「不判定」也记账（裸名找不到 / 裸名多匹配且不定位行号）
      if (result.kind === 'bare-artifact' || result.kind === 'ambiguous-bare') {
        localSkips.push({ raw: ref.raw, file: ref.file, line: ref.line, reason: result.kind })
      }
      if (ref.start === null) pathOnly.push(record)
      else withLine.push(record)
      if (result.verdict !== 'ok') findings.push(record)
    }
    if (audit && !isExempt(rel)) {
      for (const sk of localSkips) skipped.push({ doc: rel, ...sk })
      auditOtherExt(text, index, rel, otherExt)
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
          deletedMarkers: deleted.length,
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
  console.log(
    `  已删除（删除线 ~~…~~ 标记，视为「曾存在、现已删除」）${deleted.length} 处，不判定；改引用为真活路径时请去掉删除线`,
  )
  console.log('')

  if (audit) {
    console.log('—— 跳过 / 曾被跳过的引用（--audit-skipped，仅盘点，不影响退出码）——')
    const byReason = new Map()
    for (const sk of skipped) {
      if (!byReason.has(sk.reason)) byReason.set(sk.reason, [])
      byReason.get(sk.reason).push(sk)
    }
    const reasonRows = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)
    console.log(`  REF_EXT 白名单内的引用里被跳过 ${skipped.length} 处：`)
    for (const [reason, list] of reasonRows) {
      console.log(`    ${reason}  ${list.length} 处 — ${SKIP_REASONS[reason] ?? ''}`)
    }
    const shots = otherExt.filter((o) => o.shots)
    const nonShots = otherExt.filter((o) => !o.shots)
    console.log(
      `  REF_EXT 白名单**外**、但确实落到仓库文件上的引用 ${otherExt.length} 处` +
        `（其中图片类 ${shots.length} 处由 check:ui-shots 管，本门禁该管 ${nonShots.length} 处）：`,
    )
    const byExt = new Map()
    for (const o of nonShots) {
      const key = `${o.shots ? 'img:' : ''}${o.ext}`
      if (!byExt.has(key)) byExt.set(key, [])
      byExt.get(key).push(o)
    }
    for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    .${ext}  ${list.length} 处`)
    }
    console.log('')
    for (const [reason, list] of reasonRows) {
      console.log(`  [${reason}] ${list.length} 处`)
      for (const sk of list) {
        console.log(`    ${sk.doc}:${sk.line}  ${sk.raw}${sk.detail ? `  (${sk.detail})` : ''}`)
      }
      console.log('')
    }
    console.log('  非图片扩展（本门禁该管，但从未判定过）：')
    for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    [.${ext}] ${list.length} 处`)
      for (const o of list) {
        console.log(`      ${o.doc}:${o.docLine}  ${o.raw}  → ${o.hits.slice(0, 2).join(' / ')}`)
      }
    }
    console.log('')
    // suffix 唯一匹配到底救回来多少条 —— 这是 #678 选 A 不选 B 的依据
    console.log(
      `  首段不是仓库根的引用中，按后缀唯一匹配认定成功 ${suffixJudged.length} 处（以前 0 处受判定）；` +
        `后缀多匹配/零匹配 → WARN ${warns.filter((w) => w.kind.startsWith('suffix-')).length} 处`,
    )
    console.log('')
  }

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
