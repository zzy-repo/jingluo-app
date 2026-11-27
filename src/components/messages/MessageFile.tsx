import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { describeSentImage, useUploads } from '../../services/attachments.js'
import { imagePartBytes, imagePartOf } from '../../services/attachments/imageSource.js'
import { loadFile } from '../../services/chat/db.js'
import type { FileAttachment } from '../../services/chat/types.js'
import { ImagePreview } from '../base/ImagePreview.js'
import { IconPhotoErrorFill20, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import styles from './MessageFile.module.css'

/** 原件从 IndexedDB 读出并生成本地地址；undefined 表示加载中，null 表示原件缺失。 */
const useFileUrl = (id: string) => {
  const [fileUrl, setFileUrl] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    loadFile(id).then((blob) => {
      if (!cancelled) {
        objectUrl = blob ? URL.createObjectURL(blob) : null
        setFileUrl({ id, url: objectUrl })
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [id])
  return fileUrl?.id === id ? fileUrl.url : undefined
}

/** 历史或失效附件的补传状态：只在还没有 serverId 时显示 */
const useUploadState = (file: FileAttachment) =>
  useUploads((state) => {
    if (file.serverId) {
      return null
    }
    const task = state.tasks[file.id]
    return task?.status === 'uploading' || task?.status === 'error' ? task : null
  })

/**
 * 消息里的附件：
 * - 图片：纯图片显示随屏宽自适应的缩略图（`min(120px, 27vw)`，390 宽约 105px、360 宽约 97px，
 *   见 MessageFile.module.css 的 #818 说明），与文件混排时为 64×64；点开走应用内预览
 *   （`base/ImagePreview.tsx`：全屏遮罩 + contain），不再是 `target="_blank"` 直接开原件。
 *   上传中显示 loading 蒙层，
 *   上传失败显示品牌色描边 + 中心重试图标（可重试）或 photo-error 图标（不可重试）。
 *   走 base64 内联通路的图（#552）在正常态额外标出**发出去的格式与体积**（例：`WEBP · 218 KB`），
 *   因为压缩后的字节和用户手上的原件不是一回事，这一点不能瞒着。
 * - 文件：显示文件卡片。
 */
export const MessageFile = ({
  file,
  onRetry,
}: {
  file: FileAttachment
  /** 本条消息补传失败且可重试时提供 */
  onRetry: (() => void) | null
}) => {
  const t = useTranslate()
  const url = useFileUrl(file.id)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  /** #818：点开大图走应用内预览层；`target="_blank"` 会把未缩放的原件丢给新页面/WebView */
  const [previewOpen, setPreviewOpen] = useState(false)
  const upload = useUploadState(file)
  /**
   * 这张图**真正发出去的形态**（#552）：编码产物在选图阶段就进了 `imageSource` 的缓存
   * （`drafts.prepareInline`），而消息是在发送前就挂上来的，所以这里同步查一次就能拿到。
   * 刷新页面 / 换设备后缓存里没有这条 → 不显示（缩略图照常，原件仍在 IndexedDB）：
   * 宁可不写，也不拿原件的体积冒充发出去的体积。
   */
  const sentPart = file.isImage ? imagePartOf(file.id) : undefined
  const sentLabel = sentPart
    ? describeSentImage(
        { mediaType: sentPart.mediaType, bytes: imagePartBytes(sentPart) },
        file.size
      )
    : null
  const uploading = upload?.status === 'uploading'
  const failed = upload?.status === 'error'
  const retryable = failed && upload.retryable
  const errorText = failed ? t(upload.error.key, upload.error.params) : undefined

  const retry = retryable ? onRetry : null

  if (file.isImage && url !== null) {
    const preview = url ? (
      failedUrl === url ? (
        <span className={styles.failedIcon} role="img" aria-label={file.name}>
          <IconPhotoErrorFill20 />
        </span>
      ) : (
        <img src={url} alt={file.name} onError={() => setFailedUrl(url)} />
      )
    ) : null

    // 上传中：本地原件已在 IndexedDB，先垫在蒙层下显示，避免只有一块灰色占位
    if (uploading) {
      return (
        <div className={clsx(styles.image, styles.imageThumb)} title={file.name}>
          {preview}
          <div className={styles.overlay}>
            <span className={styles.spinner} />
          </div>
        </div>
      )
    }

    // 「上传失败」只显示状态，其余原因写在图片底部的渐变上
    const reason =
      errorText && errorText !== t('uploadFileStatusFailed') ? (
        <span className={styles.reason}>{errorText}</span>
      ) : null

    // 上传失败不可重试：保留缩略图，底部渐变显示原因
    if (failed && !retry) {
      return (
        <div
          className={clsx(styles.image, styles.imageThumb)}
          title={errorText}
          aria-label={errorText}
        >
          {preview ?? (
            <span className={styles.failedIcon}>
              <IconPhotoErrorFill20 />
            </span>
          )}
          {reason}
        </div>
      )
    }

    // 上传失败可重试：缩略图 + 红色描边 + 蒙层重试图标，原因在底部
    if (failed && retry) {
      const retryLabel = t('uploadRetry', { message: errorText ?? t('uploadFileStatusFailed') })
      return (
        <Tooltip content={retryLabel}>
          <button
            type="button"
            className={clsx(styles.image, styles.imageThumb, styles.retryImage)}
            aria-label={retryLabel}
            onClick={retry}
          >
            {preview}
            <div className={clsx(styles.overlay, styles.retryOverlay)}>
              <IconRefreshOutline16 />
            </div>
            {reason}
          </button>
        </Tooltip>
      )
    }

    // 正常态：点开走应用内预览（#818）
    return url ? (
      <>
        <button
          type="button"
          className={clsx(styles.image, styles.imageThumb)}
          title={file.name}
          aria-label={t('imagePreviewOpen')}
          onClick={() => setPreviewOpen(true)}
        >
          {preview}
          {/* 压缩过的图发出去是 webp、字节也比原件小：底部渐变上写清楚，与失败原因同一套样式 */}
          {sentLabel ? <span className={styles.meta}>{sentLabel}</span> : null}
        </button>
        {previewOpen ? (
          <ImagePreview src={url} alt={file.name} onClose={() => setPreviewOpen(false)} />
        ) : null}
      </>
    ) : (
      // 原件还没加载出来（极短暂）
      <div className={styles.image} />
    )
  }

  return (
    <FileCard
      name={file.name}
      size={file.size}
      status={uploading ? 'uploading' : failed ? 'error' : 'done'}
      error={errorText}
      onRetry={retry ?? undefined}
      onOpen={url && !upload ? () => window.open(url, '_blank', 'noreferrer') : undefined}
    />
  )
}
