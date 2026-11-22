/**
 * #831 分支会话的本地判定：这些附件在本机还拿得到吗。
 *
 * 判断口径只有两条，都按**id 引用**（不读本体、不碰 sha256）：
 *  - `att-…` 前缀 = 文档附件引用（#480）：元数据记录在 `attachments` 表里，
 *    记录没了就等于「本机不可用」（正文与原件都随记录走）；
 *  - 其余 = 图片原件：`files` 表里按 id 存 blob（`db.loadFile`），blob 不在就是没有。
 *
 * 这里**只回答「在不在」，不抛错也不清库**：清理是孤儿清扫的职责（`attachments/store.ts`），
 * 展示层的职责是把结论说出来 —— 分支是从别处复制来的引用，判不出来时按「不可用」处理，
 * 让用户看到一句明确的话，而不是一个转圈或者一片白（#831 第 6 条）。
 */
import { isAttachmentId } from '../attachments/manager.js'
import { getAttachment } from '../attachments/store.js'
import { loadFile } from './db.js'

/** 附件在本机是否可用；读库失败由调用方（`unavailableAttachmentIds`）按「不可用」收口 */
export const attachmentAvailable = async (id: string): Promise<boolean> => {
  if (isAttachmentId(id)) {
    return (await getAttachment(id)) !== undefined
  }
  return (await loadFile(id)) !== undefined
}
