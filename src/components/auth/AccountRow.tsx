/**
 * 设置页里的「账号」一行（W1-B 后半，Issue #487）—— 当前登录的邮箱 + 退出登录。
 *
 * 为什么单独一个组件而不是塞进 `SettingsDialog`：设置弹窗已经 1500 行，再说「账号」这块
 * 是身份层（`services/auth`）的唯一界面出口 —— 放在 `components/auth/` 下，W1-C 做
 * 「账户与消费」页时可以整块搬走，不用从设置里再抠一遍。
 *
 * 退出登录的口径（#484 §二）：**先让服务端把会话全作废，再清本地**（顺序在 store 里，
 * 见 `signOut`）。这里只负责两件事：
 *  1. 破坏性操作要两下：第一次点变成「确定退出 / 取消」，第二次才真退（与「更换 Key」同一套交互）；
 *  2. 退完之后把设置弹窗一起关掉 —— 登录墙会立刻把界面切成登录页，留一个设置弹窗
 *     浮在登录页上既没用也挡视线。
 *
 * 没登录（`state !== 'authenticated'`）时整行不渲染：登录墙上不可能出现，但设置默认值
 * 之外的场景（测试、将来免登录入口）不该看到一个没有意义的「退出登录」。
 */

import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useAuthStore } from '../../services/auth/store.js'
import { Button } from '../base/Button.js'
import { closeSettings } from '../settings/settingsDialogState.js'
import styles from '../settings/Settings.module.css'

export const AccountRow = () => {
  const t = useTranslate()
  const state = useAuthStore((s) => s.state)
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (state !== 'authenticated') {
    return null
  }

  const confirmSignOut = () => {
    setBusy(true)
    void signOut().then(() => {
      setBusy(false)
      setConfirming(false)
      closeSettings()
    })
  }

  return (
    <div className={clsx(styles.cell, styles.row)} data-testid="account-row">
      <div className={styles.text}>
        <div className={styles.label}>{t('sub2authAccount')}</div>
        <div className={styles.description} data-testid="account-email">
          {user?.email ?? '—'}
        </div>
      </div>
      <div className={styles.cellActions}>
        {confirming ? (
          <>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={busy}
              data-testid="account-signout-cancel"
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="m"
              className={styles.cellButton}
              disabled={busy}
              aria-busy={busy}
              data-testid="account-signout-confirm"
              onClick={confirmSignOut}
            >
              {t('sub2authLogout')}
            </Button>
          </>
        ) : (
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            data-testid="account-signout"
            onClick={() => setConfirming(true)}
          >
            {t('sub2authLogout')}
          </Button>
        )}
      </div>
    </div>
  )
}
