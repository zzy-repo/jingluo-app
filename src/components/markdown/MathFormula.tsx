import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import { readMathTexSource, stripMathDelimiters } from '../../services/markdown/mathSource.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

type MathHtmlResult = {
  html: string
  renderMode: 'katex' | 'fallback'
}

const noop = () => {}

/** KaTeX 渲染公式；出错时保留上次成功的结果（流式中公式未写完），没有则展示原文 */
const useMathHtml = (input: string, isInline: boolean): MathHtmlResult => {
  const previousResultRef = useRef<MathHtmlResult | null>(null)
  const katexRef = useRef(ensureKatex())
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  return useMemo((): MathHtmlResult => {
    if (!katex) {
      return { html: input, renderMode: 'fallback' }
    }
    try {
      const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
      const html = katex
        .renderToString(input, { throwOnError: true, strict: false, displayMode: !isInline })
        .slice(prefix.length, -suffix.length)
      const result = { html, renderMode: 'katex' } as const
      previousResultRef.current = result
      return result
    } catch {
      return previousResultRef.current ?? { html: input, renderMode: 'fallback' }
    }
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

export const MathBlock = memo(function MathBlock({ value }: { value: string }) {
  const { html, renderMode } = useMathHtml(value, false)
  const hostRef = useRef<HTMLSpanElement>(null)
  if (renderMode === 'fallback') {
    return <p className="ds-markdown-paragraph">{html}</p>
  }
  return (
    <span className="katex-display ds-markdown-math md-math-block" ref={hostRef}>
      <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
      <MathCopyButton hostRef={hostRef} fallback={value} />
    </span>
  )
})

export const InlineMath = memo(function InlineMath({ value }: { value: string }) {
  const { html, renderMode } = useMathHtml(value, true)
  const hostRef = useRef<HTMLSpanElement>(null)
  if (renderMode === 'fallback') {
    return html
  }
  return (
    <span className="md-math-inline" ref={hostRef}>
      <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
      <MathCopyButton hostRef={hostRef} fallback={value} />
    </span>
  )
})
