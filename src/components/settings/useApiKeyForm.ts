import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { checkApiKeyBeforeSend, recordKeySuccess, setApiKey } from '../../services/api/apiConfig.js'
import { clearApiKeyFormatBlocked } from './settingsDialogState.js'
import { useTranslate, translateUntrusted } from '../../i18n/index.js'

/**
 * 输入 API Key 后**立即写入本地配置**（点「确定」/ 回车即落盘），再用当前配置的 GET /models
 * 校验；校验失败只提示错误，已保存的 Key 保留。
 */
export const useApiKeyForm = (
  /** 校验通过：收起输入框；校验失败：保持在编辑态，让错误提示与待修正的 Key 都看得见 */
  callbacks: { onSaved?: () => void; onFailed?: () => void } = {}
) => {
  const { onSaved, onFailed } = callbacks
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? // 持久化过的错误文案可能来自别的版本：未识别的 key 走上报 + 兜底。
                    // 这里是 render 体内求值，裸 `t(key)` 一旦缺 key 就会把整个设置页换成错误页（#314）
                    translateUntrusted(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    // 先落盘、再校验：本地持久化绝不能依赖网络结果。
    // 之前的顺序是先 await verifyApiKey 再 setApiKey，只要 GET /models 失败
    // （离线、上游宕机、CORS/明文 HTTP 被拦、把校验地址填错…），Key 就一个字都不会写进
    // localStorage，于是每次启动 ensureApiKey() 都判成「没配 Key」，设置页反复弹出、发送被拦。
    setApiKey(apiKey)
    // #451：只有新 Key 不再是「格式明显不对」那一条，才把发送前拦截留下的提示撤掉
    // （又贴了一把同样坏的 Key 的话，那句「这条消息没有发出去」仍然成立，不能撤）
    if (checkApiKeyBeforeSend() === 'ok') {
      clearApiKeyFormatBlocked()
    }
    setVerifying(true)
    setFailure(null)
    try {
      await verifyApiKey(apiKey)
      // #451：GET /models 成功 = 这把 Key 现在真的被上游认了，记一次「确认可用」
      // （「最近一次成功使用」的五个写入点之一，见 services/invite/keyIdentity.ts 文件头）
      recordKeySuccess(apiKey)
      // 校验通过：收起输入框（已保存的 Key 以掩码显示）
      setValue('')
      onSaved?.()
    } catch (e) {
      // 校验失败只提示，不回滚已保存的 Key，也不清空输入框，方便用户就地改正
      setFailure({ cause: e })
      onFailed?.()
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
