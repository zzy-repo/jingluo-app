/**
 * #480 文档附件的上下文构建：**按需读取 → 去重 → 预算注入 → 与历史裁剪协同**。
 *
 * 职责边界：
 * - parser（txt/docx/pdf）负责把文件变成纯文本，manager 负责存储与 `getText(id)`；
 * - 这里只做一件事：把「已经解析好的附件全文」按预算塞进**请求消息里**，
 *   并保证塞进去的字节每一轮都一样（见下面的三条不变量）；
 * - 不发请求、不读文件、不碰 IndexedDB、不改全局状态 —— 纯函数 + 一个可注入的读取口。
 *
 * ## 三条不变量（前缀稳定，直接决定上游上下文缓存命中率）
 *
 * `contextBudget.ts` 的 #345 修的是「裁剪边界每轮前移」，让**历史消息序列**逐字节稳定；
 * 本模块是同一件事的另一半：**附件正文是拼在历史消息里的**，一旦拼法随轮次变化，
 * 前面所有历史消息的字节都会跟着变，#345 白修（实测命中价 0.19 分 vs 未命中 4.70 分）。
 *
 * 所以这里强制三条：
 *
 * 1. **无状态纯函数**：`buildWithDocuments()` 的输出只由入参决定 ——
 *    不看当前时间、不看随机数、不看「上次注入了什么」、不累计任何模块级变量。
 *    同一组入参调用两次，输出的 JSON 逐字节相同（包含重试 / 重新生成的重发场景）。
 * 2. **跟随所属消息、位置固定**：附件正文拼在**它所属的那条 user 消息**里，
 *    位置固定在消息内容的最前面（`<document …>` 块 → 空行 → 用户问题），
 *    不新增消息、不调整消息顺序、不改其它消息的字节；
 *    没有附件的消息**原样返回同一个对象引用**（连序列化都不重做）。
 * 3. **自旧向新贪心分配预算**：第 i 条消息的附件能分到多少预算，
 *    只取决于它**前面**的附件（按请求顺序），永远不看它后面的消息。
 *    因此「历史在尾部又长了一轮」不会改变任何一条老消息的注入结果 ——
 *    这正是前缀缓存需要的单调性。反过来，若按「新的优先」分配，
 *    今天排在末尾的消息下一轮就进了前缀，它的正文却会被重算成另一个样子，前缀立刻作废。
 *
 * 于是与 #345 的锚点冻结协同起来是自洽的：
 * - 窗口没变（绝大多数轮次，锚点命中）→ 消息序列不变 + 注入结果不变 → 前缀逐字节不变；
 * - 窗口变了（越线，一次性裁到低水位）→ 前缀本来就已经从第一个 token 起变了，
 *   此时重新分配预算**不产生额外成本**。这就是「裁剪协同」的全部含义：
 *   被裁掉的轮次带走它的附件（不注入、不占预算），窗口内轮次的附件照旧注入。
 *
 * ## 预算与「禁止静默截断」（issue §3.7 / §9）
 *
 * - 单附件上限：`ATTACHMENT_LIMITS.maxExtractedChars`（40 万字符）；
 * - 单次请求合计预算：`ATTACHMENT_LIMITS.docBudgetTokens`（3.2 万 token，按
 *   `CHARS_PER_TOKEN` 折成字符）；给了模型上下文窗口时按 §9 公式再取一次小值；
 * - 真的超了**不静默**：注入文本里就地插一条
 *   `[内容过长，已截断，剩余 N 字符未发送]`，同时往 `warnings` 里记一条给人看的说明；
 * - 合计预算用尽后剩下的附件**不静默丢弃**：进 `skipped`（`budget_exhausted`）+ `warnings`，
 *   由上层提示用户「减少附件或选择部分内容」（§9 的处理方式）；
 * - 预算用尽后的附件**不再读取全文**（`getText` 不调用），元数据仍读，这样 skipped 里还能带文件名。
 */

import type { MessageParam } from '../api/types.js'
import { CHARS_PER_TOKEN } from '../chat/contextBudget.js'
// 拼法唯一来源（#530）：块头/块尾/文件名归一/「块怎么拼进 content」都在那边
import {
  DOCUMENT_FOOTER,
  DOCUMENT_PREAMBLE,
  documentHeader,
  injectDocumentBlocks,
} from './inject.js'
import { ATTACHMENT_LIMITS } from './limits.js'
import {
  getMeta as readAttachmentMeta,
  getText as readAttachmentText,
} from './manager.js'
import type { AttachmentStatus } from './types.js'

/** 附件引用：消息只存 id（+ 可选 sha256），正文永远按需读 */
export type ChatAttachmentRef = {
  /** 本地附件 id（manager 的主键，同一文件被多条消息引用时共用） */
  attachmentId: string
  /** 内容指纹；给了就与 id 一起参与单次请求内的去重 */
  sha256?: string
  /** 展示用文件名；缺省时从 manager 元数据取，再缺省用 id */
  filename?: string
}

/**
 * 请求侧消息：就是 `toRequestMessages()` 产出的 `MessageParam`，
 * 额外挂一个**只在构建期存在**的 `attachments` 字段（保存附件引用）。
 *
 * 出参里这个字段会被**剥掉**：`MessageParam` 是要原样 JSON 上行的，
 * 多一个 `attachments` 键上游可能直接 400。
 */
export type ChatMessage = MessageParam & {
  attachments?: readonly ChatAttachmentRef[]
}

/** manager 侧的附件元数据（按需读，只有元数据，不读全文） */
export type AttachmentMeta = {
  filename?: string
  sha256?: string
  status?: AttachmentStatus
  warnings?: readonly string[]
  errorMessage?: string
}

/**
 * 附件正文的读取口。实现方是 `manager.ts`：
 * `getText(id)` 读解析全文，`getMeta(id)` 读元数据。
 *
 * 这里保留接口注入（而不是在调用点直接 import manager）：单测 / 宿主可以换成替身，
 * 且本模块对「怎么读」零假设；生产默认实现在文件末尾注册（`manager.ts` 的 `getText` / `getMeta`）。
 */
export type AttachmentTextSource = {
  /** 解析全文；未解析 / 不存在返回 undefined（不抛） */
  getText: (attachmentId: string) => Promise<string | undefined>
  /** 元数据；没有就只按 id 去重、用 id 当文件名 */
  getMeta?: (attachmentId: string) => Promise<AttachmentMeta | undefined>
}

/** 跳过原因（机器可读），对应的人话在 `detail` 与 `warnings` 里 */
export type SkipReason =
  | 'duplicate'
  | 'budget_exhausted'
  | 'not_ready'
  | 'parse_failed'
  | 'empty'
  | 'read_error'
  | 'source_unavailable'
  | 'unsupported_role'
  | 'no_user_message'
  | 'already_injected'

export type InjectedAttachment = {
  attachmentId: string
  /** 计入预算的字符数：含 `<document>` 包装与截断标注（不是原文长度） */
  characters: number
  /** 是否被截断注入（原文没进完） */
  truncated: boolean
  /** 展示用文件名 */
  name: string
  /** 原文总字符数（UI 可以说「已注入 x / 共 y」） */
  totalCharacters: number
  /** 实际注入的正文正文字符数（不含包装与标注） */
  bodyCharacters: number
}

export type SkippedAttachment = {
  attachmentId: string
  reason: SkipReason
  /** 直接可展示的中文说明 */
  detail: string
  name?: string
}

export interface BuildResult {
  /** 可以直接塞进请求体的消息（`attachments` 字段已剥离，无附件消息保持原对象） */
  messages: ChatMessage[]
  injected: InjectedAttachment[]
  skipped: SkippedAttachment[]
  /**
   * 需要 UI 展示的提示（截断、未注入、解析失败、读失败…）。
   * 有内容就说明「本次请求没有完整发送用户给的全部文档」，不能吞。
   */
  warnings: string[]
  budget: {
    /** 本轮文档预算（字符） */
    docBudgetChars: number
    /** 折算回去的 token 估算，便于和 §9 的 3.2 万对齐 */
    docBudgetTokens: number
    /** 实际用掉的字符数（含包装与标注） */
    usedChars: number
    /** 单附件注入上限（字符） */
    perAttachmentCap: number
  }
}

export type BuildOptions = {
  /** 正文读取口；缺省用 `setAttachmentTextSource()` 注册的那个 */
  source?: AttachmentTextSource
  /** 覆盖本轮文档预算（字符）；缺省由 `docBudgetTokens` 换算 */
  docBudgetChars?: number
  /** 覆盖本轮文档预算（token）；缺省 `ATTACHMENT_LIMITS.docBudgetTokens` */
  docBudgetTokens?: number
  /**
   * 模型上下文窗口（token）。给了就按 issue §9 公式取小值：
   * `窗口 - 系统提示 - 历史 - 本轮输入 - 预留输出`，
   * 此处无法知道历史与本轮的确切占用，所以只减 `reservedTokens`，其余交给调用方传准数值。
   */
  contextWindowTokens?: number
  /** §9 公式里除 doc 之外要扣掉的 token（系统提示 + 历史 + 本轮输入 + 预留输出） */
  reservedTokens?: number
  /** 覆盖单附件注入上限（字符）；缺省 `ATTACHMENT_LIMITS.maxExtractedChars` */
  maxExtractedChars?: number
  /** 剩余预算低于它就改为「未注入」而不是塞一个碎片；缺省 `ATTACHMENT_LIMITS.minInjectableChars` */
  minInjectableChars?: number
}

// ---------- 注入格式（固定不变，是前缀稳定性的一部分） ----------
//
// **拼法不在这里定义**：`<document name="…">` 块头、块尾、文件名归一、以及「块怎么拼进
// content」全部来自 `inject.ts`（#530）—— 那边是 issue §7 样例的唯一实现。本模块只决定
// 「哪条消息注入哪些块、每块分多少预算、超了怎么标注」，不再自己写一份标签与转义。
// 两处各写一份的结果是：同一个附件在两条路径下拼出不同字节，前缀稳定性与断言都会各说各话。

/** 注入块开头的统一说明（issue §7）。沿用 #526 的导出名，值就是 `inject.ts` 的那一条 */
export const DOC_INTRO = DOCUMENT_PREAMBLE

/**
 * 截断标注（issue §3.7 的 a 方案：不拒绝注入，但把「截了、还差多少」写在正文里）。
 * 文案与排版**不能再改**：它属于请求前缀的一部分，改一个字就是一次全量缓存失效。
 */
export const truncationMarker = (rest: number): string =>
  `[内容过长，已截断，剩余 ${rest} 字符未发送]`

/** 不切开代理对（emoji 等）：退一个 UTF-16 码元，结果依然是确定的 */
const safeSlice = (text: string, length: number): string => {
  if (length >= text.length) {
    return text
  }
  if (length <= 0) {
    return ''
  }
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

/** 非负整数兜底：非法值（NaN / 负数 / 0）回落到 fallback */
const positive = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

/**
 * issue §9：可用文档预算 = 模型窗口 - 系统提示 - 历史 - 本轮输入 - 预留输出，
 * 再与产品默认 `docBudgetTokens` 取小。这里只负责减法，减法输入由调用方给准。
 */
export const resolveDocBudgetTokens = (input: {
  docBudgetTokens?: number
  contextWindowTokens?: number
  reservedTokens?: number
}): number => {
  const product = positive(input.docBudgetTokens, ATTACHMENT_LIMITS.docBudgetTokens)
  if (typeof input.contextWindowTokens !== 'number' || !Number.isFinite(input.contextWindowTokens)) {
    return product
  }
  const reserved = Math.max(0, Math.floor(input.reservedTokens ?? 0))
  const available = Math.floor(input.contextWindowTokens) - reserved
  if (available <= 0) {
    return product
  }
  return Math.min(product, available)
}

// ---------- 读取口注册（manager.ts 接线用） ----------

let registered: AttachmentTextSource | null = null

/**
 * 注册正文读取口。manager.ts 落地后调用一次即可：
 * `setAttachmentTextSource({ getText, getMeta })`。
 * 没注册时不会崩：所有附件进 `skipped`（`source_unavailable`）+ warning，绝不静默。
 */
export const setAttachmentTextSource = (source: AttachmentTextSource | null): void => {
  registered = source
}

export const getAttachmentTextSource = (): AttachmentTextSource | null => registered

// ---------- 主流程 ----------

type Candidate = {
  attachmentId: string
  sha256?: string
  filename?: string
  /** 注入到哪条消息；-1 表示「本轮提问但没有任何消息引用它」 */
  messageIndex: number
}

/** 从入参里按请求顺序收集候选：先消息自带的引用，再本轮显式给的 id（都挂在最后一条 user 上） */
const collectCandidates = (base: ChatMessage[], attachmentIds: string[]): Candidate[] => {
  const candidates: Candidate[] = []
  base.forEach((message, messageIndex) => {
    const refs = message.attachments
    if (!refs || refs.length === 0) {
      return
    }
    // 附件只属于 user 消息；assistant / latest_reminder 上挂着引用是上游数据坏了，记下来不注入
    const injectable = message.role === 'user'
    for (const ref of refs) {
      candidates.push({
        attachmentId: ref.attachmentId,
        sha256: ref.sha256,
        filename: ref.filename,
        messageIndex: injectable ? messageIndex : -2,
      })
    }
  })
  for (const attachmentId of attachmentIds) {
    candidates.push({ attachmentId, messageIndex: -1 })
  }
  return candidates
}

/** 末条 user 消息的下标；没有 user 消息时 -1 */
const lastUserIndex = (base: ChatMessage[]): number => {
  for (let index = base.length - 1; index >= 0; index -= 1) {
    if (base[index].role === 'user') {
      return index
    }
  }
  return -1
}

const describeName = (candidate: Candidate, meta: AttachmentMeta | undefined): string =>
  meta?.filename || candidate.filename || candidate.attachmentId

/** 取一条消息里的纯文本（用于幂等检查；只读，不改任何东西） */
const messageText = (message: ChatMessage): string => {
  if (message.role === 'latest_reminder') {
    return message.content
  }
  if (typeof message.content === 'string') {
    return message.content
  }
  const parts: string[] = []
  for (const block of message.content) {
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 这条消息里是否已经有该附件的注入块（幂等保护，避免同一次内容被注入两遍） */
const hasInjectedBlock = (message: ChatMessage | undefined, name: string): boolean =>
  message !== undefined && messageText(message).indexOf(documentHeader(name)) >= 0

/**
 * 构建带文档的请求消息。
 *
 * @param base 已经是**裁剪后**的请求消息（`toRequestMessages()` 的输出，带上 `attachments` 引用）。
 *   历史裁剪会先决定窗口，被裁掉的轮次不在这里出现，它们的附件自然不会被注入 —— 这就是「裁剪协同」。
 * @param attachmentIds 本轮显式要注入的附件（当前提问带的文件）；没有消息引用它们时挂到最后一条 user 消息。
 * @param opts 预算 / 读取口覆盖
 */
export async function buildWithDocuments(
  base: ChatMessage[],
  attachmentIds: string[] = [],
  opts: BuildOptions = {}
): Promise<BuildResult> {
  const docBudgetTokens = resolveDocBudgetTokens({
    docBudgetTokens: positive(opts.docBudgetTokens, ATTACHMENT_LIMITS.docBudgetTokens),
    contextWindowTokens: opts.contextWindowTokens,
    reservedTokens: opts.reservedTokens,
  })
  const docBudgetChars = positive(opts.docBudgetChars, docBudgetTokens * CHARS_PER_TOKEN)
  const perAttachmentCap = positive(opts.maxExtractedChars, ATTACHMENT_LIMITS.maxExtractedChars)
  const minInjectable = positive(opts.minInjectableChars, ATTACHMENT_LIMITS.minInjectableChars)

  const candidates = collectCandidates(base, attachmentIds)
  const injected: InjectedAttachment[] = []
  const skipped: SkippedAttachment[] = []
  const warnings: string[] = []
  /** 每条消息要拼的文档块，按注入顺序（= 请求顺序） */
  const blocksByMessage = new Map<number, string[]>()
  const seenIds = new Set<string>()
  const seenSha = new Set<string>()
  const duplicateOf = new Map<string, string>()
  const fallbackUserIndex = lastUserIndex(base)
  const source = opts.source ?? registered

  let usedChars = 0
  for (const candidate of candidates) {
    const id = candidate.attachmentId
    // 1. 去重（按 id）：同一附件在**单次请求**里只处理一次，先到先得，
    //    注入位置固定在第一次出现的那条消息里 —— 位置固定才有稳定的前缀。
    if (seenIds.has(id)) {
      skipped.push({
        attachmentId: id,
        reason: 'duplicate',
        detail: `附件「${candidate.filename || id}」在本次请求中已处理过一次，不重复注入`,
        ...(candidate.filename ? { name: candidate.filename } : {}),
      })
      continue
    }
    if (candidate.messageIndex === -2) {
      skipped.push({
        attachmentId: id,
        reason: 'unsupported_role',
        detail: '附件引用挂在非 user 消息上，已忽略',
      })
      continue
    }
    // 目标消息（本轮显式给了 id、又没有消息引用它时，挂到最后一个 user 消息上）
    const targetIndex = candidate.messageIndex === -1 ? fallbackUserIndex : candidate.messageIndex
    if (targetIndex < 0) {
      skipped.push({
        attachmentId: id,
        reason: 'no_user_message',
        detail: `没有可挂载的用户消息，附件「${candidate.filename || id}」未注入`,
      })
      continue
    }
    seenIds.add(id)
    if (!source) {
      skipped.push({
        attachmentId: id,
        reason: 'source_unavailable',
        detail: '附件读取接口未就绪，本次未注入任何文档内容',
      })
      continue
    }

    // 2. 元数据（只读元数据，不读全文）：文件名 / sha256 / 状态 / 解析告警
    let meta: AttachmentMeta | undefined
    if (source.getMeta) {
      try {
        meta = await source.getMeta(id)
      } catch {
        meta = undefined
      }
    }
    const name = describeName(candidate, meta)
    const sha = candidate.sha256 || meta?.sha256
    if (sha) {
      const first = seenSha.has(sha) ? duplicateOf.get(sha) : undefined
      if (first) {
        skipped.push({
          attachmentId: id,
          reason: 'duplicate',
          detail: `附件「${name}」与「${first}」内容相同（sha256 一致），本次请求只注入一次`,
          name,
        })
        continue
      }
    }

    // 3. 解析状态：不完整的解析结果不静默发送（issue §12）
    const status = meta?.status
    if (status === 'failed') {
      skipped.push({
        attachmentId: id,
        reason: 'parse_failed',
        detail: `附件「${name}」解析失败，未注入${meta?.errorMessage ? `：${meta.errorMessage}` : ''}`,
        name,
      })
      warnings.push(`附件「${name}」解析失败，本次未发送其内容。`)
      continue
    }
    if (status === 'pending' || status === 'parsing') {
      skipped.push({
        attachmentId: id,
        reason: 'not_ready',
        detail: `附件「${name}」尚未解析完成（${status}），本次未注入`,
        name,
      })
      warnings.push(`附件「${name}」还未解析完，请等解析完成后再发送。`)
      continue
    }
    if (status === 'partial') {
      warnings.push(`附件「${name}」只解析出一部分内容（可能缺少部分页），已按现有内容注入。`)
    }
    if (meta?.warnings && meta.warnings.length > 0) {
      for (const item of meta.warnings) {
        warnings.push(`附件「${name}」：${item}`)
      }
    }

    // 4. 幂等保护：base 应该是未注入的原文。若目标消息里已经有这个附件的包装块，
    //    说明调用方把上一次的构建结果又传进来了 —— 再注入一次就是重复内容。
    if (hasInjectedBlock(base[targetIndex], name)) {
      skipped.push({
        attachmentId: id,
        reason: 'already_injected',
        detail: `目标消息里已有附件「${name}」的注入块，本次不重复注入`,
        name,
      })
      continue
    }

    // 5. 预算已用尽：不再读全文（按需读取），但要说清楚「没注入」
    const header = documentHeader(name)
    const footer = DOCUMENT_FOOTER
    const overhead = header.length + footer.length
    const remaining = docBudgetChars - usedChars
    if (remaining - overhead < minInjectable) {
      skipped.push({
        attachmentId: id,
        reason: 'budget_exhausted',
        detail: `本轮文档预算已用尽（上限 ${docBudgetChars} 字符），附件「${name}」未注入`,
        name,
      })
      warnings.push(
        `本轮文档预算已用尽，附件「${name}」未发送；请减少附件数量，或分批提问。`
      )
      continue
    }

    // 6. 按需读正文
    let text: string | undefined
    try {
      text = await source.getText(id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      skipped.push({
        attachmentId: id,
        reason: 'read_error',
        detail: `附件「${name}」读取失败，未注入：${reason}`,
        name,
      })
      warnings.push(`附件「${name}」读取失败，本次未发送其内容。`)
      continue
    }
    if (typeof text !== 'string' || text === '') {
      skipped.push({
        attachmentId: id,
        reason: 'empty',
        detail: `附件「${name}」没有可注入的文本内容`,
        name,
      })
      warnings.push(`附件「${name}」没有可提取的文字，本次没有发送任何内容。`)
      continue
    }

    // 7. 单附件上限 + 本轮剩余预算，两个都按「先截再标注」处理（§3.7 禁止静默截断）
    let body = text
    let marker = ''
    const capByBudget = Math.max(0, remaining - overhead)
    const effectiveCap = Math.min(perAttachmentCap, capByBudget)
    if (body.length > effectiveCap) {
      // 标注本身也吃预算：按「剩余 N = 原文全长」这种最长形态预留，保证总长不超过预算，
      // 且这个预留量与后面真正的 N 无关 —— 同一组入参永远得到同一个结果。
      const reserved = overhead + 1 + truncationMarker(text.length).length
      const fit = Math.max(0, Math.min(effectiveCap, remaining - reserved))
      body = safeSlice(text, fit)
      if (body.length < minInjectable) {
        skipped.push({
          attachmentId: id,
          reason: 'budget_exhausted',
          detail: `本轮文档预算不足以容纳附件「${name}」的可用片段，未注入`,
          name,
        })
        warnings.push(`本轮文档预算不足，附件「${name}」未发送；请减少附件数量，或分批提问。`)
        continue
      }
      marker = `\n${truncationMarker(text.length - body.length)}`
    }
    const block = `${header}${body}${marker}${footer}`
    const characters = block.length

    if (sha) {
      seenSha.add(sha)
      duplicateOf.set(sha, name)
    }
    const list = blocksByMessage.get(targetIndex)
    if (list) {
      list.push(block)
    } else {
      blocksByMessage.set(targetIndex, [block])
    }
    usedChars += characters
    injected.push({
      attachmentId: id,
      characters,
      truncated: marker !== '',
      name,
      totalCharacters: text.length,
      bodyCharacters: body.length,
    })
    if (marker) {
      const rest = text.length - body.length
      warnings.push(
        `附件「${name}」内容过长，已截断注入：剩余 ${rest} 字符未发送（原文 ${text.length} 字符，本次发送 ${body.length} 字符）。`
      )
    }
  }

  // 8. 落地：只改「有注入内容」「带引用需要剥掉字段」的消息，其余原样返回同一引用
  const messages = base.map((message, index): ChatMessage => {
    const blocks = blocksByMessage.get(index)
    if (blocks && blocks.length > 0 && message.role === 'user') {
      // 拼法走 inject.ts（与 #530 同一条实现）：声明 → 各文档块 → 「用户问题：原文」。
      // content 为块数组时保留非 text 块，注入文本作为**最后一个** text 块（与 toUserParam 同序）。
      return { role: 'user', content: injectDocumentBlocks(message.content, blocks) }
    }
    if (!message.attachments || message.attachments.length === 0) {
      return message
    }
    // 引用已消费：出参不能带 attachments 键（原样上行会被上游当未知字段）
    if (message.role === 'user') {
      return { role: 'user', content: message.content }
    }
    if (message.role === 'assistant') {
      return { role: 'assistant', content: message.content }
    }
    return { role: 'latest_reminder', content: message.content }
  })

  return {
    messages,
    injected,
    skipped,
    warnings,
    budget: {
      docBudgetChars,
      docBudgetTokens,
      usedChars,
      perAttachmentCap,
    },
  }
}

/**
 * 给调用方的一行摘要（日志 / 诊断用），口径与 `formatContextTrim()` 一致：
 * 只做观测，不参与请求本身。
 */
export const formatDocumentInjection = (result: BuildResult): string => {
  const truncated = result.injected.filter((item) => item.truncated).length
  return (
    `文档注入：注入 ${result.injected.length} 个（其中截断 ${truncated} 个），` +
    `跳过 ${result.skipped.length} 个，字符 ${result.budget.usedChars}/${result.budget.docBudgetChars}，` +
    `单附件上限 ${result.budget.perAttachmentCap}`
  )
}

/**
 * 默认读取口：`manager.ts`（#529 落地后接线）。
 *
 * 语义与 `AttachmentTextSource` 一致：
 * - `getText`：未解析 / 解析失败 / 原件丢失 → `undefined`（不抛）；
 * - `getMeta`：完整 `DocumentAttachment` 在这里**降型**成 `AttachmentMeta` ——
 *   本模块只要文件名 / 指纹 / 状态 / 告警，拿不到正文以外的字段，也不该拿到。
 *
 * 为什么是「注册」而不是在调用点直接 import：`setAttachmentTextSource()` 仍是唯一入口，
 * 单测传入 `source` 即可覆盖（入参优先于注册值），两者互不干扰。
 */
setAttachmentTextSource({
  getText: readAttachmentText,
  getMeta: async (id: string): Promise<AttachmentMeta | undefined> => {
    const attachment = await readAttachmentMeta(id)
    return attachment === undefined
      ? undefined
      : {
          filename: attachment.filename,
          sha256: attachment.sha256,
          status: attachment.status,
          warnings: attachment.warnings,
          errorMessage: attachment.errorMessage,
        }
  },
})

/**
 * 调用点（#480 集成轮已接线，见 `chat/store.ts` 的 `withRequestDocuments()`）：
 *
 * ```text
 * store.ts::streamReply
 *   ├─ docInjectionFor(kind).textInjection === false  →  原路径，本模块一次都不进（DeepSeek）
 *   └─ true
 *       ├─ toRequestMessages(..., { attachmentRefs: true })   // 引用挂到所属 user 消息上
 *       ├─ collectAttachmentsForRequest(messages)             // 没有附件 → 连本模块都不进
 *       └─ buildWithDocuments(messages, [], { contextWindowTokens, reservedTokens })
 * ```
 *
 * 三条调用纪律：
 * 1. **每轮都用未注入的 base 重建**（本函数只对「base 里已有注入块」做幂等保护，
 *    见 `already_injected`；把上一次的出参再喂回来是浪费，也会让预算算两遍）；
 * 2. 引用只挂在 user 消息上（`reply.ts::toRequestMessages` 的 `attachmentRefs` 选项），
 *    历史裁剪把某轮丢掉时引用随消息一起消失 —— 这就是「裁剪协同」的全部机制；
 * 3. `warnings` 必须往上传（store 会记一条 `chat_send`），不许吞：它代表
 *    「这次没有把用户给的全部文档完整发出去」。
 */
