import clsx from 'clsx'
import { useUntrustedTranslate } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  // toast 的文案对象由调用方注入（`setCustomerMissingNotice` 那条链路来自服务端回包），
  // key 可能是别的版本留下的：用带校验的版本，缺 key 时上报 + 兜底，而不是整棵树被 ErrorBoundary 换掉（#314）
  const t = useUntrustedTranslate()
  const { id, message } = useToast()
  if (!message) {
    return null
  }
  if (typeof message === 'string') {
    return (
      <div key={id} className={styles.toast} role="status">
        {message}
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
    </div>
  )
}
