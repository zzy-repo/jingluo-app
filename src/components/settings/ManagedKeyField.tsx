import { useCallback, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { managedKeyTail } from '../../services/api/managedKey.js'
import { getManagedKeyVerdict, useApiConfig } from '../../services/api/apiConfig.js'
import { Button } from '../base/Button.js'
import { toPanelError } from '../consume/panels.js'
import { clearManagedKeyBlocked, useSettingsDialog } from './settingsDialogState.js'
import { claimManagedKeyForDevice } from './managedKeyRuntime.js'
import { ManagedKeyView } from './managedKeyView.js'
import styles from './Settings.module.css'

/**
 * 「我们的渠道」的 API Key 行（Issue #596 的容器部分）。
 *
 * 只做四件事：取判定、取尾号、把「重新领取」接到领取链路、把失败说清楚。
 * 展示结构全在 `managedKeyView.ts`（可被单测按真文案渲染），这里不写任何可见文案。
 *
 * 尾号取自 `getApiKey()` —— **就是发送时 `Authorization: Bearer` 里那一把**。
 * 不另存一份「显示用的尾号」：两份数据一旦分叉，就是 #596 第 1 条事故（界面 `···e8494c`、
 * 请求另一把）的复现路径。
 */
export const ManagedKeyField = () => {
  const t = useTranslate()
  // 订阅 apiKey：领取成功后尾号要**立刻**跟着变（这是 #596 验收里「界面立即显示新 Key 尾号」那一条）
  const apiKey = useApiConfig((state) => state.apiKey)
  const blocked = useSettingsDialog((state) => state.managedKeyBlocked)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const claim = useCallback(async () => {
    if (claiming) {
      return
    }
    setClaiming(true)
    setError(null)
    setNotice(null)
    try {
      const result = await claimManagedKeyForDevice({ rotate: true })
      if (!result.ok) {
        const panel = toPanelError(result.error)
        // 未登录时服务端只会回 401：把「去登录」这句话说在前面，而不是让用户对着一个
        // 「鉴权失败」自己猜（我们的渠道的 Key 挂在账号上，没账号就没有可领取的 Key）
        const reason = t(panel.i18nKey, panel.params)
        setError(
          t('settingsManagedKeyClaimFailed', {
            message: panel.needLogin ? `${reason} ${t('settingsManagedKeyNeedLogin')}` : reason,
          })
        )
        return
      }
      // 领取成功：发送前拦截留下的提示到此为止，并把新尾号说出来（与上面那一行同一个来源）
      clearManagedKeyBlocked()
      setNotice(t('settingsManagedKeyClaimed', { tail: managedKeyTail(result.data.key) }))
    } finally {
      setClaiming(false)
    }
  }, [claiming, t])

  return (
    <ManagedKeyView
      t={t}
      verdict={getManagedKeyVerdict()}
      // 尾号与「实际请求用的那把」同源：请求侧走 `getApiKey()`（localStorage），
      // 这里的 `apiKey` 就是同一个值的订阅视图（`setApiKey` 同时改存储与该 state）
      tail={managedKeyTail(apiKey)}
      blocked={blocked}
      claiming={claiming}
      error={error}
      notice={notice}
      onClaim={() => {
        void claim()
      }}
      Button={Button}
      styles={styles}
    />
  )
}
