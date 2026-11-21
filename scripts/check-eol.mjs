#!/usr/bin/env node
/**
 * check-eol.mjs —— 行尾门禁（Issue #533，最后一块拼图）。
 *
 * ## 为什么要有它
 *
 * #533 的起点：#323（大包导入流式）30 个改动文件里 **27 个只有行尾不同**，`+8126/−7757`
 * 里一大半是 CRLF 噪音 —— 「17 个真实冲突」被放大成「19 个文件 21 个 hunk」，
 * review 看不出真实改动，`git blame` 也失效。
 *
 * `.gitattributes`（`* text=auto eol=lf` + `*.bat -text` + 二进制白名单）解决了
 * **新提交**的归一问题，但解决不了两件事：
 *   ① 历史 CRLF blob 会一直躺在索引里 —— `eol=lf` 只在 **checkin** 时把 CRLF 归一成 LF，
 *      它**不会**在 checkout 时把已有 CRLF blob 转成 LF（实测：`i/crlf w/crlf` 的文件
 *      `git checkout -- <file>` 之后仍然是 CRLF）。所以只加 `.gitattributes` 不够，
 *      必须有人把存量按索引重写一遍（本单第二个 commit 干这件事）。
 *   ② 没有门禁 = 下一个人（尤其 Windows 上 `core.autocrlf=true` 的环境）还会再塞回来。
 *
 * ## 判据
 *
 * 扫**会进仓库的文本文件** —— `git ls-files --cached --others --exclude-standard`
 * 的并集（已跟踪 + 未跟踪但没被 ignore），跳过 node_modules / dist / 二进制；
 * 内容里出现第一个 `\r\n` 就算违规，打印 `文件:首个 CRLF 行号` 并 exit 1。
 *
 * 为什么把**未跟踪**的文件也算进来：只扫 `--cached` 时，`printf 'x\r\n' > src/x.mjs`
 * 这种「刚造出来、还没 add」的探针是**绿**的 —— 而它恰好是噪音进入仓库前的最后一秒。
 * `--exclude-standard` 保证 `node_modules` / `dist*` / `coverage` 这些不入库的东西不扫，
 * 所以本地产物不会制造假红；报告里两类分开标注（未跟踪的带 `[未跟踪]`）。
 *
 * 为什么看**工作区内容**而不是索引：行号只有工作区文件才有；而「索引里还是 CRLF」的
 * 唯一后果是工作区被检出成 CRLF（上面 ① 实测过），所以工作区扫描能覆盖这两种形态。
 *
 * ## 豁免（逐类给理由；打印时会计数，避免以后被当成漏网）
 *
 *   · `*.bat` / `*.cmd` —— `.gitattributes` 里写的是 `-text`：cmd.exe 解析 label / goto
 *     在 LF-only 下有坑，所以这类文件在工作区与索引里都保持 CRLF（`android/gradlew.bat`）。
 *     注意这是「按约定不转」而不是「检查漏了」。
 *   · 二进制 —— 两类来源，都从 `.gitattributes` 的 `binary` / `-text` 行**读出来**
 *     （单一来源：改 `.gitattributes` 就等于改门禁口径，两边不会漂）。
 *     `BINARY_EXT_FALLBACK` 只是兜底（`.gitattributes` 被人误删时门禁不该把 png 当文本报）。
 *   · 内容嗅探 —— 前 8 KiB 有 NUL 字节的当二进制跳过（与 git 的文本探测同口径），
 *     这样即使某个二进制扩展名没登记，也不会打出「png 有 CRLF」这种假红。
 *
 * ## 用法
 *
 *   node scripts/check-eol.mjs                # 门禁（CI 跑这条）
 *   pnpm run check:eol
 *   node scripts/check-eol.mjs --fix          # 把违规文本文件原地归一为 LF（保留 BOM 与其余字节）
 *   node scripts/check-eol.mjs --verbose      # 额外打印扫描/豁免统计
 *   node scripts/check-eol.mjs --selftest     # 自带反例：临时仓库里 CRLF 文本必须红、.bat 与二进制必须绿
 *
 * 退出码：0 干净 / 1 有违规 / 2 用法或环境错误
 *
 * ## 修法
 *
 *   node scripts/check-eol.mjs --fix && git add -u && git commit -m "chore(eol): 归一 CRLF"
 *
 * Windows 贡献者：`git config core.autocrlf false`（或 `input`），**不要用 `true`** ——
 * `true` 会在 checkout 时把 LF 写成 CRLF，于是你本地每个文件都是脏的，提交上去又互相打架。
 * 详见 AGENTS.md「行尾（EOL）」一节。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 任意层级都不看的目录（`.git` 本来就不在 `git ls-files` 里，留着是防御） */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-scroll',
  'dist-internal',
  'dist-legacy',
  'coverage',
  '.git',
  '.workflow-lite',
])

/**
 * 二进制扩展名兜底表（**不是**真相源）。
 *
 * 真相源是 `.gitattributes` 里的 `binary` / `-text` 行 —— 那几行同时决定 git 的转换行为
 * 与本题的豁免口径，两边必须一致，所以这里不重复维护全表，只放一份「哪怕 .gitattributes
 * 误删也不该把图片当文本」的最小集合（与 #533 正文点名的类型一致）。
 */
const BINARY_EXT_FALLBACK = new Set([
  '.apk', '.aab', '.zip', '.jar', '.keystore', '.jks', '.p12',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.heic', '.bcmap',
  '.pdf', '.docx', '.xlsx', '.mp4', '.webm',
])

/** 文本探测窗口（与 git 的 `FIRST_FEW_BYTES` 同量级） */
const SNIFF_BYTES = 8192

// ───────────────────────────── .gitattributes 解析 ─────────────────────────────

/**
 * 从 `.gitattributes` 读出「不做行尾转换」的模式。
 *
 * 规则：属性里出现 `binary`（等价 `-diff -merge -text`）或 `-text` 即为豁免。
 * 注意 `!eol` / `eol=lf` **不算**豁免 —— 那是「要转」，正好相反。
 *
 * @param {string} root
 * @returns {{ patterns: string[], source: string }}
 */
const readGitattributesExemptions = (root) => {
  const file = path.join(root, '.gitattributes')
  if (!fs.existsSync(file)) return { patterns: [], source: '(无 .gitattributes)' }
  const patterns = []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [pattern, ...attrs] = line.split(/\s+/)
    if (!pattern || attrs.length === 0) continue
    const noConvert = attrs.some((attr) => attr === 'binary' || attr === '-text')
    if (noConvert) patterns.push(pattern)
  }
  return { patterns, source: '.gitattributes' }
}

/**
 * gitattributes 模式 → 正则。
 *
 * 支持本仓库实际用到的形态：`*.ext`、`**​/*.ext`、`dir/**`、`dir/*.ext`、字面路径。
 * 不做完整 gitattributes 语义（不支持 `[]` 字符类、不支持 `!` 反转）——
 * 真需要时在这里加，别在别处偷偷放行。
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
const patternToRegExp = (pattern) => {
  // gitattributes 语义：不含 `/` 的模式匹配**任意层级**的同名文件（`*.bat` 命中
  // `android/gradlew.bat`）。少了这条，`.bat` 豁免会在子目录里失效 —— 而这个错很隐蔽：
  // 门禁会开始报 `android/gradlew.bat`，看着像「豁免写错了」，其实匹配口径写错了。
  const anchored = pattern.includes('/') ? pattern : `**/${pattern}`
  let out = ''
  for (let i = 0; i < anchored.length; i++) {
    const ch = anchored[i]
    if (ch === '*') {
      if (anchored[i + 1] === '*') {
        i++ // 吃掉第二个 *
        if (anchored[i + 1] === '/') {
          // `**/`：跨目录（零层也认，与 gitattributes 的 `**/foo` 一致）
          i++
          out += '(?:.*/)?'
        } else {
          // 结尾的 `/**` 或中间的 `**`：跨整棵子树
          out += '.*'
        }
        continue
      }
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// ───────────────────────────── 扫描 ─────────────────────────────

/**
 * `git ls-files -z --cached --others --exclude-standard` 的仓库相对路径列表。
 *
 * 为什么不是只有 `--cached`（#533 自带的验收就是「人为制造一个 CRLF 文件 → 红」）：
 * 只扫已跟踪文件，那么 `printf 'x\r\n' > src/x.mjs` 这种「刚造出来、还没 add」的
 * 探针会**绿**——而它正是下一次 `git add` 会把噪音带进仓库的那一刻，也是本门禁唯一
 * 还来得及拦的时刻。`--exclude-standard` 让 `.gitignore` / `.git/info/exclude` 里的东西
 * （`node_modules`、`dist*`、`coverage`、构建中间物）照旧不扫，所以本地产物不会假红。
 *
 * 两类文件在报告里分开标注（`[未跟踪]`）：已跟踪 = 已经进过仓库的行尾债；
 * 未跟踪 = 你正要提交的行尾噪音。
 *
 * `-z`：仓库里存在含引号 / 空格的路径（`git ls-files | sed 's/.*\\.//'` 见过
 * `png"` 这种尾巴），按换行切会切坏，所以走 NUL 分隔。
 *
 * @param {string} root
 * @returns {{ file: string, tracked: boolean }[]}
 */
const listCandidateFiles = (root) => {
  const run = (args) =>
    execFileSync('git', ['ls-files', '-z', ...args], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\u0000')
      .filter(Boolean)

  const tracked = new Set(run(['--cached']))
  const others = run(['--others', '--exclude-standard'])
  const all = [...tracked, ...others.filter((file) => !tracked.has(file))]
  return all.map((file) => ({ file, tracked: tracked.has(file) }))
}

/** 路径里任意一段命中 SKIP_DIRS 就跳过 */
const inSkippedDir = (relPath) => relPath.split('/').some((seg) => SKIP_DIRS.has(seg))

/** 前 8 KiB 有 NUL → 当二进制（与 git 的文本探测同口径） */
const looksBinary = (buffer) => buffer.subarray(0, SNIFF_BYTES).includes(0)

/**
 * 找首个 CRLF，返回 `{ index, line }`；没有则返回 null。
 *
 * 行号口径：首个 CRLF 里那个 `\n` 之前出现过多少个 `\n`，再加 1 —— 也就是
 * 编辑器里看到的那一行（含首行 = 1）。
 *
 * @param {Buffer} buffer
 * @returns {{ index: number, line: number, count: number } | null}
 */
const findCrlf = (buffer) => {
  let first = -1
  let count = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
      if (first < 0) first = i
      count++
    }
  }
  if (first < 0) return null
  // 行号 = 首个 CR 之前出现过的 `\n` 数 + 1（首行即 1）
  let line = 1
  for (let i = 0; i < first; i++) if (buffer[i] === 0x0a) line++
  return { index: first, line, count }
}

/**
 * 扫一个仓库根，返回违规与统计。
 *
 * 抽成函数（而不是写死在 main 里）是为了 `--selftest` 能在临时仓库上跑同一套判据 ——
 * 「判据」和「跑判据的壳」分开，自检才是在验真东西。
 *
 * @param {string} root
 * @returns {{ violations: { file: string, line: number, count: number, tracked: boolean }[], scanned: number, exemptCount: number, exemptUsed: Map<string, number> }}
 */
const scan = (root) => {
  const { patterns } = readGitattributesExemptions(root)
  const exemptMatchers = patterns.map((pattern) => ({ pattern, re: patternToRegExp(pattern) }))

  const files = listCandidateFiles(root).filter((entry) => !inSkippedDir(entry.file))
  const violations = []
  const exemptUsed = new Map()
  let scanned = 0
  let exemptCount = 0

  for (const { file: relPath, tracked } of files) {
    const abs = path.join(root, relPath)
    let buffer
    try {
      const stat = fs.statSync(abs)
      if (!stat.isFile()) continue
      buffer = fs.readFileSync(abs)
    } catch {
      continue // 索引里有、工作区没有（被删但没 stage）：不归本门禁管
    }

    const exemptionHit = exemptMatchers.find((m) => m.re.test(relPath))
    const ext = path.extname(relPath).toLowerCase()
    const exempt =
      Boolean(exemptionHit) || BINARY_EXT_FALLBACK.has(ext) || looksBinary(buffer)

    const hit = findCrlf(buffer)
    if (exempt) {
      if (hit) {
        exemptCount++
        exemptUsed.set(relPath, hit.count)
      }
      continue
    }
    scanned++
    if (hit) violations.push({ file: relPath, line: hit.line, count: hit.count, tracked })
  }

  return { violations, scanned, exemptCount, exemptUsed }
}

// ───────────────────────────── --fix ─────────────────────────────

/**
 * 原地归一为 LF。
 *
 * 按 **Buffer** 做替换（`latin1` 往返是逐字节的）而不是 utf8 解码后替换：这样
 * BOM（EF BB BF）、GBK 残留、任何非 UTF-8 字节都原样保留 —— 本门禁只允许改行尾，
 * 「顺手修了编码」会让 diff 变成整文件重写，正是 #533 要消灭的东西。
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {boolean} 是否真的改了
 */
const fixOne = (root, relPath) => {
  const abs = path.join(root, relPath)
  const before = fs.readFileSync(abs)
  if (!before.includes(0x0d)) return false
  const after = Buffer.from(before.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  if (Buffer.compare(before, after) === 0) return false
  fs.writeFileSync(abs, after)
  return true
}

// ───────────────────────────── --selftest ─────────────────────────────

/**
 * 自带反例（与 `check-case-collision.mjs --selftest` / `check-db-version.mjs --selftest` 同风格）。
 *
 * 在临时目录建一个**真 git 仓库**，放四份文件：
 *   · `plain.mjs`   CRLF 文本      → 必须被报（判据咬得住）
 *   · `ok.mjs`      LF 文本        → 必须不被报（不能恒红）
 *   · `run.bat`     CRLF + `-text` → 必须不被报（豁免来自 .gitattributes，不是写死的白名单）
 *   · `blob.bcmap`  CRLF 二进制    → 必须不被报（二进制白名单）
 * 再补一拍 `--fix`：修完必须干净，且 `plain.mjs` 的**除行尾外**字节不变（BOM 也还在）。
 *
 * @returns {number} 退出码
 */
const selftest = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-eol-selftest-'))
  const fail = (message) => {
    console.error(`check:eol --selftest 失败：${message}`)
    console.error(`（临时仓库留在 ${dir}，可手工复核）`)
    return 1
  }
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' })
    fs.writeFileSync(path.join(dir, '.gitattributes'), [
      '* text=auto eol=lf',
      '*.bat -text !eol',
      '*.bcmap binary',
      '',
    ].join('\n'))
    // BOM + CRLF：--fix 必须保留 BOM
    fs.writeFileSync(path.join(dir, 'plain.mjs'), Buffer.from('\uFEFFexport const a = 1\r\nexport const b = 2\r\n', 'utf8'))
    fs.writeFileSync(path.join(dir, 'ok.mjs'), 'export const c = 3\n')
    fs.writeFileSync(path.join(dir, 'run.bat'), '@echo off\r\ngoto :eof\r\n')
    fs.writeFileSync(path.join(dir, 'blob.bcmap'), Buffer.concat([Buffer.from('BZ\r\n'), Buffer.from([0x00, 0x01, 0x0d, 0x0a])]))
    // 被 ignore 的目录：必须**不**被报（node_modules / dist 这类本地产物不能假红）
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n')
    fs.mkdirSync(path.join(dir, 'ignored'))
    fs.writeFileSync(path.join(dir, 'ignored', 'skip.mjs'), 'export const e = 5\r\n')
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })
    // 未跟踪的 CRLF 文本：**在 `git add` 之后**才写，所以它没进索引 —— 必须照样被报
    // （它就是下一次 `git add` 要带进仓库的噪音），否则 `printf 'x\r\n' > src/x.mjs`
    // 这种最自然的负向对照会是绿的。
    fs.writeFileSync(path.join(dir, 'untracked.mjs'), 'export const d = 4\r\n')

    const first = scan(dir)
    const flagged = first.violations.map((v) => v.file).sort()
    if (JSON.stringify(flagged) !== JSON.stringify(['plain.mjs', 'untracked.mjs'])) {
      return fail(`应只报 plain.mjs + untracked.mjs，实际报了 ${flagged.length ? flagged.join(', ') : '（什么都没报）'}`)
    }
    const plainHit = first.violations.find((v) => v.file === 'plain.mjs')
    if (plainHit.line !== 1) {
      return fail(`行号应为 1（首行就是 CRLF），实际 ${plainHit.line}`)
    }
    if (plainHit.tracked !== true) return fail('plain.mjs 已进索引，应标成 tracked')
    const untrackedHit = first.violations.find((v) => v.file === 'untracked.mjs')
    if (untrackedHit.tracked !== false) return fail('untracked.mjs 没进索引，应标成 [未跟踪]')
    if (first.violations.some((v) => v.file.startsWith('ignored/'))) {
      return fail('.gitignore 里的 ignored/skip.mjs 被报了 —— --exclude-standard 没生效，本地产物会假红')
    }

    const fixed = fixOne(dir, 'plain.mjs')
    if (!fixed) return fail('--fix 报告「没改」，但 plain.mjs 确实含 CRLF')
    const after = fs.readFileSync(path.join(dir, 'plain.mjs'))
    if (after.includes(0x0d)) return fail('--fix 之后 plain.mjs 里还有 CR')
    if (!after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return fail('--fix 把 BOM 弄丢了')
    if (after.toString('utf8') !== '\uFEFFexport const a = 1\nexport const b = 2\n') {
      return fail(`--fix 改了行尾以外的东西：${JSON.stringify(after.toString('utf8'))}`)
    }

    fixOne(dir, 'untracked.mjs')
    const second = scan(dir)
    if (second.violations.length !== 0) {
      return fail(`--fix 之后仍然报 ${second.violations.map((v) => `${v.file}:${v.line}`).join(', ')}`)
    }
    if (!second.exemptUsed.has('run.bat') || !second.exemptUsed.has('blob.bcmap')) {
      return fail(`豁免没有生效：run.bat / blob.bcmap 未被识别为豁免（实际豁免 ${[...second.exemptUsed.keys()].join(', ') || '无'}）`)
    }

    console.log(
      'check:eol --selftest OK —— 已跟踪 / 未跟踪的 CRLF 文本 → 报出（行号 1）；'
        + '.bat / 二进制 / gitignore 里的产物 → 豁免；--fix 归一且保留 BOM',
    )
    return 0
  } catch (error) {
    return fail(`自检过程抛错：${error?.message ?? error}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ───────────────────────────── main ─────────────────────────────

const main = () => {
  const argv = process.argv.slice(2)
  const known = new Set(['--fix', '--verbose', '--selftest'])
  const unknown = argv.filter((arg) => !known.has(arg))
  if (unknown.length > 0) {
    console.error(`check:eol 不认识的参数：${unknown.join(' ')}（支持 --fix / --verbose / --selftest）`)
    process.exit(2)
  }
  if (argv.includes('--selftest')) process.exit(selftest())

  const fix = argv.includes('--fix')
  const verbose = argv.includes('--verbose')

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error(`check:eol 需要在 git 仓库里运行（${ROOT} 里没有 .git）`)
    process.exit(2)
  }

  let result
  try {
    result = scan(ROOT)
  } catch (error) {
    console.error(`check:eol 扫描失败（git ls-files 跑不动？）：${error?.message ?? error}`)
    process.exit(2)
  }

  let { violations } = result

  if (fix && violations.length > 0) {
    let fixedCount = 0
    for (const v of violations) if (fixOne(ROOT, v.file)) fixedCount++
    console.log(`check:eol --fix：已把 ${fixedCount} 个文本文件归一为 LF（只改行尾，内容与 BOM 不动）`)
    console.log('  下一步：git add -u && git commit -m "chore(eol): 归一 CRLF（只改行尾，不改内容）"')
    violations = scan(ROOT).violations
  }

  // core.autocrlf=true 是 Windows 上最常见的复发源：本地把 LF 检出成 CRLF，一提交就是噪音。
  // 只提示不判红 —— 它不在本门禁的判据里（判据是文件内容），但要让人看见。
  try {
    const autocrlf = execFileSync('git', ['config', '--get', 'core.autocrlf'], { cwd: ROOT, encoding: 'utf8' }).trim()
    if (autocrlf === 'true') {
      console.warn('提示：`git config core.autocrlf` 是 true —— 请改成 false 或 input（AGENTS.md「行尾（EOL）」）。')
    }
  } catch {
    /* 没设这个 key 是正常情况 */
  }

  if (violations.length === 0) {
    console.log(`check:eol OK —— 扫描 ${result.scanned} 个会进仓库的文本文件（git 跟踪 + 未跟踪未忽略），无 CRLF 行尾`)
    if (result.exemptCount > 0) {
      console.log(
        `  另有 ${result.exemptCount} 个豁免文件的字节里出现 CRLF（*.bat / *.cmd 按 .gitattributes 约定保留 CRLF；`
          + '二进制不判行尾 —— png/jpg 这类压缩流里本来就会随机出现 0d 0a，不当违规）',
      )
    }
    if (verbose) {
      console.log('\n豁免明细（只列字节里真有 CRLF 的）：')
      for (const [file, count] of [...result.exemptUsed].sort()) console.log(`  - ${file}（${count} 处 CRLF，豁免）`)
      console.log(`\n判据：git ls-files --cached --others --exclude-standard（含未跟踪未忽略）；跳过 ${[...SKIP_DIRS].join(', ')}`)
    }
    return
  }

  console.error(`check:eol 失败：${violations.length} 个文本文件含 CRLF 行尾（.gitattributes 定的是 LF）\n`)
  for (const v of violations) {
    const tag = v.tracked ? '' : ' [未跟踪]'
    console.error(`  ${v.file}:${v.line}: CRLF 行尾（本文件共 ${v.count} 处，此处为首处）${tag}`)
  }
  console.error(
    '\n修法：node scripts/check-eol.mjs --fix && git add -u，然后单独提交（只改行尾，不改内容）。\n'
      + 'Windows：`git config core.autocrlf false`（或 input），不要用 true。\n'
      + '规则与豁免理由见 scripts/check-eol.mjs 文件头（#533）与 AGENTS.md「行尾（EOL）」。',
  )
  process.exit(1)
}

main()
