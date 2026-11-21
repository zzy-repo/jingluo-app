/**
 * 「模型来源」页的**单层手风琴**（Issue #807）—— 纯逻辑：状态机 / 校验 / 行头状态，全部可裸 Node 单测。
 *
 * ## 为什么单独一个 `.ts`
 *
 * #800 已经把「渲染哪些字段行」抽成 `sourceFieldPlan.sourceFieldRows()`；本单要抽的是另一半：
 * **这一页有哪些行、同一时间展开哪一行、「正在查看」与「正在使用」怎么分开**。
 * `.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除范围内），所以判定与状态转移都放这里，
 * 界面（`AccountConsumePage`）与用例**共用同一份**：用例断的不是一份平行真理。
 *
 * ## 这一页的三个概念（别混）
 *
 *  1. **行**（`SourceRowKey`）：内置服务 / 第三方服务 / DeepSeek 官方服务 —— 三行，一个手风琴。
 *  2. **展开（open）**：只是在**看**。同一时间只展开一行；收起不丢草稿（草稿在 `drafts` 里）。
 *     展开/收起**从不**改变生效来源 —— 这里连 `setProviderKind` 都不 import。
 *  3. **生效来源（effective）**：`chat-demo:provider-kind`（既有键，`apiConfig.getProviderKind()`）。
 *     **打勾只绑它**：`rowOfKind(kind)` 命中的那一行才有 ✓，同一时间最多一个，重启后照样在。
 *
 * 切换生效来源只有两条路（都是动作，不是浏览）：
 *  - 内置服务**领取成功**（`claimBuiltinKey()` 拿到 key 之后才 `setProviderKind('ours')`）；
 *  - 第三方 / 官方展开区底部的**「确认使用」**（`confirmSourceRow()`：先校验，通过才落盘 + 切）。
 *
 * ## 「未配置」与「领取中…」是两回事
 *
 * 行头右侧的状态只表达这一行自己那一份够不够用：
 *  - `current`      ✓ 当前使用（= 生效来源这一行，且这一行真的有可用的 Key）
 *  - `claiming`     领取中…（内置服务正在向服务端要领 Key，**期间整行禁用**，防重复领取）
 *  - `unconfigured` 未配置（没 Key / 领取出错后回到这一档，原因写在行内）
 *
 * 领取失败不吞掉文字：`claim.failed` 带着 `messageKey`（#771 / #484 的分类结果，由 `toPanelError`
 * 归一化后给过来），行内渲染「原因 + 重试」，**且不选中**。
 */
import type { TranslationKey } from '../../i18n/index.js'
import { normalizeBaseUrl } from '../../services/api/apiConfig.js'
import type { ProviderKind } from '../../services/api/providers.js'

/** 手风琴的三行 */
export type SourceRowKey = 'builtin' | 'third' | 'official'

/** 有表单的两行（内置服务**没有**表单：行即动作） */
export type DraftRowKey = 'third' | 'official'

/** 行的顺序 = 界面顺序（内置 → 第三方 → 官方） */
export const SOURCE_ROWS: readonly SourceRowKey[] = ['builtin', 'third', 'official']

/** 行名与子页标题共用同一批词条（不新写中文） */
export const SOURCE_ROW_LABEL_KEY: Record<SourceRowKey, TranslationKey> = {
  builtin: 'accountConsumeSourceBuiltin',
  third: 'accountConsumeSourceThird',
  official: 'accountConsumeSourceOfficial',
}

/**
 * 生效来源（`ProviderKind`）→ 打勾的那一行。
 *
 * 第三方两种协议（`openai` / `anthropic`）是**同一个槽位**（#794），所以都落在 `third`：
 * 用户看到的是「第三方服务 ✓ 当前使用」，而不是协议名 —— 协议由发送链路自动适配。
 */
export const rowOfKind = (kind: ProviderKind): SourceRowKey =>
  kind === 'ours' ? 'builtin' : kind === 'deepseek' ? 'official' : 'third'

/**
 * 这一行「确认使用 / 领取」时要落到哪个 kind。
 *
 * 第三方行需要一个**槽位**（`openai` 还是 `anthropic`）：由调用方传 `thirdPartyEntryKind()`
 * （既有判定：保持当前第三方协议 → 有数据的那一边 → openai），这里不另判一次。
 */
export const rowTargetKind = (row: SourceRowKey, thirdKind: ProviderKind): ProviderKind =>
  row === 'builtin' ? 'ours' : row === 'official' ? 'deepseek' : thirdKind

/** 行头与展开区的 id（`aria-controls` / `aria-labelledby` 必须真指到节点上） */
export const rowIds = (row: SourceRowKey): { headerId: string; panelId: string } => ({
  headerId: `settings-source-${row}`,
  panelId: `settings-source-${row}-panel`,
})

/**
 * 手风琴：**同一时间只展开一行**。
 *
 * 点已展开的那一行 = 收起（`null`）；点另一行 = 换过去（旧的那行自动收起 —— 这就是
 * 「同一时间只展开一行」的全部实现，没有第二处「顺手把别的关掉」）。
 */
export const toggleAccordion = (
  open: SourceRowKey | null,
  row: SourceRowKey
): SourceRowKey | null => (open === row ? null : row)

// ─────────────────────────────────────────────────────────── 行头状态

/** 行头右侧的状态（文案见 `rowStatusTextKey`） */
export type RowStatus = 'current' | 'unconfigured' | 'claiming'

/** 状态 → 文案（`claiming` 自带省略号；失败时回到「未配置」，原因写在行内） */
export const rowStatusTextKey = (status: RowStatus): TranslationKey =>
  status === 'current'
    ? 'settingsSourceStatusCurrent'
    : status === 'claiming'
      ? 'settingsSourceStatusClaiming'
      : 'settingsSourceStatusUnconfigured'

/**
 * 这一行现在该显示什么状态。
 *
 * 打勾（`current`）的判据**只有一条**：它是生效来源那一行，而且这一行真的有可用的 Key。
 * 「有 Key 但没生效」不是 ✓ —— 那正是「正在查看」与「正在使用」必须分开的地方。
 */
export const rowStatusOf = (input: {
  row: SourceRowKey
  /** 生效来源（`chat-demo:provider-kind`） */
  effectiveKind: ProviderKind
  /** 这一行自己那一份够不够用（内置=服务端那把已在；第三方/官方=填了 Key） */
  configured: boolean
  /** 内置服务的领取状态（其它行传 `{ phase: 'idle' }`） */
  claim: BuiltinClaimState
}): RowStatus => {
  if (input.row === 'builtin' && input.claim.phase === 'claiming') {
    return 'claiming'
  }
  return rowOfKind(input.effectiveKind) === input.row && input.configured ? 'current' : 'unconfigured'
}

// ─────────────────────────────────────────────────── 内置服务：行即动作

/** 领取状态机（只有内置服务那一行有） */
export type BuiltinClaimState =
  | { phase: 'idle' }
  /** 未登录：**一个请求都不发**，弹登录 / 注册；登录成功后自动继续领取 */
  | { phase: 'need-login' }
  /** 领取中：整行禁用，行头写「领取中…」 */
  | { phase: 'claiming' }
  /** 领取失败：不选中，行内给原因 + 「重试」 */
  | { phase: 'failed'; messageKey: TranslationKey; retryable: boolean }

/** 点内置服务这一行会发生什么（纯判定，调用方据此发请求 / 弹登录 / 选中） */
export type BuiltinClickPlan =
  | { action: 'need-login'; resume: true }
  | { action: 'select' }
  | { action: 'claim' }

/**
 * 点「内置服务」这一行 = **行即动作**（没有表单）：
 *
 *  - 未登录 → 弹登录 / 注册，并且**记住「登录成功后自动继续领取」**（`resume: true`）；
 *  - 已登录且手上就是服务端那把 Key（`verdict === 'ok'`）→ 直接设为当前来源 + 打勾；
 *  - 已登录但本机没有可用 Key（从来没有 / 旧的 / 手填的）→ 行内领取。
 *
 * 「已有一把 Key」的判据由调用方给（`managedKeyVerdict(...) === 'ok'`）：不是「非空就行」——
 * 旧 Key / 手填 Key 一样要重新领取，#596 那三类事故正是从这里进来的。
 */
export const planBuiltinClick = (input: {
  signedIn: boolean
  hasKey: boolean
}): BuiltinClickPlan =>
  !input.signedIn ? { action: 'need-login', resume: true } : input.hasKey ? { action: 'select' } : { action: 'claim' }

/** 登录回来了要不要自动接着领（③：「登录成功后自动继续领取，不要让用户再点一次」） */
export const shouldResumeAfterLogin = (input: {
  pending: boolean
  signedIn: boolean
}): boolean => input.pending && input.signedIn

// ───────────────────────────────────────────────────────── 草稿与「确认使用」

/** 一行草稿：只在前端存在，**点「确认使用」且校验通过**才落盘 + 切成生效来源 */
export type SourceDraft = {
  baseUrl: string
  apiKey: string
  model: string
}

export const EMPTY_SOURCE_DRAFT: SourceDraft = { baseUrl: '', apiKey: '', model: '' }

/** 草稿出错落在哪一行（红字位置） */
export type DraftErrorField = 'baseUrl' | 'apiKey' | 'model'

/** 草稿校验结果：`ok` 时顺手给出**要落盘的那一份**（已 trim / 已规范化地址） */
export type DraftCheck =
  | { ok: true; draft: SourceDraft }
  | { ok: false; field: DraftErrorField; messageKey: TranslationKey }

/**
 * 「确认使用」之前的校验：**Key 非空 + 地址格式合法**（票面口径）。
 *
 * 官方服务（`deepseek`）的地址与模型是内置的，只需要 Key；
 * 第三方服务（`openai` / `anthropic`）三件套都要（模型为空 `setModel` 会拒写，
 * 空模型发给中转只会换回一次 400 —— 本地能拦就先拦）。
 *
 * 地址的合法性判据**复用** `apiConfig.normalizeBaseUrl`（缺协议 / 非法 URL 都由它判死），
 * 这里不另写一套正则：两处一起漂移就会变成「界面说合法、请求发不出去」。
 *
 * 连通性探测**不在**校验里（票面：探测可选）：它只是给用户看一眼，探测失败不影响「确认使用」。
 */
export const checkSourceDraft = (row: DraftRowKey, draft: SourceDraft): DraftCheck => {
  const apiKey = draft.apiKey.trim()
  if (apiKey === '') {
    return { ok: false, field: 'apiKey', messageKey: 'settingsTestApiKeyRequired' }
  }
  if (row === 'official') {
    // 官方服务：地址 / 模型内置（`spec.fields` 里只有 apiKey），草稿里那两格不参与
    return { ok: true, draft: { baseUrl: '', apiKey, model: '' } }
  }
  const baseUrl = normalizeBaseUrl(draft.baseUrl)
  if (baseUrl === null) {
    return {
      ok: false,
      field: 'baseUrl',
      messageKey: draft.baseUrl.trim() === '' ? 'settingsBaseUrlRequired' : 'settingsBaseUrlInvalid',
    }
  }
  const model = draft.model.trim()
  if (model === '') {
    return { ok: false, field: 'model', messageKey: 'settingsModelInvalid' }
  }
  return { ok: true, draft: { baseUrl, apiKey, model } }
}

// ───────────────────────────────────────────────────────────── 页面状态机

/** 「模型来源」这一页的全部界面状态（`AccountConsumePage` 用 `useReducer` 跑它） */
export type SourcePageState = {
  /** 展开的是哪一行（`null` = 三行都收起） */
  open: SourceRowKey | null
  /** 两行的草稿：**收起不丢**（票面 ⑦），刷新/重启由 `readSourceDraft()` 从存储取回 */
  drafts: Record<DraftRowKey, SourceDraft>
  /** 「确认使用」失败的提示（落在哪一格、说什么） */
  errors: Record<DraftRowKey, { field: DraftErrorField; messageKey: TranslationKey } | null>
  /** 内置服务的领取状态 */
  claim: BuiltinClaimState
}

export type SourcePageEvent =
  | { type: 'toggle'; row: SourceRowKey }
  | { type: 'collapse' }
  | { type: 'edit'; row: DraftRowKey; field: DraftErrorField; value: string }
  | { type: 'submit-failed'; row: DraftRowKey; field: DraftErrorField; messageKey: TranslationKey }
  | { type: 'submit-ok'; row: DraftRowKey }
  /** 校验通过后把草稿换成**规范化过的那一份**（地址去尾斜杠等），免得界面还显示旧串 */
  | { type: 'draft-set'; row: DraftRowKey; draft: SourceDraft }
  | { type: 'claim-need-login' }
  | { type: 'claim-started' }
  | { type: 'claim-ok' }
  | { type: 'claim-failed'; messageKey: TranslationKey; retryable: boolean }

/** 首帧：草稿来自存储（`readSourceDraft`），其余是空的 */
export const initialSourcePageState = (
  drafts: Record<DraftRowKey, SourceDraft>
): SourcePageState => ({
  open: null,
  drafts,
  errors: { third: null, official: null },
  claim: { phase: 'idle' },
})

/**
 * 状态转移。
 *
 * 两个关键不变量：
 *  1. `toggle` **只动 `open`**：既不碰草稿（收起后草稿仍在），也不碰任何存储 / 生效来源；
 *  2. `claim-*` 只动 `claim`：真正的「选中」发生在运行时（`claimBuiltinKey()` 拿到 key 之后
 *     才 `setProviderKind('ours')`），所以「领取失败不选中」在结构上成立，不靠界面自觉。
 */
export const sourcePageReducer = (
  state: SourcePageState,
  event: SourcePageEvent
): SourcePageState => {
  switch (event.type) {
    case 'toggle':
      return { ...state, open: toggleAccordion(state.open, event.row) }
    case 'collapse':
      return { ...state, open: null }
    case 'edit':
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [event.row]: { ...state.drafts[event.row], [event.field]: event.value },
        },
        // 改了哪一格就把那一格的红字撤掉（不然用户改完了还在看一句旧结论）
        errors: {
          ...state.errors,
          [event.row]:
            state.errors[event.row]?.field === event.field ? null : state.errors[event.row],
        },
      }
    case 'submit-failed':
      return {
        ...state,
        errors: { ...state.errors, [event.row]: { field: event.field, messageKey: event.messageKey } },
      }
    case 'submit-ok':
      return { ...state, errors: { ...state.errors, [event.row]: null } }
    case 'draft-set':
      return { ...state, drafts: { ...state.drafts, [event.row]: event.draft } }
    case 'claim-need-login':
      return { ...state, claim: { phase: 'need-login' } }
    case 'claim-started':
      return { ...state, claim: { phase: 'claiming' } }
    case 'claim-ok':
      return { ...state, claim: { phase: 'idle' } }
    case 'claim-failed':
      return {
        ...state,
        claim: { phase: 'failed', messageKey: event.messageKey, retryable: event.retryable },
      }
    default:
      return state
  }
}
