import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useState } from 'react'
import { waitSeconds, waitTierLine, type WaitHint } from '../../services/chat/waitStage.js'
import styles from './AssistantMessage.module.css'

/**
 * 首字等待提示的**叶子**组件（#328）。
 *
 * 「已等待 Ns」每秒变一次，但秒数**不进 store**：写 store 会让整棵消息列表每秒重渲染，
 * 这里让定时器只唤醒这一个叶子（1Hz 改文本），`waitHints` 只在阶段 / 分档变化时写一次。
 */

/** 只在本组件内跑的 1Hz 秒表：挂载即起、卸载即停 */
const useElapsedSeconds = (startedAt: number) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return waitSeconds(startedAt, now)
}

export const WaitNotice = memo(function WaitNotice({ hint }: { hint: WaitHint }) {
  const t = useTranslate()
  const seconds = useElapsedSeconds(hint.startedAt)
  const tierLine = waitTierLine(hint.stage, hint.tier)
  return (
    <>
      {/* 阶段名进读屏；秒数每秒变，标成 aria-hidden，避免读屏每秒播报一次 */}
      <span className={styles.waitingText} role="status" aria-live="polite">
        {t(hint.key, hint.params)}
      </span>
      <span className={styles.waitingElapsed} aria-hidden="true">
        · {t('waitElapsed', { seconds })}
      </span>
      {tierLine ? (
        <span className={styles.waitingTier} role="status" aria-live="polite">
          {t(tierLine)}
        </span>
      ) : null}
    </>
  )
})
