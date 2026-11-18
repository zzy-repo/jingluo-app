import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import { prefersReducedMotion } from '../../utils/usePresence.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  visible = true,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  /**
   * 是否处于打开状态。调用方要自己保留挂载（配合 usePresence）才能播完退出动画；
   * 默认为 true：直接挂载出来时只播进入动画。
   */
  visible?: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  // 挂载后同帧切到「打开」：先把「关闭态」真正算出来并落地，再切到打开态，
  // 首次出现才有淡入 / 滑入过渡，而不是瞬间跳出。
  const [entered, setEntered] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Portals live outside the app frame: follow the keyboard's visual viewport here too.
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    const viewport = window.visualViewport
    const update = () => {
      if (!overlay || (viewport && viewport.scale !== 1)) {
        return
      }
      const height = viewport?.height ?? window.innerHeight
      overlay.style.setProperty('--modal-viewport-height', `${height}px`)
      overlay.style.top = `${viewport?.offsetTop ?? 0}px`
      overlay.style.height = `${height}px`
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  useLayoutEffect(() => {
    if (prefersReducedMotion()) {
      setEntered(true)
      return
    }
    // 同步强制一次样式重算（读布局属性即 style+layout 落地），替代原来的双 rAF：
    // 双 rAF 只保证两次回调，主线程忙时中间那帧会被合并掉，
    // 元素第一次重算就已经带「打开态」→ transition 从未创建 → 一击到位（闪现）。
    const el = contentRef.current
    if (el) {
      void el.getBoundingClientRect().height
    }
    setEntered(true)
  }, [])
  const shown = entered && visible
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const token = {}
    openModals.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === token) {
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return createPortal(
    <div
      ref={overlayRef}
      className={styles.overlay}
      data-motion-state={shown ? 'open' : 'closed'}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={contentRef}
        className={clsx(styles.content, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-motion-state={shown ? 'open' : 'closed'}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
