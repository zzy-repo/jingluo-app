import './beautifyMath.css'
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import {
  planMathRender,
  type MathBlockPart,
  type MathRenderPlan,
} from '../../services/markdown/mathBlocks.js'
import { isTrustedMathCommand, normalizeBeautifyMath } from '../../services/markdown/mathCompat.js'
import { readMathTexSource, stripMathDelimiters } from '../../services/markdown/mathSource.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

const noop = () => {}

/** 切掉 renderToString 自己加的外层包裹；形态不符时原样返回，绝不乱 slice */
const stripWrapper = (html: string, isInline: boolean): string => {
  const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
  return html.startsWith(prefix) && html.endsWith(suffix)
    ? html.slice(prefix.length, -suffix.length)
    : html
}

/**
 * 公式渲染计划（issue #821）。
 *
 * 与改动前的差别只有一条：整块 `ParseError` 时**不再把整块换成 TeX 原文**，而是交给
 * `planMathRender` 按 `\\` 模块逐个降级（见 `services/markdown/mathBlocks.ts`）。
 *
 * 流式仍按老规矩：上一次渲染成功过、且这次是它的**延长**（公式还没写完，例如
 * `\frac{1}` 尾巴还在路上），就先显示上一次的结果，不闪降级块。
 */
const useMathRender = (input: string, isInline: boolean) => {
  const katexRef = useRef(ensureKatex())
  const previousRef = useRef<{ input: string; plan: MathRenderPlan } | null>(null)
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  return useMemo((): MathRenderPlan | null => {
    // KaTeX 还没加载完：返回 null，由调用方先按原文顶上（与改动前一致）
    if (!katex) {
      return null
    }
    // #821：「美化规则」用 graphicx 命令画气泡。每一次渲染（整块 / 逐块降级）都先改写成 KaTeX 认识的写法，
    // 这样 `\scalebox` 这类命令是真的渲染出来，而不是被 `planMathRender` 当成「不支持」降级成原文。
    // `trust` 不是开关，只放行改写自己生成的 font-size / rotate 样式与固定 class（见 mathCompat.ts），
    // 用户手写的 `\htmlStyle` / `\href` 一律拒绝。`throwOnError` 仍为 true：真写坏的公式照旧走降级，不渲染红字。
    const render = (tex: string): string =>
      stripWrapper(
        katex.renderToString(normalizeBeautifyMath(tex), {
          throwOnError: true,
          strict: 'ignore',
          trust: isTrustedMathCommand,
          displayMode: !isInline,
        }),
        isInline
      )
    const plan = planMathRender(input, render)
    if (plan.mode === 'katex') {
      previousRef.current = { input, plan }
      return plan
    }
    const renderedSomething = plan.parts.some(
      (part) => part.kind === 'rendered' && part.html !== ''
    )
    const previous = previousRef.current
    if (
      !renderedSomething &&
      previous !== null &&
      previous.plan.mode === 'katex' &&
      input.length > previous.input.length &&
      input.startsWith(previous.input)
    ) {
      return previous.plan
    }
    return plan
  }, [input, isInline, katex])
}

/**
 * 「复制公式源码」按钮（issue #486 P0-2）。
 *
 * 复制的是 KaTeX 藏在 `.katex-mathml annotation[encoding="application/x-tex"]` 里的 **TeX 原文**，
 * 不是可见字形 —— 框选可见文本只会得到排版碎片。取不到 annotation 时回落到 `value`（mdast 里的
 * 同一份 TeX），所以「MathML 输出被关掉」的渲染器变体也还能用。
 *
 * 按钮默认 `opacity: 0` + `pointer-events: none`（样式在 `markdown.css` 的 `.md-float-copy`）：
 * 不占位、不遮挡公式，但**仍在 Tab 顺序里**，键盘走到它时由父级 `:focus-within` 显形；
 * 触屏上点一下公式容器同样会走 `:hover` 显形。
 */
const MathCopyButton = ({
  hostRef,
  fallback,
}: {
  hostRef: RefObject<HTMLSpanElement>
  fallback: string
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="md-float-copy md-math-copy"
      aria-label={t('mathCopySource')}
      title={t('mathCopySource')}
      onClick={async () => {
        const source = readMathTexSource(hostRef.current)
        if (!(await copyText(stripMathDelimiters(source === null ? fallback : source)))) {
          showToast({ key: 'copyFailed' })
          return
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
    </button>
  )
}

/** 渲染不了的那一块：说明 + 「查看原文」折叠（默认收起，正文只占一行提示） */
const UnsupportedPart = ({ part, compact }: { part: MathBlockPart; compact: boolean }) => {
  const t = useTranslate()
  if (part.kind !== 'unsupported') {
    return null
  }
  const note = t('mathUnsupportedBlock')
  // 空原因 = 没抛错但有排版残渣（KaTeX 把 `[0pt][0pt]` 当文字打出来了），用本地化文案
  const reason = part.reason === '' ? t('mathIgnoredArgs') : part.reason
  // 行内公式没有「一块」的概念，也不能塞折叠块：给标题提示 + 等宽原文，不撑破行
  if (compact) {
    return (
      <span className="md-math-unsupported-inline" title={`${note}：${reason}`}>
        <code className="md-math-unsupported-source">{part.source}</code>
      </span>
    )
  }
  return (
    <span className="md-math-unsupported">
      <span className="md-math-unsupported-note">{note}</span>
      <details className="md-math-unsupported-detail">
        <summary>{t('mathSourceToggle')}</summary>
        <code className="md-math-unsupported-source">{part.source}</code>
        <span className="md-math-unsupported-reason">
          {t('mathUnsupportedReason')}
          {reason}
        </span>
      </details>
    </span>
  )
}

/** 降级视图：能渲染的模块照常排版，只有失败的模块换成可读提示（issue #821 B/C 方案） */
const MathDegraded = memo(function MathDegraded({
  plan,
  compact,
}: {
  plan: Extract<MathRenderPlan, { mode: 'degraded' }>
  compact: boolean
}) {
  const t = useTranslate()
  return (
    <span className={`md-math-degraded${compact ? ' md-math-degraded-inline' : ''}`}>
      {!compact && plan.approximated.length > 0 && (
        <span className="md-math-degraded-note">{t('mathSimplified')}</span>
      )}
      {plan.parts.map((part, index) =>
        part.kind === 'rendered' ? (
          <span
            className={compact ? 'katex md-math-degraded-part' : 'katex md-math-degraded-line'}
            key={index}
            dangerouslySetInnerHTML={{ __html: part.html }}
          />
        ) : (
          <UnsupportedPart key={index} part={part} compact={compact} />
        )
      )}
    </span>
  )
})

export const MathBlock = memo(function MathBlock({ value }: { value: string }) {
  const plan = useMathRender(value, false)
  const hostRef = useRef<HTMLSpanElement>(null)
  // KaTeX 还没加载完：先给原文，和改动前完全一致（加载完会重渲染）
  if (plan === null) {
    return <p className="ds-markdown-paragraph">{value}</p>
  }
  if (plan.mode === 'degraded') {
    return (
      <span className="ds-markdown-math md-math-block" ref={hostRef}>
        <MathDegraded plan={plan} compact={false} />
        <MathCopyButton hostRef={hostRef} fallback={value} />
      </span>
    )
  }
  return (
    <span className="katex-display ds-markdown-math md-math-block" ref={hostRef}>
      <span className="katex" dangerouslySetInnerHTML={{ __html: plan.html }}></span>
      <MathCopyButton hostRef={hostRef} fallback={value} />
    </span>
  )
})

export const InlineMath = memo(function InlineMath({ value }: { value: string }) {
  const plan = useMathRender(value, true)
  const hostRef = useRef<HTMLSpanElement>(null)
  if (plan === null) {
    return value
  }
  if (plan.mode === 'degraded') {
    return (
      <span className="md-math-inline" ref={hostRef}>
        <MathDegraded plan={plan} compact />
        <MathCopyButton hostRef={hostRef} fallback={value} />
      </span>
    )
  }
  return (
    <span className="md-math-inline" ref={hostRef}>
      <span className="katex" dangerouslySetInnerHTML={{ __html: plan.html }}></span>
      <MathCopyButton hostRef={hostRef} fallback={value} />
    </span>
  )
})
