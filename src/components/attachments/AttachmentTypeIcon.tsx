/**
 * #527 附件类型图标：PDF / DOCX / TXT 三种。
 *
 * PDF 直接复用 `files/FileIcon`（已有的官方图标），DOCX 与 TXT 补两个同款外框的变体：
 * 外框路径与 `files/FileIcon` 的 `FileIconFrame` 一致，只换主色与内部白色字形，
 * 保证三种图标在卡片里是同一套视觉语言。
 */
import type { ReactNode } from 'react'
import { FileIcon } from '../files/FileIcon.js'

/** 与 `FileIconFrame` 同一条外框路径（28×28 viewBox） */
function Frame({ color, children }: { color: string; children: ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={28} height={28} viewBox="0 0 28 28" fill="none">
      <path
        d="M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3257 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z"
        fill={color}
      />
      <path
        d="M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z"
        fill="white"
        fillOpacity=".7"
      />
      {children}
    </svg>
  )
}

/** Word：正文行 + 一个小表格，表示「段落 + 表格」都被抽取 */
function DocxIcon() {
  return (
    <Frame color="#2B579A">
      <g fill="white">
        <rect x="7.6" y="12.2" width="12.8" height="1.6" rx=".8" />
        <rect x="7.6" y="15.8" width="12.8" height="1.6" rx=".8" />
        <rect x="7.6" y="19.4" width="7.4" height="1.6" rx=".8" />
        <rect x="16.6" y="19.4" width="3.8" height="1.6" rx=".8" fillOpacity=".7" />
      </g>
    </Frame>
  )
}

/** 纯文本：三条等宽行，长短递减 */
function TxtIcon() {
  return (
    <Frame color="#6B7785">
      <g fill="white">
        <rect x="7.6" y="12.2" width="12.8" height="1.6" rx=".8" />
        <rect x="7.6" y="15.8" width="12.8" height="1.6" rx=".8" fillOpacity=".85" />
        <rect x="7.6" y="19.4" width="8.6" height="1.6" rx=".8" fillOpacity=".7" />
      </g>
    </Frame>
  )
}

/**
 * 入口按钮用的小号「文档」图标（16px 描边风）。
 *
 * 为什么单独一个：输入区并排有两个入口 —— 图片（`IconPaperclipOutline16`，走 Files API）
 * 与文档（本图标，走 manager + 文本注入）。两个回形针并排会让人分不清哪个是哪个。
 */
export const IconDocumentOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M9.25 1.75H6.5c-.98 0-1.47 0-1.79.17-.32.17-.62.47-.79.79-.17.32-.17.81-.17 1.79v7c0 .98 0 1.47.17 1.79.17.32.47.62.79.79.32.17.81.17 1.79.17h4c.98 0 1.47 0 1.79-.17.32-.17.62-.47.79-.79.17-.32.17-.81.17-1.79V6L9.25 1.75Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path
      d="M9.25 1.75V5c0 .47 0 .7.09.88.08.15.21.28.36.36.18.09.41.09.88.09h3.25"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M6.1 8.4h4.2M6.1 10.7h2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

/** 不认识的扩展名（历史数据 / 未来的格式）兜底成通用文档图标 */
export const AttachmentTypeIcon = ({ extension }: { extension: string }) => {
  if (extension === 'PDF') {
    return <FileIcon ext="PDF" />
  }
  if (extension === 'DOCX') {
    return <DocxIcon />
  }
  if (extension === 'TXT') {
    return <TxtIcon />
  }
  return <FileIcon ext={extension} />
}
