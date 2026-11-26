import { useTranslate } from '../../i18n/index.js'
import { dismissDataLost, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'

/**
 * #909：启动时判定「本机库从有到无」后的横幅。它出现时欢迎页下面**不能**装作什么都没发生，
 * 所以横幅在 dataLost 非空期间一直在，直到用户确认（或恢复成功）。
 */
export const DataLostBanner = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const dataLost = useChatStore((state) => state.dataLost)
  if (dataLost === null) {
    return null
  }
  return (
    <div className={className} role="alert" data-testid="data-lost-banner">
      <span>
        <strong>{t('dataLostTitle', { count: dataLost.expectedSessions })}</strong> {t('dataLostNoSnapshot')}
      </span>
      <Button variant="outlined" size="s" onClick={() => void dismissDataLost()}>
        {t('dataLostDismiss')}
      </Button>
    </div>
  )
}
