/**
 * 历史附件的补传策略（Issue #379）。
 *
 * 背景：导入的会话里，附件一律 `serverId: null`（见 `history/toLocal.ts`），
 * 于是每次发消息前，`prepareFiles()` 都会把**历史轮次**里没有 serverId 的附件重新上传一遍。
 * 导入的图片确实带着原件（ZIP 解出来的副本），所以会真的发出上传请求；
 * 而重建出来的 File 没有 MIME、文件名可能没有扩展名，官方端点会直接 400，
 * 失败状态又被消息卡片读走，显示成「这张附件上传失败」——连发纯文字也会看到。
 *
 * 结论：导入的附件是**既有消息的记录**，不是待发送内容，不参与补传；
 * 只有用户自己新加、且确实还没有 serverId 的附件才需要补传。
 *
 * 这里只放判据，好让 Node 单测直接 import（不碰存储、不碰网络）。
 */

export type HistoryAttachmentLike = {
  serverId: string | null
  /** 从归档导入的附件：属于既有记录，不参与补传 */
  imported?: boolean
}

/** 历史轮次里的这个附件，是否需要在本轮发送前补传 */
export const shouldReuploadHistoryAttachment = (file: HistoryAttachmentLike): boolean =>
  !file.serverId && file.imported !== true

/**
 * 本轮提问里的这个附件是否需要上传。
 *
 * 导入的附件要排除掉：用户「编辑并重发」一条导入的历史消息时，附件仍然是归档记录，
 * 原件上传同样会拿到 400，而提问附件上传失败会**阻断整条发送**（历史附件只是静默跳过）。
 * 宁可让这条消息不带该附件发出去，也不要让用户卡在「上传失败」上。
 */
export const shouldUploadQuestionAttachment = (file: HistoryAttachmentLike): boolean =>
  file.imported !== true
