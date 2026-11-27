import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listBackups } from '../../services/backup/backupApi.js'
import { useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './Welcome.module.css'

/**
 * 疑似丢库的提示条（#993 任务 3）。
 *
 * 判定两条**都要成立**：**本机会话数为 0**（直接读 `useChatStore`，见下方 `sessionCount`）+
 * **存在至少一份可用备份** → 提示「本机没有找到聊天记录，但检测到有可用备份」，给一个「去恢复」
 * 直接落到设置里的备份区域。
 *
 * ⚠️ 曾经只判「有备份」：当时误以为欢迎页只在零会话时渲染。实际上欢迎页是**落地页** ——
 * 冷启动、点「开启新对话」都会渲染它，于是有历史、有备份的用户每次打开都会看到这条"疑似丢库"
 * 提示（实测踩到）。所以**会话数必须自己判**，不能依赖宿主页面的渲染条件。
 *
 * 为什么必须挂在欢迎页：用户报的就是「打开应用一片空白、聊天记录没了」。备份做得再好，
 * 丢库时静默进欢迎页，用户根本找不到恢复入口。
 *
 * 为什么**没有备份时绝不显示**：新装用户第一次打开也是零会话，提示他「可能丢数据」是骚扰。
 * 所以「有可用备份」是这个提示条的**唯一开关**，读不到备份就当没有。
 */
export const BackupLostBanner = () => {
  const t = useTranslate()
  const ready = useChatStore((state) => state.ready)
  const sessionCount = useChatStore((state) => state.sessions.length)
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

  if (!ready || sessionCount > 0 || !hasBackup) {
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
