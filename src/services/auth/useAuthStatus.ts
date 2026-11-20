/**
 * 登录态的**只读视图**（Issue #608）。
 *
 * 拆掉登录墙之后，「要不要显示登录 UI」不再是入口的事，而是**每个局部区域自己的事**：
 * 账号区 / 我的额度 / 我的邀请各问一句 `authenticated`，未登录就画引导，而不是把人挡在门外。
 * 这个 hook 就是那句话的唯一出处 —— 判据只有一条：`state === 'authenticated'`
 * （「有 token」不算登录，`restored` 也不算；口径与 `AuthGate` 的放行分支一致）。
 *
 * 三个字段各有用途，别互相顶替：
 *  - `authenticated`：**能不能读账号数据**（余额 / Key / 邀请）。false 时面板不发请求、只画引导；
 *  - `restored`：启动恢复是否跑过。false 时面板先画「正在检查登录状态…」，
 *    别在还没问完就把「未登录」当结论（弱网下会闪一下引导再变数据）；
 *  - `expired`：上次会话过期（续期失败 / JWT 不认）。账号区据此多一句「登录已过期」，
 *    免得用户以为自己从没登录过。
 *
 * 为什么不做成 `AuthGate` 的一个变体：`AuthGate` 是「挡住 children」的语义，仍然被
 * L1 / golden 用例与局部场景引用；而这里要的是「**不挡任何东西**、只回答问题」。
 * 两者读同一份 store，不存在第二份状态。
 */

import { useAuthStore } from './store.js'
import type { AuthState, AuthUser } from './types.js'

export type AuthStatus = {
  /** 四态原样透出（`unauthenticated` / `authenticating` / `authenticated` / `expired`） */
  state: AuthState
  /** 判据只认这一个：`state === 'authenticated'` */
  authenticated: boolean
  /** 启动恢复是否已经跑过（false = 后台还在静默恢复） */
  restored: boolean
  /** 上次会话过期：账号区要说明原因，别让用户以为是从来没登录过 */
  expired: boolean
  /** 已登录的账号（未登录时 null） */
  user: AuthUser | null
}

/**
 * 读当前登录态。返回值是**每帧新算的普通对象**（不 memo 也能安全用在 effect 依赖里：
 * 四个字段都是原始值 / store 引用，`user` 由 store 保证引用稳定）。
 */
export const useAuthStatus = (): AuthStatus => {
  const state = useAuthStore((store) => store.state)
  const restored = useAuthStore((store) => store.restored)
  const user = useAuthStore((store) => store.user)
  return {
    state,
    authenticated: state === 'authenticated',
    restored,
    expired: state === 'expired',
    user,
  }
}
