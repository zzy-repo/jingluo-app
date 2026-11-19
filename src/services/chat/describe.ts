import { isTranslationKey, translate } from '../../i18n/index.js'
import { classifyErrorSignature, isContextLimitMessage } from '../api/errors.js'
import { buildReplyErrorReport } from './replyErrorReport.js'
import type { AssistantMessage } from './types.js'

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /** 需要用户处理的问题附带的操作 */
  action?: 'apiKey' | 'topUp'
  /**
   * 兜底提示附带的**可复制诊断文本**（#324）：HTTP 状态码 + 上游 code + 失败环节。
   *
   * 只有「上游确实给了可自证的信息」时才存在 —— 真未知（无状态码、无上游 code、
   * 也没有可读文案）不给它：那种情况复制出去也只是一句「未知错误」，没有诊断价值。
   */
  diagnostics?: string
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

/**
 * 兜底分支里「重试还有没有意义」（#324）：没状态码（请求没到达服务端）、429 限流、
 * 5xx 都还是临时故障；4xx 的其它状态是「同样的请求再发一次也一样」。
 * 与请求层的 `isRetryableStatus` 同口径，这里只多认一个「没有状态码」。
 */
const isRetryableSignature = (status: number | undefined): boolean =>
  typeof status !== 'number' || status === 429 || status >= 500

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
    /**
     * 上游自己写了中文（日/韩同理）：**原话比任何固定文案都具体**，直接展示。
     *
     * 像「当前模型不支持图片输入」这种句子，哪一档固定文案（参数错误 / 模型不可用）
     * 都不如原话准确。分类照旧进日志（`ui.condition`），只是界面上不让固定文案盖掉
     * 上游能自证的原话——这是 #324 之前就有、也必须保留的行为。
     * 只给「没有附带操作」的档用：鉴权 / 额度这两档要保住操作按钮，仍用固定文案。
     */
    const readable = isReadableForUser(message) ? { text: message } : null
    // 历史补传错误刷新后仍需说明原因，恢复沿用附件卡片或重新生成。
    if (kind === 'upload') {
      return { text: message || translate('uploadFileStatusFailed') }
    }
    // 流断在 message_stop 之前：明说连接中断（已收到的内容照常展示），不要混进「网络异常」
    if (kind === 'interrupted') {
      return { text: localized || translate('replyStreamInterrupted') }
    }
    // 正文阶段长时间没有新数据（#150）：连接还在，只是上游不动了，说「等待时间过长」而不是「断网」
    if (kind === 'idle') {
      return { text: localized || translate('replyWaitingStalled') }
    }
    if (kind === 'network') {
      return { text: translate('commonNetworkErrorToast') }
    }
    // 上游说「上下文太长」（#122）：这不是重试能解决的，给能照着做的建议
    if (status === 413 || isContextLimitMessage(message)) {
      return { text: localized || translate('replyContextLimit') }
    }
    switch (
      // 判定口径与请求层共用一份（#299 / #324）：状态码 + 上游 code + 文案，
      // 这样「429 + insufficient_quota」也能落到额度档，而不是被当成限流说「请求过于频繁」
      classifyErrorSignature({ status, code: reply.error.upstreamCode, message })
    ) {
      case 'unauthorized':
        return { text: translate('replyInvalidApiKey'), action: 'apiKey' }
      case 'insufficientBalance':
        // 额度不足是终态（不参与自动重试）：说清「无法继续生成」，并直接给充值 / 卡密入口。
        // 文案复用已有 key（只改成明确措辞），不新增第二个名字，避免出现两个同义 key。
        return { text: translate('replyInsufficientBalance'), action: 'topUp' }
      case 'rateLimited':
        return { text: translate('replyRateLimited') }
      case 'serverBusy':
        // 5xx 是临时故障且会自动重试：文案显式写「可以重试」，与终态错误的「不要重试」区分（#324）
        return { text: translate('replyServerBusy') }
      case 'contentFilter':
        // 内容被审核拦截（#324）：重发同样被拦，文案要让人改内容，而不是点重新生成
        return readable ?? { text: translate('replyContentFiltered') }
      case 'modelInvalid':
        // 模型不存在 / 已下线（#324）：官方端点 400 + invalid_request_error，出路是换模型
        return readable ?? { text: translate('replyModelInvalid') }
      case 'badRequest':
        // 其它被拒绝的请求（400 / 422 参数错误，#324）：重试不会有变化
        return readable ?? { text: translate('replyBadRequest') }
      case 'emptyStream':
        // 200 却没有任何内容（#324）：说「空响应、可重试」，不要含糊成「未知错误」
        return { text: translate('replyEmptyStream') }
      default: {
        // 未识别的错误（#324）：可读的中文原文照常展示，其余升级为「能自证」的提示。
        if (readable) {
          return readable
        }
        const upstreamCode = reply.error.upstreamCode?.trim() ?? ''
        const hasStatus = typeof status === 'number'
        // **真未知**：没有 HTTP 状态码、没有上游 code、也没有可读文案 ——
        // 这才是 `replyUnknownError` 唯一该出现的地方（#324 验收口径）。
        if (!hasStatus && !upstreamCode) {
          return { text: translate('replyUnknownError') }
        }
        // 否则把可自证的信息摆到台面上（短码，不贴长 message），并给一份可复制的诊断
        const detail = [
          hasStatus ? `HTTP ${status}` : '',
          upstreamCode ? `code=${upstreamCode}` : '',
        ]
          .filter(Boolean)
          .join('，')
        return {
          text: translate(
            isRetryableSignature(status) ? 'replyUnclassifiedRetryable' : 'replyUnclassifiedFatal',
            { detail }
          ),
          diagnostics: buildReplyErrorReport({
            status,
            upstreamCode: upstreamCode || undefined,
            kind,
            message: reply.error.message,
          }),
        }
      }
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
