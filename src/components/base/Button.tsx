import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export const Button = ({
  variant = 'primary',
  size = 'l',
  block = false,
  className,
  testId,
  ...props
}: {
  variant?: 'primary' | 'outlined' | 'danger' | 'dangerOutlined'
  size?: 'l' | 'm' | 's'
  block?: boolean
  /**
   * 测试接缝（#608）：`.ts` 视图模型（`createElement`）里写不了 `data-testid` 的属性名习惯，
   * 各处一直传的是 `testId`。以前它只是个普通未知属性 → React 落到 DOM 上是 `testid`，
   * `getByTestId()`（认 `data-testid`）一个都取不到，于是「按钮在、断言却假红」。
   * 这里统一翻译成 `data-testid`：`.tsx` 里写 `data-testid`、`.ts` 里写 `testId`，两种都成立。
   */
  testId?: string
} & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className={clsx(styles.button, styles[variant], styles[size], block && styles.block, className)}
    data-testid={testId}
    {...props}
  />
)
