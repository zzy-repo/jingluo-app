import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listBackups } from '../../services/backup/backupApi.js'
import { Button } from '../base/Button.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './Welcome.module.css'

/**
 * 疑似丢库的提示条（#993 任务 3）。
 *
 * 判定只有一条：**本机没有任何会话**（本组件只挂在欢迎页，而欢迎页在所有会话为空时才会渲染，
 * 见 `app/App.tsx` 的空态分支）+ **存在至少一份可用备份** → 提示「本机没有找到聊天记录，
 * 但检测到有可用备份」，给一个「去恢复」直接落到设置里的备份区域。
 *
 * 为什么必须挂在欢迎页：用户报的就是「打开应用一片空白、聊天记录没了」。备份做得再好，
 * 丢库时静默进欢迎页，用户根本找不到恢复入口。
 *
 * 为什么**没有备份时绝不显示**：新装用户第一次打开也是零会话，提示他「可能丢数据」是骚扰。
 * 所以「有可用备份」是这个提示条的**唯一开关**，读不到备份就当没有。
 */
export const BackupLostBanner = () => {
  const t = useTranslate()
  const [hasBackup, setHasBackup] = useState(false)

  useEffect(() => {
    let alive = true
    void listBackups()
      .then((items) => {
        if (alive) {
          setHasBackup(items.some((item) => item.checksumOk))
        }
      })
      .catch(() => {
        // 读不到就按「没有备份」处理：宁可少提示，也不打扰新装用户
      })
    return () => {
      alive = false
    }
  }, [])

  if (!hasBackup) {
    return null
  }

  return (
    <div className={styles.backupLost} role="status" data-testid="backup-lost-banner">
      <span className={styles.backupLostText}>{t('backupLostHint')}</span>
      <Button size="s" onClick={() => openSettings('data')}>
        {t('backupLostAction')}
      </Button>
    </div>
  )
}
