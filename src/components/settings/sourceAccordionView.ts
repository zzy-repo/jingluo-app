/**
 * 「模型来源」**单层手风琴**的视图（Issue #807）—— 真 zh 文案 + `createElement`，
 * 裸 Node 里能 `renderToStaticMarkup`（所以 `aria-expanded` / 行头状态 / 领取中 / 重试 /
 * 「确认使用」这些**用户真的会看到**的东西都能按 markup 断言，不是读源码猜）。
 *
 * ## 结构（一屏三行，没有子页、没有「返回」）
 *
 * ```
 * 内置服务        ✓ 当前使用   ⌃        ← 行头 = 按钮（aria-expanded + aria-controls）
 *   展开区：Key 由服务端下发的说明 / 领取失败原因 + 重试（**没有表单、没有 Key**）
 * 第三方服务      未配置        ⌄        ← 展开区：服务地址 / API Key / 模型 + 「确认使用」
 * DeepSeek 官方服务 未配置      ⌄        ← 展开区：地址固定 + 只填 API Key + 「确认使用」
 * ```
 *
 * ## 三条硬约定（都由本文件的结构保证）
 *
 *  1. **同一时间只展开一行**：`open` 是单个 `SourceRowKey | null`（`sourceAccordion.toggleAccordion`），
 *     这里只负责把 `aria-expanded` / `hidden` 如实翻出来；
 *  2. **打勾只绑生效来源**：`rowStatusOf()` 命中 `current` 的那一行才有 ✓，且它带
 *     `aria-label="当前使用中"` + `title`（不只靠图形，#807 第 4 条）；
 *  3. **内置服务没有表单**：这一行的展开区只有状态说明与「重试」，没有 Key 输入框 / 掩码展示 /
 *     复制入口 /「重新领取」按钮 —— 判别不是在这里写 `if`，而是这一行的字段清单本来就是空的
 *     （`sourceFieldPlan.sourceFieldRows('ours') === []`，#800 的结论不许退回）。
 *
 * 字段区（第三方 / 官方）由调用方注入（`panels`）：草稿的编辑与校验在 `ApiConfigFields` 的
 * 草稿形态里，本文件只负责「哪一行展开、展开区底部的『确认使用』、以及行内红字」。
 */
import { createElement, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { ProviderKind } from '../../services/api/providers.js'
import {
  rowIds,
  rowStatusOf,
  rowStatusTextKey,
  SOURCE_ROWS,
  SOURCE_ROW_LABEL_KEY,
  type DraftRowKey,
  type SourcePageState,
  type SourceRowKey,
} from './sourceAccordion.js'

export type SourceAccordionViewProps = {
  /** i18n 取词（与 `useTranslate()` 同签名；单测注入真 zh 表） */
  t: (key: TranslationKey, params?: TranslationParams) => string
  /** 页面状态机（`sourceAccordion.sourcePageReducer`） */
  state: SourcePageState
  /** 生效来源（`chat-demo:provider-kind`）—— **打勾只认它** */
  effectiveKind: ProviderKind
  /** 每一行自己那一份够不够用（`sourceAccordionRuntime.rowConfigured`） */
  configured: Record<SourceRowKey, boolean>
  /** 展开区里的字段（第三方 / 官方）：由界面注入草稿表单，本文件不碰输入控件 */
  panels: Partial<Record<DraftRowKey, ReactNode>>
  /** 内置服务展开区顶部那句说明（Key 从哪来 / 正在对齐 / 刚对齐完） */
  builtinNote?: ReactNode
  /** 点行头：只切换「正在查看」的那一行（内置服务那一行另外触发行内动作，由调用方决定） */
  onToggle: (row: SourceRowKey) => void
  /** 内置服务领取失败后的「重试」 */
  onRetry: () => void
  /** 展开区底部的「确认使用」（校验通过才生效） */
  onConfirm: (row: DraftRowKey) => void
  /** CSS Module 类名表 */
  styles: Record<string, string>
}

/**
 * 行头右侧的状态文字（✓ 当前使用 / 未配置 / 领取中…）。
 *
 * ✓ 是**带 `aria-label` 的独立节点**（`settings-source-current`）：读屏软件读到「当前使用中」，
 * 鼠标悬停有 tooltip，不靠一个纯图形让人猜。
 */
const statusNode = (
  props: Pick<SourceAccordionViewProps, 't' | 'state' | 'effectiveKind' | 'configured' | 'styles'>,
  row: SourceRowKey
): ReactNode => {
  const { t, styles } = props
  const status = rowStatusOf({
    row,
    effectiveKind: props.effectiveKind,
    configured: props.configured[row],
    claim: props.state.claim,
  })
  const current = status === 'current'
  return createElement(
    'span',
    {
      key: 'status',
      className: `${styles.sourceStatus} ${current ? styles.sourceStatusCurrent : ''}`.trim(),
      'data-testid': `settings-source-${row}-status`,
      'data-status': status,
    },
    current
      ? createElement(
          'span',
          {
            key: 'check',
            className: styles.sourceCheck,
            role: 'img',
            'aria-label': t('settingsSourceCurrentAria'),
            title: t('settingsSourceCurrentAria'),
            'data-testid': 'settings-source-current',
          },
          '✓'
        )
      : null,
    t(rowStatusTextKey(status))
  )
}

/** 展开区底部的「确认使用」（只有第三方 / 官方有；内置服务是行即动作，没有表单也就没有确认） */
const confirmNode = (
  props: Pick<SourceAccordionViewProps, 't' | 'styles' | 'onConfirm'>,
  row: DraftRowKey,
  error: { field: string; messageKey: TranslationKey } | null
): ReactNode[] => {
  const { t, styles } = props
  const nodes: ReactNode[] = []
  if (error !== null) {
    nodes.push(
      createElement(
        'div',
        {
          key: 'error',
          className: styles.sourceError,
          role: 'status',
          'data-testid': `settings-source-${row}-error`,
          'data-field': error.field,
        },
        t(error.messageKey)
      )
    )
  }
  nodes.push(
    createElement(
      'button',
      {
        key: 'confirm',
        type: 'button',
        className: styles.sourceConfirm,
        'data-testid': `settings-source-${row}-confirm`,
        onClick: () => props.onConfirm(row),
      },
      t('settingsSourceConfirm')
    )
  )
  return nodes
}

/** 内置服务展开区：说明 + （领取失败时）原因 + 「重试」。**结构上没有 Key 控件** */
const builtinPanelBody = (props: SourceAccordionViewProps): ReactNode[] => {
  const { t, state, styles } = props
  const nodes: ReactNode[] = []
  if (props.builtinNote !== undefined && props.builtinNote !== null) {
    nodes.push(createElement('div', { key: 'note' }, props.builtinNote))
  }
  if (state.claim.phase === 'need-login') {
    nodes.push(
      createElement(
        'div',
        { key: 'login', className: styles.sourceHint, 'data-testid': 'settings-source-builtin-login' },
        t('settingsSourceClaimNeedLogin')
      )
    )
  }
  if (state.claim.phase === 'claiming') {
    nodes.push(
      createElement(
        'div',
        { key: 'claiming', className: styles.sourceHint, role: 'status', 'data-testid': 'settings-source-builtin-claiming' },
        t('settingsSourceStatusClaiming')
      )
    )
  }
  if (state.claim.phase === 'failed') {
    nodes.push(
      createElement(
        'div',
        {
          key: 'failed',
          className: styles.sourceError,
          role: 'alert',
          'data-testid': 'settings-source-builtin-error',
        },
        t('settingsManagedKeyClaimFailed', { message: t(state.claim.messageKey) })
      ),
      createElement(
        'button',
        {
          key: 'retry',
          type: 'button',
          className: styles.sourceRetry,
          'data-testid': 'settings-source-builtin-retry',
          onClick: () => props.onRetry(),
        },
        t('settingsSourceRetry')
      )
    )
  }
  return nodes
}

/**
 * 手风琴本体。
 *
 * 行头是 `<button aria-expanded aria-controls>`（键盘可达、读屏可读）；
 * 展开区是 `role="region" aria-labelledby=行头`，收起时 `hidden` —— 只是不显示，
 * **草稿仍在**（输入框的值由 `draftValue()` 给，状态机收起时不动 `drafts`）。
 */
export const SourceAccordionView = (props: SourceAccordionViewProps): ReactNode => {
  const { t, state, styles } = props
  const groups: ReactNode[] = []
  for (const [index, row] of SOURCE_ROWS.entries()) {
    const { headerId, panelId } = rowIds(row)
    const expanded = state.open === row
    // 领取期间整行禁用：防重复领取（票面 ④）
    const disabled = row === 'builtin' && state.claim.phase === 'claiming'
    if (index > 0) {
      groups.push(createElement('div', { key: `${row}-divider`, className: styles.divider }))
    }
    const body: ReactNode[] =
      row === 'builtin'
        ? builtinPanelBody(props)
        : [
            createElement(
              'div',
              { key: 'fields', className: styles.sourceFields },
              props.panels[row as DraftRowKey] ?? null
            ),
            ...confirmNode(props, row as DraftRowKey, state.errors[row as DraftRowKey]),
          ]
    groups.push(
      createElement(
        'div',
        { key: `${row}-group`, className: styles.sourceGroup },
        createElement(
          'button',
          {
            type: 'button',
            id: headerId,
            className: `${styles.row} ${styles.sourceHeader}`,
            'aria-expanded': expanded,
            'aria-controls': panelId,
            disabled,
            'data-testid': `settings-source-${row}`,
            onClick: () => props.onToggle(row),
          },
          createElement(
            'span',
            { key: 'label', className: styles.rowMain },
            t(SOURCE_ROW_LABEL_KEY[row])
          ),
          statusNode(props, row),
          createElement('i', {
            key: 'chevron',
            className: `${styles.sourceChevron} ${expanded ? styles.sourceChevronOpen : ''}`.trim(),
            'aria-hidden': 'true',
            'data-testid': `settings-source-${row}-chevron`,
          })
        ),
        createElement(
          'div',
          {
            id: panelId,
            className: styles.sourcePanel,
            role: 'region',
            'aria-labelledby': headerId,
            hidden: !expanded,
            'data-testid': `settings-source-${row}-panel`,
          },
          ...body
        )
      )
    )
  }
  return createElement(
    'div',
    { className: styles.rows, 'data-testid': 'settings-source-accordion', 'data-open': state.open ?? '' },
    ...groups
  )
}
