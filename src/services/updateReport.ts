import { scrubReportText } from '../app/errorReport.js'
import { RELEASE_BASES } from './updateManifest.js'

/**
 * 「检查更新」弹窗里的**诊断文本**（Issue #310）。
 *
 * 为什么单独一层：它要被单测钉住（字段顺序、脱敏、不含地址路径与堆栈），
 * 而弹窗组件本身只能在浏览器里验。这里只拼字符串，不碰 React、不碰采集层。
 *
 * 复用既有能力，不另造一套：
 * - 脱敏走 `src/app/errorReport.ts:scrubReportText`（错误页「复制诊断信息」用的同一套规则）；
 * - 剪贴板走 `src/utils/clipboard.ts:copyText`（调用方负责）。
 */

/** 更新检查的现场事实：全是用户在界面上本来就能看到的信息 */
export interface UpdateReportFacts {
  /** 当前版本号（构建期注入） */
  version: string
  /** 当前 versionCode */
  versionCode?: number
  /** 渠道的中文名 */
  channel: string
  /** 是否 Android 原生更新通道 */
  native: boolean
  /** 最近一次检查的时刻（ms） */
  checkedAt?: number
  /** 最近一次检查的结论（`describeUpdateFailure().text` / `describeUpToDate().text`） */
  outcome?: string
  /** 上游短码（只在这里出现，界面不展示） */
  code?: string
  /** 本次清单实际生效的分发机（回退成功时与首选不同） */
  base?: string
}

/** 只取 `host[:port]`：路径 / query / 协议头都不进文本（分发机地址里带签名时等于泄漏） */
export const hostOf = (value: string | undefined): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'unknown'
  }
  try {
    return new URL(value).host || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 首选 → 回退的分发顺序，只写 host */
export const releaseHosts = (): string => RELEASE_BASES.map((base) => hostOf(base)).join(' → ')

const timeLine = (at: number | undefined): string => {
  if (at === undefined || !Number.isFinite(at)) {
    return '时间: 尚未检查'
  }
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '时间: 尚未检查' : `时间: ${date.toISOString()}`
}

/** 拼出「复制诊断信息」的正文。字段顺序固定，便于人工比对与单测断言 */
export const buildUpdateReport = (facts: UpdateReportFacts): string => {
  const lines = [
    'DeepSeek 应用内更新诊断',
    `版本: ${facts.version || 'unknown'}${facts.versionCode === undefined ? '' : ` (${facts.versionCode})`}`,
    `渠道: ${facts.channel}`,
    `通道: ${facts.native ? 'Android 原生更新' : '网页预览（仅下载链接）'}`,
    timeLine(facts.checkedAt),
    `结论: ${facts.outcome === undefined || facts.outcome === '' ? '尚未检查' : facts.outcome}`,
  ]
  if (facts.code !== undefined && facts.code !== '') {
    lines.push(`上游短码: ${facts.code}`)
  }
  lines.push(`更新服务: ${releaseHosts()}`)
  if (facts.base !== undefined && facts.base !== '') {
    lines.push(`本次生效: ${hostOf(facts.base)}`)
  }
  return scrubReportText(lines.join('\n'))
}
