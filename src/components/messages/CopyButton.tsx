import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCheckOutline16, IconCopyOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { saveText } from '../../services/exportText.js'

export const CopyButton = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <>
      <IconButton
        icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        tooltip={t('copy')}
        tooltipPlacement="bottom"
        onClick={async () => {
          if (copied) { return }
          const result = await copyText(text)
          if (result === 'too-large') { showToast({ key: 'copyTooLarge' }); return }
          if (result !== 'copied') { showToast({ key: 'copyFailed' }); return }
          setCopied(true)
          timerRef.current = setTimeout(() => setCopied(false), 1000)
        }}
      />
      <IconButton
        icon={<IconDownloadOutline16 />}
        tooltip={t('saveAsTxt')}
        tooltipPlacement="bottom"
        onClick={async () => {
          try {
            const result = await saveText({ filename: 'deepseek-export.txt', mimeType: 'text/plain', text })
            showToast({ key: result === 'saved' ? 'textSaved' : 'textSaveCancelled' })
          } catch { showToast({ key: 'textSaveFailed' }) }
        }}
      />
    </>
  )
}
