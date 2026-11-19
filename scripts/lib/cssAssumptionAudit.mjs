/**
 * 类别 2（CSS 特性）能力假设盘点 —— issue #209「能力探测替代一切假设」。
 *
 * 纯判定模块：不读盘、不起浏览器、不测量。输入 [{ path, content }]，输出逐命中行的判定，
 * 供 CLI（scripts/check-capabilities.mjs，由另一条并行车道装配）与单测共用。
 *
 * 判定要回答的是「这条 CSS 假设了运行时一定认得某个特性，而它认得吗」，
 * 所以每个命中都要落到下面五种结论之一：
 *
 *   no-risk        首支持版本 ≤ 基线 83，根本不需要探测
 *   covered        确实需要 > 83，但已有**等价**兜底（先写 vh 再 @supports，或构建期降级）
 *   degraded       需要 > 83、没有兜底，但缺了只是外观降级（动画/装饰），不影响可用性
 *   defect         需要 > 83、没有兜底，缺了会让布局或可访问性实质损坏 → 要单开 issue
 *   false-positive 探测**能通过**但效果为 0 —— issue #173 那一类
 *
 * 最后一类是本次盘点的重点。区分「判能力」和「判布局生效性」：
 *
 *   CSS.supports('height', '100dvh')   → 长度单位，解析通过即生效 → 判能力，安全
 *   CSS.supports('gap', '12px')        → `gap` 从 Chrome 66 起就是多列/grid 属性，
 *                                        WebView 83 上返回 true，但 flex 容器里的 gap
 *                                        到 Chromium 84 才生效 → 判的是布局生效性，
 *                                        而探测根本测不到它 → 假阳性
 *
 * 所以「一个属性是否属于布局生效性探测」不能靠字面量猜，按语义定：
 * 该属性在**别的布局模式**下早就是合法值，于是解析通过 ≠ 在当前布局模式下生效。
 * 这类属性集中在 gap 家族（flex 的 gap 晚于 grid/多列的 gap）。见 LAYOUT_CONTEXTUAL。
 *
 * 反过来说，**判布局生效性不是原罪，「探测 + 无动态回读」才是**。同一个仓库里就有正反两例：
 *   src/utils/flexGap.ts       离屏造 flex 容器量 getBoundingClientRect → 正确姿态
 *   src/app/viewport.ts:29     getComputedStyle(el).overflowY 匹配 auto|scroll 就当「能滚」
 *                              → 声明了可滚 ≠ 真的能滚（高度链断了盒子无界，可滚距离为 0）
 * 后者是本轮识别出的假阳性：判定为「能滚」于是放行 touchmove，结果容器滚不动、整页也被锁住。
 * 对照 src/components/session/scrollToFirstMessage.ts:30 —— 同一个判据里补了
 * `scrollHeight - clientHeight > 0` 的实测回读，就不再有这个问题。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 运行时下限：Android 11 出厂镜像停在 WebView 83.0.4103.106（Chromium 83）。
 * 唯一来源是 package.json 的 browserslist，rspack.config.ts 会为它兜底抛错；
 * 这里只是判定用的常量，改动需同步 docs/capabilities/css.md。
 */
export const BASELINE_CHROMIUM = 83

export const VERDICTS = Object.freeze({
  NO_RISK: 'no-risk',
  COVERED: 'covered',
  DEGRADED: 'degraded',
  DEFECT: 'defect',
  FALSE_POSITIVE: 'false-positive',
})

/** 判定 → 给人看的中文标签，docs/capabilities/css.md 与 CLI 输出共用 */
export const VERDICT_TEXT = Object.freeze({
  [VERDICTS.NO_RISK]: '无风险',
  [VERDICTS.COVERED]: '已有兜底',
  [VERDICTS.DEGRADED]: '可接受降级',
  [VERDICTS.DEFECT]: '真实缺陷',
  [VERDICTS.FALSE_POSITIVE]: '假阳性',
})

/**
 * 布局生效性探测属性：解析通过 ≠ 在当前布局模式下生效。
 *
 * `gap` 家族是唯一有实证的一组（issue #173）：`gap` 自 Chrome 66 起作为多列布局 / grid
 * 属性存在，flex 容器的 gap 到 Chromium 84 才生效。`@supports (gap: 12px)` 与
 * `CSS.supports('gap', '12px')` 在 WebView 83 上都返回 true，间距却是 0。
 *
 * 新增成员必须有同样的实证（某属性在模式 A 合法、在模式 B 未生效），否则会把安全的
 * 能力探测误判成假阳性。
 */
export const LAYOUT_CONTEXTUAL = Object.freeze(
  new Set(['gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap'])
)

/**
 * 特性表。firstSupported 取浏览器最低支持版本（Chromium 口径），每条与
 * scripts/compat/matrix-scan.mjs 的 CSS_FEATURES / docs/compat/matrix/README.md 第 4 节一致，
 * 那里带 MDN 出处；本文件不重复写 URL，避免两处说法漂移。
 *
 * fallback 描述兜底的种类：
 *   'unit'      单元等价：同一规则里先写一个旧单位（vh）的声明，再把新单位放进 @supports
 *   'attribute' 运行时实测后挂 html[data-flex-gap-fallback]，兜底样式只写在该属性之下
 *   'build'     构建期降级：lightningcss 按 browserslist(chrome >= 83) 展开/加前缀，产物里不再有新语法
 *   null        没有兜底
 *
 * cosmetic=true 表示缺了只是外观降级，不影响可用性；这类走 degraded 而不是 defect。
 */
export const CSS_FEATURES = Object.freeze([
  {
    id: 'dvh',
    label: 'dvh / svh / lvh 视口单位',
    firstSupported: 108,
    pattern: /\d+(?:\.\d+)?(?:dvh|svh|lvh)\b/gu,
    fallback: 'unit',
    fallbackUnit: 'vh',
    cosmetic: false,
  },
  {
    id: 'flex-gap',
    label: 'flex 容器 gap',
    firstSupported: 84,
    pattern: null, // 专用判定：只有 flex 容器上的 gap 才算，见 auditFlexGapHits
    fallback: 'attribute',
    cosmetic: false,
  },
  {
    id: ':has()',
    label: ':has() 关系选择器',
    firstSupported: 105,
    pattern: /:has\(/gu,
    fallback: null,
    // 选择器列表里只要有一个选择器无效，整条规则被丢弃 —— 不是「匹配不到」而是全丢
    destructive: true,
    cosmetic: false,
  },
  {
    id: '@container',
    label: '@container 容器查询',
    firstSupported: 105,
    pattern: /@container\b/gu,
    fallback: null,
    destructive: true,
    cosmetic: false,
  },
  {
    id: 'container-type',
    label: 'container-type 容器声明',
    firstSupported: 105,
    pattern: /container-type\s*:/gu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: ':focus-visible',
    label: ':focus-visible 焦点选择器',
    firstSupported: 86,
    pattern: /:focus-visible\b/gu,
    fallback: null,
    destructive: true,
    cosmetic: false,
    a11y: true,
  },
  {
    id: ':where()/:is()',
    label: ':where() / :is() 零权重选择器',
    firstSupported: 88,
    pattern: /:(?:is|where)\(/gu,
    fallback: null,
    destructive: true,
    cosmetic: true,
  },
  {
    id: 'inset',
    label: 'inset 简写',
    firstSupported: 87,
    pattern: /(?:^|[;{\s])inset(?:-(?:inline|block))?(?:-(?:start|end))?\s*:/dgu,
    fallback: 'build',
    cosmetic: false,
  },
  {
    id: 'min()/max()',
    label: 'min() / max() 数学函数',
    firstSupported: 79,
    pattern: /(?:^|[^\w-])(?:min|max)\(/dgu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: 'clamp()',
    label: 'clamp() 数学函数',
    firstSupported: 79,
    pattern: /clamp\(/gu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: 'overscroll-behavior',
    label: 'overscroll-behavior',
    firstSupported: 63,
    pattern: /overscroll-behavior(?:-[xy])?\s*:/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'scrollbar-gutter',
    label: 'scrollbar-gutter',
    firstSupported: 94,
    pattern: /scrollbar-gutter\s*:/gu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: 'touch-action',
    label: 'touch-action',
    firstSupported: 36,
    pattern: /touch-action\s*:/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'env(safe-area-inset-*)',
    label: 'env(safe-area-inset-*) 安全区',
    firstSupported: 69,
    pattern: /env\(\s*safe-area-inset-/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'backdrop-filter',
    label: 'backdrop-filter',
    firstSupported: 76,
    pattern: /(?<!-webkit-)backdrop-filter\s*:/gu,
    fallback: 'build',
    cosmetic: true,
  },
  {
    id: 'accent-color',
    label: 'accent-color',
    firstSupported: 93,
    pattern: /accent-color\s*:/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'aspect-ratio',
    label: 'aspect-ratio',
    firstSupported: 88,
    pattern: /aspect-ratio\s*:/gu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: 'text-wrap',
    label: 'text-wrap / text-wrap: balance',
    firstSupported: 114,
    pattern: /text-wrap\s*:/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'color-mix()',
    label: 'color-mix()',
    firstSupported: 111,
    pattern: /color-mix\(/gu,
    fallback: null,
    cosmetic: false,
  },
  {
    id: '@layer',
    label: '@layer 级联层',
    firstSupported: 99,
    pattern: /@layer\b/gu,
    fallback: null,
    cosmetic: true,
  },
  {
    id: 'nesting &',
    label: 'CSS 嵌套（&）',
    firstSupported: 112,
    pattern: /(?:^|\n)\s*&/gu,
    fallback: 'build',
    cosmetic: false,
  },
])

/** 特性 id → 表项，外部按 id 查版本与标签用 */
export const FEATURE_BY_ID = Object.freeze(
  Object.fromEntries(CSS_FEATURES.map((feature) => [feature.id, feature]))
)

const CSS_EXTENSIONS = new Set(['.css'])
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html'])

/** 去掉注释但保留换行 —— 行号必须和原文件一致，否则表里的「文件:行」全是错的 */
const blankComments = (text, withLineComments) => {
  const block = /\/\*[\s\S]*?\*\//gu
  let out = text.replace(block, (chunk) => chunk.replace(/[^\n]/gu, ' '))
  if (withLineComments) {
    // 只吃「前面不是协议冒号」的 //，避免把 https:// 之后整行抹掉
    out = out.replace(/(^|[^:\w])\/\/[^\n]*/gu, (chunk, lead) => lead + ' '.repeat(chunk.length - lead.length))
  }
  return out
}

const lineStartsOf = (text) => {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

const lineOfIndex = (starts, index) => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** 从 `{` 找到配对的 `}`，返回块内区间（不含花括号） */
const matchBrace = (text, openIndex) => {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return { start: openIndex + 1, end: index }
    }
  }
  return { start: openIndex + 1, end: text.length }
}

/**
 * 扫出所有 @supports 块：条件原文 + 块内区间。
 * 条件里可能有嵌套括号（calc / min），所以按括号配对而不是找第一个 `)`。
 */
const supportsBlocksOf = (text) => {
  const blocks = []
  const pattern = /@supports\s*(?=\()/gu
  let matched
  while ((matched = pattern.exec(text)) !== null) {
    let index = matched.index + matched[0].length
    let depth = 0
    let conditionEnd = -1
    for (; index < text.length; index += 1) {
      if (text[index] === '(') depth += 1
      else if (text[index] === ')') {
        depth -= 1
        if (depth === 0) {
          conditionEnd = index
          break
        }
      }
    }
    if (conditionEnd < 0) continue
    const braceIndex = text.indexOf('{', conditionEnd)
    if (braceIndex < 0) continue
    const body = matchBrace(text, braceIndex)
    blocks.push({
      index: matched.index,
      condition: text.slice(matched.index, conditionEnd + 1),
      bodyStart: body.start,
      bodyEnd: body.end,
    })
  }
  return blocks
}

/** 从 @supports 条件里抓被探测的属性/值：`(max-height: 100dvh)` → ['max-height', '100dvh'] */
const probeOfCondition = (condition) => {
  const matched = /\(\s*(?:not\s+)?\(?\s*(-{0,2}[a-z][\w-]*)\s*:\s*([^)]*)\)/iu.exec(condition)
  if (!matched) return null
  return { property: matched[1].toLowerCase(), value: matched[2].trim() }
}

const VIEWPORT_UNIT = /\d+(?:\.\d+)?(?:dvh|svh|lvh)\b/u
const VIEWPORT_UNIT_FALLBACK = /(?:^|[^\w.-])\d+(?:\.\d+)?vh\b/u

const versionOfProbe = (probe) => {
  if (!probe) return BASELINE_CHROMIUM
  if (LAYOUT_CONTEXTUAL.has(probe.property)) return FEATURE_BY_ID['flex-gap'].firstSupported
  if (VIEWPORT_UNIT.test(probe.value)) return FEATURE_BY_ID.dvh.firstSupported
  return BASELINE_CHROMIUM
}

const verdictOf = (feature, hasFallback) => {
  if (feature.firstSupported <= BASELINE_CHROMIUM) return VERDICTS.NO_RISK
  if (hasFallback) return VERDICTS.COVERED
  return feature.cosmetic ? VERDICTS.DEGRADED : VERDICTS.DEFECT
}

const riskOf = (feature, verdict) => {
  if (verdict === VERDICTS.FALSE_POSITIVE) return '高'
  if (verdict === VERDICTS.NO_RISK) return '低'
  if (verdict === VERDICTS.COVERED) return '低'
  if (verdict === VERDICTS.DEGRADED) return '低'
  if (feature.a11y) return '中'
  if (feature.destructive) return '中'
  return '中'
}

/**
 * 探测点判定：判能力还是判布局生效性。
 * 判布局生效性 = 被探测属性在别的布局模式下早已合法（LAYOUT_CONTEXTUAL），
 * 而且调用点在同一个文件里没有动态回读（getBoundingClientRect / offsetWidth …）。
 * 有回读的一律按能力探测记，因为回读已经把「效果」量过一遍了。
 */
const judgeProbe = (probe, hasReadback) => {
  if (!probe) {
    return { feature: '@supports', firstSupported: BASELINE_CHROMIUM, hasFallback: false, verdict: VERDICTS.NO_RISK, reason: '条件无法解析，按无风险记' }
  }
  const contextual = LAYOUT_CONTEXTUAL.has(probe.property)
  const firstSupported = versionOfProbe(probe)
  if (contextual && !hasReadback) {
    return {
      feature: 'CSS.supports',
      firstSupported,
      hasFallback: false,
      verdict: VERDICTS.FALSE_POSITIVE,
      reason: `探测 ${probe.property} 判的是布局生效性（该属性在别的布局模式下早已合法），且没有动态回读`,
    }
  }
  if (contextual && hasReadback) {
    return {
      feature: 'CSS.supports',
      firstSupported,
      hasFallback: true,
      verdict: VERDICTS.COVERED,
      reason: '判布局生效性，但同一文件里有动态回读（如 getBoundingClientRect），按正确姿态记',
    }
  }
  return {
    feature: 'CSS.supports',
    firstSupported,
    hasFallback: false,
    verdict: firstSupported <= BASELINE_CHROMIUM ? VERDICTS.NO_RISK : VERDICTS.COVERED,
    reason: '判能力（解析通过即生效），不是布局生效性探测',
  }
}

/** CSS.supports( ... )：两种签名都要认 —— ('prop','value') 与 ('prop: value') */
const CSS_SUPPORTS_CALL = /CSS\.supports\(\s*(['"`])([^'"`]*)\1(?:\s*,\s*(['"`])([^'"`]*)\3)?\s*\)/gu

const READBACK = /getBoundingClientRect|offsetWidth|offsetHeight|getClientRects|checkVisibility/gu

const probeOfCall = (first, second) => {
  if (typeof second === 'string' && second.length > 0) {
    return { property: first.trim().toLowerCase(), value: second.trim() }
  }
  const colon = first.indexOf(':')
  if (colon < 0) return { property: first.trim().toLowerCase(), value: '' }
  return { property: first.slice(0, colon).trim().toLowerCase(), value: first.slice(colon + 1).trim() }
}

/** flex 容器上非零 gap 的判定：兜底是否存在只看 html[data-flex-gap-fallback] */
const hasFlexGapAttribute = (text) => text.includes('data-flex-gap-fallback')

// 只认 flex：grid 与多列的 gap 从 Chrome 66 起就生效，把它们算进来会凭空造出缺陷
const FLEX_CONTAINER = /display\s*:\s*(?:inline-)?flex\b/u
const GAP_DECLARATION = /(?:^|[;{\s])(?:row-|column-)?gap\s*:/gu

/**
 * 判一个文件是否「CSS 源」（.css / .module.css），以及是否脚本文件（.ts/.tsx/.html）。
 * style 属性里的内联字符串也在这个范围内 —— 用 <style> 或 cssText 写 CSS 的同样算。
 */
const kindOf = (filePath) => {
  const extension = path.extname(filePath).toLowerCase()
  if (CSS_EXTENSIONS.has(extension)) return 'css'
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script'
  return 'other'
}

/**
 * 盘点入口。
 *
 * @param {Array<{path: string, content: string}>} files 已读入内存的源文件
 * @returns {{hits: Array<object>, summary: object}}
 */
export const auditCssAssumptions = (files = []) => {
  const hits = []

  for (const file of files) {
    const filePath = String(file?.path ?? '')
    const content = String(file?.content ?? '')
    const kind = kindOf(filePath)
    if (kind === 'other' || content === '') continue

    const text = blankComments(content, kind === 'script')
    const starts = lineStartsOf(text)
    const lines = text.split('\n')
    const hasReadback = new RegExp(READBACK.source, 'u').test(text)
    const supportedBlocks = kindsafeSupportsBlocks(text)

    const push = (index, fields) => {
      hits.push({ file: filePath, line: lineOfIndex(starts, index), ...fields })
    }

    // ---- 1. @supports 块 ----
    for (const block of supportedBlocks) {
      const probe = probeOfCondition(block.condition)
      const judged = judgeProbe(probe, hasReadback)
      const body = text.slice(block.bodyStart, block.bodyEnd)
      // 块里用的是新单位、门槛也是新单位时，等价兜底 = 同一规则里先有一份旧单位声明
      const needsUnitFallback = Boolean(probe) && VIEWPORT_UNIT.test(probe.value)
      const headLine = lineOfIndex(starts, block.index)
      const head = lines.slice(Math.max(0, headLine - 41), headLine - 1).join('\n')
      const unitFallback = VIEWPORT_UNIT_FALLBACK.test(body) || VIEWPORT_UNIT_FALLBACK.test(head)
      const hasFallback = needsUnitFallback ? unitFallback : judged.hasFallback
      const verdict =
        judged.verdict === VERDICTS.FALSE_POSITIVE || judged.verdict === VERDICTS.NO_RISK
          ? judged.verdict
          : needsUnitFallback
            ? verdictOf(FEATURE_BY_ID.dvh, hasFallback)
            : judged.verdict

      push(block.index, {
        feature: '@supports',
        probe: probe ? `${probe.property}: ${probe.value}` : block.condition,
        firstSupported: judged.firstSupported,
        hasFallback,
        verdict,
        risk: riskOf({ destructive: false, a11y: false }, verdict),
        reason:
          verdict === VERDICTS.FALSE_POSITIVE
            ? judged.reason
            : needsUnitFallback
              ? hasFallback
                ? 'dvh 只出现在 @supports 里，且同一规则先有等价 vh 声明（#13 的坑已避开）'
                : 'dvh 出现在 @supports 里但找不到等价 vh 基础声明 —— 低内核会掉回 initial'
              : judged.reason,
      })
    }

    // ---- 2. CSS.supports(...) 调用 ----
    const callPattern = new RegExp(CSS_SUPPORTS_CALL.source, CSS_SUPPORTS_CALL.flags)
    let call
    while ((call = callPattern.exec(text)) !== null) {
      const probe = probeOfCall(call[2] ?? '', call[4] ?? '')
      const judged = judgeProbe(probe, hasReadback)
      push(call.index, {
        feature: 'CSS.supports',
        probe: `${probe.property}${probe.value ? `: ${probe.value}` : ''}`,
        firstSupported: judged.firstSupported,
        hasFallback: judged.hasFallback,
        verdict: judged.verdict,
        risk: riskOf({ destructive: false, a11y: false }, judged.verdict),
        reason: judged.reason,
      })
    }

    // ---- 3. 逐特性的声明级命中（只扫 CSS：脚本里的 Math.max( / clamp( 是同名函数，不是 CSS 特性）----
    for (const feature of kind === 'css' ? CSS_FEATURES : []) {
      if (feature.pattern === null) continue
      const pattern = new RegExp(feature.pattern.source, feature.pattern.flags)
      let matched
      while ((matched = pattern.exec(text)) !== null) {
        const index = matched.index + (matched[0].startsWith('\n') ? 1 : 0)
        // 命中落在这个文件的某个 @supports 块内/条件里 → 已经在第 1 步判过，不重复记
        const insideSupports = supportedBlocks.some(
          (block) => index >= block.index && index <= block.bodyEnd
        )
        if (feature.id === 'dvh' && insideSupports) continue

        let hasFallback = false
        if (feature.fallback === 'unit') {
          const headLine = lineOfIndex(starts, index)
          const head = lines.slice(Math.max(0, headLine - 41), headLine - 1).join('\n')
          hasFallback = VIEWPORT_UNIT_FALLBACK.test(head)
        } else if (feature.fallback === 'build') {
          hasFallback = true
        } else if (feature.fallback === 'attribute') {
          hasFallback = hasFlexGapAttribute(text)
        }

        const verdict =
          feature.id === 'dvh' && !insideSupports
            ? VERDICTS.DEFECT // dvh 直接写在规则里 = 踩 #13 的坑
            : verdictOf(feature, hasFallback)

        push(index, {
          feature: feature.id,
          probe: feature.label,
          firstSupported: feature.firstSupported,
          hasFallback,
          verdict,
          risk:
            feature.id === 'dvh' && !insideSupports ? '高' : riskOf(feature, verdict),
          reason:
            feature.fallback === 'build'
              ? 'lightningcss 按 browserslist(chrome >= 83) 在构建期展开/加前缀，产物里不再有新语法'
              : feature.fallback === 'attribute'
                ? hasFallback
                  ? '运行时实测后挂 html[data-flex-gap-fallback]（issue #173 的正确姿态）'
                  : 'flex 容器上的 gap 没有兜底属性块'
                : verdictOf(feature, hasFallback) === VERDICTS.NO_RISK
                  ? `首支持 Chromium ${feature.firstSupported}，低于基线 ${BASELINE_CHROMIUM}`
                  : hasFallback
                    ? '有等价兜底'
                    : '无兜底',
        })
      }
    }

    // ---- 4. flex 容器上的 gap（单独判定，需要看容器形态）----
    const gapPattern = new RegExp(GAP_DECLARATION.source, GAP_DECLARATION.flags)
    let gap
    while (kind === 'css' && (gap = gapPattern.exec(text)) !== null) {
      const braceIndex = text.lastIndexOf('{', gap.index)
      if (braceIndex < 0) continue
      const blockEnd = text.indexOf('}', gap.index)
      const block = text.slice(braceIndex, blockEnd < 0 ? text.length : blockEnd)
      if (!FLEX_CONTAINER.test(block)) continue
      const declaration = text.slice(gap.index, text.indexOf(';', gap.index) + 1)
      if (/:\s*0(?:px)?\s*;/u.test(declaration)) continue
      const hasFallback = hasFlexGapAttribute(text)
      const verdict = verdictOf(FEATURE_BY_ID['flex-gap'], hasFallback)
      push(gap.index, {
        feature: 'flex-gap',
        probe: declaration.replace(/\s+/gu, ' ').trim(),
        firstSupported: FEATURE_BY_ID['flex-gap'].firstSupported,
        hasFallback,
        verdict,
        risk: riskOf(FEATURE_BY_ID['flex-gap'], verdict),
        reason: hasFallback
          ? 'flex 容器上的 gap 有 html[data-flex-gap-fallback] 兜底块'
          : 'flex 容器上的 gap 没有兜底 —— WebView 83 上间距为 0',
      })
    }

    // ---- 5. getComputedStyle 声明回读（脚本侧同一类假阳性）----
    if (kind === 'script') auditComputedStyleProbes(text, push)
  }

  return { hits, summary: summarize(hits, files) }
}

/** 内部：安全地扫 @supports 块（注释已抹，不会再撞上注释里的 @supports 字样） */
const kindsafeSupportsBlocks = (text) => supportsBlocksOf(text)

/**
 * 第四个探测面：用 getComputedStyle 读**声明值**代替实测布局效果。
 *
 * 这是 #173 那一类假阳性在 JS 侧的同一副面孔：
 *   getComputedStyle(el).overflowY 命中 auto|scroll  →  断言「这里能滚」
 * 但「声明了 overflow-y: auto」不等于「真的能滚」—— 高度链断开时盒子无界、可滚距离为 0，
 * 或内容不足一屏。断言成真后会放行 touchmove，于是容器滚不动、整页也不再滚 = 静默锁死。
 *
 * 判据很硬：读的是 overflow / display / visibility / opacity 这类**生效性依赖布局上下文**
 * 的属性，而同一个文件里没有效果回读（scrollHeight / clientHeight / getBoundingClientRect …）。
 * 有回读就说明已经量过效果，按正确姿态记。
 */
export const COMPUTED_STYLE_PROBE = Object.freeze({
  id: 'getComputedStyle',
  label: 'getComputedStyle 声明回读',
  firstSupported: BASELINE_CHROMIUM,
})

const COMPUTED_STYLE_CALL = /getComputedStyle\s*\(/gu
const LAYOUT_EFFECT_PROPERTY = /\.\s*(overflowY|overflowX|overflow|display|visibility)\b/gu
const LAYOUT_EFFECT_READBACK =
  /scrollHeight|clientHeight|getBoundingClientRect|getClientRects|offsetHeight|checkVisibility/gu
/** 一次调用之后多远还算「同一处判断」—— 通常是 `const style = getComputedStyle(el)` 后紧跟一行 */
const PROBE_WINDOW = 300

const auditComputedStyleProbes = (text, push) => {
  const hasReadback = new RegExp(LAYOUT_EFFECT_READBACK.source, 'u').test(text)
  const callPattern = new RegExp(COMPUTED_STYLE_CALL.source, COMPUTED_STYLE_CALL.flags)
  let call
  while ((call = callPattern.exec(text)) !== null) {
    const scope = text.slice(call.index, call.index + PROBE_WINDOW)
    const effect = new RegExp(LAYOUT_EFFECT_PROPERTY.source, 'u').exec(scope)
    if (!effect) continue
    const property = effect[1]
    if (hasReadback) {
      push(call.index, {
        feature: COMPUTED_STYLE_PROBE.id,
        probe: `getComputedStyle(...).${property}`,
        firstSupported: COMPUTED_STYLE_PROBE.firstSupported,
        hasFallback: true,
        verdict: VERDICTS.COVERED,
        risk: '低',
        reason: '读声明值，但同一文件里有实测回读（scrollHeight / getBoundingClientRect…），效果已被量过',
      })
      continue
    }
    push(call.index, {
      feature: COMPUTED_STYLE_PROBE.id,
      probe: `getComputedStyle(...).${property}`,
      firstSupported: COMPUTED_STYLE_PROBE.firstSupported,
      hasFallback: false,
      verdict: VERDICTS.FALSE_POSITIVE,
      risk: '高',
      reason: `用声明值 .${property} 断言布局效果，没有任何实测回读 —— 声明了不等于生效，效果为 0 时判定照样通过`,
    })
  }
}

const tally = (items, key) => {
  const out = {}
  for (const item of items) {
    const value = item[key]
    out[value] = (out[value] ?? 0) + 1
  }
  return out
}

const summarize = (hits, files) => {
  const byFeature = {}
  for (const hit of hits) {
    const record = (byFeature[hit.feature] ??= {
      feature: hit.feature,
      count: 0,
      firstSupported: hit.firstSupported,
      covered: 0,
      noRisk: 0,
      degraded: 0,
      defect: 0,
      falsePositive: 0,
    })
    record.count += 1
    if (hit.verdict === VERDICTS.COVERED) record.covered += 1
    else if (hit.verdict === VERDICTS.NO_RISK) record.noRisk += 1
    else if (hit.verdict === VERDICTS.DEGRADED) record.degraded += 1
    else if (hit.verdict === VERDICTS.DEFECT) record.defect += 1
    else if (hit.verdict === VERDICTS.FALSE_POSITIVE) record.falsePositive += 1
  }

  return {
    files: files.length,
    filesWithHits: new Set(hits.map((hit) => hit.file)).size,
    hits: hits.length,
    byFeature,
    byVerdict: tally(hits, 'verdict'),
    byRisk: tally(hits, 'risk'),
    falsePositives: hits.filter((hit) => hit.verdict === VERDICTS.FALSE_POSITIVE),
    defects: hits.filter((hit) => hit.verdict === VERDICTS.DEFECT),
  }
}

/**
 * 便捷读取：把扫描范围里的源文件读成 { path, content } 数组（判定函数本身不碰盘）。
 * CSS 与脚本都要收：CSS 收特性声明，脚本收 CSS.supports(...) 与 getComputedStyle 回读。
 */
export const collectSources = (root, { includeHtml = true } = {}) => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      const kind = kindOf(full)
      const extension = path.extname(full).toLowerCase()
      if (kind === 'css') {
        out.push({ path: relativeTo(root, full), content: readFileSync(full, 'utf8') })
      } else if (kind === 'script' && (includeHtml || extension !== '.html')) {
        out.push({ path: relativeTo(root, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(root)
  return out.sort((left, right) => left.path.localeCompare(right.path))
}

const relativeTo = (root, full) => path.relative(root, full).split(path.sep).join('/')
