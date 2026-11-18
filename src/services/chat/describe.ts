import { isTranslationKey, translate } from '../../i18n/index.js'
import { classifyStatus, isContextLimitMessage } from '../api/errors.js'
import type { AssistantMessage } from './types.js'

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /** 需要用户处理的问题附带的操作 */
  action?: 'apiKey' | 'topUp'
}

const getTemplateText = (reply: AssistantMessage) =>
  reply.blocks
    .map((block) => (block.type === 'text' && block.isTemplate ? block.text : ''))
    .join('')

/**
 * 上游报错原文是否可以直接给用户看：中文/日文/韩文是上游自己写给人看的话，
 * 英文（或无法判断的符号串）多半是内部错误，界面上换成 i18n 兜底文案，原文只留在日志里。
 */
const isReadableForUser = (text: string) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)

/** 回复出错或未正常结束时展示的提示 */
export const describeReply = (reply: AssistantMessage): Notice | null => {
  if (reply.status === 'error' && reply.error) {
    const { kind, status, localMessage } = reply.error
    // 导入的历史可能来自不同版本；不识别的文案沿用保存时的原文。
    const localized =
      localMessage && isTranslationKey(localMessage.key)
        ? translate(localMessage.key, localMessage.params)
        : ''
    const message = localized || reply.error.message
    // 历史补传错误刷新后仍需说明原因，恢复沿用附件卡片或重新生成。
    if (kind === 'upload') {
      return { text: message || translate('uploadFileStatusFailed') }
    }
    // 流断在 message_stop 之前：明说连接中断（已收到的内容照常展示），不要混进「网络异常」
    if (kind === 'interrupted') {
      return { text: localized || translate('replyStreamInterrupted') }
    }
    if (kind === 'network') {
      return { text: translate('commonNetworkErrorToast') }
    }
    // 上游说「上下文太长」（#122）：这不是重试能解决的，给能照着做的建议
    if (status === 413 || isContextLimitMessage(message)) {
      return { text: localized || translate('replyContextLimit') }
    }
    switch (classifyStatus(status)) {
      case 'unauthorized':
        return { text: translate('replyInvalidApiKey'), action: 'apiKey' }
      case 'insufficientBalance':
        return { text: translate('replyInsufficientBalance'), action: 'topUp' }
      case 'rateLimited':
        return { text: translate('replyRateLimited') }
      case 'serverBusy':
        return { text: translate('completionServerBusyToast') }
      default:
        // 未识别的错误：可读的中文原文照常展示，其余一律走 i18n 兜底，不把英文原文丢给用户。
        if (localized) {
          return { text: localized }
        }
        return { text: isReadableForUser(message) ? message : translate('replyUnknownError') }
    }
  }
  const template = getTemplateText(reply)
  // 归档不带结构化错误，错误文案保存在模板中，仍按错误提示展示。
  if (reply.status === 'error' && template) {
    return { text: template }
  }
  if (reply.stopReason === 'refusal') {
    // 导入的拒绝回复优先展示归档中的模板，普通正文仍不可展示。
    return { text: template || translate('replyRefused'), presentation: 'response' }
  }
  if (template) {
    return { text: template, presentation: 'response' }
  }
  return null
}
