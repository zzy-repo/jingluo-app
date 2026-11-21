import { isTranslationKey, translate, type TranslationKey } from '../../i18n/index.js'
import {
  classifyErrorSignature,
  isContextLimitMessage,
  parseErrorField,
  parseSupportedModels,
  UPSTREAM_HTML_CODE,
} from '../api/errors.js'
import { getBaseUrl, getProviderKind } from '../api/apiConfig.js'
import { classifyKeyFailure, type KeyFailure, type KeyFailureKind } from '../api/keyFailure.js'
import { getSpec } from '../api/providers.js'
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
   * 提示里附带「先看额度」的入口（#374）：Key 失效那一档额外给一条**不动 Key** 的路。
   *
   * 为什么要单独一个字段：换 Key 会影响额度归属（#374 的顾虑），用户需要先确认
   * 当前账号 / 剩余额度再决定换不换。它和 `action`（换 Key / 打开设置）并列，
   * 不是替代关系，所以不塞进 `action` 的联合类型里。
   */
  quotaAction?: true
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

/**
 * Key 失效细分 → 文案 key（#374）。三种能确定的原因各一句，`rejected` 是
 * 「上游只说了不行、没说为什么」的兜底 —— 兜底那句话不再断言「已被删除」。
 */
const KEY_FAILURE_COPY: Record<KeyFailureKind, TranslationKey> = {
  format: 'replyApiKeyFormatWrong',
  notFound: 'replyApiKeyNotFound',
  rotated: 'replyApiKeyRotated',
  rejected: 'replyInvalidApiKey',
}

/**
 * Key 失效提示的正文（#374）：原因 + Key 尾号 + 「换 Key 前先确认额度归属」。
 *
 * 三段拼起来才完整：
 * - 原因让用户知道**该做什么**（重新粘贴 / 重新绑定 / 用新 Key 覆盖）；
 * - 尾号让用户知道**是哪一把**（多人多 Key / 刚从别处拷来的场景里，这是唯一能自证的线索）；
 * - 额度归属提醒是因为「换 Key 会不会丢额度」正是用户不敢点更换的原因（#374 原文）。
 */
const keyFailureText = (failure: KeyFailure): string => {
  const reason = translate(KEY_FAILURE_COPY[failure.kind])
  const tail = failure.tail ? translate('replyApiKeyTailNote', { tail: failure.tail }) : ''
  return `${reason}${tail}；${translate('replyApiKeyQuotaNote')}`
}

/**
 * 诊断里「我们发的是什么」（#353 第 2 点）：渠道 / 模型 / 接口。
 *
 * 为什么在渲染时算而不是随消息落盘：这三样都是**当前配置**，用户点「复制诊断信息」时
 * 要的正是「我现在这套配置 + 这条上游报错」的组合；重新渲染时读到的与设置页里看到的一致，
 * 不会出现「诊断里说 A、设置页写着 B」。`model` 例外 —— 它来自消息本身（`reply.model`），
 * 因为内置渠道的残留值与导入的历史回复都可能与设置页显示的不同，那种差异正是要看到的。
 *
 * 任何一项取不到就整项省略（`undefined`）：诊断文本宁可少一行，也不写占位符骗人。
 * 接口地址原样交出，由 `scrubReportText` 收敛成「协议//host/***」（查询串里的签名参数必须抹掉）。
 */
const configSnapshot = (model?: string | null) => {
  const modelName = model?.trim() || undefined
  try {
    const spec = getSpec(getProviderKind())
    // 报告正文是中文产物（标题与字段名都是中文，见 replyErrorReport.ts），渠道名取中文标签；
    // `kind` 一并写出，客服按 id 对渠道最省事，也不受翻译改名影响。
    return { provider: `${spec.label.zh}（${spec.kind}）`, model: modelName, endpoint: getBaseUrl() }
  } catch {
    // 配置还没初始化（首屏 / 历史导入）：只交模型名，渠道与接口整行省略
    return { model: modelName }
  }
}

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
     *
     * #434 起优先用落盘的 `detail`：上游返回网页时，message 是本地文案，
     * **响应摘要**（content-type + 正文前 200 字）只存在 detail 里。
     */
    const upstreamOf = () =>
      buildUpstreamSnippet({
        status,
        upstreamCode: reply.error?.upstreamCode,
        message: reply.error?.detail || reply.error?.message,
      })
    /** 「复制诊断信息」的文本（#324 的同一份口径，字段顺序固定） */
    const diagnosticsOf = () =>
      buildReplyErrorReport({
        status,
        upstreamCode: reply.error?.upstreamCode,
        kind,
        // 上游给了响应摘要（#434）就一并带上：反馈里最缺的就是「到底回了什么」
        message: reply.error?.detail
          ? `${reply.error?.message ?? ''}\n${reply.error.detail}`.trim()
          : reply.error?.message,
        // 可执行的核对项（#353 第 2 点）：渠道 / 模型 / 接口。三样都取自当前配置，
        // 只有「贴回去能被复现」这层用处；取值失败不影响诊断本身，缺哪行就不写哪行。
        ...configSnapshot(reply.model),
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
      // 这样「429 + insufficient_quota」也能落到额度档，而不是被当成限流说「请求过于频繁」。
      // #434：请求层判死的 `upstream_returned_html` 也要原样喂进来 —— 否则 200 + 网页
      // 会被 2xx 兜底改写成「空响应」，那条文案就又不可达了。
      classifyErrorSignature({
        status,
        code:
          reply.error.upstreamCode ??
          (reply.error.code === UPSTREAM_HTML_CODE ? UPSTREAM_HTML_CODE : undefined),
        message,
      })
    ) {
      case 'unauthorized': {
        /**
         * Key 不行（#303 → #374）：不再只给一句「无效或已被删除」。
         *
         * `keyFailure` 是请求失败**当次**算好并落盘的（谁也不知道当时那把 Key 的尾号，
         * 换过 Key 之后更不可能反推），历史 / 导入的旧记录没有它时按同一条口径就地补算，
         * 只是没有尾号（那时本地 Key 已经不是当时那把了，编一个尾号比不显示更糟）。
         */
        const failure =
          reply.error.keyFailure ??
          classifyKeyFailure({
            status,
            code: reply.error.upstreamCode,
            message: reply.error.message,
          })
        return {
          text: keyFailureText(failure),
          action: 'apiKey',
          // 「换 Key 会影响额度归属」：光说不够，给一个**不动 Key** 就能核对账号的入口
          quotaAction: true,
          upstream: upstreamOf(),
          diagnostics: diagnosticsOf(),
        }
      }
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
      case 'upstreamReturnedHtml':
        // 上游返回的是网页而不是数据（#434）：以前这条会落到 emptyStream（「空响应，可以重试」），
        // 于是同一份 HTML 被重试 3 次、用户还以为上游故障。现在单独成档：
        // 主文案说人话（网关 / 代理 / 地址填错），响应摘要（content-type + 前 200 字）进折叠区。
        return {
          text: localized || translate('upstreamReturnedHtml'),
          upstream: upstreamOf(),
          diagnostics: diagnosticsOf(),
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
