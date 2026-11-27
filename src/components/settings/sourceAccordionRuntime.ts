/**
 * 「模型来源」单层手风琴的**运行时接线**（Issue #807）：把纯逻辑（`sourceAccordion.ts`）
 * 接到真实的三样东西上 —— 存储（`apiConfig`）、领取链路（`managedKeyRuntime`）、错误分类（`panels`）。
 *
 * 为什么单独一个 `.ts`（而不是写在 `AccountConsumePage.tsx` 里）：
 *  - 组件在裸 Node 单测里 import 不了，而这里有三条会被验收的顺序
 *    （先校验 → 再落盘 → 最后切生效来源；未登录 → 不发请求；领取成功 → 才选中），值得被读被改；
 *  - 界面手风琴的展开/收起不切渠道，确认来源与领取成功才切换。
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
  recordConfigRejection,
  setApiKey,
  setBaseUrlFor,
  setModelFor,
  setProviderKind,
  thirdPartyEntryKind,
} from '../../services/api/apiConfig.js'
import { managedKeyVerdict } from '../../services/api/managedKey.js'
import type { ProviderKind } from '../../services/api/providers.js'
import { toPanelError, type PanelError } from '../consume/panels.js'
import { ensureDeviceBuiltinKey } from './managedKeyRuntime.js'
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

/** 行内领取的结局（`claimed` 时已经切到内置服务） */
export type BuiltinClaimResult =
  | { kind: 'need-login' }
  | { kind: 'claimed' }
  | { kind: 'superseded' }
  | { kind: 'failed'; error: PanelError }

/**
 * 内置服务行内领取：**拿到 Key 之后才允许选中**。
 *
 * 顺序是验收的一部分，不许调换：
 *  1. 未登录 → `need-login`，**一个请求都不发**（顺便记下「登录后自动继续」）；
 *  2. 与登录后自动领取共用同一次请求；
 *  3. 成功时密钥和渠道均已保存。失败或超时则在行内显示原因。
 */
export const claimBuiltinKey = async (options: { signedIn: boolean }): Promise<BuiltinClaimResult> => {
  if (!options.signedIn) {
    markPendingBuiltinClaim()
    return { kind: 'need-login' }
  }
  const result = await ensureDeviceBuiltinKey('select')
  if (result.outcome === 'signed-out') {
    markPendingBuiltinClaim()
    return { kind: 'need-login' }
  }
  if (result.outcome === 'superseded') {
    return { kind: 'superseded' }
  }
  if (result.outcome === 'failed') {
    const failure = result.failure
    if (failure.error) {
      return { kind: 'failed', error: toPanelError(failure.error) }
    }
    const saveFailed = failure.stop === 'save-failed'
    return {
      kind: 'failed',
      error: {
        i18nKey: saveFailed ? 'settingsManagedKeyFailStorage' : 'settingsManagedKeyFailEmpty',
        code: saveFailed ? 'KEY_NOT_SAVED' : 'EMPTY_KEY',
        retryable: true,
        needLogin: false,
      },
    }
  }
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
  /**
   * #986：校验过了，但**本机存储没写进去**（`setApiKey` / `setProviderKind` 等返回 false）。
   * 与 `invalid` 分开是为了实话实说：这不是「你填错了」，是「这台设备存不下」。
   * 走到这里时**磁盘与内存态都已经回到点之前**（下面的整体回滚），一个字都没留下。
   */
  | { kind: 'not-saved'; field: DraftErrorField; messageKey: TranslationKey }
  | { kind: 'applied'; row: DraftRowKey; providerKind: ProviderKind; draft: SourceDraft }

/**
 * 「确认使用」：**校验通过才生效**。
 *
 *  - 校验不过 → `invalid`（行内红字，**生效来源一个字都不动**，草稿照旧留着）；
 *  - 校验通过 → 先切槽位（`setProviderKind`，因为 `setBaseUrlFor` 要知道写给哪个 kind），
 *    再落盘地址 / 模型 / Key —— 落盘全走既有的 scoped 键，不新增存储；
 *  - 落盘失败 → `not-saved`（#986）：**整体回滚**到点之前，绝不留在「半个新渠道」的状态。
 *    旧写法把四个 `write()` 的返回值全丢了：kind 写失败时磁盘上是旧渠道、界面上是新渠道，
 *    用户接着发出去的内容按旧渠道走 —— 「切了但没生效」既没提示也没有留痕。
 */
export const confirmSourceRow = (row: DraftRowKey, draft: SourceDraft): ConfirmSourceResult => {
  const check = checkSourceDraft(row, draft)
  if (!check.ok) {
    /**
     * 配置保存被拒**也要留痕**（与旧 store 形态的 `BaseUrlField.save()` / `settingsDialogState`
     * 同一口径，`recordConfigRejection(field, reason)` → 诊断里的 `config_change / provider-<field>`
     * 且 `result=rejected`）。
     *
     * 为什么必须记在这里：这一页把地址 / 模型 / Key 全收进**草稿**，落盘只剩「确认使用」这一个
     * 入口（`mode: 'draft'` 的输入框只回调 `draft.onChange`，不写存储）。所以草稿形态下，
     * 校验失败的那一瞬间就是**唯一**能记的时刻 —— 不记，「点了确认没反应」这类问题在日志里
     * 一个字都查不到（旧 store 形态里那次 `config_change` 就是这么来的）。
     *
     * `reason` 沿用旧口径的两个值：必填格没填是 `required`，填了但不合法是 `invalid`。
     * 只记字段名与判定档位，草稿内容（含 Key 原文）一个字都不进日志。
     */
    recordConfigRejection(
      check.field,
      check.messageKey === 'settingsTestApiKeyRequired' || check.messageKey === 'settingsBaseUrlRequired'
        ? 'required'
        : 'invalid'
    )
    return { kind: 'invalid', field: check.field, messageKey: check.messageKey }
  }
  const kind: ProviderKind = row === 'third' ? thirdRowKind() : 'deepseek'
  // 回滚用的现场：点这一下之前的生效来源 + 目标槽位的地址/模型 + 共用那把 Key。
  // 全部只从既有存储读（`readSourceField` / `getApiKey`），不留第二份状态。
  const previousKind = getProviderKind()
  const previousApiKey = getApiKey()
  const slotBefore =
    row === 'third' ? { baseUrl: readSourceField(kind, 'baseUrl'), model: readSourceField(kind, 'model') } : undefined
  let saved = setProviderKind(kind)
  if (row === 'third') {
    // 官方服务的地址 / 模型是内置的（`spec.fields` 里没有这两格），写不进去也不该写
    saved = setBaseUrlFor(kind, check.draft.baseUrl) && saved
    saved = setModelFor(kind, check.draft.model) && saved
  }
  saved = setApiKey(check.draft.apiKey) && saved
  if (!saved) {
    /**
     * #986 整体回滚：任何一格没写成 → 把这次已经写进去的也退回去，绝不留
     * 「界面新渠道 / 磁盘旧渠道」。三件事：目标槽位的地址/模型、生效来源、共用那把 Key。
     * 回滚本身再失败也只能到此为止（此时确实无处可退），但诊断里至少留下每条 `rejected` 记录。
     */
    if (slotBefore !== undefined) {
      setBaseUrlFor(kind, slotBefore.baseUrl)
      setModelFor(kind, slotBefore.model)
    }
    setProviderKind(previousKind)
    setApiKey(previousApiKey)
    return {
      kind: 'not-saved',
      field: row === 'third' ? 'baseUrl' : 'apiKey',
      messageKey: 'settingsManagedKeyFailStorage',
    }
  }
  return { kind: 'applied', row, providerKind: kind, draft: check.draft }
}
