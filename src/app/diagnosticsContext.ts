import { getApiKey, getModel, useApiConfig } from '../services/api/apiConfig.js'
import { useChatStore } from '../services/chat/store.js'
import type { SnapshotFacts } from '../services/diagnostics/collector.js'
import { asArray } from '../utils/safeArray.js'

/**
 * 应用侧的「当前状态」读取器：采集层只认这个函数的形状，不认识 chat store / apiConfig。
 * 每 30 秒的周期快照与每次关键动作后的快照都读它（会话数、附件数、provider/model、当前界面）。
 */
export const readDiagnosticsFacts = (): SnapshotFacts => {
  const chat = useChatStore.getState()
  const provider = useApiConfig.getState().kind
  // 只统计已加载会话里的附件引用数，不额外读库（快照要足够轻）。
  // messages / files 可能被存储写坏成 null：快照往往在错误路径上被调用，这里不能再抛一次（issue #28）
  const files = Object.values(chat.sessionCache).reduce(
    (total, session) =>
      total +
      asArray(session.messages).reduce(
        (count, message) => count + (message.role === 'user' ? asArray(message.files).length : 0),
        0
      ),
    0
  )
  const dialogOpen = typeof document !== 'undefined' && Boolean(document.querySelector('[role="dialog"]'))
  return {
    sessions: chat.sessions.length,
    files,
    provider,
    model: getModel() || 'unset',
    view: dialogOpen ? 'dialog' : chat.activeId ? 'session' : 'welcome',
    configured: Boolean(getApiKey()),
  }
}
