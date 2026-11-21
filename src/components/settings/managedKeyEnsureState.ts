/**
 * 「登录 / 注册后自动拿 Key」这条后台流程的**可见状态**（Issue #803 第 5 条）。
 *
 * 为什么要单独一个 store 而不是写在 runtime 里：runtime 是 `.ts` 的副作用层（发请求、落盘），
 * 界面（`AccountConsumePage` 的内置服务子页）要**订阅**它跑到哪一步了 —— 两件事分开，
 * 界面就不会为了一个状态位去 import 领取链路，而且「失败必须可见」这条要求有一个明确的落点：
 * 只有 `status === 'failed'` 时才有 `failure`，界面照它出「原因 + 重试」。
 *
 * 三条约定：
 *  1. **失败必须带得住**：`failure` 里有 `kind` / `status` / `code`，界面与日志都能取，
 *     绝不出现「失败了但说不清为什么」（#803 正文里那一轮全 401 就是这么被咽下去的）；
 *  2. **不存凭据**：这里只放失败的性质与进度，Key 原文 / token 一个字都不进（#387 红线）；
 *  3. **切号即清**：整块状态是账号维度的（A 的失败提示不许留在 B 的界面上），
 *     所以 `managedKeyRuntime` 在模块初始化时把它登记进 `sessionCache`（见该文件的末尾）。
 */
import { create } from 'zustand'
import type { ManagedKeyFailure } from '../../services/api/managedKey.js'

/** `idle` = 没在跑也没有失败；`running` = 正在「查重 → 建 → 重试」；`failed` = 两次都没拿到 */
export type ManagedKeyEnsureStatus = 'idle' | 'running' | 'failed'

/**
 * 失败时**定位用**的两条现场信息（#812 第 4 条）。
 *
 * 有了它们，下次看板上的一句提示就能回答「哪把 Key、打到哪个地址」——
 * #812 的现场是「Key 有效但提示 Key 无效」，缺的正是这两条：Key 前 6 位说明用的是哪一把，
 * 请求地址说明它被打到了哪个环境（staging 的 Key 打到生产网关，必然 401）。
 */
export type ManagedKeyEnsureContext = {
  /** 当前用于推理的 Key 的**前 6 位**（`sk-xxx`；不是钥匙本体，够定位即可） */
  keyPrefix: string
  /** 这把 Key 会被打到的**推理请求地址**（当前生效的 `getMessagesUrl()`） */
  requestUrl: string
}

export type ManagedKeyEnsureState = {
  status: ManagedKeyEnsureStatus
  /** 最后一次失败（`status === 'failed'` 时非空；拿它出「原因 + 状态码」） */
  failure: ManagedKeyFailure | null
  /** 这一次一共尝试了几次（1 = 没重试；2 = 重试过）—— 界面据此说「已自动重试一次」 */
  attempts: number
  /** 失败现场（Key 前 6 位 + 推理地址）；成功时清空 */
  context: ManagedKeyEnsureContext | null
}

export const useManagedKeyEnsure = create<ManagedKeyEnsureState>(() => ({
  status: 'idle',
  failure: null,
  attempts: 0,
  context: null,
}))

/**
 * 开始一次「确保有 Key」（并发触发时由 runtime 的单飞挡住，这里只反映最新一次）。
 *
 * **不清 `failure`**：用户点「重试」的瞬间提示不该闪没（界面按 `status === 'running'` 只把按钮置灰），
 * 下一次成功才把它收掉（`markManagedKeyEnsureOk`）。
 */
export const markManagedKeyEnsureRunning = (): void => {
  useManagedKeyEnsure.setState({ status: 'running' })
}

/** 成功：把上一次的失败提示收掉（不清 `attempts`，成功也要能说清「重试过一次才成功」） */
export const markManagedKeyEnsureOk = (attempts: number): void => {
  useManagedKeyEnsure.setState({ status: 'idle', failure: null, attempts, context: null })
}

/**
 * 两次都失败：留下原因 + 次数 + **现场**，界面必须据此出提示与「重试」（不许静默失败）。
 *
 * `context` 是 #812 加的：状态码只说「服务端回了什么」，说不清「用的是哪把 Key、打到哪」——
 * 而 #812 的现场恰恰是这两条决定的（staging 的 Key 打到生产网关 → 401「Key 无效」）。
 */
export const markManagedKeyEnsureFailed = (
  failure: ManagedKeyFailure,
  attempts: number,
  context: ManagedKeyEnsureContext | null = null
): void => {
  useManagedKeyEnsure.setState({ status: 'failed', failure, attempts, context })
}

/** 清空（切号 / 退出登录 / 用户手动重试前） */
export const resetManagedKeyEnsure = (): void => {
  useManagedKeyEnsure.setState({ status: 'idle', failure: null, attempts: 0, context: null })
}
