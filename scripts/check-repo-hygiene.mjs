#!/usr/bin/env node
/**
 * check-repo-hygiene.mjs —— 仓库卫生门禁（Issue #291；#302 收尾）。
 *
 * 为什么要有它：#291 体检时发现 `docs/` + `repro/` 里躺着 745 个取证产物、71.3 MiB，
 * 其中 69 个文本文件写着 `D:\all_project\runs\compatold\…` 这类**本机绝对路径**。
 * 代价不是磁盘，是「搜代码」：`git grep zip|import|toast` 会被 492 张 png 的路径和 25 份
 * 3 MB 级 logcat 刷屏；而绝对路径在别人机器上根本不存在，照它复现只会得到「文件不存在」。
 * 手工清理只能清一次，所以把这两件事变成一条命令：**再写进去就 exit 1**。
 *
 * 拦两类：
 *   1. 本机绝对路径（换台机器就无法复核）
 *      - Windows 盘符：`D:/`、`D:\`、`C:\Users\`（排除 `https://` 这类 scheme，见 PATTERNS 的负向断言）
 *      - Git-Bash / MSYS 形态：`/d/all_project`、`/home/<user>`、`/Users/<user>`
 *   2. 单文件体积超阈值（大文本进仓库 = 取证/日志全量入库）
 *
 * 体积阈值 512 KiB（524 288 B）：
 *   #291 落地时取的是 1 MiB，理由只有一个 —— 存量 `docs/ui/180-guard-i18n/api30/logcat-api30.txt`
 *   是 539 949 B，而 `docs/ui/**` 当时是「整目录不动」的边界，512 KiB 会让门禁在存量上直接红。
 *   #302 把那 3 份全量 logcat（539 949 / 316 342 / 117 083 B）按 #291 的「摘录口径」压成
 *   ~24 KB 的摘录，存量最大文本变成 `docs/compat/matrix/es-floor.json`（270 581 B）——
 *   那条「只能取 1 MiB」的理由已经不成立，于是回到 #291 正文最初写的 512 KiB，
 *   把「再把全量 logcat 搬回仓库」重新变成红灯（这正是本单修掉的失效模式）。
 *
 * 豁免（EXEMPT_*，逐条给理由；打印时会计数，避免以后被当成漏网）：
 *   - `docs/repro/g1..g8-*.md`（8 份）：已关闭 issue（#13/#14/#18/#19/#22/#24/#25/#28/#30/#31/#32/
 *     #34/#35/#36/#37/#38/#41/#43/#44/#45/#46）的取证记录，里面那些 `/d/all_project/runs/g*` 是
 *     当时的现场路径；改成相对路径等于改历史证词，破坏一致性，故显式豁免
 *   - `docs/ui/**` 的**目录级**豁免已在 #302 删除：那 38 处本机路径（13 个文件：一次性 measure/cdp
 *     脚本的 adb 默认值、`result-180.json` 的 provenance 字段、`firstscreen-results.json` 的
 *     screens 列表、`settings-cell-wrap/README.md` 的 AVD 目录）全部改成仓库相对路径 / `<worktree>`
 *     占位 / 走 PATH 的 `adb`，现在 `docs/ui/**` 零豁免、零命中。
 *
 * 用法：
 *   node scripts/check-repo-hygiene.mjs
 *   pnpm run check:hygiene
 *   node scripts/check-repo-hygiene.mjs --verbose   # 额外打印豁免清单与扫描文件数
 *
 * 退出码：0 干净 / 1 发现违规 / 2 用法或环境错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫这些目录（相对仓库根）。`repro/` 在 #291 里已整目录删除，留着是防它被重新引入。 */
const SCAN_DIRS = ['docs', 'repro']

/**
 * 为什么只扫 docs/ 与 repro/（#291 的口径）：
 *   `src/` `tests/` `scripts/` 里也存在 `D:/android-sdk` 这类字面量 —— 但它们是**测试夹具**与
 *   `scripts/compat/lib/matrix-config.mjs` 的历史默认值，受各自的门禁与 #291 的边界约束，不是
 *   「文档里写死本机路径」这一类问题。要扩到这三个目录，得先把存量清干净再改这里，否则门禁一上线
 *   就是红的（这件事留给 follow-up，不在这张单里顺手做）。
 */

/** 任意层级都不看的目录名 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-scroll',
  'dist-internal',
  '.git',
  '.workflow-lite',
  'coverage',
  'android',
])

/** 只看文本；二进制/截图一律跳过（体积规则也不该拦 png） */
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
  '.csv',
  '.xml',
])

/** 体积阈值：单个文本文件 > 512 KiB 即违规（理由见文件头；#302 起从 1 MiB 收回 512 KiB） */
export const TEXT_FILE_LIMIT = 512 * 1024

/**
 * 本机绝对路径的判定规则。
 * 负向断言 `(?<![A-Za-z0-9+.\-])` 是为了放过 `https://`、`chrome://`、`HEAD:refs/heads/…`
 * 这类「字母 + 冒号」的合法写法 —— 它们同样是 `[A-Za-z]:[/]` 的形状。
 */
export const PATTERNS = [
  {
    id: 'win-drive',
    // D:/  D:\  C:\Users\  —— 盘符 + 分隔符
    re: /(?<![A-Za-z0-9+.\-])[A-Za-z]:[\\/]/,
    label: 'Windows 盘符绝对路径（D:/、C:\\Users\\…）',
  },
  {
    id: 'posix-home-drive',
    // /d/all_project  /home/<user>  /Users/<user>
    re: /(?<![A-Za-z0-9_.\-])\/(?:[a-z]\/)?(?:Users|users|home)\/[A-Za-z0-9_.\-]+/,
    label: 'POSIX 形态本机路径（/home/<user>、/Users/<user>）',
  },
  {
    id: 'msys-drive',
    // /d/all_project  /d/runs …（Git-Bash 盘符挂载）
    re: /(?<![A-Za-z0-9_.\-])\/[a-z]\/(?:all_project|runs|repos|projects)\b/,
    label: 'Git-Bash 盘符挂载路径（/d/all_project/…）',
  },
]

/**
 * 本机绝对路径规则的豁免（不影响体积规则）。
 * 每条都要写清为什么 —— 豁免不是漏网，是「这批不动」。
 * #302 之后只剩 `docs/repro/**` 这 8 份：`docs/ui/**` 的目录级豁免已删（存量已清零，见文件头）。
 */
const EXEMPT_ABS_PATHS = [
  ...[
    'g1-issue-38-34-24.md',
    'g2-issue-40-49-50.md',
    'g3-issue-32-14-18.md',
    'g4-issue-13-39-10.md',
    'g5-issue-30-31-28.md',
    'g6-issue-45-46-25-44.md',
    'g7-issue-19-41.md',
    'g8-issue-37-35-36-43-22.md',
  ].map(
    (f) => ({
      path: `docs/repro/${f}`,
      reason: '已关闭 issue 的取证记录：现场路径即证词，改成相对路径会破坏历史一致性（#291 显式豁免）',
    }),
  ),
]

const log = (...a) => console.log(...a)

const walk = (dir, out) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

const absExemptionFor = (relPath) => {
  for (const item of EXEMPT_ABS_PATHS) if (item.path === relPath) return item.reason
  return null
}

const main = () => {
  const verbose = process.argv.includes('--verbose')
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) continue
    walk(full, files)
  }
  if (files.length === 0) {
    console.error('check:hygiene 没扫到任何文件，检查 SCAN_DIRS 与工作目录')
    process.exit(2)
  }

  const violations = []
  let exemptHits = 0
  const exemptUsed = new Set()

  for (const file of files) {
    const relPath = rel(file)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }

    // ---- 规则 1：体积 ----
    if (stat.size > TEXT_FILE_LIMIT) {
      violations.push({
        file: relPath,
        line: 0,
        kind: 'size',
        detail: `${stat.size} B > ${TEXT_FILE_LIMIT} B（${(stat.size / 1024 / 1024).toFixed(2)} MiB）；`
          + '取证全文请留在工作树或附件里，仓库只放结论与摘录',
      })
    }

    // ---- 规则 2：本机绝对路径 ----
    const exemption = absExemptionFor(relPath)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue // 二进制混入文本扩展名，跳过
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]
      for (const pattern of PATTERNS) {
        if (!pattern.re.test(lineText)) continue
        if (exemption) {
          exemptHits++
          exemptUsed.add(relPath)
          continue
        }
        violations.push({
          file: relPath,
          line: i + 1,
          kind: pattern.id,
          detail: lineText.trim().slice(0, 160),
        })
      }
    }
  }

  if (violations.length === 0) {
    log(`check:hygiene OK —— 扫描 ${files.length} 个文本文件，无本机绝对路径、无超过 ${TEXT_FILE_LIMIT} B 的文件`)
    if (exemptHits > 0) log(`  豁免命中 ${exemptHits} 处（${exemptUsed.size} 个文件，均为已声明的关单证据）`)
    if (verbose) {
      log('\n豁免清单（本机绝对路径规则；体积规则不豁免）：')
      for (const item of EXEMPT_ABS_PATHS) log(`  - ${item.path}\n      ${item.reason}`)
    }
    return
  }

  console.error(`check:hygiene 失败：${violations.length} 处违规\n`)
  for (const v of violations) {
    if (v.kind === 'size') console.error(`  ${v.file}: ${v.detail}`)
    else console.error(`  ${v.file}:${v.line}: [${v.kind}] ${v.detail}`)
  }
  console.error(
    '\n修法：本机路径改成仓库相对路径（`docs/…`）或占位（`<repo>/…`、`<worktree>/…`、`<android-sdk>`）；'
      + '大文件只留摘录与结论，全文放工作树或 issue 附件。规则与豁免见 scripts/check-repo-hygiene.mjs 文件头（#291）。',
  )
  if (exemptHits > 0) console.error(`（另有 ${exemptHits} 处命中已豁免的关单证据，未计入）`)
  process.exit(1)
}

main()
