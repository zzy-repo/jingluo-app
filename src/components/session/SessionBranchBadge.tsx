/**
 * #831 会话级分支的**来源徽标**（会话列表项与会话详情共用同一个）。
 *
 * 渲染逻辑全在 `sessionBranchView.ts`（纯 `.ts`，裸 Node 用例直接用 `renderToStaticMarkup`
 * 真渲染两态文案）；这里只做两件 `.tsx` 才做得到的事：
 * 1. 取当前语言的 `t`；
 * 2. 把 CSS Module 的类名与真 SVG 图标传进去。
 *
 * 两态口径（`sessionBranch.ts::branchBadgeState`）：
 *  - `branch`：`分支` —— tooltip 写清「分支自「父会话标题」」，给了 `onOpenParent` 时可点跳回父会话；
 *  - `source-missing`：`来源已不在本机` —— 父会话被删 / 包导到了另一台设备（#831 第 7 条），
 *    **不报错、也不假装父会话还在**，所以是不可点的虚线徽标。
 */
import { useTranslate } from '../../i18n/index.js'
import type { SessionBranchOrigin } from '../../services/chat/types.js'
import { IconBranchOutline16 } from '../base/icons.js'
import { SessionBranchBadgeView } from './sessionBranchView.js'
import styles from './SessionBranch.module.css'

export const SessionBranchBadge = ({
  origin,
  parentTitle,
  onOpenParent,
}: {
  /** 分支来源；缺省 = 这条会话不是分支出来的，整个组件不渲染 */
  origin?: SessionBranchOrigin
  /** 父会话标题；`null` = 父会话不在本机（降级态） */
  parentTitle: string | null
  /** 给了就把它画成可点的按钮（详情页「回到来源会话」）；不给就是纯标签 */
  onOpenParent?: (sessionId: string) => void
}) => {
  const t = useTranslate()
  return SessionBranchBadgeView({
    origin,
    parentTitle,
    onOpenParent,
    t,
    icon: IconBranchOutline16(),
    classNames: {
      badge: styles.badge,
      badgeMissing: styles.badgeMissing,
      badgeIcon: styles.badgeIcon,
      badgeText: styles.badgeText,
      badgeButton: styles.badgeButton,
    },
  })
}
