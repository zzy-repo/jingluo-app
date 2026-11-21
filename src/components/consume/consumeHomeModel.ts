/**
 * 「账户与消费」整页（#727 阶段 1 / P0 最小可发布集）的**纯投影**。
 *
 * 这个文件里只有「把既有实现的结果换算成一行字 / 一个颜色」的判断，**没有第二种口径**：
 *
 *  连通性  → `services/api/client.ts` 的 `probeProvider()`（现存的那条 `/models` 探测，
 *            与设置页「连通性测试」同一个函数、同一份错误分类 `reason`），这里只把它归成三态；
 *  余额    → `components/consume/quotaPanelModel.ts` 的 `quotaSummaryOf()`（`spent = actual_cost`，
 *            **不是** `quota.used`）。这里只决定「钱包卡上的大数字取哪个字段」；
 *  模型来源 → `services/api/providers.ts` 的 `PROVIDER_SPECS`（`ProviderKind` 换皮）。
 *            **不新增渠道枚举**：选项、标签、字段全由既有 spec 驱动。
 *
 * 为什么抽成纯函数：`node --test` 只认 `.ts`（JSX 不在类型擦除范围内），
 * 只有把这三处判断放在这里，单测才能对**真代码**断言，而不是对着测试自己复刻的一份分支。
 */

import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { ProviderProbeResult } from '../../services/api/client.js'
import { PROVIDER_SPECS, type ProviderKind } from '../../services/api/providers.js'
import type { QuotaSummary } from './quotaPanelModel.js'

/**
 * 连通性三态（外加 `idle` / `testing` 两个过程态）。
 *
 * 与 #727 原型一致：`正常 42 ms` / `测试中…` / `连接失败 · 重试`，用绿 / 黄 / 红圆点区分。
 * 三态里「Key 无效」与「网络或配置错」分开显示，是因为用户要做的下一步不同
 * （换 Key ←→ 查地址 / 网络），但这个区分**来自既有 `probeProvider` 的 status**，
 * 这里不新增一套错误分类表。
 */
export type ConnectivityPhase = 'idle' | 'testing' | 'ok' | 'keyInvalid' | 'error'

/** Key 被视为「无效」的 HTTP 状态：与 `consume/errors.ts` 的会话判据同一组（401 / 403） */
export const KEY_REJECT_STATUSES: readonly number[] = [401, 403]

export const connectivityOf = (
  probe: ProviderProbeResult | null,
  testing: boolean
): ConnectivityPhase => {
  if (testing) {
    return 'testing'
  }
  if (probe === null) {
    return 'idle'
  }
  if (probe.ok) {
    return 'ok'
  }
  const status = probe.status
  if (status !== undefined && KEY_REJECT_STATUSES.indexOf(status) >= 0) {
    return 'keyInvalid'
  }
  return 'error'
}

/** 一行文案：key + 占位符。界面只 `t(key, params)`，不在渲染里拼中文。 */
export type ConnectivityLabel = { key: TranslationKey; params?: TranslationParams }

export const connectivityLabelOf = (
  phase: ConnectivityPhase,
  elapsedMs?: number
): ConnectivityLabel => {
  switch (phase) {
    case 'ok':
      return { key: 'accountConsumeConnOk', params: { ms: elapsedMs ?? 0 } }
    case 'testing':
      // 与设置页「连通性测试」同一个过程态文案（`settingsTesting`），不另写一句
      return { key: 'settingsTesting' }
    case 'keyInvalid':
      return { key: 'accountConsumeConnKeyInvalid' }
    case 'error':
      return { key: 'accountConsumeConnError' }
    default:
      return { key: 'accountConsumeConnIdle' }
  }
}

/** 模型来源一行（原型：`模型来源` 右侧显示当前来源） */
export type ModelSourceOption = {
  kind: ProviderKind
  /** 既有 spec 的双语标签（`我们的渠道` / `OpenAI 兼容` / …），不新增第二套渠道名 */
  zh: string
  en: string
}

/**
 * 底部 sheet 的选项 = `PROVIDER_SPECS` 原样（顺序与设置页下拉一致）。
 *
 * 原型里的三个选项（内置服务 / 第三方服务 / DeepSeek 官方服务）对应到真实渠道是四选一：
 *  「第三方服务」在实际仓库里是**两条协议**（OpenAI 兼容 / Anthropic 协议），
 *  合并成一条会让用户选不到自己那家中转，所以这里照既有 spec 列出四条，不另造枚举。
 */
export const modelSourceOptions = (): ModelSourceOption[] =>
  PROVIDER_SPECS.map((spec) => ({ kind: spec.kind, zh: spec.label.zh, en: spec.label.en }))

/** 当前来源在 sheet 里打勾 / 在行尾显示，都读同一份 spec 标签 */
export const modelSourceLabel = (kind: ProviderKind, lang: 'zh' | 'en'): string => {
  const found = PROVIDER_SPECS.filter((spec) => spec.kind === kind)[0]
  return found === undefined ? '' : found.label[lang]
}

/**
 * 钱包卡的「大数字」取哪个字段。
 *
 * 口径照抄 `quotaSummary.showRemaining`：钱包模式（`unrestricted`）下 `remaining` 就是余额，
 * 再显示一行「剩余」会出现「余额 / 已用 / 剩余」三数看着像算错；限额模式下才以 `remaining` 为主。
 * 这里**不重新算余额**，只是挑字段。
 */
export const walletRemainingOf = (summary: QuotaSummary | null | undefined): number | undefined => {
  if (summary === null || summary === undefined) {
    return undefined
  }
  return summary.showRemaining
    ? summary.remaining === undefined
      ? summary.balance
      : summary.remaining
    : summary.balance === undefined
      ? summary.remaining
      : summary.balance
}
