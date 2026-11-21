/**
 * 「账号」面板（W1-C2 #487 / 契约 §3.1a、§3.2）。
 *
 * 三块内容：资料（邮箱 / 余额 / 注册时间）、Key 管理、退出登录。
 *
 * **Key 的安全设计（必须在界面上说清，不是可选项）**：
 * 完整 Key 只在 `POST /api/v1/keys` 成功的那一刻由服务端返回一次；`GET /keys` 里虽然有 `key` 字段，
 * 但界面只显示末 4 位 —— 因为「随时能看全文」等于把 Key 变成一张长期有效的截屏。
 * 所以：`createdKey` 在状态里**只存活到用户点「我保存好了」**，列表永远走 {@link maskedKey}。
 *
 * 另一条来自 #484 §4.3：创建 Key **不可重试**（没有幂等键），客户端层的 `keys.create` 已经默认
 * 先按名字查一遍（`dedupe`）。界面这边只做两件事：按钮在请求期间禁用、成功后立刻把完整 Key 摆出来
 * —— 不让用户因为「没看到 Key」而再点一次。
 */

import { createElement, type ChangeEvent, type ReactNode } from 'react'

import type {
  ConsumeApiKey,
  ConsumeCallResult,
  ConsumeKeyCreateInput,
  ConsumeKeyUpdateInput,
  ConsumePage,
  ConsumeRawResponse,
  ConsumeUser,
} from '../../services/consume/index.js'
import {
  asRecord,
  copyRow,
  emptyBlock,
  errorBlock,
  firstStr,
  formatDateTime,
  loadingBlock,
  localPanelError,
  maskedKey,
  panelFromResult,
  panelLoading,
  panelReady,
  panelShell,
  sectionTitle,
  statRow,
  toPanelError,
  formatCurrency,
  type PanelAsync,
  type PanelBlockProps,
  type PanelError,
} from './panels.js'

/** 每页 Key 数（面板只做「第一页 + 更多」；重命名 / 分页留给后续单） */
export const ACCOUNT_KEY_PAGE_SIZE = 20

/** 面板要用到的客户端子集（结构化取子集 → 单测不必造整个 client） */
export type AccountSource = {
  auth: {
    profile: () => Promise<ConsumeCallResult<ConsumeUser>>
    revokeAllSessions: () => Promise<ConsumeCallResult<undefined>>
  }
  keys: {
    list: (query?: { page?: number; pageSize?: number }) => Promise<ConsumeCallResult<ConsumePage<ConsumeApiKey>>>
    create: (input: ConsumeKeyCreateInput) => Promise<ConsumeCallResult<ConsumeApiKey>>
    update: (id: number, input: ConsumeKeyUpdateInput) => Promise<ConsumeCallResult<ConsumeApiKey>>
    remove: (id: number) => Promise<ConsumeCallResult<undefined>>
  }
}

/** 资料区：注册时间不在 `ConsumeUser` 里（见下），所以单独攒成一份 */
export type AccountProfile = {
  email: string
  balance?: number
  /** 服务端 `created_at`（`ConsumeUser` 没映射这个字段，见 {@link toAccountProfile}） */
  registeredAt?: string
}

export type AccountState = {
  profile: PanelAsync<AccountProfile>
  keys: PanelAsync<ConsumePage<ConsumeApiKey>>
  /** 刚创建的 Key：**完整值只在这里存活一次**，dismiss 之后再也拿不到 */
  createdKey: ConsumeApiKey | null
  /** 正在进行的动作：`'create'` / `'logout'` / `'key:<id>'`（按钮禁用用） */
  busy: string | null
  /** 动作级错误（列表还在，只是这次点击失败），与 `keys.phase === 'failed'` 分开 */
  actionError: PanelError | null
  /**
   * 一次性提示：删掉了 / 已退出 / 退出**未确认**。
   *
   * `logoutUnconfirmed`（#679 第 5 处，安全语义）：撤销接口回了 2xx，但回查证明不了会话已失效。
   * 这时**不许**显示「已退出登录」—— 用户会以为公用 / 丢失设备上的会话也没了，于是不再改密码。
   */
  notice: 'deleted' | 'loggedOut' | 'logoutUnconfirmed' | null
  /** 删除的二次确认（一次只对一个 Key） */
  confirmDeleteId: number | null
  /** 退出登录的二次确认 */
  confirmLogout: boolean
  /** 新建 Key 的名称输入 */
  draftName: string
}

export type AccountEvent =
  | { type: 'profile'; state: PanelAsync<AccountProfile> }
  | { type: 'keys'; state: PanelAsync<ConsumePage<ConsumeApiKey>> }
  | { type: 'draft'; name: string }
  | { type: 'busy'; token: string | null }
  | { type: 'created'; key: ConsumeApiKey }
  | { type: 'createdDismiss' }
  | { type: 'replaceKey'; key: ConsumeApiKey }
  | { type: 'removeKey'; id: number }
  | { type: 'confirmDelete'; id: number | null }
  | { type: 'confirmLogout'; value: boolean }
  | { type: 'actionError'; error: PanelError | null }
  | { type: 'notice'; notice: AccountState['notice'] }

/**
 * 资料映射。`ConsumeUser` 没有 `createdAt`（W1-A 的 mapper 只挑了余额 / 身份那批字段），
 * 所以注册时间从**这次响应已经带回来的原始体**里读一次，不额外发请求、也不缓存。
 *
 * TODO(W1-A)：`toConsumeUser` 补上 `createdAt` 之后删掉 `raw` 这条兜底路径。
 */
export const toAccountProfile = (user: ConsumeUser, raw?: ConsumeRawResponse): AccountProfile => {
  const data = raw === undefined ? {} : asRecord(asRecord(raw.json).data)
  const registeredAt = firstStr(data.created_at, data.createdAt)
  const profile: AccountProfile = { email: user.email }
  if (user.balance !== undefined) {
    profile.balance = user.balance
  }
  if (registeredAt !== '') {
    profile.registeredAt = registeredAt
  }
  return profile
}

/** 首屏：外壳若已经知道用户，就先渲染资料，再用 `profile()` 的结果覆盖（避免闪一下加载态） */
export const initialAccountState = (user: ConsumeUser | null): AccountState => ({
  profile: user === null ? panelLoading<AccountProfile>() : panelReady(toAccountProfile(user)),
  keys: panelLoading<ConsumePage<ConsumeApiKey>>(),
  createdKey: null,
  busy: null,
  actionError: null,
  notice: null,
  confirmDeleteId: null,
  confirmLogout: false,
  draftName: '',
})

/** 纯 reducer：所有状态迁移都在这里，容器只负责「按顺序 dispatch」 */
export const reduceAccount = (state: AccountState, event: AccountEvent): AccountState => {
  switch (event.type) {
    case 'profile':
      return { ...state, profile: event.state }
    case 'keys':
      return { ...state, keys: event.state }
    case 'draft':
      return { ...state, draftName: event.name }
    case 'busy':
      return { ...state, busy: event.token }
    case 'created':
      // 新 Key 插到最前面：用户刚点完创建，眼睛正盯着列表顶部
      return {
        ...state,
        createdKey: event.key,
        actionError: null,
        notice: null,
        keys:
          state.keys.phase === 'ready'
            ? {
                phase: 'ready',
                data: {
                  ...state.keys.data,
                  items: [event.key].concat(state.keys.data.items.filter((item) => item.id !== event.key.id)),
                  total: state.keys.data.total + 1,
                },
              }
            : state.keys,
      }
    case 'createdDismiss':
      // 完整 Key 从状态里彻底消失（不是折叠，是真的丢掉）
      return { ...state, createdKey: null }
    case 'replaceKey':
      return {
        ...state,
        keys:
          state.keys.phase === 'ready'
            ? {
                phase: 'ready',
                data: {
                  ...state.keys.data,
                  items: state.keys.data.items.map((item) => (item.id === event.key.id ? event.key : item)),
                },
              }
            : state.keys,
      }
    case 'removeKey':
      return {
        ...state,
        createdKey: state.createdKey !== null && state.createdKey.id === event.id ? null : state.createdKey,
        confirmDeleteId: null,
        keys:
          state.keys.phase === 'ready'
            ? {
                phase: 'ready',
                data: {
                  ...state.keys.data,
                  items: state.keys.data.items.filter((item) => item.id !== event.id),
                  total: Math.max(0, state.keys.data.total - 1),
                },
              }
            : state.keys,
      }
    case 'confirmDelete':
      return { ...state, confirmDeleteId: event.id }
    case 'confirmLogout':
      return { ...state, confirmLogout: event.value }
    case 'actionError':
      return { ...state, actionError: event.error }
    case 'notice':
      return { ...state, notice: event.notice }
    default:
      return state
  }
}

/** 首屏加载：资料 + Key 列表并行（两个都是只读，失败互不影响） */
export const runLoadAccount = async (source: AccountSource): Promise<AccountEvent[]> => {
  const [profile, keys] = await Promise.all([
    source.auth.profile(),
    source.keys.list({ page: 1, pageSize: ACCOUNT_KEY_PAGE_SIZE }),
  ])
  const events: AccountEvent[] = []
  events.push({
    type: 'profile',
    state: profile.ok
      ? panelReady(toAccountProfile(profile.data, profile.raw))
      : { phase: 'failed', error: toPanelError(profile.error) },
  })
  events.push({ type: 'keys', state: panelFromResult(keys) })
  return events
}

/**
 * 创建 Key。名称先在本地校验（空名字服务端也会拒，但让它跑一趟网络没意义）。
 * 成功时把完整 Key 抬进 `createdKey` —— 这是**唯一**一次完整值上屏的机会。
 */
export const runCreateKey = async (source: AccountSource, name: string): Promise<AccountEvent[]> => {
  const trimmed = name.trim()
  if (trimmed === '') {
    return [{ type: 'actionError', error: localPanelError('consumeKeyNameRequired') }]
  }
  const result = await source.keys.create({ name: trimmed })
  if (!result.ok) {
    return [{ type: 'actionError', error: toPanelError(result.error) }]
  }
  return [{ type: 'created', key: result.data }, { type: 'draft', name: '' }]
}

/** 停用 / 启用（同一个端点，只有 `status` 不同） */
export const runToggleKey = async (source: AccountSource, key: ConsumeApiKey): Promise<AccountEvent[]> => {
  const next: ConsumeKeyUpdateInput = { status: key.status === 'active' ? 'inactive' : 'active' }
  const result = await source.keys.update(key.id, next)
  return result.ok
    ? [{ type: 'replaceKey', key: result.data }]
    : [{ type: 'actionError', error: toPanelError(result.error) }]
}

/** 删除（客户端层把 404 当「已删掉」，所以这里成功即移除） */
export const runDeleteKey = async (source: AccountSource, id: number): Promise<AccountEvent[]> => {
  const result = await source.keys.remove(id)
  if (!result.ok) {
    return [{ type: 'actionError', error: toPanelError(result.error) }]
  }
  return [{ type: 'removeKey', id }, { type: 'notice', notice: 'deleted' }]
}

/**
 * 退出登录：撤掉**所有设备**的会话（不只是当前这台）。
 *
 * 三条出口（#679 第 5 处）：
 *   1. `ok: true` = `revokeAllSessions` 已经**回查确认**旧凭据失效 → 才可以说「已退出登录」；
 *   2. `ok: false` 且 `i18nKey === 'consumeErrRevokeUnconfirmed'` = 撤销请求已提交但**未确认** →
 *      `notice: 'logoutUnconfirmed'`，文案给下一步（重新登录验证 / 查其他设备），**不出现「已退出」**；
 *      本地会话该清仍然要清（`store.signOut` 与服务端结果无关，见 `auth/store.ts`）；
 *   3. 其余失败 = 普通动作错误（`actionError`），按钮留在原地让用户重试。
 */
export const runLogout = async (source: AccountSource): Promise<AccountEvent[]> => {
  const result = await source.auth.revokeAllSessions()
  if (!result.ok) {
    if (result.error.i18nKey === 'consumeErrRevokeUnconfirmed') {
      return [{ type: 'notice', notice: 'logoutUnconfirmed' }, { type: 'confirmLogout', value: false }]
    }
    return [{ type: 'actionError', error: toPanelError(result.error) }, { type: 'confirmLogout', value: false }]
  }
  return [{ type: 'notice', notice: 'loggedOut' }, { type: 'confirmLogout', value: false }]
}

export type AccountPanelViewProps = PanelBlockProps & {
  state: AccountState
  /** 复制的按钮点了之后那一小会儿的「已复制」 */
  copied: boolean
  onCopyKey: (value: string) => void
  onDraft: (name: string) => void
  onCreate: () => void
  onToggleKey: (key: ConsumeApiKey) => void
  onAskDelete: (id: number) => void
  onCancelDelete: () => void
  onConfirmDelete: (id: number) => void
  onDismissCreated: () => void
  onAskLogout: () => void
  onCancelLogout: () => void
  onLogout: () => void
  onRetry: () => void
}

const keyRow = (
  props: AccountPanelViewProps,
  key: ConsumeApiKey,
  busy: boolean
): ReactNode => {
  const { t, c, Button, state } = props
  const active = key.status === 'active'
  const confirming = state.confirmDeleteId === key.id
  return createElement(
    'li',
    { className: c.keyRow, key: key.id, 'data-testid': 'account-key-row' },
    createElement(
      'div',
      { className: c.listMain },
      createElement('span', { className: c.listTitle }, key.name === '' ? '—' : key.name),
      // 列表里**只有末 4 位**：完整 Key 只在创建成功那一次出现过
      createElement('code', { className: c.keyMasked, 'data-testid': 'account-key-masked' }, maskedKey(key.key)),
      createElement(
        'span',
        { className: c.listMeta },
        `${t('consumeKeyStatus')}：${active ? t('consumeKeyStatusActive') : t('consumeKeyStatusInactive')}`
      )
    ),
    createElement(
      'div',
      { className: c.keyActions },
      createElement(
        Button,
        {
          size: 's',
          variant: 'outlined',
          disabled: busy,
          testId: 'account-key-toggle',
          onClick: () => props.onToggleKey(key),
        },
        active ? t('consumeKeyStatusInactive') : t('consumeKeyStatusActive')
      ),
      confirming
        ? createElement(
            'div',
            { className: c.confirm, 'data-testid': 'account-key-delete-confirm' },
            createElement('p', { className: c.confirmText }, t('consumeDeleteConfirm')),
            createElement(
              Button,
              {
                size: 's',
                variant: 'danger',
                disabled: busy,
                testId: 'account-key-delete-yes',
                onClick: () => props.onConfirmDelete(key.id),
              },
              t('confirm')
            ),
            createElement(
              Button,
              { size: 's', variant: 'outlined', testId: 'account-key-delete-no', onClick: props.onCancelDelete },
              t('cancel')
            )
          )
        : createElement(
            Button,
            {
              size: 's',
              variant: 'dangerOutlined',
              disabled: busy,
              testId: 'account-key-delete',
              onClick: () => props.onAskDelete(key.id),
            },
            t('consumeDeleteKey')
          )
    )
  )
}

/** 账号面板（纯渲染） */
export const AccountPanelView = (props: AccountPanelViewProps): ReactNode => {
  const { t, c, Button, state, copied } = props
  const busy = state.busy !== null
  const body: ReactNode[] = []

  // ── 当前态（#608：登录 / 未登录都要在第一屏说清「我现在是什么态」）──────────
  if (state.profile.phase === 'ready') {
    body.push(
      createElement(
        'p',
        { className: c.hint, 'data-testid': 'account-optional-status' },
        t('accountOptionalStatusLoggedIn', { email: state.profile.data.email === '' ? '—' : state.profile.data.email })
      )
    )
  }

  // ── 资料 ────────────────────────────────────────────────────────────────
  body.push(sectionTitle(c, t('consumeProfileTitle')))
  if (state.profile.phase === 'loading') {
    body.push(loadingBlock(props))
  } else if (state.profile.phase === 'failed') {
    body.push(errorBlock(props, state.profile.error, props.onRetry, 'account-profile-error'))
  } else {
    body.push(
      createElement(
        'div',
        { className: c.stats, 'data-testid': 'account-profile' },
        statRow(c, t('sub2authEmail'), state.profile.data.email === '' ? '—' : state.profile.data.email, 'account-email', true),
        statRow(c, t('consumeBalanceLabel'), formatCurrency(state.profile.data.balance), 'account-balance'),
        statRow(
          c,
          t('consumeRegisteredAt'),
          state.profile.data.registeredAt === undefined ? '—' : formatDateTime(state.profile.data.registeredAt),
          'account-registered'
        )
      )
    )
  }

  // ── Key 管理 ────────────────────────────────────────────────────────────
  body.push(sectionTitle(c, t('consumeKeyList')))

  // 创建成功后的**唯一一次**完整 Key
  if (state.createdKey !== null) {
    body.push(
      createElement(
        'div',
        { className: c.once, 'data-testid': 'account-key-once' },
        createElement('p', { className: c.onceTitle }, t('consumeKeyOnceTitle')),
        createElement('p', { className: c.hint }, t('consumeKeyOnceBody')),
        copyRow(props, {
          value: state.createdKey.key,
          copied,
          onCopy: () => props.onCopyKey(state.createdKey === null ? '' : state.createdKey.key),
          testId: 'account-key-once',
          copyLabel: 'consumeCopyKey',
          copiedLabel: 'consumeKeyCopied',
        }),
        createElement(
          'div',
          { className: c.actions },
          createElement(
            Button,
            { size: 's', variant: 'primary', testId: 'account-key-once-dismiss', onClick: props.onDismissCreated },
            t('consumeKeyOnceSaved')
          )
        )
      )
    )
  }

  body.push(
    createElement(
      'div',
      { className: c.createRow },
      createElement('input', {
        className: c.input,
        type: 'text',
        value: state.draftName,
        placeholder: t('consumeKeyName'),
        'aria-label': t('consumeKeyName'),
        'data-testid': 'account-key-name',
        onChange: (event: ChangeEvent<HTMLInputElement>) => props.onDraft(event.currentTarget.value),
      }),
      createElement(
        Button,
        { size: 's', variant: 'primary', disabled: busy, testId: 'account-key-create', onClick: props.onCreate },
        t('consumeCreateKey')
      )
    )
  )
  if (state.keys.phase === 'loading') {
    body.push(loadingBlock(props))
  } else if (state.keys.phase === 'failed') {
    body.push(errorBlock(props, state.keys.error, props.onRetry, 'account-keys-error'))
  } else if (state.keys.data.items.length === 0) {
    body.push(emptyBlock(props, t('consumeKeyEmpty'), 'account-keys-empty'))
  } else {
    body.push(
      createElement(
        'ul',
        { className: c.list, 'data-testid': 'account-key-list' },
        state.keys.data.items.map((key) => keyRow(props, key, busy))
      )
    )
    body.push(createElement('p', { className: c.hint, 'data-testid': 'account-key-tail-hint' }, t('consumeKeyTailOnly')))
  }

  // ── 动作级反馈 ──────────────────────────────────────────────────────────
  if (state.actionError !== null) {
    body.push(errorBlock(props, state.actionError, undefined, 'account-action-error'))
  }
  if (state.notice !== null) {
    body.push(
      createElement(
        'p',
        { className: c.notice, 'data-testid': 'account-notice' },
        state.notice === 'deleted'
          ? t('consumeKeyDeleted')
          : state.notice === 'logoutUnconfirmed'
            ? t('consumeErrRevokeUnconfirmed')
            : t('consumeLogoutSuccess')
      )
    )
  }

  // ── 退出登录 ────────────────────────────────────────────────────────────
  body.push(
    state.confirmLogout
      ? createElement(
          'div',
          { className: c.confirm, 'data-testid': 'account-logout-confirm' },
          createElement('p', { className: c.confirmText }, t('consumeLogoutConfirm')),
          createElement(
            Button,
            { size: 's', variant: 'danger', disabled: busy, testId: 'account-logout-yes', onClick: props.onLogout },
            t('sub2authLogout')
          ),
          createElement(
            Button,
            { size: 's', variant: 'outlined', testId: 'account-logout-no', onClick: props.onCancelLogout },
            t('cancel')
          )
        )
      : createElement(
          Button,
          { size: 'm', variant: 'outlined', testId: 'account-logout', onClick: props.onAskLogout },
          t('sub2authLogout')
        )
  )

  return panelShell(c, t('consumeAccountTitle'), body, 'account-panel')
}

/**
 * 「账号」面板的**未登录态**（#608 拆登录墙之后的主路径）。
 *
 * 为什么它必须存在：拆掉登录墙之后，绝大多数用户不会登录 —— 他们只填一把 Key 就开始聊天。
 * 于是这个面板第一眼要回答的是三件事，**一屏之内**，且顺序固定（维护者点名的「好一点」）：
 *  1. 我现在是什么态：`当前未登录`（不是错误、不是「登录失效」—— 从没登录过不是故障）；
 *  2. 登录能得到什么 / 不登录会缺什么：余额与用量、云端 Key 管理、邀请返利这三件；
 *  3. 下一步做什么：**主 CTA 是「去填 API Key」**，登录只是它下面那块可选项。
 *
 * 两条硬约束：
 *  - **不发请求**：未登录时不去问 `profile()` / `keys.list()`（那两条只会回 401，把「没登录」
 *    显示成「登录已失效」是 #608 要消掉的那种错）；这里全是静态文案 + 一个回调。
 *  - **不重写表单**：登录 / 注册卡片由容器把 `<AuthGate variant="inline" />` 作为 `auth` 传进来，
 *    表单逻辑与 `sub2auth*` 文案都在那一份里（LoginPage / RegisterPage），这里只负责排版与引导。
 */
export type AccountSignedOutViewProps = PanelBlockProps & {
  /** 局部登录 / 注册卡片（容器注入，见上） */
  auth: ReactNode
  /** 主 CTA：跳到「设置 → 数据管理 → API Key」 */
  onFillKey: () => void
}

/** 账号面板（未登录态，纯渲染：不读 store、不发请求） */
export const AccountSignedOutView = (props: AccountSignedOutViewProps): ReactNode => {
  const { t, c, Button, auth, onFillKey } = props
  const body: ReactNode[] = []

  // ① 顶部固定一句「不登录也能用」—— 维护者定调的原话，位置不动
  body.push(
    createElement(
      'div',
      { className: c.guide, 'data-testid': 'account-optional-notice' },
      createElement('p', { className: c.guideTitle }, t('accountOptionalHint')),
      createElement('p', { className: c.hint, 'data-testid': 'account-signed-out-state' }, t('accountOptionalStatusLoggedOut'))
    )
  )

  // ② 能得到什么：三行账单类信息（账号**只**多这些，不是「更安全」）
  body.push(sectionTitle(c, t('accountOptionalBenefitsTitle')))
  body.push(
    createElement(
      'ul',
      { className: c.list, 'data-testid': 'account-benefits' },
      [t('accountOptionalBenefitBalance'), t('accountOptionalBenefitKeys'), t('accountOptionalBenefitInvite')].map(
        (text, index) =>
          createElement(
            'li',
            { className: c.listItem, key: `benefit-${index}`, 'data-testid': 'account-benefit' },
            createElement('span', { className: c.listTitle }, text)
          )
      )
    )
  )

  // ③ 不登录会失去什么 —— 反过来把「不会失去的」也说清楚（聊天 / Key / 导入导出）
  body.push(createElement('p', { className: c.hint, 'data-testid': 'account-optional-keep' }, t('accountOptionalKeep')))

  // ④ 主 CTA：能不发请求就不发请求 —— 填 Key 才是「用起来」的那条路
  body.push(
    createElement(
      'div',
      { className: c.actions },
      createElement(
        Button,
        { size: 'm', variant: 'primary', testId: 'account-fill-key', onClick: onFillKey },
        t('accountFillKeyCta')
      )
    )
  )
  body.push(createElement('p', { className: c.hint, 'data-testid': 'account-fill-key-hint' }, t('accountFillKeyHint')))

  // ⑤ 次要入口：登录 / 注册（可选能力，放在主 CTA 之后）
  body.push(sectionTitle(c, t('accountOptionalLoginEntry')))
  body.push(createElement('div', { 'data-testid': 'account-auth-card' }, auth))

  return panelShell(c, t('consumeAccountTitle'), body, 'account-panel')
}

/**
 * 供容器判断：这批事件里是否已经有人要求重新登录。
 *
 * 两种情况都算（#679 第 5 处）：「已确认退出」与「退出未确认」—— 后者本地凭据同样要停用，
 * 只是文案上不许把它说成「所有设备都已退出」。
 */
export const loggedOut = (events: AccountEvent[]): boolean =>
  events.some((event) => event.type === 'notice' && (event.notice === 'loggedOut' || event.notice === 'logoutUnconfirmed'))
