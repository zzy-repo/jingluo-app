/**
 * 「模型来源」子页里**要渲染哪些字段行**（Issue #800）—— 唯一判定处。
 *
 * 为什么单独一个 `.ts`：这一页「哪些控件在 DOM 里」正是 #800 的验收对象
 * （内置服务不许出现 Key 输入框 / Key 展示区 /「重新领取」），而 `.tsx` 在裸 Node 单测里
 * import 不了。把「渲染哪些行」抽成纯函数后，界面（`ApiConfigFields`）与单测**共用同一份判定**
 * —— 单测断的不是一份平行真理，而是界面真的会用的那张表。
 *
 * ## 规则
 *
 * - 字段清单仍然来自 `providers.ts` 的 `spec.fields`（地址 / Key / 模型由渠道形状决定，
 *   这里不重抄一遍）；
 * - **唯一的减法**：`apiKey` 这一行在「Key 由服务端管理」的渠道上（`ours` = 内置服务）
 *   **整行不渲染**。不是隐藏、不是禁用、不是空占位 —— 结构上就没有那一段 DOM，
 *   所以「重新领取」（它长在 Key 行里）也随之消失。
 *
 * ## 为什么 `ours` 连展示都不需要（Issue #800 的结论）
 *
 * 内置服务的 Key 由服务端下发（`services/api/managedKey.ts`），本机既不能填也不能换；
 * 展示一个尾号 +「重新领取」按钮，除了让用户以为这里有可操作的东西，没有别的用途。
 * 领取与恢复全部走后台：启动（以及登录后）由 `syncManagedKeyFromServer()` 做幂等对齐，
 * 发送前那道闸发现「不是服务端那把」时还会在设置里自动再对齐一次
 * （`AccountConsumePage` 的 `managedKeyBlocked` 分支）—— 用户不需要按钮。
 */
import { getSpec, type ProviderField, type ProviderKind } from '../../services/api/providers.js'
import { apiKeyFieldMode } from './managedKeyView.js'

/** 字段行就是 spec 里的三种字段，这里只负责「渲染哪一个」 */
export type SourceFieldRow = ProviderField

/**
 * 这个渠道在「模型来源」子页里要渲染的字段行（顺序 = `spec.fields` 的顺序）。
 *
 * 例：
 *  - `ours`      → `[]`（内置服务：地址/模型内置，Key 由服务端下发 → 一行都没有）
 *  - `deepseek`  → `['apiKey']`（官方渠道：只填 Key，地址/模型内置）
 *  - `openai` / `anthropic` → `['baseUrl', 'apiKey', 'model']`（第三方服务：三件套）
 */
export const sourceFieldRows = (kind: ProviderKind): SourceFieldRow[] =>
  getSpec(kind).fields.filter(
    (field) => field !== 'apiKey' || apiKeyFieldMode(kind) === 'editable'
  )

/**
 * 这一页会不会出现 Key 相关控件（输入框 / 掩码展示区 /「重新领取」）。
 *
 * #800 的验收判据：内置服务必须 `false`（DOM 里连节点都没有），第三方与官方必须 `true`。
 */
export const rendersKeyControls = (kind: ProviderKind): boolean =>
  sourceFieldRows(kind).includes('apiKey')
