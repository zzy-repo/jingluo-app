# 能力矩阵：三种服务类型下的真实可用性

> 适用范围：deepseek-app 1.3.0（commit `e2ed1ce`）
> 结论口径：**以代码为准**，不看文档承诺。单元格里的「原因」用 `文件` + 符号定位（函数名 / 常量名 / 唯一字符串），
> **不写行号**：行号引一次是准的，代码一动就错（issue #290 的根因就是它）。
> 三种服务类型：`deepseek`（DeepSeek 官方）/ `anthropic`（Anthropic 兼容中转）/ `openai`（OpenAI 兼容）。
> 能力总开关定义在 `src/services/api/providers.ts` 的 `RAW_SPECS`（每份 spec 的 `caps`），请求侧字段门控集中在 `REQUEST_GATES`。

## 0. 判定依据与已知背景

**代码路径**（本矩阵的全部证据来源）

| 环节 | 文件 |
| --- | --- |
| 三种 spec 的 `caps` / `paths` / `extended` | `src/services/api/providers.ts` |
| 请求路径拼装、鉴权头、流式请求 | `src/services/api/apiConfig.ts` 的 `getMessagesUrl()` / `getModelsUrl()`、`src/services/api/client.ts` 的 `streamMessage` |
| OpenAI 协议双向翻译 | `src/services/api/openaiAdapter.ts` |
| 请求体字段「发 / 不发」 | `src/services/api/providers.ts` 的 `REQUEST_GATES` + `src/services/chat/store.ts` 里 `streamMessage(...)` 调用处的 `gates.*` 展开 |
| 请求体 messages 拼装（含 reminder 折叠、prefill） | `src/services/chat/reply.ts` 的 `toRequestMessages()` / `foldReminders()` |
| 响应侧事件白名单 | `src/services/api/parseEvent.ts` |
| UI 入口显隐 | `src/components/`（下表逐条给行号） |
| 已有断言覆盖 | `tests/integration/full-acceptance.test.mjs`（8 组一次性验收）+ `tests/integration/caps.test.mjs`（能力降级）+ `tests/integration/paths.test.mjs` / `request-body.test.mjs`（路径与请求体） |

**2026-11 实测结论（可直接引用，本矩阵不再重复验证）**

- DeepSeek 私有字段：`safety_check`、`title`、`tools:[deepseek_web_search|deepseek_read_url]`、`role:'latest_reminder'`。
- 裸 Anthropic 不认这些字段（未知顶层字段 / 非法 role → 400），1.2.3 起做剥离，并把 reminder 折进 `system`（`store.ts` 的 `toRequestBody()`、`reply.ts` 的 `foldReminders()`）。
- OpenAI 兼容模式走 `/v1/chat/completions`，SSE 需翻译成 Anthropic 事件（`openaiAdapter.ts`）。
- 三类上游普遍缺失：搜索执行、链接抓取、自动标题、安全审核、ASR/TTS、Files API。

**关于 `—不适用`**：本表没有出现该标记。三种 spec 对每项能力都给出了「发不发 / 有没有入口」的明确结论（`providers.ts` 的 `RAW_SPECS`），不存在协议上无意义的空位；不可用一律是 `❌`，且注明是「上游没接口」还是「我们主动砍」。

---

## 一、总表

| 能力 | DeepSeek 官方 | Anthropic 协议 | OpenAI 兼容 |
| --- | --- | --- | --- |
| 基础文本对话 | ✅可用 —— `POST /anthropic/v1/messages`，`system` + `messages` 直发，`x-api-key` 鉴权（`providers.ts` 的 `SPECS`、`client.ts:276-285`） | ✅可用 —— 路径换 `/v1/messages`，正文链路一字不改，只剥私有字段（`providers.ts:225`、`tests/integration/full-acceptance.test.mjs`（第 7 组：anthropic `/v1/*` + 字段剥离）） | ✅可用 —— `POST /v1/chat/completions` + `Bearer`，请求体经 `toOpenAIRequest` 翻译（`providers.ts:136`、`openaiAdapter.ts:71-94`） |
| 流式输出 | ✅可用 —— 原生 SSE，`readServerSentEvents` → `readMessageEvent` 逐事件消费（`client.ts` 的 `readServerSentEvents`） | ✅可用 —— 与 DeepSeek 走同一段 `streamMessage`，1.2.3 起就是纯透传（`client.ts` 的 `streamMessage`） | ✅可用 —— 翻译器把 chunk 转成严格合法的 `content_block_delta` 序列，断流也会补 `message_stop`（`openaiAdapter.ts:237-337`） |
| 深度思考 | ✅可用 —— 请求带 `thinking:{type:'enabled'}`，字段发不发由 `requestBody.ts` 的 `buildMessageBody()` 按 `gates.reasoning_param` 判定，思考块按 `thinking_delta`/`signature_delta` 累积（`reply.ts:103-108`） | ✅可用 —— 同一个开关，另自动补 `budget_tokens:4096`（真 Anthropic 必填，`requestBody.ts` 的 `gates.thinking_budget` 分支、`providers.ts:128`） | ⚠️按档位 —— 出厂 `reasoningParam:'none'`：`caps.thinking=false`，入口仍常驻（#341：可点、只改本地档位，`data-thinking-effective=false`），请求里一个思考字段都不加（与 1.3.0 一致）。渠道改成 `'reasoning_effort'` 则发 `reasoning_effort:'low'|'medium'|'high'`，改成 `'thinking_enabled'` 则发 `thinking:{type:'enabled'}`；非法档位按 `none` fail-closed（`providers.ts` 的 `reasoningParamOf()` / `thinkingAvailable()`、`openaiAdapter.ts` 的 `reasoningFields()`、`ThinkingToggle.ts`） |
| 联网搜索 | ✅可用 —— `tools` 里带 `deepseek_web_search`，结果块渲染成搜索面板与正文角标（`store.ts` 的 `serverTools()` + `gates.tools`、`view.ts:197-205`、`SearchPanel.tsx:9-35`） | ❌不可用 —— 上游没接口（中转基本不实现 `deepseek_web_search`）：`gates.tools=false`，不发 `tools`，开关也不渲染（`providers.ts` 的 `caps.search` + `gates.tools`、`ChatInput.tsx:229-242`） | ❌不可用 —— 既无 `tools`（`gates.tools=false`）也没有等价的服务端搜索协议（`providers.ts` 的 `caps.search` / `gates.tools`） |
| 阅读链接 | ✅可用 —— `deepseek_read_url` 恒定下发（无独立开关），模型按需抓 URL 并回 `web_fetch_tool_result`（`store.ts` 的 `serverTools()`（`deepseek_read_url`）、`ReplyArea.tsx:381-391`） | ❌不可用 —— 与 `tools` 共用一道门，读链接随搜索一起消失（`providers.ts:187`、`store.ts` 的 `gates.tools`） | ❌不可用 —— 同上；且 OpenAI 协议里没有服务端 fetch 工具位（`providers.ts:144`） |
| 自动标题 | ✅可用 —— 空标题的会话带上 `title:{enabled:true}`，标题从 `message_delta.delta.title` 取（`store.ts` 的 `titleRequests` + `event.delta.title`、`parseEvent.ts:208-224`） | ❌不可用 —— 我们主动砍掉（`caps.title=false`）：标题永远为空，侧边栏落到「未命名对话」（`providers.ts:122`、`SessionItem.tsx:23`） | ❌不可用 —— `chat/completions` 没有 title 字段，`caps.title=false`（`providers.ts` 里 openai spec 的 `caps.title`） |
| 用户元信息（日期/地区） | ✅可用 —— 五项快照以 `role:'latest_reminder'` 随消息发送（`latestReminder.ts:19-30`、`store.ts` 的 `toRequestBody()` + `reply.ts` 的 `toRequestMessages()`） | ⚠️部分 —— 信息不丢但语义降级：reminder 行被摘掉、内容折进 `system` 前缀当普通文本（`store.ts` 的 `toRequestBody()`、`reply.ts` 的 `foldReminders()`） | ⚠️部分 —— 同样折进 `system`，再变成 messages 头部的 `{role:'system'}`，模型不会当「客户端快照」理解（`openaiAdapter.ts:74-76`） |
| 内容安全审核/拒答 | ✅可用 —— `safety_check:{level:'high'}` 恒定开启；`stop_reason:'refusal'` 时正文与思考按协议丢弃、只展示拒答模板（`store.ts` 的 `SAFETY_CHECK` + `gates.safety_check`、`reply.ts:143-160`、`describe.ts` 的 `describeReply()`） | ⚠️部分 —— 上游没这个参数（发了 400），只剩协议自带的 `stop_reason:'refusal'` 兜底，拒答由中转自己决定（`parseEvent.ts:211`、`describe.ts` 的 `describeReply()`） | ⚠️部分 —— 无 `safety_check`，只把 `finish_reason:'content_filter'` 映射成 `refusal`（`openaiAdapter.ts:99-105`） |
| 上下文缓存 | ✅可用 —— 上游自动前缀缓存，命中量从 `usage.cache_read_input_tokens` 回流（`parseEvent.ts:168-172`） | ❌不可用 —— 我们主动砍掉：从不下发 `cache_control` 断点，原生 Anthropic 的显式缓存不会生效（全仓 `grep cache_control` 零命中） | ⚠️部分 —— 靠上游自动缓存（`prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`），客户端只做字段映射，不可控（`openaiAdapter.ts` 的 `readUsage()`） |
| 用量统计 | ⚠️部分 —— usage 解析并落库，但**界面零展示**，只在导出归档时折算成 `context_tokens`（`parseEvent.ts:168-172`、`reply.ts:82,132`、`toArchive.ts:200-207`） | ⚠️部分 —— 同上；且中转若少给任一 `cache_*` 字段，整条 usage 会被丢弃（`parseEvent.ts:168-172` 要求四字段齐全） | ⚠️部分 —— 依赖 `stream_options.include_usage`，上游不回就恒为 `ZERO_USAGE`（`openaiAdapter.ts:92,117-122`） |
| 停止生成 | ✅可用 —— `AbortController.abort()` 中断流，`settleReply('stopped')` 收尾（`store.ts` 的 `stopReply()`、`reply.ts:143-160`） | ✅可用 —— 纯客户端逻辑，与协议无关（同左） | ✅可用 —— 同左，翻译器不会因 abort 抛脏错（`client.ts:534-547`） |
| 重新生成 | ✅可用 —— 本地加同父分支后重发同一问题，旧回答与后续对话保留（`store.ts` 的 `regenerateReply()`） | ✅可用 —— 同上（`branches.ts:77-102`） | ✅可用 —— 同上 |
| 编辑消息 | ✅可用 —— 编辑后新增同父版本，附件沿用（`store.ts` 的 `editMessage()`、`UserMessage.tsx` 的编辑态（`editMessage()`）） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| 消息分支（切换版本） | ✅可用 —— 纯本地 `branches.ts`，不依赖上游任何字段（`branches.ts:40-117`、`BranchSwitcher.tsx:28-30`） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| 继续生成 | ✅可用 —— assistant prefill，本轮思考与签名一并回传（`reply.ts:350-362,261-264`） | ✅可用 —— 原生 prefill，语义完全一致 | ⚠️部分 —— OpenAI 没有 prefill 字段，只能把 assistant 消息挂到 messages 末尾碰运气续写（`openaiAdapter.ts:77-86`） |
| 复制 | ✅可用 —— 本地拼接全部 text 块（`AssistantMessage.tsx:145`、`reply.ts:163-164`） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| Markdown/KaTeX/Mermaid 渲染 | ✅可用 —— 全本地渲染（AST → 组件），与上游无关（`Markdown.tsx:1-20`、`MathFormula.tsx:1-10`、`MermaidDiagram.tsx` 的 `MermaidDiagram`） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| 会话管理（新建/重命名/删除） | ✅可用 —— IndexedDB 本地 CRUD（`Sider.tsx:66-75,121`、`SessionItem.tsx:29,63-70`、`src/services/chat/store.ts:462,478,503`） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| 历史导入导出 | ✅可用 —— ZIP 导入/导出纯本地，含附件（`SettingsDialog.tsx:470,517`、`history/zipWriter.ts`） | ✅可用 —— 同上 | ✅可用 —— 同上 |
| 附件/图片 | ✅可用 —— Files API 上传（`{messages}/files`，带 `anthropic-beta`），引用走 `image`/`document` + `file_id`（`client.ts:27,181-200`、`reply.ts:22-32`） | ❌不可用 —— 我们主动砍掉：`caps.vision=false`，回形针与拖拽入口都不渲染（`providers.ts:124`、`ChatInput.tsx:81-94,260-275`） | ❌不可用 —— 入口不渲染；即使硬塞，翻译层也只取 `text` 块、图片/文档直接丢弃（`openaiAdapter.ts:57-65`） |
| 语音输入 ASR | ✅可用 —— `POST /v1/tools/asr`（multipart WAV/Ogg）返回全文（`speech.ts:17-46`、`providers.ts` 里 deepseek 的 `paths.tools`） | ❌不可用 —— `caps.asr=false`（上游没接口），VoiceButton 不渲染（`providers.ts:125`、`ChatInput.tsx:245-259`） | ❌不可用 —— `caps.asr=false`，且 `paths.tools` 是空串，连工具前缀都没定义（`providers.ts:136`） |
| 朗读 TTS | ✅可用 —— `POST /v1/tools/tts` 返回裸 PCM（24k 单声道），服务端过滤 markdown（`speech.ts:49-68`） | ❌不可用 —— `caps.tts=false`，`ReadAloudButton` 直接 `return null`（`providers.ts:126`、`ReadAloudButton.tsx:18-22`） | ❌不可用 —— 同上，无工具前缀 |

**统计**（22 项能力 × 3 模式 = 66 格）

| 模式 | ✅可用 | ⚠️部分 | ❌不可用 |
| --- | --- | --- | --- |
| DeepSeek 官方 | 21 | 1（用量统计） | 0 |
| Anthropic 协议 | 12 | 3（元信息 / 审核 / 用量） | 7（搜索、读链接、标题、缓存控制、附件、ASR、TTS） |
| OpenAI 兼容 | 10 | 5（元信息 / 审核 / 缓存 / 用量 / 继续生成） | 7（搜索、读链接、标题、深度思考、附件、ASR、TTS） |
| 合计 | 43 | 9 | 14 |

**DeepSeek 模式缺的只有「用量统计的界面展示」**（⚠️），其余 21 项全部 ✅。

---

## 二、纯文字功能里「暂时无法实现」的清单

> 只列**不依赖图片/语音**的能力。共 **8 条**：其中 3 条是 Anthropic/OpenAI 双缺，2 条是 OpenAI 单缺，3 条是三模式共同缺口。

### 2.1 联网搜索（Anthropic ❌ / OpenAI ❌）

- **为什么做不到**：**上游没接口**。搜索不是模型能力而是服务端工具协议——DeepSeek 用私有 `tools:[{type:'deepseek_web_search'}]`，边想边搜在 `deepseek_deep_search` 的 `kind` 里再细分（`parseEvent.ts:50-113`）。裸 Anthropic 与 OpenAI 都没有同名工具；OpenAI 的 `tools` 是**客户端工具**（要我们自己执行后回灌 `tool_result`），语义完全不同，塞进去只会 400 或让模型空转。代码层面 `gates.tools = caps.search`（`providers.ts:187`）直接把这条路封死。
- **变通办法与代价**：
  1. **自建搜索**：接第三方搜索 API（Bing/Serper/Tavily…），在客户端把 `tools` 声明成 OpenAI 的 `function` 或 Anthropic 的客户端 `tool_use`，自己执行、自己回灌 `tool_result`。代价：需要额外 Key 与计费；要新写「工具往返」循环（现在的 `applyEvent` 明确丢弃 `tool_use` 并关闭续写，`reply.ts:88,172-191`），还要新做一轮 UI（工具调用态、失败态）；正文引用（`citations_delta`）上游不会给，只能自己拼 `[citation:N]`。
  2. **本地搜索面板**：只做「手动搜索 + 把结果拼进提问」，不进对话流。代价：不是 agentic 搜索，模型不会自己决定何时搜、搜几轮。
  3. **让用户自带搜索结果**：贴 URL 或摘要，靠模型自身知识答。代价：等于没有搜索。
- **未来补的话依赖**：一个稳定的搜索执行后端（自有代理或第三方 API）+ 客户端工具往返循环 + `view.ts` 里 `ServerToolKind` 之外新增的客户端工具渲染分支。

### 2.2 阅读链接 / 链接抓取（Anthropic ❌ / OpenAI ❌）

- **为什么做不到**：**上游没接口**，且被同一道门连坐。`deepseek_read_url` 是 DeepSeek 私有工具，且**没有独立开关**——它恒定塞在 `tools` 数组里（`store.ts` 的 `serverTools()`（`deepseek_read_url`）），而整个 `tools` 字段受 `gates.tools`（= `caps.search`）控制 → 搜索关掉，读链接一起关掉。另外抓取结果要靠 DeepSeek 的签名机制回传（`reply.ts:229-239` 里没签名的 read_link 会被整块丢弃），第三方协议根本没有这套签名。
- **变通办法与代价**：客户端 fetch + 正文提取（Readability）后拼进 prompt。代价：浏览器 CORS 会挡掉绝大多数站点（需要自建代理，见 `docs/baseurl-config-research.md` 同类问题）；正文长度与 token 成本不可控；多页抓取需要自己写循环与去重；`web_fetch_tool_result` 的 `signature` 无法伪造，历史轮次的「已读页面」无法按原语义回传（`reply.ts:229-239`）。
- **未来补的话依赖**：自建抓取代理 + 正文抽取库 + 一套本地「已读页面」的上下文拼装策略（替代签名回传）。

### 2.3 自动标题（Anthropic ❌ / OpenAI ❌）

- **为什么做不到**：**主动砍掉**。`title:{enabled:true}` 是 DeepSeek 私有请求字段，标题从 `message_delta.delta.title` 回来（`store.ts` 的 `title:{enabled:true}` + `event.delta.title`、`parseEvent.ts:208-224`）。`caps.title=false` 后请求不带该字段，`session.title` 永远为空，侧边栏回落到「未命名对话」（`SessionItem.tsx:23`）。代码里**没有任何本地生成标题的兜底**（`store.ts` 全文只有 `renameSession` 会写 title）。
- **变通办法与代价**：本地生成——首轮回答结束后用同一上游再发一条廉价请求（「给这段对话起 6 字标题」），或在客户端直接截首条提问前 N 字。代价：多一次计费请求（且要处理"标题请求失败不能污染会话"）；截断方案质量差、中英混排难看；还要加节流（现有 `titleRequests` Set 只服务于服务端标题，`src/services/chat/store.ts:79`）。
- **未来补的话依赖**：一次额外的轻量补全调用 + 一套「标题只写一次、手动重命名后不再覆盖」的规则（规则已有：`src/services/chat/store.ts:1056` 的 `session.title ? session : ...`、`src/services/chat/store.ts:484`）。

### 2.4 服务端内容安全审核（Anthropic ⚠️ / OpenAI ⚠️）

- **为什么做不到**：**上游没这个参数**。`safety_check:{level:'high'}` 是 DeepSeek 私有顶层字段，裸 Anthropic 收到未知顶层字段直接 400，所以 `gates.safety_check=false`（`providers.ts:185`、`src/services/chat/store.ts:1038`）。剩下的只有协议自带的 `stop_reason:'refusal'`（`parseEvent.ts:211`）与 OpenAI 的 `finish_reason:'content_filter'`（`openaiAdapter.ts:104`）——**审核强度、审核时机、审核文案全由上游决定，客户端无法要求**。
- **变通办法与代价**：客户端自建审核（敏感词/分类模型前置拦截）。代价：多一份模型或词表依赖、多一次延迟；误杀无法申诉；且挡不住上游自己的拒答，两套策略要合并展示（`describe.ts:19-59` 的 Notice 体系要扩展）。
- **未来补的话依赖**：一个可配置的审核服务；或上游（中转商）暴露同类开关。

### 2.5 用量统计的界面展示（三模式共同 ⚠️）

- **为什么做不到**：**我们主动没做**，不是协议问题。usage 一路解析进 `message.usage`（`parseEvent.ts:168-172`、`reply.ts:82,132`），但 `src/components/` 全文没有一处渲染 token（`grep token` 只命中 Modal 的锁对象与 highlight.css 的 class）。唯一用武之地是导出归档时折算 `context_tokens`（`toArchive.ts:200-207`）。另外 Anthropic 兼容中转若少给 `cache_creation_input_tokens` 等任一字段，`isUsage` 判定失败、整条 usage 直接丢弃。
- **变通办法与代价**：在消息底部加一行「↑1.2k ↓356」小字即可，成本极低；但**必须先放宽 `isUsage`**（改成逐字段可选、缺失记 0），否则中转下永远是空。
- **未来补的话依赖**：`isUsage` 容错改造 + 一个 `<UsageBar>` 小标签（i18n 两条文案）。

### 2.6 上下文缓存的主动控制（Anthropic ❌ / OpenAI ⚠️）

- **为什么做不到**：**我们主动砍掉**。原生 Anthropic 的缓存要靠 `cache_control:{type:'ephemeral'}` 断点显式标记，全仓没有任何 `cache_control`（`grep` 零命中），所以 Anthropic 模式等于完全无缓存；DeepSeek / OpenAI 侧则是上游自动前缀缓存，客户端只能"读命中量"，不能"要求缓存"（`openaiAdapter.ts` 的 `readUsage()`）。
- **变通办法与代价**：给长上下文（历史 + system）打 cache_control 断点。代价：Anthropic 断点最多 4 个、需要按「稳定前缀」精心排序（system → 历史 → 本轮），否则命中率反而下降；中转是否透传 `cache_control` 未知，需要逐个验证；命中与否会影响计费口径，需要 UI 说明。
- **未来补的话依赖**：`CreateMessageRequest` 的 block 级 `cache_control` 支持（`types.ts` 扩展）+ 前缀稳定性策略 + 与 `gates` 联动的开关。

### 2.7 继续生成的严格 prefill 语义（仅 OpenAI ⚠️）

- **为什么做不到**：**协议无对应字段**。DeepSeek/Anthropic 都用 assistant 尾部消息做 prefill，服务端会"接着写"（`reply.ts:350-362`，且带签名回传本轮思考）。OpenAI `chat/completions` 没有 prefill 概念，翻译层只能把 assistant 消息原样排到 messages 末尾（`openaiAdapter.ts:77-86`），是否真的续写取决于上游实现——官方 OpenAI 会续写，部分中转会当成"已回答完"直接结束或报错。
- **变通办法与代价**：改用「把已有正文塞进 user 消息 + `继续` 指令」的模拟续写。代价：模型可能复述而非续写，且历史里多出一条假的 user 消息会污染分支/上下文；`canContinueReply` 的判定（`reply.ts:172-191`）也要跟着改。
- **未来补的话依赖**：上游确认支持 assistant 尾部续写，或提供 `assistant_prefix` 之类参数。

### 2.8 用户元信息的结构化快照（Anthropic ⚠️ / OpenAI ⚠️）

- **为什么做不到**：**协议无对应 role**。`role:'latest_reminder'` 不是合法 Anthropic role，只能折进 `system` 前缀（`store.ts` 的 `toRequestBody()`、`reply.ts` 的 `foldReminders()`）。DeepSeek 侧模型是**按字段约定**理解这行快照的（日期/星期/地区/客户端/语言，`latestReminder.ts:19-30`），折成 system 文本后信息还在，但失去了"客户端环境快照"的语义位置，模型更容易把它当成用户说的话。
- **变通办法与代价**：在 system 里加一句说明（「以下是你收到的客户端环境快照：…」）能缓解，但会增加 prompt 长度、且无法保证模型不误读；也可以用 `<env>` 之类的标记包装，代价是要在多语言 system 模板里各维护一份。
- **未来补的话依赖**：无（这是协议固有限制，只能优化措辞）。

---

## 三、能力与代码的对应关系

| 能力 | 依赖的请求字段 / 路径 | 依赖的响应 block / 事件 | UI 组件位置 |
| --- | --- | --- | --- |
| 基础文本对话 | `POST {baseUrl}{paths.messages}`（`apiConfig.ts` 的 `getMessagesUrl()`）；`model` / `system` / `messages`（`streamMessage(...)` 的 `model` / `system` / `messages`）；鉴权 `x-api-key` 或 `Bearer`（`client.ts:380-400`） | `message_start` / `content_block_*` / `message_delta` / `message_stop`（`parseEvent.ts:175-231`） | `ChatInput.tsx:180-210`（输入区）、`MessageList.tsx`、`ReplyArea.tsx:71-105` |
| 流式输出 | `stream:true`（`client.ts:283`）；OpenAI 侧 `stream:true` + `stream_options.include_usage`（`openaiAdapter.ts` 的 `toOpenAIRequest()`：`stream` / `stream_options`） | `content_block_delta` → `text_delta`（`parseEvent.ts:155-156`、`reply.ts:99-102`）；rAF 节流刷新（`store.ts` 的 `applyEvent()` + `requestAnimationFrame(flush)`） | `useThrottleMarkdownRender.ts`、`AssistantMessage.tsx:60-100` |
| 深度思考 | `thinking:{type:'enabled', budget_tokens?}`（`requestBody.ts` 的 `buildMessageBody()`：`gates.reasoning_param` 决定开不开、`gates.thinking_budget` + `spec.thinkingBudget` 决定带不带预算）；OpenAI 侧按 `reasoningParam` 翻译成 `reasoning_effort` / `thinking:{type:'enabled'}`，`none` 档照旧丢弃（`openaiAdapter.ts` 的 `reasoningFields()`） | `thinking` block + `thinking_delta` / `signature_delta`（`parseEvent.ts:42-49,157-160`、`reply.ts:103-108`） | `ThinkingToggle.ts`（开关，`ChatInput.tsx` 挂载）、`ReplyArea.tsx:112-190`（思考步骤） |
| 联网搜索 | `tools:[{type:'deepseek_web_search'}]`（`store.ts` 的 `serverTools()`）；门控 `gates.tools`（`providers.ts:187`、`store.ts` 的 `gates.tools`） | `server_tool_use(kind:search/deep_search)` + `web_search_tool_result`（`parseEvent.ts:50-113`）→ `searchResults`（`view.ts:197-205,345`） | `ChatInput.tsx:229-242`（开关）、`AssistantMessage.tsx:127-140`（来源摘要）、`SearchPanel.tsx:9-35`、`SourceCard.tsx:14-30`、`CitationLink.tsx:10-26` |
| 阅读链接 | `tools:[{type:'deepseek_read_url'}]` 恒定下发（`store.ts` 的 `serverTools()`（`deepseek_read_url`）），同受 `gates.tools` 门控 | `web_fetch_tool_result(kind:read_link)` + `signature`（`parseEvent.ts:114-140`、`reply.ts:229-239`） | `ReplyArea.tsx:159,381-391`（ReadLinkRow）、`PageLink` 子组件 |
| 自动标题 | `title:{enabled:true}`（`store.ts` 的 `title:{enabled:true}`、`providers.ts:188`） | `message_delta.delta.title`（`parseEvent.ts:219-224`）→ `session.title`（`store.ts` 的 `event.delta.title`） | `SessionItem.tsx:23`（空标题回落 `untitledChat`）、`store.ts` 的 `renameSession()`（手动重命名） |
| 用户元信息 | `messages` 里的 `{role:'latest_reminder'}`（`reply.ts` 的 `foldReminders()` / `toRequestMessages()`）；不支持时折进 `system`（`store.ts` 的 `toRequestBody()`） | 无（只上行，响应不体现） | 无 UI；来源 `latestReminder.ts:19-30`、`services/location.ts` |
| 内容安全审核/拒答 | `safety_check:{level:'high'}`（`store.ts` 的 `SAFETY_CHECK` + `gates.safety_check`、`providers.ts:185`）；OpenAI `content_filter` 映射（`openaiAdapter.ts:104`） | `message_delta.delta.stop_reason:'refusal'`（`parseEvent.ts:211`）→ 丢弃文本/思考（`reply.ts:143-160`）→ 模板（`describe.ts` 的 `describeReply()`） | `AssistantMessage.tsx:95-126`（notice 区） |
| 上下文缓存 | 无请求字段（Anthropic 缺 `cache_control`，`grep` 零命中） | `usage.cache_read_input_tokens` / `cache_creation_input_tokens`（`parseEvent.ts:168-172`、`openaiAdapter.ts` 的 `readUsage()`） | 无 UI（仅 `toArchive.ts:200-207` 导出用） |
| 用量统计 | OpenAI 侧 `stream_options.include_usage`（`openaiAdapter.ts:92`） | `message.usage` / `message_delta.usage`（`reply.ts:82,127-133`） | 无 UI；仅 `toArchive.ts:200-207` |
| 停止生成 | `AbortSignal`（`client.ts` 的 `streamMessage`） | 中断 → `settleReply('stopped')`（`settleReply('stopped')`、`reply.ts:143-160`） | `ChatInput.tsx:290`（发送键切换为停止键，`store.ts` 的 `stopReply()`） |
| 重新生成 | 重新构造请求（同一 `question`，`history` 截到前一轮） | 全新一轮 block | `AssistantMessage.tsx` 的 `regenerateReply` 按钮（`store.ts` 的 `regenerateReply()`） |
| 编辑消息 | 同上（`question` 内容替换） | 同上 | `UserMessage.tsx` 的编辑态（`editMessage()`）（`store.ts` 的 `editMessage()`） |
| 消息分支 | 无（纯本地） | 无（纯本地） | `BranchSwitcher.tsx:28-30`（`branches.ts:40-117`、`branches.ts` 的 `MessageVersions` / `selectVersion()`） |
| 继续生成 | 尾部 assistant 消息（prefill）：`reply.ts:350-362`；OpenAI 只能原样排在末尾（`openaiAdapter.ts:77-86`） | 新事件继续追加到原有 block（`reply.ts:72-137` 的 `blockIndexes` 映射） | `AssistantMessage.tsx:160-173`（`src/services/chat/store.ts:1063-1081`） |
| 复制 | 无 | 本地拼接 text block（`reply.ts:163-164`） | `AssistantMessage.tsx:145`、`CopyButton.tsx` |
| Markdown/KaTeX/Mermaid | 无 | 无（纯本地渲染） | `Markdown.tsx:1-20`、`MarkdownAstRenderer.tsx`、`MathFormula.tsx:1-10`、`MermaidDiagram.tsx` 的 `MermaidDiagram`、`CodeBlock.tsx` |
| 会话管理 | 无（IndexedDB） | 无 | `Sider.tsx:66-75,121`、`SessionItem.tsx:23-70`、`src/services/chat/store.ts:462,478,503` |
| 历史导入导出 | 无（ZIP 本地） | 无 | `SettingsDialog.tsx` 的「数据管理」分组、`history/zipWriter.ts`、`history/importArchive.ts` |
| 附件/图片 | `POST {messages}/files`（`client.ts:181-200`）+ `anthropic-beta:files-api-2025-04-14`（`client.ts:27,160-163`）；引用 `image`/`document` + `file_id`（`reply.ts:22-32`） | 无特殊事件（图片只上行） | `ChatInput.tsx:81-94,260-275`、`DraftAttachments.tsx`、`FileCard.tsx`、`MessageFile.tsx` |
| 语音输入 ASR | `POST {baseUrl}{paths.tools}/asr`（`speech.ts:24`） | 纯 JSON `{text}`（`speech.ts:30-45`） | `ChatInput.tsx:245-259`、`VoiceButton.tsx`、`useVoiceInput.ts` |
| 朗读 TTS | `POST {baseUrl}{paths.tools}/tts`（`speech.ts:55`） | 裸 PCM 流（`speech.ts:64-67`） | `ReadAloudButton.tsx:15-33`、`ReadingBars.tsx`、`services/speech/readAloud.ts` |

**已有测试覆盖**（`tests/integration/full-acceptance.test.mjs`，8 组断言）

| 组 | 覆盖内容 | 行号 |
| --- | --- | --- |
| 1–2 | OpenAI 路径 `/v1/chat/completions` + `Authorization: Bearer`；请求体无 `safety_check`/`title`/`tools`/`thinking`/顶层 `system` | `675-681`、`606-700` |
| 3–4 | 翻译器单测（干净流）+ 脏数据（空 choices / 无 `[DONE]` / `: ping`） | `300-346` |
| 5 | OpenAI 端到端逐字渲染、结束状态正常 | `701-744` |
| 6 | OpenAI 模式五个入口 `count=0`；切回 deepseek 后恢复 | `745-806` |
| 7a | DeepSeek 三路径（`/models`、`/anthropic/v1/messages`、`/v1/tools/asr`）+ 四私有字段 + `deepseek_web_search` + 自动标题生效 | `347-465`（字段判定 `394-418`，标题 `426-432`，ASR `444-460`） |
| 7b/7c | Anthropic 路径与字段剥离（`safety_check`/`title`/`tools`/`latest_reminder` 全不发）+ 上游返回 HTML 报错 | `466-533`、`586-605` |
| 7d | Anthropic 能力降级（搜索/上传/语音/朗读隐藏，深度思考保留） | `534-585` |
| 8 | 刷新后会话与配置仍在；console error = 0 | `809-845` |

**测试未覆盖的空白**（本矩阵里标 ⚠️ 的格子大多落在这里）：继续生成的 prefill 行为、TTS 实际出音、用量数值、缓存命中、拒答分支、历史导入导出。

---

## 四、结论

**一句话**：DeepSeek 模式能吃满 22 项能力里的 21 项（唯一缺口是「用量统计」没有界面）；Anthropic 协议只能做**纯文本对话 + 深度思考**（外加本地的那套会话/分支/渲染）；OpenAI 兼容只能做**最裸的流式文本对话**——连深度思考和继续生成的严格语义都没有。

**若要尽量补齐「纯文字功能」，按性价比排序的待办**：

1. **用量统计小标签 + 放宽 `isUsage`**（成本最低、三模式同时受益）。改 `parseEvent.ts:168-172` 让四个 token 字段逐个可选、缺失记 0，再在 `AssistantMessage` 底部加一行 `↑in ↓out`。这一步同时顺手修掉「中转少给 `cache_*` 就丢掉整条 usage」的隐性 bug。
2. **本地自动标题兜底**（Anthropic/OpenAI 立刻有标题）。复用现有 `titleRequests` 节流与「只写一次」规则（`src/services/chat/store.ts:79,1056`），在首轮回答结束后用同上游发一条廉价补全；失败不影响会话。代价是一次额外调用，可以加开关。
3. **给 Anthropic 模式打 `cache_control` 断点**（省的是真金白银）。按「system → 历史 → 本轮」顺序给最多 4 个 ephemeral 断点，需要 `types.ts` 扩展 block 级字段 + 逐中转验证透传。
4. **客户端工具往返框架**（补齐搜索/阅读链接的唯一正路）。先在 `applyEvent`（`reply.ts:88`）里把 `tool_use` 从"丢弃"改成"可执行"，接一个第三方搜索 API；这条路也是唯一能同时救活 Anthropic/OpenAI 两个模式的搜索方案，但工作量最大、要新写 UI 态。
5. **OpenAI 侧 prefill 探测 + 降级策略**（小修）。检测上游是否支持 assistant 尾部续写，不支持时把「继续生成」按钮置灰并给出说明，避免用户点了没反应（`canContinueReply` 加一个 `caps` 判断）。

> 不建议补：服务端安全审核（无接口，客户端自建性价比低）、结构化 `latest_reminder`（协议固有限制，只能优化 system 措辞）。
