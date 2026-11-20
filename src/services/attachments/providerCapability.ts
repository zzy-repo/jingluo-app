/**
 * #480 §7「模型请求兼容」的**渠道能力表**：谁能收文档、以什么方式收。
 *
 * 为什么需要一张表，而不是在请求组装处写 `if (kind === ...)`：
 * 1. 「这个渠道怎么收文档」是渠道本身的属性，和 `providers.ts` 里的 `paths.files`
 *    （有没有文件上传端点）、`caps.vision`（有没有附件入口）是同一层级的事实，
 *    散落在请求链路上必然会出现「两处各写一遍、改一处忘一处」（#297 的教训）。
 * 2. 两条路径是**互斥**的，必须显式声明清楚：要么把正文当纯文本注入，
 *    要么保留上游原生文件能力。两者同时为 true 会把同一份文档发两遍（既烧 token
 *    又可能让上游把它当两次不同输入）。
 *
 * 三条取值口径（与 issue 一致）：
 * - `deepseek`：DeepSeek 官方 API 自 2026-11-13 起有原生文件解析
 *   （`POST /files` + `purpose=text_recognition`，`/chat/completions` 用
 *   `{"type":"file","file_id":...}` 引用），本仓库现有链路走的就是它
 *   （`FileAttachment.serverId` → `document`/`image` 块）。**一行都不许改。**
 * - `anthropic` / `openai` / `ours`：没有可靠的原生文件能力（我们渠道没有 `/files`
 *   路由，见 #37 的 2059 条 404），走 #480 的文本注入。
 *
 * 与 `SPECS[kind].paths.files` 的一致性：`textInjection: true` 的三个渠道恰好都没有
 * `paths.files`。这张表是**唯一判定处**，接线点（`chat/requestBody.ts`）与纯函数
 * （`attachments/inject.ts`）都只看它，没人再自己判断渠道。
 */
import type { ProviderKind } from '../api/providers.js'

export interface DocumentInjectionCapability {
  /** 该渠道是否把文档当纯文本注入（#480 §7：普通 text 消息，不上传原始二进制、不 Base64） */
  textInjection: boolean
  /** 是否需要保留原生文件能力（DeepSeek 官方可能已支持，不要动） */
  nativeFile: boolean
}

/**
 * 四渠道能力表。**新增渠道必须在这里显式登记**（`Record<ProviderKind, …>` 会在
 * 类型层强制：漏写一个渠道就编译不过），不允许靠默认值兜过去。
 */
const CAPABILITIES: Record<ProviderKind, DocumentInjectionCapability> = {
  /** 官方原生文件能力：现有 `file_id` 链路照旧，本单对它零改动 */
  deepseek: { textInjection: false, nativeFile: true },
  anthropic: { textInjection: true, nativeFile: false },
  openai: { textInjection: true, nativeFile: false },
  ours: { textInjection: true, nativeFile: false },
}

/**
 * 未知渠道（老配置 / 手工改过的 localStorage / 未来新增没登记）：
 * **fail-closed** —— 不注入，等价于「按原路径发」。宁可不注入，也不擅自往一个
 * 我们不了解的上游塞几万字正文（那可能直接 400，或者把用户文档发给错的服务商）。
 * 这一档刻意与 `deepseek` 同形：`nativeFile: true` 表示「不要用文本注入碰它」。
 */
const UNKNOWN_CHANNEL: DocumentInjectionCapability = { textInjection: false, nativeFile: true }

/**
 * 某个渠道的文档收取方式。返回**副本**：调用方拿到后写不坏这张表
 * （`as const` 之外的第二道保险，避免有人在别处 `caps.textInjection = true` 就地改规则）。
 */
export function docInjectionFor(kind: ProviderKind): DocumentInjectionCapability {
  const caps = CAPABILITIES[kind]
  return caps ? { ...caps } : { ...UNKNOWN_CHANNEL }
}
