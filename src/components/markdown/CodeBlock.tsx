import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useState, type CSSProperties } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import { codeFileName, splitHighlightedLines } from '../../services/markdown/codeLines.js'
import { setCodeLineNumbers, setCodeWrap, useSettings } from '../../services/settings.js'
import { savePlainText } from '../../utils/savePlainText.js'
import { IconCheckOutline16, IconCopyOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

/**
 * 代码块标题栏：左侧语言名（或 Mermaid 图/码切换），右侧行号、换行、下载与复制。
 *
 * 行号 / 换行是**本机设置**（`services/settings.ts` 的 `codeLineNumbers` / `codeWrap`），
 * 与其它设置项同一份 store + 同一套 localStorage 读写；默认值等于改造前的现状
 * （无行号 / 长行折行），所以存量代码块的截图基线不变。
 */
const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
  showCodeControls,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
  /** Mermaid 看图时不显示行号 / 换行 / 下载：它们作用在源码视图上，摆在图上点了没反应 */
  showCodeControls: boolean
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const lineNumbers = useSettings((state) => state.codeLineNumbers)
  const wrap = useSettings((state) => state.codeWrap)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.name} title={infostring}>
          {infostring}
        </span>
      )}
      <div className={styles.actions}>
        {showCodeControls ? (
          <>
            <button
              type="button"
              className={styles.button}
              aria-pressed={lineNumbers}
              onClick={() => setCodeLineNumbers(!lineNumbers)}
            >
              {t('codeLineNumbers')}
            </button>
            <button
              type="button"
              className={styles.button}
              aria-pressed={wrap}
              onClick={() => setCodeWrap(!wrap)}
            >
              {t('codeWrap')}
            </button>
            <button
              type="button"
              className={styles.button}
              aria-label={t('codeDownload')}
              title={t('codeDownload')}
              disabled={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  // 复用既有落盘出口：src/utils/savePlainText.ts → services/exportText.ts
                  // （Android 走 ExportText 原生桥的 SAF 面板，Web 走 Blob 下载），不另造一套。
                  const result = await savePlainText(codeFileName(infostring), code)
                  if (result === 'saved') {
                    showToast({ key: 'codeDownloadSaved' })
                  }
                } catch {
                  showToast({ key: 'codeDownloadFailed' })
                } finally {
                  setSaving(false)
                }
              }}
            >
              <IconDownloadOutline16 />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={styles.button}
          onClick={async () => {
            if (!(await copyText(code))) {
              showToast({ key: 'copyFailed' })
              return
            }
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
          <span>{t(copied ? 'copied' : 'copy')}</span>
        </button>
      </div>
    </div>
  )
}

/** 代码块：语言包按需加载，不支持或尚未加载的语言按纯文本显示 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const [showDiagram, setShowDiagram] = useState(true)
  const lineNumbers = useSettings((state) => state.codeLineNumbers)
  const wrap = useSettings((state) => state.codeWrap)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    const name = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, lang, loaded])
  /**
   * 行号：整段高亮一次之后按行切开（见 `services/markdown/codeLines.ts` 的说明），
   * 每行一个 `<span class="md-code-block-line">`，行号是行内元素，所以**换行打开时
   * 折行后的续行仍对齐在源码列**（这是两列式行号槽做不到的）。
   * 关闭行号时走原来的整段 innerHTML，一条标签都不多。
   */
  const displayHtml = useMemo(() => {
    if (!lineNumbers) {
      return renderedHtml
    }
    const lines = splitHighlightedLines(renderedHtml)
    let html = ''
    for (let index = 0; index < lines.length; index += 1) {
      html += `<span class="md-code-block-line"><span class="md-code-block-lineno" aria-hidden="true">${
        index + 1
      }</span>${lines[index]}</span>`
    }
    return html
  }, [renderedHtml, lineNumbers])
  /** 行号槽宽度按行数位数算，超过 99 行不会把源码顶歪 */
  const gutterStyle = useMemo(() => {
    const digits = Math.max(2, String(code.split('\n').length).length)
    return { '--md-code-gutter-width': `${digits + 1}ch` } as CSSProperties
  }, [code])
  const codeVisible = !(isMermaid && showDiagram)
  return (
    <div
      className="md-code-block"
      data-line-numbers={lineNumbers ? 'true' : 'false'}
      data-wrap={wrap ? 'true' : 'false'}
      style={lineNumbers ? gutterStyle : undefined}
    >
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
          showCodeControls={codeVisible}
        />
      </div>
      {isMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: displayHtml }}></pre>
      )}
    </div>
  )
})
