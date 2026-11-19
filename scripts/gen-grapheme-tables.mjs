/** 生成字素（grapheme cluster）断点区间表（issue #167）。
 *
 * 为什么需要表：WebView 83 没有 `Intl.Segmenter`（Chromium 87 才有），缺了它第三方库会退回
 * `[...text]` 按码点切 —— emoji（ZWJ 家庭、肤色修饰、国旗）和组合字符（分解形 é、泰文/印地文
 * 的元音符号）就被切成半个。补齐要按 UAX #29 判定边界，而 UAX #29 依赖 `Grapheme_Extend`、
 * `SpacingMark`、`Extended_Pictographic` 这些 Unicode 属性；旧内核的解析器也不认 `\p{…}`
 * 属性转义（ES2018），所以只能把属性查表化，把区间当字面量打进包里。
 *
 * 用法（`pnpm run gen:grapheme`）：
 *
 *   mkdir -p /tmp/ucd && cd /tmp/ucd
 *   curl -OsS https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakProperty.txt
 *   curl -OsS https://www.unicode.org/Public/17.0.0/ucd/emoji/emoji-data.txt
 *   curl -OsS https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt
 *   node scripts/gen-grapheme-tables.mjs --ucd /tmp/ucd
 *
 * 版本写死在 URL 里（不用 `latest`）：产物要和 `node -e "process.versions.unicode"` 对得上才
 * 能拿原生 `Intl.Segmenter` 做对照核验，也让 diff 只反映数据升级这一件事。三个输入的 sha256
 * 会写进产物头部，换数据来源时一眼看得出来。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = join(ROOT, 'src/polyfills/graphemeData.ts')

/** 输入文件 → 产物常量名（顺序即产物里的顺序） */
const SOURCES = [
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'Extend',
    constant: 'GRAPHEME_EXTEND',
    note: 'GCB=Extend（含 ZWNJ U+200C）',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'SpacingMark',
    constant: 'GRAPHEME_SPACING_MARK',
    note: 'GCB=SpacingMark',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'Prepend',
    constant: 'GRAPHEME_PREPEND',
    note: 'GCB=Prepend',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'Control',
    constant: 'GRAPHEME_CONTROL',
    note: 'GCB=Control（CR/LF/ZWJ 在 UCD 里各自单列，不在这张表里）',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'L',
    constant: 'HANGUL_L',
    note: 'Hangul 音节的 L（初声）',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'V',
    constant: 'HANGUL_V',
    note: 'Hangul 音节的 V（中声）',
  },
  {
    file: 'GraphemeBreakProperty.txt',
    property: 'T',
    constant: 'HANGUL_T',
    note: 'Hangul 音节的 T（终声）',
  },
  {
    file: 'emoji-data.txt',
    property: 'Extended_Pictographic',
    constant: 'EXTENDED_PICTOGRAPHIC',
    note: 'GB11 用：Emoji ZWJ 序列里的「图象字符」',
  },
  {
    file: 'DerivedCoreProperties.txt',
    property: 'InCB; Consonant',
    constant: 'INCB_CONSONANT',
    note: 'GB9c 用',
  },
  {
    file: 'DerivedCoreProperties.txt',
    property: 'InCB; Linker',
    constant: 'INCB_LINKER',
    note: 'GB9c 用（连字／virama）',
  },
]

const readArgs = () => {
  const index = process.argv.indexOf('--ucd')
  const dir = index > 0 ? process.argv[index + 1] : process.env.UCD_DIR
  if (!dir) {
    console.error(
      '缺少 Unicode 数据目录：node scripts/gen-grapheme-tables.mjs --ucd <目录>（或置 UCD_DIR）'
    )
    console.error('下载命令见本脚本头部注释（3 个 txt，Unicode 17.0.0）。')
    process.exit(2)
  }
  return dir
}

const UCD = readArgs()
const cache = new Map()
const readSource = (file) => {
  if (!cache.has(file)) {
    cache.set(file, readFileSync(join(UCD, file), 'utf8'))
  }
  return cache.get(file)
}

/** 解析 UCD 数据文件里的某个属性 → 闭区间数组 [[start, end], …]（升序） */
const parseRanges = (text, property) => {
  const ranges = []
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim()
    if (body === '') {
      continue
    }
    const parts = body.split(';').map((part) => part.trim())
    if (parts.slice(1).join('; ') !== property) {
      continue
    }
    const [first, last] = parts[0].split('..')
    const start = parseInt(first, 16)
    ranges.push([start, last === undefined ? start : parseInt(last, 16)])
  }
  return ranges.sort((left, right) => left[0] - right[0])
}

const versionOf = (text) => {
  const match = /-(\d+\.\d+\.\d+)\.txt/.exec(text)
  return match === null ? 'unknown' : match[1]
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 扁平化成 [start0, end0, start1, end1, …]，每行 8 个数字（= oxfmt 对长数组的折行宽度） */
const renderRanges = (ranges) => {
  const flat = ranges.map(([start, end]) => [start, end]).flat()
  const lines = []
  for (let index = 0; index < flat.length; index += 8) {
    const chunk = flat.slice(index, index + 8).map((value) => `0x${value.toString(16)},`)
    lines.push(`  ${chunk.join(' ')}`)
  }
  return lines.join('\n')
}

const files = [...new Set(SOURCES.map((source) => source.file))]
const provenance = files
  .map((file) => `//   ${file.padEnd(28)} sha256=${sha256(readSource(file))}`)
  .join('\n')
const unicodeVersion = versionOf(readSource('GraphemeBreakProperty.txt'))

const body = SOURCES.map((source) => {
  const ranges = parseRanges(readSource(source.file), source.property)
  if (ranges.length === 0) {
    throw new Error(`${source.file} 里没有 ${source.property} 区间：数据文件版本不对？`)
  }
  return `/** ${source.note} —— ${source.file} 的 ${source.property}，${ranges.length} 个区间 */\nexport var ${source.constant} = [\n${renderRanges(ranges)}\n]\n`
}).join('\n')

const output = `// ⚠️ 自动生成，勿手改：node scripts/gen-grapheme-tables.mjs --ucd <目录>（issue #167）
//
// 内容：UAX #29 字素边界判定要用的 Unicode 属性区间表，给 src/polyfills/graphemeSegmenter.ts 用。
// 为什么要表而不是 \\p{…}：旧内核的 JS 解析器不认 ES2018 的属性转义，属性只能写成字面量区间。
//
// 数据来源：Unicode ${unicodeVersion}（\`node -e "process.versions.unicode"\` 应与之相同，才能拿原生
// Intl.Segmenter 做对照核验）。三个输入文件的 sha256：
${provenance}
//
// 表示法：扁平数组 [start0, end0, start1, end1, …]，闭区间，按 start 升序；运行时二分查找。

${body}`

writeFileSync(TARGET, output)
const total = SOURCES.reduce(
  (sum, source) => sum + parseRanges(readSource(source.file), source.property).length,
  0
)
console.log(
  `写入 ${TARGET.replace(ROOT, '')}：${SOURCES.length} 张表 / ${total} 个区间 / Unicode ${unicodeVersion}`
)
// 产物要过仓库的 formatter（区间会被填到 120 列），否则「重新生成 → git diff」永远不干净
try {
  execFileSync('pnpm', ['exec', 'oxfmt', '--write', TARGET], { stdio: 'ignore', shell: true })
  console.log('已按仓库格式（oxfmt）写回')
} catch {
  console.log(
    '格式化：pnpm exec oxfmt --write src/polyfills/graphemeData.ts（自动调用失败，请手动跑）'
  )
}
