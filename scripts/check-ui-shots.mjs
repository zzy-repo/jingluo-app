#!/usr/bin/env node
/**
 * 截图引用门禁（GitHub issue #661）。
 *
 *   node scripts/check-ui-shots.mjs            # 或 pnpm check:ui-shots
 *   node scripts/check-ui-shots.mjs --json     # 机器可读
 *   node scripts/check-ui-shots.mjs --list     # 逐条打印孤儿/悬空引用
 *
 * 回答两个问题：
 *   ① **孤儿**：`docs/ui/**` 下的每张截图，还有没有任何文档 / 测试 / 脚本指向它？
 *   ② **悬空**：文档里写的那些截图路径，文件还在不在？
 *
 * ## 为什么需要它（#661 实测）
 *
 * `docs/ui` 曾经是「整目录不动」的取证区，于是只进不出：553 张截图里 **155 张（18.2 MB /
 * 17.4 MiB）** 在仓库任何 tracked 文本里都查不到一处引用 —— 既不是关单证据，也不在任何
 * 子目录 README 的结论表里。它们不是磁盘问题，是**搜索噪音**：`git grep zip|import|toast`
 * 会被这些图的路径刷屏，而谁的结论都不依赖它们。
 *
 * 已有的两道门禁都看不见这件事：
 *   - `check:doc-refs` 只认代码类扩展名（`REF_EXT` 里没有 png/jpg），图片引用它根本不扫；
 *   - `check:hygiene` 管的是「本机绝对路径」与「大文本文件」。
 * 所以误删一张**被引用**的截图，CI 会全绿（PR 里留了这条负向对照的实测）。
 *
 * ## 判定口径
 *
 * 「被引用」= 命中下列任一条（都要求**落到具体文件**，不是按 basename 一刀切 ——
 * `docs/ui` 下有 21 个重复 basename，光按名字判会把「有人引用了 360 那张」算成「390 那张也有人要」）：
 *
 *   L0 字面名：任何 tracked 文本文件里出现该文件名（= issue #661 正文给的两条判据：
 *      `grep -rl "<文件名>" docs/ tests/ scripts/ *.md` 与 `git grep -l "<文件名>"`）
 *   A  显式路径：token 按「文档所在目录相对」/「仓库根相对」解析后等于该图片路径（含 `..`）
 *   B  glob：`360/*.png` 这类以图片扩展名收尾的通配（`docs/ui/**` 这种整目录通配**不**算，
 *      它只是「这个目录存在」的说法，不能证明某张图有人要）
 *   C  brace：`quota-{390,360}.png` 展开后匹配
 *   D  祖先裸名：文档位于图片的祖先目录、token 是裸文件名，且该 basename 的同名图**全部**在该
 *      文档子树内（`docs/ui/auth-pages/README.md` 的 `login.png` 就属于这种：360/ 与 390/ 各一张）
 *   E  续写简写：`-s1-hold-long-360dp.png` —— 接在同文件里上一条已解析路径的目录后，按后缀匹配
 *   F  目录级：`.md` 把 `docs/ui/<子目录>/` 当一个整体引用（含裸相对目录名如 `screens/`、
 *      省略号形态 `360/…`）→ 该目录下全部图片连带算引用
 *   H  stem 前缀：`metrics.json` 的 key 形如 `390/01-失败-有缓存兜底`（不带扩展名、不带视口后缀）
 *      → 该目录下以此开头的图片算引用。删掉图就删掉了这条量数的出处
 *
 * 「悬空」= 文档里的引用解析到的 `docs/ui/**` 图片不存在（父目录还在 → 不是历史记录，是死链）。
 * 代码块（```）与删除线（`~~…~~`）里的路径不算：前者是命令示例，后者是「曾有、现已删除」的记录。
 *
 * ## 豁免
 *
 * `EXEMPT` 逐条给理由，只有 2 条（#213 的那两张）。**不要**加「目录里有 README 就整目录放行」
 * 那种通用规则 —— 那样等于把这份名单变成后门。
 *
 * 退出码：0 合格 / 1 有 FAIL / 2 环境不具备（不是 git 仓库）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = new Set(process.argv.slice(2))
const JSON_OUT = ARGS.has('--json')
const LIST = ARGS.has('--list')

/** 图片扩展名（`docs/ui` 目前只有 png，留全是为了别人挪进来时不会漏判） */
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** 逐条豁免（带理由；只有这里能「留一张没人引用的图」） */
const EXEMPT = new Map([
  [
    'docs/ui/213-has-fallback/360/markdown-before-list.png',
    '#213：该目录只有这一张 360 + 一张 390 图，README 正文（「看什么」表 + 期望 margin）逐条描述的就是它们，' +
      '只是没写文件名；删了 README 就指向不存在的证据',
  ],
  ['docs/ui/213-has-fallback/390/markdown-before-list.png', '同上（390 档）'],
])

const git = (args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString()

let tracked
try {
  tracked = git(['ls-files', '-z']).split('\0').filter(Boolean)
} catch {
  console.error('check:ui-shots —— 这不是一个 git 仓库（退出码 2）')
  process.exit(2)
}

const norm = (p) => path.posix.normalize(p).replace(/^\.\//, '').replace(/(.)\/+$/, '$1')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** glob → 正则（`*` 只跨一层目录；先按 `*` 切段再逐段转义，避免 `\*` 被二次转义） */
const globToRe = (g) => new RegExp('^' + g.split('*').map(esc).join('[^/]*') + '$')

/** 去掉 token 前面粘着的 markdown 标记；但**不**吞掉 glob 的 `*` */
const stripLead = (t) => t.replace(/^[#[_[\]()`"']+/, '')

/** 本脚本自己不算「引用出处」：`EXEMPT` 里那两条豁免理由中写着文件名，不能因此把图算成被引用 */
const SELF = 'scripts/check-ui-shots.mjs'

const images = tracked.filter((f) => f.startsWith('docs/ui/') && IMG_RE.test(f))
const imageSet = new Set(images)
/** 存在性缓存（图片都在 git 索引里，直接查集合即可，免 次次 stat） */
const imgOK = imageSet

/** 读所有 tracked 文本文件（图片跳过；>4 MiB 的跳过 —— docs/ui 下最大约 300 KB） */
const texts = new Map()
for (const f of tracked) {
  if (IMG_RE.test(f) || f === SELF) continue
  try {
    const abs = path.join(ROOT, f)
    if (fs.statSync(abs).size > 4 * 1024 * 1024) continue
    texts.set(f, fs.readFileSync(abs, 'utf8'))
  } catch {
    /* 二进制 / 不可读：跳过 */
  }
}

/** 去掉 fenced code block 与 `~~删除线~~`（两者都不是「现在指得着的引用」） */
const stripNonRefs = (t) =>
  t.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1/gm, '').replace(/~~[^~\n]*~~/g, '')

const base = path.posix.basename
const byBase = new Map()
for (const img of images) {
  const b = base(img)
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push(img)
}

// ─────────────────────────── 引用收集 ───────────────────────────
/** img -> [{ how, file, token }] */
const refs = new Map()
const addRef = (img, rec) => {
  if (!refs.has(img)) refs.set(img, [])
  refs.get(img).push(rec)
}

/** 目录级引用：目录 -> Set(出处) */
const dirCite = new Map()
const citeDir = (dir, why) => {
  if (!dirCite.has(dir)) dirCite.set(dir, new Set())
  dirCite.get(dir).add(why)
}

/** 递归展开花括号：`a-{1,2}-{x,y}.png` → 4 条。展开不干净（还有 `{`）就返回空（不当引用判） */
const expandBraces = (token, depth = 0) => {
  if (depth > 4) return []
  const m = token.match(/^(.*?)\{([^{}]*)\}(.*)$/)
  if (!m) return token.includes('{') || token.includes('}') ? [] : [token]
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3], depth + 1))
}

const TOKEN_RE = /[^\s'"`()[\]<>|;、，。]+/g
const DIR_RE = /(?:^|[\s`'"([|])((?:[\w.@+-]+\/)*docs\/ui\/[\w.@+\-\u4e00-\u9fff/]*\/)(?![\w.@+-]*\.)/gm
const BARE_DIR_RE = /(?:^|[\s`'"([|])((?:[\w.@+\-\u4e00-\u9fff]+\/)+)(?=[\s`'")|,，。]|$)/gm
const ELLIPSIS_DIR_RE = /(?:^|[\s`'"([|])([\w.@+\-\u4e00-\u9fff]+)\/[\u2026.。]{1,3}(?=[\s`'")\]|,，。]|$)/gm

for (const [file, raw] of texts) {
  const text = stripNonRefs(raw).replace(/\\/g, '/')
  const docDir = path.posix.dirname(file)
  const isMd = file.endsWith('.md')

  // F：目录级引用（只认文档；测试/脚本里的输出目录是「生产方」自我声明，不是谁在引用这些图）
  if (isMd) {
    for (const m of text.matchAll(DIR_RE)) {
      const d = norm(m[1])
      if (d.startsWith('docs/ui/') && d !== 'docs/ui') citeDir(d, file)
    }
    for (const m of text.matchAll(BARE_DIR_RE)) {
      const d = norm(path.posix.join(docDir, m[1]))
      if (!d.startsWith('docs/ui/') || d === 'docs/ui') continue
      try {
        if (fs.statSync(path.join(ROOT, d)).isDirectory()) citeDir(d, `${file} (裸目录名)`)
      } catch {
        /* 目录不存在：不是引用 */
      }
    }
    for (const m of text.matchAll(ELLIPSIS_DIR_RE)) {
      const d = norm(path.posix.join(docDir, m[1]))
      if (d.startsWith('docs/ui/') && d !== 'docs/ui') citeDir(d, `${file} (省略号)`)
    }
  }

  // A/B/C/E/H：逐 token
  const resolvedInFile = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = stripLead(m[0])
    const variants = expandBraces(token)

    for (const v of variants) {
      if (!IMG_RE.test(v)) continue
      const hasGlob = v.includes('*') && !v.includes('**')
      for (const cand of [norm(path.posix.join(docDir, v)), norm(v)]) {
        if (!hasGlob) {
          if (imageSet.has(cand)) {
            addRef(cand, { how: 'path', file, token })
            resolvedInFile.push(cand)
          }
          continue
        }
        const re = globToRe(cand)
        for (const img of images) {
          if (re.test(img)) {
            addRef(img, { how: 'glob', file, token })
            resolvedInFile.push(img)
          }
        }
      }
    }

    // D：祖先裸名（`quota-{390,360}.png` 展开出来的裸名同样适用）
    for (const v of variants) {
      if (v.includes('/') || !IMG_RE.test(v)) continue
      const same = byBase.get(v)
      if (same && docDir !== '.' && same.every((p) => p.startsWith(docDir + '/')))
        for (const p of same) addRef(p, { how: 'ancestor-bare', file, token })
    }

    // E：续写简写 `-s1-hold-long-360dp.png`
    if (/^-[^/]+\.(png|jpe?g|gif|webp|svg)$/i.test(token) && token.length >= 10 && resolvedInFile.length) {
      const dirs = new Set(resolvedInFile.map((p) => path.posix.dirname(p)))
      for (const img of images)
        if (dirs.has(path.posix.dirname(img)) && base(img).endsWith(token))
          addRef(img, { how: 'shorthand', file, token })
    }

    // H：stem 前缀（`390/01-失败-有缓存兜底`）
    if (!IMG_RE.test(token) && !token.includes('*') && token.includes('/')) {
      const seg = token.split('/').pop()
      if (seg.length >= 6) {
        for (const cand of [norm(path.posix.join(docDir, token)), norm(token)]) {
          const dir = path.posix.dirname(cand)
          let entries
          try {
            entries = fs.readdirSync(path.join(ROOT, dir))
          } catch {
            continue
          }
          for (const e of entries) {
            const p = path.posix.join(dir, e)
            if (imageSet.has(p) && base(p).startsWith(seg)) addRef(p, { how: 'stem', file, token })
          }
        }
      }
    }
  }
}

// L0：字面文件名（双判据里的那两条 grep 的并集）
for (const img of images) {
  const b = base(img)
  for (const [file, text] of texts) if (text.includes(b)) addRef(img, { how: 'literal', file })
}

// ─────────────────────────── ① 孤儿 ───────────────────────────
const orphans = []
const keptByHow = {}
for (const img of images) {
  const r = refs.get(img) || []
  if (r.length) {
    keptByHow[r[0].how] = (keptByHow[r[0].how] || 0) + 1
    continue
  }
  let d = path.posix.dirname(img)
  let cited = null
  while (d.startsWith('docs/ui')) {
    if (dirCite.has(d)) {
      cited = d
      break
    }
    if (d === 'docs/ui') break
    d = path.posix.dirname(d)
  }
  if (cited) {
    keptByHow.dir = (keptByHow.dir || 0) + 1
    continue
  }
  if (EXEMPT.has(img)) {
    keptByHow.exempt = (keptByHow.exempt || 0) + 1
    continue
  }
  orphans.push(img)
}

// ─────────────────────────── ② 悬空引用 ───────────────────────────
/**
 * 只判**文档**（`*.md`）：`metrics.json` / `result-*.json` 这类机器记录里的历史路径是
 * 「当时采集了什么」的档案，不是「现在指得着吗」的断言（#133/#180 几处就属于这种）；
 * 生成脚本里的 `${base}.png` 模板同理。
 *
 * 只判两种能**确定**指向某张图的写法：
 *   - 带 `/` 的路径：解析到 `docs/ui/**` 且父目录还在 → 文件必须存在；
 *   - 裸文件名：只在「文档就躺在那批图中间」时判（该目录直接有图片、且没有图片子目录）。
 *     `docs/ui/README.md`（整目录索引）、`auth-pages/README.md`（图在 360/390 子目录）都不满足，不判。
 */
/** 工作树上真实存在的图（`git ls-files` 是「提交里有什么」，删了工作树副本它还在索引里） */
const liveImages = images.filter((f) => fs.existsSync(path.join(ROOT, f)))
const liveSet = new Set(liveImages)

const hasImageSubdir = (dir) =>
  liveImages.some((img) => {
    const parent = path.posix.dirname(img)
    return parent !== dir && parent.startsWith(dir + '/')
  })
const PLACEHOLDER = /[…]{1,}|[.]{3,}|\$\{|\}|[*]$/

const dead = []
for (const [file, raw] of texts) {
  if (!file.endsWith('.md')) continue
  const text = stripNonRefs(raw).replace(/\\/g, '/')
  const docDir = path.posix.dirname(file)
  const leafDirWithImages = liveImages.some((img) => path.posix.dirname(img) === docDir) && !hasImageSubdir(docDir)

  for (const m of text.matchAll(TOKEN_RE)) {
    const token = stripLead(m[0])
    if (!IMG_RE.test(token)) continue
    if (token.includes('**') || token.includes('…') || token.includes('${')) continue
    if (/^(https?:|\/|~)/.test(token) || token.includes('://')) continue

    const variants = expandBraces(token)
    if (!variants.length) continue

    for (const v of variants) {
      if (!IMG_RE.test(v) || PLACEHOLDER.test(v)) continue
      if (v.includes('/')) {
        for (const cand of [norm(path.posix.join(docDir, v)), norm(v)]) {
          if (!cand.startsWith('docs/ui/')) continue
          if (!fs.existsSync(path.join(ROOT, path.posix.dirname(cand)))) continue // 目录都不在：历史口述，不判
          if (v.includes('*')) {
            const re = globToRe(cand)
            if (!liveImages.some((img) => re.test(img))) dead.push({ file, token, why: 'glob 无匹配' })
            continue
          }
          if (liveSet.has(cand)) continue
          dead.push({ file, token, why: '文件不存在' })
        }
        continue
      }
      if (!leafDirWithImages) continue
      if (v.includes('*')) {
        // `234-01-rules-from-server-*.png`：同目录 glob 得有匹配，否则这行表格指向空
        const re = globToRe(v)
        const hit = liveImages.some((img) => path.posix.dirname(img) === docDir && re.test(base(img)))
        if (!hit) dead.push({ file, token, why: '同目录 glob 无匹配' })
        continue
      }
      if (!liveSet.has(norm(path.posix.join(docDir, v))))
        dead.push({ file, token, why: '同目录裸名不存在' })
    }
  }
}

// ─────────────────────────── 输出 ───────────────────────────
const orphanBytes = orphans.reduce((a, p) => {
  try {
    return a + fs.statSync(path.join(ROOT, p)).size
  } catch {
    return a
  }
}, 0)
const totalBytes = images.reduce((a, p) => {
  try {
    return a + fs.statSync(path.join(ROOT, p)).size
  } catch {
    return a
  }
}, 0)

const report = {
  images: images.length,
  totalBytes,
  referenced: images.length - orphans.length,
  keptByHow,
  orphans: orphans.length,
  orphanBytes,
  dead: dead.length,
  dirCited: dirCite.size,
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ...report, orphanList: orphans, deadList: dead }, null, 2))
} else {
  if (LIST) {
    for (const p of orphans) console.log(`孤儿    ${p}`)
    for (const d of dead) console.log(`悬空    ${d.file} → ${d.token}（${d.why}）`)
  }
  console.log(
    `截图 ${report.images} 张 / ${(totalBytes / 1048576).toFixed(2)} MiB；` +
      `被引用 ${report.referenced}（${Object.entries(keptByHow)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')}）；目录级引用 ${report.dirCited} 个目录`,
  )
  if (orphans.length) {
    console.log(`\nFAIL 孤儿截图 ${orphans.length} 张 / ${orphanBytes} B（${(orphanBytes / 1048576).toFixed(2)} MiB）：`)
    for (const p of orphans.slice(0, 40)) console.log(`  ${p}`)
    if (orphans.length > 40) console.log(`  …另 ${orphans.length - 40} 条（--list 看全部）`)
    console.log(
      '  修法：给这张图补一份文档引用（子目录 README 的表格里写全文件名即可），' +
        '或按 #661 的流程先归档到仓库外再 git rm。',
    )
  }
  if (dead.length) {
    console.log(`\nFAIL 悬空引用 ${dead.length} 条（文档写了、文件不在）：`)
    for (const d of dead.slice(0, 40)) console.log(`  ${d.file} → ${d.token}（${d.why}）`)
    if (dead.length > 40) console.log(`  …另 ${dead.length - 40} 条（--list 看全部）`)
  }
  if (!orphans.length && !dead.length) console.log('\ncheck:ui-shots OK —— 每张截图都有出处，每处引用都指得着 ✅')
}

process.exit(orphans.length || dead.length ? 1 : 0)
