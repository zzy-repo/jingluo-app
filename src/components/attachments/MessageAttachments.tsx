/**
 * #527 消息里的附件卡片（输入区那张卡片的只读版）。
 *
 * 消息只保存附件 id（`att-…`）的引用（#480 §6），正文与状态都在 `localPath` / manager 的
 * 记录里 —— 所以这里按 id 向 manager 取元信息后复用 `AttachmentCard`：
 *  - 不显示文档全文（§3.5），只显示文件名 / 大小 / 类型 / 状态 / 警告条数；
 *  - 记录已被清理（孤儿清扫、导入了别人的历史）时明说一句 `attachMissing`，不留空白格。
 */
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getAttachmentService } from './attachmentService.js'
import { AttachmentList } from './AttachmentCard.js'
import { toAttachmentView, type AttachmentView } from './viewModel.js'
import styles from './Attachments.module.css'

type Loaded = {
  key: string
  views: AttachmentView[]
  /** 记录找不到（被清理过 / 别人导出的历史）的条数 */
  missing: number
  /** 读元信息的入口没接线：此时一句「管理器未就绪」比空白格诚实 */
  unavailable: boolean
}

export const MessageAttachments = ({
  ids,
  className,
}: {
  /** 本条消息引用的附件 id 列表 */
  ids: string[]
  className?: string
}) => {
  const t = useTranslate()
  // 父组件每次渲染都会给一个新数组，依赖数组只能落在拼出来的字符串上，否则会无限重取
  const key = ids.join('|')
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    const wanted = key === '' ? [] : key.split('|')
    const service = getAttachmentService()
    if (service === null) {
      setLoaded({ key, views: [], missing: 0, unavailable: true })
      return
    }
    if (wanted.length === 0) {
      setLoaded({ key, views: [], missing: 0, unavailable: false })
      return
    }
    let cancelled = false
    const reads = wanted.map((id) =>
      service.getMeta(id).then(
        (meta) => meta,
        () => undefined
      )
    )
    void Promise.all(reads).then((metas) => {
      if (cancelled) {
        return
      }
      const views: AttachmentView[] = []
      let missing = 0
      for (const meta of metas) {
        if (meta === undefined) {
          missing += 1
        } else {
          views.push(toAttachmentView(meta))
        }
      }
      setLoaded({ key, views, missing, unavailable: false })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  if (ids.length === 0) {
    return null
  }

  const current = loaded !== null && loaded.key === key ? loaded : null
  if (current === null) {
    return (
      <div className={styles.loading} role="status" aria-label={t('attachLoading')}>
        <span className={styles.skeleton} />
      </div>
    )
  }

  return (
    <>
      <AttachmentList attachments={current.views} variant="message" className={className} />
      {current.unavailable ? <div className={styles.missing}>{t('attachUnavailable')}</div> : null}
      {current.missing === 0 ? null : <div className={styles.missing}>{t('attachMissing')}</div>}
    </>
  )
}
