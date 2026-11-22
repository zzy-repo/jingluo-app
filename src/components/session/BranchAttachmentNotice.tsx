/**
 * #831 会话级分支的**附件降级提示**（第 6 条：父会话被删除 / 换设备导入后，分支侧显示
 * 「附件不可用」，**绝不许报错**）。
 *
 * 两件事分在两个文件里，别合并：
 *  - 文案渲染在 `sessionBranchView.ts::BranchAttachmentNoticeView`（纯 `.ts`，markup 用例直接断言）；
 *  - 接线（逐个问「这个附件本机还在不在」）在这里，因为要读库、要 React 副作用。
 *
 * 判「附件在不在」而不是判「父会话在不在」：附件是按 **id 引用**共享的（不复制本体）。
 * 父会话删掉时，只要分支还引用着同一批附件，它们依旧「有人引用」（孤儿清扫按引用计数），
 * 分支照常能看能发 —— 这正是不复制的好结果。真正会丢的是原件本来就不在本机：
 * 换设备导入、存储被系统清理、父会话删除后原件被外部清掉。那时这里降级成一句话，
 * 会话照常能打开、能继续聊（`unavailableAttachmentIds()` 对读库异常一律按「不可用」处理）。
 */
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { attachmentAvailable } from '../../services/chat/branchAttachments.js'
import { attachmentRefsOf, unavailableAttachmentIds } from '../../services/chat/sessionBranch.js'
import type { Session } from '../../services/chat/types.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { BranchAttachmentNoticeView } from './sessionBranchView.js'
import styles from './SessionBranch.module.css'

/** 纯展示：`missing === 0` 时什么都不渲染（没有坏消息时不该占一行）。 */
export const BranchAttachmentNotice = ({ missing }: { missing: number }) => {
  const t = useTranslate()
  return BranchAttachmentNoticeView({
    missing,
    t,
    icon: IconWarningOutline16(),
    classNames: { notice: styles.attachmentNotice, noticeIcon: styles.attachmentNoticeIcon },
  })
}

/**
 * 接线层：只在**分支会话**里跑（普通会话的缺件由每条消息自己的附件卡说明，
 * 不在这里再报一遍，否则同一条事实会有两处口径）。
 */
export const SessionBranchAttachments = ({ session }: { session: Session }) => {
  // 依赖落在「引用了哪些 id」的字符串上：父组件每次渲染都会给一个新数组，直接当依赖会无限重取
  const ids = attachmentRefsOf(session)
  const key = ids.join('|')
  const [missing, setMissing] = useState(0)
  useEffect(() => {
    const wanted = key === '' ? [] : key.split('|')
    let cancelled = false
    // `unavailableAttachmentIds()` 内部吞掉一切异常：读库失败 = 不可用，不会把会话页炸掉
    void unavailableAttachmentIds(wanted, attachmentAvailable).then((list) => {
      if (!cancelled) {
        setMissing(list.length)
      }
    })
    return () => {
      cancelled = true
    }
  }, [key])
  return <BranchAttachmentNotice missing={missing} />
}
