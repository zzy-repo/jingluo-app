/**
 * 「账户与消费」页的四个面板（W1-C2 #487）的**唯一入口**。
 *
 * 页面外壳（W1-C1 的 `AccountConsumePage.tsx`）按 tab 挂载其中一个即可：
 *
 * ```tsx
 * import { QuotaPanel, AccountPanel, InvitePanel, EmailBindPanel } from '../components/consume/index.js'
 *
 * <QuotaPanel consume={consume} onNeedLogin={goLogin} />
 * <AccountPanel consume={consume} user={user} onNeedLogin={goLogin} />
 * <InvitePanel consume={consume} />
 * <EmailBindPanel consume={consume} />
 * ```
 *
 * 四个面板都是**自包含**的：各自带 loading / 空 / 错误三态，自己拉数据，不依赖外部状态机；
 * 唯一的外向依赖是 `onNeedLogin`（会话失效时交给外壳切登录）与 `user`（外壳已知道的账号，可省一次闪烁）。
 *
 * `consume` 的类型就是 `createConsumeClient()` 的返回值（W1-A / PR #494），不另造接口。
 */
export { AccountPanel, type AccountPanelProps } from './AccountPanel.js'
export { EmailBindPanel, type EmailBindPanelProps } from './EmailBindPanel.js'
export { InvitePanel, type InvitePanelProps } from './InvitePanel.js'
export { QuotaPanel, type QuotaPanelProps } from './QuotaPanel.js'
