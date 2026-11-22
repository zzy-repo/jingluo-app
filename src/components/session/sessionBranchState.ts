/**
 * #831「分支会话」确认弹层的开合状态。
 *
 * 为什么单独一个 zustand store（与 `searchPanelState` / `settingsDialogState` 同一套写法）：
 * 入口有两个 —— 会话列表的「更多」菜单（完整分支）和回答下方的按钮（节点分支）——
 * 它们分处两棵子树，弹层本体挂在 `App` 上。用一份请求态比让两个入口各自挂一个 Modal 干净，
 * 也不会出现「两个弹层同时开着」。
 */
import { create } from 'zustand'

export type SessionBranchDialogRequest = {
  /** 父会话 id */
  sessionId: string
  /** 分叉点消息 id；缺省 = 完整分支 */
  messageId?: string
}

type SessionBranchDialogState = {
  /** null = 弹层关着 */
  request: SessionBranchDialogRequest | null
}

export const useSessionBranchDialog = create<SessionBranchDialogState>(() => ({ request: null }))

export const openSessionBranchDialog = (request: SessionBranchDialogRequest) =>
  useSessionBranchDialog.setState({ request })

export const closeSessionBranchDialog = () => useSessionBranchDialog.setState({ request: null })
