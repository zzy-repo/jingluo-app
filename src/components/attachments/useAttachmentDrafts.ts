/**
 * #527 输入区附件的编排 hook。
 *
 * 边界：**状态机的权威在 `AttachmentManager`**（IndexedDB 记录 + 五态状态机 + 解析缓存去重），
 * 这个 hook 只做「按 manager 的公开签名调它 + 把结果摆成卡片要的样子」：
 *
 *  - `addFile` → `pending` 卡片落位，紧接着 `parse`；
 *  - `parse` 带 `onProgress` / `signal`，进度百分比来自 `{page,totalPages}`，取消就是 `abort()`；
 *  - `remove` 走 manager，卡片同步消失；
 *  - 卸载时只 `abort()` 正在进行的解析，**不删记录**（用户切会话再回来还能看到）。
 *
 * 删除消息 / 会话后的清理是另一条路径（`sweepOrphanAttachmentsAfterDelete`），不在卸载里做。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatSize } from '../../services/attachments.js'
import type { DocumentAttachment } from '../../services/attachments/types.js'
import type { LinkedMessage } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import {
  classifyAttachmentFiles,
  extensionOf,
  getAttachmentService,
  rejectReasonOf,
  sizeLimitOf,
  type AttachmentReject,
} from './attachmentService.js'
import { toAttachmentView, type AttachmentView } from './viewModel.js'

export type AttachmentInjectionInfo = {
  /** 注入时被截断、没发送出去的字符数 */
  truncatedCharacters?: number
  /** 注入侧的额外告警原文 */
  warnings?: string[]
}

export type UseAttachmentDrafts = {
  attachments: AttachmentView[]
  /** 选择/拖入入口：不合格的会逐条提示并拒绝，不静默过滤 */
  addFiles: (files: File[]) => void
  /** 取消正在进行的解析（`abort()` → parser 抛 abort → manager 落 failed，视图显示「已取消」） */
  cancel: (id: string) => void
  /** 重新解析（失败 / 取消后可用） */
  retry: (id: string) => void
  remove: (id: string) => void
  /** 发送后把注入侧的告警/截断回填到卡片上（没有就不调） */
  annotateInjection: (info: Record<string, AttachmentInjectionInfo>) => void
  /** 还有附件没就绪（解析中/等待中）时为 `true`，此时不允许发送依赖它的消息 */
  busy: boolean
  /**
   * 清空输入区列表（发送成功后调用）。
   *
   * 只清视图、abort 进行中的解析：manager 里的记录**不动** —— 消息已经引用了它们的 id，
   * 真正的回收是删除消息 / 会话后的 `sweepOrphanAttachmentsAfterDelete()`。
   */
  clear: () => void
}

/**
 * UI 侧兜底的那条失败原文：与 manager 的 `describeAttachmentError()` **同一条约定**
 * （`<码>: <人话>`，见 `services/attachments/manager.ts`）。
 *
 * 为什么这里也要认码（#574）：`service.parse()` 抛出来的不一定都是落库的 `failed` 记录
 * （`not-found` / 被取消 / 接线方直接 reject 一个 `PdfParseError`），那条路径不经过 manager
 * 的 `describeError`，只留 `error.message` 同样会把码丢掉，面板就退回「未知问题」。
 *
 * 这里**不 import** `parsers/pdf.ts`：那会把 pdfjs 拖进输入区这个热点模块，
 * 只按鸭子类型认 `code`（`PdfParseError` 的 `code` 是必填 string）。
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const detail = error.message === '' ? error.name : error.message
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? `${code}: ${detail}` : detail
  }
  return String(error)
}

const rejectionToast = (item: AttachmentReject, maxFiles?: number): LinkedMessage => {
  const name = item.file.name
  if (item.reason === 'unsupported-format') {
    return { key: 'attachPickUnsupported', params: { name } }
  }
  if (item.reason === 'empty-file') {
    return { key: 'attachPickEmpty', params: { name } }
  }
  if (item.reason === 'too-large') {
    return {
      key: 'attachPickTooLarge',
      params: {
        name,
        size: formatSize(item.file.size),
        limit: formatSize(item.limitBytes === undefined ? item.file.size : item.limitBytes),
      },
    }
  }
  return {
    key: 'attachPickTooMany',
    params: { limit: maxFiles === undefined ? 0 : maxFiles, count: 1 },
  }
}

/** manager.addFile() 抛出的 `AttachmentError` → 一句人话 */
const addFailureToast = (file: File, error: unknown): LinkedMessage => {
  const reason = rejectReasonOf(error)
  if (reason === 'unsupported-format') {
    return { key: 'attachPickUnsupported', params: { name: file.name } }
  }
  if (reason === 'empty-file') {
    return { key: 'attachPickEmpty', params: { name: file.name } }
  }
  if (reason === 'too-large') {
    const limit = sizeLimitOf(file.name)
    return {
      key: 'attachPickTooLarge',
      params: {
        name: file.name,
        size: formatSize(file.size),
        limit: formatSize(limit === undefined ? file.size : limit),
      },
    }
  }
  if (reason === 'mime-mismatch') {
    return { key: 'attachFailMimeMismatch' }
  }
  return { key: 'attachUnavailable' }
}

export const useAttachmentDrafts = (options?: {
  /** 单条消息的附件数量上限（来自 `ATTACHMENT_LIMITS.maxFilesPerMessage`，缺省不限） */
  maxFiles?: number
  /**
   * 挂载时先把这些 id 的元信息读回来铺成卡片。
   *
   * 输入区的文档草稿与其他草稿一样存在 `chat/drafts.ts` 里，切换会话会把本 hook 的状态
   * （随 `Input` 的 key 重挂载）丢掉；不还原的话「草稿里还挂着引用、界面上却一张卡都没有」，
   * 用户会以为附件没带上。只在首次渲染读一次（`restoreIds` 之后的更新由 `addFiles` 负责）。
   */
  restoreIds?: string[]
}): UseAttachmentDrafts => {
  const maxFiles = options?.maxFiles
  const [attachments, setAttachments] = useState<AttachmentView[]>([])
  /** 正在进行的解析：`remove` / 卸载时用它 abort，避免解析结果落到已经消失的卡片上 */
  const controllers = useRef(new Map<string, AbortController>())
  /** 数量上限判断要的是「此刻的列表长度」，不能读渲染时闭包里的旧值 */
  const countRef = useRef(0)
  countRef.current = attachments.length
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    const running = controllers.current
    return () => {
      aliveRef.current = false
      running.forEach((controller) => controller.abort())
      running.clear()
    }
  }, [])

  /** 首次渲染时把草稿里已有的文档引用读回卡片（见 `restoreIds` 说明） */
  useEffect(() => {
    const ids = options?.restoreIds ?? []
    const service = getAttachmentService()
    if (service === null || ids.length === 0) {
      return
    }
    let cancelled = false
    void Promise.all(
      ids.map((id) =>
        service.getMeta(id).then(
          (meta) => meta,
          () => undefined
        )
      )
    ).then((metas) => {
      if (cancelled || !aliveRef.current) {
        return
      }
      const views = metas
        .filter((meta): meta is DocumentAttachment => meta !== undefined)
        .map((meta) => toAttachmentView(meta))
      if (views.length > 0) {
        setAttachments(views)
      }
    })
    return () => {
      cancelled = true
    }
    // 只在挂载时跑一次：之后列表由 addFiles / remove / retry 维护
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = useCallback((id: string, change: (view: AttachmentView) => AttachmentView) => {
    if (!aliveRef.current) {
      return
    }
    setAttachments((items) => items.map((item) => (item.id === id ? change(item) : item)))
  }, [])

  const startParse = useCallback(
    (id: string) => {
      const service = getAttachmentService()
      if (service === null) {
        return
      }
      // 同一条附件重复点「重新解析」时，先把上一轮 abort 掉，避免两份进度抢同一张卡
      const previous = controllers.current.get(id)
      if (previous !== undefined) {
        previous.abort()
      }
      const controller = new AbortController()
      controllers.current.set(id, controller)
      update(id, (view) => ({ ...view, status: 'parsing', progress: { stage: 'validate' } }))
      service
        .parse(id, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (controller.signal.aborted) {
              return
            }
            update(id, (view) => (view.status === 'parsing' ? { ...view, progress } : view))
          },
        })
        .then(
          (record) => {
            update(id, () =>
              controller.signal.aborted
                ? { ...toAttachmentView(record), status: 'cancelled', progress: null }
                : toAttachmentView(record)
            )
          },
          (error: unknown) => {
            const cancelled = controller.signal.aborted
            update(id, (view) => ({
              ...view,
              status: cancelled ? 'cancelled' : 'failed',
              progress: null,
              errorMessage: cancelled ? view.errorMessage : describeError(error),
            }))
          }
        )
        .then(() => {
          if (controllers.current.get(id) === controller) {
            controllers.current.delete(id)
          }
        })
    },
    [update]
  )

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return
      }
      const service = getAttachmentService()
      if (service === null) {
        // 没接线时**明说**：静默什么都不发生，用户会以为点了没反应
        showToast({ key: 'attachUnavailable' })
        return
      }
      const result = classifyAttachmentFiles(files, { limit: maxFiles, existing: countRef.current })
      let tooMany = 0
      for (const item of result.rejected) {
        if (item.reason === 'too-many') {
          tooMany += 1
          continue
        }
        showToast(rejectionToast(item, maxFiles))
      }
      if (tooMany > 0) {
        showToast({
          key: 'attachPickTooMany',
          params: { limit: maxFiles === undefined ? tooMany : maxFiles, count: tooMany },
        })
      }
      if (result.accepted.length === 0) {
        return
      }
      void (async () => {
        for (const file of result.accepted) {
          let record: DocumentAttachment
          try {
            record = await service.addFile(file)
          } catch (error) {
            showToast(addFailureToast(file, error))
            continue
          }
          const view = toAttachmentView(record, { status: 'pending' })
          if (!aliveRef.current) {
            return
          }
          setAttachments((items) => [...items, view])
          startParse(record.id)
        }
      })()
    },
    [maxFiles, startParse]
  )

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id)
      if (controller === undefined) {
        return
      }
      // 视图立刻转「已取消」：abort 之后 manager 还会落一次 failed 记录，不该让用户先看到红色
      controller.abort()
      update(id, (view) => ({ ...view, status: 'cancelled', progress: null }))
    },
    [update]
  )

  const retry = useCallback(
    (id: string) => {
      startParse(id)
    },
    [startParse]
  )

  const remove = useCallback((id: string) => {
    const service = getAttachmentService()
    const controller = controllers.current.get(id)
    if (controller !== undefined) {
      controller.abort()
      controllers.current.delete(id)
    }
    setAttachments((items) => items.filter((item) => item.id !== id))
    if (service === null) {
      return
    }
    void service.remove(id).catch(() => {
      showToast({ key: 'attachRemoveFailed' })
    })
  }, [])

  const annotateInjection = useCallback((info: Record<string, AttachmentInjectionInfo>) => {
    setAttachments((items) =>
      items.map((item) => {
        const extra = info[item.id]
        if (extra === undefined) {
          return item
        }
        const next: AttachmentView = {
          ...item,
          injectionWarnings:
            extra.warnings === undefined ? item.injectionWarnings : [...extra.warnings],
        }
        if (extra.truncatedCharacters !== undefined) {
          next.truncatedCharacters = extra.truncatedCharacters
        }
        return next
      })
    )
  }, [])

  const clear = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort())
    controllers.current.clear()
    setAttachments([])
  }, [])

  const busy = attachments.some((item) => item.status === 'pending' || item.status === 'parsing')

  return { attachments, addFiles, cancel, retry, remove, annotateInjection, busy, clear }
}

/** 供调试/上报用：`PDF 2.4 MB` 这类一行摘要（不含正文，符合 §3.5） */
export const summarizeAttachment = (view: AttachmentView): string =>
  `${extensionOf(view.filename)} ${formatSize(view.size)} ${view.status}`
