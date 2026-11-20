/**
 * #480 文档附件：原件 blob 的键契约（单独一个文件，是因为**两个层要共用它**）。
 *
 * 为什么不让 `chat/db.ts` 直接 import `attachments/store.ts`：store 依赖 db（`getChatDB` /
 * `loadFile` / `saveFiles`），反过来再 import 就是循环依赖。而 #531 的修法本质是
 * 「整包导入替换时，`chat/db.ts` 必须认得哪些键不属于聊天数据」，这个**判定口径**必须只有一份 ——
 * 两处各写一个 `'attachment-'` 字面量，改了一处没改另一处的那天，附件会**静默**被替换清掉。
 * 所以：常量与判定放在这里（本文件不 import 任何东西），store 与 db 都从这里取。
 */

/** 原件 blob 键前缀：内容寻址，与聊天图片的 `files` 键（图片 id）互不干扰 */
export const ATTACHMENT_BLOB_PREFIX = 'attachment-'

/** 附件原件在 `files` store 里的键（= `DocumentAttachment.localPath`） */
export const attachmentBlobKey = (sha256: string): string => `${ATTACHMENT_BLOB_PREFIX}${sha256}`

/** 是否本模块写进 `files` 的键（按前缀圈定范围，不误伤聊天图片） */
export const isAttachmentBlobKey = (key: string): boolean => key.startsWith(ATTACHMENT_BLOB_PREFIX)
