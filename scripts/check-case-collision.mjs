#!/usr/bin/env node
/**
 * check-case-collision.mjs —— 「仅大小写不同」的文件名门禁（Issue #557）。
 *
 * 为什么要有它：#557 里 main 上的 APK / Web 产物同时断在两处，其中一处是
 * `src/components/consume/` 下并存 4 对只差大小写的模块（#487/PR #502 的面板拆分引入的）：
 *
 *     AccountPanel.tsx / accountPanel.ts      QuotaPanel.tsx  / quotaPanel.ts
 *     InvitePanel.tsx  / invitePanel.ts       EmailBindPanel.tsx / emailBindPanel.ts
 *
 * 在大小写**敏感**的文件系统（Linux / CI）上这是两个互不相干的文件，看不出任何问题；
 * 到了大小写**不敏感**的文件系统（macOS 默认 APFS、Windows NTFS）上，它们是同一批名字，于是：
 *   · `tsc`  → `TS1261: Already included file name '…/QuotaPanel.ts' differs from file name
 *              '…/quotaPanel.ts' only in casing` —— `pnpm type` 红；
 *   · rspack → `ESModulesLinkingError: export 'AccountPanel' was not found in './AccountPanel.js'`
 *              （`./AccountPanel.js` 被解析到小写那份）—— `pnpm build` 红；
 *   · git 本身也会恶心：`core.ignorecase=true` 的克隆里一次 checkout 只能落地其中一个。
 * 而 Linux 上的 CI 永远绿 —— 这正是它一路漂到 main 的原因。人工 review 也靠不住：
 * 一屏 diff 里 `AccountPanel.tsx` 与 `accountPanel.ts` 长得就像同一个文件的两个扩展名。
 *
 * 所以判据必须机械化。三条规则（互相独立，命中任意一条就红）：
 *
 *   R1 路径仅大小写不同      `Foo.ts` / `foo.ts`、`src/A/x.ts` / `src/a/x.ts`
 *                             —— 任何两处内容都可能在 macOS 上互相覆盖。
 *   R2 目录名仅大小写不同    `src/Consume/` 与 `src/consume/` 并存
 *                             —— 目录级的 R1，同样会让 checkout 只落地一半。
 *   R3 模块 stem 仅大小写不同（同目录、模块类扩展名 `.ts/.tsx/.mts/.cts/.d.ts/.js/.jsx/.mjs/.cjs`）
 *                             —— **#557 真正踩到的就是这条**：`AccountPanel.tsx` 与 `accountPanel.ts`
 *                             全名不同（`.tsx` ≠ `.ts`），但 `import './accountPanel'` 在大小写不敏感
 *                             的盘上会同时匹配到两者，模块解析要么歧义、要么选中错的那份。
 *                             R1 抓不到它（扩展名确实不一样），所以 R3 必需。
 *
 * 不看 `a.json` / `a.png` 这种「同 stem、不同非模块扩展名」的组合：`docs/ui/**` 里大量成对出现
 * （截图 + 同名测量数据），那不是模块，也不存在解析歧义 —— 一个什么都报的门禁等于没有门禁。
 *
 * 扫描范围：`git ls-files --cached --others --exclude-standard`，即**已跟踪 + 未跟踪但未被忽略**的文件。
 * 带上未跟踪的那部分是有意的：名字撞车的代价在 `git add` 之前就已经存在（macOS 上文件根本存不下第二份），
 * 等进了索引再拦就晚了；而 `dist-*`、`node_modules/` 这些产物目录本来就在 `.gitignore` 里，不会进来。
 *
 * 用法：
 *   node scripts/check-case-collision.mjs            # 有撞车 → exit 1
 *   node scripts/check-case-collision.mjs --verbose  # 额外打印扫描计数与规则口径
 *   node scripts/check-case-collision.mjs --selftest # 只用合成清单验判据（不读仓库）
 *   pnpm run check:case-collision
 *
 * 退出码：0 干净 / 1 有撞车 / 2 用法或环境错误（不是 git 仓库、git 不可用）
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 模块类扩展名：只有这些参与 R3（`.d.ts` 先于 `.ts` 匹配，避免 stem 被切成 `x.d`） */
const MODULE_EXT = /\.(?:d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i

const dirOf = (file) => {
  const index = file.lastIndexOf('/')
  return index < 0 ? '' : file.slice(0, index)
}

const baseOf = (file) => {
  const index = file.lastIndexOf('/')
  return index < 0 ? file : file.slice(index + 1)
}

/** 模块 stem（含目录）：`src/a/Foo.d.ts` → `src/a/Foo`。非模块文件返回 null。 */
const moduleStem = (file) => (MODULE_EXT.test(file) ? file.replace(MODULE_EXT, '') : null)

/** 按 key 分组，只留 size > 1 的组（key 一律已经小写化） */
const groupsOf = (files, keyOf) => {
  const buckets = new Map()
  for (const file of files) {
    const key = keyOf(file)
    if (key === null) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(file)
    else buckets.set(key, [file])
  }
  return [...buckets.entries()].filter(([, members]) => members.length > 1)
}

/**
 * 纯判据：给一串仓库相对路径，返回三类违规。**没有任何 IO** —— `--selftest` 与真跑共用这一份实现，
 * 所以自检证明的是真判据（不是另一份长得像判据的东西）。
 */
export const findCollisions = (files) => {
  // R1：整条路径小写后相同（覆盖 R2 的「文件级」表现，也覆盖同名不同目录大小写）
  const r1 = groupsOf(files, (file) => file.toLowerCase()).filter(
    ([, members]) => new Set(members).size > 1
  )

  // R2：目录名仅大小写不同 —— 按 (父目录小写 + 目录名小写) 分组，组里出现 ≥2 个**不同**的真实目录名
  const r2ByKey = new Map()
  for (const dir of new Set(files.map(dirOf).filter(Boolean))) {
    const parent = dirOf(dir)
    const key = `${parent.toLowerCase()}/${baseOf(dir).toLowerCase()}`
    const bucket = r2ByKey.get(key) ?? new Set()
    bucket.add(dir)
    r2ByKey.set(key, bucket)
  }
  const r2 = [...r2ByKey.entries()].filter(([, dirs]) => dirs.size > 1)

  // R3：模块 stem 仅大小写不同（#557 的主判据）
  const r3 = groupsOf(files, (file) => {
    const stem = moduleStem(file)
    return stem === null ? null : stem.toLowerCase()
  }).filter(([, members]) => members.length > 1)

  return {
    pathCase: r1.map(([, members]) => members),
    dirCase: r2.map(([, dirs]) => [...dirs]),
    moduleCase: r3.map(([, members]) => members),
  }
}

const countOf = (report) =>
  report.pathCase.length + report.dirCase.length + report.moduleCase.length

const printReport = (report, { verbose }) => {
  const { pathCase, dirCase, moduleCase } = report
  const total = countOf(report)

  if (total === 0) {
    if (verbose)
      console.log('[case-collision] 0 组：R1 路径 / R2 目录 / R3 模块 stem 均无「仅大小写不同」')
    else console.log('[case-collision] OK：仓库里没有「仅大小写不同」的文件名')
    return
  }

  console.error(
    `[case-collision] 发现 ${total} 组「仅大小写不同」的名字（macOS/Windows 上会互相覆盖或令模块解析歧义）：`
  )
  if (pathCase.length > 0) {
    console.error('\n  R1 整条路径仅大小写不同（大小写不敏感的文件系统只能落地其中一个）：')
    for (const members of pathCase) console.error(`    ✗ ${members.join('\n      ~ ')}`)
  }
  if (dirCase.length > 0) {
    console.error('\n  R2 目录名仅大小写不同（同上，整个目录会打架）：')
    for (const dirs of dirCase) console.error(`    ✗ ${dirs.join('\n      ~ ')}`)
  }
  if (moduleCase.length > 0) {
    console.error(
      '\n  R3 同目录下模块 stem 仅大小写不同（#557 的形态：import 会在大小写不敏感的盘上选错文件）：'
    )
    for (const members of moduleCase) console.error(`    ✗ ${members.join('\n      ~ ')}`)
  }
  console.error(
    '\n修法（#557 选的是 A）：把实现文件改成语义明确、且不与容器组件撞车的名字（如 `accountPanelModel.ts`），' +
      '\n并同步更新 import。只改大小写不行：在 macOS 上 `git mv foo.ts Foo.ts` 不会被记录，' +
      '\n要用两步（`git mv foo.ts foo.ts.tmp && git mv foo.ts.tmp FooModel.ts`）。'
  )
}

/** 仓库里的真实文件清单。`--cached --others --exclude-standard` = 已跟踪 + 未跟踪未被忽略。 */
const listRepoFiles = () => {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    )
    return out.split('\0').filter(Boolean)
  } catch (error) {
    console.error(
      `[case-collision] 读不到 git 文件清单（${error.message}）—— 这道门禁需要 git 仓库与 git 可执行文件`
    )
    process.exit(2)
  }
}

/**
 * `--selftest`：判据自己的负向对照（#369 的规矩 —— 门禁也要有反例证明它会咬）。
 * 五条反例 + 两条正例，任一条不符预期就 exit 1。
 */
const selftest = () => {
  const cases = [
    {
      name: 'R1 路径仅大小写不同（题面给的 Foo.ts / foo.ts）',
      files: ['src/Foo.ts', 'src/foo.ts'],
      expect: (report) => report.pathCase.length === 1 && report.moduleCase.length === 1,
    },
    {
      name: 'R2 目录名仅大小写不同',
      files: ['src/Consume/A.ts', 'src/consume/B.ts'],
      expect: (report) => report.dirCase.length === 1 && report.pathCase.length === 0,
    },
    {
      name: 'R3 #557 的形态：AccountPanel.tsx / accountPanel.ts（扩展名不同，R1 抓不到）',
      files: ['src/components/consume/AccountPanel.tsx', 'src/components/consume/accountPanel.ts'],
      expect: (report) => report.moduleCase.length === 1 && report.pathCase.length === 0,
    },
    {
      name: 'R3 不该被 .d.ts 骗过（Foo.d.ts / foo.ts）',
      files: ['src/Foo.d.ts', 'src/foo.ts'],
      expect: (report) => report.moduleCase.length === 1,
    },
    {
      name: '正例：非模块扩展名同 stem 不算撞车（docs/ui/a.json + a.png）',
      files: ['docs/ui/a.json', 'docs/ui/a.png', 'src/a.ts', 'src/b.ts'],
      expect: (report) => countOf(report) === 0,
    },
    {
      name: '正例：大小写不同但 stem 不同（AccountPanel.tsx / panels.ts）',
      files: ['src/AccountPanel.tsx', 'src/panels.ts'],
      expect: (report) => countOf(report) === 0,
    },
  ]

  let failed = 0
  for (const item of cases) {
    const report = findCollisions(item.files)
    const ok = item.expect(report)
    if (!ok) {
      failed++
      console.error(`✗ selftest 失败：${item.name}`)
      console.error(`  输入：${item.files.join(', ')}`)
      console.error(
        `  实际：R1=${report.pathCase.length} R2=${report.dirCase.length} R3=${report.moduleCase.length}`
      )
    } else {
      console.log(`✓ ${item.name}`)
    }
  }
  if (failed > 0) {
    console.error(
      `\n[case-collision] selftest 失败 ${failed}/${cases.length} 条 —— 判据本身坏了，别信它的绿灯`
    )
    process.exit(1)
  }
  console.log(
    `\n[case-collision] selftest 通过：${cases.length}/${cases.length} 条（含 4 条反例 + 2 条正例）`
  )
}

const main = (argv) => {
  const unknown = argv.filter((arg) => !['--verbose', '--selftest', '--'].includes(arg))
  if (unknown.length > 0) {
    console.error(`[case-collision] 未知参数：${unknown.join(' ')}`)
    console.error('用法：node scripts/check-case-collision.mjs [--verbose] [--selftest]')
    process.exit(2)
  }
  if (argv.includes('--selftest')) {
    selftest()
    return
  }
  const verbose = argv.includes('--verbose')
  const files = listRepoFiles()
  const report = findCollisions(files)
  if (verbose)
    console.log(`[case-collision] 扫描 ${files.length} 个文件（已跟踪 + 未跟踪未被忽略）`)
  printReport(report, { verbose })
  process.exit(countOf(report) === 0 ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
