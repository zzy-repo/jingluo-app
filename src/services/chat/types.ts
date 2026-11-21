import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type { KeyFailure } from '../api/keyFailure.js'
import type { UnavailableAttachment } from '../attachments/types.js'
import type {
  ChatModel,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
  /**
   * 发送时判定「本机不可用」、因而不随这条消息发出去的附件（#379）。
   *
   * 导入的历史会话只有元信息（ZIP 只带图片原件），这些附件在发送时没有东西可传。
   * 它们**不阻断发送**：消息照常按剩下的内容发出，这里只是留一份事实，界面据此在消息里
   * 点名提示（哪个附件、为什么没发）。空 / 缺省 = 这条消息没有附件被跳过。
   */
  unavailable?: UnavailableAttachment[]
}

/** 思考块：thinking_delta 累积，签名随 signature_delta 到达；历史轮次的思考服务端会丢弃，不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间；没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop（或回复结束）的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
export type ReplyBlock = ThinkingPart | TextPart | ServerToolBlock

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前默认模型。 */
  model: ChatModel | null
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 请求时是否声明 deepseek_web_search；关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /** 是否允许作为续写前缀；仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列；续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量，续写后更新 */
  usage?: MessageUsage
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    /**
     * 上游响应体里的机器可读错误码（如 `insufficient_quota`）。
     * 存下来是为了刷新 / 换设备后仍能把「额度不足」认出来：状态码常是 429 / 400，
     * 单看状态码会被说成「请求过于频繁」或「未知错误」（#299）。
     */
    upstreamCode?: string
    /**
     * 客户端自己的错误码（`ApiError.code`）：`stream_empty` / `upstream_returned_html` 这类。
     * 目前只用来让**刷新后**仍能认出「上游返回网页」（#434）—— 那个结论只有请求层知道，
     * 不落盘的话重新渲染就退回「空响应」文案。
     */
    code?: string
    localMessage?: TranslationMessage
    /**
     * 上游给的「可自证的原文」（#434）：目前只在「上游返回网页」这条路上有值 ——
     * 内容是 content-type + 正文前 200 字。存下来是为了刷新 / 换设备后**折叠区还在**
     * （改前只有内存里那一份 ApiError 知道，重新渲染就丢）。
     */
    detail?: string
    /**
     * Key 失效的细分（#374）：格式错 / 不存在或被删除 / 被轮换 / 上游没说清。
     * 在失败**当次**就算好并存下来 —— 尾号属于「当时那把 Key」，用户换过 Key 之后
     * 再回看这条消息，也不能显示成新 Key 的尾号。
     */
    keyFailure?: KeyFailure
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
  /** 时间戳表示置顶顺序；缺省表示未置顶。 */
  pinnedAt?: number
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'pinnedAt'>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.pinnedAt === undefined ? {} : { pinnedAt: session.pinnedAt }),
})
