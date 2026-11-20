/**
 * 渠道能力表：**一个渠道一个能力对象**，回答「这个渠道怎么收文档」（#480）与
 * 「这个渠道怎么收图片」（#551 / 母单 #548）。
 *
 * 表只有这一张（#562 定的所有权）：`providers.ts` 的 `caps`（UI 开关）、`paths`（有没有端点）
 * 是渠道的静态描述，而「拿这个渠道的附件怎么办」的判定**只在这里**。请求侧拼装、发送前准备、
 * UI 入口门禁都查这张表，没人再自己写 `if (kind === ...)`。
 *
 * ## 两个维度，四个渠道，形状统一
 *
 * ```ts
 * CAPABILITIES[kind] = {
 *   documents: { textInjection, nativeFile },   // #480：文档当文本注入 / 走原生文件
 *   image:     { base64, nativeFile },          // #551：图片本地编码内联 / 走 file_id
 * }
 * ```
 *
 * 两条通路各自**互斥**，必须显式声明：同时为 true 会把同一份内容发两遍（既烧 token，
 * 又可能让上游把它当两次不同输入），所以「怎么收」不是猜的，是写下来的。
 *
 * ### 两个 `nativeFile` 不是同一个意思（别拿错）
 *
 * - `documents.nativeFile`：**本仓库对该渠道确有可用的「文档当原生文件」实现**。
 *   `deepseek` 是 `false` —— 见下面 §#538 的语义收紧（`/v1/chat/completions/files` 在 #360
 *   就确认不存在，上传文档这条路对本仓库不成立）。
 * - `image.nativeFile`：**图片走 Files API 上传拿 `file_id`**（`{type:'image',
 *   source:{type:'file', file_id}}`）。`deepseek` 是 `true` —— 它的 `paths.files`
 *   （`/anthropic/v1/files`）真的能传图片，现网图片链路一直这么走。
 *
 * 同名不同义是刻意的：两个维度问的是不同的东西（一个是"文档能不能当文件"，一个是
 * "图片能不能当文件"），合并成一个字段会立刻出现自相矛盾的行（`deepseek` 需要
 * `false` 与 `true` 同时成立）。放在各自维度里，名字就回到它本来的意思。
 *
 * ### 和 `providers.ts` 的 `caps.vision` 是什么关系（别混用）
 *
 * - `caps.vision`（`providers.ts` 的 `ProviderCaps`）：**UI 上有不有附件入口**。这是 #480 的
 *   既有语义，入口门禁是 `caps.vision && supportsFileUpload()`（`ChatInput.tsx`）。
 *   **本单不动它**（#562：以 A 的结构为准）：`anthropic / openai / ours` 仍是 `false`，
 *   否则会出现「入口亮着、点下去拿不到图」的假承诺。
 * - `visionFor(kind)`（本文件）：**请求体里图片怎么走**。这是 #562 要求 B 线追加的 `image` 维度。
 *   三个渠道这一维已经是 `base64: true` —— 声明的是「通路存在」，不是「入口已打开」。
 *
 * 两者在接线那一步一起翻（入口门禁改成 `caps.vision && (supportsFileUpload() ||
 * visionFor(kind).base64)`，同时把三家渠道的 `caps.vision` 置真并配上注入链路），
 * 现在只落前者会让用户选到一张发不出去的图 —— 那是 #548 明令禁止的「静默丢图」。
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
 * 图片在**请求体里怎么走**：两种通路互斥，一张图只能走其中一条。
 * - `nativeFile`：上传 Files API 拿 `file_id`，请求里放 `{type:'image', source:{type:'file', file_id}}`
 *   （今天只有 deepseek 声明了 `paths.files`，所以只有它走这条）；
 * - `base64`：本地编码后内联，anthropic 用 `{type:'image', source:{type:'base64', …}}`，
 *   openai / ours 用 `{type:'image_url', image_url:{url:'data:…'}}`（由 `openaiAdapter` 翻译）。
 *
 * 两者都为 false = **一张图都发不出去**（未知渠道 / 未来新增但没有视觉能力的渠道），
 * 调用方必须给明确提示，不许静默丢图。
 */
export interface ImageTransportCapability {
  /** 本地编码成 base64 内联进请求体 */
  base64: boolean
  /** 走 Files API 的 file_id 引用 */
  nativeFile: boolean
}

/** 一个渠道的完整能力对象。新增维度就往这里加一层，**不要另开第二张表**。 */
export interface ChannelCapability {
  /** #480：文档（TXT / DOCX / PDF）怎么收 */
  documents: DocumentInjectionCapability
  /** #551：图片怎么收 */
  image: ImageTransportCapability
}

/**
 * 四渠道能力表。**新增渠道必须在这里显式登记**（`Record<ProviderKind, …>` 会在
 * 类型层强制：漏写一个渠道就编译不过），不允许靠默认值兜过去。
 */
const CAPABILITIES: Record<ProviderKind, ChannelCapability> = {
  /**
   * DeepSeek 官方：文档走**原生文件能力**、图片走 `file_id`，两条都保持 `textInjection: false`，
   * 让 DeepSeek 请求路径**逐字节不变**（#480 / #551 的硬约束，对它零改动）。
   *
   * `documents.nativeFile: false` 是**如实描述**：本仓库没有可用的原生文档上传实现（#360），
   * 所以这个渠道**收不了文档**，UI 入口必须关掉（#538）。
   * `image.nativeFile: true` 则是现网事实：图片一直走 `paths.files` 上传 + `file_id` 引用。
   */
  deepseek: {
    documents: { textInjection: false, nativeFile: false },
    image: { base64: false, nativeFile: true },
  },
  anthropic: {
    documents: { textInjection: true, nativeFile: false },
    image: { base64: true, nativeFile: false },
  },
  openai: {
    documents: { textInjection: true, nativeFile: false },
    image: { base64: true, nativeFile: false },
  },
  ours: {
    documents: { textInjection: true, nativeFile: false },
    image: { base64: true, nativeFile: false },
  },
}

/**
 * 未知渠道（老配置 / 手工改过的 localStorage / 未来新增没登记）：
 * **fail-closed** —— 不注入文档、不假装有原生能力、也不猜图片走哪条通路。
 * 宁可不收，也不擅自往一个我们不了解的上游塞几万字正文或几 MB base64
 * （那可能直接 400，或者把用户的附件发给错的服务商）。
 *
 * 注入侧只看 `documents.textInjection`（`attachments/inject.ts` / `chat/store.ts`），
 * 所以 `nativeFile` 可以照实写 `false`：两个 `false` 合起来正好等于「这个渠道不收文档」，
 * 由 `acceptsDocuments()` 统一判定，UI 与发送闸同源。
 */
const UNKNOWN_CHANNEL: ChannelCapability = {
  documents: { textInjection: false, nativeFile: false },
  image: { base64: false, nativeFile: false },
}

/**
 * 某个渠道的完整能力对象。返回**副本**：调用方拿到后写不坏这张表
 * （`as const` 之外的第二道保险，避免有人在别处 `caps.image.base64 = true` 就地改规则）。
 */
export function channelCapabilityOf(kind: ProviderKind): ChannelCapability {
  const caps = CAPABILITIES[kind]
  const source = caps ?? UNKNOWN_CHANNEL
  return { documents: { ...source.documents }, image: { ...source.image } }
}

/**
 * 某个渠道的文档收取方式。返回**副本**：调用方拿到后写不坏这张表
 * （`as const` 之外的第二道保险，避免有人在别处 `caps.textInjection = true` 就地改规则）。
 */
export function docInjectionFor(kind: ProviderKind): DocumentInjectionCapability {
  return channelCapabilityOf(kind).documents
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

/**
 * 某个渠道的图片通路。**唯一判定处**（#551）：请求侧拼装、发送前准备、UI 入口判定都查它。
 *
 * 为什么三渠道只能是 base64：#360 起「附件上传必须渠道显式声明 `paths.files`」，
 * 而 anthropic / openai / ours 没有、也不会有这条路由（`/v1/chat/completions/files` 在网关
 * 根本不存在，曾占 84% 的 404 流量）→ 这三家的图片**不可能走上传**，只能本地编码。
 *
 * deepseek 保持 `nativeFile` 通路，行为与改造前**逐字节一致**（#551 的零改动边界）。
 * 未知渠道 fail-closed：两条通路全关（猜一条通路的代价是 404 刷屏或上游 400）。
 */
export function visionFor(kind: ProviderKind): ImageTransportCapability {
  return channelCapabilityOf(kind).image
}

/**
 * 该渠道**能不能收图片**（两条通路任一为真）。UI 入口与发送闸都问它，
 * 而不是各自去看 `caps.vision` 或 `paths.files` —— 那两个各自只回答一半问题。
 */
export function supportsImage(kind: ProviderKind): boolean {
  const caps = visionFor(kind)
  return caps.base64 || caps.nativeFile
}
