/**
 * #831 会话级分支的**纯展示层**（`createElement`，不 import CSS、不问 store / 库）。
 *
 * 为什么单独一层而不是直接写 JSX：这两个小件的验收证据是「文案对了没有」——
 * 「分支 / 来源已不在本机」「附件不可用」。用例要在裸 Node 里用 `renderToStaticMarkup`
 * 真渲染一遍（同 `components/settings/importSkipped.ts` 的做法），而裸 Node 只吃 `.ts`、
 * 不吃 `.tsx`。所以渲染逻辑放在这里，`.tsx` 只做两件事：取当前语言的 `t`、把 CSS Module
 * 的类名传进来。样式与判定口径都只有一份实现（`check:dup-impl` 最爱抓这种双份）。
 */
import { createElement, type ReactNode } from 'react'
import {
  branchBadgeState,
  type BranchBadgeState,
} from '../../services/chat/sessionBranch.js'
import type { SessionBranchOrigin } from '../../services/chat/types.js'
import type { Translate } from '../settings/importSkipped.js'

export type BranchClassNames = {
  badge?: string
  badgeMissing?: string
  badgeIcon?: string
  badgeText?: string
  badgeButton?: string
  notice?: string
  noticeIcon?: string
}

const cx = (...values: (string | false | undefined)[]): string | undefined => {
  const parts = values.filter((value): value is string => typeof value === 'string' && value !== '')
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** 徽标的主体（span）：正常态实心、降级态虚线，文案两态各不相同。 */
const badgeOf = ({
  state,
  label,
  description,
  classNames,
  icon,
}: {
  state: BranchBadgeState
  label: string
  /** tooltip：正常态写明「分支自「父会话标题」」，用户不点也能看出这条会话从哪来 */
  description: string
  classNames: BranchClassNames
  /** 图标槽：`.tsx` 包装层传真 SVG；裸 Node 渲染时退化成文本符号（用例只断言文案） */
  icon: ReactNode
}): ReactNode => {
  const missing = state === 'source-missing'
  return createElement(
    'span',
    {
      className: cx(classNames.badge, missing && classNames.badgeMissing),
      'data-testid': 'session-branch-badge',
      'data-branch-state': state,
      title: description,
    },
    createElement('span', { className: classNames.badgeIcon, 'aria-hidden': 'true' }, icon),
    createElement('span', { className: classNames.badgeText }, label)
  )
}

/**
 * 来源徽标。
 * - `parentTitle === null` → 降级「来源已不在本机」（不可点：没有跳转目标）；
 * - 给了 `onOpenParent` 且父会话在 → 画成可点的按钮（详情页「回到来源会话」）；
 * - `origin` 缺省（不是分支会话）→ 什么都不渲染。
 */
export const SessionBranchBadgeView = ({
  origin,
  parentTitle,
  onOpenParent,
  t,
  classNames = {},
  icon = '⑂',
}: {
  origin?: SessionBranchOrigin
  parentTitle: string | null
  onOpenParent?: (sessionId: string) => void
  t: Translate
  classNames?: BranchClassNames
  /** 图标槽：真 SVG 由 `.tsx` 包装层传；裸 Node 渲染时是文本符号 */
  icon?: ReactNode
}): ReactNode => {
  if (origin === undefined) {
    return null
  }
  const state = branchBadgeState(origin, parentTitle !== null)
  if (state === null) {
    return null
  }
  const missing = state === 'source-missing'
  const label = missing ? t('sessionBranchSourceMissing') : t('sessionBranchBadge')
  const description = missing
    ? t('sessionBranchSourceMissing')
    : t('sessionBranchBadgeFrom', { title: parentTitle === null ? '' : parentTitle })
  const badge = badgeOf({ state, label, description, classNames, icon })
  if (state === 'source-missing' || onOpenParent === undefined) {
    return badge
  }
  return createElement(
    'button',
    {
      type: 'button',
      className: classNames.badgeButton,
      'data-testid': 'session-branch-open-parent',
      title: t('sessionBranchOpenParent'),
      'aria-label': t('sessionBranchOpenParent'),
      onClick: (event: { stopPropagation: () => void }) => {
        // 徽标嵌在会话列表项 / 详情标题里：点击不能穿透成「打开这条分支会话」
        event.stopPropagation()
        onOpenParent(origin.sessionId)
      },
    },
    badge
  )
}

/** 附件降级提示：`missing <= 0` 时什么都不渲染（没坏消息就不占一行）。 */
export const BranchAttachmentNoticeView = ({
  missing,
  t,
  classNames = {},
  icon = '!',
}: {
  missing: number
  t: Translate
  classNames?: BranchClassNames
  icon?: ReactNode
}): ReactNode => {
  if (missing <= 0) {
    return null
  }
  return createElement(
    'div',
    {
      className: classNames.notice,
      'data-testid': 'session-branch-attachment-missing',
      role: 'status',
    },
    createElement('span', { className: classNames.noticeIcon, 'aria-hidden': 'true' }, icon),
    createElement('span', null, t('sessionBranchAttachmentMissing', { count: missing }))
  )
}
