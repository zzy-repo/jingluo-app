/**
 * #480 §7 的**附件侧接线**：按 id 取出解析后的正文，交给 `inject.ts` 组装成文本消息。
 *
 * 分工（谁负责什么，避免同一个决定写两遍）：
 * - 解析 / 缓存 / 状态机：`attachments/manager.ts`（W1 并行落地，本文件只调它的读接口）；
 * - 能不能注入、注入成什么形状：`providerCapability.ts` + `inject.ts`（纯函数，无 IO）；
 * - 「这一轮请求要带哪些附件」：调用方（`chat/store.ts`）—— 本轮提问 + 上下文里还在的历史提问；
 * - **去重**：`inject.ts` 按 `filename + sha256` 做，本文件只按 `id` 避免同一份原件读两遍。
 *
 * 本文件不做截断：单份正文的字符上限（`ATTACHMENT_LIMITS.maxExtractedChars`）与超限
 * warning 由 manager 负责，真正的上下文裁剪在 ContextBuilder（W1 单 #480 §9）。
 * 这里多截一刀会让「禁止静默截断」变成「两处各截一半，谁都说不清」。
 */
import type { FileAttachment } from '../chat/types.js'
import type { InjectDocument } from './inject.js'
import type { DocumentAttachment } from './types.js'

/**
 * `manager.ts` 的读接口。签名与 W1（agent-4）对齐：
 * - `getText`：未解析 / 解析失败 / 原文丢失 → 返回 `undefined`（**不抛错**），
 *   调用侧统一按「这份附件不进请求」处理；要看原因用 `getMeta(id).status`；
 * - `getMeta`：完整 `DocumentAttachment`，`sha256` 由内容算出（64 位小写十六进制）。
 */
export type AttachmentTextApi = {
  getText: (id: string) => Promise<string | undefined>
  getMeta: (id: string) => Promise<DocumentAttachment | undefined>
}

/**
 * TODO(W1 attachments)：`src/services/attachments/manager.ts` 落地后，
 * 把下面的惰性加载整段换成静态 import（行为完全不变，只是少一层动态解析）：
 *
 * ```ts
 * import { getMeta, getText } from './manager.js'
 * ```
 *
 * 现在先用惰性解析，是因为 manager.ts 与本分支并行开发、尚未进入 `feat/480-doc-attachments`
 * —— 静态 import 一个还不存在的模块会让 `npx tsc -p tsconfig.json` 直接 TS2307，
 * 整条分支（包括 DeepSeek 路径）连类型检查都过不了。
 */
const MANAGER_MODULE = './manager.js'

let pending: Promise<AttachmentTextApi | null> | null = null

/** 从模块命名空间里挑出读接口；形状不对就当拿不到（fail-closed，不注入） */
const pickApi = (mod: unknown): AttachmentTextApi | null => {
  if (!mod || typeof mod !== 'object') {
    return null
  }
  const record = mod as Record<string, unknown>
  const candidate = record.attachmentManager ?? record
  const getText = (candidate as Record<string, unknown>).getText
  const getMeta = (candidate as Record<string, unknown>).getMeta
  if (typeof getText !== 'function' || typeof getMeta !== 'function') {
    return null
  }
  return candidate as AttachmentTextApi
}

const loadApi = (): Promise<AttachmentTextApi | null> => {
  if (!pending) {
    // 模块名走变量：见上面 TODO(W1 attachments)，落地后换成静态 import
    pending = import(MANAGER_MODULE).then(pickApi).catch(() => null)
  }
  return pending
}

/**
 * 按附件 id 读正文 → 待注入文档列表。
 *
 * - 同一 `id` 只读一次（原件在 IndexedDB 里只有一份，多轮引用同一附件时共用）；
 * - `getText` 返回 `undefined` / 空正文 / 读失败 → 这份不进请求。按 #480 §10，
 *   解析未完成的附件本来就不允许发送，走到这里还是空说明原件被删或归档缺失，
 *   属于「孤儿附件」，跳过是正确行为，而不是静默截断；
 * - 任何一次读失败都不拖垮整轮请求：文档是增强项，不是请求的前置条件。
 */
export async function loadRequestDocuments(files: FileAttachment[]): Promise<InjectDocument[]> {
  if (files.length === 0) {
    return []
  }
  const api = await loadApi()
  if (!api) {
    return []
  }
  const documents: InjectDocument[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!file.id || seen.has(file.id)) {
      continue
    }
    seen.add(file.id)
    let text: string | undefined
    try {
      text = await api.getText(file.id)
    } catch {
      // 读失败 = 这份不进请求；不吞掉整轮生成
      text = undefined
    }
    if (typeof text !== 'string' || text.trim() === '') {
      continue
    }
    let sha256: string | undefined
    try {
      sha256 = (await api.getMeta(file.id))?.sha256
    } catch {
      // 元数据缺失只影响「去重键退化为 filename + 正文」，不影响注入
      sha256 = undefined
    }
    documents.push({ filename: file.name, text, sha256 })
  }
  return documents
}
