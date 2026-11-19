import { isTranslationKey, translate } from '../../i18n/index.js'
import {
  classifyErrorSignature,
  isContextLimitMessage,
  parseErrorField,
  parseSupportedModels,
} from '../api/errors.js'
import { buildReplyErrorReport, buildUpstreamSnippet } from './replyErrorReport.js'
import type { AssistantMessage } from './types.js'

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /**
   * 需要用户处理的问题附带的操作。
   * - `apiKey`：换 Key（落到「数据管理」里的服务配置）；
   * - `topUp`：充值 / 卡密；
   * - `settings`：打开设置（模型与接口配置都在「数据管理」）——#347 / #353 补的入口，
   *   参数错误与模型不可用这两档以前只会「叫你去看设置」，却没有任何能点的东西。
   */
  action?: 'apiKey' | 'topUp' | 'settings'
  /**
   * 兜底提示附带的**可复制诊断文本**（#324）：HTTP 状态码 + 上游 code + 失败环节。
   *
   * 只有「上游确实给了可自证的信息」时才存在 —— 真未知（无状态码、无上游 code、
   * 也没有可读文案）不给它：那种情况复制出去也只是一句「未知错误」，没有诊断价值。
   */
  diagnostics?: string
  /**
   * 折叠区里的**上游原文**（#347 / #353）：
   * 状态码 + 上游短码 + 首段原文（截断到 200 字、已脱敏）。
   *
   * 为什么英文原文只进折叠区、不进主文案：界面上直接糊一段英文既不可读也不可控（#324 口径），
   * 但「完全看不到上游说了什么」正是 #347 / #353 的问题 —— 折起来让用户主动展开。
   */
  upstream?: string
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

/**
 * 文案里的状态码标签（#347）：`HTTP 400` 是协议里的固定写法，不翻译；
 * 没有状态码（流内错误帧 / 请求没发出去）时说明「上游未给出状态码」，而不是留个空括号。
 */
const statusLabel = (status: number | undefined): string =>
  typeof status === 'number' ? `HTTP ${status}` : translate('replyUpstreamStatusUnknown')

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
    /**
     * 折叠区「上游原文」（#347 / #353）：**只在上游真给了原文时**存在。
     * 断流 / 空响应这类上游什么都没说的失败不占版面。
     */
    const upstreamOf = () =>
      buildUpstreamSnippet({
        status,
        upstreamCode: reply.error?.upstreamCode,
        message: reply.error?.message,
      })
    /** 「复制诊断信息」的文本（#324 的同一份口径，字段顺序固定） */
    const diagnosticsOf = () =>
      buildReplyErrorReport({
        status,
        upstreamCode: reply.error?.upstreamCode,
        kind,
        message: reply.error?.message,
      })
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
      case 'modelInvalid': {
        // 模型不存在 / 已下线（#324 / #339）：官方端点 400 + invalid_request_error。
        // 只说「去设置里换模型」对内置渠道是死路（那里根本没有模型行，见 #339），
        // 所以把**实际发出的模型名**与**上游列出的可用模型**一起摆出来：
        // 用户/客服一眼就能看出「发的是残留值」，而不用再去翻诊断。
        const models = parseSupportedModels(message)
        const modelName = reply.model?.trim()
        return {
          ...(readable ?? {
            text: translate('replyModelInvalid', {
              model: modelName || translate('replyModelUnknownName'),
              models: models.length ? models.join(', ') : translate('replyModelInvalidNoModels'),
            }),
          }),
          // 模型不可用的唯一出路是换模型（#347 / #353）：文案以前只说「去设置里换」，
          // 现在给一个真的能点的入口（落到「数据管理」的服务配置）。
          action: 'settings',
        }
      }
      case 'badRequest': {
        // 参数 / 字段不合法（400 / 422，#324 / #347 / #353）：重试不会有变化。
        //
        // 这一档以前只有一句「请检查设置里的模型与接口配置」：说不出是哪个字段、看不到上游原文、
        // 也没有能点的入口。现在三件事都补齐：字段名（`parseErrorField`）、可展开的上游原文、
        // 「打开设置」按钮（模型与地址就在那里面）。
        const field = parseErrorField(message)
        // 上游写了中文就照抄原话（#324 口径）：比任何固定文案都具体；入口与诊断照给
        if (readable) {
          return { text: readable.text, action: 'settings', diagnostics: diagnosticsOf() }
        }
        return {
          text: field
            ? translate('replyParamInvalid', { status: statusLabel(status), field })
            : translate('replyBadRequest', { status: statusLabel(status) }),
          action: 'settings',
          upstream: upstreamOf(),
          diagnostics: diagnosticsOf(),
        }
      }
      case 'upstreamRejected': {
        // 其余被上游拒绝的 4xx（#347）：403 / 404 / 405 / 409 / 415。
        // 它们既不是参数问题（说「检查模型与接口配置」是误导），也不是临时故障。
        if (readable) {
          return { text: readable.text, upstream: upstreamOf(), diagnostics: diagnosticsOf() }
        }
        return {
          text: translate('replyUpstreamRejected', { status: statusLabel(status) }),
          upstream: upstreamOf(),
          diagnostics: diagnosticsOf(),
        }
      }
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
          // 长英文原文不上主文案，但用户**主动展开**能看到（#347）：这就是「至少显示状态码 +
          // 上游首句」的落点，也是以前只能翻日志才看得到的那段话
          upstream: upstreamOf(),
          diagnostics: diagnosticsOf(),
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
