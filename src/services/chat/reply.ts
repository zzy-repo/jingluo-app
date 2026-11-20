import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
} from '../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'
import {
  estimateChars,
  estimateTokens,
  readRoundAnchor,
  rememberRoundAnchor,
  reportContextTrim,
  resolveContextBudget,
  selectRoundWindow,
  type ContextBudget,
  type ContextTrimReport,
} from './contextBudget.js'
import { normalizeReminder } from './latestReminder.js'
// #480 §7：附件引用挂在请求消息上（`ChatAttachmentRef` 是类型，`attachmentRefsOf` 是唯一映射点）
import type { ChatAttachmentRef, ChatMessage } from '../attachments/contextBuilder.js'
import { attachmentRefsOf } from '../attachments/requestDocs.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        // 客户端工具内容不保存；未完成的工具往返也不能作为续写前缀。
        return event.content_block.type === 'tool_use' ? { ...next, prefix: false } : next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) =>
        block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      )
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' ||
    (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

/**
 * 「只传了文档、没打字」时的占位说明（#480 §8 多轮：历史轮不能整轮消失）。
 *
 * 为什么需要：文档附件在本仓库里 `serverId` 恒为 null（原件在 AttachmentManager，不走上传），
 * 于是 `toFileBlocks()` 不会为它产出任何块 —— 一条「只上传了 PDF、没说别的」的历史提问
 * 在请求消息里就是**空 content**。加上占位说明有两个作用：
 * 1. 该轮不会因为「空 content」被当成坏数据整轮丢掉，它的附件引用因此能进入注入路径；
 * 2. 注入失败（解析 failed / 预算耗尽）时消息也不是空的，不会让上游因为空 user 消息 400。
 *
 * 计数用引用数量（不是文件数）：只有会被注入的文档才参与，图片不算。
 * 文案必须是**纯函数**（同一轮永远同一串字节），否则 #345 的前缀稳定性会被打破。
 */
const documentsPlaceholder = (count: number): string => `[用户上传了 ${count} 个附件]`

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = (
  { content, files }: UserMessage,
  attachments?: readonly ChatAttachmentRef[]
): ChatMessage => {
  const refs = attachments ?? []
  const blocks = toFileBlocks(files)
  // 空正文 + 有文档引用 → 占位说明（仅在挂了引用时生效；不传引用时与原实现逐字节相同）
  const text = content === '' && refs.length > 0 ? documentsPlaceholder(refs.length) : content
  const param: ChatMessage =
    blocks.length === 0
      ? { role: 'user', content: text }
      : {
          role: 'user',
          content: [...blocks, ...(text ? [{ type: 'text' as const, text }] : [])],
        }
  // #480 §7：文档引用随消息走（**不是**协议字段，注入完成后由 ContextBuilder 剥掉）。
  // 只有声明了文本注入的渠道才会传 attachments —— DeepSeek 原生路径拿到的对象与改动前一致。
  return refs.length > 0 ? { ...param, attachments: refs } : param
}

/**
 * assistant 的内容块按历史与续写场景转换：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾；
 */
const toAssistantParam = (
  { blocks }: AssistantMessage,
  prefix = false,
  thinking = false
): Extract<MessageParam, { role: 'assistant' }> => {
  const content: AssistantBlockParam[] = []
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  for (const block of blocks) {
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      // 续写保留本轮思考，历史轮次的思考省略。
      const { type, thinking, signature } = block
      content.push({ type, thinking, signature: signature ?? '' })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    }
  }
  return {
    role: 'assistant',
    content: content.filter((block) => block.type !== 'text' || block.text !== ''),
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 *
 * 请求前过一遍上下文预算（#122）：token 估算 + 轮次双闸，超了就成对丢弃最旧的轮次。
 * 裁掉的永远是老历史 —— 系统前缀由请求侧单独拼、本轮提问与续写前缀始终保留。
 * 裁剪统计通过 `reportContextTrim` / `options.onTrim` 暴露，诊断里能看到本轮裁了多少条。
 */
/**
 * 把 `role:'latest_reminder'` 快照从 messages 里摘出来（相邻重复只留一条）。
 * 不支持该扩展角色的协议（Anthropic）把内容折进 system 前缀，信息不丢。
 */
export const foldReminders = (
  messages: MessageParam[]
): { messages: MessageParam[]; reminders: string[] } => {
  const reminders: string[] = []
  const rest: MessageParam[] = []
  for (const message of messages) {
    if (message.role !== 'latest_reminder') {
      rest.push(message)
      continue
    }
    if (reminders[reminders.length - 1] !== message.content) {
      reminders.push(message.content)
    }
  }
  return { messages: rest, reminders }
}

export type RequestBudgetOptions = {
  /** 单次覆盖预算（缺省用全局默认 getContextBudget()） */
  budget?: Partial<ContextBudget>
  /** 发生裁剪时回调一次，供诊断层记录「本轮裁掉多少条」 */
  onTrim?: (report: ContextTrimReport) => void
  /**
   * 会话身份（#345）：同一个 key 的连续几轮会**沿用同一个裁剪边界**，
   * 这样历史只在尾部增长、请求前缀逐字节稳定，上游上下文缓存才能命中。
   * 不传 = 不记边界（无状态重算），只有 `store.ts` 有会话 id，别处不用管。
   */
  anchorKey?: string
  /**
   * 是否在 user 消息上挂附件引用（#480 §7，`attachments: ChatAttachmentRef[]`）。
   *
   * **只有文本注入渠道（`textInjection === true`）才传 true**；DeepSeek 官方不传 ——
   * 出参与改动前逐字节相同（引用键根本不出现），请求体也就不可能被动到。
   *
   * 为什么挂在这里、而不是在调用点按内容回猜「这条 user 消息是哪一轮」：
   * `toRequestMessages()` 是唯一知道「哪条请求消息来自哪条 UserMessage」的地方；
   * 出去之后只剩 content 字符串，再靠正则/内容匹配反查会随内容变化而错配。
   * 引用只是消息上的**旁挂字段**：不计入裁剪预算（不传 size），注入完成后由
   * `contextBuilder.buildWithDocuments()` 从出参里剥掉（原样上行会被上游当未知字段）。
   */
  attachmentRefs?: boolean
}

export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  options?: RequestBudgetOptions
): MessageParam[] => {
  const budget = resolveContextBudget(options?.budget)
  /** #480 §7：是否挂文档引用（只有文本注入渠道） */
  const wantRefs = options?.attachmentRefs === true
  /** 本轮提问的文档引用（只在文本注入渠道取；否则为空数组，出参与改动前一致） */
  const questionRefs = wantRefs ? attachmentRefsOf(question.files) : []
  const questionParam = toUserParam(question, questionRefs)
  /**
   * 历史提问没有文字、附件也都没有 serverId 时，提问为空，连同回答一起省略（原有行为）。
   *
   * #480 §8 的例外：**只有文档、没有文字**的轮次（`serverId` 恒为 null → `toFileBlocks()`
   * 恒空）在文本注入渠道上必须保留 —— 它的正文要靠「消息上的附件引用」带回来，
   * 整轮丢掉就等于多轮追问时丢失上一轮上传的文档（§8「多轮对话」）。
   *
   * 这条豁免**跟着 `wantRefs` 走**，不是无条件放开：DeepSeek 原生路径拿不到这些文档的
   * `file_id`，保留下来只会多一条空 user 消息（上游 400 风险），所以那边的行为一个字都不变。
   */
  const rounds = getContextRounds(history).filter(([user]) => {
    if (user.content !== '' || toFileBlocks(user.files).length > 0) {
      return true
    }
    return wantRefs && attachmentRefsOf(user.files).length > 0
  })
  // 每轮先转成请求里的那几条消息：裁剪以「轮」为单位，成对进出，不会只留一半。
  const units = rounds.map(([user, reply]) => {
    const params: MessageParam[] = []
    if (reply.latestReminder) {
      // 修复前写下的快照可能是四段（#324）：原样重发会让官方端点继续 400
      params.push({ role: 'latest_reminder', content: normalizeReminder(reply.latestReminder) })
    }
    params.push(toUserParam(user), toAssistantParam(reply))
    // 附件引用留到**裁剪之后**再挂（见下面 push 处）：不进 estimateChars，
    // 于是裁剪边界与改动前逐字节一致，不受附件引用字段长度影响。
    return { params, user }
  })
  const sizes = units.map(({ params }) => estimateChars(params))
  // 本轮提问与系统快照永远保留，但占预算
  const fixedChars = estimateChars(questionParam) + (latestReminder?.length ?? 0)
  /**
   * 上一轮定下的裁剪边界（#345）：按「第一个被保留的轮次」的提问 id 找回它的下标。
   * 找不到（会话被改过 / 预算变了）就当没有锚点，重新算一次。
   */
  const anchorKey = options?.anchorKey
  const anchorFromId = anchorKey ? readRoundAnchor(anchorKey, budget) : undefined
  const anchorIndex = anchorFromId ? rounds.findIndex(([user]) => user.id === anchorFromId) : -1
  const window = selectRoundWindow(
    sizes,
    budget,
    fixedChars,
    anchorIndex >= 0 ? rounds.length - anchorIndex : undefined
  )
  if (anchorKey) {
    // 记下本轮边界：第一个被保留的轮次的提问 id（下一轮靠它找回同一个边界）
    const firstKept = rounds[rounds.length - window.kept]?.[0]
    if (firstKept?.id) {
      rememberRoundAnchor(anchorKey, firstKept.id, budget)
    }
  }
  const kept = units.slice(units.length - window.kept)
  if (kept.length < units.length) {
    const report: ContextTrimReport = {
      roundsTotal: units.length,
      roundsKept: kept.length,
      roundsDropped: units.length - kept.length,
      charsBefore: sizes.reduce<number>((sum, size) => sum + size, 0) + fixedChars,
      charsAfter: window.chars,
      tokensBefore: estimateTokens(
        sizes.reduce<number>((sum, size) => sum + size, 0) + fixedChars
      ),
      tokensAfter: estimateTokens(window.chars),
      maxTokens: budget.maxTokens,
      maxRounds: budget.maxRounds,
      reason: window.reason,
    }
    reportContextTrim(report)
    try {
      options?.onTrim?.(report)
    } catch {
      // 观测失败不影响请求
    }
  }
  const messages: MessageParam[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: normalizeReminder(reminder) })
      previousReminder = reminder
    }
  }
  for (const { params, user } of kept) {
    // 引用在这里才挂：重新过一遍 toUserParam，让「空正文 + 有引用」的占位说明也一并生效
    // （直接给 params 里的对象加 attachments 不会有占位说明，空提问就还是空 user 消息）
    const refs = wantRefs ? attachmentRefsOf(user.files) : []
    for (const param of params) {
      if (param.role === 'latest_reminder') {
        appendReminder(param.content)
      } else if (param.role === 'user' && refs.length > 0) {
        messages.push(toUserParam(user, refs))
      } else {
        messages.push(param)
      }
    }
  }
  appendReminder(latestReminder)
  messages.push(questionParam)
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}
