import clsx from 'clsx'
import { useUntrustedTranslate } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  // toast 的文案对象由调用方注入（`setCustomerMissingNotice` 那条链路来自服务端回包），
  // key 可能是别的版本留下的：用带校验的版本，缺 key 时上报 + 兜底，而不是整棵树被 ErrorBoundary 换掉（#314）
  const t = useUntrustedTranslate()
  const { id, message, action } = useToast()
  if (!message) {
    return null
  }
  /**
   * 动作按钮（#793）：与下面的外链同一个位置、同一套配色，但它是**应用内**动作
   * （点了切到「服务 Tab → 模型来源」），所以用 `<button>` 而不是 `<a href>` ——
   * 不做页面跳转，走 `openSettings('account')` 那条既有路径。
   */
  const actionButton =
    action === null ? null : (
      <button
        type="button"
        className={styles.action}
        data-testid="toast-action"
        onClick={() => {
          // 点了就收：同一条提示的按钮不该还能被点第二次（设置已经打开了）
          action.run()
          useToast.setState({ message: null, action: null })
        }}
      >
        {t(action.key)}
      </button>
    )
  if (typeof message === 'string') {
    return (
      <div key={id} className={styles.toast} role="status">
        {message}
        {actionButton}
      </div>
    )
  }
  const error = message.type === 'error'
  return (
    <div key={id} className={clsx(styles.toast, error && styles.error)} role="status">
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      <span className={styles.content}>
        {t(message.key, message.params)}
        {message.link ? (
          <a className={styles.link} href={message.link.href} target="_blank" rel="noreferrer">
            {t(message.link.key)}
          </a>
        ) : null}
      </span>
      {actionButton}
    </div>
  )
}
