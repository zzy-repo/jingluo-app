/**
 * 「模型来源」单层手风琴的**运行时接线**（Issue #807）：把纯逻辑（`sourceAccordion.ts`）
 * 接到真实的三样东西上 —— 存储（`apiConfig`）、领取链路（`managedKeyRuntime`）、错误分类（`panels`）。
 *
 * 为什么单独一个 `.ts`（而不是写在 `AccountConsumePage.tsx` 里）：
 *  - 组件在裸 Node 单测里 import 不了，而这里有三条会被验收的顺序
 *    （先校验 → 再落盘 → 最后切生效来源；未登录 → 不发请求；领取成功 → 才选中），值得被读被改；
 *  - 「正在查看」与「正在使用」的分界必须只有一处：**只有这里的两个函数**会调用
 *    `setProviderKind()`，界面手风琴的展开/收起一次都不碰它。
 *
 * 三条边界（沿用 #596 / #800 的纪律，别退回）：
 *  1. 内置服务的 Key **只在后台落盘**（`applyManagedKey`：Key + 下发标记一起写），界面不展示、
 *     不提供复制、也没有「重新领取」按钮；
 *  2. Key 原文只在内存里过一手，日志只记尾号 / 动作 / 结果；
 *  3. 领取失败原样交给 `toPanelError()`（#771 / #484 的分类），这里不自己编文案。
 */
import {
  getApiKey,
  getProviderKind,
  getServerKeyMark,
  readSourceField,
  setApiKey,
  setBaseUrlFor,
  setModelFor,
  setProviderKind,
  thirdPartyEntryKind,
} from '../../services/api/apiConfig.js'
import { managedKeyVerdict } from '../../services/api/managedKey.js'
import type { ProviderKind } from '../../services/api/providers.js'
import { toPanelError, type PanelError } from '../consume/panels.js'
import { claimManagedKeyForDevice } from './managedKeyRuntime.js'
import type { TranslationKey } from '../../i18n/index.js'
import {
  checkSourceDraft,
  rowOfKind,
  type DraftErrorField,
  type DraftRowKey,
  type SourceDraft,
  type SourceRowKey,
} from './sourceAccordion.js'

/** 生效来源是哪一行（打勾的那一行）—— 只读存储，**不写**任何东西 */
export const effectiveRow = (): SourceRowKey => rowOfKind(getProviderKind())

/** 这一行自己那一份够不够用（行头状态 / 「确认使用」后的 ✓ 都看它） */
export const rowConfigured = (row: SourceRowKey): boolean => {
  if (row === 'builtin') {
    // 内置服务要的是**服务端下发的那把**：旧 Key / 手填 Key 都不算（#596 的三类事故就从这儿进）
    return managedKeyVerdict({ localKey: getApiKey(), mark: getServerKeyMark() }) === 'ok'
  }
  // 第三方 / 官方：Key 是四个渠道共用的一把，非空即可（地址 / 模型在「确认使用」时校验）
  return getApiKey().trim() !== ''
}

/** 第三方行要落到的槽位（#794：两种协议一个槽位，判定复用 `thirdPartyEntryKind`） */
export const thirdRowKind = (): ProviderKind => thirdPartyEntryKind()

/**
 * 读某一行的草稿（首次展开 / 重启后都走这里）。
 *
 * 草稿 = 那一槽已存的值，**没有第二份草稿存储**：收起/展开只是界面状态，值一直在既有的
 * `chat-demo:base-url:<kind>` / `chat-demo:model:<kind>` / `chat-demo:api-key` 里。
 */
export const readSourceDraft = (row: DraftRowKey): SourceDraft => {
  const kind: ProviderKind = row === 'third' ? thirdRowKind() : 'deepseek'
  return {
    baseUrl: readSourceField(kind, 'baseUrl'),
    apiKey: getApiKey(),
    model: readSourceField(kind, 'model'),
  }
}

/** 一起读两行的草稿（页面初始化用） */
export const readSourceDrafts = (): Record<DraftRowKey, SourceDraft> => ({
  third: readSourceDraft('third'),
  official: readSourceDraft('official'),
})

// ─────────────────────────────────────────────── 内置服务：行内领取（行即动作）

/**
 * 「登录成功后自动继续领取」的待办标记（③）。
 *
 * 为什么放在模块作用域而不是组件 state：未登录时面板会把用户送到「账号」页去登录，
 * 那一屏是同一个组件的另一个分支（state 还在），但用户也可能顺手关掉设置再打开 ——
 * 一个布尔待办放在这里最稳，而且**能被单测直接断言**（`takePendingBuiltinClaim`）。
 */
let pendingBuiltinClaim = false

export const markPendingBuiltinClaim = (): void => {
  pendingBuiltinClaim = true
}

export const hasPendingBuiltinClaim = (): boolean => pendingBuiltinClaim

/** 取出并清空（只消费一次：领取真正开始之后就没人再欠这一次了） */
export const takePendingBuiltinClaim = (): boolean => {
  const value = pendingBuiltinClaim
  pendingBuiltinClaim = false
  return value
}

/** 测试 / 退出登录时清掉，避免上一次的待办漏到下一次 */
export const resetPendingBuiltinClaim = (): void => {
  pendingBuiltinClaim = false
}

/** 行内领取的三种结局（`claimed` 时**已经**切到内置服务了） */
export type BuiltinClaimResult =
  | { kind: 'need-login' }
  | { kind: 'claimed' }
  | { kind: 'failed'; error: PanelError }

/**
 * 内置服务行内领取：**拿到 Key 之后才允许选中**。
 *
 * 顺序是验收的一部分，不许调换：
 *  1. 未登录 → `need-login`，**一个请求都不发**（顺便记下「登录后自动继续」）；
 *  2. 领取（`claimManagedKeyForDevice({ rotate: false })`：按设备固定名幂等领取，与 #800 的
 *     启动对齐同一条链路、同一个 Key 名，不会因为用户点了一次就多长出一把）；
 *  3. 只有 `ok` 才 `setProviderKind('ours')` —— 失败/超时**不选中**，行内给原因 + 重试。
 */
export const claimBuiltinKey = async (options: { signedIn: boolean }): Promise<BuiltinClaimResult> => {
  if (!options.signedIn) {
    markPendingBuiltinClaim()
    return { kind: 'need-login' }
  }
  const result = await claimManagedKeyForDevice({ rotate: false })
  if (!result.ok) {
    return { kind: 'failed', error: toPanelError(result.error) }
  }
  // 票面 ④：拿到 key 之后**才**允许选中（`applyManagedKey` 已在上面那次调用里落盘）
  setProviderKind('ours')
  resetPendingBuiltinClaim()
  return { kind: 'claimed' }
}

/** 已经有服务端那把 —— 点这一行就直接设成当前来源（不再领取、不再发请求） */
export const selectBuiltin = (): void => {
  setProviderKind('ours')
}

// ─────────────────────────────────────────── 第三方 / 官方：「确认使用」

/** 「确认使用」的结局 */
export type ConfirmSourceResult =
  | { kind: 'invalid'; field: DraftErrorField; messageKey: TranslationKey }
  | { kind: 'applied'; row: DraftRowKey; providerKind: ProviderKind; draft: SourceDraft }

/**
 * 「确认使用」：**校验通过才生效**。
 *
 * 只有这个函数（和上面的 `claimBuiltinKey`）会切生效来源：
 *  - 校验不过 → `invalid`（行内红字，**生效来源一个字都不动**，草稿照旧留着）；
 *  - 校验通过 → 先切槽位（`setProviderKind`，因为 `setBaseUrlFor` 要知道写给哪个 kind），
 *    再落盘地址 / 模型 / Key —— 落盘全走既有的 scoped 键，不新增存储。
 */
export const confirmSourceRow = (row: DraftRowKey, draft: SourceDraft): ConfirmSourceResult => {
  const check = checkSourceDraft(row, draft)
  if (!check.ok) {
    return { kind: 'invalid', field: check.field, messageKey: check.messageKey }
  }
  const kind: ProviderKind = row === 'third' ? thirdRowKind() : 'deepseek'
  setProviderKind(kind)
  if (row === 'third') {
    // 官方服务的地址 / 模型是内置的（`spec.fields` 里没有这两格），写不进去也不该写
    setBaseUrlFor(kind, check.draft.baseUrl)
    setModelFor(kind, check.draft.model)
  }
  setApiKey(check.draft.apiKey)
  return { kind: 'applied', row, providerKind: kind, draft: check.draft }
}
