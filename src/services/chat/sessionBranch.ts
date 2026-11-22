/**
 * #831 会话级分支（session branch）：**从历史会话分叉出一条独立的新会话**。
 *
 * 与 `branches.ts` 分清楚（两者只共享「分支」这个词）：
 *   - `branches.ts` = **消息级**分支：同一个会话内多条回答版本，靠消息树的 `parentId` /
 *     `selectedChildId` 表达，消息 id 与存储行都是同一条会话；
 *   - 本文件 = **会话级**分支：新建一条 `Session`（新 id、新标题、自己的消息列表与删除生命周期），
 *     只在 `branchOf` 里记下「我从哪条会话的哪条消息处来」。
 *
 * 三条设计口径（本单的硬约束，改动前先读）：
 *  1. **复制，不是移动**：父会话一个字节都不改（本文件只读 `source`，返回新对象）；
 *     用例 `tests/unit/session-branch-831.test.mjs` 的 ④ 用「改父标题 / 删父消息 / 继续聊父」双向断言。
 *  2. **节点分支不带入分叉点之后的任何消息**：`branchPointOf()` 的 `dropped` 就是确认弹层里
 *     「之后的 M 条不会带入」的那个 M，`planBranchSession()` 只切 `path.slice(0, kept)`。
 *  3. **附件按引用共享**：消息里的附件条目（`files[]`，图片的原件 id 与文档附件的 `att-…` id）
 *     原样带过去、**不复制本体**；本文件不做任何 blob / 附件记录的写操作，所以存储里只有一份。
 *     原件真的不在本机时由 `unavailableAttachmentIds()` 判出来，界面降级成「附件不可用」，不抛错。
 *
 * 本文件**不 import 任何存储 / DOM / i18n 模块**（只 import 消息级分支的纯函数与类型），
 * 因此可以被裸 Node 用例直接 `loadTsModule()` 加载。
 */
import { getVisibleMessages } from './branches.js'
import type { Message, Session, SessionBranchOrigin, SessionSummary } from './types.js'

/**
 * 分叉点：第 N 条消息处分支。
 *
 * `kept` = 带入新会话的条数（= N），`dropped` = 分叉点之后**不带入**的条数（= M）。
 * 完整分支（`messageId` 缺省）的 `dropped` 恒为 0。
 */
export type BranchPoint = {
  /** 带入新会话的消息条数（= 分叉点在「第几条消息」） */
  kept: number
  /** 分叉点之后不带入的条数 */
  dropped: number
  /** 分叉点上那条消息的 id；完整分支 / 空会话为 null */
  messageId: string | null
}

/**
 * 会话的**当前可见路径**：界面展示与请求上下文用的就是这条链（消息级分支下不是整棵消息树）。
 * 分支必须按它切 —— 否则「第 N 条」在有多版本回答的会话里会指到用户看不到的消息上。
 */
export const branchPathOf = (session: Session): Message[] => getVisibleMessages(session)

/**
 * 算分叉点。`messageId` 缺省 = 完整分支（整条会话）；给了 id 就按它在这条可见路径上的位置切。
 * 给的 id 不在可见路径上（数据损坏 / 已被删除）→ null，调用方必须放弃这次分支而不是瞎猜一个位置。
 */
export const branchPointOf = (session: Session, messageId?: string): BranchPoint | null => {
  const path = branchPathOf(session)
  if (messageId === undefined) {
    const last = path.length > 0 ? path[path.length - 1] : null
    return { kept: path.length, dropped: 0, messageId: last === null ? null : last.id }
  }
  const index = path.findIndex((message) => message.id === messageId)
  if (index < 0) {
    return null
  }
  return { kept: index + 1, dropped: path.length - index - 1, messageId }
}

/**
 * 分支标题：默认 `<原标题>（分支）`。
 *
 * 后缀由调用方按当前语言传入（`t('sessionBranchTitleSuffix')`）：本模块不读 i18n，
 * 也不能自己拼中文 —— 英文界面下默认名得是 `Title (branch)`。
 * 原标题为空时只用后缀，避免造出「（分支）」这种没有主语的标题。
 */
export const branchTitle = (title: string, suffix: string): string => {
  const base = title.trim()
  return base === '' ? suffix.trim() : `${title}${suffix}`
}

/**
 * 单条消息的**结构副本**：对象与数组各一份，附件条目只复制引用字段（id / sha256 等），
 * **不做任何附件本体复制**。这样两条会话在内存里改各自的标题 / 消息时不会穿透到对方。
 */
const copyMessage = (message: Message): Message => {
  if (message.role === 'user') {
    return { ...message, files: message.files.map((file) => ({ ...file })) }
  }
  return { ...message, blocks: message.blocks.map((block) => ({ ...block })) }
}

/**
 * 线性化：分支出来的会话按「一条链」存储（`rootMessageId` 缺省 = 线性列表，见 `types.ts`），
 * 因此要把消息级分支的 `parentId` / `selectedChildId` 摘掉 —— 留着它们等于把父会话的消息树
 * 复制了一份进来，之后 `normalizeSession()` 会按旧指针重新排链，反而可能丢掉刚复制的消息。
 */
const linearCopy = (message: Message): Message => {
  const copy: Record<string, unknown> = { ...copyMessage(message) }
  delete copy.parentId
  delete copy.selectedChildId
  return copy as unknown as Message
}

export type BranchSessionInput = {
  source: Session
  /** 分叉点消息 id；缺省 = 完整分支 */
  messageId?: string
  /** 新会话 id（由调用方生成，便于用例固定） */
  id: string
  /** 新会话标题（已含「（分支）」后缀或用户当场改的名字） */
  title: string
  /** 创建时间（毫秒） */
  createdAt: number
}

export type BranchSessionPlan = {
  /** 新会话（独立对象；父会话不受影响） */
  session: Session
  /** `session.branchOf` 的同一份引用，便于调用方直接落库 / 断言 */
  branchOf: SessionBranchOrigin
  point: BranchPoint
}

/**
 * 造分支会话（纯函数）：父会话只读，返回值里的消息是**结构副本**（附件按 id 引用共享）。
 * 分叉点算不出来时返回 null（调用方必须当成「这次分支没发生」处理）。
 */
export const planBranchSession = (input: BranchSessionInput): BranchSessionPlan | null => {
  const point = branchPointOf(input.source, input.messageId)
  if (point === null) {
    return null
  }
  const path = branchPathOf(input.source)
  // 节点分支只带分叉点**及之前**的消息；分叉点之后的 M 条一条都不带入。
  const kept = input.messageId === undefined ? path : path.slice(0, point.kept)
  const branchOf: SessionBranchOrigin = {
    sessionId: input.source.id,
    createdAt: input.createdAt,
  }
  // 只有**节点分支**才记分叉点；完整分支的 `branchOf` 里不带 `messageId`（缺省 = 整条复制）
  if (input.messageId !== undefined && point.messageId !== null) {
    branchOf.messageId = point.messageId
  }
  const session: Session = {
    id: input.id,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    messages: kept.map(linearCopy),
    // 空会话显式写 null（与 `normalizeSession()` 对空会话的口径一致）；有线则缺省表示线性列表
    ...(kept.length === 0 ? { rootMessageId: null } : {}),
    branchOf,
  }
  return { session, branchOf, point }
}

/**
 * 徽标口径：父会话还在本机 → `branch`（「分支」）；不在 → `source-missing`
 * （降级「来源已不在本机」—— 父会话被删、或这个包导到了另一台设备，都是这一态）。
 * 不是分支会话（`origin` 缺省）→ null：徽标整块不渲染，而不是渲染一个空标签。
 */
export type BranchBadgeState = 'branch' | 'source-missing'

export const branchBadgeState = (
  origin: SessionBranchOrigin | undefined,
  parentExists: boolean
): BranchBadgeState | null => {
  if (origin === undefined) {
    return null
  }
  return parentExists ? 'branch' : 'source-missing'
}

/** 取一条会话/摘要的分支来源；不是分支会话返回 undefined（避免调用方到处写可选链）。 */
export const branchOriginOf = (item: { branchOf?: SessionBranchOrigin }): SessionBranchOrigin | undefined =>
  item.branchOf

/**
 * 列表徽标要显示的**父会话标题**：父会话不在本机返回 null（徽标降级，不报错、也不假装存在）。
 * 父会话标题为空（还没自动起标题）时用父会话 id 顶一下，别显示成空徽标。
 */
export const parentTitleOf = (
  origin: SessionBranchOrigin | undefined,
  summaries: readonly SessionSummary[]
): string | null => {
  if (origin === undefined) {
    return null
  }
  for (const summary of summaries) {
    if (summary.id === origin.sessionId) {
      return summary.title.trim() === '' ? summary.id : summary.title
    }
  }
  return null
}

/**
 * 会话引用的附件 id（按出现顺序去重）：图片原件 id（`files[].id`）与文档附件引用
 * （`att-…` 前缀，同一字段）都算 —— 两者都是「按 id 引用本体」。
 */
export const attachmentRefsOf = (session: Session): string[] => {
  const seen: Record<string, true> = {}
  const ids: string[] = []
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      if (seen[file.id] === true) {
        continue
      }
      seen[file.id] = true
      ids.push(file.id)
    }
  }
  return ids
}

/** 判断「这个附件在本机还在吗」：可以是同步实现，也可以是读库的异步实现。 */
export type AttachmentExists = (id: string) => boolean | Promise<boolean>

/**
 * 本机拿不到的附件 id 列表（#831 第 6 条：父会话被删除 / 换设备导入后，分支侧降级「附件不可用」）。
 *
 * **绝不抛错**：读库失败、判断函数抛异常都记成「不可用」——
 * 分支是从别处复制来的引用，父会话不在了也不该让整个会话页白屏。
 */
export const unavailableAttachmentIds = async (
  ids: readonly string[],
  exists: AttachmentExists
): Promise<string[]> => {
  const missing: string[] = []
  for (const id of ids) {
    let available = false
    try {
      available = await exists(id)
    } catch {
      available = false
    }
    if (!available) {
      missing.push(id)
    }
  }
  return missing
}
