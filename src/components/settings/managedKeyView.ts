/**
 * 「我们的渠道」的 API Key 行：**只读**展示 + 「重新领取」（Issue #596）。
 *
 * 这一行与另外三个渠道的 Key 行是两种控件，不是同一个控件的两种样式：
 *
 *  - 我们的渠道（`ours`）：没有输入框，没有铅笔按钮。只有一行「当前 Key ···e849」+ 一句
 *    「由设备自动领取，无需填写」+ 一个「重新领取」。Key 从服务端来（`managedKey.ts` 的那条链路），
 *    用户手里那把外部 Key 在这里**没有地方可填**。
 *  - DeepSeek 官方 / Anthropic / OpenAI 兼容：维持原样（可填、可改、可校验）。#608 的硬验收
 *    「只拿一把自己的 Key 也能用」正是靠这三个渠道成立的，所以这里的判别必须按渠道分支，
 *    **不能**一刀切地把所有 Key 行都锁死。
 *
 * ## #800 起：这一行**不再由设置页渲染**
 *
 * 「内置服务」子页按 #800 的要求把 Key 相关控件（输入框 / 掩码展示区 /「重新领取」）整段从 DOM 里
 * 拿掉了 —— 判定只有一处：`sourceFieldPlan.sourceFieldRows()` 把 `apiKey` 从行清单里摘掉。
 * Key 的领取与恢复改走**后台自动流程**：`managedKeyRuntime.syncManagedKeyFromServer()` 在启动、
 * 登录后、以及「发送被拦且打开设置」时各对齐一次（都是幂等的「按设备固定名领取」）。
 *
 * 本模块（连同 `ManagedKeyField.tsx`）**保留**：它们是「领取链路」唯一的现成视图与容器，
 * 将来若要在别处（例如账号页）恢复一个手动换 Key 的入口，直接复用，不必重写领取逻辑；
 * `tests/unit/managed-key-596.test.mjs` 也仍然按真文案钉着它的形态。
 *
 * 为什么把渲染放在 `.ts` 而不是 `.tsx`：本仓的 `.tsx` 裸 Node import 不了（JSX 不在类型擦除范围内），
 * 而「用户到底看到什么」必须能被单测按真文案渲染出来（沿用 `accountPanelModel.ts` 的写法）。
 * 设计系统的 `Button` 由调用方注入，单测注入替身即可，这里不做任何 UI 框架假设。
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { ManagedKeyFailure, ManagedKeyVerdict } from '../../services/api/managedKey.js'
import type { ProviderKind } from '../../services/api/providers.js'
import type { ManagedKeyEnsureStatus } from './managedKeyEnsureState.js'

/** Key 行的形态：只读（服务端管理）还是可编辑（用户自己的 Key） */
export type ApiKeyFieldMode = 'managed' | 'editable'

/**
 * 渠道 → Key 行的形态。**唯一判定处**：设置页按它分支渲染，单测按它逐渠道断言
 * （改坏了只要四个渠道里有一个形态不对，用例就红）。
 */
export const apiKeyFieldMode = (kind: ProviderKind): ApiKeyFieldMode =>
  kind === 'ours' ? 'managed' : 'editable'

/** 注入的按钮组件（真机是 `components/base/Button`，单测是替身） */
export type ManagedKeyButton = ComponentType<{
  variant?: 'primary' | 'outlined' | 'danger' | 'dangerOutlined'
  size?: 's' | 'm' | 'l'
  disabled?: boolean
  className?: string
  testId?: string
  onClick?: () => void
  children?: ReactNode
}>

export type ManagedKeyViewProps = {
  /** i18n 取词（与 `useTranslate()` 同签名；单测注入真 zh 表） */
  t: (key: TranslationKey, params?: TranslationParams) => string
  /** 本机 Key 与服务端那把的关系（`services/api/managedKey.ts` 的判定） */
  verdict: ManagedKeyVerdict
  /** 尾 4 位，取**实际会用于请求的那一把**（`getApiKey()`），不是另一个来源 */
  tail: string
  /** 这次打开设置是发送前拦截触发的哪一档（没被拦就是 null） */
  blocked: null | 'unclaimed' | 'stale'
  claiming: boolean
  /** 领取失败的原因（已是可读文案；`needLogin` 时由调用方拼上「先登录」那句） */
  error: string | null
  /** 领取成功的提示（含新尾号），没有就是 null */
  notice: string | null
  onClaim: () => void
  Button: ManagedKeyButton
  styles: Record<string, string>
}

/** 只读那一格显示什么：有 Key 显示尾号，没有就说「尚未领取」，绝不显示完整 Key */
export const managedKeyValueText = (
  props: Pick<ManagedKeyViewProps, 't' | 'verdict' | 'tail'>
): string =>
  props.verdict === 'unclaimed' || props.tail === ''
    ? props.t('settingsManagedKeyUnclaimedValue')
    : props.t('settingsManagedKeyValue', { tail: props.tail })

/**
 * 「我们的渠道」的 Key 行。
 *
 * 结构上**不出现 `<input>`**：这是「用户填不进来」最硬的保证 —— 不是 disabled，
 * 而是根本没有那个 DOM 节点（disable 能被 devtools 改回来，input 不存在就无从改起）。
 */
export const ManagedKeyView = (props: ManagedKeyViewProps): ReactNode => {
  const { t, verdict, blocked, claiming, error, notice, onClaim, Button, styles } = props
  const rows: ReactNode[] = [
    createElement(
      'div',
      { key: 'head', className: styles.apiKeySaved, 'data-testid': 'settings-managed-key' },
      createElement(
        'span',
        { key: 'value', className: styles.apiKeyMask, 'data-testid': 'settings-managed-key-value' },
        managedKeyValueText(props)
      ),
      createElement(
        Button,
        {
          key: 'claim',
          variant: 'outlined',
          size: 's',
          disabled: claiming,
          testId: 'settings-managed-key-claim',
          onClick: onClaim,
        },
        claiming ? t('settingsManagedKeyClaiming') : t('settingsManagedKeyClaim')
      )
    ),
    createElement(
      'div',
      { key: 'hint', className: styles.description, 'data-testid': 'settings-managed-key-hint' },
      t('settingsManagedKeyHint')
    ),
  ]
  // 发送前拦截：红字，且必须写明「这条消息没有发出去」（与 #451 的格式拦截同一纪律）
  if (blocked !== null) {
    rows.push(
      createElement(
        'div',
        {
          key: 'blocked',
          className: styles.error,
          role: 'status',
          'data-testid': 'settings-managed-key-blocked',
        },
        blocked === 'stale' ? t('settingsManagedKeyBlockedStale') : t('settingsManagedKeyBlockedClaim')
      )
    )
  } else if (verdict === 'stale') {
    // 没被拦、但本机这把已经不是服务端那把（例如刚切回我们的渠道）：主动说，别让人以为一切正常
    rows.push(
      createElement(
        'div',
        { key: 'stale', className: styles.error, 'data-testid': 'settings-managed-key-stale' },
        t('settingsManagedKeyStale')
      )
    )
  }
  if (error !== null) {
    rows.push(
      createElement(
        'div',
        { key: 'error', className: styles.error, role: 'alert', 'data-testid': 'settings-managed-key-error' },
        error
      )
    )
  }
  if (notice !== null) {
    rows.push(
      createElement(
        'div',
        { key: 'notice', className: styles.description, 'data-testid': 'settings-managed-key-notice' },
        notice
      )
    )
  }
  return createElement(
    'div',
    { className: styles.cell },
    createElement(
      'div',
      { className: styles.apiKey },
      createElement('div', { className: styles.label }, t('settingsApiKeyLabel')),
      ...rows
    )
  )
}

// ---------------------------------------------------------------- 「自动拿 Key 失败」的可见提示（#803）

/**
 * 失败原因 → 一句人话（**带状态码**，因为「失败了」本身对排查毫无用处）。
 *
 * 三种性质分别对应 #803 第 4 条里「没拿到」的三类：超时 / 网络错误（`transport`，status 0）、
 * 非 2xx（`http`）、2xx 但没有 Key 值（`empty`）。文案里不写「服务器繁忙」「未知错误」这类
 * 掩盖性说法（#596 的老教训：用户拿着旧 Key 一直 401，却被告知服务器忙）。
 */
export const managedKeyEnsureFailureReason = (
  t: ManagedKeyViewText,
  failure: ManagedKeyFailure
): string => {
  if (failure.kind === 'transport') {
    return t('settingsManagedKeyFailNetwork')
  }
  if (failure.kind === 'empty') {
    return t('settingsManagedKeyFailEmpty')
  }
  return t('settingsManagedKeyFailHttp', { status: String(failure.status) })
}

/** 视图要的取词签名（与 `useTranslate()` 同形；单测注入真 zh 表） */
export type ManagedKeyViewText = (
  key: TranslationKey,
  params?: TranslationParams
) => string

export type ManagedKeyEnsureBannerProps = {
  t: ManagedKeyViewText
  /** 后台那条「确保有 Key」现在跑到哪一步（`managedKeyEnsureState`） */
  status: ManagedKeyEnsureStatus
  /** 最后一次失败（`status === 'failed'` 时非空） */
  failure: ManagedKeyFailure | null
  /** 这次一共尝试了几次（2 = 已自动重试过一次） */
  attempts: number
  onRetry: () => void
  Button: ManagedKeyButton
  styles: Record<string, string>
}

/**
 * 「自动获取 Key 失败」的提示块：**红字 + 「重试」按钮**，不是一句静默的日志（#803 第 5 条）。
 *
 * 为什么要有它：这条流程是后台跑的（登录 / 注册成功后自己触发），失败时用户手上没有任何按钮可点、
 * 界面上也什么都没有 —— 表现就是「注册好了，但发不出消息」，而原因（超时 / 500 / 服务端没下发 Key）
 * 全在日志里。所以失败必须**在界面上停住**，并把重试留在原地。
 *
 * 渲染条件只看「有没有留着一条失败」：`idle`（没跑过 / 刚成功）时不占地方；
 * `running` 时**继续显示上一次的失败**（否则用户点「重试」的瞬间提示会闪没），
 * 只是把按钮置灰换成「正在领取…」—— 重试在飞的时候连点会打出两次 `POST /api/v1/keys`。
 */
export const ManagedKeyEnsureBanner = (props: ManagedKeyEnsureBannerProps): ReactNode => {
  const { t, status, failure, attempts, onRetry, Button, styles } = props
  if (status === 'idle' || failure === null) {
    return null
  }
  const reason = managedKeyEnsureFailureReason(t, failure)
  const running = status === 'running'
  return createElement(
    'div',
    {
      className: styles.viewBody,
      role: 'alert',
      'data-testid': 'settings-managed-key-ensure-failed',
    },
    createElement(
      'p',
      { key: 'reason', className: styles.errorText, 'data-testid': 'settings-managed-key-ensure-reason' },
      t('settingsManagedKeyEnsureFailed', { reason, attempts: String(Math.max(attempts, 1)) })
    ),
    createElement(
      'p',
      { key: 'hint', className: styles.sourceNote, 'data-testid': 'settings-managed-key-ensure-hint' },
      t('settingsManagedKeyEnsureFailedHint')
    ),
    createElement(
      Button,
      {
        key: 'retry',
        variant: 'outlined',
        size: 's',
        disabled: running,
        testId: 'settings-managed-key-ensure-retry',
        onClick: onRetry,
      },
      running ? t('settingsManagedKeyClaiming') : t('retry')
    )
  )
}
