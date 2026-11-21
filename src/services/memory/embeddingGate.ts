/**
 * embeddingGate.ts — 窗口记忆的 embedding 门（#398）：**开关关着就一个请求都不发**。
 *
 * 这个文件是**本仓库自研代码**，不是同目录下 `embedding.js` / `recall.js` 那批 vendored 上游代码
 * （来源与许可见 `src/services/memory/README.md`）；命名带 `Gate` 后缀就是为了不和 vendored 的
 * `embedding.js` 混成同一个模块 —— 后者是上游客户端的移植版，`./embedding.js` 在打包器与单测里
 * 还会按 `.js → .ts` 的约定解析，两个同名模块挨着放只会让下一个改这里的人导错。
 *
 * ## 为什么要这道门
 *
 * 窗口记忆的 embedding 是**唯一一类会把聊天内容发到外部服务做向量化**的请求。#398 的口径是
 * 「默认关闭，关闭后零外部请求」——注意是**零**，不是「少」。所以判定必须发生在任何地址解析、
 * 鉴权头拼装、`fetch` 之前，而且只有一处：
 *
 *   - `isEmbeddingEnabled()` 是唯一的判定（读 `services/settings.ts` 的 `embeddingEnabled`，
 *     默认 false，未存过 / 脏值都按 false）；组件、召回链路、将来 #399 的接线**一律走这里**，
 *     不许在别处再写一遍 `useSettings.getState().embeddingEnabled === ...`（两套判断必然漂移）。
 *   - `embed()` 是记忆侧唯一出口：关闭态**在任何网络调用之前**抛 `EmbeddingDisabledError`。
 *     刻意抛错而不是返回「空向量」：`services/api/embedding.ts` 的既有约定是失败返回
 *     `{ ok: false, vectors: [] }`，如果关闭态也返回空向量，调用方会把它当成「上游没配好」
 *     而静默降级 —— 用户永远不知道自己关着开关、也永远看不到「这是你关的」。#398 要的是
 *     **说得出口的未启用**，不是又一条静默降级路径。
 *   - 打开态直接转交 `services/api/embedding.ts` 的 `embedTexts()`（#397 收进 API 层的那个出口）：
 *     地址 / 鉴权头 / 超时 / 错误分类都在那一层，这里**不另立一套**请求栈，也不做本地推理。
 *     本单只做门，不做真正的 embedding 调用实现。
 *
 * ## 边界（写清楚，别让下一个人以为已经全接完了）
 *
 * - 现在 app 里**没有**调用 `embed()` 的地方：召回链路接线是 #399 的事。本单保证的是
 *   「开关存在 + 默认关闭 + 关闭态调用一个请求都不发 + 状态持久化」，即 #398 的关闭条件。
 * - 同目录 `embedding.js`（vendored）自己调 `embedTexts()` 的那条路**尚未接进 app 运行时**
 *   （`src/` 里没有任何模块 import 它）。#399 接线时必须让它改走本文件的 `embed()`，
 *   否则会出现第二套判断 —— 到时一并把 vendored 目录从 `scripts/lib/vendoredPaths.mjs`
 *   的排除名单里拿出来。
 */
import { embedTexts, type EmbeddingResult } from '../api/embedding.js'
import { useSettings } from '../settings.js'

/** 关闭态的错误码：调用方要按码判断，不要去 match 中文文案 */
export const EMBEDDING_DISABLED = 'embedding-disabled'

/** 关掉开关时 `embed()` 抛的错：**明确的「未启用」**，不是静默返回空向量 */
export class EmbeddingDisabledError extends Error {
  readonly code = EMBEDDING_DISABLED

  constructor() {
    super('embedding 未启用：设置里的开关是关闭的，这次没有发出任何请求')
    this.name = 'EmbeddingDisabledError'
  }
}

/**
 * 判定唯一来源（#398）：`services/settings.ts` 的 `embeddingEnabled`。
 * 默认 false；读不到设置 / 存了脏值也是 false（见 `initialEmbeddingEnabled`）。
 */
export const isEmbeddingEnabled = (): boolean => useSettings.getState().embeddingEnabled

export type EmbedOptions = {
  /** 待向量化文本；空数组 = 成功且空结果，与 `embedTexts` 同一口径 */
  input: string[]
  model?: string
  expectedDimensions?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * 记忆侧唯一的 embedding 出口。
 *
 * - 开关关着 → **先抛 `EmbeddingDisabledError`**，`fetch` 一次都不会被调用；
 * - 开关开着 → 转交 `embedTexts()`（#397 的 API 层出口），失败仍是 `{ ok: false }` 不抛错。
 *
 * 调用方（#399 的召回链路）应当先看 `isEmbeddingEnabled()`：关着就直接走 BM25，
 * 连 `embed()` 都不用调；真走到这里也必须能接住 `EmbeddingDisabledError`。
 */
export const embed = async (options: EmbedOptions): Promise<EmbeddingResult> => {
  if (!isEmbeddingEnabled()) {
    // 早返回点只有一个：删掉这两行，「关闭态 fetchCalls === 0」的用例必须变红
    // （tests/unit/memory-embedding-toggle-398.test.mjs 的负向对照就是删它）
    throw new EmbeddingDisabledError()
  }
  return embedTexts(options)
}
