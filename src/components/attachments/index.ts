/**
 * #527 附件 UI 的对外出口。
 *
 * 组件（输入区 / 消息内复用同一张卡片）：
 *  - `AttachmentPicker`        选择入口（多选、只列 .txt/.docx/.pdf、非法类型明确拒绝）
 *  - `AttachmentCard`          单张卡片（五态 / 进度 / 取消 / 警告角标 / 失败红）——
 *                              外观复用 `files/FileCard`，不另建一套卡片
 *  - `AttachmentList`          卡片列表（`draft` 输入区 / `message` 消息内）
 *  - `AttachmentPanel`         点击卡片弹出的详情小面板（warnings / 失败原因 / 移除）
 *  - `MessageAttachments`      消息里按 id 取元信息后渲染卡片
 *
 * 编排与接线：
 *  - `useAttachmentDrafts()`   输入区草稿附件（add / 进度 / 取消 / 重试 / 移除）
 *  - `setAttachmentService()`  注入 `AttachmentManager`（manager 合入 base 后调用一次，见文件内 TODO）
 *  - `sweepOrphanAttachmentsAfterDelete()`  删除消息 / 会话后的清理收尾
 */
export { AttachmentCard, AttachmentList, type AttachmentCardHandlers } from './AttachmentCard.js'
export { AttachmentPanel } from './AttachmentPanel.js'
export { AttachmentPicker } from './AttachmentPicker.js'
export { MessageAttachments } from './MessageAttachments.js'
export {
  ACCEPT_DOCUMENTS,
  ATTACHMENT_ID_PREFIX,
  classifyAttachmentFiles,
  extensionOf,
  getAttachmentService,
  isAttachmentRefId,
  rejectReasonOf,
  setAttachmentService,
  sizeLimitOf,
  sweepOrphanAttachments,
  sweepOrphanAttachmentsAfterDelete,
  type AttachmentErrorReason,
  type AttachmentReject,
  type AttachmentRejectReason,
  type AttachmentService,
} from './attachmentService.js'
export {
  summarizeAttachment,
  useAttachmentDrafts,
  type AttachmentInjectionInfo,
  type UseAttachmentDrafts,
} from './useAttachmentDrafts.js'
export {
  attachmentWarnings,
  failureOf,
  parsePercent,
  stageLabel,
  statusLine,
  toAttachmentView,
  type AttachmentProgress,
  type AttachmentView,
  type AttachmentViewStatus,
} from './viewModel.js'
