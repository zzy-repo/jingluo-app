import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from './IconButton.js'
import { IconCloseOutline16 } from './icons.js'
import styles from './ImagePreview.module.css'

/**
 * #209 口径：**能力靠探测，不靠假设**。这里探测的是「内核认不认 `object-fit`」——
 * 造一个游离元素把声明写进去再读回来（声明被丢弃时读回空串），
 * 而不是用 `CSS.supports()` 或「Chromium 32 就支持」这类推理当结论
 * （`CSS.supports` 在 flex `gap` 上就骗过人，见 #173）。
 *
 * 注意：本组件**不把正确性押在这条声明上** —— 图片的适配由 `max-width/max-height: 100%` + `auto`
 * 尺寸决定（老内核也认），`object-fit: contain` 只是双保险。探测结果写到遮罩层的
 * `data-object-fit` 上供取证（见 tests/unit/image-sizing-818.test.mjs 与 docs/ui/818-image-sizing/），
 * 并在不支持时显式落到 `.imageNoFit` 那套纯尺寸方案。
 */
const detectObjectFit = (): boolean => {
  if (typeof document === 'undefined') {
    return false
  }
  const probe = document.createElement('div')
  probe.style.objectFit = 'contain'
  return probe.style.objectFit === 'contain'
}

/**
 * #818：应用内的图片预览层（全屏遮罩 + `object-fit: contain` 等比缩放）。
 *
 * 为什么要有它：消息里的图片原来是 `<a href={url} target="_blank">`（见 MessageFile.tsx），
 * 点开直接在新页面打开**原件**。实测（Playwright Chromium，390×844 / 360×740，
 * 长边 4000px 的图）：新页面的文档宽度等于原图像素宽（3000px），即**未缩放的原始像素**，
 * 屏幕只有 360 宽时要横向滚动才能看全 —— 这就是「图片显示过大、没适配屏幕」的实际来源；
 * 在 WebView 里还会跑到应用外面（回退栈、状态栏、下载行为都不受控）。
 *
 * 这里只做一件事：遮罩 + 一张等比缩进视口内的图，点击遮罩任意处或按 Esc 关闭。
 * 不依赖任何「应该支持」的能力：不调 `requestFullscreen`（没有全屏 API 也照样是 fixed 遮罩），
 * 不用 `:has()` / `aspect-ratio` / `dvh`，图片适配只靠 `max-width/max-height` + `auto`。
 * 不复用 `base/Modal.tsx`：那是有标题栏、有 footer、内容区固定 380px 的**卡片**弹窗，
 * 塞一张图要靠 className 覆写掉它的宽度/内边距/背景/阴影，反而比一个新组件更难读
 * （当初 grep `Lightbox|ImagePreview|preview` 也没有现成的图片预览组件）。
 */
export const ImagePreview = ({
  src,
  /** 同时作为 `<img alt>` 与对话框的无障碍名称（消息附件的文件名） */
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) => {
  const t = useTranslate()
  // 探测只做一次：整个会话里内核不会变
  const [objectFit] = useState(detectObjectFit)
  // 捕获阶段的监听挂在 document 上，回调用 ref 取最新的一次，避免重新挂载监听
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      // 捕获阶段先吃掉：消息就地编辑态的 Esc 是「退出编辑」（UserMessage.tsx），
      // 预览开着时应当先关预览，而不是把下面的输入框关掉。
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return createPortal(
    // 点击遮罩任意处关闭（图片自己也是遮罩的子节点，点图同样关）：手机上最省手势，
    // 右上角的关闭按钮是明确的可见入口，Esc 给键盘 / 桌面。
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-testid="image-preview"
      data-object-fit={objectFit ? 'contain' : 'unsupported'}
      onClick={onClose}
    >
      <img className={objectFit ? styles.image : styles.imageNoFit} src={src} alt={alt} />
      {/* 复用 IconButton：键盘焦点环 / 按压反馈都由它提供（含 #215 的低内核焦点兜底），
          这里只把颜色换成深色遮罩上的白 —— tone 都是给浅色底准备的 */}
      <IconButton
        className={styles.close}
        size="xl"
        icon={<IconCloseOutline16 />}
        tooltip={t('close')}
        onClick={onClose}
      />
    </div>,
    document.body
  )
}
