import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { prefersReducedMotion } from '../../utils/usePresence.js'
import {
  anchorShift,
  pickAnchor,
  type RowSpan,
  type ScrollAnchor,
} from '../../utils/scrollAnchor.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext, ScrollToBottomStateContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import { DEFAULT_ESTIMATE, VirtualRows } from './virtualRows.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/**
 * #386：距底部超过该值时，输入框上方才浮现「回到底部」按钮。
 * 比 `STICKY_THRESHOLD`（40）大得多是刻意的 —— 刚离开底部一两行还在视野里，
 * 这时候弹按钮只会挡住正文；翻上去一两屏才是真的需要它。
 */
const TO_BOTTOM_THRESHOLD = 200
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

/**
 * #386：平滑滚到最底部。
 *
 * 老内核不认 `scrollTo` 的 options 对象时会把对象当成坐标（NaN，静默不动），
 * 所以先用 `scrollBehavior` 特性检测兜一层，再用 try/catch 兜一层，两条都不成立就
 * 直接赋值 scrollTop —— 功能不丢，只是没有过渡。系统要求「减少动态效果」时同理：
 * 平滑滚动本身也是动态效果。
 */
const smoothScrollToBottom = (element: HTMLElement) => {
  if (prefersReducedMotion() || !('scrollBehavior' in element.style)) {
    element.scrollTop = element.scrollHeight
    return
  }
  try {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  } catch {
    element.scrollTop = element.scrollHeight
  }
}

/**
 * #610：读出挂载窗口里「锚点行」与「第一条可见行」为止的几行几何（内容坐标）。
 *
 * 只读到够用为止（锚点行 + 首条可见行），不遍历整份列表：长会话里挂载的行本来就只有
 * 视口 ± overscan 这一小段。行序与 DOM 顺序一致，所以拿到首条可见行就能提前收工。
 */
const readRowSpans = (
  scroll: HTMLElement,
  content: HTMLElement,
  anchorId: string | null
): RowSpan[] => {
  // 内容坐标原点：滚动容器自身的内容顶部（rect.top 是视口坐标，加回 scrollTop 即内容坐标）
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop
  const spans: RowSpan[] = []
  let foundAnchor = anchorId === null
  let foundVisible = false
  for (const row of content.querySelectorAll<HTMLElement>('[data-row-id]')) {
    const id = row.dataset.rowId
    if (!id) {
      continue
    }
    const box = row.getBoundingClientRect()
    spans.push({ id, top: box.top - base, height: box.height })
    if (id === anchorId) {
      foundAnchor = true
    }
    if (box.bottom - base > scroll.scrollTop) {
      foundVisible = true
    }
    if (foundAnchor && foundVisible) {
      break
    }
  }
  return spans
}

/**
 * 消息列表（虚拟化，Issue #45）。
 *
 * 只挂载视口附近的行：行高由 `ResizeObserver` 按行实测（流式增长的回答随时在变），
 * 未实测到的行用估值占位，滚动条长度靠上下占位撑住 —— 所以长会话的 DOM 节点数
 * 与历史总条数无关。窗口计算见 `virtualRows.ts`。
 */
export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  /** #386：点「回到底部」后平滑滚动是否还在路上（在路上时不写 scrollTop，否则动画被掐断） */
  const jumpRef = useRef(false)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  /** 消息 id → 实测高度；会话切换时清空，避免带上一个会话的估值。 */
  const heightsRef = useRef(new Map<string, number>())
  const measureRef = useRef<ResizeObserver | null>(null)
  const observedRowsRef = useRef(new Set<Element>())
  /**
   * #610：上一次提交时「第一条可见行」的锚点（id + 内容坐标系偏移）。
   * 行高实测回填 / 估值变化会改动上方占位，靠它把阅读位置钉住，见文件末尾那条 layout effect。
   */
  const anchorRef = useRef<ScrollAnchor | null>(null)
  /** #610：本帧的滚动位置是「故意挪的」（版本切换定位），不要被锚点修正拉回去。 */
  const skipAnchorRef = useRef(false)
  const sessionIdRef = useRef(session.id)
  // 实测结果存在 ref 里，靠这个版本的计数触发重算占位。
  const [, setMeasureVersion] = useState(0)
  const [metrics, setMetrics] = useState({ top: 0, viewport: 0 })
  const messages = getVisibleMessages(session)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (jumpRef.current) {
      // 平滑滚动还在路上：这时候写 scrollTop 会把原生动画掐掉（用户看到的就是「点了没动，然后瞬移」）。
      // 内容若又长高了，就朝新的底部再发起一次，落点始终是最新消息。
      smoothScrollToBottom(el)
      return
    }
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // #386：输入框上方「回到底部」按钮的状态。默认隐藏 —— 首次进会话就在底部，不该有按钮。
  const [toBottom, setToBottom] = useState({ visible: false, hasNew: false })
  const toBottomRef = useRef(toBottom)
  // 圆点只在流式期间点亮：虚拟列表上翻时行高会重新实测、内容高度跟着抖，
  // 只看「长高了」会把这种抖动当成新内容；流式里长高才是真的来了新 token。
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming

  /**
   * #386：按当前位置刷新按钮状态；只在布尔值真的变了才 setState（滚动事件每帧都来）。
   * @param grew 内容高度刚长高（流式追加 / 新消息）时为 true，记一条「有新内容」
   */
  const syncToBottom = useCallback((grew: boolean) => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > TO_BOTTOM_THRESHOLD
    const previous = toBottomRef.current
    const next = {
      visible: away,
      hasNew: away && ((grew && streamingRef.current) || previous.hasNew),
    }
    if (next.visible === previous.visible && next.hasNew === previous.hasNew) {
      return
    }
    toBottomRef.current = next
    setToBottom(next)
  }, [])

  /**
   * #386：点「回到底部」—— 先恢复跟随（后续新内容继续自动贴底），再滚到底。
   * 平滑滚动只在**真的支持**时用：`scrollBehavior` 特性检测 + try/catch 双保险，
   * 老 WebView 不认 options 对象时退回直接赋值（否则对象被当成坐标，滚不动）。
   * 系统开了「减少动态效果」时也直接跳 —— 平滑滚动同样是动态效果。
   */
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    // 先恢复跟随：动画落地后新内容继续自动贴底（这是 Issue 验收里的「点击后恢复跟随」）
    stickyRef.current = true
    jumpRef.current = true
    smoothScrollToBottom(el)
  }, [])

  // 行实测高度 → 未实测行的估值。用已实测高度的均值，比固定常量更接近真实内容。
  let measuredSum = 0
  let measuredCount = 0
  for (const height of heightsRef.current.values()) {
    measuredSum += height
    measuredCount += 1
  }
  const estimate =
    measuredCount === 0
      ? DEFAULT_ESTIMATE
      : Math.max(DEFAULT_ESTIMATE / 2, Math.round(measuredSum / measuredCount))

  const measured = messages.map((message) => heightsRef.current.get(message.id))

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      setMetrics((previous) =>
        previous.viewport === scroll.clientHeight
          ? previous
          : { ...previous, viewport: scroll.clientHeight }
      )
      scrollToBottom()
      // 内容长高而用户已经翻上去时不会触发 scroll 事件，只能在这里补一次判断（#386）
      syncToBottom(entries.some((entry) => entry.target === content))
    })
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom, syncToBottom])

  // 单例行高实测：挂载/卸载行时订阅、退订，高度变化（流式增长、版本切换）时重算占位。
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const id = target.dataset.rowId
        if (!id || !target.isConnected) {
          continue
        }
        const blockSize = entry.borderBoxSize?.[0]?.blockSize
        const height =
          typeof blockSize === 'number' && blockSize > 0
            ? blockSize
            : target.getBoundingClientRect().height
        if (!(height > 0)) {
          continue
        }
        const previous = heightsRef.current.get(id)
        if (previous === undefined || Math.abs(previous - height) >= 0.5) {
          heightsRef.current.set(id, height)
          changed = true
        }
      }
      if (changed) {
        setMeasureVersion((version) => version + 1)
      }
    })
    measureRef.current = observer
    return () => {
      observer.disconnect()
      measureRef.current = null
      observedRowsRef.current = new Set()
    }
  }, [])

  // 每次提交后同步「当前挂载了哪些行」，让实测覆盖到新进窗口的行，并退订已卸载的行。
  useLayoutEffect(() => {
    const observer = measureRef.current
    const content = contentRef.current
    if (!observer || !content) {
      return
    }
    const next = new Set<Element>()
    for (const row of content.querySelectorAll<HTMLElement>('[data-row-id]')) {
      next.add(row)
      observer.observe(row)
    }
    for (const row of observedRowsRef.current) {
      if (!next.has(row)) {
        observer.unobserve(row)
      }
    }
    observedRowsRef.current = next
  })

  // 会话切换：上一个会话的实测高度不再有意义，清空后重新量。
  useLayoutEffect(() => {
    if (sessionIdRef.current !== session.id) {
      sessionIdRef.current = session.id
      heightsRef.current.clear()
      anchorRef.current = null
      setMeasureVersion((version) => version + 1)
    }
  }, [session.id])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
        // 这一跳是「把版本选择器留在原处」的故意定位，本帧不再做阅读位置修正（#610）
        skipAnchorRef.current = true
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const sync = () => {
      setMetrics((previous) =>
        previous.top === el.scrollTop && previous.viewport === el.clientHeight
          ? previous
          : { top: el.scrollTop, viewport: el.clientHeight }
      )
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    sync()
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
        // 平滑滚动落地（或用户自己滑回底部）：跟随逻辑可以正常写位置了
        jumpRef.current = false
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
        jumpRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      sync()
      // 用户翻到离底部超过阈值 → 按钮浮现；回到贴底区 → 按钮与「有新内容」圆点一起收掉
      syncToBottom(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom, syncToBottom])

  /**
   * #610（症状二）：把阅读位置钉住。
   *
   * 虚拟列表的行高是实测出来的，没实测的用估值（实测均值）。窗口里新挂上一行、或流式回答长高，
   * 都会改动上方占位的总高 —— 同一份 scrollTop 下，用户正在读的那一行就跳一段，
   * 表现出来正是长会话上滑「滚到某个位置被弹回去」。这里每次提交后记下第一条可见行
   * （`pickAnchor`），下一次提交算出它移动了多少（`anchorShift`），再把这个量补进 scrollTop。
   * layout effect 阶段执行，早于绘制，所以不会闪中间态。
   *
   * 三种情况不修正：贴底跟随（#386 由 scrollToBottom 负责）、版本切换的故意定位、
   * 以及锚点行已经不在列表里（编辑截断 / 删消息 —— 这时宁可不挪）。
   */
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const skip = skipAnchorRef.current
    skipAnchorRef.current = false
    const rows = readRowSpans(scroll, content, anchorRef.current?.id ?? null)
    if (!skip && !stickyRef.current && !jumpRef.current) {
      const shift = anchorShift(anchorRef.current, rows)
      if (Math.abs(shift) >= 0.5) {
        scroll.scrollTop += shift
        scrollTopRef.current = scroll.scrollTop
      }
    }
    // 下一次提交的参照：本帧第一条可见行（内容坐标，滚动不会让它失效）
    anchorRef.current = pickAnchor(rows, scroll.scrollTop)
  })

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const renderItem = useCallback(
    (message: Message, index: number) =>
      message.role === 'user' ? (
        <UserMessage
          sessionId={session.id}
          message={message}
          retryUploadId={uploadRetryId}
          isFirst={index === 0}
          isLast={index === lastIndex || index === lastIndex - 1}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
        />
      ) : (
        <AssistantMessage
          sessionId={session.id}
          message={message}
          isLast={index === lastIndex}
          streaming={streaming && index === lastIndex}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
        />
      ),
    [lastIndex, selectVersion, session.id, streaming, uploadRetryId, versions]
  )

  // 按钮挂在输入区里（输入框上方），所以状态与动作从列表这一层传给 footer 子树
  const toBottomState = useMemo(
    () => ({ ...toBottom, jump: jumpToBottom }),
    [toBottom, jumpToBottom]
  )

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <ScrollToBottomStateContext.Provider value={toBottomState}>
        <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              <VirtualRows
                items={messages}
                measured={measured}
                estimate={estimate}
                scrollTop={metrics.top}
                viewport={metrics.viewport}
                anchorEnd={stickyRef.current}
                getId={(message) => message.id}
                renderItem={renderItem}
              />
            </div>
          </div>
          {footer}
        </div>
      </ScrollToBottomStateContext.Provider>
    </ScrollToBottomContext.Provider>
  )
}
