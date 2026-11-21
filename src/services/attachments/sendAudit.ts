/**
 * #379：**发送前的附件可用性审计** —— 只回答一个问题：
 * 「这一轮请求会引用到的附件里，哪些在本机根本没有原件？」
 *
 * ## 为什么需要它（bug 的定性）
 *
 * 导入会话里的附件只有元信息：`history/toLocal.ts` 的 `toFile()` 把 `serverId` 一律置空，
 * 而 ZIP 只带图片原件（`historyExportDescription`：「包含所有历史对话及本地图片原件；
 * 其他附件仅保留文件信息」）。于是同一个附件在发送时可能是三种状态：
 *
 * | 状态 | 旧行为 |
 * | --- | --- |
 * | 有 `serverId` | 正常进请求（`file_id`） |
 * | 没 `serverId`、本机有原件 | 补传一次（#444 起只在本轮提问里做；历史轮次不补传） |
 * | 没 `serverId`、**本机没原件** | 到处漏：图片通道 `imageSourceMissing` 直接中止整条消息（一个请求都发不出去）；图片文件通道在 `ensureServerId` 里返回 null 后**静默消失**（违反 #548「不许静默丢图」）；卡片上什么原因都不说 |
 *
 * 表格里第三行的两种漏法都是「源缺失」这一件事的后果，却没有一处统一判定它。
 * 本模块就是那一处：**源缺失 = 只能展示、不能发送**，因此
 *
 * 1. **不重传**（没有东西可传，重传只会再失败一次）；
 * 2. **不阻断**（它是既有消息记录的一部分，不是这一轮要发的内容）—— 消息照常发出；
 * 3. **不静默**（交给界面在消息里点名：哪个附件、为什么没发）。
 *
 * ## 边界
 *
 * - 不认识网络、不认识 IndexedDB：`hasSource` 由调用方注入，本模块只做判定；
 * - **不判本轮刚选的附件**：原件就在这轮内存里（`pendingFiles`），真失败必须由上传环节
 *   点名报错（#548 的硬约束：本轮图片要么成功、要么明确报错，绝不静默丢图）；
 * - **不判文档附件引用**（`att-` 前缀）：它们正文在 AttachmentManager、走 #480 的文本注入，
 *   没有「原件缺失」这回事（缺了由 `contextBuilder` 记 warning 并按无正文发送）。
 */
import type { FileAttachment } from '../chat/types.js'
import { isAttachmentId } from './manager.js'
import type { UnavailableAttachment } from './types.js'

export type AttachmentAudit = {
  /** 可以照常进入本轮请求的附件（保持原顺序，元素是原对象） */
  sendable: FileAttachment[]
  /** 本机没有原件、已跳过，且要在消息里说清楚的附件 */
  unavailable: UnavailableAttachment[]
  /** `unavailable` 的 id 集合：发送链路按它跳过，免得每处再判一次、判法还各不相同 */
  unavailableIds: Set<string>
}

export type AttachmentAuditOptions = {
  /**
   * 这个附件是不是**本轮刚选的**（原件在这轮内存里，可能还没落盘）。
   * 是 → 一律算可发送：它的问题属于「上传失败」，要由上传环节点名报错，不在这里被悄悄跳过。
   */
  isOwnUpload: (id: string) => boolean
  /** 本机有没有可上传的原件（调用方查 IndexedDB 的 files 表） */
  hasSource: (id: string) => Promise<boolean>
}

/**
 * 逐条判「能不能发」，返回可发送的、以及本机不可用的清单。
 *
 * 判定顺序（每条都对应一个真实状态，别合并）：
 *  1. 有 `serverId` → 可发送（服务端已经有这份文件，与本机原件无关）；
 *  2. `att-` 文档引用 → 可发送（正文走注入，没有「原件」概念，不在这里判死）；
 *  3. 本轮刚选的 → 可发送（原件在内存里；上传失败由上传环节点名报错，见 #548）；
 *  4. 其余（历史 / 继承来的）→ 查本机原件：没有 → `source-missing`，跳过并进提示。
 *
 * 同一 id 只判一次（`edit` / `regenerate` 会让同一条附件同时出现在提问与历史里）。
 */
export const auditSendableAttachments = async (
  files: readonly FileAttachment[],
  options: AttachmentAuditOptions
): Promise<AttachmentAudit> => {
  const sendable: FileAttachment[] = []
  const unavailable: UnavailableAttachment[] = []
  const unavailableIds = new Set<string>()
  const checked = new Map<string, boolean>()

  for (const file of files) {
    if (file.serverId || isAttachmentId(file.id) || options.isOwnUpload(file.id)) {
      sendable.push(file)
      continue
    }
    let hasSource = checked.get(file.id)
    if (hasSource === undefined) {
      hasSource = await options.hasSource(file.id)
      checked.set(file.id, hasSource)
    }
    if (hasSource) {
      sendable.push(file)
      continue
    }
    if (!unavailableIds.has(file.id)) {
      unavailableIds.add(file.id)
      unavailable.push({ id: file.id, name: file.name, reason: 'source-missing' })
    }
  }

  return { sendable, unavailable, unavailableIds }
}
