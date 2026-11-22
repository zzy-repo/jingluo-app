/**
 * KaTeX 不支持命令的**按块降级**（issue #821）。
 *
 * 背景：#486 第五节的气泡美化包让模型用 `\rule` / `\raisebox` / `\hspace` 这类**排版宏**把
 * 聊天界面「画」出来。KaTeX 0.16 支持其中大部分（实测见下），但 `\scalebox` / `\rotatebox` /
 * `\resizebox` / `\parbox` / `\vspace` 之类是 LaTeX 排版命令，KaTeX 没有实现 —— 而**一个**
 * 未定义命令就会让整块公式 `ParseError`，现在的 `MathFormula` 把整块换成 TeX 原文，
 * 用户看到的是「一屏反斜杠」。
 *
 * 本模块只做三件纯逻辑的事，不碰 React、不碰 DOM，便于单测：
 *
 *   1. `splitMathBlocks`  —— 按 `\\`（顶层，不在花括号里）把公式切成模块；
 *   2. `downgradeMathSource` —— A 方案：把少数不支持的排版命令映射成等价/近似写法（丢缩放、
 *      丢旋转，保留内容），能救的救回来；
 *   3. `planMathRender`   —— B 方案：先整块试，整块失败再逐块试，**失败的块只降级它自己**，
 *      成功的块照常渲染，于是气泡结构还在，只有那一行给原文 + 原因。
 *
 * 为什么先整块试：正常公式（占绝大多数）走的还是原来的单次 `renderToString`，行为与改动前
 * 完全一致，不引入额外开销，也不会把 `\\` 分隔的多行公式拆成多段（alignment 环境里 `\\`
 * 是行号分隔，拆开就错了）。
 */

/** 一个模块的渲染结果：要么是 KaTeX 的 HTML，要么是「渲染不了」的原文 + 原因 */
export type MathBlockPart =
  | { kind: 'rendered'; html: string }
  | { kind: 'unsupported'; source: string; reason: string }

/**
 * 整块的渲染计划。
 *
 * - `katex`    ：整块一次渲染成功，和改动前一样；
 * - `degraded` ：整块渲染不了，按模块分开给结果（`parts` 至少一项）。
 */
export type MathRenderPlan =
  /** `simplified: true` = 渲染成功，但 A 方案动过源码（丢了缩放/旋转/字间距），界面要说明 */
  | { mode: 'katex'; html: string; simplified: boolean }
  | { mode: 'degraded'; parts: MathBlockPart[]; approximated: string[] }

/** 由调用方注入：`tex => katex.renderToString(tex, …)`（组件里绑定好选项，这里保持纯函数） */
export type MathRenderer = (tex: string) => string

/** 参数规格：最多读几个 `{}` / `[]` 组，以及保留哪一组 */
type ArgSpec = {
  /** 最多读几组参数；0 = 该命令不带参数，直接删掉 */
  max: number
  /**
   * `last` = 保留最后一组（丢缩放/旋转/宽度，留下内容）；`none` = 参数一起删；
   * `first+last` = 保留第一组（如 `\raisebox` 的位移量）与最后一组（内容），中间的丢掉。
   */
  keep: 'last' | 'none' | 'first+last'
}

/**
 * **实测得出的**不支持命令表（KaTeX 0.16.22，`strict: false`）。
 *
 * 只登记「删掉/近似后不会让内容失真到误导」的命令：
 * - `\scalebox{1.2}[1.2]{X}` → `{X}`：丢缩放，字还在；
 * - `\rotatebox{15}{X}` → `{X}`：丢旋转，字还在；
 * - `\resizebox{w}{h}{X}` / `\parbox{w}{X}` / `\mbox{X}` / `\vbox{X}` / `\makebox` / `\framebox`
 *   → `{X}`；
 * - `\setlength{\x}{0pt}` / `\fontsize{20}{24}` / `\vspace{1em}` / `\hfill` / `\noindent`
 *   / `\centering` / `\strut` / `\smallskip` / `\selectfont` / `\unicode{…}` → 整个删掉
 *   （纯位置/字号指令，删掉只是少一点间距）。
 */
const ARG_SPECS: Record<string, ArgSpec> = {
  /**
   * `\raisebox{70pt}[0pt][0pt]{X}`（美化包爱用它做叠字）：KaTeX **不报错**，但只读 `{dimen}`
   * 和 `{内容}`，两个可选参数 `[0pt][0pt]` 会被当成普通文字打出来 —— 页面上会出现
   * 「[0pt][0pt]」这种残渣（#821 浏览器验收抓到的第二类问题）。这里把它们剥掉。
   */
  raisebox: { max: 4, keep: 'first+last' },
  scalebox: { max: 3, keep: 'last' },
  rotatebox: { max: 3, keep: 'last' },
  resizebox: { max: 3, keep: 'last' },
  parbox: { max: 3, keep: 'last' },
  makebox: { max: 3, keep: 'last' },
  framebox: { max: 3, keep: 'last' },
  mbox: { max: 1, keep: 'last' },
  vbox: { max: 1, keep: 'last' },
  intertext: { max: 1, keep: 'last' },
  setlength: { max: 2, keep: 'none' },
  fontsize: { max: 2, keep: 'none' },
  vspace: { max: 1, keep: 'none' },
  unicode: { max: 1, keep: 'none' },
  hfill: { max: 0, keep: 'none' },
  vfill: { max: 0, keep: 'none' },
  hfil: { max: 0, keep: 'none' },
  noindent: { max: 0, keep: 'none' },
  centering: { max: 0, keep: 'none' },
  selectfont: { max: 0, keep: 'none' },
  strut: { max: 0, keep: 'none' },
  smallskip: { max: 0, keep: 'none' },
  medskip: { max: 0, keep: 'none' },
  bigskip: { max: 0, keep: 'none' },
  linebreak: { max: 0, keep: 'none' },
}

/** 整对环境丢掉的环境（只是对齐方式，KaTeX 外面由 CSS 决定） */
const DROPPED_ENVS = new Set(['center', 'flushleft', 'flushright'])

/** 环境改名：KaTeX 有 `array` 没有 `tabular`，列格式写法一致 */
const RENAMED_ENVS: Record<string, string> = { tabular: 'array', tabularx: 'array' }

/**
 * 读一个 `{…}` 或 `[…]` 组，返回组内文本与结束位置；不匹配返回 null。
 *
 * `\\` 后面的字符一律视为被转义（`\{` / `\}` / `\\`），所以不会把 `\{` 当成分组起点。
 */
const readGroup = (source: string, start: number): { body: string; end: number } | null => {
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === open) {
      depth += 1
      continue
    }
    if (char === close) {
      depth -= 1
      if (depth === 0) {
        return { body: source.slice(start + 1, index), end: index + 1 }
      }
    }
  }
  return null
}

/**
 * 位移量还算不算「微调」。
 *
 * `\raisebox{2pt}` 是正常的上标微调，保留；`\raisebox{70pt}`（≈7em）是美化包拿来做绝对定位的，
 * 在可重排的列里只会把行顶飞、留下大片空白，所以视为「绝对定位」并丢掉位移。
 * 单位换算按 TeX 的 1em = 10pt（KaTeX 同一套口径）粗算：超过 3em 就算绝对定位。
 */
const isAbsoluteOffset = (dimen: string): boolean => {
  const matched = /^\s*([-+]?\d+(?:\.\d+)?)\s*(pt|em|ex|mm|cm|in|bp|pc|px|mu)?\s*$/u.exec(dimen)
  if (matched === null) {
    return false
  }
  const value = Number(matched[1])
  if (!Number.isFinite(value)) {
    return false
  }
  const unit = matched[2] ?? 'pt'
  const emRatio: Record<string, number> = {
    em: 1,
    pt: 0.1,
    bp: 0.1,
    pc: 1.2,
    px: 0.0625,
    mm: 0.28,
    cm: 2.84,
    in: 7.2,
    ex: 0.5,
    mu: 0.0556,
  }
  const em = Math.abs(value) * (emRatio[unit] ?? 0.1)
  return em > 3
}

/**
 * 从 `\` 处读出命令名；控制符（`\\`、`\,`）返回 null */
const readCommandName = (source: string, at: number): { name: string; end: number } | null => {
  let index = at + 1
  while (index < source.length && /[a-zA-Z]/.test(source[index])) {
    index += 1
  }
  return index > at + 1 ? { name: source.slice(at + 1, index), end: index } : null
}

const skipSpaces = (source: string, start: number): number => {
  let index = start
  while (index < source.length && /\s/.test(source[index])) {
    index += 1
  }
  return index
}

/**
 * A 方案：把不支持的排版命令映射成 KaTeX 认识的等价写法。
 *
 * 只认表中的命令名；表外的一律原样保留（宁可不救，也不改坏用户内容）。
 * 返回 `approximated` 是**真的做过的近似**的命令名，界面据此提示「部分排版已简化」。
 */
const downgradeOnce = (source: string, depth = 0): { tex: string; approximated: string[] } => {
  let out = ''
  const approximated: string[] = []
  let index = 0

  while (index < source.length) {
    if (source[index] !== '\\') {
      out += source[index]
      index += 1
      continue
    }
    const command = readCommandName(source, index)
    if (command === null) {
      out += source[index]
      index += 1
      continue
    }

    // 环境：`\begin{center}` 之类整对丢掉 / `tabular` → `array`
    if (command.name === 'begin' || command.name === 'end') {
      const group = readGroup(source, skipSpaces(source, command.end))
      if (group !== null) {
        const env = group.body.trim()
        if (DROPPED_ENVS.has(env)) {
          if (!approximated.includes(`\\${env}`)) {
            approximated.push(`\\${env}`)
          }
          index = group.end
          continue
        }
        const renamed = RENAMED_ENVS[env]
        if (renamed !== undefined) {
          if (!approximated.includes(`\\${env}`)) {
            approximated.push(`\\${env}`)
          }
          out += `\\${command.name}{${renamed}}`
          index = group.end
          continue
        }
      }
      out += source.slice(index, command.end)
      index = command.end
      continue
    }

    const spec = ARG_SPECS[command.name]
    if (spec === undefined) {
      out += source.slice(index, command.end)
      index = command.end
      continue
    }

    // `\vspace*{1em}` 这种带星号的：星号跟着命令一起吃掉
    let cursor = command.end
    if (source[cursor] === '*') {
      cursor += 1
    }

    // 按顺序读最多 max 组参数（`[]` 与 `{}` 都算，`\scalebox{1.2}[1.2]{X}` 是 3 组）
    const groups: Array<{ body: string; start: number; end: number }> = []
    for (let taken = 0; taken < spec.max; taken += 1) {
      const next = skipSpaces(source, cursor)
      if (source[next] !== '{' && source[next] !== '[') {
        break
      }
      const group = readGroup(source, next)
      if (group === null) {
        break
      }
      groups.push({ body: group.body, start: next, end: group.end })
      cursor = group.end
    }

    // 参数没读全（公式被截断 / 写得不对）：原样吐回去，交给上层按「原文」降级
    const reachedArgs = spec.max === 0 || groups.length > 0
    if (!reachedArgs) {
      out += source.slice(index, command.end)
      index = command.end
      continue
    }

    const consumed = source.slice(index, cursor)
    const mergeInner = (result: { approximated: string[] }) => {
      for (const name of result.approximated) {
        if (!approximated.includes(name)) {
          approximated.push(name)
        }
      }
    }
    /** 递归映射某一组参数里的内容（外层命令会整段吞掉参数，不递归就漏掉嵌套的命令） */
    const mapGroup = (body: string) =>
      depth < 8 ? downgradeOnce(body, depth + 1) : { tex: body, approximated: [] as string[] }

    let rebuilt = ''
    if (spec.keep === 'none') {
      rebuilt = ''
    } else {
      const last = groups[groups.length - 1]
      const inner = mapGroup(last.body)
      mergeInner(inner)
      if (spec.keep === 'last') {
        rebuilt = `{${inner.tex}}`
      } else {
        // `first+last`：目前只有 `\raisebox`
        const head = mapGroup(groups[0].body)
        mergeInner(head)
        // 美化包拿 `\raisebox{70pt}` 做**绝对定位**（把头像压到标题行上）。聊天列是可重排的，
        // 位移量一大就变成「一大片空白 + 内容被挤出可视区」，所以超过阈值的位移直接丢掉，
        // 内容留在原地（结构还能认出来），而不是照抄一个在流式排版里必然崩坏的位置。
        rebuilt = isAbsoluteOffset(groups[0].body)
          ? `{${inner.tex}}`
          : `\\${command.name}{${head.tex}}{${inner.tex}}`
      }
    }
    // 只有真的改写了源码才记一笔：没改的（`\raisebox{1em}{X}` 这种本来就合法）不该触发提示
    if (rebuilt !== consumed && !approximated.includes(`\\${command.name}`)) {
      approximated.push(`\\${command.name}`)
    }
    out += rebuilt
    index = cursor
  }

  return { tex: out, approximated }
}

/**
 * A 方案对外入口：把不支持的排版命令映射成 KaTeX 认识的写法。
 *
 * 跑**多轮**直到不再变化：`\raisebox{70pt}[0pt][0pt]{\rotatebox{15}{o}}` 这种嵌套写法里，
 * 外层先被改写、内层还留在新串里，单轮只会处理外层（第二轮才轮到 `\rotatebox`）。
 * 轮数上限 5 是防御性的 —— 每轮都必须让字符串变短或不变，不变就停。
 */
export const downgradeMathSource = (
  source: string
): { tex: string; approximated: string[] } => {
  let tex = source
  const approximated: string[] = []
  for (let pass = 0; pass < 5; pass += 1) {
    const result = downgradeOnce(tex)
    for (const name of result.approximated) {
      if (!approximated.includes(name)) {
        approximated.push(name)
      }
    }
    if (result.tex === tex) {
      break
    }
    tex = result.tex
  }
  return { tex, approximated }
}

/**
 * 按 `\\` 把公式切成模块（`\\` 在花括号里不算，`\text{a\\b}` 那种整块保留）。
 *
 * `\\[2pt]` 里的 `[2pt]` 是行间额外间距，拆块后由 CSS 统一给间距，这里直接吃掉。
 * 空模块（连续的 `\\`）丢掉 —— 它们渲染出来是空行，留着只会多一条空白。
 */
export const splitMathBlocks = (source: string): string[] => {
  const blocks: string[] = []
  let current = ''
  let depth = 0
  let index = 0
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed !== '') {
      blocks.push(trimmed)
    }
  }

  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      if (next === '\\' && depth === 0) {
        push(current)
        current = ''
        index += 2
        // 吃掉 `\\[2pt]` 的间距参数
        const afterBreak = skipSpaces(source, index)
        if (source[afterBreak] === '[') {
          const group = readGroup(source, afterBreak)
          if (group !== null) {
            index = group.end
          }
        }
        continue
      }
      // 其它控制序列整体跳过，避免把 `\{` `\}` 数进深度
      const command = readCommandName(source, index)
      if (command === null) {
        current += char
        index += 1
        if (index < source.length) {
          current += source[index]
          index += 1
        }
        continue
      }
      current += source.slice(index, command.end)
      index = command.end
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth = Math.max(0, depth - 1)
    }
    current += char
    index += 1
  }
  push(current)
  return blocks
}

/**
 * 渲染残渣探测：`throwOnError: true` **只能抓住「不认识」**，抓不住「认识但读错参数」。
 *
 * `\raisebox{70pt}[0pt][0pt]{X}` 就是这样：KaTeX 认这个命令、不抛错，却把两个可选参数
 * 当普通文字打进页面（#821 浏览器验收里出现的 `[0pt][0pt]`）。所以渲染完还要看一眼**可见文本**
 * 里有没有这两类残渣，有就当作「这块没渲染好」，走降级而不是把它当成功结果端给用户。
 */
const LEAK_PATTERNS = [
  /** 未定义命令被原样打印（宽松模式下 KaTeX 会这么干） */
  /\\[a-zA-Z]{2,}/u,
  /** 尺寸参数残渣：`[0pt]` / `[-2em]` 这种被当文字打出来的可选参数 */
  /\[\s*[-+]?\d+(?:\.\d+)?\s*(?:pt|em|ex|mm|cm|in|bp|pc|dd|cc|nd|nc|sp|mu|px)\s*\]/u,
]

/** 从 KaTeX 的 HTML 里取「用户能看见的文字」：丢掉标签，也丢掉藏 TeX 原文的 annotation */
const visibleTextOf = (html: string): string =>
  html
    .replace(/<annotation[\s\S]*?<\/annotation>/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')

/** 渲染结果里有没有排版残渣（有 = 这块不能算渲染成功） */
export const hasRenderLeak = (html: string): boolean => {
  const text = visibleTextOf(html)
  return LEAK_PATTERNS.some((pattern) => pattern.test(text))
}

/** KaTeX 的错误消息去掉前缀和「下划线标记」，剩下人话 */
const cleanError = (error: unknown): string => {
  if (error === null || error === undefined) {
    // 残渣路径没有抛错（KaTeX「认识但读错参数」），原因由界面按本地化文案补
    return ''
  }
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^KaTeX parse error:\s*/u, '')
    .replace(/[\u0332]/gu, '')
    .split('\n')[0]
    .trim()
}

/**
 * B 方案主入口：先整块渲染，失败再逐块渲染。
 *
 * 每一块三层兜底：
 *   1. 原样渲染（支持的命令一行都不用改）；
 *   2. 等价映射后再渲染（A 方案，只有映射真的改动了源码才试）；
 *   3. 还不行就**只把这一块**降级成原文 + 原因，其余块照常渲染。
 *
 * `downgrade: false` 只给负向对照用（关掉 A 方案，验证 B 单独也能撑住），
 * 生产路径不会传它。
 */
export const planMathRender = (
  source: string,
  render: MathRenderer,
  { downgrade = true }: { downgrade?: boolean } = {}
): MathRenderPlan => {
  const blocks = splitMathBlocks(source)
  const normalized = downgrade ? downgradeMathSource(source) : { tex: source, approximated: [] }
  /**
   * A 方案动过源码、且本来就是多模块（气泡卡片那种 `\\` 分隔）时，**不**走整块渲染：
   * 这些模块靠 `\raisebox` / `\rule{…}{0pt}` 的空盒子撑开行距，一旦把绝对位移夹掉，
   * KaTeX 的 vlist 行高就塌成 0，四行会**叠在同一个基线上**（只看得见最上面那行）。
   * 逐模块渲染 = 每个模块一个 DOM 行，行距由 CSS 给，谁也压不着谁。
   */
  const preferBlocks = normalized.approximated.length > 0 && blocks.length > 1
  if (!preferBlocks) {
    try {
      const html = render(normalized.tex)
      // 残渣检查：`throwOnError` 抓不到「认识但读错参数」的情况（见 hasRenderLeak）
      if (!hasRenderLeak(html)) {
        return { mode: 'katex', html, simplified: normalized.approximated.length > 0 }
      }
    } catch {
      // 整块不行，往下走分块
    }
  }

  const parts: MathBlockPart[] = []
  const approximated: string[] = []
  // 切不开（只有一块）时也要有输出，否则界面会空白
  const effective = blocks.length > 0 ? blocks : [source.trim()]

  for (const block of effective) {
    let firstError: unknown = null
    // 1) 原样渲染（支持的命令一行都不改）
    try {
      const html = render(block)
      if (!hasRenderLeak(html)) {
        parts.push({ kind: 'rendered', html })
        continue
      }
    } catch (error) {
      firstError = error
    }

    // 2) 等价映射之后再试（A 方案）
    const downgraded = downgrade ? downgradeMathSource(block) : { tex: block, approximated: [] }
    const merged = () => {
      for (const name of downgraded.approximated) {
        if (!approximated.includes(name)) {
          approximated.push(name)
        }
      }
    }
    if (downgraded.tex !== block) {
      if (downgraded.tex.trim() === '') {
        // 整块只剩位置/间距指令（例如单独一行 `\vspace{1em}`）：没有内容可显示，正常吞掉
        merged()
        continue
      }
      try {
        const html = render(downgraded.tex)
        // 映射后仍有残渣：这块交给原文降级，别把「[0pt][0pt]」端给用户
        if (!hasRenderLeak(html)) {
          parts.push({ kind: 'rendered', html })
          merged()
          continue
        }
        merged()
        parts.push({ kind: 'unsupported', source: block, reason: '' })
        continue
      } catch {
        // 映射后还是不行：落到原文降级
      }
    }

    // 3) 原文降级：只降这一块，其它块不受影响
    parts.push({ kind: 'unsupported', source: block, reason: cleanError(firstError) })
  }

  // 极端情况：所有块都被吞掉（整块只是一堆间距指令）—— 给一个空渲染，别让容器空着报错
  if (parts.length === 0) {
    return { mode: 'degraded', parts: [{ kind: 'rendered', html: '' }], approximated }
  }

  return { mode: 'degraded', parts, approximated }
}
