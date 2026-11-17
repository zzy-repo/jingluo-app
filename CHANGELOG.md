# 变更记录

本文件记录 deepseek-app 的重要变更，版本倒序排列。

## 1.4.0-beta.2 (2026-11-17) — 动效优化

> 只优化「外壳」的交互动效（侧边栏、设置弹窗、按钮按压、列表切项、主题切换），**消息流一律不碰**：
> 流式打字机、思考块、气泡、附件预览、搜索卡片的 DOM 与 CSS 相对 1.4.0-beta.1 逐字未变（`git diff` 为空）。

- 新增动效令牌层 `src/app/motion.css`：iOS 风格缓动 `cubic-bezier(0.32, 0.72, 0, 1)`，
  时长按压 110ms / 淡入淡出 180ms / 常规 220ms / 抽屉 280ms；全部只用于 `transform` 与 `opacity`
- 侧边栏（移动端抽屉）：从左侧 `translateX(-100% → 0)` 滑入，遮罩同步 `opacity 0 → 1` 淡入；
  关闭反向滑出，**DOM 保留到退出动画结束再卸载**，动画期间遮罩仍可点击关闭、不会「点不动」
- 设置弹窗：移动端改为底部弹层 `translateY(100% → 0)` 滑起 + 遮罩淡入淡出；桌面端保留居中缩放淡入
  （`scale 0.97 → 1`）；关闭时同样等动画播完再卸载；遮罩拆成独立伪元素层，压暗与背景模糊一起淡入淡出
- 按钮 / 列表项按压反馈：`:active` 时 `transform: scale(0.96)`（图标按钮 0.92、列表行 `opacity .7`），110ms 回弹
- 会话列表切项：选中项 `opacity .82 → 1` 轻微淡入（≤180ms）；主题切换：整壳 `opacity` 淡入 180ms
- 无障碍：`prefers-reduced-motion: reduce` 下所有动效时长降为 0.01ms，动画类名 `animation: none`，
  且抽屉 / 弹窗不排帧、不保留退出时长的 DOM（实测 `transition-duration = 1e-05s`）
- 技术约束：`src/` 下 37 个 CSS 文件没有任何 `transition`/`animation` 动 `width/height/top/left/margin` 等布局属性，
  相对 1.4.0-beta.1 也没有引入 `transform`/`opacity` 之外的新动画属性（由 `tests/test.motion.spec.mjs` 自动校验）
- 新增验收 `tests/test.motion.spec.mjs`：中间帧截图 + 计算样式断言 + reduced-motion + 静态属性检查 + 功能回归（mock 上游）
- 版本号：versionCode 9 / versionName 1.4.0-beta.2（本轮仅本地验证与 5181 部署，未发布 APK / 未打 tag）

## 1.4.0-beta.1 (2026-11-17) — 内测版

> 内测版包：服务地址与模型已固定，用户只需填写 API Key。下载页与 GitHub Release 均标注「内测版」（pre-release）。

- 服务地址、模型、服务类型在**构建期固定**（`INTERNAL_BUILD=1 pnpm build:internal`，versionCode 8 / versionName 1.4.0-beta.1）：
  - 服务地址固定为 `http://123.207.199.196:60010`，模型固定为 `deepseek-v4.1-flash`，服务类型固定为「Anthropic 协议」预设（该上游只有 `/v1/messages`，没有 `/anthropic` 前缀，且不带 `anthropic-version` 头以免中转 CORS 预检失败）
  - 三项常量集中在 `src/services/api/internalBuild.ts` 一处，改地址/模型只改这里
  - 这些值**不写 localStorage**：内测包不再读取已存的地址/模型/服务类型，`setBaseUrl`/`setModel`/`setProviderKind` 变为空操作
- 设置页隐藏编辑入口：`providers.ts` 的 spec 新增 `fixed` 概念，固定项的 `baseUrl`/`model` 不进 `fields`，因此不渲染「服务地址」「模型」输入行；可选项只剩一个 spec 时不渲染「服务类型」下拉
- **API Key 仍由用户填写**（唯一可编辑项），保存前的 `/v1/models` 校验、连通性测试按钮行为不变
- 移除设置页「位置信息」（location / 所在地）：UI 项整段删除，`settings.location`、`src/services/location.ts` 与 `latestReminder` 的读取逻辑保留但不再暴露入口；`createLatestReminder` 在没有位置信息时**省略该段**，不再产生空段或 `undefined`
- 协议适配零改动：deepseek / anthropic / openai 三条链路的路径、字段门控（REQUEST_GATES）、翻译器（`openaiAdapter.ts`）逐字未变；正式构建（`pnpm build`）行为与 1.3.0 完全一致
- 测试：9 个既有 spec 全绿（对标准构建，断言未削弱）；新增 `tests/test.internal-build.spec.mjs`（内测构建验收：DOM 只有 API Key、请求 URL/模型固定、扩展字段剥离、localStorage 不落固定项、console error=0）与本地 mock 上游 `tests/mock-anthropic.mjs`（node 标准库，监听 `123.207.199.196:60010` 并回标准 Anthropic SSE）

## 1.3.0 (2026-11-17)

- 设置页新增第三个服务类型「OpenAI 兼容 / OpenAI-compatible」（versionCode 7）：可自填服务地址、API Key 与模型，发消息走 `POST /v1/chat/completions`，鉴权头为 `Authorization: Bearer <key>`，模型探测走 `GET /v1/models`
- 新增协议翻译层 `src/services/api/openaiAdapter.ts`：
  - 请求方向：`system` → messages 头部 `{role:'system'}`；user/assistant 原样映射，block 数组只取 `type:'text'`（图片/文档直接丢弃）；`safety_check`/`title`/`tools` 沿用 REQUEST_GATES 不发；`thinking` 直接丢弃（OpenAI 无对应字段，`reasoning_effort` 不是通用 chat/completions 参数）；必带 `stream: true` 与 `stream_options.include_usage`
  - 响应方向：OpenAI SSE → Anthropic 事件流，序列固定为 `message_start → content_block_start → content_block_delta* → content_block_stop → message_delta(stop_reason + usage) → message_stop`；`finish_reason` 映射 `stop→end_turn`、`length→max_tokens`、`tool_calls/function_call→end_turn`、`content_filter→refusal`
  - 脏数据容错：空 `choices`、`delta` 空对象、`: ping` 注释行、非 JSON 的 data 行、同一 chunk 多条 choices（只取 index 0）、没有 `[DONE]` 的断流都能正常收尾不卡死；上游若下发 `reasoning_content` 会另开一个 thinking 块
- OpenAI 兼容模式只保留基础对话（流式文本、停止、重新生成 / 编辑 / 分支）：智能搜索、附件/图片、语音输入、朗读、自动标题、深度思考入口全部隐藏（由 `caps` 驱动，DOM 里 `count=0`）
- deepseek / anthropic 两种模式零影响：三条路径、四个私有字段、能力降级行为与 1.2.3 逐字一致，原有回归断言仍全绿
- 测试：新增 `tests/test.openai-adapter.spec.mjs`（28 项断言，直接 import 适配器，不启浏览器）并纳入 `tests/run-acceptance.mjs`（覆盖 openai 路径/鉴权头/请求体/端到端逐字渲染/能力降级 + 原有 deepseek/anthropic 回归）

## 1.2.3 (2026-11-17)

- 设置页新增「服务类型」下拉（versionCode 6）：
  - **DeepSeek 官方**（默认）：只需填 API Key，服务地址与模型使用内置默认值；`/models`、`/anthropic/v1/messages`、`/v1/tools` 三条路径与改造前逐字一致，`safety_check`/`title`/`tools`/`latest_reminder`/`thinking` 原样发送
  - **Anthropic 协议**：可自填服务地址与模型，路径改为 `/v1/models`、`/v1/messages`，鉴权同为 `x-api-key`
- Anthropic 兼容模式**只保留基础对话**：流式文本、停止、重新生成/编辑/分支与可选「深度思考」（自动补 `budget_tokens: 4096`）可用；智能搜索、阅读链接、自动标题、附件/图片、语音输入、朗读等入口在界面上隐藏或置灰，不会出现「发了请求却静默丢弃」的半吊子适配
- Anthropic 兼容模式请求体自动剥离 DeepSeek 私有字段：不发 `safety_check`、`title`、`tools` 与 `role:'latest_reminder'`；`latest_reminder` 的内容折进 `system` 前缀，信息不丢
- 上游返回网页（`text/html`，通常是路径填错或网关异常）时给出明确中文错误，不再把 HTML 当回答显示
- 新增本地 mock 端到端验收 `tests/run-acceptance.mjs` 及 8 个专项回归用例（路径/请求体/能力降级/HTML 上游/旧配置兼容等），不依赖真实上游
- 测试脚本默认使用 `http://127.0.0.1:5181`（安全上下文），语音输入用例不再因非 HTTPS 页面被置灰而失败

## 1.2.2 (2026-11-17)

- 修复设置页「测试」按钮误报 `Invalid api key`：探测请求改用 API Key 输入框的当前值，而不是 store 里已保存（可能为空）的旧值，不必先点「确定」再测试（versionCode 5）
- 未填写 API Key 时点「测试」会直接提示「请先填写 API Key」，不再发出空 `Authorization: Bearer` 请求
- 新增 Playwright 回归测试 `tests/test.probe-auth.spec.mjs`、`tests/test.probe-nokey.spec.mjs`

## 1.2.1 (2026-11-17)

- 允许 Android WebView 混合内容，修复 http 上游地址无法连通的问题（versionCode 4）

## 1.2.0 (2026-11-17)

- 新增聊天背景图功能：支持选择本地图片作为聊天背景，图片压缩至 1600px 上限后存入 IndexedDB，提供亮/暗主题遮罩保证可读性（versionCode 3）
- 数据库版本 11 → 12 迁移，新增 appAssets 表，迁移过程不丢数据
- 设置页新增「聊天背景」配置项，支持应用/更换/清除背景

## 1.1.0 (2026-11-17)

- 新增服务地址（Service URL）与模型可配置，API Key 本地存储（versionCode 2）
- 新增 API Key 连通性测试，配置错误提示更清晰
- 历史记录导入错误提示优化

## 1.0.0 (2026-11-17)

- 首个版本：Capacitor 套壳 Android 应用（versionCode 1）
- 支持自定义服务地址访问 DeepSeek 兼容接口
