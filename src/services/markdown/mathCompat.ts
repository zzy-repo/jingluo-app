/**
 * 「美化规则」一类提示词会用 LaTeX 画聊天气泡（#486 §五 / #821），用到 KaTeX 没有的 graphicx 命令。
 * 这里在送进 KaTeX 之前把它们改写成 KaTeX 认识的写法，**只改写、不扩大信任面**：
 *
 *  - `\scalebox{n}{X}`：n 极小（≤ 0.01，规则里 `0.00001` 是零宽占位词）→ 整段丢掉；否则 → `\htmlStyle{font-size:n em}{X}`。
 *    KaTeX 的盒子全是 em 单位，改外层 font-size 会连布局一起缩放，比 CSS transform 更贴近 LaTeX 的 scalebox；
 *  - `\rotatebox{deg}{X}` → `\htmlStyle{display:inline-block;transform:rotate(deg)}{X}`；
 *  - `\raisebox{h}[d][w]{X}`：去掉 KaTeX 不认的两个可选参数；内容是文本模式，`\begin{array}` 等数学结构在里面会报
 *    `Can't use function '\begin' in text mode`，所以内容包一层 `$...$`。
 *
 * `\htmlStyle` 需要 `trust`，而用户 / 模型可以直接写 `\htmlStyle{position:fixed;...}`（遮盖界面、
 * `background:url(...)` 外联）。所以 `trust` 不是开关：{@link isTrustedMathCommand} 只放行下面两种
 * 由本文件自己生成的、数值受限的样式串，其余一律拒绝（拒绝后 KaTeX 把该命令按错误处理）。
 */

const MAX_SCALE = 10

/** 可被放行的样式串：只有 font-size 与 rotate，数值有界（上限在函数里判，不靠正则位数） */
const SAFE_FONT_SIZE = /^font-size:(\d{1,2}(?:\.\d{1,4})?)em$/
const SAFE_ROTATE = /^display:inline-block;transform:rotate\((-?\d{1,3}(?:\.\d{1,3})?)deg\)$/

/** 形状字符的固定 class：样式在 beautifyMath.css 里，类名不接受用户输入 */
const SAFE_CLASSES = new Set(['md-cap-l', 'md-cap-r', 'md-tail-bl', 'md-tail-br'])

export const isTrustedMathCommand = (context: { command?: string; style?: string; class?: string }): boolean => {
  if (context.command === '\\htmlClass') {
    return typeof context.class === 'string' && SAFE_CLASSES.has(context.class)
  }
  if (context.command !== '\\htmlStyle' || typeof context.style !== 'string') {
    return false
  }
  const size = SAFE_FONT_SIZE.exec(context.style)
  if (size !== null) {
    return Number(size[1]) <= MAX_SCALE
  }
  const rotate = SAFE_ROTATE.exec(context.style)
  return rotate !== null && Math.abs(Number(rotate[1])) <= 360
}

const PLACEHOLDER_SCALE = 0.01

/** 从 `start` 起读一个成对括号的参数，返回 [参数内容, 下一个下标]；读不到返回 null */
const readGroup = (source: string, start: number, open: string, close: string): [string, number] | null => {
  if (source[start] !== open) {
    return null
  }
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++ // 转义字符（\{ \} \\）不参与配对
    } else if (ch === open) {
      depth++
    } else if (ch === close && --depth === 0) {
      return [source.slice(start + 1, i), i + 1]
    }
  }
  return null
}

/** `\\begin{..}` 比 `\\end{..}` 多出的个数（负数 = 反过来多） */
const environmentGap = (source: string): number =>
  (source.match(/\\begin\{/g) ?? []).length - (source.match(/\\end\{/g) ?? []).length

/**
 * 规则文件里有这样的写法：`\\scalebox{1.6}{\\begin{array}{l} … \\end{array}}\n\\end{array}` ——
 * 花括号组的右括号落在 `\\end{array}` **之前**，组跨过了环境边界。LaTeX / MathJax 容忍，KaTeX 不行
 * （`Expected & or \\\\ or \\cr or \\end`）。包成真正的组（`\\htmlStyle`）之前，要把右括号后移到
 * 补齐 `need` 个 `\\end` 之后。返回新的结束下标（含那个 `\\end{..}`）；中途遇到多余的 `}` 就放弃（null）。
 */
const extendThroughEnds = (source: string, from: number, need: number): number | null => {
  const token = /\\[{}]|\\(begin|end)\{[^}]*\}|[{}]/g
  token.lastIndex = from
  let remaining = need
  let depth = 0
  for (let m = token.exec(source); m !== null; m = token.exec(source)) {
    const text = m[0]
    if (text === '{') {
      depth++
    } else if (text === '}') {
      if (--depth < 0) {
        return null
      }
    } else if (m[1] === 'begin') {
      remaining++
    } else if (m[1] === 'end' && --remaining === 0) {
      return token.lastIndex
    }
  }
  return null
}

/**
 * `◖ ◗ ◣ ◢` 在规则里是「画图形」的零件（头像圆、气泡端帽、气泡尾巴）。它们不在 KaTeX 自带字体里，
 * 走各机型自己的回退字体：字形大小、基线都不一样，同一份规则在不同手机上对不齐。
 * 改成 KaTeX 自带的 `\rule` 实心块 + 固定 class（圆角 / 三角由 beautifyMath.css 画），尺寸按
 * 「字形高 ≈ 0.5em」定：规则里端帽是 `\scalebox{3}`、气泡框高约为它的一半，端帽才刚好盖满气泡两侧。
 */
const SHAPES: Record<string, string> = {
  '◖': '\\htmlClass{md-cap-l}{\\rule[-0.22em]{0.6em}{0.5em}}',
  '◗': '\\htmlClass{md-cap-r}{\\rule[-0.22em]{0.6em}{0.5em}}',
  '◣': '\\htmlClass{md-tail-bl}{\\rule{0.6em}{0.6em}}',
  '◢': '\\htmlClass{md-tail-br}{\\rule{0.6em}{0.6em}}',
}
const replaceShapes = (tex: string): string => tex.replace(/[◖◗◣◢]/gu, (ch) => SHAPES[ch] ?? ch)

/**
 * `\\rule{30em}{0pt}`：LaTeX 里是「看不见的撑宽」，KaTeX 会画出一条细线；撑宽本身也会让公式块出现 600+px 的
 * 横向滚动。气泡宽度由内容决定，直接丢掉。
 */
const stripStrutRules = (tex: string): string => tex.replace(/\\rule\s*\{[^{}]+\}\s*\{0(?:pt|em|ex)?\}/gu, '')

/** 块首的负 `\\hspace`：是给原渲染器对齐用的，在这里会让内容伸到容器左边界之外（`overflow-x:auto` 不能向左滚，被裁掉） */
const stripLeadingNegativeSpace = (tex: string): string => tex.replace(/^\s*(?:\\hspace\s*\{-[^{}]*\}\s*)+/u, '')

/** 色块上的文字色：按底色明暗取深 / 浅，规则里没写字色时不至于继承主题色而看不见（浅底 + 白字） */
const readableOn = (background: string): string | null => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(background.trim())?.[1]
  if (hex === undefined) {
    return null
  }
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16))
  const luma = (0.299 * (r as number) + 0.587 * (g as number) + 0.114 * (b as number)) / 255
  return luma > 0.6 ? '#1f1f23' : '#ffffff'
}

const skipSpaces = (source: string, from: number): number => {
  let i = from
  while (i < source.length && /\s/u.test(source[i] as string)) {
    i++
  }
  return i
}

const rewrite = (source: string): string => {
  let out = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('\\', i)
    if (at < 0) {
      out += source.slice(i)
      break
    }
    out += source.slice(i, at)
    const name = /^\\(scalebox|rotatebox|raisebox|colorbox)(?![a-zA-Z])/u.exec(source.slice(at))?.[1]
    if (name === undefined) {
      // 不是我们要改写的命令：原样带过（连同它后面一个转义字符，免得把 `\\` 当成命令开头）
      out += source.slice(at, at + 2)
      i = at + 2
      continue
    }
    let cursor = skipSpaces(source, at + name.length + 1)
    const first = readGroup(source, cursor, '{', '}')
    if (first === null) {
      out += source.slice(at, cursor)
      i = cursor
      continue
    }
    cursor = first[1]
    if (name === 'raisebox') {
      // 丢掉 [depth][height] 两个可选参数
      for (let n = 0; n < 2; n++) {
        const probe = skipSpaces(source, cursor)
        const optional = readGroup(source, probe, '[', ']')
        if (optional === null) {
          break
        }
        cursor = optional[1]
      }
    }
    const body = readGroup(source, skipSpaces(source, cursor), '{', '}')
    if (body === null) {
      out += source.slice(at, cursor)
      i = cursor
      continue
    }
    let content = body[0]
    i = body[1]
    const gap = environmentGap(content)
    if (gap !== 0) {
      const extended = gap > 0 ? extendThroughEnds(source, i, gap) : null
      if (extended === null) {
        // 补不齐：不包组（包了就是新的解析错误），内容原位展开，这一层缩放 / 旋转 / 抬升放弃
        out += rewrite(content)
        continue
      }
      content += source.slice(i, extended)
      i = extended
    }
    const inner = rewrite(content)
    if (name === 'scalebox') {
      const scale = Number.parseFloat(first[0])
      if (!Number.isFinite(scale) || scale <= PLACEHOLDER_SCALE) {
        continue // 零宽占位词：整段不要
      }
      out += `\\htmlStyle{font-size:${Math.min(scale, MAX_SCALE)}em}{${inner}}`
    } else if (name === 'rotatebox') {
      const degree = Number.parseFloat(first[0])
      out += Number.isFinite(degree)
        ? `\\htmlStyle{display:inline-block;transform:rotate(${Math.max(-360, Math.min(360, degree))}deg)}{${inner}}`
        : inner
    } else if (name === 'colorbox') {
      const fg = readableOn(first[0])
      out += fg === null ? `\\colorbox{${first[0]}}{${inner}}` : `\\colorbox{${first[0]}}{\\textcolor{${fg}}{${inner}}}`
    } else {
      out += `\\raisebox{${first[0]}}{$${inner}$}`
    }
  }
  return out
}

/** 只有出现这三个命令之一才改写，普通公式零成本、零差异 */
const NEEDS_COMPAT = /\\(?:scalebox|rotatebox|raisebox)(?![a-zA-Z])/u

export const normalizeBeautifyMath = (tex: string): string =>
  NEEDS_COMPAT.test(tex) ? rewrite(stripLeadingNegativeSpace(stripStrutRules(replaceShapes(tex)))) : tex
