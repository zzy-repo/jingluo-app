/**
 * #480 §7 的**请求侧附件引用收集**：回答「这一轮请求到底带着哪些附件」。
 *
 * ## 职责（#480 集成轮收敛后）
 *
 * | 谁 | 负责什么 |
 * | --- | --- |
 * | `attachments/manager.ts` | 存储 / 解析状态机 / `getText(id)` 读全文 |
 * | `contextBuilder.buildWithDocuments()` | **唯一请求入口**：按需读正文 → 去重 → 预算 → 与裁剪协同 |
 * | `providerCapability.ts` | 哪个渠道走文本注入（`textInjection`） |
 * | `inject.ts` | `<document>` 块的**拼法**（唯二处：块头/块尾 + 拼进 content） |
 * | **本文件** | 从请求消息上收集附件引用（不读正文、不拼字节） |
 *
 * 为什么不再由本文件读正文：正文读取要「按需」（预算用尽就不再 `getText`，见
 * contextBuilder §1），而 setter 只有一个读取口（`contextBuilder` 的 `AttachmentTextSource`）。
 * 两处各读一遍会让「读了几次、谁读了」无法自证，也把「按需」变成「先全读再挑」。
 *
 * ## 引用从哪来（为什么不是从 `prepareFiles` 的 `files` 直接来）
 *
 * 附件引用是**挂在请求消息上**的：`chat/reply.ts` 的 `toRequestMessages()` 在拼消息时
 * 用 `attachmentRefs` 选项把 `UserMessage.files`（非图片）转成 `ChatAttachmentRef` 挂在
 * 对应 user 消息上。这样「哪份附件属于哪一轮」由消息自己携带，历史裁剪（#345）把某轮
 * 丢掉时，它的附件引用自然一起消失 —— 不需要第二套「历史窗口里的附件」的算法。
 *
 * 本文件的 `collectAttachmentsForRequest()` 只做一件事：把这些引用摊平（按 id 去重、
 * 保持请求顺序），供调用方判断「有没有附件要注入」与打点；真正注入在 `buildWithDocuments()`。
 */
import type { FileAttachment } from '../chat/types.js'
import type { ChatAttachmentRef, ChatMessage } from './contextBuilder.js'

/**
 * 附件引用字段的**唯一来源**：`FileAttachment.id`（就是 `DocumentAttachment.id`）。
 *
 * #527 附件 UI 已合并，落地口径与这里的假设一致（不再是假设，是三条链路对齐的同一份契约）：
 * - 输入区：`chat/drafts.ts` 的 `DraftDocument.id`（`att-` 前缀）→ `prepareDraftMessage()`
 *   折成 `FileAttachment`（`serverId: null`、`isImage: false`、无 blob）；
 * - 会话：`chat/store.ts::sendMessage` 把它并进 `UserMessage.files` —— 文档引用就存在
 *   `files[].id` 上，没有另开 `documentIds` 字段；`serverId: null` 让 `reply.ts::toFileBlocks()`
 *   跳过它（不会拼出 `file_id` 块），`isImage: false` 让本文件把它当文档收；
 * - 孤儿清扫：`attachments/manager.ts::collectReferencedAttachmentIds()` 同样按
 *   `files[].id` 认引用，删除消息后据此清掉没人引用的原件。
 *
 * 所以哪天要换字段，改 `attachmentRefsOf()` 一处即可 —— 但另外两处（`sendMessage` 的
 * `files` 合并、孤儿清扫的收集）也必须一起改，它们是同一个契约的三个读取点。
 */
const refOf = (file: FileAttachment): ChatAttachmentRef | null =>
  file.id ? { attachmentId: file.id, filename: file.name } : null

/**
 * 把一条消息的附件列表转成请求侧的附件引用。
 *
 * - **只要文档**（`isImage === false`）：图片走各自渠道的视觉能力（`caps.vision`），
 *   不属于 #480 的文本注入范围；混进来会把图片二进制当文档正文注入；
 * - **没有 id 的丢弃**：没有本地 id 就没有正文可读（历史导入的老消息可能只有 serverId）；
 * - 同一个 id 只留第一次出现（同一附件被重复挂上时不重复注入）。
 */
export const attachmentRefsOf = (files: readonly FileAttachment[]): ChatAttachmentRef[] => {
  const refs: ChatAttachmentRef[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file.isImage) {
      continue
    }
    const ref = refOf(file)
    if (!ref || seen.has(ref.attachmentId)) {
      continue
    }
    seen.add(ref.attachmentId)
    refs.push(ref)
  }
  return refs
}

/**
 * 收集这一轮请求消息上带着的全部附件引用（按请求顺序、按 id 去重）。
 *
 * 调用方（`chat/store.ts`）用它做「本轮要不要走注入」的判定：返回空数组就说明这条
 * 请求没有任何文档要注入，连 `buildWithDocuments()` 都不必进 —— DeepSeek 原生路径与
 * 「有注入能力但没附件」的普通提问都在这一步止步，消息数组原样上行。
 */
export const collectAttachmentsForRequest = (
  messages: readonly ChatMessage[]
): ChatAttachmentRef[] => {
  const refs: ChatAttachmentRef[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const ref of message.attachments ?? []) {
      if (!ref.attachmentId || seen.has(ref.attachmentId)) {
        continue
      }
      seen.add(ref.attachmentId)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * 把消息上的 `attachments` 引用键剥掉，返回**可以上行的**消息。
 *
 * 只在「本该注入却失败」的降级路径上用（`buildWithDocuments()` 自己抛错时）：那种情况下
 * 消息上还挂着引用键，而 `attachments` 不是协议字段，原样上行会被上游当未知字段（400）。
 * 正常路径不需要它 —— `buildWithDocuments()` 出参已经剥过。
 */
export const stripAttachmentRefs = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message
    }
    if (message.role === 'user') {
      return { role: 'user', content: message.content }
    }
    if (message.role === 'assistant') {
      return { role: 'assistant', content: message.content }
    }
    return { role: 'latest_reminder', content: message.content }
  })
