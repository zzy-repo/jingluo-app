import { createElement, type ReactNode } from 'react'
import {
  isTranslationKey,
  reportMissingKey,
  type TranslationKey,
  type TranslationMessage,
  type TranslationParams,
} from '../../i18n/index.js'
import type { ImportSkip } from '../../services/chat/history/toLocal.js'
import type { HistoryImportSummary } from '../../services/chat/store.js'

/**
 * #49：导入结果的「跳过明细」。
 *
 * 为什么要单独一层：导入的容错策略是「坏消息截断、坏会话跳过、其余照常入库」，
 * 但用户之前只看到一句「已导入 N 个会话」——到底丢了什么、丢在哪条消息上，全靠猜。
 * 这里把 `state.importSkipped` 里的每条记录渲染成一行人话：条目类型 + 定位（会话标题 / 消息 id /
 * 缺失的父消息 id）+ 原因。
 *
 * 用 `createElement` 而不是 JSX、也不 import CSS：本文件要被 `tests/unit/import-skipped-ui.test.mjs`
 * 在裸 Node 里用 renderToStaticMarkup 真渲染一遍（样式类名由调用方按需注入，见 SettingsDialog）。
 */

/** 翻译函数：组件不自己取语言，交给调用方（真机上就是 useTranslate()）。 */
export type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** 样式注入：不在这里 import CSS Module，测试环境也就能直接渲染。 */
export type ImportSkippedClassNames = {
  box?: string
  header?: string
  title?: string
  list?: string
  row?: string
  scope?: string
  text?: string
}

/** 条目类型的中文/英文说法：会话 / 消息 / 当前分支定位。 */
const SCOPE_KEY: Record<ImportSkip['scope'], TranslationKey> = {
  session: 'historyImportSkipScopeSession',
  message: 'historyImportSkipScopeMessage',
  branch: 'historyImportSkipScopeBranch',
}

/** 原因 key → 「跳过」语境下的说法（既有 backupInvalid* 是「无法导入」，与跳过语义不符，另起一条）。 */
const REASON_KEY: Partial<Record<TranslationKey, TranslationKey>> = {
  backupInvalidBranches: 'historyImportSkipReasonBranches',
  backupInvalidFiles: 'historyImportSkipReasonFiles',
}

const reasonText = (entry: ImportSkip, t: Translate): string => {
  // 归档里的 reason 来自别的版本 / 第三方构造的包：类型上写着 TranslationKey，运行时并不可信。
  // 以前这里 `entry.reason as TranslationKey` 直接查表，缺 key 就抛 TypeError 且没有 key 名（#314）；
  // 现在先收敛到受控类型，认不出来就走同一条 miss 上报 + 专用兜底文案。
  const reason: unknown = entry.reason
  if (!isTranslationKey(reason)) {
    reportMissingKey(reason)
    return t('historyImportSkipReasonUnknown')
  }
  return t(REASON_KEY[reason] ?? reason)
}

/** 定位文案：会话标题 + 消息 id（会话级跳过只有标题）。 */
const whereText = (entry: ImportSkip, t: Translate): string => {
  const session = entry.sessionTitle || entry.sessionId
  if (entry.scope === 'session') {
    return t('historyImportSkipWhereSession', { session })
  }
  const message = entry.messageId === null ? '' : `#${entry.messageId}`
  if (entry.scope === 'branch') {
    return t('historyImportSkipWhereBranch', { session, message })
  }
  return t('historyImportSkipWhereMessage', { session, message })
}

/** 一条跳过记录：`[类型] 定位 · 原因（缺失的父消息 #id）`。 */
const SkippedRow = ({
  entry,
  t,
  classNames,
}: {
  entry: ImportSkip
  t: Translate
  classNames: ImportSkippedClassNames
}): ReactNode => {
  const parts: ReactNode[] = [
    `${whereText(entry, t)} · ${reasonText(entry, t)}`,
  ]
  if (entry.parentId !== null) {
    parts.push(`（${t('historyImportSkipMissingParent', { parent: `#${entry.parentId}` })}）`)
  }
  return createElement(
    'li',
    {
      className: classNames.row,
      // 供测试与排查定位：条目的类型、会话 id、（有的话）消息 id
      'data-skipped-entry': `${entry.scope}:${entry.sessionId}${
        entry.messageId === null ? '' : `#${entry.messageId}`
      }`,
    },
    createElement('span', { className: classNames.scope }, t(SCOPE_KEY[entry.scope])),
    createElement('span', { className: classNames.text }, ...parts)
  )
}

/**
 * 跳过明细列表：没有跳过时什么都不渲染（正常导入不长出多余的一块）。
 * 传 `idPrefix` 只是给非受控展开留口子，当前版本默认全展开——丢数据这件事不该藏在折叠里。
 */
export const ImportSkippedDetails = ({
  skipped,
  t,
  classNames = {},
}: {
  skipped: ImportSkip[]
  t: Translate
  classNames?: ImportSkippedClassNames
}): ReactNode => {
  if (skipped.length === 0) {
    return null
  }
  return createElement(
    'div',
    { className: classNames.box, 'data-skipped-box': '' },
    createElement(
      'div',
      { className: classNames.header, 'data-skipped-header': '' },
      createElement(
        'span',
        { className: classNames.title },
        t('historyImportSkippedTitle', { count: skipped.length })
      ),
      createElement('span', { className: classNames.title }, t('historyImportSkippedHint'))
    ),
    createElement(
      'ol',
      { className: classNames.list },
      ...skipped.map((entry, index) =>
        createElement(SkippedRow, {
          key: `${entry.sessionId}-${entry.messageId ?? 'session'}-${index}`,
          entry,
          t,
          classNames,
        })
      )
    )
  )
}

/**
 * 增量导入的结果明细（#390）：紧跟在「已导入 N 个会话」后面，用括号带出「新增 / 覆盖 / 跳过」。
 * 整包覆盖没有冲突概念（本地会话全被替换），保持原来那一句，不加多余的数字。
 */
export const importSummaryDetail = (
  summary: HistoryImportSummary
): { key: TranslationKey; params: TranslationParams } | undefined =>
  summary.mode === 'overwrite'
    ? undefined
    : {
        key: 'historyImportSummaryDetail',
        params: {
          added: summary.added,
          overwritten: summary.overwritten,
          skipped: summary.skipped,
        },
      }

/** 成功文案 + 可选的增量明细（#390）：`detail` 直接拼在主文案后面展示。 */
export type ImportedMessage = TranslationMessage & { detail?: TranslationMessage }

/**
 * 导入成功后的状态文案：有跳过时把数量一起说出来（「已导入 2 个会话，跳过 3 处损坏数据」），
 * 让人一眼知道这不是整包失败、也不是全都进来了；增量模式再补一段新增 / 覆盖 / 跳过的明细。
 */
export const importedMessage = (summary: HistoryImportSummary, skipped: number): ImportedMessage => {
  const count = summary.count
  const base: TranslationMessage =
    skipped > 0
      ? { key: 'historyImportedPartial', params: { count, skipped } }
      : { key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } }
  const detail = importSummaryDetail(summary)
  return detail === undefined ? base : { ...base, detail }
}

/** 拿不到摘要时的兜底（只有条数）：按整包覆盖展示，不编造新增 / 覆盖明细。 */
export const summaryFromCount = (count: number): HistoryImportSummary => ({
  mode: 'overwrite',
  count,
  added: count,
  overwritten: 0,
  skipped: 0,
  skippedTitles: [],
})
