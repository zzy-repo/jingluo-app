import type {
  ServerToolUseBlock,
  WebFetchResult,
  WebFetchToolResultBlock,
} from '../../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  Session,
  UserMessage,
} from '../types.js'
import type { TranslationKey } from '../../../i18n/index.js'
import { fail } from './errors.js'
import type { ChatMessage, FileEntry, Fragment, SessionFile } from './format.js'
import { sessionFilesDir } from './paths.js'

export type LocalSession = {
  session: Session
  /** 本会话目录下应存在的图片：ZIP 条目名 → 文件 ID */
  images: Map<string, string>
}

/**
 * 单条导入失败的定位信息（#49）。汇总进导入结果的 skipped[]：
 * 界面据此显示「成功 N 个 / 跳过 M 个」，并能定位到具体会话、消息。
 */
export type ImportSkip = {
  /** session：整个会话跳过；message：只丢这一条消息；branch：当前分支指针损坏，已回退到最长链 */
  scope: 'session' | 'message' | 'branch'
  sessionId: string
  sessionTitle: string
  /** 出问题的消息 id；会话级失败为 null */
  messageId: string | null
  /** 缺失或冲突的父消息 id，用于定位损坏点 */
  parentId: string | null
  /** 提示文案 key（backupInvalidBranches / backupInvalidFiles） */
  reason: TranslationKey
}

/**
 * 单会话转换结果：坏数据降级成 skipped 而不是抛错，一条坏分支不再让整次导入失败（#49）。
 * ok=false 表示整个会话无法构造，调用方跳过它继续处理其余会话即可。
 */
export type LocalSessionResult =
  | { ok: true; session: LocalSession; skipped: ImportSkip[] }
  | { ok: false; reason: TranslationKey; skipped: ImportSkip[] }

const time = (value: string) => Date.parse(value)

/** 链接会渲染成 href，只接受 HTTP / HTTPS。 */
const isWebUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const toFile = (file: FileEntry): FileAttachment => ({
  id: file.id,
  serverId: null,
  name: file.file_name,
  size: file.file_size,
  isImage: file.is_image,
  // 图片身份来自归档；原件随后从 ZIP 读取后补充具体 MIME。
  mimeType: '',
})

const toUser = (message: ChatMessage): UserMessage => ({
  id: String(message.id),
  role: 'user',
  createdAt: time(message.inserted_at),
  content: message.fragments.map((item) => (item.type === 'REQUEST' ? item.content : '')).join(''),
  files: message.fragments.flatMap((item) => (item.type === 'FILE' ? item.files.map(toFile) : [])),
})

/** 归档不带原调用 ID，以消息和片段位置生成稳定 ID，调用与结果共用。 */
const toolBlocks = (
  id: string,
  input: ServerToolUseBlock['input'],
  kind: ServerToolUseBlock['kind'],
  result?: ReplyBlock
): ReplyBlock[] => [
  {
    type: 'server_tool_use',
    id,
    name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
    input,
    kind,
    caller: { type: 'direct' },
  },
  ...(result ? [result] : []),
]

const fetchResult = (
  toolUseId: string,
  content: WebFetchToolResultBlock['content']
): WebFetchToolResultBlock => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  kind: 'deep_search',
  content,
})

const fetched = (
  url: string,
  title: string | null,
  publishedAt: string | null
): WebFetchResult => ({
  type: 'web_fetch_result',
  url,
  content: {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '' },
    title,
  },
  published_at: publishedAt,
})

const unavailable: WebFetchToolResultBlock['content'] = {
  type: 'web_fetch_tool_result_error',
  error_code: 'unavailable',
}

/**
 * 片段一次性转换为正式内容块，展示、请求和导出共用：
 * - 普通搜索与边想边搜共用 TOOL_SEARCH，以同一回复是否有打开 / 查找网页来区分；
 * - READ_LINK 将 URL、标题和签名存入工具结果；仅含签名的结果也保留；
 * - 没有链接的 TOOL_OPEN 不展示；
 * - 没有对应展示的片段直接丢弃。
 */
const toBlocks = (fragments: Fragment[], messageId: string): ReplyBlock[] => {
  const searchKind = fragments.some(
    (item) => item.type === 'TOOL_OPEN' || item.type === 'TOOL_FIND'
  )
    ? 'deep_search'
    : 'search'
  return fragments.flatMap((item, index): ReplyBlock[] => {
    const id = `history-${messageId}-${index}`
    switch (item.type) {
      case 'RESPONSE':
        return [{ type: 'text', text: item.content }]
      case 'TEMPLATE_RESPONSE':
        return [{ type: 'text', text: item.content, isTemplate: true }]
      case 'THINK':
        return [
          {
            type: 'thinking',
            thinking: item.content,
            ...(item.elapsed_secs === null ? {} : { elapsedSeconds: item.elapsed_secs }),
          },
        ]
      case 'TOOL_SEARCH':
        return toolBlocks(
          id,
          { action: 'search', query: item.queries[0] ?? '', queries: item.queries },
          searchKind,
          item.status === 'WIP'
            ? undefined
            : {
                type: 'web_search_tool_result',
                tool_use_id: id,
                kind: searchKind,
                content:
                  item.status === 'FAILED'
                    ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
                    : item.results
                        .filter((result) => isWebUrl(result.url))
                        .map((result) => ({
                          type: 'web_search_result',
                          url: result.url,
                          title: result.title,
                          snippet: result.snippet,
                          site_icon:
                            result.site_icon && isWebUrl(result.site_icon)
                              ? result.site_icon
                              : null,
                          site_name: result.site_name,
                          page_age: result.published_at,
                          encrypted_content: '',
                        })),
              }
        )
      case 'TOOL_OPEN':
        if (!item.url || !isWebUrl(item.url)) {
          return []
        }
        return toolBlocks(
          id,
          { action: 'open_page', url: item.url },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(
                id,
                item.status === 'FINISHED'
                  ? fetched(item.url, item.title, item.published_at)
                  : unavailable
              )
        )
      case 'TOOL_FIND':
        return toolBlocks(
          id,
          { action: 'find_in_page', url: '', pattern: item.pattern ?? '' },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(id, item.status === 'FINISHED' ? fetched('', null, null) : unavailable)
        )
      case 'READ_LINK':
        return item.results.flatMap((result, resultIndex) => {
          const url = result.url && isWebUrl(result.url) ? result.url : ''
          if (!url && !result.signature.trim()) {
            return []
          }
          const toolId = `${id}-${resultIndex}`
          return toolBlocks(toolId, { action: 'read_link', url }, 'read_link', {
            type: 'web_fetch_tool_result',
            tool_use_id: toolId,
            kind: 'read_link',
            content: fetched(url, result.title ?? null, null),
            signature: result.signature,
          })
        })
      default:
        return []
    }
  })
}

/** 统一为正式回复状态：失败不进入上下文，未完成的按已停止处理。 */
const replyStatus: Record<ChatMessage['status'], ReplyStatus> = {
  FINISHED: 'done',
  CONTENT_FILTER: 'done',
  FAILED: 'error',
  CONTEXT_LENGTH_EXCEEDED: 'error',
  INCOMPLETE: 'stopped',
  TIMEOUT: 'error',
  WIP: 'stopped',
}

const toAssistant = (message: ChatMessage): AssistantMessage => {
  const id = String(message.id)
  const blocks = toBlocks(message.fragments, id)
  const refused = message.status === 'CONTENT_FILTER'
  return {
    id,
    role: 'assistant',
    createdAt: time(message.inserted_at),
    model: null,
    thinking: message.thinking_enabled,
    search: message.search_enabled,
    prefix: false,
    status: replyStatus[message.status],
    // 拒绝回复丢弃模型正文和思考，保留模板提示与工具步骤。
    ...(refused ? { stopReason: 'refusal' as const } : {}),
    blocks: refused
      ? blocks.filter(
          (block) => block.type !== 'thinking' && (block.type !== 'text' || block.isTemplate)
        )
      : blocks,
  }
}

/**
 * 按 id 排序还原消息树：父消息的 id 必须更小、角色交替、根为提问。
 * current_message_id 到根的路径为当前分支；其余节点默认选中 id 最大的子消息。
 */
const buildTree = (
  file: SessionFile
): Pick<Session, 'messages' | 'rootMessageId'> & { skipped: ImportSkip[] } => {
  // 不用 Array.prototype.toSorted：它是 ES2023（Chrome/WebView 110+），旧 Android WebView 会直接抛
  // 「e.messages.toSorted is not a function」，导致导入全部失败。复制后排序，保持“不改入参”的原语义。
  const sorted = [...file.messages].sort((a, b) => a.id - b.id)
  const byId = new Map<number, Message>()
  const skipped: ImportSkip[] = []
  // 单条消息损坏只丢这一条（#49）：父消息缺失会让它的子消息陆续被丢，每条都记下来便于定位。
  const skipMessage = (message: ChatMessage, reason: TranslationKey) => {
    skipped.push({
      scope: 'message',
      sessionId: file.id,
      sessionTitle: file.title ?? '',
      messageId: String(message.id),
      parentId: message.parent_id === null ? null : String(message.parent_id),
      reason,
    })
  }
  const messages = sorted.flatMap((message) => {
    const { id, parent_id } = message
    const parent = parent_id === null ? undefined : byId.get(parent_id)
    if (
      byId.has(id) ||
      (parent_id === null ? message.role !== 'USER' : !parent) ||
      (parent && parent.role === (message.role === 'USER' ? 'user' : 'assistant'))
    ) {
      skipMessage(message, 'backupInvalidBranches')
      return []
    }
    const local = message.role === 'USER' ? toUser(message) : toAssistant(message)
    local.parentId = parent ? parent.id : null
    if (parent) {
      parent.selectedChildId = local.id
    }
    byId.set(id, local)
    return [local]
  })
  if (messages.length === 0) {
    return { messages, rootMessageId: null, skipped }
  }
  let current = byId.get(file.current_message_id)
  if (!current) {
    // 当前分支指针指向不存在 / 已被丢弃的消息：回退到最深的一条链，不中断整次导入。
    skipped.push({
      scope: 'branch',
      sessionId: file.id,
      sessionTitle: file.title ?? '',
      messageId: String(file.current_message_id),
      parentId: null,
      reason: 'backupInvalidBranches',
    })
    current = deepest(messages, byId)
  }
  // 当前消息就是用户停留的位置，后面即使还有消息也不继续展开。
  current.selectedChildId = undefined
  while (current.parentId) {
    const parent = byId.get(Number(current.parentId))
    if (!parent) {
      // 容忍模式下父链必定完整；留一手防御，坏数据也只丢分支不抛错。
      break
    }
    parent.selectedChildId = current.id
    current = parent
  }
  return { messages, rootMessageId: current.id, skipped }
}

/** 分支指针损坏时的兜底：取最深的一条消息，沿父链回溯出的链就是默认展示分支。 */
const deepest = (messages: Message[], byId: Map<number, Message>): Message => {
  let best = messages[messages.length - 1]
  let bestDepth = -1
  for (const message of messages) {
    let depth = 0
    let current: Message | undefined = message
    while (current?.parentId) {
      depth += 1
      current = byId.get(Number(current.parentId))
      if (depth > messages.length) {
        break
      }
    }
    if (depth >= bestDepth) {
      bestDepth = depth
      best = message
    }
  }
  return best
}

/**
 * 转换单个会话并收集被跳过的条目，坏数据不抛错（#49）。
 * 整个会话无法构造时返回 ok=false，由调用方把它记进 skipped 后继续处理其余会话。
 */
export const toLocalSessionResult = (file: SessionFile): LocalSessionResult => {
  const tree = buildTree(file)
  if (tree.messages.length === 0) {
    tree.skipped.push({
      scope: 'session',
      sessionId: file.id,
      sessionTitle: file.title ?? '',
      messageId: null,
      parentId: null,
      reason: 'backupInvalidBranches',
    })
    return { ok: false, reason: 'backupInvalidBranches', skipped: tree.skipped }
  }
  const session: Session = {
    id: file.id,
    // 空标题按「新对话」显示，导出时还原为 null。
    title: file.title ?? '',
    createdAt: time(file.inserted_at),
    updatedAt: time(file.updated_at),
    messages: tree.messages,
    rootMessageId: tree.rootMessageId,
    // #831：分支来源原样带回。**父会话在不在本机不影响导入** —— 徽标层面降级为
    // 「来源已不在本机」（见 components/session/SessionBranchBadge.tsx），不是导入失败。
    ...(file.branch_of === undefined
      ? {}
      : {
          branchOf: {
            sessionId: file.branch_of.session_id,
            createdAt: time(file.branch_of.created_at),
            ...(file.branch_of.message_id === null
              ? {}
              : { messageId: file.branch_of.message_id }),
          },
        }),
  }
  const images = new Map<string, string>()
  let filesBroken = false
  for (const message of file.messages) {
    for (const item of message.fragments) {
      if (item.type !== 'FILE') {
        continue
      }
      for (const entry of item.files) {
        if (!entry.is_image) {
          continue
        }
        // 读取端把条目名规范为 NFC，引用也按同样规则比较。
        const path = entry.export_path?.normalize('NFC')
        if (path === undefined) {
          continue
        }
        // 图片只能在本会话目录下，同一条目不能对应不同文件。
        if (
          !path.startsWith(sessionFilesDir(file.id)) ||
          (images.get(path) ?? entry.id) !== entry.id
        ) {
          filesBroken = true
          continue
        }
        images.set(path, entry.id)
      }
    }
  }
  if (filesBroken) {
    tree.skipped.push({
      scope: 'session',
      sessionId: file.id,
      sessionTitle: file.title ?? '',
      messageId: null,
      parentId: null,
      reason: 'backupInvalidFiles',
    })
    return { ok: false, reason: 'backupInvalidFiles', skipped: tree.skipped }
  }
  return { ok: true, session: { session, images }, skipped: tree.skipped }
}

/**
 * 旧入口（兼容既有调用方）：整个会话不可用时仍抛错，
 * 单条消息损坏已经降级为 skipped，不再影响其余会话。
 */
export const toLocalSession = (file: SessionFile): LocalSession => {
  const result = toLocalSessionResult(file)
  if (result.ok) {
    return result.session
  }
  return fail(result.reason)
}
