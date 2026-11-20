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
 * 四个渠道的取值：
 * - `anthropic` / `openai` / `ours`：没有可靠的原生文件能力（我们渠道没有 `/files`
 *   路由，见 #37 的 2059 条 404），走 #480 的文本注入（`textInjection: true`）。
 * - `deepseek`：**两条都是 `false`** —— 见下面 §#538 的语义收紧。
 *
 * 与 `SPECS[kind].paths.files` 的一致性：`textInjection: true` 的三个渠道恰好都没有
 * `paths.files`。这张表是**唯一判定处**，接线点（`chat/store.ts` 的请求组装）、纯函数
 * （`attachments/inject.ts`）与 UI 门（`chatInput/ChatInput.tsx`）都只看它，
 * 没人再自己判断渠道。
 *
 * ## #538：`nativeFile` 的语义收紧（本单唯一的语义变更）
 *
 * 原来 `deepseek: {nativeFile: true}` 表达的是「理论上支持原生文件、不要用文本注入碰它」。
 * 但实测这个「支持」在本仓库**没有实现**：`/v1/chat/completions/files` 早在 #360 就确认
 * 不存在（线上 404），也就是说 DeepSeek 渠道既不上传原件、也不注入正文 —— 用户只传文档
 * 不写字时，消息 content 是**空**的。
 *
 * 于是把 `nativeFile` 的含义收紧成「**本仓库对该渠道确有可用的原生文件上传实现**」，
 * 而不是「上游理论上支持」：`deepseek` 因此为 `false`。这样「这个渠道能不能收文档」
 * 就是一个诚实的判断（`acceptsDocuments()`），UI 才不会给出假承诺（#538 的核心诉求）。
 *
 * 为什么**收紧含义**而不是新增 `nativeFileImplemented`：能力表是**判定表**，一个轴一个字段
 * 就够。再加一个布尔会产生 4 种组合（含 `nativeFile:true, implemented:false` 这种自相矛盾的
 * 行），每个消费方还得再问一句「我该看哪个字段」—— 这正是本文件开头第 1 条要避免的
 * 「两处各写一遍」。取名即语义：`nativeFile` 现在只回答「有没有真能用的实现」。
 *
 * 未来 DeepSeek 真接上原生上传时，只需把该行改回 `nativeFile: true`（并在 `paths.files`
 * 登记端点），UI 入口与发送闸会一并放开 —— 一处开关。
 */
import type { ProviderKind } from '../api/providers.js'

export interface DocumentInjectionCapability {
  /** 该渠道是否把文档当纯文本注入（#480 §7：普通 text 消息，不上传原始二进制、不 Base64） */
  textInjection: boolean
  /**
   * 本仓库对该渠道**确有可用的原生文件上传实现**（`spec.paths.files` 已登记且发送链路
   * 真的会为附件补传、用 `file_id` 引用）。
   *
   * 注意：这里回答的是「**我们有实现**」，不是「上游理论上支持」。`deepseek` 属于后者
   * （上游有 `POST /files`，但我们的渠道没有这条路由，见 #360），所以是 `false`。
   */
  nativeFile: boolean
}

/**
 * 四渠道能力表。**新增渠道必须在这里显式登记**（`Record<ProviderKind, …>` 会在
 * 类型层强制：漏写一个渠道就编译不过），不允许靠默认值兜过去。
 */
const CAPABILITIES: Record<ProviderKind, DocumentInjectionCapability> = {
  /**
   * 官方原生文件能力：`textInjection` 保持 `false`，让 DeepSeek 请求路径**逐字节不变**
   * （#480 的硬约束，本单对它零改动）。
   * `nativeFile: false` 是**如实描述**：本仓库没有可用的原生上传实现（#360），
   * 所以这个渠道**收不了文档**，UI 入口必须关掉（#538）。
   */
  deepseek: { textInjection: false, nativeFile: false },
  anthropic: { textInjection: true, nativeFile: false },
  openai: { textInjection: true, nativeFile: false },
  ours: { textInjection: true, nativeFile: false },
}

/**
 * 未知渠道（老配置 / 手工改过的 localStorage / 未来新增没登记）：
 * **fail-closed** —— 不注入、也不假装有原生能力。宁可不收文档，也不擅自往一个
 * 我们不了解的上游塞几万字正文（那可能直接 400，或者把用户文档发给错的服务商）。
 *
 * 注入侧只看 `textInjection`（`attachments/inject.ts` / `chat/store.ts`），所以
 * `nativeFile` 可以照实写 `false`：两个 `false` 合起来正好等于「这个渠道不收文档」，
 * 由 `acceptsDocuments()` 统一判定，UI 与发送闸同源。
 */
const UNKNOWN_CHANNEL: DocumentInjectionCapability = { textInjection: false, nativeFile: false }

/**
 * 某个渠道的文档收取方式。返回**副本**：调用方拿到后写不坏这张表
 * （`as const` 之外的第二道保险，避免有人在别处 `caps.textInjection = true` 就地改规则）。
 */
export function docInjectionFor(kind: ProviderKind): DocumentInjectionCapability {
  const caps = CAPABILITIES[kind]
  return caps ? { ...caps } : { ...UNKNOWN_CHANNEL }
}

/**
 * 该渠道**能不能收文档**（注入或原生，任一为真即可）。
 *
 * 这是 #538 引入的**唯一判定口**：UI 入口（`ChatInput` 的文档按钮 / 拖入 / 粘贴）与
 * 发送闸（`chat/store.ts` 的 `sendMessage`）都问它，避免「按钮藏了但别的路还能塞进来」。
 * 两个 `false` 的渠道（`deepseek` 与未知渠道）一律不收 —— 后者是 fail-closed。
 */
export function acceptsDocuments(kind: ProviderKind): boolean {
  const caps = docInjectionFor(kind)
  return caps.textInjection || caps.nativeFile
}
